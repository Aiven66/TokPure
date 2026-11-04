'use strict';

/* ============================================================
   TokPure — 声音样本纯逻辑（AI 视频翻译）

   只做「能不能拿来克隆」的判定与展示数据：
   - 有效语音时长 / 语音占比 / 整体电平 → judgeSample
   - 波形峰值（64 段）→ 页面上的声音卡片
   - WAV 头解析（参考音是我们自己转出来的 24k 单声道 PCM，不需要再起 ffmpeg）
   - 档案索引清洗

   这里刻意不 require electron / ffmpeg：test/unit.js 里直接 require 就能测。
   ============================================================ */

/** 克隆引擎读取参考音的采样率（worker.py 里 soundfile 直接读，24k 与训练一致） */
const MONO_RATE = 24000;
/** Chatterbox 只取参考音前 10 秒做说话人条件，截 12 秒留一点余量 */
const REF_MAX_SEC = 12;
/** 少于 4 秒根本无法建立音色条件，直接拒绝 */
const SAMPLE_MIN_SEC = 4;
/** 6 秒以下能出片，但音色会飘，给「建议重录」提示 */
const SAMPLE_GOOD_SEC = 6;
/** 档案上限：声音卡片太多反而选不出来 */
const MAX_PROFILES = 20;

/** 文件名 / 档案名清洗：路径分隔符、控制字符全部换空格，限 32 字 */
function sanitizeName(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  return s || String(fallback || '我的声音').slice(0, 32);
}

/** 解析 PCM WAV 头：返回采样率/声道/位深/数据长度（秒） */
function readWavInfo(buf) {
  if (!buf || buf.length < 32) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let dataSize = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: Math.max(1, buf.readUInt16LE(off + 10)),
        sampleRate: Math.max(1, buf.readUInt32LE(off + 12)),
        bits: Math.max(8, buf.readUInt16LE(off + 22) || 16)
      };
    } else if (id === 'data') {
      // 文件可能被截断：以真实剩余字节为准，避免算出一个虚长的时长
      dataSize = Math.min(size, Math.max(0, buf.length - off - 8));
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt) return null;
  const frameBytes = Math.max(1, (fmt.bits / 8) * fmt.channels);
  return { ...fmt, dataSize, duration: dataSize / frameBytes / fmt.sampleRate };
}

const toDb = (v) => {
  if (!(v > 0)) return -100;
  const db = 20 * Math.log10(v);
  return Number.isFinite(db) ? Math.max(-100, Math.min(0, db)) : -100;
};

/**
 * 逐 20ms 帧量语音占比。
 * 门限取「最响一帧」的 -20dB，并设 -48dBFS 绝对下限：纯底噪/电流声不会被算成说话。
 */
function speechStats(pcm, sampleRate) {
  const sr = Number(sampleRate) > 0 ? Number(sampleRate) : MONO_RATE;
  const total = pcm && pcm.length ? pcm.length : 0;
  const frame = Math.max(1, Math.round(sr * 0.02));
  const n = Math.floor(total / frame);
  if (!n) return { ratio: 0, rmsDb: -100, peakDb: -100, activeSec: 0, totalSec: 0 };
  const rms = new Float64Array(n);
  let all = 0;
  let maxRms = 0;
  for (let i = 0; i < n; i += 1) {
    const base = i * frame;
    let sum = 0;
    for (let k = 0; k < frame; k += 1) {
      const v = pcm[base + k];
      sum += v * v;
    }
    all += sum;
    const r = Math.sqrt(sum / frame);
    rms[i] = r;
    if (r > maxRms) maxRms = r;
  }
  const gate = Math.max(0.004, maxRms * 0.1);
  let active = 0;
  for (let i = 0; i < n; i += 1) if (rms[i] > gate) active += 1;
  return {
    ratio: active / n,
    rmsDb: toDb(Math.sqrt(all / (n * frame))),
    peakDb: toDb(maxRms),
    activeSec: (active * frame) / sr,
    totalSec: (n * frame) / sr
  };
}

