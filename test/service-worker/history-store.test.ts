import { describe, expect, test } from 'bun:test';
import {
  type CreatorHistoryUpdate,
  HISTORY_BUDGET_BYTES,
  HISTORY_SCHEMA_VERSION,
  historyKeyFor,
} from '../../src/history-record';
import { evict, type HistoryStorageArea, HistoryStore } from '../../src/service-worker/history-store';
import { createFakeLocalStorage } from './fake-storage';

function makeUpdate(creatorId: string, at: number, postId: string): CreatorHistoryUpdate {
  return {
    creatorId,
    at,
    catalog: [
      {
        postId,
        updatedDatetime: `${postId}-updated`,
        title: `${postId} title`,
        publishedDatetime: `${postId}-published`,
        feeRequired: null,
        complete: true,
        assets: [],
      },
    ],
  };
}

/** 破棄を起こさない大きさの正常な履歴レコード */
function makeSmallHistory(creatorId: string, lastUsedAt: number) {
  return { schemaVersion: HISTORY_SCHEMA_VERSION, creatorId, lastUsedAt, catalog: [], saved: [], scan: null };
}

/** 上限をひとりで超える大きさの履歴レコード。破棄を確実に起こすために使う */
function makeBigHistory(creatorId: string, lastUsedAt: number) {
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    creatorId,
    lastUsedAt,
    catalog: [
      {
        postId: 'post-big',
        updatedDatetime: null,
        title: 'x'.repeat(HISTORY_BUDGET_BYTES),
        publishedDatetime: null,
        feeRequired: null,
        complete: true,
        assets: [],
      },
    ],
    saved: [],
    scan: null,
  };
}

describe('履歴の容量超過時の破棄', () => {
  test('合計が上限ちょうどなら何も捨てない (許容量を使い切っただけの正常な履歴を失わないため)。', () => {
    const entries = [
      { creatorId: 'creator-1', lastUsedAt: 100, bytes: HISTORY_BUDGET_BYTES },
      { creatorId: 'creator-2', lastUsedAt: 200, bytes: 0 },
    ];

    const result = evict(entries, 'writer');

    expect(result).toEqual({ kept: entries, evicted: [] });
  });

  test('上限を超えたら lastUsedAt の古い creator から捨てる (新しく使った履歴を優先して残すため)。', () => {
    const entries = [
      { creatorId: 'old', lastUsedAt: 100, bytes: HISTORY_BUDGET_BYTES / 2 + 1 },
      { creatorId: 'new', lastUsedAt: 200, bytes: HISTORY_BUDGET_BYTES / 2 + 1 },
    ];

    const result = evict(entries, 'writer');

    expect(result).toEqual({ kept: [entries[1]], evicted: [entries[0]] });
  });

  test('protectedCreatorId の creator は候補が他にあっても捨てない (今書き込む履歴を無効にしないため)。', () => {
    const entries = [
      { creatorId: 'protected', lastUsedAt: 100, bytes: HISTORY_BUDGET_BYTES / 2 },
      { creatorId: 'other', lastUsedAt: 200, bytes: HISTORY_BUDGET_BYTES / 2 + 1 },
    ];

    const result = evict(entries, 'protected');

    expect(result).toEqual({ kept: [entries[0]], evicted: [entries[1]] });
  });

  test('protected の一件だけで上限を超える場合はそれを残して停止する (大きすぎる一件で破棄処理が無限に続かないため)。', () => {
    const protectedEntry = { creatorId: 'protected', lastUsedAt: 100, bytes: HISTORY_BUDGET_BYTES + 1 };

    const result = evict([protectedEntry], 'protected');

    expect(result).toEqual({ kept: [protectedEntry], evicted: [] });
  });

  test('合計が上限以下になった時点で破棄を止める (必要以上に古い履歴まで削除しないため)。', () => {
    const entries = [
      { creatorId: 'old', lastUsedAt: 100, bytes: 5_000_000 },
      { creatorId: 'middle', lastUsedAt: 200, bytes: 2_000_000 },
      { creatorId: 'new', lastUsedAt: 300, bytes: 2_000_000 },
    ];

    const result = evict(entries, 'writer');

    expect(result).toEqual({ kept: [entries[1], entries[2]], evicted: [entries[0]] });
  });
});

