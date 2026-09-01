/**
 * service worker との messaging を AbortSignal 対応にするラッパー。
 *
 * chrome.runtime.sendMessage は AbortSignal を受け取らないため、service worker 側の
 * fetch が返らないと待ち続けてしまい、キャンセル操作が効かなくなる。
 * 送信済みのリクエスト自体は取り消せないが、呼び出し側を待たせないことはできる。
 */
export function sendMessageAbortable<T>(message: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  if (!signal && timeoutMs === undefined) return chrome.runtime.sendMessage(message);
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const onTimeout = () => {
      cleanup();
      reject(new DOMException(`service worker が ${timeoutMs}ms 以内に応答しませんでした`, 'TimeoutError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) timeoutId = setTimeout(onTimeout, timeoutMs);
    chrome.runtime.sendMessage(message).then(
      (value: T) => {
        cleanup();
        resolve(value);
      },
      (reason: unknown) => {
        cleanup();
        reject(reason);
      },
    );
  });
}
