import { describe, expect, test } from 'bun:test';
import type {
  AssetMetadata,
  BodyAssetKey,
  BodyFileObj,
  CoverFileObj,
  ReadonlyPostObj,
} from 'download-helper/download-helper';
import { assetKeyToString, DownloadObject, DownloadUtils } from 'download-helper/download-helper';
import { byteLength } from '../src/archive-name-rules';
import { ARCHIVE_FORMAT_VERSION, createPostIdArchivePathAllocator } from '../src/content/archive-path';

function makeBodyFile(
  key: BodyAssetKey,
  name: string,
  extension: string,
  metadata: AssetMetadata = {},
): Readonly<BodyFileObj> {
  return { key, name, extension, url: `https://example.test/${key.assetId}`, metadata };
}

function makeCover(extension = '.jpg'): Readonly<CoverFileObj> {
  return { key: { kind: 'cover' }, name: 'cover', extension, url: 'https://example.test/cover', metadata: {} };
}

function makePost(
  postId: string,
  name: string,
  files: readonly Readonly<BodyFileObj>[] = [],
  cover?: Readonly<CoverFileObj>,
): ReadonlyPostObj {
  return {
    postId,
    name,
    info: '',
    files,
    html: [],
    tags: [],
    ...(cover === undefined ? {} : { cover }),
  };
}

describe('投稿ディレクトリ', () => {
  test('タイトルの後ろに postId を角括弧で付ける', () => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils());
    expect(allocator.allocatePostDirectoryNames([makePost('post-1', '好きなタイトル')])).toEqual([
      '好きなタイトル [post-1]',
    ]);
  });

  test.each(['', '...', '   '])('タイトル %s が空になる場合は角括弧付き postId だけにする', (title) => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils());
    expect(allocator.allocatePostDirectoryNames([makePost('post-1', title)])).toEqual(['[post-1]']);
  });

  test('同名投稿でも postId により一意になり、投稿が増えても既存名は変わらない', () => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils());
    const first = [makePost('p1', '同名'), makePost('p2', '同名')];
    expect(allocator.allocatePostDirectoryNames(first)).toEqual(['同名 [p1]', '同名 [p2]']);
    expect(allocator.allocatePostDirectoryNames([...first, makePost('p3', '同名')])).toEqual([
      '同名 [p1]',
      '同名 [p2]',
      '同名 [p3]',
    ]);
  });

  test('同じ postId が複数あればタイトルにかかわらず拒否する', () => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils());
    expect(() => allocator.allocatePostDirectoryNames([makePost('p1', 'a'), makePost('p1', 'b')])).toThrow(
      '同じ postId の投稿が複数あります',
    );
  });

  test('Windows で使えない文字を正規化し、UTF-8 でセグメント上限に収める', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const [normalized, long] = allocator.allocatePostDirectoryNames([
      makePost('p1', '作品/名前%?'),
      makePost('p2', '😀'.repeat(200)),
    ]);
    expect(normalized).toBe('作品／名前％？ [p1]');
    expect(byteLength(long)).toBeLessThanOrEqual(200);
    expect(utils.encodeFileName(normalized)).toBe(normalized);
  });

  test('凍結済みディレクトリを使い、未保存投稿だけ現在の規則で割り当てる', () => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils(), {
      postDirectories: new Map([['p1', '過去タイトル [p1]']]),
      assetNames: new Map(),
    });
    expect(allocator.allocatePostDirectoryNames([makePost('p1', '変更後'), makePost('p2', '新規')])).toEqual([
      '過去タイトル [p1]',
      '新規 [p2]',
    ]);
  });

  test('凍結名と新規名の衝突を picker より前に拒否する', () => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils(), {
      postDirectories: new Map([['p1', '同名 [p2]']]),
      assetNames: new Map(),
    });
    expect(() => allocator.allocatePostDirectoryNames([makePost('p1', '旧'), makePost('p2', '同名')])).toThrow(
      '重複しています',
    );
  });
});

