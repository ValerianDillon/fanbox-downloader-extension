import { describe, expect, test } from 'bun:test';
import { CHUNK_BYTES, type MediaStreamMessage } from '../../src/media-stream-protocol';
import { type MediaStreamDeps, type MediaStreamPort, streamMedia } from '../../src/service-worker/media-stream';

/**
 * Issue #22: service worker 側の分割転送 (streamMedia) のテスト。
 * chrome.runtime.Port と fetch をフェイクに差し替え、Port 上に流れるメッセージ列を検証する。
 */

/** Port のフェイク。送られたメッセージを記録し、テストから onDisconnect を発火できる */
function fakePort(options: { throwOnPost?: boolean } = {}) {
  const messages: MediaStreamMessage[] = [];
  const disconnectListeners: (() => void)[] = [];
  let disconnected = false;
  const port: MediaStreamPort & { disconnect(): void } = {
    postMessage: (message) => {
      if (disconnected || options.throwOnPost) throw new Error('Attempting to use a disconnected port object');
      messages.push(message);
    },
    onDisconnect: {
      addListener: (callback) => {
        disconnectListeners.push(callback);
      },
    },
    /** content script 側が切った状況を再現する (service worker 側の onDisconnect が発火する) */
    disconnect: () => {
      disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
  };
  return { port, messages };
}

function decode(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

/** chunk メッセージの本文を連結する */
function concatChunks(messages: MediaStreamMessage[]): Uint8Array {
  const parts = messages.filter((m): m is Extract<MediaStreamMessage, { type: 'chunk' }> => m.type === 'chunk');
  const decoded = parts.map((m) => decode(m.data));
  const out = new Uint8Array(decoded.reduce((sum, d) => sum + d.length, 0));
  let offset = 0;
  for (const d of decoded) {
    out.set(d, offset);
    offset += d.length;
  }
  return out;
}

/** 与えたバイト列を pieces 個に分けて流す ReadableStream を本文に持つ Response のフェイク */
function fakeResponse(init: {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
  pieces?: number;
  /** 本文の途中 (n 個目の piece を流した後) で失敗させる */
  failAfterPieces?: number;
  /** signal が abort されたら本文の読み込みを reject させる */
  signal?: AbortSignal;
}): Response {
  const headers = new Headers(init.headers ?? {});
  const body = init.body ?? new Uint8Array();
  const pieces = Math.max(1, init.pieces ?? 1);
  const pieceSize = Math.ceil(body.length / pieces) || 1;
  let sent = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (init.signal?.aborted) {
        controller.error(new DOMException('The user aborted a request.', 'AbortError'));
        return;
      }
      if (init.failAfterPieces !== undefined && index >= init.failAfterPieces) {
        controller.error(new Error('body read failed'));
        return;
      }
      if (sent >= body.length) {
        controller.close();
        return;
      }
      controller.enqueue(body.subarray(sent, Math.min(body.length, sent + pieceSize)));
      sent += pieceSize;
      index++;
    },
  });
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers,
    body: body.length === 0 && init.status === 204 ? null : stream,
  } as unknown as Response;
}

