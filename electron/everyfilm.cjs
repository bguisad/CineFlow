/**
 * v3.4.3 纯增量：every.film 开放元数据（无 TMDB 凭证时的海报 / 身份解析兜底）。
 *
 * 逆向结论（实测，见 CINEFLOW_CONTEXT.md 第二十五轮）：
 *   GET /api/v1/search?q=      → { query, counts, results:{ media[], people[] } }，匿名可读
 *   GET /api/v1/media/{uuid}   → { titles[]（含中文别名）, mappings[]（tmdb/imdb/douban 外部 id + 各自评分）}
 *   GET /api/v1/img/media/…    → 海报，直连 200，不需要 Referer（比豆瓣图片省事）
 *   GET /3/…                   → TMDB 兼容接口，但**要审批过的密钥**（无 key 直接 401），所以不能当 TMDB 替身
 *   没有 简介 / 类型 / 演职员 端点 → 这几项仍然只能靠豆瓣或 TMDB，本模块不负责。
 *
 * 遵守该站《API 使用条款》（https://every.film/zh-CN/api-terms-of-use）：
 *   读取无需密钥；署名 every.film 且给回链（渲染层负责显示）；
 *   匿名读有速率限制 → 这里做单道闸串行 + 最小间隔 + 429 时按 Retry-After 退避 + 结果长缓存；
 *   不高并发、不分摊绕限、不抓 HTML 代替 API（本模块只打 /api/v1 的 JSON 端点）。
 * 摘除办法：删本文件、main.cjs 末尾 everyfilm 段、preload 的 expose、src/douban-fallback.js 里标了
 * 「every.film」的那几处，即完全回到只做豆瓣的版本。
 */

const API_ROOT = 'https://every.film/api/v1';
const UA = 'CineFlow/3.4.4 (personal desktop app; metadata via every.film)';
const SOURCE_HOME = 'https://every.film/';
const https = require('node:https');

const REQUEST_TIMEOUT_MS = 7000;
const MIN_REQUEST_GAP_MS = 420; // 个人维护的开放数据项目，比豆瓣那层再慢一点
const CACHE_MAX = 160;
const SEARCH_TTL_MS = 6 * 60 * 1000;
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MS = 20 * 1000; // 拿不到 Retry-After 时的默认退避
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

function clean(value) {
  return String(value == null ? '' : value).replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value) {
  return clean(value).toLowerCase().replace(/[\s·:：\-—_,，.。/\\()（）\[\]【】《》]/g, '');
}

function yearOf(value) {
  const hit = /(19|20)\d{2}/.exec(String(value || ''));
  return hit ? hit[0] : '';
}

function absoluteImage(url) {
  const raw = clean(url);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/api/')) return `https://every.film${raw}`;
  return '';
}

