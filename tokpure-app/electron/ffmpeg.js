'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');

let cachedPath = null;

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
// keep console windows from flashing when ffmpeg is spawned on Windows
const SPAWN_OPTS = isWin ? { windowsHide: true } : {};

function candidates() {
  const list = [];
  // 1. bundled into app resources (resources/bin/ffmpeg[.exe])
  try {
    const resRoot = process.resourcesPath || path.join(__dirname, '..', 'resources');
    list.push(path.join(resRoot, 'resources', 'bin', 'ffmpeg' + EXE));
    list.push(path.join(resRoot, 'bin', 'ffmpeg' + EXE));
    list.push(path.join(resRoot, 'ffmpeg' + EXE));
  } catch (_) {}
  // 2. ffmpeg-static package (dev / bundled dependency)
  try {
    const stat = require('ffmpeg-static');
    if (stat) list.push(stat);
  } catch (_) {}
  // 3. common system locations
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

function getFfmpegPath() {
  if (cachedPath) return cachedPath;
  for (const p of candidates()) {
    try {
      if (p && fs.existsSync(p)) {
        cachedPath = p;
        return p;
      }
    } catch (_) {}
  }
  cachedPath = 'ffmpeg'; // rely on PATH
  return cachedPath;
}

function hasFfmpeg() {
  const p = getFfmpegPath();
  return p !== null && (p === 'ffmpeg' ? true : fs.existsSync(p));
}

async function verifyFfmpeg() {
  const bin = getFfmpegPath();
  return new Promise((resolve) => {
    execFile(bin, ['-version'], SPAWN_OPTS, (err, stdout) => {
      if (err) return resolve({ ok: false, path: bin });
      const first = String(stdout).split('\n')[0];
      resolve({ ok: true, path: bin, version: first });
    });
  });
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

function run(bin, args, onStderr) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, SPAWN_OPTS);
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (onStderr) onStderr(d.toString());
    });
    child.on('error', reject);
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
  hasEncoder,
  extractAudio,
  cleanupWatermark,
  remuxToMp4,
  probe,
  muxAudio
};