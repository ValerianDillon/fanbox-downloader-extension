/**
 * smoke test 専用の最小 ZIP パーサ。
 *
 * download-helper の ZipWriter (node_modules/download-helper/download-helper.ts) が書き出す
 * stored (非圧縮) ZIP を読めれば十分なので、圧縮方式のデコードなどは実装しない。
 * 参考: test/downloader.test.ts の parseLocalEntries (Local File Header を走査する簡易パーサ)。
 * こちらは Central Directory / EOCD を読むため、e2e で「壊れていない ZIP か」の検証も兼ねる。
 */

const LFH_SIGNATURE = 0x04034b50;
const CD_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;

export type ZipEntry = {
  name: string;
};

export type ParsedZip = {
  entries: ZipEntry[];
};

/**
 * base64 文字列を Uint8Array にデコードする (Node の atob はブラウザ互換のグローバル)
 */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 先頭 4 バイトが Local File Header シグネチャ (`PK\x03\x04`) かどうか
 */
export function hasLocalFileHeaderSignature(buf: Uint8Array): boolean {
  if (buf.length < 4) return false;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getUint32(0, true) === LFH_SIGNATURE;
}

/**
 * EOCD (End of Central Directory) レコードの開始オフセットを末尾から探索する。
 * コメント長がファイル末尾までのバイト数と一致するものだけを EOCD として受理する
 * (ファイルデータの中に偶然シグネチャと同じバイト列が出現する誤検出を防ぐ)。
 */
function findEocdOffset(buf: Uint8Array): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const searchStart = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (view.getUint32(i, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(i + 20, true);
    if (i + EOCD_MIN_SIZE + commentLength === buf.length) {
      return i;
    }
  }
  throw new Error('EOCD レコードが見つからない (ZIP として不正)');
}

/**
 * ZIP バッファを Central Directory 経由でパースし、エントリ名一覧を返す。
 * EOCD の central directory offset/size がファイル範囲内に収まっているか、
 * 各エントリの Local File Header シグネチャが妥当かも検証する (壊れた ZIP を検出する)。
 */
export function parseZip(buf: Uint8Array): ParsedZip {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocdOffset = findEocdOffset(buf);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (cdOffset > eocdOffset || cdOffset + cdSize !== eocdOffset) {
    throw new Error(
      `central directory の offset/size が EOCD と整合しない (cd=${cdOffset}+${cdSize}, eocd=${eocdOffset})`,
    );
  }

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || view.getUint32(pos, true) !== CD_SIGNATURE) {
      throw new Error(`central directory entry ${i} のシグネチャが不正 (pos=${pos})`);
    }
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    if (localHeaderOffset + 4 > buf.length || view.getUint32(localHeaderOffset, true) !== LFH_SIGNATURE) {
      throw new Error(`central directory entry ${i} が参照する Local File Header が不正 (offset=${localHeaderOffset})`);
    }

    const nameStart = pos + 46;
    const name = decoder.decode(buf.slice(nameStart, nameStart + nameLength));
    entries.push({ name });
    pos = nameStart + nameLength + extraLength + commentLength;
  }

  if (pos !== cdOffset + cdSize) {
    throw new Error(
      `central directory のサイズが実際のエントリ合計と一致しない (expected end=${cdOffset + cdSize}, got=${pos})`,
    );
  }

  return { entries };
}
