'use strict';
/**
 * 服务注册表（新增文件，零触碰架构基建之三）。
 * 为外挂服务（source-compat / source-engine / 契约层 / 诊断通道）提供统一的
 * 生命周期：按注册顺序安装、失败隔离（单服务异常不影响其它）、健康自省。
 * bootstrap.cjs 经 registerServices 一次性装配；cf:services.list 提供装载结果视图。
 */

const services = [];          // { id, deps, install, state: 'pending'|'ok'|'failed', error, installedAt }

function registerService(id, install, { deps = [] } = {}) {
  services.push({ id: String(id), deps: [...deps], install: install || (() => {}), state: 'pending', error: null, installedAt: 0 });
}

function installServices(context = {}) {
  const results = [];
  for (const service of services) {
    const missing = service.deps.filter((dep) => !services.some((s) => s.id === dep && s.state === 'ok'));
    if (missing.length) {
      service.state = 'failed';
      service.error = `依赖未就绪: ${missing.join(', ')}`;
      results.push({ id: service.id, state: service.state, error: service.error });
      continue;
    }
    try {
      service.install(context);
      service.state = 'ok';
      service.installedAt = Date.now();
      results.push({ id: service.id, state: 'ok' });
    } catch (error) {
      service.state = 'failed';
      service.error = String(error?.message || error);
      results.push({ id: service.id, state: 'failed', error: service.error });
    }
  }
  return results;
}

function listServices() {
  return services.map(({ id, deps, state, error, installedAt }) => ({ id, deps, state, error, installedAt }));
}

function isHealthy(id) {
  return services.some((service) => service.id === id && service.state === 'ok');
}

function installServiceChannels(ipcMain) {
  try {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    if (!ipcMain._invokeHandlers.get('cf:services.list')) {
      ipcMain.handle('cf:services.list', () => ({ services: listServices() }));
    }
  } catch { /* 诊断通道注册失败不影响功能 */ }
}

module.exports = { registerService, installServices, listServices, isHealthy, installServiceChannels };
