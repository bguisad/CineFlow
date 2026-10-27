const ENTER_MS = 360;
const SWITCH_MS = ENTER_MS + 90;
const WARM_OPACITY = 0.012;

function wrapIndex(value, size) {
  return ((value % size) + size) % size;
}

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
      el.classList.add('cf3-warm');
    }
    el.style.visibility = 'visible';

    el.style.opacity = '1';
    el.inert = false;
    return el;
  }

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

    }
    window.setTimeout(run, fallbackMs);
    return run;
  }

  function framesUnstable() {
    return document.body.classList.contains('is-motion-throttled');
  }

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
    if (switching) finalizeSwitch();
    if (reducedMotion) {
      swapInstantly(index);
      return;
    }

    const from = current;

    const forward = typeof forwardHint === 'boolean' ? forwardHint : index > from;

    const entering = index === 0 ? null : mountPage(index);
    if (index !== 0) pages[index].prepare?.();
    const leaving = from === 0 ? null : pageEl(from);

    if (entering) entering.style.zIndex = '2';
    if (leaving) leaving.style.zIndex = '1';
    layer.classList.add('is-switching');
    if (from === 0 || index === 0) layer.classList.add('is-home-edge');
    document.body.classList.add('cf3-switching');
    switching = { from, to: index, entering, leaving, timer: 0 };

    const start = () => {
      if (!switching || switching.from !== from || switching.to !== index) return;
      if (entering) {
        entering.style.opacity = '1';
        entering.classList.add('cf3-enter', forward ? 'is-forward' : 'is-backward');
      }

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

    current = to;
    applyRestState();
    if (entering) entering.style.zIndex = '';
    if (leaving) leaving.style.zIndex = '';
    layer.classList.remove('is-switching', 'is-home-edge');
    document.body.classList.remove('cf3-switching');
    pages[from].leave?.();
    pages[from].settle?.();
    onSwitch?.(to);
    warmOthers();
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

      applyRestState();
      warm(index);
    },
    dispose() {
      if (switching) finalizeSwitch();
      layer.remove();
    },
  };
}
