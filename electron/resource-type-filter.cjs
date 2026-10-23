'use strict';
/**
 * v3.4.2 纯增量：播放源的"标题一致性 + 媒体类型"强过滤。
 *
 * 判据来自真包真源的实测样本（.r16-truth 调研）：
 *   《寄生虫》→ 电影天堂给出「寄生虫保姆」(单线路 64 集)
 *   《不择手段》→ 360/量子给出「假名媛她不择手段」(类别 爽文短剧 / 61 集)
 *   《疯狂动物城》→ 非凡/量子把它归在「欧美动漫」——这是**正确**类别（它本就是动画电影），
 *                   电影天堂/暴风只挂 2~6 个播放项，那是多线路/多画质而不是剧集。
 * 所以第一版"集数>1 或类别含动漫就判剧集"的写法误杀严重，本版改成：
 *   ① 标题强一致是主判据（归一化后必须相等，最多容忍一个 4 位年份尾巴）；
 *   ② 类型只作辅助，且不再把「动漫」当连载；单线路要 ≥8 集才判连载；
 *   ③ 备注里必须出现"更新/全/共 + 数字 + 集期"这类明确的连载标记才算连载；
 *   ④ 同名但年份差超过 1 年 → 判为不同作品（这是"同名不同片"的唯一可用信号）。
 * 判据不足时一律放行：宁可少过滤，绝不把可用资源清空。
 */

const YEAR_ONLY = /^(19|20)\d{2}$/;
// 连载类类别词。刻意不含「动漫 / 国漫 / 少儿 / 纪录片」——它们都可能是单部电影。
const SERIES_TYPE_WORDS = /(连续剧|电视剧|国产剧|国产电视剧|港台剧|港台电视剧|日韩剧|日剧|韩剧|欧美剧|美剧|英剧|海外剧|其他剧|泰剧|马国剧|综艺|综艺节目|真人秀|脱口秀|选秀|节目|番剧|短剧)/;
// 只有"数字 + 集/期/话"才是连载证据；「已完结」「HD中字」这类不算
const SERIES_REMARKS = /(更新至?\s*\d+\s*[集期话]|全\s*\d+\s*[集期话]|共\s*\d+\s*[集期话]|第\s*\d+\s*[集期话]|完结\s*\d+\s*[集期话]|\d+\s*[集期话]\s*)$/;
const MOVIE_TYPE_WORDS = /(电影|影片|动画电影|剧情片|喜剧片|动作片|爱情片|科幻片|恐怖片|悬疑片|战争片|记录片|纪录片|动漫电影|4K电影|电影)/;
const MOVIE_REMARKS = /(HD|BD|DVD|TC|TS|SCR|CAM|WEB-?Rip|WEBDL|Blu-?ray|4K|1080P|720P|2160P|中字|双语|国语|粤语|日语|英语|原声|无删减|完整版|正片|高清|蓝光|抢先)/i;
// 单线路挂这么多播放项才当连载；2~6 个在苹果CMS 里常是多条播放线路被并进同一 line
const SERIES_EPISODE_MIN = 8;
// 解说 / 预告 / 花絮这类是"另一段内容"，不是这部片子本身 —— 硬剔，不参与归一化豁免
const NON_FEATURE_WORDS = /(解说|速看|图解|预告|花絮|彩蛋|特别篇|番外|幕后|访谈|片尾曲|主题曲|MV|定档|定档预告)/i;

// 强归一化：剥括号内容、剥画质/版本词、剥集季尾巴、剥所有标点空白，只留可比对的正文。
// 注意这里**不剥**解说/预告那类词 —— 剥了就会把「寄生虫解说」错当成《寄生虫》本身。
const NOISE_WORDS = /(HD|BD|DVD|TC|TS|SCR|CAM|WEB-?Rip|WEBDL|Blu-?ray|4K|1080P|720P|2160P|中字|双语|国语|粤语|日语|英语|原声|无删减|未删减|完整版|正片|高清|蓝光|抢先)/gi;

