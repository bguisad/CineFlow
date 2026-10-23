'use strict';
/**
 * v3.4.1 纯增量：TMDB 应用内凭证向导的主进程状态机。
 *
 * 只做 TMDB 官方文档里的 v4「Application Default Credentials」授权流：
 *   1) GET  /3/authentication/token/new?api_key=...      （这一步 TMDB 要求已有 v3 Key，无法跳过）
 *   2) 浏览器打开 https://www.themoviedb.org/auth/access?request_token=...，由用户自己点"批准"
 *   3) POST /4/authentication/access_token {request_token}  换回 Read Access Token
 *   4) 交给主进程既有的保存链路写进本机 settings.json
 *
 * 刻意不碰注册、CAPTCHA、邮箱验证、开发者表格审批 —— 那些是 TMDB 自己的准入环节。
 * 没有 v3 Key 时本模块直接返回 NEED_API_KEY，由渲染层改走"打开申请页 + 剪贴板自动识别"的引导路径。
 * 整个文件删掉 + 撤掉 main.cjs 末尾那一段挂钩，应用就退回第十二轮的设置页形态。
 */

const APPROVAL_BASE = 'https://www.themoviedb.org/auth/access';
const API3_HOSTS = ['https://api.themoviedb.org/3'];
const API4_HOSTS = ['https://api.tmdb.org/4', 'https://api.themoviedb.org/4'];
// 换 Read Access Token 的两个候选路径：TMDB 文档写的是 /4/auth/access_token，
// 早期实现走的是 /4/authentication/access_token，两个都试一遍，谁先回 200 用谁。
const ACCESS_TOKEN_PATHS = ['/auth/access_token', '/authentication/access_token'];
const POLL_INTERVAL_MS = 2500;
const APPROVAL_TIMEOUT_MS = 6 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

// 剪贴板里的东西是不是一个能用的 TMDB 凭证：v3 Key 是 32 位十六进制，v4 用户令牌以 eyJ 开头的 JWT
function classifyCredential(raw) {
  const value = String(raw || '').replace(/\s+/g, '');
  if (!value) return null;
  if (/^eyJ[A-Za-z0-9_.\-]{40,}$/.test(value)) return { type: 'readToken', value, label: 'Read Access Token' };
  if (/^[a-f0-9]{32}$/i.test(value)) return { type: 'apiKey', value, label: 'API Key' };
  return null;
}

// TMDB 各处返回字段不完全一致：access_token 既可能是对象也可能是字符串，token 也可能直接挂在顶层
function pickAccessToken(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  const inner = payload.access_token && typeof payload.access_token === 'object'
    ? payload.access_token
    : payload;
  return String(inner.token || inner.access_token || (typeof payload.access_token === 'string' ? payload.access_token : '') || '').trim();
}

