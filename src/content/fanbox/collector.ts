import type { DownloadObject } from 'download-helper/download-helper';
import { type AddPostResult, addByPostInfo, DownloadManage, type PostListItem } from 'download-helper/fanbox-collector';
import {
  ApiSession,
  ApiShapeError,
  DEFAULT_API_RATE_LIMIT_MS,
  HttpError,
  RateLimitExhaustedError,
  ResponseParseError,
  TransportExhaustedError,
} from './api';

export type CollectorSettings = {
  isIgnoreFree: boolean;
  limit: number | null;
  apiIntervalMs: number | null;
};

/**
 * 投稿単位の失敗の内訳 (Issue #14)。
 *
 * 理由によって呼び出し側 (overlay.ts) の扱いが違う (表示を分ける、閾値判定には使わない等) ため、
 * 合算した 1 個の数値ではなく理由別に持つ。unavailable はさらに reason 別の内訳も持つが、
 * これは観測用であり表示は unavailable に合流させる (isRestricted: false かつ本文なしが
 * 実際に起こるかは未観測のため、reason 別の表示までは Issue #14 の必須範囲としない)。
 */
export type PostFailureCounts = {
  /** 本文を利用できなかった投稿の合計 (unavailableRestricted + unavailableMissingBody) */
  unavailable: number;
  /** 一覧/詳細で isRestricted だった (支援額不足などでも正常に起こりうる) */
  unavailableRestricted: number;
  /** isRestricted ではないのに本文が無かった (missing-body。postInfo 自体が取れない場合も含む) */
  unavailableMissingBody: number;
  /** 未知の投稿タイプ (収集は中断しないが取り込めない) */
  unsupported: number;
  /** postInfo の取得が HttpError (2xx 以外の応答) で終わった。再試行枠の枯渇はここに数えず収集を止める */
  apiFailed: number;
};

function emptyPostFailureCounts(): PostFailureCounts {
  return { unavailable: 0, unavailableRestricted: 0, unavailableMissingBody: 0, unsupported: 0, apiFailed: 0 };
}

export type CollectResult = {
  downloadObject: DownloadObject;
  /**
   * addByPostInfo が実際に 'added' を返した件数。
   *
   * ZIP を保存してよいかの判定はこの値で行う (失敗件数で判定してはいけない。1 件目の投稿で
   * 失敗した場合は失敗件数が 0 のままになる経路があり、「1 件も取れていない」と「全部取れた」を
   * 失敗件数だけでは区別できないため)。
   */
  addedPostCount: number;
  /** 投稿単位の失敗の内訳。理由ごとの扱いは PostFailureCounts のコメントを参照 */
  postFailures: PostFailureCounts;
  /**
   * 取得できなかった投稿一覧ページの数。
   * 1 ページ落ちると複数投稿が欠落するので、投稿単位の失敗件数とは足し合わせない。
   */
  failedPageCount: number;
  /**
   * 収集を最後まで走査せずに打ち切った理由。未設定なら全ページを走査した。
   * 打ち切った場合もそこまでに集めた分は捨てず、不完全と明示したうえで保存できるようにする。
   */
  stoppedReason?: 'rate-limit-exhausted' | 'transport-exhausted';
};

export type ProgressCallback = (current: number, total: number) => void;

/**
 * addByPostInfo が本文を安全に取り込めないと判断した (AddPostResult.status === 'invalid') ことを
 * 表すエラー。
 *
 * 既知の投稿タイプなのに addByPostInfo が実際に読み取るフィールドが欠けている、という
 * 構造的な不一致であり、支援額不足などの正常系では説明できない。API 層の ApiShapeError とは
 * 検出層が違う (こちらはライブラリ層である addByPostInfo 自身のフィールド検証結果) が、
 * 「このバージョンでは仕様変更に追随できていない」という意味は同じなので、ApiShapeError と
 * 同様に投稿単位の失敗に丸めず収集全体を中断する。
 */
export class PostBodyInvalidError extends Error {
  readonly postId: string;
  readonly type: string;
  readonly missing: readonly string[];

  constructor(postId: string, type: string, missing: readonly string[]) {
    super(`投稿データの形式が想定外 (postId: ${postId}, type: ${type}, missing: ${missing.join(', ')})`);
    this.name = 'PostBodyInvalidError';
    this.postId = postId;
    this.type = type;
    this.missing = missing;
  }
}

