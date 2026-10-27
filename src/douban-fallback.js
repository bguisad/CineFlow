const POSTER_TTL_MS = 30 * 60 * 1000;
const POSTER_WATCHDOG_MS = 4500;
const posterCache = new Map();
const posterInflight = new Map();
const imageCache = new Map();
const sheetState = { item: null, open: false };
let state = null;
let mounted = false;

const clean = (value) => String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
const DOUBAN_IMAGE_RE = /^https:\/\/[a-z0-9-]+\.doubanio\.com\//i;

function bridge() {
  return window.cineflowDouban;
}

function cardMeta(card) {
  const title = clean(card.querySelector('h3')?.textContent);
  if (!title) return null;
  const line = clean(card.querySelector('p')?.textContent);
  const year = (/^(19|20)\d{2}/.exec(line) || [])[0] || '';
  const mediaType = card.dataset.mediaType === 'tv' ? 'tv' : 'movie';
  return { title, year, mediaType };
}

async function doubanImageDataUrl(url) {
  const target = String(url || '');
  if (!DOUBAN_IMAGE_RE.test(target)) return '';
  if (imageCache.has(target)) return imageCache.get(target);
  const result = await bridge()?.image({ url: target }).catch(() => null);
  const data = result?.ok ? `data:${result.contentType || 'image/jpeg'};base64,${result.base64}` : '';
  if (data) imageCache.set(target, data);
  return data;
}

function everyfilmBridge() {
  return window.cineflowEveryfilm;
}

async function everyfilmPoster({ title, year, mediaType, wantDataUrl = true } = {}) {
  const bridge = everyfilmBridge();
  if (!bridge?.lookup || !title) return '';
  const result = await bridge.lookup({ query: title, year, type: mediaType }).catch(() => null);
  const url = /^https:\/\//i.test(String(result?.item?.poster || '')) ? result.item.poster : '';
  if (!url) return '';
  if (!wantDataUrl) return url;
  if (imageCache.has(url)) return imageCache.get(url);
  const bytes = await bridge.image({ url }).catch(() => null);
  const data = bytes?.ok ? `data:${bytes.contentType || 'image/jpeg'};base64,${bytes.base64}` : '';
  if (data) imageCache.set(url, data);
  return data;
}

function firstSettledValue(sources) {
  return new Promise((resolve) => {
    let finished = 0;
    let taken = false;
    for (const make of sources) {
      Promise.resolve()
        .then(make)
        .then((value) => {
          if (!taken && value) { taken = true; resolve(value); }
        })
        .catch(() => {})
        .then(() => {
          finished += 1;
          if (!taken && finished >= sources.length) resolve('');
        });
    }
  });
}

async function doubanPosterPath({ title, year, mediaType, cover = '' }) {
  if (DOUBAN_IMAGE_RE.test(String(cover || ''))) {

    return await doubanImageDataUrl(cover);
  }
  const result = await bridge()?.poster({ title, year, type: mediaType }).catch(() => null);
  return result?.ok ? await doubanImageDataUrl(result.url) : '';
}

async function resolvePoster({ title, year, mediaType, cover = '' }) {
  const key = `${mediaType}:${title}:${year}`;
  if (posterCache.has(key)) {
    const cached = posterCache.get(key);
    if (cached && Date.now() - cached.at > POSTER_TTL_MS) posterCache.delete(key);
    else return cached?.data || '';
  }
  if (posterInflight.has(key)) return posterInflight.get(key);
  const hasCover = DOUBAN_IMAGE_RE.test(String(cover || ''));
  const task = (async () => {
    try {

      const sources = hasCover
        ? [() => doubanPosterPath({ title, year, mediaType, cover })]
        : [
          () => everyfilmPoster({ title, year, mediaType }),
          () => doubanPosterPath({ title, year, mediaType, cover })
        ];
      const data = await firstSettledValue(sources);

      posterCache.set(key, data ? { at: Date.now(), data } : { at: Date.now() - POSTER_TTL_MS + 60 * 1000, data: '' });
      if (posterCache.size > 300) posterCache.delete(posterCache.keys().next().value);
      return data;
    } finally {
      posterInflight.delete(key);
    }
  })();
  posterInflight.set(key, task);
  return task;
}

