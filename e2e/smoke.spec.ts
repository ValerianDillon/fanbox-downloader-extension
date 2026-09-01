import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  CREATOR_ID,
  EXPECTED_FETCHED_URLS,
  EXPECTED_ZIP_ENTRIES,
  LIST_PAGE_RESPONSE,
  LIST_PAGE_URL,
  PAGINATE_RESPONSE,
  PAGINATE_URL,
  PLANS_RESPONSE,
  PLANS_URL,
  POST_A_FULL,
  POST_A_STUB,
  POST_B_FILE_URL,
  POST_B_STUB,
  POST_INFO_RESPONSE_A,
  POST_INFO_RESPONSE_B,
  POST_INFO_URL_A,
  POST_INFO_URL_B,
  TAGS_RESPONSE,
  TAGS_URL,
} from './fixtures';
import { confirmReview, launchAndStartCollecting, readTestState } from './harness';
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
  const session = await launchAndStartCollecting(JSON_RESPONSES, 'ok');
  const { context, page, userDataDir, unexpectedRequests } = session;

  try {
    // 収集後は review で止まる。全件選択のまま確定して ZIP 生成へ進める (Issue #55)
    await confirmReview(session);

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

    // Issue #56: 収集と ZIP の結果が実際に履歴として書かれるところまでを見る。
    // 差分の組み立て (test/history-update.ts) と送信の判断 (test/overlay.test.ts) を
    // 個別に固定しても、overlay からの呼び出しを消した退行は検出できない。
    // service worker 側の storage を直接読むことで、収集 → overlay → service worker →
    // storage の配線全体を一度に確かめる
    const history = await session.serviceWorker.evaluate(async (creatorId: string) => {
      const key = `fbdlHistory:${creatorId}`;
      const stored = await chrome.storage.local.get(key);
      const record = stored[key] as
        | { catalog?: unknown[]; saved?: { assets?: { outcome?: string }[] }[]; scan?: { completedFullScan?: boolean } }
        | undefined;
      return {
        catalogCount: record?.catalog?.length ?? 0,
        savedCount: record?.saved?.length ?? 0,
        writtenCount:
          record?.saved?.reduce(
            (total, post) => total + (post.assets ?? []).filter((asset) => asset.outcome === 'written').length,
            0,
          ) ?? 0,
        completedFullScan: record?.scan?.completedFullScan ?? null,
      };
    }, CREATOR_ID);

    expect(history).toEqual({
      catalogCount: 2,
      savedCount: 2,
      // 取得系のエントリ (カバー + 本文アセット) の数。投稿ディレクトリ直下の生成物
      // (index.html / post.json) とルートの固定ファイルは含めない
      writtenCount: EXPECTED_ZIP_ENTRIES.filter(
        (name) => name.split('/').length === 3 && !name.endsWith('/') && !/\/(index\.html|post\.json)$/.test(name),
      ).length,
      completedFullScan: true,
    });
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

/**
 * 保存済みの投稿も 2 回目の収集で `post.info` を再取得し、編集を検出できることを確認する。
 *
 * 単体テストは履歴の組み立てと保存済み判定を別々に固定しているが、次の配線は押さえていない。
 *
 * - 収集の開始時に storage から履歴を読むこと
 * - 保存履歴があっても全投稿の詳細を再取得すること
 * - 同じ世代を保存済みと表示し、既定では投稿を選択しないこと
 * - 再観測しても既存の保存実績が失われないこと
 *
 * 同じブラウザコンテキストで 2 回収集し、2 回目の review と履歴を確認する。
 */
test('2 回目も投稿情報を取得し、前回保存済みの投稿を既定未選択で表示する', async () => {
  const session = await launchAndStartCollecting(JSON_RESPONSES, 'diff');
  const { context, page, overlay, userDataDir } = session;

  try {
    await confirmReview(session);
    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'complete', zipDone: '1' });

    const beforeSecond = await session.serviceWorker.evaluate(async (creatorId: string) => {
      const key = `fbdlHistory:${creatorId}`;
      const stored = await chrome.storage.local.get(key);
      return JSON.stringify(stored[key]);
    }, CREATOR_ID);

    // 完了画面を閉じ、同じページから 2 回目の収集を始める
    await overlay.getByRole('button', { name: '閉じる' }).click();
    await page.locator('#fanbox-downloader-ext-fab button').click();
    // 履歴の読み込みが済むまで「記録を削除」は現れない
    await expect(overlay.locator('#history-forget')).toBeVisible({ timeout: 10_000 });

    const requestedAfter: string[] = [];
    await context.route('https://api.fanbox.cc/post.info**', async (route) => {
      requestedAfter.push(route.request().url());
      await route.fallback();
    });
    await overlay.getByRole('button', { name: '投稿を収集' }).click();

    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'review', addedPostCount: '2', selectedPostCount: '0' });

    expect(requestedAfter.sort()).toEqual([POST_INFO_URL_A, POST_INFO_URL_B].sort());
    await expect(overlay.locator('.review-post-list > li.is-saved')).toHaveCount(2);
    await expect(overlay.locator('.review-post-list > li input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(overlay.locator('#review-confirm')).toBeDisabled();

    // 再観測だけの回でも既存の保存実績は失われない
    const afterSecond = await session.serviceWorker.evaluate(async (creatorId: string) => {
      const key = `fbdlHistory:${creatorId}`;
      const stored = await chrome.storage.local.get(key);
      const record = stored[key] as { catalog?: unknown[]; saved?: unknown[] } | undefined;
      return { catalogCount: record?.catalog?.length ?? 0, savedCount: record?.saved?.length ?? 0 };
    }, CREATOR_ID);
    expect(afterSecond).toEqual({ catalogCount: 2, savedCount: 2 });
    expect(beforeSecond).not.toBeUndefined();
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

  const session = await launchAndStartCollecting(allRestrictedResponses, 'nosave');
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

/**
 * Issue #55: review 画面での選択が ZIP の中身と ZIP フェーズの取得要求の両方に届くこと。
 *
 * 「選択できる UI がある」ことと「選択が実際に効く」ことは別の懸念である。UI の状態だけを
 * 見るテストでは、選択条件を projection へ渡し忘れても通ってしまう。ここでは投稿 A (リンゴ) と
 * カバーを外し、ZIP に投稿 B (バナナ) のディレクトリしか無いこと、および外した対象の URL を
 * 一度も要求していないことを確かめる。
 */
test('review で外した投稿とカバーは ZIP にも取得要求にも現れない (Issue #55)', async () => {
  const session = await launchAndStartCollecting(JSON_RESPONSES, 'select');
  const { context, page, overlay, userDataDir, unexpectedRequests } = session;

  try {
    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'review' });

    await overlay.locator('#review-cover').uncheck();
    await overlay.locator('.review-post-list li', { hasText: 'リンゴ' }).locator('input[type="checkbox"]').uncheck();

    // 選択の集計が UI に反映されてから確定する (確定前の表示と ZIP の中身が一致することの確認)
    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 10_000 })
      .toMatchObject({ selectedPostCount: '1', selectedFileCount: '1', selectedCoverCount: '0' });

    await confirmReview(session);

    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'complete', zipDone: '1' });

    const state = await page.evaluate(readTestState);
    expect(state.error, 'startCollecting でエラーが発生した').toBeNull();
    expect(state.aborted, 'ダウンロードが中断された').toBeNull();
    expect(state.failedFileCount).toBe('0');

    // 外した対象は ZIP フェーズで一度も要求されない (カバー 2 件と投稿 A の画像が消える)
    const fetchedUrls = JSON.parse(state.fetchedUrls ?? '[]') as string[];
    expect(fetchedUrls).toEqual([POST_B_FILE_URL]);

    const zipBytes = decodeBase64ToBytes(state.zipB64 ?? '');
    const parsed = parseZip(zipBytes);
    expect([...parsed.entries.map((e) => e.name)].sort()).toEqual(
      [
        'testcreator/',
        'testcreator/index.html',
        'testcreator/download-manifest.json',
        'testcreator/バナナ [1002]/',
        'testcreator/バナナ [1002]/post.json',
        'testcreator/バナナ [1002]/index.html',
        'testcreator/バナナ [1002]/002.pdf',
      ].sort(),
    );

    expect(unexpectedRequests, `予期しないリクエストが発生した: ${unexpectedRequests.join(', ')}`).toEqual([]);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

