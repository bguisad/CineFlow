'use strict';
/**
 * CineFlow × rec-engine 适配宿主（新增文件，零侵入集成）
 * 职责：引擎生命周期、TMDB/豆瓣卡片 ↔ 引擎物料映射、rec:* IPC、行为事件接入、存量偏好迁移。
 * 引擎物料 id 统一使用 CineFlow 的 contentKey（movie:123 / tv:456 / douban:1292052），
 * 推荐结果在本层映射回 CineFlow 卡片形状，渲染层零转换。
 * 设计为依赖注入式（initRecommender({ app, ipcMain })），可在纯 Node 下用 mock 冒烟。
 */

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const USER_ID = 'cineflow-local';
const REBUILD_EVENT_THRESHOLD = 150;
const REBUILD_MIN_INTERVAL_MS = 30 * 60 * 1000;
const FINISHED_RATIO = 0.96; // 与 src/history-page.js 的已看完判定一致

const TRACK_TYPE_MAP = {
  click: 'click',
  play: 'play',
  finish: 'finish',
  like: 'like',
  imp: 'imp',
  rate: 'rate',
};

function contentKeyOf(mediaType, id) {
  return `${mediaType === 'tv' ? 'tv' : 'movie'}:${id}`;
}

/**
 * Electron 33 的 ESM 动态 import 不支持 asar 内文件:
 * 打包时 rec-engine/dist 由 asarUnpack 解包到 app.asar.unpacked, 此处重映射真实路径。
 * 开发态(无 asar)路径不变。
 */
function asarReal(p) {
  if (!p || !p.includes('app.asar') || p.includes('app.asar.unpacked')) return p;
  return p.replace('app.asar', 'app.asar.unpacked');
}

/** CineFlow 卡片（TMDB compactMovie 形状或豆瓣 cf8 条目）→ 引擎 ItemMeta */
function cardToItemMeta(card) {
  if (!card || card.id === undefined || card.id === null) return null;
  const isDouban = Boolean(card.cf8Douban);
  const mediaType = card.mediaType === 'tv' ? 'tv' : 'movie';
  const id = isDouban
    ? `douban:${card.id}`
    : contentKeyOf(mediaType, card.id);
  if (!String(id).trim()) return null;

  const genres = Array.isArray(card.genres) ? card.genres.filter((g) => typeof g === 'string' && g) : [];
  const extra = {};
  const poster = card.posterPath || card.cf8Cover;
  if (poster) extra.posterPath = String(poster);
  if (card.backdropPath) extra.backdropPath = String(card.backdropPath);
  if (card.voteCount !== undefined && card.voteCount !== null) extra.voteCount = Number(card.voteCount) || 0;
  if (Array.isArray(card.genreIds) && card.genreIds.length) extra.genreIds = card.genreIds.map(Number).filter(Number.isFinite).join(',');
  if (isDouban) extra.cf8 = true;

  let releaseDate = card.releaseDate ? String(card.releaseDate).slice(0, 10) : '';
  if (!releaseDate && card.year && /^\d{4}$/.test(String(card.year))) releaseDate = `${card.year}-01-01`;

  const rating = Number(card.voteAverage ?? card.cf8Rating ?? 0);
  return {
    id: String(id),
    title: String(card.title || '未命名'),
    genres,
    overview: card.overview ? String(card.overview) : undefined,
    actors: Array.isArray(card.actors) ? card.actors.map(String) : undefined,
    releaseDate: releaseDate || undefined,
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    extra,
  };
}

/** 引擎 ItemMeta → CineFlow 卡片（豆瓣条目 v1 不输出，返回 null 由调用方过滤） */
function itemToCard(meta) {
  if (!meta || typeof meta.id !== 'string') return null;
  if (meta.id.startsWith('douban:')) return null;
  const sep = meta.id.indexOf(':');
  if (sep <= 0) return null;
  const mediaType = meta.id.slice(0, sep) === 'tv' ? 'tv' : 'movie';
  const id = Number(meta.id.slice(sep + 1));
  if (!Number.isFinite(id)) return null;
  const extra = meta.extra || {};
  let genreIds = [];
  if (typeof extra.genreIds === 'string' && extra.genreIds) {
    genreIds = extra.genreIds.split(',').map(Number).filter(Number.isFinite);
  }
  return {
    id,
    mediaType,
    title: meta.title,
    overview: meta.overview || '',
    posterPath: extra.posterPath || null,
    backdropPath: extra.backdropPath || null,
    voteAverage: Number(meta.rating || 0),
    voteCount: Number(extra.voteCount || 0),
    releaseDate: meta.releaseDate || '',
    genreIds,
    popularity: Number(extra.popularity || 0),
    adult: false,
  };
}

