const MAX_ROWS = 12;
const GAP = 12;
const SETTLE_MS = 1500;
const MIN_TERM = 2;

const STORE_KEY = 'cineflow:search-history:v2';
const LEGACY_KEY = 'cineflow:search-history:v1';

function normalizeRow(row, fallbackAt = Date.now()) {
  if (typeof row === 'string') {
    const term = row.trim();
    return term ? { term, hits: 0, searches: 1, at: fallbackAt } : null;
  }
  if (!row || typeof row !== 'object') return null;
  const term = String(row.term || '').trim();
  if (!term) return null;
  return {
    term,
    hits: Math.max(0, Number(row.hits) || 0),
    searches: Math.max(1, Number(row.searches) || 1),
    at: Number(row.at) || fallbackAt
  };
}

function readStore() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORE_KEY) || '[]');
    if (Array.isArray(parsed) && parsed.length) return parsed.map((row, index) => normalizeRow(row, Date.now() - index)).filter(Boolean);
  } catch (error) {

  }
  try {
    const legacy = JSON.parse(window.localStorage.getItem(LEGACY_KEY) || '[]');
    if (Array.isArray(legacy)) return legacy.map((row, index) => normalizeRow(row, Date.now() - index * 1000)).filter(Boolean);
  } catch (error) {

  }
  return [];
}

function writeStore(items) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, MAX_ROWS)));
    window.localStorage.removeItem(LEGACY_KEY);
  } catch (error) {

  }
}

function looksLikeQuery(term) {
  if (term.length < MIN_TERM) return false;
  if (/'|‘|’/.test(term)) return false;
  if (/^[a-z]+$/.test(term)) return false;
  return true;
}

function migrateFromPrefs(prefs) {
  const raw = Array.isArray(prefs?.recentSearches) ? prefs.recentSearches.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const kept = raw.filter(looksLikeQuery);
  return kept.filter((term) => !kept.some((other) => other !== term && other.startsWith(term)));
}

function stripInvisible(value) {
  return String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '');
}

