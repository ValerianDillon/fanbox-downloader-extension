import type { DownloadObject } from 'download-helper/download-helper';
import { addByPostInfo, DownloadManage } from 'download-helper/fanbox-collector';
import {
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
  if (plans) {
    for (const plan of plans) {
      feeMapper.set(plan.fee, plan.title);
    }
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
      const postInfo = await fetchPostInfo(postId, signal);
      addByPostInfo(downloadManage, postInfo);
    } catch (e) {
      if (signal.aborted) throw e;
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
        if (post.body) {
          addByPostInfo(downloadManage, post);
        } else if (!post.isRestricted) {
          try {
            const postInfo = await fetchPostInfo(post.id, signal);
            if (postInfo) {
              addByPostInfo(downloadManage, postInfo);
            } else {
              failedPostCount++;
            }
          } catch (e) {
            if (signal.aborted) return failedPostCount;
            console.error(`投稿情報の取得に失敗 (postId: ${post.id}):`, e);
            failedPostCount++;
          }
        }
        processed++;
        onProgress(processed, totalEstimate);
      }
    } catch (e) {
      if (signal.aborted) return failedPostCount;
      console.error(`${i + 1}回目の投稿リスト取得に失敗:`, e);
      failedPostCount++;
    }
  }
  return failedPostCount;
}
