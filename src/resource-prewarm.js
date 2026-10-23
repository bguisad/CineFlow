/**
 * v3.4.2 纯增量：介绍页播放源的首帧预热（渲染端触发器）。
 *
 * #resourceResults 是详情内容被渲染时才出现的节点，所以这里不能只在启动时找一次
 * （第十七轮探针实测：那样整条预热链路会静默不装）。改成盯着 #detailContent，
 * 容器一出现就绑定；换一部影片（节点被重建）就重新绑定。
 *
 * 绑定后只做两件事：
 *   ① 卡片一渲染出来，就把 firstUrl 交给主进程 —— 队首那条做"深度预热"
 *      （resolve → 清单 → 密钥 → 首分片，全部走会话默认 HTTP 缓存），其余只热连接；
 *   ② 悬停到哪条，就把哪条升级成深度预热。
 * 全程 best-effort：桥不存在、面板没开、URL 重复，都直接静默返回，绝不影响基线任何链路。
 * 摘掉本文件 + incremental-pages.js 里那 2 行挂钩 + preload 末尾的 cineflowFast，即完全回退。
 */

const MAX_WATCH = 6;
// 深度预热（清单+密钥+首分片）很贵，一部影片只给一次；悬停时把悬停那条提到队首。
const DEEP_BATCH = 1;

const asked = new Map(); // url -> 已热深度：0 只热了连接，1 已深度热

function requestPrewarm(urls, deepBudget) {
  const bridge = window.cineflowFast;
  if (!bridge?.prewarmMedia) return false;
  const fresh = [];
  let deep = 0;
  for (const url of urls) {
    if (!url) continue;
    const prev = asked.get(url);
    if (prev === undefined) {
      const willDeep = deepBudget > 0;
      asked.set(url, willDeep ? 1 : 0);
      if (willDeep) { deepBudget -= 1; deep += 1; }
      fresh.push(url);
    } else if (prev === 0 && deepBudget > 0) {
      // 之前只热了连接，现在用户悬停到这条了 → 重新排队升级成深度热
      asked.set(url, 1);
      deepBudget -= 1;
      deep += 1;
      fresh.push(url);
    }
    if (fresh.length >= MAX_WATCH) break;
  }
  if (!fresh.length) return false;
  if (asked.size > 400) asked.clear();
  Promise.resolve(bridge.prewarmMedia(fresh, deep)).catch(() => {});
  return deep > 0;
}

function mountResourcePrewarm() {
  if (!window.cineflowFast?.prewarmMedia) return false;
  const host = document.querySelector('#detailContent') || document.querySelector('#app');
  if (!host) return false;

  const detailOpen = () => document.querySelector('#detailPanel')?.classList.contains('is-open');
  const islandMode = () => ['island-mode', 'island-expanded-mode', 'island-docked-mode']
    .some((name) => document.body.classList.contains(name));

  function urlOf(card) {
    const button = card.querySelector('.resource-open[data-play-url]');
    return button ? String(button.getAttribute('data-play-url') || '').trim() : '';
  }

  let bound = null;

  function bind() {
    const list = document.querySelector('#resourceResults');
    if (!list) return false;
    if (list === bound) return true;
    bound = list;
    let deepSpent = false;

    // 新卡片一进来就预热：队首那条深度热，其余只热连接；悬停哪条就把哪条升级成深度热
    new MutationObserver((records) => {
      if (!detailOpen() || islandMode()) return;
      const added = [];
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('.resource-card')) added.push(node);
          added.push(...Array.from(node.querySelectorAll?.('.resource-card') || []));
        }
      }
      if (!added.length) return;
      const total = list.querySelectorAll('.resource-card').length;
      if (total === added.length) deepSpent = false; // 列表里只有这一批 → 是这部影片的首批
      if (requestPrewarm(added.map(urlOf), deepSpent ? 0 : DEEP_BATCH)) deepSpent = true;
    }).observe(list, { childList: true, subtree: true });

    list.addEventListener('pointerover', (event) => {
      if (!detailOpen() || islandMode()) return;
      const card = event.target instanceof Element ? event.target.closest('.resource-card') : null;
      if (card) requestPrewarm([urlOf(card)], DEEP_BATCH);
    }, { passive: true });

    // 打开介绍页时列表可能已经有卡片（缓存命中的二次进入），补一次
    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.movie-card, #dailyDetailBtn')) return;
      deepSpent = false;
      window.setTimeout(() => {
        if (!detailOpen() || islandMode() || deepSpent) return;
        deepSpent = requestPrewarm(Array.from(list.querySelectorAll('.resource-card')).map(urlOf), DEEP_BATCH);
      }, 1200);
    }, { passive: true });

    return true;
  }

  // 容器每次渲染详情都会被重建，所以这个盯宿主的观察器不解除：bind() 内部对同一个节点直接短路
  const watcher = new MutationObserver(() => { bind(); });
  watcher.observe(host, { childList: true, subtree: true });
  bind();
  return true;
}

export function initResourcePrewarm(deps = {}) {
  void deps;
  try {
    return mountResourcePrewarm();
  } catch (error) {
    console.warn('[CineFlow] 播放源首帧预热装配失败，已跳过', error);
    return false;
  }
}
