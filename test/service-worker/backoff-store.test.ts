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

  test('並行する record() は競合しても遠い方が残る (read-modify-write の直列化)', async () => {
    // 直列化されていないと、両方が同じ現在値 (0) を読んでから書き込むため、
    // 後から書き込みを終えた方が先に書き込まれた方を (本来遠いはずの期限ごと) 上書きしうる。
    // Promise.all で同時に発火させることで、await のたびに発生するマイクロタスクの
    // 切り替わりに乗じたこの競合を再現する。
    //
    // 呼び出し順は意図的に「遠い方を先、近い方を後」にしている。直列化されていない実装では
    // 両者とも同じ現在値 (0) から出発し、後に呼んだ方の書き込みが最後に完了するため、
    // 近い方を後に呼ぶこの並びが「短い期限が長い期限を上書きする」不具合を最も素直に再現する
    // (実際に直列化を外して実行し、この並びだけが失敗することを確認済み)。
    const store = new BackoffStore();
    await store.get(); // キャッシュを 0 で温めておき、競合条件を record() 自体の直列化に絞る
    const far = Date.now() + 200_000;
    const near = Date.now() + 100_000;

    const results = await Promise.all([store.record(far), store.record(near)]);

    expect(await store.get()).toBe(far);
    expect(Math.max(...results)).toBe(far);
  });

  test('record() 中の並行する get() は書き込み途中の値を返さない (直列化キューを共有する)', async () => {
    // get() と record() は同じキューを共有するため、呼び出した順に処理される。
    // ここでは record(until) を先に呼んでいるので、後から呼んだ get() は
    // record() の書き込みが完了した後の値だけを見る (書き込み途中の半端な状態を挟まない)
    const store = new BackoffStore();
    await store.get();
    const until = Date.now() + 60_000;

    const [recorded, gotten] = await Promise.all([store.record(until), store.get()]);

    expect(recorded).toBe(until);
    expect(gotten).toBe(until);
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
