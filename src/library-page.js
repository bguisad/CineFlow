// v3.4.0 纯增量：分类片库页
// 卡片复用基线 .movie-card 结构与 data-content-key 约定，点击仍由基线事件委托打开介绍页。
// 排序 / 年份通过悬浮按钮展开，不改基线任何函数，只调用既有 tmdb:discover IPC。
// 第九轮：加载更多照搬首页那套（railState 的 page/loading/hasMore + 去重合并 + 一页不足 18 条即到底 +
// 距底 420px 触发），滚轮往下滑会一直续拉，不再有 8 页上限。
// 第十轮：首页"电影/节目风格入口"已从界面去掉，标签真源改成 state.genres（TMDB 电影+节目类型全集），
// 顺序照 classification.png 的"类型"行排；标签只留分类文字；2000 年之前统一归进"2000~"一个标签。
// 第十八轮：无 TMDB 凭证（或 TMDB 整页失败）时改用豆瓣热门片单兜底，卡片带 data-cf8-douban，
// 点击由 douban-fallback 接管弹出豆瓣资料卡（播放仍需 TMDB 凭证，不给假按钮）。
// 第二十七轮：滚动改到内层 .cf3-scroll，"热度 / 回到顶部"两枚固定按钮留在不滚动的页面上，
// 因为 cf3-warm 的常驻 will-change 会让滚动的 .cf3-page 变成 fixed 后代的包含块（按钮跟着滚走）。
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
// 与基线 maybeAutoLoadMore / loadMoreRail 同一组数字：距底 420px 就续拉，一页返回不足 18 条视为到底
const LOAD_MORE_THRESHOLD_PX = 420;
const FULL_PAGE_SIZE = 18;
const SKELETON_COUNT = 8;
// "2000~" 这一档：TMDB 早于 2000 的条目投票数普遍很低，沿用默认的 80 会几乎筛空
const PRE_2000 = 'pre2000';
const PRE_2000_MIN_VOTES = 25;

function styleOrderIndex(name) {
  const index = STYLE_ORDER.findIndex((item) => String(name || '').includes(item));
  return index === -1 ? 99 : index;
}

function normalizeGenreName(name) {
  return String(name || '').replace(/片$/, '').trim();
}

// state.genres 是主进程合并 TMDB 电影与节目两个 /genre 端点的结果；节目侧的"科幻与奇幻""战争与政治"
// 这类复合名在电影侧已有对应单基标签，跳过它们以免同一含义出现两个胶囊。
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
  if (/^(https?:|data:)/i.test(value)) return value; // 豆瓣兜底海报是绝对地址
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
      /* Map 不可用时卡片点击只是打不开详情，页面本身不受影响 */
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

// 年份筛选的三种形态：不限 / 单一年份 / "2000~"（上界 1999-12-31，走 tmdb:discover 的 yearTo 透传）
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
  // "最新 / 最旧"的日期字段在电影与节目两个端点上并不同名，合并请求会有一端被 TMDB 判非法，
  // 因此这两种排序下分头请求再交错合并，其余排序沿用单次调用（与首页风格入口行为一致）。
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

// 第十八轮：TMDB 整页失败（含无凭证）时改用豆瓣热门片单；豆瓣也拿不到才把原错误抛回去
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
  // 逐年只列到 2000，更早的统一成一档"2000~"
  const yearEntries = [
    { year: null, label: '不限' },
    ...Array.from({ length: currentYear - 1999 }, (_, index) => ({ year: currentYear - index, label: String(currentYear - index) })),
    { year: PRE_2000, label: '2000~' },
  ];

  // 第二十七轮：滚动容器换成内层 .cf3-scroll，页面自身不再滚动。
  // 原因：cf3-warm 给 .cf3-page 常驻了 will-change:transform，这会让它成为 position:fixed 后代的包含块，
  // 于是"热度"和"回到顶部"这两枚固定按钮被算进了滚动内容里 —— 一滚就跑上去了。
  // 现在覆盖层是 .cf3-page 的直接子节点，包含块 = 不滚动的页面框，位置恒定；滚动条样式跟着搬到内层。
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
  const seen = new Set(); // 跨页去重，跟首页 uniqueMovies 一个意思
  let page = 1;
  let token = 0;
  let loading = false;
  let hasMore = true;
  let loadedEpoch = ''; // 这一页当前是用哪个数据源渲染的（无凭证=豆瓣 / 有凭证=TMDB）

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

  // state.genres 是异步到位的（首页启动可能还在重试），进页时再核对一次
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

  // 数据源身份：无凭证时这一页是豆瓣片单，配好凭证后是 TMDB。凭证一变，缓存与已渲染的卡片都得作废，
  // 否则"保存并刷新"只刷新了首页，切到这一页还是旧内容（第二十六轮修的就是这个）。
  function sourceEpoch() {
    const credential = state?.credential;
    return `${credential?.configured ? '1' : '0'}:${credential?.type || ''}`;
  }

  // 与首页 loadMoreRail 同一套：合并时按 mediaType:id 去重，只把新卡片追加进网格
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
      // 首页判底的两个条件照搬：这一页没有新卡片，或返回不足一整页
      if (!reset && !added) hasMore = false;
      else if (fetched.length < FULL_PAGE_SIZE) hasMore = false;
    } catch (error) {
      if (current !== token) return;
      if (reset) grid.innerHTML = '<p class="cf3-empty">加载失败</p>';
      else hasMore = false; // 续拉失败就停住，不跟滚轮较劲
    } finally {
      if (current === token) {
        loading = false;
        view.classList.remove('is-loading');
        syncMoreButton();
      }
    }
  }

  // 骨架直接用基线首页的 .movie-card.skeleton 结构，样式与首页完全一致
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

  // 一键回到顶部：离开顶部一屏的三分之一才浮出，回到顶部就收回去
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

  // 首页就是 scroll + wheel 双绑定：软件渲染下滚轮未必触发 scroll 事件，补一次延后检查
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
      // 凭证可能刚被向导或"保存并刷新"改掉：以主进程为准核一次再决定要不要重拉
      const fresh = await api?.getCredentialState?.().catch(() => null);
      if (fresh && state) state.credential = fresh;
      const epoch = sourceEpoch();
      if (!grid.childElementCount) {
        loadedEpoch = epoch;
        load(true);
        return;
      }
      if (loadedEpoch === epoch) return;
      // 数据源换了（豆瓣 ↔ TMDB）：缓存与已渲染卡片全部作废，整页重拉
      loadedEpoch = epoch;
      cache.clear();
      genres = collectGenres(state);
      syncGenres();
      load(true);
    },
    // 切页时收起浮层，避免快照里出现半个浮层、也避免回来时还挡着
    settle() {
      if (!sheet.hidden) {
        sheet.hidden = true;
        fab.setAttribute('aria-expanded', 'false');
        view.classList.remove('is-sheet-open');
      }
    },
  };
}
