import { describe, expect, test } from 'bun:test';
import type { AssetWriteResult, DownloadManifest } from 'download-helper/download-helper';
import { ARCHIVE_FORMAT_VERSION } from '../src/content/archive-path';
import type { CollectResult } from '../src/content/fanbox/collector';
import { buildCatalog, buildHistoryUpdate, buildSavedPosts, buildScanRecord } from '../src/content/history-update';

const COLLECTED_AT = 1_000;
const SAVED_AT = 2_000;

type PostSummaryStub = {
  postId: string;
  name: string;
  tags: string[];
  files: Array<{ key: { kind: 'image' | 'file'; assetId: string }; name: string; extension: string; metadata: object }>;
  cover?: { key: { kind: 'cover' }; name: string; extension: string; metadata: object };
  publishedDatetime?: string;
};

function makeResult(overrides: Partial<CollectResult> & { posts?: PostSummaryStub[] } = {}): CollectResult {
  const { posts = [], ...rest } = overrides;
  return {
    downloadObject: { listPosts: () => posts } as unknown as CollectResult['downloadObject'],
    addedPostCount: posts.length,
    postFailures: {
      unavailable: 0,
      unavailableRestricted: 0,
      unavailableMissingBody: 0,
      unsupported: 0,
      apiFailed: 0,
    },
    failedPageCount: 0,
    listedRevisions: new Map(),
    apiFailedPostIds: new Set(),
    collectedAt: COLLECTED_AT,
    scannedCreator: true,
    completedFullScan: true,
    limited: false,
    ...rest,
  };
}

function makeManifest(
  posts: Array<{
    postId: string;
    archiveDirectory: string;
    included: Array<{ kind: 'cover' | 'image' | 'file'; assetId?: string; archiveName: string }>;
  }>,
): DownloadManifest {
  return {
    posts: posts.map((post) => ({
      postId: post.postId,
      archiveDirectory: post.archiveDirectory,
      included: post.included.map((asset) => ({
        ...(asset.kind === 'cover' ? { kind: 'cover' as const } : { kind: asset.kind, assetId: asset.assetId ?? '' }),
        originalName: asset.archiveName,
        extension: 'png',
        archiveName: asset.archiveName,
      })),
      excluded: [],
    })),
  } as unknown as DownloadManifest;
}

const writeResult = (postIndex: number, archiveName: string, outcome: AssetWriteResult['outcome']): AssetWriteResult =>
  ({ postIndex, kind: 'file', archiveName, outcome }) as AssetWriteResult;

describe('観測カタログの組み立て', () => {
  test('取り込めた投稿だけを載せる (取り込めなかった投稿を載せても省略条件は成立せず保存量が増えるだけのため)。', () => {
    const result = makeResult({
      posts: [{ postId: 'p1', name: 'タイトル', tags: [], files: [] }],
      listedRevisions: new Map([
        ['p1', 'rev-1'],
        ['p2', 'rev-2'],
      ]),
    });

    expect(buildCatalog(result, COLLECTED_AT).map((post) => post.postId)).toEqual(['p1']);
  });

  test('カバーもアセットとして載せる (カバーの保存実績を突き合わせられないと省略できなくなるため)。', () => {
    const result = makeResult({
      posts: [
        {
          postId: 'p1',
          name: 'タイトル',
          tags: [],
          files: [{ key: { kind: 'image', assetId: 'a1' }, name: 'a', extension: 'png', metadata: {} }],
          cover: { key: { kind: 'cover' }, name: 'cover', extension: 'jpg', metadata: {} },
        },
      ],
    });

    expect(buildCatalog(result, COLLECTED_AT)[0].assets.map((asset) => asset.kind)).toEqual(['image', 'cover']);
  });

  test('size は非負の安全な整数のときだけ載せる (履歴の復号が同じ条件で弾くため)。', () => {
    const result = makeResult({
      posts: [
        {
          postId: 'p1',
          name: 'タイトル',
          tags: [],
          files: [
            { key: { kind: 'file', assetId: 'a1' }, name: 'a', extension: 'zip', metadata: { size: 10 } },
            { key: { kind: 'file', assetId: 'a2' }, name: 'b', extension: 'zip', metadata: { size: -1 } },
            { key: { kind: 'file', assetId: 'a3' }, name: 'c', extension: 'zip', metadata: {} },
          ],
        },
      ],
    });

    expect(buildCatalog(result, COLLECTED_AT)[0].assets.map((asset) => asset.size)).toEqual([10, undefined, undefined]);
  });

  test('updatedDatetime は一覧が返した値を使い、無ければ null にする (突き合わせる相手と同じ出所の値でなければ意味がないため)。', () => {
    const result = makeResult({
      posts: [
        { postId: 'p1', name: 'a', tags: [], files: [] },
        { postId: 'p2', name: 'b', tags: [], files: [] },
      ],
      listedRevisions: new Map([['p1', 'rev-1']]),
    });

    expect(buildCatalog(result, COLLECTED_AT).map((post) => post.updatedDatetime)).toEqual(['rev-1', null]);
  });

  test('observedAt には渡された観測時刻が入る (保存時刻で代用すると古い観測が新しい観測を上書きしうるため)。', () => {
    const result = makeResult({ posts: [{ postId: 'p1', name: 'a', tags: [], files: [] }] });

    expect(buildCatalog(result, COLLECTED_AT)[0].observedAt).toBe(COLLECTED_AT);
  });
});

