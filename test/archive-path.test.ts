import { describe, expect, test } from 'bun:test';
import type {
  AssetMetadata,
  BodyAssetKey,
  BodyFileObj,
  CoverFileObj,
  ReadonlyPostObj,
} from 'download-helper/download-helper';
import { assetKeyToString, DownloadObject, DownloadUtils } from 'download-helper/download-helper';
import { ARCHIVE_FORMAT_VERSION, createPostIdArchivePathAllocator } from '../src/content/archive-path';

function makeBodyFile(
  key: BodyAssetKey,
  name: string,
  extension: string,
  metadata: AssetMetadata = {},
): Readonly<BodyFileObj> {
  return {
    key,
    name,
    extension,
    url: `https://example.test/${key.assetId}`,
    metadata,
  };
}

function makeCover(name: string, extension: string): Readonly<CoverFileObj> {
  return {
    key: { kind: 'cover' },
    name,
    extension,
    url: 'https://example.test/cover',
    metadata: {},
  };
}

function makePost(
  postId: string,
  name: string,
  files: readonly Readonly<BodyFileObj>[] = [],
  cover?: Readonly<CoverFileObj>,
): ReadonlyPostObj {
  return cover === undefined
    ? { postId, name, info: '', files, html: [], tags: [] }
    : { postId, name, info: '', files, html: [], tags: [], cover };
}

describe('postId 由来の archive path', () => {
  test('投稿ディレクトリ名は postId とタイトルを連結する', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);

    expect(allocator.allocatePostDirectoryNames([makePost('post-1', '好きなタイトル')])).toEqual([
      'post-1_好きなタイトル',
    ]);
  });

  test.each([
    ['', 'post-empty'],
    ['...', 'post-dots'],
    ['   ', 'post-spaces'],
  ])('タイトル %s が空になると postId だけになる', (title, expected) => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);

    expect(allocator.allocatePostDirectoryNames([makePost(expected, title)])).toEqual([expected]);
  });

  // postId を素のまま使うと ("a", "b_c") と ("a_b", "c") が同じディレクトリ名になる。
  // 同じパスに 2 投稿ぶんの中身が入り、片方の index.html と info.json が失われる
  test('postId とタイトルの切れ目が曖昧になる組でも別のディレクトリ名になる', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);

    const names = allocator.allocatePostDirectoryNames([makePost('a', 'b_c'), makePost('a_b', 'c')]);

    expect(new Set(names).size).toBe(names.length);
  });

  // 凍結名と新しく割り当てた名前が重なることもある。共有層は投稿ディレクトリ名の重複を
  // preflight で弾くが、そこまで進むと保存先を確保した後になる
  test('凍結名と新規割り当ての投稿ディレクトリ名が重なったら例外にする', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils, {
      postDirectories: new Map([['post-1', 'post-2_タイトル']]),
      assetNames: new Map(),
    });

    expect(() =>
      allocator.allocatePostDirectoryNames([makePost('post-1', '別のタイトル'), makePost('post-2', 'タイトル')]),
    ).toThrow('重複しています');
  });

  // 共有層は postId の一意性を検証しないので、収集側で重複排除していなければここに届く。
  // タイトルが違うとディレクトリ名は分かれてしまうが、postId を投稿の identity として扱う以上、
  // 同じ postId が 2 つあるのは表現できない状態である
  test.each([
    ['同じタイトル', 'a', 'a'],
    ['違うタイトル', '古いタイトル', '新しいタイトル'],
  ])('同じ postId が 2 回渡ったら例外にする (%s)', (_label, firstTitle, secondTitle) => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);

    expect(() =>
      allocator.allocatePostDirectoryNames([makePost('post-1', firstTitle), makePost('post-1', secondTitle)]),
    ).toThrow('同じ postId の投稿が複数あります');
  });

  // postId は識別子であってパスではないので、大文字小文字が違えば別の投稿である。
  // パス上の衝突は生成後のディレクトリ名の検査が見る
  test('大文字小文字だけ違う postId は別の投稿として扱う', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);

    expect(allocator.allocatePostDirectoryNames([makePost('A', 'x'), makePost('a', 'y')])).toEqual(['A_x', 'a_y']);
  });

  test('同名の投稿が複数あっても互いの名前が変わらない', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const posts = [
      makePost('post-1', '同じタイトル'),
      makePost('post-2', '同じタイトル'),
      makePost('post-3', '同じタイトル'),
    ];

    expect(allocator.allocatePostDirectoryNames(posts)).toEqual([
      'post-1_同じタイトル',
      'post-2_同じタイトル',
      'post-3_同じタイトル',
    ]);
  });

  test('投稿を増やしても既存投稿のディレクトリ名が変わらない', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const posts = [makePost('post-1', '同じタイトル'), makePost('post-2', '同じタイトル')];

    expect(allocator.allocatePostDirectoryNames(posts)).toEqual(['post-1_同じタイトル', 'post-2_同じタイトル']);
    expect(allocator.allocatePostDirectoryNames([...posts, makePost('post-3', '同じタイトル')])).toEqual([
      'post-1_同じタイトル',
      'post-2_同じタイトル',
      'post-3_同じタイトル',
    ]);
  });
});

