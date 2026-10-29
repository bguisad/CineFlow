import { createPageTransition } from './page-transition.js';
import { createLibraryPage } from './library-page.js';
import { createHistoryPage } from './history-page.js';
import { createHistoryResume } from './history-resume.js';
import { initHistoryStore } from './history-store.js';
import { initIncrementalSettings } from './incremental-settings.js';
import { initIncrementalSourceManager } from './source-manager.js';
import { initSearchHistory } from './search-history.js';
import { initResourcePrewarm } from './resource-prewarm.js';
import { initDetailPrewarm } from './detail-prewarm.js';
import { initDualSearch } from './dual-search.js';
import { initDoubanFallback } from './douban-fallback.js';
import { initUpdateBubble } from './update-bubble.js';
import { initTmdbWizard } from './tmdb-wizard.js';
import { initPlayerAnchor } from './player-anchor.js';
import { initSearchWorkbench } from './search-workbench.js';

const ISLAND_CLASSES = ['island-mode', 'island-expanded-mode', 'island-docked-mode'];
const PRELOAD_DELAY_MS = 2200;

function mountPages(deps) {
  const root = document.getElementById('app');
  if (!root || root.dataset.cf3Pages === '1') return false;
  root.dataset.cf3Pages = '1';
  const { api, state, escapeHtml } = deps;

  const isIsland = () => ISLAND_CLASSES.some((name) => document.body.classList.contains(name));

  initHistoryStore({ state, api });
  initIncrementalSettings({ api, state });
  initIncrementalSourceManager({ api, state, escapeHtml });
  initSearchHistory({ api, state });
  initResourcePrewarm({ api, state });
  initDetailPrewarm({ api, state });
  initDualSearch({ api, state });
  initDoubanFallback({ api, state });
  initUpdateBubble({ api, state });
  initTmdbWizard({ api, state });
  initPlayerAnchor({ api, state });
  initSearchWorkbench({ api, state, escapeHtml });

  const library = createLibraryPage({ api, state, escapeHtml });
  const history = createHistoryPage({ state, escapeHtml, resume: createHistoryResume({ state }) });

  const stage = createPageTransition({
    root,
    pages: [
      { id: 'home', el: null },
      {
        id: 'library',
        el: library.el,
        activate: () => library.activate(),

        prepare: () => library.activate(),
        settle: () => library.settle(),
      },
      {
        id: 'history',
        el: history.el,

        activate: () => history.activate(),
        prepare: () => history.activate(),
        settle: () => history.settle?.(),
      },
    ],
  });

  let preloaded = false;
  window.setTimeout(() => {
    if (preloaded || isIsland() || stage.getCurrent() !== 0) return;
    preloaded = true;
    stage.preload(1);
    stage.preload(2);
  }, PRELOAD_DELAY_MS);

  new MutationObserver(() => stage.setEnabled(!isIsland())).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });

  const settingsModal = document.querySelector('#settingsModal');
  if (settingsModal) {
    new MutationObserver(() => {
      if (settingsModal.classList.contains('is-hidden') && stage.getCurrent() === 1) library.activate();
    }).observe(settingsModal, { attributes: true, attributeFilter: ['class'] });
  }

  return true;
}

export function initIncrementalPages(deps = {}) {
  try {
    return mountPages(deps);
  } catch (error) {
    console.warn('[CineFlow] 分类片库 / 播放历史与三页切换装配失败，已跳过', error);
    return false;
  }
}
