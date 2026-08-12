import type {
  PaginatedPosts,
  PlanInfo,
  Plans,
  PostInfo,
  PostInfoResponse,
  PostList,
  PostListItem,
  Tags,
} from 'download-helper/fanbox-collector';
import { parseRetryAfter } from '../../retry-after';
import { sendMessageAbortable } from '../messaging';

export const DEFAULT_API_RATE_LIMIT_MS = 500;
const RETRY_BACKOFF_MS = [5_000, 15_000, 45_000];
const NETWORK_RETRY_BACKOFF_MS = 5_000;
const MIN_RATE_LIMIT_MS = 50;
const ADAPTIVE_THROTTLE_MULTIPLIER = 1.5;
const ADAPTIVE_THROTTLE_CAP_MS = 3_000;
/** 通信失敗そのものに対する再試行回数 (429 の再試行枠とは別に数える) */
const MAX_NETWORK_RETRY = 1;
/**
 * service worker 側の最終ゲートで拒否された (kind: 'backoff') ときの再試行回数の上限。
 * 通信していないので通常は 429 の再試行枠を消費させたくないが、無限ループの安全弁として
 * 429 の再試行枠とは別に上限を設ける。次の gate() は取り込み済みの最新の期限を見て
 * 適切な時間だけ待ってから再試行するため、通常はここに達する前に解消するはずである。
 */
const MAX_GATE_REJECTIONS = 10;
/** 引き上げた間隔を戻すのに必要な連続成功数 */
const DECAY_SUCCESS_STREAK = 20;
/** 引き上げた間隔を戻すのに必要な、直近のレート制限からの経過時間 */
const DECAY_QUIET_PERIOD_MS = 60_000;
const DECAY_DIVISOR = 1.25;

export type PageType =
  | { type: 'creator'; creatorId: string }
  | { type: 'post'; creatorId: string; postId: string }
  | null;

