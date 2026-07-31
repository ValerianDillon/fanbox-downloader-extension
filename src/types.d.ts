/**
 * scripts/build.ts の --define で注入されるビルド時定数。
 * 通常ビルドでは false (dead code elimination によりテスト専用コードは dist/ に残らない)、
 * `--test` ビルド (dist-test/) では true になる。
 */
declare const __FBDL_TEST__: boolean;

/**
 * bun build の `with { type: 'text' }` インポート。
 * CSS を文字列として読み込み、shadow DOM に流し込むために使う。
 */
declare module '*.css' {
  const content: string;
  export default content;
}
