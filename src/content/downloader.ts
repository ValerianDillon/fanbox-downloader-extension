import { DownloadHelper, DownloadUtils, ZipWriter } from 'download-helper/download-helper';

const utils = new DownloadUtils();
const helper = new DownloadHelper(utils);

async function toUint8Array(parts: BlobPart[]): Promise<Uint8Array> {
  const blob = new Blob(parts);
  return new Uint8Array(await blob.arrayBuffer());
}

export type DownloadProgress = {
  onProgress: (percent: number) => void;
  onLog: (message: string) => void;
  onRemainTime: (time: string) => void;
};

/**
 * DownloadObject を ZIP ファイルとして書き出す
 */
export async function downloadAsZip(
  downloadObjJson: string,
  progress: DownloadProgress,
  signal: AbortSignal,
): Promise<void> {
  const downloadObj: unknown = JSON.parse(downloadObjJson);
  if (!helper.isDownloadJsonObj(downloadObj)) {
    throw new Error('ダウンロード対象オブジェクトの型が不正');
  }
  const encodedId = utils.encodeFileName(downloadObj.id);

  const handle = await showSaveFilePicker({ suggestedName: `${encodedId}.zip` });
  const writable = await handle.createWritable();
  const zip = new ZipWriter(writable);

  const enqueue = async (fileBits: BlobPart[], path: string) => {
    await zip.addFile(`${encodedId}/${path}`, await toUint8Array(fileBits));
  };

  const startTime = Math.floor(Date.now() / 1000);
  let count = 0;
  let failedCount = 0;

  progress.onLog(`@${downloadObj.id} 投稿:${downloadObj.postCount} ファイル:${downloadObj.fileCount}`);
  await enqueue([helper.createRootHtmlFromPosts(downloadObj)], 'index.html');

  let postCount = 0;
  for (const post of downloadObj.posts) {
    if (signal.aborted) {
      await zip.close();
      return;
    }
    progress.onLog(`${post.originalName} (${++postCount}/${downloadObj.postCount})`);
    const informationFile = utils.createInformationFile(post.informationText);
    await enqueue(informationFile.content, `${post.encodedName}/${utils.encodeFileName(informationFile.name)}`);
    await enqueue([helper.createHtmlFromBody(post.originalName, post.htmlText)], `${post.encodedName}/index.html`);

    if (post.cover) {
      progress.onLog(`download ${post.cover.name}`);
      const blob = await utils.fetchWithLimit(post.cover, 1);
      if (blob) {
        await enqueue([blob], `${post.encodedName}/${post.cover.name}`);
      }
    }

    let fileCount = 0;
    for (const file of post.files) {
      if (signal.aborted) {
        await zip.close();
        return;
      }
      progress.onLog(`download ${file.encodedName} (${++fileCount}/${post.files.length})`);
      const blob = await utils.fetchWithLimit({ url: file.url, name: file.encodedName }, 1);
      if (blob) {
        await enqueue([blob], `${post.encodedName}/${file.encodedName}`);
      } else {
        failedCount++;
        console.error(`${file.encodedName}(${file.url})のダウンロードに失敗、読み飛ばすよ`);
        progress.onLog(`${file.encodedName}のダウンロードに失敗`);
      }
      count++;
      const remain = Math.floor(
        (Math.abs(Math.floor(Date.now() / 1000) - startTime) * (downloadObj.fileCount - count)) / count,
      );
      const h = (remain / (60 * 60)) | 0;
      const m = Math.ceil((remain - 60 * 60 * h) / 60);
      progress.onRemainTime(`${h}:${(`00${m}`).slice(-2)}`);
      progress.onProgress(((count * 100) / downloadObj.fileCount) | 0);
      await utils.sleep(100);
    }
  }
  if (failedCount > 0) {
    progress.onLog(`完了 (${failedCount}件のダウンロードに失敗)`);
  } else {
    progress.onLog('完了');
  }
  await zip.close();
}

declare function showSaveFilePicker(options?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}): Promise<FileSystemFileHandle>;

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}
