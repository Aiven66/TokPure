'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');

let cachedPath = null;
let prepared = null;   // ensure() 的 Promise（只跑一次）

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
// keep console windows from flashing when ffmpeg is spawned on Windows
const SPAWN_OPTS = isWin ? { windowsHide: true } : {};

/* 3.9.26：FFmpeg 不能只依赖「安装包内那一个绝对路径」。
   3.9.25 的真实现场：任务跑到 97%（渲染出片）时应用目录被新版本覆盖，
   进程里缓存着的 /Applications/TokPure.app/.../ffmpeg 已经不存在，
   spawn 直接 ENOENT —— 33 分钟的计算全废。所以：
   ① 首次运行时把安装包内的 ffmpeg 复制一份到 userData/ai/bin/ffmpeg，
      正在跑的任务从此不再依赖 app 目录（覆盖、移动、卸载都不影响）；
   ② getFfmpegPath() 每次调用都复核文件是否还在，缓存失效就重新解析；
   ③ 真的没了还能落到 ffmpeg-static / Homebrew / PATH。 */
function usable(p) {
  if (!p) return false;
  if (p === 'ffmpeg') return true; // 交给 PATH，能否运行由实际 spawn 决定
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 1000000;
  } catch (_) {
    return false;
  }
}

/* 稳定的自备副本：与安装包解耦，应用更新不会把它删掉 */
function stablePath() {
  try {
    return path.join(app.getPath('userData'), 'ai', 'bin', 'ffmpeg' + EXE);
  } catch (_) {
    return '';
  }
}

/* 安装包内自带的三个可能位置（extraResources 打进去的那份） */
function bundledPaths() {
  const list = [];
  try {
    const resRoot = process.resourcesPath || path.join(__dirname, '..', 'resources');
    list.push(path.join(resRoot, 'resources', 'bin', 'ffmpeg' + EXE));
    list.push(path.join(resRoot, 'bin', 'ffmpeg' + EXE));
    list.push(path.join(resRoot, 'ffmpeg' + EXE));
  } catch (_) {}
  return list;
}

function candidates() {
  const list = [];
  const st = stablePath();
  if (st) list.push(st);
  bundledPaths().forEach((p) => list.push(p));
  // ffmpeg-static package (dev / bundled dependency)
  try {
    const stat = require('ffmpeg-static');
    if (stat) list.push(stat);
  } catch (_) {}
  // common system locations
  if (isWin) {
    if (process.env.LOCALAPPDATA) {
      list.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'));
    }
    list.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  } else {
    list.push('/opt/homebrew/bin/ffmpeg');
    list.push('/usr/local/bin/ffmpeg');
    list.push('/usr/bin/ffmpeg');
  }
  return list;
}

function verifyPath(bin) {
  return new Promise((resolve) => {
    if (bin !== 'ffmpeg' && !usable(bin)) return resolve({ ok: false, path: bin });
    execFile(bin, ['-version'], { ...SPAWN_OPTS, timeout: 15000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, path: bin });
      const first = String(stdout).split('\n')[0];
      resolve({ ok: true, path: bin, version: first });
    });
  });
}

function getFfmpegPath() {
  // 复核缓存：文件被删/被覆盖时必须重新解析，不能把死路径继续交给 spawn
  if (cachedPath && usable(cachedPath)) return cachedPath;
  cachedPath = null;
  for (const p of candidates()) {
    if (usable(p)) {
      cachedPath = p;
      return p;
    }
  }
  cachedPath = 'ffmpeg'; // rely on PATH
  return cachedPath;
}

function hasFfmpeg() {
  const p = getFfmpegPath();
  return p !== null && (p === 'ffmpeg' ? true : usable(p));
}

async function verifyFfmpeg() {
  const bin = getFfmpegPath();
  const r = await verifyPath(bin);
  return r.ok ? r : { ok: false, path: bin };
}

/**
 * 启动 / 开跑前自检：确保有一个「能真正执行」的 ffmpeg，并尽量把它搬进 userData。
 * 返回 { ok, path, version, source }；ok=false 时上层应给出明确的中文提示，
 * 而不是让任务跑到最后一步才抛 spawn ENOENT。
 */
