import {
  HttpError,
  RateLimitExhaustedError,
  ApiSession as RateLimitedSession,
  ResponseParseError,
  type Transport,
  TransportExhaustedError,
} from 'download-helper/api-session';
import type {
  PlanInfo,
  PlansResponse,
  PostInfo,
  PostInfoResponse,
  PostListItem,
  PostListResponse,
  PostPaginationResponse,
  TagsResponse,
} from 'download-helper/fanbox-collector';
import { sendMessageAbortable } from '../messaging';

// レート制御そのものは共有層が持つが、利用側は FANBOX の取得口ごしに扱うので再 export する
export { HttpError, RateLimitExhaustedError, ResponseParseError, TransportExhaustedError };

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
/**
 * service worker が記録しているバックオフ期限のローカルな参照値。
 *
 * 適応スロットルの間隔はこちらの都合なので収集ごとに初期化してよいが、Retry-After は
 * サーバーが「いつまで待て」と言っている期限であり、収集を中断して再実行しても消えない。
 * SoT は service worker 側 (chrome.storage.session、Issue #16) で、ここはその参照値。
 */
let sharedBackoffUntil = 0;

/** テスト用。収集をまたぐ状態を初期化する (別タブ・リロードでの状態リセットの再現にも使う) */
export function resetSharedBackoff(): void {
  sharedBackoffUntil = 0;
}

/**
 * service worker に記録されている現在のバックオフ期限を取り込む。
 *
 * 発行の直前に毎回呼ぶ。別タブ (別の JS 実行環境) がこちらの待機中に期限を延長していても、
 * その延長は自分が fetchApi の応答を受け取るまでローカルの参照値に反映されないため
 * (Issue #16「実行中タブ間で期限の延長が同期されない」問題)。
 *
 * 応答が欠けている/型が違う場合は無視する (Math.max に undefined を渡すと NaN で壊れる)。
 */
async function syncBackoffUntil(signal?: AbortSignal): Promise<void> {
  const response = await sendMessageAbortable<{ backoffUntil?: number }>({ type: 'getBackoffUntil' }, signal);
  if (typeof response?.backoffUntil === 'number') {
    sharedBackoffUntil = Math.max(sharedBackoffUntil, response.backoffUntil);
  }
}

/**
 * 拡張の transport。service worker を fetch プロキシとして使う。
 *
 * バックオフ期限中は I/O を発行せず deferred を返す。adapter の内側で待って再要求すると、
 * セッションが実際の発行時刻を見失い、基準間隔と適応間隔が抜けるため
 * (待機と再発行はセッションが行う)。
 */
