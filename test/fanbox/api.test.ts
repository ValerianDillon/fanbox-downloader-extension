import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_API_RATE_LIMIT_MS,
  detectPage,
  fetchPaginatedPosts,
  fetchPlans,
  fetchPostInfo,
  fetchPostList,
  fetchTags,
  getApiRateLimitMs,
  resetApiRateLimitState,
  setApiRateLimitMs,
} from '../../src/content/fanbox/api';

describe('detectPage', () => {
  describe('www.fanbox.cc 形式', () => {
    test('creator ページ', () => {
      const result = detectPage('https://www.fanbox.cc/@testcreator');
      expect(result).toEqual({ type: 'creator', creatorId: 'testcreator' });
    });

    test('creator ページ (末尾スラッシュ)', () => {
      const result = detectPage('https://www.fanbox.cc/@testcreator/');
      expect(result).toEqual({ type: 'creator', creatorId: 'testcreator' });
    });

    test('post ページ', () => {
      const result = detectPage('https://www.fanbox.cc/@testcreator/posts/12345');
      expect(result).toEqual({ type: 'post', creatorId: 'testcreator', postId: '12345' });
    });

    test('post ページ (末尾スラッシュ)', () => {
      const result = detectPage('https://www.fanbox.cc/@testcreator/posts/12345/');
      expect(result).toEqual({ type: 'post', creatorId: 'testcreator', postId: '12345' });
    });
  });

  describe('サブドメイン形式', () => {
    test('creator ページ', () => {
      const result = detectPage('https://testcreator.fanbox.cc/');
      expect(result).toEqual({ type: 'creator', creatorId: 'testcreator' });
    });

    test('post ページ', () => {
      const result = detectPage('https://testcreator.fanbox.cc/posts/67890');
      expect(result).toEqual({ type: 'post', creatorId: 'testcreator', postId: '67890' });
    });
  });

  describe('除外パターン', () => {
    test('www サブドメインは creator として検出しない', () => {
      const result = detectPage('https://www.fanbox.cc/');
      expect(result).toBeNull();
    });

    test('api サブドメインは除外', () => {
      const result = detectPage('https://api.fanbox.cc/');
      expect(result).toBeNull();
    });

    test('downloads サブドメインは除外', () => {
      const result = detectPage('https://downloads.fanbox.cc/');
      expect(result).toBeNull();
    });

    test('無関係な URL は null', () => {
      const result = detectPage('https://example.com/');
      expect(result).toBeNull();
    });
  });
});

type ProxyApiResponse = {
  ok: boolean;
  status: number;
  retryAfter: string | null;
  body?: string;
  error?: string;
};
type ApiCall = { url: string };
type ApiResponder = () => ProxyApiResponse | Promise<ProxyApiResponse>;

function okJson(body: unknown): ProxyApiResponse {
  return { ok: true, status: 200, retryAfter: null, body: JSON.stringify(body) };
}

function tooManyRequests(retryAfter: string | null = null): ProxyApiResponse {
  return { ok: false, status: 429, retryAfter };
}

function errorStatus(status: number): ProxyApiResponse {
  return { ok: false, status, retryAfter: null };
}

