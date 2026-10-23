/**
 * v3.4.2 纯增量：详情页秒开预热。
 *
 * 基线 openDetails()（renderer.js:2020）会先铺骨架、再 await getMovieDetails() ——
 * 所以"点开慢"主要慢在这一次 TMDB 详情请求（约 200~900ms）以及打开后海报/剧照要现拉。
 * 基线自己只在 hover 时 preloadDetails（且并发上限 2、idle 调度），够不到三种场景：
 *   ① 鼠标直接点下去、没停够时间；② 触控板/键盘选中；③ 片源列表要等详情渲染完才开轮询。
 *
 * 这一层做三件事，全部走基线已有的 IPC（因此填的是同一条主进程缓存）：
 *   预热详情：卡片渲染出来就排队（每批最多 8 张、idle 执行、并发 2），悬停/聚焦再补一次；
 *   预热图片：详情回来后，把海报、剧照、前 6 位演员头像、前 8 部推荐海报丢进浏览器缓存；
 *   预热片源：悬停停留 350ms 后，用与基线**完全相同**的 payload 调一次 findMovieResources
 *            （round 16 的 60s 合并缓存会命中），于是点开后片源列表几乎立刻出现。
 *
 * 只在有 TMDB 凭证时预热片源；任何失败静默跳过。摘掉本文件 + incremental-pages.js 的两行挂钩即回退。
 */

const IDLE_TIMEOUT_MS = 800;
const DETAIL_TTL_MS = 4 * 60 * 1000;
const DETAIL_CONCURRENCY = 2;
const RESOURCE_HOVER_DELAY_MS = 350;
const MAX_PREFETCH_IMAGES = 20;
const IMAGE_BASE = 'https://image.tmdb.org/t/p/';

const entries = new Map(); // key -> { at, details, resourceAt }
const imageSeen = new Set();
let detailActive = 0;
let resourceActive = 0;
let credential = { configured: false, checkedAt: 0 };
let started = false;

const idle = (callback) => (window.requestIdleCallback  ? window.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS })
  : window.setTimeout(callback, 60));

function cardMovie(card) {
  const id = String(card?.dataset?.movieId || '').trim();
  const mediaType = card?.dataset?.mediaType === 'tv' ? 'tv' : 'movie';
  if (!/^\d+$/.test(id)) return null;
  const title = (card.querySelector('h3')?.textContent || '').trim();
  return { id: Number(id), mediaType, title };
}

function prefetchImage(path, size) {
  if (!path) return;
  const url = `${IMAGE_BASE}${size}${path}`;
  if (imageSeen.has(url) || imageSeen.size > 600) return;
  imageSeen.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
}

function warmImages(details) {
  prefetchImage(details.posterPath, 'w500');
  prefetchImage(details.backdropPath, 'w780');
  const cast = Array.isArray(details.cast) ? details.cast.slice(0, 6) : [];
  const recs = Array.isArray(details.recommendations) ? details.recommendations.slice(0, 8) : [];
  const similar = Array.isArray(details.similar) ? details.similar.slice(0, 6) : [];
  for (const person of cast) prefetchImage(person.profilePath, 'w185');
  for (const movie of recs) prefetchImage(movie.posterPath, 'w185');
  for (const movie of similar) prefetchImage(movie.posterPath, 'w185');
  if (imageSeen.size > MAX_PREFETCH_IMAGES * 30) imageSeen.clear();
}

async function credentialConfigured() {
  if (Date.now() - credential.checkedAt < 60 * 1000) return credential.configured;
  try {
    const state = await window.cineflow.getCredentialState();
    credential = { configured: Boolean(state?.configured), checkedAt: Date.now() };
  } catch {
    credential = { configured: false, checkedAt: Date.now() };
  }
  return credential.configured;
}

function resourceSearchPayload(details) {
  return {
    id: details.id,
    mediaType: details.mediaType === 'tv' ? 'tv' : 'movie',
    title: details.title,
    originalTitle: details.originalTitle,
    releaseDate: details.releaseDate,
    year: String(details.releaseDate || '').slice(0, 4)
  };
}

