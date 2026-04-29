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
        const chunks: string[] = [];
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
        }
        sendResponse({ ok: true, data: btoa(chunks.join('')) });
      })
      .catch(() => {
        sendResponse({ ok: false });
      });
    return true;
  }
  if (message.type === 'fetchApi') {
    fetch(message.url, { credentials: 'include' })
      .then(async (r) => {
        const retryAfter = r.headers.get('Retry-After');
        if (r.status === 429) {
          sendResponse({ ok: false, status: 429, retryAfter });
          return;
        }
        if (!r.ok) {
          sendResponse({ ok: false, status: r.status, retryAfter });
          return;
        }
        const body = await r.text();
        sendResponse({ ok: true, status: r.status, retryAfter, body });
      })
      .catch((e) => {
        sendResponse({ ok: false, status: 0, retryAfter: null, error: String(e) });
      });
    return true;
  }
});
