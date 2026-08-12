import type { DownloadZipResult, FileSystemFileHandle } from 'download-helper/download-helper';
import { DownloadHelper, DownloadUtils } from 'download-helper/download-helper';
import { sendMessageAbortable } from './messaging';
import { createTestSaveHandle, IS_TEST_BUILD, wrapFetchFileForTest } from './test-hooks';

export type { FileSystemFileHandle } from 'download-helper/download-helper';

const utils = new DownloadUtils();
const helper = new DownloadHelper(utils);

/**
 * service worker (`type: 'fetch'`) からの応答の型。
 *
 * service worker 側 (src/service-worker/handlers.ts) の MediaFetchResponse とワイヤ形状は
 * 一致させているが、content/fanbox/api.ts の ApiFetchResponse と同様、型としては別モジュールの
 * ものを import せずローカルに持つ (service worker と content script は別バンドルであり、
 * 型のみの結合であっても実装がどちらかの都合で変わったときにもう片方の型定義まで追随を
 * 強制されないようにするため)。
 */
type MediaFetchResponse = {
  ok: boolean;
  status: number;
  retryAfter: string | null;
  data?: string;
  error?: string;
};

/** ZIP フェーズの 1 回のメディア取得試行の記録 (Issue #18 第 1 段階の観測用契約) */
export type MediaFetchAttempt = {
  /** 取得先ホスト名 (downloads.fanbox.cc / *.pximg.net 等)。URL 解析に失敗した場合は 'unknown' */
  host: string;
  /** HTTP ステータス。fetchApi と揃え、通信失敗 (message 応答が status を持たない/例外) は 0 とする */
  status: number;
  retryAfter: string | null;
  kind: 'cover' | 'file';
  /** 試行が完了した時刻 (epoch ms) */
  at: number;
};

