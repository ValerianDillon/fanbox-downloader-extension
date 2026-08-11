import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiSession } from '../src/content/fanbox/api';
import { BackoffStore } from '../src/service-worker/backoff-store';
import { handleFetchApi, handleGetBackoffUntil } from '../src/service-worker/handlers';
import { createFakeSessionStorage } from './service-worker/fake-storage';

/**
 * 本番のライフサイクル境界 (別タブ、リロード、service worker の停止) を再現するテスト。
 *
 * test/fanbox/api.test.ts は同一 JavaScript 実行環境内での共有 (ApiSession の static
 * フィールドが同じプロセス内で保たれること) しか確認しておらず、「service worker 側の記録」と
 * 「content script 側のゲート」を別の実行状態として扱っていなかった。
 * ここでは両者を意図的に分けて組み立て、境界をまたいだときの挙動を検証する。
 *
 * - content script 側の「別タブ・リロード」= ApiSession.resetSharedBackoff() で静的フィールドを
 *   リセットしつつ、新しい ApiSession インスタンスに切り替えることで再現する
 * - service worker 側の「稼働中の共有」= 1 つの BackoffStore インスタンス (+ その裏の
 *   chrome.storage.session) を、複数の content script インスタンス (= sendMessage 経由の呼び出し)
 *   から共有することで再現する
 * - service worker の「再起動」= 同じ chrome.storage.session (backing の Map) を裏に持つ、
 *   新しい BackoffStore インスタンスに切り替えることで再現する
 *   (BackoffStore はインスタンスごとにメモリキャッシュを持ち、storage だけを共有するため)
 */

function fakeHttpResponse(init: { status: number; retryAfter?: string | null; body?: string }): Response {
  const headers = new Headers();
  if (init.retryAfter) headers.set('Retry-After', init.retryAfter);
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers,
    text: async () => init.body ?? '',
  } as Response;
}

function okPostBody(): string {
  return JSON.stringify({ body: { post: { id: '1', type: 'image', isRestricted: false } } });
}

/** content script (chrome.runtime.sendMessage) から service worker (BackoffStore) への橋渡し */
function bridgeTo(store: BackoffStore) {
  return (message: { type: string; url?: string }) => {
    if (message.type === 'fetchApi') return handleFetchApi(message.url as string, store);
    if (message.type === 'getBackoffUntil') return handleGetBackoffUntil(store);
    return Promise.reject(new Error(`unexpected message type: ${message.type}`));
  };
}