function bytesOf(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

const depsWith = (fetchImpl: MediaStreamDeps['fetch'], extra: Partial<MediaStreamDeps> = {}): MediaStreamDeps => ({
  fetch: fetchImpl,
  ...extra,
});

describe('streamMedia', () => {
  test('200: head → chunk (CHUNK_BYTES ごと) → end の順に送り、連結すると本文と一致する', async () => {
    const body = bytesOf(CHUNK_BYTES * 2 + 1234);
    const { port, messages } = fakePort();
    const seen: RequestInit[] = [];
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      depsWith(async (_url, init) => {
        seen.push(init);
        return fakeResponse({ status: 200, headers: { 'Content-Length': String(body.length) }, body, pieces: 7 });
      }),
    );
    expect(messages[0]).toEqual({
      type: 'head',
      ok: true,
      status: 200,
      retryAfter: null,
      contentLength: body.length,
      contentRange: null,
      etag: null,
      lastModified: null,
    });
    const chunks = messages.filter((m) => m.type === 'chunk');
    // 本文は CHUNK_BYTES × 2 + 端数なので、CHUNK_BYTES ちょうど × 2 + 端数の 3 メッセージに分かれる。
    // read() が返す断片の大きさ (ここでは 7 分割) には依存しない
    expect(chunks.map((c) => (c.type === 'chunk' ? decode(c.data).length : -1))).toEqual([
      CHUNK_BYTES,
      CHUNK_BYTES,
      1234,
    ]);
    expect(messages[messages.length - 1]).toEqual({ type: 'end', bytes: body.length });
    expect(concatChunks(messages)).toEqual(body);
    // credentials: include で fetch し、offset 0 では Range を付けない
    expect(seen[0].credentials).toBe('include');
    expect((seen[0].headers as Record<string, string>).Range).toBeUndefined();
  });

  test('1 回の read() が CHUNK_BYTES を大きく超える断片を返しても、1 メッセージは CHUNK_BYTES 以下に切って送る', async () => {
    // ローカルのモックサーバや高速な回線では 1 回の read() で数十 MiB が返りうる。そのまま 1 メッセージに
    // 載せると base64 化後に runtime messaging の 64 MiB 上限に当たる (Issue #22 の再発)
    const body = bytesOf(CHUNK_BYTES * 2 + CHUNK_BYTES / 2);
    const { port, messages } = fakePort();
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      depsWith(async () => fakeResponse({ status: 200, body, pieces: 1 })),
    );
    const chunks = messages.filter((m) => m.type === 'chunk');
    expect(chunks.map((c) => (c.type === 'chunk' ? decode(c.data).length : -1))).toEqual([
      CHUNK_BYTES,
      CHUNK_BYTES,
      CHUNK_BYTES / 2,
    ]);
    expect(concatChunks(messages)).toEqual(body);
    expect(messages[messages.length - 1]).toEqual({ type: 'end', bytes: body.length });
  });

  test('offset > 0 なら Range ヘッダを付け、206 の Content-Range を head に載せる', async () => {
    const body = bytesOf(100);
    const { port, messages } = fakePort();
    const seen: RequestInit[] = [];
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 40 },
      depsWith(async (_url, init) => {
        seen.push(init);
        return fakeResponse({
          status: 206,
          headers: { 'Content-Length': '60', 'Content-Range': 'bytes 40-99/100' },
          body: body.subarray(40),
        });
      }),
    );
    expect((seen[0].headers as Record<string, string>).Range).toBe('bytes=40-');
    expect(messages[0]).toMatchObject({
      type: 'head',
      ok: true,
      status: 206,
      contentLength: 60,
      contentRange: 'bytes 40-99/100',
    });
    expect(concatChunks(messages)).toEqual(body.subarray(40));
    expect(messages[messages.length - 1]).toEqual({ type: 'end', bytes: 60 });
  });

  test('0 バイトの本文は chunk なしで end (bytes 0) を送る', async () => {
    const { port, messages } = fakePort();
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      depsWith(async () => fakeResponse({ status: 200, headers: { 'Content-Length': '0' }, body: new Uint8Array() })),
    );
    expect(messages.map((m) => m.type)).toEqual(['head', 'end']);
    expect(messages[1]).toEqual({ type: 'end', bytes: 0 });
  });

  test('429 は ok:false, status:429, Retry-After を head に載せ、本文は送らない', async () => {
    const { port, messages } = fakePort();
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      depsWith(async () => fakeResponse({ status: 429, headers: { 'Retry-After': '30' }, body: bytesOf(10) })),
    );
    expect(messages).toEqual([
      {
        type: 'head',
        ok: false,
        status: 429,
        retryAfter: '30',
        contentLength: null,
        contentRange: null,
        etag: null,
        lastModified: null,
      },
    ]);
  });

  test('404 等の他の HTTP エラーもステータスを保持する (429 だけを特別扱いしない)', async () => {
    const { port, messages } = fakePort();
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      depsWith(async () => fakeResponse({ status: 404 })),
    );
    expect(messages).toEqual([
      {
        type: 'head',
        ok: false,
        status: 404,
        retryAfter: null,
        contentLength: null,
        contentRange: null,
        etag: null,
        lastModified: null,
      },
    ]);
  });

  test('fetch が例外を投げたら通信失敗として ok:false, status:0 の head を送る (fetchApi と揃える)', async () => {
    const { port, messages } = fakePort();
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      depsWith(async () => {
        throw new Error('network down');
      }),
    );
    expect(messages.length).toBe(1);
    expect(messages[0]).toMatchObject({ type: 'head', ok: false, status: 0, retryAfter: null });
    expect((messages[0] as { error?: string }).error).toContain('network down');
  });

  test('本文の読み込み中に失敗したら、送信済みの head/chunk はそのままに error を送る (status を 0 にすり替えない)', async () => {
    const body = bytesOf(1000);
    const { port, messages } = fakePort();
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      depsWith(async () =>
        fakeResponse({ status: 200, headers: { 'Retry-After': '7' }, body, pieces: 4, failAfterPieces: 2 }),
      ),
    );
    expect(messages[0]).toMatchObject({ type: 'head', ok: true, status: 200, retryAfter: '7' });
    const last = messages[messages.length - 1];
    expect(last?.type).toBe('error');
    expect((last as { error: string }).error).toContain('body read failed');
    expect(messages.some((m) => m.type === 'end')).toBe(false);
  });

  test('content script 側が切断したら fetch を abort し、以後は何も送らない', async () => {
    const body = bytesOf(CHUNK_BYTES * 3);
    const { port, messages } = fakePort();
    let capturedSignal: AbortSignal | undefined;
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      depsWith(
        async (_url, init) => {
          capturedSignal = init.signal ?? undefined;
          return fakeResponse({ status: 200, body, pieces: 3, signal: capturedSignal });
        },
        {
          // 最初の chunk を送ったところで content script が切断する
          onChunkSent: ({ sentBytes }) => {
            if (sentBytes >= CHUNK_BYTES) queueMicrotask(() => port.disconnect());
          },
        },
      ),
    );
    expect(capturedSignal?.aborted).toBe(true);
    // head + 最初の chunk までは送られ、それ以降 (残りの chunk / end / error) は送られない
    expect(messages.map((m) => m.type)).toEqual(['head', 'chunk']);
  });

  test('切断より前に fetch を abort する: 応答ヘッダ待ちの間に切断されたら fetch の signal が abort される', async () => {
    const { port, messages } = fakePort();
    let capturedSignal: AbortSignal | undefined;
    await streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      depsWith(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            capturedSignal = init.signal ?? undefined;
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            // 応答が返る前に content script が切断する
            queueMicrotask(() => port.disconnect());
          }),
      ),
    );
    expect(capturedSignal?.aborted).toBe(true);
    // 切断後は head (ok:false) も送らない
    expect(messages).toEqual([]);
  });

  test('切断済みの Port への postMessage が投げても throw せず、fetch を abort して終わる', async () => {
    const body = bytesOf(100);
    const { port } = fakePort({ throwOnPost: true });
    let capturedSignal: AbortSignal | undefined;
    await expect(
      streamMedia(
        port,
        { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
        depsWith(async (_url, init) => {
          capturedSignal = init.signal ?? undefined;
          return fakeResponse({ status: 200, body });
        }),
      ),
    ).resolves.toBeUndefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  test('read() がブロック中でも、溜まっているぶんを FLUSH_INTERVAL_MS ごとに実時間タイマーで送る (idle timer リセット)', async () => {
    // 小さい断片 (CHUNK_BYTES 未満) を 1 つ流したあと read() が長くブロックするストリームを作り、
    // read() が返らない間でも定期 flush で chunk が送られることを確認する。
    // read() が返った時だけ時間を見る方式ではこの chunk は送られず、service worker が停止しうる。
    const first = bytesOf(1000);
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(first);
          return;
        }
        // 2 回目の pull はテストが解放するまでブロックする
        await blocked;
        controller.close();
      },
    });
    const response = {
      status: 200,
      ok: true,
      headers: new Headers({ 'Content-Length': '1000' }),
      body: stream,
    } as unknown as Response;

    const { port, messages } = fakePort();
    const done = streamMedia(
      port,
      { type: 'start', url: 'https://downloads.fanbox.cc/f', offset: 0 },
      {
        fetch: async () => response,
        flushIntervalMs: 10,
      },
    );
    // read() がブロックしている間に、実時間タイマーで最初の 1000 バイトが flush されるのを待つ
    await Bun.sleep(60);
    expect(messages.filter((m) => m.type === 'chunk').length).toBe(1);
    expect((messages.find((m) => m.type === 'chunk') as { data: string }).data).toBe(
      btoa(String.fromCharCode(...first)),
    );
    // ブロックを解放してストリームを終端させる
    release();
    await done;
    expect(messages[messages.length - 1]).toEqual({ type: 'end', bytes: 1000 });
  });
});
