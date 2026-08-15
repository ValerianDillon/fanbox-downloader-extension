/**
 * メディア取得 (downloads.fanbox.cc / *.pximg.net) を service worker 経由で分割転送するための
 * Port プロトコル (Issue #22)。
 *
 * content script と service worker は別バンドルだが、このモジュールはワイヤ契約そのものなので
 * 両側から import する (api.ts / downloader.ts が応答型をローカルに持つのは「片側の実装都合で
 * もう片側の型定義まで追随を強制されない」ためだが、ここは片側だけ変えられない契約であり、
 * 二重に持つと乖離したときに検出できない)。
 *
 * 単発の `chrome.runtime.sendMessage` で本文全体を base64 で返す従来方式は、メッセージサイズ上限
 * (64 MiB) に base64 の 4/3 膨張込みで当たり、約 48 MiB 以上のファイルが必ず失敗していた。
 * Port 上で本文を chunk に分けて送れば 1 メッセージあたりのサイズは CHUNK_BYTES × 4/3 に収まり、
 * ファイルサイズ自体には上限を持たない。
 *
 * 流れ (1 Port = 1 回の取得試行):
 *
 * ```
 * content ── connect({ name: MEDIA_PORT_NAME }) ──▶ service worker
 * content ── { type: 'start', url, offset } ──────▶ fetch (offset > 0 なら Range 付き)
 * content ◀── { type: 'head', ok, status, ... } ── 応答ヘッダの観測結果
 * content ◀── { type: 'chunk', data } × N ──────── 本文 (base64、CHUNK_BYTES ごと)
 * content ◀── { type: 'end', bytes } ───────────── 本文終端
 * content ── disconnect() ────────────────────────▶ 後片付け
 * ```
 *
 * 終端 (`head` の ok:false / `end` / `error`) を送るのは常に service worker で、Port を切るのは常に
 * content script である。service worker 側から postMessage 直後に disconnect すると最後のメッセージが
 * 届く前に切断されうるため、service worker は自分からは切らない。content script が終端を受け取る前に
 * onDisconnect を観測したら、それは service worker の停止 (MV3 の service worker はいつでも停止しうる)
 * か拡張の再読み込みであり、`offset` を進めた `start` で再開を試みる。
 */

export const MEDIA_PORT_NAME = 'fbdl-media';

/**
 * 1 メッセージに載せる本文の生バイト数。base64 化で 4/3 になるため 1 メッセージは約 10.7 MiB になり、
 * runtime messaging の上限 (64 MiB) に対して十分な余裕がある。
 *
 * 大きくするほどメッセージ数 (往復の JSON シリアライズ回数) は減るが、service worker / content script の
 * 両側で chunk 1 つぶんの一時バッファ (生 + base64) がピークメモリに乗る。
 */
export const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 本文の到着が遅くても、この間隔で溜まっているぶんを送る (ミリ秒)。
 *
 * MV3 の service worker は 30 秒の無活動で停止し、Port 上のメッセージ送受信がその idle timer を
 * リセットする (Chrome 114 以降。Port を開いているだけではリセットされない)。低速回線で CHUNK_BYTES が
 * 溜まるまで 30 秒以上かかると、転送中に service worker が停止してしまうため、chunk が満たなくても
 * 定期的に送って活動を示す。
 */
export const FLUSH_INTERVAL_MS = 2000;

/** content script → service worker。connect 直後に 1 度だけ送る */
export type MediaStreamRequest = {
  type: 'start';
  url: string;
  /**
   * 再開時に既に受け取っているバイト数。0 より大きければ service worker は `Range: bytes=<offset>-` を付けて
   * fetch する。サーバが Range を無視して 200 を返した場合の扱いは content script 側の責務
   * (受信済みのぶんを捨てて先頭から受け直す)。
   */
  offset: number;
};

/** 応答ヘッダの観測結果。fetch() 自体の失敗 (通信障害) は ok:false, status:0 で表す */
export type MediaStreamHead = {
  type: 'head';
  ok: boolean;
  status: number;
  retryAfter: string | null;
  /** Content-Length (数値として読めなければ null)。Range 応答 (206) では残りの長さになる */
  contentLength: number | null;
  /** Content-Range ヘッダの生の値。206 のときの再開位置の検証に使う */
  contentRange: string | null;
  error?: string;
};

export type MediaStreamChunk = {
  type: 'chunk';
  /** base64。chunk ごとに独立してデコードできる (chunk 境界を 3 バイトの倍数に揃える必要はない) */
  data: string;
};

/** 本文終端。`bytes` はこの Port 上で送った本文の生バイト数の合計 (content script 側の受信数と突き合わせる) */
export type MediaStreamEnd = {
  type: 'end';
  bytes: number;
};

/** 本文の読み込み中の失敗。head は既に送っているので status は content script 側が保持している */
export type MediaStreamError = {
  type: 'error';
  error: string;
};

export type MediaStreamMessage = MediaStreamHead | MediaStreamChunk | MediaStreamEnd | MediaStreamError;

/**
 * Content-Range (`bytes <start>-<end>/<total|*>`) を解釈する。形式が読めなければ null。
 * 206 応答の再開位置が要求した offset と一致するかを content script 側で検証するために使う。
 */
export function parseContentRange(header: string | null): { start: number; end: number; total: number | null } | null {
  if (!header) return null;
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/.exec(header);
  if (!m) return null;
  return {
    start: Number.parseInt(m[1], 10),
    end: Number.parseInt(m[2], 10),
    total: m[3] === '*' ? null : Number.parseInt(m[3], 10),
  };
}