function createTmdbAuthFlow(deps) {
  const { fetchJson, openExternal, readCredential, saveCredential } = deps;
  let flow = null;

  const idle = () => ({ active: false, phase: 'idle', step: 0, message: '' });

  function snapshot() {
    if (!flow) return idle();
    return {
      active: !flow.done,
      phase: flow.phase,
      step: flow.step,
      message: flow.message,
      error: flow.error,
      approvalUrl: flow.approvalUrl,
      preview: flow.preview,
      waitedMs: flow.done ? 0 : now() - flow.startedAt,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
    };
  }

  function setStep(phase, step, message) {
    if (!flow) return;
    flow.phase = phase;
    flow.step = step;
    flow.message = message;
  }

  function fail(error) {
    if (!flow) return;
    flow.done = true;
    flow.finishedAt = now();
    flow.error = String(error || '未知错误');
    setStep('failed', flow.step || 0, flow.error);
  }

  async function requestJson(hosts, pathname, options) {
    let lastError = 'TMDB 无响应';
    for (const host of hosts) {
      const result = await fetchJson(`${host}${pathname}`, options).catch((error) => ({ error: error?.message || error }));
      if (!result) continue;
      if (result.ok) return { ok: true, data: result.data };
      if (result.error) lastError = String(result.error);
      // 401/403 在"等待批准"阶段是正常信号，交给上层继续轮询；换 host 没意义
      if (result.status && result.status !== 0) return { ok: false, status: result.status, error: lastError };
    }
    return { ok: false, error: lastError };
  }

  async function finish(value) {
    setStep('saving', 4, '正在写入本机配置');
    try {
      const state = await saveCredential(value);
      if (!flow) return;
      flow.done = true;
      flow.finishedAt = now();
      flow.preview = state?.preview || '';
      setStep('saved', 5, 'Read Access Token 已保存');
    } catch (error) {
      fail(`保存失败：${error?.message || error}`);
    }
  }

  async function pollForApproval() {
    while (flow && !flow.done && now() - flow.startedAt < APPROVAL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      if (!flow || flow.done) return;
      let result = { ok: false };
      for (const path of ACCESS_TOKEN_PATHS) {
        result = await requestJson(API4_HOSTS, path, {
          method: 'POST',
          body: { request_token: flow.requestToken },
          // 换 token 这一步 TMDB 也认 api_key；带上不影响结果，漏了则可能一路 401
          apiKey: flow.apiKey,
        });
        if (!flow || flow.done) return;
        if (result.ok) break;
        // 401/404 说明这条路径还没通（未批准 / 路径不对），换下一条；其它错误直接认栽
        if (result.status && result.status !== 401 && result.status !== 404) break;
      }
      if (result.ok) {
        const value = pickAccessToken(result.data);
        if (value) return finish(value);
        fail('TMDB 返回的令牌是空的');
        return;
      }
      // key 本身无效（status_code 7）时没必要把 6 分钟等完
      if (/invalid api key/i.test(String(result.error || ''))) {
        fail('这把 API Key 被 TMDB 判定无效，先回上一步换一把');
        return;
      }
      setStep('awaiting-approval', 3, '还在等你在 TMDB 页面点批准');
    }
    if (flow && !flow.done) fail('授权超时：6 分钟内没有完成批准');
  }

  async function start() {
    if (flow && !flow.done) return { ok: true, reused: true, state: snapshot() };

    const credential = readCredential();
    if (!credential || credential.type !== 'apiKey') {
      flow = { done: true, phase: credential ? 'has-read-token' : 'need-api-key', step: 0, startedAt: now(), finishedAt: now() };
      return { ok: false, code: credential ? 'HAS_READ_TOKEN' : 'NEED_API_KEY', state: snapshot() };
    }

    flow = {
      done: false,
      phase: 'requesting',
      step: 1,
      message: '正在申请 request token',
      startedAt: now(),
      approvalUrl: '',
      requestToken: '',
      apiKey: credential.value,
      preview: '',
      error: '',
    };

    const result = await requestJson(API3_HOSTS, '/authentication/token/new', { apiKey: credential.value });
    if (!flow || flow.done) return { ok: false, code: 'CANCELLED', state: snapshot() };
    if (!result.ok) {
      fail(`申请 request token 失败：${result.error || result.status}`);
      return { ok: false, code: 'REQUEST_TOKEN_FAILED', error: flow.error, state: snapshot() };
    }

    const token = String(result.data?.token || result.data?.request_token || '').trim();
    if (!token) {
      fail('TMDB 没有返回 request token');
      return { ok: false, code: 'NO_REQUEST_TOKEN', error: flow.error, state: snapshot() };
    }

    flow.requestToken = token;
    flow.approvalUrl = `${APPROVAL_BASE}?request_token=${encodeURIComponent(token)}`;
    setStep('opening', 2, '正在打开 TMDB 授权页');
    const opened = await openExternal(flow.approvalUrl).catch(() => false);
    if (!opened) {
      fail('打不开系统浏览器，请检查默认浏览器设置');
      return { ok: false, code: 'OPEN_FAILED', error: flow.error, state: snapshot() };
    }
    setStep('awaiting-approval', 3, '在 TMDB 页面点一下"批准"');
    pollForApproval();
    return { ok: true, state: snapshot() };
  }

  function cancel() {
    if (!flow || flow.done) return snapshot();
    flow.done = true;
    flow.finishedAt = now();
    setStep('cancelled', flow.step, '已取消');
    return snapshot();
  }

  return { start, snapshot, cancel, classifyCredential };
}

module.exports = { createTmdbAuthFlow, classifyCredential, pickAccessToken, APPROVAL_BASE };
