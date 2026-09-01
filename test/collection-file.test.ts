import { describe, expect, test } from 'bun:test';
import { DownloadObject, DownloadUtils } from 'download-helper/download-helper';
import { createPostIdArchivePathAllocator } from '../src/content/archive-path';
import {
  COLLECTION_FILE_KIND,
  COLLECTION_FILE_SCHEMA_VERSION,
  createCollectionFile,
  restoreCollectionFile,
} from '../src/content/collection-file';
import type { CollectResult } from '../src/content/fanbox/collector';

function makeResult(): CollectResult {
  const utils = new DownloadUtils();
  const downloadObject = new DownloadObject('creator', utils, createPostIdArchivePathAllocator(utils));
  const post = downloadObject.addPost('p1', '投稿');
  post.setInfo(JSON.stringify({ id: 'p1', title: '投稿' }));
  post.setUpdatedDatetime('2025-02-03T04:05:06+09:00');
  const image = post.addFile({
    key: { kind: 'image', assetId: 'a1' },
    name: '画像',
    extension: 'jpeg',
    url: 'https://downloads.fanbox.cc/a1.jpeg',
    metadata: { width: 640, height: 480 },
  });
  post.setHtml(post.getAutoAssignedLinkTag(image));
  return {
    downloadObject,
    addedPostCount: 1,
    postFailures: {
      unavailable: 1,
      unavailableRestricted: 1,
      unavailableMissingBody: 0,
      unsupported: 2,
      apiFailed: 3,
    },
    failedPageCount: 4,
    listedRevisions: new Map([['p1', '2025-02-03T04:05:06+09:00']]),
    apiFailedPostIds: new Set(['failed']),
    skippedByHistoryPostIds: new Set(),
    collectedAt: 1234,
    stoppedReason: 'rate-limit-exhausted',
    scannedCreator: true,
    completedFullScan: false,
    limited: true,
    historyUsed: null,
  };
}

describe('投稿情報ファイル', () => {
  test('収集結果を JSON 往復し、選択可能な DownloadObject と診断値を復元する', () => {
    const source = makeResult();
    const file = createCollectionFile('creator', source, new Date('2026-01-02T03:04:05Z'));
    expect([file.schemaVersion, file.kind, file.exportedAt]).toEqual([
      COLLECTION_FILE_SCHEMA_VERSION,
      COLLECTION_FILE_KIND,
      '2026-01-02T03:04:05.000Z',
    ]);

    const utils = new DownloadUtils();
    const restored = restoreCollectionFile(
      JSON.parse(JSON.stringify(file)),
      utils,
      createPostIdArchivePathAllocator(utils),
      null,
    );
    expect(restored.creatorId).toBe('creator');
    expect(restored.result.downloadObject.listPosts()).toEqual(source.downloadObject.listPosts());
    expect(restored.result.listedRevisions).toEqual(source.listedRevisions);
    expect(restored.result.postFailures).toEqual(source.postFailures);
    expect([
      restored.result.failedPageCount,
      restored.result.collectedAt,
      restored.result.stoppedReason,
      restored.result.scannedCreator,
      restored.result.completedFullScan,
      restored.result.limited,
    ]).toEqual([4, 1234, 'rate-limit-exhausted', true, false, true]);
  });

  test('保存履歴はファイルから復元せず、現在の storage 由来の引数だけを使う', () => {
    const file = createCollectionFile('creator', makeResult());
    const history = { creatorId: 'creator' } as never;
    const utils = new DownloadUtils();
    const restored = restoreCollectionFile(file, utils, createPostIdArchivePathAllocator(utils), history);
    expect(restored.result.historyUsed).toBe(history);
    expect('history' in file).toBe(false);
  });

  test.each([
    ['kind', (value: Record<string, unknown>) => (value.kind = 'unknown')],
    ['creator mismatch', (value: Record<string, unknown>) => ((value.collection as { id: string }).id = 'other')],
    ['duplicate revision', (value: Record<string, unknown>) => (value.listedRevisions as unknown[]).push(['p1', null])],
    ['invalid count', (value: Record<string, unknown>) => (value.failedPageCount = -1)],
    ['invalid exportedAt', (value: Record<string, unknown>) => (value.exportedAt = 'not-a-date')],
    [
      'script 付き投稿 HTML',
      (value: Record<string, unknown>) =>
        ((value.collection as { posts: Array<{ html: string[] }> }).posts[0].html = [
          '<script>globalThis.pwned=1</script>',
        ]),
    ],
  ])('%s が壊れた外部ファイルを理由付きで拒否する', (_label, mutate) => {
    const value = JSON.parse(JSON.stringify(createCollectionFile('creator', makeResult()))) as Record<string, unknown>;
    mutate(value);
    expect(() =>
      restoreCollectionFile(value, new DownloadUtils(), createPostIdArchivePathAllocator(new DownloadUtils()), null),
    ).toThrow('投稿情報ファイルを読み込めません');
  });
});
