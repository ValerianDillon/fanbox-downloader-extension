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
  PostInfoCandidate,
  PostInfoResponse,
  PostListItemCandidate,
  PostListResponse,
  PostPaginationResponse,
  TagsResponse,
} from 'download-helper/fanbox-collector';
import { sendMessageAbortable } from '../messaging';

// レート制御そのものは共有層が持つが、利用側は FANBOX の取得口ごしに扱うので再 export する
export { HttpError, RateLimitExhaustedError, ResponseParseError, TransportExhaustedError };

export const DEFAULT_API_RATE_LIMIT_MS = 500;
/**
 * 利用者が指定できる基準間隔の下限。再試行の待機やバックオフ、適応スロットルの
 * パラメータは共有セッション (download-helper/api-session) が持つ。
 */
const MIN_RATE_LIMIT_MS = 50;

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
  /**
   * service worker が実際に fetch を開始した時刻 (epoch ms、Issue #46)。
   * fetch を発行しなかった応答では欠ける。旧バージョンの service worker との組み合わせでも
   * 欠けうるので optional にし、欠けていればセッションが sendMessage 直前の時刻に落とす。
   */
  issuedAt?: number;
};

/**
 * service worker 経由で JSON API を叩く。
 * content script から直接 fetch するとページオリジンとして扱われ、読めるヘッダが CORS の
 * セーフリストに限られる。`Retry-After` はセーフリスト外なので、429 を受けてもサーバーの
 * 指示を読めない (ValerianDillon/fanbox-downloader#3 の 2026-08-20 の実測)。
 */
