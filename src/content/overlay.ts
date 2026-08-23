import type {
  DownloadJsonObj,
  DownloadManifest,
  DownloadZipResult,
  PostSummary,
} from 'download-helper/download-helper';
import type { CreatorHistory, HistoryResponse } from '../history-record';
import type { DownloadProgress, FileSystemFileHandle } from './downloader';
import { downloadAsZip, pickSaveHandle, preflightDownload } from './downloader';
import { ApiShapeError, type PageType, ResponseParseError } from './fanbox/api';
import type { CollectorSettings, CollectResult, PostFailureCounts } from './fanbox/collector';
import { collect, PostBodyInvalidError } from './fanbox/collector';
import { applyCreatorHistory, readCreatorHistory, removeCreatorHistory } from './history';
import { historyForCollect } from './history-plan';
import { buildObservationUpdate, buildSaveUpdate } from './history-update';
import css from './overlay.css' with { type: 'text' };
import {
  countSelection,
  createInitialSelection,
  describeRenderedRange,
  describeSelectionCounts,
  describeSizeEstimate,
  type ExtensionOption,
  filterPosts,
  listExtensionOptions,
  POST_LIST_RENDER_LIMIT,
  type ReviewSelection,
  toSelection,
} from './review-model';
import { assertAllowedTransitionForTest, publishTestState, resetTestState, SHADOW_ROOT_MODE } from './test-hooks';

/**
 * オーバーレイの状態。
 *
 * `review` は収集が終わってからダウンロード対象の選択を確定するまでの区間である (Issue #55)。
 * 収集用と ZIP 用の AbortController の切り替わりもここで起きる。
 */
export type OverlayState = 'settings' | 'collecting' | 'review' | 'downloading' | 'complete';

/**
 * 許される状態遷移。
 *
 * ここが遷移の SoT で、テストビルドの `setState` がこの表に照らして検証する。
 * 表をテスト側に手で持つと、実装が表に無い遷移をするようになってもテストは通ってしまう。
 *
 * - `collecting → complete` (review / downloading を経由しない) は 3 経路が使う。
 *   collect() が正常に返って `addedPostCount === 0` (Issue #14)、未対応のレスポンス形式で例外、
 *   それ以外の例外 (枯渇や想定外のバグ) の catch。いずれも保存すべき ZIP が無いと分かった時点で着地する
 * - `review → complete` は無い。確定は必ず `downloading` を経由する。保存先の取得に失敗しても
 *   review に留まる (Issue #55)
 * - `downloading → settings` はパネルの再オープン等による全破棄で、部分保存を活かす
 *   「ここまでで終了」(→ complete) とは別物である
 */
export const OVERLAY_TRANSITIONS: Readonly<Record<OverlayState, readonly OverlayState[]>> = {
  settings: ['collecting'],
  collecting: ['review', 'settings', 'complete'],
  review: ['downloading', 'settings'],
  downloading: ['complete', 'settings'],
  complete: ['settings'],
};

/**
 * ダウンロード中に「ここまでで終了」が押されて中断した場合の完了画面の文言。
 *
 * 全投稿を書き終えた直後 (最終の zip.close() の最中) に押された場合、ZIP は実際には
 * 完全にできあがっている可能性がある。download-helper v4.4.0 の DownloadZipResult.aborted も
 * 同じ境界 (zip.close() 実行中の中断) では反映されない仕様のため (Issue #17 の「完了直前に
 * 押された場合の文言」参照、DownloadZipResult のコメントも参照)、ここでは引き続き
 * content script 側の AbortSignal (signal.aborted) を見て判定し、完了・部分保存の
 * どちらであっても偽にならない断定しない表現にする。
 */
export const PARTIAL_DOWNLOAD_MESSAGE = 'ここまでの内容を保存して終了しました';

/** 失敗ゼロ・非中断の完了画面の見出し */
export const COMPLETE_HEADLINE = 'ダウンロードが完了しました';

/**
 * 収集フェーズ (postFailures / failedPageCount) または ZIP フェーズ (failedFileCount) の
 * いずれかに欠落があった、非中断の完了画面の見出し (Issue #18 第 1 段階。Issue #14 で
 * 条件を ZIP フェーズのファイル欠落のみから収集フェーズの欠落も含める形に拡張した —
 * 拡張前は収集フェーズの欠落だけがあっても見出しが COMPLETE_HEADLINE のままで、
 * 本文に併記される欠落の詳細行と矛盾していた)。
 */
export const PARTIAL_FILE_FAILURE_HEADLINE = '一部取得できませんでした';

/**
 * 新しく取得するものが無かったときの見出し (Issue #56)。
 *
 * 「取得済み」ではなく「前回保存済み」とする。拡張が主張できるのは書き込みの完了を確認した
 * ことまでで、その ZIP が今も存在するとは主張できない。
 */
export const ALREADY_SAVED_HEADLINE = '前回保存済みから更新はありませんでした';

/** 収集フェーズがレート制限で打ち切られた場合の完了画面の見出し */
export const RATE_LIMIT_EXHAUSTED_HEADLINE = 'レート制限のため途中で打ち切りました (取得できた分のみ保存しています)';
export const TRANSPORT_EXHAUSTED_HEADLINE = '通信に失敗したため途中で打ち切りました (取得できた分のみ保存しています)';

/**
 * addByPostInfo が 'added' を返した投稿が 0 件だった場合の完了画面の見出し (Issue #14)。
 *
 * この場合 review へ進まず ZIP も保存しない。保存先の確保は review の確定時に初めて行うので、
 * **この経路では showSaveFilePicker を呼ばず、0 バイトのファイルも残らない** (Issue #55)。
 * 以前は収集より前に picker を呼んでいたため、書き込みを一切しなくても 0 バイトのファイルが
 * 残っていた (ハンドルからは新規作成か上書き対象の既存ファイルかを区別できず、無条件に削除すると
 * 利用者が残したいファイルを消しかねないので、削除もできなかった)。
 */
export const NOTHING_SAVED_HEADLINE = '保存できる投稿がなかったため ZIP を保存しませんでした';

/**
 * 収集が「未対応のレスポンス形式」(ApiShapeError / ResponseParseError または
 * PostBodyInvalidError) で中断した場合の完了画面の見出し (Issue #14)。
 *
 * この場合 collect() が例外を投げるため CompleteMessageParams を経由せず、
 * OverlayController.startCollecting の catch から直接この見出しで complete 状態に遷移する。
 */
export const UNSUPPORTED_RESPONSE_HEADLINE = '未対応のレスポンス形式のため中断しました';

/**
 * 収集を止めた例外が「未対応のレスポンス形式」かを判定する。
 *
 * ApiShapeError は API 層のレスポンス形状違反、ResponseParseError は同じく API 層の
 * 本文を JSON として読めなかったケース、PostBodyInvalidError はライブラリ層
 * (addByPostInfo が読む本文フィールドの不一致) で、どれも「このバージョンでは安全に
 * 取り込めない仕様変更」を意味するため同じ見出しで扱う。
 *
 * 判定を関数に切り出しているのは、この分岐が OverlayController の catch の中にあり
 * DOM 無しでは検証できないため。収集の失敗のうちどれを仕様変更として扱うかは
 * 見出しの分岐そのものなので、純粋関数として固定する。
 */
export function isUnsupportedResponseError(e: unknown): boolean {
  return e instanceof ApiShapeError || e instanceof ResponseParseError || e instanceof PostBodyInvalidError;
}

/**
 * review 画面で保存先 (`showSaveFilePicker`) を確保できなかった場合の文言 (Issue #55)。
 *
 * 利用者が選択をやめた `AbortError` はエラーにせず review へ戻すので、この文言は出さない。
 */
export const PICKER_FAILED_MESSAGE = 'ファイル保存先を取得できませんでした';

/** review 画面でダウンロード対象を導出できなかった場合の文言 (Issue #55) */
export const PROJECTION_FAILED_MESSAGE = 'ダウンロード対象を組み立てられませんでした';

/** 拡張子を持たないアセットの選択肢に付ける表示名 */
export const NO_EXTENSION_LABEL = '(拡張子なし)';