async function createRecommenderCore({ dataDir, engineEntry, configPath, log = () => {} } = {}) {
  const entry = asarReal(engineEntry || path.join(__dirname, 'rec-engine', 'dist', 'engine.js'));
  // Windows 绝对路径必须转 file:// URL, 否则 ESM loader 报 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const { RecEngine } = await import(pathToFileURL(entry).href);
  const engine = new RecEngine(dataDir, configPath ? asarReal(configPath) : undefined).init();
  const state = { eventsSinceRebuild: 0, lastRebuildAt: Date.now() };

  function upsertCards(cards) {
    const metas = (cards || []).map(cardToItemMeta).filter(Boolean);
    if (metas.length) engine.upsertItems(metas);
    return metas.length;
  }

  function maybeRebuild() {
    if (state.eventsSinceRebuild < REBUILD_EVENT_THRESHOLD) return;
    if (Date.now() - state.lastRebuildAt < REBUILD_MIN_INTERVAL_MS) return;
    try {
      const stats = engine.rebuild();
      state.eventsSinceRebuild = 0;
      state.lastRebuildAt = Date.now();
      log(`rebuild 完成: ${JSON.stringify(stats)}`);
    } catch (err) {
      log('rebuild 失败(不影响推荐):', err && err.message);
    }
  }

  function metaOf(itemId) {
    return engine.catalog.find((c) => c.id === String(itemId)) || null;
  }

  return {
    engine,
    upsertCards,

    /** 行为事件: [{ key, type, value, ts, card? }] */
    track(events = []) {
      upsertCards(events.filter((e) => e && e.card).map((e) => e.card));
      const mapped = (events || [])
        .filter((e) => e && e.key && TRACK_TYPE_MAP[e.type])
        .map((e) => ({
          userId: USER_ID,
          itemId: String(e.key),
          type: TRACK_TYPE_MAP[e.type],
          value: e.value,
          ts: Number(e.ts) || Date.now(),
        }));
      engine.track(mapped);
      state.eventsSinceRebuild += mapped.length;
      maybeRebuild();
      return { accepted: mapped.length };
    },

    /** 首次运行: 把 CineFlow 既有偏好/历史迁移为引擎事件 */
    seed({ prefs = {}, history = [], genreNames = {}, cards = [] } = {}) {
      const events = [];
      const now = Date.now();
      const seedCards = [...(cards || [])];
      const seenKey = new Set();

      const pushCard = (card) => {
        const meta = cardToItemMeta(card);
        if (meta && !seenKey.has(meta.id)) {
          seenKey.add(meta.id);
          seedCards.push(card);
        }
      };

      for (const fav of prefs.favorites || []) {
        if (!fav || fav.id === undefined) continue;
        pushCard({
          ...fav,
          // favorites 快照只有 genreIds(数字), 借 genreNames 映射为类型名供标签路使用
          genres: (fav.genreIds || []).map((gid) => genreNames[gid] || genreNames[String(gid)]).filter(Boolean),
        });
        events.push({ key: `${fav.mediaType === 'tv' ? 'tv' : 'movie'}:${fav.id}`, type: 'like', ts: now });
      }
      for (const key of prefs.likedMovieIds || []) {
        if (typeof key === 'string' && key.includes(':')) events.push({ key, type: 'like', ts: now });
      }
      for (const key of prefs.clickedMovieIds || []) {
        if (typeof key === 'string' && key.includes(':')) events.push({ key, type: 'click', ts: now });
      }
      for (const item of history || []) {
        if (!item || item.id === undefined || !item.key) continue;
        const mediaType = item.mediaType === 'tv' ? 'tv' : 'movie';
        pushCard({
          id: item.id,
          mediaType,
          title: item.title,
          posterPath: item.posterPath,
          year: item.year,
          voteAverage: 0,
        });
        const ratio = item.duration > 0 ? (item.progress || 0) / item.duration : 0;
        events.push({
          key: item.key,
          type: ratio >= FINISHED_RATIO ? 'finish' : 'play',
          ts: Number(item.updatedAt) || now,
        });
      }

      upsertCards(seedCards);
      // 引擎事件字段是 itemId(非 key), 映射后上报
      engine.track(events.map((e) => ({ userId: USER_ID, itemId: String(e.key), type: e.type, ts: e.ts })));
      state.eventsSinceRebuild += events.length;

      // onboarding 兴趣: genreWeights top3 → 类型名
      const genreWeights = prefs.genreWeights || {};
      const topGenres = Object.entries(genreWeights)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 3)
        .map(([id]) => genreNames[id] || genreNames[Number(id)])
        .filter(Boolean);
      if (topGenres.length) engine.setOnboarding(USER_ID, topGenres);

      try {
        engine.rebuild();
        state.eventsSinceRebuild = 0;
        state.lastRebuildAt = Date.now();
      } catch (err) {
        log('seed 后 rebuild 失败:', err && err.message);
      }
      return { events: events.length, items: seedCards.length, onboarding: topGenres };
    },

    /** 首页推荐 → CineFlow 卡片列表 */
    async home({ size = 24, page = 1 } = {}) {
      const resp = await engine.recommend({ userId: USER_ID, scene: 'home', size, page });
      const cards = (resp.items || [])
        .map((it) => itemToCard(metaOf(it.itemId)))
        .filter(Boolean);
      return {
        cards,
        total: resp.total,
        coldTier: resp.coldTier,
        events: engine.metrics().events,
        tookMs: resp.tookMs,
      };
    },

    /** 详情页相似推荐 */
    async similar(itemId, { size = 12 } = {}) {
      const items = await engine.similarItems(String(itemId), size);
      return {
        cards: items.map((it) => itemToCard(metaOf(it.itemId))).filter(Boolean),
      };
    },

    status() {
      return { items: engine.catalog.length, ...engine.metrics(), userId: USER_ID };
    },

    rebuild() {
      const stats = engine.rebuild();
      state.eventsSinceRebuild = 0;
      state.lastRebuildAt = Date.now();
      return stats;
    },
  };
}