function ensure() {
  if (prepared) return prepared;
  prepared = (async () => {
    const st = stablePath();
    const bundled = bundledPaths().find((p) => usable(p)) || '';
    // 1) 已有稳定副本（上次已复制）→ 直接验证使用；安装包换了 ffmpeg（体积不同）才重拷
    if (st && usable(st)) {
      let stale = false;
      if (bundled) {
        try { stale = fs.statSync(bundled).size !== fs.statSync(st).size; } catch (_) { stale = false; }
      }
      if (!stale) {
        const v = await verifyPath(st);
        if (v.ok) { cachedPath = st; return { ...v, source: 'stable' }; }
      }
    }
    // 2) 从安装包内复制一份到 userData（先写 .tmp 再 rename，避免半截文件）
    if (bundled && st) {
      try {
        fs.mkdirSync(path.dirname(st), { recursive: true });
        const tmp = st + '.tmp';
        fs.copyFileSync(bundled, tmp);
        if (!isWin) fs.chmodSync(tmp, 0o755);
        fs.renameSync(tmp, st);
        const v = await verifyPath(st);
        if (v.ok) { cachedPath = st; return { ...v, source: 'copied' }; }
      } catch (_) {
        try { fs.unlinkSync(st + '.tmp'); } catch (__) {}
      }
    }
    // 3) 复制失败（磁盘只读/空间不足）→ 直接使用安装包内那份
    if (bundled) {
      const v = await verifyPath(bundled);
      if (v.ok) { cachedPath = bundled; return { ...v, source: 'bundled' }; }
    }
    // 4) 最后兜底：ffmpeg-static / Homebrew / PATH
    for (const p of candidates()) {
      const v = await verifyPath(p);
      if (v.ok) { cachedPath = p; return { ...v, source: 'fallback' }; }
    }
    cachedPath = 'ffmpeg';
    return { ok: false, path: 'ffmpeg', version: '', source: 'none' };
  })();
  return prepared;
}

/** 让下一次 getFfmpegPath() 重新解析（spawn ENOENT 后调用） */
function invalidate() {
  cachedPath = null;
  prepared = null;
}

/** 当前 ffmpeg 是否带某个编码器（结果缓存，避免每次渲染都探测） */
const encoderCache = new Map();
function hasEncoder(name) {
  if (encoderCache.has(name)) return Promise.resolve(encoderCache.get(name));
  const bin = getFfmpegPath();
  return new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-encoders'], SPAWN_OPTS, (err, stdout) => {
      // 硬件编码在 Mac 上可把竖版渲染从 5 分钟压到几十秒
      const ok = !err && String(stdout).includes(name);
      encoderCache.set(name, ok);
      resolve(ok);
    });
  });
}

function run(bin, args, onStderr, retried) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, SPAWN_OPTS);
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (onStderr) onStderr(d.toString());
    });
    child.on('error', (e) => {
      // 路径被覆盖/删除（应用更新）→ 重新解析一次，不让整条任务作废
      if (!retried && e && e.code === 'ENOENT') {
        invalidate();
        const nb = getFfmpegPath();
        if (nb && nb !== bin) {
          run(nb, args, onStderr, true).then(resolve, reject);
          return;
        }
      }
      reject(e);
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg 退出码 ${code}\n${stderr.slice(-800)}`));
    });
  });
}

async function extractAudio(input, output, { bitrate = '320k' } = {}) {
  const bin = getFfmpegPath();
  await run(bin, ['-y', '-i', input, '-vn', '-c:a', 'libmp3lame', '-b:a', bitrate, output]);
  return output;
}

/**
 * Local watermark cleanup fallback.
 * mode 'delogo': blur a fixed box region using ffmpeg delogo filter.
 * mode 'crop':   crop off a percentage from edges.
 */
async function cleanupWatermark(input, output, opts = {}) {
  const bin = getFfmpegPath();
  const { mode = 'delogo', box, cropPercent = 6 } = opts;
  let vf;
  if (mode === 'crop') {
    const p = Math.max(0, Math.min(20, Number(cropPercent) || 6)) / 100;
    // crop off the right + bottom margins where the TikTok logo typically sits
    vf = `crop=iw*(1-${p}):ih*(1-${p}):0:0`;
  } else {
    const b = box || { x: 20, y: 20, w: 240, h: 120 };
    vf = `delogo=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}`;
  }
  await run(bin, ['-y', '-i', input, '-vf', vf, '-c:a', 'copy', output]);
  return output;
}

async function remuxToMp4(input, output) {
  const bin = getFfmpegPath();
  await run(bin, ['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output]);
  return output;
}

/* 探测媒体文件里到底有没有音轨 / 视频轨。
   ffmpeg -i 无输出文件时必然以非 0 退出，流信息只在 stderr，所以这里单独解析。 */
function probe(file) {
  const bin = getFfmpegPath();
  return new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-i', file], SPAWN_OPTS, (err, stdout, stderr) => {
      const text = `${stderr || ''}${stdout || ''}`;
      const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve({
        hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(text),
        hasVideo: /Stream #\d+:\d+.*?: Video:/.test(text),
        duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0
      });
    });
  });
}

/* 把独立音轨并进无声视频，视频流直接 copy，不重编码。
   音轨统一转成 AAC：TikTok 的原声轨是 mp3，mp3-in-mp4 在 QuickTime / 预览里
   会「有音轨但播不出声」，必须转码成 AAC 才能被 macOS 原生播放器识别。 */
async function muxAudio(video, audio, output) {
  const bin = getFfmpegPath();
  await run(bin, [
    '-y', '-i', video, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    // 原声轨常比画面短几百毫秒到几秒，apad 补静音再 -shortest，避免画面尾部被截掉
    '-af', 'apad', '-movflags', '+faststart', '-shortest', output
  ]);
  return output;
}

module.exports = {
  getFfmpegPath,
  hasFfmpeg,
  verifyFfmpeg,
  ensure,
  invalidate,
  hasEncoder,
  extractAudio,
  cleanupWatermark,
  remuxToMp4,
  probe,
  muxAudio
};