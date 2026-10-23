// v3.4.4 纯增量：首页左上角 "CF" 图标的更新检查气泡。
// 只读 GitHub 的最新 Release（electron/updater.cjs 直连 api.github.com），
// 有新版就在图标下方弹一颗鸿蒙风格气泡：显示版本、本机该用的安装包与体积；
// 点"立即更新"由主进程流式下载 → 静默跑安装包 → 应用退出，全程不跳浏览器。
// 不做任何破坏性操作：下载只落在 userData/updates，安装只接受那个目录里的 .exe。
//
// 摘除办法：删本文件 + incremental-pages.js 里 2 行挂钩 + styles.css 末尾 cf23 段
//          + main.cjs 末尾 update:* 四个通道 + preload 末尾那一个 expose，即回到上一版。

const AUTO_CHECK_DELAY_MS = 5000;
const AUTO_CHECK_EVERY_MS = 6 * 3600 * 1000;
const DISMISS_KEY = 'cineflow:update-dismissed:v1';
const BUBBLE_GAP = 10;
const BUBBLE_INSET = 14;

const update = { open: false, busy: false, data: null, offProgress: null, autoTimer: 0, revealPath: '' };

function bridge() {
  return window.cineflowUpdate;
}

function fmtMB(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '';
  return `${(value / 1048576).toFixed(1)} MB`;
}

function readDismissed() {
  try {
    return String(window.localStorage.getItem(DISMISS_KEY) || '');
  } catch {
    return '';
  }
}

function writeDismissed(version) {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(version || ''));
  } catch {
    /* 存不下就只在本会话生效 */
  }
}

function isIsland() {
  return ['island-mode', 'island-expanded-mode', 'island-docked-mode'].some((name) => document.body.classList.contains(name));
}

function ensureBubble() {
  let bubble = document.querySelector('.cf23-bubble');
  if (bubble) return bubble;
  const app = document.querySelector('#app');
  if (!app) return null;
  bubble = document.createElement('div');
  bubble.className = 'cf23-bubble';
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-hidden', 'true');
  bubble.setAttribute('aria-label', '应用更新');
  bubble.innerHTML = `
    <div class="cf23-head">
      <span class="cf23-badge">CineFlow</span>
      <span class="cf23-versions"></span>
    </div>
    <p class="cf23-title">检查更新</p>
    <p class="cf23-meta"></p>
    <div class="cf23-progress" hidden><i style="width:0%"></i></div>
    <div class="cf23-actions">
      <button type="button" class="primary-button cf23-action">立即更新</button>
      <button type="button" class="ghost-button cf23-later">稍后</button>
    </div>
  `;
  app.append(bubble);
  bubble.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.cf23-later')) {
      closeBubble();
      const latest = update.data?.latest || '';
      if (latest) writeDismissed(latest);
      return;
    }
    if (target.closest('.cf23-action')) {
      if (update.revealPath) bridge()?.reveal?.({ path: update.revealPath }).catch(() => null);
      else startUpdate();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && update.open) closeBubble();
  });
  document.addEventListener('click', (event) => {
    if (!update.open) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.cf23-bubble, .brand-mark')) return;
    closeBubble();
  });
  window.addEventListener('resize', () => {
    if (update.open) placeBubble();
  });
  return bubble;
}

function placeBubble() {
  const bubble = document.querySelector('.cf23-bubble');
  const icon = document.querySelector('.brand-mark');
  if (!bubble || !icon) return;
  const iconRect = icon.getBoundingClientRect();
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;
  const left = Math.min(
    Math.max(BUBBLE_INSET, Math.round(iconRect.left)),
    Math.max(BUBBLE_INSET, window.innerWidth - BUBBLE_INSET - width)
  );
  let top = Math.round(iconRect.bottom + BUBBLE_GAP);
  if (top + height > window.innerHeight - BUBBLE_INSET) {
    top = Math.max(BUBBLE_INSET, window.innerHeight - BUBBLE_INSET - height);
  }
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  bubble.style.setProperty('--cf23-caret-x', `${Math.round(Math.min(Math.max(iconRect.left + iconRect.width / 2 - left, 18), width - 18))}px`);
}

function setText(selector, text) {
  const node = document.querySelector(selector);
  if (node) node.textContent = text || '';
}

function setAction(label, { hidden = false, disabled = false } = {}) {
  const button = document.querySelector('.cf23-action');
  if (!button) return;
  button.textContent = label;
  button.hidden = hidden;
  button.disabled = disabled;
}

function setProgress(percent, text) {
  const bar = document.querySelector('.cf23-progress');
  const fill = bar?.querySelector('i');
  if (!bar || !fill) return;
  bar.hidden = false;
  fill.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
  setText('.cf23-meta', text);
}

function hideProgress() {
  const bar = document.querySelector('.cf23-progress');
  if (bar) {
    bar.hidden = true;
    const fill = bar.querySelector('i');
    if (fill) fill.style.width = '0%';
  }
}