describe('fetchJson レートリミッタ / 429 リトライ', () => {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const origChrome = (globalThis as any).chrome;
  let calls: ApiCall[];
  let responders: ApiResponder[];
  // 仮想時間: setTimeout を即時実行に置換し、待機時間の累積だけ測る
  let virtualWaitMs: number;

  function installFakeTimers() {
    virtualWaitMs = 0;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      virtualWaitMs += timeout ?? 0;
      const id = origSetTimeout(handler as () => void, 0);
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }

  function restoreTimers() {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }

  beforeEach(() => {
    calls = [];
    responders = [];
    resetApiRateLimitState();
    setApiRateLimitMs(DEFAULT_API_RATE_LIMIT_MS);
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: (message: { type: string; url: string }) => {
          if (message.type !== 'fetchApi') return Promise.reject(new Error('unexpected message type'));
          calls.push({ url: message.url });
          const responder = responders.shift();
          if (!responder) return Promise.reject(new Error(`unexpected fetch: ${message.url}`));
          return Promise.resolve(responder());
        },
      },
    };
    installFakeTimers();
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = origChrome;
    restoreTimers();
    resetApiRateLimitState();
  });

  test('429 + Retry-After (秒) を読んでリトライする', async () => {
    responders.push(() => tooManyRequests('2'));
    responders.push(() => okJson({ body: { post: { id: '1', title: 'x', type: 'image', isRestricted: false } } }));

    const result = await fetchPostInfo('1');
    expect(result).toEqual({ id: '1', title: 'x', type: 'image', isRestricted: false } as never);
    expect(calls).toHaveLength(2);
    expect(virtualWaitMs).toBeGreaterThanOrEqual(2_000);
  });

  test('429 + Retry-After (HTTP-date) を読んでリトライする', async () => {
    const future = new Date(Date.now() + 3_000).toUTCString();
    responders.push(() => tooManyRequests(future));
    responders.push(() => okJson({ body: { post: { id: '2', type: 'image', isRestricted: false } } }));

    const result = await fetchPostInfo('2');
    expect(result).toEqual({ id: '2', type: 'image', isRestricted: false } as never);
    expect(calls).toHaveLength(2);
  });

  test('Retry-After 不在時は指数バックオフ (5s → 15s)', async () => {
    responders.push(() => tooManyRequests());
    responders.push(() => tooManyRequests());
    responders.push(() => okJson({ body: { post: { id: '3', type: 'image', isRestricted: false } } }));

    await fetchPostInfo('3');
    expect(calls).toHaveLength(3);
    expect(virtualWaitMs).toBeGreaterThanOrEqual(5_000 + 15_000);
  });

  test('リトライ上限を超えると例外を投げる', async () => {
    responders.push(() => tooManyRequests());
    responders.push(() => tooManyRequests());
    responders.push(() => tooManyRequests());

    await expect(fetchPostInfo('x')).rejects.toThrow(/HTTP 429/);
    expect(calls).toHaveLength(3);
  });

  test('signal.abort() でリトライ中の待機を中断する', async () => {
    responders.push(() => tooManyRequests('60'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    await expect(fetchPostInfo('z', controller.signal)).rejects.toThrow();
  });

  test('429 以外のエラーは即時例外', async () => {
    responders.push(() => errorStatus(500));
    await expect(fetchPostInfo('w')).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
  });

  test('429 を踏むと最小間隔が引き上がる (適応スロットル)', async () => {
    setApiRateLimitMs(400);
    expect(getApiRateLimitMs()).toBe(400);
    responders.push(() => tooManyRequests('1'));
    responders.push(() => okJson({ body: { post: { id: '1', type: 'image', isRestricted: false } } }));

    await fetchPostInfo('1');
    expect(getApiRateLimitMs()).toBeGreaterThan(400);
  });

  test('適応スロットルは上限 (3000ms) を超えない', async () => {
    setApiRateLimitMs(2500);
    responders.push(() => tooManyRequests('1'));
    responders.push(() => tooManyRequests('1'));
    responders.push(() => okJson({ body: { post: { id: '1', type: 'image', isRestricted: false } } }));

    await fetchPostInfo('1');
    expect(getApiRateLimitMs()).toBeLessThanOrEqual(3_000);
  });
});

