/**
 * service worker との messaging を AbortSignal 対応にするラッパー。
 *
 * chrome.runtime.sendMessage は AbortSignal を受け取らないため、service worker 側の
 * fetch が返らないと待ち続けてしまい、キャンセル操作が効かなくなる。
 * 送信済みのリクエスト自体は取り消せないが、呼び出し側を待たせないことはできる。
 */
export function sendMessageAbortable<T>(message: unknown, signal?: AbortSignal): Promise<T> {
  if (!signal) return chrome.runtime.sendMessage(message);
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    chrome.runtime.sendMessage(message).then(
      (value: T) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(reason);
      },
    );
  });
}