describe('アセットの archive path', () => {
  test('本文アセットの archive 名は元の名前と鍵と拡張子を連結する', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [makeBodyFile({ kind: 'file', assetId: 'asset-1' }, '資料', '.png')]);

    expect(allocator.allocateAssetPaths(post).files.map((file) => file.archiveName)).toEqual(['資料_file_asset-1.png']);
  });

  // 共有層の identity は kind と assetId の組である。assetId だけを名前に入れると、
  // image と file で同じ assetId が来たときに同じパスへ 2 エントリ入って片方が失われる
  test('image と file で同じ assetId でも別の名前になる', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [
      makeBodyFile({ kind: 'image', assetId: 'same' }, '同じ名前', '.png'),
      makeBodyFile({ kind: 'file', assetId: 'same' }, '同じ名前', '.png'),
    ]);

    const names = allocator.allocateAssetPaths(post).files.map((file) => file.archiveName);

    expect(names).toEqual(['同じ名前_image_same.png', '同じ名前_file_same.png']);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * 元の名前は利用者が付けた任意の文字列なので `_file_` のような並びを含みうる。
   * 識別子側にも同じ並びが現れうると、別の (名前, 鍵) の組が同じ archive 名になり、
   * 同じパスに 2 エントリ入って片方が失われる。
   */
  test('元の名前と assetId の切れ目が曖昧になる組でも別の名前になる', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [
      makeBodyFile({ kind: 'file', assetId: 'b_file_c' }, 'a', '.bin'),
      makeBodyFile({ kind: 'file', assetId: 'c' }, 'a_file_b', '.bin'),
    ]);

    const names = allocator.allocateAssetPaths(post).files.map((file) => file.archiveName);

    expect(new Set(names).size).toBe(names.length);
  });

  // encodeFileName は複数の文字を同じ文字へ潰すので、識別子をそのまま名前に入れると
  // 別の assetId が同じ名前になる
  test('正規化で同じ文字に潰れる assetId でも別の名前になる', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [
      makeBodyFile({ kind: 'file', assetId: 'x/y' }, '資料', '.bin'),
      makeBodyFile({ kind: 'file', assetId: 'x／y' }, '資料', '.bin'),
    ]);

    const names = allocator.allocateAssetPaths(post).files.map((file) => file.archiveName);

    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(utils.encodeFileName(name)).toBe(name);
    }
  });

  // 拡張子は共有層の decoder が文字列としてしか検証していないので、区切りと同じ並びも入りうる。
  // 素のまま末尾に付けると識別子との切れ目が曖昧になる
  test('拡張子で切れ目が曖昧になる組でも別の名前になる', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [
      makeBodyFile({ kind: 'file', assetId: 'b' }, 'a', '.x_file_c.y'),
      makeBodyFile({ kind: 'file', assetId: 'c' }, 'a_file_b.x', '.y'),
    ]);

    const names = allocator.allocateAssetPaths(post).files.map((file) => file.archiveName);

    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * Windows と既定の macOS は大文字小文字を区別せず、Windows は末尾の空白とピリオドを取り除いて
   * 解釈する。完全一致だけで比べると展開時に一方が上書きされる。
   */
  // macOS の APFS は正規化を区別しないので、'é' と 'e\u0301' は同じディレクトリに共存できない
  test('Unicode の正規化だけ違う名前になったら例外にする', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [
      makeBodyFile({ kind: 'file', assetId: 'a' }, 'é', '.bin'),
      makeBodyFile({ kind: 'file', assetId: 'a' }, 'e\u0301', '.bin'),
    ]);

    expect(() => allocator.allocateAssetPaths(post)).toThrow('重複しています');
  });

  // 孤立サロゲートは書き込み時に U+FFFD へ置き換えられる。置き換え前で比べると、
  // 同じバイト列になる名前を別物として通してしまう
  test('孤立サロゲートを U+FFFD へ潰してから一意性を見る', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [
      makeBodyFile({ kind: 'file', assetId: 'a' }, 'a\uD800', '.bin'),
      makeBodyFile({ kind: 'file', assetId: 'b' }, 'a\uFFFD', '.bin'),
    ]);

    const names = allocator.allocateAssetPaths(post).files.map((file) => file.archiveName);

    expect(names).toEqual(['a\uFFFD_file_a.bin', 'a\uFFFD_file_b.bin']);
  });

  test('大文字小文字だけ違う名前になったら例外にする', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [
      makeBodyFile({ kind: 'file', assetId: 'A' }, '資料', '.bin'),
      makeBodyFile({ kind: 'file', assetId: 'a' }, '資料', '.bin'),
    ]);

    expect(() => allocator.allocateAssetPaths(post)).toThrow('重複しています');
  });

  // 凍結名は任意の値を取れるので、新しく割り当てた名前と重なりうる。
  // 共有層はアセット同士の衝突を検査しないため、重なったまま通すと片方が失われる
  test('凍結名と新規割り当てが重なったら例外にする', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils, {
      postDirectories: new Map(),
      assetNames: new Map([['post-1', new Map([['file:a', '資料_file_b.bin']])]]),
    });
    const post = makePost('post-1', '投稿', [
      makeBodyFile({ kind: 'file', assetId: 'a' }, '別名', '.bin'),
      makeBodyFile({ kind: 'file', assetId: 'b' }, '資料', '.bin'),
    ]);

    expect(() => allocator.allocateAssetPaths(post)).toThrow('重複しています');
  });

  /**
   * 共有層の HTML 生成が使う encodeURI は `%` を符号化しない。
   * ZIP の実体名は `%2F資料...` のままなのに、HTML の `href="./%2F資料..."` は `/資料...` と
   * 解釈され、実在しないファイルを指す。
   */
  test('名前に含まれる % と ? を全角へ寄せる', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '割合 100%?', [makeBodyFile({ kind: 'file', assetId: 'a' }, '%2F資料?', '.txt')]);

    expect(allocator.allocatePostDirectoryNames([post])).toEqual(['post-1_割合 100％？']);
    expect(allocator.allocateAssetPaths(post).files.map((file) => file.archiveName)).toEqual(['％2F資料？_file_a.txt']);
  });

  // tar.gz のような複合拡張子を壊すと、展開したファイルが関連付けから外れる
  test('複合拡張子はそのまま残す', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [makeBodyFile({ kind: 'file', assetId: 'a' }, '書庫', '.tar.gz')]);

    expect(allocator.allocateAssetPaths(post).files.map((file) => file.archiveName)).toEqual(['書庫_file_a.tar.gz']);
  });

  test.each([
    ['', 'asset-empty', 'file_asset-empty.bin'],
    ['...', 'asset-dots', 'file_asset-dots.bin'],
    ['   ', 'asset-spaces', 'file_asset-spaces.bin'],
  ])('アセット名 %s が空になると鍵と拡張子だけになる', (name, assetId, expected) => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost('post-1', '投稿', [makeBodyFile({ kind: 'file', assetId }, name, '.bin')]);

    expect(allocator.allocateAssetPaths(post).files.map((file) => file.archiveName)).toEqual([expected]);
  });

  test('同名のアセットを増やしても既存のアセット名が変わらない', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const firstFile = makeBodyFile({ kind: 'file', assetId: 'asset-1' }, '同じ名前', '.png');
    const secondFile = makeBodyFile({ kind: 'file', assetId: 'asset-2' }, '同じ名前', '.png');

    expect(
      allocator.allocateAssetPaths(makePost('post-1', '投稿', [firstFile])).files.map((file) => file.archiveName),
    ).toEqual(['同じ名前_file_asset-1.png']);
    expect(
      allocator
        .allocateAssetPaths(makePost('post-1', '投稿', [firstFile, secondFile]))
        .files.map((file) => file.archiveName),
    ).toEqual(['同じ名前_file_asset-1.png', '同じ名前_file_asset-2.png']);
  });

  test('カバーは cover と拡張子になり、カバーが無ければプロパティを返さない', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const withCover = allocator.allocateAssetPaths(makePost('post-1', '投稿', [], makeCover('表紙', '.jpg')));
    const withoutCover = allocator.allocateAssetPaths(makePost('post-2', '投稿'));

    expect(withCover.coverArchiveName).toBe('cover.jpg');
    expect('coverArchiveName' in withoutCover).toBe(false);
  });
});