// 他们自家图片端点支持 ?w= 缩放：不带参数会 302 到原图（实测 414KB / 1000×1500），
// 卡片位只要 342 宽（实测 ~43KB），首屏和解码成本差一个量级。
function sizedImage(url, width = 342) {
  const target = absoluteImage(url);
  if (!/^https:\/\/every\.film\/api\/v1\/img\//i.test(target) || target.includes('?w=')) return target;
  return `${target}?w=${width}`;
}

function pickTitle(titles, uuidTitle) {
  const list = Array.isArray(titles) ? titles : [];
  const score = (row) => {
    const lang = clean(row.language_code).toLowerCase();
    const country = clean(row.country_code).toUpperCase();
    let value = 0;
    if (country === 'CN') value += 60;
    if (country === 'TW' || country === 'HK') value += 40;
    if (lang.startsWith('zh')) value += 30;
    if (row.is_primary) value += 8;
    if (clean(row.title_type) === 'common') value += 4;
    if (clean(row.title_type) === 'alias') value += 1;
    return value;
  };
  const best = list.slice().sort((a, b) => score(b) - score(a))[0];
  const candidate = clean(best && best.title);
  if (candidate && /[\u4e00-\u9fff]/.test(candidate)) return candidate;
  return clean(uuidTitle);
}

function idsFrom(mappings) {
  const out = {};
  for (const row of Array.isArray(mappings) ? mappings : []) {
    const platform = clean(row.source_platform).toLowerCase();
    const external = clean(row.external_id);
    if (!platform || !external) continue;
    if (!out[platform]) out[platform] = external;
    const score = Number(row.rating_score);
    if (Number.isFinite(score) && score > 0 && !out[`${platform}Rating`]) out[`${platform}Rating`] = score.toFixed(1);
  }
  return out;
}

function createEveryfilmProvider({ session }) {
  const cache = new Map();
  const inflight = new Map();
  let gate = Promise.resolve();
  let lastRequestAt = 0;
  let blockedUntil = 0;

  function remember(key, payload, ttl) {
    cache.set(key, { payload, expiresAt: Date.now() + ttl });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return payload;
  }

  // 单道闸串行 + 最小间隔：条款要求善意使用，不允许高并发洪泛
  function schedule(task) {
    const run = gate.then(async () => {
      if (blockedUntil > Date.now()) await new Promise((resolve) => setTimeout(resolve, blockedUntil - Date.now() + 10));
      const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      return task();
    });
    gate = run.catch(() => {});
    return run;
  }

  // 传输顺序很关键：这台机器的代理出口被 Cloudflare 判 403（实测 直连 200 / 走 7897 代理 403），
  // 而 Electron 主进程里的 global fetch 仍走 Chromium 网络栈（会吃 session 代理），
  // 所以"直连"必须用 node:https —— 它是真·Node 网络栈，不套代理。失败再退回 session（照顾只有代理能出网的网络）。
  function nodeRequest(target, { binary = false, hops = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.get(target, {
        headers: headersFor(),
        timeout: REQUEST_TIMEOUT_MS,
        servername: 'every.film'
      }, (res) => {
        // 图片端点会 302 到签名后的 CDN 地址，必须跟跳转（最多 3 跳）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          nodeRequest(next, { binary, hops: hops + 1 }).then(resolve, reject);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > IMAGE_MAX_BYTES) { req.destroy(new Error('图片过大')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode || 0,
            headers: { get: (name) => res.headers[String(name).toLowerCase()] },
            contentType: String(res.headers['content-type'] || ''),
            buffer: binary ? body : null,
            text: binary ? '' : body.toString('utf8')
          });
        });
      });
      req.on('timeout', () => req.destroy(new Error('超时')));
      req.on('error', reject);
    });
  }

  async function transportDirect(target, options) {
    const response = await nodeRequest(target, options);
    return {
      status: response.status,
      headers: response.headers,
      contentType: response.contentType,
      json: async () => JSON.parse(response.text),
      buffer: async () => response.buffer
    };
  }

  async function transportSession(target, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await session.defaultSession.fetch(target, { method: 'GET', headers: headersFor(), cache: 'reload' });
      return {
        status: response.status,
        headers: response.headers,
        contentType: String(response.headers.get('content-type') || ''),
        json: async () => response.json(),
        buffer: async () => Buffer.from(await response.arrayBuffer())
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function headersFor() {
    return {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      origin: SOURCE_HOME,
      referer: SOURCE_HOME
    };
  }

  // 出口顺序固定：先 node:https 直连（不套代理），只有**网络层失败**（本机必须走代理出网、DNS 不通等）
  // 才退回 session 走代理。HTTP 4xx 不再换出口 —— 实测走代理那条路会被 Cloudflare 判 403，
  // 而 403 要等代理跑完才有结果，把它当"可重试"会让队列白等十几秒。
  async function attempt(target, { binary = false } = {}) {
    const order = [transportDirect, transportSession];
    let lastError = '';
    for (const transport of order) {
      try {
        const response = await transport(target, { binary });
        if (response.status === 429) {
          const seconds = Number(response.headers.get('retry-after')) || Math.ceil(BACKOFF_MS / 1000);
          blockedUntil = Date.now() + Math.min(Math.max(seconds, 1) * 1000, 120000);
          return { ok: false, code: 'RATE_LIMITED', error: `every.film 限流，${seconds}s 后再试` };
        }
        if (response.status < 200 || response.status >= 300) {
          return { ok: false, error: `HTTP ${response.status}`, code: response.status === 403 ? 'BLOCKED' : '' };
        }
        return { ok: true, response };
      } catch (error) {
        lastError = String(error?.message || error);
      }
    }
    return { ok: false, error: lastError || 'every.film 不可达' };
  }

  async function getJson(target, cacheKey, ttl) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.payload;
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    const task = (async () => {
      try {
        return await schedule(async () => {
          const result = await attempt(target);
          if (!result.ok) return { ok: false, error: result.error, code: result.code };
          try {
            return { ok: true, json: await result.response.json() };
          } catch (error) {
            return { ok: false, error: `响应解析失败：${String(error?.message || error)}` };
          }
        });
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      } finally {
        inflight.delete(cacheKey);
      }
    })();
    inflight.set(cacheKey, task);
    const result = await task;
    if (result?.ok) remember(cacheKey, result, ttl);
    return result;
  }

  // 图片：渲染层 <img> 走的是 session（会撞代理 403），所以这里用同一套传输把字节取回来转 data URL
  async function image({ url = '' } = {}) {
    const target = clean(url);
    if (!/^https:\/\/every\.film\/api\/v1\/img\//i.test(target)) return { ok: false, error: '地址不是 every.film 图片' };
    const result = await schedule(async () => attempt(target, { binary: true }));
    if (!result.ok) return { ok: false, error: result.error, code: result.code };
    const buffer = await result.response.buffer();
    if (!buffer || !buffer.length) return { ok: false, error: '空响应' };
    return { ok: true, contentType: result.response.contentType || 'image/jpeg', base64: buffer.toString('base64'), bytes: buffer.length };
  }

  function shape(row) {
    return {
      uuid: clean(row.id),
      type: row.type === 'tv' ? 'tv' : 'movie',
      title: clean(row.display_title) || clean(row.original_title),
      originalTitle: clean(row.original_title),
      year: yearOf(row.original_release_date),
      poster: sizedImage(row.poster_stored_url) || absoluteImage(row.poster_url),
      rating: clean(row.fused_rating),
      votes: Number(row.fused_votes) || 0,
      source: clean(row.primary_source),
      slug: clean(row.slug)
    };
  }

  async function search({ query = '', type = '', limit = 8 } = {}) {
    const term = clean(query);
    if (!term) return { ok: false, error: '缺少查询词' };
    const want = type === 'tv' ? 'tv' : type === 'movie' ? 'movie' : '';
    const target = `${API_ROOT}/search?q=${encodeURIComponent(term)}`;
    const result = await getJson(target, `search:${term}:${want}`, SEARCH_TTL_MS);
    if (!result?.ok) return { ok: false, error: result?.error || 'every.film 无响应', code: result?.code };
    const rows = (result.json?.results?.media || []).map(shape).filter((item) => item.uuid && item.title);
    const items = (want ? rows.filter((item) => !item.type || item.type === want) : rows).slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)));
    return { ok: true, items, counts: result.json?.counts || {} };
  }

  async function detail({ uuid = '' } = {}) {
    const id = clean(uuid);
    if (!/^[0-9a-f-]{20,40}$/i.test(id)) return { ok: false, error: 'uuid 不合法' };
    const result = await getJson(`${API_ROOT}/media/${id}`, `detail:${id}`, DETAIL_TTL_MS);
    if (!result?.ok) return { ok: false, error: result?.error || 'every.film 无响应', code: result?.code };
    const raw = result.json || {};
    const ids = idsFrom(raw.mappings);
    return {
      ok: true,
      meta: {
        uuid: id,
        type: raw.type === 'tv' ? 'tv' : 'movie',
        originalTitle: clean(raw.original_title),
        zhTitle: pickTitle(raw.titles, raw.original_title),
        year: yearOf(raw.original_release_date),
        language: clean(raw.original_language),
        fusedRating: clean(raw.fused_rating),
        tmdbId: ids.tmdb || '',
        imdbId: ids.imdb || '',
        doubanId: ids.douban || '',
        tmdbRating: ids.tmdbRating || '',
        doubanRating: ids.doubanRating || '',
        titleCount: Array.isArray(raw.titles) ? raw.titles.length : 0
      }
    };
  }

  // 中文片名 → 记录 + 各上游 id：标题按归一化全等优先，其次互相包含，年份只作加分不作门槛
  async function lookup({ query = '', year = '', type = '' } = {}) {
    const term = clean(query);
    if (!term) return { ok: false, error: '缺少片名' };
    const found = await search({ query: term, type, limit: 8 });
    if (!found?.ok || !found.items.length) return { ok: false, error: found?.error || 'every.film 没有匹配' };
    const left = normalizeTitle(term);
    const wantYear = yearOf(year);
    const scored = found.items.map((item) => {
      let score = 0;
      const candidates = [normalizeTitle(item.title), normalizeTitle(item.originalTitle)];
      if (candidates.includes(left)) score += 6;
      else if (candidates.some((c) => c && (c.includes(left) || left.includes(c)))) score += 3;
      if (wantYear && item.year === wantYear) score += 2;
      if (item.poster) score += 1;
      return { item, score };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 3) return { ok: false, error: 'every.film 匹配度过低', items: found.items };
    const merged = Object.assign({}, best.item, { matchScore: best.score });
    const full = await detail({ uuid: best.item.uuid });
    if (full?.ok) merged.meta = full.meta;
    return { ok: true, item: merged, candidates: found.items.slice(0, 4) };
  }

  return { search, detail, lookup, image, UA, SOURCE_HOME };
}

module.exports = { createEveryfilmProvider, normalizeTitle, yearOf, absoluteImage, sizedImage, SOURCE_HOME };
