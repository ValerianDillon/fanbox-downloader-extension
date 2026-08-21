import type { DownloadProgress, FileSystemFileHandle } from './downloader';
import { downloadAsZip, pickSaveHandle } from './downloader';
import { ApiShapeError, type PageType } from './fanbox/api';
import type { CollectorSettings, PostFailureCounts } from './fanbox/collector';
import { collect, PostBodyInvalidError } from './fanbox/collector';
import css from './overlay.css' with { type: 'text' };
import { publishTestState, resetTestState, SHADOW_ROOT_MODE } from './test-hooks';

export type OverlayState = 'settings' | 'collecting' | 'downloading' | 'complete';

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

/** 収集フェーズがレート制限で打ち切られた場合の完了画面の見出し */
export const RATE_LIMIT_EXHAUSTED_HEADLINE = 'レート制限のため途中で打ち切りました (取得できた分のみ保存しています)';
export const TRANSPORT_EXHAUSTED_HEADLINE = '通信に失敗したため途中で打ち切りました (取得できた分のみ保存しています)';

/**
 * addByPostInfo が 'added' を返した投稿が 0 件だった場合の完了画面の見出し (Issue #14)。
 *
 * この場合 ZIP を保存しない (startCollecting 側で downloadAsZip 自体を呼ばない)。
 * showSaveFilePicker は「ダウンロード開始」直後に既にハンドルを確保済み (ジェスチャー失効対策)
 * のため、ファイル自体は既に (0 バイトで) 作成されている。書き込みを一切行わないことで
 * その 0 バイトのまま残す。ハンドルからは新規作成か上書き対象の既存ファイルかを区別できず、
 * 無条件に削除すると利用者が残したいファイルを消しかねないため、削除は行わない
 * (Issue #17 の「showSaveFilePicker が返る前に空ファイルを作る」と同じ理由・同じ結論)。
 */
export const NOTHING_SAVED_HEADLINE = '保存できる投稿がなかったため ZIP を保存しませんでした';

/**
 * 収集が「未対応のレスポンス形式」(ApiShapeError または PostBodyInvalidError) で
 * 中断した場合の完了画面の見出し (Issue #14)。
 *
 * この場合 collect() が例外を投げるため CompleteMessageParams を経由せず、
 * OverlayController.startCollecting の catch から直接この見出しで complete 状態に遷移する。
 */
