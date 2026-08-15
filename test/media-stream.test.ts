import { describe, expect, test } from 'bun:test';
import { fetchMediaViaPort, MAX_RESUMES } from '../src/content/media-stream';
import { type MediaStreamMessage, parseContentRange } from '../src/media-stream-protocol';
import { b64, fakeConnect } from './fake-media-port';

/**
 * Issue #22: content script 側の分割転送受信 (fetchMediaViaPort) のテスト。
 * chrome.runtime.connect を、service worker の振る舞いをスクリプトで模したフェイク Port を返す関数
 * (test/fake-media-port.ts の fakeConnect) に差し替える。
 */

function bytesOf(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

/** head メッセージを既定値付きで組み立てる (etag/lastModified まで毎回書かずに済ませる) */
function head(
  partial: Partial<MediaStreamMessage & { type: 'head' }> & { ok: boolean; status: number },
): MediaStreamMessage {
  return {
    type: 'head',
    retryAfter: null,
    contentLength: null,
    contentRange: null,
    etag: null,
    lastModified: null,
    ...partial,
  };
}

const okHead = (contentLength: number | null): MediaStreamMessage => head({ ok: true, status: 200, contentLength });

const URL_ = 'https://downloads.fanbox.cc/f';

/** 成功結果の Blob の中身を読む。blob が null なら (成功していなければ) 例外にして失敗を明示する */
async function blobBytes(result: Awaited<ReturnType<typeof fetchMediaViaPort>>): Promise<Uint8Array> {
  if (!result?.blob) throw new Error(`blob が null (status ${result?.status})`);
  return new Uint8Array(await result.blob.arrayBuffer());
}

describe('fetchMediaViaPort', () => {
  test('head → chunk × N → end を受け取り、連結した Blob を返す (chunk 境界は 3 の倍数でなくてよい)', async () => {
    const body = bytesOf(1000);
    const { connect, ports } = fakeConnect((_req, server) => {
      server.send(okHead(body.length));
      server.send({ type: 'chunk', data: b64(body.subarray(0, 301)) });
      server.send({ type: 'chunk', data: b64(body.subarray(301, 700)) });
      server.send({ type: 'chunk', data: b64(body.subarray(700)) });
      server.send({ type: 'end', bytes: body.length });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result?.status).toBe(200);
    expect(result?.blob).not.toBeNull();
    expect(await blobBytes(result)).toEqual(body);
    // 終端を受け取ったら content script 側が Port を切る
    expect(ports.length).toBe(1);
    expect(ports[0].clientDisconnected).toBe(true);
    expect(ports[0].request).toEqual({ type: 'start', url: URL_, offset: 0, ifRange: null });
  });

  test('0 バイトの本文 (chunk なしで end) は失敗ではなく空の Blob として成功する', async () => {
    const { connect } = fakeConnect((_req, server) => {
      server.send(okHead(0));
      server.send({ type: 'end', bytes: 0 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result?.blob?.size).toBe(0);
    expect(result?.status).toBe(200);
  });

  test('HTTP エラー (429) は blob:null で status/Retry-After を保持して返し、再開しない', async () => {
    const { connect, ports } = fakeConnect((_req, server) => {
      server.send(head({ ok: false, status: 429, retryAfter: '30' }));
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result).toEqual({ blob: null, status: 429, retryAfter: '30' });
    expect(ports.length).toBe(1);
  });

  test('通信失敗 (ok:false, status:0 の head) は blob:null, status:0 を返す', async () => {
    const { connect } = fakeConnect((_req, server) => {
      server.send(head({ ok: false, status: 0, error: 'x' }));
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result).toEqual({ blob: null, status: 0, retryAfter: null });
  });

  test('本文の途中で切断されたら、受信済みバイト数を offset にして Range で再開し、206 の続きを結合する', async () => {
    const body = bytesOf(1000);
    const { connect, ports } = fakeConnect((req, server) => {
      if (req.offset === 0) {
        server.send(okHead(body.length));
        server.send({ type: 'chunk', data: b64(body.subarray(0, 400)) });
        server.drop();
        return;
      }
      expect(req.offset).toBe(400);
      server.send(head({ ok: true, status: 206, contentLength: 600, contentRange: `bytes 400-999/${body.length}` }));
      server.send({ type: 'chunk', data: b64(body.subarray(400)) });
      server.send({ type: 'end', bytes: 600 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result?.blob).not.toBeNull();
    expect(await blobBytes(result)).toEqual(body);
    expect(ports.map((p) => p.request?.offset)).toEqual([0, 400]);
  });

  test('再開時にサーバが Range を無視して 200 を返したら、受信済みのぶんを捨てて先頭から受け直す', async () => {
    const body = bytesOf(1000);
    const { connect, ports } = fakeConnect((req, server) => {
      if (req.offset === 0 && ports.length === 1) {
        server.send(okHead(body.length));
        server.send({ type: 'chunk', data: b64(body.subarray(0, 400)) });
        server.drop();
        return;
      }
      // Range を無視: 200 で全体を返す
      server.send(okHead(body.length));
      server.send({ type: 'chunk', data: b64(body) });
      server.send({ type: 'end', bytes: body.length });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(await blobBytes(result)).toEqual(body);
    expect(ports.map((p) => p.request?.offset)).toEqual([0, 400]);
  });

  test('206 の Content-Range が要求 offset と一致しなければ受信済みデータを破棄して失敗にする (壊れたファイルを成功にしない)', async () => {
    const body = bytesOf(1000);
    const { connect, ports } = fakeConnect((req, server) => {
      if (req.offset === 0) {
        server.send(okHead(body.length));
        server.send({ type: 'chunk', data: b64(body.subarray(0, 400)) });
        server.drop();
        return;
      }
      server.send(head({ ok: true, status: 206, contentLength: 700, contentRange: `bytes 300-999/${body.length}` }));
      server.send({ type: 'chunk', data: b64(body.subarray(300)) });
      server.send({ type: 'end', bytes: 700 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result?.blob).toBeNull();
    expect(result?.status).toBe(206);
    // 破棄後は received が 0 なので再開せず、失敗として返す (上位の fetchWithRetry に委ねる)
    expect(ports.length).toBe(2);
  });

  test('初回 Content-Length 不明でも、206 の Content-Range total を全体長に採用して欠落を検出する', async () => {
    // 初回応答に Content-Length が無く 400 bytes で切断。再開の 206 は Content-Range で /1000 を示すが
    // 899 までしか送らず切れる。total を採用しないと 900-byte Blob を「完全」として返してしまう (Codex #1)
    const body = bytesOf(1000);
    const { connect } = fakeConnect((req, server) => {
      if (req.offset === 0) {
        server.send(okHead(null)); // Content-Length 不明
        server.send({ type: 'chunk', data: b64(body.subarray(0, 400)) });
        server.drop();
        return;
      }
      // 206 は total=1000 を示すが 400-899 (500 bytes) しか送らず end
      server.send(head({ ok: true, status: 206, contentLength: 500, contentRange: `bytes 400-899/${body.length}` }));
      server.send({ type: 'chunk', data: b64(body.subarray(400, 900)) });
      server.send({ type: 'end', bytes: 500 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    // 900 !== 1000 (Content-Range total) なので成功にしない
    expect(result?.blob).toBeNull();
    expect(result?.status).toBe(206);
  });

  test('全体長が最後まで不明なまま途中から再開したストリームは、受け切っても成功にしない', async () => {
    // 初回 Content-Length 無し、206 の Content-Range total も `*` (不明)。欠落を検出できないので、
    // 途中再開 (baseOffset > 0) では end を受けても成功にしない
    const body = bytesOf(600);
    const { connect } = fakeConnect((req, server) => {
      if (req.offset === 0) {
        server.send(okHead(null));
        server.send({ type: 'chunk', data: b64(body.subarray(0, 300)) });
        server.drop();
        return;
      }
      server.send(head({ ok: true, status: 206, contentLength: 300, contentRange: 'bytes 300-599/*' }));
      server.send({ type: 'chunk', data: b64(body.subarray(300)) });
      server.send({ type: 'end', bytes: 300 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result?.blob).toBeNull();
    expect(result?.status).toBe(206);
  });

  test('再開に 206/200 以外の成功 (204) が返っても、空 Blob を成功として返さない', async () => {
    // 204 を「Range 無視」として restart 扱いすると、end.bytes 0 で空 Blob が成功になる (Codex #3)
    const body = bytesOf(1000);
    const { connect } = fakeConnect((req, server) => {
      if (req.offset === 0) {
        server.send(okHead(body.length));
        server.send({ type: 'chunk', data: b64(body.subarray(0, 400)) });
        server.drop();
        return;
      }
      server.send(head({ ok: true, status: 204 }));
      server.send({ type: 'end', bytes: 0 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result?.blob).toBeNull();
    expect(result?.status).toBe(204);
  });

  test('再開要求に初回応答の validator を If-Range として渡す (ETag 優先)', async () => {
    const body = bytesOf(1000);
    const { connect, ports } = fakeConnect((req, server) => {
      if (req.offset === 0) {
        server.send(head({ ok: true, status: 200, contentLength: body.length, etag: 'W/"abc"', lastModified: 'Mon' }));
        server.send({ type: 'chunk', data: b64(body.subarray(0, 400)) });
        server.drop();
        return;
      }
      server.send(head({ ok: true, status: 206, contentLength: 600, contentRange: `bytes 400-999/${body.length}` }));
      server.send({ type: 'chunk', data: b64(body.subarray(400)) });
      server.send({ type: 'end', bytes: 600 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(await blobBytes(result)).toEqual(body);
    // 初回 (offset 0) は If-Range 無し、再開 (offset 400) は初回の ETag を If-Range として送る
    expect(ports.map((p) => p.request?.ifRange)).toEqual([null, 'W/"abc"']);
  });

  test('ETag が無ければ Last-Modified を If-Range に使う', async () => {
    const body = bytesOf(500);
    const { connect, ports } = fakeConnect((req, server) => {
      if (req.offset === 0) {
        server.send(
          head({ ok: true, status: 200, contentLength: body.length, lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' }),
        );
        server.send({ type: 'chunk', data: b64(body.subarray(0, 200)) });
        server.drop();
        return;
      }
      server.send(head({ ok: true, status: 206, contentLength: 300, contentRange: `bytes 200-499/${body.length}` }));
      server.send({ type: 'chunk', data: b64(body.subarray(200)) });
      server.send({ type: 'end', bytes: 300 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(await blobBytes(result)).toEqual(body);
    expect(ports[1].request?.ifRange).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
  });

  test('head を受け取る前の切断 (受信 0 バイト) は再開せず通信失敗 (status 0) として返す', async () => {
    const { connect, ports } = fakeConnect((_req, server) => {
      server.drop();
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result).toEqual({ blob: null, status: 0, retryAfter: null });
    expect(ports.length).toBe(1);
  });

  test('切断が MAX_RESUMES 回を超えて続いたら諦めて失敗を返す', async () => {
    const body = bytesOf(1000);
    const { connect, ports } = fakeConnect((req, server) => {
      if (req.offset === 0) {
        server.send(okHead(body.length));
      } else {
        server.send(
          head({
            ok: true,
            status: 206,
            contentLength: body.length - req.offset,
            contentRange: `bytes ${req.offset}-999/${body.length}`,
          }),
        );
      }
      // 毎回 100 バイトだけ送って切れる
      server.send({ type: 'chunk', data: b64(body.subarray(req.offset, req.offset + 100)) });
      server.drop();
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result?.blob).toBeNull();
    expect(result?.status).toBe(206);
    // 初回 + MAX_RESUMES 回の再開
    expect(ports.length).toBe(1 + MAX_RESUMES);
  });

  test('end の bytes が受信数と一致しなければ失敗にする', async () => {
    const body = bytesOf(100);
    const { connect } = fakeConnect((_req, server) => {
      server.send(okHead(null));
      server.send({ type: 'chunk', data: b64(body) });
      server.send({ type: 'end', bytes: 101 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result?.blob).toBeNull();
    expect(result?.status).toBe(200);
  });

  test('受信合計が Content-Length と一致しなければ失敗にする (途中で end が来ても成功にしない)', async () => {
    const body = bytesOf(100);
    const { connect } = fakeConnect((_req, server) => {
      server.send(okHead(200));
      server.send({ type: 'chunk', data: b64(body) });
      server.send({ type: 'end', bytes: 100 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(result?.blob).toBeNull();
  });

  test('service worker 側の error は失敗として返す (受信済みがあれば再開を試みる)', async () => {
    const body = bytesOf(500);
    const { connect, ports } = fakeConnect((req, server) => {
      if (req.offset === 0) {
        server.send(okHead(body.length));
        server.send({ type: 'chunk', data: b64(body.subarray(0, 200)) });
        server.send({ type: 'error', error: 'body read failed' });
        return;
      }
      server.send(head({ ok: true, status: 206, contentLength: 300, contentRange: `bytes 200-499/${body.length}` }));
      server.send({ type: 'chunk', data: b64(body.subarray(200)) });
      server.send({ type: 'end', bytes: 300 });
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect });
    expect(await blobBytes(result)).toEqual(body);
    expect(ports.length).toBe(2);
  });

  test('中断 (signal) されたら null を返し、Port を切断する (service worker 側が fetch を abort できるように)', async () => {
    const controller = new AbortController();
    const { connect, ports } = fakeConnect((_req, server) => {
      server.send(okHead(1000));
      // head を届けたあと、応答が続く前に中断される
      queueMicrotask(() => controller.abort());
    });
    const result = await fetchMediaViaPort(URL_, controller.signal, { connect });
    expect(result).toBeNull();
    expect(ports[0].clientDisconnected).toBe(true);
  });

  test('service worker が生きたまま何も送ってこなければ stallTimeoutMs で打ち切り、通信失敗として返す', async () => {
    const { connect, ports } = fakeConnect((_req, server) => {
      // head だけ送って以後沈黙する (切断もしない)
      server.send(okHead(1000));
    });
    const result = await fetchMediaViaPort(URL_, undefined, { connect, stallTimeoutMs: 20 });
    // head は受け取っているので status は 200、本文が揃わないので blob は null。received 0 なので再開しない
    expect(result).toEqual({ blob: null, status: 200, retryAfter: null });
    expect(ports.length).toBe(1);
    expect(ports[0].clientDisconnected).toBe(true);
  });

  test('呼び出し前から中断済みなら Port を開かず null を返す', async () => {
    const controller = new AbortController();
    controller.abort();
    const { connect, ports } = fakeConnect(() => {});
    const result = await fetchMediaViaPort(URL_, controller.signal, { connect });
    expect(result).toBeNull();
    expect(ports.length).toBe(0);
  });

  test('connect() が投げたら (拡張の再読み込み等) 通信失敗として返す', async () => {
    const result = await fetchMediaViaPort(URL_, undefined, {
      connect: () => {
        throw new Error('Extension context invalidated.');
      },
    });
    expect(result).toEqual({ blob: null, status: 0, retryAfter: null });
  });
});

describe('parseContentRange', () => {
  test('bytes <start>-<end>/<total> を読む', () => {
    expect(parseContentRange('bytes 400-999/1000')).toEqual({ start: 400, end: 999, total: 1000 });
    expect(parseContentRange('bytes 0-0/*')).toEqual({ start: 0, end: 0, total: null });
  });
  test('読めない形式は null', () => {
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange('bytes */1000')).toBeNull();
    expect(parseContentRange('items 0-1/2')).toBeNull();
  });
});
