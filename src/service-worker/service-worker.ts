chrome.runtime.onInstalled.addListener(() => {
  console.log('FANBOX Downloader installed');
});

/**
 * content script からの fetch プロキシ要求を処理する
 * Manifest V3 では content script の fetch はページのオリジンとして扱われるため、
 * downloads.fanbox.cc への fetch が CORS でブロックされる。
 * service worker は拡張のオリジンで動作し host_permissions が適用されるため CORS を回避できる。
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
    return true; // 非同期レスポンスを返すことを示す
  }
});
