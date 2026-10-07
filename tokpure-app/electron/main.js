'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const net = require('./net');
const tiktok = require('./tiktok');
const ffmpeg = require('./ffmpeg');
const Downloader = require('./downloader');

let mainWindow = null;
const isMac = process.platform === 'darwin';
const downloader = new Downloader(() => networkSettings());

/**
 * Resolved OS-level proxy (Electron honours the macOS/Windows system proxy settings).
 * Cached briefly so every parse/download does not re-query the network stack.
 */
let systemProxy = null;
let systemProxyCheckedAt = 0;
const SYSTEM_PROXY_TTL = 15000;

async function refreshSystemProxy(force = false) {
  if (!force && Date.now() - systemProxyCheckedAt < SYSTEM_PROXY_TTL) return systemProxy;
  systemProxyCheckedAt = Date.now();
  try {
    const spec = await session.defaultSession.resolveProxy('https://www.tiktok.com/');
    systemProxy = net.parseProxySpec(spec);
  } catch (_) {
    systemProxy = null;
  }
  return systemProxy;
}

function proxyMode(settings) {
  const p = settings && settings.proxy;
  if (!p) return 'direct';
  if (p.mode) return p.mode;
  return p.enabled ? 'custom' : 'direct';
}

/**
 * Effective network settings handed to the parser / downloader.
 * 'system' injects the auto-detected OS proxy, 'custom' uses the manual config,
 * 'direct' forces a plain connection.
 */
function networkSettings() {
  const s = store.get();
  const mode = proxyMode(s);
  let proxy;
  if (mode === 'custom') proxy = { ...s.proxy, enabled: true };
  else if (mode === 'system') proxy = systemProxy || { enabled: false };
  else proxy = { enabled: false };
  return { ...s, proxy, proxyMode: mode };
}

