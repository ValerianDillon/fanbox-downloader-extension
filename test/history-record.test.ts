import { describe, expect, test } from 'bun:test';
import {
  type CatalogPost,
  type CreatorHistory,
  type CreatorHistoryUpdate,
  creatorIdFromHistoryKey,
  decodeCreatorHistory,
  decodeCreatorHistoryUpdate,
  decodeHistoryMessage,
  estimateEntryBytes,
  HISTORY_SCHEMA_VERSION,
  type HistoryAsset,
  historyKeyFor,
  mergeCreatorHistory,
  type SavedAsset,
  type SavedPost,
  type ScanRecord,
} from '../src/history-record';

function makeCatalogPost(postId: string, assets: readonly HistoryAsset[] = [], observedAt = 100): CatalogPost {
  return {
    postId,
    observedAt,
    updatedDatetime: `${postId}-updated`,
    title: `${postId} title`,
    publishedDatetime: `${postId}-published`,
    complete: true,
    assets,
  };
}

function makeHistoryAsset(assetId: string, size?: number): HistoryAsset {
  const asset: HistoryAsset = {
    kind: 'image',
    assetId,
    originalName: `${assetId}.png`,
    extension: 'png',
  };
  return size === undefined ? asset : { ...asset, size };
}

function makeSavedAsset(assetId: string, outcome: SavedAsset['outcome'], savedAt = 200): SavedAsset {
  return { kind: 'image', assetId, archiveName: `${assetId}.png`, outcome, zipName: 'archive.zip', savedAt };
}

function makeSavedPost(
  postId: string,
  assets: readonly SavedAsset[] = [],
  overrides: Partial<SavedPost> = {},
): SavedPost {
  return {
    postId,
    archiveDirectory: `${postId}-directory`,
    revision: 'revision-1',
    archiveFormatVersion: 1,
    savedAt: 200,
    assets,
    ...overrides,
  };
}

function makeScan(scannedAt = 300, failedPageCount = 0): ScanRecord {
  return {
    completedFullScan: true,
    failedPageCount,
    stoppedReason: null,
    limited: false,
    scannedAt,
  };
}

function makeUpdate(overrides: Partial<CreatorHistoryUpdate> = {}): CreatorHistoryUpdate {
  return { creatorId: 'creator-1', at: 100, ...overrides };
}

