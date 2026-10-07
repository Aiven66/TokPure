'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('tokpure', {
  auth: {
    getSession: () => invoke('auth:getSession'),
    // 打开系统浏览器完成登录；用户在网页登录成功后 Promise 才 resolve
    login: () => invoke('auth:login'),
    logout: () => invoke('auth:logout'),
    openWeb: (target) => invoke('auth:openWeb', target),
    onChanged: (cb) => ipcRenderer.on('auth:changed', (_e, s) => cb(s))
  },
  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
    reset: () => invoke('settings:reset'),
    chooseDir: () => invoke('settings:chooseDir')
  },
  tiktok: {
    parse: (url) => invoke('tik:parse', url)
  },
  downloads: {
    add: (url, opts) => invoke('dl:add', url, opts),
    list: () => invoke('dl:list'),
    stats: () => invoke('dl:stats'),
    pause: () => invoke('dl:pause'),
    resume: () => invoke('dl:resume'),
    cancel: (id) => invoke('dl:cancel', id),
    retry: (id) => invoke('dl:retry', id),
    remove: (id) => invoke('dl:remove', id),
    clearCompleted: () => invoke('dl:clearCompleted'),
    setConcurrency: (n) => invoke('dl:setConcurrency', n),
    onUpdate: (cb) => ipcRenderer.on('dl:update', (_e, t) => cb(t)),
    onAdd: (cb) => ipcRenderer.on('dl:add', (_e, t) => cb(t)),
    onRemove: (cb) => ipcRenderer.on('dl:remove', (_e, id) => cb(id)),
    onPaused: (cb) => ipcRenderer.on('dl:paused', (_e, p) => cb(p))
  },
  fs: {
    reveal: (p) => invoke('fs:reveal', p),
    openPath: (p) => invoke('fs:openPath', p),
    openFolder: () => invoke('fs:openFolder'),
    library: () => invoke('fs:library'),
    delete: (p) => invoke('fs:delete', p),
    // Electron >=32 移除了 File.path，拖拽文件需经 webUtils 还原绝对路径
    pathForFile: (file) => {
      try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
    }
  },
  clipboard: {
    read: () => invoke('clip:read')
  },
  win: {
    minimize: () => invoke('win:minimize'),
    maximize: () => invoke('win:maximize'),
    close: () => invoke('win:close')
  },
  system: {
    ffmpeg: () => invoke('ffmpeg:status'),
    appInfo: () => invoke('app:info'),
    netTest: () => invoke('net:test'),
    netDetect: () => invoke('net:detect')
  },
  lab: {
    pickFile: () => invoke('lab:pickFile'),
    openPath: (p) => invoke('lab:openPath', p),
    process: (payload) => invoke('lab:process', payload)
  }
});