/**
 * v3.4.2 纯增量：豆瓣海报兜底 + 无 TMDB 凭证时的豆瓣片单。
 *
 * 思路来自 LibreTV：它的首页完全由豆瓣公开接口供给（热门电影/剧集），海报直接用豆瓣 CDN。
 * CineFlow 的详情页需要 TMDB id，所以这里**不改详情链路**，只补两件事：
 *
 *   A. 海报兜底（有凭证也生效）：卡片海报缺失（No Poster）或加载失败时，按片名去豆瓣联想接口
 *      找同名片，经主进程中转图片字节（豆瓣 CDN 不带 Referer 会 418/403）后换上海报。
 *      TMDB 图片被墙、或该片 TMDB 无 poster_path 时，首页/片库/搜索/收藏都能看到图。
 *   B. 无凭证时的首页与片库：首页两条空轨道渲染豆瓣热门电影/剧集；分类片库通过 fetchDoubanMovies
 *      改为豆瓣片单（分类胶囊映射成豆瓣标签）。这些卡片带 data-cf8-douban，点击由本层接管，
 *      弹出豆瓣资料卡（评分/类型/地区/简介/演员）。**播放仍需要 TMDB 凭证**，卡片上不做假按钮。
 *
 * 所有网络失败都静默降级；摘掉本文件 + incremental-pages.js 两行挂钩 + cf8 样式即回退。
 *
 * 第二十七轮（海报贴不出来的三处修正）：
 *   1. 轨道改成一条一条补，且已经是豆瓣片单的轨道绝不重画 —— 以前基线一重写 empty-state，
 *      两条轨道会一起被抹掉重画，刚贴好的海报跟着没（"刷新也没用"）。
 *   2. 片单自带豆瓣封面时不再并行问 every.film（它的图片端点首查实测 19s/张，36 张排长队白耗带宽内存）。
 *   3. 封面中转失败不再串三跳 rexxar 检索（会把主进程 320ms 闸门堵死），60s 后由补网扫描重试。
 *
 * 第二十八轮（"还是没出来、刷新也没用"继续加固）：
 *   4. 取图改成**看得见才取**（IntersectionObserver + 320px 预备边）：一条轨道 18 张首屏只露 6~7 张，
 *      一次全取就是 36 个中转请求 —— 反复刷新正是被豆瓣 CDN 限流的原因。
 *   5. 图片**既不完成也不报错**（连接被挂住）时，4.5s 看门狗到点当它坏了直接改走兜底；
 *      以前只等 error 事件，那种卡片会永远空着。
 *   6. 主进程侧新增落盘缓存与备用地址重试（见 electron/douban.cjs 顶部说明）：刷新/重启零请求。
 */

const POSTER_TTL_MS = 30 * 60 * 1000;
const POSTER_WATCHDOG_MS = 4500; // 图片既不完成也不报错时，最多等这么久就改走兜底
const posterCache = new Map(); // mediaType:title:year -> dataUrl | ''
const posterInflight = new Map(); // 同一个片名并发只查一次
const imageCache = new Map(); // douban image url -> dataUrl
const sheetState = { item: null, open: false };
let state = null; // 基线的 state（只用它的 credential 与 resourcePlaylists 两个现成字段）
let mounted = false; // 注意：不能用 documentElement.dataset.cf8Douban 当标记，会和卡片属性同名把 <html> 也选中

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

// every.film 的海报域名直连可取，但渲染层 <img> 走的是 session（本机代理出口会被 Cloudflare 判 403），
// 所以和豆瓣图片一样由主进程把字节取回来转 data URL；匹配到就省掉豆瓣那一次联想。
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