/**
 * 選択が変わってから導出 (`project`) を走らせるまでの静穏時間 (ms)。
 *
 * 1000 投稿規模では `project()` だけで 100 ms 近くかかる。チェックのたびに走らせると
 * 連続操作でメインスレッドが目に見えて止まる。
 */
export const PROJECTION_DEBOUNCE_MS = 200;

/**
 * 保存先の取得に失敗したときに review 画面へ出す文言を返す。出さない場合は null。
 *
 * `AbortError` は「保存先を選ばずに閉じた」という正常な操作なので、エラーとして見せない。
 * それ以外 (`SecurityError` / `NotAllowedError` / 書き込み不能など) は理由を添えて出す。
 *
 * 分岐を純粋関数に切り出しているのは、`showSaveFilePicker` がネイティブダイアログを要求するため
 * ブラウザ自動化では失敗経路を再現できず、DOM 無しで検証するしかないためである。
 * @param e picker が投げた値
 */
export function describePickerFailure(e: unknown): string | null {
  if (e instanceof DOMException && e.name === 'AbortError') return null;
  return `${PICKER_FAILED_MESSAGE}: ${e instanceof Error ? e.message : String(e)}`;
}

export type CompleteMessageParams = {
  /** 「ここまでで終了」による中断か (content script 側の AbortSignal 由来) */
  aborted: boolean;
  /**
   * addByPostInfo が 'added' を返した件数。0 なら他の値に関わらず NOTHING_SAVED_HEADLINE を
   * 最優先で返す (ZIP を保存していないので、それ以外の見出しは事実と矛盾する)。
   */
  addedPostCount: number;
  /** 収集フェーズで取得できなかった投稿の内訳 (理由別)。表示文言は PostFailureCounts 参照 */
  postFailures: PostFailureCounts;
  /** 収集フェーズで取得に失敗した投稿一覧ページ数 (欠落した投稿数は不明) */
  failedPageCount: number;
  /** ZIP フェーズでの対象単位の最終失敗数。カバー画像含み、中断由来は含まない (DownloadZipResult.failedFileCount) */
  failedFileCount: number;
  /** 収集フェーズが再試行の上限で打ち切られた場合、その理由 */
  stoppedReason?: 'rate-limit-exhausted' | 'transport-exhausted';
  /**
   * 履歴を根拠に `post.info` を省いた投稿数 (Issue #56)。
   *
   * 失敗ではないので見出しの判定には使わない。省いた投稿が ZIP に無い理由を書くためだけに持つ。
   */
  skippedByHistoryCount?: number;
  /**
   * 差分ダウンロードの履歴の更新に失敗した理由 (Issue #56)。成功または記録対象外なら null。
   *
   * ZIP は保存できているので見出しは変えない。次回の差分判定がこの回を知らないという
   * 事実だけを本文に足す (黙って落とすと、利用者は次回に全件取り直す理由が分からない)。
   */
  historyError?: string | null;
};

/**
 * 収集・ZIP 両フェーズの失敗を、理由ごとに独立した行として列挙する (Issue #14)。
 *
 * 従来は 1 文に "と" で連結し、まとめて「支援プランの範囲外か、FANBOX のレート制限の
 * 可能性があります」という理由を付けていたが、これは理由を混ぜて断定していた。
 * 観測できた事実 (どの段階の何件が失敗したか) と理由の推測を、カテゴリごとに分けて出す。
 */
function buildFailureLines(params: CompleteMessageParams): string[] {
  const lines: string[] = [];
  if (params.postFailures.unavailable > 0) {
    lines.push(
      `本文を利用できなかった投稿: ${params.postFailures.unavailable} 件 (閲覧権限または支援プランの範囲外など)`,
    );
  }
  if (params.postFailures.unsupported > 0) {
    lines.push(`未対応の本文形式: ${params.postFailures.unsupported} 件 (拡張機能の更新が必要な可能性があります)`);
  }
  if (params.postFailures.apiFailed > 0) {
    lines.push(`API 通信に失敗した投稿: ${params.postFailures.apiFailed} 件 (時間を置いて再試行してください)`);
  }
  if (params.failedPageCount > 0) {
    lines.push(`取得できなかった一覧ページ: ${params.failedPageCount} ページ (欠落した投稿数は不明)`);
  }
  if (params.failedFileCount > 0) {
    // ZIP フェーズのファイル欠落 (Issue #18) は Issue #14 の分類の対象外だが、
    // 表示形式を揃えるため同じ「理由ごとに独立した行」に合流させる。
    // failedFileCount はカバー画像・添付ファイルを合わせた「ファイル数」の集計
    // (DownloadZipResult.failedFileCount) であり投稿数ではないため、1 投稿から
    // 複数ファイルが失敗した場合と数が食い違わないよう「投稿」ではなく「ファイル」と表記する
    lines.push(
      `取得できなかったファイル: ${params.failedFileCount} 件 (カバー画像含む。時間を置いて再試行してください)`,
    );
  }
  return lines;
}

/**
 * 完了画面に表示するメッセージを組み立てる (Issue #18 第 1 段階、Issue #14 で拡張)。
 *
 * OverlayController.startCollecting から呼ばれる純粋関数として切り出している。DOM や
 * collect()/downloadAsZip() の実行を伴わずに、失敗件数の組み合わせごとの分岐をそのまま
 * ユニットテストできるようにするため。
 *
 * collect() は postFailures/failedPageCount があっても打ち切らず ZIP フェーズへ進むため、
 * 「aborted (ZIP フェーズの中断) なら収集フェーズの失敗は無い」という前提は成り立たない。
 * そのため収集フェーズ/ZIP フェーズの失敗の併記は aborted の有無に関わらず行う。
 *
 * 見出しの優先順位:
 * 1. addedPostCount === 0: NOTHING_SAVED_HEADLINE。ZIP を保存していない事実が最優先
 *    (addedPostCount === 0 かつ stoppedReason が同時に立つことは無い — collector.ts が
 *    その場合は打ち切りに変換せず例外にするため。念のため他の分岐より先に判定する)
 * 2. 収集フェーズの打ち切り (stoppedReason あり): 原因に応じた打ち切りの見出し。
 *    aborted かどうかに関わらず最優先 (非中断時と同じ見出し)。ZIP フェーズも中断していた場合は、
 *    その事実 (PARTIAL_DOWNLOAD_MESSAGE) を本文で併記する
 * 3. 単純な中断 (収集フェーズは打ち切りなく完了、ZIP フェーズのみ「ここまでで終了」): PARTIAL_DOWNLOAD_MESSAGE
 * 4. 収集フェーズ (postFailures/failedPageCount) または ZIP フェーズ (failedFileCount) の
 *    いずれかに欠落があれば: PARTIAL_FILE_FAILURE_HEADLINE (buildFailureLines が 1 行でも
 *    出力される場合と同値。本文の詳細行と見出しが矛盾しないようにする)
 * 5. 何も無ければ COMPLETE_HEADLINE
 *
 * 「未対応のレスポンス形式のため中断しました」(UNSUPPORTED_RESPONSE_HEADLINE) はここには
 * 含まれない。collect() が例外を投げて CollectResult 自体を返さないケースなので、
 * OverlayController.startCollecting の catch から別経路で表示する。
 */
export function buildCompleteMessage(params: CompleteMessageParams): string {
  // 履歴の更新の失敗は「取得できなかった」ではないので、見出しの判定 (failureLines) には
  // 混ぜず、どの見出しになっても最後に足すだけにする。混ぜると、全部取得できているのに
  // 「一部取得できませんでした」と出る
  const historySuffix = params.historyError
    ? `\n保存済みの記録を更新できませんでした: ${params.historyError} (今回の保存分は次回の差分判定に反映されません)`
    : '';
  const skipped = params.skippedByHistoryCount ?? 0;
  // 省いた投稿は取りこぼしではないので、これも見出しの判定には混ぜない
  const skippedSuffix = skipped > 0 ? `\n前回保存済みのため取得を省いた投稿: ${skipped} 件` : '';
  return `${buildDownloadOutcome(params)}${skippedSuffix}${historySuffix}`;
}

