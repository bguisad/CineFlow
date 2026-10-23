// v3.4.0 纯增量：三页切换引擎（首页 / 分类片库 / 播放历史）
// 三页都是不透明整屏板：切换 = 新页整块推入（只位移、全程不透明）+ 旧页同向退暗，
// 只有回首页时旧页才真的淡出。没有快照切片、没有逐帧 JS 动画循环：软件渲染下主线程一帧都不参与动效计算。
// 第九轮：底部 Tab 栏与左右虫洞都去掉了，切页只认键盘左右方向键（Alt+1/2/3 仍可直接跳转）。
// 第十一轮：三页排成环——首页在中间，→ 走 分类片库→播放历史→首页 循环，← 反过来走 播放历史→分类片库→首页 循环。

const ENTER_MS = 360; // 与 CSS 的 --cf3-enter-ms 成对：动效一摘就要正好落到静息态
const SWITCH_MS = ENTER_MS + 90; // 收尾兜底时长，动效绝不会把界面留在半空
const WARM_OPACITY = 0.012; // 肉眼看不出的"露一点点"，只为逼合成器把整页栅格化一次

// 环回取模：两端都不封顶，跨界那一步的方向仍由按键决定
function wrapIndex(value, size) {
  return ((value % size) + size) % size;
}

// 基线浮层开着的时候，方向键归浮层自己用，这一层不抢
function overlayOpen() {
  const open = ['.player-modal.is-open', '.detail-panel.is-open', '.favorites-panel.is-open', '.cast-panel.is-open'];
  if (open.some((selector) => document.querySelector(selector))) return true;
  const settings = document.querySelector('#settingsModal');
  return Boolean(settings && !settings.classList.contains('is-hidden') && getComputedStyle(settings).display !== 'none');
}

function typingAt() {
  const active = document.activeElement;
  if (!active) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true;
  return Boolean(active.isContentEditable);
}

