'use strict';

/* ============================================================
   TokPure — 我的声音（克隆声音档案库）

   用户上传的样本落盘成「一份参考音 + 一条索引」，之后每次视频翻译、
   试听都直接复用这份参考音，不需要重新上传。
   参考音在入库时就按原声克隆同一条链做预处理（去首尾静音 / 80Hz 高通 /
   9.5k 低通 / 两级 afftdn / 截 12 秒），所以「样本有多干净，成片就有多干净」。

   目录：<userData>/voices/<id>/ref.wav  +  index.json
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const ffmpegMod = require('./ffmpeg');
const sample = require('./voicesample');

/* 预处理链与原声克隆（localize.buildRefWav）保持一致：
   参考音里留多少房间底噪，克隆引擎就会把它复制进每一句，
   这是成片「背景噪音」最直接的来源。两级 afftdn 都是频域降噪，
   不做帧块平滑，不会给音色条件抹上一层「水声」。 */
const REF_CHAIN = [
  'silenceremove=start_periods=1:start_duration=0.15:start_threshold=-45dB:'
    + 'stop_periods=-1:stop_duration=0.3:stop_threshold=-45dB',
  'asetpts=PTS-STARTPTS',
  'highpass=f=80:poles=2',
  'lowpass=f=9500',
  'afftdn=nr=20:nf=-40:tn=1',
  'afftdn=nr=16:nf=-42:tn=1',
  `atrim=0:${sample.REF_MAX_SEC}`
].join(',');

const SAMPLE_EXTS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'mkv', 'webm'];

function root() {
  return path.join(app.getPath('userData'), 'voices');
}

function indexPath() {
  return path.join(root(), 'index.json');
}

function readIndex() {
  try {
    return sample.profilesFromIndex(JSON.parse(fs.readFileSync(indexPath(), 'utf8')));
  } catch (_) {
    return [];
  }
}