// 两个来源并行问、谁先给出非空海报就用谁：every.film 匹配准但首查可能慢（实测 0.8~19s，之后走缓存），
// 豆瓣那路一直是 1~2s。并行才不会因为等 every.film 而把破图时间拉长。
// 全部问完都没有就用 '' 收尾 —— 这里绝不能用 Promise.race + 挂起的哨兵，那样两路都空时会永久悬住。
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
    // 片单本来就带着豆瓣封面：这一次中转拿不到就是网络/限流，再去串三跳 rexxar 检索只会把
    // 主进程那道 320ms 的请求闸门堵死（实测每张多等 1~3s，36 张就是半分钟）。直接失败，交给重试。
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
      // 有豆瓣封面时不再惊动 every.film：它的图片端点首查实测要 19s，36 张排下来会一直占着带宽和内存，
      // 而这些卡片本来就有封面。只有"TMDB 没给海报"的卡片才值得两条路并行问。
      const sources = hasCover
        ? [() => doubanPosterPath({ title, year, mediaType, cover })]
        : [
          () => everyfilmPoster({ title, year, mediaType }),
          () => doubanPosterPath({ title, year, mediaType, cover })
        ];
      const data = await firstSettledValue(sources);
      // 只把成功结果缓存满 30 分钟；失败 60 秒后可重试（上游偶发限流，不能把失败钉死）
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
    card.dataset.cf8Poster = ''; // 失败不封死，后面的扫描/错误事件还能再试
    return;
  }
  const frame = card.querySelector('.poster-frame');
  if (!frame) return;
  let img = frame.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    img.alt = `${clean(card.querySelector('h3')?.textContent)} 海报`;
    img.decoding = 'async';
    // 字节已经在手里（data URL），再标 lazy 只会让轨道里靠边的卡片滚到才解码 —— 看着就是"海报不出来"
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
      // 只等 error 事件是不够的：图片卡在"既不完成也不报错"的状态时（连接被挂住），
      // 卡片会永远空着，用户看到的就是"海报没出来、刷新也没用"。到点就当它坏了，改走兜底。
      if (img.complete && img.naturalWidth > 0) return;
      card.dataset.cf8PosterWatch = '';
      delete card.dataset.cf8Poster;
      patchCardPoster(card);
    };
    img.addEventListener('load', () => { card.dataset.cf8PosterWatch = ''; }, { once: true });
    img.addEventListener('error', () => {
      // 先把状态清掉再重试：否则第一次还在 pending 时，错误事件会被这行挡回去
      card.dataset.cf8PosterWatch = '';
      delete card.dataset.cf8Poster;
      patchCardPoster(card);
    }, { once: true });
    window.setTimeout(giveUp, POSTER_WATCHDOG_MS);
    return;
  }
  card.dataset.cf8Poster = 'pending';
  const dataUrl = await resolvePoster({ ...meta, cover: card.__cf8Item?.cover || '' });
  applyPoster(card, dataUrl); // 失败时 applyPoster 会把状态清回空，后面的补网扫描还能再试
}

// 海报取图按"看得见才取"排队：一条轨道 18 张里首屏只露出 6~7 张，一次全取就是 36 个中转请求，
// 刷新几次很容易被豆瓣 CDN 判限流（然后整条轨道一起空）。横向滚到才补、纵向滚到才补。
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

// 供分类片库等自家模块复用：把豆瓣条目（或带 cf8* 字段的卡片数据）统一成资料卡入参
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

/* ---------------- 豆瓣资料卡 ---------------- */

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
        <p class="cf8-sheet-note">豆瓣数据 · 播放需 TMDB 凭证</p>
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
  // 摘要卡下面那条可播线路：不挡住摘要渲染，拿到才显形
  resetPlayBlock();
  setSheetNote('豆瓣数据 · 播放需 TMDB 凭证');
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
    // 豆瓣条目摘要拿不到时，用 every.film 补年份 / 中文片名 / 融合评分，并按条款署上来源
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
  // 摘要里拿到了准确年份 / 条目类型，第一次没匹配上就用它再问一次
  retryPlaySource({ ...item, year: data.year || item.year, mediaType: data.mediaType || item.mediaType }, data.title || item.title);
}

// 摘要里拿到准确年份后，只有"第一次确实问完了且没结果"才值得再敲一次源站
function retryPlaySource(item, title) {
  const block = document.querySelector('.cf21-play');
  if (!block || !block.__cf21Done || block.__cf21Resource) return;
  const year = clean(item?.year);
  if (!year || block.__cf21AskedYear === year) return;
  block.__cf21AskedYear = year;
  loadPlaySource({ ...item, title: clean(title) || item.title });
}

