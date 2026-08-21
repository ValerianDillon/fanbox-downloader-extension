import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MediaFetchAttempt } from '../src/content/downloader';
import { appendMediaAttempts, MAX_STORED_ATTEMPTS, MEDIA_ATTEMPT_STORAGE_KEY } from '../src/content/media-attempt-log';
// chrome.storage.local も get(key) / set(items) の契約は storage.session と同じなのでフェイクを流用する
import { createFakeSessionStorage } from './service-worker/fake-storage';

const attempt = (at: number, status = 200): MediaFetchAttempt => ({
  host: 'downloads.fanbox.cc',
  status,
  retryAfter: null,
  kind: 'file',
  at,
});

describe('appendMediaAttempts', () => {
  const origChrome = (globalThis as { chrome?: unknown }).chrome;
  let backing: Map<string, unknown>;

  const installStorage = (local: unknown) => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome storage mock
    (globalThis as any).chrome = { storage: { local } };
  };

  beforeEach(() => {
    backing = new Map();
    installStorage(createFakeSessionStorage(backing));
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome storage mock
    (globalThis as any).chrome = origChrome;
  });

  test('既存の記録に追記する', async () => {
    await appendMediaAttempts([attempt(1)]);
    await appendMediaAttempts([attempt(2), attempt(3)]);
    expect((backing.get(MEDIA_ATTEMPT_STORAGE_KEY) as MediaFetchAttempt[]).map((a) => a.at)).toEqual([1, 2, 3]);
  });

  test('空の配列では書き込まない', async () => {
    await appendMediaAttempts([]);
    expect(backing.size).toBe(0);
  });

  test('上限を超えたら古い方から捨てる', async () => {
    const many = Array.from({ length: MAX_STORED_ATTEMPTS + 10 }, (_, i) => attempt(i));
    await appendMediaAttempts(many);
    const stored = backing.get(MEDIA_ATTEMPT_STORAGE_KEY) as MediaFetchAttempt[];
    expect(stored).toHaveLength(MAX_STORED_ATTEMPTS);
    // 新しい方を残す。古い方を残すと、直近の 429 が最初に落ちて観測の役に立たない
    expect(stored[0].at).toBe(10);
    expect(stored[stored.length - 1].at).toBe(MAX_STORED_ATTEMPTS + 9);
  });

  test('並行して呼んでも記録が失われない', async () => {
    await Promise.all([appendMediaAttempts([attempt(1)]), appendMediaAttempts([attempt(2)])]);
    // 直列化しないと後から書いた方が先の記録ごと上書きする
    expect(backing.get(MEDIA_ATTEMPT_STORAGE_KEY) as MediaFetchAttempt[]).toHaveLength(2);
  });

  test('壊れた値が入っていても記録を続ける', async () => {
    backing.set(MEDIA_ATTEMPT_STORAGE_KEY, 'not an array');
    await appendMediaAttempts([attempt(1)]);
    expect((backing.get(MEDIA_ATTEMPT_STORAGE_KEY) as MediaFetchAttempt[]).map((a) => a.at)).toEqual([1]);
  });

  test('storage の失敗を呼び出し元へ伝播させない', async () => {
    installStorage({
      get: async () => {
        throw new Error('storage.local.get failed');
      },
      set: async () => {},
    });
    await appendMediaAttempts([attempt(1)]);
  });

  test('storage が使えない環境では何もしない', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = { runtime: {} };
    await appendMediaAttempts([attempt(1)]);
    expect(backing.size).toBe(0);
  });
});
