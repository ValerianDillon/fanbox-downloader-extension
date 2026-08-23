import type {
  AllocatedAssetPaths,
  ArchivePathAllocator,
  DownloadUtils,
  ReadonlyPostObj,
} from 'download-helper/download-helper';
import { assetKeyToString } from 'download-helper/download-helper';

/**
 * ZIP の出力形式のバージョン (Issue #56)。
 *
 * archive path の採番規則を変えると、同じ投稿が過去の ZIP と違う場所に入る。
 * 「前回保存済み」の判定は保存実績の archive 名を突き合わせるので、規則が変わったことを
 * 記録しておかないと、実際には別の場所に入っている過去の ZIP を根拠に取得を省いてしまう。
 *
 * 1 は共有層の `createLegacyArchivePathAllocator` による従来の採番 (同名グループの件数に依存)。
 * 2 は postId 由来の採番 (このモジュール)。
 */
export const ARCHIVE_FORMAT_VERSION = 2;

/**
 * 1 つのパスセグメント全体に許す UTF-8 バイト数。
 *
 * ext4 のファイル名上限は 255 bytes で、超えると ZIP は作れても展開できない。
 * 余裕を見て 200 bytes にしてある (投稿ディレクトリ名とアセット名を連ねたパス全体の上限は
 * 共有層の `preflight` が別に見る)。
 */
const SEGMENT_MAX_BYTES = 200;

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

/**
 * `toSafeExtension` が符号化しない文字。
 * `.` を残すのは `tar.gz` のような複合拡張子を壊さないためで、`_` は含めないので
 * 識別子との切れ目は曖昧にならない。
 */
const SAFE_EXTENSION_CHARS = /^[A-Za-z0-9-.]$/;

/**
 * 識別子を、archive 名の中で曖昧さなく取り出せる形にする。
 *
 * archive 名は `<元の名前>_<kind>_<識別子><拡張子>` の形で組み立てる。元の名前は利用者が付けた
 * 任意の文字列なので `_file_` のような並びを含みうる。識別子側にも同じ並びが現れうると、
 * 別の (名前, 鍵) の組が同じ archive 名になり、**同じパスに 2 エントリ入って片方が失われる**
 * (共有層はアセット同士の名前衝突を検査しない)。
 *
 * そこで識別子からは `_` を含む「安全でない文字」を追い出す。`~` を escape 記号にし、`~` 自体も
 * 符号化するので、符号化後の文字列から元の識別子を一意に復元できる。`-` を残すのは、FANBOX の
 * assetId に現れる文字で、残しても曖昧さが生じないため (読みやすさのため)。
 *
 * `encodeFileName` が別の文字へ潰す文字 (`/` と `／` など) も符号化されるので、正規化で
 * 潰れて同じ名前になることも無い。
 * @param value 識別子 (assetId など)
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
 * 拡張子は共有層の decoder が文字列としてしか検証していないので、`_file_` のような並びも入りうる。
 * 素のまま末尾に付けると識別子との切れ目が曖昧になるため、先頭のドットを除いた本体を符号化する。
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
 * 予約名 (`index.html` / `info.json` など) との衝突はここでは見ない。
 * どのファイル名が予約されているかは共有層が決めることで、こちらに写すと定義が 2 箇所になる。
 * 共有層の `preflight` が保存先を確保する前に弾く。
 * @param name 検証する名前
 * @param context エラーメッセージに含める対象の説明
 * @param utils 正規化に使うユーティリティ
 */
