import type { Plans, PostInfo, Tags } from './types';

const API_RATE_LIMIT_MS = 100;

export type PageType =
  | { type: 'creator'; creatorId: string }
  | { type: 'post'; creatorId: string; postId: string }
  | null;

/**
 * URL から FANBOX ページの種類を判定する
 */
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchPlans(creatorId: string): Promise<Plans['body']> {
  try {
    const result = await fetchJson<Plans>(`https://api.fanbox.cc/plan.listCreator?creatorId=${creatorId}`);
    return result.body;
  } catch (e) {
    console.error('プラン情報の取得に失敗:', e);
    return undefined;
  }
}

export async function fetchTags(creatorId: string): Promise<string[]> {
  try {
    const result = await fetchJson<Tags>(`https://api.fanbox.cc/tag.getFeatured?creatorId=${creatorId}`);
    return Array.isArray(result.body) ? result.body.map((tag) => tag.tag) : [];
  } catch (e) {
    console.error('タグ情報の取得に失敗:', e);
    return [];
  }
}

export async function fetchPostInfo(postId: string): Promise<PostInfo | undefined> {
  try {
    const result = await fetchJson<{ body?: PostInfo }>(`https://api.fanbox.cc/post.info?postId=${postId}`);
    return result.body;
  } catch (e) {
    console.error(`投稿情報の取得に失敗 (postId: ${postId}):`, e);
    return undefined;
  }
}

export async function fetchPaginatedPosts(creatorId: string): Promise<string[]> {
  const result = await fetchJson<{ body: string[] }>(
    `https://api.fanbox.cc/post.paginateCreator?creatorId=${creatorId}`,
  );
  return result.body;
}

export async function fetchPostList(url: string): Promise<PostInfo[]> {
  const result = await fetchJson<{ body: PostInfo[] }>(url);
  return result.body;
}

export { API_RATE_LIMIT_MS, sleep };
