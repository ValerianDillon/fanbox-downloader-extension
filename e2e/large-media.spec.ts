import { createHash } from 'node:crypto';
import type { Route, Worker } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  CREATOR_ID,
  PAGINATE_RESPONSE,
  PAGINATE_URL,
  PLANS_RESPONSE,
  PLANS_URL,
  TAGS_RESPONSE,
  TAGS_URL,
} from './fixtures';
import { closeSession, launchAndStartDownload, readTestState } from './harness';

/**
 * Issue #22: 大きいファイルの分割転送 (Port 経由の chunk 転送) の smoke test。
 *
 * ユニットテスト (test/media-stream.test.ts / test/service-worker/media-stream.test.ts) は Port を
 * フェイクにしているため、Chrome の runtime messaging の 64 MiB 上限や、実際の Port の切断・abort の
 * 伝播は再現できない。ここでは実ブラウザで次を検証する。
 *
 * - 従来必ず失敗していたサイズ (48 MiB = 50,331,648 bytes。base64 で 64 MiB を超える境界) と、
 *   64 MiB (メッセージ上限そのもの) を超えるサイズのファイルが、複数 chunk で欠落なく ZIP に入る
 *   (バイト列は SHA-256 で完全一致を確認する)
 * - 転送中に service worker 側との接続が切れても Range で再開して完全なファイルになる。サーバが Range を
 *   無視して 200 を返す場合も (先頭から受け直して) 完全なファイルになる
 * - キャンセルすると service worker 側の fetch も中断され、進行中のストリームが残らない
 *
 * 大きい fixture はリポジトリに置かず、テスト実行時に決定的な擬似乱数で生成する。
 * ZIP の中身は Blob URL (data-fbdl-zip-url) を page.evaluate から fetch し、ページ内で
 * Local File Header を走査してエントリごとの SHA-256 を計算する (数十 MiB の base64 を DOM 属性や
 * CDP 越しに運ばないため)。
 */

const LIST_PAGE_URL = `https://api.fanbox.cc/post.listCreator?creatorId=${CREATOR_ID}&cursor=1`;
const CHUNK_BYTES = 8 * 1024 * 1024;

/** 従来 (単発メッセージ + base64) の失敗境界。Issue #22 の計算どおり 48 MiB ちょうどでも失敗していた */
const OLD_LIMIT_BYTES = 48 * 1024 * 1024;
/** runtime messaging のメッセージ上限そのもの (64 MiB) を 1 バイト超えるサイズ */
const OVER_MESSAGE_LIMIT_BYTES = 64 * 1024 * 1024 + 1;

/** 決定的な擬似乱数バイト列 (xorshift32)。同じ seed/size なら同じ内容になる */
function generateBytes(size: number, seed: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  let x = seed >>> 0 || 1;
  let i = 0;
  while (i + 4 <= size) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf.writeUInt32LE(x, i);
    i += 4;
  }
  while (i < size) {
    buf[i++] = i & 0xff;
  }
  return buf;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

type ZipEntryDigest = { name: string; size: number; sha256: string };

/**
 * ページ内で ZIP (Blob URL) を fetch し、Local File Header を先頭から走査してエントリごとの
 * サイズと SHA-256 を返す。ZipWriter は stored (無圧縮) かつ data descriptor なしで書くため、
 * LFH のサイズフィールドをそのまま信頼して次のエントリへ進める。
 */
async function digestZipEntriesInPage(
  page: { evaluate: <R, A>(fn: (arg: A) => Promise<R>, arg: A) => Promise<R> },
  zipUrl: string,
): Promise<{ totalSize: number; entries: ZipEntryDigest[] }> {
  return page.evaluate(async (url: string) => {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const decoder = new TextDecoder();
    const entries: { name: string; size: number; sha256: string }[] = [];
    let off = 0;
    while (off + 30 <= buf.length && view.getUint32(off, true) === 0x04034b50) {
      const compSize = view.getUint32(off + 18, true);
      const nameLen = view.getUint16(off + 26, true);
      const extraLen = view.getUint16(off + 28, true);
      const name = decoder.decode(buf.subarray(off + 30, off + 30 + nameLen));
      const dataStart = off + 30 + nameLen + extraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
      const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
      entries.push({ name, size: compSize, sha256 });
      off = dataStart + compSize;
    }
    return { totalSize: buf.length, entries };
  }, zipUrl);
}

