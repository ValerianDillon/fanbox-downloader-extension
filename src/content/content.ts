import { FabManager } from './fab';
import { detectPage } from './fanbox/api';

let fabManager: FabManager | null = null;

function updateFab() {
  const pageType = detectPage(window.location.href);
  if (pageType) {
    if (!fabManager) {
      fabManager = new FabManager();
    }
    fabManager.show(pageType);
  } else {
    fabManager?.hide();
  }
}

// 初回実行
updateFab();

// SPA ナビゲーション検知 (pushState/replaceState)
const originalPushState = history.pushState.bind(history);
const originalReplaceState = history.replaceState.bind(history);

history.pushState = (...args: Parameters<typeof history.pushState>) => {
  originalPushState(...args);
  updateFab();
};

history.replaceState = (...args: Parameters<typeof history.replaceState>) => {
  originalReplaceState(...args);
  updateFab();
};

window.addEventListener('popstate', () => updateFab());
