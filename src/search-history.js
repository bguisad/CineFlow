/**
 * v3.4.2 纯增量：首页搜索框的"搜索记录"弹窗。
 *
 * 为什么不直接用基线的 state.prefs.recentSearches：
 * 基线 `input` 事件 320ms 防抖后就调 `search()` → `addRecentSearch()`，
 * 于是逐字输入会留下一串碎片（`下` / `下雨`、`xia` / `xia'yu` / `fang's` —— 后者是输入法
 * 组合框里的拼音被当成查询词存了）。那是"输入轨迹"，不是"搜索历史"。
 *
 * 所以这里自己存一份 `cineflow:search-history:v1`，只在**用户真的说完一句话**之后才记：
 *   ① 输入法组合中（compositionstart…compositionend）一律不记；
 *   ② 最后一次输入后静置 1.5s，且这期间输入框的值没再变过，才记；
 *   ③ 按回车立刻记（明确意图），并取消待处理的静置计时；
 *   ④ 首次使用时从基线那份里迁一遍，丢掉"是别的词的前缀"、带拼音撇号、单字的碎片。
 * 显示、删除、清空都只动自己这份，立刻落盘，不再依赖基线什么时候才 savePrefs。
 *
 * 玻璃质感复用收藏页那套配方；一个 app-region 都不声明（拖拽区只归基线 .titlebar）。
 */

const MAX_ROWS = 12;
const GAP = 12;
const SETTLE_MS = 1500;
const MIN_TERM = 2;
// v2 起每条记 { term, hits, searches, at }：hits=点这条历史记录的次数（决定词云字号）
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
    /* 落到下面读 v1 */
  }
  try {
    const legacy = JSON.parse(window.localStorage.getItem(LEGACY_KEY) || '[]');
    if (Array.isArray(legacy)) return legacy.map((row, index) => normalizeRow(row, Date.now() - index * 1000)).filter(Boolean);
  } catch (error) {
    /* 两条都读不到就从空开始 */
  }
  return [];
}

function writeStore(items) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, MAX_ROWS)));
    window.localStorage.removeItem(LEGACY_KEY);
  } catch (error) {
    /* 存储不可用就只在本会话里显示，不影响任何基线链路 */
  }
}

// 基线那份是"输入轨迹"，里面混着输入法中间态（xia / qingyu / fang's）。
// 一次性迁移时只留下像完整查询的：够长、没有拼音撇号、不是纯小写英文单词（那就是拼音片段），
// 再丢掉"是别的词的前缀"的碎字。代价是纯英文单词的历史会被清掉一次，之后正常记录。
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

// 双路搜索会用零宽分隔符拆开意图词再交给基线检索，存历史时要把它们去掉
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
  // 从 v1 旧格式读出来的，挂载时就落成 v2（同时清掉 v1），别等下一次搜索才升级
  if (items.length) writeStore(items);

  // 装配时 state.prefs 可能还没落下来，真正打开面板时再补一次迁移
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

  // replay=true 表示"点击了这条历史记录"：hits+1，词云里就更大
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
    // 用 offsetLeft/offsetTop 回校：面板静息态带 scale/translate，getBoundingClientRect 会被 transform 带偏
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

  // 字号的唯一主权重是"点开这条历史记录的次数"；另外给搜索次数一点点加成，避免刚搜过的词也最小。
  // 颜色取 32 位哈希的三段独立位段：色相 0-359、饱和 52-81%、亮度 70-85%，
  // 三者组合出上千种观感颜色，而同一个词永远算出同一组值（点得越多越亮越饱和）。
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

  // —— 记录时机：静置 1.5s 且这期间这个词没再变过，才算"用户真的搜了这个" ——
  function armSettle() {
    const armed = String(input.value || '').trim();
    if (settleTimer) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (composing) return;
      if (!armed) return;
      if (String(input.value || '').trim() !== armed) return; // 静置期间又改过，交给下一次计时
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

  // —— 面板交互 ——
  input.addEventListener('focus', open);
  input.addEventListener('click', open);

  // mousedown 里 preventDefault：焦点留在搜索框，避免点列表时先触发失焦把面板关掉
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