/** 样本是否可用。ok=false 时 message 直接给用户看。 */
function judgeSample({ duration, ratio, rmsDb, activeSec } = {}) {
  const dur = Math.max(0, Number(duration) || 0);
  const speech = Math.max(0, Number(ratio) || 0);
  const db = Number.isFinite(Number(rmsDb)) ? Number(rmsDb) : -100;
  const active = Number.isFinite(Number(activeSec)) ? Number(activeSec) : dur * speech;
  if (dur <= 0.2 || active <= 0.2) {
    return { ok: false, level: 'error', message: '没有读到有效人声，请换一段有人说话的录音（8~15 秒最理想）' };
  }
  if (dur < SAMPLE_MIN_SEC) {
    return {
      ok: false,
      level: 'error',
      message: `有效语音只有 ${dur.toFixed(1)} 秒，至少需要 ${SAMPLE_MIN_SEC} 秒连续说话（推荐 8~15 秒）`
    };
  }
  if (speech < 0.2) {
    return { ok: false, level: 'error', message: '这段样本大部分是静音或音乐，请换一段连续说话的录音' };
  }
  if (db < -52) {
    return { ok: false, level: 'error', message: '样本音量太低，请靠近麦克风重录，或换一段更清晰的录音' };
  }
  if (dur < SAMPLE_GOOD_SEC) {
    return { ok: true, level: 'warn', message: `样本约 ${dur.toFixed(1)} 秒，建议 8 秒以上，音色会更像` };
  }
  return { ok: true, level: 'ok', message: `有效语音 ${dur.toFixed(1)} 秒，音色条件充足` };
}

/** 波形峰值（0~1，按全局最大值归一），供页面画条形波形 */
function peakBuckets(pcm, buckets) {
  const n = Math.max(8, Math.min(128, Math.round(Number(buckets) || 64)));
  const out = new Array(n).fill(0);
  const total = pcm && pcm.length ? pcm.length : 0;
  if (!total) return out;
  const size = Math.max(1, Math.ceil(total / n));
  let max = 0;
  for (let b = 0; b < n; b += 1) {
    const start = b * size;
    const end = Math.min(total, start + size);
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const v = Math.abs(pcm[i]);
      if (v > peak) peak = v;
    }
    out[b] = peak;
    if (peak > max) max = peak;
  }
  if (!max) return out;
  return out.map((v) => Math.round((Math.min(1, v / max)) * 100) / 100);
}

/** 索引文件可能被手工改坏 / 旧版本写少字段：全部归一化，坏条目直接丢 */
function profilesFromIndex(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.profiles) ? raw.profiles : []);
  const out = [];
  list.forEach((p) => {
    const id = String((p && p.id) || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{3,39}$/i.test(id)) return;
    const peaks = Array.isArray(p && p.peaks)
      ? p.peaks.slice(0, 128).map((v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100) / 100)
      : [];
    out.push({
      id,
      name: sanitizeName(p && p.name),
      createdAt: Math.max(0, Number((p && p.createdAt) || 0)),
      duration: Math.max(0, Number((p && p.duration) || 0)),
      bytes: Math.max(0, Number((p && p.bytes) || 0)),
      ratio: Math.max(0, Math.min(1, Number((p && p.ratio) || 0))),
      peaks,
      ref: 'ref.wav',
      sample: typeof (p && p.sample) === 'string' ? p.sample : ''
    });
  });
  return out.slice(0, MAX_PROFILES);
}

module.exports = {
  MONO_RATE,
  REF_MAX_SEC,
  SAMPLE_MIN_SEC,
  SAMPLE_GOOD_SEC,
  MAX_PROFILES,
  sanitizeName,
  readWavInfo,
  speechStats,
  judgeSample,
  peakBuckets,
  profilesFromIndex
};
