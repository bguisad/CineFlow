'use strict';
/**
 * CineFlow × rec-engine：TMDB 类型 id → 中文类型名 映射表（新增文件，零侵入）
 *
 * 背景：渲染层把卡片喂给推荐宿主时，详情/列表卡片只带数字 genreIds，
 * 而引擎的 TagChannel / 画像 genreWeights / 重排的 Jaccard 相似度全部按「类型名」工作。
 * 于是入库物料 genres 恒为空数组，标签路彻底失效（新用户档位只有 trending 在跑）。
 * 该模块把 genreIds 还原成与 TMDB zh-CN 一致的名称，渲染层 onboarding 里的
 * "剧情/爱情/喜剧" 等名称即可与物料标签对齐。
 */

/** 电影类型（TMDB movie genre id，zh-CN 名称） */
const MOVIE_GENRES = {
  28: '动作',
  12: '冒险',
  16: '动画',
  35: '喜剧',
  80: '犯罪',
  99: '纪录',
  18: '剧情',
  10751: '家庭',
  14: '奇幻',
  36: '历史',
  27: '恐怖',
  10402: '音乐',
  9648: '悬疑',
  10749: '爱情',
  878: '科幻',
  10770: '电视电影',
  53: '惊悚',
  10752: '战争',
  37: '西部'
};

/** 剧集类型（TMDB tv genre id，zh-CN 名称） */
const TV_GENRES = {
  10759: '动作冒险',
  16: '动画',
  35: '喜剧',
  80: '犯罪',
  99: '纪录',
  18: '剧情',
  10751: '家庭',
  10762: '儿童',
  9648: '悬疑',
  10763: '新闻',
  10764: '真人秀',
  10765: '科幻奇幻',
  10766: '肥皂剧',
  10767: '脱口秀',
  10768: '战争政治',
  37: '西部'
};

/** 与 src/renderer.js 的 MOVIE_TV_GENRE_ALIASES 保持一致：跨媒体类型的近似类型回退 */
const MOVIE_TV_GENRE_ALIASES = {
  12: [10759],
  14: [10765],
  28: [10759],
  53: [9648, 10759],
  878: [10765],
  10749: [18],
  10752: [10768],
  10759: [12, 28],
  10765: [14, 878],
  10768: [10752]
};

function toIdList(ids) {
  if (!Array.isArray(ids)) {
    if (typeof ids === 'string' && ids.trim()) return ids.split(',').map(Number).filter(Number.isFinite);
    return [];
  }
  return ids.map(Number).filter(Number.isFinite);
}

/** 单个 genreId → 类型名（先按媒体类型查表，再跨表回退，最后走别名表） */
function genreNameOf(id, mediaType = 'movie') {
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) return '';
  const primary = mediaType === 'tv' ? TV_GENRES : MOVIE_GENRES;
  const secondary = mediaType === 'tv' ? MOVIE_GENRES : TV_GENRES;
  if (primary[numeric]) return primary[numeric];
  if (secondary[numeric]) return secondary[numeric];
  for (const alias of MOVIE_TV_GENRE_ALIASES[numeric] || []) {
    if (primary[alias]) return primary[alias];
    if (secondary[alias]) return secondary[alias];
  }
  return '';
}

/** genreIds → 去重后的类型名数组 */
function genreNamesFromIds(ids, mediaType = 'movie') {
  const out = [];
  const seen = new Set();
  for (const numeric of toIdList(ids)) {
    const name = genreNameOf(numeric, mediaType);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

module.exports = {
  MOVIE_GENRES,
  TV_GENRES,
  MOVIE_TV_GENRE_ALIASES,
  genreNameOf,
  genreNamesFromIds
};
