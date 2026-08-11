import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BackoffStore } from '../../src/service-worker/backoff-store';
import { createFakeSessionStorage } from './fake-storage';

describe('BackoffStore', () => {
  // biome-ignore lint/suspicious/noExplicitAny: chrome storage mock
  const origChrome = (globalThis as any).chrome;
  let backing: Map<string, unknown>;

  beforeEach(() => {
    backing = new Map();
    // biome-ignore lint/suspicious/noExplicitAny: chrome storage mock
    (globalThis as any).chrome = { storage: { session: createFakeSessionStorage(backing) } };
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome storage mock
    (globalThis as any).chrome = origChrome;
  });

  test('記録が無ければ 0 を返す', async () => {
    const store = new BackoffStore();
    expect(await store.get()).toBe(0);
  });

  test('record() した値を get() で読み返せる', async () => {
    const store = new BackoffStore();
    const until = Date.now() + 60_000;
    await store.record(until);
    expect(await store.get()).toBe(until);
  });

  test('record() はメモリキャッシュだけでなく storage にも書き込む', async () => {
    // SoT は storage 側であるべきなので、メモリキャッシュへの反映だけでは不十分
    // (service worker が直後に停止すると記録が失われる)
    const store = new BackoffStore();
    const until = Date.now() + 60_000;
    await store.record(until);
    expect(backing.get('fbdlBackoffUntil')).toBe(until);
  });

  test('record() は常に遠い方を採る (短い候補で長い期限を上書きしない)', async () => {
    // 複数のリクエストが並行していると、後から届いた応答の期限の方が短いことがありうる
    const store = new BackoffStore();
    const far = Date.now() + 120_000;
    const near = Date.now() + 10_000;
    await store.record(far);
    const result = await store.record(near);
    expect(result).toBe(far);
    expect(await store.get()).toBe(far);
  });

  test('record() は候補の方が遠ければ更新する', async () => {
    const store = new BackoffStore();
    const near = Date.now() + 10_000;
    const far = Date.now() + 120_000;
    await store.record(near);
    const result = await store.record(far);
    expect(result).toBe(far);
    expect(await store.get()).toBe(far);
  });

  test('service worker 再起動相当: 新しいインスタンスでもメモリキャッシュではなく storage から復元する', async () => {
    const first = new BackoffStore();
    const until = Date.now() + 60_000;
    await first.record(until);

    // 新しいインスタンス = メモリキャッシュが空の状態 (MV3 の service worker が停止して
    // 再起動した後を模す)。裏の chrome.storage.session (backing) は共有されたままなので、
    // そこから読み直せば記録は残っている
    const restarted = new BackoffStore();
    expect(await restarted.get()).toBe(until);
  });

  test('get() は同一インスタンス内ではキャッシュを使い、storage の外部からの変化には追従しない', async () => {
    const store = new BackoffStore();
    expect(await store.get()).toBe(0); // ここでこのインスタンスのキャッシュが 0 で埋まる

    // 裏の storage を直接書き換える (同じ service worker ライフタイム中に、あり得ない想定だが
    // 挙動を明示するためのテスト)
    backing.set('fbdlBackoffUntil', Date.now() + 60_000);

    // 同一インスタンスは以後 storage を読み直さないので、直接の書き換えには追従しない。
    // 反映させたければ record() 経由で書くか、新しいインスタンス (= 再起動) にする
    expect(await store.get()).toBe(0);
  });
});