type AddOutcome = 'added' | 'ignored' | 'failed';

/**
 * addByPostInfo の結果を counts に反映し、取り込めたか (added/ignored/failed) を返す。
 *
 * invalid は収集全体を中断すべき失敗なので、ここで PostBodyInvalidError を投げる
 * (呼び出し側の catch で ApiShapeError と同様に扱う想定)。
 */
function applyAddResult(result: AddPostResult, counts: PostFailureCounts): AddOutcome {
  switch (result.status) {
    case 'added':
      return 'added';
    case 'ignored':
      return 'ignored';
    case 'unavailable':
      counts.unavailable++;
      if (result.reason === 'restricted') {
        counts.unavailableRestricted++;
      } else {
        counts.unavailableMissingBody++;
      }
      return 'failed';
    case 'unsupported':
      counts.unsupported++;
      return 'failed';
    case 'invalid':
      throw new PostBodyInvalidError(result.postId, result.type, result.missing);
  }
}

export async function collect(
  creatorId: string,
  postId: string | undefined,
  settings: CollectorSettings,
  onProgress: ProgressCallback,
  signal: AbortSignal,
): Promise<CollectResult> {
  // レート制限の状態は収集ごとに持つ。前回引き上がった間隔を次の収集に持ち越さない
  const api = new ApiSession(settings.apiIntervalMs ?? DEFAULT_API_RATE_LIMIT_MS);

  // 別タブや直前のリロードで service worker 側に記録が残っていても、ApiSession の
  // gate() が実際にリクエストを発行する直前に毎回 service worker へ問い合わせるため、
  // ここで明示的に事前取得する必要はない (最初のリクエストも含めて gate() 側で守られる)。

  const plans = await api.fetchPlans(creatorId, signal);
  const feeMapper = new Map<number, string>();
  for (const plan of plans) {
    feeMapper.set(plan.fee, plan.title);
  }
  const downloadManage = new DownloadManage(creatorId, feeMapper);
  downloadManage.downloadObject.setUrl(`https://www.fanbox.cc/@${creatorId}`);
  downloadManage.isIgnoreFree = settings.isIgnoreFree;
  if (settings.limit !== null && settings.limit > 0) {
    downloadManage.setLimitAvailable(true);
    downloadManage.setLimit(settings.limit);
  }

  // プラン名とタグの取得は投稿を 1 件も集める前に走る。ここで枯渇したら
  // 「取得できた分」が存在しないので、打ち切り扱いにせずエラーとして投げる。
  // 打ち切り扱いにすると、中身のない ZIP を「取得できた分のみ保存しています」と
  // 表示して出してしまう。
  const definedTags = await api.fetchTags(creatorId, signal);
  downloadManage.addTags(...definedTags);

  let addedPostCount = 0;
  let postFailures = emptyPostFailureCounts();
  let failedPageCount = 0;
  let stoppedReason: CollectResult['stoppedReason'];
  if (postId) {
    onProgress(0, 1);
    try {
      const result = addByPostInfo(downloadManage, await api.fetchPostInfo(postId, signal));
      if (applyAddResult(result, postFailures) === 'added') addedPostCount++;
    } catch (e) {
      if (signal.aborted) throw e;
      // 単一投稿モードで枯渇したなら取り込めたものは無いので、打ち切りではなくエラーにする。
      // 形状/本文の不一致 (ApiShapeError/PostBodyInvalidError) も投稿単位の失敗に丸めない
      if (
        e instanceof ApiShapeError ||
        e instanceof ResponseParseError ||
        e instanceof PostBodyInvalidError ||
        e instanceof RateLimitExhaustedError ||
        e instanceof TransportExhaustedError
      ) {
        throw e;
      }
      // HttpError だけを投稿単位の失敗として数える。通信の失敗は再試行を経て枯渇として
      // 伝播し、そこで収集を止める (残りを要求し続けると、非可視の 429 だった場合に危険)。それ以外
      // (想定外の例外) を握りつぶすと、こちらのバグが「取得に失敗した投稿」として
      // 静かに握り潰されてしまう
      if (!(e instanceof HttpError)) throw e;
      console.error(`投稿情報の取得に失敗 (postId: ${postId}):`, e);
      postFailures.apiFailed++;
    }
    onProgress(1, 1);
  } else {
    const collected = await getItemsByCreator(api, downloadManage, onProgress, signal);
    addedPostCount = collected.addedPostCount;
    postFailures = collected.postFailures;
    failedPageCount = collected.failedPageCount;
    if (collected.stoppedBy) {
      // 1 件も取り込めていないなら「取得できた分」が無い。打ち切りとして返すと
      // 中身のない ZIP を「取得できた分のみ保存しています」と表示して出してしまう。
      // 判定は失敗件数ではなく取り込めた件数で行う: 最初の投稿やページで枯渇した場合は
      // 失敗件数も 0 のままなので、失敗件数では区別できない
      if (collected.addedPostCount === 0) throw collected.stoppedBy;
      console.error('再試行の上限に達したため収集を打ち切りました:', collected.stoppedBy);
      stoppedReason =
        collected.stoppedBy instanceof RateLimitExhaustedError ? 'rate-limit-exhausted' : 'transport-exhausted';
    }
  }

  downloadManage.applyTags();
  return {
    downloadObject: downloadManage.downloadObject,
    addedPostCount,
    postFailures,
    failedPageCount,
    stoppedReason,
  };
}

