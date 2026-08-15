import {
  MEDIA_PORT_NAME,
  type MediaStreamMessage,
  type MediaStreamRequest,
  parseContentRange,
} from '../media-stream-protocol';

/**
 * chrome.runtime.Port のうち content script 側の受信処理が使う部分。
 * ユニットテストでは chrome.runtime.connect をこの形のフェイクを返す関数に差し替える。
 */
export type MediaClientPort = {
  postMessage(message: MediaStreamRequest): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
};

export type MediaFetchDeps = {
  /** 既定は chrome.runtime.connect({ name: MEDIA_PORT_NAME }) */
  connect: () => MediaClientPort;
  /** 無応答の打ち切りまでのミリ秒。既定は STALL_TIMEOUT_MS (テストで短くする) */
  stallTimeoutMs?: number;
};

const defaultDeps: MediaFetchDeps = {
  connect: () => chrome.runtime.connect({ name: MEDIA_PORT_NAME }),
};

/**
 * Port 上でこの時間メッセージが来なければ、service worker 側が黙って止まったとみなして打ち切る (ミリ秒)。
 *
 * 正常系では service worker は本文が流れている限り FLUSH_INTERVAL_MS ごとに chunk を送り、停止すれば
 * onDisconnect が届くので、この watchdog に頼る経路は本来ない。応答ヘッダ待ちが長引く場合も、MV3 の
 * service worker は fetch の応答が 30 秒以内に届かないと停止するため onDisconnect の側で観測できる。
 * これは「service worker は生きているが何も送ってこない」想定外の状態で content script が永久に
 * 待ち続けないための backstop であり、通常の待ち時間 (数秒〜十数秒) を大きく上回る値にしている。
 */
export const STALL_TIMEOUT_MS = 60_000;

/**
 * 1 回の取得の結果。
 *
 * - blob が非 null なら成功 (本文を最後まで受け取り、長さの整合も取れた)
 * - blob が null なら失敗。status は観測できた HTTP ステータス (応答ヘッダに届かなかった通信失敗は 0)
 */
export type MediaFetchResult = { blob: Blob | null; status: number; retryAfter: string | null };

/**
 * 終端に到達する前に service worker 側との接続が切れたときに、Range で続きを要求する回数の上限。
 *
 * MV3 の service worker は転送中でも停止しうる (30 秒無活動など) ため、切断そのものは異常ではない。
 * ただし切断が続くようなら (回線が不安定、Range を返さないサーバで毎回先頭からやり直しになる等)
 * 打ち切って失敗として報告し、上位 (fetchWithRetry) の再試行に委ねる。
 */
export const MAX_RESUMES = 3;

/** 1 Port ぶんの受信結果 (内部用) */
type StreamOutcome =
  | { kind: 'complete'; status: number; retryAfter: string | null }
  | { kind: 'http'; status: number; retryAfter: string | null }
  | { kind: 'transport'; status: number; retryAfter: string | null }
  | { kind: 'aborted' };

/**
 * service worker 経由でメディアを取得し、Port で分割転送された本文を Blob に組み立てる (Issue #22)。
 *
 * 戻り値が null なのは signal による中断のみ。中断時は Port を切断し、service worker 側はそれを受けて
 * fetch を abort する (Issue #22 の受け入れ条件: キャンセル時に service worker 側の fetch も止まる)。
 * それ以外 (HTTP エラー、通信失敗、切断が続いて諦めた) は blob: null と観測済みの status を返す。
 *
 * 再開: 終端 (`end`) より前に Port が切れたら、受信済みバイト数を offset にして新しい Port で `start` を送る。
 * - 206 かつ Content-Range の開始が offset と一致 → 続きとして受け取る
 * - 200 (サーバが Range を無視) → 受信済みのぶんを捨てて先頭から受け直す
 * - それ以外 (416 等) → HTTP 失敗として報告する
 *
 * 整合性: 本文の総バイト数は、初回応答の Content-Length (あれば)、および各 Port の `end.bytes` と
 * 突き合わせる。どちらかが合わなければ通信失敗 (transport) として扱い、成功とは報告しない
 * (欠けたファイルを完了として ZIP に入れないため)。
 *
 * メモリ: chunk ごとに Blob 化して配列に持ち、最後に 1 つの Blob に結合する。JS ヒープに本文全体を
 * 置かない (Blob の実体はブラウザ側で管理され、必要ならディスクに退避される)。
 */
export async function fetchMediaViaPort(
  url: string,
  signal: AbortSignal | undefined,
  deps: MediaFetchDeps = defaultDeps,
): Promise<MediaFetchResult | null> {
  const parts: Blob[] = [];
  let received = 0;
  /** 初回応答の Content-Length (不明なら null)。再開時の 206 の Content-Range total とも突き合わせる */
  let expectedTotal: number | null = null;
  let resumes = 0;

  while (true) {
    if (signal?.aborted) return null;
    const outcome = await streamOnce(url, received, signal, deps, {
      onHead: (total) => {
        if (expectedTotal === null) expectedTotal = total;
      },
      onRestart: () => {
        parts.length = 0;
        received = 0;
        expectedTotal = null;
      },
      onChunk: (bytes) => {
        parts.push(new Blob([bytes]));
        received += bytes.length;
      },
      expectedTotal: () => expectedTotal,
    });
    switch (outcome.kind) {
      case 'aborted':
        return null;
      case 'complete':
        return { blob: new Blob(parts), status: outcome.status, retryAfter: outcome.retryAfter };
      case 'http':
        return { blob: null, status: outcome.status, retryAfter: outcome.retryAfter };
      case 'transport':
        if (received > 0 && resumes < MAX_RESUMES) {
          resumes++;
          console.warn(
            `メディア転送が途中で切断されたため ${received} バイト目から再開します (${resumes}/${MAX_RESUMES}): ${url}`,
          );
          continue;
        }
        return { blob: null, status: outcome.status, retryAfter: outcome.retryAfter };
    }
  }
}