function buildDownloadOutcome(params: CompleteMessageParams): string {
  const failureLines = buildFailureLines(params);
  const failedSuffix = failureLines.length ? `\n${failureLines.join('\n')}` : '';

  if (params.addedPostCount === 0) {
    // 全部が「前回保存済み」で省かれたなら、取りこぼしではなく更新が無かっただけである。
    // NOTHING_SAVED_HEADLINE のままだと、差分が無いことを失敗のように読ませてしまう
    if ((params.skippedByHistoryCount ?? 0) > 0 && failureLines.length === 0) {
      return ALREADY_SAVED_HEADLINE;
    }
    return `${NOTHING_SAVED_HEADLINE}${failedSuffix}`;
  }
  if (params.stoppedReason) {
    const abortedNote = params.aborted ? `\n${PARTIAL_DOWNLOAD_MESSAGE}` : '';
    // 原因で文言を分ける。レート制限なら時間を置けばよいが、通信の失敗は環境側を確認する必要がある
    const headline =
      params.stoppedReason === 'rate-limit-exhausted' ? RATE_LIMIT_EXHAUSTED_HEADLINE : TRANSPORT_EXHAUSTED_HEADLINE;
    return `${headline}${abortedNote}${failedSuffix}`;
  }
  if (params.aborted) {
    return `${PARTIAL_DOWNLOAD_MESSAGE}${failedSuffix}`;
  }
  // 収集フェーズ・ZIP フェーズのいずれかに欠落があれば PARTIAL_FILE_FAILURE_HEADLINE にする。
  // failureLines は buildFailureLines が同じ 5 分類 (unavailable/unsupported/apiFailed/
  // failedPageCount/failedFileCount) を見て組み立てるため、判定をそこに合わせておくことで
  // 「本文には欠落の行があるのに見出しは完了扱い」という矛盾を防ぐ
  const headline = failureLines.length > 0 ? PARTIAL_FILE_FAILURE_HEADLINE : COMPLETE_HEADLINE;
  return `${headline}${failedSuffix}`;
}

/**
 * 保存先のファイル名。
 *
 * 共有層の `FileSystemFileHandle` は `createWritable()` しか宣言していないので、実際の
 * `name` は型に出てこない。利用者は picker で名前を変えられるため、こちらが渡した
 * 既定の名前で代用すると事実と食い違う。読めたときだけ使い、読めなければ既定へ倒す。
 */
function zipNameOf(handle: FileSystemFileHandle, fallbackBaseName: string): string {
  const name = (handle as { name?: unknown }).name;
  return typeof name === 'string' && name !== '' ? name : `${fallbackBaseName}.zip`;
}

/**
 * 差分ダウンロードの履歴を記録する (Issue #56)。失敗したらその理由を返す。
 *
 * **中断で終わった実行は記録しない。** 書けたと確認できていないものを保存済みとして扱わない。
 * `downloadZip` は中断されても ZIP を閉じて正常に戻るので、ここで見ないと途中までの結果を
 * 保存実績にしてしまう。
 *
 * 記録の失敗は ZIP の失敗ではないので例外にせず、完了画面に併記するための文言を返す。
 */
/**
 * 収集で分かったこと (観測カタログと走査実績) を記録する (Issue #56)。失敗したらその理由を返す。
 *
 * ZIP を作るかに関わらず送る。理由は `buildObservationUpdate` の JSDoc を参照。
 */
export async function recordObservation(creatorId: string, result: CollectResult): Promise<string | null> {
  try {
    const response = await applyCreatorHistory(buildObservationUpdate(creatorId, result));
    return response.ok ? null : (response.error ?? '不明な理由');
  } catch (e) {
    console.error('収集結果の記録に失敗:', e);
    return e instanceof Error ? e.message : String(e);
  }
}

