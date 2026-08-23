/**
 * archive 名がパスセグメントとして使えるかの規則 (Issue #56)。
 *
 * `content/archive-path.ts` の allocator と、`history-record.ts` の履歴の復号が同じ規則を使う。
 * 履歴に入った名前は次回の凍結名として allocator へ渡るので、規則が食い違うと
 * **復号を通った履歴が allocator で例外になり、次のダウンロードごと止まる**。
 * 「読めない履歴は履歴が無いものとして扱う」という契約を守るには、判定が 1 箇所である必要がある。
 *
 * このモジュールは共有層 (`download-helper`) に依存しない。履歴の復号は service worker 側でも
 * 走るので、依存すると共有層が service worker のバンドルに入る。
 * 共有層の `DownloadUtils` を要する正規化の判定 (`encodeFileName` を通しても変わらないこと) だけは
 * `archive-path.ts` 側に残る。
 */

/**
 * 1 つのパスセグメント全体に許す UTF-8 バイト数。
 *
 * ext4 のファイル名上限は 255 bytes で、超えると ZIP は作れても展開できない。
 * 余裕を見て 200 bytes にしてある (投稿ディレクトリ名とアセット名を連ねたパス全体の上限は
 * 共有層の `preflight` が別に見る)。
 */
export const SEGMENT_MAX_BYTES = 200;

/** UTF-8 でのバイト数 */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * 孤立サロゲートを U+FFFD へ置き換える。
 *
 * ZIP のエントリ名は `TextEncoder` で UTF-8 にするが、孤立サロゲートはそこで置き換えられる。
 * `String.prototype.toWellFormed` は Chrome 111 以降にあるが、テスト環境の差を避けて自前で持つ。
 */
export function toWellFormed(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * archive 名がパスセグメントとして使えないなら、その理由を返す。使えるなら null。
 *
 * 判定の内訳:
 *
 * - 末尾の空白とピリオドを落とすと空・`.`・`..` になる名前 — Windows は末尾の空白とピリオドを
 *   取り除いて解釈するので、`...` や `. .` も親ディレクトリと同じ扱いになりうる
 * - `/` `\` `:` と制御文字 — ZIP のエントリ名として不正である
 * - `%` と `?` — `%` は共有層の HTML 生成が使う `encodeURI` が符号化しないため、`%2F資料` は
 *   ZIP ではそのままなのに HTML の参照が `/資料` として解釈される。`?` は Windows で使えない
 * - `SEGMENT_MAX_BYTES` を超える名前 — 展開できない ZIP になる
 * - 孤立サロゲートを含む名前 — 書き込み時に U+FFFD へ置き換えられるので、記録上の名前と
 *   ZIP の実体名が違うものになる
 * - 共有層の `encodeFileName` が書き換える名前 — 通すと、記録した名前と実際に書かれる名前が
 *   食い違う。`encodeFileName` は固定の文字を全角へ寄せて前後の空白を落とすだけなので、
 *   「書き換えられない」条件はここに写せる (一致は契約テストで固定する)
 */
export function describeUnusableSegment(name: string): string | null {
  const trimmedTrailing = name.replace(/[ .]+$/u, '');
  if (trimmedTrailing === '' || trimmedTrailing === '.' || trimmedTrailing === '..') {
    return 'パスセグメントとして使えません';
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ZIP のエントリ名として不正な文字を弾く
  if (/[/\\:\u0000-\u001f\u007f]/.test(name)) return '使えない文字が含まれています';
  if (name.includes('%') || name.includes('?')) return '% または ? が含まれています';
  if (byteLength(name) > SEGMENT_MAX_BYTES) {
    return `長すぎます (UTF-8 ${byteLength(name)} bytes, 上限 ${SEGMENT_MAX_BYTES} bytes)`;
  }
  if (toWellFormed(name) !== name) return '孤立サロゲートが含まれています';
  if (ENCODED_BY_SHARED_LAYER.test(name)) return '共有層が書き換える文字が含まれています';
  if (name.trim() !== name) return '前後に空白があります';
  return null;
}

/**
 * 共有層の `encodeFileName` が全角へ寄せる文字。
 *
 * この集合と `DownloadUtils.encodeFileName` の一致は `test/archive-name-rules.test.ts` が固定する。
 * 共有層が対象を増やしたらそこが落ちる。
 */
const ENCODED_BY_SHARED_LAYER = /[/\\,:*"<>|]/;
