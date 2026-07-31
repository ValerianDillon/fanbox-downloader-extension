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
import { sendMessageAbortable } from '../messaging';

export const DEFAULT_API_RATE_LIMIT_MS = 500;
const RETRY_BACKOFF_MS = [5_000, 15_000, 45_000];
const NETWORK_RETRY_BACKOFF_MS = 5_000;
const MIN_RATE_LIMIT_MS = 50;
const ADAPTIVE_THROTTLE_MULTIPLIER = 1.5;
const ADAPTIVE_THROTTLE_CAP_MS = 3_000;
/** 通信失敗そのものに対する再試行回数 (429 の再試行枠とは別に数える) */
const MAX_NETWORK_RETRY = 1;
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

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

type ApiFetchResponse = {
  ok: boolean;
  status: number;
  retryAfter: string | null;
  body?: string;
  error?: string;
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
 * レート制限の再試行を使い切ったことを表すエラー。
 *
 * 通常の HTTP エラーと区別する必要がある。投稿単位の失敗に丸めると、
 * レート制限が続いている間、残りの投稿が 1 件ずつ順に失敗していく。
 */
export class RateLimitExhaustedError extends Error {
  constructor(url: string) {
    super(`レート制限の再試行上限に達した: ${url}`);
    this.name = 'RateLimitExhaustedError';
  }
}

/**
 * API レスポンスの形状が想定と違うことを表すエラー。
 * 通信失敗や個別投稿の取得失敗 (収集を続行してよい) と区別するために専用の型にしている。
 */
export class ApiShapeError extends Error {
  constructor(url: string) {
    super(`API レスポンスの形状が想定外: ${url}`);
    this.name = 'ApiShapeError';
  }
}

/**
 * FANBOX API の配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。
 * 形状が想定外なら空配列扱いにせず投げる: 空配列にフォールバックすると
 * 「0 件だった」と区別が付かず、API 変更が無言で通り抜けてしまうため。
 */
function unwrapArray<T>(value: unknown, url: string, isValidItem?: (item: unknown) => boolean): T[] {
  if (!Array.isArray(value)) {
    throw new ApiShapeError(url);
  }
  if (isValidItem && !value.every(isValidItem)) {
    throw new ApiShapeError(url);
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
   * サーバーが指定したバックオフ期限。収集をまたいで共有する。
   *
   * 適応スロットルの間隔はこちらの都合なので収集ごとに初期化してよいが、
   * Retry-After はサーバーが「いつまで待て」と言っている期限であり、
   * 収集を中断して再実行しても消えるわけではない。
   * セッションごとに持つと、枯渇した直後に再実行したときに即座に発行してしまう。
   *
   * ただし共有されるのは同じ content script の実行環境内だけで、別タブや
   * リロードをまたぐと 0 に戻る。全リクエストが通る service worker 側で
   * 管理するのが本来の置き場所である。Issue #16 を参照。
   */
  private static sharedBackoffUntil = 0;

  /** テスト用。収集をまたぐ状態を初期化する */
  static resetSharedBackoff(): void {
    ApiSession.sharedBackoffUntil = 0;
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
   * キャンセル直後に再実行すると、前の fetch と新しい fetch が重なり、
   * 前の fetch が受け取った Retry-After も失われる。Issue #16 を参照。
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
      for (;;) {
        await this.gate(signal);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        let response: ApiFetchResponse;
        try {
          response = await proxyFetchApi(url, signal);
        } catch (e) {
          if (signal?.aborted) throw e;
          this.successStreak = 0;
          if (networkAttempts >= MAX_NETWORK_RETRY) throw e;
          networkAttempts++;
          console.warn(`ネットワーク失敗のためリトライ: ${url}`, e);
          await abortableSleep(NETWORK_RETRY_BACKOFF_MS, signal);
          continue;
        }
        // service worker は fetch の失敗を reject せず status 0 で返す。
        // 通常の HTTP エラーとして扱うと、一時的な通信障害がまったく再試行されない
        if (response.status === 0) {
          this.successStreak = 0;
          const error = new Error(`通信に失敗: ${url}${response.error ? ` (${response.error})` : ''}`);
          if (networkAttempts >= MAX_NETWORK_RETRY) throw error;
          networkAttempts++;
          console.warn(`ネットワーク失敗のためリトライ: ${url}`, response.error);
          await abortableSleep(NETWORK_RETRY_BACKOFF_MS, signal);
          continue;
        }
        if (response.status === 429) {
          this.escalate();
          // 待機時間は枯渇するときも記録する。記録せずに投げると、同じセッションに
          // 積まれている後続のリクエストが Retry-After を無視して発行される
          const waitMs =
            parseRetryAfter(response.retryAfter) ??
            RETRY_BACKOFF_MS[Math.min(rateLimitAttempts, RETRY_BACKOFF_MS.length - 1)];
          // 複数のセッションが動いていると、後から返った短い期限が長い期限を
          // 上書きしうるので、常に遠い方を採る
          ApiSession.sharedBackoffUntil = Math.max(ApiSession.sharedBackoffUntil, Date.now() + waitMs);
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
          throw new Error(`HTTP ${response.status}: ${url}${response.error ? ` (${response.error})` : ''}`);
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
        (result) => unwrapArray<PlanInfo>(result?.body?.plans, url, isValidPlan),
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
        if (
          !post ||
          typeof post.id !== 'string' ||
          typeof post.type !== 'string' ||
          typeof post.isRestricted !== 'boolean'
        ) {
          throw new ApiShapeError(url);
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
      (result) => unwrapArray<string>(result?.body?.pageUrls, url, (item) => typeof item === 'string'),
      signal,
    );
  }

  async fetchPostList(url: string, signal?: AbortSignal): Promise<PostListItem[]> {
    return this.fetchJson<PostList, PostListItem[]>(
      url,
      (result) => unwrapArray<PostListItem>(result?.body?.posts, url, isValidPostListItem),
      signal,
    );
  }
}

export { sleep };
