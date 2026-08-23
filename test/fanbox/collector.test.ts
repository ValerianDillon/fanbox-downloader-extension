import { afterEach, describe, expect, test } from 'bun:test';
import { ARCHIVE_FORMAT_VERSION } from '../../src/content/archive-path';
import { ResponseParseError, resetSharedBackoff } from '../../src/content/fanbox/api';
import { collect, PostBodyInvalidError, type ProgressCallback } from '../../src/content/fanbox/collector';
import { type CreatorHistory, HISTORY_SCHEMA_VERSION } from '../../src/history-record';

const CREATOR_ID = 'testcreator';
const LIST_PAGE_URL = `https://api.fanbox.cc/post.listCreator?creatorId=${CREATOR_ID}&cursor=1`;
const POST_INFO_URL = 'https://api.fanbox.cc/post.info?postId=1001';

const POST_STUB = {
  id: '1001',
  title: 'リンゴ',
  feeRequired: 0,
  creatorId: CREATOR_ID,
  excerpt: '',
  isRestricted: false,
  tags: [],
  publishedDatetime: '2024-01-01T00:00:00+09:00',
  updatedDatetime: '2024-01-01T00:00:00+09:00',
  likeCount: 0,
  commentCount: 0,
  cover: { type: 'cover_image', url: 'https://i.pximg.net/cover.jpg' },
};

const POST_FULL = {
  ...POST_STUB,
  coverImageUrl: 'https://i.pximg.net/cover.jpg',
  type: 'image',
  body: { text: '', images: [{ id: 'img-1', originalUrl: 'https://downloads.fanbox.cc/img.png', extension: 'png' }] },
};

type ProxyApiResponse = { ok: boolean; status: number; retryAfter: string | null; body?: string };

/**
 * URL ごとの JSON レスポンスを返す chrome.runtime.sendMessage のモックを組む。
 * 値に関数を渡すと、その URL が叩かれたときのレスポンスを組み立てさせられる (abort の注入用)。
 */
function mockApi(responses: Record<string, unknown | (() => ProxyApiResponse)>) {
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: (message: { type: string; url: string }) => {
        const entry = responses[message.url];
        if (entry === undefined) return Promise.resolve({ ok: false, status: 404, retryAfter: null });
        if (typeof entry === 'function') return Promise.resolve((entry as () => ProxyApiResponse)());
        return Promise.resolve({ ok: true, status: 200, retryAfter: null, body: JSON.stringify(entry) });
      },
    },
  };
}

/**
 * `mockApi` が組んだモックを包み、要求された URL を記録する。
 * 「発行しなかったこと」を確かめるテストのために、応答そのものは変えない。
 */
function recordRequestedUrls(): string[] {
  const requested: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const chromeMock = (globalThis as any).chrome;
  const inner = chromeMock.runtime.sendMessage;
  chromeMock.runtime.sendMessage = (message: { type: string; url: string }) => {
    requested.push(message.url);
    return inner(message);
  };
  return requested;
}

const SETTINGS = { isIgnoreFree: false, limit: null, apiIntervalMs: 50 };

/** POST_STUB を「前回すべて保存できた」状態で記録した履歴 (Issue #56 の差分判定用) */
const HISTORY: CreatorHistory = {
  schemaVersion: HISTORY_SCHEMA_VERSION,
  creatorId: CREATOR_ID,
  lastUsedAt: 1,
  catalog: [
    {
      postId: POST_STUB.id,
      observedAt: 1,
      updatedDatetime: POST_STUB.updatedDatetime,
      title: POST_STUB.title,
      publishedDatetime: POST_STUB.publishedDatetime,
      complete: true,
      assets: [
        { kind: 'image', assetId: 'img-1', originalName: 'img', extension: 'png' },
        { kind: 'cover', originalName: 'cover', extension: 'jpg' },
      ],
    },
  ],
  saved: [
    {
      postId: POST_STUB.id,
      archiveDirectory: `${POST_STUB.id}_${POST_STUB.title}`,
      revision: POST_STUB.updatedDatetime,
      archiveFormatVersion: ARCHIVE_FORMAT_VERSION,
      assets: [
        {
          kind: 'image',
          assetId: 'img-1',
          archiveName: 'img_image_img-1.png',
          outcome: 'written',
          zipName: 'out.zip',
          savedAt: 2,
        },
        { kind: 'cover', archiveName: 'cover.jpg', outcome: 'written', zipName: 'out.zip', savedAt: 2 },
      ],
    },
  ],
  scan: null,
};