describe('履歴ストア', () => {
  test('apply した内容を read で読める (service worker の再起動後も差分判定の材料を復元するため)。', async () => {
    const backing = new Map<string, unknown>();
    const store = new HistoryStore(createFakeLocalStorage(backing));
    const update = makeUpdate('creator-1', 100, 'post-1');

    await store.apply(update);

    expect(await store.read('creator-1')).toEqual({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      creatorId: 'creator-1',
      lastUsedAt: 100,
      catalog: update.catalog ?? [],
      saved: [],
      scan: null,
    });
  });

  test('破棄する creator のキーと新しいレコードを一回の set で書く (remove と set の間で停止して無関係な履歴だけが消えるのを防ぐため)。', async () => {
    const backing = new Map<string, unknown>([[historyKeyFor('old'), makeBigHistory('old', 1)]]);
    const storage = createFakeLocalStorage(backing);
    const store = new HistoryStore(storage);

    await store.apply(makeUpdate('new', 2, 'post-new'));

    const setOperations = storage.operations.filter((operation) => operation.type === 'set');
    expect(setOperations).toHaveLength(1);
    expect(setOperations[0].items[historyKeyFor('old')]).toBeNull();
    expect(setOperations[0].items[historyKeyFor('new')]).not.toBeNull();
    const removeIndex = storage.operations.findIndex((operation) => operation.type === 'remove');
    expect(removeIndex).toBeGreaterThan(storage.operations.indexOf(setOperations[0]));
  });

  test('set が失敗したとき破棄対象だった他の creator の履歴は残る (更新に失敗しただけで無関係な履歴まで失わないため)。', async () => {
    const backing = new Map<string, unknown>([[historyKeyFor('old'), makeBigHistory('old', 1)]]);
    const base = createFakeLocalStorage(backing);
    const area: HistoryStorageArea = {
      get: base.get,
      remove: base.remove,
      set: async () => {
        throw new Error('storage.local.set failed');
      },
    };
    const store = new HistoryStore(area);

    await expect(store.apply(makeUpdate('new', 2, 'post-new'))).rejects.toThrow('storage.local.set failed');

    expect(await store.read('old')).not.toBeNull();
  });

  test('レコードは一回の set で書く (書き込みが途中まで進んだ状態を service worker 停止で残さないため)。', async () => {
    const storage = createFakeLocalStorage();
    const store = new HistoryStore(storage);

    await store.apply(makeUpdate('creator-1', 100, 'post-1'));

    const setOperations = storage.operations.filter((operation) => operation.type === 'set');
    expect(setOperations).toHaveLength(1);
    expect(Object.keys(setOperations[0].items)).toEqual([historyKeyFor('creator-1')]);
  });

  test('履歴以外のキーは破棄の対象にしない (Issue #51 の観測記録など別用途のデータを消さないため)。', async () => {
    const backing = new Map<string, unknown>([['fbdlMediaAttempts', 'x'.repeat(HISTORY_BUDGET_BYTES)]]);
    const storage = createFakeLocalStorage(backing);
    const store = new HistoryStore(storage);

    await store.apply(makeUpdate('creator-1', 100, 'post-1'));

    expect(backing.get('fbdlMediaAttempts')).not.toBeNull();
    const setOperations = storage.operations.filter((operation) => operation.type === 'set');
    expect(Object.keys(setOperations[0].items)).toEqual([historyKeyFor('creator-1')]);
  });

  test('復号できない履歴のキーを真っ先に破棄する (読めないレコードを残して読めるレコードを捨てないため)。', async () => {
    const backing = new Map<string, unknown>([
      [historyKeyFor('broken'), { broken: 'x'.repeat(HISTORY_BUDGET_BYTES) }],
      [historyKeyFor('readable'), makeSmallHistory('readable', 1)],
    ]);
    const storage = createFakeLocalStorage(backing);
    const store = new HistoryStore(storage);

    await store.apply(makeUpdate('creator-1', 100, 'post-1'));

    const setOperations = storage.operations.filter((operation) => operation.type === 'set');
    expect(setOperations[0].items[historyKeyFor('broken')]).toBeNull();
    expect(historyKeyFor('readable') in setOperations[0].items).toBe(false);
  });

  test('同じ creator への並行する二つの apply は両方の差分を残す (後から書いた差分で先の投稿を丸ごと消さないため)。', async () => {
    const store = new HistoryStore(createFakeLocalStorage());
    const first = makeUpdate('creator-1', 100, 'post-1');
    const second = makeUpdate('creator-1', 200, 'post-2');

    await Promise.all([store.apply(first), store.apply(second)]);

    const history = await store.read('creator-1');
    expect(history?.catalog.map((post) => post.postId)).toEqual(['post-1', 'post-2']);
  });

  test('read は保存値の schemaVersion が違えば null を返す (古い形式を現在の履歴として差分判定しないため)。', async () => {
    const creatorId = 'creator-1';
    const backing = new Map<string, unknown>([
      [historyKeyFor(creatorId), { schemaVersion: HISTORY_SCHEMA_VERSION + 1 }],
    ]);
    const store = new HistoryStore(createFakeLocalStorage(backing));

    expect(await store.read(creatorId)).toBeNull();
  });

  test('remove はレコードのキーを消す (利用者が削除した履歴を次の差分判定に残さないため)。', async () => {
    const backing = new Map<string, unknown>();
    const store = new HistoryStore(createFakeLocalStorage(backing));
    const creatorId = 'creator-1';
    await store.apply(makeUpdate(creatorId, 100, 'post-1'));

    await store.remove(creatorId);

    expect(backing.has(historyKeyFor(creatorId))).toBe(false);
  });

  test('キーと中身の creatorId がずれたレコードは read で null になる (別の creator の保存実績を今の creator のものとして扱わないため)。', async () => {
    const backing = new Map<string, unknown>();
    const store = new HistoryStore(createFakeLocalStorage(backing));
    await store.apply(makeUpdate('creator-2', 100, 'post-1'));
    backing.set(historyKeyFor('creator-1'), backing.get(historyKeyFor('creator-2')));

    expect(await store.read('creator-1')).toBeNull();
  });

  test('storage の一回の失敗後も apply と read が動く (失敗した promise で直列化キュー全体を詰まらせないため)。', async () => {
    const backing = new Map<string, unknown>();
    const base = createFakeLocalStorage(backing);
    let failNextSet = true;
    const area: HistoryStorageArea = {
      get: base.get,
      remove: base.remove,
      set: async (items) => {
        if (failNextSet) {
          failNextSet = false;
          throw new Error('storage.local.set failed');
        }
        await base.set(items);
      },
    };
    const store = new HistoryStore(area);

    await expect(store.apply(makeUpdate('creator-1', 100, 'post-failed'))).rejects.toThrow('storage.local.set failed');
    await store.apply(makeUpdate('creator-1', 200, 'post-success'));

    expect((await store.read('creator-1'))?.catalog.map((post) => post.postId)).toEqual(['post-success']);
  });
});
