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

module.exports = {
  getFfmpegPath,
  hasFfmpeg,
  verifyFfmpeg,
  extractAudio,
  cleanupWatermark,
  remuxToMp4
};