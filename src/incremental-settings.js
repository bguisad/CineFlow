const CARET_VAR = '--cf4-caret-x';
const GAP = 10;

const ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5.87 21.045h2.923l.959-3.068h4.503l.949 3.068h2.922L11.94 2.955l-6.07 18.09zm6.162-10.12 1.543 4.917h-3.153l1.553-4.916h.057zM24 17.617l-.378-1.182-6.266-.59.733 2.127 5.91-.354zM6.644 15.843l-6.266.591L0 17.616l5.911.355.733-2.128z"/>
  </svg>
`;

function mountSettingsBubble() {
  const title = document.querySelector('#settingsTitle');
  const stateNode = document.querySelector('#settingsState');
  const card = document.querySelector('.settings-card');
  const modal = document.querySelector('#settingsModal');
  if (!title || !stateNode || !card || !modal) return false;
  if (title.dataset.cf4SettingsBubble === '1') return true;
  title.dataset.cf4SettingsBubble = '1';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cf4-config-btn';
  button.setAttribute('aria-label', '查看当前配置');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = ICON;
  title.append(button);

  const bubble = document.createElement('div');
  bubble.className = 'cf4-bubble';
  bubble.setAttribute('role', 'status');
  bubble.append(stateNode);
  card.append(bubble);

  const isOpen = () => bubble.classList.contains('is-open');

  const CARET_INSET = 16;
  const CARD_INSET = 24;
  function place() {
    const cardRect = card.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const width = bubble.offsetWidth;
    if (!cardRect.width || !buttonRect.width || !width) return;
    bubble.style.top = `${Math.round(titleRect.bottom - cardRect.top) + GAP}px`;
    const wanted = Math.round(cardRect.right - buttonRect.right);
    const maxRight = Math.max(0, Math.round(cardRect.width - CARD_INSET - width));
    const right = Math.min(wanted, maxRight);
    bubble.style.right = `${right}px`;
    const bubbleLeft = cardRect.right - right - width;
    const caret = buttonRect.left + buttonRect.width / 2 - bubbleLeft;
    bubble.style.setProperty(CARET_VAR, `${Math.round(Math.min(Math.max(caret, CARET_INSET), width - CARET_INSET))}px`);
  }

  function show() {
    place();
    bubble.classList.add('is-open');
    bubble.inert = false;
    button.setAttribute('aria-expanded', 'true');
  }

  function hide() {
    if (!isOpen()) return;
    bubble.classList.remove('is-open');
    bubble.inert = true;
    button.setAttribute('aria-expanded', 'false');
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (isOpen()) hide();
    else show();
  });

  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('.cf4-config-btn, .cf4-bubble')) return;
    hide();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });

  new MutationObserver(() => {
    if (modal.classList.contains('is-hidden')) hide();
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });

  window.addEventListener('resize', () => {
    if (isOpen()) place();
  });

  bubble.inert = true;
  return true;
}

function simplifySettings({ api, state } = {}) {
  const title = document.querySelector('#settingsTitle');
  if (title && title.dataset.cf5Title !== '1') {
    title.dataset.cf5Title = '1';
    const text = Array.from(title.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim()
    );
    if (text) text.nodeValue = '设置';
  }

  if (!api?.saveResourceMode || state?.resourceSettings?.mode === 'full') return;
  Promise.resolve(api.saveResourceMode('full'))
    .then((next) => {
      if (!next || !state) return;
      state.resourceSettings = { ...state.resourceSettings, ...next };
      if (state.credential) state.credential.resources = state.resourceSettings;
    })
    .catch(() => {   });
}

export function initIncrementalSettings(deps = {}) {
  try {
    const mounted = mountSettingsBubble();
    simplifySettings(deps);
    return mounted;
  } catch (error) {
    console.warn('[CineFlow] 设置页配置气泡装配失败，已跳过', error);
    return false;
  }
}
