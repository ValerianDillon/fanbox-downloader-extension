import { describe, expect, test } from 'bun:test';
import type {
  AssetMetadata,
  BodyAssetSummary,
  CoverAssetSummary,
  PostSummary,
  Selection,
} from 'download-helper/download-helper';
import {
  countSelection,
  createInitialSelection,
  describeRenderedRange,
  describeSelectionCounts,
  describeSizeEstimate,
  filterPosts,
  formatByteSize,
  listExtensionOptions,
  type ReviewSelection,
  toSelection,
} from '../src/content/review-model';

function bodyAsset(
  assetId: string,
  extension: string,
  metadata: AssetMetadata = {},
  kind: 'file' | 'image' = 'file',
): BodyAssetSummary {
  return {
    key: { kind, assetId },
    name: assetId,
    extension,
    metadata,
  };
}

function coverAsset(metadata: AssetMetadata = {}, extension = ''): CoverAssetSummary {
  return {
    key: { kind: 'cover' },
    name: 'cover',
    extension,
    metadata,
  };
}

type PostOptions = {
  name?: string;
  files?: readonly BodyAssetSummary[];
  cover?: CoverAssetSummary;
};

function postSummary(postId: string, options: PostOptions = {}): PostSummary {
  const { name = postId, files = [], cover } = options;
  if (cover === undefined) {
    return { postId, name, tags: [], files };
  }
  return { postId, name, tags: [], files, cover };
}

describe('初期選択の作成', () => {
  test('全投稿の postId と全添付の拡張子を集め、カバーを含める', () => {
    const posts = [
      postSummary('post-1', {
        files: [bodyAsset('image-1', '.png', { width: 640, height: 480 }, 'image'), bodyAsset('file-1', '.zip')],
      }),
      postSummary('post-2', { files: [bodyAsset('file-2', '.txt')] }),
    ];

    expect(createInitialSelection(posts)).toEqual({
      postIds: new Set(['post-1', 'post-2']),
      extensions: new Set(['.png', '.zip', '.txt']),
      includeCover: true,
    });
  });

  test('添付が無い投稿だけなら拡張子は空集合になる', () => {
    const posts = [postSummary('post-1', { cover: coverAsset({ size: 10 }, '.jpg') }), postSummary('post-2')];

    expect(createInitialSelection(posts)).toEqual({
      postIds: new Set(['post-1', 'post-2']),
      extensions: new Set(),
      includeCover: true,
    });
  });

  test('投稿が 0 件なら postId と拡張子は空集合でカバーを含める', () => {
    expect(createInitialSelection([])).toEqual({
      postIds: new Set(),
      extensions: new Set(),
      includeCover: true,
    });
  });
});

describe('拡張子の選択肢', () => {
  test('拡張子ごとの添付件数を投稿をまたいで合算する', () => {
    const posts = [
      postSummary('post-1', { files: [bodyAsset('jpg-1', '.jpg'), bodyAsset('jpg-2', '.jpg')] }),
      postSummary('post-2', { files: [bodyAsset('jpg-3', '.jpg'), bodyAsset('pdf-1', '.pdf')] }),
    ];

    expect(listExtensionOptions(posts)).toEqual([
      { extension: '.jpg', fileCount: 3 },
      { extension: '.pdf', fileCount: 1 },
    ]);
  });

  test('拡張子なしを末尾に置き、それ以外は辞書順に並べる', () => {
    const posts = [
      postSummary('post-1', {
        files: [bodyAsset('z', '.z'), bodyAsset('none', ''), bodyAsset('a', '.a'), bodyAsset('m', '.m')],
      }),
    ];

    expect(listExtensionOptions(posts)).toEqual([
      { extension: '.a', fileCount: 1 },
      { extension: '.m', fileCount: 1 },
      { extension: '.z', fileCount: 1 },
      { extension: '', fileCount: 1 },
    ]);
  });

  test('カバーは拡張子ごとの添付件数に含めない', () => {
    const posts = [
      postSummary('post-1', {
        files: [bodyAsset('file-1', '.jpg')],
        cover: coverAsset({ size: 20 }, '.jpg'),
      }),
    ];

    expect(listExtensionOptions(posts)).toEqual([{ extension: '.jpg', fileCount: 1 }]);
  });
});