function registerRecIpc({ ipcMain, corePromise, log = () => {} }) {
  const wrap = (fn) => async (_event, ...args) => {
    const core = await corePromise;
    if (!core) return null; // 引擎停用 → 渲染层走原生回退
    try {
      return await fn(core, ...args);
    } catch (err) {
      log('rec handler 异常(返回 null 走回退):', err && err.message);
      return null;
    }
  };
  ipcMain.handle('rec:getHome', wrap((core, opts) => core.home(opts || {})));
  ipcMain.handle('rec:getSimilar', wrap((core, payload) => core.similar(payload.itemId, payload || {})));
  ipcMain.handle('rec:track', wrap((core, payload) => core.track((payload && payload.events) || [])));
  ipcMain.handle('rec:upsert', wrap((core, payload) => ({ fed: core.upsertCards((payload && payload.cards) || []) })));
  ipcMain.handle('rec:seed', wrap((core, payload) => core.seed(payload || {})));
  ipcMain.handle('rec:status', wrap((core) => core.status()));
  ipcMain.handle('rec:rebuild', wrap((core) => core.rebuild()));
}

/** bootstrap 入口: 返回 corePromise(失败 resolve null = 引擎停用) */
async function initRecommender({ app, ipcMain, log = console.log } = {}) {
  const corePromise = (async () => {
    if (!app || !ipcMain) return null;
    const dataDir = path.join(app.getPath('userData'), 'cineflow-rec');
    const engineEntry = path.join(__dirname, 'rec-engine', 'dist', 'engine.js');
    const configPath = path.join(__dirname, 'rec-engine', 'config', 'weights.json');
    if (!fs.existsSync(asarReal(configPath))) log('[CineFlow:Rec] 未找到 weights.json, 使用引擎默认配置');
    const core = await createRecommenderCore({
      dataDir,
      engineEntry,
      configPath: fs.existsSync(asarReal(configPath)) ? configPath : undefined,
      log,
    });
    log(`[CineFlow:Rec] 引擎就绪: ${JSON.stringify(core.status())}`);
    return core;
  })();
  registerRecIpc({ ipcMain, corePromise, log });
  return corePromise;
}

module.exports = {
  USER_ID,
  cardToItemMeta,
  itemToCard,
  createRecommenderCore,
  registerRecIpc,
  initRecommender,
};
