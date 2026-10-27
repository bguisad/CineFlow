import { fetchDoubanMovies } from './douban-fallback.js';

const SORTS = [
  { id: 'popularity', label: '热度', movie: 'popularity.desc', tv: 'popularity.desc' },
  { id: 'rating', label: '评分', movie: 'vote_average.desc', tv: 'vote_average.desc' },
  { id: 'latest', label: '最新', movie: 'primary_release_date.desc', tv: 'first_air_date.desc' },
  { id: 'oldest', label: '最早', movie: 'primary_release_date.asc', tv: 'first_air_date.asc' },
];
const MEDIA_TABS = [
  { id: 'all', label: '全部' },
  { id: 'movie', label: '电影' },
  { id: 'tv', label: '节目' },
];
const STYLE_ORDER = ['喜剧', '爱情', '恐怖', '动作', '科幻', '剧情', '犯罪', '奇幻', '悬疑', '惊悚', '家庭', '冒险', '动画', '纪录', '历史', '音乐', '战争', '西部', '儿童', '新闻', '真人秀', '脱口秀'];
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const POSTER_SIZE = 'w342';

const LOAD_MORE_THRESHOLD_PX = 420;
const FULL_PAGE_SIZE = 18;
const SKELETON_COUNT = 8;

const PRE_2000 = 'pre2000';
const PRE_2000_MIN_VOTES = 25;

function styleOrderIndex(name) {
  const index = STYLE_ORDER.findIndex((item) => String(name || '').includes(item));
  return index === -1 ? 99 : index;
}

function normalizeGenreName(name) {
  return String(name || '').replace(/片$/, '').trim();
}

function collectGenres(state) {
  const genres = Array.isArray(state?.genres) ? state.genres : [];
  const picked = [];
  for (const genre of genres) {
    const raw = String(genre?.name || '').trim();
    const label = normalizeGenreName(raw);
    if (!label || /与|\/|&/.test(raw)) continue;
    if (!Number.isFinite(Number(genre.id))) continue;
    if (picked.some((item) => item.label === label)) continue;
    picked.push({ id: Number(genre.id), label });
  }
  return picked.sort((a, b) => styleOrderIndex(a.label) - styleOrderIndex(b.label));
}

function posterOf(path) {
  if (!path) return '';
  const value = String(path);
  if (/^(https?:|data:)/i.test(value)) return value;
  return `${IMAGE_BASE}/${POSTER_SIZE}${path}`;
}

function scoreOf(movie) {
  return Number(movie.voteAverage || 0).toFixed(1);
}

function rememberMovie(state, movie) {
  const mediaType = movie.mediaType === 'tv' ? 'tv' : 'movie';
  const key = `${mediaType}:${movie.id}`;
  if (!movie.cf8Douban) {
    try {
      if (state?.cardMovies?.set) state.cardMovies.set(key, movie);
    } catch (error) {

    }
  }
  return key;
}

function buildCard(movie, state, escapeHtml) {
  const key = rememberMovie(state, movie);
  const card = document.createElement('article');
  card.className = 'movie-card';
  card.tabIndex = 0;
  card.dataset.movieId = String(movie.id);
  card.dataset.mediaType = movie.mediaType === 'tv' ? 'tv' : 'movie';
  card.dataset.contentKey = key;
  if (movie.cf8Douban) {
    card.dataset.cf8Douban = '1';
    card.__cf8Item = {
      id: movie.cf8Id || movie.id,
      title: movie.title,
      mediaType: movie.mediaType === 'tv' ? 'tv' : 'movie',
      cover: movie.cf8Cover || movie.posterPath || '',
      rating: movie.cf8Rating || ''
    };
  }
  const poster = posterOf(movie.posterPath);
  const year = String(movie.releaseDate || '').slice(0, 4);
  card.innerHTML = `
    <div class="poster-frame">
      ${poster ? `<img src="${poster}" alt="${escapeHtml(movie.title)} 海报" decoding="async" fetchpriority="low" />` : '<div class="poster-fallback">No Poster</div>'}
      <div class="score-pill">★ ${scoreOf(movie)} · ${card.dataset.mediaType === 'tv' ? '节目' : '电影'}</div>
    </div>
    <h3>${escapeHtml(movie.title)}</h3>
    <p>${escapeHtml(year || '未知年份')}</p>
  `;
  return card;
}

function yearQuery(year) {
  if (year === PRE_2000) return { yearTo: '1999-12-31', minVotes: PRE_2000_MIN_VOTES };
  if (year) return { year };
  return {};
}

