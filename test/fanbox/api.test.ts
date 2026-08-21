import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ApiSession,
  ApiShapeError,
  DEFAULT_API_RATE_LIMIT_MS,
  detectPage,
  HttpError,
  RateLimitExhaustedError,
  ResponseParseError,
  resetSharedBackoff,
  TransportExhaustedError,
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
  backoffUntil?: number;
};
type ApiCall = { url: string };
type ApiResponder = () => ProxyApiResponse | Promise<ProxyApiResponse>;

function okJson(body: unknown): ProxyApiResponse {
  return { ok: true, status: 200, retryAfter: null, body: JSON.stringify(body) };
}

/**
 * backoffUntil は本来 service worker (chrome.storage.session) が計算して返す値なので、
 * ここでは呼び出し側が「service worker がこう応答したはず」という値を明示的に渡す。
 * 省略時は cross-session の共有ゲートには関わらない 429 として振る舞う。
 */
function tooManyRequests(retryAfter: string | null = null, backoffUntil?: number): ProxyApiResponse {
  return { ok: false, status: 429, retryAfter, backoffUntil };
}

function errorStatus(status: number): ProxyApiResponse {
  return { ok: false, status, retryAfter: null };
}

describe('fetchJson レートリミッタ / 429 リトライ', () => {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const origDateNow = Date.now;
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const origChrome = (globalThis as any).chrome;
  let calls: ApiCall[];
  let responders: ApiResponder[];
  let api: ApiSession;
  // 仮想時間: setTimeout を即時実行に置換し、待機時間の累積だけ測る
  let virtualWaitMs: number;
  /**
   * 待機した分だけ Date.now も進める。
   * 共有セッションは deferred (service worker のバックオフ期限中で発行していない) を受けると
   * 「期限まで待ってから transport を呼び直す」。時計を止めたままにすると、待機後の再呼び出しで
   * adapter が依然として期限内と判断して deferred を返し続け、待機が実際には経過している
   * はずの場面で deferred の上限に達してしまう。
   */
  let virtualClockMs: number;

  function installFakeTimers() {
    virtualWaitMs = 0;
    virtualClockMs = 0;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      virtualWaitMs += timeout ?? 0;
      virtualClockMs += timeout ?? 0;
      const id = origSetTimeout(handler as () => void, 0);
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = origClearTimeout;
    Date.now = () => origDateNow() + virtualClockMs;
  }

  function restoreTimers() {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    Date.now = origDateNow;
  }

  beforeEach(() => {
    calls = [];
    responders = [];
    resetSharedBackoff();
    api = new ApiSession(DEFAULT_API_RATE_LIMIT_MS);
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
    resetSharedBackoff();
  });

  test('429 + Retry-After (秒) を読んでリトライする', async () => {
    responders.push(() => tooManyRequests('2'));
    responders.push(() => okJson({ body: { post: { id: '1', title: 'x', type: 'image', isRestricted: false } } }));

    const result = await api.fetchPostInfo('1');
    expect(result).toEqual({ id: '1', title: 'x', type: 'image', isRestricted: false } as never);
    expect(calls).toHaveLength(2);
    // 下限だけでは Retry-After を無視して固定バックオフ (5 秒) を使う実装も通ってしまう。
    // サーバーの指示に従ったことを示すには、固定バックオフより短いことまで見る必要がある
    expect(virtualWaitMs).toBeGreaterThanOrEqual(2_000);
    expect(virtualWaitMs).toBeLessThan(5_000);
  });

  test('429 + Retry-After (HTTP-date) を読んでリトライする', async () => {
    const future = new Date(Date.now() + 3_000).toUTCString();
    responders.push(() => tooManyRequests(future));
    responders.push(() => okJson({ body: { post: { id: '2', type: 'image', isRestricted: false } } }));

    const result = await api.fetchPostInfo('2');
    expect(result).toEqual({ id: '2', type: 'image', isRestricted: false } as never);
    expect(calls).toHaveLength(2);
    // 秒数形式と同じく、HTTP-date を読めたことは待機時間でしか確かめられない。
    // toUTCString() は秒未満を切り捨て、さらに生成から解析までの実経過ぶんも引かれるので、
    // 待機は 3 秒ちょうどにはならず [2秒, 3秒] に入る。固定バックオフ (5 秒) との区別は上限が担う
    expect(virtualWaitMs).toBeGreaterThanOrEqual(2_000);
    expect(virtualWaitMs).toBeLessThanOrEqual(3_000);
  });

  test('Retry-After 不在時は指数バックオフ (5s → 15s)', async () => {
    responders.push(() => tooManyRequests());
    responders.push(() => tooManyRequests());
    responders.push(() => okJson({ body: { post: { id: '3', type: 'image', isRestricted: false } } }));

    await api.fetchPostInfo('3');
    expect(calls).toHaveLength(3);
    // 上限も見る。下限だけでは「もっと長く待つ」誤りを検知できず、Retry-After を読めないときの
    // 待機時間そのものが契約 (Issue #3 の再試行ポリシー) なので固定する。
    // 基準間隔 (500ms) ぶんのゲート待機が乗るので、その分の余裕を見る
    expect(virtualWaitMs).toBeGreaterThanOrEqual(5_000 + 15_000);
    expect(virtualWaitMs).toBeLessThan(5_000 + 15_000 + 2_000);
  });

  test('5s / 15s / 45s を実際に待って再試行し、4 回目で枯渇する', async () => {
    for (let i = 0; i < 4; i++) responders.push(() => tooManyRequests());

    await expect(api.fetchPostInfo('x')).rejects.toThrow(RateLimitExhaustedError);
    // 初回 + 再試行 3 回 = 4 リクエスト、累積待機 65 秒
    expect(calls).toHaveLength(4);
    expect(virtualWaitMs).toBeGreaterThanOrEqual(5_000 + 15_000 + 45_000);
    expect(virtualWaitMs).toBeLessThan(5_000 + 15_000 + 45_000 + 2_000);
  });

  test('通信失敗は 429 の再試行枠を消費しない', async () => {
    // 通信失敗 → 再試行 → 429 が 3 回続いても、429 の枠は使い切られない
    responders.push(() => Promise.reject(new Error('network')));
    for (let i = 0; i < 3; i++) responders.push(() => tooManyRequests());
    responders.push(() => okJson({ body: { post: { id: '1', type: 'image', isRestricted: false } } }));

    const result = await api.fetchPostInfo('1');
    expect(result).toEqual({ id: '1', type: 'image', isRestricted: false } as never);
    expect(calls).toHaveLength(5);
  });

  const okPost = () => okJson({ body: { post: { id: '1', type: 'image', isRestricted: false } } });

  /** 引き上がった状態にしてから n 回成功させる */
  async function escalateThenSucceed(n: number): Promise<number> {
    responders.push(() => tooManyRequests('1'));
    responders.push(okPost);
    await api.fetchPostInfo('1');
    const escalated = api.getIntervalMs();
    for (let i = 0; i < n; i++) {
      responders.push(okPost);
      await api.fetchPostInfo('1');
    }
    return escalated;
  }

  test('静穏期間を満たさないうちは引き上げた間隔を戻さない', async () => {
    api = new ApiSession(500);
    const escalated = await escalateThenSucceed(20);
    expect(escalated).toBeGreaterThan(500);
    expect(api.getIntervalMs()).toBe(escalated);
  });

  test('連続成功と静穏期間を満たしたら引き上げた間隔を戻す', async () => {
    api = new ApiSession(500);
    const escalated = await escalateThenSucceed(19);
    // 静穏期間を跨がせる
    const origNow = Date.now;
    const shifted = origNow() + 61_000;
    Date.now = () => shifted;
    try {
      responders.push(okPost);
      await api.fetchPostInfo('1');
    } finally {
      Date.now = origNow;
    }
    expect(api.getIntervalMs()).toBeLessThan(escalated);
  });

  test('途中で失敗すると連続成功が切れて減衰しない', async () => {
    api = new ApiSession(500);
    const escalated = await escalateThenSucceed(19);
    // 19 回成功した後に HTTP 500 を挟むと、次の成功は 1 回目として数え直される
    responders.push(() => errorStatus(500));
    await expect(api.fetchPostInfo('1')).rejects.toThrow(/HTTP 500/);
    const origNow = Date.now;
    const shifted = origNow() + 61_000;
    Date.now = () => shifted;
    try {
      responders.push(okPost);
      await api.fetchPostInfo('1');
    } finally {
      Date.now = origNow;
    }
    expect(api.getIntervalMs()).toBe(escalated);
  });

  test('service worker が status 0 で返す通信失敗も再試行する', async () => {
    // service worker は fetch の失敗を reject せず status 0 で返す
    responders.push(() => ({ ok: false, status: 0, retryAfter: null, error: 'Failed to fetch' }));
    responders.push(okPost);

    const result = await api.fetchPostInfo('1');
    expect(result).toEqual({ id: '1', type: 'image', isRestricted: false } as never);
    expect(calls).toHaveLength(2);
  });

  test('status 0 が続けば再試行上限で投げる', async () => {
    // 観測できない失敗の再試行は 5 秒・15 秒の 2 回。初回と合わせて 3 要求で枯渇する
    for (let i = 0; i < 3; i++) {
      responders.push(() => ({ ok: false, status: 0, retryAfter: null, error: 'Failed to fetch' }));
    }

    await expect(api.fetchPostInfo('1')).rejects.toThrow(TransportExhaustedError);
    expect(calls).toHaveLength(3);
    // 429 の枠 (65 秒) ではなくこちらの枠 (20 秒) で見切ったことまで固定する
    expect(virtualWaitMs).toBeGreaterThanOrEqual(5_000 + 15_000);
    expect(virtualWaitMs).toBeLessThan(5_000 + 15_000 + 2_000);
  });

  test('サーバー指定のバックオフは収集をまたいでも守る', async () => {
    // 打ち切った直後に再実行しても、Retry-After の期限までは発行しない。
    // backoffUntil は本来 service worker が計算する値なので、ここでは
    // 実際の service worker が返すはずの値 (Date.now() + Retry-After) を明示的に模擬する
    api = new ApiSession(50);
    for (let i = 0; i < 3; i++) responders.push(() => tooManyRequests('0', Date.now()));
    responders.push(() => tooManyRequests('120', Date.now() + 120_000));
    await expect(api.fetchPostInfo('x')).rejects.toThrow(RateLimitExhaustedError);

    const next = new ApiSession(50);
    responders.push(okPost);
    const before = virtualWaitMs;
    await next.fetchPostInfo('1');
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(119_000);
  });

  test('発行前に別のメッセージ往復を挟んでも、実際の発行間隔は基準間隔を下回らない', async () => {
    // セッションは transport を呼ぶ直前に発行時刻を記録する (api-session.ts の issuedAt)。
    // transport が実際の fetch より前に待つと、その待ち時間ぶんだけ「発行済みの時刻」が
    // 前倒しされ、次の要求のゲートが早く明ける。往復の所要時間が要求ごとに違えば、
    // 実際の fetchApi が基準間隔を空けずに連続発行されうる。
    // fetchApi 以外のメッセージに待ち時間を持たせ、発行前の往復が入り込んだら検知する
    let extraRoundTripMs = 500;
    const issuedAt: number[] = [];
    const otherMessages: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: async (message: { type: string; url: string }) => {
          if (message.type !== 'fetchApi') {
            otherMessages.push(message.type);
            await new Promise((resolve) => setTimeout(resolve, extraRoundTripMs));
            // 最初の往復だけ遅い状況を作る (往復の所要時間が毎回同じなら間隔は縮まない)
            extraRoundTripMs = 0;
            return { backoffUntil: 0 };
          }
          issuedAt.push(Date.now());
          return okPost();
        },
      },
    };

    api = new ApiSession(500);
    await api.fetchPostInfo('1');
    await api.fetchPostInfo('2');
    await api.fetchPostInfo('3');

    expect(issuedAt).toHaveLength(3);
    for (let i = 1; i < issuedAt.length; i++) {
      expect(issuedAt[i] - issuedAt[i - 1]).toBeGreaterThanOrEqual(500);
    }
    // 発行前の往復そのものが無いことも固定する (待ち時間が短ければ上の検査は通ってしまう)
    expect(otherMessages).toEqual([]);
  });

  test('service worker への配送が遅れても、実際の fetch の間隔は基準間隔を下回らない', async () => {
    // セッションは sendMessage を呼ぶ直前の時刻を発行時刻として記録するが、実際の fetch は
    // service worker 側で起きる。起動待ちなどで配送が遅れた要求の次は、その遅延ぶんゲートが
    // 早く明けてしまう (Issue #46)。応答が運ぶ issuedAt を発行時刻に採ることで防ぐ
    let deliveryMs = 800;
    const fetchedAt: number[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: async (message: { type: string; url: string }) => {
          if (message.type !== 'fetchApi') throw new Error('unexpected message type');
          // 最初の配送だけ遅い状況を作る (毎回同じだけ遅ければ間隔は縮まない)
          await new Promise((resolve) => setTimeout(resolve, deliveryMs));
          deliveryMs = 0;
          const issuedAt = Date.now();
          fetchedAt.push(issuedAt);
          return { ...okPost(), issuedAt };
        },
      },
    };

    api = new ApiSession(500);
    await api.fetchPostInfo('1');
    await api.fetchPostInfo('2');

    expect(fetchedAt).toHaveLength(2);
    expect(fetchedAt[1] - fetchedAt[0]).toBeGreaterThanOrEqual(500);
  });

  test('service worker が実発行時刻を返さなくても収集は成立する', async () => {
    // 旧バージョンの service worker と組み合わさった場合。セッションは sendMessage 直前の
    // 時刻に落とすので、間隔は従来どおり保たれる (実発行とのずれは補正されない)
    responders.push(okPost);
    responders.push(okPost);
    api = new ApiSession(500);
    await api.fetchPostInfo('1');
    const before = virtualWaitMs;
    await api.fetchPostInfo('2');
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(400);
  });

  test('壊れたレスポンスは成功として数えない', async () => {
    api = new ApiSession(500);
    const escalated = await escalateThenSucceed(19);
    // JSON として読めないレスポンスで連続成功が切れる
    responders.push(() => ({ ok: true, status: 200, retryAfter: null, body: '{ broken' }));
    await expect(api.fetchPostInfo('1')).rejects.toThrow();
    const origNow = Date.now;
    const shifted = origNow() + 61_000;
    Date.now = () => shifted;
    try {
      responders.push(okPost);
      await api.fetchPostInfo('1');
    } finally {
      Date.now = origNow;
    }
    expect(api.getIntervalMs()).toBe(escalated);
  });

  test('枯渇した最後の 429 の Retry-After も後続のために記録する', async () => {
    api = new ApiSession(50);
    for (let i = 0; i < 3; i++) responders.push(() => tooManyRequests('0', Date.now()));
    responders.push(() => tooManyRequests('120', Date.now() + 120_000));
    await expect(api.fetchPostInfo('x')).rejects.toThrow(RateLimitExhaustedError);

    // 後続のリクエストは記録された 120 秒のバックオフを待つ
    responders.push(okPost);
    const before = virtualWaitMs;
    await api.fetchPostInfo('1');
    expect(virtualWaitMs - before).toBeGreaterThanOrEqual(119_000);
  });

  test('signal.abort() でリトライ中の待機を中断し、追加の要求を出さない', async () => {
    responders.push(() => tooManyRequests('60'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    const error = await api.fetchPostInfo('z', controller.signal).catch((e) => e);
    // 任意の例外で通してしまうと、中断を無視して再要求し別の理由で失敗した場合も通る
    expect((error as Error).name).toBe('AbortError');
    // 中断後に再試行が発行されていないこと (初回の 1 回だけ)。中断を無視すれば待機を終えて
    // 再要求するので 2 回になる。待機時間では判定できない: 仮想時間の setTimeout は
    // 中断で捨てられた待機ぶんも積んでしまうため
    expect(calls).toHaveLength(1);
  });

  test('中断済みの signal では要求を一切発行せず、中断として伝播する', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: () => Promise.reject(new Error('unreachable: 中断済みの signal では送信しないはず')),
      },
    };
    const controller = new AbortController();
    controller.abort();
    const error = await api.fetchPostInfo('1', controller.signal).catch((e) => e);
    expect((error as Error).name).toBe('AbortError');
  });

  test('429 以外のエラーは即時例外', async () => {
    responders.push(() => errorStatus(500));
    await expect(api.fetchPostInfo('w')).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
  });

  test('429 を踏むと最小間隔が引き上がる (適応スロットル)', async () => {
    api = new ApiSession(400);
    expect(api.getIntervalMs()).toBe(400);
    responders.push(() => tooManyRequests('1'));
    responders.push(() => okJson({ body: { post: { id: '1', type: 'image', isRestricted: false } } }));

    await api.fetchPostInfo('1');
    expect(api.getIntervalMs()).toBeGreaterThan(400);
  });

  test('適応スロットルは上限 (3000ms) を超えない', async () => {
    api = new ApiSession(2500);
    responders.push(() => tooManyRequests('1'));
    responders.push(() => tooManyRequests('1'));
    responders.push(() => okJson({ body: { post: { id: '1', type: 'image', isRestricted: false } } }));

    await api.fetchPostInfo('1');
    expect(api.getIntervalMs()).toBeLessThanOrEqual(3_000);
  });
});

