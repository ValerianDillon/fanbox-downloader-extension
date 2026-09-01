import { describe, expect, test } from 'bun:test';
import type { AssetMetadata, BodyAssetSummary, CoverAssetSummary, PostSummary } from 'download-helper/download-helper';
import {
  countContentAvailability,
  countSelection,
  createInitialSelection,
  describeRenderedRange,
  describeSelectionCounts,
  describeSizeEstimate,
  effectivePostIds,
  filterPosts,
  formatByteSize,
  hasSelectedContent,
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
  return { key: { kind, assetId }, name: assetId, extension, metadata };
}

function coverAsset(metadata: AssetMetadata = {}, extension = '.jpg'): CoverAssetSummary {
  return { key: { kind: 'cover' }, name: 'cover', extension, metadata };
}

type PostOptions = {
  name?: string;
  files?: readonly BodyAssetSummary[];
  cover?: CoverAssetSummary;
  publishedDatetime?: string;
  updatedDatetime?: string;
};

function postSummary(postId: string, options: PostOptions = {}): PostSummary {
  const { name = postId, files = [], cover, publishedDatetime, updatedDatetime } = options;
  return {
    postId,
    name,
    tags: [],
    files,
    ...(cover === undefined ? {} : { cover }),
    ...(publishedDatetime === undefined ? {} : { publishedDatetime }),
    ...(updatedDatetime === undefined ? {} : { updatedDatetime }),
  };
}

describe('初期選択とコンテンツ件数', () => {
  const posts = [
    postSummary('p1', { files: [bodyAsset('a1', '.jpg'), bodyAsset('a2', '.zip')], cover: coverAsset() }),
    postSummary('p2', { files: [bodyAsset('a3', '.jpg')] }),
  ];

  test('全内容を希望状態にし、前回保存済みとして渡した投稿だけ既定で外す', () => {
    expect(createInitialSelection(posts, new Set(['p2']))).toEqual({
      postIds: new Set(['p1']),
      extensions: new Set(['.jpg', '.zip']),
      includeCover: true,
      includeBody: true,
    });
  });

  test('拡張子の種類は全投稿から残し、件数は選択中の投稿だけから数える', () => {
    expect(listExtensionOptions(posts, new Set(['p2']))).toEqual([
      { extension: '.jpg', fileCount: 1 },
      { extension: '.zip', fileCount: 0 },
    ]);
    expect(countContentAvailability(posts, new Set(['p2']))).toEqual({
      bodyCount: 1,
      coverCount: 0,
      extensions: [
        { extension: '.jpg', fileCount: 1 },
        { extension: '.zip', fileCount: 0 },
      ],
    });
  });

  test('拡張子なしは末尾に置き、カバーは拡張子件数に混ぜない', () => {
    const source = [
      postSummary('p1', {
        files: [bodyAsset('none', ''), bodyAsset('z', '.z'), bodyAsset('a', '.a')],
        cover: coverAsset({}, '.z'),
      }),
    ];
    expect(listExtensionOptions(source)).toEqual([
      { extension: '.a', fileCount: 1 },
      { extension: '.z', fileCount: 1 },
      { extension: '', fileCount: 1 },
    ]);
  });
});

