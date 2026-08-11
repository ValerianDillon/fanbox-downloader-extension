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
    await store.record(Date.now() + 12_345);
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const res = await handleFetchApi('https://api.fanbox.cc/x', store);
    expect(res.status).toBe(0);
    expect(res.error).toContain('network down');
    expect(res.backoffUntil).toBe(await store.get());
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