function applyPoster(card, dataUrl) {
  if (!dataUrl) {
    card.dataset.cf8Poster = '';
    return;
  }
  const frame = card.querySelector('.poster-frame');
  if (!frame) return;
  let img = frame.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    img.alt = `${clean(card.querySelector('h3')?.textContent)} 海报`;
    img.decoding = 'async';

    img.loading = 'eager';
    frame.insertBefore(img, frame.firstChild);
  }
  img.classList.add('cf8-poster-loaded');
  img.src = dataUrl;
  card.dataset.cf8Poster = 'douban';
}

async function patchCardPoster(card) {
  if (!(card instanceof Element) || card.dataset.cf8Poster === 'douban') return;
  const meta = cardMeta(card);
  if (!meta) return;
  const img = card.querySelector('.poster-frame img');
  const broken = !img || (img.complete && img.naturalWidth === 0);
  if (img && !broken) {
    if (card.dataset.cf8PosterWatch) return;
    card.dataset.cf8PosterWatch = '1';
    const giveUp = () => {

      if (img.complete && img.naturalWidth > 0) return;
      card.dataset.cf8PosterWatch = '';
      delete card.dataset.cf8Poster;
      patchCardPoster(card);
    };
    img.addEventListener('load', () => { card.dataset.cf8PosterWatch = ''; }, { once: true });
    img.addEventListener('error', () => {

      card.dataset.cf8PosterWatch = '';
      delete card.dataset.cf8Poster;
      patchCardPoster(card);
    }, { once: true });
    window.setTimeout(giveUp, POSTER_WATCHDOG_MS);
    return;
  }
  card.dataset.cf8Poster = 'pending';
  const dataUrl = await resolvePoster({ ...meta, cover: card.__cf8Item?.cover || '' });
  applyPoster(card, dataUrl);
}

let posterObserver = null;
const posterWaiters = new WeakMap();
function queuePoster(card) {
  if (!('IntersectionObserver' in window)) {
    patchCardPoster(card);
    return;
  }
  if (posterWaiters.get(card)) return;
  posterWaiters.set(card, true);
  if (!posterObserver) {
    posterObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        posterObserver.unobserve(entry.target);
        posterWaiters.delete(entry.target);
        patchCardPoster(entry.target);
      }
    }, { rootMargin: '320px 0px' });
  }
  posterObserver.observe(card);
}

function scanPosters(root = document) {
  for (const card of root.querySelectorAll('.movie-card')) queuePoster(card);
}

export function openDoubanSheet(item = {}) {
  return openSheet({
    id: item.cf8Id || item.id,
    title: item.title,
    mediaType: item.mediaType === 'tv' ? 'tv' : 'movie',
    cover: item.cf8Cover || item.posterPath || '',
    rating: item.cf8Rating || (item.voteAverage ? Number(item.voteAverage).toFixed(1) : ''),
    year: String(item.releaseDate || '').slice(0, 4)
  });
}

function ensureSheet() {
  let sheet = document.querySelector('.cf8-sheet');
  if (sheet) return sheet;
  const app = document.querySelector('#app');
  if (!app) return null;
  sheet = document.createElement('div');
  sheet.className = 'cf8-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.setAttribute('aria-label', '豆瓣影片资料');
  sheet.innerHTML = `
    <div class="cf8-sheet-card">
      <button type="button" class="cf8-sheet-close" aria-label="关闭">×</button>
      <div class="cf8-sheet-poster"><div class="cf8-sheet-ph">豆瓣</div></div>
      <div class="cf8-sheet-body">
        <h3 class="cf8-sheet-title"></h3>
        <p class="cf8-sheet-meta"></p>
        <p class="cf8-sheet-intro"></p>
        <div class="cf8-sheet-cast"></div>
        <div class="cf21-play" hidden>
          <div class="cf21-play-head">
            <span class="cf21-badge"></span>
            <span class="cf21-play-meta"></span>
          </div>
          <p class="cf21-status"></p>
          <div class="cf21-play-lines"></div>
        </div>
        <p class="cf8-sheet-note">豆瓣数据</p>
        <p class="cf16-sheet-credit" hidden><button type="button" class="cf16-credit-link">every.film</button><span>海报与评分 · CC-BY-SA 4.0</span></p>
      </div>
    </div>
  `;
  app.append(sheet);
  sheet.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.cf16-credit-link')) {
      window.cineflow?.openExternal?.('https://every.film/zh-CN');
      return;
    }
    if (target.closest('.cf21-ep')) {
      event.preventDefault();
      event.stopPropagation();
      playFromSheet(target.closest('.cf21-ep'));
      return;
    }
    if (target.closest('.cf8-sheet-close') || target === sheet) closeSheet();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sheetState.open) closeSheet();
  });
  return sheet;
}

