import { uint8ArrayToBase64 } from '../base64';
import {
  CHUNK_BYTES,
  FLUSH_INTERVAL_MS,
  type MediaStreamMessage,
  type MediaStreamRequest,
} from '../media-stream-protocol';

/**
 * chrome.runtime.Port のうち、この処理が使う部分だけを切り出した型。
 * ユニットテストから chrome のグローバルスタブなしにフェイクを渡せるようにするため
 * (handlers.ts が chrome.* を参照しないのと同じ理由)。
 */
export type MediaStreamPort = {
  postMessage(message: MediaStreamMessage): void;
  onDisconnect: { addListener(callback: () => void): void };
};

/** streamMedia が依存する外部 I/O。テストで差し替える */
export type MediaStreamDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** 各 chunk の送信直前に呼ばれる観測フック (テストビルドの状態公開・切断シミュレーション用)。省略可 */
  onChunkSent?: (info: { url: string; sentBytes: number }) => void;
  /** 定期 flush の間隔 (ミリ秒)。省略時は FLUSH_INTERVAL_MS。テストで短くする */
  flushIntervalMs?: number;
  /** setInterval / clearInterval の差し替え (テスト用)。省略時はグローバル */
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
};

const defaultDeps: MediaStreamDeps = {
  fetch: (input, init) => fetch(input, init),
};

/**
 * `start` 要求 1 つぶんのメディア取得を Port 上に流す (Issue #22)。
 *
 * - `head` を必ず 1 度送る。fetch() 自体の失敗 (通信障害) は ok:false, status:0 で表し、fetchApi と揃える
 * - ok な応答は本文を逐次読み、CHUNK_BYTES 溜まったら `chunk` を送る。加えて FLUSH_INTERVAL_MS ごとに
 *   実時間タイマーで溜まっているぶんを flush する (read() が長時間ブロックしても、溜まっているデータを
 *   送って service worker の idle timer をリセットするため。read() が返った時だけ時間を見る方式では、
 *   次の read() が 30 秒以上返らないと flush されず service worker が停止しうる)
 * - 本文を読み切ったら `end` を送る。読み込み中に失敗したら `error` を送る
 * - Port が切断されたら (content script のキャンセル/タブ閉鎖) fetch を abort し、以後は何も送らない
 *
 * 自分からは Port を切らない (理由は media-stream-protocol.ts の冒頭コメント参照)。
 *
 * この関数は throw しない。想定外の例外も `error` (head 送信前なら ok:false の `head`) として Port に流す。
 * ここで reject して onConnect の配線側に伝播しても受け取り手がおらず、content script は終端が来ないまま
 * 待ち続けることになるため (service-worker.ts の onMessage 側と同じ考え方)。
 *
 * メモリ: 本文全体は保持しない。溜めるのは chunk 1 つぶん (CHUNK_BYTES) まで。base64 化した文字列は
 * postMessage に渡した後は参照を持たない。
 */