describe('凍結済み archive name', () => {
  test('凍結済みの投稿ディレクトリ名を優先し未登録の投稿は通常どおり割り当てる', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils, {
      postDirectories: new Map([['post-1', '凍結済みディレクトリ']]),
      assetNames: new Map(),
    });

    expect(
      allocator.allocatePostDirectoryNames([
        makePost('post-1', '変更後のタイトル'),
        makePost('post-2', '新しいタイトル'),
      ]),
    ).toEqual(['凍結済みディレクトリ', 'post-2_新しいタイトル']);
  });

  test('凍結済みの本文アセットとカバーの名前を優先する', () => {
    const utils = new DownloadUtils();
    const file = makeBodyFile({ kind: 'file', assetId: 'asset-1' }, '現在の本文名', '.png');
    const cover = makeCover('現在のカバー名', '.webp');
    const allocator = createPostIdArchivePathAllocator(utils, {
      postDirectories: new Map(),
      assetNames: new Map([
        [
          'post-1',
          new Map([
            [assetKeyToString(file.key), '凍結済み本文.bin'],
            [assetKeyToString(cover.key), '凍結済みカバー.jpg'],
          ]),
        ],
      ]),
    });

    const result = allocator.allocateAssetPaths(makePost('post-1', '投稿', [file], cover));

    expect(result.files.map((item) => item.archiveName)).toEqual(['凍結済み本文.bin']);
    expect(result.coverArchiveName).toBe('凍結済みカバー.jpg');
  });
});