/** downloadAsZip の戻り値。ZIP 生成本体の結果 (download-helper 由来) と試行記録を分けて持つ */
export type DownloadAsZipResult = {
  zip: DownloadZipResult;
  attempts: MediaFetchAttempt[];
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

type ProxyFetchResult = { blob: Blob | null; status: number; retryAfter: string | null };

/**
 * service worker 経由で fetch する (CORS 回避)
 * content script の fetch はページのオリジンとして扱われるため、
 * downloads.fanbox.cc への fetch が CORS でブロックされる。
 * service worker 経由であれば host_permissions が適用される。
 *
 * 戻り値が null なのは、応答そのものを観測できなかった場合 (signal による中断で
 * sendMessageAbortable が reject した) に限る。service worker 側の handleFetchMedia は
 * content script の中断とは無関係に完走する (handleFetchApi と同様) ため、この場合でも
 * fetch 自体は成功/失敗しているかもしれないが、その結果は content script からは観測できない。
 * HTTP エラーや通信失敗など、応答を受け取れた場合は status/retryAfter を伴って返す
 * (blob は null になりうるが、これは「試行はした」ことを意味する)。
 */
async function proxyFetch(url: string, signal?: AbortSignal): Promise<ProxyFetchResult | null> {
  let response: MediaFetchResponse;
  try {
    response = await sendMessageAbortable<MediaFetchResponse>({ type: 'fetch', url }, signal);
  } catch (e) {
    if (signal?.aborted) return null;
    console.error(`proxyFetch エラー (メッセージング): ${url}`, e);
    return { blob: null, status: 0, retryAfter: null };
  }
  // 応答の正規化: 拡張の更新中は世代の異なる content script / service worker が併存しうるため、
  // 旧応答形状 ({ ok, data } のみで status/retryAfter を持たない) や欠損フィールドを受け取る
  // 可能性がある。実行時の値を信頼せず、MediaFetchAttempt の契約 (status 欠損は 0、
  // retryAfter は文字列でなければ null) をここで保証してから先へ渡す。
  const status = Number.isFinite(response.status) ? response.status : 0;
  const retryAfter = typeof response.retryAfter === 'string' ? response.retryAfter : null;
  // data の欠損判定は型で行う。0 バイトのファイルは有効な空文字列 base64 (data: '') として
  // 届くため、truthiness (!response.data) で判定すると正常な空ファイルを失敗扱いしてしまう。
  if (!response.ok || typeof response.data !== 'string') {
    return { blob: null, status, retryAfter };
  }
  try {
    const binary = atob(response.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { blob: new Blob([bytes]), status, retryAfter };
  } catch (e) {
    console.error(`proxyFetch エラー (デコード): ${url}`, e);
    return { blob: null, status, retryAfter };
  }
}

/**
 * リトライ付き fetch (service worker プロキシ経由)
 *
 * 中断されたら即座に null を返す。downloadZip は次のループ境界で signal を見て
 * ZIP を閉じるので、ここで例外にする必要はない。リトライ待ちを挟むと、
 * キャンセルしてから実際に止まるまでが retries × 1 秒ぶん延びる。
 *
 * 試行単位の観測 (Issue #18 第 1 段階): 実際に応答を受け取れた試行ごとに `attempts` へ記録し、
 * 併せて構造化ログとして console.info に単一オブジェクトで出力する。中断により応答を
 * 観測できなかった試行 (proxyFetch が null を返す場合) は記録しない — 実際に何が起きたか
 * 分からないものを「失敗」として記録すると、以後の集計 (対象単位の失敗集計) を汚すため。
 *
 * downloadAsZip からしか呼ばれないが、試行記録の性質 (429 → 成功でも初回の 429 が残る、
 * 通信失敗は status 0、中断は記録しない) を downloadAsZip 経由の JSON 往復なしに直接
 * 検証できるよう export している (handlers.ts の handleFetchApi と同じ理由)。
 */
export async function fetchWithRetry(
  url: string,
  name: string,
  retries: number,
  signal: AbortSignal | undefined,
  kind: 'cover' | 'file',
  attempts: MediaFetchAttempt[],
): Promise<Blob | null> {
  const host = hostnameOf(url);
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) return null;
    const result = await proxyFetch(url, signal);
    if (result) {
      const attempt: MediaFetchAttempt = {
        host,
        status: result.status,
        retryAfter: result.retryAfter,
        kind,
        at: Date.now(),
      };
      attempts.push(attempt);
      console.info(attempt);
      if (result.blob) return result.blob;
    }
    if (signal?.aborted) return null;
    if (i < retries) {
      console.error(`取得失敗 (retry ${i + 1}, status ${result?.status ?? '不明'}): ${name}, ${url}`);
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
  if (IS_TEST_BUILD) {
    return createTestSaveHandle();
  }
  const safeName = utils.encodeFileName(suggestedBaseName);
  return showSaveFilePicker({ suggestedName: `${safeName}.zip` });
}

/**
 * DownloadObject を ZIP ファイルとして書き出す
 *
 * 戻り値の `zip` (DownloadZipResult) が対象単位の最終的な失敗集計 (カバー画像含む、中断由来は
 * 含まない) であり、`attempts` が試行単位の観測記録である。1 対象につき最大 2 回試行するため、
 * 初回 429 → 再試行 200 で成功しても、初回の 429 は attempts に残る (呼び出し元の完了画面は
 * zip 側の対象単位集計を見るべきで、attempts の件数と混同しないこと)。
 */
export async function downloadAsZip(
  handle: FileSystemFileHandle,
  downloadObjJson: string,
  progress: DownloadProgress,
  signal: AbortSignal,
): Promise<DownloadAsZipResult> {
  const downloadObj: unknown = JSON.parse(downloadObjJson);
  const attempts: MediaFetchAttempt[] = [];
  const fetchFile = wrapFetchFileForTest((url, name, context) =>
    fetchWithRetry(url, name, 1, signal, context.kind, attempts),
  );
  const zip = await helper.downloadZip(downloadObj, progress.onProgress, progress.onLog, progress.onRemainTime, {
    handle,
    signal,
    fetchFile,
  });
  return { zip, attempts };
}

declare function showSaveFilePicker(options?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}): Promise<FileSystemFileHandle>;