function openBubble(mode, data = {}) {
  const bubble = ensureBubble();
  if (!bubble) return;
  update.open = true;
  update.data = data;
  // 先定位一次：placeBubble 内部要读 getBoundingClientRect/offsetWidth，必然触发一次布局，
  // 这样首次出现也是从关闭态过渡进来（同帧建节点+加类会被浏览器合并成"直接跳到 opacity:1"）
  placeBubble();
  bubble.classList.add('is-open');
  bubble.setAttribute('aria-hidden', 'false');
  document.querySelector('.brand-mark')?.classList.toggle('cf23-has-update', mode === 'update');
  hideProgress();
  // 版本号只在"有新版"时显示；已是最新还挂着 GitHub 上那个更旧的版本号会让人困惑
  setText('.cf23-versions', mode === 'update' && data.latest ? `v${data.latest}` : '');
  const later = document.querySelector('.cf23-later');
  if (later) later.hidden = false;
  if (mode === 'checking') {
    setText('.cf23-title', '正在检查更新');
    setText('.cf23-meta', 'api.github.com · 直连');
    setAction('检查中', { disabled: true });
  } else if (mode === 'update') {
    setText('.cf23-title', `发现新版本 v${data.latest}`);
    setText('.cf23-meta', [data.asset?.label, fmtMB(data.asset?.size)].filter(Boolean).join(' · '));
    setAction('立即更新', { disabled: false });
  } else if (mode === 'latest') {
    setText('.cf23-title', '已是最新版本');
    setText('.cf23-meta', `当前 v${data.current}`);
    setAction('已是最新', { disabled: true });
  } else {
    setText('.cf23-title', '检查更新失败');
    setText('.cf23-meta', String(data.error || '网络不可用').slice(0, 80));
    setAction('重试', { disabled: false });
  }
  if (later) later.hidden = mode === 'checking';
  requestAnimationFrame(placeBubble);
}

function closeBubble() {
  const bubble = document.querySelector('.cf23-bubble');
  update.open = false;
  bubble?.classList.remove('is-open');
  bubble?.setAttribute('aria-hidden', 'true');
}

async function runCheck({ force = false, silent = false } = {}) {
  const api = bridge();
  if (!api?.check) return null;
  if (!silent) openBubble('checking');
  const result = await api.check({ force }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  if (!result || result.ok === false) {
    if (!silent) openBubble('error', { error: result?.error || '检查失败' });
    return result;
  }
  if (silent) return result;
  if (result.hasUpdate && result.asset) {
    openBubble('update', result);
    return result;
  }
  if (result.hasUpdate && !result.asset) {
    openBubble('error', { error: '这个版本没有适合当前系统的安装包' });
    return result;
  }
  openBubble('latest', result);
  return result;
}

async function startUpdate() {
  if (update.busy) return;
  const api = bridge();
  const data = update.data;
  if (!api?.download || !data?.asset) return;
  update.busy = true;
  const button = document.querySelector('.cf23-action');
  if (button) button.disabled = true;
  setText('.cf23-title', `正在下载 v${data.latest}`);
  setAction('下载中', { disabled: true });
  hideProgress();
  setProgress(0, `${data.asset.label} · ${fmtMB(data.asset.size)}`);
  update.offProgress?.();
  update.offProgress = api.onProgress?.((payload) => {
    if (!update.open || payload?.phase !== 'downloading') return;
    setProgress(payload.percent || 0, `下载中 ${payload.percent || 0}% · ${fmtMB(payload.received)}${payload.total ? ` / ${fmtMB(payload.total)}` : ''}`);
  }) || null;
  const result = await api.download({ url: data.asset.url, name: data.asset.name })
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  update.offProgress?.();
  update.offProgress = null;
  update.busy = false;
  update.revealPath = '';
  if (!result?.ok) {
    setText('.cf23-title', '下载失败');
    setText('.cf23-meta', String(result?.error || '未知原因').slice(0, 80));
    setAction('重试', { disabled: false });
    hideProgress();
    return;
  }
  setProgress(100, `已下载 ${fmtMB(result.bytes)} · ${result.speedMBps} MB/s`);
  setText('.cf23-title', '正在安装');
  setAction('安装中', { disabled: true });
  const install = await api.install({ path: result.path }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  if (install?.ok) {
    setText('.cf23-meta', '应用即将重启完成覆盖安装');
    return;
  }
  // 非 Windows / 绿色版：不静默覆盖，改成在资源管理器里定位安装包
  await api.reveal?.({ path: result.path }).catch(() => null);
  setText('.cf23-title', '安装包已下载');
  setText('.cf23-meta', String(install?.error || '请在打开的文件夹里手动安装'));
  setAction('打开文件夹', { disabled: false });
  update.revealPath = result.path;
}

export function initUpdateBubble(deps = {}) {
  void deps;
  try {
    const icon = document.querySelector('.brand-mark');
    if (!icon || icon.dataset.cf23Bound === '1' || !bridge()?.check) return false;
    icon.dataset.cf23Bound = '1';
    icon.setAttribute('role', 'button');
    icon.setAttribute('tabindex', '0');
    icon.setAttribute('title', '检查更新');
    icon.addEventListener('click', () => {
      if (update.busy) return;
      if (update.open && update.data?.hasUpdate) {
        closeBubble();
        return;
      }
      runCheck({ force: true });
    });
    icon.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      runCheck({ force: true });
    });
    // 自动检查：启动 5s 后一次，之后每 6h 一次；只在主窗口形态下自动弹，且同一版本被"稍后"过就不再打扰
    const auto = async () => {
      const result = await runCheck({ silent: true }).catch(() => null);
      if (!result?.hasUpdate || !result.asset) return;
      if (readDismissed() === result.latest) return;
      if (isIsland()) return;
      openBubble('update', result);
    };
    update.autoTimer = window.setTimeout(() => {
      auto();
      update.autoTimer = window.setInterval(auto, AUTO_CHECK_EVERY_MS);
    }, AUTO_CHECK_DELAY_MS);
    return true;
  } catch (error) {
    console.warn('[CineFlow] 更新检查装配失败，已跳过', error);
    return false;
  }
}
