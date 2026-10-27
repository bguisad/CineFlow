import { EXTRA_PROMPT_INTENTS } from './intent-extras.js';

const BASE_PATTERNS = [
  '放松', '轻松', '解压', '开心', '治愈', '暖心', '舒服', '周末', '窝在家', '下饭', '吃饭', '快乐', '无脑', '舒服点', '喜剧', '搞笑', '幽默',
  '一个人', '独处', '孤独', '安静', '自我', '内心', '人生', 'emo', '低落', '失落', '发呆', '文艺', '剧情',
  '晚上', '夜晚', '深夜', '下雨', '雨天', '阴天', '失眠', '雨夜', '睡前', '夜里', '氛围',
  '刺激', '高能', '燃', '爽', '紧张', '动作', '冒险', '打斗', '速度', '爆米花', '热血',
  '烧脑', '悬疑', '推理', '反转', '犯罪', '谜团', '破案', '侦探', '谜案', '真相',
  '科幻', '未来', '赛博', '太空', '机器人', '末日', '外星', '宇宙', 'AI', '人工智能',
  '恐怖', '惊悚', '吓人', '鬼', '怪物', '灵异', '胆小勿入',
  '恋爱', '爱情', '浪漫', '约会', '暧昧', '心动', '情侣', '甜', '告白',
  '家庭', '亲子', '孩子', '小朋友', '全家', '温馨', '陪伴', '父母',
  '催泪', '感动', '哭', '想哭', '泪点', '悲伤', '遗憾', '温柔',
  '高分', '经典', '口碑', '神作', '必看', '影史', '豆瓣'
];

const INTENT_WORDS = [...new Set([
  ...BASE_PATTERNS,
  ...EXTRA_PROMPT_INTENTS.flatMap((intent) => intent.patterns || [])
])].filter(Boolean).sort((a, b) => b.length - a.length);

const LEAD_FILLERS = [
  '帮忙推荐一部', '帮我推荐一部', '给我推荐一部', '有没有什么', '有没有', '有木有', '帮我推荐', '给我推荐',
  '我想看一部', '我要看一部', '想找一部', '想看一部', '推荐一部', '求推荐一部', '安利一部', '找一部', '来一部', '求一部', '看一部',
  '我想看', '我要看', '我想找', '我要找', '我想', '我要', '想找', '想看', '要看到', '要看', '打算看', '准备看', '求推荐', '求安利',
  '推荐', '安利', '求', '帮我找', '帮我', '给我', '大家', '麻烦', '请问', '咱想', '俺想', '看下', '看看', '一部', '一个',
  '一个人', '那部', '这部', '名叫', '叫做', '叫', '今天', '今晚', '昨天晚上', '昨天', '周末', '最近', '现在', '我', '想', '要'
].sort((a, b) => b.length - a.length);

const TAIL_FILLERS = [
  '的电影吗', '的电影', '的片子', '的作品', '类似的', '之类', '这类', '好看的', '好看', '电视剧', '连续剧',
  '纪录片', '综艺节目', '综艺', '动漫', '动画', '剧集', '片子', '作品', '电影', '有没有', '有吗', '可以吗',
  '合适吗', '吗', '呢', '吧', '呀', '啊', '嘛', '哦', '噢', '的', '了'
].sort((a, b) => b.length - a.length);

const FILLER_CHARS = /[我想我要来去给找看部个只些的了吗呢吧呀啊嘛哦噢太挺很超非常一点天日雨雪风雾晴夜晚晨昏时候推荐适合有无什么啥好剧类]/g;
const DICT_TTL_MS = 5000;
const DICT_LIMIT = 900;
const ZWSP = '\u200b';
const SETTLE_QUIET_MS = 360;
const SETTLE_FLOOR_MS = 1200;
const SETTLE_MAX_MS = 6000;
const ENTER_GUARD_MS = 6000;

let bypass = false;
let lastEnterAt = 0;
let lastInputAt = 0;
let pending = false;
let dictAt = 0;
const dict = new Map();

function stripInvisible(value) {
  return String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '');
}

function clean(value) {
  return stripInvisible(value).replace(/\s+/g, ' ').trim();
}

