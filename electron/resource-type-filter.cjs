'use strict';

const YEAR_ONLY = /^(19|20)\d{2}$/;

const SERIES_TYPE_WORDS = /(连续剧|电视剧|国产剧|国产电视剧|港台剧|港台电视剧|日韩剧|日剧|韩剧|欧美剧|美剧|英剧|海外剧|其他剧|泰剧|马国剧|综艺|综艺节目|真人秀|脱口秀|选秀|节目|番剧|短剧)/;

const SERIES_REMARKS = /(更新至?\s*\d+\s*[集期话]|全\s*\d+\s*[集期话]|共\s*\d+\s*[集期话]|第\s*\d+\s*[集期话]|完结\s*\d+\s*[集期话]|\d+\s*[集期话]\s*)$/;
const MOVIE_TYPE_WORDS = /(电影|影片|动画电影|剧情片|喜剧片|动作片|爱情片|科幻片|恐怖片|悬疑片|战争片|记录片|纪录片|动漫电影|4K电影|电影)/;
const MOVIE_REMARKS = /(HD|BD|DVD|TC|TS|SCR|CAM|WEB-?Rip|WEBDL|Blu-?ray|4K|1080P|720P|2160P|中字|双语|国语|粤语|日语|英语|原声|无删减|完整版|正片|高清|蓝光|抢先)/i;

const SERIES_EPISODE_MIN = 8;

const NON_FEATURE_WORDS = /(解说|速看|图解|预告|花絮|彩蛋|特别篇|番外|幕后|访谈|片尾曲|主题曲|MV|定档|定档预告)/i;

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

    const nonFeature = `${resource.title || ''} ${resource.remarks || ''} ${resource.type || ''}`;
    if (NON_FEATURE_WORDS.test(nonFeature)) {
      reject(resource, `非正片内容（${(NON_FEATURE_WORDS.exec(nonFeature)[0] || '').trim()}）`);
      continue;
    }
    const verdict = classifyResourceKind(resource);

    if (verdict.kind !== 'unknown' && verdict.kind !== want) { reject(resource, `${verdict.reason}（要${want === 'tv' ? '节目' : '电影'}）`); continue; }

    if (yearConflict(resource, payload)) {
      reject(resource, `同名但年份对不上（源 ${String(resource.year || '').slice(0, 4)}）`);
      continue;
    }
    kept.push(resource);
  }
  return { resources: kept, dropped };
}

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