function closeSheet() {
  const sheet = document.querySelector('.cf8-sheet');
  sheet?.classList.remove('is-open');
  sheet?.setAttribute('aria-hidden', 'true');
  sheetState.open = false;
}

async function openSheet(item) {
  const sheet = ensureSheet();
  if (!sheet || !item) return;
  sheetState.open = true;
  sheet.classList.add('is-open');
  sheet.setAttribute('aria-hidden', 'false');
  const credit = sheet.querySelector('.cf16-sheet-credit');
  if (credit) credit.hidden = true;
  sheet.querySelector('.cf8-sheet-title').textContent = item.title || '';
  sheet.querySelector('.cf8-sheet-meta').textContent = [item.year, item.rating ? `★ ${item.rating}` : '', item.mediaType === 'tv' ? '剧集' : '电影'].filter(Boolean).join(' · ');
  sheet.querySelector('.cf8-sheet-intro').textContent = '';
  sheet.querySelector('.cf8-sheet-cast').textContent = '';
  const posterBox = sheet.querySelector('.cf8-sheet-poster');
  posterBox.querySelector('img')?.remove();

  resetPlayBlock();
  setSheetNote('豆瓣数据');
  playState.run += 1;
  loadPlaySource(item);

  const coverUrl = item.cover || item.cf8Cover || '';
  const cover = coverUrl ? await doubanImageDataUrl(coverUrl) : '';
  if (cover) {
    const img = document.createElement('img');
    img.src = cover;
    img.alt = `${item.title} 海报`;
    posterBox.appendChild(img);
  }

  const subject = await bridge()?.subject({ id: item.id, type: item.mediaType }).catch(() => null);
  if (!subject?.ok) {

    await enrichSheetWithEveryfilm(sheet, item);
    retryPlaySource(item, sheet.querySelector('.cf8-sheet-title').textContent);
    return;
  }
  const data = subject.subject;
  sheet.querySelector('.cf8-sheet-title').textContent = data.titleWithYear || item.title;
  sheet.querySelector('.cf8-sheet-meta').textContent = [
    data.rating ? `★ ${data.rating}` : '',
    data.genres.join(' / '),
    data.region,
    data.duration,
    data.episodes ? `${data.episodes} 集` : ''
  ].filter(Boolean).join(' · ');
  sheet.querySelector('.cf8-sheet-intro').textContent = data.intro || '';
  const cast = [
    data.directors.length ? `导演：${data.directors.join(' / ')}` : '',
    data.actors.length ? `主演：${data.actors.slice(0, 5).join(' / ')}` : ''
  ].filter(Boolean).join('\n');
  sheet.querySelector('.cf8-sheet-cast').textContent = cast;

  retryPlaySource({ ...item, year: data.year || item.year, mediaType: data.mediaType || item.mediaType }, data.title || item.title);
}

function retryPlaySource(item, title) {
  const block = document.querySelector('.cf21-play');
  if (!block || !block.__cf21Done || block.__cf21Resource) return;
  const year = clean(item?.year);
  if (!year || block.__cf21AskedYear === year) return;
  block.__cf21AskedYear = year;
  loadPlaySource({ ...item, title: clean(title) || item.title });
}

async function enrichSheetWithEveryfilm(sheet, item) {
  const bridge = everyfilmBridge();
  if (!bridge?.lookup) return;
  const result = await bridge.lookup({ query: item.title, year: item.year, type: item.mediaType }).catch(() => null);
  if (!result?.ok || !result.item) return;
  const meta = result.item.meta || {};
  const title = meta.zhTitle || result.item.title;
  if (title) sheet.querySelector('.cf8-sheet-title').textContent = [title, meta.year || result.item.year].filter(Boolean).join(' ');
  const fused = Number(meta.tmdbRating || result.item.rating);
  if (Number.isFinite(fused) && fused > 0) {
    const line = sheet.querySelector('.cf8-sheet-meta').textContent;
    sheet.querySelector('.cf8-sheet-meta').textContent = [`★ ${fused.toFixed(1)}`, line].filter(Boolean).join(' · ');
  }
  const poster = /^https:\/\//i.test(String(result.item.poster || '')) ? result.item.poster : '';
  if (poster && !sheet.querySelector('.cf8-sheet-poster img')) {
    const bytes = await everyfilmBridge()?.image?.({ url: poster }).catch(() => null);
    if (bytes?.ok) {
      const img = document.createElement('img');
      img.src = `data:${bytes.contentType || 'image/jpeg'};base64,${bytes.base64}`;
      img.alt = `${title || item.title} 海报`;
      sheet.querySelector('.cf8-sheet-poster').appendChild(img);
    }
  }
  if (poster || Number.isFinite(fused)) {
    const credit = sheet.querySelector('.cf16-sheet-credit');
    if (credit) credit.hidden = false;
  }
}

