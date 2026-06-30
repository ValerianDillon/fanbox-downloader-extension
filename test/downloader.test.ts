import { afterEach, describe, expect, test } from 'bun:test';
import type { DownloadProgress, FileSystemFileHandle } from '../src/content/downloader';
import { downloadAsZip } from '../src/content/downloader';

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
  test('post 配下 info/index.html は日時付与、ルートと fallback は付与なし', async () => {
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

    // ルート index.html は date なし
    const root = entryByName(entries, 'u/index.html');
    expect(root.dosTime).toBe(0);
    expect(root.dosDate).toBe(0);
    expect(root.extraLen).toBe(0);
    expect(root.utMtime).toBeNull();

    // publishedDatetime ありの post 配下は DOS time/date + UT extra
    for (const path of ['u/withDate/info.json', 'u/withDate/index.html']) {
      const e = entryByName(entries, path);
      expect(e.dosDate).not.toBe(0);
      expect(e.extraLen).toBeGreaterThan(0);
      expect(e.utMtime).toBe(expectedUnix);
    }

    // publishedDatetime なしの post 配下は fallback (date なし)
    for (const path of ['u/noDate/info.json', 'u/noDate/index.html']) {
      const e = entryByName(entries, path);
      expect(e.dosTime).toBe(0);
      expect(e.dosDate).toBe(0);
      expect(e.extraLen).toBe(0);
      expect(e.utMtime).toBeNull();
    }
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
  });
});

describe('downloadAsZip - cover/files も日時付与 (chrome モック)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const origChrome = (globalThis as any).chrome;
  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = origChrome;
  });

  test('cover と file の LFH の UT extra Mtime が publishedDatetime と一致', async () => {
    const data = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47));
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: async (message: { type: string; url: string }) => {
          if (message.type !== 'fetch') throw new Error(`unexpected message type: ${message.type}`);
          return { ok: true, data };
        },
      },
    };

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
    await downloadAsZip(handle, json, noopProgress, new AbortController().signal);

    const entries = parseLocalEntries(mock.toBuffer());
    for (const path of ['u/p/cover.png', 'u/p/f.bin']) {
      expect(entryByName(entries, path).utMtime).toBe(expectedUnix);
    }
  });
});