export const UNSUPPORTED_RESPONSE_HEADLINE = '未対応のレスポンス形式のため中断しました';

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
  const failureLines = buildFailureLines(params);
  const failedSuffix = failureLines.length ? `\n${failureLines.join('\n')}` : '';

  if (params.addedPostCount === 0) {
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

export class OverlayController {
  private state: OverlayState = 'settings';
  private abortController: AbortController | null = null;
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
    this.state = state;
    publishTestState({ 'overlay-state': state });
  }

  /**
   * signal がまだ「現行の」実行 (this.abortController) のものである場合に限り
   * data-fbdl-aborted を publish する。
   *
   * startCollecting は連続で呼ばれ得る (キャンセル直後に再度「ダウンロード開始」を押す等)。
   * この時、旧実行の非同期処理 (collect/downloadAsZip 内の Promise) が abort による reject
   * で遅れて解決すると、旧実行のクロージャが持つ signal はまだ aborted のままだが、
   * this.abortController は既に新しい実行のものに差し替わっている。
   * この判定なしに publish すると、旧実行の遅延 publish が新実行の状態を上書きしうる。
   */
  private publishAbortedIfCurrent(signal: AbortSignal) {
    if (signal === this.abortController?.signal) {
      publishTestState({ aborted: '1' });
    }
  }

  setPageType(pageType: PageType) {
    this.pageType = pageType;
  }

  showPanel() {
    this.setState('settings');
    this.renderPanel();
  }

  hidePanel() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.backdropEl) {
      this.backdropEl.remove();
      this.backdropEl = null;
      this.panelEl = null;
    }
    this.setState('settings');
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
    this.panelEl.innerHTML = '';

    const h2 = document.createElement('h2');
    h2.textContent = 'FANBOX Downloader';
    this.panelEl.appendChild(h2);

    const desc = document.createElement('p');
    desc.textContent = isCreator
      ? `@${this.pageType.creatorId} の全投稿をダウンロード`
      : `投稿 #${this.pageType.type === 'post' ? this.pageType.postId : ''} をダウンロード`;
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

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn-primary';
    dlBtn.textContent = 'ダウンロード開始';
    dlBtn.addEventListener('click', async () => {
      if (!this.pageType) return;
      const settings: CollectorSettings = {
        isIgnoreFree: ignoreFreeCheckbox?.checked ?? false,
        limit: limitInput?.value ? Number.parseInt(limitInput.value, 10) : null,
        apiIntervalMs: intervalInput?.value ? Number.parseInt(intervalInput.value, 10) : null,
      };
      // ジェスチャー有効中にファイル保存先を確保する
      // (収集に時間がかかると transient activation が失効するため)
      let handle: Awaited<ReturnType<typeof pickSaveHandle>>;
      try {
        handle = await pickSaveHandle(this.pageType.creatorId);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        console.error('ファイル保存先の取得に失敗:', e);
        return;
      }
      this.startCollecting(settings, handle);
    });
    btnRow.appendChild(dlBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = '閉じる';
    cancelBtn.addEventListener('click', () => this.hidePanel());
    btnRow.appendChild(cancelBtn);

    this.panelEl.appendChild(btnRow);
  }

  private renderCollecting() {
    if (!this.panelEl) return;
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
      this.abortController?.abort();
      this.hidePanel();
    });
    btnRow.appendChild(cancelBtn);
    this.panelEl.appendChild(btnRow);
  }

  private renderDownloading() {
    if (!this.panelEl) return;
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
      // 部分保存の ZIP を活かして完了画面へ遷移させたいため (startCollecting 側で処理する)。
      stopBtn.disabled = true;
      this.abortController?.abort();
    });
    btnRow.appendChild(stopBtn);
    this.panelEl.appendChild(btnRow);
  }

  private renderComplete(message: string) {
    if (!this.panelEl) return;
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

  private async startCollecting(settings: CollectorSettings, saveHandle: FileSystemFileHandle) {
    if (!this.pageType) return;
    resetTestState();
    this.setState('collecting');
    this.renderCollecting();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.returnValue = 'downloading';
    };
    window.addEventListener('beforeunload', beforeUnload);

    try {
      const creatorId = this.pageType.creatorId;
      const postId = this.pageType.type === 'post' ? this.pageType.postId : undefined;

      const { downloadObject, addedPostCount, postFailures, failedPageCount, stoppedReason } = await collect(
        creatorId,
        postId,
        settings,
        (current, total) => {
          const el = this.shadowRoot.getElementById('collect-progress');
          if (el) el.textContent = `投稿情報を収集中... (${current}/${total})`;
        },
        signal,
      );

      if (signal.aborted) {
        this.publishAbortedIfCurrent(signal);
        return;
      }

      publishTestState({
        'added-post-count': String(addedPostCount),
        'unavailable-post-count': String(postFailures.unavailable),
        'unsupported-post-count': String(postFailures.unsupported),
        'api-failed-post-count': String(postFailures.apiFailed),
        'failed-page-count': String(failedPageCount),
        ...(stoppedReason ? { 'stopped-reason': stoppedReason } : {}),
      });

      if (addedPostCount === 0) {
        // 登録できた投稿が無いので ZIP を保存しない (Issue #14)。saveHandle には触れない:
        // downloadAsZip を呼ばなければ writable を開かないので、書き込みは一切発生しない。
        // showSaveFilePicker が既に作成済みの 0 バイトファイルはそのまま残る
        // (削除できない理由は NOTHING_SAVED_HEADLINE のコメントを参照)。
        this.setState('complete');
        this.renderComplete(
          buildCompleteMessage({ aborted: false, addedPostCount, postFailures, failedPageCount, failedFileCount: 0 }),
        );
        return;
      }

      this.setState('downloading');
      this.renderDownloading();

      const downloadProgress: DownloadProgress = {
        onProgress: (percent) => {
          const fill = this.shadowRoot.getElementById('dl-progress-fill');
          if (fill) fill.style.width = `${percent}%`;
        },
        onLog: (message) => {
          const logArea = this.shadowRoot.getElementById('dl-log') as HTMLTextAreaElement | null;
          if (logArea) {
            logArea.value += `${message}\n`;
            logArea.scrollTop = logArea.scrollHeight;
          }
        },
        onRemainTime: (time) => {
          const el = this.shadowRoot.getElementById('dl-remain');
          if (el) el.textContent = `残りおよそ ${time}`;
        },
      };

      const json = downloadObject.stringify();
      const { zip } = await downloadAsZip(saveHandle, json, downloadProgress, signal);
      // zip.failedFileCount はカバー画像を含む対象単位の最終失敗数 (download-helper v4.4.0 が
      // 中断由来の欠落を除いて集計する)。試行単位の記録 (attempts) とは別物なので、
      // ここでは対象単位の集計のみを完了画面に反映する
      publishTestState({ 'failed-file-count': String(zip.failedFileCount) });

      // downloadZip は中断されても ZIP を閉じて正常に戻るため、ここで見ないと
      // 途中までの ZIP を「完了しました」と表示してしまう
      if (signal.aborted) {
        this.publishAbortedIfCurrent(signal);
        if (signal !== this.abortController?.signal) {
          // hidePanel() (パネルの再オープン等) が既に別経路で呼ばれ、UI は
          // settings にリセット済み。ここでは何もしない。
          return;
        }
        // ここまで残っているのは「ここまでで終了」ボタンによる中断のみ (収集中の
        // キャンセルは renderCollecting() のボタンが hidePanel() を伴って
        // 即座に全破棄するため、この分岐に到達する前に上の signal !== ... で弾かれる)。
        this.setState('complete');
        this.renderComplete(
          buildCompleteMessage({
            aborted: true,
            addedPostCount,
            postFailures,
            failedPageCount,
            failedFileCount: zip.failedFileCount,
            stoppedReason,
          }),
        );
        return;
      }

      this.setState('complete');
      this.renderComplete(
        buildCompleteMessage({
          aborted: false,
          addedPostCount,
          postFailures,
          failedPageCount,
          failedFileCount: zip.failedFileCount,
          stoppedReason,
        }),
      );
    } catch (e) {
      if (signal.aborted) {
        this.publishAbortedIfCurrent(signal);
        if (signal !== this.abortController?.signal) {
          // hidePanel() が既に別経路で UI をリセット済み (収集中のキャンセル等)。
          // ここでは何もしない。
          return;
        }
        // 「ここまでで終了」による中断中に例外が発生したケース。downloadZip の契約上
        // 中断は正常 return のはずだが、契約違反として素直にログを残しつつ、
        // 「ダウンロード中」画面のまま固まらせないよう通常のエラー表示に合流させる
        // (部分保存の保証はできないため「保存して終了しました」ではなく素直にエラーと伝える)。
        console.error('ダウンロードエラー (中断中の契約違反):', e);
        publishTestState({ error: '1' });
        this.setState('complete');
        this.renderComplete(`エラーが発生しました: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (e instanceof ApiShapeError || e instanceof PostBodyInvalidError) {
        // 未対応のレスポンス形式による中断 (Issue #14)。ApiShapeError は API 層
        // (fetchJson のレスポンス形状違反)、PostBodyInvalidError はライブラリ層
        // (addByPostInfo が読む本文フィールドの不一致) だが、どちらも「このバージョンでは
        // 安全に取り込めない仕様変更」を意味するため同じ見出しで扱う。
        // collect() が投稿を 1 件も返さないまま例外を投げるため、downloadAsZip は
        // 呼ばれておらず ZIP は保存されていない (NOTHING_SAVED_HEADLINE と同じ理由で、
        // showSaveFilePicker が作成済みの 0 バイトファイルはそのまま残る)。
        console.error('収集を中断しました (未対応のレスポンス形式):', e);
        publishTestState({ 'unsupported-response': '1' });
        this.setState('complete');
        this.renderComplete(UNSUPPORTED_RESPONSE_HEADLINE);
        return;
      }
      console.error('ダウンロードエラー:', e);
      publishTestState({ error: '1' });
      this.setState('complete');
      this.renderComplete(`エラーが発生しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.removeEventListener('beforeunload', beforeUnload);
      // 無条件に null化すると、旧実行が downloadAsZip (中断後の zip.close 含む) の
      // 完了を待っている間にパネルが再オープンされ新しい実行が始まった場合、旧実行の
      // finally が新実行の this.abortController を消してしまう競合が起きる。
      // そうなると新実行では「ここまでで終了」も hidePanel() のキャンセルも
      // abortController.abort() が発火せず効かなくなる。signal が現行の実行のもので
      // あるときに限って null にすることで、旧実行は新実行の controller に触れない。
      if (signal === this.abortController?.signal) {
        this.abortController = null;
      }
    }
  }
}