export function createChromeProxyTransport(): Transport {
  return async (url, signal) => {
    // 発行の直前に最新の期限を取り込む。これはベストエフォートなので、失敗しても収集は続ける
    // (期限を知らずに発行することはあっても、応答に乗る backoffUntil で次から追従できる)。
    // ただし中断だけは握りつぶさず伝播する
    try {
      await syncBackoffUntil(signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn('バックオフ期限の事前確認に失敗 (続行):', e);
    }
    if (sharedBackoffUntil > Date.now()) return { kind: 'deferred', until: sharedBackoffUntil };
    let response: ApiFetchResponse;
    try {
      response = await proxyFetchApi(url, signal);
    } catch (cause) {
      // abort はセッションが扱う。通信の失敗として再試行の対象にしない
      if (signal?.aborted) throw cause;
      return { kind: 'unobservable-failure', cause };
    }
    // 応答のたびに最新の期限を取り込む。常に遠い方を採る (別タブの収集が動いていると、
    // 後から届いた応答の期限がこちらの参照値より古いことがある)
    if (typeof response.backoffUntil === 'number') {
      sharedBackoffUntil = Math.max(sharedBackoffUntil, response.backoffUntil);
    }
    if (response.kind === 'backoff') {
      // service worker 側の最終ゲートで拒否された (fetch していない)。発行直前の事前確認は
      // ベストエフォートなので、それから fetchApi が処理されるまでの間に別タブの 429 が
      // 期限を延ばすと起こる (TOCTOU)
      return { kind: 'deferred', until: sharedBackoffUntil };
    }
    // service worker は fetch の失敗を reject せず status 0 で返す
    if (response.status === 0) return { kind: 'unobservable-failure', cause: response.error };
    return {
      kind: 'response',
      status: response.status,
      body: response.body ?? '',
      retryAfter: response.retryAfter,
    };
  };
}

/**
 * FANBOX API の取得口。レート制御そのものは download-helper の共有セッションが担い、
 * ここは FANBOX 固有の URL 組み立てとレスポンス検証だけを持つ。
 */
export class ApiSession {
  private readonly session: RateLimitedSession;

  constructor(intervalMs: number = DEFAULT_API_RATE_LIMIT_MS, transport: Transport = createChromeProxyTransport()) {
    this.session = new RateLimitedSession(Math.max(intervalMs, MIN_RATE_LIMIT_MS), transport);
  }

  /** 現在の発行間隔。適応スロットルの検証用に公開する */
  getIntervalMs(): number {
    return this.session.intervalMs;
  }

  private fetchJson<T, R>(url: string, validate: (parsed: T) => R, signal?: AbortSignal): Promise<R> {
    return this.session.fetchJson<T, R>(url, validate, signal);
  }

  /**
   * プラン情報を取得する。支援額タグの表示名に使うだけなので、失敗しても収集は続ける。
   * ただしレート制限の枯渇だけは再送出する。既に最大回数・累積待機を費やした後で
   * 投稿取得を始めるのは、再試行上限を別のエンドポイントで実質的に延長することになる。
   */
  async fetchPlans(creatorId: string, signal?: AbortSignal): Promise<PlanInfo[]> {
    const url = `https://api.fanbox.cc/plan.listCreator?creatorId=${creatorId}`;
    try {
      return await this.fetchJson<PlansResponse, PlanInfo[]>(
        url,
        (result) => unwrapArray<PlanInfo>(result?.body?.plans, url, 'body.plans', isValidPlan),
        signal,
      );
    } catch (e) {
      if (signal?.aborted || e instanceof RateLimitExhaustedError || e instanceof TransportExhaustedError) throw e;
      // プラン名は表示の補助なので、HTTP エラーやレスポンス形状の不一致
      // (ApiShapeError / ResponseParseError) は握りつぶして続行する
      // (CLAUDE.md 「形状が想定と違うとき、プラン名とタグは表示の補助なので握りつぶして
      // 続行し、投稿一覧と投稿詳細は ApiShapeError で中断する」の方針)。
      // それ以外の想定外の例外 (validator や内部処理のバグ等) まで飲み込むと、
      // 他の経路 (collector.ts) で採用した陽性判定の方針と矛盾し、こちらのバグが
      // 「プラン取得の失敗」として静かに握り潰されてしまうため再送出する。
      if (!(e instanceof HttpError || e instanceof ApiShapeError || e instanceof ResponseParseError)) throw e;
      console.error('プラン情報の取得に失敗:', e);
      return [];
    }
  }

  /** タグ情報を取得する。失敗時の扱いは fetchPlans と同じ (JSDoc 参照) */
  async fetchTags(creatorId: string, signal?: AbortSignal): Promise<string[]> {
    const url = `https://api.fanbox.cc/tag.getFeatured?creatorId=${creatorId}`;
    try {
      return await this.fetchJson<TagsResponse, string[]>(
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
      if (signal?.aborted || e instanceof RateLimitExhaustedError || e instanceof TransportExhaustedError) throw e;
      // fetchPlans と同じ理由・同じ方針 (JSDoc 参照)
      if (!(e instanceof HttpError || e instanceof ApiShapeError || e instanceof ResponseParseError)) throw e;
      console.error('タグ情報の取得に失敗:', e);
      return [];
    }
  }

  /**
   * 200 なのに body.post が無いのは形状の想定違いとみなす。全投稿がこの経路を通る以上、
   * undefined を返して投稿単位の失敗に丸めると、仕様変更時に「中身が空の ZIP を完了扱い」で
   * 出してしまう。
   *
   * 投稿オブジェクト側は収集の分岐に使う id / type / isRestricted だけを検査する。
   * body は必須にはできない。実 API では、支援額が足りず閲覧できない投稿も HTTP 200 で
   * 投稿オブジェクトを返し、`body` プロパティ自体は存在したまま値が `null` になる
   * (`isRestricted: true` / `type` / `coverImageUrl` / `tags` は通常どおり入る)。
   * addByPostInfo がこれを検出して投稿単位でスキップする。
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
    return this.fetchJson<PostPaginationResponse, string[]>(
      url,
      (result) => unwrapArray<string>(result?.body?.pageUrls, url, 'body.pageUrls', (item) => typeof item === 'string'),
      signal,
    );
  }

  async fetchPostList(url: string, signal?: AbortSignal): Promise<PostListItem[]> {
    return this.fetchJson<PostListResponse, PostListItem[]>(
      url,
      (result) => unwrapArray<PostListItem>(result?.body?.posts, url, 'body.posts', isValidPostListItem),
      signal,
    );
  }
}

export { sleep };