/** service worker のテスト観測状態 (src/service-worker/test-hooks.ts の MediaStreamTestState) を読む */
type SwTestState = {
  activeStreams: number;
  disconnectedStreams: number;
  finishedStreams: number;
  chunkMessages: number;
  droppedUrls: string[];
};
async function readSwState(serviceWorker: Worker): Promise<SwTestState | null> {
  return serviceWorker.evaluate(() => {
    const state = (globalThis as unknown as { __fbdlTestState?: SwTestState }).__fbdlTestState;
    return state ? { ...state } : null;
  });
}

/** file type の投稿 fixture を組み立てる */
function filePost(id: string, title: string, files: { url: string; name: string; extension: string }[]) {
  const common = {
    id,
    title,
    feeRequired: 0,
    creatorId: CREATOR_ID,
    excerpt: '',
    isRestricted: false,
    tags: [],
    publishedDatetime: '2024-03-03T00:00:00+09:00',
    updatedDatetime: '2024-03-03T00:00:00+09:00',
    likeCount: 0,
    commentCount: 0,
  };
  return {
    stub: { ...common, cover: null },
    infoUrl: `https://api.fanbox.cc/post.info?postId=${id}`,
    info: { body: { post: { ...common, coverImageUrl: null, type: 'file', body: { text: '', files } } } },
  };
}

/**
 * 大きい本文 (と Range 応答) を返す route ハンドラを作る。
 * bodies に無い URL は false を返して既定処理 (fixture / fail-closed) に委ねる。
 * 受け取った Range ヘッダを URL ごとに記録する。
 */
function bigBodyRoute(bodies: Record<string, { body: Buffer; supportsRange: boolean }>) {
  const rangeRequests: Record<string, string[]> = {};
  const handler = async (route: Route, url: string): Promise<boolean> => {
    const entry = bodies[url];
    if (!entry) return false;
    // strong ETag を返す (無いと content 側は Range 再開せず先頭から取り直す。ここでは再開を検証したい)
    const etag = `"fbdl-${entry.body.length}"`;
    const rangeHeader = route.request().headers().range;
    if (rangeHeader) {
      rangeRequests[url] ??= [];
      rangeRequests[url].push(rangeHeader);
    }
    const m = rangeHeader ? /^bytes=(\d+)-$/.exec(rangeHeader) : null;
    if (m && entry.supportsRange) {
      const start = Number.parseInt(m[1], 10);
      const total = entry.body.length;
      if (start >= total) {
        await route.fulfill({ status: 416, headers: { 'Content-Range': `bytes */${total}` }, body: '' });
        return true;
      }
      await route.fulfill({
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(total - start),
          'Content-Range': `bytes ${start}-${total - 1}/${total}`,
          ETag: etag,
        },
        body: entry.body.subarray(start),
      });
      return true;
    }
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(entry.body.length), ETag: etag },
      body: entry.body,
    });
    return true;
  };
  return { handler, rangeRequests };
}

