import type {
  AllocatedAssetPaths,
  ArchivePathAllocator,
  DownloadUtils,
  ReadonlyPostObj,
} from 'download-helper/download-helper';
import { assetKeyToString } from 'download-helper/download-helper';
import {
  byteLength,
  describeUnusableSegment,
  SEGMENT_MAX_BYTES,
  toCollisionKey,
  toWellFormed,
} from '../archive-name-rules';

/**
 * ZIP の出力形式のバージョン (Issue #56)。
 *
 * archive path の採番規則を変えると、同じ投稿が過去の ZIP と違う場所に入る。
 * 「前回保存済み」の判定は保存実績の archive 名を突き合わせるので、規則が変わったことを
 * 記録しておかないと、実際には別の場所に入っている過去の ZIP を根拠に取得を省いてしまう。
 *
 * 1 は共有層の `createLegacyArchivePathAllocator` による従来の採番 (同名グループの件数に依存)。
 * 2 は postId と元ファイル名を含む採番。
 * 3 は `<タイトル> [<postId>]` と投稿内の数字連番による採番。
 */
export const ARCHIVE_FORMAT_VERSION = 3;

/**
 * 既に割り当て済みの archive 名。
 *
 * **一度割り当てた名前は、投稿タイトルやアセット名が編集されても変えない。** 変えると、
 * 過去の ZIP と同じ投稿を同定できなくなり、保存実績が指す先を失う。
 * 差分ダウンロードが保存実績から組み立てて渡す (Issue #56)。
 *
 * アセットは postId で入れ子にする。`AssetKey` は投稿内でしか一意でないので postId と組にする
 * 必要があるが、区切り文字で連結した平坦なキーにすると、postId や assetId にその文字が現れたときに
 * 別の組が同じキーへ潰れる (その文字が現れないという不変条件はどこも検証していない)。
 */