describe('投稿内ファイル', () => {
  test('カバーを先頭にし、本文アセットを 001 から 3 桁の数字連番にする', () => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils());
    const post = makePost(
      'p1',
      '投稿',
      [
        makeBodyFile({ kind: 'image', assetId: 'a1' }, '画像', '.jpeg'),
        makeBodyFile({ kind: 'file', assetId: 'a2' }, '書庫', '.tar.gz'),
      ],
      makeCover('.png'),
    );
    expect(allocator.allocateAssetPaths(post)).toEqual({
      coverArchiveName: '001.png',
      files: [
        { key: { kind: 'image', assetId: 'a1' }, archiveName: '002.jpeg' },
        { key: { kind: 'file', assetId: 'a2' }, archiveName: '003.tar.gz' },
      ],
    });
  });

  test('カバーがなければ本文アセットを 001 から始め、プロパティ自体を返さない', () => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils());
    const result = allocator.allocateAssetPaths(
      makePost('p1', '投稿', [makeBodyFile({ kind: 'file', assetId: 'a1' }, '資料', '.zip')]),
    );
    expect(result.files[0].archiveName).toBe('001.zip');
    expect('coverArchiveName' in result).toBe(false);
  });

  test('1000 件以上では同じ桁数に広げる', () => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils());
    const files = Array.from({ length: 1001 }, (_, index) =>
      makeBodyFile({ kind: 'file', assetId: `a${index}` }, `資料${index}`, '.bin'),
    );
    const names = allocator.allocateAssetPaths(makePost('p1', '投稿', files)).files.map((file) => file.archiveName);
    expect([names[0], names[names.length - 1]]).toEqual(['0001.bin', '1001.bin']);
  });

  test('安全でない拡張子は符号化し、通常の複合拡張子は維持する', () => {
    const utils = new DownloadUtils();
    const allocator = createPostIdArchivePathAllocator(utils);
    const result = allocator.allocateAssetPaths(
      makePost('p1', '投稿', [
        makeBodyFile({ kind: 'file', assetId: 'a1' }, '資料', '.x/y'),
        makeBodyFile({ kind: 'file', assetId: 'a2' }, '資料', '.tar.gz'),
      ]),
    );
    expect(result.files.map((file) => file.archiveName)).toEqual(['001.x~2f~y', '002.tar.gz']);
    for (const file of result.files) expect(utils.encodeFileName(file.archiveName)).toBe(file.archiveName);
  });

  test('既存アセットの番号を凍結し、削除済み番号を新しいアセットへ再利用しない', () => {
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils(), {
      postDirectories: new Map(),
      assetNames: new Map([
        [
          'p1',
          new Map([
            ['cover', '001.jpg'],
            ['image:deleted', '002.png'],
            ['file:kept', '003.zip'],
          ]),
        ],
      ]),
    });
    const kept = makeBodyFile({ kind: 'file', assetId: 'kept' }, '既存', '.zip');
    const added = makeBodyFile({ kind: 'image', assetId: 'added' }, '追加', '.png');
    expect(allocator.allocateAssetPaths(makePost('p1', '投稿', [kept, added], makeCover('.jpg')))).toEqual({
      coverArchiveName: '001.jpg',
      files: [
        { key: kept.key, archiveName: '003.zip' },
        { key: added.key, archiveName: '004.png' },
      ],
    });
  });

  test('同じ番号を指す凍結名と数字連番でない凍結名を拒否する', () => {
    expect(() =>
      createPostIdArchivePathAllocator(new DownloadUtils(), {
        postDirectories: new Map(),
        assetNames: new Map([
          [
            'p1',
            new Map([
              ['file:a', '001.bin'],
              ['file:b', '001.zip'],
            ]),
          ],
        ]),
      }).allocateAssetPaths(makePost('p1', '投稿')),
    ).toThrow('数字連番が不正です');
    expect(() =>
      createPostIdArchivePathAllocator(new DownloadUtils(), {
        postDirectories: new Map(),
        assetNames: new Map([['p1', new Map([['file:a', '旧名.bin']])]]),
      }).allocateAssetPaths(makePost('p1', '投稿')),
    ).toThrow('数字連番が不正です');
  });

  test('凍結 Map を後から変更しても割り当ては変わらない', () => {
    const file = makeBodyFile({ kind: 'file', assetId: 'a1' }, '資料', '.zip');
    const perPost = new Map([[assetKeyToString(file.key), '007.zip']]);
    const allocator = createPostIdArchivePathAllocator(new DownloadUtils(), {
      postDirectories: new Map(),
      assetNames: new Map([['p1', perPost]]),
    });
    perPost.set(assetKeyToString(file.key), '999.zip');
    expect(allocator.allocateAssetPaths(makePost('p1', '投稿', [file])).files[0].archiveName).toBe('007.zip');
  });
});

describe('共有層との接続', () => {
  test('DownloadObject.project が新しいディレクトリと連番を採用する', () => {
    const utils = new DownloadUtils();
    const downloadObject = new DownloadObject('creator', utils, createPostIdArchivePathAllocator(utils));
    const post = downloadObject.addPost('p1', '投稿タイトル');
    post.addFile({
      key: { kind: 'file', assetId: 'a1' },
      name: '元ファイル名',
      extension: 'txt',
      url: 'https://example.test/a1',
    });
    post.setCover('表紙', 'jpg', 'https://example.test/cover');

    const result = downloadObject.project(downloadObject.selectAll(), { now: new Date('2026-01-02T03:04:05Z') });
    expect(result.posts[0].encodedName).toBe('投稿タイトル [p1]');
    expect(result.posts[0].cover?.name).toBe('001.jpg');
    expect(result.posts[0].files[0].encodedName).toBe('002.txt');
  });

  test('archive format version は 3', () => {
    expect(ARCHIVE_FORMAT_VERSION).toBe(3);
  });
});
