'use strict';

/**
 * v3.4.4 纯增量：GitHub Release 检查 + 直连下载 + 一键覆盖安装。
 *
 * 只做三件事，全部只读/显式触发：
 *   1. check()    查 https://api.github.com/repos/incldue/CineFlow/releases/latest，
 *                 返回"有没有比当前版本新的正式版 + 本机该下哪个包"。
 *   2. download() 把选中的安装包流式下到 userData/updates/，边下边发进度。
 *   3. install()  Windows 上静默运行安装包（/S，per-user 安装，不弹 UAC），随后由调用方退出应用。
 *
 * 两个实测出来的网络事实（决定实现方式）：
 *   - api.github.com **直连 200**；走本机 Clash（127.0.0.1:7897）会因共用出口 IP 被判
 *     "API rate limit exceeded"（403）。所以这里用 node:https 直连，只在网络层失败时才
 *     退到 session.fetch（继承应用代理）。
 *   - 下载资源会 302 到 objects.githubusercontent.com，必须手动跟随（≤4 跳）。
 *
 * 边界：只从 github.com / api.github.com / objects.githubusercontent.com 下载 https 资源；
 * 只接受 .exe / .dmg / .zip / .AppImage；绝不执行下载下来的脚本，只把安装包交给系统安装器。
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'incldue/CineFlow';
// 仅用于本机诊断：CINEFLOW_UPDATE_FEED_URL 指向本地假 feed 时只影响"查询"这一步，
// 下载仍强制只认 github.com / objects.githubusercontent.com，避免把下载通道变成任意 URL 拉取。
const FEED_URL = String(process.env.CINEFLOW_UPDATE_FEED_URL || '').trim();
const API_LATEST = FEED_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const UA = 'CineFlow/3.4.4 (personal desktop app; update check)';
const REQUEST_TIMEOUT_MS = 9000;
const CHECK_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 2 * 60 * 1000;
const MAX_REDIRECTS = 4;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['github.com', 'api.github.com', 'objects.githubusercontent.com']);
const ALLOWED_EXT = /\.(exe|dmg|zip|appimage)$/i;

function cleanVersion(value) {
  const hit = /(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''));
  return hit ? `${hit[1]}.${hit[2]}.${hit[3]}` : '';
}

function compareVersions(a, b) {
  const pa = cleanVersion(a).split('.').map(Number);
  const pb = cleanVersion(b).split('.').map(Number);
  if (!pa.length || !pb.length) return 0;
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function hostAllowed(urlStr, { allowAnyHost = false } = {}) {
  try {
    const u = new URL(urlStr);
    if (allowAnyHost) return u.protocol === 'https:' || u.protocol === 'http:';
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function requestOnce(urlStr, { headers = {}, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_JSON_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlStr);
    const request = https.request(
      {
        method: 'GET',
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        servername: target.hostname,
        headers: { 'user-agent': UA, accept: 'application/vnd.github+json', ...headers },
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve({ redirect: new URL(response.headers.location, urlStr).toString(), status });
          return;
        }
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy(new Error('响应过大'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', reject);
      }
    );
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.end();
  });
}

async function requestFollow(urlStr, options = {}) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!hostAllowed(current, { allowAnyHost: Boolean(options.allowAnyHost) })) throw new Error('不允许的下载地址');
    const result = await requestOnce(current, options);
    if (!result.redirect) return { ...result, finalUrl: current };
    current = result.redirect;
  }
  throw new Error('重定向过多');
}

// ---- 资源挑选：按平台/架构选"最适合这台机器"的那一个 ----
function pickAsset(assets = [], { platform = process.platform, arch = process.arch } = {}) {
  const list = assets
    .filter((asset) => asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string')
    .filter((asset) => ALLOWED_EXT.test(asset.name) && hostAllowed(asset.browser_download_url));
  if (!list.length) return null;
  const by = (re) => list.find((asset) => re.test(asset.name));
  let asset = null;
  let label = '';
  if (platform === 'win32') {
    // 一键覆盖安装要的就是 NSIS 安装包；架构无关（x64 包在 arm64 Windows 上也能装）
    asset = by(/-Setup\.exe$/i) || by(/\.exe$/i);
    label = 'Windows 安装包';
  } else if (platform === 'darwin') {
    const wanted = arch === 'arm64' ? /-arm64\.(dmg|zip)$/i : /-(x64|x86_64)\.(dmg|zip)$/i;
    asset = by(wanted) || by(/arm64\.dmg$/i) || by(/\.dmg$/i) || by(/\.zip$/i);
    label = arch === 'arm64' ? 'macOS (Apple Silicon)' : 'macOS (Intel)';
  } else {
    asset = by(/\.AppImage$/i) || by(/\.zip$/i);
    label = 'Linux';
  }
  if (!asset) return null;
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: Number(asset.size) || 0,
    label,
    digest: String(asset.digest || ''),
  };
}

// 真流式下载：边收边写盘 + 每 ~150ms 报一次进度（100MB 的安装包不能整块读进内存）
function streamToFile(urlStr, filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const attempt = (current, hops) => {
      if (!hostAllowed(current)) return reject(new Error('不允许的下载地址'));
      let target;
      try {
        target = new URL(current);
      } catch {
        return reject(new Error('下载地址不合法'));
      }
      const request = https.request(
        {
          method: 'GET',
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          servername: target.hostname,
          headers: { 'user-agent': UA, accept: '*/*' },
        },
        (response) => {
          const status = response.statusCode || 0;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            if (hops >= MAX_REDIRECTS) return reject(new Error('重定向过多'));
            return attempt(new URL(response.headers.location, current).toString(), hops + 1);
          }
          if (status !== 200) {
            response.resume();
            return reject(new Error(`下载失败 HTTP ${status}`));
          }
          const total = Number(response.headers['content-length']) || 0;
          const out = fs.createWriteStream(filePath);
          let received = 0;
          let lastAt = 0;
          response.on('data', (chunk) => {
            received += chunk.length;
            const now = Date.now();
            if (now - lastAt >= 150) {
              lastAt = now;
              onProgress({ phase: 'downloading', received, total, percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0 });
            }
          });
          response.on('error', reject);
          out.on('error', reject);
          out.on('finish', () => {
            onProgress({ phase: 'downloading', received, total: total || received, percent: 100 });
            resolve({ bytes: received, total: total || received });
          });
          response.pipe(out);
        }
      );
      request.on('error', reject);
      request.setTimeout(30000, () => request.destroy(new Error('下载超时')));
      request.end();
    };
    attempt(urlStr, 0);
  });
}

