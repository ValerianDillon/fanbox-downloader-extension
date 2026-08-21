import { afterEach, describe, expect, test } from 'bun:test';
import { ResponseParseError, resetSharedBackoff } from '../../src/content/fanbox/api';
import { collect, PostBodyInvalidError, type ProgressCallback } from '../../src/content/fanbox/collector';

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
  body: { text: '', images: [{ originalUrl: 'https://downloads.fanbox.cc/img.png', extension: 'png' }] },
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

const SETTINGS = { isIgnoreFree: false, limit: null, apiIntervalMs: 50 };

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

  test('isIgnoreFree で除外した無料投稿は失敗に数えない', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });

    const result = await collect(
      CREATOR_ID,
      undefined,
      { ...SETTINGS, isIgnoreFree: true },
      () => {},
      new AbortController().signal,
    );
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
