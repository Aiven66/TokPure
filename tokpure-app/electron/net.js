'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const UA_PRESETS = {
  macos_safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  ios_app: 'TikTok 34.1.0 rv:341014 (iPhone; iOS 17.4; en_US) Cronet',
  windows_chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

function resolveUA(settings) {
  if (!settings) return UA_PRESETS.macos_safari;
  if (settings.uaPreset === 'custom' && settings.customUA) return settings.customUA;
  return UA_PRESETS[settings.uaPreset] || UA_PRESETS.macos_safari;
}

function buildAgent(proxy) {
  if (!proxy || !proxy.enabled) return null;
  const auth =
    proxy.authEnabled && proxy.username
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
      : '';
  const host = proxy.host || '127.0.0.1';
  const port = proxy.port || 7890;
  try {
    if (proxy.protocol === 'http') {
      return new HttpsProxyAgent(`http://${auth}${host}:${port}`);
    }
    return new SocksProxyAgent(`socks5h://${auth}${host}:${port}`);
  } catch (e) {
    return null;
  }
}

/**
 * Parse an Electron `session.resolveProxy()` result into a proxy config object.
 * Accepts values such as "PROXY 127.0.0.1:7897", "SOCKS5 127.0.0.1:7897",
 * "HTTPS proxy.local:8080" or "DIRECT".
 */
function parseProxySpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw || /^DIRECT$/i.test(raw)) return null;
  const m = raw.match(/(PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+([^\s;]+)/i);
  if (!m) return null;
  const kind = m[1].toUpperCase();
  const hostPort = m[2].replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const idx = hostPort.lastIndexOf(':');
  const host = idx > -1 ? hostPort.slice(0, idx) : hostPort;
  const port = idx > -1 ? Number(hostPort.slice(idx + 1)) : NaN;
  if (!host) return null;
  return {
    enabled: true,
    protocol: kind.startsWith('SOCKS') ? 'socks5' : 'http',
    host,
    port: Number.isFinite(port) && port > 0 ? port : 7890,
    auto: true,
    source: kind
  };
}

class HttpResponse {
  constructor(stream, meta) {
    this.stream = stream;
    this.statusCode = meta.statusCode;
    this.headers = meta.headers;
    this.url = meta.url;
  }
}

/**
 * Raw request returning a response stream (redirects followed).
 *
 * The timeout is enforced by an explicit timer rather than the socket `timeout`
 * option: with a proxy agent the socket-level timeout can take roughly twice the
 * configured value to surface (the tunnel socket and the request socket both
 * time out), which made blocked routes hang far longer than intended.
 */
function requestStream(url, opts = {}) {
  const { headers = {}, proxy, timeout = 30000, method = 'GET', maxRedirects = 6 } = opts;
  const agent = buildAgent(proxy);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let req = null;
    let redirects = 0;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const arm = () => {
      cleanup();
      timer = setTimeout(() => {
        const current = req;
        finish(reject, new Error('请求超时'));
        if (current) current.destroy();
      }, timeout);
    };

    const go = (target) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch (e) {
        return finish(reject, new Error(`非法URL: ${target}`));
      }
      if (settled) return;
      const mod = parsed.protocol === 'http:' ? http : https;
      const reqOpts = { method, headers, agent: agent || undefined };
      arm();
      req = mod.request(parsed, reqOpts, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          if (redirects >= maxRedirects) {
            res.resume();
            return finish(reject, new Error('重定向次数过多'));
          }
          redirects += 1;
          res.resume();
          return go(new URL(res.headers.location, parsed).toString());
        }
        finish(resolve, new HttpResponse(res, { statusCode: status, headers: res.headers, url: target }));
      });
      req.on('error', (e) => finish(reject, e));
      req.end();
      if (opts.abortSignal) {
        opts.abortSignal.addEventListener('abort', () => {
          finish(reject, new Error('已取消'));
          if (req) req.destroy();
        });
      }
    };
    go(url);
  });
}

function readAll(stream, limitBytes = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        stream.destroy();
        return reject(new Error('响应体过大'));
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function requestBuffer(url, opts = {}) {
  const res = await requestStream(url, opts);
  const body = await readAll(res.stream, opts.limitBytes);
  return { statusCode: res.statusCode, headers: res.headers, body, url: res.url };
}

async function requestJSON(url, opts = {}) {
  const res = await requestBuffer(url, opts);
  const text = res.body.toString('utf8');
  try {
    return { statusCode: res.statusCode, headers: res.headers, data: JSON.parse(text), url: res.url };
  } catch (e) {
    const err = new Error(`响应不是合法JSON (HTTP ${res.statusCode})`);
    err.statusCode = res.statusCode; // let callers detect 429 / 403 / 5xx and retry
    throw err;
  }
}

async function resolveFinalUrl(url, opts = {}) {
  const res = await requestStream(url, { ...opts, method: 'GET' });
  res.stream.resume();
  return res.url;
}

/**
 * Stream a URL to a file with progress callbacks.
 */
async function downloadToFile(url, destPath, opts = {}) {
  const { headers = {}, proxy, onProgress, abortSignal, timeout = 60000 } = opts;
  const res = await requestStream(url, { headers, proxy, timeout, abortSignal });
  if (res.statusCode >= 400) {
    res.stream.resume();
    throw new Error(`下载失败 HTTP ${res.statusCode}`);
  }
  const total = Number(res.headers['content-length'] || 0);
  let received = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    let lastDataAt = Date.now();
    // the response body has no socket timeout, so guard against a stalled stream
    const stallMs = Math.max(15000, Number(timeout) || 60000);
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataAt > stallMs) {
        res.stream.destroy(new Error('下载停滞，已超时'));
      }
    }, 5000);
    const stopWatchdog = () => clearInterval(watchdog);
    const onAbort = () => {
      stopWatchdog();
      res.stream.destroy();
      out.destroy();
      fs.unlink(destPath, () => {});
      reject(new Error('已取消'));
    };
    if (abortSignal) abortSignal.addEventListener('abort', onAbort);
    res.stream.on('data', (chunk) => {
      received += chunk.length;
      lastDataAt = Date.now();
      if (onProgress) onProgress(received, total);
    });
    res.stream.on('error', (err) => {
      stopWatchdog();
      out.destroy();
      fs.unlink(destPath, () => {});
      reject(err);
    });
    out.on('error', (err) => {
      stopWatchdog();
      res.stream.destroy();
      fs.unlink(destPath, () => {});
      reject(err);
    });
    out.on('finish', () => {
      stopWatchdog();
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      resolve();
    });
    res.stream.pipe(out);
  });
  return { size: received, contentType: res.headers['content-type'] || '' };
}

module.exports = {
  UA_PRESETS,
  resolveUA,
  buildAgent,
  parseProxySpec,
  requestStream,
  requestBuffer,
  requestJSON,
  resolveFinalUrl,
  downloadToFile
};