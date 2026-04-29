import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_API_RATE_LIMIT_MS,
  detectPage,
  fetchPostInfo,
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
    }) as typeof setTimeout;
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
    responders.push(() => okJson({ body: { id: '1', title: 'x' } }));

    const result = await fetchPostInfo('1');
    expect(result).toEqual({ id: '1', title: 'x' } as never);
    expect(calls).toHaveLength(2);
    expect(virtualWaitMs).toBeGreaterThanOrEqual(2_000);
  });

  test('429 + Retry-After (HTTP-date) を読んでリトライする', async () => {
    const future = new Date(Date.now() + 3_000).toUTCString();
    responders.push(() => tooManyRequests(future));
    responders.push(() => okJson({ body: { id: '2' } }));

    const result = await fetchPostInfo('2');
    expect(result).toEqual({ id: '2' } as never);
    expect(calls).toHaveLength(2);
  });

  test('Retry-After 不在時は指数バックオフ (5s → 15s)', async () => {
    responders.push(() => tooManyRequests());
    responders.push(() => tooManyRequests());
    responders.push(() => okJson({ body: { id: '3' } }));

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

  test('連続呼び出しは最小間隔以上空く', async () => {
    setApiRateLimitMs(400);
    responders.push(() => okJson({ body: { id: '1' } }));
    responders.push(() => okJson({ body: { id: '2' } }));

    const before = virtualWaitMs;
    await fetchPostInfo('1');
    await fetchPostInfo('2');
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(400);
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
    responders.push(() => okJson({ body: { id: '1' } }));

    await fetchPostInfo('1');
    expect(getApiRateLimitMs()).toBeGreaterThan(400);
  });

  test('適応スロットルは上限 (3000ms) を超えない', async () => {
    setApiRateLimitMs(2500);
    responders.push(() => tooManyRequests('1'));
    responders.push(() => tooManyRequests('1'));
    responders.push(() => okJson({ body: { id: '1' } }));

    await fetchPostInfo('1');
    expect(getApiRateLimitMs()).toBeLessThanOrEqual(3_000);
  });
});
