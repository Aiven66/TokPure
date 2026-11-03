'use strict';

/* ============================================================
   TokPure — 克隆配音「噪声帧静音」滤波器（3.9.24）
   ------------------------------------------------------------
   背景：本地克隆引擎（Chatterbox）在词与词之间、句尾会输出宽带噪声。
   实测（b1.wav，44.1kHz 单声道）：
     句尾 3.84s→4.36s 全程噪声，RMS -40dBFS、峰值 -30dBFS；
     词间 50~90ms 的气口也是同类噪声，RMS -28~-45dBFS；
     语音本体 -18~-22dBFS。
   成片按句归一到 -18 LUFS（+8~+12dB）之后，这些噪声被抬到 -20~-32dBFS，
   而旧链的噪声门阈值封顶 -50dBFS、只看电平 —— 噪声甚至比轻声说话还响，
   电平上根本分不开，于是短气口一路漏进成片（就是用户听到的「背景噪音」）。
   3.9.24 起改为在「每句合成完、进清洁链之前」做逐帧判别，判据是三条：
     1) 电平 < 本句语音电平（帧 RMS 的 95% 分位）- 7dB，且 < -20dBFS；
     2) 周期性 < 0.30（归一化自相关在 60~700Hz 内的峰值）——语音有基频周期，
        噪声/擦音没有；这一条把「轻声但仍是人声」的帧保下来；
     3) 3k~10kHz 相对 100~1500Hz 的占比 < +10dB —— 擦音（s/sh）是高频占优的
        宽带信号，超过这条的更可能是齿音，不动它。
   命中帧连成 ≥35ms 的段之后，用 11.6ms 线性斜坡把整段拉到数字静音；
   另外从句尾「最后一个有声帧 + 0.15s」一直静音到文件末尾，彻底清掉句尾噪声尾。
   噪声段本来就落在词间气口/句尾，人声帧（周期性高）一个采样都不动。
   实测（本轮 16 句真实克隆输出 + 原片真人 + 合成白噪）：
     被静音的段全是 3k~10k 几乎没有能量、谱峰在 100~130Hz 的低频闷响（克隆引擎的
     词间/句尾噪声本相），语音段电平一字不变（未静音帧电平差中位 0.00dB）；
     原片真人 9 段噪性连续段（2.16s）→ 0 段；白噪 + 谐波合成的测试音，噪声段全部
     落到数字静音、谐波电平 -19.8dBFS 不动。

   纯 JS 自实现 FFT/IFFT，不引第三方 DSP，不使用 anlmdn。
   ============================================================ */

const FRAME = 1024;        // 23.2ms @44.1kHz
const HOP = 512;           // 11.6ms 帧移，同时也是斜坡长度
const NFFT = 2048;         // 自相关需要的滞后范围（60Hz ≈ 735 采样）
const REL_DB = 7;          // 电平必须低于本句语音电平 7dB
const QUIET_CAP_DB = -20;  // 绝对电平上限
const PER_MAX = 0.3;       // 周期性上限（低于此判为非谐音）
const HI_MAX_DB = 10;      // 3k~10k / 100~1500 占比上限（齿音保护）
const MIN_RUN_HOPS = 3;    // 少于 35ms 的连续段不动

/** 迭代基-2 FFT（原地）。inverse=true 时做逆变换（不做 1/N 归一化）。 */
function makeFft(n) {
  const levels = Math.round(Math.log2(n));
  if ((1 << levels) !== n) throw new Error('FFT 尺寸必须是 2 的幂');
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    let x = i;
    let r = 0;
    for (let j = 0; j < levels; j += 1) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  return { n, cos, sin, rev };
}

