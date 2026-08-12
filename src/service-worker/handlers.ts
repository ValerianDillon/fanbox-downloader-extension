import { uint8ArrayToBase64 } from '../base64';
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

/**
 * store.get() を安全化する。BackoffStore の get()/record() は chrome.storage.session を
 * 叩くため失敗しうるが、期限を「知れなかった」ことが handleFetchApi / handleGetBackoffUntil
 * 全体を失敗させる理由にはならない (呼び出し元の message ハンドラは必ず応答を返す契約を
 * 守る必要がある。応答を返し損なうと sendResponse が呼ばれず、content script は
 * 応答なしで待ち続けることになる)。失敗時は「未記録 (0)」に倒す。
 */
async function safeGet(store: BackoffStore): Promise<number> {
  try {
    return await store.get();
  } catch (e) {
    console.warn('バックオフ期限の取得に失敗。未記録 (0) として扱います:', e);
    return 0;
  }
}

/**
 * store.record() を安全化する。永続化 (chrome.storage.session.set) が失敗しても、
 * 候補値 (呼び出し元がローカルで計算した Date.now() + waitMs) をそのまま返す。
 * 429 という事実と Retry-After は fetch から確実に得られているので、それを呼び出し元に
 * 報告できないのは永続化の失敗であって fetch の失敗ではない。ここで例外を伝播させると、
 * handleFetchApi の外側の catch が応答全体を「通信障害 (status: 0)」にすり替えてしまい、
 * content script は既知の Retry-After を無視して短い間隔で再送してしまう。
 */
async function safeRecord(store: BackoffStore, candidateUntil: number): Promise<number> {
  try {
    return await store.record(candidateUntil);
  } catch (e) {
    console.warn('バックオフ期限の記録 (永続化) に失敗。ローカルで計算した候補値を返します:', e);
    return candidateUntil;
  }
}

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
    // この判定が保証するのは「読み取れた既知の未経過期限があるときに fetch を開始しない」ことである。
    // if 判定と直後の fetch() 呼び出しの間には await が無いため、そこに他メッセージの処理は
    // 割り込めない (run-to-completion)。ただし期限の読み取り (safeGet) 自体は await を挟むので、
    // 並行する別 fetch の 429 記録 (record) が storage.set を待っている間に、この読み取りが
    // 記録前の古い値を返し、そのまま fetch が発行される経路は残る。つまり不可避なのは
    // (1) 既に開始済みの別 fetch の 429 がこの fetch の開始後に判明するケースと、
    // (2) 最終ゲートの読み取りと 429 の記録処理が並行するケースの 2 つで、どちらも
    // 進行中の並行リクエストに由来する限定的なレースである (その 429 自体は通常どおり
    // 下の分岐で記録され、次のリクエストからはゲートに反映される)。
    const knownBackoffUntil = await safeGet(store);
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
      //
      // record (永続化) には safeRecord を使う: 429 を受け取ったという事実と Retry-After は
      // fetch から確実に得られているので、永続化の失敗をここで例外にすると、この関数の外側の
      // catch が「通信障害 (status: 0)」にすり替えてしまい、content script は既知の
      // Retry-After を無視して短い間隔で再送してしまう。
      const backoffUntil = waitMs !== null ? await safeRecord(store, Date.now() + waitMs) : await safeGet(store);
      return { ok: false, status: 429, retryAfter, backoffUntil };
    }
    const backoffUntil = await safeGet(store);
    if (!r.ok) {
      return { ok: false, status: r.status, retryAfter, backoffUntil };
    }
    const body = await r.text();
    return { ok: true, status: r.status, retryAfter, body, backoffUntil };
  } catch (e) {
    // ここに到達するのは fetch() 自体の失敗 (実際の通信障害) のみ。safeGet/safeRecord は
    // 例外を投げないので、store へのアクセス失敗がここに紛れ込んで「通信障害」を誤って
    // 報告することはない。
    return { ok: false, status: 0, retryAfter: null, error: String(e), backoffUntil: await safeGet(store) };
  }
}

/** 収集開始時など、まだ 1 度もリクエストしていない時点でバックオフ期限を知るための問い合わせ */
export async function handleGetBackoffUntil(store: BackoffStore = backoffStore): Promise<{ backoffUntil: number }> {
  return { backoffUntil: await safeGet(store) };
}

export type MediaFetchResponse = {
  ok: boolean;
  /** HTTP ステータス。fetch() 自体が例外を投げた通信失敗は fetchApi (ApiFetchResponse) と揃えて 0 で表現する */
  status: number;
  retryAfter: string | null;
  /** base64 エンコードされたレスポンスボディ。ok のときのみ存在する */
  data?: string;
  error?: string;
};

/**
 * downloads.fanbox.cc / *.pximg.net などメディア取得 (`type: 'fetch'`) の fetch プロキシ本体。
 *
 * Issue #18 第 1 段階のスコープは「ステータスと Retry-After を失わずに観測できるようにする」ことであり、
 * fetchApi (handleFetchApi) のような 429 発行前ゲート・バックオフ記録は行わない。取得先ホストが
 * api.fanbox.cc と異なり、制限枠が共通か別かも未確認のため、ここで BackoffStore は参照しない
 * (第 2 段階のスコープ。Issue #18 の「関連」節参照)。
 *
 * 呼び出し側 (content script の downloader.ts) が試行単位の記録・対象単位の失敗集計を行う。
 * ここでは 1 回の fetch 試行の結果をそのまま返すだけに留める。
 *
 * fetch() 自体の失敗 (status: 0、実際の通信障害) と、応答は受け取れたが本文の読み込み
 * (r.arrayBuffer()) や base64 変換 (uint8ArrayToBase64) が失敗するケースを区別するため、
 * 「HTTP 応答の観測 (status/retryAfter の確定)」と「本文の読み込み・変換」を別の try で囲む。
 * 後者は既に status/retryAfter を観測できているので、失敗時もそれらを status: 0 に
 * すり替えず、観測済みの値のまま ok: false + error で返す。
 */
export async function handleFetchMedia(url: string): Promise<MediaFetchResponse> {
  let r: Response;
  try {
    r = await fetch(url, { credentials: 'include' });
  } catch (e) {
    // ここに到達するのは fetch() 自体の失敗 (実際の通信障害) のみ
    return { ok: false, status: 0, retryAfter: null, error: String(e) };
  }
  const retryAfter = r.headers.get('Retry-After');
  if (!r.ok) {
    return { ok: false, status: r.status, retryAfter };
  }
  try {
    // ArrayBuffer → base64 (messaging 経由で転送するため)
    const buf = await r.arrayBuffer();
    return { ok: true, status: r.status, retryAfter, data: uint8ArrayToBase64(new Uint8Array(buf)) };
  } catch (e) {
    // 本文の読み込み・変換の失敗。HTTP 応答自体は観測できている (status は 2xx) ので、
    // status: 0 (通信失敗) にすり替えず、観測済みの status/retryAfter を維持したまま返す
    return { ok: false, status: r.status, retryAfter, error: String(e) };
  }
}