async function proxyFetchApi(url: string, signal?: AbortSignal): Promise<ApiFetchResponse> {
  return sendMessageAbortable<ApiFetchResponse>({ type: 'fetchApi', url }, signal);
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
 * 一覧要素のうち、収集の分岐に使う 3 つだけを検証する (PostListItemCandidate が保証する範囲)。
 * id は post.info の URL を組み立てるのに使い、isRestricted は投稿を飛ばすかの判断に使い、
 * feeRequired は isIgnoreFree の判断に使う。
 * 型が変わると id は「取得失敗が N 件」、isRestricted は「無言で全件スキップ」、
 * feeRequired は「無料を省く指定が無言で効かない」になるため、ここで形状エラーとして止める。
 * それ以外のフィールドは検証しない。本文の取り込みに必要な検証は download-helper の
 * addByPostInfo が入口で行う (ValerianDillon/download-helper#30)。
 */
function isValidPostListItem(item: unknown): boolean {
  const post = item as PostListItemCandidate | null;
  return (
    !!post &&
    typeof post.id === 'string' &&
    typeof post.isRestricted === 'boolean' &&
    typeof post.feeRequired === 'number'
  );
}

/**
 * 一覧要素の `updatedDatetime` を読む (Issue #56)。
 *
 * **必須の validator (`isValidPostListItem`) には足さない。** これは差分判定という最適化のための
 * 情報でしかなく、欠落や型不正で収集全体を止める理由にならない。読めなければ null を返し、
 * その投稿だけ通常の取得へフォールバックさせる。
 *
 * 空文字と空白だけの文字列も読めなかった扱いにする。突き合わせに使う値なので、
 * 編集の前後がどちらも空文字だと「変わっていない」と誤判定する。
 *
 * `PostListItemCandidate` は index signature を持たない (未検証のフィールドを型に出さないため)
 * ので、生の値として読み直す。
 */
export function decodeListedUpdatedDatetime(item: PostListItemCandidate): string | null {
  const value = (item as unknown as Record<string, unknown>).updatedDatetime;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

/**
 * `post.info` の投稿オブジェクトの `updatedDatetime` を読む (Issue #56)。
 *
 * 一覧が返した値と突き合わせて、**一覧と詳細が同じ世代を指しているか**を確かめるために使う。
 * エンドポイントごとにキャッシュの状態が違えば、一覧が新しい版を返しているのに詳細が古い版を
 * 返すことがありうる。そのまま一覧の値を保存実績に付けると、取得できていない中身を
 * 「その版で保存済み」として扱い、次回その投稿を丸ごと飛ばす。
 *
 * 一覧側と同じく必須の validator には足さない。読めなければ「確認できなかった」として扱う。
 */
export function decodePostInfoUpdatedDatetime(post: PostInfoCandidate): string | null {
  const value = (post as unknown as Record<string, unknown>).updatedDatetime;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

/** 支援額タグの表示名の組み立てに使う 2 つを検証する */
function isValidPlan(item: unknown): boolean {
  const plan = item as PlanInfo | null;
  return !!plan && typeof plan.fee === 'number' && typeof plan.title === 'string';
}

/**
 * service worker が記録しているバックオフ期限のローカルな参照値。
 *
 * 発行間隔や適応スロットルはこちらの都合なので収集ごとに初期化してよいが (`ApiSession` を
 * 収集ごとに作る)、Retry-After はサーバーが「いつまで待て」と言っている期限であり、収集を
 * 中断して再実行しても消えない。そのためモジュール変数として収集をまたいで持つ。
 * SoT は service worker 側 (chrome.storage.session、Issue #16) で、ここはその参照値。
 * 更新は fetchApi の応答からのみ行う (下の transport 参照)。
 */
let sharedBackoffUntil = 0;

/** テスト用。収集をまたぐ状態を初期化する (別タブ・リロードでの状態リセットの再現にも使う) */
export function resetSharedBackoff(): void {
  sharedBackoffUntil = 0;
}

/**
 * 拡張の transport。service worker を fetch プロキシとして使う。
 *
 * 実際の fetch は service worker 側で起きるので、応答が運んでくる実発行時刻をそのまま
 * セッションへ渡す。セッションが記録するのは transport を呼ぶ直前の時刻なので、
 * service worker の起動待ちなどで配送が遅れると、記録と実発行がその遅延ぶんずれ、
 * 次のゲートが早く明けて実 fetch の間隔が発行間隔を下回りうる (Issue #46)。
 *
 * バックオフ期限中は I/O を発行せず deferred を返す。adapter の内側で待って再要求すると、
 * セッションが実際の発行時刻を見失い、基準間隔と適応間隔が抜けるため
 * (待機と再発行はセッションが行う)。
 *
 * 同じ理由で、発行の前に service worker へ問い合わせて最新の期限を取り込むこともしない。
 * セッションは transport を呼ぶ直前に発行時刻を記録するので、ここで往復を挟むと実際の
 * fetch がその往復のぶん遅れ、往復の所要時間が要求ごとに違えば実発行間隔が基準間隔を
 * 下回る。期限の最終的な判定は service worker 側のゲートが持ち (`handleFetchApi`)、
 * そこで弾かれた応答 (`kind: 'backoff'`) が最新の期限を運んでくるので、
 * ローカルの参照値は応答からの更新だけで足りる。
 */
export function createChromeProxyTransport(): Transport {
  return async (url, signal) => {
    // 既知の期限内なら I/O を発行しない。ここはローカルの参照値だけを見る (往復を挟まない)
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
      // service worker 側の最終ゲートで拒否された (fetch していない)。ローカルの参照値は
      // 応答からしか更新されないので、別タブの 429 で期限が延びた直後はここに来る
      return { kind: 'deferred', until: sharedBackoffUntil };
    }
    // service worker は fetch の失敗を reject せず status 0 で返す
    if (response.status === 0) {
      return { kind: 'unobservable-failure', cause: response.error, issuedAt: response.issuedAt };
    }
    return {
      kind: 'response',
      status: response.status,
      body: response.body ?? '',
      retryAfter: response.retryAfter,
      issuedAt: response.issuedAt,
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
   *
   * ただし再試行枠の枯渇 (RateLimitExhaustedError / TransportExhaustedError) だけは再送出する。
   * 既に最大回数・累積待機を費やした後で投稿取得を始めるのは、再試行上限を別のエンドポイントで
   * 実質的に延長することになる。
   *
   * 形状の不一致 (ApiShapeError / ResponseParseError) を握りつぶすのはこの 2 つ
   * (plan / tag) だけの例外である。表示の補助しか担っておらず、握りつぶしても ZIP の中身は
   * 欠けないため。投稿一覧・投稿詳細で同じことをすると、仕様変更に気付かないまま
   * 中身の無い ZIP を完了として出してしまう。
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
  async fetchPostInfo(postId: string, signal?: AbortSignal): Promise<PostInfoCandidate> {
    const url = `https://api.fanbox.cc/post.info?postId=${postId}`;
    return this.fetchJson<PostInfoResponse, PostInfoCandidate>(
      url,
      (result) => {
        const post = result?.body?.post as Record<string, unknown> | null | undefined;
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
        // 検証した 3 つだけを保証する型で返す。本文の検証は addByPostInfo の入口が行う
        return post as unknown as PostInfoCandidate;
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

  async fetchPostList(url: string, signal?: AbortSignal): Promise<PostListItemCandidate[]> {
    return this.fetchJson<PostListResponse, PostListItemCandidate[]>(
      url,
      (result) => unwrapArray<PostListItemCandidate>(result?.body?.posts, url, 'body.posts', isValidPostListItem),
      signal,
    );
  }
}