/**
 * 待機を即時化する。観測できない失敗の再試行は 5 秒・15 秒の固定待機で、Retry-After のように
 * テストから短くできないため、待機時間そのものが関心事でないテストではこれで実時間を待たない。
 */
function installImmediateTimers(): () => void {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler) =>
    origSetTimeout(handler as () => void, 0)) as unknown as typeof setTimeout;
  return () => {
    globalThis.setTimeout = origSetTimeout;
  };
}

/** 一覧レスポンスまでは正常形状で返す、共通のモック定義 */
const BASE_RESPONSES = {
  [`https://api.fanbox.cc/plan.listCreator?creatorId=${CREATOR_ID}`]: { body: { plans: [] } },
  [`https://api.fanbox.cc/tag.getFeatured?creatorId=${CREATOR_ID}`]: { body: { featuredTags: [] } },
  [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: { body: { pageUrls: [LIST_PAGE_URL] } },
  [LIST_PAGE_URL]: { body: { posts: [POST_STUB] } },
};

function collectCreator(signal = new AbortController().signal) {
  return collect(CREATOR_ID, undefined, SETTINGS, () => {}, signal);
}

function collectSinglePost(signal = new AbortController().signal) {
  return collect(CREATOR_ID, '1001', SETTINGS, () => {}, signal);
}

describe('collect', () => {
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const origChrome = (globalThis as any).chrome;

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = origChrome;
    resetSharedBackoff();
  });

  test('履歴に載っている変わらない投稿は post.info を発行しない (Issue #56 で実際に API コストを減らす箇所)', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });
    const requested = recordRequestedUrls();

    const result = await collect(CREATOR_ID, undefined, SETTINGS, () => {}, new AbortController().signal, HISTORY);

    expect(requested).not.toContain(POST_INFO_URL);
    expect([result.addedPostCount, [...result.skippedByHistoryPostIds]]).toEqual([0, ['1001']]);
  });

  test('省いた投稿は失敗にも成功にも数えない (取りこぼしではないため)', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });

    const result = await collect(CREATOR_ID, undefined, SETTINGS, () => {}, new AbortController().signal, HISTORY);

    expect([result.postFailures.apiFailed, result.postFailures.unavailable, result.failedPageCount]).toEqual([0, 0, 0]);
  });

  test('履歴を渡さなければ全件を取得する (「前回保存分も取得する」の経路)', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });
    const requested = recordRequestedUrls();

    const result = await collect(CREATOR_ID, undefined, SETTINGS, () => {}, new AbortController().signal, null);

    expect(requested).toContain(POST_INFO_URL);
    expect([result.addedPostCount, result.skippedByHistoryPostIds.size]).toEqual([1, 0]);
  });

  test('一覧の updatedDatetime が変わっていれば履歴があっても取得する (編集された投稿を飛ばさないため)', async () => {
    mockApi({
      ...BASE_RESPONSES,
      [LIST_PAGE_URL]: { body: { posts: [{ ...POST_STUB, updatedDatetime: '2099-01-01T00:00:00+09:00' }] } },
      [POST_INFO_URL]: { body: { post: POST_FULL } },
    });
    const requested = recordRequestedUrls();

    const result = await collect(CREATOR_ID, undefined, SETTINGS, () => {}, new AbortController().signal, HISTORY);

    expect(requested).toContain(POST_INFO_URL);
    expect(result.addedPostCount).toBe(1);
  });

  test('一覧の updatedDatetime を postId ごとに記録する (次回の差分判定を一覧の走査だけで済ませるため)', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });

    const result = await collectCreator();

    expect([...result.listedRevisions]).toEqual([['1001', POST_STUB.updatedDatetime]]);
  });

  test('updatedDatetime が欠けていても収集を止めず null として記録する (最適化の情報で収集全体を落とさないため)', async () => {
    const { updatedDatetime: _dropped, ...withoutUpdated } = POST_STUB;
    mockApi({
      ...BASE_RESPONSES,
      [LIST_PAGE_URL]: { body: { posts: [withoutUpdated] } },
      [POST_INFO_URL]: { body: { post: POST_FULL } },
    });

    const result = await collectCreator();

    expect([result.addedPostCount, result.listedRevisions.get('1001')]).toEqual([1, null]);
  });

  test('取り込めなかった投稿の updatedDatetime も記録する (次回その投稿を飛ばすかの判断に一覧の値が要るため)', async () => {
    mockApi({
      ...BASE_RESPONSES,
      [LIST_PAGE_URL]: { body: { posts: [{ ...POST_STUB, isRestricted: true }] } },
    });

    const result = await collectCreator();

    expect([result.addedPostCount, result.listedRevisions.get('1001')]).toEqual([0, POST_STUB.updatedDatetime]);
  });

  test('同じ投稿が一覧に二度来たら最初の updatedDatetime を採る (同じ入力への結果が一覧の並びに依存しないようにするため)', async () => {
    mockApi({
      ...BASE_RESPONSES,
      [LIST_PAGE_URL]: { body: { posts: [POST_STUB, { ...POST_STUB, updatedDatetime: '2099-01-01T00:00:00+09:00' }] } },
      [POST_INFO_URL]: { body: { post: POST_FULL } },
    });

    const result = await collectCreator();

    expect(result.listedRevisions.get('1001')).toBe(POST_STUB.updatedDatetime);
  });

  test('全ページを走査できたら完走として報告する (走査実績の整合性を保つため)', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });

    const result = await collectCreator();

    expect([result.scannedCreator, result.completedFullScan, result.limited]).toEqual([true, true, false]);
  });

  test('一覧ページの取得に失敗したら完走として報告しない (欠落した投稿を削除と誤認させないため)', async () => {
    mockApi({
      ...BASE_RESPONSES,
      [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: {
        body: { pageUrls: [LIST_PAGE_URL, `${LIST_PAGE_URL}&page=2`] },
      },
      [POST_INFO_URL]: { body: { post: POST_FULL } },
    });

    const result = await collectCreator();

    expect([result.failedPageCount, result.completedFullScan]).toEqual([1, false]);
  });

  test('件数上限に達して打ち切ったら完走として報告しない (一覧を全部見ていないため)', async () => {
    const secondPage = `${LIST_PAGE_URL}&page=2`;
    mockApi({
      ...BASE_RESPONSES,
      [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: {
        body: { pageUrls: [LIST_PAGE_URL, secondPage] },
      },
      [secondPage]: { body: { posts: [{ ...POST_STUB, id: '1002' }] } },
      [POST_INFO_URL]: { body: { post: POST_FULL } },
    });

    const result = await collect(
      CREATOR_ID,
      undefined,
      { ...SETTINGS, limit: 1 },
      () => {},
      new AbortController().signal,
    );

    expect([result.limited, result.completedFullScan]).toEqual([true, false]);
  });

  test('上限を設定しても達しなければ完走として報告する (一覧は全部見ているので削除の判断材料としては完走と変わらないため)', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });

    const result = await collect(
      CREATOR_ID,
      undefined,
      { ...SETTINGS, limit: 100 },
      () => {},
      new AbortController().signal,
    );

    expect([result.limited, result.completedFullScan]).toEqual([false, true]);
  });

  test('単一投稿モードは creator の走査ではないと報告する (一覧を見ていない収集で走査実績を書かせないため)', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });

    const result = await collectSinglePost();

    expect([result.scannedCreator, result.completedFullScan]).toEqual([false, false]);
  });

  test('新形状のレスポンスから投稿を収集できる', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });

    const result = await collectCreator();
    expect(result.addedPostCount).toBe(1);
    expect(result.postFailures.unavailable).toBe(0);
    expect(result.postFailures.unsupported).toBe(0);
    expect(result.postFailures.apiFailed).toBe(0);
    expect(result.failedPageCount).toBe(0);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(1);
  });

  /**
   * 一覧ページの重複などで同じ投稿が 2 回来ることがある (共有層は postId の一意性を検証せず、
   * 収集を止めないことを優先している)。archive path は postId 由来なので、2 回登録すると
   * 投稿ディレクトリ名が重複し、共有層の preflight が ZIP 全体を拒否する (Issue #56)。
   */
  test('同じ投稿が一覧に 2 回現れても 1 回しか取り込まず post.info も 1 回しか叩かない', async () => {
    mockApi({
      ...BASE_RESPONSES,
      [LIST_PAGE_URL]: { body: { posts: [POST_STUB, { ...POST_STUB }] } },
      [POST_INFO_URL]: { body: { post: POST_FULL } },
    });
    const requested = recordRequestedUrls();

    const result = await collectCreator();

    expect(result.addedPostCount).toBe(1);
    expect(result.postFailures.unavailable).toBe(0);
    expect(result.postFailures.apiFailed).toBe(0);
    expect(requested.filter((url) => url === POST_INFO_URL)).toHaveLength(1);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(1);
  });

  // 重複排除を「試行済み」にすると、最初の試行が失敗した投稿を取り直せなくなる。
  // 一覧の重複は同じ投稿なので、2 回目で取れるならそれを使う
  test('最初の取得に失敗した投稿は、重複側で取り直せる', async () => {
    let attempts = 0;
    mockApi({
      ...BASE_RESPONSES,
      [LIST_PAGE_URL]: { body: { posts: [POST_STUB, { ...POST_STUB }] } },
      [POST_INFO_URL]: () => {
        attempts += 1;
        return attempts === 1
          ? { ok: false, status: 500, retryAfter: null }
          : { ok: true, status: 200, retryAfter: null, body: JSON.stringify({ body: { post: POST_FULL } }) };
      },
    });

    const result = await collectCreator();

    expect(result.addedPostCount).toBe(1);
    // 取り直せたので失敗としては数えない
    expect(result.postFailures.apiFailed).toBe(0);
  });

  // 「結果が出たら以前の失敗を取り消す」は post.info を叩かずに確定する経路でも成り立つ必要がある。
  // 残すと、同じ投稿が閲覧不可としても API 失敗としても数えられる
  test('最初の取得に失敗した投稿が重複側で閲覧不可と分かったら、API 失敗としては数えない', async () => {
    let attempts = 0;
    mockApi({
      ...BASE_RESPONSES,
      [LIST_PAGE_URL]: { body: { posts: [POST_STUB, { ...POST_STUB, isRestricted: true }] } },
      [POST_INFO_URL]: () => {
        attempts += 1;
        return { ok: false, status: 500, retryAfter: null };
      },
    });

    const result = await collectCreator();

    expect(attempts).toBe(1);
    expect(result.postFailures.apiFailed).toBe(0);
    expect(result.postFailures.unavailable).toBe(1);
  });

  // 件数で数えると、1 つの投稿が 2 件の失敗になる
  test('同じ投稿が 2 回失敗しても失敗件数は 1 件になる', async () => {
    mockApi({
      ...BASE_RESPONSES,
      [LIST_PAGE_URL]: { body: { posts: [POST_STUB, { ...POST_STUB }] } },
      [POST_INFO_URL]: () => ({ ok: false, status: 500, retryAfter: null }),
    });

    const result = await collectCreator();

    expect(result.addedPostCount).toBe(0);
    expect(result.postFailures.apiFailed).toBe(1);
  });

  test('投稿一覧の形状が想定外なら失敗件数に丸めず中断する', async () => {
    // 旧形状 (body 直下に配列) が返ってきたケース
    mockApi({ ...BASE_RESPONSES, [LIST_PAGE_URL]: { body: [POST_STUB] } });

    await expect(collectCreator()).rejects.toThrow(/形状が想定外/);
  });

  test('投稿詳細の形状が想定外なら失敗件数に丸めず中断する', async () => {
    // 旧形状 (body 直下が投稿) が返ってきたケース
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: POST_FULL } });

    await expect(collectCreator()).rejects.toThrow(/形状が想定外/);
  });

  test('投稿詳細が JSON として読めない (壊れた本文) なら失敗件数に丸めず中断する', async () => {
    // 投稿単位の失敗として数えて続行すると、仕様変更で全投稿が読めなくなっても
    // 「N 件失敗」の中身のない ZIP を完了として出してしまう
    mockApi({
      ...BASE_RESPONSES,
      [POST_INFO_URL]: () => ({ ok: true, status: 200, retryAfter: null, body: '{ broken' }),
    });

    await expect(collectCreator()).rejects.toThrow(ResponseParseError);
  });

  test('ページ URL 一覧の形状が想定外なら中断する', async () => {
    mockApi({
      ...BASE_RESPONSES,
      // 旧形状 (body 直下に配列) が返ってきたケース
      [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: { body: [LIST_PAGE_URL] },
    });

    await expect(collectCreator()).rejects.toThrow(/形状が想定外/);
  });

  test('ページ URL 一覧の取得中の想定外の例外 (HttpError 以外) は汎用エラーに丸めず元のまま伝播する', async () => {
    // service worker からの応答オブジェクト自体が壊れている (undefined) ケースを模擬する。
    // fetchJson 内部で response.backoffUntil の参照時に TypeError が起きる
    // (test/fanbox/api.test.ts の「想定外の例外」テストと同じ技法)。TypeError は
    // HttpError ではないので、「投稿一覧の取得に失敗しました」という汎用エラーに
    // 丸めず、型・メッセージ・スタックを保ったまま伝播すべき
    mockApi({
      ...BASE_RESPONSES,
      [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: () =>
        undefined as unknown as ProxyApiResponse,
    });

    const error = await collectCreator().catch((e) => e);
    expect(error).toBeInstanceOf(TypeError);
  });

  test('一覧要素が id / isRestricted を欠いていれば中断する', async () => {
    // ラッパーは新形状のまま、要素側の型だけが変わったケース
    mockApi({ ...BASE_RESPONSES, [LIST_PAGE_URL]: { body: { posts: [{ id: '1001', isRestricted: 'false' }] } } });

    await expect(collectCreator()).rejects.toThrow(/形状が想定外/);
  });

  test('閲覧できない投稿も欠落するので unavailable (restricted) に数える', async () => {
    // 一覧が全件 isRestricted になったとき、空の ZIP を失敗 0 件で完了させないため
    const restricted = { ...POST_STUB, isRestricted: true };
    mockApi({ ...BASE_RESPONSES, [LIST_PAGE_URL]: { body: { posts: [restricted] } } });

    const result = await collectCreator();
    expect(result.addedPostCount).toBe(0);
    expect(result.postFailures.unavailable).toBe(1);
    expect(result.postFailures.unavailableRestricted).toBe(1);
    expect(result.postFailures.unavailableMissingBody).toBe(0);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(0);
  });

  test('isIgnoreFree のとき閲覧できない無料投稿は失敗に数えない', async () => {
    const restricted = { ...POST_STUB, isRestricted: true, feeRequired: 0 };
    mockApi({ ...BASE_RESPONSES, [LIST_PAGE_URL]: { body: { posts: [restricted] } } });

    const result = await collect(
      CREATOR_ID,
      undefined,
      { ...SETTINGS, isIgnoreFree: true },
      () => {},
      new AbortController().signal,
    );
    expect(result.postFailures.unavailable).toBe(0);
  });

  test('投稿を集める前の枯渇は打ち切りではなくエラーにする', async () => {
    // プラン名とタグは投稿収集の前に走る。ここで枯渇したとき打ち切り扱いにすると、
    // 中身のない ZIP を「取得できた分のみ保存」として出してしまう
    const rateLimited = () => ({ ok: false, status: 429, retryAfter: '0' });
    for (const url of [
      `https://api.fanbox.cc/plan.listCreator?creatorId=${CREATOR_ID}`,
      `https://api.fanbox.cc/tag.getFeatured?creatorId=${CREATOR_ID}`,
    ]) {
      mockApi({ ...BASE_RESPONSES, [url]: rateLimited });
      await expect(collectCreator()).rejects.toThrow(/レート制限の再試行上限/);
    }
  });

  test('1 件も取り込めないまま枯渇したら打ち切りではなくエラーにする', async () => {
    // 投稿単位の失敗に丸めない (丸めると、制限が続く間ずっと残りが 1 件ずつ失敗していく) が、
    // 取り込めた投稿が無いので打ち切りとして返すこともしない。
    // 中身のない ZIP を「取得できた分のみ保存しています」と表示して出さないため
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: () => ({ ok: false, status: 429, retryAfter: '0' }) });

    await expect(collectCreator()).rejects.toThrow(/レート制限の再試行上限/);
  });

  test('一覧ページの取得が最初から枯渇した場合もエラーにする', async () => {
    mockApi({ ...BASE_RESPONSES, [LIST_PAGE_URL]: () => ({ ok: false, status: 429, retryAfter: '0' }) });

    await expect(collectCreator()).rejects.toThrow(/レート制限の再試行上限/);
  });

  test('ページ URL 一覧の取得が枯渇した場合もエラーにする', async () => {
    mockApi({
      ...BASE_RESPONSES,
      [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: () => ({
        ok: false,
        status: 429,
        retryAfter: '0',
      }),
    });

    await expect(collectCreator()).rejects.toThrow(/レート制限の再試行上限/);
  });

  test('単一投稿モードで枯渇した場合もエラーにする', async () => {
    // 取り込めるものが 1 件しかないので、枯渇は常に「取得できた分」が無い
    mockApi({ [POST_INFO_URL]: () => ({ ok: false, status: 429, retryAfter: '0' }) });

    await expect(collectSinglePost()).rejects.toThrow(/レート制限の再試行上限/);
  });

  test('打ち切りでもそこまでに集めた投稿は捨てない', async () => {
    const second = { ...POST_STUB, id: '1002' };
    let infoCalls = 0;
    mockApi({
      ...BASE_RESPONSES,
      [LIST_PAGE_URL]: { body: { posts: [POST_STUB, second] } },
      [POST_INFO_URL]: { body: { post: POST_FULL } },
      'https://api.fanbox.cc/post.info?postId=1002': () => {
        infoCalls++;
        return { ok: false, status: 429, retryAfter: '0' };
      },
    });

    const result = await collectCreator();
    expect(result.stoppedReason).toBe('rate-limit-exhausted');
    expect(infoCalls).toBeGreaterThan(0);
    expect(result.addedPostCount).toBe(1);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(1);
  });

  test('通信の枯渇で打ち切ったときも、そこまでに集めた投稿は捨てない', async () => {
    // レート制限の枯渇と同じく、投稿ループの途中で枯渇しても集計を返さないと、
    // 取り込めた投稿があるのに例外として扱われて部分保存の判断ができなくなる
    const restoreTimers = installImmediateTimers();
    try {
      const second = { ...POST_STUB, id: '1002' };
      let infoCalls = 0;
      mockApi({
        ...BASE_RESPONSES,
        [LIST_PAGE_URL]: { body: { posts: [POST_STUB, second] } },
        [POST_INFO_URL]: { body: { post: POST_FULL } },
        'https://api.fanbox.cc/post.info?postId=1002': () => {
          infoCalls++;
          // service worker は fetch の失敗を reject せず status 0 で返す
          return { ok: false, status: 0, retryAfter: null };
        },
      });

      const result = await collectCreator();
      // レート制限とは停止理由を分ける。時間を置けばよいのか環境側を確認すべきかが違う
      expect(result.stoppedReason).toBe('transport-exhausted');
      // 初回 + 再試行 2 回で枯渇する
      expect(infoCalls).toBe(3);
      expect(result.addedPostCount).toBe(1);
      expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(1);
    } finally {
      restoreTimers();
    }
  });

  test('2 ページ目で枯渇しても 1 ページ目までに集めた投稿は捨てない', async () => {
    // 一覧ページの境界での枯渇は、投稿詳細での枯渇とは別の分岐 (fetchPostList の catch) を通る。
    // ここで集計を返さずに throw すると、2 ページ目の枯渇で 1 ページ目の取得結果ごと失われる
    const secondPageUrl = `https://api.fanbox.cc/post.listCreator?creatorId=${CREATOR_ID}&cursor=2`;
    const restoreTimers = installImmediateTimers();
    try {
      for (const [reason, failure] of [
        ['rate-limit-exhausted', { ok: false, status: 429, retryAfter: '0' }],
        ['transport-exhausted', { ok: false, status: 0, retryAfter: null }],
      ] as const) {
        mockApi({
          ...BASE_RESPONSES,
          [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: {
            body: { pageUrls: [LIST_PAGE_URL, secondPageUrl] },
          },
          [POST_INFO_URL]: { body: { post: POST_FULL } },
          [secondPageUrl]: () => failure,
        });

        const result = await collectCreator();
        expect(result.stoppedReason).toBe(reason);
        expect(result.addedPostCount).toBe(1);
        expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(1);
      }
    } finally {
      restoreTimers();
    }
  });

  test('投稿一覧ページの取得失敗は投稿件数と分けて数える', async () => {
    // 1 ページに複数投稿が載るため、投稿 1 件の失敗として数えると欠落を過少報告する
    mockApi({ ...BASE_RESPONSES, [LIST_PAGE_URL]: () => ({ ok: false, status: 500, retryAfter: null }) });

    const result = await collectCreator();
    expect(result.failedPageCount).toBe(1);
    expect(result.addedPostCount).toBe(0);
    expect(result.postFailures.unavailable).toBe(0);
    expect(result.postFailures.unsupported).toBe(0);
    expect(result.postFailures.apiFailed).toBe(0);
  });

  test('投稿処理中の想定外の例外 (onProgress のバグ等) は一覧ページの失敗に丸めず伝播する', async () => {
    // 一覧ページの取得自体は成功しているのに、投稿ループ内 (ここでは呼び出し元の
    // onProgress) で起きた想定外の例外まで「このページの一覧取得に失敗した」に丸めると、
    // こちらのバグが静かに failedPageCount++ に吸収され、部分 ZIP がそのまま
    // 保存されてしまう (addByPostInfo の未検証例外でも同じ経路を通る)
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });
    const boom = new Error('onProgress boom');
    const throwingProgress: ProgressCallback = () => {
      throw boom;
    };

    await expect(collect(CREATOR_ID, undefined, SETTINGS, throwingProgress, new AbortController().signal)).rejects.toBe(
      boom,
    );
  });

  test('isIgnoreFree で除外した無料投稿は post.info を叩かず、失敗にも数えない', async () => {
    // 除外すると分かっている投稿に post.info を発行すると、レート制限の枠と待機時間を
    // 無駄に使う (発行しても addByPostInfo が同じ条件で 'ignored' を返すだけ)
    let postInfoCalls = 0;
    mockApi({
      ...BASE_RESPONSES,
      [POST_INFO_URL]: () => {
        postInfoCalls++;
        return { ok: true, status: 200, retryAfter: null, body: JSON.stringify({ body: { post: POST_FULL } }) };
      },
    });

    const result = await collect(
      CREATOR_ID,
      undefined,
      { ...SETTINGS, isIgnoreFree: true },
      () => {},
      new AbortController().signal,
    );
    expect(postInfoCalls).toBe(0);
    expect(result.addedPostCount).toBe(0);
    expect(result.postFailures.unavailable).toBe(0);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(0);
  });

  test('本文のない投稿は無言で消さず unavailable (missing-body) に数える', async () => {
    // 形状としては妥当だが body だけが無いケース (支援額不足、または本文の在り処の変更)
    const { body, ...withoutBody } = POST_FULL;
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: withoutBody } } });

    const result = await collectCreator();
    expect(result.addedPostCount).toBe(0);
    expect(result.postFailures.unavailable).toBe(1);
    expect(result.postFailures.unavailableRestricted).toBe(0);
    expect(result.postFailures.unavailableMissingBody).toBe(1);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(0);
  });

  test('投稿詳細のラッパーは正しくても中身 (id/type/isRestricted) が想定外なら API 層で中断する', async () => {
    // body.post は在るが type / isRestricted を失っているケース (api.ts の形状検証で弾かれる)
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: { id: '1001' } } } });

    await expect(collectCreator()).rejects.toThrow(/形状が想定外/);
  });

  test('既知の投稿タイプなのに本文の必須フィールドが欠けていれば invalid として中断する (download-helper v4.5.0)', async () => {
    // api.ts の形状検証 (id/type/isRestricted) は通るが、addByPostInfo が実際に読む
    // body.images が欠けているケース。仕様変更に追随できていない構造的な不一致として扱う
    const { body, ...rest } = POST_FULL;
    const invalidBody = { ...rest, body: { text: 'x' } };
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: invalidBody } } });

    await expect(collectCreator()).rejects.toThrow(PostBodyInvalidError);
    await expect(collectCreator()).rejects.toThrow(/投稿データの形式が想定外/);
  });

  test('未知の投稿タイプは中断せず unsupported に数える (download-helper v4.5.0)', async () => {
    const unknownTypePost = { ...POST_FULL, type: 'poll', body: {} };
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: unknownTypePost } } });

    const result = await collectCreator();
    expect(result.addedPostCount).toBe(0);
    expect(result.postFailures.unsupported).toBe(1);
    expect(result.postFailures.unavailable).toBe(0);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(0);
  });

  test('投稿詳細が通常の HTTP 失敗なら収集を続行して apiFailed 1 件と数える', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: () => ({ ok: false, status: 500, retryAfter: null }) });

    const result = await collectCreator();
    expect(result.addedPostCount).toBe(0);
    expect(result.postFailures.apiFailed).toBe(1);
    expect(result.postFailures.unavailable).toBe(0);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(0);
  });

  test('中断が観測された時点で失敗件数に数えず収集を終える', async () => {
    const controller = new AbortController();
    mockApi({
      ...BASE_RESPONSES,
      [POST_INFO_URL]: () => {
        controller.abort();
        return { ok: false, status: 500, retryAfter: null };
      },
    });

    const result = await collectCreator(controller.signal);
    expect(result.addedPostCount).toBe(0);
    expect(result.postFailures.apiFailed).toBe(0);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(0);
  });

  test('単一投稿モードでも形状が想定外なら中断する', async () => {
    // 旧形状 (body 直下が投稿) が返ってきたケース
    mockApi({ [POST_INFO_URL]: { body: POST_FULL } });

    await expect(collectSinglePost()).rejects.toThrow(/形状が想定外/);
  });

  test('単一投稿モードで本文が invalid なら中断する', async () => {
    const { body, ...rest } = POST_FULL;
    const invalidBody = { ...rest, body: { text: 'x' } };
    mockApi({ [POST_INFO_URL]: { body: { post: invalidBody } } });

    await expect(collectSinglePost()).rejects.toThrow(PostBodyInvalidError);
  });

  test('単一投稿モードで通常の HTTP 失敗なら apiFailed 1 件として完了する', async () => {
    mockApi({ [POST_INFO_URL]: () => ({ ok: false, status: 500, retryAfter: null }) });

    const result = await collectSinglePost();
    expect(result.addedPostCount).toBe(0);
    expect(result.postFailures.apiFailed).toBe(1);
  });
});
