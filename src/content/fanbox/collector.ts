import type { DownloadObject } from 'download-helper/download-helper';
import { addByPostInfo, DownloadManage, type PostInfo } from 'download-helper/fanbox-collector';
import {
  ApiShapeError,
  DEFAULT_API_RATE_LIMIT_MS,
  fetchPaginatedPosts,
  fetchPlans,
  fetchPostInfo,
  fetchPostList,
  fetchTags,
  setApiRateLimitMs,
} from './api';

export type CollectorSettings = {
  isIgnoreFree: boolean;
  limit: number | null;
  apiIntervalMs: number | null;
};

export type CollectResult = {
  downloadObject: DownloadObject;
  failedPostCount: number;
};

export type ProgressCallback = (current: number, total: number) => void;

/**
 * 本文を持たない投稿を収集対象に加える。追加できたかを返す。
 *
 * addByPostInfo は本文のない投稿を「支援がたりない」とみなして黙って読み飛ばすため、
 * そのまま任せると本文の在り処が変わったときに全投稿が無言で消え、空の ZIP が
 * 「完了」として出てしまう。ここで数えておけば、支援額不足で実際に取れなかった場合も
 * 含めて「N 件の投稿が失敗した」とユーザーに伝わる。
 */
function addPost(downloadManage: DownloadManage, postInfo: PostInfo): boolean {
  if (!postInfo.body) return false;
  addByPostInfo(downloadManage, postInfo);
  return true;
}

export async function collect(
  creatorId: string,
  postId: string | undefined,
  settings: CollectorSettings,
  onProgress: ProgressCallback,
  signal: AbortSignal,
): Promise<CollectResult> {
  setApiRateLimitMs(settings.apiIntervalMs ?? DEFAULT_API_RATE_LIMIT_MS);

  const plans = await fetchPlans(creatorId, signal);
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

  const definedTags = await fetchTags(creatorId, signal);
  downloadManage.addTags(...definedTags);

  let failedPostCount = 0;
  if (postId) {
    onProgress(0, 1);
    try {
      if (!addPost(downloadManage, await fetchPostInfo(postId, signal))) {
        failedPostCount++;
      }
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof ApiShapeError) throw e;
      console.error(`投稿情報の取得に失敗 (postId: ${postId}):`, e);
      failedPostCount++;
    }
    onProgress(1, 1);
  } else {
    failedPostCount = await getItemsByCreator(downloadManage, onProgress, signal);
  }

  downloadManage.applyTags();
  return { downloadObject: downloadManage.downloadObject, failedPostCount };
}

async function getItemsByCreator(
  downloadManage: DownloadManage,
  onProgress: ProgressCallback,
  signal: AbortSignal,
): Promise<number> {
  let urls: string[];
  try {
    urls = await fetchPaginatedPosts(downloadManage.userId, signal);
  } catch (e) {
    console.error('投稿一覧の取得に失敗:', e);
    // 形状エラーは仕様変更を示すので、汎用の文言に潰さずそのまま伝える
    if (e instanceof ApiShapeError) throw e;
    throw new Error('投稿一覧の取得に失敗しました');
  }

  let processed = 0;
  let totalEstimate = urls.length * 10;
  let failedPostCount = 0;

  for (let i = 0; i < urls.length; i++) {
    if (signal.aborted) return failedPostCount;
    if (!downloadManage.isLimitValid()) break;
    console.log(`${i + 1}回目`);
    try {
      const postList = await fetchPostList(urls[i], signal);
      if (i === 0) {
        totalEstimate = urls.length * postList.length;
      }
      console.log(`投稿の数:${postList.length}`);
      for (const post of postList) {
        if (signal.aborted) return failedPostCount;
        if (!downloadManage.isLimitValid()) break;
        // 一覧レスポンスに本文は含まれないため、投稿ごとに post.info を叩く必要がある
        if (!post.isRestricted) {
          try {
            if (!addPost(downloadManage, await fetchPostInfo(post.id, signal))) {
              failedPostCount++;
            }
          } catch (e) {
            if (signal.aborted) return failedPostCount;
            if (e instanceof ApiShapeError) throw e;
            console.error(`投稿情報の取得に失敗 (postId: ${post.id}):`, e);
            failedPostCount++;
          }
        }
        processed++;
        onProgress(processed, totalEstimate);
      }
    } catch (e) {
      if (signal.aborted) return failedPostCount;
      // 形状の不一致は「このページだけ落ちた」ではなく API 仕様変更なので、
      // 失敗件数に丸めず中断する。丸めると投稿ゼロの ZIP を「完了 (1件失敗)」として
      // 出してしまい、ユーザーが取得漏れに気付けない。
      if (e instanceof ApiShapeError) throw e;
      console.error(`${i + 1}回目の投稿リスト取得に失敗:`, e);
      failedPostCount++;
    }
  }
  return failedPostCount;
}
