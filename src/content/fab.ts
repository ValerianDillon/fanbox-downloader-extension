import type { PageType } from './fanbox/api';
import { OverlayController } from './overlay';

export class FabManager {
  private fabButton: HTMLButtonElement | null = null;
  private overlayController: OverlayController | null = null;
  private hostEl: HTMLElement;

  constructor() {
    this.hostEl = document.createElement('div');
    this.hostEl.id = 'fanbox-downloader-ext';
    document.body.appendChild(this.hostEl);
    this.overlayController = new OverlayController(this.hostEl);
  }

  show(pageType: PageType) {
    if (!pageType) {
      this.hide();
      return;
    }
    this.overlayController?.setPageType(pageType);
    if (!this.fabButton) {
      this.fabButton = document.createElement('button');
      this.fabButton.className = 'fab-button';
      this.fabButton.textContent = '\u2B07';
      this.fabButton.title = 'FANBOX Downloader';
      this.fabButton.addEventListener('click', () => {
        this.overlayController?.showPanel();
      });
      // FAB は shadow DOM の外に配置 (overlay.css の :host{all:initial} の影響を避ける)
      this.fabButton.style.cssText =
        'position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;' +
        'background:#4caf50;color:#fff;border:none;cursor:pointer;' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.3);font-size:24px;z-index:2147483647;' +
        'display:flex;align-items:center;justify-content:center;' +
        'font-family:system-ui,sans-serif;transition:transform 0.2s,background 0.2s;';
      this.fabButton.addEventListener('mouseenter', () => {
        if (this.fabButton) {
          this.fabButton.style.transform = 'scale(1.1)';
          this.fabButton.style.background = '#43a047';
        }
      });
      this.fabButton.addEventListener('mouseleave', () => {
        if (this.fabButton) {
          this.fabButton.style.transform = '';
          this.fabButton.style.background = '#4caf50';
        }
      });
      document.body.appendChild(this.fabButton);
    }
  }

  hide() {
    this.overlayController?.hidePanel();
    if (this.fabButton) {
      this.fabButton.remove();
      this.fabButton = null;
    }
  }

  destroy() {
    this.hide();
    this.hostEl.remove();
  }
}
