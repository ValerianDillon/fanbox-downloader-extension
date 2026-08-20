#!/usr/bin/env bun
/**
 * テストビルド (__FBDL_TEST__=true) が data-fbdl-zip-url (Blob URL) に publish した ZIP を
 * 取り出し、ローカルファイルに保存する CLI。
 *
 * ZIP が ZIP_B64_PUBLISH_LIMIT (8 MiB, src/content/test-hooks.ts) を超えると
 * data-fbdl-zip-b64 は publish されず zip-url / zip-size のみになるため、この経路が必要になる。
 * Blob URL 自体は CDP 越しに直接読めないので、対象ページ内で fetch してバイト列を
 * window.__fbdlPull に保持し、base64 にスライスして少しずつ CDP 越しに引き出す
 * (Runtime.evaluate の戻り値サイズにも実用的な限度があるため、ZIP 全体を一括では受け取らない)。
 *
 * 使い方: bun scripts/live-pull-zip.ts <out.zip> [--port <n>]
 */
import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { type CdpTarget, evaluateOnTarget, fetchTargetList } from './lib/cdp-client';

const DEFAULT_PORT = 9222;
// 12 MiB。3 の倍数にすることで、各スライスの base64 化がそれ自身で閉じる
// (パディング '=' が最終スライス以外に出ない) ため、スライスごとに独立してデコードできる。
const CHUNK_BYTES = 12 * 1024 * 1024;

type Options = {
  outPath: string;
  port: number;
};

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let port = DEFAULT_PORT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = argv[++i];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--port には正の整数を指定してください: ${value}`);
      }
      port = parsed;
      continue;
    }
    positional.push(arg);
  }

  const [outPath] = positional;
  if (!outPath) {
    throw new Error('第 1 引数に出力先ファイルパスを指定してください');
  }

  return { outPath, port };
}

async function evaluateChecked(wsUrl: string, expression: string, label: string): Promise<unknown> {
  const result = await evaluateOnTarget(wsUrl, expression);
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '不明な例外';
    throw new Error(`${label} の評価に失敗しました: ${message}`);
  }
  return result.result?.value ?? null;
}

/**
 * /json/list の type === 'page' を順に見て、data-fbdl-zip-url が非 null の最初のページを返す。
 */
async function findZipPage(port: number): Promise<CdpTarget> {
  const targets = await fetchTargetList(port);
  const pages = targets.filter((t) => t.type === 'page');
  if (pages.length === 0) {
    throw new Error(`type === 'page' のターゲットが見つかりません (/json/list に ${targets.length} 件)`);
  }

  for (const page of pages) {
    if (!page.webSocketDebuggerUrl) continue;
    const zipUrl = await evaluateChecked(
      page.webSocketDebuggerUrl,
      "document.documentElement.getAttribute('data-fbdl-zip-url')",
      'data-fbdl-zip-url の取得',
    );
    if (typeof zipUrl === 'string' && zipUrl.length > 0) {
      return page;
    }
  }

  throw new Error(
    `data-fbdl-zip-url を publish しているページが見つかりません (page ${pages.length} 件を確認)。` +
      ' テストビルドで ZIP 生成が完了 (data-fbdl-zip-done) しているか確認してください。',
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const page = await findZipPage(options.port);
  // biome-ignore lint/style/noNonNullAssertion: findZipPage が非 null を保証する
  const wsUrl = page.webSocketDebuggerUrl!;

  const length = await evaluateChecked(
    wsUrl,
    `(async () => {
      const url = document.documentElement.getAttribute('data-fbdl-zip-url');
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      window.__fbdlPull = new Uint8Array(buf);
      return window.__fbdlPull.length;
    })()`,
    'Blob URL の fetch',
  );
  if (typeof length !== 'number' || length < 0) {
    throw new Error(`予期しない ZIP 長を受け取りました: ${JSON.stringify(length)}`);
  }

  console.log(`ZIP を取得します: ${length} bytes`);
  writeFileSync(options.outPath, Buffer.alloc(0));

  let written = 0;
  for (let offset = 0; offset < length; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, length);
    const b64 = await evaluateChecked(
      wsUrl,
      `(() => {
        const slice = window.__fbdlPull.subarray(${offset}, ${end});
        if (typeof slice.toBase64 === 'function') return slice.toBase64();
        let binary = '';
        const step = 0x8000;
        for (let i = 0; i < slice.length; i += step) {
          binary += String.fromCharCode.apply(null, slice.subarray(i, i + step));
        }
        return btoa(binary);
      })()`,
      `ZIP スライス [${offset}, ${end})`,
    );
    if (typeof b64 !== 'string') {
      throw new Error(`予期しないスライス値を受け取りました (offset ${offset}): ${JSON.stringify(b64)}`);
    }
    const buf = Buffer.from(b64, 'base64');
    appendFileSync(options.outPath, buf);
    written += buf.length;
  }

  await evaluateChecked(wsUrl, 'delete window.__fbdlPull; true', 'window.__fbdlPull の解放');

  const actualSize = statSync(options.outPath).size;
  if (written !== length || actualSize !== length) {
    throw new Error(
      `書き出したバイト数が一致しません (期待 ${length}, 書き込み ${written}, ファイル実サイズ ${actualSize})`,
    );
  }

  console.log(`保存しました: ${options.outPath} (${actualSize} bytes)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