describe('走査実績の組み立て', () => {
  test('単一投稿モードでは走査実績を作らない (一覧を見ていない収集で削除の判断材料を書かせないため)。', () => {
    expect(buildScanRecord(makeResult({ scannedCreator: false }), COLLECTED_AT)).toBeNull();
  });

  test('完走・失敗ページ数・打ち切り理由・件数上限をそのまま写す (後段が一覧の欠落を削除と誤認しないため)。', () => {
    const result = makeResult({
      completedFullScan: false,
      failedPageCount: 2,
      stoppedReason: 'rate-limit-exhausted',
      limited: true,
    });

    expect(buildScanRecord(result, COLLECTED_AT)).toEqual({
      completedFullScan: false,
      failedPageCount: 2,
      stoppedReason: 'rate-limit-exhausted',
      limited: true,
      scannedAt: COLLECTED_AT,
    });
  });
});

describe('保存実績の組み立て', () => {
  const manifest = makeManifest([
    {
      postId: 'p1',
      archiveDirectory: 'p1_dir',
      included: [
        { kind: 'image', assetId: 'a1', archiveName: 'a_image_a1.png' },
        { kind: 'file', assetId: 'a1', archiveName: 'a_file_a1.zip' },
        { kind: 'cover', archiveName: 'cover.jpg' },
      ],
    },
  ]);

  test('archive 名から AssetKey を引き当てる (共有層は archive 名でしか結果を指さないため)。', () => {
    const assets = [
      writeResult(0, 'a_image_a1.png', 'written'),
      writeResult(0, 'a_file_a1.zip', 'failed'),
      writeResult(0, 'cover.jpg', 'written'),
    ];

    const saved = buildSavedPosts(manifest, assets, new Map(), 'out.zip', SAVED_AT);

    expect(saved[0].assets.map((asset) => [asset.kind, asset.assetId, asset.outcome])).toEqual([
      ['image', 'a1', 'written'],
      ['file', 'a1', 'failed'],
      ['cover', undefined, 'written'],
    ]);
  });

  test('中断で書けなかったアセットは記録しない (書けたと確認できていないものを保存済みにしないため)。', () => {
    const assets = [writeResult(0, 'a_image_a1.png', 'skipped'), writeResult(0, 'cover.jpg', 'written')];

    const saved = buildSavedPosts(manifest, assets, new Map(), 'out.zip', SAVED_AT);

    expect(saved[0].assets.map((asset) => asset.archiveName)).toEqual(['cover.jpg']);
  });

  test('archive 名が manifest に無ければ例外にする (allocator の不変条件が破れたのを黙って通さないため)。', () => {
    const assets = [writeResult(0, 'unknown.png', 'written')];

    expect(() => buildSavedPosts(manifest, assets, new Map(), 'out.zip', SAVED_AT)).toThrow();
  });

  test('archive 名が投稿内で二つに一致したら例外にする (別のアセットの実績として記録しないため)。', () => {
    const duplicated = makeManifest([
      {
        postId: 'p1',
        archiveDirectory: 'p1_dir',
        included: [
          { kind: 'image', assetId: 'a1', archiveName: 'same.png' },
          { kind: 'image', assetId: 'a2', archiveName: 'same.png' },
        ],
      },
    ]);

    expect(() =>
      buildSavedPosts(duplicated, [writeResult(0, 'same.png', 'written')], new Map(), 'z', SAVED_AT),
    ).toThrow();
  });

  test('postIndex が manifest の範囲外なら例外にする (別の投稿の実績として記録しないため)。', () => {
    expect(() =>
      buildSavedPosts(manifest, [writeResult(5, 'cover.jpg', 'written')], new Map(), 'z', SAVED_AT),
    ).toThrow();
  });

  test('revision には一覧が返した値を、無ければ null を入れる (世代の判定を一覧の値で行うため)。', () => {
    const assets = [writeResult(0, 'cover.jpg', 'written')];

    const withRevision = buildSavedPosts(manifest, assets, new Map([['p1', 'rev-1']]), 'z', SAVED_AT);
    const withoutRevision = buildSavedPosts(manifest, assets, new Map(), 'z', SAVED_AT);

    expect([withRevision[0].revision, withoutRevision[0].revision]).toEqual(['rev-1', null]);
  });

  test('現在の ARCHIVE_FORMAT_VERSION と保存元と保存時刻を記録する (採番規則が変われば過去の ZIP は別の場所に入るため)。', () => {
    const saved = buildSavedPosts(manifest, [writeResult(0, 'cover.jpg', 'written')], new Map(), 'out.zip', SAVED_AT);

    expect([saved[0].archiveFormatVersion, saved[0].assets[0].zipName, saved[0].assets[0].savedAt]).toEqual([
      ARCHIVE_FORMAT_VERSION,
      'out.zip',
      SAVED_AT,
    ]);
  });

  test('投稿ディレクトリ名を manifest から写す (次回の凍結名として渡すため)。', () => {
    const saved = buildSavedPosts(manifest, [writeResult(0, 'cover.jpg', 'written')], new Map(), 'z', SAVED_AT);

    expect(saved[0].archiveDirectory).toBe('p1_dir');
  });
});