function normalizeTitleStrict(raw) {
  let text = String(raw || '');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)|\{[^}]*\}/g, ' ');
  text = text.replace(/第\s*[0-9一二三四五六七八九十百]+\s*[季部集期话]/g, ' ');
  text = text.replace(NOISE_WORDS, ' ');
  text = text.toLowerCase();
  text = text.replace(/[\s\u3000·・:：,，.。!！?？;；'""''“”‘’《》〈〉「」\-—–_+/\\|~`^*]+/g, '');
  return text;
}

function targetTitles(payload = {}) {
  return [payload.title, payload.originalTitle, payload.name]
    .map((value) => normalizeTitleStrict(value))
    .filter(Boolean);
}

/**
 * 标题是否就是这部片子。
 * @returns {{ok: boolean, reason: string}}
 */
function verdictTitle(resource, payload) {
  const got = normalizeTitleStrict(resource.title);
  const wants = targetTitles(payload);
  if (!wants.length) return { ok: true, reason: '无目标标题可比' };
  if (!got) return { ok: false, reason: '资源无标题' };
  for (const want of wants) {
    if (got === want) return { ok: true, reason: '标题一致' };
  }
  for (const want of wants) {
    if (got.startsWith(want)) {
      const rest = got.slice(want.length);
      if (YEAR_ONLY.test(rest)) return { ok: true, reason: '同名带年份' };
      return { ok: false, reason: `标题多出「${rest}」` };
    }
    if (want.startsWith(got) && got.length >= 2) {
      return { ok: false, reason: `标题少了「${want.slice(got.length)}」` };
    }
  }
  return { ok: false, reason: '标题不是本片' };
}

/** 判定单条资源更像连载还是单片。标题不参与这里的判定，由 verdictTitle 负责。 */
function classifyResourceKind(resource = {}) {
  const type = String(resource.type || '').trim();
  const remarks = String(resource.remarks || '').trim();
  const seasonMax = Number(resource.seasonEpisodeCount || 0);
  const episodeCount = Number(resource.episodeCount || 0);

  if (seasonMax >= SERIES_EPISODE_MIN) return { kind: 'tv', reason: `单线路 ${seasonMax} 集` };
  if (SERIES_TYPE_WORDS.test(type)) return { kind: 'tv', reason: `类别「${type}」` };
  if (SERIES_REMARKS.test(remarks)) return { kind: 'tv', reason: `更新状态「${remarks}」` };
  if (MOVIE_TYPE_WORDS.test(type)) return { kind: 'movie', reason: `类别「${type}」` };
  if (MOVIE_REMARKS.test(remarks) && episodeCount <= SERIES_EPISODE_MIN) return { kind: 'movie', reason: `片源标记「${remarks}」` };
  return { kind: 'unknown', reason: '无类型信号' };
}

function yearConflict(resource, payload) {
  const want = Number(String(payload.year || payload.releaseDate || '').slice(0, 4));
  const got = Number(String(resource.year || resource.remarks || '').slice(0, 4));
  if (!Number.isFinite(want) || !Number.isFinite(got) || want < 1900 || got < 1900) return false;
  return Math.abs(want - got) > 1;
}

/**
 * 综合过滤：标题 → 类型 → 年份。
 * @param {Array} resources 基线 compactResourceItem 的产物
 * @param {object} payload 渲染端传来的查询（含 title / originalTitle / mediaType / year）
 * @returns {{resources: Array, dropped: Array<{title, sourceName, reason}>}}
 */
function filterResources(resources, payload = {}) {
  if (!Array.isArray(resources) || !resources.length) return { resources: resources || [], dropped: [] };
  const want = String(payload.mediaType || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
  const kept = [];
  const dropped = [];
  const reject = (resource, reason) => dropped.push({
    title: String(resource.title || ''),
    sourceName: String(resource.sourceName || ''),
    reason
  });

  for (const resource of resources) {
    const title = verdictTitle(resource, payload);
    if (!title.ok) { reject(resource, title.reason); continue; }
    // 标题对得上，但内容其实是解说/预告那一类 —— 不是这部片子，硬剔
    const nonFeature = `${resource.title || ''} ${resource.remarks || ''} ${resource.type || ''}`;
    if (NON_FEATURE_WORDS.test(nonFeature)) {
      reject(resource, `非正片内容（${(NON_FEATURE_WORDS.exec(nonFeature)[0] || '').trim()}）`);
      continue;
    }
    const verdict = classifyResourceKind(resource);
    // 要电影却给出连载（或反之）→ 剔掉；unknown 一律放行
    if (verdict.kind !== 'unknown' && verdict.kind !== want) { reject(resource, `${verdict.reason}（要${want === 'tv' ? '节目' : '电影'}）`); continue; }
    // 同名不同作品：两边年份都能解析且差超过 1 年 → 剔（这是唯一可用的区分信号）
    if (yearConflict(resource, payload)) {
      reject(resource, `同名但年份对不上（源 ${String(resource.year || '').slice(0, 4)}）`);
      continue;
    }
    kept.push(resource);
  }
  return { resources: kept, dropped };
}

// 兼容上一版的调用口：只按类型过滤（保留给冒烟脚本与回退路径用）
function filterResourcesByMediaType(resources, mediaType) {
  return filterResources(resources, { mediaType });
}

module.exports = {
  classifyResourceKind,
  filterResources,
  filterResourcesByMediaType,
  normalizeTitleStrict,
  verdictTitle
};