async function fetchTmdbPage(api, { genre, media, sort, year, page }) {
  const movieSort = sort.movie;
  const tvSort = sort.tv;
  const yearParams = yearQuery(year);
  if (media !== 'all') {
    return api.discoverMovies({
      mediaType: media,
      genreId: genre ? genre.id : undefined,
      sortBy: media === 'tv' ? tvSort : movieSort,
      ...yearParams,
      page,
    });
  }

  if (sort.id === 'latest' || sort.id === 'oldest') {
    const [movies, shows] = await Promise.all([
      api.discoverMovies({ mediaType: 'movie', genreId: genre ? genre.id : undefined, sortBy: movieSort, ...yearParams, page }),
      api.discoverMovies({ mediaType: 'tv', genreId: genre ? genre.id : undefined, sortBy: tvSort, ...yearParams, page }),
    ]);
    const merged = [];
    const moviePool = (movies || []).slice();
    const tvPool = (shows || []).slice();
    while (moviePool.length || tvPool.length) {
      if (moviePool.length) merged.push(moviePool.shift());
      if (tvPool.length) merged.push(tvPool.shift());
    }
    return merged;
  }
  return api.discoverMovies({ genreId: genre ? genre.id : undefined, sortBy: movieSort, ...yearParams, page });
}

async function fetchPage(api, query) {
  try {
    return await fetchTmdbPage(api, query);
  } catch (error) {
    const fallback = await fetchDoubanMovies(query).catch(() => []);
    if (fallback.length) return fallback;
    throw error;
  }
}