/**
 * Issue #55: 拡張子の選択が ZIP と ZIP フェーズの取得要求に届くこと。
 *
 * 投稿とカバーだけを外すテストでは、`Selection` 全体を渡し忘れて全件相当に戻る退行は
 * 検出できても、**拡張子の軸だけが効かない退行**は検出できない (拡張子のチェックが選択の
 * SoT を更新しない、`toSelection` が extensions を落とす、など)。ここでは投稿もカバーも
 * 残したまま `.pdf` だけを外し、その添付だけが消えることを確かめる。
 */
test('review で外した拡張子の添付だけが ZIP から消える (Issue #55)', async () => {
  const session = await launchAndStartCollecting(JSON_RESPONSES, 'ext');
  const { context, page, overlay, userDataDir, unexpectedRequests } = session;

  try {
    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'review' });

    await overlay.locator('.review-chip', { hasText: '.pdf' }).locator('input[type="checkbox"]').uncheck();

    // 投稿とカバーは全件のまま、添付だけが 2 件から 1 件に減る
    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 10_000 })
      .toMatchObject({ selectedPostCount: '2', selectedFileCount: '1', selectedCoverCount: '2' });

    await confirmReview(session);

    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'complete', zipDone: '1' });

    const state = await page.evaluate(readTestState);
    expect(state.error, 'startCollecting でエラーが発生した').toBeNull();
    expect(state.failedFileCount).toBe('0');

    const fetchedUrls = JSON.parse(state.fetchedUrls ?? '[]') as string[];
    expect([...fetchedUrls].sort()).toEqual([...EXPECTED_FETCHED_URLS].filter((url) => url !== POST_B_FILE_URL).sort());

    const parsed = parseZip(decodeBase64ToBytes(state.zipB64 ?? ''));
    expect([...parsed.entries.map((e) => e.name)].sort()).toEqual(
      EXPECTED_ZIP_ENTRIES.filter((name) => name !== 'testcreator/バナナ [1002]/002.pdf'),
    );

    expect(unexpectedRequests, `予期しないリクエストが発生した: ${unexpectedRequests.join(', ')}`).toEqual([]);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