function unquote(value) {
  return clean(value)
    .replace(/^[《「【"“‘']+/, '')
    .replace(/[》」】"”’']+$/, '')
    .trim();
}

function normalizeTitle(value) {
  return unquote(value)
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/g, '')
    .replace(/[\s·:：\-—_,，.。/\\()（）\[\]【】]/g, '')
    .toLowerCase();
}

function hasBookQuote(value) {
  return /[《「【]/.test(String(value || ''));
}

function matchedIntentWords(value) {
  const text = String(value || '').toLowerCase();
  return INTENT_WORDS.filter((word) => word && text.includes(word.toLowerCase()));
}

function titleScore(candidate, query) {
  const left = normalizeTitle(candidate);
  const right = normalizeTitle(query);
  if (!left || !right) return 0;
  if (left === right) return 3;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 2 && longer.startsWith(shorter) && shorter.length / longer.length >= 0.7) return 2;
  if (shorter.length >= 3 && longer.includes(shorter) && shorter.length / longer.length >= 0.7) return 1;
  return 0;
}

function strongTitleHit(results, query) {
  for (const item of results || []) {
    if (titleScore(item.title, query) >= 2) return item;
    if (titleScore(item.originalTitle, query) >= 2) return item;
  }
  return null;
}

function sanitizeForIntent(text, words) {
  let output = String(text || '');
  for (const word of words) {
    if (!word) continue;
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(safe, 'gi'), (hit) => hit.split('').join(ZWSP));
  }
  return output;
}

function meaningfulRemainder(query, words) {
  let text = clean(query);
  for (const word of words) {
    if (!word) continue;
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(safe, 'gi'), '');
  }
  return text.replace(/[天空日雨雪风夜晚早晨午间时候点些部个的了想找看要推荐适合吗呢吧呀啊我你他她它们来去]/g, '').trim();
}

function isPureIntent(query) {
  const text = normalizeTitle(query);
  if (!text) return true;
  let rest = text;
  for (const word of INTENT_WORDS) {
    const key = word.toLowerCase();
    while (rest.includes(key)) rest = rest.replace(key, '');
  }
  return rest.replace(FILLER_CHARS, '').length === 0;
}

function extractCandidate(value) {
  let text = clean(value);
  if (!text) return '';
  let changed = true;
  while (changed && text.length > 2) {
    changed = false;
    const lower = text.toLowerCase();
    for (const filler of LEAD_FILLERS) {
      if (!lower.startsWith(filler.toLowerCase()) || text.length <= filler.length + 1) continue;
      text = text.slice(filler.length).trim();
      changed = true;
      break;
    }
    if (text.length <= 2) continue;
    for (const filler of TAIL_FILLERS) {
      if (!lower.endsWith(filler.toLowerCase()) || text.length <= filler.length + 1) continue;
      text = text.slice(0, text.length - filler.length).trim();
      changed = true;
      break;
    }
  }
  return text;
}

function addTitle(raw) {
  const title = clean(raw);
  if (title.length < 2 || title.length > 40) return;
  const key = normalizeTitle(title);
  if (!key || key.length < 2) return;
  if (!dict.has(key)) {
    if (dict.size >= DICT_LIMIT) return;
    dict.set(key, title);
  }
}

function readStoredTitles() {
  try {
    const prefs = JSON.parse(window.localStorage.getItem('cineflow:prefs') || '{}');
    for (const item of prefs.favorites || []) addTitle(item?.title || item?.name);
    for (const term of prefs.recentSearches || []) void term;
  } catch {   }
  try {
    const history = JSON.parse(window.localStorage.getItem('cineflow:history:v3') || '[]');
    for (const item of Array.isArray(history) ? history : []) addTitle(item?.title || item?.name);
  } catch {   }
}

function refreshDict(force) {
  if (!force && Date.now() - dictAt < DICT_TTL_MS) return;
  dictAt = Date.now();
  document.querySelectorAll('.movie-card:not(.skeleton) h3').forEach((el) => addTitle(el.textContent));
  document.querySelectorAll('#detailTitle, #playerTitle, .history-item-title').forEach((el) => addTitle(el.textContent));
  readStoredTitles();
}

function findLocal(query) {
  const key = normalizeTitle(query);
  if (!key || key.length < 2 || isPureIntent(query)) return null;
  refreshDict(false);
  let best = null;
  let bestScore = 0;
  for (const [norm, display] of dict) {
    if (norm === key) return display;
    const shorter = norm.length <= key.length ? norm : key;
    const longer = norm.length <= key.length ? key : norm;
    if (shorter.length < 2 || !longer.startsWith(shorter)) continue;
    const ratio = shorter.length / longer.length;
    if (ratio >= 0.7 && ratio > bestScore) { bestScore = ratio; best = display; }
  }
  return best;
}