function fftRun(f, re, im) {
  const { n, cos, sin, rev } = f;
  for (let i = 0; i < n; i += 1) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j += 1, k += step) {
        const c = cos[k];
        const s = sin[k];
        const a = i + j;
        const b = a + half;
        const xr = re[b];
        const xi = im[b];
        const tr = xr * c + xi * s;
        const ti = xi * c - xr * s;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** 实对称功率谱 → 自相关（r[k] = sum x[n]x[n+k]，未归一化） */
function autocorr(power, f) {
  const n = f.n;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re[0] = power[0];
  re[n / 2] = power[n / 2];
  for (let k = 1; k < n / 2; k += 1) {
    re[k] = power[k];
    re[n - k] = power[k];
  }
  fftRun(f, re, im);
  for (let k = 0; k < n; k += 1) re[k] /= n;
  return re;
}

/**
 * 分析一段 PCM（Float32，-1~1，单声道）：
 * 返回需要静音的采样跨度、句尾起点与判据统计。
 */
function findNoiseSpans(pcm, rate, opts = {}) {
  const n = pcm.length;
  const empty = { spans: [], tailFrom: n, speechRef: 0, noiseFrames: 0, frames: 0, mutedSec: 0 };
  if (n < FRAME * 4) return empty;
  const relDb = opts.relDb != null ? opts.relDb : REL_DB;
  const perMax = opts.perMax != null ? opts.perMax : PER_MAX;
  const hiMax = opts.hiMaxDb != null ? opts.hiMaxDb : HI_MAX_DB;
  const capDb = opts.quietCapDb != null ? opts.quietCapDb : QUIET_CAP_DB;
  const minRun = Math.max(1, opts.minRunHops || MIN_RUN_HOPS);
  const frames = Math.floor((n - FRAME) / HOP) + 1;
  // 第一遍：只算帧电平（便宜），据此定「本句语音电平」与电平门限
  const lv = new Float64Array(frames);
  for (let k = 0; k < frames; k += 1) {
    const s = k * HOP;
    let e = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const v = pcm[s + i];
      e += v * v;
    }
    lv[k] = 10 * Math.log10(e / FRAME + 1e-30);
  }
  const sorted = Array.prototype.slice.call(lv).sort((a, b) => a - b);
  // 本句语音电平取 95% 分位：一句里通常大部分帧都是语音（词间气口只占两三成），
  // 85% 分位会落在「语音的轻声段」，遇上 r12 这种前面很响、后面很轻的句子，
  // 门限会被压到 -36dB，-26dB 的气口噪声就漏过去了。95% 分位稳定落在响亮语音上。
  const speechRef = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
  const thr = Math.min(speechRef - relDb, capDb);
  // 第二遍：只对「低于门限」的帧做谱分析（约占两成帧，开销可控）
  const f = makeFft(NFFT);
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const binHz = rate / NFFT;
  const lo0 = Math.max(1, Math.floor(100 / binHz));
  const lo1 = Math.floor(1500 / binHz);
  const hi0 = Math.max(lo0 + 1, Math.floor(3000 / binHz));
  const hi1 = Math.min(NFFT / 2, Math.ceil(10000 / binHz));
  const lagLo = Math.max(2, Math.floor(rate / 700));
  const lagHi = Math.min(NFFT / 2 - 1, Math.ceil(rate / 60));
  const per = new Float64Array(frames);
  const low = new Float64Array(frames);
  for (let k = 0; k < frames; k += 1) {
    if (lv[k] >= thr) continue; // 电平够高，必然是语音，不用再分析
    const s = k * HOP;
    for (let i = 0; i < NFFT; i += 1) {
      re[i] = i < FRAME ? pcm[s + i] * win[i] : 0;
      im[i] = 0;
    }
    fftRun(f, re, im);
    const power = new Float64Array(NFFT / 2 + 1);
    let loSum = 0;
    let hiSum = 0;
    for (let b = 0; b <= NFFT / 2; b += 1) {
      const p = re[b] * re[b] + im[b] * im[b];
      power[b] = p;
      if (b >= lo0 && b <= lo1) loSum += p;
      else if (b >= hi0 && b <= hi1) hiSum += p;
    }
    const r = autocorr(power, f);
    let peak = 0;
    for (let t = lagLo; t <= lagHi; t += 1) if (r[t] > peak) peak = r[t];
    per[k] = r[0] > 1e-12 ? peak / r[0] : 0;
    low[k] = loSum > 1e-20 ? 10 * Math.log10(hiSum / loSum + 1e-20) : 0;
  }
  // 逐帧判定：电平低 + 非谐音 + 不是齿音
  const hit = new Uint8Array(frames);
  let noiseFrames = 0;
  for (let k = 0; k < frames; k += 1) {
    if (lv[k] >= thr) continue;
    if (per[k] < perMax && low[k] < hiMax) {
      hit[k] = 1;
      noiseFrames += 1;
    }
  }
  // 单帧空洞填平（噪声段被一个瞬态切开时不要留缝），再丢掉过短的段
  for (let k = 1; k < frames - 1; k += 1) {
    if (!hit[k] && hit[k - 1] && hit[k + 1]) hit[k] = 1;
  }
  let k = 0;
  while (k < frames) {
    if (hit[k]) {
      let j = k;
      while (j < frames && hit[j]) j += 1;
      if (j - k < minRun) for (let x = k; x < j; x += 1) hit[x] = 0;
      k = j;
    } else {
      k += 1;
    }
  }
  // 句尾静音起点：最后一个「还有明确人声」的帧之后 0.15s。
  // 判据用 5 帧（58ms）中值平滑后的电平（本句语音电平 -14dB 以内）：
  // 句尾噪声尾实测比语音低 18~28dB，一定落在门限之下；而收尾的轻声/齿音
  // 通常只低 8~13dB，不会被误切。用中值而不是均值，是因为噪声尾里有 -30dB
  // 的尖峰，逐帧判会把切点一路推到最后一声爆音上（那样句尾噪声就清不掉了）。
  const smooth = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const vals = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(frames - 1, i + 2); j += 1) vals.push(lv[j]);
    vals.sort((a, b) => a - b);
    smooth[i] = vals[Math.floor(vals.length / 2)];
  }
  let endFrame = -1;
  for (let i = frames - 1; i >= 0; i -= 1) {
    if (smooth[i] >= speechRef - 14) {
      endFrame = i;
      break;
    }
  }
  const tailFrom = endFrame < 0
    ? n
    : Math.min(n, endFrame * HOP + FRAME + Math.round(0.15 * rate));
  const spans = [];
  k = 0;
  while (k < frames) {
    if (hit[k]) {
      let j = k;
      while (j < frames && hit[j]) j += 1;
      // 帧中心对齐到 hop 网格，两侧各多让一个 hop，让 11.6ms 斜坡落在噪声段外侧
      const c0 = k * HOP + FRAME / 2;
      const c1 = (j - 1) * HOP + FRAME / 2;
      spans.push([Math.max(0, c0 - HOP), Math.min(n, c1 + HOP)]);
      k = j;
    } else {
      k += 1;
    }
  }
  if (tailFrom < n) {
    // 与最后一段噪声合并（或补一段），保证句尾一路静音到文件末尾
    const last = spans.length ? spans[spans.length - 1] : null;
    if (last && tailFrom <= last[1] + HOP) last[1] = n;
    else spans.push([tailFrom, n]);
  }
  return { spans, tailFrom, speechRef, noiseFrames, frames, thr };
}

