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

let lastRequestAt = 0;
let baseInterval = DEFAULT_API_RATE_LIMIT_MS;
let minInterval = DEFAULT_API_RATE_LIMIT_MS;
let backoffUntil = 0;

export function setApiRateLimitMs(ms: number): void {
  const clamped = Math.max(MIN_RATE_LIMIT_MS, Math.floor(ms));
  baseInterval = clamped;
  minInterval = clamped;
}

export function getApiRateLimitMs(): number {
  return minInterval;
}

export function resetApiRateLimitState(): void {
  lastRequestAt = 0;
  backoffUntil = 0;
  baseInterval = DEFAULT_API_RATE_LIMIT_MS;
  minInterval = DEFAULT_API_RATE_LIMIT_MS;
}

function escalateInterval(): number {
  const next = Math.min(
    ADAPTIVE_THROTTLE_CAP_MS,
    Math.max(baseInterval, Math.floor(minInterval * ADAPTIVE_THROTTLE_MULTIPLIER)),
  );
  if (next !== minInterval) {
    console.warn(`レート制限検知: API 間隔を ${minInterval}ms → ${next}ms に引き上げ`);
    minInterval = next;
  }
  return minInterval;
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

async function rateLimitGate(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const wait = Math.max(backoffUntil - now, lastRequestAt + minInterval - now, 0);
  if (wait > 0) await abortableSleep(wait, signal);
  lastRequestAt = Date.now();
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

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let networkRetried = false;
  for (let attempt = 0; ; attempt++) {
    await rateLimitGate(signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let response: ApiFetchResponse;
    try {
      response = await proxyFetchApi(url, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (networkRetried) throw e;
      networkRetried = true;
      console.warn(`ネットワーク失敗のためリトライ: ${url}`, e);
      await abortableSleep(NETWORK_RETRY_BACKOFF_MS, signal);
      continue;
    }
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.retryAfter);
      const waitMs = retryAfter ?? RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
      console.warn(`HTTP 429: ${url} → ${waitMs}ms 待機してリトライ (attempt ${attempt + 1})`);
      backoffUntil = Date.now() + waitMs;
      escalateInterval();
      if (attempt + 1 >= RETRY_BACKOFF_MS.length) {
        throw new Error(`HTTP 429: ${url} (リトライ上限到達)`);
      }
      await abortableSleep(waitMs, signal);
      continue;
    }
    if (!response.ok || response.body === undefined) {
      throw new Error(`HTTP ${response.status || 0}: ${url}${response.error ? ` (${response.error})` : ''}`);
    }
    return JSON.parse(response.body) as T;
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

export async function fetchPlans(creatorId: string, signal?: AbortSignal): Promise<PlanInfo[]> {
  const url = `https://api.fanbox.cc/plan.listCreator?creatorId=${creatorId}`;
  try {
    const result = await fetchJson<Plans>(url, signal);
    return unwrapArray<PlanInfo>(result?.body?.plans, url, isValidPlan);
  } catch (e) {
    if (signal?.aborted) throw e;
    // プラン名は支援額タグの表示名に使うだけなので、失敗しても収集自体は続行する
    console.error('プラン情報の取得に失敗:', e);
    return [];
  }
}

export async function fetchTags(creatorId: string, signal?: AbortSignal): Promise<string[]> {
  const url = `https://api.fanbox.cc/tag.getFeatured?creatorId=${creatorId}`;
  try {
    const result = await fetchJson<Tags>(url, signal);
    return unwrapArray<{ tag: string }>(
      result?.body?.featuredTags,
      url,
      (item) => typeof (item as { tag?: unknown } | null)?.tag === 'string',
    ).map((tag) => tag.tag);
  } catch (e) {
    if (signal?.aborted) throw e;
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
export async function fetchPostInfo(postId: string, signal?: AbortSignal): Promise<PostInfo> {
  const url = `https://api.fanbox.cc/post.info?postId=${postId}`;
  const result = await fetchJson<PostInfoResponse>(url, signal);
  const post = result?.body?.post;
  if (!post || typeof post.id !== 'string' || typeof post.type !== 'string' || typeof post.isRestricted !== 'boolean') {
    throw new ApiShapeError(url);
  }
  return post;
}

export async function fetchPaginatedPosts(creatorId: string, signal?: AbortSignal): Promise<string[]> {
  const url = `https://api.fanbox.cc/post.paginateCreator?creatorId=${creatorId}`;
  const result = await fetchJson<PaginatedPosts>(url, signal);
  return unwrapArray<string>(result?.body?.pageUrls, url, (item) => typeof item === 'string');
}

export async function fetchPostList(url: string, signal?: AbortSignal): Promise<PostListItem[]> {
  const result = await fetchJson<PostList>(url, signal);
  return unwrapArray<PostListItem>(result?.body?.posts, url, isValidPostListItem);
}

export { sleep };