function railCards() {
  return Array.from(document.querySelectorAll('#searchRail .movie-card'));
}

function promote(query) {
  const rail = document.querySelector('#searchRail');
  if (!rail) return 0;
  const cards = Array.from(rail.querySelectorAll('.movie-card'));
  if (cards.length < 2) return 0;
  const scored = cards.map((card, index) => ({
    card,
    index,
    score: Math.max(titleScore(card.querySelector('h3')?.textContent || '', query), 0)
  }));
  const hits = scored.filter((item) => item.score >= 2);
  if (!hits.length) return 0;
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  const rest = scored.filter((item) => item.score < 2);
  for (const item of [...hits, ...rest]) rail.appendChild(item.card);
  return hits.length;
}

function relabel(query, hits) {
  const title = document.querySelector('#searchTitle');
  const hint = document.querySelector('#searchHint');
  if (title) title.textContent = `“${query}” 的相关推荐`;
  if (hint && hits) hint.textContent = `${hits} 个片名匹配优先`;
}

function replay(value) {
  const input = document.querySelector('#globalSearch');
  if (!input) return;
  const restore = input.value;
  bypass = true;
  try {
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  } finally {
    bypass = false;
    input.value = restore;
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function railPending() {
  const rail = document.querySelector('#searchRail');
  if (!rail) return false;
  return Boolean(rail.querySelector('.movie-card.skeleton'));
}

function railSettled() {
  const rail = document.querySelector('#searchRail');
  if (!rail) return true;
  if (rail.querySelector('.movie-card:not(.skeleton)')) return true;
  return Boolean(rail.querySelector('.empty-state'));
}

function waitRailSettled() {
  return new Promise((resolve) => {
    const rail = document.querySelector('#searchRail');
    if (!rail) { resolve(); return; }
    const started = Date.now();
    let quiet = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(quiet);
      quiet = window.setTimeout(tryDone, SETTLE_QUIET_MS);
    });
    observer.observe(rail, { childList: true, subtree: true });
    const finish = () => {
      observer.disconnect();
      window.clearTimeout(quiet);
      window.clearInterval(guard);
      resolve();
    };
    function tryDone() {
      const elapsed = Date.now() - started;
      if (elapsed > SETTLE_MAX_MS) { finish(); return; }
      if (!railPending() && (railSettled() || elapsed >= SETTLE_FLOOR_MS)) { finish(); return; }
      window.clearTimeout(quiet);
      quiet = window.setTimeout(tryDone, 240);
    }
    quiet = window.setTimeout(tryDone, SETTLE_QUIET_MS);
    const guard = window.setInterval(tryDone, 500);
    window.setTimeout(() => window.clearInterval(guard), SETTLE_MAX_MS + 600);
  });
}

function looksLikeSentence(value) {
  const text = clean(value);
  if (text.length < 8) return false;
  return /[想找看推荐适合的了吗呢吧呀嘛]|[\s，,。！!?？]/.test(text);
}

function titleCheck(text, words, quoted) {
  if (!text || text.length < 2) return Promise.resolve(null);
  if (!quoted && isPureIntent(text)) return Promise.resolve(null);
  if (!quoted && meaningfulRemainder(text, words).length < 2) return Promise.resolve(null);
  return window.cineflow.searchMovies(text, { enrich: false })
    .then((results) => strongTitleHit(results || [], text))
    .catch(() => null);
}

async function titlePath(text, words) {
  const watched = clean(document.querySelector('#globalSearch')?.value);
  if (Date.now() - lastInputAt < 500) await sleep(420);
  await waitRailSettled();
  if (!stillCurrent(watched)) return;
  const section = document.querySelector('#searchSection');
  const hint = document.querySelector('#searchHint');
  section?.classList.remove('is-hidden');
  if (hint) hint.textContent = '核对片名…';
  replay(words.length ? sanitizeForIntent(text, words) : text);
  await waitRailSettled();
  if (!stillCurrent(watched)) return;
  refreshDict(true);
  const hits = promote(text);
  relabel(text, hits);
  reapplyPromotion(text, watched, Date.now() + 3600);
}

function stillCurrent(watched) {
  return clean(document.querySelector('#globalSearch')?.value) === watched;
}

