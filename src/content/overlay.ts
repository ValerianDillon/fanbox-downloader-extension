import type { DownloadProgress, FileSystemFileHandle } from './downloader';
import { downloadAsZip, pickSaveHandle } from './downloader';
import type { PageType } from './fanbox/api';
import type { CollectorSettings } from './fanbox/collector';
import { collect } from './fanbox/collector';
import css from './overlay.css' with { type: 'text' };
import { publishTestState, resetTestState, SHADOW_ROOT_MODE } from './test-hooks';

export type OverlayState = 'settings' | 'collecting' | 'downloading' | 'complete';

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

      const { downloadObject, failedPostCount } = await collect(
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

      publishTestState({ 'failed-post-count': String(failedPostCount) });

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
      await downloadAsZip(saveHandle, json, downloadProgress, signal);

      this.setState('complete');
      const failedSuffix =
        failedPostCount > 0
          ? `\n${failedPostCount} 件は取得に失敗しました (FANBOX のレート制限の可能性があります)`
          : '';
      this.renderComplete(`ダウンロードが完了しました${failedSuffix}`);
    } catch (e) {
      if (signal.aborted) {
        this.publishAbortedIfCurrent(signal);
        return;
      }
      console.error('ダウンロードエラー:', e);
      publishTestState({ error: '1' });
      this.setState('complete');
      this.renderComplete(`エラーが発生しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.removeEventListener('beforeunload', beforeUnload);
      this.abortController = null;
    }
  }
}
