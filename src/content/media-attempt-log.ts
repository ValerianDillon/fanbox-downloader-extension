import type { MediaFetchAttempt } from './downloader';

/**
 * ZIP フェーズのメディア取得の試行記録を chrome.storage.local に蓄積する (Issue #51 の観測用)。
 *
 * `console.info` への出力はページを閉じると消えるため、通常利用で 429 が出ているかを後から
 * 判断できない。制御方式を決める前に観測が要る (#18 の第 2 段階) ので、記録だけを残す。
 *
 * 記録はホスト名・ステータス・`Retry-After`・種別・時刻だけで、URL も投稿名も含めない。
 * 保存先はブラウザローカルの拡張ストレージのみで、どこにも送信しない。
 */

/** chrome.storage.local のキー。service worker の devtools コンソールから読む前提の固定名 */
export const MEDIA_ATTEMPT_STORAGE_KEY = 'fbdlMediaAttempts';

/**
 * 保持する試行記録の上限。超えたぶんは古い方から捨てる。
 * 1 件あたり 100 バイト程度なので 2000 件でも 200 KB 前後で、chrome.storage.local の
 * 既定容量 (10 MiB) を圧迫しない。
 */
export const MAX_STORED_ATTEMPTS = 2000;

/**
 * 書き込みの直列化キュー。「読む → 足す → 書く」の read-modify-write なので、
 * 直列化しないと並行する 2 つの保存が同じ現在値を読み、後から書いた方が前の記録を消す。
 * タブをまたぐ競合までは防げない (同じ storage を別プロセスが読み書きするため)。
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * 試行記録を追記する。
 *
 * 記録の失敗はダウンロードの失敗ではないので、例外を伝播させない。
 * 記録先が無い環境 (storage をスタブしないユニットテスト等) では何もしない。
 */
export function appendMediaAttempts(attempts: readonly MediaFetchAttempt[]): Promise<void> {
  if (attempts.length === 0) return Promise.resolve();
  const local = typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
  if (!local) return Promise.resolve();
  const task = queue
    .then(async () => {
      const stored = await local.get(MEDIA_ATTEMPT_STORAGE_KEY);
      const previous: unknown = stored[MEDIA_ATTEMPT_STORAGE_KEY];
      // 壊れた値が入っていても記録を止めない。観測の補助データなので、読めなければ作り直す方が
      // 「以後まったく記録されない」より損失が小さい
      const base = Array.isArray(previous) ? (previous as MediaFetchAttempt[]) : [];
      const next = base.concat(attempts).slice(-MAX_STORED_ATTEMPTS);
      await local.set({ [MEDIA_ATTEMPT_STORAGE_KEY]: next });
    })
    .catch((e: unknown) => {
      console.warn('メディア取得の試行記録を保存できませんでした:', e);
    });
  queue = task;
  return task;
}
