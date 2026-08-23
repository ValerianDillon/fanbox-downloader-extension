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
 * 初回応答の ETag / Last-Modified を `If-Range` として渡すため、切断中に中身が差し替わっていたら
 * サーバは 200 (全体) を返し、先頭から取り直す (旧本文 prefix + 新本文 suffix の結合を防ぐ)。
 * - 206 かつ Content-Range が要求 offset と一致 → 続きとして受け取り、Content-Range の total を全体長に採用する
 * - 200 (サーバが Range を無視 / If-Range 不一致) → 受信済みのぶんを捨てて先頭から受け直す
 * - それ以外の成功 (204 等) や不一致な 206 → 失敗として上位の再試行に委ねる
 *
 * `downloads.fanbox.cc` は Range に対応する (206 + `Accept-Ranges: bytes`) が ETag も Last-Modified も
 * 返さない (実測 2026-08-16)。そのため実サイトでは validator 無しの分岐に入り、Range 再開は行われず
 * 先頭からの取り直しになる。正しさは保たれ、切断時の効率だけが下がる。
 *
 * 整合性: 全体長は初回の Content-Length か 206 の Content-Range total から得る。得られた場合は最終的な
 * 受信合計と突き合わせ、一致しなければ成功にしない。全体長が最後まで不明なまま終端を受けた場合は、
 * 先頭から一度も途切れず受け切った (baseOffset === 0) ときだけ成功とみなす (途中から再開したのに
 * 全体長を確認できないケースは、欠落を検出できないので成功にしない)。各 Port の `end.bytes` も
 * 受信数と突き合わせる。いずれの不一致も通信失敗 (transport) として扱い、欠けたファイルを ZIP に入れない。
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
  /** 全体長 (不明なら null)。初回の Content-Length か 206 の Content-Range total から確定する */
  let expectedTotal: number | null = null;
  /** 直近の応答の representation validator (strong ETag 優先、なければ Last-Modified)。再開時の If-Range に使う */
  let validator: string | null = null;
  /** Range 再開が成立するか。非 identity Content-Encoding の応答では false (展開後バイト数で offset を数えられない) */
  let resumable = true;
  let resumes = 0;

  const discard = () => {
    parts.length = 0;
    received = 0;
    expectedTotal = null;
  };

  while (true) {
    if (signal?.aborted) return null;
    const outcome = await streamOnce(url, received, validator, signal, deps, {
      setExpectedTotal: (total) => {
        expectedTotal = total;
      },
      getExpectedTotal: () => expectedTotal,
      // 応答ごとに validator を置き換える (200 restart で表現が変わったら新しい方を採る)。
      // 呼ぶのは初回応答と 200 restart のときだけで、206 継続時は呼ばない (初回の validator を保つ)。
      setValidator: (v) => {
        validator = v;
      },
      setResumable: (r) => {
        resumable = r;
      },
      onRestart: discard,
      onChunk: (bytes) => {
        parts.push(new Blob([bytes]));
        received += bytes.length;
      },
    });
    switch (outcome.kind) {
      case 'aborted':
        return null;
      case 'complete':
        return { blob: new Blob(parts), status: outcome.status, retryAfter: outcome.retryAfter };
      case 'http':
        return { blob: null, status: outcome.status, retryAfter: outcome.retryAfter };
      case 'transport':
        // received === 0 は資すべき受信が無く、offset 0 からの取り直しは fetchWithRetry の再試行と同じなので、
        // ここでは重ねて回さず失敗を返す。
        if (received > 0 && resumes < MAX_RESUMES) {
          resumes++;
          if (validator === null || !resumable) {
            // validator が無いと Range 再開は世代混在 (旧 prefix + 新 suffix) を検出できず、
            // 非 identity Content-Encoding では offset (展開後バイト数) が符号化表現に対する Range と
            // 対応しない。どちらの場合も受信済みを捨てて先頭から取り直す
            // (単一ストリームは常に単一表現なので混在しない)。
            discard();
            console.warn(`Range 再開できないため先頭から取り直します (${resumes}/${MAX_RESUMES}): ${url}`);
          } else {
            console.warn(
              `メディア転送が切断されたため ${received} バイト目から再開します (${resumes}/${MAX_RESUMES}): ${url}`,
            );
          }
          continue;
        }
        return { blob: null, status: outcome.status, retryAfter: outcome.retryAfter };
    }
  }
}

