import { describe, expect, test } from 'bun:test';
import { DownloadUtils } from 'download-helper/download-helper';
import { ARCHIVE_FORMAT_VERSION } from '../src/content/archive-path';
import {
  buildFrozenArchiveNames,
  canSkipPostInfo,
  historyForCollect,
  prepareHistoryPlan,
} from '../src/content/history-plan';
import type { CatalogPost, CreatorHistory, SavedAsset, SavedPost } from '../src/history-record';
import { HISTORY_SCHEMA_VERSION } from '../src/history-record';

const utils = new DownloadUtils();
const REVISION = '2024-01-01T00:00:00+09:00';

function makeCatalog(overrides: Partial<CatalogPost> = {}): CatalogPost {
  return {
    postId: 'p1',
    observedAt: 100,
    updatedDatetime: REVISION,
    title: 'タイトル',
    publishedDatetime: null,
    complete: true,
    assets: [{ kind: 'image', assetId: 'a1', originalName: 'a', extension: 'png' }],
    ...overrides,
  };
}

function makeSavedAsset(overrides: Partial<SavedAsset> = {}): SavedAsset {
  return {
    kind: 'image',
    assetId: 'a1',
    archiveName: 'a_image_a1.png',
    outcome: 'written',
    zipName: 'out.zip',
    savedAt: 200,
    ...overrides,
  };
}

function makeSaved(overrides: Partial<SavedPost> = {}): SavedPost {
  return {
    postId: 'p1',
    archiveDirectory: 'p1_タイトル',
    revision: REVISION,
    archiveFormatVersion: ARCHIVE_FORMAT_VERSION,
    savedAt: 200,
    assets: [makeSavedAsset()],
    ...overrides,
  };
}

function makeHistory(overrides: Partial<CreatorHistory> = {}): CreatorHistory {
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    creatorId: 'c1',
    lastUsedAt: 300,
    catalog: [makeCatalog()],
    saved: [makeSaved()],
    scan: null,
    ...overrides,
  };
}

describe('凍結名の組み立て', () => {
  test('投稿ディレクトリとアセット名を postId で入れ子にして渡す (一度出した名前を編集で変えないため)。', () => {
    const frozen = buildFrozenArchiveNames(makeHistory());

    expect(frozen.postDirectories.get('p1')).toBe('p1_タイトル');
    expect(frozen.assetNames.get('p1')?.get('image:a1')).toBe('a_image_a1.png');
  });

  test('カバーは sentinel の鍵で渡す (投稿に高々一つなので assetId を持たないため)。', () => {
    const history = makeHistory({
      saved: [makeSaved({ assets: [makeSavedAsset({ kind: 'cover', assetId: undefined, archiveName: 'cover.jpg' })] })],
    });

    expect(buildFrozenArchiveNames(history).assetNames.get('p1')?.get('cover')).toBe('cover.jpg');
  });

  test('ARCHIVE_FORMAT_VERSION が違う投稿は凍結しない (別の採番規則で決めた名前を作り直せないため)。', () => {
    const history = makeHistory({ saved: [makeSaved({ archiveFormatVersion: ARCHIVE_FORMAT_VERSION + 1 })] });

    const frozen = buildFrozenArchiveNames(history);

    expect([frozen.postDirectories.size, frozen.assetNames.size]).toEqual([0, 0]);
  });
});

describe('履歴を使う収集の準備', () => {
  test('履歴が無ければ凍結名なしの allocator を返す (初回の収集を止めないため)。', () => {
    const plan = prepareHistoryPlan(utils, null);

    expect(plan.history).toBeNull();
    expect(typeof plan.allocator.allocatePostDirectoryNames).toBe('function');
  });

  test('凍結名が allocator に拒否されたら履歴ごと無いものとして扱う (破損した履歴で次のダウンロードを止めないため)。', () => {
    // encodeFileName が書き換える名前は復号を通りうるが、allocator は正規化されていないとして拒否する
    const history = makeHistory({ saved: [makeSaved({ archiveDirectory: 'a*b' })] });

    const plan = prepareHistoryPlan(utils, history);

    expect(plan.history).toBeNull();
  });

  test('凍結名が使えるなら履歴をそのまま返す (差分判定にも同じ履歴を使うため)。', () => {
    const history = makeHistory();

    expect(prepareHistoryPlan(utils, history).history).toBe(history);
  });
});

