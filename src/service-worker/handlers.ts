import { parseRetryAfter } from '../retry-after';
import { BackoffStore } from './backoff-store';

/**
 * レート制限のバックオフ期限の SoT。
 *
 * すべての `fetchApi` がここを通るため、429 を検知できる唯一の choke point である。
 * content script 側 (別タブ・別セッション) をまたいで期限を共有するために service worker 側で
 * 一元管理する。詳細は BackoffStore のコメントおよび Issue #16 を参照。
 *
 * このモジュールは chrome.runtime.onMessage.addListener などの配線を持たない
 * (service-worker.ts がそれを担う)。import した時点で chrome.* を参照しないようにすることで、
 * ユニットテストから直接 import してもグローバルな chrome スタブなしに読み込める。
 */
const backoffStore = new BackoffStore();

export type ApiFetchResponse = {
  ok: boolean;
  status: number;
  retryAfter: string | null;
  body?: string;
  error?: string;
  /** 記録されている現在のバックオフ期限 (epoch ms)。content script 側のゲートが参照する */
  backoffUntil: number;
  /**
   * service worker 側の最終ゲートで、fetch を発行せずに拒否したことを示す。
   * 'backoff' のときは fetch していないので status / retryAfter / body / error に意味はない。
   * content script 側はこれを通信失敗として数えず、429 の再試行枠も消費しない
   * (専用の上限だけを設けて無限ループを防ぐ)。
   */
  kind?: 'backoff';
};

/**
 * api.fanbox.cc への fetch プロキシ本体。429 ならバックオフ期限を記録してから応答する。
 *
 * content script が sendMessageAbortable で待ち合わせを中断していても、この関数自体は
 * 最後まで完走する (fetch そのものを打ち切る仕組みは持たない。真の直列化には service worker 側で
 * AbortController を message 連携させる必要があるが、Issue #16 のスコープ外としている)。
 * そのため、中断された直後に届いた 429 の Retry-After も取りこぼさずに記録できる。
 *
 * @param store 省略時はモジュール共有の singleton を使う。テストでは service worker の
 *   1 回のライフタイムを表す独立したインスタンスを都度渡すことで、同一プロセス内で
 *   複数の「起動」を再現できる (BackoffStore のコメント参照)。
 */
export async function handleFetchApi(url: string, store: BackoffStore = backoffStore): Promise<ApiFetchResponse> {
  try {
    // fetch を発行する前に、既知の未経過期限がないか確認する (最終ゲート)。
    //
    // content script 側にも発行直前の事前確認 (ApiSession.syncBackoffUntil) があるが、
    // それは「ローカルで待ってから来る」ための最適化にすぎず、その確認が終わってから
    // この fetchApi メッセージが実際にここで処理されるまでの間にも、別タブの 429 が
    // 割り込んで期限を延ばしうる (TOCTOU)。すべての fetchApi がここを通る以上、
    // fetch を発行する権限を最終的に持つのはここであるべきなので、ここでもう一度確認する。
    //
    // この判定が保証するのは「既知の未経過期限があるときに fetch を開始しない」ことだけである。
    // service worker はシングルスレッドで store の get()/record() 自体は直列化されているが、
    // この if 判定と直後の fetch() 呼び出しの間には、別メッセージ (別タブの 429) の record が
    // 割り込みうる (service worker は複数のメッセージを並行して処理する)。fetch を開始した後に
    // 別タブの 429 が届くケースはサーバーの応答タイミングに起因する不可避なレースであり、
    // ここでは扱わない (その 429 自体は通常どおり下の分岐で記録される)。
    const knownBackoffUntil = await store.get();
    if (Date.now() < knownBackoffUntil) {
      return { ok: false, status: 0, retryAfter: null, backoffUntil: knownBackoffUntil, kind: 'backoff' };
    }

    const r = await fetch(url, { credentials: 'include' });
    const retryAfter = r.headers.get('Retry-After');
    if (r.status === 429) {
      const waitMs = parseRetryAfter(retryAfter);
      // Retry-After が読めないときは新たな期限を主張しない (現在の記録をそのまま返す)。
      // 何秒待てばよいかの推測はサーバーの指示ではなく content script 側のポリシーなので、
      // ここで決め打ちにしない。
      const backoffUntil = waitMs !== null ? await store.record(Date.now() + waitMs) : await store.get();
      return { ok: false, status: 429, retryAfter, backoffUntil };
    }
    const backoffUntil = await store.get();
    if (!r.ok) {
      return { ok: false, status: r.status, retryAfter, backoffUntil };
    }
    const body = await r.text();
    return { ok: true, status: r.status, retryAfter, body, backoffUntil };
  } catch (e) {
    return { ok: false, status: 0, retryAfter: null, error: String(e), backoffUntil: await store.get() };
  }
}

/** 収集開始時など、まだ 1 度もリクエストしていない時点でバックオフ期限を知るための問い合わせ */
export async function handleGetBackoffUntil(store: BackoffStore = backoffStore): Promise<{ backoffUntil: number }> {
  return { backoffUntil: await store.get() };
}
