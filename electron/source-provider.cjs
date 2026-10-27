'use strict';
/**
 * Source 统一抽象（新增文件，零触碰架构基建之五）。
 * 统一 { id, kind, capabilities, search, health } 契约，把「CMS JSON 源」与
 * 「豆瓣分类」两类已落地的数据面接入同一接口——为未来 spider/直播源铺路：
 * 新增数据面 = 注册一个适配器，而不是改任何链路。
 * cf:sources.list / cf:sources.search 提供自省与诊断检索。
 */

const telemetry = require('./telemetry.cjs');

const providers = new Map();   // id -> { id, kind, description, capabilities, search }

function registerProvider(provider) {
  if (!provider?.id || typeof provider.search !== 'function') return false;
  providers.set(String(provider.id), {
    id: String(provider.id),
    kind: String(provider.kind || 'vod'),
    description: String(provider.description || ''),
    capabilities: { search: true, ...provider.capabilities },
    search: provider.search,
    health: provider.health || (async () => ({ ok: true }))
  });
  return true;
}

function listProviders() {
  return [...providers.values()].map(({ id, kind, description, capabilities }) => ({ id, kind, description, capabilities }));
}

async function searchAll(payload, { limit = 3 } = {}) {
  const out = [];
  for (const provider of providers.values()) {
    if (out.length >= limit) break;
    try {
      const result = await provider.search(payload);
      if (result) out.push({ id: provider.id, kind: provider.kind, result });
    } catch (error) {
      out.push({ id: provider.id, kind: provider.kind, error: String(error?.message || error) });
    }
  }
  return out;
}

/** 适配器：CMS JSON 源（包装聚合引擎的单源搜索） */
function createCmsJsonSource({ id, name, searchSource }) {
  return {
    id,
    kind: 'vod',
    description: `CMS JSON 源 · ${name}`,
    capabilities: { search: true, detail: true },
    async search(payload) {
      const done = telemetry.timer('source.cms.search');
      try {
        const deadline = Date.now() + 5000;
        const resource = await searchSource(payload.source, payload, deadline);
        telemetry.count('source.cms.hit', resource ? 1 : 0);
        return { ok: true, resource };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      } finally {
        done({ id });
      }
    }
  };
}

/** 适配器：豆瓣分类（包装 rexxar recent_hot） */
function createDoubanCategorySource({ id, fetchDoubanRecentHot }) {
  return {
    id,
    kind: 'browse',
    description: '豆瓣原生分类（rexxar recent_hot）',
    capabilities: { search: true, categories: true },
    async search(payload) {
      const done = telemetry.timer('source.douban.search');
      try {
        const result = await fetchDoubanRecentHot({ kind: payload.kind, category: payload.category, type: payload.type, limit: payload.limit || 20 });
        telemetry.count('source.douban.items', result?.items?.length || 0);
        return result;
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      } finally {
        done({ id });
      }
    }
  };
}

function installSourceChannels(ipcMain) {
  try {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    if (!ipcMain._invokeHandlers.get('cf:sources.list')) {
      ipcMain.handle('cf:sources.list', () => ({ providers: listProviders() }));
    }
    if (!ipcMain._invokeHandlers.get('cf:sources.search')) {
      ipcMain.handle('cf:sources.search', (_event, payload = {}) => searchAll(payload, { limit: payload?.limit || 3 }));
    }
  } catch { /* 诊断通道注册失败不影响功能 */ }
}

module.exports = { registerProvider, listProviders, searchAll, createCmsJsonSource, createDoubanCategorySource, installSourceChannels };