export async function recordHistory(
  ctx: Pick<ReviewContext, 'creatorId' | 'result'>,
  manifest: DownloadManifest,
  zip: DownloadZipResult,
  zipName: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted || zip.aborted) return null;
  try {
    const update = buildSaveUpdate(ctx.creatorId, ctx.result, manifest, zip.assets, zipName, Date.now());
    const response = await applyCreatorHistory(update);
    return response.ok ? null : (response.error ?? '不明な理由');
  } catch (e) {
    console.error('履歴の記録に失敗:', e);
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * review 画面 (収集完了からダウンロード対象の確定まで) が保持する状態 (Issue #55)。
 *
 * 収集結果 (`result`) は確定後も保持する。完了画面は収集フェーズの失敗件数も併記するため、
 * ZIP フェーズが終わった時点でも必要になる。
 */
/**
 * 検証を通ったダウンロード対象。
 *
 * `manifest` は保存実績を記録するときに `AssetKey` を引き当てるために持つ
 * (`DownloadZipResult.assets` は archive 名でしか結果を指さない)。
 * `preflight` が返した写しをそのまま使い、`json.manifest` を読み直さない — 検証を通った値と
 * 記録に使う値を別々に読むと、片方だけが差し替わる余地ができる。
 */
type PreparedDownload = {
  readonly json: DownloadJsonObj;
  readonly manifest: DownloadManifest;
};

type ReviewContext = {
  readonly creatorId: string;
  readonly result: CollectResult;
  readonly posts: PostSummary[];
  readonly extensionOptions: ExtensionOption[];
  readonly selection: ReviewSelection;
  /** 投稿リストの検索語 */
  query: string;
  /**
   * 選択から導出済みかつ検証済みのダウンロード対象。導出が終わっていなければ null。
   *
   * 確定ボタンのハンドラで導出すると、`showSaveFilePicker` を呼ぶまでに重い処理を挟むことになる。
   * ユーザアクティベーションは時間で失効するので、選択が変わるたびに先に済ませておき、
   * ハンドラは読むだけにする。
   */
  prepared: PreparedDownload | null;
  /**
   * 収集時の観測 (カタログと走査実績) の記録に失敗した理由 (Issue #56)。成功なら null。
   *
   * 完了画面まで持ち越す。ここで落とすと、保存実績だけが記録されてカタログが古いまま残り、
   * 次回また全件を取得することになる理由が利用者に伝わらない。
   */
  observationError: string | null;
  /** 導出待ちのタイマー。連続した操作で導出が何度も走るのを 1 回にまとめる */
  prepareTimer: ReturnType<typeof setTimeout> | null;
  /** review 画面に表示するエラー。選択状態は保ったまま出す */
  errorMessage: string | null;
};

export class OverlayController {
  private state: OverlayState = 'settings';
  /** 読み込み済みの差分ダウンロードの履歴 (Issue #56)。未読または無ければ null */
  private history: CreatorHistory | null = null;
  /** 履歴の読み込みの世代。遅れて解決した読み込みが新しい画面を書き換えないようにする */
  private historyGeneration = 0;
  /**
   * 削除の応答を待っている creator。
   *
   * 削除の途中で始まった読み込みは、まだ消える前の storage を読む。世代だけで守ると、
   * パネルを閉じて開き直したときに新しい世代の読み込みが旧履歴を戻してしまう。
   */
  private readonly deletingCreators = new Set<string>();
  /**
   * 進行中の履歴の読み込み。収集を始める前にこれを待つ。
   *
   * 待たずに始めると、読み込みが終わる前に押された収集が履歴なしで走る。差分にならないだけでなく
   * **凍結名も使われない**ので、タイトルやアセット名が変わっていれば archive 名が付け替わる。
   */
  private historyLoad: Promise<void> = Promise.resolve();
  /** 履歴を一度でも読み終えたか。設定画面の表示を「確認中」と分けるために持つ */
  private historyLoaded = false;
  /**
   * 収集フェーズ用と ZIP フェーズ用で AbortController を分ける (Issue #55)。
   *
   * 選択の確定を待つ区間 (review) を 1 つの controller で覆うと、「キャンセル」の意味が
   * 段階ごとに変わってしまう。収集用は collect() が返った時点で役目を終え、ZIP 用は
   * 確定時に新しく作る。
   */
  private collectAbort: AbortController | null = null;
  private downloadAbort: AbortController | null = null;
  /**
   * ZIP フェーズの実行世代。
   *
   * `AbortController` は確定の後 (`startDownloading`) に作られるので、確定の時点で確保する
   * 保存先ハンドルからは参照できない。ZIP の書き込みは中断されても最後まで走るため、
   * パネルを閉じて別の収集を始めた後に旧実行の書き込み完了が届きうる。その時点で「まだ現行か」を
   * 判定できるよう、確定時に採番して以降の判定に使う。
   */
  private downloadRunId = 0;
  private review: ReviewContext | null = null;
  private beforeUnload: ((e: BeforeUnloadEvent) => void) | null = null;
  private shadowRoot: ShadowRoot;
  private panelEl: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private pageType: PageType = null;

  constructor(hostEl: HTMLElement) {
    this.shadowRoot = hostEl.attachShadow({ mode: SHADOW_ROOT_MODE });
    const style = document.createElement('style');
    style.textContent = css;
    this.shadowRoot.appendChild(style);
  }

  getState(): OverlayState {
    return this.state;
  }

  private setState(state: OverlayState) {
    assertAllowedTransitionForTest(this.state, state, OVERLAY_TRANSITIONS[this.state]);
    this.state = state;
    publishTestState({ 'overlay-state': state });
  }

  /**
   * signal がまだ「現行の」実行のものかを返す。
   *
   * startCollecting / startDownloading は連続で呼ばれ得る (キャンセル直後に再度開始する等)。
   * この時、旧実行の非同期処理 (collect / downloadAsZip 内の Promise) が abort による reject で
   * 遅れて解決すると、旧実行のクロージャが持つ signal はまだ aborted のままだが、controller は
   * 既に新しい実行のものに差し替わっている。
   *
   * **画面の更新も観測状態の publish も、これを確かめてから行う。** 判定を後回しにすると、
   * 旧実行の集計やエラー表示が新実行のものを上書きする。
   * @param signal 判定対象の signal
   */
  private isCurrentCollect(signal: AbortSignal): boolean {
    return signal === this.collectAbort?.signal;
  }

  /** signal がまだ現行の ZIP フェーズのものかを返す。判定の理由は isCurrentCollect を参照 */
  private isCurrentDownload(signal: AbortSignal): boolean {
    return signal === this.downloadAbort?.signal;
  }

  /**
   * 収集結果を失う遷移 (リロード・ページ遷移) を警告する。
   *
   * 収集の開始から完了画面までの全区間で維持する。review 画面で失われるのも実害は同じで、
   * 選択に時間をかけている間ほど失うものが大きい (Issue #55 の要検討事項をここで決めている)。
   */
  private guardUnload() {
    if (this.beforeUnload) return;
    this.beforeUnload = (e: BeforeUnloadEvent) => {
      e.returnValue = 'downloading';
    };
    window.addEventListener('beforeunload', this.beforeUnload);
  }

  private releaseUnloadGuard() {
    if (!this.beforeUnload) return;
    window.removeEventListener('beforeunload', this.beforeUnload);
    this.beforeUnload = null;
  }

  setPageType(pageType: PageType) {
    // SPA 遷移で creator が変わったら、読み込み済みの履歴も進行中の読み込みも捨てる。
    // 残すと別の creator の保存実績を根拠に post.info を省きうる (Issue #56)
    if (pageType?.creatorId !== this.pageType?.creatorId) {
      this.history = null;
      this.historyLoaded = false;
      this.historyGeneration++;
    }
    this.pageType = pageType;
  }

  showPanel() {
    this.setState('settings');
    this.renderPanel();
    // 履歴の読み出しは storage への往復なので、画面を出してから追いつかせる。
    // 待ってから描画すると、パネルが開くまでに間が空く
    this.historyLoad = this.loadHistory();
  }

  /**
   * 差分ダウンロードの履歴を読み込み、設定画面に反映する (Issue #56)。
   *
   * 読めなければ履歴が無いものとして扱う (`readCreatorHistory` が null に倒す)。
   * 読み込み中に画面が変わっていたら描画しない。
   */
  private async loadHistory() {
    const creatorId = this.pageType?.creatorId;
    if (creatorId === undefined) {
      this.historyLoaded = true;
      return;
    }
    this.historyLoaded = false;
    const generation = ++this.historyGeneration;
    const history = await readCreatorHistory(creatorId);
    // 世代だけでなく creator も突き合わせる。世代を上げずに creator が戻ってくる経路
    // (A → B → A) では世代の一致だけでは足りない
    if (this.historyGeneration !== generation || this.pageType?.creatorId !== creatorId) return;
    // 削除の応答を待っている間に読んだ値は、消える前の storage のものである
    if (this.deletingCreators.has(creatorId)) return;
    this.history = history;
    this.historyLoaded = true;
    if (this.state === 'settings') this.renderHistoryRow();
  }

  hidePanel() {
    // 進行中の ZIP フェーズはここで無効になる。以降その実行が届けても状態を触らせない
    this.downloadRunId++;
    this.collectAbort?.abort();
    this.collectAbort = null;
    this.downloadAbort?.abort();
    this.downloadAbort = null;
    this.discardReview();
    this.releaseUnloadGuard();
    if (this.backdropEl) {
      this.backdropEl.remove();
      this.backdropEl = null;
      this.panelEl = null;
    }
    this.setState('settings');
  }

  /** review 状態を破棄する。導出待ちのタイマーが残ると、既に閉じた画面に向けて publish が走る */
  private discardReview() {
    this.cancelPreparation();
    this.review = null;
  }

  private cancelPreparation() {
    const timer = this.review?.prepareTimer;
    if (timer === null || timer === undefined) return;
    clearTimeout(timer);
    if (this.review) this.review.prepareTimer = null;
  }

  private renderPanel() {
    this.hidePanel();
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && this.state === 'settings') {
        this.hidePanel();
      }
    });

    const panel = document.createElement('div');
    panel.className = 'overlay-panel';
    backdrop.appendChild(panel);
    this.shadowRoot.appendChild(backdrop);
    this.backdropEl = backdrop;
    this.panelEl = panel;
    this.renderSettings();
  }

  private renderSettings() {
    if (!this.panelEl || !this.pageType) return;
    const isCreator = this.pageType.type === 'creator';
    this.panelEl.className = 'overlay-panel';
    this.panelEl.innerHTML = '';

    const h2 = document.createElement('h2');
    h2.textContent = 'FANBOX Downloader';
    this.panelEl.appendChild(h2);

    const desc = document.createElement('p');
    desc.textContent = isCreator
      ? `@${this.pageType.creatorId} の全投稿を収集`
      : `投稿 #${this.pageType.type === 'post' ? this.pageType.postId : ''} を収集`;
    this.panelEl.appendChild(desc);

    let ignoreFreeCheckbox: HTMLInputElement | undefined;
    let limitInput: HTMLInputElement | undefined;
    let intervalInput: HTMLInputElement | undefined;

    if (isCreator) {
      const freeLabel = document.createElement('label');
      ignoreFreeCheckbox = document.createElement('input');
      ignoreFreeCheckbox.type = 'checkbox';
      freeLabel.appendChild(ignoreFreeCheckbox);
      freeLabel.appendChild(document.createTextNode('無料コンテンツを除外'));
      this.panelEl.appendChild(freeLabel);

      const limitRow = document.createElement('div');
      limitRow.className = 'setting-row';
      const limitLabel = document.createElement('span');
      limitLabel.textContent = '取得件数上限:';
      limitInput = document.createElement('input');
      limitInput.type = 'number';
      limitInput.min = '0';
      limitInput.placeholder = '無制限';
      limitRow.appendChild(limitLabel);
      limitRow.appendChild(limitInput);
      this.panelEl.appendChild(limitRow);

      const intervalRow = document.createElement('div');
      intervalRow.className = 'setting-row';
      const intervalLabel = document.createElement('span');
      intervalLabel.textContent = 'API 間隔(ms):';
      intervalInput = document.createElement('input');
      intervalInput.type = 'number';
      intervalInput.min = '100';
      intervalInput.max = '2000';
      intervalInput.step = '50';
      intervalInput.value = '500';
      intervalRow.appendChild(intervalLabel);
      intervalRow.appendChild(intervalInput);
      this.panelEl.appendChild(intervalRow);
    }

    // 履歴の行は読み込みが済んでから埋める。ここでは器だけ置く
    const historyRow = document.createElement('div');
    historyRow.className = 'setting-row';
    historyRow.id = 'history-row';
    this.panelEl.appendChild(historyRow);
    this.renderHistoryRow();

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const collectBtn = document.createElement('button');
    collectBtn.className = 'btn-primary';
    // 保存先の確保はここではなく review 画面の確定時に行うので、この操作は収集までしか進めない
    collectBtn.textContent = '投稿を収集';
    collectBtn.addEventListener('click', () => {
      if (!this.pageType) return;
      const settings: CollectorSettings = {
        isIgnoreFree: ignoreFreeCheckbox?.checked ?? false,
        limit: limitInput?.value ? Number.parseInt(limitInput.value, 10) : null,
        apiIntervalMs: intervalInput?.value ? Number.parseInt(intervalInput.value, 10) : null,
      };
      const ignoreHistory =
        (this.shadowRoot.getElementById('history-ignore') as HTMLInputElement | null)?.checked ?? false;
      this.startCollecting(settings, ignoreHistory);
    });
    btnRow.appendChild(collectBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = '閉じる';
    cancelBtn.addEventListener('click', () => this.hidePanel());
    btnRow.appendChild(cancelBtn);

    this.panelEl.appendChild(btnRow);
  }

  /**
   * 設定画面の履歴の行を描く (Issue #56)。
   *
   * **表示は「取得済み」ではなく「前回保存済み」とする。** 拡張が主張できるのは
   * 「この拡張が日時 X の ZIP 生成で当該エントリの書き込み完了を確認した」までで、
   * その ZIP が今も存在するとは主張できない。
   */
  private renderHistoryRow() {
    const row = this.shadowRoot.getElementById('history-row');
    if (!row) return;
    row.innerHTML = '';
    if (!this.historyLoaded) {
      row.textContent = '前回保存済みの記録を確認中...';
      return;
    }
    const savedCount = this.history?.saved.length ?? 0;
    if (savedCount === 0) {
      row.textContent = '前回保存済みの記録はありません (全件を取得します)';
      return;
    }

    const summary = document.createElement('span');
    summary.textContent = `前回保存済み: ${savedCount} 投稿`;
    row.appendChild(summary);

    const ignoreLabel = document.createElement('label');
    const ignoreBox = document.createElement('input');
    ignoreBox.type = 'checkbox';
    ignoreBox.id = 'history-ignore';
    ignoreLabel.appendChild(ignoreBox);
    // 「履歴を無視して全件を取得する」と「既存の履歴を含めて再保存する」は、収集から見れば
    // 同じ操作である (どちらも全件を取得し、その結果で記録を更新する)
    ignoreLabel.appendChild(document.createTextNode('前回保存分も取得する'));
    row.appendChild(ignoreLabel);

    const forgetBtn = document.createElement('button');
    forgetBtn.className = 'btn-secondary';
    forgetBtn.id = 'history-forget';
    forgetBtn.textContent = '記録を削除';
    forgetBtn.addEventListener('click', () => void this.forgetHistory(forgetBtn));
    row.appendChild(forgetBtn);
  }

  /**
   * この creator の履歴を消す (Issue #56 の利用者の操作)。
   *
   * 消してよいかは利用者に確かめる。消すと次回は全件を取得することになるので、
   * 誤操作の代償が通信量と待ち時間になる。
   */
  private async forgetHistory(button: HTMLButtonElement) {
    const creatorId = this.pageType?.creatorId;
    if (creatorId === undefined) return;
    if (!confirm(`@${creatorId} の保存済みの記録を削除しますか (次回は全件を取得します)`)) return;
    button.disabled = true;
    // 進行中の読み込みを無効にしてから消す。無効にしないと、削除の前に始まった読み込みが
    // 後から解決して、消したはずの履歴をメモリ上へ戻す (その履歴で post.info を省きうる)
    const generation = ++this.historyGeneration;
    // 応答を待つ間に収集を始められるので、メモリ上の履歴もここで落とす。落とさないと
    // 「削除したつもり」の履歴を根拠に post.info が省かれる
    const previous = this.history;
    this.history = null;
    this.deletingCreators.add(creatorId);
    let response: HistoryResponse;
    try {
      response = await removeCreatorHistory(creatorId);
    } finally {
      this.deletingCreators.delete(creatorId);
    }
    // 削除を待つ間に別の creator へ移っていたら、こちらの状態には触らない
    if (this.pageType?.creatorId !== creatorId) return;
    if (!response.ok) {
      if (this.historyGeneration === generation) {
        // 消せていないので元に戻す。戻さないと、履歴があるのに全件取得になる
        this.history = previous;
      } else {
        // 世代が進んでいる = この削除の間に読み込みが走っており、その結果は
        // `deletingCreators` で捨てられている。放っておくと storage には履歴があるのに
        // 画面もメモリも「履歴なし」のままになるので、読み直す
        this.historyLoad = this.loadHistory();
      }
      if (this.state === 'settings') {
        button.disabled = false;
        button.textContent = `削除できません: ${response.error ?? '不明な理由'}`;
      }
      return;
    }
    // 消えたことは世代に依らない事実なので、世代が進んでいてもメモリ上の履歴は落とす。
    // 落とさないと、削除中に読んだ旧履歴を根拠に post.info を省きうる
    this.history = null;
    if (this.state === 'settings') this.renderHistoryRow();
  }

  private renderCollecting() {
    if (!this.panelEl) return;
    this.panelEl.className = 'overlay-panel';
    this.panelEl.innerHTML = '';

    const h2 = document.createElement('h2');
    h2.textContent = '投稿情報を収集中...';
    this.panelEl.appendChild(h2);

    const progressText = document.createElement('p');
    progressText.className = 'progress-text';
    progressText.id = 'collect-progress';
    progressText.textContent = '準備中...';
    this.panelEl.appendChild(progressText);

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', () => {
      this.collectAbort?.abort();
      this.hidePanel();
    });
    btnRow.appendChild(cancelBtn);
    this.panelEl.appendChild(btnRow);
  }

  /**
   * review 画面を組み立てる (Issue #55)。
   *
   * 選択の SoT は `ReviewContext.selection` であり、チェックボックスの状態ではない。
   * 検索や再描画でチェックボックスの要素は入れ替わるため、DOM を SoT にすると絞り込みの
   * 操作だけで選択が変わってしまう。
   */
  private renderReview() {
    const ctx = this.review;
    if (!this.panelEl || !ctx) return;
    this.panelEl.className = 'overlay-panel overlay-panel-wide';
    this.panelEl.innerHTML = '';

    const h2 = document.createElement('h2');
    h2.textContent = 'ダウンロード対象を選択';
    this.panelEl.appendChild(h2);

    const counts = document.createElement('p');
    counts.className = 'review-counts';
    counts.id = 'review-counts';
    this.panelEl.appendChild(counts);

    const size = document.createElement('p');
    size.className = 'progress-text';
    size.id = 'review-size';
    this.panelEl.appendChild(size);

    // 省いた投稿が一覧に出てこない理由を書く。書かないと「取りこぼした」ように見える
    const skipped = ctx.result.skippedByHistoryPostIds.size;
    if (skipped > 0) {
      const skippedText = document.createElement('p');
      skippedText.className = 'progress-text';
      skippedText.textContent = `前回保存済みのため取得を省いた投稿: ${skipped} 件 (この ZIP には含まれません)`;
      this.panelEl.appendChild(skippedText);
    }

    const error = document.createElement('p');
    error.className = 'review-error';
    error.id = 'review-error';
    error.hidden = true;
    this.panelEl.appendChild(error);

    this.panelEl.appendChild(this.buildExtensionSection(ctx));
    this.panelEl.appendChild(this.buildPostSection(ctx));

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-primary';
    confirmBtn.id = 'review-confirm';
    confirmBtn.textContent = 'ダウンロード開始';
    confirmBtn.addEventListener('click', () => this.confirmReview(confirmBtn));
    btnRow.appendChild(confirmBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = '閉じる';
    cancelBtn.addEventListener('click', () => this.hidePanel());
    btnRow.appendChild(cancelBtn);
    this.panelEl.appendChild(btnRow);

    this.renderPostList();
    // 初期選択に対する導出もここから始める。ハンドラが読むだけで済む状態を最初から作る
    this.onSelectionChanged();
  }

  /** 拡張子とカバーの選択欄を組み立てる */
  private buildExtensionSection(ctx: ReviewContext): HTMLElement {
    const section = document.createElement('section');
    section.className = 'review-section';

    const heading = document.createElement('h3');
    heading.textContent = '添付の拡張子';
    section.appendChild(heading);

    const note = document.createElement('p');
    note.className = 'review-note';
    // 「.pdf のみ」と読ませない。拡張子の指定は投稿の添付にしか効かず、カバーは別枠で決まる
    note.textContent = '拡張子の指定は投稿の添付にだけ効きます。カバー画像は下のトグルで別に選びます。';
    section.appendChild(note);

    const list = document.createElement('div');
    list.className = 'review-chip-list';
    for (const option of ctx.extensionOptions) {
      const label = document.createElement('label');
      label.className = 'review-chip';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = ctx.selection.extensions.has(option.extension);
      box.addEventListener('change', () => {
        if (box.checked) {
          ctx.selection.extensions.add(option.extension);
        } else {
          ctx.selection.extensions.delete(option.extension);
        }
        this.onSelectionChanged();
      });
      label.appendChild(box);
      label.appendChild(
        document.createTextNode(
          ` ${option.extension === '' ? NO_EXTENSION_LABEL : option.extension} (${option.fileCount})`,
        ),
      );
      list.appendChild(label);
    }
    if (ctx.extensionOptions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'progress-text';
      empty.textContent = '添付を持つ投稿がありません';
      list.appendChild(empty);
    }
    section.appendChild(list);

    const coverLabel = document.createElement('label');
    const coverBox = document.createElement('input');
    coverBox.type = 'checkbox';
    coverBox.id = 'review-cover';
    coverBox.checked = ctx.selection.includeCover;
    coverBox.addEventListener('change', () => {
      ctx.selection.includeCover = coverBox.checked;
      this.onSelectionChanged();
    });
    coverLabel.appendChild(coverBox);
    coverLabel.appendChild(document.createTextNode('カバー画像を含める'));
    section.appendChild(coverLabel);

    return section;
  }

  /** 投稿の検索・一括操作・一覧を組み立てる */
  private buildPostSection(ctx: ReviewContext): HTMLElement {
    const section = document.createElement('section');
    section.className = 'review-section';

    const heading = document.createElement('h3');
    heading.textContent = '投稿';
    section.appendChild(heading);

    const search = document.createElement('input');
    search.type = 'search';
    search.id = 'review-search';
    search.className = 'review-search';
    search.placeholder = '投稿タイトル / postId で絞り込み';
    search.addEventListener('input', () => {
      ctx.query = search.value;
      this.renderPostList();
    });
    section.appendChild(search);

    const actions = document.createElement('div');
    actions.className = 'review-actions';
    // 操作は 全選択 / 全解除 / 検索結果の選択 / 検索結果の解除 の 4 つに限る。
    // 「表示中」を対象にする操作は入れない (検索一致が描画上限を超えたとき、利用者が
    // どちらを指すのか判別できない)。反転も入れない
    actions.appendChild(
      this.buildActionButton('全選択', () => {
        for (const post of ctx.posts) ctx.selection.postIds.add(post.postId);
        this.renderPostList();
        this.onSelectionChanged();
      }),
    );
    actions.appendChild(
      this.buildActionButton('全解除', () => {
        ctx.selection.postIds.clear();
        this.renderPostList();
        this.onSelectionChanged();
      }),
    );
    const selectMatched = this.buildActionButton('検索結果をすべて選択', () => {
      for (const post of filterPosts(ctx.posts, ctx.query)) ctx.selection.postIds.add(post.postId);
      this.renderPostList();
      this.onSelectionChanged();
    });
    selectMatched.id = 'review-select-matched';
    actions.appendChild(selectMatched);
    const clearMatched = this.buildActionButton('検索結果をすべて解除', () => {
      for (const post of filterPosts(ctx.posts, ctx.query)) ctx.selection.postIds.delete(post.postId);
      this.renderPostList();
      this.onSelectionChanged();
    });
    clearMatched.id = 'review-clear-matched';
    actions.appendChild(clearMatched);
    section.appendChild(actions);

    const range = document.createElement('p');
    range.className = 'progress-text';
    range.id = 'review-range';
    section.appendChild(range);

    const list = document.createElement('ul');
    list.className = 'review-post-list';
    list.id = 'review-list';
    section.appendChild(list);

    return section;
  }

  private buildActionButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-link';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * 投稿一覧を描き直す。
   *
   * 描画は `POST_LIST_RENDER_LIMIT` 件までに抑えるが、選択は postId の集合に対して適用するので
   * 描画されていない投稿も一括操作の対象になる。上限は描画コストだけを抑えるものである。
   */
  private renderPostList() {
    const ctx = this.review;
    const list = this.shadowRoot.getElementById('review-list');
    const range = this.shadowRoot.getElementById('review-range');
    if (!ctx || !list) return;

    const matched = filterPosts(ctx.posts, ctx.query);
    const rendered = matched.slice(0, POST_LIST_RENDER_LIMIT);
    list.innerHTML = '';
    for (const post of rendered) {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = ctx.selection.postIds.has(post.postId);
      box.addEventListener('change', () => {
        if (box.checked) {
          ctx.selection.postIds.add(post.postId);
        } else {
          ctx.selection.postIds.delete(post.postId);
        }
        this.onSelectionChanged();
      });
      label.appendChild(box);
      const title = document.createElement('span');
      title.className = 'review-post-title';
      title.textContent = post.name;
      label.appendChild(title);
      const meta = document.createElement('span');
      meta.className = 'review-post-meta';
      meta.textContent = `#${post.postId} / 添付 ${post.files.length} 件${post.cover ? ' / カバーあり' : ''}`;
      label.appendChild(meta);
      item.appendChild(label);
      list.appendChild(item);
    }
    if (range) range.textContent = describeRenderedRange(matched.length, rendered.length);

    const hasQuery = ctx.query.trim() !== '';
    for (const id of ['review-select-matched', 'review-clear-matched']) {
      const button = this.shadowRoot.getElementById(id) as HTMLButtonElement | null;
      // 検索語が無いときは「検索結果」が全件と同義になり、全選択 / 全解除と区別が付かない
      if (button) button.disabled = !hasQuery;
    }
  }

  /**
   * 選択が変わったときの処理。
   *
   * 導出 (`project`) はここでは行わず、操作が止まってから走らせる。1000 投稿規模では
   * `project()` だけで 100 ms 近くかかるため、チェックのたびに走らせるとメインスレッドが
   * 目に見えて止まる。
   */
  private onSelectionChanged() {
    const ctx = this.review;
    if (!ctx) return;
    ctx.prepared = null;
    ctx.errorMessage = null;
    if (ctx.prepareTimer !== null) clearTimeout(ctx.prepareTimer);
    ctx.prepareTimer = setTimeout(() => {
      ctx.prepareTimer = null;
      this.prepareProjection(ctx);
    }, PROJECTION_DEBOUNCE_MS);
    this.refreshReviewSummary();
  }

  /**
   * 選択からダウンロード対象を導出し、ZIP 入力として受け付けられる形かまで確かめる。
   *
   * `showSaveFilePicker` は呼ぶだけで新規ファイルを作るため、導出や検証で落ちる可能性を
   * picker より前に潰しておく。ここで落ちた場合は確定ボタンを無効のままにする。
   * @param ctx 導出対象の review 状態
   */
  private prepareProjection(ctx: ReviewContext) {
    // 導出待ちの間にパネルが閉じられた、または再収集された場合は捨てる
    if (this.review !== ctx) return;
    try {
      const json = ctx.result.downloadObject.project(toSelection(ctx.selection));
      const { manifest } = preflightDownload(json);
      ctx.prepared = { json, manifest };
      ctx.errorMessage = null;
    } catch (e) {
      console.error('ダウンロード対象の導出に失敗:', e);
      ctx.prepared = null;
      ctx.errorMessage = `${PROJECTION_FAILED_MESSAGE}: ${e instanceof Error ? e.message : String(e)}`;
    }
    // 件数は選択が変わった時点で更新済みで、導出では変わらない。ここで数え直さない
    this.refreshConfirmState();
  }

  /** 件数とサイズを現在の選択に合わせる */
  private refreshReviewSummary() {
    const ctx = this.review;
    if (!ctx) return;
    const counts = countSelection(ctx.posts, ctx.selection);

    const countsEl = this.shadowRoot.getElementById('review-counts');
    if (countsEl) countsEl.textContent = describeSelectionCounts(counts);
    const sizeEl = this.shadowRoot.getElementById('review-size');
    if (sizeEl) sizeEl.textContent = describeSizeEstimate(counts);
    publishTestState({
      'selected-post-count': String(counts.postCount),
      'selected-file-count': String(counts.fileCount),
      'selected-cover-count': String(counts.coverCount),
    });
    this.refreshConfirmState();
  }

  /** エラー表示と確定ボタンの可否を更新する。件数の再集計を伴わない */
  private refreshConfirmState() {
    const ctx = this.review;
    if (!ctx) return;
    const errorEl = this.shadowRoot.getElementById('review-error');
    if (errorEl) {
      errorEl.textContent = ctx.errorMessage ?? '';
      errorEl.hidden = ctx.errorMessage === null;
    }
    const confirmBtn = this.shadowRoot.getElementById('review-confirm') as HTMLButtonElement | null;
    if (confirmBtn) {
      // 投稿が 0 件なら picker を出さない。押せてしまうと、書くものが無いのに新規ファイルだけ作る。
      // 収集済みの投稿から作った集合なので、要素があれば必ずどれかの投稿に対応する
      confirmBtn.disabled = ctx.selection.postIds.size === 0 || ctx.prepared === null;
    }
  }

  /**
   * review の確定。**`pickSaveHandle` より前に await も重い処理も置かないこと。**
   *
   * `showSaveFilePicker` はユーザアクティベーションが有効な間しか開けない。導出と検証は
   * `prepareProjection` が選択のたびに済ませてあるので、ここは読むだけで済む。
   * @param confirmBtn 二重操作を防ぐために無効化する確定ボタン
   */
  private confirmReview(confirmBtn: HTMLButtonElement) {
    const ctx = this.review;
    if (!ctx || ctx.prepared === null) return;
    const prepared = ctx.prepared;
    const runId = ++this.downloadRunId;
    confirmBtn.disabled = true;
    pickSaveHandle(ctx.creatorId, () => this.downloadRunId === runId)
      .then((handle) => {
        if (this.downloadRunId !== runId || this.review !== ctx) return;
        this.startDownloading(ctx, runId, prepared, handle);
      })
      .catch((e: unknown) => {
        if (this.downloadRunId !== runId || this.review !== ctx) return;
        // 失敗しても選択状態 (ctx.selection) には触れない。選び直せば同じ対象で再試行できる
        confirmBtn.disabled = false;
        const message = describePickerFailure(e);
        // 保存先の選択をやめただけなら、文言も出さずに review に留まる
        if (message === null) return;
        console.error('ファイル保存先の取得に失敗:', e);
        ctx.errorMessage = message;
        this.refreshConfirmState();
      });
  }

  private renderDownloading() {
    if (!this.panelEl) return;
    this.panelEl.className = 'overlay-panel';
    this.panelEl.innerHTML = '';

    const h2 = document.createElement('h2');
    h2.textContent = 'ダウンロード中...';
    this.panelEl.appendChild(h2);

    const progressSection = document.createElement('div');
    progressSection.className = 'progress-section';

    const track = document.createElement('div');
    track.className = 'progress-bar-track';
    const fill = document.createElement('div');
    fill.className = 'progress-bar-fill';
    fill.id = 'dl-progress-fill';
    track.appendChild(fill);
    progressSection.appendChild(track);

    const remain = document.createElement('p');
    remain.className = 'remain-time';
    remain.id = 'dl-remain';
    remain.textContent = '残りおよそ -:--';
    progressSection.appendChild(remain);

    this.panelEl.appendChild(progressSection);

    const logArea = document.createElement('textarea');
    logArea.className = 'log-area';
    logArea.id = 'dl-log';
    logArea.readOnly = true;
    this.panelEl.appendChild(logArea);

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn-secondary';
    stopBtn.textContent = 'ここまでで終了';
    stopBtn.addEventListener('click', () => {
      // 二重操作 (連打・非同期の停止処理中の再クリック) を防ぐため即座に無効化する。
      // hidePanel() はここでは呼ばない: 全破棄ではなく、downloadZip が閉じた
      // 部分保存の ZIP を活かして完了画面へ遷移させたいため (startDownloading 側で処理する)。
      stopBtn.disabled = true;
      this.downloadAbort?.abort();
    });
    btnRow.appendChild(stopBtn);
    this.panelEl.appendChild(btnRow);
  }

  private renderComplete(message: string) {
    if (!this.panelEl) return;
    this.panelEl.className = 'overlay-panel';
    this.panelEl.innerHTML = '';

    const h2 = document.createElement('h2');
    h2.textContent = '完了';
    this.panelEl.appendChild(h2);

    const result = document.createElement('p');
    result.className = 'result-text';
    result.textContent = message;
    this.panelEl.appendChild(result);

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-primary';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', () => this.hidePanel());
    btnRow.appendChild(closeBtn);
    this.panelEl.appendChild(btnRow);
  }

  /**
   * 完了画面へ遷移する。ここから先はページを離れても失うものが無いので unload の警告も外す。
   *
   * 収集結果も併せて捨てる。完了画面が使う値は呼び出し側で既に取り出してあり、保持し続けると
   * 大きいクリエイターでは投稿・アセット・導出結果を抱えたまま画面を閉じるまで解放されない。
   */
  private finish(message: string) {
    this.releaseUnloadGuard();
    this.discardReview();
    this.setState('complete');
    this.renderComplete(message);
  }

  private async startCollecting(settings: CollectorSettings, ignoreHistory = false) {
    if (!this.pageType) return;
    resetTestState();
    // 新しい収集を始めた時点で、前の ZIP フェーズの結果は観測状態に載せてはいけない
    this.downloadRunId++;
    // 前の収集が走ったままなら止める。止めずに差し替えると、旧実行の signal が aborted に
    // ならないまま進み、集計を publish して review を上書きしうる
    this.collectAbort?.abort();
    this.discardReview();
    this.setState('collecting');
    this.renderCollecting();
    this.collectAbort = new AbortController();
    const signal = this.collectAbort.signal;
    this.guardUnload();

    try {
      // 履歴の読み込みが終わるまで待つ。待たずに始めると、履歴なしで収集が走って
      // 凍結名が使われず archive 名が付け替わる。保存先の確保は review の確定時なので、
      // ここで待ってもユーザアクティベーションは失効しない
      await this.historyLoad;
      if (!this.isCurrentCollect(signal)) return;
      const creatorId = this.pageType.creatorId;
      const postId = this.pageType.type === 'post' ? this.pageType.postId : undefined;

      const result = await collect(
        creatorId,
        postId,
        settings,
        (current, total) => {
          // await の後の判定ではコールバックに間に合わない。旧実行の進捗が新実行の画面を
          // 塗り替えないよう、呼び出しごとに現行かを見る
          if (!this.isCurrentCollect(signal)) return;
          const el = this.shadowRoot.getElementById('collect-progress');
          if (el) el.textContent = `投稿情報を収集中... (${current}/${total})`;
        },
        signal,
        historyForCollect(this.history, creatorId),
        // 「前回保存分も取得する」は省略だけを止める。凍結名は据え置く
        !ignoreHistory,
      );

      // 状態に触る前に現行かを見る (ZIP フェーズと同じ順序)
      if (!this.isCurrentCollect(signal)) return;
      if (signal.aborted) {
        publishTestState({ aborted: '1' });
        return;
      }

      // 収集で分かったことは ZIP を作るかに関わらず記録する。全件が省かれた回は ZIP を
      // 作らないので、ここで書かないと走査実績と最終利用時刻がその回だけ残らない
      const observationError = await recordObservation(creatorId, result);
      if (!this.isCurrentCollect(signal)) return;

      publishTestState({
        'added-post-count': String(result.addedPostCount),
        'unavailable-post-count': String(result.postFailures.unavailable),
        'unsupported-post-count': String(result.postFailures.unsupported),
        'api-failed-post-count': String(result.postFailures.apiFailed),
        'failed-page-count': String(result.failedPageCount),
        ...(result.stoppedReason ? { 'stopped-reason': result.stoppedReason } : {}),
      });

      if (result.addedPostCount === 0) {
        // 登録できた投稿が無いので review へ進まず、ZIP も保存しない (Issue #14)。
        // 保存先の確保は review の確定時に初めて行うので、0 バイトのファイルも作られない
        // (Issue #55 でこの経路の「空ファイルが残る」問題は解消した)
        this.finish(
          buildCompleteMessage({
            aborted: false,
            addedPostCount: result.addedPostCount,
            postFailures: result.postFailures,
            failedPageCount: result.failedPageCount,
            failedFileCount: 0,
            skippedByHistoryCount: result.skippedByHistoryPostIds.size,
            historyError: observationError,
          }),
        );
        return;
      }

      this.enterReview(creatorId, result, observationError);
    } catch (e) {
      // hidePanel() や新しい収集が既に走っているなら、旧実行はここで降りる。
      // エラー表示も publish も新実行のものを上書きしてしまう
      if (!this.isCurrentCollect(signal)) return;
      if (signal.aborted) {
        publishTestState({ aborted: '1' });
        // 収集中のキャンセルは renderCollecting() のボタンが hidePanel() を伴うため、
        // 上の判定で弾かれてここには来ない。到達したなら契約違反なので素直にエラーを出す
        console.error('収集エラー (中断中の契約違反):', e);
        publishTestState({ error: '1' });
        this.finish(`エラーが発生しました: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (isUnsupportedResponseError(e)) {
        // 未対応のレスポンス形式による中断 (Issue #14。内訳は isUnsupportedResponseError 参照)。
        // review へ進まないので保存先も確保せず、ZIP も空ファイルも残らない
        console.error('収集を中断しました (未対応のレスポンス形式):', e);
        publishTestState({ 'unsupported-response': '1' });
        this.finish(UNSUPPORTED_RESPONSE_HEADLINE);
        return;
      }
      console.error('収集エラー:', e);
      publishTestState({ error: '1' });
      this.finish(`エラーが発生しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // 無条件に null 化すると、旧実行が遅れて解決した際に新実行の controller を消してしまう
      if (this.isCurrentCollect(signal)) {
        this.collectAbort = null;
      }
    }
  }

  /** 収集結果を review 画面に載せる。収集用の controller はここで役目を終える */
  private enterReview(creatorId: string, result: CollectResult, observationError: string | null) {
    const posts = result.downloadObject.listPosts();
    this.review = {
      creatorId,
      result,
      posts,
      extensionOptions: listExtensionOptions(posts),
      selection: createInitialSelection(posts),
      query: '',
      prepared: null,
      prepareTimer: null,
      errorMessage: null,
      observationError,
    };
    this.setState('review');
    this.renderReview();
  }

  private async startDownloading(
    ctx: ReviewContext,
    runId: number,
    prepared: PreparedDownload,
    saveHandle: FileSystemFileHandle,
  ) {
    // 確定した時点で選択はもう変わらない。残った導出待ちを走らせても捨てるだけになる
    this.cancelPreparation();
    this.downloadAbort = new AbortController();
    const signal = this.downloadAbort.signal;
    this.setState('downloading');
    this.renderDownloading();
    const { addedPostCount, postFailures, failedPageCount, stoppedReason } = ctx.result;

    try {
      // コールバックは downloadZip の中から呼ばれるので、await の後の判定では間に合わない。
      // 旧実行の進捗が新実行の画面を塗り替えないよう、各呼び出しで現行かを見る
      const downloadProgress: DownloadProgress = {
        onProgress: (percent) => {
          if (this.downloadRunId !== runId) return;
          const fill = this.shadowRoot.getElementById('dl-progress-fill');
          if (fill) fill.style.width = `${percent}%`;
        },
        onLog: (message) => {
          if (this.downloadRunId !== runId) return;
          const logArea = this.shadowRoot.getElementById('dl-log') as HTMLTextAreaElement | null;
          if (logArea) {
            logArea.value += `${message}\n`;
            logArea.scrollTop = logArea.scrollHeight;
          }
        },
        onRemainTime: (time) => {
          if (this.downloadRunId !== runId) return;
          const el = this.shadowRoot.getElementById('dl-remain');
          if (el) el.textContent = `残りおよそ ${time}`;
        },
      };

      const { zip } = await downloadAsZip(
        saveHandle,
        prepared.json,
        downloadProgress,
        signal,
        () => this.downloadRunId === runId,
      );
      // 履歴の記録は現行かの判定より前に行う。ZIP を書けたという事実は、その実行が
      // 今の画面のものかどうかに依らない (Issue #56)
      const saveError = await recordHistory(ctx, prepared.manifest, zip, zipNameOf(saveHandle, ctx.creatorId), signal);
      // 収集時の観測の失敗も併せて出す。どちらが落ちても次回は差分にならないので、
      // 保存実績が書けたことだけを見て「記録は正常」と読ませない
      const historyError = ctx.observationError ?? saveError;
      // 状態を触る前に現行の実行かを見る。旧実行の遅延解決が新実行の画面と観測状態を
      // 上書きするのを防ぐ (中断してすぐ再実行したときに起こりうる)
      if (this.downloadRunId !== runId || !this.isCurrentDownload(signal)) return;
      // zip.failedFileCount はカバー画像を含む対象単位の最終失敗数 (中断由来は含まない)。
      // 試行単位の記録 (attempts) とは別物なので、完了画面には対象単位の集計だけを反映する
      publishTestState({ 'failed-file-count': String(zip.failedFileCount) });

      // downloadZip は中断されても ZIP を閉じて正常に戻るため、ここで見ないと
      // 途中までの ZIP を「完了しました」と表示してしまう。
      // ここまで残っている中断は「ここまでで終了」ボタンによるものだけである
      if (signal.aborted) publishTestState({ aborted: '1' });
      this.finish(
        buildCompleteMessage({
          aborted: signal.aborted,
          addedPostCount,
          postFailures,
          failedPageCount,
          failedFileCount: zip.failedFileCount,
          stoppedReason,
          skippedByHistoryCount: ctx.result.skippedByHistoryPostIds.size,
          historyError,
        }),
      );
    } catch (e) {
      if (this.downloadRunId !== runId || !this.isCurrentDownload(signal)) return;
      if (signal.aborted) {
        publishTestState({ aborted: '1' });
        // 「ここまでで終了」による中断中に例外が発生したケース。downloadZip の契約上
        // 中断は正常 return のはずだが、契約違反として素直にログを残しつつ、
        // 「ダウンロード中」画面のまま固まらせないよう通常のエラー表示に合流させる
        // (部分保存の保証はできないため「保存して終了しました」ではなく素直にエラーと伝える)。
        console.error('ダウンロードエラー (中断中の契約違反):', e);
      } else {
        console.error('ダウンロードエラー:', e);
      }
      publishTestState({ error: '1' });
      this.finish(`エラーが発生しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (this.isCurrentDownload(signal)) {
        this.downloadAbort = null;
      }
    }
  }
}