function createWindow() {
  // macOS: keep the window framed so the OS draws its native traffic lights on
  // top of the content — `titleBarStyle: 'hidden'` only hides the title bar.
  // These native buttons always receive mouse events. The previous `frame: false`
  // removed them completely and left only self-drawn buttons living inside the
  // window's drag region, where macOS swallows the click (hit-test counts as a
  // window drag), so minimize/maximize/close never fired.
  // Windows/Linux: frameless window with the self-drawn title-bar buttons.
  const platformWindow = isMac
    ? {
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 18, y: 20 },
        vibrancy: 'under-window',
        visualEffectState: 'active',
        roundedCorners: true
      }
    : { frame: false };

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#111317',
    ...platformWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  // Windows/Linux use a frameless window with no native menu bar; installing the
  // macOS-style application menu there would only add leftover mac菜单 entries.
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  const template = [
    {
      label: 'TokPure',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function wireDownloader() {
  ['update', 'add', 'remove', 'paused'].forEach((evt) => {
    downloader.on(evt, (payload) => sendToRenderer(`dl:${evt}`, payload));
  });
}

function registerIpc() {
  // ---- settings ----
  ipcMain.handle('settings:get', () => store.get());
  ipcMain.handle('settings:save', async (_e, patch) => {
    const saved = store.save(patch);
    if (proxyMode(saved) === 'system') await refreshSystemProxy(true);
    return saved;
  });
  ipcMain.handle('settings:reset', async () => {
    const saved = store.reset();
    await refreshSystemProxy(true);
    return saved;
  });
  ipcMain.handle('settings:chooseDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.get().downloadDir
    });
    if (res.canceled || !res.filePaths.length) return null;
    return store.save({ downloadDir: res.filePaths[0] }).downloadDir;
  });

  // ---- parse ----
  ipcMain.handle('tik:parse', async (_e, url) => {
    await refreshSystemProxy(true);
    return tiktok.parse(url, networkSettings());
  });

  // ---- download queue ----
  ipcMain.handle('dl:add', (_e, url, opts) => downloader.add(url, opts || {}));
  ipcMain.handle('dl:list', () => downloader.list());
  ipcMain.handle('dl:stats', () => downloader.stats());
  ipcMain.handle('dl:pause', () => downloader.pauseAll());
  ipcMain.handle('dl:resume', () => downloader.resumeAll());
  ipcMain.handle('dl:cancel', (_e, id) => downloader.cancel(id));
  ipcMain.handle('dl:retry', (_e, id) => downloader.retry(id));
  ipcMain.handle('dl:remove', (_e, id) => downloader.remove(id));
  ipcMain.handle('dl:clearCompleted', () => downloader.clearCompleted());
  ipcMain.handle('dl:setConcurrency', (_e, n) => {
    store.save({ concurrency: n });
    downloader.setConcurrency(n);
    return downloader.maxConcurrent;
  });

  // ---- filesystem / library ----
  ipcMain.handle('fs:reveal', (_e, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    return true;
  });
  ipcMain.handle('fs:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('fs:openFolder', () => {
    const dir = store.get().downloadDir;
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  ipcMain.handle('fs:library', () => {
    const dir = store.get().downloadDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => {
          const full = path.join(dir, e.name);
          const st = fs.statSync(full);
          return {
            name: e.name,
            path: full,
            size: st.size,
            mtime: st.mtimeMs,
            kind: /\.(mp4|mov|webm)$/i.test(e.name)
              ? 'video'
              : /\.(mp3|m4a|aac|wav)$/i.test(e.name)
              ? 'audio'
              : /\.(jpg|jpeg|png|webp)$/i.test(e.name)
              ? 'image'
              : 'other'
          };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return { dir, files };
    } catch (e) {
      return { dir, files: [], error: e.message };
    }
  });
  ipcMain.handle('fs:delete', async (_e, filePath) => {
    try {
      await shell.trashItem(filePath);
      return true;
    } catch (e) {
      return false;
    }
  });

  // ---- clipboard ----
  ipcMain.handle('clip:read', () => clipboard.readText());

  // ---- window controls ----
  ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('win:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('win:close', () => mainWindow && mainWindow.close());

  // ---- ffmpeg / diagnostics ----
  ipcMain.handle('ffmpeg:status', () => ffmpeg.verifyFfmpeg());
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    proxy: store.get().proxy
  }));

  ipcMain.handle('net:test', async () => {
    await refreshSystemProxy(true);
    const settings = networkSettings();
    const results = {
      tiktok: null,
      cdn: null,
      proxy: !!(settings.proxy && settings.proxy.enabled),
      mode: settings.proxyMode,
      detected: systemProxy
        ? { protocol: systemProxy.protocol, host: systemProxy.host, port: systemProxy.port }
        : null,
      effective:
        settings.proxy && settings.proxy.enabled
          ? `${settings.proxy.protocol.toUpperCase()} · ${settings.proxy.host}:${settings.proxy.port}`
          : '直接连接 · 无代理'
    };
    const targets = [
      { key: 'tiktok', url: 'https://www.tiktok.com/favicon.ico' },
      { key: 'cdn', url: 'https://www.tiktok.com/' }
    ];
    for (const t of targets) {
      // retry once: a single transient failure should not report the whole link as down
      let last = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const start = Date.now();
        try {
          const res = await net.requestStream(t.url, {
            proxy: settings.proxy,
            headers: { 'User-Agent': net.resolveUA(settings) },
            timeout: 12000
          });
          res.stream.resume();
          last = { ok: res.statusCode > 0 && res.statusCode < 500, status: res.statusCode, ms: Date.now() - start };
          if (last.ok) break;
        } catch (e) {
          last = { ok: false, error: e.message, ms: Date.now() - start };
        }
      }
      results[t.key] = last;
    }
    return results;
  });

  ipcMain.handle('net:detect', async () => {
    await refreshSystemProxy(true);
    const settings = networkSettings();
    return {
      mode: settings.proxyMode,
      enabled: !!(settings.proxy && settings.proxy.enabled),
      detected: systemProxy
        ? { protocol: systemProxy.protocol, host: systemProxy.host, port: systemProxy.port, source: systemProxy.source }
        : null,
      effective:
        settings.proxy && settings.proxy.enabled
          ? { protocol: settings.proxy.protocol, host: settings.proxy.host, port: settings.proxy.port }
          : null
    };
  });

  // ---- local AI lab: pick a file and run cleanup ----
  ipcMain.handle('lab:pickFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地视频',
      properties: ['openFile'],
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv'] }]
    });
    if (res.canceled || !res.filePaths.length) return null;
    const p = res.filePaths[0];
    const st = fs.statSync(p);
    return { path: p, name: path.basename(p), size: st.size };
  });

  // 拖拽上传：渲染层拿到的只是 File 对象，路径由 preload 的 webUtils 还原后传入
  ipcMain.handle('lab:openPath', async (_e, input) => {
    if (!input || !fs.existsSync(input)) throw new Error('文件不存在或已被移动');
    const st = fs.statSync(input);
    if (!st.isFile()) throw new Error('不是有效的文件');
    const ext = path.extname(input).toLowerCase();
    if (!['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) {
      throw new Error('仅支持 MP4 / MOV / WEBM / MKV 格式');
    }
    return { path: input, name: path.basename(input), size: st.size };
  });

  ipcMain.handle('lab:process', async (event, payload) => {
    const { input, mode, cropPercent, box } = payload || {};
    if (!input || !fs.existsSync(input)) throw new Error('文件不存在');
    if (!ffmpeg.hasFfmpeg()) throw new Error('未检测到 FFmpeg，无法进行本地处理');
    const dir = store.get().downloadDir;
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(input).replace(/\.[^.]+$/, '');
    const out = path.join(dir, `${base} - clean.mp4`);
    await ffmpeg.cleanupWatermark(input, out, { mode: mode || 'crop', cropPercent: cropPercent || 6, box });
    return { output: out };
  });
}

app.whenReady().then(async () => {
  buildMenu();
  registerIpc();
  wireDownloader();
  await refreshSystemProxy(true);
  // keep the auto-detected system proxy fresh (e.g. the user toggles their VPN client)
  setInterval(() => refreshSystemProxy(true), 60000);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

module.exports = { downloader };