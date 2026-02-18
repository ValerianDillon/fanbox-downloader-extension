import type { PageType } from './fanbox/api';
import { OverlayController } from './overlay';

const FAB_STYLES = `
  :host {
    all: initial;
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
  }
  button {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: #4caf50;
    color: #fff;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    font-size: 24px;
    font-family: system-ui, sans-serif;
    transition: transform 0.2s, background 0.2s;
    box-sizing: border-box;
  }
  button:hover {
    transform: scale(1.1);
    background: #43a047;
  }
`;

export class FabManager {
  private fabHost: HTMLElement | null = null;
  private fabShadow: ShadowRoot | null = null;
  private overlayController: OverlayController | null = null;
  private overlayHost: HTMLElement;

  constructor() {
    this.overlayHost = document.createElement('div');
    this.overlayHost.id = 'fanbox-downloader-ext-overlay';
    document.body.appendChild(this.overlayHost);
    this.overlayController = new OverlayController(this.overlayHost);
  }

  show(pageType: PageType) {
    if (!pageType) {
      this.hide();
      return;
    }
    this.overlayController?.setPageType(pageType);
    if (!this.fabHost) {
      this.fabHost = document.createElement('div');
      this.fabHost.id = 'fanbox-downloader-ext-fab';
      this.fabShadow = this.fabHost.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = FAB_STYLES;
      this.fabShadow.appendChild(style);

      const button = document.createElement('button');
      button.textContent = '\u2B07';
      button.title = 'FANBOX Downloader';
      button.addEventListener('click', () => {
        this.overlayController?.showPanel();
      });
      this.fabShadow.appendChild(button);
      document.body.appendChild(this.fabHost);
    }
  }

  hide() {
    this.overlayController?.hidePanel();
    if (this.fabHost) {
      this.fabHost.remove();
      this.fabHost = null;
      this.fabShadow = null;
    }
  }

  destroy() {
    this.hide();
    this.overlayHost.remove();
  }
}