type CreatorCollectCounts = {
  addedPostCount: number;
  postFailures: PostFailureCounts;
  failedPageCount: number;
  /** 再試行枠の枯渇 (レート制限または通信) で全ページを走査せずに打ち切った場合、その原因 */
  stoppedBy?: RateLimitExhaustedError | TransportExhaustedError;
};

async function getItemsByCreator(
  api: ApiSession,
  downloadManage: DownloadManage,
  onProgress: ProgressCallback,
  signal: AbortSignal,
): Promise<CreatorCollectCounts> {
  let urls: string[];
  try {
    urls = await api.fetchPaginatedPosts(downloadManage.userId, signal);
  } catch (e) {
    console.error('投稿一覧の取得に失敗:', e);
    // 形状エラーと枯渇は原因が特定できているので、汎用の文言に潰さずそのまま伝える
    if (
      e instanceof ApiShapeError ||
      e instanceof ResponseParseError ||
      e instanceof RateLimitExhaustedError ||
      e instanceof TransportExhaustedError
    ) {
      throw e;
    }
    // HttpError だけを汎用の文言に変換する。それ以外の想定外の例外
    // (abort、validator や内部処理のバグ等) まで丸めると、元の型・メッセージ・スタックが
    // 失われ、原因調査ができなくなる。他の経路 (getItemsByCreator 内の各 catch) で
    // 採用した陽性判定の方針とも矛盾する。
    if (!(e instanceof HttpError)) throw e;
    throw new Error('投稿一覧の取得に失敗しました');
  }

  let processed = 0;
  let totalEstimate = urls.length * 10;
  let addedPostCount = 0;
  const postFailures = emptyPostFailureCounts();
  let failedPageCount = 0;
  const counts = (): CreatorCollectCounts => ({ addedPostCount, postFailures, failedPageCount });

  for (let i = 0; i < urls.length; i++) {
    if (signal.aborted) return counts();
    if (!downloadManage.isLimitValid()) break;
    console.log(`${i + 1}回目`);

    // try は一覧ページ 1 回分の取得だけを囲む。以前は投稿ループ全体 (addByPostInfo や
    // onProgress 呼び出しを含む) までこの try に入っており、そこで発生した想定外の例外
    // (ライブラリのバグ、呼び出し元の onProgress のバグ等) まで「このページの一覧取得に
    // 失敗した」に丸めて failedPageCount++ に吸収し、収集を継続してしまっていた。
    // 一覧取得の失敗だけをここで捕まえ、それ以外は下の投稿ループ側の try (または
    // 未捕捉のまま) に委ねる。
    let postList: PostListItem[];
    try {
      postList = await api.fetchPostList(urls[i], signal);
    } catch (e) {
      if (signal.aborted) return counts();
      // 形状の不一致は「このページだけ落ちた」ではなく API 仕様変更なので、
      // 失敗件数に丸めず中断する。丸めると投稿ゼロの ZIP を「完了 (1件失敗)」として
      // 出してしまい、ユーザーが取得漏れに気付けない
      if (e instanceof ApiShapeError || e instanceof ResponseParseError) throw e;
      // 枯渇したらそこで打ち切るが、集計は返す。throw すると、それまでに
      // 数えた件数が呼び出し側に伝わらず、部分保存の可否も判断できない
      if (e instanceof RateLimitExhaustedError || e instanceof TransportExhaustedError) {
        return { ...counts(), stoppedBy: e };
      }
      // HttpError (2xx 以外の応答) だけをページ単位の失敗として数える。
      // それ以外の想定外の例外を握りつぶすと、こちらのバグが「一覧ページの取得に
      // 失敗した」として静かに握り潰され、部分 ZIP がそのまま保存されてしまう
      if (!(e instanceof HttpError)) throw e;
      console.error(`${i + 1}回目の投稿リスト取得に失敗:`, e);
      failedPageCount++;
      continue;
    }

    if (i === 0) {
      totalEstimate = urls.length * postList.length;
    }
    console.log(`投稿の数:${postList.length}`);

    // この try は投稿ループの中で再試行枠の枯渇 (RateLimitExhaustedError /
    // TransportExhaustedError) が起きた場合に限り、それまでの集計 (counts()) を失わずに
    // 打ち切り扱いへ変換するためのものである。それ以外 (ApiShapeError/ResponseParseError/
    // PostBodyInvalidError、および想定外の例外) はここで丸めず、catch の中で明示的に
    // 再送出して未捕捉のまま呼び出し元へ伝播させる。
    // 投稿単位の失敗 (HttpError) は下の内側の try で個別に処理して継続するので、
    // ここまで上がってくることはない。
    try {
      for (const post of postList) {
        if (signal.aborted) return counts();
        if (!downloadManage.isLimitValid()) break;
        // 閲覧できない投稿も ZIP からは欠落するので数える。数えないと、一覧が全件
        // isRestricted になったときに空の ZIP を「失敗 0 件で完了」として出してしまう。
        // isIgnoreFree で除外する無料投稿は利用者が意図した除外なので数えない。
        if (post.isRestricted) {
          if (!(downloadManage.isIgnoreFree && post.feeRequired === 0)) {
            postFailures.unavailable++;
            postFailures.unavailableRestricted++;
          }
          processed++;
          onProgress(processed, totalEstimate);
          continue;
        }
        // 一覧レスポンスに本文は含まれないため、投稿ごとに post.info を叩く必要がある
        try {
          const result = addByPostInfo(downloadManage, await api.fetchPostInfo(post.id, signal));
          if (applyAddResult(result, postFailures) === 'added') addedPostCount++;
        } catch (e) {
          if (signal.aborted) return counts();
          // レート制限の枯渇・形状/本文の不一致を投稿単位の失敗に丸めると、制限が続いている間
          // ずっと残りの投稿が 1 件ずつ順に失敗していく (レート制限)、または仕様変更を
          // 検知できないまま収集が続いてしまう (形状/本文の不一致)。ここで throw したものは
          // すぐ外側の try の catch (このブロックの外) が受け止める。
          if (
            e instanceof ApiShapeError ||
            e instanceof ResponseParseError ||
            e instanceof PostBodyInvalidError ||
            e instanceof RateLimitExhaustedError ||
            e instanceof TransportExhaustedError
          ) {
            throw e;
          }
          // HttpError だけを投稿単位の失敗として数える (理由は上のページ単位の分岐と同じ)
          if (!(e instanceof HttpError)) throw e;
          console.error(`投稿情報の取得に失敗 (postId: ${post.id}):`, e);
          postFailures.apiFailed++;
        }
        processed++;
        onProgress(processed, totalEstimate);
      }
    } catch (e) {
      if (signal.aborted) return counts();
      // 枯渇したらそこで打ち切るが、集計は返す。素通しすると、それまでに
      // 数えた件数が呼び出し側に伝わらず、部分保存の可否も判断できない。
      // レート制限と通信の枯渇を分けないのは、どちらも「上限まで待った末に諦めた」で
      // あって、それまでに取り込めた投稿の扱いは変わらないため
      if (e instanceof RateLimitExhaustedError || e instanceof TransportExhaustedError) {
        return { ...counts(), stoppedBy: e };
      }
      // ApiShapeError/ResponseParseError/PostBodyInvalidError (安全に取り込めない仕様変更) と、
      // 想定外の例外 (onProgress のバグ、addByPostInfo の未検証例外など) はどちらも
      // 「一覧ページの取得に失敗した」わけではないので、failedPageCount に丸めず素通しする
      throw e;
    }
  }
  return counts();
}
