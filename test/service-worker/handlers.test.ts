import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BackoffStore } from '../../src/service-worker/backoff-store';
import { handleFetchApi, handleGetBackoffUntil } from '../../src/service-worker/handlers';
import { createFakeSessionStorage } from './fake-storage';

/**
 * fetch() の最小限のフェイク応答。BackoffStore はここでは直接使わず、
 * handleFetchApi / handleGetBackoffUntil に明示的に渡すインスタンスを都度作る
 * (service-worker.ts のモジュール共有 singleton に依存すると、同じプロセス内で動く他の
 * テストと状態が混ざってしまうため)。
 */
function fakeResponse(init: { status: number; retryAfter?: string | null; body?: string }): Response {
  const headers = new Headers();
  if (init.retryAfter) headers.set('Retry-After', init.retryAfter);
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers,
    text: async () => init.body ?? '',
  } as Response;
}

describe('handleFetchApi / handleGetBackoffUntil', () => {
  const origFetch = globalThis.fetch;
  let backing: Map<string, unknown>;
  let store: BackoffStore;

  beforeEach(() => {
    backing = new Map();
    // biome-ignore lint/suspicious/noExplicitAny: chrome storage mock
    (globalThis as any).chrome = { storage: { session: createFakeSessionStorage(backing) } };
    store = new BackoffStore();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('200 は現在のバックオフ期限 (未記録なら 0) を添えて返す', async () => {
    globalThis.fetch = (async () => fakeResponse({ status: 200, body: '{"ok":true}' })) as unknown as typeof fetch;
    const res = await handleFetchApi('https://api.fanbox.cc/x', store);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.backoffUntil).toBe(0);
  });

  test('429 + Retry-After を受けたら絶対時刻に変換して記録し、応答にも含める', async () => {
    const before = Date.now();
    globalThis.fetch = (async () => fakeResponse({ status: 429, retryAfter: '30' })) as unknown as typeof fetch;
    const res = await handleFetchApi('https://api.fanbox.cc/x', store);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
    expect(res.backoffUntil).toBeGreaterThanOrEqual(before + 30_000);
    // storage にも書き込まれている (メモリキャッシュだけに留めない)
    expect(backing.get('fbdlBackoffUntil')).toBe(res.backoffUntil);
  });

  test('429 で Retry-After が読めなければ新たな期限を主張せず、現在の記録をそのまま返す', async () => {
    // 何秒待つべきかの推測は content script 側のポリシー (RETRY_BACKOFF_MS) の役割であり、
    // service worker 側で決め打ちにしない
    globalThis.fetch = (async () => fakeResponse({ status: 429 })) as unknown as typeof fetch;
    const res = await handleFetchApi('https://api.fanbox.cc/x', store);
    expect(res.backoffUntil).toBe(0);
    expect(backing.size).toBe(0);
  });

  test('fetch が例外を投げても現在の backoffUntil を添えて status 0 を返す', async () => {
    // 経過済み (過去) の期限にしておく。未経過の期限だと発行前ゲートで弾かれ、
    // ここで確かめたい「fetch 自体が例外を投げたときの catch」に到達できない
    await store.record(Date.now() - 1_000);
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await handleFetchApi('https://api.fanbox.cc/x', store);
    expect(res.status).toBe(0);
    expect(res.kind).toBeUndefined();
    expect(res.error).toContain('network down');
    expect(res.backoffUntil).toBe(await store.get());
  });

  test('既知の未経過期限があるときは fetch せずにゲート拒否を返す', async () => {
    const backoffUntil = await store.record(Date.now() + 60_000);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return fakeResponse({ status: 200, body: '{"ok":true}' });
    }) as unknown as typeof fetch;

    const res = await handleFetchApi('https://api.fanbox.cc/x', store);

    expect(fetchCalled).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('backoff');
    expect(res.backoffUntil).toBe(backoffUntil);
  });

  test('期限が経過済みなら通常どおり fetch する', async () => {
    await store.record(Date.now() - 1_000);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return fakeResponse({ status: 200, body: '{"ok":true}' });
    }) as unknown as typeof fetch;

    const res = await handleFetchApi('https://api.fanbox.cc/x', store);

    expect(fetchCalled).toBe(true);
    expect(res.kind).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  test('storage.session.set が失敗しても、429 と Retry-After 由来の候補期限をそのまま返す (通信障害にすり替えない)', async () => {
    // 429 という事実と Retry-After は fetch から確実に得られている。永続化 (storage.session.set)
    // が失敗しても、それを status: 0 (通信障害) にすり替えてしまうと、content script は
    // 既知の Retry-After を無視して短い間隔で再送してしまう
    // biome-ignore lint/suspicious/noExplicitAny: chrome storage mock
    (globalThis as any).chrome = {
      storage: {
        session: {
          get: async (key: string) => (backing.has(key) ? { [key]: backing.get(key) } : {}),
          set: async () => {
            throw new Error('storage.session.set failed');
          },
        },
      },
    };

    const before = Date.now();
    globalThis.fetch = (async () => fakeResponse({ status: 429, retryAfter: '30' })) as unknown as typeof fetch;
    const res = await handleFetchApi('https://api.fanbox.cc/x', store);

    expect(res.status).toBe(429);
    expect(res.ok).toBe(false);
    expect(res.error).toBeUndefined();
    // ローカルで計算した候補期限 (Date.now() + waitMs) がそのまま返る
    expect(res.backoffUntil).toBeGreaterThanOrEqual(before + 30_000);
    // 永続化そのものは失敗しているので storage には残っていない
    expect(backing.size).toBe(0);
  });

  test('storage.session.get が失敗しても、fetchApi / getBackoffUntil は必ず応答を返す (未応答にならない)', async () => {
    // store.get()/record() が reject すると、外側の catch 内で再度呼ぶ store.get() も
    // reject して handler 自体が never-resolve になりうる。呼び出し元の message ハンドラは
    // 必ず応答を返す契約を守る必要がある (でないと content script は応答なしで待ち続ける)
    // biome-ignore lint/suspicious/noExplicitAny: chrome storage mock
    (globalThis as any).chrome = {
      storage: {
        session: {
          get: async () => {
            throw new Error('storage.session.get failed');
          },
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) backing.set(key, value);
          },
        },
      },
    };

    globalThis.fetch = (async () => fakeResponse({ status: 200, body: '{"ok":true}' })) as unknown as typeof fetch;
    const fetchRes = await handleFetchApi('https://api.fanbox.cc/x', store);
    expect(fetchRes.ok).toBe(true);
    expect(fetchRes.backoffUntil).toBe(0);

    const getRes = await handleGetBackoffUntil(store);
    expect(getRes).toEqual({ backoffUntil: 0 });

    // fetch 自体が例外を投げる経路 (外側の catch) でも、その中の store.get() が
    // 失敗して二重に落ちることはない
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const networkFailRes = await handleFetchApi('https://api.fanbox.cc/x', store);
    expect(networkFailRes.status).toBe(0);
    expect(networkFailRes.error).toContain('network down');
    expect(networkFailRes.backoffUntil).toBe(0);
  });

  test('getBackoffUntil はそのときの記録をそのまま返す', async () => {
    await store.record(Date.now() + 99_999);
    const result = await handleGetBackoffUntil(store);
    expect(result).toEqual({ backoffUntil: await store.get() });
  });

  test('content script 側が中断していても handleFetchApi 自体は完走して 429 を記録する', async () => {
    // sendMessageAbortable は呼び出し側 (content script) の Promise を reject するだけで、
    // service worker 側のこの関数は signal を一切受け取らないため中断されない
    // (Issue #16: 中断すると Retry-After が失われる問題は、ここが完走することで解消される)。
    globalThis.fetch = (async () => fakeResponse({ status: 429, retryAfter: '5' })) as unknown as typeof fetch;
    const res = await handleFetchApi('https://api.fanbox.cc/x', store);
    expect(res.status).toBe(429);
    expect(backing.get('fbdlBackoffUntil')).toBe(res.backoffUntil);
  });
});