function writeIndex(list) {
  const dir = root();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `index-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: sample.profilesFromIndex(list) }, null, 2), 'utf8');
  fs.renameSync(tmp, indexPath());
}

function refPathOf(id) {
  if (!/^[a-z0-9][a-z0-9-]{3,39}$/i.test(String(id || ''))) return '';
  return path.join(root(), id, 'ref.wav');
}

/** 对外视图：补上绝对路径，丢掉内部字段 */
function view(p) {
  const base = path.join(root(), p.id);
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    duration: Number(p.duration.toFixed ? p.duration.toFixed(2) : p.duration),
    bytes: p.bytes,
    ratio: p.ratio,
    peaks: p.peaks,
    ref: refPathOf(p.id),
    sample: p.sample ? path.join(base, p.sample) : ''
  };
}

function list() {
  return readIndex()
    .filter((p) => {
      const f = refPathOf(p.id);
      try {
        return !!f && fs.existsSync(f) && fs.statSync(f).size > 2048;
      } catch (_) {
        return false;
      }
    })
    .map(view);
}

function get(id) {
  const p = readIndex().find((x) => x.id === String(id || ''));
  if (!p) throw new Error('这个声音已经不存在了，请重新上传声音样本');
  const f = refPathOf(p.id);
  if (!fs.existsSync(f)) throw new Error('声音样本文件丢失，请重新上传');
  return { ...view(p), absRef: f };
}

function remove(id) {
  const key = String(id || '');
  const rest = readIndex().filter((p) => p.id !== key);
  writeIndex(rest);
  try { fs.rmSync(path.join(root(), key), { recursive: true, force: true }); } catch (_) {}
  // 份数很少，顺手清掉没有索引的孤儿目录（中断的导入会留下半个目录）
  try {
    const alive = new Set(readIndex().map((p) => p.id));
    fs.readdirSync(root(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !alive.has(d.name))
      .forEach((d) => { try { fs.rmSync(path.join(root(), d.name), { recursive: true, force: true }); } catch (_) {} });
  } catch (_) {}
  return true;
}

function runFf(args) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegMod.getFfmpegPath();
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-6000); });
    child.stdout.on('data', () => {});
    child.on('error', (e) => reject(new Error(`FFmpeg 无法启动：${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg 退出码 ${code}\n${stderr.slice(-600)}`));
    });
  });
}

/** 解码成单声道 float32（样本最长 12 秒，直接进内存没有压力） */
function decodePcm(file, rate) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegMod.getFfmpegPath();
    const child = spawn(bin, [
      '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate || sample.MONO_RATE),
      '-f', 'f32le', 'pipe:1'
    ], { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error('声音样本解码失败')); return; }
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 4);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i += 1) pcm[i] = buf.readFloatLE(i * 4);
      resolve(pcm);
    });
  });
}

/**
 * 导入一份声音样本。
 * @param {{input:string, name?:string}} payload
 * @returns {Promise<object>} 新档案（已写入索引）
 */
async function ingest(payload = {}) {
  const input = String(payload.input || '');
  if (!input || !fs.existsSync(input)) throw new Error('声音样本文件不存在或已被移动');
  const st = fs.statSync(input);
  if (!st.isFile()) throw new Error('不是有效的音频文件');
  const ext = path.extname(input).toLowerCase().replace('.', '');
  if (!SAMPLE_EXTS.includes(ext)) {
    throw new Error('声音样本仅支持 WAV / MP3 / M4A / AAC / FLAC / OGG，也可以直接用一段视频');
  }
  const existing = readIndex();
  if (existing.length >= sample.MAX_PROFILES) {
    throw new Error(`最多保存 ${sample.MAX_PROFILES} 个声音，请先删除不用的声音再导入`);
  }

  const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(root(), id);
  fs.mkdirSync(dir, { recursive: true });
  const copied = `sample.${ext}`;
  const ref = path.join(dir, 'ref.wav');
  try {
    fs.copyFileSync(input, path.join(dir, copied));
    await runFf(['-y', '-i', path.join(dir, copied), '-vn', '-ac', '1', '-ar', String(sample.MONO_RATE),
      '-af', REF_CHAIN, '-c:a', 'pcm_s16le', ref]);
    let size = 0;
    try { size = fs.statSync(ref).size; } catch (_) { size = 0; }
    if (size < 4096) throw new Error('这个文件里没有可用的说话声，请换一段人声清晰的录音');
    const info = sample.readWavInfo(fs.readFileSync(ref));
    const pcm = await decodePcm(ref, sample.MONO_RATE);
    const stats = sample.speechStats(pcm, sample.MONO_RATE);
    const verdict = sample.judgeSample({
      duration: info ? info.duration : 0,
      ratio: stats.ratio,
      rmsDb: stats.rmsDb,
      activeSec: stats.activeSec
    });
    if (!verdict.ok) throw new Error(verdict.message);

    const name = sample.sanitizeName(payload.name, path.basename(input).replace(/\.\w+$/, ''));
    const profile = {
      id,
      name,
      createdAt: Date.now(),
      duration: info ? info.duration : stats.totalSec,
      bytes: st.size + size,
      ratio: stats.ratio,
      peaks: sample.peakBuckets(pcm, 64),
      ref: 'ref.wav',
      sample: copied
    };
    writeIndex([profile, ...existing].slice(0, sample.MAX_PROFILES));
    return { ...view(profile), note: verdict.message };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    throw e;
  }
}

function rename(id, name) {
  const next = sample.sanitizeName(name);
  const list0 = readIndex();
  const hit = list0.find((p) => p.id === String(id || ''));
  if (!hit) throw new Error('这个声音已经不存在了');
  writeIndex(list0.map((p) => (p.id === hit.id ? { ...p, name: next } : p)));
  return view({ ...hit, name: next });
}

module.exports = {
  SAMPLE_EXTS,
  root,
  list,
  get,
  ingest,
  rename,
  remove
};