/**
 * 共有層 (download-helper/api-session) のエラー型は kind を持たない。Issue #14 で導入した
 * e.kind による構造的な分岐は、失敗の種別をエラー型そのもので表す形に置き換わっている。
 * status を持つのは HttpError だけで、枯渇系 (RateLimitExhaustedError /
 * TransportExhaustedError) は「どの再試行枠を使い切ったか」を型で表す。
 */
describe('Issue #14: エラー型による失敗種別の識別', () => {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const origChrome = (globalThis as any).chrome;
  let calls: ApiCall[];
  let responders: ApiResponder[];
  let api: ApiSession;

  function installFakeTimers() {
    globalThis.setTimeout = ((handler: TimerHandler) =>
      origSetTimeout(handler as () => void, 0)) as unknown as typeof setTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }

  function restoreTimers() {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }

  beforeEach(() => {
    calls = [];
    responders = [];
    resetSharedBackoff();
    api = new ApiSession(DEFAULT_API_RATE_LIMIT_MS);
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
    resetSharedBackoff();
  });

  test('レート制限の枯渇は RateLimitExhaustedError を投げる', async () => {
    for (let i = 0; i < 4; i++) responders.push(() => tooManyRequests());

    const error = await api.fetchPostInfo('x').catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitExhaustedError);
    // 通信の枯渇と取り違えない。呼び出し側は停止理由をこの型の違いから導く
    expect(error).not.toBeInstanceOf(TransportExhaustedError);
  });

  test('HTTP エラー (429 以外) は HttpError を投げ、status に実際のコードを持つ', async () => {
    responders.push(() => errorStatus(503));

    const error = await api.fetchPostInfo('w').catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(503);
  });

  test('通信失敗 (status 0) が再試行後も続くと TransportExhaustedError を投げる', async () => {
    for (let i = 0; i < 3; i++) {
      responders.push(() => ({ ok: false, status: 0, retryAfter: null, error: 'Failed to fetch' }));
    }

    const error = await api.fetchPostInfo('1').catch((e) => e);
    expect(error).toBeInstanceOf(TransportExhaustedError);
    // 観測できない失敗をレート制限として扱わない (再試行枠も待機時間も違う)
    expect(error).not.toBeInstanceOf(RateLimitExhaustedError);
    expect(calls).toHaveLength(3);
  });

  test('sendMessage 自体の失敗が再試行後も続くと TransportExhaustedError を投げる', async () => {
    // proxyFetchApi (chrome.runtime.sendMessage) が例外で reject し続けるケース
    for (let i = 0; i < 3; i++) {
      responders.push(() => {
        throw new Error('messaging failed');
      });
    }

    const error = await api.fetchPostInfo('1').catch((e) => e);
    expect(error).toBeInstanceOf(TransportExhaustedError);
    expect(calls).toHaveLength(3);
  });
});

