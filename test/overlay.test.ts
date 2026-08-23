import { afterEach, describe, expect, test } from 'bun:test';
import type { DownloadManifest, DownloadZipResult } from 'download-helper/download-helper';
import {
  ApiShapeError,
  HttpError,
  RateLimitExhaustedError,
  ResponseParseError,
  TransportExhaustedError,
} from '../src/content/fanbox/api';
import type { CollectResult } from '../src/content/fanbox/collector';
import { PostBodyInvalidError, type PostFailureCounts } from '../src/content/fanbox/collector';
import {
  ALREADY_SAVED_HEADLINE,
  buildCompleteMessage,
  COMPLETE_HEADLINE,
  type CompleteMessageParams,
  describePickerFailure,
  isUnsupportedResponseError,
  joinHistoryErrors,
  NOTHING_SAVED_HEADLINE,
  OVERLAY_TRANSITIONS,
  type OverlayState,
  PARTIAL_DOWNLOAD_MESSAGE,
  PARTIAL_FILE_FAILURE_HEADLINE,
  PICKER_FAILED_MESSAGE,
  RATE_LIMIT_EXHAUSTED_HEADLINE,
  recordHistory,
  recordObservation,
  TRANSPORT_EXHAUSTED_HEADLINE,
  UNSUPPORTED_RESPONSE_HEADLINE,
} from '../src/content/overlay';

/**
 * OverlayController の状態遷移テスト
 * DOM 環境が必要なため、状態遷移ロジックのみを検証する
 */

// 遷移表は実装 (src/content/overlay.ts の OVERLAY_TRANSITIONS) が SoT で、ここではその中身を
// 仕様として固定する。実装側は setState がテストビルドでこの表に照らして検証するので、
// 表に無い遷移をするようになれば e2e が落ちる
function isValidTransition(from: OverlayState, to: OverlayState): boolean {
  return OVERLAY_TRANSITIONS[from].includes(to);
}