function makeRichHistory(): CreatorHistory {
  return mergeCreatorHistory(
    null,
    makeUpdate({
      at: 500,
      catalog: [makeCatalogPost('post-1', [makeHistoryAsset('asset-1', 32)])],
      saved: [makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written')])],
      scan: makeScan(),
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

describe('履歴のマージ', () => {
  test('空の履歴へカタログを適用すると投稿が入る (最初の差分を保存済み履歴として扱えるようにするため)。', () => {
    const post = makeCatalogPost('post-1');

    const result = mergeCreatorHistory(null, makeUpdate({ catalog: [post] }));

    expect(result.catalog).toEqual([post]);
  });

  test('同じ postId のカタログは元の位置で置換する (更新で投稿の並びが不必要に変わらないようにするため)。', () => {
    const oldPost = makeCatalogPost('post-1');
    const otherPost = makeCatalogPost('post-2');
    const newPost = makeCatalogPost('post-1', [makeHistoryAsset('asset-1')], 200);
    const current = mergeCreatorHistory(null, makeUpdate({ catalog: [oldPost, otherPost] }));

    const result = mergeCreatorHistory(current, makeUpdate({ catalog: [newPost] }));

    expect(result.catalog).toEqual([newPost, otherPost]);
  });

  test('未知の postId のカタログは末尾へ追加する (新しく見つかった投稿を既存履歴で失わないため)。', () => {
    const firstPost = makeCatalogPost('post-1');
    const newPost = makeCatalogPost('post-2');
    const current = mergeCreatorHistory(null, makeUpdate({ catalog: [firstPost] }));

    const result = mergeCreatorHistory(current, makeUpdate({ catalog: [newPost] }));

    expect(result.catalog).toEqual([firstPost, newPost]);
  });

  test('同じ差分を二度適用しても一度の結果と同じになる (応答を受け取れず再送しても履歴が揺れないようにするため)。', () => {
    const update = makeUpdate({
      catalog: [makeCatalogPost('post-1')],
      saved: [makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written')])],
      scan: makeScan(),
    });

    const once = mergeCreatorHistory(null, update);
    const twice = mergeCreatorHistory(once, update);

    expect(twice).toEqual(once);
  });

  test('lastUsedAt は既存値と update.at の大きい方を採る (古い差分の再送で LRU の順序を巻き戻さないため)。', () => {
    const current = mergeCreatorHistory(null, makeUpdate({ at: 500 }));

    const result = mergeCreatorHistory(current, makeUpdate({ at: 400 }));

    expect(result.lastUsedAt).toBe(500);
  });

  test('同じ版の保存実績は別アセットだけを含む再試行でも既存の書き込み結果を残す (部分再試行で成功済みの保存を未保存扱いにしないため)。', () => {
    const existing = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written')]);
    const retry = makeSavedPost('post-1', [makeSavedAsset('asset-2', 'failed')]);
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [existing] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [retry] }));

    expect(result.saved[0].assets).toEqual([...existing.assets, ...retry.assets]);
  });

  test('revision が変わった保存実績は投稿ごと置換する (編集前のアセットを編集後の投稿へ持ち越さないため)。', () => {
    const existing = makeSavedPost('post-1', [makeSavedAsset('asset-old', 'written')], { revision: 'revision-old' });
    const updated = makeSavedPost('post-1', [makeSavedAsset('asset-new', 'written', 300)], {
      revision: 'revision-new',
      savedAt: 300,
    });
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [existing] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [updated] }));

    expect(result.saved).toEqual([updated]);
  });

  test('archiveFormatVersion が変わった保存実績は投稿ごと置換する (旧形式の ZIP の実績を新形式へ持ち越さないため)。', () => {
    const existing = makeSavedPost('post-1', [makeSavedAsset('asset-old', 'written')], { archiveFormatVersion: 1 });
    const updated = makeSavedPost('post-1', [makeSavedAsset('asset-new', 'written', 300)], {
      archiveFormatVersion: 2,
      savedAt: 300,
    });
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [existing] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [updated] }));

    expect(result.saved).toEqual([updated]);
  });

  test('同じ identity の保存結果は新しい outcome で置換する (再試行の成否を最新の観測へ反映するため)。', () => {
    const failed = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'failed', 300)]);
    const written = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written', 300)]);
    const currentFailed = mergeCreatorHistory(null, makeUpdate({ saved: [failed] }));
    const currentWritten = mergeCreatorHistory(null, makeUpdate({ saved: [written] }));

    const newerWritten = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written', 400)]);
    const newerFailed = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'failed', 400)]);
    const failedToWritten = mergeCreatorHistory(currentFailed, makeUpdate({ saved: [newerWritten] }));
    const writtenToFailed = mergeCreatorHistory(currentWritten, makeUpdate({ saved: [newerFailed] }));

    expect(failedToWritten.saved[0].assets).toEqual(newerWritten.assets);
    expect(writtenToFailed.saved[0].assets).toEqual(newerFailed.assets);
  });

  test('cover と image は assetId 相当が同じでも別アセットとして扱う (種別の違うアセットを同一視して履歴から落とさないため)。', () => {
    const cover: SavedAsset = {
      kind: 'cover',
      archiveName: 'cover.jpg',
      outcome: 'written',
      zipName: 'archive.zip',
      savedAt: 200,
    };
    const image = makeSavedAsset('same-id', 'written');
    const existing = makeSavedPost('post-1', [cover]);
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [existing] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [makeSavedPost('post-1', [image])] }));

    expect(result.saved[0].assets).toEqual([cover, image]);
  });

  test('scan は指定時だけ置換し未指定なら既存値を残す (不完全な更新で走査完了の証跡を消さないため)。', () => {
    const oldScan = makeScan(300, 1);
    const newScan = makeScan(400, 0);
    const current = mergeCreatorHistory(null, makeUpdate({ scan: oldScan }));

    const retained = mergeCreatorHistory(current, makeUpdate());
    const replaced = mergeCreatorHistory(current, makeUpdate({ scan: newScan }));

    expect(retained.scan).toEqual(oldScan);
    expect(replaced.scan).toEqual(newScan);
  });

  test('scannedAt が古い scan は既存の scan を置き換えない (遅れて届いた古い差分で走査の完全性を巻き戻さないため)。', () => {
    const newScan = makeScan(400, 0);
    const staleScan = makeScan(300, 5);
    const current = mergeCreatorHistory(null, makeUpdate({ scan: newScan }));

    const result = mergeCreatorHistory(current, makeUpdate({ scan: staleScan }));

    expect(result.scan).toEqual(newScan);
  });

  test('savedAt が古いアセットの結果は新しい結果を置き換えない (遅れて届いた古い差分で保存実績を巻き戻さないため)。', () => {
    const newer = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written', 400)]);
    const stale = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'failed', 300)]);
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [newer] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [stale] }));

    expect(result.saved[0].assets).toEqual(newer.assets);
  });

  test('savedAt が同じで結果が食い違うときは written でない方を残す (書けたと確認できない対象を保存済みにしないため)。', () => {
    const written = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written', 400)]);
    const failed = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'failed', 400)]);
    const fromWritten = mergeCreatorHistory(
      mergeCreatorHistory(null, makeUpdate({ saved: [written] })),
      makeUpdate({ saved: [failed] }),
    );
    const fromFailed = mergeCreatorHistory(
      mergeCreatorHistory(null, makeUpdate({ saved: [failed] })),
      makeUpdate({ saved: [written] }),
    );

    expect(fromWritten.saved[0].assets[0].outcome).toBe('failed');
    expect(fromFailed.saved[0].assets[0].outcome).toBe('failed');
  });

  test('archiveDirectory が変わった保存実績は投稿ごと置換する (別のディレクトリへ書いた ZIP の実績を混ぜないため)。', () => {
    const existing = makeSavedPost('post-1', [makeSavedAsset('asset-old', 'written')], { archiveDirectory: 'dir-a' });
    const updated = makeSavedPost('post-1', [makeSavedAsset('asset-new', 'written', 300)], {
      archiveDirectory: 'dir-b',
      savedAt: 300,
    });
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [existing] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [updated] }));

    expect(result.saved).toEqual([updated]);
  });

  test('保存実績をマージしても各アセットの zipName と savedAt はそのまま残る (書いていない ZIP で書いたと主張しないため)。', () => {
    const first: SavedAsset = { ...makeSavedAsset('asset-1', 'written', 200), zipName: 'first.zip' };
    const second: SavedAsset = { ...makeSavedAsset('asset-2', 'written', 300), zipName: 'second.zip' };
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [makeSavedPost('post-1', [first])] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [makeSavedPost('post-1', [second])] }));

    expect(result.saved[0].assets).toEqual([first, second]);
  });

  test('observedAt が古いカタログは新しいカタログを置き換えない (古い部分的なカタログで post.info の省略条件を成立させないため)。', () => {
    const newer = makeCatalogPost('post-1', [makeHistoryAsset('asset-1'), makeHistoryAsset('asset-2')], 200);
    const older = makeCatalogPost('post-1', [makeHistoryAsset('asset-1')], 100);
    const current = mergeCreatorHistory(null, makeUpdate({ catalog: [newer] }));

    const result = mergeCreatorHistory(current, makeUpdate({ catalog: [older] }));

    expect(result.catalog).toEqual([newer]);
  });

  test('observedAt が同じで内容が食い違うカタログは complete を false にする (どちらが正しいか決められないなら post.info を取り直させるため)。', () => {
    const empty = makeCatalogPost('post-1', [], 100);
    const withAsset = makeCatalogPost('post-1', [makeHistoryAsset('asset-x')], 100);
    const forward = mergeCreatorHistory(
      mergeCreatorHistory(null, makeUpdate({ catalog: [empty] })),
      makeUpdate({ catalog: [withAsset] }),
    );

    const back = mergeCreatorHistory(forward, makeUpdate({ catalog: [empty] }));

    expect([forward.catalog[0].complete, back.catalog[0].complete]).toEqual([false, false]);
  });

  test('observedAt が同じでアセットの並びだけが違うカタログは complete を保つ (並びの違いを内容の食い違いと数えないため)。', () => {
    const assets = [makeHistoryAsset('asset-1'), makeHistoryAsset('asset-2')];
    const forward = makeCatalogPost('post-1', assets, 100);
    const reversed = makeCatalogPost('post-1', [...assets].reverse(), 100);
    const current = mergeCreatorHistory(null, makeUpdate({ catalog: [forward] }));

    const result = mergeCreatorHistory(current, makeUpdate({ catalog: [reversed] }));

    expect(result.catalog[0].complete).toBe(true);
  });

  test('衝突で complete を false にした後に同じ差分を再送しても true に戻らない (応答を受け取れず再送しただけで欠けたカタログを完全と扱わないため)。', () => {
    const withA = makeCatalogPost('post-1', [makeHistoryAsset('asset-a')], 100);
    const withB = makeCatalogPost('post-1', [makeHistoryAsset('asset-b')], 100);
    const conflicted = mergeCreatorHistory(
      mergeCreatorHistory(null, makeUpdate({ catalog: [withA] })),
      makeUpdate({ catalog: [withB] }),
    );

    const resent = mergeCreatorHistory(conflicted, makeUpdate({ catalog: [withB] }));

    expect([conflicted.catalog[0].complete, resent.catalog[0].complete]).toEqual([false, false]);
  });

  test('アセットを持たない投稿でも世代の新しい実績で置き換える (本文だけの投稿の差分判定が永久に成立しなくなるため)。', () => {
    const older = makeSavedPost('post-1', [], { revision: 'r1', savedAt: 100 });
    const newer = makeSavedPost('post-1', [], { revision: 'r2', savedAt: 200 });
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [older] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [newer] }));

    expect(result.saved).toEqual([newer]);
  });

  test('同じ世代をマージしたら投稿の savedAt は新しい方を採る (古い差分の再送で時刻が巻き戻らないようにするため)。', () => {
    const first = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written', 100)], { savedAt: 100 });
    const second = makeSavedPost('post-1', [makeSavedAsset('asset-2', 'written', 200)], { savedAt: 200 });
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [first] }));

    const merged = mergeCreatorHistory(current, makeUpdate({ saved: [second] }));
    const resent = mergeCreatorHistory(merged, makeUpdate({ saved: [first] }));

    expect([merged.saved[0].savedAt, resent.saved[0].savedAt]).toEqual([200, 200]);
  });

  test('世代が違い savedAt が同値なら後から適用した差分で置き換えない (到着順で保存実績が入れ替わらないようにするため)。', () => {
    const first = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written', 100)], {
      revision: 'r1',
      savedAt: 100,
    });
    const second = makeSavedPost('post-1', [makeSavedAsset('asset-2', 'written', 100)], {
      revision: 'r2',
      savedAt: 100,
    });
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [first] }));

    const afterSecond = mergeCreatorHistory(current, makeUpdate({ saved: [second] }));
    const resent = mergeCreatorHistory(afterSecond, makeUpdate({ saved: [first] }));

    expect([afterSecond.saved, resent.saved]).toEqual([[first], [first]]);
  });

  test('大文字小文字だけが違う凍結名の組は例外にする (allocator が衝突と判定して次のダウンロードごと止まるのを防ぐため)。', () => {
    const post = makeSavedPost('post-1', [
      { ...makeSavedAsset('asset-1', 'written'), archiveName: 'same.png' },
      { ...makeSavedAsset('asset-2', 'written'), archiveName: 'SAME.PNG' },
    ]);

    expect(() => mergeCreatorHistory(null, makeUpdate({ saved: [post] }))).toThrow();
  });

  test('別々の差分がマージされて初めて衝突する凍結名も例外にする (更新のたびに組全体を確かめないと衝突を作れるため)。', () => {
    const first = makeSavedPost('post-1', [{ ...makeSavedAsset('asset-1', 'written'), archiveName: 'same.png' }]);
    const second = makeSavedPost('post-1', [{ ...makeSavedAsset('asset-2', 'written'), archiveName: 'SAME.PNG' }]);
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [first] }));

    expect(() => mergeCreatorHistory(current, makeUpdate({ saved: [second] }))).toThrow();
  });

  test('大文字小文字だけが違う投稿ディレクトリの組も例外にする (展開時に一方が他方を上書きするため)。', () => {
    const first = makeSavedPost('post-1', [], { archiveDirectory: 'same' });
    const second = makeSavedPost('post-2', [], { archiveDirectory: 'SAME' });

    expect(() => mergeCreatorHistory(null, makeUpdate({ saved: [first, second] }))).toThrow();
  });

  test('世代の違う保存実績は新しい方だけを残す (遅れて届いた古い差分で新しい世代の実績を消さないため)。', () => {
    const older = makeSavedPost('post-1', [makeSavedAsset('asset-old', 'written', 100)], {
      revision: 'r1',
      savedAt: 100,
    });
    const newer = makeSavedPost('post-1', [makeSavedAsset('asset-new', 'written', 200)], {
      revision: 'r2',
      savedAt: 200,
    });
    const afterNewer = mergeCreatorHistory(
      mergeCreatorHistory(null, makeUpdate({ saved: [older] })),
      makeUpdate({ saved: [newer] }),
    );

    const resent = mergeCreatorHistory(afterNewer, makeUpdate({ saved: [older] }));

    expect([afterNewer.saved, resent.saved]).toEqual([[newer], [newer]]);
  });

  test('revision が null 同士の保存実績はアセットをマージする (単一投稿モードの保存で過去の凍結名を消さないため)。', () => {
    const first = makeSavedPost('post-1', [makeSavedAsset('asset-old', 'written', 100)], { revision: null });
    const second = makeSavedPost('post-1', [makeSavedAsset('asset-new', 'written', 200)], { revision: null });
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [first] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [second] }));

    expect(result.saved[0].assets).toEqual([...first.assets, ...second.assets]);
  });

  test('revision が null の実績は revision の分かっている実績を置き換えない (世代の分からない保存で凍結名と実績を失わないため)。', () => {
    const known = makeSavedPost('post-1', [makeSavedAsset('asset-a', 'written', 100)], {
      revision: 'r1',
      savedAt: 100,
    });
    const unknown = makeSavedPost('post-1', [makeSavedAsset('asset-b', 'written', 200)], {
      revision: null,
      savedAt: 200,
    });
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [known] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [unknown] }));

    expect(result.saved).toEqual([known]);
  });

  test('revision の分かっている実績は revision が null の実績を置き換える (世代を特定できる記録の方が使えるため)。', () => {
    const unknown = makeSavedPost('post-1', [makeSavedAsset('asset-b', 'written', 200)], {
      revision: null,
      savedAt: 200,
    });
    const known = makeSavedPost('post-1', [makeSavedAsset('asset-a', 'written', 100)], {
      revision: 'r1',
      savedAt: 100,
    });
    const current = mergeCreatorHistory(null, makeUpdate({ saved: [unknown] }));

    const result = mergeCreatorHistory(current, makeUpdate({ saved: [known] }));

    expect(result.saved).toEqual([known]);
  });

  test('scannedAt が同じで内容が食い違う scan は完走していない方を残す (欠落を削除と誤認させないため)。', () => {
    const completed = makeScan(400, 0);
    const stopped: ScanRecord = { ...completed, completedFullScan: false, stoppedReason: 'transport-exhausted' };
    const fromCompleted = mergeCreatorHistory(
      mergeCreatorHistory(null, makeUpdate({ scan: completed })),
      makeUpdate({ scan: stopped }),
    );
    const fromStopped = mergeCreatorHistory(
      mergeCreatorHistory(null, makeUpdate({ scan: stopped })),
      makeUpdate({ scan: completed }),
    );

    expect(fromCompleted.scan).toEqual(stopped);
    expect(fromStopped.scan).toEqual(stopped);
  });

  test('同じ postId が二度現れる差分は例外にする (適用回数で結果が変わる曖昧な入力を受け取らないため)。', () => {
    const update = makeUpdate({ catalog: [makeCatalogPost('post-1'), makeCatalogPost('post-1')] });

    expect(() => mergeCreatorHistory(null, update)).toThrow();
  });

  test('同じアセットが二度現れる差分は例外にする (適用回数で残るアセットが変わる曖昧な入力を受け取らないため)。', () => {
    const post = makeSavedPost('post-1', [makeSavedAsset('asset-1', 'written'), makeSavedAsset('asset-1', 'failed')]);

    expect(() => mergeCreatorHistory(null, makeUpdate({ saved: [post] }))).toThrow();
  });

  test('入力を深く凍結してもマージでき元の catalog と saved が変わらない (共有された履歴を破壊せず安全に再利用するため)。', () => {
    const current = deepFreeze(makeRichHistory());
    const catalogBefore = structuredClone(current.catalog);
    const savedBefore = structuredClone(current.saved);

    expect(() => mergeCreatorHistory(current, makeUpdate({ catalog: [makeCatalogPost('post-2')] }))).not.toThrow();

    expect(current.catalog).toEqual(catalogBefore);
    expect(current.saved).toEqual(savedBefore);
  });
});