// every.film 没有 简介/类型/演职员 端点（实测），所以这里只补它确实有的那几项：
// 中文片名、年份、融合评分（TMDB/IMDb/豆瓣合流），并在海报由它提供时显示署名。
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

/* ---------------- 无凭证时保留的一条播放源（应用内置的"如意资源"） ---------------- */

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

// 把这条线路的分集表登记进基线自己维护的 state.resourcePlaylists —— 播放器列全集就靠它
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

// 起播走基线自己那个播放器：renderer.js 末尾只加了一行把 openResourcePlayer 多开一个门，
// 原有的两处调用、resolve / 代理 / 广告过滤 / transport 回退逻辑一行没改。
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
  block.hidden = false; // 一行"如意资源"始终占位显示，找不到线路时也有个明确交代
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
  if (meta) meta.textContent = ''; // 换卡片时必须清掉上一部的"年份 · 备注 · 格式"，否则会串到没货的卡片上
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
  if (!block || block.__cf21Resource) return; // 已经有线路了，后面任何一次补问都不许把它冲掉
  if (state?.credential?.configured) return; // 有凭证时基线详情链路本来就能播，这里不抢
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
  // 摘要卡已经关掉，或者人已经切到别的卡片 —— 这一份结果作废（同一张卡片的补问不算切走）
  if (!sheetState.open || run !== playState.run) return;
  if (!result?.ok || !result.resource) {
    // 找不到也把这行留着，写清楚原因，而不是让整块凭空消失
    setPlayStatus(result?.disabled ? '外部源已关闭' : '这部没找到可播线路');
    return;
  }
  renderPlayBlock(block, result.resource);
  setSheetNote('豆瓣数据 · 下方线路可直接播');
}

/* ---------------- 无凭证时的豆瓣片单 ---------------- */

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
    posterPath: '', // 豆瓣 CDN 有防盗链，交给海报兜底层中转换成 data URL
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

// 兜底片单直接复用基线卡片的 DOM 结构与类名：`.movie-rail` 是 `grid-auto-flow:column; grid-auto-columns:178px`
// 的网格，之前这里塞了一个 .cf8-rail 包装层，整条片单就被塞进**一个 178px 网格列**里 —— 就是"海报全挤在左边"。
// 现在卡片直接作为网格子项追加，尺寸、圆角、hover、图片填充全部自动跟首页一致。
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
    // 海报统一交给兜底层：豆瓣封面 / every.film 两条路，看得见才取（queuePoster）
    queuePoster(card);
  }
}

function escapeText(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 一条轨道一条轨道地补，而且只补真的空掉的那条。
// 上一版是两条轨道一起重画：基线的 TMDB 重试每隔几秒会把其中一条写成 empty-state，
// 于是另一条刚贴好海报的轨道也被一起抹掉重来 —— 海报闪一下就没了，看起来就是"豆瓣海报不显示、刷新也没用"。
async function fillRail(rail, { media, title, debug }) {
  if (!rail) return false;
  if (rail.dataset.cf8Filling === media) return false; // 这一条正在填，别并发重画
  if (rail.querySelector('.movie-card:not([data-cf8-douban])')) return true; // 基线的真卡片已到位，不抢
  if (rail.querySelector('[data-cf8-douban]')) return true; // 已经是我们的片单，绝不重画
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
  // 海报是异步一张张贴的：首轮排队时失败的那几张（缓存里 60s 后作废）靠这几趟补回来，
  // 不用用户手动刷新。三趟封顶，已贴好的卡片会在 patchCardPoster 第一行直接返回。
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

  // 豆瓣片单卡片：点击/悬停都别落到基线（它们没有 TMDB id）。捕获阶段统一处理，
  // 卡片自己的打开逻辑也在这里做 —— 一旦 stopPropagation，捕获之后卡片上的监听器就收不到了。
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

  window.cineflow.getCredentialState().then((state) => {
    if (state?.configured) return;
    let tries = 0;
    // 基线的失败态会在几秒后把轨道重写成 empty-state（把我们的片单一起盖掉），
    // 所以这里不"填成功一次就收工"，而是持续盯 36 秒：只有出现真正的 TMDB 卡片才停。
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
