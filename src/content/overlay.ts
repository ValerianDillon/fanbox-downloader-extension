import type { DownloadProgress, FileSystemFileHandle } from './downloader';
import { downloadAsZip, pickSaveHandle } from './downloader';
import type { PageType } from './fanbox/api';
import type { CollectorSettings } from './fanbox/collector';
import { collect } from './fanbox/collector';
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

/** ZIP フェーズでのファイル欠落 (カバー画像含む) があった、非中断の完了画面の見出し (Issue #18 第 1 段階) */
export const PARTIAL_FILE_FAILURE_HEADLINE = '一部取得できませんでした';

/** 収集フェーズがレート制限で打ち切られた場合の完了画面の見出し */
export const RATE_LIMIT_EXHAUSTED_HEADLINE = 'レート制限のため途中で打ち切りました (取得できた分のみ保存しています)';

export type CompleteMessageParams = {
  /** 「ここまでで終了」による中断か (content script 側の AbortSignal 由来) */
  aborted: boolean;
  /** 収集フェーズで取得に失敗した投稿数 (投稿単位) */
  failedPostCount: number;
  /** 収集フェーズで取得に失敗した投稿一覧ページ数 (欠落した投稿数は不明) */
  failedPageCount: number;
  /** ZIP フェーズでの対象単位の最終失敗数。カバー画像含み、中断由来は含まない (DownloadZipResult.failedFileCount) */
  failedFileCount: number;
  /** 収集フェーズがレート制限で打ち切られた場合に 'rate-limit-exhausted' */
  stoppedReason?: 'rate-limit-exhausted';
};

/**
 * 完了画面に表示するメッセージを組み立てる (Issue #18 第 1 段階)。
 *
 * OverlayController.startCollecting から呼ばれる純粋関数として切り出している。DOM や
 * collect()/downloadAsZip() の実行を伴わずに、失敗件数の組み合わせごとの分岐をそのまま
 * ユニットテストできるようにするため。
 *
 * 優先順位: 中断 (PARTIAL_DOWNLOAD_MESSAGE、失敗があれば併記) > 収集フェーズの打ち切り
 * (RATE_LIMIT_EXHAUSTED_HEADLINE) > ZIP フェーズのファイル欠落 (PARTIAL_FILE_FAILURE_HEADLINE)
 * > 完全な成功 (COMPLETE_HEADLINE)。収集フェーズの失敗 (failedPostCount/failedPageCount) と
 * ZIP フェーズの失敗 (failedFileCount) は同じ文言構成 (failedSuffix) に合流させ、矛盾する
 * 表示にならないようにする。
 */
export function buildCompleteMessage(params: CompleteMessageParams): string {
  if (params.aborted) {
    const fileFailureNote =
      params.failedFileCount > 0 ? `\n${params.failedFileCount} 件のファイル (カバー画像含む)の取得に失敗しました` : '';
    return `${PARTIAL_DOWNLOAD_MESSAGE}${fileFailureNote}`;
  }

  // ページ単位の失敗は欠落した投稿数が分からないため、投稿単位の件数とは足し合わせない。
  // ZIP フェーズのファイル欠落 (カバー画像含む) も同じ文言構成に合流させる
  const failures = [
    params.failedPostCount > 0 ? `${params.failedPostCount} 件の投稿` : '',
    params.failedPageCount > 0 ? `${params.failedPageCount} ページ分の投稿一覧 (投稿数は不明)` : '',
    params.failedFileCount > 0 ? `${params.failedFileCount} 件のファイル (カバー画像含む)` : '',
  ].filter(Boolean);
  const failedSuffix = failures.length
    ? `\n${failures.join(' と ')}の取得に失敗しました (支援プランの範囲外か、FANBOX のレート制限の可能性があります)`
    : '';
  // 打ち切った場合もそこまでの分は保存済みなので、完了ではなく不完全と伝える。
  // 収集フェーズの打ち切りが最優先、次に ZIP フェーズのファイル欠落、どちらも無ければ完了
  const headline =
    params.stoppedReason === 'rate-limit-exhausted'
      ? RATE_LIMIT_EXHAUSTED_HEADLINE
      : params.failedFileCount > 0
        ? PARTIAL_FILE_FAILURE_HEADLINE
        : COMPLETE_HEADLINE;
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

      const { downloadObject, failedPostCount, failedPageCount, stoppedReason } = await collect(
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
        'failed-post-count': String(failedPostCount),
        'failed-page-count': String(failedPageCount),
        ...(stoppedReason ? { 'stopped-reason': stoppedReason } : {}),
      });

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
            failedPostCount,
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
          failedPostCount,
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
      } else {
        console.error('ダウンロードエラー:', e);
      }
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