const playState = { seq: 0, run: 0 };
const VISIBLE_LINE_LIMIT = 3;
const VISIBLE_EPISODE_LIMIT = 12;

function episodeNumberOf(label, index) {
  const match = /(\d+)/.exec(String(label || ''));
  return Number(match?.[1]) || index + 1;
}

function episodeDisplayLabel(label, index) {
  const text = String(label || '').trim();
  if (/第.+[集话話期]/.test(text)) return text;
  return `第 ${episodeNumberOf(text, index)} 集`;
}

function registerPlaylist(resource, line, lineIndex) {
  const episodes = Array.isArray(line?.episodes) ? line.episodes : [];
  if (!episodes.length || !state?.resourcePlaylists?.set) return '';
  const sourceName = resource.sourceName || '如意资源';
  const title = resource.title || '';
  const lineName = line.name || `线路 ${lineIndex + 1}`;
  const playlistId = `cf21-playlist-${playState.seq + 1}`;
  playState.seq += 1;
  state.resourcePlaylists.set(playlistId, episodes.map((episode, index) => ({
    url: episode.url,
    kind: episode.kind || '',
    format: episode.format || '',
    needsResolve: Boolean(episode.needsResolve),
    title,
    sourceName,
    lineName,
    label: episode.label || `播放 ${index + 1}`,
    displayLabel: episodeDisplayLabel(episode.label, index),
    episodeIndex: index,
    episodeNo: episodeNumberOf(episode.label, index),
    total: episodes.length,
  })));
  return playlistId;
}

function playViaBaseline(attrs) {
  const open = window.__cineflowOpenResourcePlayer;
  if (typeof open !== 'function') {
    const toast = document.querySelector('#toast');
    if (toast) {
      toast.textContent = '播放器入口不可用';
      toast.classList.remove('is-hidden');
      window.setTimeout(() => toast.classList.add('is-hidden'), 2200);
    }
    return false;
  }
  open(attrs);
  return true;
}

function setSheetNote(text) {
  const note = document.querySelector('.cf8-sheet-note');
  if (note) note.textContent = text;
}

function setPlayStatus(text) {
  const block = document.querySelector('.cf21-play');
  if (!block) return;
  const status = block.querySelector('.cf21-status');
  const lines = block.querySelector('.cf21-play-lines');
  if (status) {
    status.textContent = text || '';
    status.hidden = !text;
  }
  if (lines) lines.innerHTML = '';
  block.hidden = false;
}

function resetPlayBlock() {
  const block = document.querySelector('.cf21-play');
  if (!block) return null;
  block.hidden = true;
  delete block.__cf21Resource;
  delete block.__cf21Done;
  delete block.__cf21AskedYear;
  const lines = block.querySelector('.cf21-play-lines');
  if (lines) lines.innerHTML = '';
  const meta = block.querySelector('.cf21-play-meta');
  if (meta) meta.textContent = '';
  const status = block.querySelector('.cf21-status');
  if (status) {
    status.textContent = '';
    status.hidden = true;
  }
  return block;
}