function normalizeKey(value) {
  return stripInvisible(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function mountSearchHistory({ state } = {}) {
  const input = document.querySelector('#globalSearch');
  const app = document.querySelector('#app');
  const box = document.querySelector('.search-box');
  if (!input || !app || !box) return false;
  if (app.dataset.cf7SearchHistory === '1') return true;
  app.dataset.cf7SearchHistory = '1';

  let items = readStore();
  let migrated = items.length > 0;

  if (items.length) writeStore(items);

  function seedFromPrefs() {
    if (migrated) return;
    const seeded = migrateFromPrefs(state?.prefs);
    if (!seeded.length) return;
    migrated = true;
    items = seeded.map((term, index) => ({ term, hits: 0, searches: 1, at: Date.now() - index * 1000 }));
    writeStore(items);
  }

  const panel = document.createElement('div');
  panel.className = 'cf7-history';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '搜索记录');
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = `
    <div class="cf7-history-head">
      <span class="cf7-history-title">搜索记录</span>
      <button type="button" class="cf7-history-clear">清空</button>
    </div>
    <div class="cf7-history-list"></div>
  `;
  app.append(panel);

  const listEl = panel.querySelector('.cf7-history-list');
  const clearEl = panel.querySelector('.cf7-history-clear');
  let settleTimer = 0;
  let composing = false;

  const isOpen = () => panel.classList.contains('is-open');
  const islandMode = () => ['island-mode', 'island-expanded-mode', 'island-docked-mode']
    .some((name) => document.body.classList.contains(name));

  function remember(term, { replay = false } = {}) {
    const value = stripInvisible(term).trim();
    if (value.length < MIN_TERM) return;
    const key = normalizeKey(value);
    const existing = items.find((row) => normalizeKey(row.term) === key);
    if (existing) {
      existing.term = value;
      existing.searches += 1;
      if (replay) existing.hits += 1;
      existing.at = Date.now();
      items = [existing, ...items.filter((row) => row !== existing)];
    } else {
      items = [{ term: value, hits: replay ? 1 : 0, searches: 1, at: Date.now() }, ...items];
    }
    items = items.slice(0, MAX_ROWS);
    writeStore(items);
    if (isOpen()) render();
  }

  function forget(index) {
    items = items.filter((_, position) => position !== index);
    writeStore(items);
    render();
  }

  function place() {
    const appRect = app.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();

    const wantLeft = Math.round(boxRect.left - appRect.left);
    const wantTop = Math.round(boxRect.bottom - appRect.top) + GAP;
    panel.style.left = `${wantLeft}px`;
    panel.style.top = `${wantTop}px`;
    const room = Math.max(220, appRect.width - wantLeft - 24);
    panel.style.width = `${Math.round(Math.min(430, room))}px`;
    const dx = wantLeft - panel.offsetLeft;
    const dy = wantTop - panel.offsetTop;
    if (Math.abs(dx) > 0.5) panel.style.left = `${wantLeft + dx}px`;
    if (Math.abs(dy) > 0.5) panel.style.top = `${wantTop + dy}px`;
    const width = panel.offsetWidth || 430;
    const caret = boxRect.left + boxRect.width / 2 - (appRect.left + panel.offsetLeft);
    panel.style.setProperty('--cf7-caret-x', `${Math.round(Math.min(Math.max(caret, 18), width - 18))}px`);
  }

  function termHash(term) {
    let hash = 2166136261 >>> 0;
    for (const ch of term) {
      hash ^= ch.codePointAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }

  function cloudStyle(row) {
    const hits = Math.min(Number(row.hits) || 0, 6);
    const extra = Math.min(Math.max((Number(row.searches) || 1) - 1, 0), 4);
    const size = 12.5 + hits * 1.9 + extra * 0.45;
    const weight = 500 + Math.min(hits, 4) * 50;
    const hash = termHash(normalizeKey(row.term));
    const hue = hash % 360;
    const sat = Math.min(52 + ((hash >>> 9) % 30) + Math.min(hits, 4) * 2, 88);
    const light = Math.min(70 + ((hash >>> 18) % 16) + Math.min(hits, 4) * 1.4, 88);
    return `--cf9-size:${size.toFixed(1)}px;--cf9-weight:${weight};--cf9-hue:${hue};--cf9-sat:${sat}%;--cf9-light:${light.toFixed(1)}%`;
  }

  function render() {
    if (!items.length) {
      close();
      return;
    }
    listEl.innerHTML = items
      .map((row, index) => `<button type="button" class="cf7-history-item" data-index="${index}" tabindex="-1" style="${cloudStyle(row)}" aria-label="搜索 ${escapeHtml(row.term)}">
          <svg class="cf7-history-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/></svg>
          <span class="cf7-history-term">${escapeHtml(row.term)}</span>
          <span class="cf7-history-del" role="button" tabindex="-1" title="删除这条" aria-label="删除这条">×</span>
        </button>`)
      .join('');
  }

  function open() {
    if (islandMode()) return;
    seedFromPrefs();
    if (!items.length) return;
    render();
    place();
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
  }

  function close() {
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
  }

  function replay(term) {
    const value = String(term || '').trim();
    if (!value) return;
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    remember(value, { replay: true });
    close();
  }

  function armSettle() {
    const armed = String(input.value || '').trim();
    if (settleTimer) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (composing) return;
      if (!armed) return;
      if (String(input.value || '').trim() !== armed) return;
      remember(armed);
    }, SETTLE_MS);
  }

  input.addEventListener('compositionstart', () => {
    composing = true;
    if (settleTimer) { window.clearTimeout(settleTimer); settleTimer = 0; }
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    armSettle();
  });
  input.addEventListener('input', () => {
    if (!composing) armSettle();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (settleTimer) { window.clearTimeout(settleTimer); settleTimer = 0; }
      if (!composing) remember(input.value);
      close();
      return;
    }
    if (event.key === 'Escape') close();
  });
  window.addEventListener('beforeunload', () => {
    if (settleTimer) window.clearTimeout(settleTimer);
  });

  input.addEventListener('focus', open);
  input.addEventListener('click', open);

  panel.addEventListener('mousedown', (event) => {
    if (event.target instanceof Element && event.target.closest('.cf7-history-item, .cf7-history-clear')) {
      event.preventDefault();
    }
  });

  panel.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.cf7-history-clear')) {
      items = [];
      writeStore(items);
      close();
      return;
    }
    const item = target.closest('.cf7-history-item');
    if (!item) return;
    const index = Number(item.dataset.index || 0);
    if (target.closest('.cf7-history-del')) {
      forget(index);
      return;
    }
    replay(items[index]?.term);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!isOpen()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && (target.closest('.cf7-history') || target === input || target.closest('.search-box'))) return;
    close();
  }, { passive: true });

  window.addEventListener('resize', () => { if (isOpen()) place(); });
  new MutationObserver(() => { if (islandMode()) close(); })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });

  return true;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function initSearchHistory(deps = {}) {
  try {
    return mountSearchHistory(deps);
  } catch (error) {
    console.warn('[CineFlow] 搜索记录弹窗装配失败，已跳过', error);
    return false;
  }
}
