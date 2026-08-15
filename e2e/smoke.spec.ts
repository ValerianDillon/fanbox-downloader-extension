import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  EXPECTED_FETCHED_URLS,
  EXPECTED_ZIP_ENTRIES,
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
import { launchAndStartDownload, readTestState } from './harness';
import { decodeBase64ToBytes, hasLocalFileHeaderSignature, parseZip } from './zip-util';

/**
 * Issue #10: 拡張の smoke test (WSL headless)。
 *
 * dist-test/ (scripts/build.ts --test でビルドした __FBDL_TEST__=true ビルド) を
 * Chromium の永続コンテキストに読み込み、FANBOX API を Playwright の routing でモックした上で
 * 「FAB クリック → 収集 → ZIP 生成」を実ブラウザで完走させる。
 * 共通のセットアップは e2e/harness.ts にある。
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
