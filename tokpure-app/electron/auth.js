'use strict';

/**
 * 桌面端账号模块。
 *
 * 登录不再在客户端内收集密码：客户端只负责启动一个绑定在 127.0.0.1 随机端口上的
 * 一次性 loopback 服务器，然后调用系统浏览器打开官网登录页（附带
 * `?from=desktop&callback=http://127.0.0.1:<port>`）。用户在网页完成登录/注册后，
 * public-pkg 会把 access_token / refresh_token 回跳到该 loopback 地址，客户端拿到
 * token 后落盘并通知渲染层——「显示已登录账号」。
 *
 * 会话落盘：<userData>/auth.json，与 settings.json 分离，避免把 token 混进
 * 会通过 settings:get 透出的普通配置里。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { app, shell } = require('electron');

/** 官网基址（可用环境变量覆盖，便于本地联调）。 */
const WEB_BASE = (process.env.TOKPURE_WEB_BASE || 'https://tokpure.vercel.app').replace(/\/+$/, '');
const LOGIN_URL = `${WEB_BASE}/login.html`;
/** 等待用户在浏览器完成登录的最长时间。 */
const LOGIN_TIMEOUT = 5 * 60 * 1000;

/** undefined = 尚未从磁盘读取；null = 已读取且无会话。 */
let cache;
let filePath = null;
let pending = null;
const changeHandlers = [];

function ensurePath() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'auth.json');
  return filePath;
}

function decodePayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

/** 归一化：token 里的 email/name/role 作为兜底，回调显式字段优先。 */
function normalizeSession(raw) {
  if (!raw || !raw.token) return null;
  const payload = decodePayload(raw.token) || {};
  const meta = payload.user_metadata && typeof payload.user_metadata === 'object' ? payload.user_metadata : {};
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  return {
    token: String(raw.token),
    refreshToken: raw.refreshToken ? String(raw.refreshToken) : null,
    email: raw.email || payload.email || '',
    name: raw.name || meta.name || payload.full_name || '',
    userId: raw.userId || payload.sub || '',
    role: typeof payload.role === 'string' ? payload.role : 'user',
    loginAt: raw.loginAt || Date.now(),
    expiresAt: exp ? exp * 1000 : null
  };
}

function load() {
  if (cache !== undefined) return cache;
  ensurePath();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cache = normalizeSession(raw);
  } catch (_) {
    cache = null;
  }
  return cache;
}

function persist(session) {
  cache = session;
  ensurePath();
  try {
    if (session) fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
    else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {
    /* 落盘失败不应阻断登录，内存态仍可用 */
  }
}

function emit(session) {
  changeHandlers.forEach((fn) => {
    try {
      fn(session);
    } catch (_) {
      /* 单个订阅者异常不影响其它 */
    }
  });
}

function getSession() {
  return load();
}

function setSession(raw) {
  const session = normalizeSession(raw);
  if (!session) return null;
  persist(session);
  emit(session);
  return session;
}

function logout() {
  persist(null);
  emit(null);
  return true;
}

/** 打开官网（登录/注册入口）。 */
function openWeb(target) {
  const url = typeof target === 'string' && /^https?:\/\//.test(target) ? target : WEB_BASE;
  return shell.openExternal(url);
}

function resultPage(title, message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title} · TokPure</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#111317;color:#e6e8ee;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif}
  .box{max-width:420px;padding:36px 32px;text-align:center}
  h1{font-size:20px;margin:0 0 10px}
  p{margin:0;color:#9aa3b2}
</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * 启动一次桌面登录：返回 Promise，用户在浏览器完成登录后 resolve 会话。
 * 若已有进行中的登录，直接复用同一个 Promise（避免开多个服务器/多个浏览器标签）。
 */
function login() {
  if (pending) return pending.promise;

  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const state = { server: null, timer: null, done: false };

  const finish = (err, session) => {
    if (state.done) return;
    state.done = true;
    pending = null;
    if (state.timer) clearTimeout(state.timer);
    if (state.server) {
      try {
        state.server.close();
      } catch (_) {
        /* ignore */
      }
    }
    if (err) rejectFn(err);
    else resolveFn(session);
  };

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (_) {
      res.writeHead(400).end();
      return;
    }
    if (url.pathname !== '/' && url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const token = url.searchParams.get('token') || '';
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage('登录失败', '未收到登录凭证，请返回 TokPure 客户端重新发起登录。'));
      return;
    }

    const session = setSession({
      token,
      refreshToken: url.searchParams.get('refreshToken'),
      email: url.searchParams.get('email'),
      userId: url.searchParams.get('userId'),
      name: url.searchParams.get('name')
    });

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(resultPage('登录成功', `已登录：${session.email || session.userId}。请返回 TokPure 客户端继续使用。`));
    finish(null, session);
  });

  state.server = server;
  pending = { promise };

  server.on('error', (err) => finish(err));
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const callback = `http://127.0.0.1:${port}`;
    const loginUrl = `${LOGIN_URL}?from=desktop&callback=${encodeURIComponent(callback)}`;
    shell.openExternal(loginUrl).catch((err) => finish(err));
    state.timer = setTimeout(() => finish(new Error('登录超时，请重试')), LOGIN_TIMEOUT);
  });

  return promise;
}

function onSessionChange(fn) {
  changeHandlers.push(fn);
}

module.exports = { getSession, setSession, logout, login, openWeb, onSessionChange, WEB_BASE };