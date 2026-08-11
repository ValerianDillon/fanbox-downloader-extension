import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiSession } from '../src/content/fanbox/api';
import { sendMessageAbortable } from '../src/content/messaging';
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
 *
 * gate() は待機を終えて実際に発行する直前に毎回 service worker へ問い合わせる
 * (ApiSession.syncBackoffUntil()、Issue #16 の追加対応) ため、以下のテストは明示的な
 * 事前呼び出しをせず、この自動的な問い合わせだけに頼って検証している。
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
  const origDateNow = Date.now;
  // biome-ignore lint/suspicious/noExplicitAny: chrome mock
  const origChrome = (globalThis as any).chrome;
  const origFetch = globalThis.fetch;
  // 仮想時間: setTimeout を即時実行に置換しつつ、その待機時間ぶんだけ Date.now() も進める。
  //
  // handleFetchApi は fetch を発行する前に Date.now() < backoffUntil を実際の時計で判定する
  // (service worker 側の最終ゲート)。setTimeout の待機時間だけ即時実行に潰して Date.now() を
  // 進めずにいると、このゲート判定が「時間が経過した」と一切認識できず、gate() がいくら
  // ローカルに待ったつもりになっても service worker 側で永遠に拒否され続けてしまう。
  // そのため、待った分だけ Date.now() も虚偽なく進める必要がある。
  let virtualWaitMs: number;

  function installFakeTimers() {
    virtualWaitMs = 0;
    let offsetMs = 0;
    Date.now = () => origDateNow() + offsetMs;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      const ms = timeout ?? 0;
      virtualWaitMs += ms;
      offsetMs += ms;
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
    Date.now = origDateNow;
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
    // 明示的な事前取得はしない。gate() が発行直前に自動で service worker へ問い合わせる
    ApiSession.resetSharedBackoff();
    const tab2 = new ApiSession(50);
    globalThis.fetch = (async () => fakeHttpResponse({ status: 200, body: okPostBody() })) as unknown as typeof fetch;

    const before = virtualWaitMs;
    await tab2.fetchPostInfo('1');
    // service worker 側の記録 (Retry-After 60s 分) が新しいタブのゲートにも効くので、
    // 未経過分 (60s 弱) だけ待ってから発行される
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(55_000);
  });

  test('(b) 中断後に service worker 側で 429 が記録されれば、再実行のゲートがそれを参照する', async () => {
    const backing = new Map<string, unknown>();
    const store = new BackoffStore();

    // service worker 側の fetch をテストが明示的に制御できるよう、resolve するまで
    // 完了しない deferred にする。これで「content 側が abort で先に reject する →
    // その後で service worker 側の fetch が完走し 429 を記録する」という実際の時間順序を
    // 厳密に再現できる (直接 handleFetchApi を await するだけだと、その順序を再現できない)。
    let resolveFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = (async () => {
      await fetchGate;
      return fakeHttpResponse({ status: 429, retryAfter: '45' });
    }) as unknown as typeof fetch;

    // service worker 側で実際に処理中の Promise を捕まえておく (setTimeout(0) 等での
    // 当てずっぽうな待ち合わせを避け、完了を直接 await できるようにするため)
    let swProcessing: Promise<unknown> | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: chrome mock
    (globalThis as any).chrome = {
      storage: { session: createFakeSessionStorage(backing) },
      runtime: {
        sendMessage: (message: { type: string; url?: string }) => {
          if (message.type === 'fetchApi') {
            swProcessing = handleFetchApi(message.url as string, store);
            return swProcessing;
          }
          return handleGetBackoffUntil(store);
        },
      },
    };

    // content script 側: sendMessageAbortable で発行し、応答を待たずに中断する
    // (収集のキャンセル操作を模す)。実際の ApiSession はこの下に proxyFetchApi を持つが、
    // ここでは中断のタイミングを厳密に制御したいので sendMessageAbortable を直接使う
    const controller = new AbortController();
    const contentPromise = sendMessageAbortable(
      { type: 'fetchApi', url: 'https://api.fanbox.cc/post.info?postId=x' },
      controller.signal,
    );
    controller.abort();
    await expect(contentPromise).rejects.toThrow(/Aborted/);

    // (1) content 側は既に reject 済みだが、service worker 側の fetch はまだ
    // fetchGate で止まっている = まだ 429 を記録していないはず
    expect(await store.get()).toBe(0);

    // (2) その後で service worker 側の処理を完走させる
    resolveFetch?.();
    await swProcessing;
    expect(await store.get()).toBeGreaterThan(0);

    // (3) 「キャンセル直後の再実行」: 新しい ApiSession で収集をやり直す
    const retrySession = new ApiSession(50);
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
    globalThis.fetch = (async () => fakeHttpResponse({ status: 200, body: okPostBody() })) as unknown as typeof fetch;

    const before = virtualWaitMs;
    await afterRestartSession.fetchPostInfo('1');
    // 再起動後の新しい BackoffStore インスタンスもメモリキャッシュではなく storage から
    // 読み直すので、service worker の再起動をまたいでも記録は失われていない
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(85_000);
  });

  test('(d) 並行 2 タブ相当: 待機中に他方が延長した期限を、発行直前の問い合わせで拾う', async () => {
    const backing = new Map<string, unknown>();
    const store = new BackoffStore();
    // biome-ignore lint/suspicious/noExplicitAny: chrome mock
    (globalThis as any).chrome = {
      storage: { session: createFakeSessionStorage(backing) },
      runtime: { sendMessage: bridgeTo(store) },
    };

    // "タブ A": 自分の 429 (Retry-After 30s) を経由して、ローカルの参照値が 30 秒になる
    // (通常の fetchApi 応答の取り込みで、ここは既存の仕組みのまま)
    globalThis.fetch = (async () => fakeHttpResponse({ status: 429, retryAfter: '30' })) as unknown as typeof fetch;
    const tabA = new ApiSession(50);
    await expect(tabA.fetchPostInfo('x')).rejects.toThrow();

    // "タブ B" (別の JS 実行環境) が、タブ A の待機中に期限を 90 秒延長する記録を残す。
    // ここを新しい ApiSession インスタンスで表現しない理由: ApiSession.sharedBackoffUntil は
    // クラス全体で 1 つの static であり、同一プロセス内であればどのインスタンスからの
    // 更新も即座に他のインスタンスから見えてしまう。それでは「別タブ (別プロセス)」を
    // 再現したことにならず、gate() の発行直前の問い合わせ (今回の修正) を経由しなくても
    // テストが通ってしまう。そのため、タブ B の更新は store.record() を直接叩くことで、
    // タブ A の static に触れずに service worker 側の記録だけを進める
    // (handleFetchApi 経由にしないのは、そちらは発行前に「既知の未経過期限」を見て
    // fetch 自体を止めてしまう新しい最終ゲートを持つため。ここで模したいのは、
    // 既に発生していた別タブの 429 応答が記録される場面であり、その 429 自体が
    // 発行できたかどうかはこのテストの関心事ではない)。
    await store.record(Date.now() + 90_000);

    // タブ A が次のリクエストを発行しようとする。ローカルの参照値はまだ 30 秒分のままだが
    // (自分の fetchApi 応答を経由していないので、タブ B の延長を知らない)、
    // gate() が発行直前に service worker へ問い合わせるので、90 秒への延長を捕捉できるはず
    globalThis.fetch = (async () => fakeHttpResponse({ status: 200, body: okPostBody() })) as unknown as typeof fetch;
    const before = virtualWaitMs;
    await tabA.fetchPostInfo('1');
    // 発行直前の問い合わせが無ければ、タブ A は自分の知る 30 秒分しか待たずに発行してしまい
    // (実際に旧コードではそうなる)、延長後の期限 (90 秒) を破ってしまう
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(85_000);
  });

  test('(e) getBackoffUntil 完了後・fetchApi 到達前に別タブの 429 が期限を延ばしても、service worker 側の最終ゲートが fetch 前に弾く', async () => {
    // (d) は「gate() の発行直前の問い合わせ (ApiSession.syncBackoffUntil)」が拾う延長を検証した。
    // ここで検証したいのはさらに狭い窓: その問い合わせ (getBackoffUntil) が完了した*後*、
    // 実際の fetchApi メッセージが service worker で処理される*前*に割り込む延長であり、
    // これは content script 側のどんな事前確認でも原理的に拾えない (問い合わせと発行の間に
    // 必ず隙間がある、いわゆる TOCTOU)。ここを最終的に塞ぐのは service worker 側の
    // handleFetchApi が fetch 直前に行うゲートである。
    const backing = new Map<string, unknown>();
    const store = new BackoffStore();

    // タブ A の fetchApi メッセージが service worker に「届いた」ことを合図する Promise と、
    // そこから実際の処理 (handleFetchApi の呼び出し) を再開させる Promise を用意する。
    // これにより「getBackoffUntil 完了後、fetchApi の実処理が始まる前」という狭い窓を
    // 厳密に (実行タイミングを勘に頼らず) 再現できる。
    let markReached: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    let release: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fetchCalls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      fetchCalls.push(String(url));
      return fakeHttpResponse({ status: 200, body: okPostBody() });
    }) as unknown as typeof fetch;

    // biome-ignore lint/suspicious/noExplicitAny: chrome mock
    (globalThis as any).chrome = {
      storage: { session: createFakeSessionStorage(backing) },
      runtime: {
        sendMessage: (message: { type: string; url?: string }) => {
          if (message.type === 'getBackoffUntil') return handleGetBackoffUntil(store);
          if (message.type === 'fetchApi') {
            markReached?.();
            return (async () => {
              await releaseGate;
              return handleFetchApi(message.url as string, store);
            })();
          }
          return Promise.reject(new Error(`unexpected message type: ${message.type}`));
        },
      },
    };

    const tabA = new ApiSession(50);
    const tabAPromise = tabA.fetchPostInfo('1');

    // タブ A の getBackoffUntil (発行直前の事前確認) が完了し、fetchApi メッセージが
    // service worker に届いた瞬間まで進める。この時点でタブ A は「期限は無い (0)」と
    // 認識しているはず
    await reached;

    // ここで「タブ B」が割り込み、期限を 60 秒延長する記録を残す。タブ A の fetchApi の
    // 実処理 (handleFetchApi) はまだ releaseGate で保留されたままなので、この延長は
    // タブ A が実際に fetch される前に service worker 側へ記録される
    await store.record(Date.now() + 60_000);

    const before = virtualWaitMs;
    release?.();
    await tabAPromise;

    // service worker 側の最終ゲートが延長後の期限を見て fetch をブロックしたはずなので、
    // 実際の fetch は延長を織り込んだ待機の後に 1 回だけ発生する
    // (このゲートが無ければ、タブ A は「期限は無い」という古い認識のまま即座に発行してしまう)
    expect(fetchCalls).toHaveLength(1);
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(55_000);
  });
});