describe('凍結済み archive name の検証', () => {
  // 凍結名は保存実績から来る任意の値で、生成時のような組み立てを経ない。
  // 正規化済みであることだけでは、パスセグメントとして使えるかを確かめたことにならない
  test.each([
    ['空文字列', ''],
    ['ドット', '.'],
    ['親ディレクトリ', '..'],
    ['区切り文字を含む', 'a/b'],
    // Windows は末尾の空白とピリオドを取り除いて解釈するので、これらも '.' や '..' と同じになる
    ['末尾のピリオドを畳むとドット', '...'],
    ['末尾の空白とピリオドを畳むと親ディレクトリ', '.. .'],
    ['空白だけ', '  '],
    // 保存実績として固定されるので、HTML の参照がずれる名前は受け取った時点で拒否する
    ['% を含む', 'a%2Fb'],
    // 書き込み時に U+FFFD へ置き換えられるので、記録上の名前と ZIP の実体名が違うものになる
    ['孤立サロゲートを含む', 'a\uD800b'],
    // Windows ではファイル名に使えない
    ['? を含む', 'why?'],
    // ext4 のファイル名上限を超えると、ZIP は作れても展開できない
    ['長すぎる', '😀'.repeat(60)],
  ])('パスセグメントとして使えない凍結済み名 (%s) を拒否する', (_label, name) => {
    const utils = new DownloadUtils();

    expect(() =>
      createPostIdArchivePathAllocator(utils, {
        postDirectories: new Map([['post-1', name]]),
        assetNames: new Map(),
      }),
    ).toThrow('凍結済みの投稿ディレクトリ名');
  });

  test('同じ名前を持つ凍結済み投稿ディレクトリを拒否する', () => {
    const utils = new DownloadUtils();

    expect(() =>
      createPostIdArchivePathAllocator(utils, {
        postDirectories: new Map([
          ['post-1', '同じ名前'],
          ['post-2', '同じ名前'],
        ]),
        assetNames: new Map(),
      }),
    ).toThrow('重複しています');
  });

  // frozen 名は保存実績とずれるので後から直せない。受け取った時点で拒否する
  test.each([
    [
      '投稿ディレクトリ名',
      { postDirectories: new Map([['post-1', 'a/b']]), assetNames: new Map() },
      '投稿ディレクトリ名',
    ],
    [
      'アセット名',
      { postDirectories: new Map(), assetNames: new Map([['post-1', new Map([['file:a', 'a/b']])]]) },
      'アセット名',
    ],
  ])('正規化されていない凍結済み%sを拒否する', (_label, frozen, message) => {
    const utils = new DownloadUtils();

    expect(() => createPostIdArchivePathAllocator(utils, frozen)).toThrow(message);
  });

  // 同じ投稿の中で名前が重なると、同じパスに 2 エントリ入って片方が失われる。
  // 共有層はアセット同士の衝突を検査しないので、受け取った時点で弾く
  test('同じ投稿の中で重複する凍結済みアセット名を拒否する', () => {
    const utils = new DownloadUtils();

    expect(() =>
      createPostIdArchivePathAllocator(utils, {
        postDirectories: new Map(),
        assetNames: new Map([
          [
            'post-1',
            new Map([
              ['file:a', 'same.bin'],
              ['cover', 'same.bin'],
            ]),
          ],
        ]),
      }),
    ).toThrow('重複しています');
  });

  test.each([
    ['大文字小文字だけ違う', 'same.bin', 'SAME.BIN'],
    ['末尾のピリオドだけ違う', 'same.bin', 'same.bin.'],
    ['Unicode の正規化だけ違う', 'é.bin', 'e\u0301.bin'],
  ])('同じパスとして扱われる凍結済みアセット名 (%s) を同じ投稿の中では拒否する', (_label, first, second) => {
    const utils = new DownloadUtils();

    expect(() =>
      createPostIdArchivePathAllocator(utils, {
        postDirectories: new Map(),
        assetNames: new Map([
          [
            'post-1',
            new Map([
              ['file:a', first],
              ['file:b', second],
            ]),
          ],
        ]),
      }),
    ).toThrow('重複しています');
  });

  test('別の投稿で同じ名前を使うのは拒否しない', () => {
    const utils = new DownloadUtils();

    expect(() =>
      createPostIdArchivePathAllocator(utils, {
        postDirectories: new Map(),
        assetNames: new Map([
          ['post-1', new Map([['file:a', 'same.bin']])],
          ['post-2', new Map([['file:b', 'same.bin']])],
        ]),
      }),
    ).not.toThrow();
  });

  // 作成後に呼び出し側が Map を変えると同じ入力への結果が変わり、共有層が求める決定性を破る
  test('作成後に渡した Map を変更しても結果が変わらない', () => {
    const utils = new DownloadUtils();
    const postDirectories = new Map([['post-1', '凍結済み']]);
    const allocator = createPostIdArchivePathAllocator(utils, { postDirectories, assetNames: new Map() });

    const before = allocator.allocatePostDirectoryNames([makePost('post-1', 'タイトル')]);
    postDirectories.set('post-1', '後から変えた名前');

    expect(allocator.allocatePostDirectoryNames([makePost('post-1', 'タイトル')])).toEqual(before);
  });
});

