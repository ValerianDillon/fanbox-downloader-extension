import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { chromium, expect, test } from '@playwright/test';
import {
  CREATOR_PAGE_URL,
  EXPECTED_FETCHED_URLS,
  EXPECTED_ZIP_ENTRIES,
  FILE_BODIES,
  LIST_PAGE_RESPONSE,
  LIST_PAGE_URL,
  PAGINATE_RESPONSE,
  PAGINATE_URL,
  PLANS_RESPONSE,
  PLANS_URL,
  POST_A_STUB,
  POST_B_STUB,
  POST_INFO_RESPONSE_A,
  POST_INFO_RESPONSE_B,
  POST_INFO_URL_A,
  POST_INFO_URL_B,
  TAGS_RESPONSE,
  TAGS_URL,
} from './fixtures';
import { decodeBase64ToBytes, hasLocalFileHeaderSignature, parseZip } from './zip-util';

/**
 * Issue #10: 拡張の smoke test (WSL headless)。
 *
 * dist-test/ (scripts/build.ts --test でビルドした __FBDL_TEST__=true ビルド) を
 * Chromium の永続コンテキストに読み込み、FANBOX API を Playwright の routing でモックした上で
 * 「FAB クリック → 収集 → ZIP 生成」を実ブラウザで完走させる。
 *
 * 責務範囲外 (対象外):
 * - 実ファイル保存 (showSaveFilePicker はテストビルドで in-memory スタブに差し替え済み。
 *   ネイティブファイル選択ダイアログは自動化不可)
 * - ZIP エントリの mtime 検証 (test/downloader.test.ts でカバー済み)
 */

const JSON_RESPONSES: Record<string, unknown> = {
  [PLANS_URL]: PLANS_RESPONSE,
  [TAGS_URL]: TAGS_RESPONSE,
  [PAGINATE_URL]: PAGINATE_RESPONSE,
  [LIST_PAGE_URL]: LIST_PAGE_RESPONSE,
  [POST_INFO_URL_A]: POST_INFO_RESPONSE_A,
  [POST_INFO_URL_B]: POST_INFO_RESPONSE_B,
};

type Manifest = {
  host_permissions?: unknown;
  background?: { service_worker?: unknown };
};

/**
 * static/manifest.json を読み込む。ハードコードによる手打ち複製 (実体との乖離リスク) を避け、
 * host_permissions / background.service_worker を実ファイルから導出するために使う。
 */
function readManifest(): Manifest {
  const manifestPath = path.resolve(process.cwd(), 'static/manifest.json');
  return JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
}

/**
 * host_permissions (`*://*.<suffix>/*` の形式を想定) からドメインサフィックスを導出する。
 * 想定外の形式が来た場合は黙って無視せず test を fail させる (fail-closed)。
 */
function deriveAllowedHostSuffixes(manifest: Manifest): string[] {
  const hostPermissions = manifest.host_permissions;
  if (!Array.isArray(hostPermissions) || hostPermissions.length === 0) {
    throw new Error(`static/manifest.json の host_permissions が空/不正です: ${JSON.stringify(hostPermissions)}`);
  }
  const pattern = /^\*:\/\/\*\.(.+)\/\*$/;
  return hostPermissions.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(`host_permissions のエントリが文字列ではありません: ${JSON.stringify(entry)}`);
    }
    const match = entry.match(pattern);
    if (!match) {
      throw new Error(`host_permissions が想定形式 (*://*.<suffix>/*) 外です: ${entry}`);
    }
    return match[1];
  });
}

/**
 * WSLg の DISPLAY / WAYLAND_DISPLAY を取り除いた環境を返す。
 *
 * これらが設定されたまま headless Chromium を起動すると、最初の requestAnimationFrame の
 * 配送が 60〜100 秒止まる (2 フレーム目以降は 16ms で正常)。Playwright の actionability の
 * stable 判定は連続 2 フレームの bounding box 比較を待つため、最初の操作がそこで固まり、
 * 既定の 60 秒タイムアウトを超える。CI には元から設定されていないので影響しない。
 */
function browserEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'DISPLAY' || key === 'WAYLAND_DISPLAY') continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** background.service_worker (拡張自身の service worker のファイル名) を manifest から導出する */
function deriveServiceWorkerFileName(manifest: Manifest): string {
  const swPath = manifest.background?.service_worker;
  if (typeof swPath !== 'string' || swPath.length === 0) {
    throw new Error(`static/manifest.json の background.service_worker が不正です: ${JSON.stringify(swPath)}`);
  }
  return swPath;
}

const MANIFEST = readManifest();
const ALLOWED_HOST_SUFFIXES = deriveAllowedHostSuffixes(MANIFEST);
const SERVICE_WORKER_FILE_NAME = deriveServiceWorkerFileName(MANIFEST);

function isWithinExtensionHostPermissions(hostname: string): boolean {
  return ALLOWED_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

type TestState = {
  overlayState: string | null;
  zipDone: string | null;
  error: string | null;
  aborted: string | null;
  unsupportedResponse: string | null;
  addedPostCount: string | null;
  unavailablePostCount: string | null;
  unsupportedPostCount: string | null;
  apiFailedPostCount: string | null;
  failedPageCount: string | null;
  failedFileCount: string | null;
  fetchedUrls: string | null;
  zipB64: string | null;
};

function readTestState(): TestState {
  const el = document.documentElement;
  return {
    overlayState: el.getAttribute('data-fbdl-overlay-state'),
    zipDone: el.getAttribute('data-fbdl-zip-done'),
    error: el.getAttribute('data-fbdl-error'),
    aborted: el.getAttribute('data-fbdl-aborted'),
    unsupportedResponse: el.getAttribute('data-fbdl-unsupported-response'),
    addedPostCount: el.getAttribute('data-fbdl-added-post-count'),
    unavailablePostCount: el.getAttribute('data-fbdl-unavailable-post-count'),
    unsupportedPostCount: el.getAttribute('data-fbdl-unsupported-post-count'),
    apiFailedPostCount: el.getAttribute('data-fbdl-api-failed-post-count'),
    failedPageCount: el.getAttribute('data-fbdl-failed-page-count'),
    failedFileCount: el.getAttribute('data-fbdl-failed-file-count'),
    fetchedUrls: el.getAttribute('data-fbdl-fetched-urls'),
    zipB64: el.getAttribute('data-fbdl-zip-b64'),
  };
}

type ExtensionSession = {
  context: BrowserContext;
  page: Page;
  overlay: Locator;
  userDataDir: string;
  unexpectedRequests: string[];
};

/**
 * dist-test/ を読み込んだ拡張プロファイルを起動し、FANBOX API を jsonResponses でモックした上で
 * FAB クリック → 「ダウンロード開始」まで進める共通セットアップ。
 *
 * 個々のテストは戻り値の page/overlay を使って、そこから先 (完了までの待機や状態の検証) だけを書く。
 * 呼び出し側は必ず finally で context.close() / rm(userDataDir, ...) を行うこと
 * (このヘルパー自体は後始末をしない)。
 */
async function launchAndStartDownload(
  jsonResponses: Record<string, unknown>,
  namePrefix: string,
): Promise<ExtensionSession> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), `fbdl-smoke-${namePrefix}-`));
  const extensionPath = path.resolve(process.cwd(), 'dist-test');

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    env: browserEnv(),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...(process.env.CI ? ['--no-sandbox'] : []),
    ],
  });

  // 拡張の service worker (MV3 background) が起動していることを確認する
  let serviceWorker = context.serviceWorkers().find((sw) => sw.url().startsWith('chrome-extension://'));
  serviceWorker ??= await context.waitForEvent('serviceworker', {
    predicate: (sw) => sw.url().startsWith('chrome-extension://'),
  });
  // manifest の background.service_worker (= 'service-worker.js') で終わる URL であることを見て、
  // 「chrome-extension:// で始まる」というフィルタと同義の (常に真になる) assert ではなく、
  // 自拡張の service worker であることを実質的に検証する
  expect(serviceWorker.url().endsWith(`/${SERVICE_WORKER_FILE_NAME}`)).toBe(true);

  const unexpectedRequests: string[] = [];

  await context.route('**/*', async (route) => {
    const url = route.request().url();

    if (url === CREATOR_PAGE_URL) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body></body></html>',
      });
      return;
    }

    const jsonBody = jsonResponses[url];
    if (jsonBody !== undefined) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(jsonBody) });
      return;
    }

    const file = FILE_BODIES[url];
    if (file) {
      await route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
      return;
    }

    if (url.endsWith('/favicon.ico')) {
      // ブラウザが自動的に取りに行くことがあるが、fixture/テストの本題とは無関係なので
      // 404 で応答するだけにして「予期しないリクエスト」としては扱わない
      await route.fulfill({ status: 404, body: '' });
      return;
    }

    // 拡張自身のリソース (content.js / service-worker.js / manifest / icons) は
    // chrome-extension:// スキームで読み込まれる。ネットワークリクエストではないので通す。
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      await route.continue();
      return;
    }

    const hostname = new URL(url).hostname;
    if (!isWithinExtensionHostPermissions(hostname)) {
      // host_permissions (*://*.fanbox.cc/*, *://*.pximg.net/*) の対象外ドメインは
      // このテストの関心事ではないので黙って abort する
      await route.abort();
      return;
    }

    // host_permissions の対象内なのに fixture に定義がない = テストが想定していないリクエスト
    // (fail-closed: 収集ロジックが fixture にない URL を叩いていないか検出する)
    unexpectedRequests.push(url);
    await route.abort();
  });

  const page = await context.newPage();
  await page.goto(CREATOR_PAGE_URL);

  const fab = page.locator('#fanbox-downloader-ext-fab');
  await fab.waitFor({ state: 'visible' });
  await fab.locator('button').click();

  const overlay = page.locator('#fanbox-downloader-ext-overlay');
  // renderSettings(): 1つ目の number input が取得件数上限、2つ目が API 間隔(ms)
  const intervalInput = overlay.locator('.setting-row input[type="number"]').nth(1);
  await intervalInput.fill('50');
  await overlay.getByRole('button', { name: 'ダウンロード開始' }).click();

  return { context, page, overlay, userDataDir, unexpectedRequests };
}

