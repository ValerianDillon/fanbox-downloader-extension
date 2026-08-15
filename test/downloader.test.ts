import { afterEach, describe, expect, test } from 'bun:test';
import type { DownloadProgress, FileSystemFileHandle, MediaFetchAttempt } from '../src/content/downloader';
import { downloadAsZip, fetchWithRetry } from '../src/content/downloader';
import { installFakeMediaRuntime, simpleResponder } from './fake-media-port';

// ZipWriter が書き込む先のモック。write() で渡る Uint8Array を蓄積する。
class MockWritableStream {
  chunks: Uint8Array[] = [];
  closed = false;
  async write(data: Uint8Array) {
    // ZipWriter がバッファを再利用する可能性に備えてコピーする
    this.chunks.push(new Uint8Array(data));
  }
  async close() {
    this.closed = true;
  }
  toBuffer(): Uint8Array {
    const len = this.chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);
const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const i32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getInt32(o, true);

// extra field 群から指定 header id のブロック先頭オフセットと size を探す
function findExtra(extra: Uint8Array, id: number): { offset: number; size: number } | null {
  let off = 0;
  while (off + 4 <= extra.length) {
    const fid = extra[off] | (extra[off + 1] << 8);
    const size = extra[off + 2] | (extra[off + 3] << 8);
    if (fid === id) return { offset: off, size };
    off += 4 + size;
  }
  return null;
}

type Entry = { name: string; dosTime: number; dosDate: number; extraLen: number; utMtime: number | null };

// Local File Header を signature 0x04034b50 から走査する (stored 無圧縮、data descriptor なし)
function parseLocalEntries(buf: Uint8Array): Entry[] {
  const dec = new TextDecoder();
  const entries: Entry[] = [];
  let off = 0;
  while (off + 4 <= buf.length && u32(buf, off) === 0x04034b50) {
    const compSize = u32(buf, off + 18);
    const nameLen = u16(buf, off + 26);
    const extraLen = u16(buf, off + 28);
    const name = dec.decode(buf.slice(off + 30, off + 30 + nameLen));
    const extra = buf.slice(off + 30 + nameLen, off + 30 + nameLen + extraLen);
    const ut = findExtra(extra, 0x5455);
    let utMtime: number | null = null;
    if (ut) {
      const blk = extra.slice(ut.offset, ut.offset + 4 + ut.size);
      // blk[4] = flags(0x07), blk[5..] = mtime (Int32LE)
      utMtime = i32(blk, 5);
    }
    entries.push({ name, dosTime: u16(buf, off + 10), dosDate: u16(buf, off + 12), extraLen, utMtime });
    off += 30 + nameLen + extraLen + compSize;
  }
  return entries;
}

function entryByName(entries: Entry[], name: string): Entry {
  const e = entries.find((it) => it.name === name);
  if (!e) throw new Error(`entry not found: ${name} (got: ${entries.map((it) => it.name).join(', ')})`);
  return e;
}

const noopProgress: DownloadProgress = {
  onProgress: () => {},
  onLog: () => {},
  onRemainTime: () => {},
};

function makeHandle(): { handle: FileSystemFileHandle; mock: MockWritableStream } {
  const mock = new MockWritableStream();
  const handle = { createWritable: async () => mock } as unknown as FileSystemFileHandle;
  return { handle, mock };
}

describe('downloadAsZip - publishedDatetime (info/html, chrome 不要)', () => {
  test('post 配下 info/index.html とルートは日時付与、publishedDatetime なしの post 配下は付与なし', async () => {
    const published = '2024-05-01T12:34:56Z';
    const expectedUnix = Math.floor(new Date(published).getTime() / 1000);
    const json = JSON.stringify({
      id: 'u',
      url: '#main',
      tags: [],
      postCount: 2,
      fileCount: 0,
      posts: [
        {
          originalName: 'withDate',
          encodedName: 'withDate',
          informationText: '{"postId":"1"}',
          htmlText: '<p>a</p>',
          files: [],
          tags: [],
          publishedDatetime: published,
        },
        {
          originalName: 'noDate',
          encodedName: 'noDate',
          informationText: '{"postId":"2"}',
          htmlText: '<p>b</p>',
          files: [],
          tags: [],
        },
      ],
    });
    const { handle, mock } = makeHandle();
    await downloadAsZip(handle, json, noopProgress, new AbortController().signal);
    expect(mock.closed).toBe(true);

    const entries = parseLocalEntries(mock.toBuffer());

    // ルートディレクトリの日時は、投稿の publishedDatetime のうち有効な値の最大値
    // (このケースでは withDate のみが有効な値なので withDate の日時と一致する)
    const rootDir = entryByName(entries, 'u/');
    expect(rootDir.utMtime).toBe(expectedUnix);

    // ルート index.html にもルートディレクトリと同じ日時が付く (download-helper v4.6.0 以降)。
    // 日時を与えないと DOS date 0 となり、展開時に ZIP の epoch (1980-01-01) より前の
    // 不正な mtime になるため
    const root = entryByName(entries, 'u/index.html');
    expect(root.utMtime).toBe(expectedUnix);
    expect(root.dosDate).not.toBe(0);
    expect(root.extraLen).toBeGreaterThan(0);

    // publishedDatetime ありの post 配下は DOS time/date + UT extra
    for (const path of ['u/withDate/info.json', 'u/withDate/index.html']) {
      const e = entryByName(entries, path);
      expect(e.dosDate).not.toBe(0);
      expect(e.extraLen).toBeGreaterThan(0);
      expect(e.utMtime).toBe(expectedUnix);
    }

    // 投稿ディレクトリの UT extra の mtime も publishedDatetime と一致する
    const withDateDir = entryByName(entries, 'u/withDate/');
    expect(withDateDir.utMtime).toBe(expectedUnix);

    // publishedDatetime なしの post 配下は fallback (date なし)
    for (const path of ['u/noDate/info.json', 'u/noDate/index.html']) {
      const e = entryByName(entries, path);
      expect(e.dosTime).toBe(0);
      expect(e.dosDate).toBe(0);
      expect(e.extraLen).toBe(0);
      expect(e.utMtime).toBeNull();
    }

    // publishedDatetime なしの post ディレクトリも fallback (date なし)
    const noDateDir = entryByName(entries, 'u/noDate/');
    expect(noDateDir.dosTime).toBe(0);
    expect(noDateDir.dosDate).toBe(0);
    expect(noDateDir.extraLen).toBe(0);
    expect(noDateDir.utMtime).toBeNull();
  });

  test('不正値 publishedDatetime の post は date なし (fallback)', async () => {
    const json = JSON.stringify({
      id: 'u',
      url: '#main',
      tags: [],
      postCount: 1,
      fileCount: 0,
      posts: [
        {
          originalName: 'bad',
          encodedName: 'bad',
          informationText: '{"postId":"3"}',
          htmlText: '<p>c</p>',
          files: [],
          tags: [],
          publishedDatetime: 'not-a-date',
        },
      ],
    });
    const { handle, mock } = makeHandle();
    await downloadAsZip(handle, json, noopProgress, new AbortController().signal);

    const entries = parseLocalEntries(mock.toBuffer());
    const e = entryByName(entries, 'u/bad/info.json');
    expect(e.dosTime).toBe(0);
    expect(e.dosDate).toBe(0);
    expect(e.extraLen).toBe(0);
    expect(e.utMtime).toBeNull();

    // 有効な publishedDatetime を持つ投稿が 1 件も無いので、投稿ディレクトリ・ルートディレクトリともに date なし
    const dir = entryByName(entries, 'u/bad/');
    expect(dir.dosTime).toBe(0);
    expect(dir.dosDate).toBe(0);
    expect(dir.extraLen).toBe(0);
    expect(dir.utMtime).toBeNull();

    const rootDir = entryByName(entries, 'u/');
    expect(rootDir.dosTime).toBe(0);
    expect(rootDir.dosDate).toBe(0);
    expect(rootDir.extraLen).toBe(0);
    expect(rootDir.utMtime).toBeNull();
  });

  test('ルートディレクトリの日時は複数投稿の publishedDatetime のうち最大値になる', async () => {
    const earlier = '2024-01-01T00:00:00Z';
    const later = '2024-12-31T23:59:59Z';
    const expectedEarlierUnix = Math.floor(new Date(earlier).getTime() / 1000);
    const expectedLaterUnix = Math.floor(new Date(later).getTime() / 1000);
    const json = JSON.stringify({
      id: 'u',
      url: '#main',
      tags: [],
      postCount: 3,
      fileCount: 0,
      posts: [
        {
          originalName: 'earlier',
          encodedName: 'earlier',
          informationText: '{}',
          htmlText: '<p>a</p>',
          files: [],
          tags: [],
          publishedDatetime: earlier,
        },
        {
          originalName: 'later',
          encodedName: 'later',
          informationText: '{}',
          htmlText: '<p>b</p>',
          files: [],
          tags: [],
          publishedDatetime: later,
        },
        {
          originalName: 'none',
          encodedName: 'none',
          informationText: '{}',
          htmlText: '<p>c</p>',
          files: [],
          tags: [],
        },
      ],
    });
    const { handle, mock } = makeHandle();
    await downloadAsZip(handle, json, noopProgress, new AbortController().signal);

    const entries = parseLocalEntries(mock.toBuffer());

    // ルートディレクトリは最大値 (later) を採用し、最小値 (earlier) には引きずられない
    const rootDir = entryByName(entries, 'u/');
    expect(rootDir.utMtime).toBe(expectedLaterUnix);

    // 各投稿ディレクトリは自身の publishedDatetime をそのまま持つ
    expect(entryByName(entries, 'u/earlier/').utMtime).toBe(expectedEarlierUnix);
    expect(entryByName(entries, 'u/later/').utMtime).toBe(expectedLaterUnix);
    const noneDir = entryByName(entries, 'u/none/');
    expect(noneDir.dosTime).toBe(0);
    expect(noneDir.utMtime).toBeNull();
  });
});

describe('downloadAsZip - cover/files も日時付与 (chrome モック)', () => {
  let restoreRuntime: (() => void) | null = null;
  afterEach(() => {
    restoreRuntime?.();
    restoreRuntime = null;
  });

  test('cover と file の LFH の UT extra Mtime が publishedDatetime と一致し、戻り値 (zip/attempts) も正しく埋まる', async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    restoreRuntime = installFakeMediaRuntime(simpleResponder(() => ({ status: 200, body: data }))).restore;

    const published = '2023-08-15T09:00:00Z';
    const expectedUnix = Math.floor(new Date(published).getTime() / 1000);
    const json = JSON.stringify({
      id: 'u',
      url: '#main',
      tags: [],
      postCount: 1,
      fileCount: 1,
      posts: [
        {
          originalName: 'p',
          encodedName: 'p',
          informationText: '{}',
          htmlText: '<p></p>',
          files: [{ url: 'https://example.test/f', originalName: 'f.bin', encodedName: 'f.bin' }],
          tags: [],
          cover: { url: 'https://example.test/c', name: 'cover.png' },
          publishedDatetime: published,
        },
      ],
    });
    const { handle, mock } = makeHandle();
    const { zip, attempts } = await downloadAsZip(handle, json, noopProgress, new AbortController().signal);

    const entries = parseLocalEntries(mock.toBuffer());
    for (const path of ['u/p/cover.png', 'u/p/f.bin']) {
      expect(entryByName(entries, path).utMtime).toBe(expectedUnix);
    }

    // 対象単位の集計 (DownloadZipResult): カバー + ファイルの 2 件とも成功
    expect(zip.failedFileCount).toBe(0);
    expect(zip.writtenFileCount).toBe(2);
    expect(zip.completedPostCount).toBe(1);
    expect(zip.totalPostCount).toBe(1);
    expect(zip.aborted).toBe(false);

    // 試行単位の記録: cover 用・file 用それぞれ 1 回ずつ、応答のステータス/Retry-After が反映されている
    expect(attempts.length).toBe(2);
    expect(attempts.every((a) => a.status === 200 && a.retryAfter === null && a.host === 'example.test')).toBe(true);
    // context.kind (download-helper から渡される取得対象の種別) が正しく attempts に伝わっている
    expect(attempts.map((a) => a.kind).sort()).toEqual(['cover', 'file']);
  });

  test('取得に 2 回とも失敗 (429) すると zip.failedFileCount に反映され、attempts にも 2 回分の 429 が残る', async () => {
    restoreRuntime = installFakeMediaRuntime(simpleResponder(() => ({ status: 429, retryAfter: '3' }))).restore;
    const origSetTimeout = globalThis.setTimeout;
    // fetchWithRetry の再試行間の 1 秒待機を仮想時間で進める
    globalThis.setTimeout = ((handler: TimerHandler) =>
      origSetTimeout(handler as () => void, 0)) as unknown as typeof setTimeout;

    try {
      const json = JSON.stringify({
        id: 'u',
        url: '#main',
        tags: [],
        postCount: 1,
        fileCount: 1,
        posts: [
          {
            originalName: 'p',
            encodedName: 'p',
            informationText: '{}',
            htmlText: '<p></p>',
            files: [{ url: 'https://example.test/f', originalName: 'f.bin', encodedName: 'f.bin' }],
            tags: [],
          },
        ],
      });
      const { handle } = makeHandle();
      const { zip, attempts } = await downloadAsZip(handle, json, noopProgress, new AbortController().signal);

      expect(zip.failedFileCount).toBe(1);
      expect(zip.writtenFileCount).toBe(0);
      expect(zip.aborted).toBe(false);

      // 1 対象最大 2 試行なので、429 が 2 回とも記録に残る
      expect(attempts.length).toBe(2);
      expect(attempts.every((a) => a.status === 429 && a.retryAfter === '3' && a.kind === 'file')).toBe(true);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});

/**
 * Issue #18 第 1 段階: fetchWithRetry の試行単位の観測記録のテスト。
 * downloadAsZip 経由の JSON 往復を挟まず、fetchWithRetry を直接呼んで検証する
 * (test/service-worker/handlers.test.ts が handleFetchApi を直接呼ぶのと同じ理由)。
 */
describe('fetchWithRetry の試行記録 (Issue #18)', () => {
  const origSetTimeout = globalThis.setTimeout;
  const origConsoleInfo = console.info;
  let restoreRuntime: (() => void) | null = null;

  afterEach(() => {
    restoreRuntime?.();
    restoreRuntime = null;
    globalThis.setTimeout = origSetTimeout;
    console.info = origConsoleInfo;
  });

  test('初回 429 → 再試行 200 で成功しても、初回の 429 が試行記録に残る', async () => {
    // fetchWithRetry の再試行間には 1 秒の固定待機 (utils.sleep) があるため、
    // setTimeout を即時実行に置換して仮想時間で進める (test/fanbox/api.test.ts と同じ手法)
    globalThis.setTimeout = ((handler: TimerHandler) =>
      origSetTimeout(handler as () => void, 0)) as unknown as typeof setTimeout;

    let calls = 0;
    const runtime = installFakeMediaRuntime(
      simpleResponder(() => {
        calls++;
        if (calls === 1) return { status: 429, retryAfter: '3' };
        return { status: 200, body: new TextEncoder().encode('ok') };
      }),
    );
    restoreRuntime = runtime.restore;
    const loggedAttempts: unknown[] = [];
    console.info = ((...args: unknown[]) => loggedAttempts.push(args[0])) as typeof console.info;

    const attempts: MediaFetchAttempt[] = [];
    const blob = await fetchWithRetry('https://downloads.fanbox.cc/f', 'f.bin', 1, undefined, 'file', attempts);

    expect(blob).not.toBeNull();
    expect(calls).toBe(2);
    // 対象単位では最終的に成功しているが、試行記録には初回の 429 も残る
    expect(attempts.map((a) => a.status)).toEqual([429, 200]);
    expect(attempts[0].kind).toBe('file');
    expect(attempts[0].host).toBe('downloads.fanbox.cc');
    expect(attempts[0].retryAfter).toBe('3');
    expect(attempts[1].retryAfter).toBeNull();
    // 試行ごとに console.info へ単一オブジェクトとして構造化ログを出す
    expect(loggedAttempts).toEqual(attempts);
  });

  test('通信失敗 (service worker が status:0 を返す) は 2 回とも status 0 で記録され、最終的に blob は null', async () => {
    globalThis.setTimeout = ((handler: TimerHandler) =>
      origSetTimeout(handler as () => void, 0)) as unknown as typeof setTimeout;

    restoreRuntime = installFakeMediaRuntime(simpleResponder(() => ({ status: 0 }))).restore;

    const attempts: MediaFetchAttempt[] = [];
    const blob = await fetchWithRetry('https://downloads.fanbox.cc/f', 'f.bin', 1, undefined, 'cover', attempts);

    expect(blob).toBeNull();
    expect(attempts.length).toBe(2);
    expect(attempts.every((a) => a.status === 0)).toBe(true);
    expect(attempts.every((a) => a.kind === 'cover')).toBe(true);
  });

  test('中断による打ち切りは失敗として記録されない (1 回目の応答後に中断すると 2 回目は試行されない)', async () => {
    let calls = 0;
    restoreRuntime = installFakeMediaRuntime(
      simpleResponder(() => {
        calls++;
        return { status: 429, retryAfter: '3' };
      }),
    ).restore;

    const controller = new AbortController();
    const attempts: MediaFetchAttempt[] = [];
    // 1 回目の試行が観測された直後 (attempts.push の瞬間) に中断させることで、
    // 「応答を受け取れた試行は記録されるが、中断により見送られた 2 回目は記録されない」を
    // タイミング競合なしに検証する
    const originalPush = attempts.push.bind(attempts);
    attempts.push = ((...items: MediaFetchAttempt[]) => {
      const result = originalPush(...items);
      controller.abort();
      return result;
    }) as typeof attempts.push;

    const blob = await fetchWithRetry('https://downloads.fanbox.cc/f', 'f.bin', 1, controller.signal, 'file', attempts);

    expect(blob).toBeNull();
    expect(calls).toBe(1);
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe(429);
  });

  test('呼び出し前から中断済みなら 1 回も試行せず、記録も残らない', async () => {
    let calls = 0;
    restoreRuntime = installFakeMediaRuntime(
      simpleResponder(() => {
        calls++;
        return { status: 200, body: new TextEncoder().encode('ok') };
      }),
    ).restore;
    const controller = new AbortController();
    controller.abort();
    const attempts: MediaFetchAttempt[] = [];

    const blob = await fetchWithRetry('https://downloads.fanbox.cc/f', 'f.bin', 1, controller.signal, 'file', attempts);

    expect(blob).toBeNull();
    expect(calls).toBe(0);
    expect(attempts.length).toBe(0);
  });

  test('0 バイトのファイル (chunk なしで end) は失敗ではなく空の Blob として成功する', async () => {
    // HTTP 2xx で本文 0 バイトのファイルは head → end (bytes 0) だけで届く。
    // これを失敗扱いすると正常な空ファイルを failedFileCount に誤計上してしまう
    restoreRuntime = installFakeMediaRuntime(simpleResponder(() => ({ status: 200, body: new Uint8Array() }))).restore;

    const attempts: MediaFetchAttempt[] = [];
    const blob = await fetchWithRetry('https://downloads.fanbox.cc/f', 'f.bin', 1, undefined, 'file', attempts);

    expect(blob).not.toBeNull();
    expect(blob?.size).toBe(0);
    expect(attempts.map((a) => a.status)).toEqual([200]);
  });
});
