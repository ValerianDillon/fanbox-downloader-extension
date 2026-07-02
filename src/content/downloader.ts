import type { FileSystemFileHandle } from 'download-helper/download-helper';
import { DownloadHelper, DownloadUtils } from 'download-helper/download-helper';

export type { FileSystemFileHandle } from 'download-helper/download-helper';

const utils = new DownloadUtils();
const helper = new DownloadHelper(utils);

/**
 * service worker 経由で fetch する (CORS 回避)
 * content script の fetch はページのオリジンとして扱われるため、
 * downloads.fanbox.cc への fetch が CORS でブロックされる。
 * service worker 経由であれば host_permissions が適用される。
 */
async function proxyFetch(url: string): Promise<Blob | null> {
  try {
    const response: { ok: boolean; data?: string } = await chrome.runtime.sendMessage({ type: 'fetch', url });
    if (!response.ok || !response.data) return null;
    const binary = atob(response.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes]);
  } catch (e) {
    console.error(`proxyFetch エラー: ${url}`, e);
    return null;
  }
}

/**
 * リトライ付き fetch (service worker プロキシ経由)
 */
async function fetchWithRetry(url: string, name: string, retries: number): Promise<Blob | null> {
  for (let i = 0; i <= retries; i++) {
    const blob = await proxyFetch(url);
    if (blob) return blob;
    if (i < retries) {
      console.error(`通信エラー (retry ${i + 1}): ${name}, ${url}`);
      await utils.sleep(1000);
    }
  }
  return null;
}

export type DownloadProgress = {
  onProgress: (percent: number) => void;
  onLog: (message: string) => void;
  onRemainTime: (time: string) => void;
};

/**
 * 「ダウンロード開始」直後のユーザジェスチャー有効中に呼ぶ。
 * 収集処理が長引いてジェスチャーが失効する前にファイルハンドルを確保する。
 */
export async function pickSaveHandle(suggestedBaseName: string): Promise<FileSystemFileHandle> {
  const safeName = utils.encodeFileName(suggestedBaseName);
  return showSaveFilePicker({ suggestedName: `${safeName}.zip` });
}

/**
 * DownloadObject を ZIP ファイルとして書き出す
 */
export async function downloadAsZip(
  handle: FileSystemFileHandle,
  downloadObjJson: string,
  progress: DownloadProgress,
  signal: AbortSignal,
): Promise<void> {
  const downloadObj: unknown = JSON.parse(downloadObjJson);
  await helper.downloadZip(downloadObj, progress.onProgress, progress.onLog, progress.onRemainTime, {
    handle,
    signal,
    fetchFile: (url, name) => fetchWithRetry(url, name, 1),
  });
}

declare function showSaveFilePicker(options?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}): Promise<FileSystemFileHandle>;