export type FrozenArchiveNames = {
  /** postId → 割り当て済みの投稿ディレクトリ名 */
  readonly postDirectories: ReadonlyMap<string, string>;
  /** postId → (`assetKeyToString(key)` → 割り当て済みの archive 名) */
  readonly assetNames: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

/** `toSafeIdentity` が符号化しない文字 */
const SAFE_IDENTITY_CHARS = /^[A-Za-z0-9-]$/;

/** archive 名の拡張子でそのまま使える文字。 */
const SAFE_EXTENSION_CHARS = /^[A-Za-z0-9-.]$/;

/**
 * 識別子を、archive 名の中で曖昧さなく取り出せる形にする。
 *
 * 投稿ディレクトリは `<タイトル> [<postId>]` の形で組み立てる。タイトルは利用者が付けた任意の
 * 文字列なので、区切りに使う角括弧と同じ並びを含みうる。postId 側を一意に符号化しておけば、
 * 正規化によって別の postId が同じディレクトリ名へ潰れることを避けられる。
 *
 * `_` を含む安全でない文字は `~<code point>~` へ符号化する。`~` 自体も符号化するので、
 * 符号化後の文字列から元の識別子を一意に復元できる。`-` を残すのは FANBOX の postId に
 * 現れても曖昧さが生じないためである。
 *
 * `encodeFileName` が別の文字へ潰す文字 (`/` と `／` など) も符号化されるので、正規化で
 * 潰れて同じ名前になることも無い。
 * @param value 投稿の識別子
 */
function toSafeIdentity(value: string): string {
  let encoded = '';
  for (const character of value) {
    encoded += SAFE_IDENTITY_CHARS.test(character) ? character : `~${(character.codePointAt(0) ?? 0).toString(16)}~`;
  }
  return encoded;
}

/**
 * 拡張子を archive 名に使える形にする。
 *
 * 拡張子は共有層の decoder が文字列としてしか検証していないので、パスに使えない文字も入りうる。
 * 数字連番の末尾へ安全に付けられるよう、先頭のドットを除いた本体を符号化する。
 * 実際の拡張子 (`png` / `pdf` / `tar.gz` など) は符号化しても変わらない。
 * @param extension `FileObj.extension` (先頭ドット付き、または空文字列)
 */
function toSafeExtension(extension: string): string {
  if (extension === '') return '';
  const body = extension.startsWith('.') ? extension.slice(1) : extension;
  let encoded = '';
  for (const character of body) {
    encoded += SAFE_EXTENSION_CHARS.test(character) ? character : `~${(character.codePointAt(0) ?? 0).toString(16)}~`;
  }
  return `.${encoded}`;
}

/**
 * 凍結済みの名前が ZIP のパスセグメントとして使える形かを確かめる。
 *
 * 凍結名は保存実績から来る任意の値で、生成時のような組み立てを経ない。
 * 「不正なら受け取った時点で拒否する」ためには、正規化済みであることだけでは足りない。
 *
 * 予約名 (`index.html` / `post.json` など) との衝突はここでは見ない。
 * どのファイル名が予約されているかは共有層が決めることで、こちらに写すと定義が 2 箇所になる。
 * 共有層の `preflight` が保存先を確保する前に弾く。
 * @param name 検証する名前
 * @param context エラーメッセージに含める対象の説明
 * @param utils 正規化に使うユーティリティ
 */
function assertUsableSegment(name: string, context: string, utils: DownloadUtils): void {
  // 判定の本体は `archive-name-rules.ts` にある。履歴の復号も同じ規則を使うので、ここに書き足すと
  // 復号を通った凍結名が allocator で例外になり、次のダウンロードごと止まる
  const unusable = describeUnusableSegment(name);
  if (unusable !== null) throw new Error(`${context}が${unusable} (${JSON.stringify(name)})`);
  // 正規化の判定だけはここに残る。共有層の DownloadUtils を要するため、
  // service worker 側でも走る履歴の復号には持ち込めない
  if (utils.encodeFileName(name) !== name) {
    throw new Error(`${context}が正規化されていません (${JSON.stringify(name)})`);
  }
}

/**
 * 割り当てた名前が互いに重なっていないことを確かめる。
 *
 * 投稿ディレクトリはタイトルと postId を、アセット名は数字連番と拡張子を連ねて作る。
 * 識別子と拡張子は符号化しているが、**組み立て全体が単射であることを文字列の形だけで保証しきる
 * のは難しい** (`encodeFileName` が別々の文字を同じ文字へ潰す、凍結名は任意の値を取れる、など)。
 *
 * 共有層はアセット同士の名前衝突を検査しない (legacy allocator が作りうるものとして許容している)
 * ので、ここで検出しないと同じパスに 2 エントリ入って片方が黙って失われる。
 * 例外にすれば、呼び出し元が保存先を確保する前に気付ける。
 * @param names 割り当てた名前
 * @param context エラーメッセージに含める対象の説明
 */
function assertUniqueNames(names: readonly string[], context: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    const key = toCollisionKey(name);
    if (seen.has(key)) {
      throw new Error(`${context}の archive 名が重複しています (${JSON.stringify(name)})`);
    }
    seen.add(key);
  }
}

/**
 * UTF-8 で指定バイト数に収まるところまで切る。
 *
 * コードポイント単位で足していくのは、UTF-16 の符号単位で切るとサロゲート対が割れて
 * 不正な文字が残るため。
 * @param value 対象の文字列
 * @param maxBytes 許す UTF-8 バイト数
 */
function truncateToBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

/**
 * 投稿タイトルを archive 名に使える形にする。
 *
 * 長さで切るのは、セグメント全体が ext4 のファイル名上限 (255 bytes) を超えると、ZIP は作れても
 * 展開できないため。postId を先に確保し、残りを投稿タイトルに割り当てる。
 * @param name 投稿タイトル
 * @param utils 正規化に使うユーティリティ
 * @param budgetBytes 投稿タイトルに割り当てられる UTF-8 バイト数
 */
