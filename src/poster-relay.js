const RELAY_HOSTS = ['image.tmdb.org', 'static-1.themoviedb.org', 'media.themoviedb.org'];
const MAX_CONCURRENT = 4;
const WATCHDOG_MS = 2600;

const SMALL_POSTER_RE = /\/t\/p\/(w92|w154|w185|w342|w500)\//;

let running = 0;
const queue = [];

function pump(api) {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running += 1;
    job(api).finally(() => {
      running -= 1;
      pump(api);
    });
  }
}

function isPosterUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl, window.location.href);
    return parsed.protocol === 'https:' && RELAY_HOSTS.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function relayJob(img, sourceUrl) {
  return async (api) => {
    try {
      const result = await api.relayImage(sourceUrl);
      if (!result?.ok || !result.base64) return;
      if (!img.isConnected) return;
      img.src = `data:${result.contentType || 'image/jpeg'};base64,${result.base64}`;
    } catch {

    }
  };
}

function enqueue(img, sourceUrl) {
  if (img.dataset.cfRelayed || !isPosterUrl(sourceUrl)) return;
  img.dataset.cfRelayed = '1';
  queue.push(relayJob(img, sourceUrl));
  pump(getApi());
}

let api = null;
function getApi() {
  return api;
}

function watch(img) {
  const sourceUrl = img.getAttribute('src') || '';
  if (!isPosterUrl(sourceUrl) || img.dataset.cfRelayed) return;
  if (img.complete && img.naturalWidth > 0) return;
  if (!SMALL_POSTER_RE.test(sourceUrl)) return;
  window.setTimeout(() => {
    if ((img.complete && img.naturalWidth > 0) || !img.isConnected) return;
    enqueue(img, sourceUrl);
  }, WATCHDOG_MS);
}

function scanNode(node) {
  if (node.nodeType !== 1) return;
  if (node.tagName === 'IMG') watch(node);
  node.querySelectorAll?.('img[src]').forEach(watch);
}

export function initPosterRelay({ api: bridgeApi } = {}) {
  if (!bridgeApi?.relayImage) return false;
  api = bridgeApi;
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    enqueue(img, img.getAttribute('src') || img.src || '');
  }, true);
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target.tagName === 'IMG') {
          watch(record.target);
          continue;
        }
        record.addedNodes.forEach(scanNode);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    document.querySelectorAll('img[src]').forEach(watch);
  }
  return true;
}
