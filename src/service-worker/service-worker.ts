import { uint8ArrayToBase64 } from '../base64';
import { handleFetchApi, handleGetBackoffUntil } from './handlers';

chrome.runtime.onInstalled.addListener(() => {
  console.log('FANBOX Downloader installed');
});

/**
 * content script からの fetch プロキシ要求を処理する
 *
 * Manifest V3 では content script の fetch はページのオリジンとして扱われるため、
 * - downloads.fanbox.cc への fetch は CORS でブロックされる
 * - api.fanbox.cc の 429 レスポンスは CORS ヘッダが無く、JS が status / Retry-After を読めない
 *
 * service worker は拡張のオリジンで動作し host_permissions が適用されるため、これらを回避できる。
 *
 * fetchApi / getBackoffUntil の実処理は ./handlers.ts に切り出している (chrome.* への配線と
 * ロジックを分け、後者をユニットテストから chrome のグローバルスタブなしに直接呼べるようにするため)。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'fetch') {
    fetch(message.url, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) return null;
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (!buf) {
          sendResponse({ ok: false });
          return;
        }
        // ArrayBuffer → base64 (messaging 経由で転送するため)
        const bytes = new Uint8Array(buf);
        sendResponse({ ok: true, data: uint8ArrayToBase64(bytes) });
      })
      .catch(() => {
        sendResponse({ ok: false });
      });
    return true;
  }
  if (message.type === 'fetchApi') {
    handleFetchApi(message.url).then(sendResponse);
    return true;
  }
  if (message.type === 'getBackoffUntil') {
    handleGetBackoffUntil().then(sendResponse);
    return true;
  }
});
