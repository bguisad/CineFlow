'use strict';
/**
 * IPC 契约层（新增文件，零触碰架构基建之四）。
 * 为已知高频通道定义 payload 校验器，并在**全部包装器之后**以 log-only 方式安装：
 * 只记录违规（便于发现契约漂移），绝不修改/拦截返回值——保证零回归。
 * cf:contract.list 提供契约自省视图。
 */

const telemetry = require('./telemetry.cjs');

/** 校验器：返回 null 表示通过，否则返回违规描述字符串 */
const validators = {
  'app:importResourceSources': (payload) => (typeof payload === 'string' || (payload && typeof payload === 'object') ? null : 'payload 应为字符串或对象'),
  'app:saveProxy': (payload) => (payload === null || typeof payload === 'string' ? null : 'proxy 应为字符串或 null'),
  'tmdb:search': (payload) => (typeof payload === 'string' ? null : 'query 应为字符串'),
  'resources:findMovieFiltered': (payload, options) => {
    if (payload && typeof payload !== 'object') return 'payload 应为对象';
    if (options !== undefined && (options === null || typeof options !== 'object')) return 'options 应为对象';
    if (options?.cursor !== undefined && Number.isNaN(Number(options.cursor))) return 'cursor 应为数字';
    return null;
  },
  'resources:testSource': (payload) => (payload && typeof payload === 'object' && (payload.key || payload.api) ? null : '需要 key 或 api'),
  'douban:playSource': (payload) => (payload && typeof payload === 'object' && payload.title ? null : '需要 title'),
  'douban:hot': (payload) => (payload === undefined || (payload && typeof payload === 'object') ? null : 'payload 应为对象'),
  'rec:browseHint': (payload) => (payload && typeof payload === 'object' ? null : 'payload 应为对象'),
  'rec:doubanRecentHot': (payload) => (payload && typeof payload === 'object' ? null : 'payload 应为对象'),
  'media:prewarm': (payload) => (payload && typeof payload === 'object' ? null : 'payload 应为对象')
};

const contractView = () => Object.entries(validators).map(([channel, validate]) => ({
  channel,
  arity: validate.length,
  enforced: false,          // log-only：不拦截
  description: 'payload 形状校验，违规仅记录'
}));

function installIpcContract(ipcMain) {
  try {
    if (!ipcMain || typeof ipcMain._invokeHandlers !== 'object') return;
    const handlers = ipcMain._invokeHandlers;
    let wrapped = 0;
    for (const [channel, validate] of Object.entries(validators)) {
      const original = handlers.get(channel);
      if (typeof original !== 'function') continue;
      handlers.set(channel, async (event, ...args) => {
        try {
          const violation = validate(...args);
          if (violation) {
            telemetry.record('contract.violation', { channel, violation, payload: String(args[0] ?? '').slice(0, 120) });
          }
        } catch { /* 校验自身异常绝不外泄 */ }
        return original(event, ...args);
      });
      wrapped += 1;
    }
    if (!handlers.get('cf:contract.list')) {
      handlers.set('cf:contract.list', async () => ({ channels: contractView(), wrapped }));
    }
    return { wrapped, total: Object.keys(validators).length };
  } catch { /* 契约层失败不影响任何功能 */ }
  return { wrapped: 0, total: 0 };
}

module.exports = { installIpcContract, contractView, validators };