function createUpdater({ app, session, cacheDir } = {}) {
  const state = { cache: null, at: 0, etag: '', failAt: 0, failError: '' };
  const dir = cacheDir || (app ? path.join(app.getPath('userData'), 'updates') : '');
  let activeDownload = null;

  function shape(release, { platform, arch } = {}) {
    const current = cleanVersion(app?.getVersion?.() || '0.0.0');
    const latest = cleanVersion(release?.tag_name || release?.name || '');
    const asset = pickAsset(release?.assets || [], { platform, arch });
    return {
      ok: true,
      current,
      latest,
      hasUpdate: Boolean(latest) && compareVersions(latest, current) > 0,
      name: String(release?.name || release?.tag_name || ''),
      notes: String(release?.body || '').slice(0, 1200),
      publishedAt: String(release?.published_at || ''),
      htmlUrl: String(release?.html_url || ''),
      asset,
    };
  }

  async function fetchLatestJson() {
    const headers = state.etag ? { 'if-none-match': state.etag } : {};
    try {
      const result = await requestFollow(API_LATEST, { headers, allowAnyHost: Boolean(FEED_URL) });
      if (result.status === 304) return { notModified: true };
      if (result.status === 403 || result.status === 429) {
        const text = result.body.toString('utf8');
        return { error: /rate limit/i.test(text) ? 'GitHub 接口限流，稍后再试' : `GitHub 返回 ${result.status}` };
      }
      if (result.status !== 200) return { error: `GitHub 返回 ${result.status}` };
      const parsed = JSON.parse(result.body.toString('utf8'));
      state.etag = String(result.headers.etag || '');
      return { release: parsed };
    } catch (error) {
      // 直连失败（断网/DNS）时才退到 session.fetch（继承应用代理）
      if (!session?.defaultSession?.fetch) return { error: String(error?.message || error) };
      try {
        const response = await session.defaultSession.fetch(API_LATEST, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': UA },
          cache: 'no-store',
        });
        if (!response.ok) return { error: `GitHub 返回 ${response.status}` };
        const text = await response.text();
        state.etag = String(response.headers.get('etag') || '');
        return { release: JSON.parse(text) };
      } catch (fallbackError) {
        return { error: String(fallbackError?.message || fallbackError) };
      }
    }
  }

  async function check({ force = false, platform, arch } = {}) {
    const now = Date.now();
    if (!force && state.cache && now - state.at < CHECK_TTL_MS) {
      return { ...shape(state.cache, { platform, arch }), cached: true };
    }
    if (!force && state.failAt && now - state.failAt < FAIL_TTL_MS) {
      return { ok: false, error: state.failError, current: cleanVersion(app?.getVersion?.() || '') };
    }
    const result = await fetchLatestJson();
    if (result.notModified && state.cache) {
      state.at = now;
      return { ...shape(state.cache, { platform, arch }), cached: true };
    }
    if (result.error || !result.release) {
      state.failAt = now;
      state.failError = result.error || '检查更新失败';
      return { ok: false, error: state.failError, current: cleanVersion(app?.getVersion?.() || '') };
    }
    state.cache = result.release;
    state.at = now;
    state.failAt = 0;
    return shape(result.release, { platform, arch });
  }

  function sendProgress(payload) {
    try {
      const win = require('electron').BrowserWindow.getAllWindows()[0];
      win?.webContents?.send('update:progress', payload);
    } catch {
      /* 窗口没了就只是不发进度 */
    }
  }

  // 走 session（继承应用代理）的流式下载：实测 github.com 的 Release 资产直连不通、代理 206，
