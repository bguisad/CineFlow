'use strict';
/**
 * CineFlow 推荐引擎额外 preload（新增文件，经 session.setPreload 注入，原 preload.cjs 未改动）。
 * 与主 preload 一样运行在隔离世界，用 contextBridge 暴露 cineflowRec 命名空间。
 * 所有 rec:* handler 在主进程 recommender.cjs 注册；引擎停用时返回 null，渲染层走原生回退。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cineflowRec', {
  /** 首页推荐: home({ size, page }) → { cards, total, coldTier, events } | null */
  home: (opts) => ipcRenderer.invoke('rec:getHome', opts),
  /** 详情相似: similar(contentKey, { size }) → { cards } | null */
  similar: (itemId, opts) => ipcRenderer.invoke('rec:getSimilar', { itemId, ...(opts || {}) }),
  /** 行为埋点: track({ events: [{ key, type, value?, ts?, card? }] })，type: click/play/finish/like */
  track: (events) => ipcRenderer.invoke('rec:track', { events }),
  /** 仅补充物料元数据（不产生行为）: upsert({ cards: [...] }) */
  upsert: (cards) => ipcRenderer.invoke('rec:upsert', { cards }),
  /** 首次迁移: seed({ prefs, history, genreNames }) */
  seed: (payload) => ipcRenderer.invoke('rec:seed', payload),
  status: () => ipcRenderer.invoke('rec:status'),
  rebuild: () => ipcRenderer.invoke('rec:rebuild'),
  // v3.4.6 片库豆瓣路径换血：筛选 hint（注入层捕获阶段先于基线请求写入）+ rexxar 年份元数据
  setBrowseHint: (payload) => ipcRenderer.invoke('rec:browseHint', payload),
  doubanMeta: (payload) => ipcRenderer.invoke('rec:doubanMeta', payload),
  // v3.4.6 豆瓣原生分类（rexxar recent_hot）：{ kind, category, type, start, limit }
  doubanRecentHot: (payload) => ipcRenderer.invoke('rec:doubanRecentHot', payload),
});