describe('レート制限バックオフのライフサイクル境界 (Issue #16)', () => {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  // biome-ignore lint/suspicious/noExplicitAny: chrome mock
  const origChrome = (globalThis as any).chrome;
  const origFetch = globalThis.fetch;
  // 仮想時間: setTimeout を即時実行に置換し、待機時間の累積だけ測る (test/fanbox/api.test.ts と同じ手法)
  let virtualWaitMs: number;

  function installFakeTimers() {
    virtualWaitMs = 0;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      virtualWaitMs += timeout ?? 0;
      return origSetTimeout(handler as () => void, 0);
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }

  beforeEach(() => {
    ApiSession.resetSharedBackoff();
    installFakeTimers();
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome mock
    (globalThis as any).chrome = origChrome;
    globalThis.fetch = origFetch;
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    ApiSession.resetSharedBackoff();
  });

  test('(a) 別タブ・リロード相当で content script 側の状態がリセットされても、service worker 側の記録が次のゲートに効く', async () => {
    const backing = new Map<string, unknown>();
    const store = new BackoffStore();
    // biome-ignore lint/suspicious/noExplicitAny: chrome mock
    (globalThis as any).chrome = {
      storage: { session: createFakeSessionStorage(backing) },
      runtime: { sendMessage: bridgeTo(store) },
    };

    // "タブ1": 429 (Retry-After 60s) を受け続けて枯渇するまでの間、service worker 側に記録させる
    globalThis.fetch = (async () => fakeHttpResponse({ status: 429, retryAfter: '60' })) as unknown as typeof fetch;
    const tab1 = new ApiSession(50);
    await expect(tab1.fetchPostInfo('x')).rejects.toThrow();

    // "別タブを開く/リロードする": content script の静的な参照値だけがリセットされる。
    // ここで syncBackoffUntil() を呼ばなければ、以降の gate() は 0 のまま (対策前の挙動)
    ApiSession.resetSharedBackoff();

    const tab2 = new ApiSession(50);
    await ApiSession.syncBackoffUntil(); // collector.ts が収集開始時に一度呼ぶ処理を模す
    globalThis.fetch = (async () => fakeHttpResponse({ status: 200, body: okPostBody() })) as unknown as typeof fetch;

    const before = virtualWaitMs;
    await tab2.fetchPostInfo('1');
    // service worker 側の記録 (Retry-After 60s 分) が新しいタブのゲートにも効くので、
    // 未経過分 (60s 弱) だけ待ってから発行される
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(55_000);
  });

  test('(a-対照) syncBackoffUntil() を呼ばなければ、リセット後の最初のリクエストは未経過の期限を無視する (対策前の再現)', async () => {
    // 上の (a) が実際に syncBackoffUntil() の効果を検証していることを保証するための対照実験。
    // これが失敗しない (=待たずに発行してしまう) ことを確認して、(a) の合格が
    // 「たまたま待った」ではないことを担保する
    const backing = new Map<string, unknown>();
    const store = new BackoffStore();
    // biome-ignore lint/suspicious/noExplicitAny: chrome mock
    (globalThis as any).chrome = {
      storage: { session: createFakeSessionStorage(backing) },
      runtime: { sendMessage: bridgeTo(store) },
    };

    globalThis.fetch = (async () => fakeHttpResponse({ status: 429, retryAfter: '60' })) as unknown as typeof fetch;
    const tab1 = new ApiSession(50);
    await expect(tab1.fetchPostInfo('x')).rejects.toThrow();

    ApiSession.resetSharedBackoff();
    const tab2 = new ApiSession(50);
    // syncBackoffUntil() を意図的に呼ばない
    globalThis.fetch = (async () => fakeHttpResponse({ status: 200, body: okPostBody() })) as unknown as typeof fetch;

    const before = virtualWaitMs;
    await tab2.fetchPostInfo('1');
    expect(virtualWaitMs - before).toBeLessThan(1_000);
  });

  test('(b) 中断後に service worker 側で 429 が記録されれば、再実行のゲートがそれを参照する', async () => {
    const backing = new Map<string, unknown>();
    const store = new BackoffStore();
    // biome-ignore lint/suspicious/noExplicitAny: chrome mock
    (globalThis as any).chrome = {
      storage: { session: createFakeSessionStorage(backing) },
      runtime: { sendMessage: bridgeTo(store) },
    };

    // content script 側は既に中断済みで、この応答をもう処理しない想定。
    // sendMessageAbortable は呼び出し側の Promise を reject するだけで、service worker 側の
    // fetch (handleFetchApi) は独立して完走する。ここではその「中断後も完走する」性質を、
    // content script の ApiSession を経由させず handleFetchApi を直接呼ぶことで表現している
    // (= 中断された sendMessageAbortable の裏で実際に起きていること)。
    globalThis.fetch = (async () => fakeHttpResponse({ status: 429, retryAfter: '45' })) as unknown as typeof fetch;
    await handleFetchApi('https://api.fanbox.cc/post.info?postId=x', store);

    // 「キャンセル直後の再実行」: 新しい ApiSession で収集をやり直す
    const retrySession = new ApiSession(50);
    await ApiSession.syncBackoffUntil();
    globalThis.fetch = (async () => fakeHttpResponse({ status: 200, body: okPostBody() })) as unknown as typeof fetch;

    const before = virtualWaitMs;
    await retrySession.fetchPostInfo('1');
    // 中断された側が受け取るはずだった 429 の Retry-After を、再実行側が引き継いで守る
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(40_000);
  });

  test('(c) service worker 再起動相当: chrome.storage.session への保存と復元がゲートに反映される', async () => {
    const backing = new Map<string, unknown>();
    const storeBeforeRestart = new BackoffStore();
    // biome-ignore lint/suspicious/noExplicitAny: chrome mock
    (globalThis as any).chrome = {
      storage: { session: createFakeSessionStorage(backing) },
      runtime: { sendMessage: bridgeTo(storeBeforeRestart) },
    };

    globalThis.fetch = (async () => fakeHttpResponse({ status: 429, retryAfter: '90' })) as unknown as typeof fetch;
    const session = new ApiSession(50);
    await expect(session.fetchPostInfo('x')).rejects.toThrow();

    // service worker の再起動: メモリキャッシュを持つ BackoffStore インスタンスを
    // 新しいものに差し替える。裏の chrome.storage.session (backing の Map) はそのまま生き残る
    const storeAfterRestart = new BackoffStore();
    // biome-ignore lint/suspicious/noExplicitAny: chrome mock
    (globalThis as any).chrome.runtime.sendMessage = bridgeTo(storeAfterRestart);

    // content script 側 (別タブ相当) もリセットしておく
    ApiSession.resetSharedBackoff();
    const afterRestartSession = new ApiSession(50);
    await ApiSession.syncBackoffUntil();
    globalThis.fetch = (async () => fakeHttpResponse({ status: 200, body: okPostBody() })) as unknown as typeof fetch;

    const before = virtualWaitMs;
    await afterRestartSession.fetchPostInfo('1');
    // 再起動後の新しい BackoffStore インスタンスもメモリキャッシュではなく storage から
    // 読み直すので、service worker の再起動をまたいでも記録は失われていない
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(85_000);
  });
});
