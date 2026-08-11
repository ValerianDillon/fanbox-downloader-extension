import { describe, expect, test } from 'bun:test';
import { PARTIAL_DOWNLOAD_MESSAGE } from '../src/content/overlay';

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

  // Issue #17: 通常の完了、および「ここまでで終了」ボタンによる中断のどちらも
  // downloading → complete に着地する (中断側は startCollecting が downloadAsZip から
  // 戻った後、signal が現行のものであるときに complete へ遷移する。詳細は下の
  // describe ブロックを参照)
  test('downloading → complete は有効 (通常完了・「ここまでで終了」による中断のどちらも)', () => {
    expect(isValidTransition('downloading', 'complete')).toBe(true);
  });

  // ダウンロード中の画面自体にはキャンセル/中止ボタンは無い (Issue #17: 「中止」は
  // 用意しない)。この遷移はパネルの再オープン等で hidePanel() が呼ばれた場合の
  // 全破棄経路であり、部分保存の ZIP を活かす「ここまでで終了」とは別物である。
  test('downloading → settings (パネルを閉じる等による全破棄) は有効', () => {
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

describe('Issue #17: ダウンロード中の「ここまでで終了」', () => {
  // downloadZip は中断されても内部で signal を再確認しないまま最終の zip.close() に
  // 入るため、全投稿を書き終えた直後に押された場合は ZIP が実際には完全な可能性がある。
  // 「完了しました」「途中で終了しました」のようにどちらか一方を断定する表現にすると、
  // このケースで嘘になりうる。そのためどちらでも成り立つ表現になっていることを保証する。
  test('完了画面の文言は完了・部分保存のどちらも断定しない', () => {
    expect(PARTIAL_DOWNLOAD_MESSAGE).not.toContain('完了');
    expect(PARTIAL_DOWNLOAD_MESSAGE).not.toContain('失敗');
    expect(PARTIAL_DOWNLOAD_MESSAGE).not.toContain('中断');
  });

  // 収集中のキャンセル (全破棄) は hidePanel() が同期的に closeし settings へ即座に
  // 戻すため、この文言が使われる余地はない。ダウンロード中の中断でのみ表示される。
  test('文言はダウンロード中の中断専用であることが分かる内容になっている', () => {
    expect(PARTIAL_DOWNLOAD_MESSAGE).toContain('ここまで');
  });
});
