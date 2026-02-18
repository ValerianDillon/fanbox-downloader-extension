import type { DownloadProgress } from './downloader';
import { downloadAsZip } from './downloader';
import type { PageType } from './fanbox/api';
import type { CollectorSettings } from './fanbox/collector';
import { collect } from './fanbox/collector';
import css from './overlay.css' with { type: 'text' };

export type OverlayState = 'settings' | 'collecting' | 'downloading' | 'complete';

export class OverlayController {
  private state: OverlayState = 'settings';
  private abortController: AbortController | null = null;
  private shadowRoot: ShadowRoot;
  private panelEl: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private pageType: PageType = null;

  constructor(hostEl: HTMLElement) {
    this.shadowRoot = hostEl.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = css;
    this.shadowRoot.appendChild(style);
  }

  getState(): OverlayState {
    return this.state;
  }

  setPageType(pageType: PageType) {
    this.pageType = pageType;
  }

  showPanel() {
    this.state = 'settings';
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
    this.state = 'settings';
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
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const dlBtn = document.createElement('button');
    dlBtn.className = 'btn-primary';
    dlBtn.textContent = 'ダウンロード開始';
    dlBtn.addEventListener('click', () => {
      const settings: CollectorSettings = {
        isIgnoreFree: ignoreFreeCheckbox?.checked ?? false,
        limit: limitInput?.value ? Number.parseInt(limitInput.value, 10) : null,
      };
      this.startCollecting(settings);
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

  private async startCollecting(settings: CollectorSettings) {
    if (!this.pageType) return;
    this.state = 'collecting';
    this.renderCollecting();
    this.abortController = new AbortController();

    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.returnValue = 'downloading';
    };
    window.addEventListener('beforeunload', beforeUnload);

    try {
      const creatorId = this.pageType.creatorId;
      const postId = this.pageType.type === 'post' ? this.pageType.postId : undefined;

      const downloadObject = await collect(
        creatorId,
        postId,
        settings,
        (current, total) => {
          const el = this.shadowRoot.getElementById('collect-progress');
          if (el) el.textContent = `投稿情報を収集中... (${current}/${total})`;
        },
        this.abortController.signal,
      );

      if (this.abortController.signal.aborted) return;

      this.state = 'downloading';
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
      await downloadAsZip(json, downloadProgress, this.abortController.signal);

      this.state = 'complete';
      this.renderComplete('ダウンロードが完了しました');
    } catch (e) {
      if (this.abortController?.signal.aborted) return;
      console.error('ダウンロードエラー:', e);
      this.state = 'complete';
      this.renderComplete(`エラーが発生しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.removeEventListener('beforeunload', beforeUnload);
      this.abortController = null;
    }
  }
}