describe('選択対象の集計', () => {
  test('選択されていない投稿の添付とカバーを数えない', () => {
    const posts = [
      postSummary('selected', {
        files: [bodyAsset('selected-file', '.jpg', { size: 10 })],
        cover: coverAsset({ size: 20 }),
      }),
      postSummary('unselected', {
        files: [bodyAsset('unselected-file', '.jpg', { size: 30 })],
        cover: coverAsset({ size: 40 }),
      }),
    ];

    expect(
      countSelection(posts, {
        postIds: new Set(['selected']),
        extensions: new Set(['.jpg']),
        includeCover: true,
      }),
    ).toEqual({
      postCount: 1,
      fileCount: 1,
      coverCount: 1,
      knownSizeBytes: 30,
      unknownSizeCount: 0,
    });
  });

  test('選択されていない拡張子の添付を数えない', () => {
    const posts = [
      postSummary('post-1', {
        files: [bodyAsset('jpg', '.jpg', { size: 12 }), bodyAsset('png', '.png', { size: 34 })],
      }),
    ];

    expect(
      countSelection(posts, {
        postIds: new Set(['post-1']),
        extensions: new Set(['.jpg']),
        includeCover: false,
      }),
    ).toEqual({
      postCount: 1,
      fileCount: 1,
      coverCount: 0,
      knownSizeBytes: 12,
      unknownSizeCount: 0,
    });
  });

  test('includeCover が false ならカバーを数えない', () => {
    const posts = [postSummary('post-1', { cover: coverAsset({ size: 20 }) })];

    expect(
      countSelection(posts, {
        postIds: new Set(['post-1']),
        extensions: new Set(),
        includeCover: false,
      }),
    ).toEqual({
      postCount: 1,
      fileCount: 0,
      coverCount: 0,
      knownSizeBytes: 0,
      unknownSizeCount: 0,
    });
  });

  test('カバーを持たない投稿は includeCover が true でもカバー数に寄与しない', () => {
    const posts = [postSummary('with-cover', { cover: coverAsset({ size: 20 }) }), postSummary('without-cover')];

    expect(
      countSelection(posts, {
        postIds: new Set(['with-cover', 'without-cover']),
        extensions: new Set(),
        includeCover: true,
      }),
    ).toEqual({
      postCount: 2,
      fileCount: 0,
      coverCount: 1,
      knownSizeBytes: 20,
      unknownSizeCount: 0,
    });
  });

  test('添付とカバーのサイズ既知・不明を同じ規則で集計する', () => {
    const posts = [
      postSummary('post-1', {
        files: [
          bodyAsset('known-file', '.bin', { size: 100 }),
          bodyAsset('unknown-image', '.png', { width: 640, height: 480 }, 'image'),
        ],
        cover: coverAsset({ size: 50 }),
      }),
      postSummary('post-2', {
        files: [bodyAsset('unknown-file', '.bin')],
        cover: coverAsset(),
      }),
    ];

    expect(
      countSelection(posts, {
        postIds: new Set(['post-1', 'post-2']),
        extensions: new Set(['.bin', '.png']),
        includeCover: true,
      }),
    ).toEqual({
      postCount: 2,
      fileCount: 3,
      coverCount: 2,
      knownSizeBytes: 150,
      unknownSizeCount: 3,
    });
  });

  test('同じ postId の投稿が複数あれば選択を両方に適用する', () => {
    const posts = [
      postSummary('same-post', { files: [bodyAsset('file-1', '.jpg', { size: 1 })] }),
      postSummary('same-post', { files: [bodyAsset('file-2', '.jpg', { size: 2 })] }),
    ];

    expect(
      countSelection(posts, {
        postIds: new Set(['same-post']),
        extensions: new Set(['.jpg']),
        includeCover: false,
      }),
    ).toEqual({
      postCount: 2,
      fileCount: 2,
      coverCount: 0,
      knownSizeBytes: 3,
      unknownSizeCount: 0,
    });
  });
});

