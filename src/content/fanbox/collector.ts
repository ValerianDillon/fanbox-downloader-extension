import type { DownloadObject } from 'download-helper/download-helper';
import { type AddPostResult, addByPostInfo, DownloadManage } from 'download-helper/fanbox-collector';
import { ApiSession, ApiShapeError, DEFAULT_API_RATE_LIMIT_MS, RateLimitExhaustedError } from './api';

export type CollectorSettings = {
  isIgnoreFree: boolean;
  limit: number | null;
  apiIntervalMs: number | null;
};

export type CollectResult = {
  downloadObject: DownloadObject;
  failedPostCount: number;
  /**
   * 取得できなかった投稿一覧ページの数。
   * 1 ページ落ちると複数投稿が欠落するので、投稿単位の失敗件数とは足し合わせない。
   */
  failedPageCount: number;
  /**
   * 収集を最後まで走査せずに打ち切った理由。未設定なら全ページを走査した。
   * 打ち切った場合もそこまでに集めた分は捨てず、不完全と明示したうえで保存できるようにする。
   */
  stoppedReason?: 'rate-limit-exhausted';
};

export type ProgressCallback = (current: number, total: number) => void;

/**
 * 取り込めなかった投稿を失敗として数えるかを判定する。
 *
 * isIgnoreFree による無料投稿の除外は利用者が意図した設定なので数えない。
 * 本文が取れなかった投稿は、支援額不足という正常な理由でも数える: 黙って落とすと
 * 本文の在り処が変わって全投稿が消えたときに、空の ZIP が「完了」として出てしまう。
 */
function isFailure(result: AddPostResult): boolean {
  return result === 'unavailable' || result === 'invalid';
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

  let failedPostCount = 0;
  let failedPageCount = 0;
  let stoppedReason: CollectResult['stoppedReason'];
  if (postId) {
    onProgress(0, 1);
    try {
      if (isFailure(addByPostInfo(downloadManage, await api.fetchPostInfo(postId, signal)))) {
        failedPostCount++;
      }
    } catch (e) {
      if (signal.aborted) throw e;
      // 単一投稿モードで枯渇したなら取り込めたものは無いので、打ち切りではなくエラーにする
      if (e instanceof ApiShapeError || e instanceof RateLimitExhaustedError) throw e;
      console.error(`投稿情報の取得に失敗 (postId: ${postId}):`, e);
      failedPostCount++;
    }
    onProgress(1, 1);
  } else {
    const collected = await getItemsByCreator(api, downloadManage, onProgress, signal);
    failedPostCount = collected.failedPostCount;
    failedPageCount = collected.failedPageCount;
    if (collected.stoppedBy) {
      // 1 件も取り込めていないなら「取得できた分」が無い。打ち切りとして返すと
      // 中身のない ZIP を「取得できた分のみ保存しています」と表示して出してしまう。
      // 判定は失敗件数ではなく取り込めた件数で行う: 最初の投稿やページで枯渇した場合は
      // 失敗件数も 0 のままなので、失敗件数では区別できない
      if (collected.addedPostCount === 0) throw collected.stoppedBy;
      console.error('レート制限のため収集を打ち切りました:', collected.stoppedBy);
      stoppedReason = 'rate-limit-exhausted';
    }
  }

  downloadManage.applyTags();
  return { downloadObject: downloadManage.downloadObject, failedPostCount, failedPageCount, stoppedReason };
}

type CreatorCollectCounts = {
  failedPostCount: number;
  failedPageCount: number;
  /** 実際に取り込めた投稿の数。打ち切りを「部分保存」として扱ってよいかの判断に使う */
  addedPostCount: number;
  /** レート制限の枯渇で全ページを走査せずに打ち切った場合、その原因 */
  stoppedBy?: RateLimitExhaustedError;
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
    if (e instanceof ApiShapeError || e instanceof RateLimitExhaustedError) throw e;
    throw new Error('投稿一覧の取得に失敗しました');
  }

  let processed = 0;
  let totalEstimate = urls.length * 10;
  let failedPostCount = 0;
  let failedPageCount = 0;
  let addedPostCount = 0;
  const counts = (): CreatorCollectCounts => ({ failedPostCount, failedPageCount, addedPostCount });

  for (let i = 0; i < urls.length; i++) {
    if (signal.aborted) return counts();
    if (!downloadManage.isLimitValid()) break;
    console.log(`${i + 1}回目`);
    try {
      const postList = await api.fetchPostList(urls[i], signal);
      if (i === 0) {
        totalEstimate = urls.length * postList.length;
      }
      console.log(`投稿の数:${postList.length}`);
      for (const post of postList) {
        if (signal.aborted) return counts();
        if (!downloadManage.isLimitValid()) break;
        // 閲覧できない投稿も ZIP からは欠落するので数える。数えないと、一覧が全件
        // isRestricted になったときに空の ZIP を「失敗 0 件で完了」として出してしまう。
        // isIgnoreFree で除外する無料投稿は利用者が意図した除外なので数えない。
        if (post.isRestricted) {
          if (!(downloadManage.isIgnoreFree && post.feeRequired === 0)) failedPostCount++;
          processed++;
          onProgress(processed, totalEstimate);
          continue;
        }
        // 一覧レスポンスに本文は含まれないため、投稿ごとに post.info を叩く必要がある
        try {
          const result = addByPostInfo(downloadManage, await api.fetchPostInfo(post.id, signal));
          if (result === 'added') addedPostCount++;
          if (isFailure(result)) failedPostCount++;
        } catch (e) {
          if (signal.aborted) return counts();
          // レート制限の枯渇を投稿単位の失敗に丸めると、制限が続いている間ずっと
          // 残りの投稿が 1 件ずつ順に失敗していく
          if (e instanceof ApiShapeError || e instanceof RateLimitExhaustedError) throw e;
          console.error(`投稿情報の取得に失敗 (postId: ${post.id}):`, e);
          failedPostCount++;
        }
        processed++;
        onProgress(processed, totalEstimate);
      }
    } catch (e) {
      if (signal.aborted) return counts();
      // 形状の不一致は「このページだけ落ちた」ではなく API 仕様変更なので、
      // 失敗件数に丸めず中断する。丸めると投稿ゼロの ZIP を「完了 (1件失敗)」として
      // 出してしまい、ユーザーが取得漏れに気付けない。
      if (e instanceof ApiShapeError) throw e;
      // 枯渇したらそこで打ち切るが、集計は返す。throw すると、それまでに
      // 数えた件数が呼び出し側に伝わらず、部分保存の可否も判断できない
      if (e instanceof RateLimitExhaustedError) {
        return { ...counts(), stoppedBy: e };
      }
      // 1 ページには複数の投稿が載るため、欠落数は不明。投稿 1 件の失敗として
      // 数えると実際の欠落を過少報告するので、ページ単位で別に数える。
      console.error(`${i + 1}回目の投稿リスト取得に失敗:`, e);
      failedPageCount++;
    }
  }
  return counts();
}