export function createPageTransition({ root, pages, onSwitch } = {}) {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

  const layer = document.createElement('div');
  layer.className = 'cf3-stage';
  layer.innerHTML = `
    <div class="cf3-veil" aria-hidden="true"></div>
    <div class="cf3-scene"><div class="cf3-slot"></div></div>
  `;
  root.append(layer);

  // 层从标题栏正下方开始（多留 2px 余量），窗口拖拽区一寸都不进这一层
  const titlebar = document.querySelector('.titlebar');
  const syncLayerTop = () => {
    const height = titlebar?.offsetHeight;
    const safe = Number.isFinite(height) && height > 0 ? Math.round(height) + 2 : 76;
    layer.style.top = `${safe}px`;
  };
  syncLayerTop();

  const slot = layer.querySelector('.cf3-slot');

  let current = 0;
  let switching = null;
  let enabled = true;

  function pageEl(index) {
    return pages[index]?.el || null;
  }

  function mountPage(index) {
    const page = pages[index];
    const el = page?.el;
    if (!el) return null;
    if (el.parentElement !== slot) {
      slot.append(el);
      page.activate?.();
      el.classList.add('cf3-warm'); // 常驻提层：动效开始时不再临场建层
    }
    el.style.visibility = 'visible';
    // 入场页是不透明整屏板：静息/动效期间都保持 opacity 1，动效只推位移
    el.style.opacity = '1';
    el.inert = false;
    return el;
  }

  // 帧回调必须带兜底：窗口被遮挡或被节流时 requestAnimationFrame 可以永远不回来，
  // 而这一层是"先画一帧再起跳"的设计 —— 没有兜底就会把切页永久卡在半空
  // （入场页停在 1.2%、stage 留着 is-switching、body 的 cf3-switching 还会把整站点击锁死）。
  function nextFrame(cb, fallbackMs) {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      cb();
    };
    try {
      requestAnimationFrame(run);
    } catch (error) {
      /* 拿不到帧就交给计时器 */
    }
    window.setTimeout(run, fallbackMs);
    return run;
  }

  // 基线自己有个掉帧守卫（renderer.js setupPremiumMotionGuard），它标了就是这台机器此刻不给稳定帧，
  // 那就不等了 —— 层已经预热过，直接起跳，别拿正确性换那一帧。
  function framesUnstable() {
    return document.body.classList.contains('is-motion-throttled');
  }

  // 预热：静息隐藏的页只改 opacity 到 1.2%，逼一次整页栅格化后再压回 0。
  // 不这么做的话，"切进一个从没画过的整屏板"这件事会把动效的头 240~380ms 全吃掉
  // （实测：同步 JS 只花 0~14ms、没有任何长任务，卡顿完全在栅格化侧）。
  function warm(index) {
    const el = pageEl(index);
    if (!el || el.parentElement !== slot || index === current) return;
    if (el.style.opacity !== '0') return;
    el.style.opacity = String(WARM_OPACITY);
    nextFrame(() => {
      if (el.style.opacity === String(WARM_OPACITY)) el.style.opacity = '0';
    }, 90);
  }

  function warmOthers() {
    const idle = window.requestIdleCallback || ((cb) => window.setTimeout(cb, 240));
    idle(() => {
      for (let index = 1; index < pages.length; index += 1) warm(index);
    });
  }

  // 静息态：首页 = 这一层完全透明（基线自己渲染）；其余页 = 真实页面铺满层。
  // 未选中的页只压到 opacity 0，不用 visibility: hidden —— 栅格保留，再次进入时不必整页重画；
  // 不可点、不可聚焦、不进无障碍树这件事交给 inert。
  function applyRestState() {
    const cover = current !== 0;
    for (let index = 1; index < pages.length; index += 1) {
      const el = pageEl(index);
      if (!el || el.parentElement !== slot) continue;
      const active = cover && index === current;
      el.style.visibility = 'visible';
      el.style.opacity = active ? '1' : '0';
      el.inert = !active;
      el.style.zIndex = '';
      el.classList.remove('cf3-enter', 'cf3-leave', 'is-forward', 'is-backward', 'is-cover', 'is-reveal');
    }
  }

  function go(index, forwardHint) {
    if (!enabled || index === current || index < 0 || index >= pages.length) return;
    if (switching) finalizeSwitch(); // 连按不排队：先把上一场落地，再从新位置起跳
    if (reducedMotion) {
      swapInstantly(index);
      return;
    }

    const from = current;
    // 跨界那一步（历史 →首页、首页 →历史）按大小比出来的方向是反的，所以以按键方向为准
    const forward = typeof forwardHint === 'boolean' ? forwardHint : index > from;
    // 首页由基线渲染，进首页时只有离场页；离开首页时只有入场页
    const entering = index === 0 ? null : mountPage(index);
    if (index !== 0) pages[index].prepare?.();
    const leaving = from === 0 ? null : pageEl(from);

    if (entering) entering.style.zIndex = '2';
    if (leaving) leaving.style.zIndex = '1';
    layer.classList.add('is-switching');
    if (from === 0 || index === 0) layer.classList.add('is-home-edge'); // 幕布只在跟首页交界的那一路出现
    document.body.classList.add('cf3-switching');
    switching = { from, to: index, entering, leaving, timer: 0 };

    // 内容先建好、先画一帧，动画再从下一帧起跳：入场页不会因为临场建层而把动效头 300ms 冻住。
    // 这一帧入场页只露 1.2%，看到的仍是旧页 —— 不然会先硬切再倒退着滑一下。
    // 但"等一帧"只在帧稳定时做：帧不回来时必须直接起跳，否则切页会卡死在半空。
    const start = () => {
      if (!switching || switching.from !== from || switching.to !== index) return;
      if (entering) {
        entering.style.opacity = '1';
        entering.classList.add('cf3-enter', forward ? 'is-forward' : 'is-backward');
      }
      // 有页盖住时旧页只退暗（褪到 0 会让首页从两页中间透出来闪一下），回首页那一路才真淡出
      if (leaving) {
        leaving.classList.add('cf3-leave', forward ? 'is-forward' : 'is-backward', index === 0 ? 'is-reveal' : 'is-cover');
      }
      switching.timer = window.setTimeout(finalizeSwitch, SWITCH_MS);
    };
    if (entering && !framesUnstable()) {
      void entering.offsetHeight;
      entering.style.opacity = String(WARM_OPACITY);
      nextFrame(start, 40);
    } else {
      start();
    }
  }

  function finalizeSwitch() {
    if (!switching) return;
    const { from, to, entering, leaving } = switching;
    clearTimeout(switching.timer);
    switching = null;
    // 先写好静息内联值再摘动效类，同一帧内完成，收尾不会有闪白
    current = to;
    applyRestState();
    if (entering) entering.style.zIndex = '';
    if (leaving) leaving.style.zIndex = '';
    layer.classList.remove('is-switching', 'is-home-edge');
    document.body.classList.remove('cf3-switching');
    pages[from].leave?.();
    pages[from].settle?.(); // 离开的页顺手收起自己的浮层，回来时不会挡着
    onSwitch?.(to);
    warmOthers(); // 刚离开的那一页马上补热，下一次切回来同样不掉帧
  }

  function swapInstantly(index) {
    if (switching) finalizeSwitch();
    pages[current].leave?.();
    current = index;
    if (index !== 0) {
      mountPage(index);
      pages[index].prepare?.();
    }
    applyRestState();
    onSwitch?.(index);
  }

  function step(delta) {
    go(wrapIndex(current + delta, pages.length), delta > 0);
  }

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!enabled || overlayOpen() || typingAt()) return;
      const position = event.altKey ? ['1', '2', '3'].indexOf(event.key) : -1;
      const arrow = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (position === -1 && !arrow) return;
      // 首页上的左右键原本没有别的用途（基线不监听方向键），这里整把接过来
      event.preventDefault();
      if (position !== -1) go(position);
      else step(arrow);
    },
    true,
  );

  window.addEventListener('resize', () => {
    syncLayerTop();
    if (switching) finalizeSwitch();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && switching) finalizeSwitch();
  });

  function setEnabled(next) {
    if (next === enabled) return;
    enabled = next;
    if (!next) {
      if (switching) finalizeSwitch();
      current = 0;
      applyRestState();
      return;
    }
    applyRestState();
  }

  applyRestState();

  return {
    layer,
    slot,
    go,
    step,
    setEnabled,
    getCurrent: () => current,
    isSwitching: () => Boolean(switching),
    preload(index) {
      if (switching || index === current) return;
      if (!mountPage(index)) return;
      // 只挂载不露出：静息态会把非当前页压回 opacity 0 + inert，栅格借此提前落好
      applyRestState();
      warm(index);
    },
    dispose() {
      if (switching) finalizeSwitch();
      layer.remove();
    },
  };
}