describe('履歴レコードの復号', () => {
  test('schemaVersion が現在版と違えば null を返す (互換性のない履歴を保存済みと誤認しないため)。', () => {
    const history = makeRichHistory();

    const result = decodeCreatorHistory({ ...history, schemaVersion: HISTORY_SCHEMA_VERSION + 1 }, 'creator-1');

    expect(result).toBeNull();
  });

  test('catalog 内に復号できないアセットが一つでもあれば配列全体を null にする (欠けたカタログを完全な履歴として扱わないため)。', () => {
    const history = makeRichHistory();
    const value = {
      ...history,
      catalog: [{ ...history.catalog[0], assets: [...history.catalog[0].assets, null] }],
    };

    const result = decodeCreatorHistory(value, 'creator-1');

    expect(result).toBeNull();
  });

  test('cover の assetId と image の無いまたは空の assetId を拒否する (壊れた identity で別アセットを同一視しないため)。', () => {
    const history = makeRichHistory();
    const invalidAssets = [
      { kind: 'cover', assetId: 'cover-id', originalName: 'cover.jpg', extension: 'jpg' },
      { kind: 'image', originalName: 'image.png', extension: 'png' },
      { kind: 'image', assetId: '', originalName: 'image.png', extension: 'png' },
    ];

    for (const asset of invalidAssets) {
      const value = { ...history, catalog: [{ ...history.catalog[0], assets: [asset] }] };
      expect(decodeCreatorHistory(value, 'creator-1')).toBeNull();
    }
  });

  test('SavedAsset の outcome が written / failed 以外なら null を返す (未知の結果を成功済み保存として扱わないため)。', () => {
    const history = makeRichHistory();
    const value = {
      ...history,
      saved: [{ ...history.saved[0], assets: [{ ...history.saved[0].assets[0], outcome: 'unknown' }] }],
    };

    const result = decodeCreatorHistory(value, 'creator-1');

    expect(result).toBeNull();
  });

  test('正常なレコードは JSON の往復後も同じ履歴へ復号できる (storage の直列化で履歴の意味を変えないため)。', () => {
    const history = makeRichHistory();

    const decoded = decodeCreatorHistory(JSON.parse(JSON.stringify(history)), 'creator-1');

    expect(decoded).toEqual(history);
  });

  test('lastUsedAt savedAt size failedPageCount の負数と非整数を拒否する (時刻や容量や件数の不正値で差分判定を壊さないため)。', () => {
    type MutableNumericHistory = {
      lastUsedAt: number;
      catalog: Array<{ assets: Array<{ size?: number }> }>;
      saved: Array<{ assets: Array<{ savedAt: number }> }>;
      scan: { failedPageCount: number } | null;
    };
    const base = makeRichHistory();
    const patches: Array<(value: MutableNumericHistory, invalid: number) => void> = [
      (value, invalid) => {
        value.lastUsedAt = invalid;
      },
      (value, invalid) => {
        value.saved[0].assets[0].savedAt = invalid;
      },
      (value, invalid) => {
        value.catalog[0].assets[0].size = invalid;
      },
      (value, invalid) => {
        if (value.scan === null) throw new Error('fixture must contain scan');
        value.scan.failedPageCount = invalid;
      },
    ];

    for (const invalid of [-1, 1.5]) {
      for (const patch of patches) {
        const candidate = structuredClone(base) as unknown as MutableNumericHistory;
        patch(candidate, invalid);
        expect(decodeCreatorHistory(candidate, 'creator-1')).toBeNull();
      }
    }
  });

  test('scan が null のレコードを正常に受け入れる (走査実績がまだ無い履歴を保存できるようにするため)。', () => {
    const history = { ...makeRichHistory(), scan: null };

    const decoded = decodeCreatorHistory(history, 'creator-1');

    expect(decoded).toEqual(history);
  });
  test('キーから求めた creatorId とレコードの creatorId が違えば null を返す (別の creator の保存実績を今の creator のものとして扱わないため)。', () => {
    const history = { ...makeRichHistory(), creatorId: 'creator-2' };

    expect(decodeCreatorHistory(history, 'creator-1')).toBeNull();
  });

  test('同じ postId が二度入っているレコードは null を返す (適用回数で結果が変わる履歴を読み込まないため)。', () => {
    const history = makeRichHistory();
    const value = { ...history, catalog: [history.catalog[0], history.catalog[0]] };

    expect(decodeCreatorHistory(value, 'creator-1')).toBeNull();
  });

  test('同じアセットが二度入っている保存実績のレコードは null を返す (どちらの結果が有効か決められない履歴を信じないため)。', () => {
    const history = makeRichHistory();
    const post = history.saved[0];
    const value = { ...history, saved: [{ ...post, assets: [post.assets[0], post.assets[0]] }] };

    expect(decodeCreatorHistory(value, 'creator-1')).toBeNull();
  });

  test('SavedAsset に zipName と savedAt が無ければ null を返す (どの ZIP でいつ書けたか言えない実績を保存済みとして扱わないため)。', () => {
    const history = makeRichHistory();
    const post = history.saved[0];
    const { zipName: _zipName, savedAt: _savedAt, ...withoutProvenance } = post.assets[0];
    const value = { ...history, saved: [{ ...post, assets: [withoutProvenance] }] };

    expect(decodeCreatorHistory(value, 'creator-1')).toBeNull();
  });

  test('completedFullScan と矛盾する走査実績は null を返す (完走していない走査を根拠に投稿の削除を判定させないため)。', () => {
    const history = makeRichHistory();
    const contradictions = [{ failedPageCount: 1 }, { stoppedReason: 'rate-limit-exhausted' }, { limited: true }];

    for (const contradiction of contradictions) {
      const value = { ...history, scan: { ...history.scan, ...contradiction } };
      expect(decodeCreatorHistory(value, 'creator-1')).toBeNull();
    }
  });

  test('未知の stoppedReason を持つ走査実績は null を返す (意味の分からない理由で完走判定を変えないため)。', () => {
    const history = makeRichHistory();
    const value = {
      ...history,
      scan: { ...history.scan, completedFullScan: false, stoppedReason: 'unknown-reason' },
    };

    expect(decodeCreatorHistory(value, 'creator-1')).toBeNull();
  });

  test('パスセグメントとして使えない archiveName や archiveDirectory は null を返す (破損した凍結名で次のダウンロードごと止めないため)。', () => {
    const history = makeRichHistory();
    const badNames = ['a/b', '..', 'a\u0000b', 'x%y', 'x?y', '\uD800', 'x'.repeat(300)];

    for (const bad of badNames) {
      const post = history.saved[0];
      const withBadAsset = { ...history, saved: [{ ...post, assets: [{ ...post.assets[0], archiveName: bad }] }] };
      const withBadDirectory = { ...history, saved: [{ ...post, archiveDirectory: bad }] };
      expect(decodeCreatorHistory(withBadAsset, 'creator-1')).toBeNull();
      expect(decodeCreatorHistory(withBadDirectory, 'creator-1')).toBeNull();
    }
  });

  test('空文字や空白だけの updatedDatetime と revision は null を返す (壊れた値を既知の世代として突き合わせないため)。', () => {
    const history = makeRichHistory();
    for (const bad of ['', '   ']) {
      expect(
        decodeCreatorHistory({ ...history, catalog: [{ ...history.catalog[0], updatedDatetime: bad }] }, 'creator-1'),
      ).toBeNull();
      expect(
        decodeCreatorHistory({ ...history, saved: [{ ...history.saved[0], revision: bad }] }, 'creator-1'),
      ).toBeNull();
    }
  });

  test('凍結名が組として衝突するレコードは null を返す (allocator を止める履歴を読み込まないため)。', () => {
    const history = makeRichHistory();
    const post = history.saved[0];
    const value = {
      ...history,
      saved: [
        { ...post, assets: [{ ...post.assets[0], archiveName: 'same.png' }] },
        { ...post, postId: 'post-2', archiveDirectory: `${post.archiveDirectory.toUpperCase()}` },
      ],
    };

    expect(decodeCreatorHistory(value, 'creator-1')).toBeNull();
  });

  test('observedAt を欠いたカタログは null を返す (観測の新旧を決められない履歴で古い値を採らないため)。', () => {
    const history = makeRichHistory();
    const { observedAt: _observedAt, ...withoutObservedAt } = history.catalog[0];
    const value = { ...history, catalog: [withoutObservedAt] };

    expect(decodeCreatorHistory(value, 'creator-1')).toBeNull();
  });
});