describe('レスポンスのアンラップ', () => {
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const origChrome = (globalThis as any).chrome;
  let nextResponse: ProxyApiResponse;

  beforeEach(() => {
    resetApiRateLimitState();
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: { sendMessage: () => Promise.resolve(nextResponse) },
    };
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = origChrome;
    resetApiRateLimitState();
  });

  test('fetchPlans は body.plans を返す', async () => {
    nextResponse = okJson({ body: { plans: [{ fee: 500, title: 'プランA' }] } });
    expect(await fetchPlans('c')).toEqual([{ fee: 500, title: 'プランA' }] as never);
  });

  test('fetchPlans は形状が想定外でも収集を止めず空配列を返す', async () => {
    nextResponse = okJson({ body: [{ fee: 500, title: 'プランA' }] });
    expect(await fetchPlans('c')).toEqual([]);
  });

  test('fetchTags は body.featuredTags のタグ名を返す', async () => {
    nextResponse = okJson({ body: { featuredTags: [{ tag: 'イラスト' }, { tag: '漫画' }] } });
    expect(await fetchTags('c')).toEqual(['イラスト', '漫画']);
  });

  test('fetchTags は形状が想定外でも収集を止めず空配列を返す', async () => {
    nextResponse = okJson({ body: [{ tag: 'イラスト' }] });
    expect(await fetchTags('c')).toEqual([]);
  });

  test('fetchPaginatedPosts は body.pageUrls を返す', async () => {
    nextResponse = okJson({ body: { pageUrls: ['https://api.fanbox.cc/post.listCreator?creatorId=c'] } });
    expect(await fetchPaginatedPosts('c')).toEqual(['https://api.fanbox.cc/post.listCreator?creatorId=c']);
  });

  test('fetchPaginatedPosts は形状が想定外なら投げる (0件と区別できないため)', async () => {
    nextResponse = okJson({ body: ['https://api.fanbox.cc/post.listCreator?creatorId=c'] });
    await expect(fetchPaginatedPosts('c')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPostList は body.posts を返す', async () => {
    const posts = [
      { id: '1', isRestricted: false },
      { id: '2', isRestricted: true },
    ];
    nextResponse = okJson({ body: { posts } });
    expect(await fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c')).toEqual(posts as never);
  });

  test('fetchPostList は要素が id / isRestricted を欠いていれば投げる', async () => {
    nextResponse = okJson({ body: { posts: [{ id: '1', isRestricted: 'false' }] } });
    await expect(fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPaginatedPosts は要素が文字列でなければ投げる', async () => {
    nextResponse = okJson({ body: { pageUrls: [{ url: 'https://api.fanbox.cc/post.listCreator?creatorId=c' }] } });
    await expect(fetchPaginatedPosts('c')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPostList は形状が想定外なら投げる (0件と区別できないため)', async () => {
    nextResponse = okJson({ body: [{ id: '1' }] });
    await expect(fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPostInfo は body.post を返す', async () => {
    nextResponse = okJson({ body: { post: { id: '1', title: 'x', type: 'image', isRestricted: false } } });
    expect(await fetchPostInfo('1')).toEqual({ id: '1', title: 'x', type: 'image', isRestricted: false } as never);
  });

  test('fetchPostInfo は body.post が無ければ投げる (投稿単位の失敗に丸めない)', async () => {
    nextResponse = okJson({ body: {} });
    await expect(fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPostInfo はラッパーが正しくても投稿が id / type を欠いていれば投げる', async () => {
    nextResponse = okJson({ body: { post: { id: '1' } } });
    await expect(fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPostInfo は isRestricted が真偽値でなければ投げる (無言の全件スキップを防ぐ)', async () => {
    nextResponse = okJson({ body: { post: { id: '1', type: 'image', isRestricted: 'false' } } });
    await expect(fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPlans は要素が壊れていても収集を止めず空配列を返す', async () => {
    // 素通りさせると collector の for-of で TypeError になり収集全体が落ちる
    nextResponse = okJson({ body: { plans: [null] } });
    expect(await fetchPlans('c')).toEqual([]);
  });

  test('fetchTags は要素が壊れていても収集を止めず空配列を返す', async () => {
    nextResponse = okJson({ body: { featuredTags: [{}] } });
    expect(await fetchTags('c')).toEqual([]);
  });

  test('レスポンス本体が JSON null でも形状エラーとして扱う', async () => {
    nextResponse = okJson(null);
    await expect(fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
    nextResponse = okJson(null);
    await expect(fetchPaginatedPosts('c')).rejects.toThrow(/形状が想定外/);
    nextResponse = okJson(null);
    await expect(fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c')).rejects.toThrow(/形状が想定外/);
    nextResponse = okJson(null);
    expect(await fetchPlans('c')).toEqual([]);
  });

  test('fetchPostInfo は旧形状 (body 直下が投稿) なら投げる', async () => {
    nextResponse = okJson({ body: { id: '1', title: 'x' } });
    await expect(fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
  });
});
