import { MEDIA_PORT_NAME, type MediaStreamRequest } from '../media-stream-protocol';
import { handleFetchApi } from './handlers';
import { streamMedia } from './media-stream';
import { trackMediaStreamForTest, wrapMediaStreamDepsForTest } from './test-hooks';

chrome.runtime.onInstalled.addListener(() => {
  console.log('FANBOX Downloader installed');
});

/**
 * content script からの fetch プロキシ要求を処理する
 *
 * Manifest V3 では content script の fetch はページのオリジンとして扱われるため、
 * - downloads.fanbox.cc / *.pximg.net への fetch は CORS でブロックされる
 * - api.fanbox.cc の 429 レスポンスは CORS ヘッダが無く、JS が status / Retry-After を読めない
 *
 * service worker は拡張のオリジンで動作し host_permissions が適用されるため、これらを回避できる。
 *
 * fetchApi の実処理は ./handlers.ts に、メディア取得 (Port による分割転送) の実処理は
 * ./media-stream.ts に切り出している (chrome.* への配線とロジックを分け、後者をユニットテストから
 * chrome のグローバルスタブなしに直接呼べるようにするため)。
 *
 * handleFetchApi は内部の失敗を自ら吸収して必ず応答オブジェクトを返す (total な関数)
 * 設計にしているが、ここでも `.catch` で二重に防御する。
 * 想定外に reject すると sendResponse が呼ばれず、content script は応答なしで
 * 待ち続けてしまう (chrome.runtime.sendMessage はタイムアウトしない) ため。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'fetchApi') {
    handleFetchApi(message.url)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, status: 0, retryAfter: null, error: String(e), backoffUntil: 0 }));
    return true;
  }
});

/**
 * メディア取得 (downloads.fanbox.cc / *.pximg.net) の分割転送 (Issue #22)。
 *
 * 単発メッセージの応答に本文全体を載せる方式は runtime messaging の 64 MiB 上限に当たるため、
 * content script が Port を張り、`start` 要求に対して本文を chunk に分けて流す。プロトコルの詳細は
 * src/media-stream-protocol.ts、処理本体は ./media-stream.ts を参照。
 *
 * 1 Port につき `start` は 1 回だけ受け付ける。2 回目以降の要求は無視する (再開・再試行は content script が
 * 新しい Port を張って行う契約のため)。名前が一致しない Port は他用途のものなので触らない。
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== MEDIA_PORT_NAME) return;
  let started = false;
  port.onMessage.addListener((message: unknown) => {
    if (started) return;
    if (!isMediaStreamRequest(message)) return;
    started = true;
    const deps = wrapMediaStreamDepsForTest(port, message.url, { fetch: (input, init) => fetch(input, init) });
    void trackMediaStreamForTest(port, () => streamMedia(port, message, deps));
  });
});

function isMediaStreamRequest(message: unknown): message is MediaStreamRequest {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  return m.type === 'start' && typeof m.url === 'string' && typeof m.offset === 'number' && m.offset >= 0;
}
