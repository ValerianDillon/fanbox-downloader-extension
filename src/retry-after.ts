/**
 * Retry-After ヘッダの値をミリ秒に変換する。秒数指定と HTTP-date 指定のどちらの形式にも対応する。
 *
 * service worker (バックオフ期限の記録, src/service-worker/service-worker.ts) と
 * content script (再試行までの待機時間の算出, src/content/fanbox/api.ts) の両方から使うため
 * 共有モジュールに切り出している。
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}