/**
 * 对克隆配音做「噪声帧静音」：返回新的 PCM（原 PCM 不变）与统计。
 * @param {Float32Array} pcm 单声道 -1~1
 * @param {number} rate 采样率
 */
function suppressNoise(pcm, rate, opts = {}) {
  const info = findNoiseSpans(pcm, rate, opts);
  const { spans, tailFrom, speechRef, noiseFrames, frames } = info;
  const n = pcm.length;
  const out = new Float32Array(pcm);
  if (!spans.length) {
    return { pcm: out, spans: 0, mutedSec: 0, tailSec: 0, speechRef, noiseFrames, frames };
  }
  // 每个 hop 的目标增益：噪声段 0，其余 1；采样时在相邻 hop 之间线性插值，
  // 于是每段噪声的进/出各是一条 11.6ms 的斜坡（不会有硬关硬开的「咔哒」）。
  const hops = Math.ceil(n / HOP) + 2;
  const g = new Float32Array(hops).fill(1);
  spans.forEach(([a, b]) => {
    const i0 = Math.floor(a / HOP);
    const i1 = Math.min(hops - 1, Math.ceil(b / HOP));
    for (let i = i0; i <= i1; i += 1) g[i] = 0;
  });
  for (let i = 0; i < n; i += 1) {
    const p = i / HOP;
    const k0 = Math.floor(p);
    const frac = p - k0;
    const gain = g[k0] * (1 - frac) + g[Math.min(hops - 1, k0 + 1)] * frac;
    if (gain !== 1) out[i] = pcm[i] * gain;
  }
  let muted = 0;
  for (let i = 1; i < hops; i += 1) if (g[i] === 0) muted += 1;
  return {
    pcm: out,
    spans: spans.length,
    mutedSec: (muted * HOP) / rate,
    tailSec: Math.max(0, (n - tailFrom) / rate),
    speechRef,
    noiseFrames,
    frames
  };
}

/** 写 16bit 单声道 WAV（克隆音只有这一种落盘格式） */
function writeWavS16(file, pcm, rate) {
  const fs = require('fs');
  const n = pcm.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const v = pcm[i];
    const s = v > 1 ? 32767 : v < -1 ? -32768 : Math.round(v * 32767);
    buf.writeInt16LE(s, 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return file;
}

module.exports = { findNoiseSpans, suppressNoise, writeWavS16, FRAME, HOP };