function toNameSlug(name: string, utils: DownloadUtils, budgetBytes: number): string {
  // encodeFileName は Windows で使えない文字を置き換えるが、`%` は残す。共有層の HTML 生成が使う
  // encodeURI も `%` を符号化しないので、`%2F資料` という名前は ZIP ではそのままなのに HTML の
  // 参照は `/資料` として解釈され、実在しないファイルを指す。全角へ寄せるのは encodeFileName が
  // 他の使えない文字に対して取っているのと同じやり方である
  // 孤立サロゲートはここで潰す。潰さないと、書き込み時に同じバイト列になる名前を
  // 一意性検査が別物として通してしまう
  // `%` と `?` は encodeFileName が写さない。`%` は HTML の参照がずれ (encodeURI が符号化しない)、
  // `?` は Windows でファイル名に使えない。encodeFileName が他の使えない文字に取っているのと
  // 同じやり方で全角へ寄せる
  const escaped = utils.encodeFileName(toWellFormed(name)).replaceAll('%', '％').replaceAll('?', '？');
  // 正規化で 1 byte の文字が全角 3 bytes へ膨らみうるので、バイト予算による切り詰めは
  // 正規化後に行う。先に切ると `/` の繰り返しなどで最終セグメントが予算を超える。
  const truncated = truncateToBytes(escaped, budgetBytes);
  // 末尾の空白とピリオドは encodeFileName が残す。Windows はそれらを取り除いて解釈するので、
  // 残すと共有層の予約名判定と食い違う
  return truncated.replace(/[\s.]+$/u, '');
}

/**
 * 投稿タイトルと数字連番による archive path を割り当てる。
 *
 * 従来の採番 (`createLegacyArchivePathAllocator`) は同名グループの件数に依存するため、同名の投稿や
 * アセットが増減すると**過去に割り当てた名前まで変わる**。複数の ZIP をまたいで同じ投稿を同定
 * できないので、差分ダウンロードの保存実績が指す先を失う。
 *
 * ここでは投稿を postId で、アセットを `AssetKey` で指す。どちらも収集結果の増減に影響されない。
 *
 * - 投稿ディレクトリ: `<タイトル> [<postId>]`。タイトルが空になる場合は `[<postId>]` だけ
 * - カバーと本文アセット: `001<拡張子>` から始まる数字連番。カバーがあれば先頭に置く
 *
 * 数字だけの stem なので、投稿ディレクトリ直下の予約名 (`index.html` / `post.json`) と一致しない。
 * 投稿ディレクトリ名はルートの予約名 (`index.html` / `download-manifest.json`) と一致しうるが、
 * それには postId 自体がその文字列である必要があり、共有層の `preflight` が picker より前に弾く。
 *
 * `frozen` を渡すと、そこに載っている投稿・アセットはその名前をそのまま使う。
 * 一度出力した名前を、タイトルやファイル名の編集で変えないための入口である。
 *
 * 共有層の契約どおり決定的で、入力を変更しない。呼び出し回数に依存する状態を持たない。
 * @param utils 正規化に使うユーティリティ
 * @param frozen 既に割り当て済みの名前 (省略時は現在の収集結果だけから決める)
 */