type StreamCallbacks = {
  onHead: (total: number | null) => void;
  onRestart: () => void;
  onChunk: (bytes: Uint8Array<ArrayBuffer>) => void;
  expectedTotal: () => number | null;
};

/** 1 つの Port で `start` を送り、終端か切断まで受信する */
function streamOnce(
  url: string,
  offset: number,
  signal: AbortSignal | undefined,
  deps: MediaFetchDeps,
  callbacks: StreamCallbacks,
): Promise<StreamOutcome> {
  return new Promise<StreamOutcome>((resolve) => {
    let port: MediaClientPort;
    try {
      port = deps.connect();
    } catch (e) {
      // 拡張の再読み込み後などで runtime に接続できない (Extension context invalidated)
      console.error(`メディア取得の Port を開けませんでした: ${url}`, e);
      resolve({ kind: 'transport', status: 0, retryAfter: null });
      return;
    }

    let settled = false;
    let status = 0;
    let retryAfter: string | null = null;
    /** この Port で受け取った本文バイト数 (end.bytes と突き合わせる) */
    let portBytes = 0;
    let headSeen = false;
    /** この Port の本文が全体のどこから始まるか。Range を無視された (200) ときは 0 に戻る */
    let baseOffset = offset;

    const stallTimeoutMs = deps.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStallTimer = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        console.error(`メディア転送が ${stallTimeoutMs} ms 無応答のため打ち切ります: ${url}`);
        finish({ kind: 'transport', status, retryAfter });
      }, stallTimeoutMs);
    };

    const finish = (outcome: StreamOutcome) => {
      if (settled) return;
      settled = true;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      signal?.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch {
        // 既に切れている
      }
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: 'aborted' });

    port.onDisconnect.addListener(() => {
      // 終端を受け取る前の切断 = service worker の停止か拡張の再読み込み。head 未受信なら status 0
      finish({ kind: 'transport', status, retryAfter });
    });
    port.onMessage.addListener((raw: unknown) => {
      if (settled) return;
      armStallTimer();
      const message = raw as MediaStreamMessage;
      switch (message.type) {
        case 'head': {
          headSeen = true;
          status = Number.isFinite(message.status) ? message.status : 0;
          retryAfter = typeof message.retryAfter === 'string' ? message.retryAfter : null;
          if (!message.ok) {
            // fetch() 自体の失敗 (status 0) は transport、HTTP エラーは http
            finish(status === 0 ? { kind: 'transport', status, retryAfter } : { kind: 'http', status, retryAfter });
            return;
          }
          if (offset > 0) {
            if (status === 206) {
              const range = parseContentRange(message.contentRange);
              const expected = callbacks.expectedTotal();
              if (
                !range ||
                range.start !== offset ||
                (expected !== null && range.total !== null && range.total !== expected)
              ) {
                // 要求した位置から始まっていない、または総量が初回と食い違う 206 は信用できない。
                // 受信済みのぶんも捨てる (どこまでが正しいか分からないため)。上位の再試行に委ねる
                console.warn(
                  `Range 再開の応答が要求と一致しないため受信済みデータを破棄します: ${url}`,
                  message.contentRange,
                );
                callbacks.onRestart();
                finish({ kind: 'transport', status, retryAfter });
                return;
              }
            } else {
              // 200: サーバが Range を無視して全体を返した。受信済みのぶんを捨てて先頭から受け直す
              callbacks.onRestart();
              baseOffset = 0;
              callbacks.onHead(message.contentLength);
            }
          } else {
            callbacks.onHead(message.contentLength);
          }
          return;
        }
        case 'chunk': {
          if (!headSeen) return;
          let bytes: Uint8Array<ArrayBuffer>;
          try {
            bytes = decodeBase64(message.data);
          } catch (e) {
            console.error(`メディア転送の chunk をデコードできませんでした: ${url}`, e);
            finish({ kind: 'transport', status, retryAfter });
            return;
          }
          portBytes += bytes.length;
          callbacks.onChunk(bytes);
          return;
        }
        case 'end': {
          if (!headSeen) return;
          const expected = callbacks.expectedTotal();
          const totalReceived = baseOffset + portBytes;
          if (message.bytes !== portBytes) {
            console.error(`メディア転送のバイト数が一致しません (送信 ${message.bytes} / 受信 ${portBytes}): ${url}`);
            finish({ kind: 'transport', status, retryAfter });
            return;
          }
          if (expected !== null && totalReceived !== expected) {
            console.error(
              `メディアの長さが Content-Length と一致しません (期待 ${expected} / 受信 ${totalReceived}): ${url}`,
            );
            finish({ kind: 'transport', status, retryAfter });
            return;
          }
          finish({ kind: 'complete', status, retryAfter });
          return;
        }
        case 'error': {
          console.error(`service worker 側でメディア本文の読み込みに失敗しました: ${url}`, message.error);
          finish({ kind: 'transport', status, retryAfter });
          return;
        }
        default:
          return;
      }
    });

    if (signal) {
      if (signal.aborted) {
        finish({ kind: 'aborted' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      port.postMessage({ type: 'start', url, offset });
      armStallTimer();
    } catch (e) {
      console.error(`メディア取得の要求を送れませんでした: ${url}`, e);
      finish({ kind: 'transport', status: 0, retryAfter: null });
    }
  });
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