test.describe('Issue #22: 大きいファイルの分割転送', () => {
  // 100 MiB 超の fixture を CDP 越しに運ぶため、既定の 60 秒より長く取る
  test.setTimeout(240_000);

  test('48 MiB (従来の失敗境界) と 64 MiB 超のファイルが複数 chunk で欠落なく ZIP に入る', async () => {
    const big48 = generateBytes(OLD_LIMIT_BYTES, 0x1234_5678);
    const big65 = generateBytes(OVER_MESSAGE_LIMIT_BYTES, 0x9abc_def0);
    const URL_48 = 'https://downloads.fanbox.cc/files/2001/big48.bin';
    const URL_65 = 'https://downloads.fanbox.cc/files/2001/big65.bin';
    const post = filePost('2001', '大きいファイル', [
      { url: URL_48, name: 'big48', extension: 'bin' },
      { url: URL_65, name: 'big65', extension: 'bin' },
    ]);
    const { handler } = bigBodyRoute({
      [URL_48]: { body: big48, supportsRange: false },
      [URL_65]: { body: big65, supportsRange: false },
    });

    const session = await launchAndStartDownload(
      {
        [PLANS_URL]: PLANS_RESPONSE,
        [TAGS_URL]: TAGS_RESPONSE,
        [PAGINATE_URL]: PAGINATE_RESPONSE,
        [LIST_PAGE_URL]: { body: { posts: [post.stub] } },
        [post.infoUrl]: post.info,
      },
      'big',
      { routeOverride: handler },
    );
    const { page, serviceWorker, unexpectedRequests } = session;
    try {
      await expect
        .poll(() => page.evaluate(readTestState), { timeout: 180_000 })
        .toMatchObject({ overlayState: 'complete', zipDone: '1' });
      const state = await page.evaluate(readTestState);
      expect(state.error).toBeNull();
      expect(state.aborted).toBeNull();
      expect(state.failedFileCount).toBe('0');
      expect(state.addedPostCount).toBe('1');
      expect(unexpectedRequests).toEqual([]);

      // 大きい ZIP なので zip-b64 は publish されず、zip-url から検証する
      expect(state.zipB64).toBeNull();
      expect(state.zipUrl).not.toBeNull();
      const { totalSize, entries } = await digestZipEntriesInPage(page, state.zipUrl ?? '');
      expect(totalSize).toBe(Number.parseInt(state.zipSize ?? '0', 10));
      const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
      expect(byName['testcreator/大きいファイル/big48.bin']).toEqual({
        name: 'testcreator/大きいファイル/big48.bin',
        size: OLD_LIMIT_BYTES,
        sha256: sha256Hex(big48),
      });
      expect(byName['testcreator/大きいファイル/big65.bin']).toEqual({
        name: 'testcreator/大きいファイル/big65.bin',
        size: OVER_MESSAGE_LIMIT_BYTES,
        sha256: sha256Hex(big65),
      });

      // service worker 側: 2 ファイルとも複数 chunk に分かれて送られ、終端まで送り切っている
      const sw = await readSwState(serviceWorker);
      expect(sw).not.toBeNull();
      expect(sw?.activeStreams).toBe(0);
      expect(sw?.finishedStreams).toBe(2);
      expect(sw?.disconnectedStreams).toBe(0);
      expect(sw?.chunkMessages).toBeGreaterThanOrEqual(
        Math.ceil(OLD_LIMIT_BYTES / CHUNK_BYTES) + Math.ceil(OVER_MESSAGE_LIMIT_BYTES / CHUNK_BYTES),
      );
    } finally {
      await closeSession(session);
    }
  });

  test('転送中に切断されても Range で再開し (Range 非対応サーバでは受け直して) 完全なファイルになる', async () => {
    const withRange = generateBytes(20 * 1024 * 1024, 0x0bad_cafe);
    const noRange = generateBytes(12 * 1024 * 1024, 0x0dead_beef);
    // fbdl-test-drop-after: テストビルドの service worker が、そのバイト数以上を送った直後に Port を切断する
    const URL_RANGE = `https://downloads.fanbox.cc/files/2002/resume-range.bin?fbdl-test-drop-after=${CHUNK_BYTES}`;
    const URL_NORANGE = `https://downloads.fanbox.cc/files/2002/resume-norange.bin?fbdl-test-drop-after=${CHUNK_BYTES}`;
    const post = filePost('2002', '再開', [
      { url: URL_RANGE, name: 'resume-range', extension: 'bin' },
      { url: URL_NORANGE, name: 'resume-norange', extension: 'bin' },
    ]);
    const { handler, rangeRequests } = bigBodyRoute({
      [URL_RANGE]: { body: withRange, supportsRange: true },
      [URL_NORANGE]: { body: noRange, supportsRange: false },
    });

    const session = await launchAndStartDownload(
      {
        [PLANS_URL]: PLANS_RESPONSE,
        [TAGS_URL]: TAGS_RESPONSE,
        [PAGINATE_URL]: PAGINATE_RESPONSE,
        [LIST_PAGE_URL]: { body: { posts: [post.stub] } },
        [post.infoUrl]: post.info,
      },
      'resume',
      { routeOverride: handler },
    );
    const { page, serviceWorker, unexpectedRequests } = session;
    try {
      await expect
        .poll(() => page.evaluate(readTestState), { timeout: 120_000 })
        .toMatchObject({ overlayState: 'complete', zipDone: '1' });
      const state = await page.evaluate(readTestState);
      expect(state.error).toBeNull();
      expect(state.aborted).toBeNull();
      expect(state.failedFileCount).toBe('0');
      expect(unexpectedRequests).toEqual([]);

      const { entries } = await digestZipEntriesInPage(page, state.zipUrl ?? '');
      const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
      expect(byName['testcreator/再開/resume-range.bin']).toEqual({
        name: 'testcreator/再開/resume-range.bin',
        size: withRange.length,
        sha256: sha256Hex(withRange),
      });
      expect(byName['testcreator/再開/resume-norange.bin']).toEqual({
        name: 'testcreator/再開/resume-norange.bin',
        size: noRange.length,
        sha256: sha256Hex(noRange),
      });

      // 切断は各 URL で 1 回ずつ起きている
      const sw = await readSwState(serviceWorker);
      expect(sw?.droppedUrls.sort()).toEqual([URL_RANGE, URL_NORANGE].sort());
      expect(sw?.activeStreams).toBe(0);
      // どちらの URL にも Range 付きの再開要求が 1 回届いている (再開位置は受信済みの続き = CHUNK_BYTES の倍数)。
      // service worker が自分の port.disconnect() では自分の onDisconnect を発火しない (Chrome の仕様) ため、
      // 切断が content 側に伝わるまでに複数 chunk 送られることがあり、再開 offset は CHUNK_BYTES ちょうどとは限らない
      const assertSingleResume = (url: string) => {
        const reqs = rangeRequests[url] ?? [];
        expect(reqs.length).toBe(1);
        const m = /^bytes=(\d+)-$/.exec(reqs[0]);
        expect(m).not.toBeNull();
        const offset = Number.parseInt(m?.[1] ?? '0', 10);
        expect(offset).toBeGreaterThan(0);
        expect(offset % CHUNK_BYTES).toBe(0);
      };
      assertSingleResume(URL_RANGE);
      assertSingleResume(URL_NORANGE);
    } finally {
      await closeSession(session);
    }
  });

  test('キャンセルすると service worker 側の fetch も中断され、進行中のストリームが残らない', async () => {
    const URL_SLOW = 'https://downloads.fanbox.cc/files/2003/slow.bin';
    const post = filePost('2003', '遅い', [{ url: URL_SLOW, name: 'slow', extension: 'bin' }]);
    let slowRequests = 0;
    const slowRoute = async (route: Route, url: string): Promise<boolean> => {
      if (url !== URL_SLOW) return false;
      slowRequests++;
      // 応答ヘッダを返さずに待たせる。この間にキャンセルされ、service worker 側の fetch が abort されれば
      // fulfill は失敗する (リクエストが既に無い) ので握りつぶす
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      await route.fulfill({ status: 200, body: 'late' }).catch(() => {});
      return true;
    };

    const session = await launchAndStartDownload(
      {
        [PLANS_URL]: PLANS_RESPONSE,
        [TAGS_URL]: TAGS_RESPONSE,
        [PAGINATE_URL]: PAGINATE_RESPONSE,
        [LIST_PAGE_URL]: { body: { posts: [post.stub] } },
        [post.infoUrl]: post.info,
      },
      'cancel',
      { routeOverride: slowRoute },
    );
    const { page, overlay, serviceWorker } = session;
    try {
      // ZIP フェーズに入り、service worker 側で fetch が進行中 (応答ヘッダ待ち) になるまで待つ
      await expect
        .poll(() => page.evaluate(readTestState), { timeout: 30_000 })
        .toMatchObject({ overlayState: 'downloading' });
      await expect.poll(() => readSwState(serviceWorker), { timeout: 30_000 }).toMatchObject({ activeStreams: 1 });
      expect(slowRequests).toBe(1);

      // ZIP フェーズ (downloading 状態) の中断ボタンは「ここまでで終了」
      await overlay.getByRole('button', { name: 'ここまでで終了' }).click();

      // 中断 → content script が Port を切断 → service worker が fetch を abort → ストリーム終了。
      // fetch が abort されていなければ、応答は 20 秒後まで返らないので activeStreams は 1 のまま残る
      await expect
        .poll(() => readSwState(serviceWorker), { timeout: 10_000 })
        .toMatchObject({ activeStreams: 0, disconnectedStreams: 1, finishedStreams: 0 });
      await expect
        .poll(() => page.evaluate(readTestState), { timeout: 10_000 })
        .toMatchObject({ overlayState: 'complete', aborted: '1' });
      // 中断後に取得をやり直していない (fetchWithRetry は中断されたら再試行しない)
      expect(slowRequests).toBe(1);
    } finally {
      await closeSession(session);
    }
  });
});