export function createLibraryPage({ api, state, escapeHtml = (value) => String(value ?? '') } = {}) {
  const view = document.createElement('div');
  view.className = 'cf3-page cf3-library';
  let genres = collectGenres(state);
  const currentYear = new Date().getFullYear();

  const yearEntries = [
    { year: null, label: '不限' },
    ...Array.from({ length: currentYear - 1999 }, (_, index) => ({ year: currentYear - index, label: String(currentYear - index) })),
    { year: PRE_2000, label: '2000~' },
  ];

  view.innerHTML = `
    <div class="cf3-scroll">
      <header class="cf3-head">
        <p class="eyebrow">LIBRARY</p>
        <h2 class="cf3-title">分类片库</h2>
        <div class="cf3-media cf3-no-drag" role="group" aria-label="媒体类型"></div>
      </header>
      <div class="cf3-filter">
        <span class="cf3-filter-label">类型</span>
        <div class="cf3-styles cf3-no-drag" role="group" aria-label="风格分类"></div>
      </div>
      <div class="cf3-grid" aria-live="polite"></div>
      <div class="cf3-foot">
        <button class="rail-more-button cf3-more" type="button" hidden>加载更多</button>
      </div>
    </div>
    <button class="cf3-fab cf3-no-drag" type="button" title="排序与年份" aria-label="排序与年份" aria-expanded="false">
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M3 5h9M3 10h6M3 15h4" /><path d="M14 6v9m0 0 2.4-2.6M14 15l-2.4-2.6" /></svg>
      <span class="cf3-fab-text">热度</span>
    </button>
    <button class="cf3-totop cf3-no-drag" type="button" title="回到顶部" aria-label="回到顶部">
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 16V5" /><path d="M5.5 9.5 10 5l4.5 4.5" /></svg>
    </button>
    <div class="cf3-sheet cf3-no-drag" role="group" aria-label="排序与年份" hidden>
      <p class="cf3-sheet-label">排序</p>
      <div class="cf3-sheet-row cf3-sort-row"></div>
      <p class="cf3-sheet-label">年份</p>
      <div class="cf3-sheet-row cf3-year-row"></div>
    </div>
  `;

  const scroller = view.querySelector('.cf3-scroll');
  const mediaRow = view.querySelector('.cf3-media');
  const styleRow = view.querySelector('.cf3-styles');
  const grid = view.querySelector('.cf3-grid');
  const moreBtn = view.querySelector('.cf3-more');
  const fab = view.querySelector('.cf3-fab');
  const toTop = view.querySelector('.cf3-totop');
  const sheet = view.querySelector('.cf3-sheet');
  const sortRow = view.querySelector('.cf3-sort-row');
  const yearRow = view.querySelector('.cf3-year-row');
  const fabText = view.querySelector('.cf3-fab-text');

  const query = { genre: null, media: 'all', sort: SORTS[0], year: null };
  const cache = new Map();
  const seen = new Set();
  let page = 1;
  let token = 0;
  let loading = false;
  let hasMore = true;
  let loadedEpoch = '';

  function chips(row, entries, isActive, onPick, makeChip) {
    row.innerHTML = '';
    entries.forEach((entry) => {
      const button = makeChip ? makeChip(entry) : document.createElement('button');
      if (!makeChip) {
        button.type = 'button';
        button.className = 'cf3-chip';
        button.textContent = entry.label;
      }
      button.classList.toggle('is-on', Boolean(isActive(entry)));
      button.addEventListener('click', () => onPick(entry));
      row.appendChild(button);
    });
  }

  function renderControls() {
    chips(mediaRow, MEDIA_TABS, (item) => item.id === query.media, (item) => {
      if (query.media === item.id) return;
      query.media = item.id;
      renderControls();
      load(true);
    });
    chips(
      styleRow,
      [{ label: '全部', id: 0 }, ...genres],
      (item) => (item.id === 0 ? !query.genre : query.genre?.id === item.id),
      (item) => {
        const next = item.id === 0 ? null : item;
        if ((query.genre?.id || 0) === (next?.id || 0)) return;
        query.genre = next;
        renderControls();
        load(true);
      },
    );
    chips(sortRow, SORTS, (item) => item.id === query.sort.id, (item) => {
      const next = SORTS.find((sort) => sort.id === item.id);
      if (next.id === query.sort.id) return;
      query.sort = next;
      renderControls();
      load(true);
    });
    chips(yearRow, yearEntries, (item) => item.year === query.year, (item) => {
      if (item.year === query.year) return;
      query.year = item.year;
      renderControls();
      load(true);
    });
    fabText.textContent = query.sort.label;
    fab.classList.toggle('is-filtered', Boolean(query.year) || query.sort.id !== 'popularity');
  }

  function syncGenres() {
    const next = collectGenres(state);
    if (next.length && next.map((item) => item.id).join() !== genres.map((item) => item.id).join()) {
      genres = next;
      renderControls();
    }
  }

  renderControls();

  function cacheKey() {
    return `${sourceEpoch()}|${query.genre?.id || 0}|${query.media}|${query.sort.id}|${query.year || 0}|${page}`;
  }

  function sourceEpoch() {
    const credential = state?.credential;
    return `${credential?.configured ? '1' : '0'}:${credential?.type || ''}`;
  }

  function appendCards(movies) {
    const fragment = document.createDocumentFragment();
    let added = 0;
    for (const movie of movies || []) {
      const key = `${movie.mediaType === 'tv' ? 'tv' : 'movie'}:${movie.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fragment.appendChild(buildCard(movie, state, escapeHtml));
      added += 1;
    }
    grid.appendChild(fragment);
    return added;
  }

  function paint(movies, append) {
    if (!append) {
      grid.innerHTML = '';
      seen.clear();
    }
    const added = appendCards(movies);
    if (!append && !added && !(movies || []).length) {
      grid.innerHTML = '<p class="cf3-empty">暂无片源</p>';
    }
    return added;
  }

  function syncMoreButton() {
    if (!hasMore) {
      moreBtn.hidden = true;
      return;
    }
    moreBtn.hidden = false;
    moreBtn.disabled = loading;
    moreBtn.textContent = loading ? '加载中...' : '加载更多';
  }

  async function load(reset) {
    if (reset) {
      page = 1;
      hasMore = true;
      scroller.scrollTop = 0;
      if (!cache.has(cacheKey())) grid.innerHTML = skeletons();
    }
    const current = ++token;
    const key = cacheKey();
    loading = true;
    view.classList.add('is-loading');
    syncMoreButton();
    try {
      const cached = cache.get(key);
      const movies = cached || (await fetchPage(api, { ...query, page }));
      if (current !== token) return;
      if (!cached) cache.set(key, movies || []);
      const fetched = movies || [];
      const added = paint(fetched, !reset);

      if (!reset && !added) hasMore = false;
      else if (fetched.length < FULL_PAGE_SIZE) hasMore = false;
    } catch (error) {
      if (current !== token) return;
      if (reset) grid.innerHTML = '<p class="cf3-empty">加载失败</p>';
      else hasMore = false;
    } finally {
      if (current === token) {
        loading = false;
        view.classList.remove('is-loading');
        syncMoreButton();
      }
    }
  }

  function skeletons() {
    return '<article class="movie-card skeleton"><div></div><span></span><small></small></article>'.repeat(SKELETON_COUNT);
  }

  function loadMore() {
    if (loading || !hasMore) return;
    page += 1;
    load(false);
  }

  function maybeAutoLoadMore() {
    if (loading || !hasMore) return;
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (remaining < LOAD_MORE_THRESHOLD_PX) loadMore();
  }

  const TO_TOP_THRESHOLD_PX = 320;
  function syncToTop() {
    const show = scroller.scrollTop > TO_TOP_THRESHOLD_PX;
    toTop.classList.toggle('is-visible', show);
    view.classList.toggle('is-scrolled', show);
  }

  toTop.addEventListener('click', (event) => {
    event.stopPropagation();
    if (scroller.scrollTo) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    else scroller.scrollTop = 0;
  });

  scroller.addEventListener('scroll', () => {
    maybeAutoLoadMore();
    syncToTop();
  }, { passive: true });
  scroller.addEventListener('wheel', () => window.setTimeout(() => {
    maybeAutoLoadMore();
    syncToTop();
  }, 80), { passive: true });

  moreBtn.addEventListener('click', loadMore);

  fab.addEventListener('click', () => {
    const open = sheet.hidden;
    sheet.hidden = !open;
    fab.setAttribute('aria-expanded', String(open));
    view.classList.toggle('is-sheet-open', open);
  });

  return {
    el: view,
    async activate() {
      syncGenres();

      const fresh = await api?.getCredentialState?.().catch(() => null);
      if (fresh && state) state.credential = fresh;
      const epoch = sourceEpoch();
      if (!grid.childElementCount) {
        loadedEpoch = epoch;
        load(true);
        return;
      }
      if (loadedEpoch === epoch) return;

      loadedEpoch = epoch;
      cache.clear();
      genres = collectGenres(state);
      syncGenres();
      load(true);
    },

    settle() {
      if (!sheet.hidden) {
        sheet.hidden = true;
        fab.setAttribute('aria-expanded', 'false');
        view.classList.remove('is-sheet-open');
      }
    },
  };
}