export function detectPage(url: string): PageType {
  // www.fanbox.cc/@creator/posts/123
  const wwwPostMatch = url.match(/fanbox\.cc\/@([^/]+)\/posts\/(\d+)/);
  if (wwwPostMatch) {
    return { type: 'post', creatorId: wwwPostMatch[1], postId: wwwPostMatch[2] };
  }
  // www.fanbox.cc/@creator
  const wwwCreatorMatch = url.match(/fanbox\.cc\/@([^/]+)/);
  if (wwwCreatorMatch) {
    return { type: 'creator', creatorId: wwwCreatorMatch[1] };
  }
  // creator.fanbox.cc/posts/123
  const subPostMatch = url.match(/^https:\/\/([^./]+)\.fanbox\.cc\/posts\/(\d+)/);
  if (subPostMatch) {
    return { type: 'post', creatorId: subPostMatch[1], postId: subPostMatch[2] };
  }
  // creator.fanbox.cc
  const subCreatorMatch = url.match(/^https:\/\/([^./]+)\.fanbox\.cc\//);
  if (
    subCreatorMatch &&
    subCreatorMatch[1] !== 'www' &&
    subCreatorMatch[1] !== 'api' &&
    subCreatorMatch[1] !== 'downloads'
  ) {
    return { type: 'creator', creatorId: subCreatorMatch[1] };
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type ApiFetchResponse = {
  ok: boolean;
  status: number;
  retryAfter: string | null;
  body?: string;
  error?: string;
  /**
   * service worker (chrome.storage.session) が記録している現在のバックオフ期限 (epoch ms)。
   * 旧バージョンの service worker との組み合わせ等で欠けることもありうるので optional にし、
   * 受け取り側は欠けていれば無視する (Math.max に undefined を渡すと NaN で壊れるため)。
   */
  backoffUntil?: number;
  /**
   * service worker 側の最終ゲートで、fetch を発行せずに拒否されたことを示す。
   * 'backoff' のときは status/retryAfter/body/error に意味はない (fetch していない)。
   */
  kind?: 'backoff';
};

/**
 * service worker 経由で JSON API を叩く。
 * content script から直接 fetch するとページオリジンとして扱われ、
 * 429 のような CORS ヘッダ無しレスポンスを JS から読めないため。
 */
async function proxyFetchApi(url: string, signal?: AbortSignal): Promise<ApiFetchResponse> {
  return sendMessageAbortable<ApiFetchResponse>({ type: 'fetchApi', url }, signal);
}

/**
 * fetchJson が投げるエラーの種別。'rate-limit' は RateLimitExhaustedError が、
 * 'network' / 'http' は FetchApiError が持つ。呼び出し側 (collector.ts) はこの kind を見て、
 * 「投稿単位の失敗として数えて続行してよい (network/http)」か「収集全体を止めるか
 * (rate-limit は枯渇時点で別途 throw/打ち切り判定)」かを区別する。
 *
 * RateLimitExhaustedError と FetchApiError を 1 クラスに統合しなかったのは、
 * RateLimitExhaustedError には「429 の再試行枠を使い切った」という固有の意味があり、
 * collector.ts 側で instanceof による絞り込み (打ち切り判定・再試行上限の伝播) を
 * 既に多用しているため。kind/status フィールドだけ両クラスに揃えることで、
 * 構造的なアクセス (e.kind / e.status) はどちらの型でも統一しつつ、型の絞り込みは
 * 既存の instanceof チェックのまま活かす。
 */
export type FetchErrorKind = 'rate-limit' | 'network' | 'http';

/**
 * レート制限の再試行を使い切ったことを表すエラー。
 *
 * 通常の HTTP エラーと区別する必要がある。投稿単位の失敗に丸めると、
 * レート制限が続いている間、残りの投稿が 1 件ずつ順に失敗していく。
 */
export class RateLimitExhaustedError extends Error {
  readonly kind: FetchErrorKind = 'rate-limit';
  readonly status = 429;

  constructor(url: string) {
    super(`レート制限の再試行上限に達した: ${url}`);
    this.name = 'RateLimitExhaustedError';
  }
}

/**
 * fetchJson が投げる、通信そのものの失敗 (レート制限の枯渇や形状違反ではない) を表すエラー。
 *
 * kind: 'network' は service worker まで応答が届かなかった/届いても status 0 (fetch 自体の失敗)、
 * 'http' は 200 以外の HTTP ステータスで応答があった場合 (429 は RateLimitExhaustedError 側で扱う
 * ため含まない)。status は 'network' のとき常に 0。
 *
 * collector.ts はこの型かどうかで「API 通信に失敗した投稿」として投稿単位の失敗に数えてよいかを
 * 判定する。instanceof による陽性判定にしているのは、想定外のバグ由来の例外まで
 * ここに丸め込んで握りつぶさないようにするため (「ApiShapeError/RateLimitExhaustedError で
 * なければ全部投稿単位の失敗」という否定形の判定は、新しく増えた例外パターンを
 * 無条件に飲み込んでしまう)。
 */
export class FetchApiError extends Error {
  readonly kind: Extract<FetchErrorKind, 'network' | 'http'>;
  readonly status: number;

  constructor(kind: Extract<FetchErrorKind, 'network' | 'http'>, status: number, message: string) {
    super(message);
    this.name = 'FetchApiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * API レスポンスの形状が想定と違うことを表すエラー。
 * 通信失敗や個別投稿の取得失敗 (収集を続行してよい) と区別するために専用の型にしている。
 *
 * fields には想定と違ったフィールドのパス (例: 'body.posts[]') を積む。詳細な理由をエラー
 * メッセージだけでなく構造化データとしても持たせることで、ログや将来の表示先が
 * 文字列パースに頼らず参照できるようにする。空配列 (デフォルト) は「配列そのものが
 * 想定外だった」等、個々のフィールドに分解できない場合を表す。
 */
export class ApiShapeError extends Error {
  readonly url: string;
  readonly fields: readonly string[];

  constructor(url: string, fields: readonly string[] = []) {
    const detail = fields.length > 0 ? ` (fields: ${fields.join(', ')})` : '';
    super(`API レスポンスの形状が想定外: ${url}${detail}`);
    this.name = 'ApiShapeError';
    this.url = url;
    this.fields = fields;
  }
}

/**
 * FANBOX API の配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。
 * 形状が想定外なら空配列扱いにせず投げる: 空配列にフォールバックすると
 * 「0 件だった」と区別が付かず、API 変更が無言で通り抜けてしまうため。
 *
 * @param fieldPath ApiShapeError.fields に積む、この配列自体を指すフィールドパス
 *   (例: 'body.posts')。要素の形状違反時は `${fieldPath}[]` として積む。
 */
function unwrapArray<T>(value: unknown, url: string, fieldPath: string, isValidItem?: (item: unknown) => boolean): T[] {
  if (!Array.isArray(value)) {
    throw new ApiShapeError(url, [fieldPath]);
  }
  if (isValidItem && !value.every(isValidItem)) {
    throw new ApiShapeError(url, [`${fieldPath}[]`]);
  }
  return value as T[];
}

/**
 * 一覧要素のうち、収集の分岐に使う 2 つだけを検証する。
 * id は post.info の URL を組み立てるのに使い、isRestricted は投稿を飛ばすかの判断に使う。
 * 型が変わると前者は「取得失敗が N 件」、後者は「無言で全件スキップ」になるため、
 * ここで形状エラーとして止める。それ以外のフィールドは download-helper 側が
 * 欠損を許容するので検証しない。
 */
function isValidPostListItem(item: unknown): boolean {
  const post = item as PostListItem | null;
  return !!post && typeof post.id === 'string' && typeof post.isRestricted === 'boolean';
}

/** 支援額タグの表示名の組み立てに使う 2 つを検証する */
function isValidPlan(item: unknown): boolean {
  const plan = item as PlanInfo | null;
  return !!plan && typeof plan.fee === 'number' && typeof plan.title === 'string';
}

/**
 * 1 回の収集ぶんの API 呼び出しをまとめる。
 *
 * レート制限の状態 (最終リクエスト時刻、現在の間隔、バックオフ期限) は収集ごとに持つ。
 * モジュール変数にすると前回の収集で引き上がった間隔が次の収集に持ち越される。
 *
 * リクエストは 1 本ずつ直列に発行する。ゲートの待機だけを直列化しても、
 * 待ち明けに複数の呼び出しが同時に発行されてしまう。
 */
export class ApiSession {
  /**
   * サーバーが指定したバックオフ期限のローカルな参照値。収集をまたいで (同じ content script の
   * 実行環境内では) 共有する。
   *
   * 適応スロットルの間隔はこちらの都合なので収集ごとに初期化してよいが、
   * Retry-After はサーバーが「いつまで待て」と言っている期限であり、
   * 収集を中断して再実行しても消えるわけではない。
   * セッションごとに持つと、枯渇した直後に再実行したときに即座に発行してしまう。
   *
   * SoT は service worker 側 (chrome.storage.session、Issue #16) にあり、ここはその参照値
   * (キャッシュ) にすぎない。別タブやリロードをまたぐとこの静的フィールド自体は 0 に戻るが、
   * gate() が実際にリクエストを発行する直前に毎回 syncBackoffUntil() で埋め直すため
   * (最初のリクエストも含む)、呼び出し側が明示的に事前取得する必要はない。
   */
  private static sharedBackoffUntil = 0;

  /** テスト用。収集をまたぐ状態を初期化する (別タブ・リロードでの状態リセットの再現にも使う) */
  static resetSharedBackoff(): void {
    ApiSession.sharedBackoffUntil = 0;
  }

  /**
   * service worker に記録されている現在のバックオフ期限を取得し、ローカルの参照値に反映する。
   *
   * gate() が、待機を終えて実際にリクエストを発行する直前に毎回呼ぶ。別タブ (別の JS 実行環境)
   * がこちらの待機中に期限を延長していても、その延長は自分が fetchApi の応答を受け取るまで
   * ローカルの参照値に反映されないため、発行直前に毎回問い合わせて確認する
   * (Issue #16「実行中タブ間で期限の延長が同期されない」問題)。同じ理由で、別タブやリロードを
   * またいで残っている記録も、最初のリクエストの発行直前にここで取り込まれる。
   *
   * 応答が欠けている/型が違う場合は無視する (Math.max に undefined を渡すと NaN で壊れるため)。
   */
  static async syncBackoffUntil(signal?: AbortSignal): Promise<void> {
    const response = await sendMessageAbortable<{ backoffUntil?: number }>({ type: 'getBackoffUntil' }, signal);
    if (typeof response?.backoffUntil === 'number') {
      ApiSession.sharedBackoffUntil = Math.max(ApiSession.sharedBackoffUntil, response.backoffUntil);
    }
  }

  private lastRequestAt = 0;
  private readonly baseInterval: number;
  private interval: number;
  /** 直近のスロットル引き上げ以降に成功したリクエスト数 */
  private successStreak = 0;
  private lastThrottledAt = 0;
  /**
   * 発行中のリクエストを直列化するための待ち行列。
   *
   * 中断された呼び出しについては直列化を保証できない。sendMessageAbortable は
   * 呼び出し側の Promise を reject するだけで、service worker 側の fetch は走り続ける。
   * キャンセル直後に再実行すると、前の fetch と新しい fetch が重なりうる。
   * ただし service worker 側の fetch はそのまま完走し、429 の Retry-After は
   * service worker 側に記録されるため (Issue #16)、失われるのは直列性だけで
   * Retry-After 自体はもう失われない。真の直列化 (service worker 側で fetch を打ち切る仕組み)
   * は Issue #16 のスコープ外としている。
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(intervalMs: number = DEFAULT_API_RATE_LIMIT_MS) {
    this.baseInterval = Math.max(MIN_RATE_LIMIT_MS, Math.floor(intervalMs));
    this.interval = this.baseInterval;
  }

  /** 現在の最小リクエスト間隔 (適応スロットルで変動する) */
  getIntervalMs(): number {
    return this.interval;
  }

  /** 適応スロットルの上限。利用者が指定した基準間隔より低くはしない */
  private get cap(): number {
    return Math.max(this.baseInterval, ADAPTIVE_THROTTLE_CAP_MS);
  }

  private escalate(): void {
    const next = Math.min(
      this.cap,
      Math.max(this.baseInterval, Math.floor(this.interval * ADAPTIVE_THROTTLE_MULTIPLIER)),
    );
    if (next !== this.interval) {
      console.warn(`レート制限検知: API 間隔を ${this.interval}ms → ${next}ms に引き上げ`);
      this.interval = next;
    }
    this.successStreak = 0;
    this.lastThrottledAt = Date.now();
  }

  /**
   * レート制限を踏まずに一定回数成功し、かつ十分な時間が経ったら間隔を戻す。
   * 減衰がないと、一度 429 を踏んだ収集は最後まで間隔が上がったままになる。
   */
  private decay(): void {
    this.successStreak++;
    if (this.interval <= this.baseInterval) return;
    if (this.successStreak < DECAY_SUCCESS_STREAK) return;
    if (Date.now() - this.lastThrottledAt < DECAY_QUIET_PERIOD_MS) return;
    const next = Math.max(this.baseInterval, Math.floor(this.interval / DECAY_DIVISOR));
    if (next !== this.interval) {
      console.info(`レート制限が落ち着いたため API 間隔を ${this.interval}ms → ${next}ms に戻す`);
      this.interval = next;
    }
    this.successStreak = 0;
  }

  private async gate(signal?: AbortSignal): Promise<void> {
    // 待っている間に別のリクエストが期限を延ばすことがあるので、その分だけ待ち足す。
    // 「期限に達したか」を時計で判定し直すと、待機を早く抜けたときに回り続けてしまう
    for (;;) {
      const deadline = ApiSession.sharedBackoffUntil;
      const now = Date.now();
      const wait = Math.max(deadline - now, this.lastRequestAt + this.interval - now, 0);
      if (wait > 0) await abortableSleep(wait, signal);
      // 待ち終えた直後、実際にリクエストを発行する直前に service worker へ最新の期限を
      // 問い合わせる。別タブ (別の JS 実行環境) が待機中に期限を延長していても、
      // その延長は自分が次に fetchApi の応答を受け取るまでローカルの参照値に反映されない。
      // ここで問い合わせておかないと、延長を知らないまま発行してしまう。
      // メッセージ 1 往復のコストは fetch 本体に比べて無視できる。
      //
      // ただしこれはあくまでベストエフォートの事前確認であり、最終判定は service worker 側の
      // handleFetchApi のゲートが持つ (発行直前の問い合わせと実際の発行の間にも別タブの 429 が
      // 割り込みうるため、TOCTOU を完全には塞げない)。そのため、ここでの問い合わせが失敗しても
      // (メッセージ不達や storage エラーなど) 収集全体を止める理由にはならない。中断だけは
      // そのまま伝播し、それ以外は警告ログを出してローカルに既知の値のまま続行する (fail-open)。
      try {
        await ApiSession.syncBackoffUntil(signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn('バックオフ期限の事前確認に失敗。ローカルの参照値のまま続行します:', e);
      }
      if (ApiSession.sharedBackoffUntil <= deadline) break;
    }
    this.lastRequestAt = Date.now();
  }

  /** 直前のリクエストが終わるまで待ってから実行する */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    // 失敗しても後続を止めない
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * @param validate レスポンスから呼び出し側が必要とする値を取り出す。
   *   ここを通って初めて成功として数える。JSON として読めても形状が違えば
   *   失敗なので、減衰の連続成功に含めてはいけない。
   */
  private fetchJson<T, R>(url: string, validate: (parsed: T) => R, signal?: AbortSignal): Promise<R> {
    return this.serialize(async () => {
      let networkAttempts = 0;
      // 通信失敗の再試行と 429 の再試行は別に数える。混ぜると通信の失敗が
      // レート制限の試行枠を食い、429 に使える回数が減る
      let rateLimitAttempts = 0;
      // service worker 側の最終ゲートで拒否された回数。通信していないので 429 の再試行枠とは
      // 別に数える (無限ループの安全弁、MAX_GATE_REJECTIONS のコメント参照)
      let gateRejections = 0;
      for (;;) {
        await this.gate(signal);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        let response: ApiFetchResponse;
        try {
          response = await proxyFetchApi(url, signal);
        } catch (e) {
          if (signal?.aborted) throw e;
          this.successStreak = 0;
          if (networkAttempts >= MAX_NETWORK_RETRY) {
            const detail = e instanceof Error ? ` (${e.message})` : '';
            throw new FetchApiError('network', 0, `通信に失敗: ${url}${detail}`);
          }
          networkAttempts++;
          console.warn(`ネットワーク失敗のためリトライ: ${url}`, e);
          await abortableSleep(NETWORK_RETRY_BACKOFF_MS, signal);
          continue;
        }
        // service worker (chrome.storage.session) が記録している現在のバックオフ期限を
        // 応答のたびに取り込む。応答に乗せる方式にしているのは、収集開始時に一度
        // 取得すれば (syncBackoffUntil)、以降は追加の往復なしに最新の期限へ追従できるため。
        // 常に遠い方を採る: 別タブの収集が動いていると、後から届いた応答の期限がこちらの
        // ローカルな参照値より古いことがある
        if (typeof response.backoffUntil === 'number') {
          ApiSession.sharedBackoffUntil = Math.max(ApiSession.sharedBackoffUntil, response.backoffUntil);
        }
        if (response.kind === 'backoff') {
          // service worker 側の最終ゲートで拒否された (fetch していない)。gate() の発行直前の
          // 事前確認 (syncBackoffUntil) はベストエフォートなので、それが完了してからこの
          // fetchApi メッセージが実際に処理されるまでの間に別タブの 429 が期限を延ばすと起こる
          // (TOCTOU)。通信していないので通信失敗としては数えず、429 の再試行枠も消費しない。
          // 上で取り込んだ最新の backoffUntil を、次の gate() が見て適切な時間だけ待つ
          if (gateRejections >= MAX_GATE_REJECTIONS) {
            throw new RateLimitExhaustedError(url);
          }
          gateRejections++;
          continue;
        }
        // service worker は fetch の失敗を reject せず status 0 で返す。
        // 通常の HTTP エラーとして扱うと、一時的な通信障害がまったく再試行されない
        if (response.status === 0) {
          this.successStreak = 0;
          if (networkAttempts >= MAX_NETWORK_RETRY) {
            throw new FetchApiError('network', 0, `通信に失敗: ${url}${response.error ? ` (${response.error})` : ''}`);
          }
          networkAttempts++;
          console.warn(`ネットワーク失敗のためリトライ: ${url}`, response.error);
          await abortableSleep(NETWORK_RETRY_BACKOFF_MS, signal);
          continue;
        }
        if (response.status === 429) {
          this.escalate();
          // この待機は「次の自分の再試行までどれだけ空けるか」というセッションローカルな
          // ポリシー (Retry-After があればそれを優先、無ければ RETRY_BACKOFF_MS)。
          // 別タブ・別セッションをまたいで共有される期限 (ApiSession.sharedBackoffUntil) は
          // 上の response.backoffUntil の取り込みで既に更新済みで、これは service worker が
          // 実際の Retry-After ヘッダから計算した値なので、ここで自前に計算し直さない。
          const waitMs =
            parseRetryAfter(response.retryAfter) ??
            RETRY_BACKOFF_MS[Math.min(rateLimitAttempts, RETRY_BACKOFF_MS.length - 1)];
          if (rateLimitAttempts >= RETRY_BACKOFF_MS.length) {
            throw new RateLimitExhaustedError(url);
          }
          rateLimitAttempts++;
          console.warn(
            `HTTP 429: ${url} → ${waitMs}ms 待機してリトライ (${rateLimitAttempts}/${RETRY_BACKOFF_MS.length})`,
          );
          await abortableSleep(waitMs, signal);
          continue;
        }
        if (!response.ok || response.body === undefined) {
          // 連続成功が途切れたので減衰の判定をやり直す
          this.successStreak = 0;
          throw new FetchApiError(
            'http',
            response.status,
            `HTTP ${response.status}: ${url}${response.error ? ` (${response.error})` : ''}`,
          );
        }
        let validated: R;
        try {
          validated = validate(JSON.parse(response.body) as T);
        } catch (e) {
          // 壊れた JSON も形状違いも成功ではない
          this.successStreak = 0;
          throw e;
        }
        this.decay();
        return validated;
      }
    });
  }

  /**
   * プラン情報を取得する。支援額タグの表示名に使うだけなので、失敗しても収集は続ける。
   * ただしレート制限の枯渇だけは再送出する。既に最大回数・累積待機を費やした後で
   * 投稿取得を始めるのは、再試行上限を別のエンドポイントで実質的に延長することになる。
   */
  async fetchPlans(creatorId: string, signal?: AbortSignal): Promise<PlanInfo[]> {
    const url = `https://api.fanbox.cc/plan.listCreator?creatorId=${creatorId}`;
    try {
      return await this.fetchJson<Plans, PlanInfo[]>(
        url,
        (result) => unwrapArray<PlanInfo>(result?.body?.plans, url, 'body.plans', isValidPlan),
        signal,
      );
    } catch (e) {
      if (signal?.aborted || e instanceof RateLimitExhaustedError) throw e;
      console.error('プラン情報の取得に失敗:', e);
      return [];
    }
  }

  async fetchTags(creatorId: string, signal?: AbortSignal): Promise<string[]> {
    const url = `https://api.fanbox.cc/tag.getFeatured?creatorId=${creatorId}`;
    try {
      return await this.fetchJson<Tags, string[]>(
        url,
        (result) =>
          unwrapArray<{ tag: string }>(
            result?.body?.featuredTags,
            url,
            'body.featuredTags',
            (item) => typeof (item as { tag?: unknown } | null)?.tag === 'string',
          ).map((tag) => tag.tag),
        signal,
      );
    } catch (e) {
      if (signal?.aborted || e instanceof RateLimitExhaustedError) throw e;
      console.error('タグ情報の取得に失敗:', e);
      return [];
    }
  }

  /**
   * 閲覧できない投稿は HTTP 4xx で返るため、200 なのに body.post が無いのは形状の想定違いとみなす。
   * 全投稿がこの経路を通る以上、undefined を返して投稿単位の失敗に丸めると、
   * 仕様変更時に「中身が空の ZIP を完了扱い」で出してしまう。
   *
   * 投稿オブジェクト側は収集の分岐に使う id / type / isRestricted だけを検査する。
   * body は支援額が足りない投稿では正常に欠落しうる (addByPostInfo がそれを検出して
   * スキップする) ので、必須にはできない。
   */
  async fetchPostInfo(postId: string, signal?: AbortSignal): Promise<PostInfo> {
    const url = `https://api.fanbox.cc/post.info?postId=${postId}`;
    return this.fetchJson<PostInfoResponse, PostInfo>(
      url,
      (result) => {
        const post = result?.body?.post;
        if (!post) {
          throw new ApiShapeError(url, ['body.post']);
        }
        const fields: string[] = [];
        if (typeof post.id !== 'string') fields.push('body.post.id');
        if (typeof post.type !== 'string') fields.push('body.post.type');
        if (typeof post.isRestricted !== 'boolean') fields.push('body.post.isRestricted');
        if (fields.length > 0) {
          throw new ApiShapeError(url, fields);
        }
        return post;
      },
      signal,
    );
  }

  async fetchPaginatedPosts(creatorId: string, signal?: AbortSignal): Promise<string[]> {
    const url = `https://api.fanbox.cc/post.paginateCreator?creatorId=${creatorId}`;
    return this.fetchJson<PaginatedPosts, string[]>(
      url,
      (result) => unwrapArray<string>(result?.body?.pageUrls, url, 'body.pageUrls', (item) => typeof item === 'string'),
      signal,
    );
  }

  async fetchPostList(url: string, signal?: AbortSignal): Promise<PostListItem[]> {
    return this.fetchJson<PostList, PostListItem[]>(
      url,
      (result) => unwrapArray<PostListItem>(result?.body?.posts, url, 'body.posts', isValidPostListItem),
      signal,
    );
  }
}

export { sleep };
