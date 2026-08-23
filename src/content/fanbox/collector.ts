import type { DownloadObject } from 'download-helper/download-helper';
import {
  type AddPostResult,
  addByPostInfo,
  DownloadManage,
  type PostListItemCandidate,
} from 'download-helper/fanbox-collector';

import type { CreatorHistory } from '../../history-record';
import { canSkipPostInfo, prepareHistoryPlan } from '../history-plan';
import {
  ApiSession,
  ApiShapeError,
  DEFAULT_API_RATE_LIMIT_MS,
  decodeListedUpdatedDatetime,
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
  /**
   * 一覧が返した `updatedDatetime` (postId → 検証済みの値、読めなければ null)。
   *
   * 差分判定にしか使わない最適化の情報である (Issue #56)。一覧に現れた投稿はすべて入る
   * (取り込めなかった投稿も含む) — 次回この値と突き合わせるのは一覧の走査だけで済ませたいため。
   */
  listedRevisions: ReadonlyMap<string, string | null>;
  /**
   * 履歴を根拠に `post.info` を省いた投稿 (Issue #56)。
   *
   * 取りこぼしではないので失敗には数えない。今回の ZIP には含まれない (差分 ZIP は
   * 独立した追加バッチであって、展開先に適用するパッチではない)。
   */
  skippedByHistoryPostIds: ReadonlySet<string>;
  /**
   * `post.info` の取得が HttpError で終わった投稿。
   * 「前回失敗した分だけ再試行する」の対象になる。件数ではなく集合で持つ理由は
   * `PostFailureCounts.apiFailed` のコメントを参照。
   */
  apiFailedPostIds: ReadonlySet<string>;
  /**
   * 収集を終えた時刻 (epoch ms)。
   *
   * 履歴に載せる観測時刻はこれを使う。保存時刻で代用すると、review 画面での選択に時間を
   * かけただけで観測が新しく見え、遅れて保存した古い観測が新しい観測を上書きしうる。
   */
  collectedAt: number;
  /** creator 全体の走査だったか。単一投稿モードなら false で、走査実績を記録してはいけない */
  scannedCreator: boolean;
  /** 投稿一覧の全ページを走査し終えたか。打ち切り・件数上限・中断で止まっていれば false */
  completedFullScan: boolean;
  /**
   * 件数の上限に達して一覧の走査を打ち切ったか。
   *
   * 「上限を設定したか」ではない。設定しても達しなければ一覧は全部見ているので、
   * 一覧から消えた投稿の判断材料としては完走と変わらない。
   */
  limited: boolean;
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

/**
 * 投稿を収集する。
 * @param creatorId 対象の creator
 * @param postId 指定すると単一投稿モードになる
 * @param settings 収集の設定
 * @param onProgress 進捗の通知
 * @param signal 中断
 * @param history 差分ダウンロードの履歴。`null` を渡すと全件を取得する (Issue #56)
 */
/**
 * 一覧要素のうち、`post.info` を発行せずに結果を決めるのに使う値をまとめた指紋。
 *
 * 同じ投稿が一覧に 2 回現れたとき、この指紋が変わっていれば走査の途中で投稿が変わっている。
 * `updatedDatetime` だけを見ると、公開範囲や料金だけが変わった場合を取りこぼす。
 */
function listFingerprint(revision: string | null, post: PostListItemCandidate): string {
  return JSON.stringify([revision, post.feeRequired, post.isRestricted]);
}

export async function collect(
  creatorId: string,
  postId: string | undefined,
  settings: CollectorSettings,
  onProgress: ProgressCallback,
  signal: AbortSignal,
  history?: CreatorHistory | null,
): Promise<CollectResult> {
  // レート制限の状態は収集ごとに持つ。前回引き上がった間隔を次の収集に持ち越さない
  const api = new ApiSession(settings.apiIntervalMs ?? DEFAULT_API_RATE_LIMIT_MS);

  // 別タブや直前のリロードで service worker 側に記録が残っていても、ここで明示的に
  // 事前取得する必要はない。最初のリクエストは service worker 側のゲートに弾かれ、
  // その応答に乗る期限を学習して待ち直す (最初のリクエストも含めて守られる)。

  const plans = await api.fetchPlans(creatorId, signal);
  const feeMapper = new Map<number, string>();
  for (const plan of plans) {
    feeMapper.set(plan.fee, plan.title);
  }
  // archive path は postId 由来で採番する。従来の採番は同名グループの件数に依存するため、
  // 同名の投稿やアセットが増減すると過去に割り当てた名前まで変わり、複数の ZIP をまたいで
  // 同じ投稿を同定できない (Issue #56)。
  // 履歴があれば過去に割り当てた名前を据え置く。凍結名を使えなければ履歴ごと無いものとして扱う
  const plan = prepareHistoryPlan(DownloadManage.utils, history ?? null);
  const downloadManage = new DownloadManage(creatorId, feeMapper, plan.allocator);
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
  let listedRevisions: ReadonlyMap<string, string | null> = new Map();
  let apiFailedPostIds: ReadonlySet<string> = new Set();
  let skippedByHistoryPostIds: ReadonlySet<string> = new Set();
  let completedFullScan = false;
  let limited = false;
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
    const collected = await getItemsByCreator(api, downloadManage, onProgress, signal, plan.history);
    addedPostCount = collected.addedPostCount;
    postFailures = collected.postFailures;
    failedPageCount = collected.failedPageCount;
    listedRevisions = collected.listedRevisions;
    apiFailedPostIds = collected.apiFailedPostIds;
    skippedByHistoryPostIds = collected.skippedByHistoryPostIds;
    completedFullScan = collected.completedFullScan;
    limited = collected.limited;
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
    listedRevisions,
    apiFailedPostIds,
    skippedByHistoryPostIds,
    collectedAt: Date.now(),
    scannedCreator: postId === undefined,
    // 打ち切りは「一覧を全部見た」を否定する。件数上限は getItemsByCreator が
    // 走査の打ち切りとして既に反映している。走査実績の整合性 (完走したなら打ち切りも
    // 取りこぼしも無い) は履歴側の復号が検査する
    completedFullScan: completedFullScan && stoppedReason === undefined,
    limited,
  };
}

