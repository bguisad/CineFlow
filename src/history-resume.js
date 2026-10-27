const DETAIL_WAIT_MS = 6000;
const RESOURCE_WAIT_MS = 20000;
const PLAYER_WAIT_MS = 15000;
const SEEK_WAIT_MS = 25000;
const POLL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function detailOpen() {
  return Boolean(document.querySelector('#detailPanel')?.classList.contains('is-open'));
}

function playerOpen() {
  return Boolean(document.querySelector('#playerModal')?.classList.contains('is-open'));
}

function resourceList() {
  return document.querySelector('#resourceResults');
}

function videoEl() {
  return document.querySelector('#resourcePlayer');
}

function textOf(node) {
  return (node?.textContent || '').replace(/\s+/g, ' ').trim();
}

function notify(message) {
  const el = document.querySelector('#toast');
  if (!el || !message) return;
  el.textContent = message;
  el.classList.remove('is-hidden');
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => el.classList.add('is-hidden'), 2600);
}

function pickPlayButton(item) {
  const list = resourceList();
  if (!list) return null;
  const cards = [...list.querySelectorAll('.resource-card')];
  if (!cards.length) return null;
  const cardsRanked = cards
    .map((card, index) => {
      const source = textOf(card.querySelector('.resource-card-head strong'));
      return { card, index, rank: item.sourceName && source === item.sourceName ? 0 : 1 };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  let fallback = null;
  let lineHit = null;
  for (const { card } of cardsRanked) {
    const buttons = [...card.querySelectorAll('[data-play-url]')];
    for (const button of buttons) {
      const line = button.getAttribute('data-player-line') || '';
      const label = button.getAttribute('data-player-label') || '';
      if (item.label && label === item.label && (!item.lineName || line === item.lineName)) return { button, exact: true };
      if (!lineHit && item.lineName && line === item.lineName) lineHit = { button, exact: false };
      if (!fallback) fallback = { button, exact: false };
    }
  }
  return lineHit || fallback;
}

function pickEpisodeButton(item) {
  const buttons = [...document.querySelectorAll('.player-episode-button')];
  if (!buttons.length) return null;
  const byLabel = item.label
    ? buttons.find((button) => (button.getAttribute('title') || '').trim() === item.label)
    : null;
  if (byLabel) return byLabel;
  if (Number.isFinite(Number(item.episodeIndex)) && Number(item.episodeIndex) > 0) {
    const byIndex = buttons.find((button) => Number(button.dataset.playerEpisodeIndex) === Number(item.episodeIndex));
    if (byIndex && (!item.label || (byIndex.getAttribute('title') || '').includes(item.label))) return byIndex;
  }
  return null;
}

async function waitFor(check, timeoutMs, isCancelled) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCancelled()) return null;
    const value = check();
    if (value) return value;
    if (resourceList()?.querySelector('.resource-empty')) return null;
    await sleep(POLL_MS);
  }
  return null;
}

async function seekTo(target, isCancelled) {
  const deadline = Date.now() + SEEK_WAIT_MS;
  while (Date.now() < deadline) {
    if (isCancelled()) return false;
    const video = videoEl();
    if (video && playerOpen()) {
      const duration = Number(video.duration) || 0;
      if (duration > 0 && duration <= target + 2) {

        return false;
      }
      if (duration > 0 && video.readyState >= 1) {
        try {
          video.currentTime = target;
        } catch (error) {

        }
        await sleep(400);
        const now = Number(video.currentTime) || 0;
        if (Math.abs(now - target) <= Math.max(3, target * 0.02)) {
          video.play?.().catch(() => {});
          return true;
        }
      }
    }
    await sleep(POLL_MS);
  }
  return false;
}

export function createHistoryResume({ state } = {}) {
  let runId = 0;

  async function resume(item, trigger) {
    if (!item || !trigger) return false;
    const my = ++runId;
    const cancelled = () => my !== runId;

    trigger.click();
    if (!(await waitFor(detailOpen, DETAIL_WAIT_MS, cancelled))) {
      notify('没能打开介绍页');
      return false;
    }
    const picked = await waitFor(() => pickPlayButton(item), RESOURCE_WAIT_MS, cancelled);
    if (cancelled()) return false;
    if (!picked) {
      notify('没找到上次的播放源');
      return false;
    }
    picked.button.click();
    if (!(await waitFor(playerOpen, PLAYER_WAIT_MS, cancelled))) {
      notify('这个源没能打开播放器');
      return false;
    }
    if (item.mediaType === 'tv' && !picked.exact) {
      const episode = await waitFor(() => pickEpisodeButton(item), 4000, cancelled);
      if (cancelled()) return false;
      if (episode) {
        episode.click();
        await waitFor(playerOpen, PLAYER_WAIT_MS, cancelled);
      }
    }
    const progress = Number(item.progress) || 0;
    if (!progress) return true;
    const ok = await seekTo(progress, cancelled);
    if (cancelled()) return false;
    if (!ok && state?.player?.open) notify('已从头开始播放');
    return ok;
  }

  return {
    resume,
    cancel() {
      runId += 1;
    },
  };
}
