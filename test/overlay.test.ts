import { describe, expect, test } from 'bun:test';
import {
  buildCompleteMessage,
  COMPLETE_HEADLINE,
  type CompleteMessageParams,
  PARTIAL_DOWNLOAD_MESSAGE,
  PARTIAL_FILE_FAILURE_HEADLINE,
  RATE_LIMIT_EXHAUSTED_HEADLINE,
} from '../src/content/overlay';

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
  // 文言は仕様上「ここまでの内容を保存して終了しました」に確定している。
  // 部分文字列検証だけでは表現の退行 (別の断定的な文言への変更) を検知できないため、
  // 完全一致で固定する。
  test('完了画面の文言が仕様どおりである', () => {
    expect(PARTIAL_DOWNLOAD_MESSAGE).toBe('ここまでの内容を保存して終了しました');
  });

  // downloadZip は中断されても内部で signal を再確認しないまま最終の zip.close() に
  // 入るため、全投稿を書き終えた直後に押された場合は ZIP が実際には完全な可能性がある。
  // 「完了しました」「途中で終了しました」のようにどちらか一方を断定する表現にすると、
  // このケースで嘘になりうる。そのためどちらでも成り立つ表現になっていることを保証する
  // (この性質は上の完全一致テストからは読み取れないため、意図の記録として別テストにする)。
  test('完了画面の文言は完了・部分保存のどちらも断定しない', () => {
    expect(PARTIAL_DOWNLOAD_MESSAGE).not.toContain('完了');
    expect(PARTIAL_DOWNLOAD_MESSAGE).not.toContain('失敗');
    expect(PARTIAL_DOWNLOAD_MESSAGE).not.toContain('中断');
  });
});

/**
 * Issue #18 第 1 段階: 完了画面の分岐 (buildCompleteMessage) のテスト。
 * DOM や collect()/downloadAsZip() を経由せず、失敗件数の組み合わせを直接入力して
 * 完了画面の文言を検証する (buildCompleteMessage は overlay.ts から切り出した純粋関数)。
 * 見出し文言は exports の完全一致で固定し、退行 (表現の変更) を検知できるようにする。
 */
