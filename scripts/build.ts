#!/usr/bin/env bun
/**
 * content script + service worker のバンドルと static ファイルのコピーを行う。
 *
 * `--test` フラグを付けると dist-test/ に出力し、`__FBDL_TEST__` を true に define する。
 * (Playwright smoke test 用のテストビルド。shadow DOM を 'open' にし、
 *  service worker 経由 fetch のスタブや data-fbdl-* 属性による状態公開が有効になる)
 *
 * 通常ビルドは dist/ に出力し、`__FBDL_TEST__` を false に define する。
 * bun build の define は識別子置換 + dead code elimination を行うため、
 * `__FBDL_TEST__` で分岐したテスト専用コードは本番ビルドの成果物に残らない。
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const isTest = process.argv.includes('--test');
const outdir = isTest ? 'dist-test' : 'dist';

/** 通常ビルドの成果物にテスト専用コードの痕跡が残っていないかの post-build 検証対象 */
const ENTRY_FILE_NAMES = ['content.js', 'service-worker.js'];
const TEST_LEAK_PATTERN = /__FBDL_TEST__|data-fbdl/;

async function main() {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  const result = await Bun.build({
    entrypoints: ['./src/content/content.ts', './src/service-worker/service-worker.ts'],
    outdir,
    target: 'browser',
    naming: '[name].[ext]',
    define: {
      __FBDL_TEST__: isTest ? 'true' : 'false',
    },
    // syntax minify (定数畳み込み + dead code elimination) は __FBDL_TEST__ の
    // --define 置換だけでは削除しきれないテスト専用コードパスを消すために必須。
    // 例えば `if (IS_TEST_BUILD) { ... }` は IS_TEST_BUILD が
    // `typeof __FBDL_TEST__ !== 'undefined' && __FBDL_TEST__` という式に define 置換された後、
    // それを `false` (通常ビルド) に畳み込んで初めて分岐ごと消せる。
    // これを外すと、テスト専用コード (data-fbdl-* の文字列リテラル等) が
    // 通常ビルド (dist/) に残留してしまう (下の post-build 検証で検出される)。
    minify: {
      syntax: true,
    },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  cpSync('static/manifest.json', join(outdir, 'manifest.json'));
  cpSync('static/rules.json', join(outdir, 'rules.json'));
  cpSync('static/icons', join(outdir, 'icons'), { recursive: true });

  // 通常ビルドのみ: テスト専用コード (__FBDL_TEST__ / data-fbdl-*) が dead code elimination で
  // 確実に取り除かれていることを自動検証する (minify.syntax への依存を fail-fast にする)。
  if (!isTest) {
    for (const fileName of ENTRY_FILE_NAMES) {
      const contents = readFileSync(join(outdir, fileName), 'utf-8');
      if (TEST_LEAK_PATTERN.test(contents)) {
        console.error(
          `post-build 検証失敗: ${outdir}/${fileName} にテスト専用コードの痕跡 (__FBDL_TEST__ / data-fbdl) が残留しています`,
        );
        process.exit(1);
      }
    }
  }

  console.log(`build complete: ${outdir}/ (__FBDL_TEST__=${isTest})`);
}

await main();
