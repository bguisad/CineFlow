import { listHistory, removeHistory, clearHistory, restoreHistory, hydrateHistory, fetchMissingPosters } from './history-store.js';

const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const DAY_MS = 86400000;
const FINISHED_RATIO = 0.96;

function thumbOf(path) {
  return path ? `${IMAGE_BASE}/w185${path}` : '';
}

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function remainingText(item) {
  if (!item.duration) return item.progress ? `已看 ${clock(item.progress)}` : '';
  if (item.progress / item.duration >= FINISHED_RATIO) return '已看完';
  const left = Math.max(0, Math.round((item.duration - item.progress) / 60));
  return `看到 ${clock(item.progress)} · 还剩 ${left} 分钟`;
}

function relativeText(at) {
  const diff = Date.now() - at;
  if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`;
  const day = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / DAY_MS);
  if (day === 0) return `${Math.round(diff / 3600000)} 小时前`;
  if (day === 1) return `昨天 ${new Date(at).toTimeString().slice(0, 5)}`;
  if (day < 7) return `${day} 天前`;
  return `${new Date(at).getFullYear()}/${String(new Date(at).getMonth() + 1).padStart(2, '0')}/${String(new Date(at).getDate()).padStart(2, '0')}`;
}

function groupLabel(at) {
  const today = new Date().setHours(0, 0, 0, 0);
  const day = Math.floor((today - new Date(at).setHours(0, 0, 0, 0)) / DAY_MS);
  if (day <= 0) return '今天';
  if (day === 1) return '昨天';
  if (day < 7) return '本周';
  return '更早';
}

export function createHistoryPage({ state, escapeHtml = (value) => String(value ?? ''), resume = null } = {}) {
  const view = document.createElement('div');
  view.className = 'cf3-page cf3-history';
  view.innerHTML = `
    <header class="cf3-head">
      <p class="eyebrow">CONTINUE</p>
      <h2 class="cf3-title">播放历史</h2>
    </header>
    <div class="cf3-groups"></div>
    <footer class="cf3-history-foot">
      <button class="cf3-undo" type="button" hidden>撤销</button>
      <button class="cf3-clear" type="button" hidden>清空记录</button>
    </footer>
  `;

  const groups = view.querySelector('.cf3-groups');
  const undoBtn = view.querySelector('.cf3-undo');
  const clearBtn = view.querySelector('.cf3-clear');

  let pendingUndo = null;
  let renderedKey = null;
  let undoTimer = null;

  function register(item) {
    const mediaType = item.mediaType === 'tv' ? 'tv' : 'movie';
    const key = `${mediaType}:${item.id}`;
    try {

      const cached = state?.cardMovies?.get?.(key) || {};
      const pick = (name, fallback) => (cached[name] ? cached[name] : fallback);
      state?.cardMovies?.set(key, {
        ...cached,
        id: item.id,
        mediaType,
        title: pick('title', item.title),
        posterPath: pick('posterPath', item.posterPath || null),
        backdropPath: pick('backdropPath', null),
        overview: pick('overview', ''),
        releaseDate: pick('releaseDate', item.year || ''),
        voteAverage: pick('voteAverage', 0),
        voteCount: pick('voteCount', 0),
        genreIds: pick('genreIds', []),
        popularity: pick('popularity', 0),
        adult: pick('adult', false),
      });
    } catch (error) {

    }
    return key;
  }

  function delegateMarkup(item) {
    const key = register(item);
    return `<article class="movie-card cf3-inert" tabindex="-1" data-movie-id="${escapeHtml(String(item.id))}" data-media-type="${escapeHtml(key.split(':')[0])}" data-content-key="${escapeHtml(key)}"></article>`;
  }

  function openByKey(row) {
    row.querySelector('.cf3-inert')?.click();
  }

  function showUndo(label, restore) {
    pendingUndo = restore;
    undoBtn.textContent = `撤销「${label}」`;
    undoBtn.hidden = false;
    window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(() => {
      pendingUndo = null;
      undoBtn.hidden = true;
    }, 8000);
  }

  undoBtn.addEventListener('click', () => {
    if (!pendingUndo) return;
    pendingUndo();
    pendingUndo = null;
    undoBtn.hidden = true;
    window.clearTimeout(undoTimer);
    render(true);
  });

  clearBtn.addEventListener('click', () => {
    const snapshot = listHistory();
    if (!snapshot.length) return;
    clearHistory();
    showUndo('全部记录', () => restoreHistory(snapshot));
    render(true);
  });

  function bindResume(btn, item, scope) {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '定位中...';
      try {
        await resume?.resume(item, scope.querySelector('.cf3-inert'));
      } finally {

        if (btn.isConnected) {
          btn.disabled = false;
          btn.textContent = '接着看';
        }
      }
    });
  }

  function buildRow(item) {
    const row = document.createElement('div');
    row.className = 'cf3-row';
    const thumb = thumbOf(item.posterPath);
    const percent = item.duration ? Math.min(100, Math.round((item.progress / item.duration) * 100)) : 0;
    row.innerHTML = `
      ${delegateMarkup(item)}
      <div class="cf3-thumb">${thumb ? `<img src="${thumb}" alt="" decoding="async" />` : '<span>·</span>'}</div>
      <div class="cf3-row-info">
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml([item.mediaType === 'tv' ? item.episode : '', remainingText(item)].filter(Boolean).join(' · '))}</p>
        <div class="cf3-progress slim"><i style="width:${percent}%"></i></div>
      </div>
      <div class="cf3-row-actions">
        <button class="primary-button cf3-resume-btn" type="button">接着看</button>
        <button class="secondary-button cf3-detail-btn" type="button">详情</button>
      </div>
      <time>${escapeHtml(relativeText(item.updatedAt))}</time>
      <button class="cf3-del" type="button" title="删除" aria-label="删除">×</button>
    `;
    bindResume(row.querySelector('.cf3-resume-btn'), item, row);
    row.querySelector('.cf3-detail-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      openByKey(row);
    });
    row.addEventListener('click', (event) => {
      if (event.target.closest('.cf3-del, .cf3-row-actions')) return;
      openByKey(row);
    });
    row.querySelector('.cf3-del').addEventListener('click', (event) => {
      event.stopPropagation();
      const backup = listHistory().find((entry) => entry.key === item.key);
      removeHistory(item.key);
      showUndo(item.title, () => {
        if (backup) restoreHistory([backup]);
      });
      render();
    });
    return row;
  }

  function render(force) {

    fetchMissingPosters(() => render(true));
    const items = hydrateHistory().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const key = signature(items);

    if (!force && key === renderedKey && groups.firstElementChild) return;
    renderedKey = key;
    renderList(items);
  }

  function signature(items) {
    return items.map((item) => `${item.key}|${item.updatedAt || 0}|${Math.round(((item.progress || 0) / (item.duration || 1)) * 100)}`).join(';');
  }

  function renderList(items) {
    groups.innerHTML = '';
    clearBtn.hidden = items.length === 0;

    if (!items.length) {
      groups.innerHTML = '<p class="cf3-empty">暂无记录</p>';
      return;
    }
    const buckets = new Map();
    for (const item of items) {
      const label = groupLabel(item.updatedAt);
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(item);
    }
    for (const [label, bucket] of buckets) {
      const section = document.createElement('section');
      section.className = 'cf3-group';
      const title = document.createElement('h3');
      title.className = 'cf3-group-title';
      title.textContent = label;
      section.appendChild(title);
      for (const item of bucket) section.appendChild(buildRow(item));
      groups.appendChild(section);
    }
  }

  return {
    el: view,
    activate() {
      render();
    },
    settle() {
      pendingUndo = null;
      undoBtn.hidden = true;
    },
  };
}