type CreatorCollectCounts = {
  addedPostCount: number;
  postFailures: PostFailureCounts;
  failedPageCount: number;
  listedRevisions: ReadonlyMap<string, string | null>;
  apiFailedPostIds: ReadonlySet<string>;
  skippedByHistoryPostIds: ReadonlySet<string>;
  /** 投稿一覧の全ページを走査し終えたか */
  completedFullScan: boolean;
  /** 件数の上限に達して打ち切ったか */
  limited: boolean;
  /** 再試行枠の枯渇 (レート制限または通信) で全ページを走査せずに打ち切った場合、その原因 */
  stoppedBy?: RateLimitExhaustedError | TransportExhaustedError;
};

async function getItemsByCreator(
  api: ApiSession,
  downloadManage: DownloadManage,
  onProgress: ProgressCallback,
  signal: AbortSignal,
  history: CreatorHistory | null,
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
  // 一覧ページの重複などで同じ投稿が 2 回来ることがある。archive path は postId 由来なので
  // 2 回登録すると投稿ディレクトリ名が重複し、共有層の preflight が ZIP 全体を拒否する
  // (従来の採番は同名グループとして採番し直していたので保存できていた)。
  // 併せて post.info の発行も 1 回で済む (レート制限の枠と待機時間を使わない)
  const seenPostIds = new Set<string>();
  const postFailures = emptyPostFailureCounts();
  let failedPageCount = 0;
  // apiFailed は件数ではなく postId の集合で持つ。一覧の重複で同じ投稿を 2 回試みたとき、
  // 件数で数えると 1 つの投稿が 2 件の失敗になる。再試行で取り込めたら集合から外す
  const apiFailedPostIds = new Set<string>();
  // 一覧が返した updatedDatetime。取り込めなかった投稿も含めて記録する (Issue #56)
  const listedRevisions = new Map<string, string | null>();
  // 履歴を根拠に post.info を省いた投稿。取りこぼしではないので失敗には数えない
  const skippedByHistoryPostIds = new Set<string>();
  // 一覧要素の内容 (突き合わせに使う 3 つ)。重複要素で食い違ったかの判定に使う
  const listFingerprints = new Map<string, string>();
  // post.info を発行せずに一覧の情報だけで決めた結果。食い違う重複が来たら取り消す
  const listOnlyDecisions = new Map<string, 'ignored-free' | 'restricted' | 'history-skipped'>();

  /**
   * 一覧の情報だけで決めた結果を取り消し、この要素で改めて判断させる。
   * 数えた失敗も戻す — 戻さないと、閲覧できるようになった投稿が「閲覧できなかった」件数に残る。
   */
  const undoListOnlyDecision = (postId: string) => {
    const decision = listOnlyDecisions.get(postId);
    if (decision === undefined) return;
    listOnlyDecisions.delete(postId);
    seenPostIds.delete(postId);
    if (decision === 'restricted') {
      postFailures.unavailable--;
      postFailures.unavailableRestricted--;
    } else if (decision === 'history-skipped') {
      skippedByHistoryPostIds.delete(postId);
    }
  };
  let scannedAllPages = false;
  let stoppedByLimit = false;
  const counts = (): CreatorCollectCounts => ({
    addedPostCount,
    postFailures: { ...postFailures, apiFailed: apiFailedPostIds.size },
    failedPageCount,
    listedRevisions,
    apiFailedPostIds,
    skippedByHistoryPostIds,
    // 取得に失敗したページがあれば、走査し切っていても一覧を全部見たとは言えない
    // (そのページに載っていた投稿が丸ごと欠けている)
    completedFullScan: scannedAllPages && failedPageCount === 0,
    limited: stoppedByLimit,
  });

  for (let i = 0; i < urls.length; i++) {
    if (signal.aborted) return counts();
    // 件数上限で止めた場合は全ページを走査していない。break だとループ後の
    // 「完走した」に落ちてしまうので、ここで返す (ループ後の return と同じ値)
    if (!downloadManage.isLimitValid()) {
      stoppedByLimit = true;
      return counts();
    }
    console.log(`${i + 1}回目`);

    // try は一覧ページ 1 回分の取得だけを囲む。以前は投稿ループ全体 (addByPostInfo や
    // onProgress 呼び出しを含む) までこの try に入っており、そこで発生した想定外の例外
    // (ライブラリのバグ、呼び出し元の onProgress のバグ等) まで「このページの一覧取得に
    // 失敗した」に丸めて failedPageCount++ に吸収し、収集を継続してしまっていた。
    // 一覧取得の失敗だけをここで捕まえ、それ以外は下の投稿ループ側の try (または
    // 未捕捉のまま) に委ねる。
    let postList: PostListItemCandidate[];
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
        // 同じ投稿が一覧に 2 回来ても最初の値を採る。後勝ちにすると、同じ入力への結果が
        // 一覧の並びに依存する。
        // **ただし一覧の情報が食い違ったら、先の要素だけで決めた結果を取り消す。**
        // 走査の途中で編集や公開範囲の変更があると、ページをまたいで別の値が現れうる。
        // 先に見た情報で「省略」「無料なので除外」「閲覧不可」と決めてしまうと、
        // 現在は取得すべき投稿が取得されないまま落ちる
        const listedRevision = decodeListedUpdatedDatetime(post);
        const fingerprint = listFingerprint(listedRevision, post);
        const knownFingerprint = listFingerprints.get(post.id);
        if (knownFingerprint === undefined) {
          listFingerprints.set(post.id, fingerprint);
          listedRevisions.set(post.id, listedRevision);
        } else if (knownFingerprint !== fingerprint) {
          listFingerprints.set(post.id, fingerprint);
          // どちらの値が現在のものか決められないので、突き合わせには使わせない
          listedRevisions.set(post.id, null);
          undoListOnlyDecision(post.id);
        }
        // ページの途中で上限に達した場合も一覧を全部見ていない。break だと最終ページでは
        // 外側のループが正常終了し、「完走した」に落ちてしまう
        if (!downloadManage.isLimitValid()) {
          stoppedByLimit = true;
          return counts();
        }
        // 既に結果の出た投稿は失敗にも成功にも数えない。利用者から見て取りこぼしではない。
        // 進捗だけは進める (除外・閲覧不可・取得失敗でも進めているので、揃えないと
        // 重複を含む一覧で進捗が最後まで届かない)。
        // 取得に失敗した投稿はここに入れない。重複側で取り直せる可能性を残す
        if (seenPostIds.has(post.id)) {
          processed++;
          onProgress(processed, totalEstimate);
          continue;
        }
        // isIgnoreFree で除外する無料投稿は利用者が意図した除外なので数えない。
        // 一覧の時点で除外して post.info を発行しない: 発行しても addByPostInfo が同じ条件で
        // 'ignored' を返すだけで、レート制限の枠と待機時間を無駄に使う
        if (downloadManage.isIgnoreFree && post.feeRequired === 0) {
          seenPostIds.add(post.id);
          listOnlyDecisions.set(post.id, 'ignored-free');
          apiFailedPostIds.delete(post.id);
          processed++;
          onProgress(processed, totalEstimate);
          continue;
        }
        // 閲覧できない投稿も ZIP からは欠落するので数える。数えないと、一覧が全件
        // isRestricted になったときに空の ZIP を「失敗 0 件で完了」として出してしまう。
        if (post.isRestricted) {
          seenPostIds.add(post.id);
          listOnlyDecisions.set(post.id, 'restricted');
          apiFailedPostIds.delete(post.id);
          postFailures.unavailable++;
          postFailures.unavailableRestricted++;
          processed++;
          onProgress(processed, totalEstimate);
          continue;
        }
        // 前回と変わっておらず、全アセットを保存できている投稿は post.info を発行しない。
        // これが Issue #56 で実際に API コストを減らす箇所である。省いた投稿は
        // DownloadObject に入らないので、今回の ZIP にも含まれない (差分 ZIP の意味論)
        if (canSkipPostInfo(history, post.id, listedRevisions.get(post.id) ?? null)) {
          seenPostIds.add(post.id);
          listOnlyDecisions.set(post.id, 'history-skipped');
          apiFailedPostIds.delete(post.id);
          skippedByHistoryPostIds.add(post.id);
          processed++;
          onProgress(processed, totalEstimate);
          continue;
        }
        // 一覧レスポンスに本文は含まれないため、投稿ごとに post.info を叩く必要がある
        try {
          const result = addByPostInfo(downloadManage, await api.fetchPostInfo(post.id, signal));
          // 結果が出たので、以降の重複はもう叩かない。取り直せたなら失敗の記録も取り消す
          seenPostIds.add(post.id);
          // post.info まで発行した結果は一覧情報だけの決定ではないので取り消さない。
          // 取り消して 2 回登録すると投稿ディレクトリ名が重複し、preflight が ZIP 全体を拒否する
          listOnlyDecisions.delete(post.id);
          apiFailedPostIds.delete(post.id);
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
          apiFailedPostIds.add(post.id);
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
  // for を最後まで回り切った場合だけここに来る (中断・件数上限・枯渇は早期 return する)
  scannedAllPages = true;
  return counts();
}
