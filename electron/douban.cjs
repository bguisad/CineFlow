'use strict';

/**
 * v3.4.2 纯增量：豆瓣元数据（学习 LibreTV 的公开接口用法）。
 *
 * LibreTV（LibreSpark/LibreTV）的服务端实现里有三条豆瓣公开端点：
 *   - 推荐列表 GET https://movie.douban.com/j/search_subjects
 *       ?type=movie|tv&tag=热门&sort=recommend&page_limit=N&page_start=0
 *       必带 UA + Referer: https://movie.douban.com/
 *   - 联想     GET https://movie.douban.com/j/subject_suggest?q=片名
 *       返回 [{id,title,sub_title,year,type,img,episode}]
 *   - 摘要     GET https://movie.douban.com/j/subject_abstract?subject_id=ID
 *       返回 评分/类型/导演/演员/地区/时长/短评，标题里带年份
 * 它把结果在服务端缓存 10 分钟、直连失败才降级到公共 CORS 代理。这里照同样思路，
 * 但请求走 Electron 的 defaultSession（因此继承应用里配置的代理），并且多一个图片中转：
 * 豆瓣图片 CDN 对无 Referer 的请求返回 418、对错误 Referer 返回 403，只有带上
 * `Referer: https://movie.douban.com/` 才是 200，所以海报必须由主进程取字节再回传。
 *
 * 全程 best-effort：任何失败都返回 { ok:false, error }，绝不让调用方抛异常。
 *
 * 第二十八轮加了两件事（都只在这条兜底链里，基线播放/图片链路一行未动）：
 *   - **落盘缓存**（`cacheDir`，由 main.cjs 传 userData 子目录）：热门片单 7 天内直接当新鲜结果用，
 *     海报 30 天内命中就零请求。一次首页要中转 36 张图，反复刷新很容易被豆瓣 CDN 判限流，
 *     一旦限流就是"海报出不来、刷新也没用"；存盘后刷新不再敲豆瓣的门，网络失败还能拿旧的顶上
 *     （stale-if-error）。
 *   - **备用地址重试**：同一张海报在豆瓣 CDN 上有多个子域（img1..img9）与多个尺寸段
 *     （s_/m_/l_ratio_poster、s_poster），某一条被判 418/403 时换一条往往就通，最多再试 3 条。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DOUBAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DOUBAN_REFERER = 'https://movie.douban.com/';
const HOT_URL = 'https://movie.douban.com/j/search_subjects';
const SUGGEST_URL = 'https://movie.douban.com/j/subject_suggest';
const ABSTRACT_URL = 'https://movie.douban.com/j/subject_abstract';
const SEARCH_URL = 'https://m.douban.com/rexxar/api/v2/search/subjects';
const IMAGE_HOST_RE = /^https:\/\/[a-z0-9-]+\.doubanio\.com\//i;

const JSON_TTL_MS = 10 * 60 * 1000;
const JSON_CACHE_MAX = 120;
const IMAGE_TTL_MS = 30 * 60 * 1000;
const IMAGE_CACHE_MAX = 160;
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const MIN_REQUEST_GAP_MS = 320;
const STRIKE_LIMIT = 3;
const COOLDOWN_MS = 60 * 1000;
// 落盘缓存：一次首页要中转 36 张海报，反复刷新很容易被豆瓣 CDN 判限流（418/403），
// 表现就是"海报出不来、刷新也没用"。存盘后刷新零请求，网络挂了还能拿旧的顶上。
const DISK_JSON_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const DISK_IMAGE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const DISK_IMAGE_MAX_FILES = 420;

function cleanText(value) {
  return String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value) {
  return cleanText(value)
    .replace(/[《》「」【】[\]()（）"“”'‘’]/g, '')
    .replace(/\s*\(\d{4}\)\s*$/g, '')
    .replace(/[\s·:：\-—_,，.。/]/g, '')
    .toLowerCase();
}

function normalizeType(value) {
  return String(value || '').toLowerCase() === 'tv' ? 'tv' : 'movie';
}

function yearOf(value) {
  const match = /(19|20)\d{2}/.exec(String(value || ''));
  return match ? match[0] : '';
}

function toDoubanImageUrl(url) {
  return String(url || '').replace(/\\\//g, '/').replace(/^http:\/\//i, 'https://');
}

// 备用图片地址：同一张海报在豆瓣 CDN 上有多个子域与多个尺寸段，任一条被限流时换一条往往就通
function alternateImageUrls(url) {
  const out = [];
  const base = toDoubanImageUrl(url);
  if (!IMAGE_HOST_RE.test(base)) return out;
  const ratios = ['s_ratio_poster', 'm_ratio_poster', 'l_ratio_poster', 's_poster', 'ratio_poster'];
  for (const ratio of ratios) {
    const swapped = base.replace(/\/(s|m|l|n)_?ratio_poster\/|\/s_poster\/|\/ratio_poster\//, `/${ratio}/`);
    if (swapped !== base && !out.includes(swapped)) out.push(swapped);
  }
  const host = /(https:\/\/img)(\d)(\.doubanio\.com\/)/i.exec(base);
  if (host) {
    for (const n of [host[2] === '2' ? '3' : '2', '9', '1']) {
      const swapped = `${host[1]}${n}${host[3]}${base.slice(host[0].length)}`;
      if (!out.includes(swapped)) out.push(swapped);
    }
  }
  return out.slice(0, 3);
}

function createDiskCache(cacheDir) {
  if (!cacheDir) return { enabled: false };
  const jsonDir = path.join(cacheDir, 'json');
  const imageDir = path.join(cacheDir, 'img');
  try {
    fs.mkdirSync(jsonDir, { recursive: true });
    fs.mkdirSync(imageDir, { recursive: true });
  } catch {
    return { enabled: false };
  }
  const file = (dir, key, ext) => path.join(dir, `${crypto.createHash('sha1').update(String(key)).digest('hex')}${ext}`);
  const put = (dir, key, ext, value) => {
    try {
      fs.writeFileSync(file(dir, key, ext), value);
      return true;
    } catch {
      return false;
    }
  };
  const get = (dir, key, ext) => {
    try {
      const target = file(dir, key, ext);
      const stat = fs.statSync(target);
      return { text: fs.readFileSync(target, 'utf8'), at: stat.mtimeMs };
    } catch {
      return null;
    }
  };
  return {
    enabled: true,
    readJson(key, maxAgeMs) {
      const found = get(jsonDir, key, '.json');
      if (!found) return null;
      try {
        const parsed = JSON.parse(found.text);
        return { payload: parsed?.payload, at: Number(parsed?.at) || found.at, fresh: Date.now() - (Number(parsed?.at) || found.at) < maxAgeMs };
      } catch {
        return null;
      }
    },
    writeJson(key, payload) {
      return put(jsonDir, key, '.json', JSON.stringify({ at: Date.now(), payload }));
    },
    readImage(url) {
      const found = get(imageDir, url, '.json');
      if (!found) return null;
      try {
        const parsed = JSON.parse(found.text);
        if (!parsed?.base64) return null;
        return {
          contentType: parsed.contentType || 'image/jpeg',
          base64: parsed.base64,
          at: Number(parsed.at) || found.at,
          fresh: Date.now() - (Number(parsed.at) || found.at) < DISK_IMAGE_MAX_AGE_MS,
        };
      } catch {
        return null;
      }
    },
    writeImage(url, contentType, base64) {
      const saved = put(imageDir, url, '.json', JSON.stringify({ at: Date.now(), contentType, base64 }));
      if (!saved) return false;
      // 只做条数封顶，按 mtime 淘汰最旧的；不做 LRU，省一次读
      try {
        const names = fs.readdirSync(imageDir);
        if (names.length <= DISK_IMAGE_MAX_FILES) return true;
        const stale = names
          .map((name) => ({ name, at: fs.statSync(path.join(imageDir, name)).mtimeMs }))
          .sort((a, b) => a.at - b.at)
          .slice(0, names.length - DISK_IMAGE_MAX_FILES);
        for (const entry of stale) fs.unlinkSync(path.join(imageDir, entry.name));
      } catch { /* 淘汰失败不影响读 */ }
      return true;
    },
  };
}