function decide(raw) {
  const stripped = unquote(raw);
  if (!stripped) return null;
  const quoted = hasBookQuote(raw);
  const candidate = quoted ? stripped : extractCandidate(stripped) || stripped;
  const words = matchedIntentWords(candidate);
  if (quoted) return { text: candidate, words, titleMode: true };
  if (findLocal(candidate)) return { text: candidate, words, titleMode: true };

  if (candidate && candidate !== stripped && !words.length && !isPureIntent(candidate)) {
    return { text: candidate, words: [], titleMode: true };
  }
  if (looksLikeSentence(stripped)) {
    return titleCheck(candidate, words, false).then((hit) => ({ text: candidate, words, titleMode: Boolean(hit), moodFirst: true }));
  }
  return titleCheck(candidate, words, false).then((hit) => ({ text: candidate, words, titleMode: Boolean(hit) }));
}

async function handleEnter(input) {
  const raw = clean(input.value);
  if (!raw) return;
  let plan = null;
  try {
    plan = await decide(raw);
  } catch {
    plan = null;
  }
  if (!plan) { replay(raw); return; }

  if (plan.moodFirst) {
    replay(raw);
    if (plan.titleMode) await titlePath(plan.text, plan.words);
    return;
  }
  if (plan.titleMode) { await titlePath(plan.text, plan.words); return; }
  replay(raw);
}

function reapplyPromotion(query, watched, until) {
  const apply = () => {
    if (Date.now() > until) return;
    const input = document.querySelector('#globalSearch');
    if (clean(input?.value) !== watched) return;
    const title = document.querySelector('#searchTitle')?.textContent || '';

    if (!title.includes('氛围推荐') && !title.includes('相关推荐')) return;
    const hits = promote(query);
    if (hits) relabel(query, hits);
  };
  window.setTimeout(apply, 700);
  window.setTimeout(apply, 1600);
  window.setTimeout(apply, 2800);
}

function mountDualSearch() {
  const input = document.querySelector('#globalSearch');
  if (!input || !window.cineflow?.searchMovies) return false;
  if (document.documentElement.dataset.cf8DualSearch === '1') return true;
  document.documentElement.dataset.cf8DualSearch = '1';
  refreshDict(true);

  document.addEventListener('input', (event) => {
    if (event.target === input) lastInputAt = Date.now();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target !== input) return;
    if (bypass || pending) return;
    const raw = clean(input.value);
    if (!raw) return;
    const stripped = unquote(raw);
    const candidate = extractCandidate(stripped);

    const worthIntercept = matchedIntentWords(raw).length > 0 || hasBookQuote(raw) || (candidate && candidate !== stripped);
    if (!worthIntercept) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pending = true;
    lastEnterAt = Date.now();
    handleEnter(input).catch(() => {}).finally(() => { pending = false; });
  }, true);

  let lastRailSignature = '';
  let lastEmptyReplay = '';
  const observer = new MutationObserver(() => {
    window.clearTimeout(observer.timer);
    observer.timer = window.setTimeout(() => {
      if (pending || Date.now() - lastEnterAt < ENTER_GUARD_MS) return;
      const title = document.querySelector('#searchTitle')?.textContent || '';
      const query = clean(input.value);
      if (!query) return;
      const stripped = unquote(query);
      const candidate = extractCandidate(stripped);
      const wrapped = candidate && candidate !== stripped;
      if (title.includes('氛围推荐')) {
        if (!matchedIntentWords(query).length) return;
        const signature = `${query}|${railCards().length}|${title}`;
        if (signature === lastRailSignature) return;
        lastRailSignature = signature;
        refreshDict(false);
        const hits = promote(isPureIntent(candidate) ? query : candidate);
        if (hits) relabel(candidate, hits);
        return;
      }

      if (!wrapped || isPureIntent(candidate) || railCards().length) return;
      if (lastEmptyReplay === candidate) return;
      lastEmptyReplay = candidate;
      replay(candidate);
      window.setTimeout(() => {
        if (!stillCurrent(query)) return;
        const hits = promote(candidate);
        if (hits) relabel(candidate, hits);
      }, 900);
    }, SETTLE_QUIET_MS);
  });
  observer.observe(document.querySelector('#searchRail') || input, { childList: true, subtree: true });

  return true;
}

export function initDualSearch(deps = {}) {
  void deps;
  try {
    return mountDualSearch();
  } catch (error) {
    console.warn('[CineFlow] 双路搜索装配失败，已跳过', error);
    return false;
  }
}