function assertUsableSegment(name: string, context: string, utils: DownloadUtils): void {
  // 判定は共有層の isValidPathSegment と同じにする。Windows は末尾の空白とピリオドを取り除いて
  // 解釈するので、'...' や '. .' も '.' や '..' と同じ扱いになる
  const trimmedTrailing = name.replace(/[ .]+$/u, '');
  if (trimmedTrailing === '' || trimmedTrailing === '.' || trimmedTrailing === '..') {
    throw new Error(`${context}がパスセグメントとして使えません (${JSON.stringify(name)})`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ZIP のエントリ名として不正な文字を弾く
  if (/[/\\:\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`${context}に使えない文字が含まれています (${JSON.stringify(name)})`);
  }
  if (utils.encodeFileName(name) !== name) {
    throw new Error(`${context}が正規化されていません (${JSON.stringify(name)})`);
  }
  // `%` を含む名前は ZIP の実体と HTML の参照がずれる (toNameSlug のコメント参照)。
  // 凍結名は保存実績として固定されるので、壊れた名前を受け取った時点で拒否する
  if (name.includes('%') || name.includes('?')) {
    throw new Error(`${context}に % または ? が含まれています (${JSON.stringify(name)})`);
  }
  if (byteLength(name) > SEGMENT_MAX_BYTES) {
    throw new Error(`${context}が長すぎます (UTF-8 ${byteLength(name)} bytes, 上限 ${SEGMENT_MAX_BYTES} bytes)`);
  }
  // 孤立サロゲートは書き込み時に U+FFFD へ置き換えられる。凍結名として固定すると、
  // 記録上の名前と ZIP の実体名が違うものになる
  if (toWellFormed(name) !== name) {
    throw new Error(`${context}に孤立サロゲートが含まれています (${JSON.stringify(name)})`);
  }
}

/**
 * 割り当てた名前が互いに重なっていないことを確かめる。
 *
 * 名前は「利用者が付けた任意の文字列 (元の名前・拡張子)」と「識別子」を連ねて作る。
 * 識別子側は `toSafeIdentity` で曖昧さを消しているが、**組み立て全体が単射であることを文字列の形
 * だけで保証しきるのは難しい** (`encodeFileName` が別々の文字を同じ文字へ潰す、凍結名は任意の値を
 * 取れる、など)。
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
 * 名前が同じパスとして扱われるかを比べるための正規化。
 *
 * Windows と既定の macOS は大文字小文字を区別せず、Windows は末尾の空白とピリオドを取り除いて
 * 解釈する。完全一致だけで比べると、`a.bin` と `A.BIN` を別の名前として通してしまい、
 * 展開時に一方が上書きされる。共有層が予約名の比較に使っているのと同じ畳み方である。
 * @param name 比較する名前
 */
function toCollisionKey(name: string): string {
  // 合成済みへ寄せる。macOS の APFS は正規化を区別しないので、'é' と 'e\u0301' は
  // 同じディレクトリに共存できない
  return name
    .normalize('NFC')
    .replace(/[ .]+$/u, '')
    .toLowerCase();
}

/**
 * UTF-8 でのバイト数を返す
 * @param value 対象の文字列
 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
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
 * 孤立サロゲートを U+FFFD へ置き換える (`String.prototype.toWellFormed` 相当)。
 *
 * ZIP のエントリ名は `TextEncoder` で UTF-8 にするが、孤立サロゲートはそこで U+FFFD へ
 * 置き換えられる。置き換え前の文字列で一意性を見ると、**書き込み時に同じバイト列になる名前を
 * 別物として通してしまう**。tsconfig の lib が es2021 なので、標準メソッドは型に無い。
 * @param value 対象の文字列
 */
function toWellFormed(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * 元の名前を archive 名に使える形にする。
 *
 * 長さで切るのは、セグメント全体が ext4 のファイル名上限 (255 bytes) を超えると、ZIP は作れても
 * 展開できないため。識別子と拡張子を先に確保し、残りを元の名前に割り当てる。
 * @param name 元の名前 (投稿タイトルまたはアセット名)
 * @param utils 正規化に使うユーティリティ
 * @param budgetBytes 元の名前に割り当てられる UTF-8 バイト数
 */
function toNameSlug(name: string, utils: DownloadUtils, budgetBytes: number): string {
  const truncated = truncateToBytes(name, budgetBytes);
  // encodeFileName は Windows で使えない文字を置き換えるが、`%` は残す。共有層の HTML 生成が使う
  // encodeURI も `%` を符号化しないので、`%2F資料` という名前は ZIP ではそのままなのに HTML の
  // 参照は `/資料` として解釈され、実在しないファイルを指す。全角へ寄せるのは encodeFileName が
  // 他の使えない文字に対して取っているのと同じやり方である
  // 孤立サロゲートはここで潰す。潰さないと、書き込み時に同じバイト列になる名前を
  // 一意性検査が別物として通してしまう
  // `%` と `?` は encodeFileName が写さない。`%` は HTML の参照がずれ (encodeURI が符号化しない)、
  // `?` は Windows でファイル名に使えない。encodeFileName が他の使えない文字に取っているのと
  // 同じやり方で全角へ寄せる
  const escaped = utils.encodeFileName(toWellFormed(truncated)).replaceAll('%', '％').replaceAll('?', '？');
  // 末尾の空白とピリオドは encodeFileName が残す。Windows はそれらを取り除いて解釈するので、
  // 残すと共有層の予約名判定と食い違う
  return escaped.replace(/[\s.]+$/u, '');
}

/**
 * postId 由来の archive path を割り当てる (Issue #56)。
 *
 * 従来の採番 (`createLegacyArchivePathAllocator`) は同名グループの件数に依存するため、同名の投稿や
 * アセットが増減すると**過去に割り当てた名前まで変わる**。複数の ZIP をまたいで同じ投稿を同定
 * できないので、差分ダウンロードの保存実績が指す先を失う。
 *
 * ここでは投稿を postId で、アセットを `AssetKey` で指す。どちらも収集結果の増減に影響されない。
 *
 * - 投稿ディレクトリ: `<postId>_<タイトル>`。タイトルが空になる場合は `<postId>` だけ
 * - 本文アセット: `<元の名前>_<kind>_<assetId><拡張子>`。**鍵は常に付ける。** 衝突したときだけ付ける
 *   形にすると、同名のアセットが増えた時点で既存の名前が変わる。`kind` も含めるのは、共有層の
 *   identity が `kind` と `assetId` の組だからである (image と file で同じ `assetId` が来ても別物)
 * - カバー: `cover<拡張子>`。投稿に高々 1 つなので、それだけで一意である
 *
 * アセット名には必ず `image_` / `file_` が入るので、投稿ディレクトリ直下の予約名
 * (`index.html` / `info.json` / `info.txt`) と一致しない。
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
    const base = toSafeIdentity(post.postId);
    // 識別子を先に確保し、残りをタイトルに割り当てる。区切りの 1 バイトも引く
    const slug = toNameSlug(post.name, utils, SEGMENT_MAX_BYTES - byteLength(base) - 1);
    return slug === '' ? base : `${base}_${slug}`;
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
      const allocated: AllocatedAssetPaths = {
        files: post.files.map((file) => {
          const frozenName = frozenForPost?.get(assetKeyToString(file.key));
          if (frozenName !== undefined) return { key: file.key, archiveName: frozenName };
          // kind も含める。共有層の identity は kind と assetId の組であり、image と file で
          // 同じ assetId が来ても別のアセットである。assetId だけだと同じ名前になり、
          // 同じパスに 2 エントリ入って片方が失われる
          const identity = `${file.key.kind}_${toSafeIdentity(file.key.assetId)}`;
          const extension = toSafeExtension(file.extension);
          // 識別子と拡張子を先に確保し、残りを元の名前に割り当てる。区切りの 1 バイトも引く
          const slug = toNameSlug(
            file.name,
            utils,
            SEGMENT_MAX_BYTES - byteLength(identity) - byteLength(extension) - 1,
          );
          const stem = slug === '' ? identity : `${slug}_${identity}`;
          // 拡張子を後から繋ぐと、拡張子側に正規化対象の文字があったときに
          // 「正規化済みの名前を返す」という allocator の契約を破る
          return { key: file.key, archiveName: utils.encodeFileName(`${stem}${extension}`) };
        }),
      };
      if (post.cover) {
        const frozenName = frozenForPost?.get(assetKeyToString(post.cover.key));
        allocated.coverArchiveName =
          frozenName ?? utils.encodeFileName(`cover${toSafeExtension(post.cover.extension)}`);
      }
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
