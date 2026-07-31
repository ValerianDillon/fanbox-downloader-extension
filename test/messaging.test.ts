import { afterEach, describe, expect, test } from 'bun:test';
import { sendMessageAbortable } from '../src/content/messaging';

describe('sendMessageAbortable', () => {
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const origChrome = (globalThis as any).chrome;

  /** 応答を任意のタイミングで解決できる sendMessage のモック */
  function mockPending() {
    let settle: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      settle = resolve;
    });
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = { runtime: { sendMessage: () => pending } };
    return (value: unknown) => settle(value);
  }

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = origChrome;
  });

  test('応答が返れば解決する', async () => {
    const resolve = mockPending();
    const promise = sendMessageAbortable({ type: 'fetchApi' });
    resolve({ ok: true });
    expect(await promise).toEqual({ ok: true } as never);
  });

  test('応答を待っている間に中断されたら待ち続けない', async () => {
    // service worker が応答しないケース。signal と競争していないと永久に戻らない
    mockPending();
    const controller = new AbortController();
    const promise = sendMessageAbortable({ type: 'fetchApi' }, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/Aborted/);
  });

  test('中断済みの signal では送信せずに拒否する', async () => {
    let called = false;
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: () => {
          called = true;
          return Promise.resolve({ ok: true });
        },
      },
    };
    const controller = new AbortController();
    controller.abort();
    await expect(sendMessageAbortable({ type: 'fetchApi' }, controller.signal)).rejects.toThrow(/Aborted/);
    expect(called).toBe(false);
  });
});
