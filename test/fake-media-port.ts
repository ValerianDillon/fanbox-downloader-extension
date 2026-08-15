import type { MediaClientPort } from '../src/content/media-stream';
import type { MediaStreamMessage, MediaStreamRequest } from '../src/media-stream-protocol';

/**
 * Issue #22: content script 側の分割転送受信をテストするための、chrome.runtime.connect のフェイク。
 * service worker の振る舞いを script として与え、Port 上のメッセージ配送 (非同期・順序保証) を模す。
 * test/media-stream.test.ts (fetchMediaViaPort 直接) と test/downloader.test.ts (downloadAsZip /
 * fetchWithRetry 経由) の両方から使う。
 */

/** フェイクの service worker 側から Port を操作するためのハンドル */
export type ServerSide = {
  /** content script 側の onMessage に届ける */
  send: (message: MediaStreamMessage) => void;
  /** service worker の停止を模す (content script 側の onDisconnect だけが発火する) */
  drop: () => void;
  /** content script 側が disconnect() したか */
  clientDisconnected: () => boolean;
};

export type Script = (request: MediaStreamRequest, server: ServerSide) => void | Promise<void>;

/**
 * connect() されるたびに新しいフェイク Port を作り、`start` を受け取ったら script を実行する。
 * script は send/drop で content script 側の受信を駆動する。
 */
export function fakeConnect(script: Script) {
  const ports: { request: MediaStreamRequest | null; clientDisconnected: boolean }[] = [];
  const connect = (): MediaClientPort => {
    const record = { request: null as MediaStreamRequest | null, clientDisconnected: false };
    ports.push(record);
    const messageListeners: ((message: unknown) => void)[] = [];
    const disconnectListeners: (() => void)[] = [];
    let dropped = false;
    const server: ServerSide = {
      send: (message) => {
        if (record.clientDisconnected || dropped) return;
        // 実際の Port と同様に非同期に届く (drop() は send() 済みのメッセージより後に届く)
        queueMicrotask(() => {
          if (record.clientDisconnected) return;
          for (const listener of messageListeners) listener(message);
        });
      },
      drop: () => {
        if (record.clientDisconnected || dropped) return;
        dropped = true;
        queueMicrotask(() => {
          if (record.clientDisconnected) return;
          for (const listener of disconnectListeners) listener();
        });
      },
      clientDisconnected: () => record.clientDisconnected,
    };
    return {
      postMessage: (message) => {
        record.request = message;
        void script(message, server);
      },
      disconnect: () => {
        record.clientDisconnected = true;
      },
      onMessage: {
        addListener: (callback) => {
          messageListeners.push(callback);
        },
      },
      onDisconnect: {
        addListener: (callback) => {
          disconnectListeners.push(callback);
        },
      },
    };
  };
  return { connect, ports };
}

/** base64 エンコード (テスト用の小さなバイト列向け) */
export function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * 「HTTP ステータスと本文だけを返す単純な service worker」を模す script を作る。
 * downloadAsZip / fetchWithRetry のテストで、応答ごとの分岐だけを書けるようにするための簡易版。
 */
export function simpleResponder(
  respond: (request: MediaStreamRequest) => { status: number; retryAfter?: string | null; body?: Uint8Array },
): Script {
  return (request, server) => {
    const res = respond(request);
    const ok = res.status >= 200 && res.status < 300;
    server.send({
      type: 'head',
      ok,
      status: res.status,
      retryAfter: res.retryAfter ?? null,
      contentLength: ok ? (res.body?.length ?? 0) : null,
      contentRange: null,
      etag: null,
      lastModified: null,
      ...(res.status === 0 ? { error: 'network down' } : {}),
    });
    if (!ok) return;
    const body = res.body ?? new Uint8Array();
    if (body.length > 0) server.send({ type: 'chunk', data: b64(body) });
    server.send({ type: 'end', bytes: body.length });
  };
}

/**
 * globalThis.chrome.runtime.connect をフェイクに差し替える。戻り値の restore() で元に戻す。
 * ports は connect() された Port の記録 (呼び出し回数 = ports.length)。
 */
export function installFakeMediaRuntime(script: Script) {
  // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
  const g = globalThis as any;
  const origChrome = g.chrome;
  const { connect, ports } = fakeConnect(script);
  g.chrome = { ...(origChrome ?? {}), runtime: { ...(origChrome?.runtime ?? {}), connect } };
  return {
    ports,
    restore: () => {
      g.chrome = origChrome;
    },
  };
}