function renderPlayBlock(block, resource) {
  const lines = (resource.lines || []).filter((line) => Array.isArray(line.episodes) && line.episodes.length).slice(0, VISIBLE_LINE_LIMIT);
  const sourceName = resource.sourceName || '如意资源';
  const badge = block.querySelector('.cf21-badge');
  const meta = block.querySelector('.cf21-play-meta');
  const holder = block.querySelector('.cf21-play-lines');
  if (badge) badge.textContent = sourceName;
  if (meta) {
    meta.textContent = [
      resource.year,
      resource.isSeries ? `${resource.seasonEpisodeCount || resource.episodeCount || 1} 集` : (resource.remarks || '可播放'),
      resource.formats?.length ? resource.formats.join(' / ') : '',
    ].filter(Boolean).join(' · ');
  }
  block.__cf21Resource = resource;
  holder.innerHTML = '';
  const status = block.querySelector('.cf21-status');
  if (status) {
    status.textContent = '';
    status.hidden = true;
  }
  lines.forEach((line, lineIndex) => {
    const lineName = line.name || `线路 ${lineIndex + 1}`;
    const wrap = document.createElement('div');
    wrap.className = 'cf21-line';
    const head = document.createElement('span');
    head.className = 'cf21-line-name';
    head.textContent = lineName;
    const row = document.createElement('div');
    row.className = 'cf21-line-eps';
    const visible = line.episodes.slice(0, resource.isSeries ? VISIBLE_EPISODE_LIMIT : 4);
    visible.forEach((episode, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cf21-ep';
      button.dataset.line = String(lineIndex);
      button.dataset.episode = String(index);
      button.textContent = resource.isSeries ? episodeDisplayLabel(episode.label, index) : (episode.label || '播放');
      row.appendChild(button);
    });
    if (line.episodes.length > visible.length) {
      const more = document.createElement('span');
      more.className = 'cf21-more';
      more.textContent = `播放器内显示全部 ${line.episodes.length} 集`;
      row.appendChild(more);
    }
    wrap.append(head, row);
    holder.appendChild(wrap);
  });
  block.hidden = false;
}

function playFromSheet(button) {
  const block = document.querySelector('.cf21-play');
  const resource = block?.__cf21Resource;
  if (!resource || !button) return false;
  const lineIndex = Number(button.dataset.line) || 0;
  const episodeIndex = Number(button.dataset.episode) || 0;
  const line = (resource.lines || []).filter((entry) => Array.isArray(entry.episodes) && entry.episodes.length)[lineIndex] || resource.lines?.[0];
  const episode = line?.episodes?.[episodeIndex] || line?.episodes?.[0];
  if (!episode) return false;
  const playlistId = registerPlaylist(resource, line, lineIndex);
  const sourceName = resource.sourceName || '如意资源';
  return playViaBaseline({
    url: episode.url,
    kind: episode.kind,
    format: episode.format,
    needsResolve: episode.needsResolve,
    playlistId,
    episodeIndex,
    title: resource.title || '',
    sourceName,
    lineName: line?.name || `线路 ${lineIndex + 1}`,
    label: episode.label || '播放',
  });
}

async function loadPlaySource(item) {
  const block = document.querySelector('.cf21-play');
  if (!block || block.__cf21Resource) return;
  const badge = block.querySelector('.cf21-badge');
  if (badge) badge.textContent = '如意资源';
  const bridge = window.cineflowFallbackPlay;
  const title = clean(item?.title);
  if (!bridge?.playSource || title.length < 2) {
    setPlayStatus('暂不可用');
    return;
  }
  const run = playState.run;
  block.__cf21Done = false;
  setPlayStatus('正在找线路…');
  let result = null;
  try {
    result = await bridge.playSource({
      title,
      originalTitle: clean(item?.originalTitle) || title,
      year: String(item?.year || ''),
      mediaType: item?.mediaType === 'tv' ? 'tv' : 'movie',
    });
  } catch (error) {
    result = null;
  }
  block.__cf21Done = true;

  if (!sheetState.open || run !== playState.run) return;
  if (!result?.ok || !result.resource) {

    setPlayStatus(result?.disabled ? '外部源已关闭' : '这部没找到可播线路');
    return;
  }
  renderPlayBlock(block, result.resource);
  setSheetNote('豆瓣数据 · 下方线路可直接播');
}

async function doubanHotMovies({ media = 'all', genre = '', page = 1, pageSize = 24 } = {}) {
  const hot = bridge()?.hot;
  if (!hot) return [];
  const type = media === 'tv' ? 'tv' : 'movie';
  const tag = genre || '热门';
  const start = Math.max(0, (Number(page) - 1) * pageSize);
  const result = await hot({ type, tag, pageStart: start, pageSize }).catch(() => null);
  const items = result?.ok ? result.items : [];
  return items.map((item) => ({
    id: Number(item.id) || item.id,
    mediaType: type,
    title: item.title,
    releaseDate: '',
    voteAverage: Number(item.rating) || 0,
    voteCount: 0,
    posterPath: '',
    cf8Douban: true,
    cf8Cover: item.cover,
    cf8Rating: item.rating
  }));
}

