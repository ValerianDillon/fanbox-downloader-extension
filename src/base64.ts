/**
 * Uint8Array → base64 文字列のエンコード。
 *
 * `String.fromCharCode(...bytes)` は引数個数に上限があるため、チャンク分割して結合する。
 * content script 側 (`src/content/test-hooks.ts`) と service worker 側
 * (`src/service-worker/service-worker.ts`) の両方で同一実装が必要なためここに切り出す。
 * content.js / service-worker.js はそれぞれ独立にバンドルされるため、
 * この関数は両方の成果物に個別に埋め込まれるだけで実行時の共有状態はない。
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}
