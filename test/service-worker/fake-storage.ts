/**
 * chrome.storage.session の最小限のフェイク。
 *
 * BackoffStore が使う get(key: string) / set(items) の 2 メソッドだけを実装する。
 * 裏の Map (backing) を複数のフェイクインスタンド間で共有すれば、chrome.storage.session が
 * service worker の再起動をまたいで生き残ることを再現できる
 * (= BackoffStore を新しいインスタンスにしても、同じ backing を渡せば記録は引き継がれる)。
 */
export function createFakeSessionStorage(backing: Map<string, unknown> = new Map()) {
  return {
    get: async (keys?: string | string[] | Record<string, unknown> | null) => {
      if (typeof keys !== 'string') {
        throw new Error('fake session storage は文字列キーの get() しかサポートしない');
      }
      return backing.has(keys) ? { [keys]: backing.get(keys) } : {};
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
  };
}

type FakeLocalStorageOperation =
  | { type: 'get'; keys: string | string[] | null }
  | { type: 'set'; items: Record<string, unknown> }
  | { type: 'remove'; keys: string | string[] };

/** HistoryStore が使う chrome.storage.local の操作と backing を観測できるフェイク。 */
export function createFakeLocalStorage(backing: Map<string, unknown> = new Map()) {
  const operations: FakeLocalStorageOperation[] = [];
  return {
    operations,
    get: async (keys: string | string[] | null) => {
      operations.push({ type: 'get', keys });
      // null は全エントリ (chrome.storage.local.get の契約)
      const requestedKeys = keys === null ? [...backing.keys()] : typeof keys === 'string' ? [keys] : keys;
      const result: Record<string, unknown> = {};
      for (const key of requestedKeys) {
        if (backing.has(key)) result[key] = backing.get(key);
      }
      return result;
    },
    set: async (items: Record<string, unknown>) => {
      operations.push({ type: 'set', items });
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
    remove: async (keys: string | string[]) => {
      operations.push({ type: 'remove', keys });
      const keysToRemove = typeof keys === 'string' ? [keys] : keys;
      for (const key of keysToRemove) backing.delete(key);
    },
  };
}
