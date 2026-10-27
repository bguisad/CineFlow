'use strict';
/**
 * 代理分片磁盘 L2 缓存（新增文件，零触碰架构基建）。
 * 目标：拖回已看区间/回看/重开 = 毫秒级（不再重新向源站取片）。
 * 挂点：compat fetch 层（代理上游的清单/密钥/分片请求全部经过）——
 *   - 命中：直接磁盘回源（毫秒级，零网络）
 *   - 未命中：放行网络，可缓存的媒体分片响应写穿磁盘 LRU
 * 策略：仅缓存 GET 2xx 且 content-type 为视频分片/MP4 的响应；AES 加密分片按密文缓存
 * （同一 KEY 解密，无影响）；Range 以请求头并入缓存键；LRU 容量默认 512MB。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const telemetry = require('./telemetry.cjs');

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const CACHEABLE_CONTENT_RE = /video\/(?:mp2t|mp4|iso\.segment)|application\/octet-stream|video\/(?:x-)?mpegvideo/i;
const CACHEABLE_URL_RE = /\.(?:ts|m4s|mp4|seg)(?:$|[?#])/i;
const INDEX_FILE = 'index.json';

const state = {
  enabled: false,
  dir: '',
  maxBytes: DEFAULT_MAX_BYTES,
  index: new Map(),    // key -> { file, size, at }
  totalBytes: 0
};

function keyOf(url, requestHeaders) {
  const range = String(requestHeaders?.range || (requestHeaders instanceof Object ? requestHeaders.Range : '') || '');
  return crypto.createHash('sha1').update(`${url}|${range}`).digest('hex');
}

function init({ app, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  try {
    if (!app) return false;
    state.dir = path.join(app.getPath('userData'), 'cf9-seg-cache');
    state.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
    state.index.clear();
    state.totalBytes = 0;
    fs.mkdirSync(state.dir, { recursive: true });
    const indexFile = path.join(state.dir, INDEX_FILE);
    if (fs.existsSync(indexFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        for (const [key, meta] of Object.entries(parsed.entries || {})) {
          const file = path.join(state.dir, meta.file);
          if (fs.existsSync(file)) {
            state.index.set(key, { ...meta, at: Number(meta.at) || 0 });
            state.totalBytes += Number(meta.size) || 0;
          }
        }
      } catch { /* 索引损坏 → 重建 */ }
    }
    state.enabled = true;
    return true;
  } catch {
    return false;
  }
}

function persistIndex() {
  try {
    const entries = {};
    for (const [key, meta] of state.index) entries[key] = meta;
    fs.writeFileSync(path.join(state.dir, INDEX_FILE), JSON.stringify({ entries }, null, 0));
  } catch { /* ignore */ }
}

function evictToFit(incomingBytes = 0) {
  while (state.totalBytes + incomingBytes > state.maxBytes && state.index.size) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, meta] of state.index) {
      if (meta.at < oldestAt) { oldestAt = meta.at; oldestKey = key; }
    }
    if (!oldestKey) break;
    const meta = state.index.get(oldestKey);
    try { fs.unlinkSync(path.join(state.dir, meta.file)); } catch { /* ignore */ }
    state.index.delete(oldestKey);
    state.totalBytes -= Number(meta.size) || 0;
  }
}

/** 命中返回 { response }；未命中返回 null */
async function serve(url, requestHeaders) {
  if (!state.enabled) return null;
  const key = keyOf(url, requestHeaders);
  const meta = state.index.get(key);
  if (!meta) return null;
  try {
    const buffer = fs.readFileSync(path.join(state.dir, meta.file));
    meta.at = Date.now();
    telemetry.count('segcache.hit');
    const headers = new Headers({ 'content-type': meta.contentType || 'video/mp2t', 'x-cf9-cache': 'hit' });
    return { response: new Response(buffer, { status: 200, headers }), from: 'disk' };
  } catch {
    state.index.delete(key);
    return null;
  }
}

/** 可缓存响应写穿（调用方已确认 content-type 可缓存且 2xx；body 为完整 Buffer） */
function store(url, requestHeaders, contentType, buffer) {
  if (!state.enabled || !(buffer instanceof Buffer) || !buffer.length) return false;
  evictToFit(buffer.length);
  if (state.totalBytes + buffer.length > state.maxBytes) return false;
  const key = keyOf(url, requestHeaders);
  if (state.index.has(key)) return true;
  const file = `${key}.bin`;
  try {
    fs.writeFileSync(path.join(state.dir, file), buffer);
    state.index.set(key, { file, size: buffer.length, contentType: String(contentType || ''), at: Date.now() });
    state.totalBytes += buffer.length;
    telemetry.count('segcache.store');
    persistIndex();
    return true;
  } catch {
    state.index.delete(key);
    return false;
  }
}

function shouldCache(contentType, url) {
  const ct = String(contentType || '').toLowerCase();
  if (/json|html|xml|text\/plain|javascript/.test(ct)) return false;   // 明确文本型一律不缓存
  if (CACHEABLE_CONTENT_RE.test(ct)) return true;                      // 媒体 content-type 直接判可缓存
  if (!ct || ct === 'application/octet-stream') return CACHEABLE_URL_RE.test(String(url || '').split('?')[0]);
  return false;                                                        // 其余未知类型不猜
}

function stats() {
  return {
    enabled: state.enabled,
    dir: state.dir,
    entries: state.index.size,
    bytes: state.totalBytes,
    maxBytes: state.maxBytes
  };
}

module.exports = { init, serve, store, shouldCache, keyOf, stats, _state: state };
