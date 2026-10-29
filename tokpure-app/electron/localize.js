'use strict';

/* ============================================================
   TokPure — AI多语切片（长片多语译制）
   长视频链接 / 本地文件 → 本地语音识别 → 本地大模型翻译
   → 系统离线 TTS 配音（可复刻原片说话人的音高与音色）
   → 9:16 竖版渲染 + 烧录字幕。
   一次输出多种语言短视频，全链路不上传任何音视频。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { app, dialog, shell } = require('electron');
const ffmpegMod = require('./ffmpeg');
const hub = require('./enginehub');
const store = require('./store');
const net = require('./net');
const aijobs = require('./aijobs');
const voiceclone = require('./voiceclone');
const voicelocal = require('./voicelocal');
const audiosep = require('./audiosep');

const isWin = process.platform === 'win32';
const OUT_ROOT = 'TokPure-AI多语切片';
const TTS_RATE = 188;
const CANVAS_W = 1080;
const CANVAS_H = 1920;

const LANGS = [
  { id: 'zh', name: '简体中文', say: 'zh_CN', win: 'zh', zhName: '简体中文', sample: '谢谢大家。' },
  { id: 'en', name: 'English', say: 'en_US', win: 'en', zhName: '英语', sample: 'Thank you all.' },
  { id: 'ja', name: '日本語', say: 'ja_JP', win: 'ja', zhName: '日语', sample: 'みなさん、ありがとうございます。' },
  { id: 'ko', name: '한국어', say: 'ko_KR', win: 'ko', zhName: '韩语', sample: '여러분, 감사합니다.' },
  { id: 'es', name: 'Español', say: 'es_ES', win: 'es', zhName: '西班牙语', sample: 'Gracias a todos.' },
  { id: 'pt', name: 'Português', say: 'pt_BR', win: 'pt', zhName: '葡萄牙语', sample: 'Obrigado a todos.' },
  { id: 'fr', name: 'Français', say: 'fr_FR', win: 'fr', zhName: '法语', sample: 'Merci à tous.' },
  { id: 'de', name: 'Deutsch', say: 'de_DE', win: 'de', zhName: '德语', sample: 'Danke an alle.' }
];

/* ---------------- 音色目录 ----------------
   每台 Mac 安装的系统音色并不相同，所以全部在运行时枚举 `say -v ?`，
   再用下面的元数据标注性别与听感，只把好听、可用的音色暴露给用户。
   macOS 26 的 Eddy / Flo / Reed / Rocko / Sandy / Shelley 是新一代自然音色，
   听感明显优于老式 MacinTalk（Albert / Fred / Ralph 一类已列入黑名单）。 */
const VOICE_META = {
  Flo: { gender: 'f', style: '自然女声', tier: 0 },
  Sandy: { gender: 'f', style: '清亮女声', tier: 0 },
  Shelley: { gender: 'f', style: '柔和女声', tier: 0 },
  Eddy: { gender: 'm', style: '自然男声', tier: 0 },
  Reed: { gender: 'm', style: '沉稳男声', tier: 0 },
  Rocko: { gender: 'm', style: '浑厚男声', tier: 0 },
  Ava: { gender: 'f', style: '美式女声', tier: 0 },
  Grandma: { gender: 'f', style: '长辈女声', tier: 1 },
  Grandpa: { gender: 'm', style: '长辈男声', tier: 1 },
  Samantha: { gender: 'f', style: '经典女声', tier: 1 },
  Allison: { gender: 'f', style: '经典女声', tier: 1 },
  Karen: { gender: 'f', style: '澳式女声', tier: 1 },
  Daniel: { gender: 'm', style: '英式男声', tier: 1 },
  Tingting: { gender: 'f', style: '标准女声', tier: 1 },
  Meijia: { gender: 'f', style: '台湾女声', tier: 1 },
  Sinji: { gender: 'f', style: '粤语女声', tier: 1 },
  Kyoko: { gender: 'f', style: '日语女声', tier: 1 },
  Otoya: { gender: 'm', style: '日语男声', tier: 1 },
  Yuna: { gender: 'f', style: '韩语女声', tier: 1 },
  'Mónica': { gender: 'f', style: '西语女声', tier: 1 },
  Monica: { gender: 'f', style: '西语女声', tier: 1 },
  Paulina: { gender: 'f', style: '西语女声', tier: 1 },
  Jorge: { gender: 'm', style: '西语男声', tier: 1 },
  Diego: { gender: 'm', style: '西语男声', tier: 1 },
  Luciana: { gender: 'f', style: '葡语女声', tier: 1 },
  Joana: { gender: 'f', style: '葡语女声', tier: 1 },
  Felipe: { gender: 'm', style: '葡语男声', tier: 1 },
  'Amélie': { gender: 'f', style: '法语女声', tier: 1 },
  Amelie: { gender: 'f', style: '法语女声', tier: 1 },
  Audrey: { gender: 'f', style: '法语女声', tier: 1 },
  Thomas: { gender: 'm', style: '法语男声', tier: 1 },
  Jacques: { gender: 'm', style: '法语男声', tier: 1 },
  Anna: { gender: 'f', style: '德语女声', tier: 1 },
  Helena: { gender: 'f', style: '德语女声', tier: 1 },
  Markus: { gender: 'm', style: '德语男声', tier: 1 }
};

/* 排序用：同一档位内按这个顺序展示（数值越小越靠前） */
const VOICE_ORDER = [
  'Flo', 'Sandy', 'Shelley', 'Eddy', 'Reed', 'Rocko',
  'Ava', 'Tingting', 'Meijia', 'Kyoko', 'Yuna', 'Mónica', 'Monica',
  'Luciana', 'Amélie', 'Amelie', 'Anna', 'Samantha', 'Allison',
  'Daniel', 'Karen', 'Thomas', 'Jacques', 'Audrey', 'Jorge', 'Diego',
  'Felipe', 'Joana', 'Otoya', 'Grandma', 'Grandpa', 'Helena', 'Markus', 'Sinji'
];

/* 卡通/机器人/低质 MacinTalk 音色，不进候选 */
const VOICE_DENY = new Set([
  'Albert', 'Fred', 'Ralph', 'Kathy', 'Bad News', 'Good News', 'Bahh', 'Bells',
  'Boing', 'Bubbles', 'Cellos', 'Jester', 'Junior', 'Organ', 'Superstar',
  'Trinoids', 'Whisper', 'Wobble', 'Zarvox'
]);

/* 每种目标语言允许的系统音色区域（避免用粤语音色读普通话等） */
const LANG_LOCALES = {
  zh: ['zh_CN'],
  en: ['en_US', 'en_GB', 'en_AU'],
  ja: ['ja_JP'],
  ko: ['ko_KR'],
  es: ['es_ES', 'es_MX'],
  pt: ['pt_BR', 'pt_PT'],
  fr: ['fr_FR', 'fr_CA'],
  de: ['de_DE']
};

/* 区域优先级：同一音色有多个口音时，优先列表里靠前的区域 */
const LOCALE_RANK = {
  en_US: 0, en_GB: 1, en_AU: 2,
  es_ES: 0, es_MX: 1,
  pt_BR: 0, pt_PT: 1,
  fr_FR: 0, fr_CA: 1
};

/* 试听例句 */
const VOICE_SAMPLE = {
  zh: '大家好，这是你成片里的配音效果，喜欢吗？',
  en: 'Hi everyone, this is how your clip will sound.',
  ja: 'みなさん、こんにちは。これは完成した音声のサンプルです。',
  ko: '안녕하세요. 완성된 음성 샘플입니다.',
  es: 'Hola a todos, así sonará tu voz en este idioma.',
  pt: 'Olá a todos, é assim que sua voz vai soar.',
  fr: 'Bonjour à tous, voici la voix de votre vidéo.',
  de: 'Hallo zusammen, so klingt die Stimme im fertigen Video.'
};

const baseVoice = (name) => String(name || '').split(' (')[0].trim();

function voiceInfo(name) {
  const meta = VOICE_META[baseVoice(name)];
  if (meta) return meta;
  return { gender: '', style: '系统音色', tier: 2 };
}


let activeJob = null;

const langById = (id) => LANGS.find((l) => l.id === id) || null;
const threads = () => Math.max(2, Math.min(8, (os.cpus() || []).length - 2 || 4));

function checkCanceled() {
  if (activeJob && activeJob.canceled) throw new Error('已取消');
}

/* ---------------- 子进程 ---------------- */
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      windowsHide: true
    });
    if (activeJob) {
      // 渲染与配音会并行跑多个子进程，取消时必须全部杀掉，只记一个会漏掉正在渲染的 ffmpeg
      activeJob.child = child;
      if (activeJob.children) activeJob.children.add(child);
    }
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (opts.timeout) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        reject(new Error(opts.timeoutMsg || '处理超时，已自动终止'));
      }, opts.timeout);
    }
    child.stdout.on('data', (c) => {
      const s = c.toString();
      stdout += s;
      if (opts.onStdout) opts.onStdout(s);
    });
    child.stderr.on('data', (c) => {
      const s = c.toString();
      stderr += s;
      if (stderr.length > 400000) stderr = stderr.slice(-200000);
      if (opts.onLine) s.split(/\r|\n/).forEach((l) => { if (l.trim()) opts.onLine(l); });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (activeJob && activeJob.child === child) activeJob.child = null;
      if (activeJob && activeJob.children) activeJob.children.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`进程退出码 ${code}\n${stderr.slice(-600)}`));
    });
  });
}

const runFf = (args, onLine, cwd) => run(ffmpegMod.getFfmpegPath(), args, { onLine, cwd });

/* ---------------- 媒体探测 ---------------- */
async function probe(input) {
  let text = '';
  try {
    await runFf(['-hide_banner', '-i', input], (line) => { text += line + '\n'; });
  } catch (_) { /* 无输出文件时 ffmpeg 必然非 0 退出，信息在 stderr */ }
  const durM = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : 0;
  return { duration, hasAudio: /Audio:/.test(text) };
}

function srtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const ms = Math.round(sec * 1000);
  const p = (x, l = 2) => String(x).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

function buildSrt(segments) {
  return segments
    .map((seg, i) => `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text.trim()}\n`)
    .join('\n');
}

function parseTimestamp(ts) {
  const m = String(ts).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
}

function parseWhisperJson(jsonPath) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return (Array.isArray(data.transcription) ? data.transcription : [])
    .map((r) => ({
      start: parseTimestamp(r.timestamps && r.timestamps.from),
      end: parseTimestamp(r.timestamps && r.timestamps.to),
      text: String(r.text || '').trim()
    }))
    .filter((s) => s.text && s.end > s.start);
}

/* ---------------- 引擎 / 模型 ---------------- */
function pickWhisperModel() {
  return ['whisper-turbo', 'whisper-small', 'whisper-base', 'whisper-tiny']
    .map((id) => ({ id, file: hub.modelPath(id) }))
    .find((m) => m.file) || null;
}

