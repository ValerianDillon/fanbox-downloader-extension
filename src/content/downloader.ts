import type {
  DownloadJsonObj,
  DownloadZipResult,
  FileSystemFileHandle,
  PreflightResult,
} from 'download-helper/download-helper';
import { DownloadHelper, DownloadUtils } from 'download-helper/download-helper';
import { appendMediaAttempts } from './media-attempt-log';
import { fetchMediaViaPort } from './media-stream';
import { createTestSaveHandle, IS_TEST_BUILD, wrapFetchFileForTest } from './test-hooks';

export type { FileSystemFileHandle } from 'download-helper/download-helper';

const utils = new DownloadUtils();
const helper = new DownloadHelper(utils);

/** 同時に取得するメディア数の既定値。設定画面では 1〜4 の範囲で変更できる。 */
export const DEFAULT_MEDIA_CONCURRENCY = 3;
export const MAX_MEDIA_CONCURRENCY = 4;

/** ZIP フェーズの 1 回のメディア取得試行の記録 (Issue #18 第 1 段階の観測用契約) */
export type MediaFetchAttempt = {
  /** 取得先ホスト名 (downloads.fanbox.cc / *.pximg.net 等)。URL 解析に失敗した場合は 'unknown' */
  host: string;
  /** HTTP ステータス。fetchApi と揃え、通信失敗 (応答ヘッダを観測できなかった) は 0 とする */
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

/**
 * リトライ付き fetch (service worker プロキシ経由)
 *
 * content script の fetch はページのオリジンとして扱われるため、downloads.fanbox.cc への fetch は
 * CORS でブロックされる。service worker 経由であれば host_permissions が適用される。本文は Port 上で
 * chunk に分けて転送される (Issue #22。単発メッセージの応答に載せる方式は runtime messaging の 64 MiB
 * 上限に当たり、約 48 MiB 以上のファイルが必ず失敗していた)。実装は ./media-stream.ts。
 *
 * ここでの再試行は「1 回の取得全体」の単位で、通信失敗・HTTP エラーが対象になる。転送途中の切断からの
 * 再開 (Range) は fetchMediaViaPort の内側で行うので、ここには現れない。サイズ起因で必ず失敗する経路は
 * 分割転送により存在しなくなったため、サイズ失敗を再試行から除外する分岐は持たない。
 *
 * 中断されたら即座に null を返す。downloadZip は次のループ境界で signal を見て
 * ZIP を閉じるので、ここで例外にする必要はない。リトライ待ちを挟むと、
 * キャンセルしてから実際に止まるまでが retries × 1 秒ぶん延びる。
 *
 * 試行単位の観測 (Issue #18 第 1 段階): 実際に応答を受け取れた試行ごとに `attempts` へ記録し、
 * 併せて構造化ログとして console.info に単一オブジェクトで出力する。中断により応答を
 * 観測できなかった試行 (fetchMediaViaPort が null を返す場合) は記録しない — 実際に何が起きたか
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
    const result = await fetchMediaViaPort(url, signal);
    if (result) {
      const attempt: MediaFetchAttempt = {
        host,
        status: result.status,
        retryAfter: result.retryAfter,
        kind,
        at: Date.now(),
      };
      attempts.push(attempt);
      console.info('[FBDL] メディア取得', attempt);
      if (result.blob) return result.blob;
    }
    if (signal?.aborted) return null;
    if (i < retries) {
      console.warn('[FBDL] メディア取得を再試行', {
        name,
        status: result?.status ?? 0,
        retry: i + 1,
        maxRetries: retries,
      });
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

/** 共有層の短い進捗ログを、対象と段階が分かる表示へ整える。 */
export function formatDownloadLog(message: string): string {
  const start = /^@(.+) 投稿:(\d+) ファイル:(\d+)$/u.exec(message);
  if (start) return `ZIP 作成開始: @${start[1]} / 投稿 ${start[2]} 件 / 添付 ${start[3]} 件`;
  const post = /^(.*) \((\d+)\/(\d+)\)$/u.exec(message);
  if (post && !post[1].startsWith('download ')) return `投稿 ${post[2]}/${post[3]}: ${post[1]}`;
  const file = /^download (.*) \((\d+)\/(\d+)\)$/u.exec(message);
  if (file) return `取得 ${file[2]}/${file[3]}: ${file[1]}`;
  const cover = /^download (.+)$/u.exec(message);
  if (cover) return `取得: ${cover[1]}`;
  const failed = /^(.+)のダウンロードに失敗$/u.exec(message);
  if (failed) return `取得失敗: ${failed[1]}`;
  if (message === '完了') return 'ZIP 作成完了';
  const completedWithFailures = /^完了 \((\d+)件のダウンロードに失敗\)$/u.exec(message);
  if (completedWithFailures) return `ZIP 作成完了: ${completedWithFailures[1]} 件取得失敗`;
  return message;
}

type FetchFile = NonNullable<Parameters<DownloadHelper['downloadZip']>[4]>['fetchFile'];

type MediaJob = {
  readonly url: string;
  readonly name: string;
  readonly kind: 'cover' | 'file';
};

/** ZIP の書き込み順を保ったまま、先のメディアを指定数だけ先行取得する。 */
export function createConcurrentFetchFile(
  downloadObj: DownloadJsonObj,
  fetchFile: NonNullable<FetchFile>,
  requestedConcurrency: number,
  signal: AbortSignal,
): NonNullable<FetchFile> {
  const jobs: MediaJob[] = [];
  for (const post of downloadObj.posts) {
    if (post.cover) jobs.push({ url: post.cover.url, name: post.cover.name, kind: 'cover' });
    for (const file of post.files) jobs.push({ url: file.url, name: file.encodedName, kind: 'file' });
  }
  type Settled = { ok: true; value: Blob | null } | { ok: false; error: unknown };
  const deferred = jobs.map(() => {
    let resolve!: (value: Settled) => void;
    const promise = new Promise<Settled>((done) => {
      resolve = done;
    });
    return { promise, resolve, started: false };
  });
  const concurrency = Math.max(1, Math.min(MAX_MEDIA_CONCURRENCY, Math.trunc(requestedConcurrency) || 1));
  let active = 0;
  let nextToStart = 0;
  let nextToConsume = 0;
  let poolStarted = false;
  const resolvePendingAsAborted = () => {
    for (const item of deferred) {
      if (!item.started) {
        item.started = true;
        item.resolve({ ok: true, value: null });
      }
    }
  };
  const pump = () => {
    if (signal.aborted) {
      resolvePendingAsAborted();
      return;
    }
    while (active < concurrency && nextToStart < jobs.length) {
      const index = nextToStart++;
      const job = jobs[index];
      const item = deferred[index];
      item.started = true;
      active++;
      void fetchFile(job.url, job.name, { kind: job.kind })
        .then((value) => item.resolve({ ok: true, value }))
        .catch((error: unknown) => item.resolve({ ok: false, error }))
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  signal.addEventListener('abort', resolvePendingAsAborted, { once: true });
  return async (url, name, context) => {
    // downloadZip が writable と ZIP writer を準備する前に通信を始めない。
    // 最初の fetchFile 呼び出しを並列取得開始の合図にする。
    if (!poolStarted) {
      poolStarted = true;
      pump();
    }
    const index = nextToConsume++;
    const job = jobs[index];
    if (job === undefined || job.url !== url || job.name !== name || job.kind !== context.kind) {
      throw new Error(`メディア取得順が ZIP の書き込み計画と一致しません (${name})`);
    }
    const result = await deferred[index].promise;
    if (!result.ok) throw result.error;
    return result.value;
  };
}

/**
 * ZIP 入力として受け付けられるかを、保存先を確保する前に確かめる。
 *
 * **`showSaveFilePicker` は解決した時点で対象ファイルの中身を空にする。** 新規なら 0 バイトで
 * 作成し、既存ファイルを選べばその内容を消す (File System Access 仕様 3.4)。picker の後で
 * 入力の不備が見つかると、書くものが無いまま利用者のファイルだけが空になる。
 *
 * `isDownloadJsonObj` だけでは足りない。`downloadZip` は型検証の後にも投稿ディレクトリ名の重複や
 * 予約名との衝突を見ており、そちらは型検証を通る入力でも落ちうる (legacy allocator は投稿名が
 * `a` / `a` / `a_1` のとき `a_1` を 2 回割り当てる)。共有層の `preflight` は picker より前に
 * 走る検証をすべて持つので、それをそのまま呼ぶ。
 * 戻り値の `manifest` は検証を通った写しで、保存実績を記録するときの `AssetKey` の引き当てに使う
 * (`DownloadZipResult.assets` は archive 名でしか結果を指さない)。
 * @param value `DownloadObject.project()` の出力
 * @returns 検証を通った入力と manifest
 * @throws {Error} ZIP 入力として受け付けられない場合
 */
export function preflightDownload(value: unknown): PreflightResult {
  return helper.preflight(value);
}

/**
 * review 画面の確定ボタンのクリック中 (ユーザアクティベーション有効中) に呼ぶ。
 *
 * 以前は「ダウンロード開始」のクリック時に呼んでいた。収集が長引くとその間にアクティベーションが
 * 失効するため、収集より前に保存先を確保しておく必要があったからである。確定ボタンのクリック自体が
 * 新しいアクティベーションになるので、review 画面での操作が何分続いても保存先を確保できる (Issue #55)。
 * @param suggestedBaseName 既定のファイル名 (拡張子を除く)
 * @param shouldPublish テストビルドで観測状態を publish してよいかの判定 (通常ビルドでは使わない)
 */
export async function pickSaveHandle(
  suggestedBaseName: string,
  shouldPublish?: () => boolean,
): Promise<FileSystemFileHandle> {
  if (IS_TEST_BUILD) {
    return createTestSaveHandle(shouldPublish);
  }
  const safeName = utils.encodeFileName(suggestedBaseName);
  return showSaveFilePicker({ suggestedName: `${safeName}.zip` });
}

/**
 * projection の結果を ZIP ファイルとして書き出す
 *
 * 受け取るのは `DownloadObject.project()` の出力そのもので、文字列を経由しない。呼び出し側は
 * picker を開く前に `preflightDownload` で検証済みなので、ここで再び文字列に落として読み直すと
 * 検証した値と書き出す値が別のオブジェクトになる。
 *
 * 戻り値の `zip` (DownloadZipResult) が対象単位の最終的な失敗集計 (カバー画像含む、中断由来は
 * 含まない) であり、`attempts` が試行単位の観測記録である。1 対象につき最大 2 回試行するため、
 * 初回 429 → 再試行 200 で成功しても、初回の 429 は attempts に残る (呼び出し元の完了画面は
 * zip 側の対象単位集計を見るべきで、attempts の件数と混同しないこと)。
 * @param shouldPublish テストビルドで観測状態を publish してよいかの判定 (通常ビルドでは使わない)
 */
export async function downloadAsZip(
  handle: FileSystemFileHandle,
  downloadObj: DownloadJsonObj,
  progress: DownloadProgress,
  signal: AbortSignal,
  shouldPublish?: () => boolean,
  mediaConcurrency = DEFAULT_MEDIA_CONCURRENCY,
): Promise<DownloadAsZipResult> {
  const attempts: MediaFetchAttempt[] = [];
  const directFetchFile = wrapFetchFileForTest(
    (url, name, context) => fetchWithRetry(url, name, 1, signal, context.kind, attempts),
    shouldPublish,
  );
  const fetchFile = createConcurrentFetchFile(downloadObj, directFetchFile, mediaConcurrency, signal);
  try {
    const zip = await helper.downloadZip(downloadObj, progress.onProgress, progress.onLog, progress.onRemainTime, {
      handle,
      signal,
      fetchFile,
    });
    return { zip, attempts };
  } finally {
    // 例外や中断で終わった実行の記録も残す。観測したい 429 は失敗した実行にこそ現れるので、
    // 成功時だけ保存すると最も見たい事象が落ちる (Issue #51)
    await appendMediaAttempts(attempts);
  }
}

declare function showSaveFilePicker(options?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}): Promise<FileSystemFileHandle>;