describe('履歴キーの解釈', () => {
  test('履歴キーからは creatorId を取り出し、他のキーは null にする (無関係な storage のキーを creator と誤認しないため)。', () => {
    expect(creatorIdFromHistoryKey(historyKeyFor('creator-1'))).toBe('creator-1');
    expect(creatorIdFromHistoryKey('fbdlMediaAttempts')).toBeNull();
    expect(creatorIdFromHistoryKey(historyKeyFor(''))).toBeNull();
  });
});

describe('差分とメッセージの復号', () => {
  test('creatorId を欠いた historyRemove は復号できない (fbdlHistory:undefined を消しにいかないため)。', () => {
    expect(decodeHistoryMessage({ type: 'historyRemove' })).toBeNull();
    expect(decodeHistoryMessage({ type: 'historyRemove', creatorId: '' })).toBeNull();
  });

  test('未知の type のメッセージは復号できない (履歴と無関係なメッセージで storage を触らないため)。', () => {
    expect(decodeHistoryMessage({ type: 'fetchApi', url: 'https://example.com' })).toBeNull();
  });

  test('catalog の要素が壊れている差分は復号できない (壊れた値を書き込んで次の読み出しで履歴ごと捨てないため)。', () => {
    const update = { creatorId: 'creator-1', at: 100, catalog: [{ postId: 'post-1' }] };

    expect(decodeCreatorHistoryUpdate(update)).toBeNull();
    expect(decodeHistoryMessage({ type: 'historyApply', update })).toBeNull();
  });

  test('正常な差分は同じ内容へ復号でき historyApply として受け付ける (通常の書き込み経路を塞がないため)。', () => {
    const update = makeUpdate({ catalog: [makeCatalogPost('post-1')], scan: makeScan() });

    expect(decodeCreatorHistoryUpdate(JSON.parse(JSON.stringify(update)))).toEqual(update);
    expect(decodeHistoryMessage({ type: 'historyApply', update })).toEqual({ type: 'historyApply', update });
  });
});

describe('履歴容量の見積もり', () => {
  test('キーと JSON の UTF-8 バイト数を見積もる (容量上限の判定を文字数ではなく保存量に合わせるため)。', () => {
    const history = { ...makeRichHistory(), creatorId: 'creator-あ' };
    const key = historyKeyFor('creator-あ');
    const expected = new TextEncoder().encode(key + JSON.stringify(history)).length;

    expect(estimateEntryBytes(key, history)).toBe(expected);
  });

  test('復号できない値でも見積もれる (読めないレコードが占める容量を破棄の判断から落とさないため)。', () => {
    const key = historyKeyFor('creator-1');

    expect(estimateEntryBytes(key, null)).toBe(new TextEncoder().encode(`${key}null`).length);
    expect(estimateEntryBytes(key, { broken: true })).toBeGreaterThan(key.length);
  });
});