describe('レスポンスのアンラップ', () => {
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const origChrome = (globalThis as any).chrome;
  let nextResponse: ProxyApiResponse;
  let api: ApiSession;

  beforeEach(() => {
    resetSharedBackoff();
    api = new ApiSession();
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: { sendMessage: () => Promise.resolve(nextResponse) },
    };
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = origChrome;
  });

  test('fetchPlans は body.plans を返す', async () => {
    nextResponse = okJson({ body: { plans: [{ fee: 500, title: 'プランA' }] } });
    expect(await api.fetchPlans('c')).toEqual([{ fee: 500, title: 'プランA' }] as never);
  });

  test('fetchPlans はレート制限の枯渇だけは握りつぶさず投げる', async () => {
    // 既に最大回数・累積待機を費やした後で投稿取得を始めるのは、
    // 再試行上限を別のエンドポイントで実質的に延長することになる
    nextResponse = { ok: false, status: 429, retryAfter: '0' };
    await expect(api.fetchPlans('c')).rejects.toThrow(RateLimitExhaustedError);
  });

  test('fetchTags はレート制限の枯渇だけは握りつぶさず投げる', async () => {
    nextResponse = { ok: false, status: 429, retryAfter: '0' };
    await expect(api.fetchTags('c')).rejects.toThrow(RateLimitExhaustedError);
  });

  test('fetchPlans は形状が想定外でも収集を止めず空配列を返す', async () => {
    nextResponse = okJson({ body: [{ fee: 500, title: 'プランA' }] });
    expect(await api.fetchPlans('c')).toEqual([]);
  });

  test('fetchTags は body.featuredTags のタグ名を返す', async () => {
    nextResponse = okJson({ body: { featuredTags: [{ tag: 'イラスト' }, { tag: '漫画' }] } });
    expect(await api.fetchTags('c')).toEqual(['イラスト', '漫画']);
  });

  test('fetchTags は形状が想定外でも収集を止めず空配列を返す', async () => {
    nextResponse = okJson({ body: [{ tag: 'イラスト' }] });
    expect(await api.fetchTags('c')).toEqual([]);
  });

  test('fetchPlans / fetchTags は本文を JSON として読めなくても空配列を返す', async () => {
    // 形状の不一致 (ApiShapeError) と同じ理由で握りつぶす。この 2 つは表示の補助しか
    // 担っておらず、握りつぶしても ZIP の中身は欠けない。投稿一覧・投稿詳細では
    // 同じ ResponseParseError で収集を止める (経路ごとに扱いが違うので個別に固定する)
    nextResponse = { ok: true, status: 200, retryAfter: null, body: '{ broken' };
    expect(await api.fetchPlans('c')).toEqual([]);
    nextResponse = { ok: true, status: 200, retryAfter: null, body: '{ broken' };
    expect(await api.fetchTags('c')).toEqual([]);
  });

  // プラン名・タグは表示の補助なので、通信/HTTP の失敗 (HttpError) も
  // 形状不一致 (ApiShapeError) と同様に握りつぶして続行してよい
  // (CLAUDE.md 「プラン名とタグは表示の補助なので握りつぶして続行し」の方針)
  test('fetchPlans は HttpError (HTTP 失敗) も握りつぶして空配列を返す', async () => {
    nextResponse = { ok: false, status: 500, retryAfter: null };
    expect(await api.fetchPlans('c')).toEqual([]);
  });

  test('fetchTags は HttpError (HTTP 失敗) も握りつぶして空配列を返す', async () => {
    nextResponse = { ok: false, status: 500, retryAfter: null };
    expect(await api.fetchTags('c')).toEqual([]);
  });

  // HttpError / ApiShapeError / RateLimitExhaustedError のいずれでもない例外
  // (validator や内部処理のバグ、あるいは互換性のない service worker が返す
  // 破損したレスポンス形状など) までは握りつぶさず再送出する。ここでは
  // sendMessage が応答オブジェクト自体を返さない (undefined) という壊れ方を模擬し、
  // fetchJson 内部で TypeError が起きるようにして検証する
  test('fetchPlans は想定外の例外 (typed error 以外) を握りつぶさず再送出する', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: 破損したレスポンス形状 (undefined) を模擬する
    nextResponse = undefined as any;
    await expect(api.fetchPlans('c')).rejects.toThrow(TypeError);
  });

  test('fetchTags は想定外の例外 (typed error 以外) を握りつぶさず再送出する', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: 破損したレスポンス形状 (undefined) を模擬する
    nextResponse = undefined as any;
    await expect(api.fetchTags('c')).rejects.toThrow(TypeError);
  });

  test('fetchPaginatedPosts は body.pageUrls を返す', async () => {
    nextResponse = okJson({ body: { pageUrls: ['https://api.fanbox.cc/post.listCreator?creatorId=c'] } });
    expect(await api.fetchPaginatedPosts('c')).toEqual(['https://api.fanbox.cc/post.listCreator?creatorId=c']);
  });

  test('fetchPaginatedPosts は形状が想定外なら投げる (0件と区別できないため)', async () => {
    nextResponse = okJson({ body: ['https://api.fanbox.cc/post.listCreator?creatorId=c'] });
    await expect(api.fetchPaginatedPosts('c')).rejects.toThrow(/形状が想定外/);
  });

  test('一覧要素の feeRequired が number でなければ形状エラーで中断する', async () => {
    // feeRequired は「無料を省く」設定の判断に使う。欠けたまま続けると、利用者が指定した
    // 除外が無言で効かなくなる (無料投稿まで ZIP に入る)
    nextResponse = okJson({ body: { posts: [{ id: '1', isRestricted: false, feeRequired: '0' }] } });
    const error = await api.fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c').catch((e) => e);
    expect(error).toBeInstanceOf(ApiShapeError);
    expect(error.fields).toEqual(['body.posts[]']);
  });

  test('fetchPostList は body.posts を返す', async () => {
    const posts = [
      { id: '1', isRestricted: false, feeRequired: 0 },
      { id: '2', isRestricted: true, feeRequired: 500 },
    ];
    nextResponse = okJson({ body: { posts } });
    expect(await api.fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c')).toEqual(posts as never);
  });

  test('fetchPostList は要素が id / isRestricted を欠いていれば投げる', async () => {
    nextResponse = okJson({ body: { posts: [{ id: '1', isRestricted: 'false' }] } });
    await expect(api.fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c')).rejects.toThrow(
      /形状が想定外/,
    );
  });

  test('fetchPaginatedPosts は要素が文字列でなければ投げる', async () => {
    nextResponse = okJson({ body: { pageUrls: [{ url: 'https://api.fanbox.cc/post.listCreator?creatorId=c' }] } });
    await expect(api.fetchPaginatedPosts('c')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPostList は形状が想定外なら投げる (0件と区別できないため)', async () => {
    nextResponse = okJson({ body: [{ id: '1' }] });
    await expect(api.fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c')).rejects.toThrow(
      /形状が想定外/,
    );
  });

  test('fetchPostInfo は body.post を返す', async () => {
    nextResponse = okJson({ body: { post: { id: '1', title: 'x', type: 'image', isRestricted: false } } });
    expect(await api.fetchPostInfo('1')).toEqual({ id: '1', title: 'x', type: 'image', isRestricted: false } as never);
  });

  test('fetchPostInfo は body.post が無ければ投げる (投稿単位の失敗に丸めない)', async () => {
    nextResponse = okJson({ body: {} });
    await expect(api.fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPostInfo はラッパーが正しくても投稿が id / type を欠いていれば投げる', async () => {
    nextResponse = okJson({ body: { post: { id: '1' } } });
    await expect(api.fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPostInfo は isRestricted が真偽値でなければ投げる (無言の全件スキップを防ぐ)', async () => {
    nextResponse = okJson({ body: { post: { id: '1', type: 'image', isRestricted: 'false' } } });
    await expect(api.fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
  });

  test('fetchPlans は要素が壊れていても収集を止めず空配列を返す', async () => {
    // 素通りさせると collector の for-of で TypeError になり収集全体が落ちる
    nextResponse = okJson({ body: { plans: [null] } });
    expect(await api.fetchPlans('c')).toEqual([]);
  });

  test('fetchTags は要素が壊れていても収集を止めず空配列を返す', async () => {
    nextResponse = okJson({ body: { featuredTags: [{}] } });
    expect(await api.fetchTags('c')).toEqual([]);
  });

  test('レスポンス本体が JSON null でも形状エラーとして扱う', async () => {
    nextResponse = okJson(null);
    await expect(api.fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
    nextResponse = okJson(null);
    await expect(api.fetchPaginatedPosts('c')).rejects.toThrow(/形状が想定外/);
    nextResponse = okJson(null);
    await expect(api.fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c')).rejects.toThrow(
      /形状が想定外/,
    );
    nextResponse = okJson(null);
    expect(await api.fetchPlans('c')).toEqual([]);
  });

  test('fetchPostInfo は旧形状 (body 直下が投稿) なら投げる', async () => {
    nextResponse = okJson({ body: { id: '1', title: 'x' } });
    await expect(api.fetchPostInfo('1')).rejects.toThrow(/形状が想定外/);
  });
});

describe('Issue #14: ApiShapeError の fields (想定と違ったフィールドの内訳)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const origChrome = (globalThis as any).chrome;
  let nextResponse: ProxyApiResponse;
  let api: ApiSession;

  beforeEach(() => {
    resetSharedBackoff();
    api = new ApiSession();
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: { sendMessage: () => Promise.resolve(nextResponse) },
    };
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = origChrome;
  });

  test('JSON として読めないレスポンスは ResponseParseError になる', async () => {
    // JSON.parse の SyntaxError をそのまま投げると、呼び出し側の型による判定を
    // すり抜け、「未対応のレスポンス形式のため中断しました」に乗らない。
    // 形状の不一致 (ApiShapeError) と型を分けているのは、本文を読めなかったのか
    // 読めた本文が想定と違ったのかで原因の切り分け先が変わるため
    nextResponse = { ok: true, status: 200, retryAfter: null, body: '{ broken' };
    const error = await api.fetchPostInfo('1').catch((e) => e);
    expect(error).toBeInstanceOf(ResponseParseError);
    expect(error).not.toBeInstanceOf(SyntaxError);
  });

  test('body.post 自体が無ければ fields は ["body.post"]', async () => {
    nextResponse = okJson({ body: {} });
    const error = await api.fetchPostInfo('1').catch((e) => e);
    expect(error).toBeInstanceOf(ApiShapeError);
    expect(error.fields).toEqual(['body.post']);
  });

  test('post が type / isRestricted を欠いていれば fields にそれぞれのパスを積む', async () => {
    nextResponse = okJson({ body: { post: { id: '1' } } });
    const error = await api.fetchPostInfo('1').catch((e) => e);
    expect(error).toBeInstanceOf(ApiShapeError);
    expect(error.fields).toEqual(['body.post.type', 'body.post.isRestricted']);
  });

  test('post が id のみ欠いていれば fields は ["body.post.id"] のみ', async () => {
    nextResponse = okJson({ body: { post: { type: 'image', isRestricted: false } } });
    const error = await api.fetchPostInfo('1').catch((e) => e);
    expect(error).toBeInstanceOf(ApiShapeError);
    expect(error.fields).toEqual(['body.post.id']);
  });

  test('fetchPaginatedPosts の配列違反は fields に ["body.pageUrls"] を積む', async () => {
    nextResponse = okJson({ body: ['https://api.fanbox.cc/post.listCreator?creatorId=c'] });
    const error = await api.fetchPaginatedPosts('c').catch((e) => e);
    expect(error).toBeInstanceOf(ApiShapeError);
    expect(error.fields).toEqual(['body.pageUrls']);
  });

  test('fetchPostList の要素違反は fields に ["body.posts[]"] を積む', async () => {
    nextResponse = okJson({ body: { posts: [{ id: '1', isRestricted: 'false' }] } });
    const error = await api.fetchPostList('https://api.fanbox.cc/post.listCreator?creatorId=c').catch((e) => e);
    expect(error).toBeInstanceOf(ApiShapeError);
    expect(error.fields).toEqual(['body.posts[]']);
  });
});