describe('履歴の差分の組み立て', () => {
  const manifest = makeManifest([
    { postId: 'p1', archiveDirectory: 'p1_dir', included: [{ kind: 'cover', archiveName: 'cover.jpg' }] },
  ]);

  test('観測時刻は収集の時刻、保存時刻は ZIP の時刻を使う (review に時間をかけても観測が新しく見えないようにするため)。', () => {
    const result = makeResult({ posts: [{ postId: 'p1', name: 'a', tags: [], files: [] }] });

    const update = buildHistoryUpdate('c1', result, manifest, [writeResult(0, 'cover.jpg', 'written')], 'z', SAVED_AT);

    expect([
      update.at,
      update.catalog?.[0].observedAt,
      update.scan?.scannedAt,
      update.saved?.[0].assets[0].savedAt,
    ]).toEqual([SAVED_AT, COLLECTED_AT, COLLECTED_AT, SAVED_AT]);
  });

  test('単一投稿モードでは走査実績を差分に含めない (一覧を見ていない収集で削除の判断材料を上書きしないため)。', () => {
    const result = makeResult({ scannedCreator: false, posts: [{ postId: 'p1', name: 'a', tags: [], files: [] }] });

    const update = buildHistoryUpdate('c1', result, manifest, [writeResult(0, 'cover.jpg', 'written')], 'z', SAVED_AT);

    expect('scan' in update).toBe(false);
  });
});