/**
 * Issue #56: 同名の投稿が並んでも archive path が衝突しないこと。
 *
 * 従来の採番は同名グループの件数に依存しており、投稿タイトルが `a` / `a` / `a_1` のとき
 * `a_2` / `a_1` / `a_1` を割り当てて**同じディレクトリ名を 2 回作っていた**。
 * 同じパスに 2 投稿ぶんの中身が入ると、片方の `index.html` とメタデータが失われる。
 * postId 由来の採番ではこの入力でも 3 投稿が別々のディレクトリに入る。
 */
test('同名の投稿が並んでも archive path が衝突しない (Issue #56)', async () => {
  const collidingTitles = ['a', 'a', 'a_1'];
  const collidingIds = ['2001', '2002', '2003'];
  const collidingResponses: Record<string, unknown> = {
    [PLANS_URL]: PLANS_RESPONSE,
    [TAGS_URL]: TAGS_RESPONSE,
    [PAGINATE_URL]: PAGINATE_RESPONSE,
    [LIST_PAGE_URL]: {
      body: { posts: collidingIds.map((id, i) => ({ ...POST_A_STUB, id, title: collidingTitles[i] })) },
    },
    ...Object.fromEntries(
      collidingIds.map((id, i) => [
        `https://api.fanbox.cc/post.info?postId=${id}`,
        { body: { post: { ...POST_A_FULL, id, title: collidingTitles[i] } } },
      ]),
    ),
  };

  const session = await launchAndStartCollecting(collidingResponses, 'collide');
  const { context, page, userDataDir } = session;

  try {
    await confirmReview(session);

    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'complete', zipDone: '1' });

    const state = await page.evaluate(readTestState);
    expect(state.error, 'startCollecting でエラーが発生した').toBeNull();

    const parsed = parseZip(decodeBase64ToBytes(state.zipB64 ?? ''));
    const names = parsed.entries.map((e) => e.name);
    // 3 投稿が別々のディレクトリに入り、どれも index.html と post.json を失っていない
    for (const [index, id] of collidingIds.entries()) {
      const dir = `testcreator/${collidingTitles[index]} [${id}]`;
      expect(names, `${dir} が作られていない`).toContain(`${dir}/`);
      expect(names).toContain(`${dir}/index.html`);
      expect(names).toContain(`${dir}/post.json`);
    }
    expect(new Set(names).size, 'ZIP のエントリ名が重複している').toBe(names.length);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

/**
 * Issue #55: 対象の導出か検証に失敗したら、**保存先を確保する前に**確定できなくなること。
 *
 * `showSaveFilePicker` は解決した時点で対象ファイルの中身を空にする (新規なら 0 バイトで作成し、
 * 既存ファイルを選べばその内容を消す)。picker の後で ZIP 生成が入力の不備で落ちると、書くものが
 * 無いまま利用者のファイルだけが空になる。
 *
 * 検証は共有層の `preflight` を通す。`isDownloadJsonObj` だけでは型検証しか行わず、ZIP のエントリ名が
 * 上限を超えるような**型検証を通る入力**が picker の後で落ちる。
 * 拡張子は共有層の decoder が文字列としてしか検証しておらず、archive 名の長さ制限も掛からないので、
 * 長い拡張子を返す投稿でこの経路を通す。現実の FANBOX では起きない入力である。
 */
test('導出に失敗する収集結果は、保存先を確保する前に確定できなくなる (Issue #55)', async () => {
  const longExtension = 'a'.repeat(70_000);
  const longPost = {
    ...POST_A_FULL,
    id: '3001',
    type: 'file',
    body: {
      text: '',
      files: [
        { id: 'long-1', url: 'https://downloads.fanbox.cc/files/3001/x', name: '資料', extension: longExtension },
      ],
    },
  };
  const longResponses: Record<string, unknown> = {
    [PLANS_URL]: PLANS_RESPONSE,
    [TAGS_URL]: TAGS_RESPONSE,
    [PAGINATE_URL]: PAGINATE_RESPONSE,
    [LIST_PAGE_URL]: { body: { posts: [{ ...POST_A_STUB, id: '3001' }] } },
    'https://api.fanbox.cc/post.info?postId=3001': { body: { post: longPost } },
  };

  const session = await launchAndStartCollecting(longResponses, 'toolong');
  const { context, page, overlay, userDataDir, unexpectedRequests } = session;

  try {
    await expect
      .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
      .toMatchObject({ overlayState: 'review' });

    // 導出は選択の変更から少し待って走るので、エラーが出るまで待つ
    await expect(overlay.locator('#review-error')).toContainText('長すぎます', { timeout: 10_000 });
    await expect(overlay.locator('#review-confirm')).toBeDisabled();

    const state = await page.evaluate(readTestState);
    expect(state.overlayState, 'review に留まっていない').toBe('review');
    // 保存先を確保していないことの証拠。テストビルドのハンドルは close() で zip-done を publish する
    expect(state.zipDone, '保存先を確保して ZIP を書いてしまった').toBeNull();
    expect(state.fetchedUrls, 'ZIP フェーズのファイル取得が発生した').toBeNull();

    expect(unexpectedRequests, `予期しないリクエストが発生した: ${unexpectedRequests.join(', ')}`).toEqual([]);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
