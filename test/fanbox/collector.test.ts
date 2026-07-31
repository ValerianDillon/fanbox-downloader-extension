import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetApiRateLimitState } from '../../src/content/fanbox/api';
import { collect } from '../../src/content/fanbox/collector';

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

  beforeEach(() => {
    resetApiRateLimitState();
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = origChrome;
    resetApiRateLimitState();
  });

  test('新形状のレスポンスから投稿を収集できる', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: POST_FULL } } });

    const result = await collectCreator();
    expect(result.failedPostCount).toBe(0);
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

  test('ページ URL 一覧の形状が想定外なら中断する', async () => {
    mockApi({
      ...BASE_RESPONSES,
      // 旧形状 (body 直下に配列) が返ってきたケース
      [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: { body: [LIST_PAGE_URL] },
    });

    await expect(collectCreator()).rejects.toThrow(/形状が想定外/);
  });

  test('一覧要素が id / isRestricted を欠いていれば中断する', async () => {
    // ラッパーは新形状のまま、要素側の型だけが変わったケース
    mockApi({ ...BASE_RESPONSES, [LIST_PAGE_URL]: { body: { posts: [{ id: '1001', isRestricted: 'false' }] } } });

    await expect(collectCreator()).rejects.toThrow(/形状が想定外/);
  });

  test('本文のない投稿は無言で消さず失敗件数に数える', async () => {
    // 形状としては妥当だが body だけが無いケース (支援額不足、または本文の在り処の変更)
    const { body, ...withoutBody } = POST_FULL;
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: withoutBody } } });

    const result = await collectCreator();
    expect(result.failedPostCount).toBe(1);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(0);
  });

  test('投稿詳細のラッパーは正しくても中身が想定外なら中断する', async () => {
    // body.post は在るが type / body を失っているケース (空の ZIP を成功扱いにしない)
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: { body: { post: { id: '1001' } } } });

    await expect(collectCreator()).rejects.toThrow(/形状が想定外/);
  });

  test('投稿詳細が通常の HTTP 失敗なら収集を続行して失敗 1 件と数える', async () => {
    mockApi({ ...BASE_RESPONSES, [POST_INFO_URL]: () => ({ ok: false, status: 500, retryAfter: null }) });

    const result = await collectCreator();
    expect(result.failedPostCount).toBe(1);
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
    expect(result.failedPostCount).toBe(0);
    expect(JSON.parse(result.downloadObject.stringify()).posts).toHaveLength(0);
  });

  test('単一投稿モードでも形状が想定外なら中断する', async () => {
    // 旧形状 (body 直下が投稿) が返ってきたケース
    mockApi({ [POST_INFO_URL]: { body: POST_FULL } });

    await expect(collectSinglePost()).rejects.toThrow(/形状が想定外/);
  });

  test('単一投稿モードで通常の HTTP 失敗なら失敗 1 件として完了する', async () => {
    mockApi({ [POST_INFO_URL]: () => ({ ok: false, status: 500, retryAfter: null }) });

    const result = await collectSinglePost();
    expect(result.failedPostCount).toBe(1);
  });
});