/**
 * If-Range に使える representation validator を選ぶ。
 * strong ETag のみ使える (weak ETag `W/...` は If-Range に使えない。RFC 9110 §13.1.5)。
 * strong ETag が無ければ Last-Modified を使う (サーバは exact match で判定する)。
 */
function pickValidator(etag: string | null, lastModified: string | null): string | null {
  if (typeof etag === 'string' && etag.length > 0 && !etag.startsWith('W/')) return etag;
  if (typeof lastModified === 'string' && lastModified.length > 0) return lastModified;
  return null;
}

type StreamCallbacks = {
  /** 全体長を確定する (初回の Content-Length / 206 の Content-Range total) */
  setExpectedTotal: (total: number) => void;
  getExpectedTotal: () => number | null;
  /** validator を記録する (初回応答と 200 restart のときだけ呼ばれる。206 継続時は呼ばれない) */
  setValidator: (validator: string | null) => void;
  /** Range 再開が成立するか (非 identity Content-Encoding では false)。初回応答と 200 restart で確定する */
  setResumable: (resumable: boolean) => void;
  onRestart: () => void;
  onChunk: (bytes: Uint8Array<ArrayBuffer>) => void;
};

/** 1 つの Port で `start` を送り、終端か切断まで受信する */
function streamOnce(
  url: string,
  offset: number,
  ifRange: string | null,
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
    /** この Port が運ぶべき本文長 (206 の Content-Range 幅 / 200 の Content-Length)。不明なら null */
    let portExpected: number | null = null;

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
          const respValidator = pickValidator(message.etag, message.lastModified);
          // fetch() の body は Content-Encoding を展開済みだが、Content-Length は符号化後の長さを指す。
          // 非 identity の応答では Content-Length を受信バイト数の照合に使えず、また Range は符号化表現に
          // 適用されるため、展開後バイト数で数えた offset での再開も成立しない。
          const identityEncoding =
            message.contentEncoding === null ||
            message.contentEncoding === undefined ||
            message.contentEncoding.trim().toLowerCase() === 'identity';
          // この応答で数えられる本文長 (非 identity では使えない)
          const usableLength = identityEncoding ? message.contentLength : null;
          if (offset > 0) {
            if (status === 206) {
              const range = parseContentRange(message.contentRange);
              const expected = callbacks.getExpectedTotal();
              // 要求した位置から始まっているか、範囲が正か、範囲が total に収まるか、Content-Length が
              // Content-Range の幅と整合するか、total が既知の全体長と食い違わないか。
              // いずれも満たさない 206 は信用しない。
              const rangeOk =
                range !== null &&
                range.start === offset &&
                range.end >= range.start &&
                (range.total === null || range.end < range.total) &&
                (usableLength === null || usableLength === range.end - range.start + 1) &&
                !(range.total !== null && expected !== null && range.total !== expected);
              if (!rangeOk || !identityEncoding) {
                // 非 identity の 206 も拒否する: offset は展開後バイト数で数えており、符号化表現に対する
                // Range 応答とは対応しない。受信済みのぶんも捨てる (どこまでが正しいか分からないため)
                console.warn(
                  `Range 再開の応答が要求と一致しないため受信済みデータを破棄します: ${url}`,
                  message.contentRange,
                );
                callbacks.onRestart();
                finish({ kind: 'transport', status, retryAfter });
                return;
              }
              // 206 継続時は validator を更新しない (初回に確定した validator を保つ)。
              // この Port が運ぶべき本文長は Content-Range の幅で確定する (Content-Length が無くても)。
              // 終端時に portBytes と照合し、宣言より多い/少ない本文を成功にしない
              portExpected = range.end - range.start + 1;
              // Content-Range total が得られたら全体長として採用する (初回に Content-Length が無くても
              // ここで確定でき、終端時の欠落検出が効くようになる)
              if (range.total !== null) callbacks.setExpectedTotal(range.total);
            } else if (status === 200) {
              // サーバが Range を無視 (または If-Range 不一致で内容が変わった) ため全体を返した。先頭から
              // 受け直し、validator も新しい representation のものへ置き換える (旧 validator を使い続けると
              // 再切断のたびに 200 が返り MAX_RESUMES まで先頭からやり直しになる)
              callbacks.onRestart();
              baseOffset = 0;
              callbacks.setValidator(respValidator);
              callbacks.setResumable(identityEncoding);
              if (usableLength !== null) {
                callbacks.setExpectedTotal(usableLength);
                portExpected = usableLength;
              }
            } else {
              // 206/200 以外の成功 (204 等) は Range 再開として解釈できない。失敗として扱う
              console.warn(`Range 再開に想定外の成功ステータス (${status}) が返りました: ${url}`);
              finish({ kind: 'transport', status, retryAfter });
              return;
            }
          } else {
            // 初回応答は Range を付けていないので 200 が正常。204 や (要求していない) 部分 206 は、
            // 全体を受け取れたか保証できないので成功にしない
            if (status !== 200) {
              console.warn(`初回応答が 200 以外の成功ステータス (${status}) でした: ${url}`);
              finish({ kind: 'transport', status, retryAfter });
              return;
            }
            callbacks.setValidator(respValidator);
            callbacks.setResumable(identityEncoding);
            if (usableLength !== null) {
              callbacks.setExpectedTotal(usableLength);
              portExpected = usableLength;
            }
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
          const expected = callbacks.getExpectedTotal();
          const totalReceived = baseOffset + portBytes;
          if (message.bytes !== portBytes) {
            console.error(`メディア転送のバイト数が一致しません (送信 ${message.bytes} / 受信 ${portBytes}): ${url}`);
            finish({ kind: 'transport', status, retryAfter });
            return;
          }
          // この Port が運ぶべき本文長 (206 の Content-Range 幅 / 200 の Content-Length) と照合する。
          // 全体長の照合 (下) だけでは、Content-Range の宣言より多い本文が載って合計が偶然一致する
          // ケースを検出できない
          if (portExpected !== null && portBytes !== portExpected) {
            console.error(
              `この転送の本文長が応答ヘッダの宣言と一致しません (宣言 ${portExpected} / 受信 ${portBytes}): ${url}`,
            );
            finish({ kind: 'transport', status, retryAfter });
            return;
          }
          if (expected !== null) {
            if (totalReceived !== expected) {
              console.error(`メディアの長さが全体長と一致しません (期待 ${expected} / 受信 ${totalReceived}): ${url}`);
              finish({ kind: 'transport', status, retryAfter });
              return;
            }
          } else if (baseOffset !== 0) {
            // 全体長が最後まで不明なまま、途中から再開したストリームを受け切った。欠落を検出できないので
            // 成功にしない (先頭から一度も途切れず受け切った場合のみ、全体長不明でも成功とみなす)
            console.error(`全体長が不明なため再開後の完全性を確認できません: ${url}`);
            finish({ kind: 'transport', status, retryAfter });
            return;
          }
          finish({ kind: 'complete', status, retryAfter });
          return;
        }
        case 'ping':
          // keepalive。受信自体が無応答 watchdog (armStallTimer) をリセットするので、他には何もしない
          return;
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
      port.postMessage({ type: 'start', url, offset, ifRange: offset > 0 ? ifRange : null });
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