test('FANBOX creator ページ: 収集から ZIP 生成まで完走する', async () => {
  const session = await launchAndStartDownload(JSON_RESPONSES, 'ok');
  const { context, page, userDataDir, unexpectedRequests } = session;

  try {
    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'complete', zipDone: '1' });

    const state = await page.evaluate(readTestState);

    expect(state.error, 'startCollecting でエラーが発生した').toBeNull();
    expect(state.aborted, 'ダウンロードが中断された').toBeNull();
    expect(state.unsupportedResponse, '未対応のレスポンス形式として中断された').toBeNull();
    expect(state.addedPostCount).toBe('2');
    expect(state.unavailablePostCount).toBe('0');
    expect(state.unsupportedPostCount).toBe('0');
    expect(state.apiFailedPostCount).toBe('0');
    expect(state.failedPageCount).toBe('0');
    expect(state.failedFileCount).toBe('0');

    expect(state.fetchedUrls).not.toBeNull();
    const fetchedUrls = JSON.parse(state.fetchedUrls ?? '[]') as string[];
    expect([...fetchedUrls].sort()).toEqual([...EXPECTED_FETCHED_URLS].sort());

    expect(unexpectedRequests, `予期しないリクエストが発生した: ${unexpectedRequests.join(', ')}`).toEqual([]);

    expect(state.zipB64).not.toBeNull();
    const zipBytes = decodeBase64ToBytes(state.zipB64 ?? '');
    expect(hasLocalFileHeaderSignature(zipBytes)).toBe(true);

    const parsed = parseZip(zipBytes);
    const entryNames = [...parsed.entries.map((e) => e.name)].sort();
    expect(entryNames).toEqual(EXPECTED_ZIP_ENTRIES);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

/**
 * Issue #14 の中心要件の回帰テスト: 登録できた投稿 (addByPostInfo が 'added' を返した投稿) が
 * 0 件のとき、ZIP を一切書き込まない (downloadAsZip / handle.createWritable を呼ばない) こと。
 *
 * buildCompleteMessage の文言テスト (test/overlay.test.ts) は「見出しがどう組み立つか」しか
 * 検証しておらず、「実際に downloadAsZip を呼んでいないか」は別の懸念である。0 件判定が
 * ZIP 生成後に移動する、あるいは削除されるような回帰が起きても、文言テストだけでは検出できない。
 *
 * ここでは 2 投稿とも一覧時点で isRestricted (支援プランの範囲外) の fixture を使い、
 * addByPostInfo を一度も呼ばずに addedPostCount === 0 で collect() が正常に返るケースを再現する。
 * downloadAsZip が呼ばれていれば test-hooks.ts の createTestSaveHandle().writable.close() が
 * data-fbdl-zip-done / data-fbdl-zip-b64 を publish するため、これらが null のまま
 * overlayState が 'complete' に到達することが「ZIP を書き込んでいない」ことの直接的な証拠になる。
 */
test('登録できた投稿が 0 件のとき ZIP を生成せず保存しない (Issue #14)', async () => {
  const allRestrictedResponses: Record<string, unknown> = {
    [PLANS_URL]: PLANS_RESPONSE,
    [TAGS_URL]: TAGS_RESPONSE,
    [PAGINATE_URL]: PAGINATE_RESPONSE,
    [LIST_PAGE_URL]: {
      body: {
        posts: [
          { ...POST_A_STUB, isRestricted: true },
          { ...POST_B_STUB, isRestricted: true },
        ],
      },
    },
    // isRestricted な投稿は post.info を叩かずスキップされる想定なので、
    // POST_INFO_URL_A/B はここに含めない。含めていないのに万一リクエストされれば
    // unexpectedRequests (fail-closed) で検出される。
  };

  const session = await launchAndStartDownload(allRestrictedResponses, 'nosave');
  const { context, page, overlay, userDataDir, unexpectedRequests } = session;

  try {
    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'complete' });

    const state = await page.evaluate(readTestState);

    expect(state.error, 'startCollecting でエラーが発生した').toBeNull();
    expect(state.aborted, 'ダウンロードが中断された').toBeNull();
    expect(state.unsupportedResponse, '未対応のレスポンス形式として中断された').toBeNull();
    expect(state.addedPostCount).toBe('0');
    expect(state.unavailablePostCount).toBe('2');

    // 中心要件: downloadAsZip が呼ばれていない (= ZIP を一切書き込んでいない)
    expect(state.zipDone, 'addedPostCount 0 なのに ZIP が書き込まれた (downloadAsZip が呼ばれた)').toBeNull();
    expect(state.zipB64, 'addedPostCount 0 なのに ZIP の中身が生成された').toBeNull();
    // ZIP フェーズ (downloadAsZip 内) に入っていれば publish されるはずの値も未設定のまま
    expect(state.failedFileCount, 'ZIP フェーズの集計が publish された (downloadAsZip に入ってしまった)').toBeNull();
    expect(state.fetchedUrls, 'ZIP フェーズのファイル取得が発生した').toBeNull();

    const resultText = await overlay.locator('.result-text').textContent();
    expect(resultText, '完了画面に非保存の理由が表示されていない').toBeTruthy();

    expect(unexpectedRequests, `予期しないリクエストが発生した: ${unexpectedRequests.join(', ')}`).toEqual([]);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