async function prefetchResources(details) {
  if (!(await credentialConfigured())) return;
  const entry = entries.get(`${details.mediaType || 'movie'}:${details.id}`);
  if (entry && Date.now() - entry.resourceAt < DETAIL_TTL_MS) return;
  if (resourceActive >= 1) return;
  resourceActive += 1;
  try {
    await window.cineflow.findMovieResources(resourceSearchPayload(details), { cursor: 0, limit: 3 });
    if (entry) entry.resourceAt = Date.now();
  } catch {
    /* 源站慢/关闭资源查找都不影响 */
  } finally {
    resourceActive -= 1;
  }
}

async function prefetchDetails(movie, { resources = false } = {}) {
  if (!movie) return null;
  const key = `${movie.mediaType}:${movie.id}`;
  const entry = entries.get(key);
  if (entry && Date.now() - entry.at < DETAIL_TTL_MS) {
    if (resources) prefetchResources(entry.details).catch(() => {});
    return entry.details;
  }
  if (detailActive >= DETAIL_CONCURRENCY) return null;
  detailActive += 1;
  try {
    const details = await window.cineflow.getMovieDetails(movie.id, { mediaType: movie.mediaType });
    if (!details) return null;
    entries.set(key, { at: Date.now(), details, resourceAt: 0 });
    if (entries.size > 120) entries.delete(entries.keys().next().value);
    warmImages(details);
    if (resources) prefetchResources(details).catch(() => {});
    return details;
  } catch {
    entries.set(key, { at: Date.now(), details: null, resourceAt: 0 });
    return null;
  } finally {
    detailActive -= 1;
  }
}

function scheduleCard(card, { resources = false, delay = 0 } = {}) {
  const movie = cardMovie(card);
  if (!movie) return;
  const run = () => idle(() => { prefetchDetails(movie, { resources }); });
  if (delay > 0) window.setTimeout(run, delay);
  else run();
}

function mountDetailPrewarm() {
  if (started) return true;
  if (!document.querySelector('#app') || !window.cineflow?.getMovieDetails) return false;
  started = true;

  let hoverTimer = 0;
  let hoverCard = null;
  const cancelHover = () => {
    window.clearTimeout(hoverTimer);
    hoverTimer = 0;
    hoverCard = null;
  };

  // 渲染即排队：每批最多 8 张，idle 执行，避免抢首屏自己的网络
  const observer = new MutationObserver((records) => {
    const cards = [];
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.('.movie-card')) cards.push(node);
        cards.push(...Array.from(node.querySelectorAll?.('.movie-card') || []));
      }
    }
    for (const card of cards.slice(0, 8)) scheduleCard(card);
  });
  observer.observe(document.querySelector('#app'), { childList: true, subtree: true });

  // 首屏已有的卡片
  for (const card of Array.from(document.querySelectorAll('.movie-card')).slice(0, 8)) scheduleCard(card);

  document.addEventListener('pointerover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest('.movie-card');
    if (!card || card === hoverCard) return;
    const related = event.relatedTarget;
    if (related instanceof Node && card.contains(related)) return;
    cancelHover();
    hoverCard = card;
    scheduleCard(card);
    hoverTimer = window.setTimeout(() => {
      if (hoverCard === card) scheduleCard(card, { resources: true });
    }, RESOURCE_HOVER_DELAY_MS);
  }, { passive: true });

  document.addEventListener('pointerout', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest('.movie-card');
    if (!card) return;
    const related = event.relatedTarget;
    if (related instanceof Node && card.contains(related)) return;
    if (card === hoverCard) cancelHover();
  }, { passive: true });

  document.addEventListener('focusin', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest('.movie-card');
    if (card) scheduleCard(card, { resources: true });
  });

  return true;
}

export function initDetailPrewarm(deps = {}) {
  void deps;
  try {
    return mountDetailPrewarm();
  } catch (error) {
    console.warn('[CineFlow] 详情页预热装配失败，已跳过', error);
    return false;
  }
}
