import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyCreatorHistory,
  HISTORY_MESSAGE_TIMEOUT_MS,
  readCreatorHistory,
  readCreatorHistoryForCollect,
  removeCreatorHistory,
} from '../src/content/history';
import { type CreatorHistoryUpdate, historyKeyFor, mergeCreatorHistory } from '../src/history-record';
import { createFakeLocalStorage } from './service-worker/fake-storage';

describe('コンテンツスクリプトの履歴クライアント', () => {
  const origChrome = (globalThis as { chrome?: unknown }).chrome;
  let backing: Map<string, unknown>;

  const installChrome = (value: unknown) => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome global mock
    (globalThis as any).chrome = value;
  };

  const update: CreatorHistoryUpdate = {
    creatorId: 'creator-1',
    at: 100,
    catalog: [],
  };

  beforeEach(() => {
    backing = new Map();
    installChrome({ storage: { local: createFakeLocalStorage(backing) } });
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome global mock
    (globalThis as any).chrome = origChrome;
  });

  test('readCreatorHistoryForCollect は service worker へ historyRead を送る (削除と同じキューを通すため)。', async () => {
    const sent: unknown[] = [];
    installChrome({
      runtime: {
        sendMessage: async (message: unknown) => {
          sent.push(message);
          return { ok: true, history: null };
        },
      },
    });

    await readCreatorHistoryForCollect('creator-1');

    expect(sent).toEqual([{ type: 'historyRead', creatorId: 'creator-1' }]);
  });

  test('readCreatorHistoryForCollect は応答の履歴を復号して返す (応答から落とすと差分判定が一度も成立しないため)。', async () => {
    const history = mergeCreatorHistory(null, { creatorId: 'creator-1', at: 100 });
    installChrome({
      runtime: { sendMessage: async () => ({ ok: true, history: JSON.parse(JSON.stringify(history)) }) },
    });

    expect(await readCreatorHistoryForCollect('creator-1')).toEqual(history);
  });

  test('readCreatorHistoryForCollect は失敗や想定外の応答を null に倒す (読めない履歴で省略しないため)。', async () => {
    for (const response of [{ ok: false, error: 'x' }, undefined, { ok: true, history: { broken: true } }]) {
      installChrome({ runtime: { sendMessage: async () => response } });
      expect(await readCreatorHistoryForCollect('creator-1')).toBeNull();
    }
  });

  test('chrome が未定義でも readCreatorHistory は null を返す (通常の Web 実行環境で履歴読み出しが停止しないため)。', async () => {
    installChrome(undefined);

    await expect(readCreatorHistory('creator-1')).resolves.toBeNull();
  });

  test('storage.local.get が reject しても readCreatorHistory は null を返す (一時的な storage 障害を再ダウンロードへ安全に倒すため)。', async () => {
    installChrome({
      storage: {
        local: {
          get: async () => {
            throw new Error('storage.local.get failed');
          },
        },
      },
    });

    await expect(readCreatorHistory('creator-1')).resolves.toBeNull();
  });

  test('保存済みの正常なレコードを readCreatorHistory で読める (content script が差分判定の材料を取得するため)。', async () => {
    const history = mergeCreatorHistory(null, update);
    backing.set(historyKeyFor(update.creatorId), history);

    const result = await readCreatorHistory(update.creatorId);

    expect(result).toEqual(history);
  });

  test('応答が { ok: true } なら applyCreatorHistory は ok: true を返す (履歴更新の成功を呼び出し元へ伝えるため)。', async () => {
    installChrome({ runtime: { sendMessage: async () => ({ ok: true }) } });

    const result = await applyCreatorHistory(update);

    expect(result).toEqual({ ok: true });
  });

  test('service worker が応答しなくても上限時間後に失敗を返す (収集完了画面を止め続けないため)。', async () => {
    installChrome({ runtime: { sendMessage: () => new Promise(() => {}) } });
    const originalSetTimeout = globalThis.setTimeout;
    let timeout: (() => void) | undefined;
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number) => {
      expect(ms).toBe(HISTORY_MESSAGE_TIMEOUT_MS);
      timeout = handler as () => void;
      return 1;
    }) as unknown as typeof setTimeout;
    try {
      const pending = applyCreatorHistory(update);
      timeout?.();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('35 秒以内');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('収集の AbortSignal で service worker の未応答待機を打ち切る', async () => {
    installChrome({ runtime: { sendMessage: () => new Promise(() => {}) } });
    const controller = new AbortController();
    const pending = applyCreatorHistory(update, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('AbortError');
  });

  test('応答が undefined なら applyCreatorHistory は ok: false を返す (listener の無い service worker を成功と誤認しないため)。', async () => {
    installChrome({ runtime: { sendMessage: async () => undefined } });

    const result = await applyCreatorHistory(update);

    expect(result.ok).toBe(false);
  });

  test('応答が { ok: false, error } なら error をそのまま返す (履歴更新失敗の理由を利用者へ隠さないため)。', async () => {
    installChrome({ runtime: { sendMessage: async () => ({ ok: false, error: '履歴 store failed' }) } });

    const result = await applyCreatorHistory(update);

    expect(result).toEqual({ ok: false, error: '履歴 store failed' });
  });

  test('応答の error が文字列でなければ既定の文言に倒す (文字列でない値が呼び出し元の表示処理へ流れないため)。', async () => {
    installChrome({ runtime: { sendMessage: async () => ({ ok: false, error: 123 }) } });

    const result = await applyCreatorHistory(update);

    expect(typeof result.error).toBe('string');
    expect(result.error).not.toBe('123');
  });

  test('applyCreatorHistory と removeCreatorHistory は sendMessage の reject を ok: false に畳む (通信例外で content script を未処理例外にしないため)。', async () => {
    installChrome({
      runtime: {
        sendMessage: async () => {
          throw new Error('runtime.sendMessage failed');
        },
      },
    });

    const applied = await applyCreatorHistory(update);
    const removed = await removeCreatorHistory(update.creatorId);

    expect([applied.ok, removed.ok]).toEqual([false, false]);
  });

  test('removeCreatorHistory は historyRemove と creatorId を含むメッセージを送る (削除対象を別 creator と取り違えないため)。', async () => {
    let sentMessage: unknown;
    installChrome({
      runtime: {
        sendMessage: async (message: unknown) => {
          sentMessage = message;
          return { ok: true };
        },
      },
    });

    await removeCreatorHistory('creator-2');

    expect(sentMessage).toEqual({ type: 'historyRemove', creatorId: 'creator-2' });
  });
});
