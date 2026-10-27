'use strict';
/**
 * 统一缓存层（新增文件，零触碰架构基建之一）。
 * 把散落各处的 ad-hoc Map 缓存收敛为语义一致的缓存工厂：
 *   TTL 过期 / LRU 容量淘汰 / stale-while-revalidate / 命中率统计 / 过期清扫 / dump 视图。
 * 基线 main.cjs 内的私有缓存不可迁移（零触碰）；本层先承载自有外挂模块
 * （source-engine / source-compat）的全部缓存，并通过 cf:cache.* 通道暴露全局视图。
 */

const registry = new Map();   // namespace -> Cache 实例（全局视图）

class Cache {
  constructor({ namespace, ttlMs = 0, max = 0, stale = false } = {}) {
    this.namespace = String(namespace || 'cache');
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);   // 默认 TTL（0 = 不过期）
    this.max = Math.max(0, Number(max) || 0);
    this.stale = Boolean(stale);
    this.store = new Map();                   // key -> { value, expiresAt }
    this.stats = { hits: 0, misses: 0, evictions: 0, writes: 0 };
    registry.set(this.namespace, this);
  }

  /** 命中返回 { value, stale }，未命中返回 undefined */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      if (this.stale) {
        this.stats.hits += 1;
        return { value: entry.value, stale: true };
      }
      this.store.delete(key);
      this.stats.misses += 1;
      return undefined;
    }
    this.store.delete(key);                    // LRU 触碰：移到 Map 尾部
    this.store.set(key, entry);
    this.stats.hits += 1;
    return { value: entry.value, stale: false };
  }

  peek(key) {
    const entry = this.store.get(key);
    return entry ? { value: entry.value, expired: entry.expiresAt <= Date.now() } : undefined;
  }

  /** ttlMs 可按条目覆盖（未传时用缓存默认 TTL；0/undefined + 默认 0 = 永不过期） */
  set(key, value, ttlMs) {
    if (this.max && !this.store.has(key)) {
      while (this.store.size >= this.max) {
        this.store.delete(this.store.keys().next().value);
        this.stats.evictions += 1;
      }
    }
    const ttl = ttlMs === undefined ? this.ttlMs : Math.max(0, Number(ttlMs) || 0);
    this.store.set(key, { value, expiresAt: ttl ? Date.now() + ttl : Infinity });
    this.stats.writes += 1;
  }

  delete(key) {
    return this.store.delete(key);
  }

  has(key) {
    const entry = this.store.get(key);
    return Boolean(entry) && entry.expiresAt > Date.now();
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }

  sweep(now = Date.now()) {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== Infinity && entry.expiresAt <= now) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  dump(limit = 20) {
    const now = Date.now();
    const rows = [];
    for (const [key, entry] of this.store) {
      rows.push({ key: String(key).slice(0, 120), expiresInMs: entry.expiresAt === Infinity ? null : entry.expiresAt - now });
      if (rows.length >= limit) break;
    }
    return {
      namespace: this.namespace,
      size: this.store.size,
      ttlMs: this.ttlMs,
      max: this.max,
      stale: this.stale,
      stats: { ...this.stats },
      rows
    };
  }
}

function createCache(options = {}) {
  return new Cache(options);
}

function getCache(namespace) {
  return registry.get(namespace) || null;
}

function listCaches() {
  return [...registry.values()].map((cache) => cache.dump(0));
}

function sweepAll() {
  let removed = 0;
  for (const cache of registry.values()) removed += cache.sweep();
  return removed;
}

function installCacheChannels(ipcMain) {
  try {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    if (!ipcMain._invokeHandlers.get('cf:cache.stats')) {
      ipcMain.handle('cf:cache.stats', () => ({ caches: listCaches() }));
    }
    if (!ipcMain._invokeHandlers.get('cf:cache.sweep')) {
      ipcMain.handle('cf:cache.sweep', () => ({ removed: sweepAll() }));
    }
  } catch { /* 诊断通道注册失败不影响功能 */ }
}

module.exports = {
  createCache,
  getCache,
  listCaches,
  sweepAll,
  installCacheChannels,
  Cache,
  _registry: registry
};