function createDoubanProvider({ session, cacheDir } = {}) {
  const jsonCache = new Map();
  const imageCache = new Map();
  const inflight = new Map();
  const disk = createDiskCache(cacheDir);
  let gate = Promise.resolve();
  let lastRequestAt = 0;
  let strikes = 0;
  let cooldownUntil = 0;

  function headers(kind) {
    if (kind === 'rexxar') {
      return {
        'user-agent': DOUBAN_UA,
        referer: 'https://m.douban.com/',
        origin: 'https://m.douban.com',
        'x-requested-with': 'XMLHttpRequest',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6'
      };
    }
    return {
      'user-agent': DOUBAN_UA,
      referer: DOUBAN_REFERER,
      accept: kind === 'image' ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' : 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6'
    };
  }

  // 所有上游请求过同一道闸：最小间隔 320ms；连续被封 3 次就冷却 60s（豆瓣对突发的 418/403 很敏感）
  function schedule(task) {
    const run = gate.then(async () => {
      const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = Date.now();
      return task();
    });
    gate = run.catch(() => {});
    return run;
  }

  async function upstreamJson(target, cacheKey, kind = 'json') {
    const cached = jsonCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.payload;
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    // 热门片单落盘后 7 天内直接当新鲜结果用：刷十次首页就是二十次列表请求，没必要每次敲门，
    // 而一旦被判限流，整条片单会连同海报一起空掉（用户读作"海报没出来、刷新也没用"）。
    if (disk.enabled && cacheKey.startsWith('hot:')) {
      const onDisk = disk.readJson(cacheKey, DISK_JSON_MAX_AGE_MS);
      if (onDisk?.payload?.ok) {
        jsonCache.set(cacheKey, { expiresAt: Date.now() + JSON_TTL_MS, payload: onDisk.payload });
        return onDisk.payload;
      }
    }
    const stale = disk.enabled ? disk.readJson(cacheKey, DISK_JSON_MAX_AGE_MS) : null;
    if (cooldownUntil > Date.now()) {
      return stale?.payload?.ok ? stale.payload : { ok: false, error: '豆瓣限流冷却中' };
    }
    const request = (async () => {
      try {
        const payload = await schedule(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
          try {
            const response = await session.defaultSession.fetch(target, {
              method: 'GET',
              headers: headers(kind),
              redirect: 'follow',
              signal: controller.signal
            });
            if (response.status === 418 || response.status === 403 || response.status === 429) {
              strikes += 1;
              if (strikes >= STRIKE_LIMIT) cooldownUntil = Date.now() + COOLDOWN_MS;
              return { ok: false, error: `豆瓣限流 ${response.status}` };
            }
            strikes = 0;
            if (!response.ok) return { ok: false, error: `豆瓣状态 ${response.status}` };
            const text = await response.text();
            try {
              return { ok: true, data: JSON.parse(text) };
            } catch {
              return { ok: false, error: '豆瓣返回非 JSON' };
            }
          } finally {
            clearTimeout(timer);
          }
        });
        if (payload.ok) {
          if (jsonCache.size >= JSON_CACHE_MAX) jsonCache.delete(jsonCache.keys().next().value);
          jsonCache.set(cacheKey, { expiresAt: Date.now() + JSON_TTL_MS, payload });
          if (disk.enabled) disk.writeJson(cacheKey, payload);
          return payload;
        }
        // 网络/限流失败时拿落盘的旧结果顶上（stale-if-error），总比整条轨道空着好
        return stale?.payload?.ok ? stale.payload : payload;
      } catch (error) {
        if (stale?.payload?.ok) return stale.payload;
        return { ok: false, error: error?.name === 'AbortError' ? '豆瓣请求超时' : String(error?.message || error) };
      } finally {
        inflight.delete(cacheKey);
      }
    })();
    inflight.set(cacheKey, request);
    return request;
  }

  async function hot({ type = 'movie', tag = '热门', pageStart = 0, pageSize = 24 } = {}) {
    const mediaType = normalizeType(type);
    const safeTag = String(tag || '热门').slice(0, 20);
    const start = Math.max(0, Number(pageStart) || 0);
    const size = Math.min(50, Math.max(1, Number(pageSize) || 24));
    const target = `${HOT_URL}?type=${mediaType}&tag=${encodeURIComponent(safeTag)}&sort=recommend&page_limit=${size}&page_start=${start}`;
    const payload = await upstreamJson(target, `hot:${mediaType}:${safeTag}:${start}:${size}`);
    if (!payload.ok) return payload;
    const subjects = Array.isArray(payload.data?.subjects) ? payload.data.subjects : [];
    return {
      ok: true,
      items: subjects.map((item) => ({
        id: String(item.id || ''),
        title: cleanText(item.title),
        cover: toDoubanImageUrl(item.cover),
        rating: item.rate && item.rate !== '0' ? String(item.rate) : '',
        url: String(item.url || ''),
        isTv: mediaType === 'tv',
        mediaType
      })).filter((item) => item.id && item.title)
    };
  }

  async function suggest(query) {
    const q = cleanText(query).slice(0, 40);
    if (!q) return { ok: true, items: [] };
    const payload = await upstreamJson(`${SUGGEST_URL}?q=${encodeURIComponent(q)}`, `suggest:${q}`);
    if (!payload.ok) return payload;
    const list = Array.isArray(payload.data) ? payload.data : [];
    return {
      ok: true,
      debug: { isArray: Array.isArray(payload.data), kind: typeof payload.data, keys: payload.data && !Array.isArray(payload.data) ? Object.keys(payload.data).slice(0, 6) : [], total: list.length },
      items: list.map((item) => ({
        id: String(item.id || ''),
        title: cleanText(item.title),
        subTitle: cleanText(item.sub_title),
        year: yearOf(item.year),
        type: String(item.type || ''),
        mediaType: String(item.type || '').toLowerCase() === 'tv' ? 'tv' : 'movie',
        cover: toDoubanImageUrl(item.img),
        episode: String(item.episode || '')
      })).filter((item) => item.id && item.title)
    };
  }

  // rexxar 条目搜索：比 suggest 稳，直接带封面 / 评分 / 年份 / 简介
  async function search({ query, type = 'movie', count = 8 } = {}) {
    const q = cleanText(query).slice(0, 40);
    if (!q) return { ok: true, items: [] };
    const mediaType = normalizeType(type);
    const size = Math.min(20, Math.max(1, Number(count) || 8));
    const target = `${SEARCH_URL}?q=${encodeURIComponent(q)}&type=${mediaType}&count=${size}`;
    const payload = await upstreamJson(target, `subjects:${mediaType}:${q}:${size}`, 'rexxar');
    if (!payload.ok) return payload;
    const items = Array.isArray(payload.data?.subjects?.items) ? payload.data.subjects.items : [];
    return {
      ok: true,
      items: items.map((item) => {
        const data = item?.target || {};
        return {
          id: String(data.id || ''),
          title: cleanText(data.title),
          year: yearOf(data.year),
          cover: toDoubanImageUrl(data.cover_url),
          rating: Number(data.rating?.value) || 0,
          mediaType,
          abstract: cleanText(data.abstract)
        };
      }).filter((item) => item.id && item.title)
    };
  }

  async function subject({ id, type = 'movie' } = {}) {
    const subjectId = String(id || '').trim();
    if (!/^\d+$/.test(subjectId)) return { ok: false, error: '无效的豆瓣条目' };
    const payload = await upstreamJson(`${ABSTRACT_URL}?subject_id=${subjectId}`, `abstract:${subjectId}`);
    if (!payload.ok) return payload;
    const data = payload.data?.subject || {};
    const titleWithYear = cleanText(data.title);
    return {
      ok: true,
      subject: {
        id: subjectId,
        mediaType: String(data.subtype || '').toLowerCase() === 'tv' || data.is_tv ? 'tv' : normalizeType(type),
        title: titleWithYear.replace(/\s*\([^)]*\)\s*$/g, '').replace(/\u200e/g, '').trim(),
        titleWithYear,
        year: yearOf(data.release_year || titleWithYear),
        rating: cleanText(data.rate),
        star: Number(data.star) || 0,
        intro: cleanText(data.short_comment?.content),
        genres: Array.isArray(data.types) ? data.types.map(cleanText).filter(Boolean) : [],
        region: cleanText(data.region),
        duration: cleanText(data.duration),
        directors: Array.isArray(data.directors) ? data.directors.map(cleanText).filter(Boolean).slice(0, 3) : [],
        actors: Array.isArray(data.actors) ? data.actors.map(cleanText).filter(Boolean).slice(0, 8) : [],
        episodes: cleanText(data.episodes_count),
        url: String(data.url || '')
      }
    };
  }

  function pickCover(items, { title, year, type }) {
    const wanted = normalizeTitle(title);
    const wantedYear = yearOf(year);
    const wantedType = normalizeType(type);
    let best = null;
    for (const item of items) {
      if (!item.cover) continue;
      const itemTitle = normalizeTitle(item.title);
      let score = 0;
      if (itemTitle === wanted) score += 100;
      else if (itemTitle.startsWith(wanted) || wanted.startsWith(itemTitle)) score += 40;
      else if (itemTitle.includes(wanted) || wanted.includes(itemTitle)) score += 15;
      else continue;
      if (wantedYear && item.year === wantedYear) score += 30;
      if (item.mediaType === wantedType) score += 12;
      if (!best || score > best.score) best = { score, item };
    }
    return best?.item || null;
  }

  // 豆瓣联想只对短查询稳定：长标题、带冒号/副标题的经常直接返回空，需要逐级缩短再试
  function posterQueries(title) {
    const full = cleanText(title);
    const plain = full.replace(/[：:·\-—|｜]/g, ' ').replace(/\s+/g, ' ').trim();
    const beforeColon = full.split(/[：:·\-—|｜]/)[0].trim();
    const compact = full.replace(/[\s：:·\-—|｜]/g, '');
    return [...new Set([
      full,
      plain,
      beforeColon,
      compact.slice(0, 8),
      compact.slice(0, 6),
      compact.slice(0, 4)
    ])].filter((value) => value.length >= 2);
  }

  async function poster({ title, year, type = 'movie', cover = '' } = {}) {
    const direct = toDoubanImageUrl(cover);
    if (IMAGE_HOST_RE.test(direct)) return { ok: true, url: direct, matched: null };
    const query = cleanText(title);
    if (!query) return { ok: false, error: '没有片名' };
    for (const attempt of posterQueries(query).slice(0, 3)) {
      const found = await search({ query: attempt, type, count: 8 });
      if (found.ok && found.items.length) {
        const match = pickCover(found.items, { title: query, year, type }) || pickCover(found.items, { title: attempt, year, type });
        if (match) return { ok: true, url: match.cover, matched: { id: match.id, title: match.title, year: match.year, query: attempt } };
      }
    }
    // rexxar 也拿不到时才退回老接口
    const result = await suggest(query);
    if (!result.ok) return result;
    const match = pickCover(result.items, { title: query, year, type });
    if (!match) return { ok: false, error: '豆瓣没有匹配条目' };
    return { ok: true, url: match.cover, matched: { id: match.id, title: match.title, year: match.year } };
  }

  let imageActive = 0;
  const imageWaiters = [];
  async function withImageSlot(task) {
    if (imageActive >= 4) await new Promise((resolve) => imageWaiters.push(resolve));
    imageActive += 1;
    try { return await task(); } finally {
      imageActive -= 1;
      const next = imageWaiters.shift();
      if (next) next();
    }
  }

  async function fetchImageOnce(target) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await session.defaultSession.fetch(target, {
        method: 'GET',
        headers: headers('image'),
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) return { ok: false, error: `图片状态 ${response.status}` };
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) return { ok: false, error: '图片为空' };
      if (buffer.length > IMAGE_MAX_BYTES) return { ok: false, error: '图片过大' };
      return { ok: true, contentType: response.headers.get('content-type') || 'image/jpeg', base64: buffer.toString('base64') };
    } finally {
      clearTimeout(timer);
    }
  }

  async function image({ url } = {}) {
    const target = toDoubanImageUrl(url);
    if (!IMAGE_HOST_RE.test(target)) return { ok: false, error: '非豆瓣图片域名' };
    const cached = imageCache.get(target);
    if (cached && cached.expiresAt > Date.now()) return cached.payload;
    if (inflight.has(target)) return inflight.get(target);
    const onDisk = disk.enabled ? disk.readImage(target) : null;
    if (onDisk?.fresh) {
      const payload = { ok: true, contentType: onDisk.contentType, base64: onDisk.base64 };
      if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
      imageCache.set(target, { expiresAt: Date.now() + IMAGE_TTL_MS, payload });
      return payload; // 落盘命中：零网络请求，刷新/重启都是即时出图
    }
    const request = (async () => {
      const remember = (payload) => {
        if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
        imageCache.set(target, { expiresAt: Date.now() + IMAGE_TTL_MS, payload });
        if (disk.enabled) disk.writeImage(target, payload.contentType, payload.base64);
      };
      try {
        let payload = await withImageSlot(() => fetchImageOnce(target).catch((error) => ({
          ok: false,
          error: error?.name === 'AbortError' ? '图片超时' : String(error?.message || error),
        })));
        if (!payload.ok) {
          // 同图多子域 / 多尺寸段：某一条被限流时换一条往往就通
          for (const alternate of alternateImageUrls(target)) {
            payload = await withImageSlot(() => fetchImageOnce(alternate).catch(() => payload));
            if (payload.ok) break;
          }
        }
        if (payload.ok) remember(payload);
        // 全失败就用落盘的旧图顶着（stale-if-error），别把卡片留在占位上
        return payload.ok || !onDisk ? payload : { ok: true, contentType: onDisk.contentType, base64: onDisk.base64 };
      } catch (error) {
        if (onDisk) return { ok: true, contentType: onDisk.contentType, base64: onDisk.base64 };
        return { ok: false, error: String(error?.message || error) };
      } finally {
        inflight.delete(target);
      }
    })();
    inflight.set(target, request);
    return request;
  }

  return { hot, suggest, search, subject, poster, image };
}

module.exports = { createDoubanProvider, normalizeTitle, yearOf };