export async function fetchDoubanMovies(query = {}) {
  const media = query.media || 'all';
  if (media !== 'all') return doubanHotMovies({ media, genre: query.genre?.name || '', page: query.page || 1 });
  const [movies, shows] = await Promise.all([
    doubanHotMovies({ media: 'movie', genre: query.genre?.name || '', page: query.page || 1, pageSize: 12 }),
    doubanHotMovies({ media: 'tv', genre: query.genre?.name || '', page: query.page || 1, pageSize: 12 })
  ]);
  const mixed = [];
  for (let i = 0; i < Math.max(movies.length, shows.length); i += 1) {
    if (movies[i]) mixed.push(movies[i]);
    if (shows[i]) mixed.push(shows[i]);
  }
  return mixed;
}

function renderDoubanRail(rail, title, items) {
  if (!rail) return;
  rail.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'movie-card';
    card.tabIndex = 0;
    card.dataset.cf8Douban = '1';
    const score = item.cf8Rating ? `★ ${item.cf8Rating}` : '★—';
    card.innerHTML = `
      <div class="poster-frame">
        <div class="cf8-ph">豆瓣</div>
        <div class="score-pill">${escapeText(score)} · ${item.mediaType === 'tv' ? '剧集' : '电影'}</div>
      </div>
      <h3>${escapeText(item.title)}</h3>
      <p>${escapeText(title)}</p>
    `;
    card.__cf8Item = Object.assign({}, item, { cover: item.cf8Cover || item.cover || '' });
    rail.appendChild(card);

    queuePoster(card);
  }
}

function escapeText(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fillRail(rail, { media, title, debug }) {
  if (!rail) return false;
  if (rail.dataset.cf8Filling === media) return false;
  if (rail.querySelector('.movie-card:not([data-cf8-douban])')) return true;
  if (rail.querySelector('[data-cf8-douban]')) return true;
  const empty = rail.querySelector('.rail-empty, .empty-state') || rail.childElementCount === 0;
  if (!empty) return false;
  rail.dataset.cf8Filling = media;
  try {
    const items = await doubanHotMovies({ media, pageSize: 18 });
    debug.lastFetch = { ...debug.lastFetch, [media]: items.length };
    if (!items.length) return false;
    renderDoubanRail(rail, title, items);
    debug.filled += 1;
    return true;
  } finally {
    delete rail.dataset.cf8Filling;
  }
}

async function fillEmptyHome() {
  const rail = document.querySelector('#personalizedRail');
  const trending = document.querySelector('#trendingRail');
  if (!rail || !trending) return false;
  const debug = window.__cf8DoubanDebug || (window.__cf8DoubanDebug = { attempts: 0, filled: 0, lastError: '' });
  debug.attempts += 1;
  try {
    const done = await Promise.all([
      fillRail(rail, { media: 'movie', title: '热门电影', debug }),
      fillRail(trending, { media: 'tv', title: '热门剧集', debug }),
    ]);
    return done.some(Boolean);
  } catch (error) {
    debug.lastError = String(error?.message || error).slice(0, 160);
    return false;
  }
}

function mountDoubanFallback() {
  if (!bridge()?.hot) return false;
  if (mounted) return true;
  mounted = true;

  scanPosters();

  [3000, 9000, 20000, 45000].forEach((delay) => window.setTimeout(() => scanPosters(), delay));
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.('.movie-card')) queuePoster(node);
        for (const card of node.querySelectorAll?.('.movie-card') || []) queuePoster(card);
      }
    }
  });
  observer.observe(document.querySelector('#app') || document.body, { childList: true, subtree: true });

  document.addEventListener('click', (event) => {
    const card = event.target instanceof Element ? event.target.closest('[data-cf8-douban]') : null;
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    if (card.__cf8Item) openSheet(card.__cf8Item);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target instanceof Element ? event.target.closest('[data-cf8-douban]') : null;
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    if (card.__cf8Item) openSheet(card.__cf8Item);
  }, true);
  document.addEventListener('mouseover', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-cf8-douban]')) event.stopPropagation();
  }, true);

  window.cineflow.getCredentialState().then(() => {
    let tries = 0;

    const timer = window.setInterval(async () => {
      tries += 1;
      await fillEmptyHome().catch(() => false);
      const tmdbReady = document.querySelector('#personalizedRail .movie-card:not([data-cf8-douban]), #trendingRail .movie-card:not([data-cf8-douban])');
      if (tmdbReady || tries >= 30) window.clearInterval(timer);
    }, 1200);
    fillEmptyHome().catch(() => false);
  }).catch(() => {});

  return true;
}

export function initDoubanFallback(deps = {}) {
  state = deps.state || null;
  try {
    return mountDoubanFallback();
  } catch (error) {
    console.warn('[CineFlow] 豆瓣兜底装配失败，已跳过', error);
    return false;
  }
}
