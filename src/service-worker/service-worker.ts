import { handleFetchApi, handleFetchMedia, handleGetBackoffUntil } from './handlers';

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
 * fetch (メディア取得) / fetchApi / getBackoffUntil の実処理は ./handlers.ts に切り出している
 * (chrome.* への配線とロジックを分け、後者をユニットテストから chrome のグローバルスタブなしに
 * 直接呼べるようにするため)。
 *
 * handleFetchMedia / handleFetchApi / handleGetBackoffUntil は内部の失敗を自ら吸収して必ず
 * 応答オブジェクトを返す (total な関数) 設計にしているが、ここでも `.catch` で二重に防御する。
 * どちらかが想定外に reject すると sendResponse が呼ばれず、content script は応答なしで
 * 待ち続けてしまう (chrome.runtime.sendMessage はタイムアウトしない) ため。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'fetch') {
    handleFetchMedia(message.url)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, status: 0, retryAfter: null, error: String(e) }));
    return true;
  }
  if (message.type === 'fetchApi') {
    handleFetchApi(message.url)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, status: 0, retryAfter: null, error: String(e), backoffUntil: 0 }));
    return true;
  }
  if (message.type === 'getBackoffUntil') {
    handleGetBackoffUntil()
      .then(sendResponse)
      .catch(() => sendResponse({ backoffUntil: 0 }));
    return true;
  }
});