describe('投稿の絞り込み', () => {
  test('空文字列または空白だけの検索語は全投稿に一致する', () => {
    const posts = [postSummary('post-1'), postSummary('post-2')];

    const emptyResult = filterPosts(posts, '');
    const whitespaceResult = filterPosts(posts, ' \t ');

    expect(emptyResult.map((post) => post.postId)).toEqual(['post-1', 'post-2']);
    expect(whitespaceResult.map((post) => post.postId)).toEqual(['post-1', 'post-2']);
  });

  test('投稿タイトルの部分一致で大文字小文字を区別せず絞り込む', () => {
    const posts = [
      postSummary('post-1', { name: 'Summer Illustration' }),
      postSummary('post-2', { name: 'Winter Novel' }),
    ];

    expect(filterPosts(posts, 'ILLUSTRATION').map((post) => post.postId)).toEqual(['post-1']);
  });

  test('postId の部分一致でも絞り込む', () => {
    const posts = [
      postSummary('creator-ABC-123', { name: 'First post' }),
      postSummary('creator-XYZ-456', { name: 'Second post' }),
    ];

    expect(filterPosts(posts, 'abc-1').map((post) => post.postId)).toEqual(['creator-ABC-123']);
  });

  test('元の配列を変更せず新しい配列インスタンスを返す', () => {
    const posts = [postSummary('post-1'), postSummary('post-2')];

    const result = filterPosts(posts, 'post-1');

    expect(result.map((post) => post.postId)).toEqual(['post-1']);
    expect(result).not.toBe(posts);
    expect(posts.map((post) => post.postId)).toEqual(['post-1', 'post-2']);
  });
});

describe('選択状態の変換', () => {
  test('postIds と extensions を複製し、元の集合の変更から分離する', () => {
    const source: ReviewSelection = {
      postIds: new Set(['post-1']),
      extensions: new Set(['.jpg']),
      includeCover: false,
    };

    const result: Selection = toSelection(source);
    source.postIds.add('post-2');
    source.extensions.add('.png');

    expect(result.postIds).not.toBe(source.postIds);
    expect(result.extensions).not.toBe(source.extensions);
    expect(result.postIds).toEqual(new Set(['post-1']));
    expect(result.extensions).toEqual(new Set(['.jpg']));
  });

  test.each([true, false])('includeCover が %s のとき同じ値を写す', (includeCover) => {
    const source: ReviewSelection = {
      postIds: new Set(),
      extensions: new Set(),
      includeCover,
    };

    expect(toSelection(source).includeCover).toBe(includeCover);
  });
});

describe('バイト数の表示', () => {
  const cases: Array<[number, string]> = [
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1536, '1.5 KiB'],
    [1048576, '1.0 MiB'],
    [1073741824, '1.0 GiB'],
  ];

  test.each(cases)('バイト数 %d を指定された単位の文字列にする', (bytes, expected) => {
    expect(formatByteSize(bytes)).toBe(expected);
  });
});

describe('サイズ見積もりの表示', () => {
  test('添付もカバーも 0 件なら取得対象が無い文言だけを返す', () => {
    expect(
      describeSizeEstimate({
        postCount: 1,
        fileCount: 0,
        coverCount: 0,
        knownSizeBytes: 4096,
        unknownSizeCount: 0,
      }),
    ).toBe('取得するファイルはありません (HTML と投稿情報のみ)');
  });

  test('サイズ不明が 0 件なら合計サイズを断定する', () => {
    expect(
      describeSizeEstimate({
        postCount: 1,
        fileCount: 2,
        coverCount: 1,
        knownSizeBytes: 1536,
        unknownSizeCount: 0,
      }),
    ).toBe('合計 1.5 KiB');
  });

  test('既知サイズが 0 でサイズ不明があれば不明件数だけを表示する', () => {
    expect(
      describeSizeEstimate({
        postCount: 1,
        fileCount: 1,
        coverCount: 1,
        knownSizeBytes: 0,
        unknownSizeCount: 2,
      }),
    ).toBe('サイズ不明 2 件 (合計は不明)');
  });

  test('既知サイズとサイズ不明が両方あれば両方と合計不明を表示する', () => {
    expect(
      describeSizeEstimate({
        postCount: 1,
        fileCount: 1,
        coverCount: 1,
        knownSizeBytes: 1024,
        unknownSizeCount: 1,
      }),
    ).toBe('既知分 1.0 KiB、サイズ不明 1 件 (合計は不明)');
  });
});

describe('件数と描画範囲の表示', () => {
  test('選択件数を指定された文言で表示する', () => {
    expect(
      describeSelectionCounts({
        postCount: 3,
        fileCount: 5,
        coverCount: 2,
        knownSizeBytes: 0,
        unknownSizeCount: 0,
      }),
    ).toBe('投稿 3 件、添付 5 件、カバー 2 件');
  });

  test('描画件数と一致件数を指定された文言で表示する', () => {
    expect(describeRenderedRange(37, 20)).toBe('20 / 37 件を表示');
  });
});