describe('Overlay 状態遷移', () => {
  // 実装の表そのものを固定する。ここが緩むと、実装が新しい遷移を許すようになっても
  // 下の個別テストが「有効」と言い続けてしまう
  test('遷移表の内容が仕様どおりである', () => {
    expect(OVERLAY_TRANSITIONS).toEqual({
      settings: ['collecting'],
      collecting: ['review', 'settings', 'complete'],
      review: ['downloading', 'settings'],
      downloading: ['complete', 'settings'],
      complete: ['settings'],
    });
  });

  test('settings → collecting は有効', () => {
    expect(isValidTransition('settings', 'collecting')).toBe(true);
  });

  // Issue #55: 収集が終わっても直接 ZIP 生成へは行かず、必ず選択画面 (review) を挟む
  test('collecting → review は有効', () => {
    expect(isValidTransition('collecting', 'review')).toBe(true);
  });

  test('collecting → downloading は無効 (review を飛ばして ZIP 生成に入らない)', () => {
    expect(isValidTransition('collecting', 'downloading')).toBe(false);
  });

  test('collecting → settings (キャンセル) は有効', () => {
    expect(isValidTransition('collecting', 'settings')).toBe(true);
  });

  // 確定ボタンのクリックで保存先を確保してから ZIP 生成に入る (Issue #55)
  test('review → downloading は有効', () => {
    expect(isValidTransition('review', 'downloading')).toBe(true);
  });

  test('review → settings (閉じる) は有効', () => {
    expect(isValidTransition('review', 'settings')).toBe(true);
  });

  // 選択の確定は必ず ZIP 生成を経由する。保存先の取得に失敗しても review に留まるので、
  // review から完了画面へ直接抜ける経路は無い
  test('review → complete は無効', () => {
    expect(isValidTransition('review', 'complete')).toBe(false);
  });

  // Issue #14: downloading を経由せず collecting → complete に直接遷移する経路が 3 つある。
  // いずれも downloadAsZip を呼ぶ前 (= 保存すべき ZIP が無い、または安全に取り込めない
  // レスポンスだった) ことが分かった時点で直接 complete に着地させるための遷移である。
  // 1. collect() が正常に返り addedPostCount === 0 (登録できた投稿が無いので ZIP を保存しない)
  // 2. collect() が ApiShapeError / PostBodyInvalidError を投げる (未対応のレスポンス形式で中断)
  // 3. collect() がそれ以外の例外を投げる (例: addedPostCount === 0 のまま枯渇した
  //    RateLimitExhaustedError) — catch の汎用フォールバックが complete へ落とす
  test('collecting → complete は有効 (downloadAsZip を呼ぶ前に保存不要/中断が確定した場合)', () => {
    expect(isValidTransition('collecting', 'complete')).toBe(true);
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

  test('settings → review は無効', () => {
    expect(isValidTransition('settings', 'review')).toBe(false);
  });

  test('complete → review は無効', () => {
    expect(isValidTransition('complete', 'review')).toBe(false);
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

function emptyPostFailures(overrides: Partial<PostFailureCounts> = {}): PostFailureCounts {
  return {
    unavailable: 0,
    unavailableRestricted: 0,
    unavailableMissingBody: 0,
    unsupported: 0,
    apiFailed: 0,
    ...overrides,
  };
}

/**
 * Issue #18 第 1 段階・Issue #14: 完了画面の分岐 (buildCompleteMessage) のテスト。
 * DOM や collect()/downloadAsZip() を経由せず、失敗件数の組み合わせを直接入力して
 * 完了画面の文言を検証する (buildCompleteMessage は overlay.ts から切り出した純粋関数)。
 * 見出し文言は exports の完全一致で固定し、退行 (表現の変更) を検知できるようにする。
 */
describe('Issue #18 / #14: 完了画面の分岐 (buildCompleteMessage)', () => {
  test('見出し文言が仕様どおりである (完全一致)', () => {
    expect(COMPLETE_HEADLINE).toBe('ダウンロードが完了しました');
    expect(PARTIAL_FILE_FAILURE_HEADLINE).toBe('一部取得できませんでした');
    expect(RATE_LIMIT_EXHAUSTED_HEADLINE).toBe('レート制限のため途中で打ち切りました (取得できた分のみ保存しています)');
    expect(TRANSPORT_EXHAUSTED_HEADLINE).toBe(
      '通信に失敗したため途中で打ち切りました (取得できた分のみ保存しています)',
    );
    expect(NOTHING_SAVED_HEADLINE).toBe('保存できる投稿がなかったため ZIP を保存しませんでした');
    expect(UNSUPPORTED_RESPONSE_HEADLINE).toBe('未対応のレスポンス形式のため中断しました');
  });

  const base: CompleteMessageParams = {
    aborted: false,
    addedPostCount: 1,
    postFailures: emptyPostFailures(),
    failedPageCount: 0,
    failedFileCount: 0,
  };

  test('収集時の観測の記録に失敗したら完了画面に出す (保存実績だけ記録されて次回また全件になる理由を伝えるため)', () => {
    const message = buildCompleteMessage({ ...base, historyError: '収集の記録に失敗' });

    expect(message).toContain('収集の記録に失敗');
  });

  test('省いた投稿があっても見出しは変わらない (取りこぼしではないため)', () => {
    const message = buildCompleteMessage({ ...base, skippedByHistoryCount: 3 });

    expect(message.split('\n')[0]).toBe(COMPLETE_HEADLINE);
    expect(message).toContain('前回保存済みのため取得を省いた投稿: 3 件');
  });

  test('全件が省かれたときは「更新はありません」にする (差分が無いことを失敗のように読ませないため)', () => {
    const message = buildCompleteMessage({ ...base, addedPostCount: 0, skippedByHistoryCount: 5 });

    expect(message.split('\n')[0]).toBe(ALREADY_SAVED_HEADLINE);
    expect(message).toContain('前回保存済みのため取得を省いた投稿: 5 件');
  });

  test('省いた投稿があっても取りこぼしがあれば「保存していません」を出す (欠落を更新なしで隠さないため)', () => {
    const message = buildCompleteMessage({
      ...base,
      addedPostCount: 0,
      skippedByHistoryCount: 5,
      postFailures: { ...base.postFailures, apiFailed: 1 },
    });

    expect(message.split('\n')[0]).toBe(NOTHING_SAVED_HEADLINE);
  });

  test('履歴の更新に失敗しても見出しは変わらない (ZIP は保存できているので「一部取得できませんでした」にしないため)', () => {
    const message = buildCompleteMessage({ ...base, historyError: 'storage が一杯です' });

    expect(message.split('\n')[0]).toBe(COMPLETE_HEADLINE);
  });

  test('履歴の更新に失敗したら次回が全件取得になることを本文に書く (黙って落とすと全件取り直す理由が分からないため)', () => {
    const message = buildCompleteMessage({ ...base, historyError: 'storage が一杯です' });

    expect(message).toContain('storage が一杯です');
    expect(message).toContain('今回の保存分は次回の差分判定に反映されません');
  });

  test('失敗ゼロ・非中断は COMPLETE_HEADLINE のみ (従来どおり)', () => {
    expect(buildCompleteMessage(base)).toBe(COMPLETE_HEADLINE);
  });

  // Issue #14: 収集フェーズの欠落 (postFailures/failedPageCount) だけがあっても、
  // ZIP フェーズの欠落 (failedFileCount) と同様に見出しを PARTIAL_FILE_FAILURE_HEADLINE に
  // 変える。以前は failedFileCount のみを見ていたため、本文に欠落の行があるのに
  // 見出しが「完了しました」のままになる矛盾があった。

  test('本文を利用できなかった投稿のみ: 見出しが一部取得できませんでしたに変わる', () => {
    const message = buildCompleteMessage({ ...base, postFailures: emptyPostFailures({ unavailable: 2 }) });
    expect(message).toBe(
      `${PARTIAL_FILE_FAILURE_HEADLINE}\n本文を利用できなかった投稿: 2 件 (閲覧権限または支援プランの範囲外など)`,
    );
  });

  test('未対応の本文形式 (unsupported) のみ: 見出しが一部取得できませんでしたに変わる', () => {
    const message = buildCompleteMessage({ ...base, postFailures: emptyPostFailures({ unsupported: 3 }) });
    expect(message).toBe(
      `${PARTIAL_FILE_FAILURE_HEADLINE}\n未対応の本文形式: 3 件 (拡張機能の更新が必要な可能性があります)`,
    );
  });

  test('API 通信に失敗した投稿のみ: 見出しが一部取得できませんでしたに変わる', () => {
    const message = buildCompleteMessage({ ...base, postFailures: emptyPostFailures({ apiFailed: 4 }) });
    expect(message).toBe(
      `${PARTIAL_FILE_FAILURE_HEADLINE}\nAPI 通信に失敗した投稿: 4 件 (時間を置いて再試行してください)`,
    );
  });

  test('取得できなかった一覧ページのみ: 見出しが一部取得できませんでしたに変わる', () => {
    const message = buildCompleteMessage({ ...base, failedPageCount: 5 });
    expect(message).toBe(
      `${PARTIAL_FILE_FAILURE_HEADLINE}\n取得できなかった一覧ページ: 5 ページ (欠落した投稿数は不明)`,
    );
  });

  test('ZIP フェーズのファイル欠落 (カバー画像含む) のみ: 見出しが一部取得できませんでしたに変わる', () => {
    const message = buildCompleteMessage({ ...base, failedFileCount: 3 });
    expect(message).toBe(
      `${PARTIAL_FILE_FAILURE_HEADLINE}\n取得できなかったファイル: 3 件 (カバー画像含む。時間を置いて再試行してください)`,
    );
  });

  test('収集フェーズ (4 分類) と ZIP フェーズの失敗が全部そろうと、理由ごとに独立した行で列挙される', () => {
    const message = buildCompleteMessage({
      aborted: false,
      addedPostCount: 1,
      postFailures: emptyPostFailures({ unavailable: 1, unsupported: 2, apiFailed: 3 }),
      failedPageCount: 4,
      failedFileCount: 5,
    });
    expect(message).toBe(
      [
        PARTIAL_FILE_FAILURE_HEADLINE,
        '本文を利用できなかった投稿: 1 件 (閲覧権限または支援プランの範囲外など)',
        '未対応の本文形式: 2 件 (拡張機能の更新が必要な可能性があります)',
        'API 通信に失敗した投稿: 3 件 (時間を置いて再試行してください)',
        '取得できなかった一覧ページ: 4 ページ (欠落した投稿数は不明)',
        '取得できなかったファイル: 5 件 (カバー画像含む。時間を置いて再試行してください)',
      ].join('\n'),
    );
  });

  test('レート制限による打ち切りが最優先 (ZIP フェーズの失敗が 0 でも見出しは打ち切り扱い)', () => {
    const message = buildCompleteMessage({ ...base, stoppedReason: 'rate-limit-exhausted' });
    expect(message).toBe(RATE_LIMIT_EXHAUSTED_HEADLINE);
  });

  test('通信の枯渇による打ち切りはレート制限とは別の見出しになる', () => {
    // レート制限は時間を置けばよいが、通信の失敗は環境側の確認が要るので文言を分ける
    const message = buildCompleteMessage({ ...base, stoppedReason: 'transport-exhausted' });
    expect(message).toBe(TRANSPORT_EXHAUSTED_HEADLINE);
    expect(message).not.toBe(RATE_LIMIT_EXHAUSTED_HEADLINE);
  });

  test('レート制限による打ち切りと ZIP フェーズの失敗が両方あっても見出しは打ち切りが勝ち、件数は併記する', () => {
    const message = buildCompleteMessage({ ...base, failedFileCount: 5, stoppedReason: 'rate-limit-exhausted' });
    expect(message).toBe(
      `${RATE_LIMIT_EXHAUSTED_HEADLINE}\n取得できなかったファイル: 5 件 (カバー画像含む。時間を置いて再試行してください)`,
    );
  });

  test('中断 (「ここまでで終了」) かつ失敗ゼロは PARTIAL_DOWNLOAD_MESSAGE のみ (断定しない文言を維持)', () => {
    expect(buildCompleteMessage({ ...base, aborted: true })).toBe(PARTIAL_DOWNLOAD_MESSAGE);
  });

  test('中断かつ ZIP フェーズの失敗がある場合、PARTIAL_DOWNLOAD_MESSAGE を維持しつつ件数を併記する', () => {
    const message = buildCompleteMessage({ ...base, aborted: true, failedFileCount: 4 });
    expect(message).toBe(
      `${PARTIAL_DOWNLOAD_MESSAGE}\n取得できなかったファイル: 4 件 (カバー画像含む。時間を置いて再試行してください)`,
    );
  });

  // collect() は postFailures/failedPageCount があっても打ち切らず ZIP フェーズへ進むため、
  // 「中断時は収集フェーズの失敗が無い」という前提は成り立たない。ZIP フェーズだけを中断しても
  // 収集フェーズの失敗は消えないので、PARTIAL_DOWNLOAD_MESSAGE に併記する
  test('中断時も収集フェーズの失敗件数を併記する', () => {
    const message = buildCompleteMessage({
      aborted: true,
      addedPostCount: 1,
      postFailures: emptyPostFailures({ unavailable: 9 }),
      failedPageCount: 3,
      failedFileCount: 0,
    });
    expect(message).toBe(
      `${PARTIAL_DOWNLOAD_MESSAGE}\n` +
        '本文を利用できなかった投稿: 9 件 (閲覧権限または支援プランの範囲外など)\n' +
        '取得できなかった一覧ページ: 3 ページ (欠落した投稿数は不明)',
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
      addedPostCount: 1,
      postFailures: emptyPostFailures({ unavailable: 1 }),
      failedPageCount: 2,
      failedFileCount: 3,
      stoppedReason: 'rate-limit-exhausted',
    });
    expect(message).toBe(
      [
        RATE_LIMIT_EXHAUSTED_HEADLINE,
        PARTIAL_DOWNLOAD_MESSAGE,
        '本文を利用できなかった投稿: 1 件 (閲覧権限または支援プランの範囲外など)',
        '取得できなかった一覧ページ: 2 ページ (欠落した投稿数は不明)',
        '取得できなかったファイル: 3 件 (カバー画像含む。時間を置いて再試行してください)',
      ].join('\n'),
    );
  });
});

/**
 * Issue #14: 登録できた投稿が 0 件の場合、ZIP を保存しない (NOTHING_SAVED_HEADLINE)。
 * 判定は addedPostCount で行い、失敗件数の多寡には依存しない
 * (失敗ゼロ・postFailures 全て 0 でも addedPostCount === 0 なら NOTHING_SAVED_HEADLINE になる —
 * 例えば投稿が 1 件も存在しないクリエイターの場合)。
 */
describe('Issue #14: 登録できた投稿が 0 件の場合 (buildCompleteMessage)', () => {
  test('addedPostCount が 0 なら、他のフラグに関わらず NOTHING_SAVED_HEADLINE になる', () => {
    const message = buildCompleteMessage({
      aborted: false,
      addedPostCount: 0,
      postFailures: emptyPostFailures(),
      failedPageCount: 0,
      failedFileCount: 0,
    });
    expect(message).toBe(NOTHING_SAVED_HEADLINE);
  });

  test('addedPostCount が 0 のとき、失敗の内訳を理由付きで併記する', () => {
    const message = buildCompleteMessage({
      aborted: false,
      addedPostCount: 0,
      postFailures: emptyPostFailures({ unavailable: 3, unsupported: 1 }),
      failedPageCount: 0,
      failedFileCount: 0,
    });
    expect(message).toBe(
      `${NOTHING_SAVED_HEADLINE}\n` +
        '本文を利用できなかった投稿: 3 件 (閲覧権限または支援プランの範囲外など)\n' +
        '未対応の本文形式: 1 件 (拡張機能の更新が必要な可能性があります)',
    );
  });

  test('addedPostCount が 0 は stoppedReason より優先される (両立しない前提だが、優先順位として明示する)', () => {
    const message = buildCompleteMessage({
      aborted: false,
      addedPostCount: 0,
      postFailures: emptyPostFailures(),
      failedPageCount: 0,
      failedFileCount: 0,
      stoppedReason: 'rate-limit-exhausted',
    });
    expect(message).toBe(NOTHING_SAVED_HEADLINE);
  });

  test('addedPostCount が 1 以上なら NOTHING_SAVED_HEADLINE にならない', () => {
    const message = buildCompleteMessage({
      aborted: false,
      addedPostCount: 1,
      postFailures: emptyPostFailures(),
      failedPageCount: 0,
      failedFileCount: 0,
    });
    expect(message).not.toBe(NOTHING_SAVED_HEADLINE);
    expect(message).toBe(COMPLETE_HEADLINE);
  });
});

/**
 * 収集が「未対応のレスポンス形式」で中断したかの判定 (Issue #14)。
 * OverlayController.startCollecting の catch はこの判定でのみ UNSUPPORTED_RESPONSE_HEADLINE に
 * 分岐するため、ここが漏れると仕様変更が「エラーが発生しました: ...」に潰れて伝わらない。
 */
describe('Issue #14: 未対応のレスポンス形式の判定 (isUnsupportedResponseError)', () => {
  const url = 'https://api.fanbox.cc/post.info?postId=1';

  test('API 層の形状違反 (ApiShapeError) は未対応のレスポンス形式として扱う', () => {
    expect(isUnsupportedResponseError(new ApiShapeError(url, ['body.post']))).toBe(true);
  });

  test('本文を JSON として読めなかった場合 (ResponseParseError) も未対応のレスポンス形式として扱う', () => {
    // 共有セッションは JSON パース失敗を ResponseParseError で返す。ここが漏れると
    // 「壊れた本文が返り続ける」仕様変更が汎用のエラー文言に潰れる
    expect(isUnsupportedResponseError(new ResponseParseError(url))).toBe(true);
  });

  test('ライブラリ層の本文不一致 (PostBodyInvalidError) も未対応のレスポンス形式として扱う', () => {
    expect(isUnsupportedResponseError(new PostBodyInvalidError('1', 'image', ['body.images']))).toBe(true);
  });

  test('通信・レート制限・HTTP エラーは未対応のレスポンス形式ではない', () => {
    // これらは時間を置けば直りうる失敗であり、「拡張機能の更新が必要」とは意味が違う
    expect(isUnsupportedResponseError(new RateLimitExhaustedError(url))).toBe(false);
    expect(isUnsupportedResponseError(new TransportExhaustedError(url))).toBe(false);
    expect(isUnsupportedResponseError(new HttpError(url, 500))).toBe(false);
    expect(isUnsupportedResponseError(new Error('想定外のバグ'))).toBe(false);
  });
});

/**
 * Issue #55: 保存先の取得に失敗したときの分岐 (describePickerFailure)。
 *
 * `showSaveFilePicker` はネイティブダイアログを要求するためブラウザ自動化では失敗を再現できない。
 * 分岐だけを純粋関数として切り出し、DOM 無しで固定する。
 */
describe('Issue #55: 保存先の取得に失敗したときの文言 (describePickerFailure)', () => {
  test('AbortError (保存先の選択をやめた) は文言を出さない', () => {
    expect(describePickerFailure(new DOMException('user aborted', 'AbortError'))).toBeNull();
  });

  // AbortError 以外の DOMException は「選択をやめた」ではないので、黙って戻すと
  // 利用者は確定ボタンが効かない理由を知る手段が無くなる
  test.each(['SecurityError', 'NotAllowedError', 'InvalidStateError'])('%s は理由を添えて文言を出す', (name) => {
    const message = describePickerFailure(new DOMException('denied', name));
    expect(message).toBe(`${PICKER_FAILED_MESSAGE}: denied`);
  });

  test('DOMException でない例外も文言を出す', () => {
    expect(describePickerFailure(new Error('disk full'))).toBe(`${PICKER_FAILED_MESSAGE}: disk full`);
  });

  test('Error ですらない値も文言を出す', () => {
    expect(describePickerFailure('boom')).toBe(`${PICKER_FAILED_MESSAGE}: boom`);
  });
});

/**
 * Issue #56: 収集・ZIP の結果が実際に履歴として送られるかの検証。
 *
 * 差分の組み立て (`history-update.ts`) とは別に、**送る・送らないの判断**を固定する。
 * 組み立てだけをテストしても、呼び出しを消した退行を検出できない。
 */
describe('Issue #56: 履歴の記録', () => {
  const origChrome = (globalThis as { chrome?: unknown }).chrome;
  let sent: unknown[];

  const installRuntime = (respond: () => unknown) => {
    sent = [];
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: async (message: unknown) => {
          sent.push(message);
          return respond();
        },
      },
    };
  };

  const makeResult = () =>
    ({
      downloadObject: { listPosts: () => [] },
      addedPostCount: 1,
      postFailures: {
        unavailable: 0,
        unavailableRestricted: 0,
        unavailableMissingBody: 0,
        unsupported: 0,
        apiFailed: 0,
      },
      failedPageCount: 0,
      listedRevisions: new Map(),
      apiFailedPostIds: new Set(),
      skippedByHistoryPostIds: new Set(),
      collectedAt: 1000,
      scannedCreator: true,
      completedFullScan: true,
      limited: false,
    }) as unknown as CollectResult;

  const manifest = { posts: [] } as unknown as DownloadManifest;
  const zip = (aborted: boolean) =>
    ({
      completedPostCount: 1,
      totalPostCount: 1,
      writtenFileCount: 0,
      failedFileCount: 0,
      aborted,
      assets: [],
    }) as unknown as DownloadZipResult;

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: chrome runtime mock
    (globalThis as any).chrome = origChrome;
  });

  test('収集を終えたら観測を送る (ZIP を作らない回にも走査実績と最終利用時刻を残すため)', async () => {
    installRuntime(() => ({ ok: true }));

    const error = await recordObservation('creator-1', makeResult());

    expect(error).toBeNull();
    expect(sent).toEqual([
      { type: 'historyApply', update: { creatorId: 'creator-1', at: 1000, catalog: [], scan: expect.anything() } },
    ]);
  });

  test('ZIP を書き終えたら保存実績を送る (書けたことを次回の差分判定へ渡すため)', async () => {
    installRuntime(() => ({ ok: true }));

    const error = await recordHistory(
      { creatorId: 'creator-1', result: makeResult() },
      manifest,
      zip(false),
      'out.zip',
    );

    expect(error).toBeNull();
    expect((sent[0] as { update: { saved?: unknown } }).update.saved).toEqual([]);
  });

  test('中断分岐へ入った実行は保存実績を送らない (書けたと確認できていないものを保存済みにしないため)', async () => {
    installRuntime(() => ({ ok: true }));

    const error = await recordHistory({ creatorId: 'creator-1', result: makeResult() }, manifest, zip(true), 'out.zip');

    expect([error, sent]).toEqual([null, []]);
  });

  test('中断分岐へ入らずに返った実行は保存実績を送る (全部書き終えた後の close() 中の中断は zip.aborted が false のまま返るため)', async () => {
    installRuntime(() => ({ ok: true }));

    // 判断材料は zip.aborted だけである (signal は引数に取らないので参照しようがない)
    const error = await recordHistory(
      { creatorId: 'creator-1', result: makeResult() },
      manifest,
      zip(false),
      'out.zip',
    );

    expect(error).toBeNull();
    expect(sent).toHaveLength(1);
  });

  test('service worker が失敗を返したらその理由を返す (完了画面へ伝えるため)', async () => {
    installRuntime(() => ({ ok: false, error: 'storage が一杯です' }));

    const error = await recordHistory(
      { creatorId: 'creator-1', result: makeResult() },
      manifest,
      zip(false),
      'out.zip',
    );

    expect(error).toBe('storage が一杯です');
  });
});

describe('Issue #56: 記録の失敗の文言', () => {
  test('観測と保存の両方が落ちたらどちらも出す (片方を採るともう片方の理由が消えるため)', () => {
    expect(joinHistoryErrors('収集が失敗', '保存が失敗')).toBe('収集の記録: 収集が失敗 / 保存の記録: 保存が失敗');
  });

  test('同じ理由なら一度だけ出す (storage が一杯なら両方が同じ文言になるため)', () => {
    expect(joinHistoryErrors('storage が一杯です', 'storage が一杯です')).toBe('storage が一杯です');
  });

  test('片方だけならそれをそのまま出す', () => {
    expect([joinHistoryErrors('だけ', null), joinHistoryErrors(null, 'だけ'), joinHistoryErrors(null, null)]).toEqual([
      'だけ',
      'だけ',
      null,
    ]);
  });
});
