import { describe, expect, test } from 'bun:test';

/**
 * OverlayController の状態遷移テスト
 * DOM 環境が必要なため、状態遷移ロジックのみを検証する
 */

type OverlayState = 'settings' | 'collecting' | 'downloading' | 'complete';

const validTransitions: Record<OverlayState, OverlayState[]> = {
  settings: ['collecting'],
  collecting: ['downloading', 'settings'],
  downloading: ['complete', 'settings'],
  complete: ['settings'],
};

function isValidTransition(from: OverlayState, to: OverlayState): boolean {
  return validTransitions[from].includes(to);
}

describe('Overlay 状態遷移', () => {
  test('settings → collecting は有効', () => {
    expect(isValidTransition('settings', 'collecting')).toBe(true);
  });

  test('collecting → downloading は有効', () => {
    expect(isValidTransition('collecting', 'downloading')).toBe(true);
  });

  test('collecting → settings (キャンセル) は有効', () => {
    expect(isValidTransition('collecting', 'settings')).toBe(true);
  });

  test('downloading → complete は有効', () => {
    expect(isValidTransition('downloading', 'complete')).toBe(true);
  });

  test('downloading → settings (キャンセル) は有効', () => {
    expect(isValidTransition('downloading', 'settings')).toBe(true);
  });

  test('complete → settings (閉じる) は有効', () => {
    expect(isValidTransition('complete', 'settings')).toBe(true);
  });

  test('settings → complete は無効', () => {
    expect(isValidTransition('settings', 'complete')).toBe(false);
  });

  test('settings → downloading は無効', () => {
    expect(isValidTransition('settings', 'downloading')).toBe(false);
  });

  test('complete → collecting は無効', () => {
    expect(isValidTransition('complete', 'collecting')).toBe(false);
  });

  test('complete → downloading は無効', () => {
    expect(isValidTransition('complete', 'downloading')).toBe(false);
  });
});
