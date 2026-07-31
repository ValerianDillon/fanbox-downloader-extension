import type { FileSystemFileHandle } from 'download-helper/download-helper';
import { uint8ArrayToBase64 } from '../base64';

/**
 * テストビルド (`__FBDL_TEST__`) 専用のフック集。
 *
 * content script は ISOLATED world で動くため、Playwright の page.evaluate /
 * addInitScript (MAIN world) からは content script 内の変数を直接観測できない。
 * そのため MAIN/ISOLATED 両 world から共有される DOM (document.documentElement の
 * data-fbdl-* 属性) 経由で状態を publish し、e2e テストの観測点として使う。
 *
 * `IS_TEST_BUILD` は `__FBDL_TEST__` の判定を一箇所に集約した定数で、値そのものが
 * 必要な箇所 (SHADOW_ROOT_MODE、および中身に data-fbdl-* の文字列リテラルを含まない
 * ガード節) から参照する。
 *
 * 【重要・DCE に関する制約】bun build の --define は「識別子 `__FBDL_TEST__` への参照」を
 * 出現箇所ごとに直接リテラル置換するが、その結果を保持する `IS_TEST_BUILD` という
 * *別の* 変数への参照は、宣言箇所から離れた別関数の中で `if (IS_TEST_BUILD)` と書いても
 * 定数畳み込みが伝播せず dead code elimination が効かないことを実測で確認した
 * (bun 1.3.14、`minify: { syntax: true }` および `minify: true` の両方で確認、
 * cross-statement/cross-function な const 伝播は行われない)。そのため
 * publishTestState / resetTestState — data-fbdl-* の文字列リテラルを直接含み、
 * 本番ビルドで確実に消す必要がある — の 2 関数だけは、あえて `IS_TEST_BUILD` を経由せず
 * `typeof __FBDL_TEST__ !== 'undefined' && __FBDL_TEST__` を直接書く (この 2 箇所のみ
 * 許容する重複。scripts/build.ts の post-build 検証で実際に消えていることを検証済み)。
 * それ以外の箇所 (SHADOW_ROOT_MODE、pickSaveHandle の分岐、wrapFetchFileForTest の分岐) は
 * data-fbdl 文字列を直接含まないか、あるいは値としてのみ使うため `IS_TEST_BUILD` を使ってよい
 * (畳み込まれず if 自体は残っても、実行時には正しく false 判定されるだけで実害がない)。
 *
 * `typeof __FBDL_TEST__ !== 'undefined'` を併せて確認しているのは `bun test`
 * (scripts/build.ts の --define を経由しない実行経路) では `__FBDL_TEST__` が
 * 実行時に一切定義されず ReferenceError になるため。--define 適用時はどちらの値
 * (true/false) でもリテラル置換されるため、この typeof チェック自体は定数畳み込みで消える。
 *
 * ガードパターンの規約:
 * - 無条件に (本番ビルドのコードパスからも呼ばれ得る形で) 呼ばれる関数
 *   (publishTestState / resetTestState / wrapFetchFileForTest) は関数内部で
 *   ガード節を持つ。本番ビルドでは中身が no-op ないし恒等関数になる。
 * - 呼び出し側で既に IS_TEST_BUILD 分岐の中からしか呼ばれない関数
 *   (createTestSaveHandle) は内部ガードを持たない (二重ガードにしない)。
 */

export const IS_TEST_BUILD = typeof __FBDL_TEST__ !== 'undefined' && __FBDL_TEST__;

/** shadow root の mode。テストビルドでは Playwright が貫通できるよう 'open' にする。 */
export const SHADOW_ROOT_MODE: ShadowRootMode = IS_TEST_BUILD ? 'open' : 'closed';

/**
 * document.documentElement に data-fbdl-{key} 属性として primitive な値を publish する。
 * data-fbdl-* の文字列リテラルを直接含むため、DCE のために IS_TEST_BUILD を経由せず
 * `__FBDL_TEST__` を直接ガードに使う (本ファイル冒頭のコメント参照)。
 */
export function publishTestState(partial: Record<string, string>): void {
  if (typeof __FBDL_TEST__ !== 'undefined' && __FBDL_TEST__) {
    for (const [key, value] of Object.entries(partial)) {
      document.documentElement.setAttribute(`data-fbdl-${key}`, value);
    }
  }
}

/**
 * 実行 (startCollecting 呼び出し) 開始時に呼び、前回実行の観測状態をクリアする。
 * data-fbdl-overlay-state は呼び出し側 (setState) が直後に上書きするのでここでは触らない。
 * publishTestState と同様の理由で IS_TEST_BUILD を経由せず `__FBDL_TEST__` を直接ガードに使う。
 */
export function resetTestState(): void {
  if (typeof __FBDL_TEST__ !== 'undefined' && __FBDL_TEST__) {
    const keys = [
      'error',
      'aborted',
      'failed-post-count',
      'failed-page-count',
      'failed-file-count',
      'fetched-urls',
      'zip-b64',
      'zip-done',
    ];
    for (const key of keys) {
      document.documentElement.removeAttribute(`data-fbdl-${key}`);
    }
  }
}

/**
 * showSaveFilePicker の代わりに使う in-memory な FileSystemFileHandle 互換オブジェクト。
 * createWritable() で得られる writable への write/close で書き込まれたチャンクを結合し、
 * close() 時に data-fbdl-zip-b64 (base64) / data-fbdl-zip-done ('1') を publish する。
 *
 * 呼び出し側 (downloader.ts の pickSaveHandle) が既に `if (IS_TEST_BUILD)` の中でのみ
 * 呼ぶため、ここでは内部ガードを持たない (呼び出し規約は本ファイル冒頭のコメントを参照)。
 */
export function createTestSaveHandle(): FileSystemFileHandle {
  const chunks: Uint8Array[] = [];
  const writable = {
    write: async (data: Uint8Array) => {
      chunks.push(new Uint8Array(data));
    },
    close: async () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const buffer = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
      publishTestState({ 'zip-b64': uint8ArrayToBase64(buffer), 'zip-done': '1' });
    },
  };
  return { createWritable: async () => writable } as unknown as FileSystemFileHandle;
}

/**
 * downloadZip に渡す fetchFile を observability 用にラップする。
 * - 要求した URL を data-fbdl-fetched-urls (JSON 配列文字列) に累積 publish
 * - null 返却 (取得失敗) の回数を data-fbdl-failed-file-count に累積 publish (0 件でも publish する)
 * 本番ビルドでは何も変更せず fetchFile をそのまま返す。
 */
export function wrapFetchFileForTest(
  fetchFile: (url: string, name: string) => Promise<Blob | null>,
): (url: string, name: string) => Promise<Blob | null> {
  if (IS_TEST_BUILD) {
    const fetchedUrls: string[] = [];
    let failedCount = 0;
    // 一件も失敗しなかった場合でも観測点として '0' を publish しておく
    // (属性が存在しないことと「失敗 0 件」を区別できるようにする)
    publishTestState({ 'failed-file-count': '0' });
    return async (url: string, name: string) => {
      fetchedUrls.push(url);
      publishTestState({ 'fetched-urls': JSON.stringify(fetchedUrls) });
      const blob = await fetchFile(url, name);
      if (!blob) {
        failedCount++;
        publishTestState({ 'failed-file-count': String(failedCount) });
      }
      return blob;
    };
  }
  return fetchFile;
}