describe('archive name の境界条件', () => {
  // 拡張子を後から繋ぐと、拡張子側に正規化対象の文字があったときに契約を破る
  test('拡張子に正規化対象の文字があっても正規化済みの名前を返す', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost(
      'post-1',
      '投稿',
      [makeBodyFile({ kind: 'file', assetId: 'asset-1' }, '資料', '.x/y')],
      makeCover('表紙', '.a/b'),
    );

    const result = allocator.allocateAssetPaths(post);
    const names = [...result.files.map((file) => file.archiveName), result.coverArchiveName ?? ''];

    for (const name of names) {
      expect(utils.encodeFileName(name)).toBe(name);
    }
  });

  test('投稿とアセットの archive 名は encodeFileName 済みになる', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const post = makePost(
      'post-1',
      '作品/名前\\,:*"<>|',
      [makeBodyFile({ kind: 'file', assetId: 'asset-1' }, '資料/名\\,:*"<>|', '.bin')],
      makeCover('表紙', '.jpg'),
    );
    const [directoryName] = allocator.allocatePostDirectoryNames([post]);
    const result = allocator.allocateAssetPaths(post);
    const returnedNames = [
      directoryName,
      ...result.files.map((file) => file.archiveName),
      ...(result.coverArchiveName === undefined ? [] : [result.coverArchiveName]),
    ];

    expect(directoryName).toBe('post-1_作品／名前＼，：＊“＜＞｜');
    expect(result.files.map((file) => file.archiveName)).toEqual(['資料／名＼，：＊“＜＞｜_file_asset-1.bin']);
    expect(result.coverArchiveName).toBe('cover.jpg');
    for (const name of returnedNames) {
      expect(utils.encodeFileName(name)).toBe(name);
    }
  });

  /**
   * ext4 のファイル名上限は 255 bytes で、超えると ZIP は作れても展開できない。
   * コードポイント数で切ると、絵文字のように 1 文字が 4 bytes の名前で上限を超える。
   */
  test('長い名前を UTF-8 バイト数で切りサロゲート対を壊さない', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const encoder = new TextEncoder();
    const post = makePost('post-1', '😀'.repeat(200), [
      makeBodyFile({ kind: 'file', assetId: 'b-file-1' }, '😀'.repeat(200), '.png'),
    ]);

    const [directoryName] = allocator.allocatePostDirectoryNames([post]);
    const [assetName] = allocator.allocateAssetPaths(post).files.map((file) => file.archiveName);
    const hasUnpairedSurrogate = (value: string) =>
      Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff;
      });

    for (const name of [directoryName, assetName]) {
      expect(encoder.encode(name).length).toBeLessThanOrEqual(200);
      expect(hasUnpairedSurrogate(name)).toBe(false);
    }
    expect(directoryName.startsWith('post-1_😀')).toBe(true);
    expect(assetName.endsWith('_file_b-file-1.png')).toBe(true);
  });

  test('同じ入力への割り当ては決定的で入力を変更しない', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const posts = [
      makePost(
        'post-1',
        '投稿',
        [makeBodyFile({ kind: 'image', assetId: 'image-1' }, '画像', '.png', { width: 640, height: 480 })],
        makeCover('表紙', '.jpg'),
      ),
      makePost('post-2', '別の投稿'),
    ];
    const before = structuredClone(posts);

    const firstDirectories = allocator.allocatePostDirectoryNames(posts);
    const firstAssets = allocator.allocateAssetPaths(posts[0]);
    const secondDirectories = allocator.allocatePostDirectoryNames(posts);
    const secondAssets = allocator.allocateAssetPaths(posts[0]);

    expect(secondDirectories).toEqual(firstDirectories);
    expect(secondAssets).toEqual(firstAssets);
    expect(posts).toEqual(before);
  });
});