export function createPostIdArchivePathAllocator(
  utils: DownloadUtils,
  frozen?: FrozenArchiveNames,
): ArchivePathAllocator {
  // 複製するのは、作成後に呼び出し側が Map を変更すると同じ入力への結果が変わり、
  // 共有層が求める決定性を破るため。併せて正規化済みかと投稿内で一意かを確かめる
  // (frozen 名は保存実績とずれるので後から直せない。不正なら受け取った時点で拒否する)
  const frozenPostDirectories = new Map(frozen?.postDirectories ?? []);
  const seenDirectories = new Set<string>();
  for (const [postId, name] of frozenPostDirectories) {
    assertUsableSegment(name, `凍結済みの投稿ディレクトリ名 (${postId})`, utils);
    // postId が違えばディレクトリも違うはずなので、同じ名前が 2 つあれば凍結の記録が壊れている
    if (seenDirectories.has(toCollisionKey(name))) {
      throw new Error(`凍結済みの投稿ディレクトリ名が重複しています (${JSON.stringify(name)})`);
    }
    seenDirectories.add(toCollisionKey(name));
  }
  const frozenAssetNames = new Map<string, Map<string, string>>();
  for (const [postId, names] of frozen?.assetNames ?? []) {
    const perPost = new Map<string, string>();
    const seen = new Set<string>();
    for (const [keyString, name] of names) {
      assertUsableSegment(name, `凍結済みのアセット名 (${postId} ${keyString})`, utils);
      // 同じ投稿の中で名前が重なると、同じパスに 2 エントリ入って片方が失われる。
      // 共有層はアセット同士の衝突を検査しないので、ここで弾く
      if (seen.has(toCollisionKey(name))) {
        throw new Error(`凍結済みのアセット名が同じ投稿の中で重複しています (${postId}: ${JSON.stringify(name)})`);
      }
      seen.add(toCollisionKey(name));
      perPost.set(keyString, name);
    }
    frozenAssetNames.set(postId, perPost);
  }

  const allocatePostDirectory = (post: ReadonlyPostObj): string => {
    const frozenName = frozenPostDirectories.get(post.postId);
    if (frozenName !== undefined) return frozenName;
    // postId も符号化する。素のまま使うと ("a", "b_c") と ("a_b", "c") が同じ名前になり、
    // 正規化で潰れる文字 (`/` と `／`) でも衝突する
    const identity = `[${toSafeIdentity(post.postId)}]`;
    // 識別子を先に確保し、残りをタイトルに割り当てる。間の空白 1 byte も引く。
    const slug = toNameSlug(post.name, utils, SEGMENT_MAX_BYTES - byteLength(identity) - 1);
    const directory = slug === '' ? identity : `${slug} ${identity}`;
    // postId の符号化自体が長い場合もあるので、組み立て後のセグメント全体を契約で検証する。
    assertUsableSegment(directory, `投稿ディレクトリ名 (${post.postId})`, utils);
    return directory;
  };

  return {
    allocatePostDirectoryNames(posts) {
      // postId 自体の重複も見る。タイトルが違えばディレクトリ名は分かれてしまうが、
      // postId を投稿の identity として扱う以上、同じ postId が 2 つあるのは表現できない状態である
      // (凍結名も postId をキーにするので、どちらの名前を覚えればよいか決められない)。
      // 判定は完全一致で行う。postId は識別子であってパスではないので、大文字小文字が違えば別物である
      const seenPostIds = new Set<string>();
      for (const post of posts) {
        if (seenPostIds.has(post.postId)) {
          throw new Error(`同じ postId の投稿が複数あります (${JSON.stringify(post.postId)})`);
        }
        seenPostIds.add(post.postId);
      }
      const names = posts.map((post) => allocatePostDirectory(post));
      assertUniqueNames(names, '投稿ディレクトリ');
      return names;
    },
    allocateAssetPaths(post) {
      const frozenForPost = frozenAssetNames.get(post.postId);
      // 現在の投稿から消えたアセットの凍結名も予約する。
      // 再利用すると、別のアセットが過去の ZIP と同じ番号を指してしまう。
      const usedIndexes = new Set<number>();
      for (const name of frozenForPost?.values() ?? []) {
        const matched = /^(\d+)(?:\..*)?$/u.exec(name);
        const index = matched === null ? 0 : Number.parseInt(matched[1], 10);
        if (!Number.isSafeInteger(index) || index <= 0 || usedIndexes.has(index)) {
          throw new Error(`凍結済みの数字連番が不正です (${post.postId}: ${JSON.stringify(name)})`);
        }
        usedIndexes.add(index);
      }
      const itemCount = post.files.length + (post.cover ? 1 : 0);
      const maxReserved = usedIndexes.size === 0 ? 0 : Math.max(...usedIndexes);
      const width = Math.max(3, String(Math.max(itemCount, maxReserved)).length);
      let nextIndex = 1;
      const allocate = (
        key: ReadonlyPostObj['files'][number]['key'] | { readonly kind: 'cover' },
        extension: string,
      ) => {
        const frozenName = frozenForPost?.get(assetKeyToString(key));
        if (frozenName !== undefined) return frozenName;
        while (usedIndexes.has(nextIndex)) nextIndex++;
        const index = nextIndex++;
        usedIndexes.add(index);
        return `${String(index).padStart(width, '0')}${toSafeExtension(extension)}`;
      };
      const allocated: AllocatedAssetPaths = {
        files: [],
      };
      if (post.cover) {
        allocated.coverArchiveName = allocate(post.cover.key, post.cover.extension);
      }
      allocated.files = post.files.map((file) => ({ key: file.key, archiveName: allocate(file.key, file.extension) }));
      // 凍結名と新しく割り当てた名前が重なることもあるので、解決し終えた全体を見る
      assertUniqueNames(
        [
          ...allocated.files.map((file) => file.archiveName),
          ...(allocated.coverArchiveName === undefined ? [] : [allocated.coverArchiveName]),
        ],
        `投稿 ${post.postId} のアセット`,
      );
      return allocated;
    },
  };
}