export async function streamMedia(
  port: MediaStreamPort,
  request: MediaStreamRequest,
  deps: MediaStreamDeps = defaultDeps,
): Promise<void> {
  const controller = new AbortController();
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    controller.abort();
  });
  const post = (message: MediaStreamMessage) => {
    if (disconnected) return;
    try {
      port.postMessage(message);
    } catch (e) {
      // 切断済みの Port への postMessage は投げる (onDisconnect の配送前にここで気付く場合がある)。
      // それ以外の理由 (想定外のシリアライズ失敗など) の可能性もあるので、1 度だけ error を送ってみて、
      // それも投げるなら切断済みとみなす。いずれにせよ以後は送らず fetch を止める
      // (content script 側は error か onDisconnect のどちらかを必ず観測できる)
      disconnected = true;
      controller.abort();
      if (message.type !== 'error') {
        try {
          port.postMessage({ type: 'error', error: `postMessage failed: ${String(e)}` });
        } catch {
          // 切断済み。content script 側には onDisconnect が届く
        }
      }
      console.warn('メディア転送先の Port へ送信できなかったため転送を打ち切ります:', e);
    }
  };

  let r: Response;
  try {
    const headers: Record<string, string> = {};
    if (request.offset > 0) {
      headers.Range = `bytes=${request.offset}-`;
      // 切断中に中身が差し替わっていたら、サーバは If-Range 不一致で 206 ではなく 200 (全体) を返す。
      // content script 側はそれを受けて先頭から取り直す (旧本文 prefix + 新本文 suffix の結合を防ぐ)
      if (request.ifRange) headers['If-Range'] = request.ifRange;
    }
    r = await deps.fetch(request.url, { credentials: 'include', signal: controller.signal, headers });
  } catch (e) {
    // fetch() 自体の失敗 (実際の通信障害)、または切断による abort。後者は送っても届かないので post が捨てる
    post({
      type: 'head',
      ok: false,
      status: 0,
      retryAfter: null,
      contentLength: null,
      contentRange: null,
      etag: null,
      lastModified: null,
      error: String(e),
    });
    return;
  }

  const retryAfter = r.headers.get('Retry-After');
  const contentLengthHeader = r.headers.get('Content-Length');
  const contentLength =
    contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader.trim())
      ? Number.parseInt(contentLengthHeader, 10)
      : null;
  post({
    type: 'head',
    ok: r.ok,
    status: r.status,
    retryAfter,
    contentLength,
    contentRange: r.headers.get('Content-Range'),
    etag: r.headers.get('ETag'),
    lastModified: r.headers.get('Last-Modified'),
  });
  if (!r.ok) {
    // 本文は読まずに捨てる。HTTP エラーの本文を content script に転送する用途はない
    try {
      await r.body?.cancel();
    } catch {
      // 既に閉じている等。観測結果 (head) は送信済みなので無視してよい
    }
    return;
  }
  if (!r.body) {
    // 空の本文 (204 等、あるいは環境によって body が null になる 0 バイト応答)
    post({ type: 'end', bytes: 0 });
    return;
  }

  const reader = r.body.getReader();
  /** 未送信の本文断片。合計が CHUNK_BYTES に達したら先頭から CHUNK_BYTES ちょうどを切り出して送る */
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let sentBytes = 0;

  /**
   * pending の先頭から size バイトを 1 つの Uint8Array に切り出す (size <= pendingBytes)。
   * 1 メッセージの生バイト数を CHUNK_BYTES 以下に保つため、read() が返す断片の大きさに依存しない
   * (ローカルのモックサーバや高速な回線では 1 回の read() で数十 MiB が返りうる。そのまま送ると
   * base64 化後に runtime messaging の 64 MiB 上限に当たる)。
   */
  const take = (size: number): Uint8Array => {
    if (pending.length === 1 && pending[0].length === size) {
      const only = pending[0];
      pending.length = 0;
      pendingBytes = 0;
      return only;
    }
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const head = pending[0];
      const need = size - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        pending.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        pending[0] = head.subarray(need);
        filled += need;
      }
    }
    pendingBytes -= size;
    return out;
  };

  const send = (bytes: Uint8Array) => {
    sentBytes += bytes.length;
    deps.onChunkSent?.({ url: request.url, sentBytes });
    post({ type: 'chunk', data: uint8ArrayToBase64(bytes) });
  };

  /** CHUNK_BYTES 単位で送れるだけ送る。force なら端数も送る */
  const flush = (force: boolean) => {
    while (pendingBytes >= CHUNK_BYTES && !disconnected) {
      send(take(CHUNK_BYTES));
    }
    if (force && pendingBytes > 0 && !disconnected) {
      send(take(pendingBytes));
    }
  };

  // 実時間タイマーで定期 flush する。read() が長時間ブロックしても、溜まっているぶんを送って
  // service worker の idle timer をリセットする (post は同期・非再入なので read ループとの競合はない)。
  const setIntervalFn = deps.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalFn = deps.clearInterval ?? ((id) => clearInterval(id));
  const flushIntervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const timer = setIntervalFn(() => {
    if (!disconnected) flush(true);
  }, flushIntervalMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (disconnected) return;
      if (done) break;
      if (value.length === 0) continue;
      pending.push(value);
      pendingBytes += value.length;
      if (pendingBytes >= CHUNK_BYTES) flush(false);
      if (disconnected) return;
    }
    flush(true);
    post({ type: 'end', bytes: sentBytes });
  } catch (e) {
    if (disconnected) return;
    post({ type: 'error', error: String(e) });
    try {
      await reader.cancel();
    } catch {
      // 既に閉じている等
    }
  } finally {
    clearIntervalFn(timer);
  }
}