describe('実効選択と集計', () => {
  const posts = [
    postSummary('p1', {
      files: [bodyAsset('known', '.zip', { size: 100 }), bodyAsset('image', '.jpg', {}, 'image')],
      cover: coverAsset({ size: 50 }),
    }),
    postSummary('p2', { files: [bodyAsset('unknown', '.zip')] }),
    postSummary('p3'),
  ];

  test('本文、カバー、選択拡張子のいずれかが残る投稿だけを有効にする', () => {
    const selection: ReviewSelection = {
      postIds: new Set(['p1', 'p2', 'p3']),
      extensions: new Set(['.zip']),
      includeCover: false,
      includeBody: false,
    };
    expect(posts.map((post) => hasSelectedContent(post, selection))).toEqual([true, true, false]);
    expect(effectivePostIds(posts, selection)).toEqual(new Set(['p1', 'p2']));
  });

  test('本文と選択メディアの件数、既知サイズ、不明サイズをまとめて数える', () => {
    expect(
      countSelection(posts, {
        postIds: new Set(['p1', 'p2']),
        extensions: new Set(['.zip', '.jpg']),
        includeCover: true,
        includeBody: true,
      }),
    ).toEqual({
      postCount: 2,
      bodyCount: 2,
      fileCount: 3,
      coverCount: 1,
      knownSizeBytes: 150,
      unknownSizeCount: 2,
    });
  });

  test('全コンテンツを外すと、希望上は選択された投稿も集計上は無効になる', () => {
    expect(
      countSelection(posts, {
        postIds: new Set(['p1']),
        extensions: new Set(),
        includeCover: false,
        includeBody: false,
      }),
    ).toEqual({
      postCount: 0,
      bodyCount: 0,
      fileCount: 0,
      coverCount: 0,
      knownSizeBytes: 0,
      unknownSizeCount: 0,
    });
  });

  test('共有層へ渡すときだけ 0 件の希望を外し、元の希望状態は変更しない', () => {
    const selection: ReviewSelection = {
      postIds: new Set(['p2']),
      extensions: new Set(['.jpg', '.zip']),
      includeCover: true,
      includeBody: true,
    };
    const projected = toSelection(posts, selection);
    expect(projected).toEqual({
      postIds: new Set(['p2']),
      extensions: new Set(['.zip']),
      includeCover: false,
      includeBody: true,
    });
    expect(selection.extensions).toEqual(new Set(['.jpg', '.zip']));
    expect(projected.extensions).not.toBe(selection.extensions);
  });
});

describe('投稿の絞り込み', () => {
  const posts = [
    postSummary('summer-1', {
      name: 'Summer Illustration',
      publishedDatetime: '2024-01-02T10:00:00+09:00',
      updatedDatetime: '2024-02-03T10:00:00+09:00',
    }),
    postSummary('winter-2', {
      name: 'Winter Novel',
      publishedDatetime: '2024-01-03T10:00:00+09:00',
      updatedDatetime: '2024-02-04T10:00:00+09:00',
    }),
  ];

  test('タイトルと postId を大文字小文字なしの部分一致で検索する', () => {
    expect(filterPosts(posts, 'ILLUSTRATION').map((post) => post.postId)).toEqual(['summer-1']);
    expect(filterPosts(posts, 'WINTER-2').map((post) => post.postId)).toEqual(['winter-2']);
  });

  test('更新日の開始・終了を両端含みで絞り、同日なら 1 日指定になる', () => {
    expect(
      filterPosts(posts, { query: '', dateField: 'updated', from: '2024-02-03', to: '2024-02-03' }).map(
        (post) => post.postId,
      ),
    ).toEqual(['summer-1']);
  });

  test('公開日へ切り替え、片側だけでも絞り込める', () => {
    expect(
      filterPosts(posts, { query: '', dateField: 'published', from: '2024-01-03' }).map((post) => post.postId),
    ).toEqual(['winter-2']);
  });
});

describe('表示文言', () => {
  test.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1536, '1.5 KiB'],
    [1048576, '1.0 MiB'],
  ] as const)('%d byte を %s と表示する', (bytes, expected) => {
    expect(formatByteSize(bytes)).toBe(expected);
  });

  test('本文だけなら post.json も保存することを示す', () => {
    expect(
      describeSizeEstimate({
        postCount: 1,
        bodyCount: 1,
        fileCount: 0,
        coverCount: 0,
        knownSizeBytes: 0,
        unknownSizeCount: 0,
      }),
    ).toBe('メディアファイルなし (投稿本文と post.json を保存)');
  });

  test('画像とカバーのサイズが API から得られない理由を表示する', () => {
    expect(
      describeSizeEstimate({
        postCount: 1,
        bodyCount: 1,
        fileCount: 1,
        coverCount: 1,
        knownSizeBytes: 0,
        unknownSizeCount: 2,
      }),
    ).toBe('サイズ不明 2 件 (画像とカバーは API にサイズ情報なし)');
  });

  test('件数と描画範囲を表示する', () => {
    expect(
      describeSelectionCounts({
        postCount: 3,
        bodyCount: 2,
        fileCount: 5,
        coverCount: 2,
        knownSizeBytes: 0,
        unknownSizeCount: 0,
      }),
    ).toBe('投稿 3 件、本文 2 件、添付 5 件、カバー 2 件');
    expect(describeRenderedRange(37, 37)).toBe('37 / 37 件を表示');
  });
});