describe('DownloadObject との接続', () => {
  test('本物の DownloadObject の project が postId 由来の名前を返す', () => {
    const utils = new DownloadUtils();
    const downloadObject = new DownloadObject('creator', utils, createPostIdArchivePathAllocator(utils));
    const firstPost = downloadObject.addPost('post-1', '同名投稿');
    const firstFile = firstPost.addFile({
      key: { kind: 'file', assetId: 'asset-1' },
      name: '同名アセット',
      extension: 'txt',
      url: 'https://example.test/asset-1',
    });
    firstPost.setCover('表紙', 'jpg', 'https://example.test/cover-1');
    firstPost.setHtml(firstPost.getAutoAssignedLinkTag(firstFile));

    const secondPost = downloadObject.addPost('post-2', '同名投稿');
    const secondFile = secondPost.addFile({
      key: { kind: 'file', assetId: 'asset-2' },
      name: '同名アセット',
      extension: 'txt',
      url: 'https://example.test/asset-2',
    });
    secondPost.setCover('表紙', 'jpg', 'https://example.test/cover-2');
    secondPost.setHtml(secondPost.getAutoAssignedLinkTag(secondFile));

    const selection = downloadObject.selectAll();
    const options = { now: new Date('2026-01-02T03:04:05.000Z') };

    expect(() => downloadObject.project(selection, options)).not.toThrow();
    const result = downloadObject.project(selection, options);

    expect(result.posts.map((post) => post.encodedName)).toEqual(['post-1_同名投稿', 'post-2_同名投稿']);
    expect(result.posts.map((post) => post.files.map((file) => file.encodedName))).toEqual([
      ['同名アセット_file_asset-1.txt'],
      ['同名アセット_file_asset-2.txt'],
    ]);
  });
});

describe('公開 API の固定値', () => {
  test('ARCHIVE_FORMAT_VERSION は 2 である', () => {
    expect(ARCHIVE_FORMAT_VERSION).toBe(2);
  });

  // 平坦なキーで postId と鍵を連結すると、区切り文字が値に現れたときに別の組が同じキーへ潰れる。
  // 保存実績の identity なので、潰れると別のアセットの記録を取り違える
  test('凍結済みアセット名は postId で入れ子にするので、区切り文字を含む値でも取り違えない', () => {
    const utils = new DownloadUtils();
    const key: BodyAssetKey = { kind: 'file', assetId: 'b' };
    const allocator = createPostIdArchivePathAllocator(utils, {
      postDirectories: new Map(),
      assetNames: new Map([
        ['p', new Map([['image:a|file:b', 'p 側.bin']])],
        ['p|image:a', new Map([[assetKeyToString(key), 'ネスト側.bin']])],
      ]),
    });

    const result = allocator.allocateAssetPaths(makePost('p|image:a', '投稿', [makeBodyFile(key, '現在名', '.png')]));

    expect(result.files.map((file) => file.archiveName)).toEqual(['ネスト側.bin']);
  });
});