describe('Issue #18: 完了画面の分岐 (buildCompleteMessage)', () => {
  test('見出し文言が仕様どおりである (完全一致)', () => {
    expect(COMPLETE_HEADLINE).toBe('ダウンロードが完了しました');
    expect(PARTIAL_FILE_FAILURE_HEADLINE).toBe('一部取得できませんでした');
    expect(RATE_LIMIT_EXHAUSTED_HEADLINE).toBe('レート制限のため途中で打ち切りました (取得できた分のみ保存しています)');
  });

  const base: CompleteMessageParams = {
    aborted: false,
    failedPostCount: 0,
    failedPageCount: 0,
    failedFileCount: 0,
  };

  test('失敗ゼロ・非中断は COMPLETE_HEADLINE のみ (従来どおり)', () => {
    expect(buildCompleteMessage(base)).toBe(COMPLETE_HEADLINE);
  });

  test('収集フェーズの投稿単位の失敗のみ: 見出しは変えず、件数を併記する (従来どおり)', () => {
    const message = buildCompleteMessage({ ...base, failedPostCount: 2 });
    expect(message).toBe(
      `${COMPLETE_HEADLINE}\n2 件の投稿の取得に失敗しました (支援プランの範囲外か、FANBOX のレート制限の可能性があります)`,
    );
  });

  test('ZIP フェーズのファイル欠落 (カバー画像含む) のみ: 見出しが一部取得できませんでしたに変わる', () => {
    const message = buildCompleteMessage({ ...base, failedFileCount: 3 });
    expect(message).toBe(
      `${PARTIAL_FILE_FAILURE_HEADLINE}\n3 件のファイル (カバー画像含む)の取得に失敗しました (支援プランの範囲外か、FANBOX のレート制限の可能性があります)`,
    );
  });

  test('収集フェーズ (投稿・ページ) と ZIP フェーズの失敗が全部そろうと 1 つの文言に合流する', () => {
    const message = buildCompleteMessage({
      aborted: false,
      failedPostCount: 1,
      failedPageCount: 2,
      failedFileCount: 3,
    });
    expect(message).toBe(
      `${PARTIAL_FILE_FAILURE_HEADLINE}\n` +
        '1 件の投稿 と 2 ページ分の投稿一覧 (投稿数は不明) と 3 件のファイル (カバー画像含む)' +
        'の取得に失敗しました (支援プランの範囲外か、FANBOX のレート制限の可能性があります)',
    );
  });

  test('レート制限による打ち切りが最優先 (ZIP フェーズの失敗が 0 でも見出しは打ち切り扱い)', () => {
    const message = buildCompleteMessage({ ...base, stoppedReason: 'rate-limit-exhausted' });
    expect(message).toBe(RATE_LIMIT_EXHAUSTED_HEADLINE);
  });

  test('レート制限による打ち切りと ZIP フェーズの失敗が両方あっても見出しは打ち切りが勝ち、件数は併記する', () => {
    const message = buildCompleteMessage({ ...base, failedFileCount: 5, stoppedReason: 'rate-limit-exhausted' });
    expect(message).toBe(
      `${RATE_LIMIT_EXHAUSTED_HEADLINE}\n5 件のファイル (カバー画像含む)の取得に失敗しました (支援プランの範囲外か、FANBOX のレート制限の可能性があります)`,
    );
  });

  test('中断 (「ここまでで終了」) かつ失敗ゼロは PARTIAL_DOWNLOAD_MESSAGE のみ (断定しない文言を維持)', () => {
    expect(buildCompleteMessage({ ...base, aborted: true })).toBe(PARTIAL_DOWNLOAD_MESSAGE);
  });

  test('中断かつ ZIP フェーズの失敗がある場合、PARTIAL_DOWNLOAD_MESSAGE を維持しつつ件数を併記する', () => {
    const message = buildCompleteMessage({ ...base, aborted: true, failedFileCount: 4 });
    expect(message).toBe(
      `${PARTIAL_DOWNLOAD_MESSAGE}\n4 件のファイル (カバー画像含む)の取得に失敗しました (支援プランの範囲外か、FANBOX のレート制限の可能性があります)`,
    );
  });

  // collect() は failedPostCount/failedPageCount があっても打ち切らず ZIP フェーズへ進むため、
  // 「中断時は収集フェーズの失敗が無い」という前提は成り立たない。ZIP フェーズだけを中断しても
  // 収集フェーズの失敗は消えないので、PARTIAL_DOWNLOAD_MESSAGE に併記する
  test('中断時も収集フェーズの失敗件数 (failedPostCount/failedPageCount) を併記する', () => {
    const message = buildCompleteMessage({
      aborted: true,
      failedPostCount: 9,
      failedPageCount: 3,
      failedFileCount: 0,
    });
    expect(message).toBe(
      `${PARTIAL_DOWNLOAD_MESSAGE}\n9 件の投稿 と 3 ページ分の投稿一覧 (投稿数は不明)の取得に失敗しました (支援プランの範囲外か、FANBOX のレート制限の可能性があります)`,
    );
  });

  // 収集フェーズの打ち切り (stoppedReason) は、その後 ZIP フェーズで「ここまでで終了」が
  // 押されて中断したかどうかに関わらず最優先の見出しになる (非中断時と同じ見出し)。
  test('収集フェーズの打ち切り (stoppedReason) は ZIP フェーズの中断より優先される (見出しは非中断時と同じ)', () => {
    const message = buildCompleteMessage({
      ...base,
      aborted: true,
      stoppedReason: 'rate-limit-exhausted',
    });
    // 見出しは打ち切りが勝つが、ZIP フェーズも中断したという事実は落とさず本文に併記する
    expect(message).toBe(`${RATE_LIMIT_EXHAUSTED_HEADLINE}\n${PARTIAL_DOWNLOAD_MESSAGE}`);
  });

  test('収集フェーズの打ち切りと ZIP フェーズの中断が両方あり、かつ各フェーズの失敗もある場合、すべて併記する', () => {
    const message = buildCompleteMessage({
      aborted: true,
      failedPostCount: 1,
      failedPageCount: 2,
      failedFileCount: 3,
      stoppedReason: 'rate-limit-exhausted',
    });
    expect(message).toBe(
      `${RATE_LIMIT_EXHAUSTED_HEADLINE}\n${PARTIAL_DOWNLOAD_MESSAGE}\n` +
        '1 件の投稿 と 2 ページ分の投稿一覧 (投稿数は不明) と 3 件のファイル (カバー画像含む)' +
        'の取得に失敗しました (支援プランの範囲外か、FANBOX のレート制限の可能性があります)',
    );
  });
});
