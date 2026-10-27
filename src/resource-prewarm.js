const MAX_WATCH = 6;

const DEEP_BATCH = 1;

const asked = new Map();

function requestPrewarm(urls, deepBudget) {
  const bridge = window.cineflowFast;
  if (!bridge?.prewarmMedia) return false;
  const fresh = [];
  let deep = 0;
  for (const url of urls) {
    if (!url) continue;
    const prev = asked.get(url);
    if (prev === undefined) {
      const willDeep = deepBudget > 0;
      asked.set(url, willDeep ? 1 : 0);
      if (willDeep) { deepBudget -= 1; deep += 1; }
      fresh.push(url);
    } else if (prev === 0 && deepBudget > 0) {

      asked.set(url, 1);
      deepBudget -= 1;
      deep += 1;
      fresh.push(url);
    }
    if (fresh.length >= MAX_WATCH) break;
  }
  if (!fresh.length) return false;
  if (asked.size > 400) asked.clear();
  Promise.resolve(bridge.prewarmMedia(fresh, deep)).catch(() => {});
  return deep > 0;
}

function mountResourcePrewarm() {
  if (!window.cineflowFast?.prewarmMedia) return false;
  const host = document.querySelector('#detailContent') || document.querySelector('#app');
  if (!host) return false;

  const detailOpen = () => document.querySelector('#detailPanel')?.classList.contains('is-open');
  const islandMode = () => ['island-mode', 'island-expanded-mode', 'island-docked-mode']
    .some((name) => document.body.classList.contains(name));

  function urlOf(card) {
    const button = card.querySelector('.resource-open[data-play-url]');
    return button ? String(button.getAttribute('data-play-url') || '').trim() : '';
  }

  let bound = null;

  function bind() {
    const list = document.querySelector('#resourceResults');
    if (!list) return false;
    if (list === bound) return true;
    bound = list;
    let deepSpent = false;

    new MutationObserver((records) => {
      if (!detailOpen() || islandMode()) return;
      const added = [];
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('.resource-card')) added.push(node);
          added.push(...Array.from(node.querySelectorAll?.('.resource-card') || []));
        }
      }
      if (!added.length) return;
      const total = list.querySelectorAll('.resource-card').length;
      if (total === added.length) deepSpent = false;
      if (requestPrewarm(added.map(urlOf), deepSpent ? 0 : DEEP_BATCH)) deepSpent = true;
    }).observe(list, { childList: true, subtree: true });

    list.addEventListener('pointerover', (event) => {
      if (!detailOpen() || islandMode()) return;
      const card = event.target instanceof Element ? event.target.closest('.resource-card') : null;
      if (card) requestPrewarm([urlOf(card)], DEEP_BATCH);
    }, { passive: true });

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.movie-card, #dailyDetailBtn')) return;
      deepSpent = false;
      window.setTimeout(() => {
        if (!detailOpen() || islandMode() || deepSpent) return;
        deepSpent = requestPrewarm(Array.from(list.querySelectorAll('.resource-card')).map(urlOf), DEEP_BATCH);
      }, 1200);
    }, { passive: true });

    return true;
  }

  const watcher = new MutationObserver(() => { bind(); });
  watcher.observe(host, { childList: true, subtree: true });
  bind();
  return true;
}

export function initResourcePrewarm(deps = {}) {
  void deps;
  try {
    return mountResourcePrewarm();
  } catch (error) {
    console.warn('[CineFlow] 播放源首帧预热装配失败，已跳过', error);
    return false;
  }
}
