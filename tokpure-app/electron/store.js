'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const DEFAULT_DOWNLOAD_DIR =
  process.platform === 'win32'
    ? path.join(os.homedir(), 'Videos', 'TokPure', 'Downloads')
    : path.join(os.homedir(), 'Movies', 'TokPure', 'Downloads');

const DEFAULTS = {
  downloadDir: DEFAULT_DOWNLOAD_DIR,
  proxy: {
    // 'system' = follow the OS system proxy (auto-detect), 'custom' = manual, 'direct' = no proxy
    mode: 'system',
    enabled: false,
    protocol: 'socks5', // 'socks5' | 'http'
    host: '127.0.0.1',
    port: 7890,
    authEnabled: false,
    username: '',
    password: ''
  },
  uaPreset: process.platform === 'win32' ? 'windows_chrome' : 'macos_safari', // 'macos_safari' | 'ios_app' | 'windows_chrome' | 'custom'
  customUA: '',
  clipboardSniff: true,
  concurrency: 3,
  savePoster: true,
  extractMp3: false,
  removeLogo: false, // FFmpeg local cleanup fallback
  cookie: '',
  parseApi: '' // optional user supplied parse endpoint
};

let cache = null;
let filePath = null;

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(patch || {})) {
    const v = patch[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[key] === 'object' && base[key] !== null) {
      out[key] = deepMerge(base[key], v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function ensureLoaded() {
  if (cache) return cache;
  filePath = path.join(app.getPath('userData'), 'settings.json');
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      cache = deepMerge(DEFAULTS, raw);
    } else {
      cache = deepMerge(DEFAULTS, {});
    }
  } catch (e) {
    cache = deepMerge(DEFAULTS, {});
  }
  // migration: an older settings.json that enabled a manual proxy becomes 'custom' mode
  if (cache.proxy && cache.proxy.mode === DEFAULTS.proxy.mode) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && raw.proxy && raw.proxy.mode === undefined && raw.proxy.enabled) {
        cache.proxy.mode = 'custom';
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (cache.downloadDir) {
    try {
      fs.mkdirSync(cache.downloadDir, { recursive: true });
    } catch (_) {
      /* ignore */
    }
  }
  return cache;
}

function get() {
  return ensureLoaded();
}

function save(patch) {
  ensureLoaded();
  cache = deepMerge(cache, patch || {});
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    /* ignore */
  }
  if (cache.downloadDir) {
    try {
      fs.mkdirSync(cache.downloadDir, { recursive: true });
    } catch (_) {
      /* ignore */
    }
  }
  return cache;
}

function reset() {
  ensureLoaded();
  cache = deepMerge(DEFAULTS, {});
  save({});
  return cache;
}

module.exports = { get, save, reset, DEFAULTS, DEFAULT_DOWNLOAD_DIR };