describe('post.info を省略できる条件', () => {
  test('四条件が揃えば省略する (これが Issue #56 で実際に API コストを減らす箇所)。', () => {
    expect(canSkipPostInfo(makeHistory(), 'p1', REVISION)).toBe(true);
  });

  test('履歴が無ければ省略しない (初回の収集を差分にしないため)。', () => {
    expect(canSkipPostInfo(null, 'p1', REVISION)).toBe(false);
  });

  test('一覧の updatedDatetime が読めなければ省略しない (突き合わせる値が無いため)。', () => {
    expect(canSkipPostInfo(makeHistory(), 'p1', null)).toBe(false);
  });

  test('updatedDatetime が変わっていれば省略しない (投稿が編集されているため)。', () => {
    expect(canSkipPostInfo(makeHistory(), 'p1', '2025-01-01T00:00:00+09:00')).toBe(false);
  });

  test('カタログに載っていない投稿は省略しない (何が入っているか分からないため)。', () => {
    expect(canSkipPostInfo(makeHistory(), 'p2', REVISION)).toBe(false);
  });

  test('カタログが完全でなければ省略しない (アセットを取りこぼしている可能性があるため)。', () => {
    const history = makeHistory({ catalog: [makeCatalog({ complete: false })] });

    expect(canSkipPostInfo(history, 'p1', REVISION)).toBe(false);
  });

  test('保存実績が無ければ省略しない (収集しただけで保存していない投稿を保存済みにしないため)。', () => {
    expect(canSkipPostInfo(makeHistory({ saved: [] }), 'p1', REVISION)).toBe(false);
  });

  test('前回失敗したアセットがあれば省略しない (省略すると永久に落ちてこないため)。', () => {
    const history = makeHistory({ saved: [makeSaved({ assets: [makeSavedAsset({ outcome: 'failed' })] })] });

    expect(canSkipPostInfo(history, 'p1', REVISION)).toBe(false);
  });

  test('カタログにあるのに保存実績が無いアセットがあれば省略しない (前回選ばなかった対象を取り逃さないため)。', () => {
    const history = makeHistory({
      catalog: [
        makeCatalog({
          assets: [
            { kind: 'image', assetId: 'a1', originalName: 'a', extension: 'png' },
            { kind: 'file', assetId: 'a2', originalName: 'b', extension: 'zip' },
          ],
        }),
      ],
    });

    expect(canSkipPostInfo(history, 'p1', REVISION)).toBe(false);
  });

  test('保存実績の revision が今回の一覧と違えば省略しない (保存した後に編集された投稿を飛ばさないため)。', () => {
    const history = makeHistory({ saved: [makeSaved({ revision: '2023-01-01T00:00:00+09:00' })] });

    expect(canSkipPostInfo(history, 'p1', REVISION)).toBe(false);
  });

  test('ARCHIVE_FORMAT_VERSION が違えば省略しない (過去の ZIP は別の場所に入っているため)。', () => {
    const history = makeHistory({ saved: [makeSaved({ archiveFormatVersion: ARCHIVE_FORMAT_VERSION + 1 })] });

    expect(canSkipPostInfo(history, 'p1', REVISION)).toBe(false);
  });

  test('kind が違うアセットの実績では省略しない (image と file で同じ assetId が来ても別のアセットのため)。', () => {
    const history = makeHistory({
      saved: [makeSaved({ assets: [makeSavedAsset({ kind: 'file', archiveName: 'a_file_a1.zip' })] })],
    });

    expect(canSkipPostInfo(history, 'p1', REVISION)).toBe(false);
  });
});

describe('収集に渡す履歴の選別', () => {
  test('creator が一致する履歴だけを渡す (SPA 遷移で別の creator の保存実績を根拠に省略しないため)。', () => {
    const history = makeHistory();

    expect(historyForCollect(history, 'c1', false)).toBe(history);
    expect(historyForCollect(history, 'c2', false)).toBeNull();
  });

  test('前回保存分も取得する指定なら履歴を渡さない (全件を取得するため)。', () => {
    expect(historyForCollect(makeHistory(), 'c1', true)).toBeNull();
  });

  test('履歴が無ければ null を返す (初回の収集を止めないため)。', () => {
    expect(historyForCollect(null, 'c1', false)).toBeNull();
  });
});
