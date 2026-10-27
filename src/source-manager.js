const MODE_LABELS = { stable: '稳定', movie: '电影', full: '全部' };
const TEST_ALL_CONCURRENCY = 2;
const BUBBLE_GAP = 8;
const CARD_INSET = 16;

function notify(message) {
  const el = document.querySelector('#toast');
  if (!el || !message) return;
  el.textContent = message;
  el.classList.remove('is-hidden');
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => el.classList.add('is-hidden'), 2600);
}

function mergeIntoState(state, next) {
  if (!state || !next) return;
  state.resourceSettings = { ...state.resourceSettings, ...next };
  if (state.credential) state.credential.resources = state.resourceSettings;
}

function sourceId(source) {
  return `${source.origin === 'custom' ? 'c' : 'b'}|${source.key || source.api}`;
}

export function createSourceManager({ api, state, escapeHtml = (value) => String(value ?? '') } = {}) {
  const card = document.querySelector('.settings-card');
  const modal = document.querySelector('#settingsModal');
  if (!card || !modal || !api?.getResourceSettings) return null;
  if (card.dataset.cf5Sources === '1') return { refresh: () => {} };
  card.dataset.cf5Sources = '1';

  const panel = document.createElement('section');
  panel.className = 'cf5-sources';
  panel.innerHTML = `
    <header class="cf5-head">
      <h3 class="cf5-title">片源管理</h3>
      <p class="cf5-count">—</p>
    </header>
    <div class="cf5-toolbar">
      <button class="secondary-button cf5-test-all" type="button">全部测速</button>
      <p class="cf5-status" role="status" aria-live="polite"></p>
    </div>
    <div class="cf5-list" role="list"></div>
    <div class="cf5-import">
      <label class="settings-label" for="cf5SourceInput">导入自定义源</label>
      <textarea id="cf5SourceInput" class="settings-input cf5-input" rows="4" spellcheck="false" placeholder="一行一个：名称|接口地址　也支持 TVBox 配置 / JSON 数组 / 配置地址"></textarea>
      <div class="settings-actions">
        <button class="primary-button cf5-import-btn" type="button">导入并刷新</button>
        <button class="secondary-button cf5-clear-btn" type="button">清空自定义源</button>
      </div>
    </div>
  `;
  card.append(panel);

  const bubble = document.createElement('div');
  bubble.className = 'cf5-bubble';
  bubble.setAttribute('role', 'group');
  bubble.setAttribute('aria-label', '内置播放源');
  bubble.inert = true;
  card.append(bubble);

  const listEl = panel.querySelector('.cf5-list');
  const countEl = panel.querySelector('.cf5-count');
  const statusEl = panel.querySelector('.cf5-status');
  const inputEl = panel.querySelector('#cf5SourceInput');
  const importBtn = panel.querySelector('.cf5-import-btn');
  const clearBtn = panel.querySelector('.cf5-clear-btn');
  const testAllBtn = panel.querySelector('.cf5-test-all');

  const speeds = new Map();
  let sources = [];
  let busy = false;

  const builtinOf = () => sources.filter((source) => source.origin !== 'custom');
  const customOf = () => sources.filter((source) => source.origin === 'custom');

  function latencyOf(source) {
    return speeds.get(sourceId(source));
  }

  function latencyMarkup(source) {
    const hit = latencyOf(source);
    if (!hit) return '<span class="cf5-latency">未测</span>';
    if (hit.ok) return `<span class="cf5-latency is-ok">${Math.round(hit.elapsedMs)} ms</span>`;
    return `<span class="cf5-latency is-bad" title="${escapeHtml(hit.error || '')}">${escapeHtml(String(hit.error || '失败').slice(0, 18))}</span>`;
  }

  function groupLatencyMarkup() {
    const list = builtinOf();
    if (!list.length) return '<span class="cf5-latency">—</span>';
    const done = list.map(latencyOf).filter(Boolean);
    if (!done.length) return '<span class="cf5-latency">未测</span>';
    const okList = done.filter((hit) => hit.ok);
    const bad = done.length - okList.length;
    if (!okList.length) return `<span class="cf5-latency is-bad">${done.length}/${list.length} 无响应</span>`;
    const fastest = Math.min(...okList.map((hit) => hit.elapsedMs));
    return `<span class="cf5-latency is-ok">最快 ${Math.round(fastest)} ms${bad ? ` · ${bad} 无响应` : ''}</span>`;
  }

  function bubbleOpen() {
    return bubble.classList.contains('is-open');
  }

  function render() {
    countEl.textContent = `内置 ${builtinOf().length} · 自定义 ${customOf().length}`;
    if (!sources.length) {
      listEl.innerHTML = '<p class="cf5-empty">暂无播放源</p>';
      return;
    }
    const groupRow = `
      <div class="cf5-item cf5-group" role="listitem" tabindex="0" data-group="builtin" aria-expanded="${bubbleOpen() ? 'true' : 'false'}" title="展开查看内置播放源">
        <div class="cf5-item-main">
          <strong>内置播放源</strong>
          <p class="cf5-api">${builtinOf().length} 个源</p>
        </div>
        <div class="cf5-tags"><span class="cf5-tag cf5-origin">内置</span></div>
        <span class="cf5-slot">${groupLatencyMarkup()}</span>
        <button class="ghost-button cf5-test-group" type="button">测速</button>
        <span class="cf5-caret" aria-hidden="true"></span>
      </div>
    `;
    const customRows = customOf().map((source) => `
      <div class="cf5-item" role="listitem" data-id="${escapeHtml(sourceId(source))}">
        <div class="cf5-item-main">
          <strong>${escapeHtml(source.name || '未命名源')}</strong>
          <p class="cf5-api" title="${escapeHtml(source.api)}">${escapeHtml(source.api)}</p>
        </div>
        <div class="cf5-tags">
          <span class="cf5-tag cf5-origin is-custom">自定义</span>
          ${(source.modes || []).map((mode) => `<span class="cf5-tag">${escapeHtml(MODE_LABELS[mode] || mode)}</span>`).join('')}
        </div>
        <span class="cf5-slot">${latencyMarkup(source)}</span>
        <button class="ghost-button cf5-test" type="button">测速</button>
        <button class="ghost-button cf5-remove" type="button" title="删除" aria-label="删除该源">×</button>
      </div>
    `).join('');
    listEl.innerHTML = groupRow + customRows;
    renderBubble();
  }

  function renderBubble() {
    bubble.innerHTML = `
      <p class="cf5-bubble-title">内置播放源 · ${builtinOf().length}</p>
      <div class="cf5-bubble-list">
        ${builtinOf().map((source) => `
          <div class="cf5-bubble-row" data-id="${escapeHtml(sourceId(source))}">
            <strong>${escapeHtml(source.name || '未命名源')}</strong>
            ${latencyMarkup(source)}
          </div>
        `).join('')}
      </div>
    `;
  }

  function placeBubble() {
    const row = listEl.querySelector('.cf5-group');
    if (!row) return;
    const cardRect = card.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const width = bubble.offsetWidth;
    if (!width) return;
    bubble.style.top = `${Math.round(rowRect.bottom - cardRect.top) + BUBBLE_GAP}px`;
    const left = Math.min(
      Math.max(16, Math.round(rowRect.left - cardRect.left)),
      Math.max(16, Math.round(cardRect.width - CARD_INSET - width))
    );
    bubble.style.left = `${left}px`;
    const caret = rowRect.left + 26 - (cardRect.left + left);
    bubble.style.setProperty('--cf5-caret-x', `${Math.round(Math.min(Math.max(caret, 18), width - 18))}px`);
  }

  function openBubble() {
    if (!builtinOf().length) return;
    renderBubble();
    placeBubble();
    bubble.classList.add('is-open');
    bubble.inert = false;
    listEl.querySelector('.cf5-group')?.setAttribute('aria-expanded', 'true');
  }

  function closeBubble() {
    if (!bubbleOpen()) return;
    bubble.classList.remove('is-open');
    bubble.inert = true;
    listEl.querySelector('.cf5-group')?.setAttribute('aria-expanded', 'false');
  }

  function setLatency(source, result) {
    speeds.set(sourceId(source), result);
    const id = CSS.escape(sourceId(source));
    const markup = latencyMarkup(source);
    const inBubble = bubble.querySelector(`[data-id="${id}"] .cf5-latency`);
    if (inBubble) inBubble.outerHTML = markup;
    const inRow = listEl.querySelector(`[data-id="${id}"] .cf5-latency`);
    if (inRow) inRow.outerHTML = markup;
    if (source.origin !== 'custom') {
      const slot = listEl.querySelector('.cf5-group .cf5-slot');
      if (slot) slot.innerHTML = groupLatencyMarkup();
    }
  }

  async function refresh() {
    try {
      const settings = await api.getResourceSettings();
      mergeIntoState(state, settings);
      sources = Array.isArray(settings?.sources) ? settings.sources : [];
      render();
      if (bubbleOpen()) placeBubble();
    } catch (error) {
      statusEl.textContent = error?.message || '播放源读取失败';
    }
  }

  async function testOne(source, btn) {
    if (!source || !api.testResourceSource) return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '测速中';
    }
    try {
      const result = await api.testResourceSource({ key: source.key, api: source.api });
      setLatency(source, result || { ok: false, error: '无结果' });
    } catch (error) {
      setLatency(source, { ok: false, elapsedMs: 0, error: error?.message || '失败' });
    } finally {
      if (btn?.isConnected) {
        btn.disabled = false;
        btn.textContent = '测速';
      }
    }
  }

  async function testList(list, label) {
    if (busy || !list.length) return;
    busy = true;
    testAllBtn.disabled = true;
    const queue = list.slice();
    let done = 0;
    statusEl.textContent = `${label} 0/${queue.length}`;
    const workers = Array.from({ length: Math.min(TEST_ALL_CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const source = queue.shift();
        await testOne(source, listEl.querySelector(`[data-id="${CSS.escape(sourceId(source))}"] .cf5-test`));
        done += 1;
        statusEl.textContent = `${label} ${done}/${list.length}`;
      }
    });
    await Promise.all(workers);
    const bad = list.filter((source) => latencyOf(source) && !latencyOf(source).ok).length;
    statusEl.textContent = bad ? `完成 ${list.length} 个 · ${bad} 个无响应` : `完成 ${list.length} 个 · 全部可达`;
    busy = false;
    testAllBtn.disabled = false;
  }

  async function importSources() {
    const payload = (inputEl?.value || '').trim();
    if (!payload) {
      notify('请先粘贴源配置');
      return;
    }
    importBtn.disabled = true;
    importBtn.textContent = '导入中...';
    try {
      const settings = await api.importResourceSources(payload);
      mergeIntoState(state, settings);
      sources = Array.isArray(settings?.sources) ? settings.sources : [];
      render();

      if (inputEl) inputEl.value = '';
      statusEl.textContent = `已导入 · 自定义 ${settings?.customSourceCount || 0} 个`;
      notify(`已导入 ${settings?.customSourceCount || 0} 个自定义源`);
    } catch (error) {
      statusEl.textContent = error?.message || '导入失败';
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = '导入并刷新';
    }
  }

  async function submitCustom(next, message) {
    try {
      const settings = next.length
        ? await api.importResourceSources(JSON.stringify(next.map((source) => ({
            name: source.name, api: source.api, modes: source.modes, note: source.note || '',
          }))))
        : await api.clearResourceSources();
      mergeIntoState(state, settings);
      sources = Array.isArray(settings?.sources) ? settings.sources : [];
      render();
      statusEl.textContent = message;
    } catch (error) {
      statusEl.textContent = error?.message || '更新失败';
    }
  }

  function removeSource(source) {
    const rest = customOf().filter((item) => sourceId(item) !== sourceId(source));
    submitCustom(rest, `已删除 ${source.name || '该源'}`);
  }

  async function clearCustom() {
    clearBtn.disabled = true;
    clearBtn.textContent = '清空中...';
    try {
      await submitCustom([], '自定义源已清空');
      if (inputEl) inputEl.value = '';
    } finally {
      clearBtn.disabled = false;
      clearBtn.textContent = '清空自定义源';
    }
  }

  function clearAllGuarded() {
    if (busy) return;
    if (!customOf().length) {
      statusEl.textContent = '没有自定义源';
      return;
    }
    clearCustom();
  }

  listEl.addEventListener('click', (event) => {
    const groupRow = event.target.closest('.cf5-group');
    if (groupRow) {
      if (event.target.closest('.cf5-test-group')) {
        testList(builtinOf(), '内置测速');
        return;
      }
      if (bubbleOpen()) closeBubble();
      else openBubble();
      return;
    }
    const row = event.target.closest('.cf5-item');
    if (!row) return;
    const source = sources.find((item) => sourceId(item) === row.dataset.id);
    if (!source) return;
    if (event.target.closest('.cf5-test')) {
      if (busy) return;
      testOne(source, event.target.closest('.cf5-test'));
      return;
    }
    if (event.target.closest('.cf5-remove')) removeSource(source);
  });

  listEl.addEventListener('keydown', (event) => {
    if (!event.target.classList?.contains('cf5-group')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (bubbleOpen()) closeBubble();
    else openBubble();
  });

  testAllBtn.addEventListener('click', () => testList(sources, '测速中'));
  importBtn.addEventListener('click', importSources);
  clearBtn.addEventListener('click', clearAllGuarded);

  document.addEventListener('click', (event) => {
    if (!bubbleOpen()) return;
    if (event.target instanceof Element && event.target.closest('.cf5-bubble, .cf5-sources')) return;
    closeBubble();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeBubble();
  });
  panel.addEventListener('scroll', () => {
    if (bubbleOpen()) placeBubble();
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (bubbleOpen()) placeBubble();
  });

  let opened = false;
  new MutationObserver(() => {
    const visible = !modal.classList.contains('is-hidden');
    if (visible && !opened) {
      opened = true;
      refresh();
    } else if (!visible) {
      opened = false;
      closeBubble();
    }
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });

  return { refresh, el: panel };
}

export function initIncrementalSourceManager(deps = {}) {
  try {
    return createSourceManager(deps) !== null;
  } catch (error) {
    console.warn('[CineFlow] 片源管理面板装配失败，已跳过', error);
    return false;
  }
}
