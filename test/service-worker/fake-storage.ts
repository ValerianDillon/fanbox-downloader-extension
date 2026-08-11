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