function ytdlpPath() {
  const dir = path.join(app.getPath('userData'), 'ai', 'engines', 'ytdlp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, isWin ? 'yt-dlp.exe' : 'yt-dlp');
}

function ytdlpInstalled() {
  try {
    const p = ytdlpPath();
    return fs.existsSync(p) && fs.statSync(p).size > 1000000;
  } catch (_) {
    return false;
  }
}

/* 翻译模型双档：轻量 0.5B（约 400MB）默认，高质量 1.5B（约 1.1GB）可选 */
const TRANSLATE_LITE = 'qwen-translate-lite';
const TRANSLATE_FULL = 'qwen-translate';
const TRANSLATE_SIZE = { [TRANSLATE_LITE]: '400MB', [TRANSLATE_FULL]: '1.1GB' };

function normalizeTranslateModel(id) {
  return id === TRANSLATE_LITE ? TRANSLATE_LITE : TRANSLATE_FULL;
}

function status() {
  const whisperModel = pickWhisperModel();
  return {
    whisper: { engine: !!hub.engineBin('whisper'), model: whisperModel ? whisperModel.id : null },
    translate: {
      engine: !!hub.engineBin('llamacpp'),
      lite: !!hub.modelPath(TRANSLATE_LITE),
      full: !!hub.modelPath(TRANSLATE_FULL)
    },
    downloader: { installed: ytdlpInstalled(), supported: process.platform === 'darwin' || isWin }
  };
}

async function ensureWhisper(proxy, emit, from, to) {
  if (!hub.engineBin('whisper')) {
    emit({ stage: '下载 Whisper 识别引擎（首次）', percent: from });
    await hub.installEngine('whisper', proxy, (p) => {
      if (!p || p.phase === 'error') return;
      if (p.phase === 'download') {
        const r = p.percent >= 0 ? p.percent / 100 : 0.2;
        emit({ stage: '下载 Whisper 识别引擎（首次）', percent: from + (to - from) * 0.7 * r });
      } else if (p.phase === 'extract') {
        emit({ stage: '安装 Whisper 识别引擎', percent: from + (to - from) * 0.9 });
      }
    });
    checkCanceled();
  }
  let model = pickWhisperModel();
  if (!model) {
    emit({ stage: '下载语音识别模型（首次，148MB）', percent: from + (to - from) * 0.9 });
    await hub.installModel('whisper-base', proxy, (p) => {
      if (!p || p.phase !== 'download' || p.percent < 0) return;
      emit({ stage: '下载语音识别模型（首次，148MB）', percent: from + (to - from) * (0.9 + 0.1 * p.percent / 100) });
    });
    model = pickWhisperModel();
  }
  if (!model) throw new Error('语音识别模型安装失败，请到「桌面引擎」手动安装后再试');
  return model;
}

async function ensureTranslateEngine(proxy, emit, from, to, modelId) {
  const target = normalizeTranslateModel(modelId);
  if (!hub.engineBin('llamacpp')) {
    emit({ stage: '下载翻译引擎（首次）', percent: from });
    await hub.installEngine('llamacpp', proxy, (p) => {
      if (!p || p.phase === 'error') return;
      if (p.phase === 'download') {
        const r = p.percent >= 0 ? p.percent / 100 : 0.2;
        emit({ stage: '下载翻译引擎（首次）', percent: from + (to - from) * 0.35 * r });
      } else if (p.phase === 'extract') {
        emit({ stage: '安装翻译引擎', percent: from + (to - from) * 0.4 });
      }
    });
    checkCanceled();
  }
  if (!hub.modelPath(target)) {
    const stage = `下载翻译模型（首次，${TRANSLATE_SIZE[target]}）`;
    emit({ stage, percent: from + (to - from) * 0.4 });
    await hub.installModel(target, proxy, (p) => {
      if (!p || p.phase !== 'download' || p.percent < 0) return;
      emit({ stage, percent: from + (to - from) * (0.4 + 0.6 * p.percent / 100) });
    });
  }
  checkCanceled();
  if (!hub.modelPath(target)) throw new Error('翻译模型安装失败，请到「桌面引擎」手动安装后再试');
}

async function ensureYtdlp(proxy, emit) {
  if (ytdlpInstalled()) return ytdlpPath();
  const name = isWin ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
  const origin = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${name}`;
  const urls = [origin, `https://gh-proxy.com/${origin}`, `https://ghfast.top/${origin}`];
  const dest = ytdlpPath();
  const tmp = dest + '.part';
  let lastErr = null;
  for (const url of urls) {
    checkCanceled();
    try {
      await net.downloadToFile(url, tmp, {
        proxy,
        timeout: 60000,
        onProgress: (received, total) => emit({
          stage: '下载链接视频引擎（首次）',
          percent: total ? Math.min(99, (received / total) * 100) : 5
        })
      });
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1000000) {
        fs.renameSync(tmp, dest);
        if (!isWin) fs.chmodSync(dest, 0o755);
        return dest;
      }
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
  throw new Error(`链接视频引擎下载失败：${(lastErr && lastErr.message) || '网络不可用'}。可改用本地视频文件`);
}

/* ---------------- 链接视频下载 ---------------- */
async function downloadVideo(url, dir, proxy, emit, from, to) {
  const bin = await ensureYtdlp(proxy, emit);
  checkCanceled();
  const ff = ffmpegMod.getFfmpegPath();
  const args = ['--no-playlist', '--no-warnings', '--newline', '--no-mtime'];
  if (ff && ff !== 'ffmpeg') args.push('--ffmpeg-location', path.dirname(ff));
  args.push('-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', path.join(dir, 'source.%(ext)s'), url);
  emit({ stage: '下载视频', percent: from });
  await run(bin, args, {
    onLine: (line) => {
      const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (m) emit({ stage: '下载视频', percent: from + (to - from) * Math.min(1, Number(m[1]) / 100) });
    }
  });
  checkCanceled();
  const files = fs.readdirSync(dir)
    .filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f) && !f.startsWith('.'))
    .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (!files.length) throw new Error('视频下载完成但未找到文件，请改用本地视频');
  return path.join(dir, files[0].f);
}

/* ---------------- 语音识别 ---------------- */
async function transcribe(wav, modelId, lang, emit, from, to) {
  const bin = hub.engineBin('whisper');
  const model = hub.modelPath(modelId);
  if (!bin || !model) throw new Error('语音识别引擎未就绪');
  const outBase = wav.replace(/\.wav$/i, '-asr');
  let detected = lang && lang !== 'auto' ? lang : '';
  const { stderr } = await run(bin, [
    '-m', model, '-f', wav, '-l', lang && lang !== 'auto' ? lang : 'auto',
    '-oj', '-of', outBase, '-t', String(threads()), '-pp'
  ], {
    onLine: (line) => {
      const p = line.match(/progress\s*=\s*(\d+)/i);
      if (p) emit({ stage: '语音识别', percent: from + (to - from) * Math.min(1, Number(p[1]) / 100) });
      const d = line.match(/auto-detected language:\s*([a-z]{2,3})/i);
      if (d) detected = d[1].toLowerCase();
    }
  });
  checkCanceled();
  const segments = parseWhisperJson(outBase + '.json');
  if (!segments.length) throw new Error('未识别到人声，请检查视频音轨');
  return { segments, detected: detected || 'en', stderr };
}

/* ---------------- 片段窗口 ---------------- */
function pickWindow(segments, duration, clipSeconds) {
  if (!clipSeconds || clipSeconds <= 0 || duration <= clipSeconds + 1) {
    return { start: 0, end: duration };
  }
  let best = { start: 0, score: -1 };
  for (const seg of segments) {
    const start = Math.max(0, Math.min(seg.start, duration - clipSeconds));
    const end = start + clipSeconds;
    let score = 0;
    for (const g of segments) {
      score += Math.max(0, Math.min(g.end, end) - Math.max(g.start, start));
    }
    if (score > best.score) best = { start, score };
  }
  const start = Math.max(0, Math.round(best.start * 10) / 10);
  return { start, end: Math.min(duration, start + clipSeconds) };
}

function sliceSegments(segments, win) {
  return segments
    .map((s) => ({
      start: Math.max(0, s.start - win.start),
      end: Math.min(win.end, s.end) - win.start,
      text: s.text.trim()
    }))
    .filter((s) => s.text && s.end - s.start > 0.3);
}

/** 单条字幕最长时长：超过就按标点/词数拆分，避免一条字幕占满整屏 */
const MAX_SEG_SEC = 7;
/** 相邻两句配音之间至少留出的静音（秒）：再小就会出现「上一句尾音 + 下一句起音」粘在一起 */
const SEG_GAP = 0.06;

function splitLongSegments(segs) {
  const out = [];
  for (const seg of segs) {
    const dur = seg.end - seg.start;
    if (dur <= MAX_SEG_SEC) {
      out.push(seg);
      continue;
    }
    const parts = Math.ceil(dur / MAX_SEG_SEC);
    const text = seg.text.trim();
    let chunks = text.split(/(?<=[.!?。！？；;])\s*/).map((c) => c.trim()).filter(Boolean);
    if (chunks.length < 2 || chunks.length > parts * 2) {
      const words = text.split(/\s+/).filter(Boolean);
      const per = Math.ceil(words.length / parts);
      chunks = [];
      for (let i = 0; i < words.length; i += per) chunks.push(words.slice(i, i + per).join(' '));
    }
    if (chunks.length < 2) {
      out.push(seg);
      continue;
    }
    // 按字符数分配时长，保证语音与字幕节奏一致
    const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let t = seg.start;
    chunks.forEach((c, i) => {
      const isLast = i === chunks.length - 1;
      const end = isLast ? seg.end : t + (dur * c.length) / totalChars;
      out.push({ start: t, end, text: c });
      t = end;
    });
  }
  return out.filter((s) => s.text && s.end - s.start > 0.25);
}

/* whisper 相邻片段的时间戳常有几十到几百毫秒重叠，长句拆分后也可能首尾相接。
   这些重叠会让两句配音同时落在同一时刻（成片听起来「两个人在同时说话」），
   所以进入配音/字幕之前统一压平：按时间排序，后一句的起点不得早于前一句的终点。 */
function normalizeSegs(segs) {
  const list = (segs || [])
    .filter((s) => s && s.text && s.end > s.start)
    .map((s) => ({ start: Math.max(0, s.start), end: Math.max(0, s.end), text: String(s.text).trim() }))
    .sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  return list
    .map((s) => {
      const start = Math.max(s.start, prevEnd);
      const end = Math.max(s.end, start + 0.25);
      prevEnd = end;
      return { ...s, start, end };
    })
    .filter((s) => s.end - s.start > 0.25);
}

/* ---------------- 本地翻译（llama.cpp + Qwen2.5） ---------------- */
function cleanTranslation(text) {
  return String(text)
    .replace(/^[\s"'“”「『]+|[\s"'“”」』]+$/g, '')
    .replace(/^(翻译|translation)\s*[:：]\s*/i, '')
    .trim();
}

/* llama-cli 会把输入的 prompt 回显到 stdout，因此同一编号可能出现两次（先原文、后译文）。
   这里统一按「后出现的为准」，同时兼容「1. 译文」与「[1] 译文」两种编号格式。 */
function parseNumbered(stdout, count) {
  const map = new Map();
  stdout.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*(?:\[(\d+)\]|(\d+)\s*[.)、])\s*(.+?)\s*$/);
    if (!m) return;
    const idx = Number(m[1] || m[2]) - 1;
    if (idx < 0 || idx >= count) return;
    const txt = cleanTranslation(m[3]);
    if (txt) map.set(idx, txt);
  });
  return map;
}