// 而 api.github.com 恰好相反 —— 所以下载先走 session，失败再退回直连，两条路都不改调用方。
async function streamViaSession(session, url, filePath, onProgress) {
  const fetchImpl = session?.defaultSession?.fetch;
  if (!fetchImpl) throw new Error('session.fetch 不可用');
  const controller = new AbortController();
  let idleTimer = 0;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 45000);
  };
  armIdle();
  try {
    const response = await fetchImpl(url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(filePath);
    const reader = response.body.getReader();
    let received = 0;
    let lastAt = 0;
    for (;;) {
      armIdle();
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => out.once('drain', resolve));
      }
      const now = Date.now();
      if (now - lastAt >= 150) {
        lastAt = now;
        onProgress({ phase: 'downloading', received, total, percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0 });
      }
    }
    await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
    onProgress({ phase: 'downloading', received, total: total || received, percent: 100 });
    return { bytes: received, total: total || received };
  } finally {
    clearTimeout(idleTimer);
  }
}

async function download({ url, name } = {}, onProgress = sendProgress) {
    if (!hostAllowed(url)) return { ok: false, error: '下载地址不在允许的域名内' };
    const safeName = String(name || '').replace(/[^\w.\-]+/g, '_').slice(0, 120);
    if (!safeName || !ALLOWED_EXT.test(safeName)) return { ok: false, error: '安装包文件名不合法' };
    if (activeDownload) return { ok: false, error: '已有下载在进行' };
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { ok: false, error: `无法创建下载目录：${error.message}` };
    }
    const target = path.join(dir, safeName);
    const part = `${target}.part`;
    activeDownload = safeName;
    const startedAt = Date.now();
    try {
      let bytes = 0;
      let total = 0;
      try {
        ({ bytes, total } = await streamViaSession(session, url, part, onProgress));
      } catch (sessionError) {
        try {
          if (fs.existsSync(part)) fs.unlinkSync(part);
        } catch { /* ignore */ }
        ({ bytes, total } = await streamToFile(url, part, onProgress));
      }
      fs.renameSync(part, target);
      const ms = Math.max(1, Date.now() - startedAt);
      onProgress?.({ phase: 'done', percent: 100, bytes, total, name: safeName, ms });
      return {
        ok: true,
        path: target,
        name: safeName,
        bytes,
        total,
        ms,
        speedMBps: Number(((bytes / 1048576) / (ms / 1000)).toFixed(2)),
      };
    } catch (error) {
      try {
        if (fs.existsSync(part)) fs.unlinkSync(part);
      } catch { /* ignore */ }
      return { ok: false, error: String(error?.message || error) };
    } finally {
      activeDownload = null;
    }
  }

  // Windows：静默跑 NSIS 安装包（per-user 安装、不弹 UAC），随后由渲染层让应用退出
  function install({ path: file } = {}) {
    if (process.platform !== 'win32') return { ok: false, error: '当前系统不支持静默覆盖安装，已打开安装包' };
    // path.resolve 会把 `/` 归一成 Windows 分隔符，渲染层传什么写法都能对上
    const target = path.resolve(String(file || ''));
    if (!/\.exe$/i.test(target) || !fs.existsSync(target)) return { ok: false, error: '安装包不存在' };
    if (path.dirname(target) !== path.resolve(dir)) return { ok: false, error: '安装包不在下载目录内' };
    try {
      const child = require('node:child_process').spawn(target, ['/S'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return { ok: true, launched: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  return { check, download, install, pickAsset, dir };
}

module.exports = { createUpdater, pickAsset, cleanVersion, compareVersions };
