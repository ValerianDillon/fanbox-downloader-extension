import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Locator, Page, Route, Worker } from '@playwright/test';
import { chromium, expect } from '@playwright/test';
import { CREATOR_PAGE_URL, FILE_BODIES } from './fixtures';

/**
 * smoke test 共通のセットアップ (拡張プロファイルの起動、FANBOX API のモック、テスト状態の読み取り)。
 * e2e/smoke.spec.ts (基本フロー) と e2e/large-media.spec.ts (Issue #22 の分割転送) から使う。
 */

type Manifest = {
  host_permissions?: unknown;
  background?: { service_worker?: unknown };
};

/**
 * static/manifest.template.json を読み込む。ハードコードによる手打ち複製 (実体との乖離リスク) を避け、
 * host_permissions / background.service_worker を実ファイルから導出するために使う。
 */
function readManifest(): Manifest {
  const manifestPath = path.resolve(process.cwd(), 'static/manifest.template.json');
  return JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
}

/**
 * host_permissions (`*://*.<suffix>/*` の形式を想定) からドメインサフィックスを導出する。
 * 想定外の形式が来た場合は黙って無視せず test を fail させる (fail-closed)。
 */
function deriveAllowedHostSuffixes(manifest: Manifest): string[] {
  const hostPermissions = manifest.host_permissions;
  if (!Array.isArray(hostPermissions) || hostPermissions.length === 0) {
    throw new Error(
      `static/manifest.template.json の host_permissions が空/不正です: ${JSON.stringify(hostPermissions)}`,
    );
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
    throw new Error(`static/manifest.template.json の background.service_worker が不正です: ${JSON.stringify(swPath)}`);
  }
  return swPath;
}

const MANIFEST = readManifest();
const ALLOWED_HOST_SUFFIXES = deriveAllowedHostSuffixes(MANIFEST);
const SERVICE_WORKER_FILE_NAME = deriveServiceWorkerFileName(MANIFEST);

function isWithinExtensionHostPermissions(hostname: string): boolean {
  return ALLOWED_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

export type TestState = {
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
  /** review 画面で選択されている投稿 / 添付 / カバーの件数 (Issue #55) */
  selectedPostCount: string | null;
  selectedFileCount: string | null;
  selectedCoverCount: string | null;
  fetchedUrls: string | null;
  zipB64: string | null;
  /** ZIP 全体の Blob URL (Issue #22。大きい ZIP は zipB64 が publish されないので、こちらを fetch して検証する) */
  zipUrl: string | null;
  zipSize: string | null;
};

export function readTestState(): TestState {
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
    selectedPostCount: el.getAttribute('data-fbdl-selected-post-count'),
    selectedFileCount: el.getAttribute('data-fbdl-selected-file-count'),
    selectedCoverCount: el.getAttribute('data-fbdl-selected-cover-count'),
    fetchedUrls: el.getAttribute('data-fbdl-fetched-urls'),
    zipB64: el.getAttribute('data-fbdl-zip-b64'),
    zipUrl: el.getAttribute('data-fbdl-zip-url'),
    zipSize: el.getAttribute('data-fbdl-zip-size'),
  };
}

export type ExtensionSession = {
  context: BrowserContext;
  page: Page;
  overlay: Locator;
  /** 拡張自身の service worker (テストビルドの観測状態 globalThis.__fbdlTestState を Worker.evaluate で読むために使う) */
  serviceWorker: Worker;
  userDataDir: string;
  unexpectedRequests: string[];
};

/**
 * launchAndStartCollecting の追加オプション。
 * - routeOverride: http(s) リクエストを既定の fixture 処理より先に処理する。true を返したら処理済み。
 *   大きい本文・Range 応答・遅延など、FILE_BODIES の固定 fixture で表せない応答を返すために使う
 * - apiIntervalMs: overlay の API 間隔 (ms) 入力に入れる値 (既定 50)
 */
export type LaunchOptions = {
  routeOverride?: (route: Route, url: string) => Promise<boolean>;
  apiIntervalMs?: number;
};

/**
 * dist-test/ を読み込んだ拡張プロファイルを起動し、FANBOX API を jsonResponses でモックした上で
 * FAB クリック → 「投稿を収集」まで進める共通セットアップ。
 *
 * 収集が終わると overlay は review 状態で止まる (Issue #55)。ZIP 生成まで進めたいテストは
 * 続けて confirmReview() を呼ぶこと。収集が review に到達しないケース (登録できた投稿が 0 件、
 * 未対応のレスポンス形式) を検証するテストは呼ばない。
 *
 * 個々のテストは戻り値の page/overlay を使って、そこから先 (完了までの待機や状態の検証) だけを書く。
 * 呼び出し側は必ず finally で context.close() / rm(userDataDir, ...) を行うこと
 * (このヘルパー自体は後始末をしない)。
 */
export async function launchAndStartCollecting(
  jsonResponses: Record<string, unknown>,
  namePrefix: string,
  options: LaunchOptions = {},
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

  if (process.env.FBDL_E2E_DEBUG) {
    // 調査用: content script / service worker の console 出力を標準出力に流す
    context.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
    context.on('weberror', (err) => console.log(`[browser:weberror] ${err.error().message}`));
  }

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

    if (options.routeOverride && (url.startsWith('http://') || url.startsWith('https://'))) {
      if (await options.routeOverride(route, url)) return;
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
  await intervalInput.fill(String(options.apiIntervalMs ?? 50));
  await overlay.getByRole('button', { name: '投稿を収集' }).click();

  return { context, page, overlay, serviceWorker, userDataDir, unexpectedRequests };
}

/**
 * review 画面 (Issue #55) で全件選択のまま確定し、ZIP 生成へ進める。
 *
 * 確定ボタンは選択の導出と検証が終わるまで無効なので、有効になるのを待ってから押す。
 * ここで押すクリックが showSaveFilePicker のユーザアクティベーションになる
 * (テストビルドでは in-memory のスタブに差し替わる)。
 */
export async function confirmReview(session: ExtensionSession): Promise<void> {
  await expect
    .poll(() => session.page.evaluate(readTestState), { timeout: 30_000 })
    .toMatchObject({ overlayState: 'review' });
  const confirm = session.overlay.locator('#review-confirm');
  await expect(confirm).toBeEnabled({ timeout: 10_000 });
  await confirm.click();
}

/** launchAndStartCollecting で起動したセッションの後始末 (finally から呼ぶ) */
export async function closeSession(session: ExtensionSession): Promise<void> {
  await session.context.close();
  await rm(session.userDataDir, { recursive: true, force: true });
}