async function llamaTranslate(lines, langId, modelId, opts = {}) {
  const bin = hub.engineBin('llamacpp');
  const model = hub.modelPath(normalizeTranslateModel(modelId));
  if (!bin || !model) throw new Error('翻译引擎未就绪');
  const lang = langById(langId);
  const numbered = lines.map((t, i) => `${i + 1}. ${t}`).join('\n');
  // 0.5B/1.5B 这类小模型对「英文长指令」会直接照抄原文；
  // 中文系统提示 + 一条目标语言示例（few-shot）能显著提升翻译成功率。
  const sys = `你是专业视频字幕翻译。把每条字幕翻译成自然、口语化的${lang.zhName}。`;
  const prompt = opts.simple
    ? `逐条翻译为${lang.zhName}，只输出「编号. 译文」：\n${numbered}`
    : `示例：\n原文：1. 谢谢大家。\n译文：1. ${lang.sample}\n\n现在逐条翻译下面的字幕，只输出「编号. 译文」，不要原文、不要解释：\n${numbered}`;
  /* llama.cpp 新版本（b11851）已移除 -no-cnv：
     必须用 -st（单轮，prompt 预置时非交互）+ --simple-io（适配管道 stdin），
     否则 llama-cli 进入会话模式后一直等待 stdin，子进程永不退出。 */
  const args = [
    '-m', model, '-sys', sys, '-p', prompt,
    '-st', '--simple-io',
    '-n', String(Math.min(2048, 64 + lines.length * 96)),
    '-c', '4096', '-t', String(threads()),
    '--temp', '0.7', '--top-p', '0.8', '--top-k', '20', '--repeat-penalty', '1.05'
  ];
  const { stdout } = await run(bin, args, { timeout: 180000, timeoutMsg: '翻译引擎 3 分钟无响应，已自动终止' });
  return parseNumbered(stdout, lines.length);
}

function countTranslated(map, chunk) {
  let n = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    const t = map.get(i);
    if (t && t !== chunk[i]) n += 1;
  }
  return n;
}

async function translateSegments(segs, langId, emit, from, to, modelId) {
  const lines = segs.map((s) => s.text);
  const out = new Array(lines.length);
  const batch = 8;
  for (let start = 0; start < lines.length; start += batch) {
    checkCanceled();
    const chunk = lines.slice(start, start + batch);
    // 整批翻译失败先换一种更简单的提示重试一次，仍失败则报错，避免产出「未翻译」的成品
    let map = await llamaTranslate(chunk, langId, modelId);
    let got = countTranslated(map, chunk);
    if (!got) {
      map = await llamaTranslate(chunk, langId, modelId, { simple: true });
      got = countTranslated(map, chunk);
    }
    if (!got) {
      throw new Error(`翻译引擎未能翻译${langById(langId).name}字幕，请重试；若反复失败，请在「翻译模型档位」切换为高质量 1.5B`);
    }
    const missing = [];
    for (let i = 0; i < chunk.length; i += 1) {
      const t = map.get(i);
      // stdout 里的原文回显不算译文，必须与原文不同才算翻译成功
      if (t && t !== chunk[i]) {
        out[start + i] = t;
      } else {
        out[start + i] = chunk[i];
        missing.push({ i: start + i, text: chunk[i] });
      }
    }
    // 个别漏翻的句子单独补一次，仍失败则保留原文
    if (missing.length && missing.length <= 6) {
      for (const item of missing) {
        checkCanceled();
        try {
          let one = await llamaTranslate([item.text], langId, modelId);
          let t = one.get(0);
          if (!t || t === item.text) {
            one = await llamaTranslate([item.text], langId, modelId, { simple: true });
            t = one.get(0);
          }
          if (t && t !== item.text) out[item.i] = t;
        } catch (e) {
          if (e.message === '已取消') throw e;
        }
      }
    }
    emit({ percent: from + (to - from) * Math.min(1, (start + chunk.length) / lines.length) });
  }
  return out;
}

/* ---------------- 原声音色分析（本地声学特征） ----------------
   不做云端克隆：只用自相关估计原片说话人的基频 F0、发声占比与过零率，
   据此挑选同性别音色，并对译文配音做音高/音色塑形，让译文听感接近原声。 */
const ANALYSIS_RATE = 8000;

function decodePcm(file, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegMod.getFfmpegPath(), [
      '-v', 'error', ...extra, '-i', file, '-vn', '-ac', '1',
      '-ar', String(ANALYSIS_RATE), '-f', 's16le', 'pipe:1'
    ], { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error('原声分析失败'));
    });
  });
}

function analyzeVoice(buf) {
  const rate = ANALYSIS_RATE;
  const n = Math.floor(buf.length / 2);
  const pcm = new Float32Array(n);
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = buf.readInt16LE(i * 2) / 32768;
    pcm[i] = v;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  const frame = Math.round(rate * 0.04);
  const hop = Math.round(rate * 0.02);
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.ceil(rate / 60);
  const gate = Math.max(rms * 0.55, 0.004);
  const f0s = [];
  let zc = 0;
  let zcTotal = 0;
  for (let s = 0; s + frame + maxLag < n; s += hop) {
    let energy = 0;
    for (let i = 0; i < frame; i += 1) energy += pcm[s + i] * pcm[s + i];
    if (Math.sqrt(energy / frame) < gate) continue;
    for (let i = 1; i < frame; i += 1) {
      zcTotal += 1;
      if ((pcm[s + i] >= 0) !== (pcm[s + i - 1] >= 0)) zc += 1;
    }
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let corr = 0;
      let tail = 0;
      for (let i = 0; i < frame; i += 1) {
        const a = pcm[s + i];
        const b = pcm[s + i + lag];
        corr += a * b;
        tail += b * b;
      }
      const norm = corr / (Math.sqrt(energy * tail) + 1e-9);
      if (norm > best) { best = norm; bestLag = lag; }
    }
    if (best > 0.45 && bestLag) {
      const f0 = rate / bestLag;
      if (f0 >= 60 && f0 <= 420) f0s.push(f0);
    }
  }
  f0s.sort((a, b) => a - b);
  return {
    f0: f0s.length ? Math.round(f0s[Math.floor(f0s.length / 2)]) : 0,
    voiced: f0s.length,
    zcr: zcTotal ? zc / zcTotal : 0,
    rms: Math.round(rms * 1000) / 1000
  };
}

/* 配音清洁链：所有模式（克隆 / 近似 / 预置）都要过。
   克隆出来的 24kHz 音频自带的底噪、气声和 10kHz 以上的嘶声，以前是原样
   进成片的（克隆模式不做任何塑形），听感就是「沙沙的电流声」。
   - highpass=f=70：去掉低频轰鸣与直流偏移
   - lowpass=f=11000：砍掉 11k 以上的嘶声（24k 源在 11k 以上几乎没有有效内容）
   - afftdn：频域降噪，tn=1 让噪声底随句子自动跟踪，不依赖固定噪声样本 */
const CLEAN = 'highpass=f=70:poles=2,lowpass=f=11000,afftdn=nr=10:nf=-50:tn=1';

/* 削峰：克隆输出常有远超语音的瞬时尖峰（峰值贴着 0dBFS），
   直接按响度放大就会撞上限制器、把齿音压破。
   先用 2.5:1 的轻压缩把尖峰收下来，再给固定增益，听感自然也不抬底噪。 */
const COMP = 'acompressor=threshold=0.05:ratio=2.5:attack=6:release=200';

/** 统一音质塑形（试听用，与成片同一套链路） */
const POLISH = `${CLEAN},${COMP}`;

/** 只测综合响度（LUFS）。返回 null 表示整段没有可测内容（全静音）。
    单遍 loudnorm 只用来「测量」（print_format=json 只测不滤）：
    它输出的是输入响度，不参与任何实际增益，所以不会泵动底噪。 */
