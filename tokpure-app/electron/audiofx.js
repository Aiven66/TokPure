'use strict';

/* ============================================================
   成片音效：片头 whoosh + 花字弹出 pop，与素材原声/BGM 混成一条音轨。
   全部为内置 PCM 合成（与 resources/audio 下素材同一算法），无版权风险。
   ============================================================ */

const fs = require('fs');
const path = require('path');

const SR = 44100;
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const TAU = Math.PI * 2;

function writeWav(file, bufL, bufR) {
  const n = bufL.length;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.max(-1, Math.min(1, bufL[i])) * 32767 | 0, 44 + i * 4);
    b.writeInt16LE(Math.max(-1, Math.min(1, bufR[i])) * 32767 | 0, 46 + i * 4);
  }
  fs.writeFileSync(file, b);
}

/** 0.45s whoosh（带通噪声上扫），写入 (L,R,i0,dur,g,pan) 缓冲 */
function addWhoosh(L, R, t0, gain) {
  const dur = 0.45;
  const i0 = Math.round(t0 * SR);
  let lp = 0, bp = 0;
  for (let i = 0; i < dur * SR; i++) {
    const idx = i0 + i;
    if (idx < 0 || idx >= L.length) continue;
    const t = i / SR;
    const cut = 500 + 5200 * (t / dur) ** 2;
    const f = Math.min(0.49, cut / SR);
    const x = rnd() * 2 - 1;
    lp += f * bp;
    const hp = x - lp - 0.3 * bp;
    bp += f * hp;
    const env = Math.sin(Math.PI * t / dur) ** 1.6;
    const v = bp * env * 2.2 * gain;
    const tilt = 0.5 + 0.5 * t / dur;
    L[idx] += v * (1 - tilt * 0.4);
    R[idx] += v * (0.6 + tilt * 0.4);
  }
}

/** 0.2s pop（上扬叮咚 + 起音 tick） */
function addPop(L, R, t0, gain) {
  const dur = 0.2;
  const i0 = Math.round(t0 * SR);
  for (let i = 0; i < dur * SR; i++) {
    const idx = i0 + i;
    if (idx < 0 || idx >= L.length) continue;
    const t = i / SR;
    const f = 720 + 560 * (1 - Math.exp(-t * 22));
    const e = Math.exp(-t * 13);
    const tick = i < SR * 0.012 ? (rnd() * 2 - 1) * (1 - i / (SR * 0.012)) * 0.5 : 0;
    const v = ((Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * f * 2 * t)) * e * 0.55 + tick) * gain;
    L[idx] += v;
    R[idx] += v;
  }
}

/**
 * 生成一条与成片等长的音效轨：
 *   events: [{ t: 秒, type: 'whoosh' | 'pop' }]
 * 开头自动有轻 whoosh（除非 opts.intro=false）。
 */
function buildSfxTrack(durationSec, events, outFile, opts = {}) {
  const n = Math.max(1, Math.round(durationSec * SR));
  const L = new Float64Array(n), R = new Float64Array(n);
  if (opts.intro !== false) addWhoosh(L, R, 0.02, 0.5);
  (events || []).forEach((e) => {
    const t = Math.max(0, Number(e.t) || 0);
    if (e.type === 'whoosh') addWhoosh(L, R, t, 0.45);
    else addPop(L, R, t, 0.7);
  });
  // 结尾 0.25s 淡出防爆音
  const fo = Math.round(0.25 * SR);
  for (let i = Math.max(0, n - fo); i < n; i++) {
    const g = (n - i) / fo;
    L[i] *= g; R[i] *= g;
  }
  writeWav(outFile, L, R);
  return outFile;
}

/** resources/audio 解析：打包后在 process.resourcesPath/resources/audio */
function audioDir() {
  const roots = [];
  try {
    if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'resources', 'audio'));
  } catch (_) {}
  roots.push(path.join(__dirname, '..', 'resources', 'audio'));
  for (const d of roots) {
    try { if (fs.existsSync(path.join(d, 'bgm-bed.wav'))) return d; } catch (_) {}
  }
  return roots[roots.length - 1];
}
function audioAsset(name) {
  return path.join(audioDir(), name);
}

module.exports = { buildSfxTrack, audioAsset, audioDir };