async function measureLufs(file, clean) {
  let out = '';
  const chain = [clean, 'loudnorm=I=-18:TP=-2:LRA=9:print_format=json'].filter(Boolean).join(',');
  try {
    await runFf(['-hide_banner', '-nostats', '-i', file, '-af', chain, '-f', 'null', '-'], (l) => { out += l + '\n'; });
  } catch (e) {
    out += String((e && e.message) || '');
  }
  const m = out.match(/"input_i"\s*:\s*"?(-?[0-9.]+)"?/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** 单句电平：先「测量」，再给一个「固定增益」。
    以前每句直接跑单遍 loudnorm（动态模式），它会在句内不停改增益：
    停顿、气口、句首尾的底噪被一起抬起来，听感就是「呼吸声」「底噪一阵一阵」。
    现在改成「先测后给固定增益」，既不泵动，也不会把底噪放大。 */
async function measureGainDb(file, clean, target = -18) {
  const i = await measureLufs(file, clean);
  // 几乎没有有效语音（-inf 或低于 -70 LUFS）：不放大，避免把整段底噪拉满
  if (i == null || i < -70) return 0;
  // 上限 +12dB：太小的句子多半是生成失败/极短，猛拉只会把底噪推到能听见
  return Math.max(-24, Math.min(12, target - i));
}

/** 把配音的音高推向原片说话人（asetrate 会连同共振峰一起平移，更像换了个人） */
function pitchChain(srcF0, ttsF0) {
  if (!srcF0 || !ttsF0) return '';
  // 系统女声基频常在 230Hz 上下，原片女声多在 170~200Hz，需要允许更低的比值才能贴合
  const ratio = Math.max(0.72, Math.min(1.3, srcF0 / ttsF0));
  if (ratio > 0.97 && ratio < 1.03) return '';
  // 结尾不要再带逗号：拼到 filter_complex 里会变成 "...,," 触发 No such filter: ''
  return `asetrate=44100*${ratio.toFixed(4)},aresample=44100,atempo=${(1 / ratio).toFixed(4)}`;
}

const genderLabel = (f0) => (f0 ? (f0 < 165 ? '男声' : '女声') : '未知');

/* ---------------- 系统离线 TTS ---------------- */
let voiceCache = null;
function listSayVoices() {
  if (voiceCache) return Promise.resolve(voiceCache);
  return new Promise((resolve) => {
    const child = spawn('say', ['-v', '?'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const rows = [];
      out.split(/\r?\n/).forEach((line) => {
        const m = line.match(/^(.+?)\s{2,}([A-Za-z]{2}[_-][A-Za-z]{2,4})\s+#/);
        if (m) rows.push({ name: m[1].trim(), locale: m[2].replace('-', '_') });
      });
      voiceCache = rows;
      resolve(rows);
    });
  });
}

/** 各语言的可用优质音色（已按听感排序，剔除卡通/机器人音色） */
async function voiceCatalog() {
  const out = {};
  if (isWin) {
    LANGS.forEach((l) => {
      out[l.id] = { default: null, list: [{ name: null, base: '', gender: '', style: '', tier: 0, label: '系统默认音色' }] };
    });
    return out;
  }
  const rows = await listSayVoices();
  LANGS.forEach((lang) => {
    const locales = (LANG_LOCALES[lang.id] || [lang.say]).map((s) => s.toLowerCase());
    const list = rows
      .filter((r) => locales.includes(r.locale.toLowerCase()))
      .filter((r) => !VOICE_DENY.has(baseVoice(r.name)))
      .map((r) => {
        const info = voiceInfo(r.name);
        return {
          name: r.name,
          base: baseVoice(r.name),
          locale: r.locale,
          gender: info.gender,
          style: info.style,
          tier: info.tier,
          label: `${baseVoice(r.name)} · ${info.style}`
        };
      })
      .sort((a, b) => a.tier - b.tier
        || ((VOICE_ORDER.indexOf(a.base) + 1 || 99) - (VOICE_ORDER.indexOf(b.base) + 1 || 99))
        || ((LOCALE_RANK[a.locale] ?? 9) - (LOCALE_RANK[b.locale] ?? 9)))
      // 同一音色的不同区域只保留优先级最高的一个，避免列表里出现重复名字
      .filter((v, i, arr) => arr.findIndex((x) => x.base === v.base) === i)
      .slice(0, 10);
    const preferred = list.find((v) => v.gender === 'f')
      || list.find((v) => v.gender === 'm')
      || list[0] || null;
    out[lang.id] = { default: preferred ? preferred.name : null, list };
  });
  return out;
}

async function pickVoice(langId, gender, explicit) {
  if (explicit) return explicit;
  if (isWin) return null;
  const cat = await voiceCatalog();
  const entry = cat[langId];
  if (!entry || !entry.list.length) return null;
  if (gender) {
    const hit = entry.list.find((v) => v.gender === gender);
    if (hit) return hit.name;
  }
  return entry.default;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function synthWin(text, outFile, langId) {
  const txt = outFile.replace(/\.wav$/i, '.txt');
  fs.writeFileSync(txt, text, 'utf8');
  const culture = langById(langId).win;
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like '${culture}*' } | Select-Object -First 1;`,
    'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) };',
    `$s.SetOutputToWaveFile(${psQuote(outFile)});`,
    `$s.Speak([System.IO.File]::ReadAllText(${psQuote(txt)}, [System.Text.Encoding]::UTF8));`,
    '$s.Dispose();'
  ].join(' ');
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return '';
}

async function synth(text, outFile, langId, voiceOverride) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('空文本');
  if (isWin) return synthWin(clean, outFile, langId);
  const voice = voiceOverride === undefined ? await pickVoice(langId) : voiceOverride;
  const txt = outFile.replace(/\.wav$/i, '.txt');
  fs.writeFileSync(txt, clean, 'utf8');
  const args = [];
  if (voice) args.push('-v', voice);
  args.push('-r', String(TTS_RATE), '--data-format=LEI16@44100', '-o', outFile, '-f', txt);
  try {
    await run('say', args);
    return voice || '';
  } catch (e) {
    if (e.message === '已取消') throw e;
    if (!voice) throw e;
    // 指定音色不可用时退回系统默认音色
    await run('say', ['-r', String(TTS_RATE), '--data-format=LEI16@44100', '-o', outFile, '-f', txt]);
    return '';
  }
}

/** 读取 WAV 头计算精确时长（PCM） */
function wavDuration(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 44) return 0;
    let pos = 12;
    let fmt = null;
    let dataSize = 0;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'fmt ') {
        fmt = {
          channels: buf.readUInt16LE(pos + 10),
          rate: buf.readUInt32LE(pos + 12),
          bits: buf.readUInt16LE(pos + 22)
        };
      } else if (id === 'data') {
        dataSize = size;
        break;
      }
      pos += 8 + size + (size % 2);
    }
    if (!fmt || !dataSize || !fmt.rate || !fmt.channels || !fmt.bits) return 0;
    return dataSize / (fmt.rate * fmt.channels * (fmt.bits / 8));
  } catch (_) {
    return 0;
  }
}

/** 逐句合成后按原时间轴拼接为整条配音轨 */
async function buildNarration(segs, duration, langId, dir, emit, from, to, opts = {}) {
  const ttsDir = path.join(dir, `tts-${langId}`);
  fs.mkdirSync(ttsDir, { recursive: true });
  const inputs = [];
  const filters = [];
  const labels = [];
  let defaultVoiceUsed = false;
  let voiceUsed = '';
  let ttsF0 = 0;
  let fallbackUsed = 0;
  let truncatedUsed = 0;
  // 变速到上限仍超窗、只能淡出截断的句数（实际上是「为了避免两句叠音」付出的代价）
  let squeezed = 0;

  // 合成阶段与拼接阶段拆开：本地克隆很吃算力，可以让 2 路 worker 同时合成不同句子
  const raws = new Array(segs.length);
  if (opts.synthFn) {
    const workers = Math.max(1, Math.min(opts.synthConcurrency || 1, segs.length));
    // 长句优先：并发合成时最后几句往往是长句，会把收尾拖成「只剩一句但还要几分钟」
    const order = segs.map((s, i) => i)
      .sort((a, b) => (segs[b].end - segs[b].start) - (segs[a].end - segs[a].start));
    let next = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const i = order[next];
        next += 1;
        if (i == null) return;
        checkCanceled();
        const seg = segs[i];
        const raw = path.join(ttsDir, `${i}.wav`);
        // 单句最多合成到「目标时长 × 1.5」：混音阶段最多再把语音拉快 1.25 倍，
        // 生成再长也只会被丢掉，白白多烧几分钟算力（克隆是逐 token 生成的）。
        const slot = Math.max(0.6, seg.end - seg.start);
        const maxTokens = Math.min(1000, Math.round(25 * slot * 1.5) + 14);
        // 单句墙钟上限：正常一句约「句长 × 10~13 倍实时」秒，再留并发排队与冷启动余量。
        // 到这个量级还没收尾只可能是生成跑飞（音色漂移/重复循环），
        // 到点截断比让整条任务停在这一句上强。
        const maxSeconds = Math.min(600, Math.max(60, Math.round(slot * 40) + 60));
        let voice;
        try {
          const r = await opts.synthFn(seg.text, raw, i, { maxTokens, maxSeconds });
          if (r && r.truncated) truncatedUsed += 1;
          voice = opts.voice || '';
        } catch (e) {
          checkCanceled();
          // 本地克隆个别句子失败时不断链：回退系统音色把这一句补上
          if (!opts.allowFallback) throw e;
          fallbackUsed += 1;
          // 'clone' 只是标记，不是系统音色名，交给 synth 自动挑音色
          voice = await synth(seg.text, raw, langId, opts.voice === 'clone' ? undefined : opts.voice);
        }
        if (!voice) defaultVoiceUsed = true;
        if (!voiceUsed) voiceUsed = voice;
        raws[i] = raw;
        done += 1;
        // 只报「第几句」，已用/剩余交给渲染层统一算：
        // 两边各算一次会出现「已用…」重复两遍，把卡片文字挤爆。
        emit({
          percent: from + (to - from) * (done / segs.length),
          detail: `第 ${done}/${segs.length} 句${truncatedUsed ? ` · ${truncatedUsed} 句截断` : ''}`
        });
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
  }

  for (let i = 0; i < segs.length; i += 1) {
    checkCanceled();
    const seg = segs[i];
    const raw = opts.synthFn ? raws[i] : path.join(ttsDir, `${i}.wav`);
    if (!opts.synthFn) {
      const voice = await synth(seg.text, raw, langId, opts.voice);
      if (!voice) defaultVoiceUsed = true;
      if (!voiceUsed) voiceUsed = voice;
    }
    // 用第一句估计配音音高（只用于把音色推向原片说话人）
    if (!ttsF0 && opts.srcF0) {
      try { ttsF0 = analyzeVoice(await decodePcm(raw)).f0; } catch (_) {}
    }
    // 每句只允许占用「本句起点 → 下一句起点」这段窗口。
    // 译文音节数通常比原文多，克隆语音一旦读长就会拖进下一句的时间轴，amix 之后
    // 就是「几个人同时说话」——这是成片音频混乱的主因。这里先算可用窗口，
    // 再用变速把它收进窗口；顶到变速上限还放不下就淡出截断，任何情况下都不允许两句重叠。
    const nextStart = i + 1 < segs.length ? segs[i + 1].start : duration;
    const avail = Math.max(0.2, Math.min(duration, nextStart) - seg.start - SEG_GAP);
    const nominal = Math.max(0.45, seg.end - seg.start);
    const spoken = wavDuration(raw) || Math.min(nominal, avail);
    // 每句：先降噪/限带/削峰 → 固定增益 → 限幅 → 变速 → 首尾微淡入淡出 → 定位。
    // 以前这里是单遍 loudnorm（动态归一），它会把句内停顿处的底噪一起抬起来，
    // 成片里就是一阵一阵的「呼吸声/沙沙声」，这是本次噪音问题的主因。
    // 现在改成「先测量再给固定增益」：整句只用一个增益，不泵动、不抬噪。
    const gain = await measureGainDb(raw, POLISH);
    // attack 默认 5ms 会放过瞬时尖峰（实测会顶到 0dBFS），压到 2ms 才能真的守住上限
    let chain = `${POLISH},volume=${gain.toFixed(2)}dB,alimiter=limit=0.85:attack=2:level=false`;
    let tempo = 1;
    if (spoken > avail) {
      // 克隆音色拉快 1.25 倍以上就明显失真；系统音色可以到 2 倍
      const cap = opts.synthFn ? 1.25 : 2;
      tempo = Math.min(cap, spoken / avail);
      chain += `,atempo=${tempo.toFixed(3)}`;
    }
    // 掐掉句首的爆音：0.006s 淡入，几乎听不出，但能消掉 TTS 起音处的「咔哒」
    chain += ',afade=t=in:st=0:d=0.006';
    const spokenAfter = Math.max(0.02, spoken / tempo);
    if (spokenAfter > avail + 0.005) {
      // 变速上限内仍然塞不进窗口：在窗口末尾淡出后截断（宁可少半句尾音，也绝不与下一句叠音）
      const fd = Math.min(0.12, Math.max(0.03, avail * 0.12));
      chain += `,afade=t=out:st=${Math.max(0, avail - fd).toFixed(3)}:d=${fd.toFixed(3)}`;
      squeezed += 1;
    } else if (spokenAfter < avail - 0.02) {
      const fadeOut = Math.min(0.012, Math.max(0.004, avail / 6));
      chain += `,afade=t=out:st=${Math.max(0, spokenAfter - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`;
    }
    chain += `,apad=whole_dur=${avail.toFixed(3)},atrim=0:${avail.toFixed(3)},adelay=${Math.round(seg.start * 1000)}:all=1`;
    filters.push(`[${inputs.length}:a]${chain}[a${i}]`);
    inputs.push(raw);
    labels.push(`[a${i}]`);
  }

  if (!inputs.length) throw new Error('该片段没有可用语音');
  // 原声音色模式：把整轨音高推向原片说话人
  const shape = opts.srcF0 ? pitchChain(opts.srcF0, ttsF0) : '';
  const mix = `amix=inputs=${inputs.length}:normalize=0:duration=longest`;
  // 降噪、削峰、限幅都已在每句里做过了，整轨这里只补一个安全限幅。
  // 每句都在自己的窗口里被裁到精确长度，句与句之间不会重叠；这里再把上限压到 -1dB，
  // 给 AAC 编码留出余量（否则编码后会有破音）。
  // 拼装时先去掉各段首尾逗号：任意一段自带逗号都会拼出空滤镜，
  // 直接让整条任务在最后一步报 "No such filter: ''"。
  // 先把采样率统一到 44.1k 再限幅：克隆源是 24k，如果让 ffmpeg 在滤镜图之后
  // 才重采样，重采样会把峰值顶上去（实测 -1.0dB 的上限会被顶到 -0.28dB）。
  const post = [shape, 'aresample=44100', 'alimiter=limit=0.89:attack=2:level=false',
    `apad=whole_dur=${duration.toFixed(3)}`, `atrim=0:${duration.toFixed(3)}`]
    .map((s) => String(s || '').trim().replace(/^,+|,+$/g, ''))
    .filter(Boolean)
    .join(',');
  const head = inputs.length > 1 ? `${labels.join('')}${mix}` : labels[0];
  const tail = post ? `${head},${post}[out]` : `${head}[out]`;
  const filter = filters.join(';') + ';' + tail;
  const args = ['-y'];
  inputs.forEach((f) => args.push('-i', f));
  args.push('-filter_complex', filter, '-map', '[out]', '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', path.join(dir, `voice-${langId}.wav`));
  await runFf(args);
  return { file: path.join(dir, `voice-${langId}.wav`), defaultVoiceUsed, voiceUsed, ttsF0, fallbackUsed, truncatedUsed, squeezed };
}

/** 试听：用同一套音色与塑形链合成一句话，返回 data URL 供渲染层直接播放 */
async function previewVoice(payload = {}) {
  if (activeJob) throw new Error('译制进行中，请稍后再试听');
  const langId = langById(payload.lang) ? payload.lang : 'en';
  const dir = path.join(app.getPath('temp'), 'tokpure-voice-preview');
  fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, `preview-${langId}.wav`);
  const out = path.join(dir, `preview-${langId}-polish.wav`);
  await synth(VOICE_SAMPLE[langId], raw, langId, payload.voice || undefined);
  await runFf(['-y', '-i', raw, '-af', POLISH, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', out]);
  const buf = fs.readFileSync(out);
  return { dataUrl: `data:audio/wav;base64,${buf.toString('base64')}`, voice: payload.voice || '' };
}

/** 测试克隆服务连通性与 Key 是否有效（不会产生克隆费用） */
async function testClone(payload = {}, proxy) {
  const provider = payload.provider === 'local'
    ? 'local'
    : payload.provider === 'fishaudio' ? 'fishaudio' : 'elevenlabs';
  return voiceclone.test(provider, String(payload.key || ''), proxy);
}

/** 分析原片窗口内的说话人音色 */
async function analyzeSourceVoice(input, win) {
  try {
    const buf = await decodePcm(input, ['-ss', win.start.toFixed(3), '-t', (win.end - win.start).toFixed(3)]);
    const p = analyzeVoice(buf);
    return { f0: p.f0, gender: p.f0 ? (p.f0 < 165 ? 'm' : 'f') : '', label: genderLabel(p.f0), zcr: p.zcr, voiced: p.voiced };
  } catch (_) {
    return { f0: 0, gender: '', label: '未知', zcr: 0, voiced: 0 };
  }
}

/* ---------------- 背景音乐（保留 BGM、去掉原语言人声） ----------------
   原片音轨是「原说话人 + 背景音乐 + 环境底噪」混在一起的，直接铺在原声轨下面，
   句间停顿里就会漏出原语言人声和底噪。唯一干净的做法是先做人声分离：
   丢掉 vocals，只把剩下的伴奏混到新配音下面。 */
// 伴奏目标响度：比配音（-18 LUFS）低 10dB，句间停顿能听清旋律，又不会盖住人声
const BGM_TARGET_LUFS = -28;
// 分离残留的嘶声/气声过一遍轻度频域降噪与低频清理；太狠会把音乐本身削薄
const BGM_CLEAN = 'highpass=f=45,lowpass=f=16000,afftdn=nr=6:nf=-60:tn=1';
// 人声一起，伴奏自动后退约 10dB；人声停，伴奏回来。阈值必须落在配音的实际电平之下：
// 配音归一后约 -18 LUFS（RMS≈0.125），以前写的 0.16 比语音还高，侧链等于没接，
// 伴奏（还带着分离残留的原语言人声）一直原音量压在译文下面——这就是「几个人同时说」。
// 实测 threshold=0.004/ratio=6 在真实电平下压 9~10dB，停顿处立刻回到原音量。
const BGM_DUCK = 'sidechaincompress=threshold=0.004:ratio=6:attack=12:release=350:level_sc=1';

/**
 * 只分离「这次要出片的窗口」，各语种共用同一份伴奏。
 * @returns {Promise<null|{file:string,lufs:number,gain:number}>}
 */
async function separateBgm({ source, win, dur, dir, onProgress, onChild }) {
  const wav = path.join(dir, 'bgm-src.wav');
  await runFf(['-y', '-ss', win.start.toFixed(3), '-t', dur.toFixed(3), '-i', source,
    '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', wav]);
  const res = await audiosep.separate({ input: wav, outdir: dir, onProgress, onChild });
  if (!res.file || !fs.existsSync(res.file)) return null;
  const lufs = await measureLufs(res.file, BGM_CLEAN);
  // 原片没有 BGM 时，分离出来的「伴奏」只是底噪残渣。
  // 这时再把它抬到 -28 LUFS 混进成片，等于把噪音放大十几 dB，所以直接丢弃。
  if (lufs == null || lufs < -48) return null;
  // 抬升上限 +6dB：再往上就是把分离残留一起放大；衰减下限 -8dB 防止伴奏被压没
  const gain = Math.max(-8, Math.min(6, BGM_TARGET_LUFS - lufs));
  return { file: res.file, lufs, gain, stats: res.stats || null };
}

/* ---------------- 竖版渲染 + 字幕烧录 ---------------- */
function assColor(hex) {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, 'F').slice(0, 6);
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/** 一次任务只做一张背景：模糊后的背景是静态的，没必要逐帧重算盒子模糊 */
async function makeBackdrop(input, win, dir) {
  const out = path.join(dir, 'backdrop.jpg');
  try {
    await runFf([
      '-y', '-ss', (win.start + Math.min(0.5, Math.max(0, win.end - win.start) / 4)).toFixed(3),
      '-i', input, '-frames:v', '1',
      '-vf', `scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},boxblur=luma_radius=24:luma_power=2,eq=brightness=-0.07:saturation=0.92`,
      '-q:v', '4', out
    ]);
    return fs.existsSync(out) ? out : null;
  } catch (_) {
    return null;
  }
}

async function renderVertical({ input, dir, win, duration, narration, bgm, srtText, srtName, backdrop, out, color, hasAudio, emit, from, to }) {
  const srtFile = path.join(dir, srtName || 'sub.srt');
  fs.writeFileSync(srtFile, '\ufeff' + srtText, 'utf8');
  // libass 的 Fontsize/MarginV 以 288 高的脚本画布为基准，会按 1080×1920 放大 6.67 倍
  // Fontsize=9 ≈ 60px、MarginV=20 ≈ 133px，刚好落在竖屏安全区内且不遮脸
  const force = [
    'Fontsize=9',
    `PrimaryColour=${assColor(color)}`,
    'OutlineColour=&H00101010',
    'BorderStyle=1',
    'Outline=0.9',
    'Shadow=0',
    'Bold=1',
    'Alignment=2',
    'MarginV=20'
  ].join(',');
  const sub = `subtitles=${path.basename(srtFile)}:force_style='${force}'`;
  const fgChain = `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease[fgv]`;
  // 输入顺序：0=原片、1=配音（有配音轨时）、2=伴奏（有 BGM 时）、最后=背景图。
  // 背景图原来写死成第 2 个输入，加了伴奏轨之后会取错流（把伴奏当成图片）。
  const bgAudio = narration && bgm ? bgm : null;
  const bgIdx = 1 + (narration ? 1 : 0) + (bgAudio ? 1 : 0);
  const vChain = backdrop
    // shortest=1：背景图是无限循环的静态帧，不加会把成片拖成无限长
    ? [fgChain, `[${bgIdx}:v][fgv]overlay=(W-w)/2:(H-h)/2:shortest=1,${sub}[v]`].join(';')
    : [
      '[0:v]split=2[bg][fg]',
      `[bg]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},boxblur=luma_radius=24:luma_power=2,eq=brightness=-0.07:saturation=0.92[bgv]`,
      // 这里必须用 split 出来的 [fg]：再写一次 [0:v] 会「一个输入接两次」，
      // 背景图生成失败时整条渲染会直接报 "Filter split has an unconnected output"
      `[fg]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease[fgv]`,
      `[bgv][fgv]overlay=(W-w)/2:(H-h)/2,${sub}[v]`
    ].join(';');
  let aChain;
  if (!narration) {
    aChain = `[0:a]volume=1.0,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS[a]`;
  } else if (bgAudio) {
    // 配音 + 分离出来的伴奏。
    // 伴奏已经是「去掉原说话人」的纯音乐，所以这里可以放心做侧链闪避：
    // 配音一开口伴奏自动后退约 10dB，停顿处再回来——分离残留的那点人声残渣
    // 会被一起压下去，不会像以前那样叠在译文上（听感就是「两个人在同时说两种语言」）。
    // 两路都先补齐/裁到精确的窗口长度再重置时间戳：伴奏只要短几百毫秒，
    // amix 就会把配音的尾巴截掉；只要长一点点，尾巴又会拖到下一段。
    const D = duration.toFixed(3);
    aChain = [
      `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${D},asetpts=PTS-STARTPTS[vo]`,
      `[2:a]aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${D},asetpts=PTS-STARTPTS,${BGM_CLEAN},volume=${bgAudio.gain.toFixed(2)}dB[bg]`,
      // 配音轨分成两路：一路当侧链的「触发信号」，一路进最终混音；
      // 伴奏只当主信号（sidechaincompress 的主输入就是它），不用再 split
      '[vo]asplit=2[vm][vk]',
      `[bg][vk]${BGM_DUCK}[bd]`,
      `[bd][vm]amix=inputs=2:normalize=0:duration=longest,atrim=0:${D},alimiter=limit=0.95:attack=2:level=false[a]`
    ].join(';');
  } else {
    // 没有可用伴奏时只留新配音：原片音轨里「原说话人 + 环境底噪」是绑在一起的，
    // 铺到多少都会被听出原语言人声，宁可不铺。
    aChain = `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,alimiter=limit=0.95:attack=2:level=false[a]`;
  }
  const hw = await ffmpegMod.hasEncoder('h264_videotoolbox');
  const videoArgs = (useHw) => (useHw
    // 硬件编码：不占 CPU，1080×1920 的 3 分钟片子几十秒就能出
    ? ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high']
    : ['-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast']);
  const build = (useHw) => [
    '-y', '-ss', win.start.toFixed(3), '-t', duration.toFixed(3), '-i', input,
    ...(narration ? ['-i', narration] : []),
    ...(bgAudio ? ['-i', bgAudio.file] : []),
    ...(backdrop ? ['-loop', '1', '-framerate', '30', '-i', backdrop] : []),
    '-filter_complex', vChain + ';' + aChain,
    // 只输出两条流：一条画面、一条音频。多语切片以前出现「音频混乱」时，
    // 常见原因就是混音图里意外多接了原片音轨，或者把多路输入一起 map 进 mp4。
    '-map', '[v]', '-map', '[a]',
    ...videoArgs(useHw),
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    out
  ];
  const onLine = (line) => {
    const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return;
    const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    emit({ percent: from + (to - from) * Math.min(1, t / Math.max(0.1, duration)) });
  };
  try {
    await runFf(build(hw), onLine, dir);
  } catch (e) {
    if (!hw) throw e;
    // 个别机器硬件编码不可用（外接显卡/老系统），退回软件编码保证一定出片
    await runFf(build(false), onLine, dir);
  }
}

/* ---------------- 成片自检 ----------------
   译文成片的音频必须是「一条音轨、时长与画面一致」。混音图一旦出错
   （多接了一路原声、伴奏/配音长度不一致），用户点开才会发现「几个人同时说话」；
   这里出片后立刻探测一次，把问题直接写进结果卡片的提示里。 */
async function verifyOutput(file, duration) {
  let text = '';
  try { await runFf(['-hide_banner', '-i', file], (l) => { text += l + '\n'; }); } catch (_) { /* 流信息只在 stderr */ }
  const tracks = (text.match(/Stream #\d+:\d+[^:]*: Audio:/g) || []).length;
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dur = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  const notes = [];
  if (tracks !== 1) notes.push(`成片音轨数量异常（${tracks} 条），请重新导出`);
  if (dur && duration && Math.abs(dur - duration) > 0.4) {
    notes.push(`成片时长与配音窗口不一致（${dur.toFixed(2)}s / ${duration.toFixed(2)}s）`);
  }
  return notes;
}

/* ---------------- 原声克隆（云端） ----------------
   真正的「原声音色」= 先从原片人声建克隆音色，再用它朗读译文。
   本地音高匹配只是近似，无法复刻音色，因此单独作为 fallback 保留。 */

/** 从片段里挑一段连续人声做克隆参考（约 20~45 秒，尽量避开纯音乐段） */
function pickRefSpan(segs, win) {
  const list = (segs || []).filter((s) => s.end > s.start);
  if (!list.length) return { start: win.start, end: Math.min(win.end, win.start + 30) };
  let start = list[0].start;
  let end = list[0].end;
  for (let i = 1; i < list.length; i += 1) {
    const next = list[i];
    if (next.end - start > 45) break;
    if (next.start - end > 3 && end - start >= 12) break;
    end = next.end;
  }
  // 克隆服务通常需要 10 秒以上参考音频；语音太短时顺延到片段结束附近补足
  if (end - start < 20) end = Math.min(win.end, start + 25);
  return { start: Math.max(win.start, start - 0.2), end: Math.min(win.end, end + 0.2) };
}

/** 挑「密集人声」片段拼成克隆参考。
    Chatterbox 只取参考音频的前 10 秒做说话人条件（前 6 秒做 prompt tokens），
    所以参考里一旦有长静音、BGM 前奏或音乐段，音色条件就被稀释了——
    用户听到的「不像原声」大多来自这里。这里只保留连续语音段，按时间轴拼起来。 */
function denseSpeechSegments(segs, win, maxSec = 13) {
  const picks = [];
  let total = 0;
  (segs || []).forEach((s) => {
    if (total >= maxSec) return;
    const start = Math.max(win.start, s.start);
    const end = Math.min(win.end, s.end);
    const dur = end - start;
    if (!(dur > 0.5)) return;
    // 单段太长会把后面对齐的句子挤掉；超过 7 秒就只取前 7 秒
    const take = Math.min(dur, 7);
    picks.push({ start, end: start + take });
    total += take;
  });
  return picks;
}

async function buildRefWav(source, segs, win, dir) {
  const out = path.join(dir, 'voice-ref.wav');
  const picks = denseSpeechSegments(segs, win);
  const total = picks.reduce((n, p) => n + (p.end - p.start), 0);
  if (picks.length && total >= 4) {
    const filters = picks.map((p, i) =>
      `[0:a]atrim=${p.start.toFixed(3)}:${p.end.toFixed(3)},asetpts=PTS-STARTPTS[s${i}]`);
    const labels = picks.map((_, i) => `[s${i}]`).join('');
    filters.push(`${labels}concat=n=${picks.length}:v=0:a=1,highpass=f=70:poles=2,`
      + 'lowpass=f=11000,afftdn=nr=8:nf=-50:tn=1[ref]');
    // 参考音只做轻度降噪：完整保留音色细节，但把原片的底噪/嘶声压下去，
    // 否则这批噪声会跟着「说话人条件」一起被克隆进每一句配音里。
    await runFf([
      '-y', '-i', source,
      '-filter_complex', filters.join(';'),
      '-map', '[ref]', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out
    ]);
    if (fs.existsSync(out) && fs.statSync(out).size > 4096) return out;
  }
  // 识别不到可用句子时退回「连续窗口」抽取，保证还有参考音可用
  const span = pickRefSpan(segs, win);
  const dur = Math.max(3, Math.min(60, span.end - span.start));
  await runFf([
    '-y', '-ss', span.start.toFixed(3), '-t', dur.toFixed(3), '-i', source,
    '-vn', '-af', 'highpass=f=60,lowpass=f=12000', '-ac', '1', '-ar', '24000',
    '-c:a', 'pcm_s16le', out
  ]);
  if (!fs.existsSync(out) || fs.statSync(out).size < 4096) throw new Error('原声参考音频提取失败');
  return out;
}

/** 云端克隆服务只收 mp3/wav：把同一段密集人声转成 mp3 再上传 */
async function buildRefMp3(wav, dir) {
  const out = path.join(dir, 'voice-ref.mp3');
  await runFf([
    '-y', '-i', wav, '-ac', '1', '-ar', '44100', '-b:a', '128k', '-f', 'mp3', out
  ]);
  if (!fs.existsSync(out) || fs.statSync(out).size < 4096) throw new Error('原声参考音频转码失败');
  return out;
}

/** 兼容旧调用：给定窗口时按窗口抽参考音（云端服务需要 10 秒以上连续人声） */
async function extractRefAudio(source, span, dir) {
  const dur = Math.max(3, Math.min(60, span.end - span.start));
  const out = path.join(dir, 'voice-ref.mp3');
  await runFf([
    '-y', '-ss', span.start.toFixed(3), '-t', dur.toFixed(3), '-i', source,
    '-vn', '-af', 'highpass=f=80,lowpass=f=11000,afftdn=nf=-25,loudnorm=I=-19:TP=-3',
    '-ar', '44100', '-ac', '1', '-b:a', '128k', '-f', 'mp3', out
  ]);
  if (!fs.existsSync(out) || fs.statSync(out).size < 4096) throw new Error('原声参考音频提取失败');
  return out;
}

function cloneConfig() {
  const s = store.get();
  const cfg = (s && s.voiceClone) || {};
  const provider = cfg.provider === 'fishaudio' ? 'fishaudio'
    : cfg.provider === 'elevenlabs' ? 'elevenlabs' : 'local';
  const keys = cfg.keys || {};
  return { provider, key: String(keys[provider] || '') };
}

const cloneProviderName = (id) => (voiceclone.providerById(id).name || id);

/** 云端配音 synthFn：整段合成 mp3 → 转 44.1k 单声道 wav，交给原有时间轴组装 */
function makeCloudSynth({ provider, key, voiceId, proxy, dir, langId }) {
  let seq = 0;
  return async (text, outWav) => {
    const mp3 = path.join(dir, `clone-${langId}-${seq}.mp3`);
    seq += 1;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      checkCanceled();
      try {
        const buf = await voiceclone.speak({ provider, key, voiceId, text, proxy });
        fs.writeFileSync(mp3, buf);
        await runFf(['-y', '-i', mp3, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', outWav]);
        return;
      } catch (e) {
        if (e.message === '已取消') throw e;
        lastErr = e;
        // 限流/服务端错误重试，鉴权错误直接抛出，避免白等
        if (!/HTTP (429|5\d\d)/.test(String(e.message))) break;
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      }
    }
    throw lastErr || new Error('云端配音失败');
  };
}

/** 把长句按标点拆成短句：整句合成失败时逐句重来，避免一句拖垮整段 */
function splitClauses(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const parts = raw.match(/[^。！？；.!?;]+[。！？；.!?;]?/g) || [raw];
  const out = [];
  parts.forEach((p) => {
    const s = p.trim();
    if (!s) return;
    if (s.length <= 48) { out.push(s); return; }
    (s.match(/[^，,、]+[，,、]?/g) || [s]).forEach((x) => {
      const v = x.trim();
      if (v) out.push(v);
    });
  });
  return out.length > 1 ? out : [];
}

async function concatWav(files, out) {
  const args = ['-y'];
  files.forEach((f) => args.push('-i', f));
  const filter = files.map((_, i) => `[${i}:a]`).join('')
    + `concat=n=${files.length}:v=0:a=1[out]`;
  args.push('-filter_complex', filter, '-map', '[out]',
    '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', out);
  await runFf(args);
}

/** 本地配音 synthFn：常驻 worker 直接产出 wav，无需转码。
    每个 worker 进程内部可以同时合成多句，这里按句子序号轮流分配，
    单路挂掉只重建那一路。
    关键约束：克隆模式下「保不住原声」就等于失败，所以这里绝不用系统音色顶替，
    只做整句重试 → 拆句重试 → 如实报错。 */
function makeLocalSynth({ ctx, langId }) {
  const speakOnce = async (slot, text, out, opts = {}) => {
    const session = ctx.sessions[slot];
    return session.speak(text, out, langId, {
      maxTokens: opts.maxTokens,
      maxSeconds: opts.maxSeconds
    });
  };
  return async (text, outWav, index, opts = {}) => {
    const slot = ctx.sessions.length ? (index || 0) % ctx.sessions.length : 0;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      checkCanceled();
      try {
        const r = await speakOnce(slot, text, outWav, opts);
        return { truncated: !!(r && r.truncated) };
      } catch (e) {
        checkCanceled();
        if (e.message === '已取消') throw e;
        lastErr = e;
        // worker 进程挂了：重建这一路会话再继续，避免后面整段都掉成系统音色
        if (/已退出|已关闭|无响应|超时/.test(e.message) && ctx.refAudio) {
          try { ctx.sessions[slot].close(); } catch (_) {}
          try {
            const s = await voicelocal.openSession({
              refAudio: ctx.refAudio,
              lang: langId,
              threads: ctx.threads,
              conc: ctx.conc,
              steps: ctx.steps
            });
            await s.prepare(ctx.refAudio);
            ctx.sessions[slot] = s;
          } catch (_) {
            /* 重建失败就交给拆句重试 */
          }
        }
      }
    }
    // 整句连续失败：按标点拆短再逐句合成后拼接（仍是同一个克隆音色）
    const clauses = splitClauses(text);
    if (clauses.length > 1) {
      const files = [];
      try {
        for (let k = 0; k < clauses.length; k += 1) {
          checkCanceled();
          const p = `${outWav.replace(/\.wav$/i, '')}.c${k}.wav`;
          const cap = Number(opts.maxTokens) > 0
            ? Math.max(24, Math.round(Number(opts.maxTokens) / clauses.length * 1.4))
            : 0;
          const sec = Number(opts.maxSeconds) > 0
            ? Math.max(30, Math.round(Number(opts.maxSeconds) / clauses.length + 20))
            : 0;
          await speakOnce(slot, clauses[k], p, { maxTokens: cap, maxSeconds: sec });
          files.push(p);
        }
        await concatWav(files, outWav);
        return { truncated: false };
      } catch (e) {
        checkCanceled();
        lastErr = e;
      } finally {
        files.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
      }
    }
    throw lastErr || new Error('本地配音失败');
  };
}

/* ---------------- 主流程 ---------------- */
function makeJobDir() {
  const dir = path.join(app.getPath('temp'), 'tokpure-lingocast', `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeBase(name) {
  return String(name || 'AI多语切片')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'AI多语切片';
}

function uniqueOut(dir, langId, ext) {
  let out = path.join(dir, `${langId}.${ext}`);
  let n = 2;
  while (fs.existsSync(out)) {
    out = path.join(dir, `${langId} ${n}.${ext}`);
    n += 1;
  }
  return out;
}

async function start(payload, proxy, emit) {
  if (activeJob) throw new Error('已有译制任务进行中，请稍候');
  if (aijobs.isBusy()) throw new Error('已有本地 AI 任务进行中，请稍候');

  const targets = Array.from(new Set((payload.targets || []).filter((id) => langById(id))));
  if (!targets.length) throw new Error('请至少选择一种目标语言');
  const clipSeconds = Number(payload.clipSeconds) || 0;
  const sourceLang = payload.sourceLang || 'auto';
  const translateModel = normalizeTranslateModel(payload.translateModel);
  const color = /^#[0-9a-f]{6}$/i.test(payload.subtitleColor || '') ? payload.subtitleColor : '#FFFFFF';
  // 缺省即「原声克隆」：只有它能保住原片说话人的音色。
  // 之前缺省落到「本地近似」，等于用系统音色另一个人念稿，用户听到的就是「叠了一条别人的声音」。
  const voiceMode = payload.voiceMode === 'match' ? 'match' : payload.voiceMode === 'preset' ? 'preset' : 'clone';
  const voiceMap = payload.voiceMap && typeof payload.voiceMap === 'object' ? payload.voiceMap : {};
  // 原声克隆：本地引擎要确认已安装，云端服务商必须先有 Key，都在开工前拦掉
  if (voiceMode === 'clone') {
    const cfg = cloneConfig();
    if (cfg.provider === 'local') {
      const st = voicelocal.status();
      if (!st.installed) {
        throw new Error('已选择「原声克隆（本地引擎）」，但引擎尚未安装。请到「桌面引擎」安装「本地声音克隆」，或先切换到「本地近似」。');
      }
    } else if (!cfg.key) {
      throw new Error('已选择「原声克隆」，但尚未配置克隆服务的 API Key。请在「配音音色」下方选择服务商并填写 Key 后重试。');
    }
  }

  activeJob = { canceled: false, child: null, children: new Set(), killSessions: null };
  const dir = makeJobDir();
  let localSession = null;
  /* 本地克隆并行方案（按内存定容，而不是按核数硬开）
     每个常驻 worker 要扛一份 0.5B 模型权重 + 解码 KV，实测常驻 2.5~3.7GB。
     16GB 机器上开 2~3 路会吃到 7~11GB，触发 macOS 内存压缩/换页，
     于是每路 CPU 掉到 30~40%、单句从 40 秒拖到 2 分钟以上——用户看到的就是「卡死」。
     所以内存低于 40GB 只开 1 路，用进程内多句并发榨干多核；
     内存够大才开第二路（每路再省一份模型内存就没必要了）。 */
  const MEM_GB = Math.max(1, Math.floor(os.totalmem() / (1024 ** 3)));
  const CPU_N = Math.max(2, (os.cpus() || []).length || 4);
  const LOCAL_WORKERS = MEM_GB >= 40 ? 2 : 1;
  const LOCAL_CONC = MEM_GB >= 32 ? 4 : 3;
  // 进程内并发已经占用了多个线程，torch 每进程线程数不能按满核给，
  // 否则 3 句并发 × 4 线程 = 12 线程抢 8 核，反而集体变慢。
  const LOCAL_THREADS = Math.max(2, Math.floor(CPU_N / LOCAL_CONC));
  // flow-matching 的采样步数：6 步虽然快，但 vocoder 会留下颗粒感/沙沙的底噪，
  // 8 步的听感明显干净，时间只多约一成，质量优先。
  const LOCAL_STEPS = 8;
  const localPool = [];
  try {
    const hasUrl = payload.url && /^https?:\/\//i.test(payload.url);
    if (!hasUrl && (!payload.input || !fs.existsSync(payload.input))) throw new Error('请先选择本地视频或填写视频链接');

    let source = payload.input;
    let baseName = payload.input ? path.basename(payload.input) : 'AI多语切片';

    /* 1) 本地引擎准备 */
    emit({ stage: '准备本地引擎', percent: 1 });
    const needTranslate = sourceLang === 'auto' || targets.some((t) => t !== sourceLang);
    const whisperModel = await ensureWhisper(proxy, emit, 1, 6);
    if (needTranslate) await ensureTranslateEngine(proxy, emit, 6, 10, translateModel);
    checkCanceled();

    /* 2) 下载源视频 */
    if (hasUrl) {
      emit({ stage: '下载视频', percent: 10 });
      source = await downloadVideo(payload.url, dir, proxy, emit, 10, 24);
      baseName = path.basename(source);
    }

    /* 3) 探测 + 提取音轨 */
    emit({ stage: '提取音轨', percent: 25 });
    const info = await probe(source);
    if (!info.duration) throw new Error('无法读取视频时长，请确认文件可正常播放');
    if (!info.hasAudio) throw new Error('该视频没有音轨，无法生成配音');
    const wav = path.join(dir, 'asr.wav');
    await runFf(['-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], (line) => {
      const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return;
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      emit({ stage: '提取音轨', percent: 25 + 2 * Math.min(1, t / Math.max(1, info.duration)) });
    });
    checkCanceled();

    /* 4) 语音识别 + 原声音色分析 */
    emit({ stage: '语音识别', percent: 27 });
    const asr = await transcribe(wav, whisperModel.id, sourceLang, emit, 27, voiceMode === 'match' ? 44 : 50);
    const win = pickWindow(asr.segments, info.duration, clipSeconds);
    const winDur = Math.max(0.5, win.end - win.start);
    const segs = normalizeSegs(splitLongSegments(sliceSegments(asr.segments, win)));
    if (!segs.length) throw new Error('所选片段没有语音，请换一个时长或选择完整长片');
    const detected = asr.detected || 'en';

    let srcVoice = { f0: 0, gender: '', label: '未知', zcr: 0, voiced: 0 };
    if (voiceMode === 'match') {
      emit({ stage: '分析原声音色', percent: 46 });
      srcVoice = await analyzeSourceVoice(source, win);
      checkCanceled();
      emit({ stage: '分析原声音色', percent: 50 });
    }

    // 原声克隆：先用原片人声建立该说话人的音色，再用它朗读各语译文
    let cloneVoice = null;
    let cloneRef = null;
    // 本地引擎的心跳统一汇聚到这里，由当前正在合成的语言接手展示
    const beatBus = { sink: null };
    if (voiceMode === 'clone') {
      const cfg = cloneConfig();
      emit({ stage: '克隆原声音色', percent: 46 });
      // 参考音只取「连续人声」并按时间轴拼起来：克隆模型只吃前 10 秒，
      // 连续参考音能显著提高音色相似度（原做法是把 BGM/停顿一起抽进去）。
      const refSpan = pickRefSpan(asr.segments, win);
      const refWav = await buildRefWav(source, asr.segments, win, dir);
      const refAudio = cfg.provider === 'local' ? refWav : await buildRefMp3(refWav, dir);
      if (cfg.provider === 'local') {
        // 本地零样本克隆：直接加载模型并把这段原片人声作为说话人条件
        localSession = await voicelocal.openSession({
          refAudio,
          lang: detected,
          threads: LOCAL_THREADS,
          conc: LOCAL_CONC,
          steps: LOCAL_STEPS,
          onLog: (l) => {
            if (!l) return;
            if (l.elapsed != null && beatBus.sink) { beatBus.sink(l.elapsed); return; }
            if (l.stage) emit({ stage: l.stage, percent: 46 });
          }
        });
        await localSession.prepare(refAudio);
        localPool.push(localSession);
        // 只有内存足够大（≥40GB）才追加第二路；16GB 机器单路即可，
        // 进程内 conc 并发已经把 8 核用满，多一路只会多占 2.5GB 并触发换页。
        const extra = Array.from({ length: Math.max(0, LOCAL_WORKERS - 1) }, (_, k) => k + 2);
        // 并行起：模型加载是纯 IO+CPU 的独立动作，串行等会让启动白白多花一两分钟
        const started = await Promise.all(extra.map(async () => {
          checkCanceled();
          try {
            const s = await voicelocal.openSession({
              refAudio,
              lang: detected,
              threads: LOCAL_THREADS,
              conc: LOCAL_CONC,
              steps: LOCAL_STEPS,
              onLog: (l) => { if (l && l.stage) emit({ stage: l.stage, percent: 46 }); }
            });
            await s.prepare(refAudio);
            return s;
          } catch (_) {
            /* 内存不足等起不来时少一路也能跑，不阻断任务 */
            return null;
          }
        }));
        started.forEach((s) => { if (s) localPool.push(s); });
        cloneRef = refAudio;
        cloneVoice = { provider: 'local', key: '', voiceId: refAudio, cached: false };
        // 常驻克隆进程不走 run() 的子进程集合，取消时要单独掐掉：
        // 否则点「取消」后还得等正在合成的那一句跑完（单句可能要几分钟）。
        activeJob.killSessions = () => localPool.forEach((s) => {
          try { s.close(); } catch (_) {}
        });
      } else {
        const got = await voiceclone.resolveVoice({
          provider: cfg.provider,
          key: cfg.key,
          proxy,
          source,
          win: refSpan,
          audioFile: refAudio,
          name: `${safeBase(baseName)} — TokPure`,
          force: !!payload.refreshVoice
        });
        cloneVoice = { provider: cfg.provider, key: cfg.key, voiceId: got.voiceId, cached: got.cached };
      }
      checkCanceled();
      emit({ stage: '克隆原声音色', percent: 50 });
    }

    /* 4.5) 背景音乐分离（可选，各语种共用同一份伴奏）
       译制成片要「保留背景音乐、去掉原语言人声」，就必须先把人声从原片音轨整段剥掉，
       只留伴奏。这里只处理「这次要出片的窗口」，并且和后面的配音并行跑，
       所以正常情况下不会额外增加总时长（首语种配音通常比分离更慢）。 */
    let bgmNote = '';
    let bgmTask = Promise.resolve(null);
    // 只有「确有语种要换语言」时才需要分离：与源语言相同的成片保留原声，不铺伴奏
    if (payload.keepBgm !== false && targets.some((t) => t !== detected)) {
      bgmTask = (async () => {
        try {
          if (!audiosep.pythonReady()) {
            bgmNote = '背景音乐未保留：分离需要「本地声音克隆」引擎的 Python 环境';
            return null;
          }
          if (!audiosep.modelReady()) {
            // 权重只下载一次，后面所有任务都复用它；不同步等到下载完成会卡住出片
            emit({ stage: '下载背景音乐分离模型（约 319MB，仅一次）', percent: 50 });
            await audiosep.ensureModel({
              onChild: (c) => { if (activeJob) activeJob.children.add(c); },
              onProgress: (p) => emit({ stage: `下载背景音乐分离模型 ${p.percent}%`, percent: 50 })
            });
          }
          checkCanceled();
          emit({ stage: '分离背景音乐（去掉原语言人声）', percent: 50 });
          const got = await separateBgm({
            source,
            win,
            dur: winDur,
            dir,
            onChild: (c) => { if (activeJob) activeJob.children.add(c); },
            onProgress: (p) => emit({
              stage: `${p.stage || '分离背景音乐'} ${Math.round(Number(p.percent) || 0)}%`,
              percent: 50
            })
          });
          if (!got) {
            bgmNote = '原片未检测到可用背景音乐，成片只保留配音';
            return null;
          }
          return got;
        } catch (e) {
          // 分离失败不该拖垮整条任务：退回「只留配音」，并在结果卡片上写明原因
          if (activeJob && activeJob.canceled) return null;
          bgmNote = `背景音乐未保留：${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 80)}`;
          return null;
        }
      })();
    }

    /* 5) 输出目录 */
    const settings = store.get();
    const outDir = path.join(settings.downloadDir || app.getPath('downloads'), OUT_ROOT, safeBase(baseName));
    fs.mkdirSync(outDir, { recursive: true });

    const total = targets.length;
    // 50 → 96 按语言均分；每语种内部：翻译 5% · 配音 75% · 渲染 20%
    const slice = 46 / total;
    const W_TR = 0.05;
    const W_TTS = 0.75;
    const files = new Array(total);

    // 模糊背景只做一张，各语种渲染直接复用（省掉逐帧 boxblur，渲染快一个数量级）
    const backdrop = await makeBackdrop(source, win, dir);
    checkCanceled();

    // 渲染走 VideoToolbox 硬件编码，主要开销在 overlay/scale 这类 CPU 滤镜。
    // 串行队列会把 6 个语种排成一条直线，这里开多条泳道并行：
    // 克隆模式下只有一个常驻克隆进程在吃 CPU（进程内已并发 3 句），
    // 再叠 2 条 ffmpeg 泳道只会和它抢核、把单句拖慢，所以只留 1 条。
    const RENDER_LANES = voiceMode === 'clone' ? 1 : 3;
    const lanes = Array.from({ length: RENDER_LANES }, () => Promise.resolve());
    let laneCursor = 0;
    const enqueueRender = (fn) => {
      const lane = laneCursor % RENDER_LANES;
      laneCursor += 1;
      const p = lanes[lane].then(fn);
      lanes[lane] = p.catch(() => {});
      return p;
    };
    // 渲染与下一语种的配音重叠时，各语种的百分比会互相穿插，
    // 顶部的总进度必须只增不减，否则进度条会往回跳。
    let lastGlobal = 50;

    for (let i = 0; i < total; i += 1) {
      checkCanceled();
      const langId = targets[i];
      const lang = langById(langId);
      const laneBase = 50 + slice * i;
      const sameLanguage = langId === detected;
      // 只发这一语种自己的进度：全局百分比由其他语种/渲染回调共同推进，
      // 卡片上的进度必须来自 langPercent，否则渲染与配音重叠时会互相串台。
      const langEmit = (stage, langStage, frac, detail) => {
        const f = Math.max(0, Math.min(1, Number(frac) || 0));
        lastGlobal = Math.max(lastGlobal, Math.min(96, laneBase + slice * f));
        emit({
          stage,
          langStage,
          percent: lastGlobal,
          langPercent: Math.round(f * 100),
          lang: langId,
          langIndex: i,
          langTotal: total,
          detail: detail || ''
        });
      };

      /* 翻译 */
      let texts;
      if (sameLanguage) {
        texts = segs.map((s) => s.text);
        langEmit('翻译字幕', 'translate', W_TR);
      } else {
        langEmit('翻译字幕', 'translate', 0);
        texts = await translateSegments(segs, langId,
          (p) => langEmit('翻译字幕', 'translate', W_TR * Math.min(1, (Number(p.percent) || 0) / 100)),
          0, 100, translateModel);
      }
      const outSegs = segs.map((s, k) => ({ start: s.start, end: s.end, text: texts[k] || s.text }));
      const srt = buildSrt(outSegs);
      const srtPath = uniqueOut(outDir, langId, 'srt');
      fs.writeFileSync(srtPath, '\ufeff' + srt, 'utf8');
      checkCanceled();

      /* 配音（同语言保留原声） */
      let narration = null;
      let defaultVoice = false;
      let voiceLabel = '';
      let ttsError = '';
      let ttsNote = '';
      const ttsFrom = W_TR;
      const ttsTo = W_TR + W_TTS;
      try {
        if (sameLanguage) {
          voiceLabel = '保留原声';
          langEmit('合成配音', 'tts', ttsTo);
        } else if (voiceMode === 'clone') {
          const isLocal = cloneVoice.provider === 'local';
          const synthFn = isLocal
            ? makeLocalSynth({
              ctx: {
                sessions: localPool,
                refAudio: cloneRef,
                threads: LOCAL_THREADS,
                conc: LOCAL_CONC,
                steps: LOCAL_STEPS
              },
              langId
            })
            : makeCloudSynth({
              provider: cloneVoice.provider,
              key: cloneVoice.key,
              voiceId: cloneVoice.voiceId,
              proxy,
              dir,
              langId
            });
          // 并发上限 = 会话数 × 每进程并发句数，与 worker 内部信号量一致
          const synthConcurrency = isLocal ? Math.max(1, localPool.length * LOCAL_CONC) : 3;
          const totalSegs = Math.max(1, outSegs.length);
          const share = W_TTS / totalSegs;   // 每句在进度条上占的份额
          let doneFrac = ttsFrom;            // 已真正完成的句子对应的进度
          let shownFrac = ttsFrom;           // 已展示的进度（含句内心跳），只增不减
          let doneSegs = 0;
          const onTts = (p) => {
            const f = Math.min(1, (Number(p.percent) || 0) / 100);
            doneFrac = ttsFrom + W_TTS * f;
            doneSegs = Math.round(f * totalSegs);
            shownFrac = Math.max(shownFrac, doneFrac);
            langEmit('合成配音', 'tts', shownFrac, p.detail || '');
          };
          // 本地引擎每 5 秒一次心跳。克隆是逐 token 生成，一句要几十秒：
          // 以前心跳只把同一句的百分比原样再发一遍，于是「数字在走、进度条不动」。
          // 现在按「本句已用时」把这一句的份额持续推近 97%（时间常数 100s：
          // 30s→25%、60s→44%、120s→67%、240s→88%），整句完成时再由 onTts
          // 跳到真实进度。条与「已生成 Ns」一起走，哪怕一句跑了 5 分钟也不会早停。
          beatBus.sink = isLocal
            ? (elapsed) => {
              const sec = Math.max(0, Number(elapsed) || 0);
              const creep = 0.97 * (1 - Math.exp(-sec / 100));
              shownFrac = Math.max(shownFrac, doneFrac + share * creep);
              const cur = Math.min(totalSegs, doneSegs + 1);
              langEmit('合成配音', 'tts', shownFrac, `第 ${cur}/${totalSegs} 句 · 已生成 ${Math.round(sec)}s`);
            }
            : null;
          const built = await buildNarration(outSegs, winDur, langId, dir,
            onTts, 0, 100,
            // 克隆模式下「保不住原声」就是失败：整句失败只会拆句重试，
            // 绝不再退化成系统音色（那会出现两个人声混在同一条片子里）。
            { synthFn, voice: 'clone', allowFallback: false, synthConcurrency });
          beatBus.sink = null;
          narration = built.file;
          // 译文比原文长时会有个别句子被收进窗口截断，提示出来比让用户以为「丢了词」更好
          if (built.squeezed) ttsNote = `${built.squeezed} 句译文偏长，已收紧时长以对齐画面`;
          voiceLabel = isLocal
            ? '原声克隆 · 本地引擎（离线）'
            : `原声克隆 · ${cloneProviderName(cloneVoice.provider)}${cloneVoice.cached ? '（复用已建音色）' : ''}`;
        } else {
          langEmit('合成配音', 'tts', ttsFrom);
          // 原声音色模式：先挑同性别音色；预置模式：用用户选择，未选则用推荐音色
          const explicit = typeof voiceMap[langId] === 'string' && voiceMap[langId] ? voiceMap[langId] : null;
          const voice = await pickVoice(langId, voiceMode === 'match' ? srcVoice.gender : '', explicit);
          const built = await buildNarration(outSegs, winDur, langId, dir,
            (p) => langEmit('合成配音', 'tts', ttsFrom + W_TTS * Math.min(1, (Number(p.percent) || 0) / 100), p.detail || ''),
            0, 100,
            { voice, srcF0: voiceMode === 'match' ? srcVoice.f0 : 0 });
          narration = built.file;
          defaultVoice = built.defaultVoiceUsed;
          const info = voiceInfo(built.voiceUsed);
          voiceLabel = `${voice ? baseVoice(built.voiceUsed) || voice : '系统默认'} · ${info.style}`;
          if (voiceMode === 'match' && srcVoice.f0) {
            voiceLabel += `（原声 ${srcVoice.f0}Hz · ${srcVoice.label}）`;
          }
        }
      } catch (e) {
        checkCanceled();
        // 单个语种配音失败不该拖垮整条任务，也绝不产出「音色不对」的成片：
        // 这一条标红并写清原因，其余语种继续。
        ttsError = String((e && e.message) || e || '配音失败').replace(/\s+/g, ' ').slice(0, 120);
      } finally {
        beatBus.sink = null;
      }

      if (ttsError) {
        files[i] = {
          lang: langId,
          name: lang.name,
          video: '',
          srt: srtPath,
          voice: '配音失败',
          warning: `配音失败：${ttsError}`
        };
        langEmit('配音失败', 'done', 1, ttsError);
        continue;
      }

      /* 竖版渲染：排进队列后立刻进入下一语种，不再阻塞整条流水线 */
      const outVideo = uniqueOut(outDir, langId, 'mp4');
      const srtName = `sub-${langId}.srt`;
      const entry = {
        lang: langId,
        name: lang.name,
        video: outVideo,
        srt: srtPath,
        voice: voiceLabel,
        warning: [defaultVoice ? '该语言缺少系统离线音色，已使用默认音色' : '', ttsNote].filter(Boolean).join(' · ')
      };
      files[i] = entry;
      enqueueRender(async () => {
        langEmit('竖版渲染', 'render', ttsTo);
        try {
          // 伴奏与配音并行准备：这里才开始等，前面的翻译/配音不会被它挡住
          const bgm = sameLanguage ? null : await bgmTask;
          if (!sameLanguage && bgmNote) {
            entry.warning = [entry.warning, bgmNote].filter(Boolean).join(' · ');
          }
          await renderVertical({
            input: source,
            dir,
            win,
            duration: winDur,
            narration: sameLanguage ? null : narration,
            bgm,
            srtText: srt,
            srtName,
            backdrop,
            out: outVideo,
            color,
            hasAudio: info.hasAudio,
            emit: (p) => langEmit('竖版渲染', 'render', ttsTo + (1 - ttsTo) * Math.min(1, (Number(p.percent) || 0) / 100)),
            from: 0,
            to: 100
          });
          // 出片自检：必须只有 1 条音轨、时长与画面一致，否则直接把问题写在卡片上
          const avNotes = await verifyOutput(outVideo, winDur);
          if (avNotes.length) entry.warning = [entry.warning, ...avNotes].filter(Boolean).join(' · ');
          langEmit('已完成', 'done', 1);
          // 单语种一出片就推给界面：用户不必等到 6 个语种全部跑完才能点开第一个
          emit({
            stage: '已完成',
            langStage: 'done',
            lang: langId,
            langIndex: i,
            langTotal: total,
            langPercent: 100,
            percent: lastGlobal,
            file: entry
          });
        } catch (e) {
          checkCanceled();
          // 单个语种渲染失败不该拖垮整条任务：标记后继续后面的语种
          entry.video = '';
          entry.warning = [entry.warning, `竖版渲染失败：${String(e.message || e).replace(/\s+/g, ' ').slice(0, 60)}`]
            .filter(Boolean).join(' · ');
          langEmit('渲染失败', 'done', 1, entry.warning);
        }
      });
    }

    await Promise.all(lanes);
    checkCanceled();
    emit({ stage: '已完成', percent: 100 });
    // 渲染失败的语种在卡片上已经有明确提示，这里只把真正出片的文件交给结果列表
    return { outputDir: outDir, files: files.filter((f) => f && f.video), sourceVoice: srcVoice };
  } finally {
    activeJob = null;
    localPool.forEach((s) => { try { s.close(); } catch (_) {} });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function cancel() {
  if (!activeJob) return false;
  activeJob.canceled = true;
  const kids = new Set([...(activeJob.children || []), activeJob.child].filter(Boolean));
  kids.forEach((c) => { try { c.kill('SIGKILL'); } catch (_) {} });
  if (typeof activeJob.killSessions === 'function') {
    try { activeJob.killSessions(); } catch (_) {}
  }
  ['whisper', 'whisper-base', 'llamacpp', TRANSLATE_LITE, TRANSLATE_FULL].forEach((id) => {
    try { hub.cancelInstall(id); } catch (_) {}
  });
  return true;
}

async function pickFile(win) {
  const res = await dialog.showOpenDialog(win, {
    title: '选择长视频',
    properties: ['openFile'],
    filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return describe(res.filePaths[0]);
}

function describe(p) {
  if (!p || !fs.existsSync(p)) throw new Error('文件不存在或已被移动');
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('不是有效的文件');
  if (!/\.(mp4|mov|webm|mkv|m4v)$/i.test(p)) throw new Error('仅支持 MP4 / MOV / WEBM / MKV 格式');
  return { path: p, name: path.basename(p), size: st.size };
}

function reveal(p) {
  if (p && fs.existsSync(p)) {
    const st = fs.statSync(p);
    if (st.isDirectory()) shell.openPath(p);
    else shell.showItemInFolder(p);
    return true;
  }
  return false;
}

function openFile(p) {
  if (!p || !fs.existsSync(p)) return false;
  shell.openPath(p);
  return true;
}

module.exports = { status, start, cancel, pickFile, describe, reveal, openFile, voices: voiceCatalog, preview: previewVoice, testClone };
