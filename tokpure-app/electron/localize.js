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
const denoise = require('./denoise');
const audiosep = require('./audiosep');
const lipsync = require('./lipsync');
const sapi = require('./sapi');
const voices = require('./voices');
const voiceSample = require('./voicesample');

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

/* 3.9.26：应用被更新覆盖时，进程里缓存的安装包路径会失效（spawn ENOENT）。
   getFfmpegPath() 本身已会复核文件，这里再加一次「重新解析后重跑」，
   免得一个已经跑了半小时的任务因为一次路径失效整条作废。 */
const runFf = async (args, onLine, cwd) => {
  const bin = ffmpegMod.getFfmpegPath();
  try {
    return await run(bin, args, { onLine, cwd });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      ffmpegMod.invalidate();
      const next = ffmpegMod.getFfmpegPath();
      if (next && next !== bin) return run(next, args, { onLine, cwd });
    }
    throw e;
  }
};

/* ---------------- 媒体探测 ---------------- */
async function probe(input) {
  let text = '';
  try {
    await runFf(['-hide_banner', '-i', input], (line) => { text += line + '\n'; });
  } catch (_) { /* 无输出文件时 ffmpeg 必然非 0 退出，信息在 stderr */ }
  const durM = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : 0;
  const fpsM = text.match(/(\d+(?:\.\d+)?)\s*fps/);
  const fps = fpsM ? Number(fpsM[1]) : 0;
  return { duration, hasAudio: /Audio:/.test(text), fps };
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

/* ---------------- 本地翻译（llama.cpp + Qwen2.5） ----------------
   这一段的每条规则都是为了「成片字幕/配音里绝不出现原语言」：
   1) llama-cli 会把 prompt 回显到 stdout，回显里的长句还会被它自己截断并加
      「 ... (truncated)」——实测英文成片第 8 条字幕因此变成中文原文（回显被当成译文）；
   2) 8 句一批时小模型偶尔只翻前 7 句，最后一句没有译文，就会静默沿用原文；
   3) 判「翻译成功」不能只靠「和原文不一样」，必须逐句校验目标语言的文字系统。
   所以：解析保留同编号的全部候选 → 剔除回显/截断伪影 → 校验目标语言 → 漏掉的句子
   单句重试三次（简单提示 → 严格提示 → 换档模型）→ 仍失败则丢弃该句并给出提示，
   宁可在时间轴上留半句空白，也不产出「英文成片里夹中文」。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff]/;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

/** 剥掉 llama.cpp 的截断伪影与替换字符（\ufffd），它们会把「回显」伪装成译文 */
function stripArtifacts(text) {
  return String(text == null ? '' : text)
    .replace(/\ufffd/g, '')
    .replace(/\s*(?:\.{2,}|…)\s*\(\s*truncated\s*\)\s*$/i, '')
    .replace(/\s*\(\s*truncated\s*\)\s*$/i, '')
    .replace(/\s*\[\s*(?:truncated|cut|omitted)\s*\]\s*$/i, '')
    .trim();
}

function cleanTranslation(text) {
  return stripArtifacts(String(text)
    .replace(/^[\s"'“”「『]+|[\s"'“”」』]+$/g, '')
    .replace(/^(翻译|translation|译文)\s*[:：]\s*/i, ''));
}

/** 归一化：去掉空白、标点与符号，只留文字，用于「是不是原文回显」判断 */
function normText(text) {
  return String(text == null ? '' : text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/** 目标语言文字系统校验：英文/西/葡/法/德不允许成段汉字；日文要有假名；韩文要有谚文 */
function scriptMatch(text, langId) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (langId === 'zh') return CJK_RE.test(t);
  if (langId === 'ja') return KANA_RE.test(t);
  if (langId === 'ko') return HANGUL_RE.test(t);
  const chars = t.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (!chars) return false;
  // 拉丁语系目标（英/西/葡/法/德）：一个汉字、假名、谚文都不许留。
  // 以前按「汉字占比 < 20%」放行，理由是品牌名偶尔保留原文——但真实成片里
  // 出现的是「...for 电商 analysis」这种中英混排，比整句中文还难看。
  // 宁可判失败去重翻（translateOne 会逐句补救），也不让目标语言字幕夹原生文字。
  return !CJK_RE.test(t) && !KANA_RE.test(t) && !HANGUL_RE.test(t);
}

/** 候选是不是「原文的回显」：回显被截断 → 它就是原文的前缀 */
function isEchoOf(candidate, source) {
  const c = normText(candidate);
  const s = normText(source);
  if (!c || !s) return false;
  if (c.length < 4) return false;
  if (c.length / s.length < 0.35) return false;
  return s.includes(c) || c.includes(s);
}

/** 从同编号的多个候选里挑出「最后一条真正合格的目标语言译文」 */
function pickTranslation(cands, source, langId) {
  if (!cands || !cands.length) return '';
  for (let k = cands.length - 1; k >= 0; k -= 1) {
    const t = cleanTranslation(cands[k]);
    if (!t) continue;
    if (isEchoOf(t, source)) continue;
    if (normText(t) === normText(source)) continue;
    if (!scriptMatch(t, langId)) continue;
    return t;
  }
  return '';
}

/* llama-cli 会把输入的 prompt 回显到 stdout，因此同一编号可能出现两次（先原文、后译文）。
   这里保留「同一编号的全部候选」，是否合格交给 pickTranslation 判断，
   同时兼容「1. 译文」与「[1] 译文」两种编号格式。 */
function parseNumbered(stdout, count) {
  const map = new Map();
  stdout.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*(?:\[(\d+)\]|(\d+)\s*[.)、])\s*(.+?)\s*$/);
    if (!m) return;
    const idx = Number(m[1] || m[2]) - 1;
    if (idx < 0 || idx >= count) return;
    const txt = cleanTranslation(m[3]);
    if (!txt) return;
    if (!map.has(idx)) map.set(idx, []);
    map.get(idx).push(txt);
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
  const sys = opts.strict
    ? `你是专业视频字幕翻译。只输出${lang.zhName}译文，禁止输出原文、拼音、注释或解释。`
    : `你是专业视频字幕翻译。把每条字幕翻译成自然、口语化的${lang.zhName}。`;
  const prompt = opts.simple
    ? `逐条翻译为${lang.zhName}，只输出「编号. 译文」：\n${numbered}`
    : opts.strict
      ? `必须全部翻译成${lang.zhName}，禁止保留任何原文文字。共 ${lines.length} 条，必须输出 ${lines.length} 行，格式「编号. 译文」：\n${numbered}`
      : `示例：\n原文：1. 谢谢大家。\n译文：1. ${lang.sample}\n\n现在逐条翻译下面的字幕，只输出「编号. 译文」，不要原文、不要解释（共 ${lines.length} 条，必须输出 ${lines.length} 行）：\n${numbered}`;
  /* llama.cpp 新版本（b11851）已移除 -no-cnv：
     必须用 -st（单轮，prompt 预置时非交互）+ --simple-io（适配管道 stdin），
     否则 llama-cli 进入会话模式后一直等待 stdin，子进程永不退出。
     --no-display-prompt 只能关掉「生成前的 prompt 打印」，会话回显仍在，
     真正的兜底是 pickTranslation 里的回显剔除。 */
  const args = [
    '-m', model, '-sys', sys, '-p', prompt,
    '-st', '--simple-io', '--no-display-prompt',
    '-n', String(Math.min(2048, 96 + lines.length * 96)),
    '-c', '4096', '-t', String(threads()),
    '--temp', String(opts.strict ? 0.3 : 0.6), '--top-p', '0.8', '--top-k', '20', '--repeat-penalty', '1.05'
  ];
  const { stdout } = await run(bin, args, { timeout: 180000, timeoutMsg: '翻译引擎 3 分钟无响应，已自动终止' });
  return parseNumbered(stdout, lines.length);
}

/** 单句补救：简单提示 → 严格提示 → 换档模型，三次都失败才放弃这一句 */
async function translateOne(text, langId, modelId) {
  const cur = normalizeTranslateModel(modelId);
  const alt = cur === TRANSLATE_LITE ? TRANSLATE_FULL : TRANSLATE_LITE;
  const tries = [
    { model: cur, opts: { simple: true } },
    { model: cur, opts: { strict: true } },
    { model: alt, opts: { strict: true } }
  ];
  for (const t of tries) {
    checkCanceled();
    try {
      const map = await llamaTranslate([text], langId, t.model, t.opts);
      const cand = pickTranslation(map.get(0), text, langId);
      if (cand) return cand;
    } catch (e) {
      if (e && e.message === '已取消') throw e;
    }
  }
  return '';
}

async function translateSegments(segs, langId, emit, from, to, modelId) {
  const lines = segs.map((s) => s.text);
  const out = new Array(lines.length).fill('');
  const dropped = [];
  const batch = 8;
  for (let start = 0; start < lines.length; start += batch) {
    checkCanceled();
    const chunk = lines.slice(start, start + batch);
    let map = null;
    try {
      map = await llamaTranslate(chunk, langId, modelId);
    } catch (e) {
      if (e && e.message === '已取消') throw e;
      map = null;
    }
    if (map) {
      for (let i = 0; i < chunk.length; i += 1) {
        const t = pickTranslation(map.get(i), chunk[i], langId);
        if (t) out[start + i] = t;
      }
    }
    // 批量里漏翻/只回了原文/截断伪影的句子，逐句补翻（每句最多 3 次）
    for (let i = 0; i < chunk.length; i += 1) {
      if (out[start + i]) continue;
      const t = await translateOne(chunk[i], langId, modelId);
      if (t) out[start + i] = t;
      else dropped.push(start + i);
    }
    emit({ percent: from + (to - from) * Math.min(1, (start + chunk.length) / lines.length) });
  }
  if (dropped.length >= lines.length) {
    throw new Error(`翻译引擎未能翻译${langById(langId).name}字幕，请重试；若反复失败，请在「翻译模型档位」切换为高质量 1.5B`);
  }
  return { texts: out, dropped };
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

/* 配音清洁链（3.9.21 重写）：所有模式（克隆 / 近似 / 预置）都要过。
   3.9.19/3.9.20 为了压掉 4.8~8k 的噪声，用的是「两级 afftdn + 侧链去齿音 + 三个 shelf」。
   量到的确是「越来越干净」：en 12/13 的 4.8~8k 相对 300-800Hz 只有 -44~-47dB。
   但用同一把尺量原片真人，这一项是 -18.2dB ——
   **成片比真人闷了 28dB，而且轻的地方被压、响的地方不压**（实测 50ms 倾斜跳变
   16.4dB/s，真人只有 8.0dB/s）。这就是用户反复说「还是有噪音」的听感来源：
   人声被削到发闷、又被逐帧抽吸，听上去就是一层沙沙的颗粒。
   直接拿引擎原样输出（不经任何链）复测，结论完全相反：
     4.8~8k -16.3dB / 8~11k -20.8dB（真人 -18.2 / -20.6）→ 高频本来就跟真人一致
     句间缝隙帧 -104dBFS（真人原片 -35dBFS，那是原片房间底噪）→ 克隆音本身是数字静音
   所以真正制造「噪音」的是这条过重的链：
   - 两级 afftdn（nr=18/24）在低电平处产生「音乐噪声」：实测把句间缝隙从
     -104dBFS 抬到 -61dBFS（+43dB），语音帧倾斜标准差 17.2 → 21.4dB；
   - 侧链去齿音用 4ms/40ms 的增益摆动揉整条高频带，是那种「沙沙抽吸」的来源；
   - 三个 shelf 再叠 -18dB，把高频彻底砍没，人声就闷掉了。
   本版全部改成「稳态处理」，不做任何逐帧增益摆动：
   - highpass=f=80：去掉低频轰鸣与直流偏移
   - lowpass=f=11000：24k 克隆源有效内容到 10k 结束，11k 以上整段砍掉
   - 3.9.24 起这里**不再有 afftdn**。逐级实测：同一句克隆音、同一条链，
     只把 afftdn 放进/移出，噪声段电平只差 1~3dB，但 afftdn 会把已经拉到
     数字静音的段落重新「填」上 -26dBFS 的残余噪声（tn=1 的谱减在纯静音处
     仍按帧估计噪声谱，等于往空白里撒噪点）。克隆音的噪声改由
     electron/denoise.js 的「噪声帧静音」处理（见那边的说明），效果是
     词间气口确认为数字静音，这里只保留限带这条纯线性部分。
   - 4 个窄带 equalizer（下面的 CLEAN_SHELF）：把克隆偏亮的中高频按真人倾斜拉回来
   实测（同一批句子，1/3 倍频程倾斜，相对 300-800Hz；原样输出 → 本链 / 真人）：
     2.5~3.5k  -10.5 → -17.0 / -17.4 dB
     3.5~4.8k  -13.6 → -19.6 / -18.9 dB
     4.8~6k    -16.1 → -20.0 / -19.3 dB
     6~8k      -16.3 → -19.3 / -18.2 dB
     8~11k     -20.8 → -21.5 / -20.6 dB
   即「整条高频与真人一致」，而不是靠砍掉来假装干净。
   缝隙帧（停顿/词间）实测 -84dBFS（原样 -73dBFS、旧链 -61dBFS），
   50ms 倾斜跳变 12.2dB（原样 12.3dB、旧链 14.4dB），不再有抽吸感。 */
const CLEAN_PRE = 'highpass=f=80:poles=2,lowpass=f=11000';

/* 静态高频倒角（名字沿用 CLEAN_SHELF，实际是窄带 equalizer，不是 shelf）：
   窄带（Q=1.1 ≈ 0.9 倍频程）叠加后，2.5k~11k 每个 1/3 倍频程都落在真人 ±1dB 内。
   全程固定增益，没有逐帧变化，所以不会产生「沙沙的抽吸」。 */
const CLEAN_SHELF = 'equalizer=f=2100:width_type=q:width=1.1:g=-3,'
  + 'equalizer=f=3000:width_type=q:width=1.1:g=-4.5,'
  + 'equalizer=f=4300:width_type=q:width=1.1:g=-3,'
  + 'equalizer=f=6200:width_type=q:width=1.1:g=-1.5';

/* 轻压缩：把 threshold 从 0.05 提到 0.25、ratio 从 2.5 降到 2（3.9.17 的关键修正）。
   逐级实测（同一句克隆输出，只看「≥4.8kHz 相对 500-800Hz」的能量，越低越干净）：
     不压缩（只限带+降噪+收口）        -18.8 dB
     + threshold=0.05 ratio=2.5        -13.5 dB   ← 3.9.16 及以前的链路，被抬高 5.3dB
     + threshold=0.25 ratio=2（本版）  -18.5 dB
   旧阈值 0.05 相当于 -26dBFS，整句几乎都落在压缩区：响度归一（-18 LUFS）会给一个
   固定增益，被压下去的语音主体（300~1200Hz）抬不回来，高频底噪相对被抬高 5dB，
   成片听感就是「人声底下一直有一层沙沙」——这就是用户反复反馈的「背景音噪音」。
   0.25（-12dBFS）只压最上面的瞬态：频谱倾斜 -18.8 → -18.5 几乎不变，
   同时仍然能收住克隆偶发的近 0dBFS 尖峰（后面还有 alimiter 兜底）。 */
const COMP = 'acompressor=threshold=0.25:ratio=2:attack=8:release=250';

/** 只测电平用的塑形链：必须和成片实际经过的链逐级一致（限带 + 单级温和降噪
    + 静态倒角 + 轻压缩），否则测出来的噪底/语音电平与成片对不上，噪声门阈值也会跟着偏。
    3.9.21 起这条链全是稳态滤镜，没有任何逐帧增益摆动，测量结果可直接用于定门限。 */
const MEASURE_CHAIN = `${CLEAN_PRE},${CLEAN_SHELF},${COMP}`;

/**
 * 把「主路清洗 + 静态倒角 + 轻压缩」串成线性滤镜片段。
 * 3.9.21 起不再有侧链去齿音：那条 4ms/40ms 的增益摆动本身就是「沙沙抽吸」的来源，
 * 齿音由上面 4 个固定 equalizer 一次性对齐到真人倾斜即可（实测与真人差 ≤1dB）。
 * 返回的字符串以「主路末级」结尾、不带输出标签，调用方自己接后续滤镜与 [out]。
 */
function polishGraph(input) {
  return `${input}${CLEAN_PRE},${CLEAN_SHELF},${COMP}`;
}

/* 静音段增益钳制：单句固定增益之后，本句噪底不得高于这个电平（dBFS）。
   克隆句子的噪底通常在 -48dB 上下，正常放大（+8~+12dB）后落在 -40~-36dB，
   离人声还有近 20dB，听不出来；但偶尔会有气声很重的句子（实测噪底 -35dB），
   一旦按句归一就把它抬到 -24dB，成片里就是「某几句突然一阵沙沙」。
   用这条把「抬噪」封在 -34dB 以内，宁可那几句轻一点。 */
const GAIN_NOISE_CEIL = -34;

/* 3.9.25：每句的停顿噪声门（agate range=0）已移除。
   它只认电平：克隆引擎的气口底噪是 -33dBFS 的低频闷响，比轻声说话还响，门根本不开；
   而 release=500ms 又让门在气口之后迟迟不回开，把下一个音节的起音压掉 6~10dB ——
   用户听到的「说话吞吞吐吐、模模糊糊」有它一份。
   气口噪声现在由 denoise.js 的逐频点谱减 + 整帧电平斜坡处理（-46~-64dBFS，且不留洞）。
   注意：AGATE 这个词不要再用回来，也不要用 anlmdn。 */

/* ---------------- 音色频带对齐（仅预置/近似模式） ----------------
   3.9.22 起克隆模式不再走这条链：静态倒角 CLEAN_SHELF 已按克隆引擎实测标定
   （2.5k~11k 与真人差 ≤1dB），而这条自适应 EQ 的 4 个中心只隔 0.5 倍频程、
   限幅又各自独立，残差为负时会在 4.8~8k 叠出 3~6dB 的额外衰减（日文实测 4.6dB），
   同一句不同语种音色就不一致。克隆模式统一交给静态倒角。
   系统音色（预置/近似）没有标定过，仍用这里的自适应对齐：
   本地克隆引擎（Chatterbox，24kHz）逐句生成的语音，比原片真人嗓音在 3~10kHz
   高 2~3dB，且 300~1200Hz 偏薄（整片实测：成片 800-1200Hz 比真人低 6.8dB）。
   这里量「原片参考音」与「本次合成里最长的一句」的倍频带能量差，反推一组小 EQ。
   3.9.17 的两个修正（3.9.16 的对齐几乎没动高频，原因就在这里）：
   1）量参考音时必须用「实测噪底 + 8dB」当门限。旧版写死 agate threshold=0.01
      （≈ -40dB），而本片原片的房间噪底就有 -36dB —— 门限比噪底还低，等于没门，
      于是参考音的噪声能量全被算进 4.8~10kHz 的带能量里，克隆的高频看起来「不高」，
      EQ 对高频一刀都没切（实测 3.9.16 的 EQ 只有 250/500/1000 三个带），
      成片 ≥4.8kHz 相对能量 -13.2dB，比真人原片（-15.8dB）还高 2.6dB。
   2）锚点改成「≤2000Hz 的 5 个语音核心带」的均值，而不是全带均值：全带均值里
      混进了 6~10k 的噪声能量，会把高频倾斜整个抵消掉。
   限制：1000Hz 以上只许减不许加（加 = 把嘶声一起抬起来），3k 以上最多 -4dB、
   4.8k 以上最多 -3dB；3k 以下最多 -4dB / +2dB（低频与中频只补不足）。
   EQ 量为空（参考音不可用/量不出来）时整链退回原样，绝不让任务因它失败。 */
const EQ_CENTERS = [125, 250, 500, 1000, 2000, 3000, 4500, 6500, 9000];
const EQ_ANCHOR_MAX = 2000;

/** 量一段语音在若干倍频带内的电平（dB）。用 agate 先把停顿压掉，
    只统计「真的在说话」的帧——否则一段很长的静音会把所有频带一起拉低。
    floorDb：该文件的实测噪底（20ms 帧的 12% 分位）。门限取 floorDb+8，
    这样「噪底高的原片」和「噪底极低的克隆音」都在各自同一套标准下统计。 */
async function bandLevels(file, floorDb) {
  if (!file || !fs.existsSync(file)) return null;
  const thr = Number.isFinite(floorDb) ? Math.max(-70, Math.min(-20, floorDb + 8)) : -40;
  const gate = `agate=threshold=${Math.pow(10, thr / 20).toFixed(5)}:ratio=8:range=0:attack=5:release=10`;
  const rows = await Promise.all(EQ_CENTERS.map(async (c0) => {
    let out = '';
    try {
      await runFf(['-hide_banner', '-nostats', '-i', file, '-af',
        `${gate},bandpass=f=${c0}:width_type=o:width=1,astats=metadata=0`,
        '-f', 'null', '-'], (l) => { out += l + '\n'; });
    } catch (_) {
      return null;
    }
    const hits = out.match(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/g) || [];
    if (!hits.length) return null;
    const v = Number(String(hits[hits.length - 1]).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(v) ? v : null;
  }));
  return rows.every((v) => v != null) ? rows : null;
}

/** 由两段语音的倍频带电平差生成矫正 EQ；只修「音色倾斜」，不碰整体响度。
    锚点只用 ≤2000Hz 的语音核心带（见上面的说明），限幅见上。 */
function eqAlignChain(refBands, ttsBands) {
  if (!refBands || !ttsBands || refBands.length !== EQ_CENTERS.length) return '';
  const ai = EQ_CENTERS.map((c0, i) => (c0 <= EQ_ANCHOR_MAX ? i : -1)).filter((i) => i >= 0);
  const pick = (a) => ai.reduce((n, i) => n + a[i], 0) / ai.length;
  const mr = pick(refBands);
  const mt = pick(ttsBands);
  const parts = [];
  EQ_CENTERS.forEach((c0, i) => {
    let g = (refBands[i] - mr) - (ttsBands[i] - mt);
    const lo = c0 < 3000 ? -4 : c0 < 4800 ? -4 : -3;
    const hi = c0 < 3000 ? 2 : c0 < 4800 ? 0 : 0;
    g = Math.max(lo, Math.min(hi, g));
    if (Math.abs(g) < 0.4) return;
    parts.push(`equalizer=f=${c0}:width_type=o:width=1:g=${g.toFixed(2)}`);
  });
  return parts.join(',');
}

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

/** 整轨响度收口：测一次 LUFS，只给**一个固定增益**（不泵动、不抬噪）。
    逐段归一之后整轨再校一次，保证同一批片子的每种语言出口响度一致；
    增益限在 ±6dB 以内，测量失败时原样保留，绝不让任务因此失败。 */
async function normalizeTrack(file, targetLufs = -18) {
  let lufs = null;
  try {
    lufs = await measureLufs(file);
  } catch (_) {
    return 0;
  }
  if (lufs == null || lufs < -70 || !Number.isFinite(lufs)) return 0;
  const gain = Math.max(-6, Math.min(6, targetLufs - lufs));
  if (Math.abs(gain) < 0.4) return 0;
  const tmp = `${file}.gain.wav`;
  try {
    await runFf(['-y', '-i', file, '-af', `volume=${gain.toFixed(2)}dB`,
      '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', tmp]);
    fs.renameSync(tmp, file);
    return gain;
  } catch (_) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    return 0;
  }
}

/** 单句电平：先「测量」，再给一个「固定增益」。
    以前每句直接跑单遍 loudnorm（动态模式），它会在句内不停改增益：
    停顿、气口、句首尾的底噪被一起抬起来，听感就是「呼吸声」「底噪一阵一阵」。
    现在改成「先测后给固定增益」，既不泵动，也不会把底噪放大。
    顺带在同一遍里拿到「分帧 RMS 分布」：停顿处的噪底与语音电平，
    交给下面的噪声门去定阈值，一次 ffmpeg 同时解决增益与噪底两件事。 */
async function measureSegment(file) {
  let out = '';
  const chain = [
    MEASURE_CHAIN,
    // 统一成 23ms 帧再统计：wav 解复用出来的帧是 4096 样本（93ms），
    // 1.5 秒的短句只有 17 帧，0.9 分位会直接跳到最响的一帧、0.12 分位落进语音里
    'asetnsamples=n=1024',
    'astats=metadata=1:reset=1',
    'ametadata=print:key=lavfi.astats.Overall.RMS_level',
    'loudnorm=I=-18:TP=-2:LRA=9:print_format=json'
  ].filter(Boolean).join(',');
  try {
    await runFf(['-hide_banner', '-nostats', '-i', file, '-af', chain, '-f', 'null', '-'], (l) => { out += l + '\n'; });
  } catch (e) {
    out += String((e && e.message) || '');
  }
  const lufsM = out.match(/"input_i"\s*:\s*"?(-?[0-9.]+)"?/);
  const lufs = lufsM ? Number(lufsM[1]) : null;
  const frames = [];
  out.split(/\r?\n/).forEach((line) => {
    const m = line.match(/RMS_level=(-?\d+(?:\.\d+)?)/);
    if (m) frames.push(Number(m[1]));
  });
  frames.sort((a, b) => a - b);
  const at = (q) => (frames.length ? frames[Math.min(frames.length - 1, Math.max(0, Math.floor(q * frames.length)))] : null);
  const speech = at(0.9);
  /* 噪底只认「比语音电平低 12dB 以上」的帧 —— 真正的气口/底噪。
     3.9.29 用的是 0.12 分位：1.5 秒的短句里只有 17 个 93ms 帧，第 2 帧还是语音，
     噪底被读成 -29dB，随后的「-34dB 封顶」把这一句的增益从 +3.4dB 砍到 -8.4dB，
     整句比邻句轻 11dB —— 这正是用户听到的「声音忽大忽小」的主因。
     找不到足够的气口帧（句子太短/太连续）时不设噪底，宁可少封顶也不误伤。 */
  let floor = null;
  if (speech != null) {
    const quiet = frames.filter((v) => v < speech - 12);
    if (quiet.length >= 4) floor = quiet[Math.floor(quiet.length / 2)];
  }
  return { lufs, floor, speech, frames: frames.length };
}

/** 3.9.25：gateDb 已随每句 agate 一起移除（见上方 noiseGate 注释）。
    留一句说明，避免后来者又按「噪底+12dB / 语音-18dB」把门加回来：
    那条阈值在克隆音上只比语音低 10dB，会把弱辅音、气口、词尾切成数字零碎片。 */

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

let sapiCache = null;
/** 枚举 Windows 已安装的 SAPI 音色（3.9.27 起与 macOS 的 `say -v ?` 对齐） */
function listSapiVoices() {
  if (sapiCache) return Promise.resolve(sapiCache);
  return new Promise((resolve) => {
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      "$s.GetInstalledVoices() | ForEach-Object { if ($_.Enabled) { '{0}|{1}|{2}' -f $_.VoiceInfo.Name, $_.VoiceInfo.Culture.Name, $_.VoiceInfo.Gender } };",
      '$s.Dispose();'
    ].join(' ');
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      sapiCache = sapi.parseSapiVoices(out);
      resolve(sapiCache);
    });
  });
}

/** 各语言的可用优质音色（已按听感排序，剔除卡通/机器人音色） */
async function voiceCatalog() {
  const out = {};
  if (isWin) {
    const rows = await listSapiVoices();
    LANGS.forEach((l) => {
      const list = rows.filter((r) => sapi.cultureLang(r.culture) === l.win).map(sapi.voiceEntry);
      out[l.id] = {
        default: list.length ? sapi.chooseVoice(rows, l.win) : null,
        list: list.length ? list : [sapi.DEFAULT_ENTRY]
      };
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
  const cat = await voiceCatalog();
  const entry = cat[langId];
  if (!entry || !entry.list.length) return null;
  if (isWin) {
    const rows = await listSapiVoices();
    const lang = langById(langId);
    const picked = rows.length ? sapi.chooseVoice(rows, lang ? lang.win : langId, '', gender) : null;
    return picked || entry.default || null;
  }
  if (gender) {
    const hit = entry.list.find((v) => v.gender === gender);
    if (hit) return hit.name;
  }
  return entry.default;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function synthWin(text, outFile, langId, voiceOverride) {
  const txt = outFile.replace(/\.wav$/i, '.txt');
  fs.writeFileSync(txt, text, 'utf8');
  const culture = langById(langId).win;
  // undefined = 自动挑（与 macOS 侧一致）；空串/指定名 = 按用户选择
  const voice = voiceOverride === undefined ? await pickVoice(langId) : voiceOverride;
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    `$name = ${psQuote(voice || '')};`,
    `if (-not $name) { $x = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like '${culture}*' } | Select-Object -First 1; if ($x) { $name = $x.VoiceInfo.Name } }`,
    // 选不上的音色（语言包被卸载等）不要整句失败，退回系统默认继续读
    'if ($name) { try { $s.SelectVoice($name) } catch { } }',
    '$s.Rate = 0;',
    `$s.SetOutputToWaveFile(${psQuote(outFile)});`,
    `$s.Speak([System.IO.File]::ReadAllText(${psQuote(txt)}, [System.Text.Encoding]::UTF8));`,
    '$s.Dispose();'
  ].join(' ');
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return voice || '';
}

async function synth(text, outFile, langId, voiceOverride) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('空文本');
  if (isWin) return synthWin(clean, outFile, langId, voiceOverride);
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

/* ---------------- 克隆配音降噪（3.9.24） ----------------
   克隆引擎在词间/句尾会输出一段宽带噪声（实测 -28~-36dBFS、谱平坦度 -5~-12dB），
   按句归一到 -18 LUFS 后这段噪声被抬到 -20~-26dBFS；旧链的噪声门阈值封顶 -50dBFS，
   电平上根本分不开（噪声甚至比轻声说话还响），所以短气口一路漏进成片。
   处理放在「每句合成完、进入清洁链之前」：用「电平 + 自相关周期性 + 高频占比」
   三条判据找出纯噪声帧，再用 11.6ms 斜坡把整段拉到数字静音（见 electron/denoise.js）。
   识别不出来就原样返回，绝不因为降噪失败而中断整条任务。 */
const DENOISE_RATE = 44100;

function decodeFloat(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegMod.getFfmpegPath(), [
      '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(DENOISE_RATE),
      '-f', 'f32le', 'pipe:1'
    ], { windowsHide: true });
    if (activeJob && activeJob.children) activeJob.children.add(child);
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('配音解码失败'));
        return;
      }
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 4);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i += 1) pcm[i] = buf.readFloatLE(i * 4);
      resolve(pcm);
    });
  });
}

/** 句内长气口折叠：克隆引擎会在同一句里插 0.3~2.4 秒的停顿（实测），
    听感就是断成两截。3.9.30 只认「数字静音」（|v|<1e-3，即 -60dBFS 以下），
    而 denoise 只把「比语音低 15dB 且连续 ≥350ms」的深静音拉到零 ——
    所以**带一点残余噪声的中等气口（-50~-40dBFS）全都漏了过去**，句子中间
    仍然一段一段地空。这里改成按帧电平判定：本句语音电平（90% 分位）以下 26dB
    持续 ≥0.26s 就算气口，保留 0.15s、其余折掉。26dB 的门限离轻声字还有余量，
    句末的真气声不会被吃掉（那通常是 -20~-30dBFS，远高于门限）。
    只做样本搬移，不重采样、不加滤波器，语音一个样本都不动。 */
function tightenPauses(pcm, rate) {
  const sr = Number(rate) > 0 ? Number(rate) : DENOISE_RATE;
  const n = pcm.length;
  const fl = Math.round(0.020 * sr);        // 20ms 帧
  if (n < fl * 12) return pcm;
  const frames = Math.floor(n / fl);
  const lv = new Float64Array(frames);
  for (let k = 0; k < frames; k += 1) {
    let e = 0;
    for (let i = 0; i < fl; i += 1) { const v = pcm[k * fl + i]; e += v * v; }
    lv[k] = 10 * Math.log10(e / fl + 1e-30);
  }
  const sorted = Array.prototype.slice.call(lv).sort((a, b) => a - b);
  const speech = sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))];
  if (!(speech > -70)) return pcm;
  const thr = speech - 26;
  const minRun = Math.round(0.26 * sr);
  const keepRun = Math.round(0.15 * sr);
  const runs = [];
  let removed = 0;
  let k = 0;
  while (k < frames) {
    if (lv[k] >= thr) { k += 1; continue; }
    let j = k;
    while (j < frames && lv[j] < thr) j += 1;
    const a = k * fl;
    const b = Math.min(n, j * fl);
    if (b - a >= minRun) {
      runs.push([a, b]);
      removed += (b - a) - keepRun;
    }
    k = j;
  }
  if (!runs.length) return pcm;
  const out = new Float32Array(n - removed);
  let src = 0;
  let dst = 0;
  for (const [a, b] of runs) {
    out.set(pcm.subarray(src, a), dst);
    dst += a - src;
    dst += keepRun;
    src = b;
  }
  if (src < n) out.set(pcm.subarray(src), dst);
  return out;
}

/** 把一句克隆音做「谱减 + 句尾裁剪 + 长气口折叠 + 句内响度拉平」，
    返回可继续进清洁链的文件路径。
    响度拉平放在最后：先用 denoise 把气口压成静音，再把有语音的段落按 450ms
    慢包络拉平，这样「一个字一个字音量不一样」被修掉，气口也不会被 AGC 抬起来。 */
async function cleanCloneVoice(raw, out) {
  const pcm = await decodeFloat(raw);
  const r = denoise.suppressNoise(pcm, DENOISE_RATE);
  const tight = tightenPauses(r.pcm, DENOISE_RATE);
  const flat = denoise.flattenLevel(tight, DENOISE_RATE);
  denoise.writeWavS16(out, flat, DENOISE_RATE);
  return {
    file: out,
    mutedSec: r.mutedSec,
    spans: r.spans,
    trimmedSec: r.trimmedSec,
    noiseFrames: r.noiseFrames,
    collapsedSec: Number(((r.pcm.length - tight.length) / DENOISE_RATE).toFixed(3))
  };
}

/** 配音进度桥：把「逐句完成」和「句内 token 进度」合成一个只增不减的百分比
 *
 *  以前一句克隆要跑 1~2 分钟，进度条只在「整句完成」时跳一格，五分钟才动 2%，
 *  看上去就是「卡在 26% 不动」。现在三段信息都用起来：
 *  - 每句按文字长度分权重（≈ 语音长度），长句占的份额大，整段推进才匀速；
 *  - worker 逐 token 回报「本句已生成多少 / 上限多少」，句内就能持续推进；
 *  - 并发合成多句时按各自进度累加，句与句不会互相盖住。
 *  没有 token 进度（云端音色 / 旧版 worker）时退回「本句已用时」推近 97%。 */
function makeTtsProgress({ weights, ttsFrom, ttsWidth, langEmit, totalSegs }) {
  const wsum = Math.max(1, weights.reduce((a, b) => a + b, 0));
  const inflight = new Map();
  let doneW = 0;
  let shown = ttsFrom;
  const emit = (frac, detail) => {
    const f = Math.max(0, Math.min(1, frac));
    // 只增不减：并发回传的顺序是无序的，进度条绝不能往回退
    shown = Math.max(shown, ttsFrom + ttsWidth * f);
    langEmit('合成配音', 'tts', shown, detail || '');
  };
  return {
    // 整句完成（buildNarration 回传 percent = 已完成权重占比，index = 句子下标）
    onDone(p) {
      const f = Math.min(1, (Number(p && p.percent) || 0) / 100);
      doneW = wsum * f;
      if (p && p.index != null) inflight.delete(p.index);
      emit(f, (p && p.detail) || '');
    },
    // 句内 token 进度
    onProgress(tag, tokens, cap) {
      if (tag == null || !(Number(cap) > 0) || tag < 0 || tag >= weights.length) return;
      inflight.set(tag, Math.min(0.97, Math.max(0, Number(tokens) / Number(cap))));
      let part = 0;
      inflight.forEach((v, k) => { part += weights[k] * v; });
      const pct = Math.round((Number(tokens) / Number(cap)) * 100);
      emit((doneW + Math.min(part, wsum - doneW)) / wsum,
        `第 ${tag + 1}/${totalSegs} 句 · 合成 ${Math.min(100, pct)}%`);
    },
    // 心跳兜底：无 token 进度时按本句用时推近
    onBeat(tag, sec) {
      const s = Math.max(0, Number(sec) || 0);
      const known = tag != null && weights[tag];
      const w = known ? weights[tag] : wsum / Math.max(1, totalSegs);
      const creep = 0.97 * (1 - Math.exp(-s / 100));
      emit((doneW + w * creep) / wsum,
        known ? `第 ${tag + 1}/${totalSegs} 句 · 已生成 ${Math.round(s)}s`
          : `合成中 · 已生成 ${Math.round(s)}s`);
    },
    sink(info) {
      if (!info) return;
      if (info.tokens != null) this.onProgress(info.tag, info.tokens, info.cap);
      else if (info.elapsed != null) this.onBeat(info.tag, info.elapsed);
    }
  };
}

/* 语音电平目标（dBFS，分帧 RMS 的 0.9 分位）。
   3.9.29 按「整句 LUFS -18」归一，再给相邻句 ±3dB 台阶：短句、带长停顿的句子
   LUFS 天然偏低，同一段配音会被算成 +10dB；而台阶又把差值一路「记住」，
   增益越走越偏 —— 听众听到的就是「声音忽大忽小」。
   这里改成只看「真正在说话的帧」（astats 分帧 RMS 的 0.9 分位），
   停顿多寡完全不影响定位；跨句不再有任何台阶/惯性。 */
const TARGET_SPEECH_DB = -15.5;

/** 单句固定增益：把语音电平拉到统一目标，噪底封顶
 *  口播与视频翻译两条配音链共用这一份判定，音色/响度口径才不会分叉。 */
function segmentGain(level) {
  if (!level) return 0;
  let gain;
  if (Number.isFinite(level.speech) && level.speech > -70) {
    gain = TARGET_SPEECH_DB - level.speech;
  } else if (Number.isFinite(level.lufs) && level.lufs > -70) {
    // 没有分帧数据时退回整句 LUFS 口径（实测 p90 语音电平 ≈ LUFS + 2.5dB）
    gain = -18 - level.lufs;
  } else {
    // 几乎没有有效语音：不放大，避免把整段底噪拉满
    return 0;
  }
  gain = Math.max(-24, Math.min(12, gain));
  // 静音段增益钳制：把「本句噪底抬升后」的水位钉在 -34dBFS 以内
  if (Number.isFinite(level.floor)) gain = Math.min(gain, GAIN_NOISE_CEIL - level.floor);
  return gain;
}

/* 裁掉一段合成语音首尾的静音（只裁 -45dB 以下的边缘，保留气口）。
   返回裁后文件；裁不动或裁得太短（可能整段没声）则退回原文件。 */
async function trimSpeechEdges(src, out) {
  const chain = 'silenceremove=start_periods=1:start_duration=0.03:start_threshold=-45dB,'
    + 'areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-45dB,areverse';
  await runFf(['-y', '-i', src, '-af', chain, '-ac', '1', '-ar', '44100',
    '-c:a', 'pcm_s16le', out]);
  return wavDuration(out) >= 0.15 ? out : src;
}

/* 混读：把夹在中文/日文/韩文里的拉丁缩写按「目标语言的字母名」读出来。
   克隆引擎是按 language_id 决定的发音体系：language_id=zh 时把 "AI" 直接按拼音
   念成「爱」，把 "GPT" 念成一个不存在的拼音串 —— 这就是用户听到的「AI 这个词读错了」。
   做法：只在合成文本里把**独立的大写缩写**（AI / GPT / 5G / 单个字母）展开成字母名，
   其余英文单词（iPhone、TikTok、Hello）原样保留，模型本来就按英文读；
   字幕始终用原文，不会被这段转写污染。 */
const LETTER_NAMES = {
  zh: {
    A: '诶', B: '必', C: '西', D: '迪', E: '伊', F: '艾弗', G: '吉', H: '艾尺', I: '艾',
    J: '杰', K: '开', L: '艾勒', M: '艾姆', N: '恩', O: '欧', P: '皮', Q: '丘', R: '阿尔',
    S: '艾斯', T: '提', U: '优', V: '维', W: '达不溜', X: '艾克斯', Y: '歪', Z: '泽'
  },
  ja: {
    A: 'エー', B: 'ビー', C: 'シー', D: 'ディー', E: 'イー', F: 'エフ', G: 'ジー', H: 'エイチ',
    I: 'アイ', J: 'ジェー', K: 'ケー', L: 'エル', M: 'エム', N: 'エヌ', O: 'オー', P: 'ピー',
    Q: 'キュー', R: 'アール', S: 'エス', T: 'ティー', U: 'ユー', V: 'ブイ', W: 'ダブリュー',
    X: 'エックス', Y: 'ワイ', Z: 'ゼット'
  },
  ko: {
    A: '에이', B: '비', C: '씨', D: '디', E: '이', F: '에프', G: '지', H: '에이치',
    I: '아이', J: '제이', K: '케이', L: '엘', M: '엠', N: '엔', O: '오', P: '피',
    Q: '큐', R: '알', S: '에스', T: '티', U: '유', V: '브이', W: '더블유',
    X: '엑스', Y: '와이', Z: '제트'
  }
};

/** 合成用文本：CJK 语种下把独立大写缩写展开成字母名，其他语种原样返回 */
function speakableText(text, langId) {
  const src = String(text || '');
  const names = LETTER_NAMES[String(langId || '').toLowerCase()];
  if (!names) return src;
  // (前面不是字母数字) + (可选数字) + (一串大写字母) + (后面不是字母数字)
  // "5G" 一起匹配；"OpenAI" / "iPhone" / "TikTok" 里的字母不连续或大小写混合，不会命中
  return src.replace(/(^|[^A-Za-z0-9])(\d*)([A-Z]{1,})(?![A-Za-z0-9])/g, (m, pre, digits, caps) => {
    let out = pre + digits;
    for (const ch of caps) out += names[ch] || ch;
    return out;
  });
}

/* ---------------- AI 视频翻译：连续语流拼接（3.9.29） ----------------
   逐句克隆有三个听感硬伤，会同时表现为「断断续续 + 不自然」：
   1) 每一句都被当成新句子从零起调：句尾降调、句首重音重置，句子越短越像念稿；
   2) 生成上限按「字幕窗口 ×1.5」算，译文一长就在句子中途被 token 上限截断；
   3) 为了塞回窗口，每句单独 atempo 最高 1.25，再顶不住就在窗口末尾淡出硬切，
      词尾被削掉——这正是用户听到的「断断续续」。
   视频翻译不需要配音逐句对齐字幕（字幕是单独一条轨），所以这里换一套拼法：
   相邻短句先并成「一个完整句」再合成（句调连贯、不被 token 截断），
   再用自然停顿串成一条连续音轨，全片最多做一次轻微整体变速（≤1.35），
   最后按实际语音时长重映射字幕时间轴。 */

/** 相邻短句合并成「语段」：只用于合成，字幕条目保持原样 */
function groupForFlow(segs, langId) {
  const CJK = langId === 'zh' || langId === 'ja' || langId === 'ko';
  const units = [];
  for (const seg of segs) {
    const text = String((seg && seg.text) || '').trim();
    if (!text) continue;
    const last = units[units.length - 1];
    // 只并「停顿短、整体不长」的相邻句：并得太长会让单句生成时间翻倍，
    // 而且字幕只能按字位比例摊到语段里，语段越长、每条字幕的漂移越大（实测长语段
    // 末尾能差半句）。3.9.31 把上限收到 60 字（西文 120 字符），兼顾连贯与对齐。
    const mergeCap = CJK ? 60 : 120;
    const canMerge = !!last
      && (Number(seg.start) - last.end) <= 0.4
      && (last.text.length + text.length) <= mergeCap
      && (Number(seg.end) - last.start) <= 8;
    if (canMerge) {
      // 西文并句必须补空格，否则合成出来的两个词会黏成一个（"there.How" 读错）；
      // 中日韩本身不用空格，直接拼
      const sep = CJK ? '' : ' ';
      last.cues.push({
        start: Number(seg.start), end: Number(seg.end), text, offset: last.text.length + sep.length
      });
      last.text += sep + text;
      last.end = Number(seg.end);
    } else {
      units.push({
        start: Number(seg.start),
        end: Number(seg.end),
        text,
        cues: [{ start: Number(seg.start), end: Number(seg.end), text, offset: 0 }]
      });
    }
  }
  return units.filter((u) => u.text);
}

/** 连续语流配音：合成 → 逐段清洁/增益 → 自然停顿串接 → 全片最多一次轻微变速 */
async function buildFlowNarration(units, duration, langId, dir, emit, opts = {}) {
  const ttsDir = path.join(dir, `tts-flow-${langId}`);
  fs.mkdirSync(ttsDir, { recursive: true });
  if (!units.length) throw new Error('该片段没有可用语音');

  const weights = units.map((u) => Math.max(3, u.text.length));
  const wsum = Math.max(1, weights.reduce((a, b) => a + b, 0));
  let doneWeight = 0;
  let fallbackUsed = 0;
  let truncatedUsed = 0;
  const raws = new Array(units.length);

  /* 1) 合成：上限按「这段话要说多久」算，不再按字幕窗口算 —— 句子必须说完 */
  const workers = Math.max(1, Math.min(opts.synthConcurrency || 1, units.length));
  const order = units.map((_, i) => i)
    .sort((a, b) => (units[b].end - units[b].start) - (units[a].end - units[a].start));
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = order[next];
      next += 1;
      if (i == null) return;
      checkCanceled();
      const unit = units[i];
      // 混读：字幕保持原文，送进合成的是「字母名展开版」（AI → 诶艾 / エーアイ / 에이아이）
      const spokenText = speakableText(unit.text, langId);
      // 按展开后的字数估时长：缩写多的句子（AI、GPT、API）展开后会明显变长，
      // 仍按原文字数算会把 token 上限给小、句子被截断
      const chars = Math.max(4, spokenText.length);
      // 克隆引擎每秒约 25 个语音 token，按语速估「这句话要说多久」，
      // 再给 1.35 倍余量：上限给小了会在句中截断（听感就是「半句没了」）
      const estSec = chars / (langId === 'zh' || langId === 'ja' || langId === 'ko' ? 4 : 15);
      const maxTokens = Math.min(1400, Math.round(25 * estSec * 1.35) + 24);
      const maxSeconds = Math.min(600, Math.max(60, Math.round(estSec * 22) + 60));
      const raw = path.join(ttsDir, `${i}.wav`);
      // 「说完没说完」不能靠感觉：克隆模型偶尔会提前停（或撞上 token 上限），
      // 这一句的后半截就没了，而字幕照常显示 —— 用户看到的就是「有字幕没声音」。
      // 判据：命中 token 上限，或时长明显短于「这段话最快也要说多久」，就带更大的
      // 上限重生成一次（同一路径覆盖），仍不完整才接受，并在日志里计数。
      const fastSec = chars / (langId === 'zh' || langId === 'ja' || langId === 'ko' ? 7 : 22);
      const needSec = Math.max(0.35, fastSec * 0.8);
      try {
        if (opts.synthFn) {
          let r = await opts.synthFn(spokenText, raw, i, { maxTokens, maxSeconds, tag: i });
          const dur0 = wavDuration(raw);
          if ((r && r.truncated) || dur0 < needSec) {
            const retryTokens = Math.min(1400, Math.max(maxTokens + 64, Math.round(maxTokens * 1.8)));
            const r2 = await opts.synthFn(spokenText, raw, i, { maxTokens: retryTokens, maxSeconds, tag: i });
            if (r2 && r2.truncated) truncatedUsed += 1;
          }
        } else {
          await synth(spokenText, raw, langId, opts.voice);
          if (wavDuration(raw) < needSec) {
            await synth(spokenText, raw, langId, opts.voice);
          }
        }
      } catch (e) {
        checkCanceled();
        if (!opts.allowFallback) throw e;
        fallbackUsed += 1;
        await synth(spokenText, raw, langId, undefined);
      }
      raws[i] = raw;
      done += 1;
      doneWeight += weights[i];
      emit({
        percent: 100 * (doneWeight / wsum),
        index: i,
        detail: `第 ${done}/${units.length} 段${truncatedUsed ? ` · ${truncatedUsed} 段截断` : ''}`
      });
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));

  /* 2) 逐段清洁与电平 */
  const spoken = new Array(units.length).fill(0);
  const gains = new Array(units.length).fill(0);
  const levels = new Array(units.length);
  const sources = new Array(units.length);
  for (let i = 0; i < units.length; i += 1) {
    checkCanceled();
    let src = raws[i];
    if (opts.synthFn) {
      try {
        const dn = await cleanCloneVoice(raws[i], path.join(ttsDir, `${i}-clean.wav`));
        if ((dn.spans > 0 || dn.trimmedSec > 0 || dn.collapsedSec > 0) && fs.existsSync(dn.file)) src = dn.file;
      } catch (_) {
        src = raws[i];
      }
    }
    // 裁掉合成结果首尾的静音（TTS/clone 都会在文件尾垫几百毫秒），
    // 否则这段底噪会被算进「语音时长」，再叠上一段气口，就成了一处明显的空档。
    // 只裁 -45dB 以下的边缘，轻声的气口与句内停顿都保留。
    try {
      src = await trimSpeechEdges(src, path.join(ttsDir, `${i}-trim.wav`));
    } catch (_) { /* 裁不动就用原文件 */ }
    const level = await measureSegment(src);
    levels[i] = level;
    spoken[i] = Math.max(0.3, wavDuration(src) || (units[i].end - units[i].start));
    sources[i] = src;
  }

  /* 电平统一：所有语段都用同一个「语音电平 → 固定目标」的映射，
     不跨句累积、不设台阶（3.9.29 的 ±3dB 台阶会让增益一路走偏）。 */
  for (let i = 0; i < units.length; i += 1) gains[i] = segmentGain(levels[i]);

  /* 3) 时间轴：连续语流 —— 不把配音锚回原片句首。
     3.9.29 按每个语段的原片起点定位，原片的长停顿（实测 1~3 秒）被原样保留，
     听感就是「说一句、停两秒、再说一句」。现在改成：
     语段之间只留「按原片停顿折算、夹在 0.12~0.5 秒」的呼吸口，
     整片只做一次变速（超长最多 1.20×，偏短最多放慢到 0.90×）把画面填满。 */
  const pauses = [];
  for (let i = 0; i < units.length - 1; i += 1) {
    const gap = Number(units[i + 1].start) - Number(units[i].end);
    const want = Number.isFinite(gap) && gap > 0 ? gap : 0.2;
    pauses.push(Math.max(0.12, Math.min(0.5, want)));
  }

  const MIN_TEMPO = 0.94;
  const MAX_TEMPO = 1.20;
  const MAX_PAUSE = 0.55;     // 呼吸口最多放到 0.55s：再长就又变成「一句一断」
  const safeDur = Math.max(0.1, duration);

  // 同一份气口数组按不同「缩放 / 额外量」重排时间轴
  const layout = (scale, extra) => {
    const arr = new Array(units.length).fill(0);
    let at = Math.max(0, Math.min(0.2, Number(units[0].start) || 0));
    for (let i = 0; i < units.length; i += 1) {
      arr[i] = at;
      at += spoken[i] + (i < pauses.length ? Math.min(MAX_PAUSE, pauses[i] * scale + extra) : 0);
    }
    return { starts: arr, total: arr[units.length - 1] + spoken[units.length - 1] };
  };

  let played = layout(1, 0);
  let starts = played.starts;
  let total = played.total;

  /* 配音比片子短时，3.9.30 是「先把整片放慢到 0.90，再 apad 出一大段片尾静音」。
     放慢会把声音拖长、咬字发黏，片尾又挂几秒空白，两个都不自然。
     现在先把这个富余时长摊进语段间的呼吸口（每个最多 1.0s），让语速保持原样；
     摊不下才允许极轻微放慢（最低 0.94）。 */
  if (total < duration && pauses.length) {
    const add = Math.min(duration - total, pauses.length * (MAX_PAUSE - 0.12)) / pauses.length;
    played = layout(1, add);
    starts = played.starts;
    total = played.total;
  }

  let tempo = Math.max(MIN_TEMPO, Math.min(MAX_TEMPO, total / safeDur));
  if (total / tempo > duration + 0.05 && pauses.length) {
    // 到 1.20 还放不下：先按比例压缩气口（最小 0.08s），再允许最后一次轻微变速
    const over = total / tempo - duration;
    const gapSum = pauses.reduce((a, b) => a + b, 0);
    const minSum = 0.08 * pauses.length;
    const cut = Math.min(over * tempo, Math.max(0, gapSum - minSum));
    const keep = gapSum > 0 ? (gapSum - cut) / gapSum : 1;
    played = layout(keep, 0);
    starts = played.starts;
    total = played.total;
    tempo = Math.max(MIN_TEMPO, Math.min(1.35, total / safeDur));
  }

  /* 4) 一段一张滤镜：清洁链 + 固定增益 + 限幅 + 首尾微淡入淡出 + 补静音定位 */
  const inputs = [];
  const filters = [];
  const labels = [];
  for (let i = 0; i < units.length; i += 1) {
    const s = sources[i];
    const durI = spoken[i];
    const fadeIn = 0.012;
    const fadeOut = Math.min(0.05, Math.max(0.02, durI * 0.04));
    const parts = [
      polishGraph(`[${inputs.length}:a]`),
      `volume=${gains[i].toFixed(2)}dB`,
      'alimiter=limit=0.85:attack=2:level=false',
      `afade=t=in:st=0:d=${fadeIn.toFixed(3)}`
    ];
    if (durI > fadeOut + 0.02) {
      parts.push(`afade=t=out:st=${(durI - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
    }
    const slot = (i + 1 < units.length ? starts[i + 1] : starts[i] + durI) - starts[i];
    parts.push(`apad=whole_dur=${slot.toFixed(3)}`);
    parts.push(`adelay=${Math.round(starts[i] * 1000)}:all=1`);
    filters.push(`${parts.join(',')}[a${i}]`);
    inputs.push(s);
    labels.push(`[a${i}]`);
  }

  const post = [
    // 放慢和加速都要真的执行：3.9.29 只在 tempo>1 时接 atempo，
    // 译文比原片短时仍然按 1.0 播放，片尾直接断掉。现在轻微放慢（最低 0.90×）也算一次变速。
    Math.abs(tempo - 1) > 0.005 ? `atempo=${tempo.toFixed(3)}` : '',
    'aresample=44100',
    'alimiter=limit=0.89:attack=2:level=false',
    `apad=whole_dur=${duration.toFixed(3)}`,
    `atrim=0:${duration.toFixed(3)}`
  ].filter(Boolean).join(',');
  // 只有一段时末尾就是输入标签 [a0]，它后面必须**直接**接滤镜；
  // 写成 `[a0],atempo…` 会多出一个空滤镜名，ffmpeg 直接报 "No such filter: ''"（整条任务失败）。
  const head = inputs.length > 1
    ? `${labels.join('')}amix=inputs=${inputs.length}:normalize=0:duration=longest,${post}`
    : `${labels[0]}${post}`;
  const voiceFile = path.join(dir, `voice-${langId}.wav`);
  const filter = `${filters.join(';')};${head}[out]`;
  const args = ['-y'];
  inputs.forEach((f) => args.push('-i', f));
  args.push('-filter_complex', filter, '-map', '[out]', '-ar', '44100', '-ac', '1',
    '-c:a', 'pcm_s16le', voiceFile);
  await runFf(args);
  // 整轨再校一次响度：只给一个固定增益，不泵动、不抬噪，保证不同语种/不同片子出口一致
  await normalizeTrack(voiceFile);

  /* 6) 字幕时间轴按实际语音重映射：每句在本语段里的字位比例 → 实际时刻 */
  const timing = [];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const chars = Math.max(1, unit.text.length);
    const startPre = starts[i];
    for (const cue of unit.cues) {
      const cs = Math.max(0, Math.min(chars, cue.offset));
      const ce = Math.max(cs + 1, Math.min(chars, cue.offset + cue.text.length));
      timing.push({
        start: (startPre + spoken[i] * (cs / chars)) / tempo,
        end: (startPre + spoken[i] * (ce / chars)) / tempo,
        text: cue.text
      });
    }
  }
  // 单调 + 最短 0.35s + 不越过片长：字幕在最长也不会闪回或压到下一句
  let prevEnd = 0;
  for (const c of timing) {
    c.start = Math.max(c.start, prevEnd);
    if (c.end < c.start + 0.35) c.end = c.start + 0.35;
    c.start = Math.min(duration - 0.05, c.start);
    c.end = Math.min(duration, Math.max(c.start + 0.2, c.end));
    prevEnd = c.end;
  }

  return {
    file: path.join(dir, `voice-${langId}.wav`),
    timing,
    tempo,
    units: units.length,
    fallbackUsed,
    truncatedUsed
  };
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
  // 进度权重：按文字长度近似语音长度（长句占的份额大），总权重用于换算百分比
  const weights = segs.map((s) => Math.max(3, String((s && s.text) || '').length));
  const wsum = Math.max(1, weights.reduce((a, b) => a + b, 0));
  let doneWeight = 0;
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
        const spokenText = speakableText(seg.text, langId);
        try {
          const r = await opts.synthFn(spokenText, raw, i, { maxTokens, maxSeconds, tag: i });
          if (r && r.truncated) truncatedUsed += 1;
          voice = opts.voice || '';
        } catch (e) {
          checkCanceled();
          // 本地克隆个别句子失败时不断链：回退系统音色把这一句补上
          if (!opts.allowFallback) throw e;
          fallbackUsed += 1;
          // 'clone' 只是标记，不是系统音色名，交给 synth 自动挑音色
          voice = await synth(spokenText, raw, langId, opts.voice === 'clone' ? undefined : opts.voice);
        }
        if (!voice) defaultVoiceUsed = true;
        if (!voiceUsed) voiceUsed = voice;
        raws[i] = raw;
        done += 1;
        doneWeight += weights[i];
        // 只报「第几句」，已用/剩余交给渲染层统一算：
        // 两边各算一次会出现「已用…」重复两遍，把卡片文字挤爆。
        emit({
          percent: from + (to - from) * (doneWeight / wsum),
          index: i,
          detail: `第 ${done}/${segs.length} 句${truncatedUsed ? ` · ${truncatedUsed} 句截断` : ''}`
        });
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
  }

  // 频带对齐：拿「原片参考音」和「本次合成里最长的一句」做倍频带电平对比，
  // 生成一组小 EQ 把克隆音色的倾斜拉回真人（详见 eqAlignChain 上的说明）。
  // 只量一次、只影响音色分布，不改变响度；任何一步量不出来就退回原链。
  // 3.9.17：两个文件各自先测「噪底」，再用「噪底+8dB」当统计门限 —— 原片的房间噪底
  // 往往比写死的 -40dB 门限还高，旧做法等于把噪底一起算进频带能量，高频一刀都切不动。
  // 3.9.22：克隆模式（synthFn）**不再**跑这条自适应 EQ。
  // 原因：CLEAN_SHELF 的四段窄带倒角已经按「克隆引擎原样输出 vs 原片真人」逐 1/3 倍频程
  // 标定过（实测 2.5k~11k 全部落在真人 ±1dB）；这条 EQ 的测量带宽是 1 个倍频程，
  // 而 3000/4500/6500/9000 四个中心只隔 0.5 倍频程，彼此重叠、限幅又是各自算的，
  // 残差为负时会在 4.8~8k 叠出 3~6dB 的额外衰减（成片 3.9.21 英文高频比真人暗 2.6dB、
  // 日文暗 4.6dB，语言不同叠出来的量还不一样）。克隆模式统一用标定好的静态倒角，
  // 音色才在每种语言、每一句都一致。预置/近似（系统音色）没有标定过，仍保留这条对齐。
  let eqChain = '';
  if (!opts.synthFn && opts.refAudio && fs.existsSync(opts.refAudio)) {
    let probe = null;
    let probeDur = 0;
    for (let i = 0; i < raws.length; i += 1) {
      const f = raws[i];
      if (!f || !fs.existsSync(f)) continue;
      const d = wavDuration(f);
      if (d >= 1.2 && d > probeDur) { probe = f; probeDur = d; }
    }
    if (probe) {
      try {
        const probeClean = path.join(ttsDir, `probe-clean-${langId}.wav`);
        await runFf(['-y', '-i', probe, '-af', MEASURE_CHAIN,
          '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', probeClean]);
        const [refLv, ttsLv] = await Promise.all([
          measureSegment(opts.refAudio),
          measureSegment(probe)
        ]);
        const [rb, tb] = await Promise.all([
          bandLevels(opts.refAudio, refLv.floor),
          bandLevels(probeClean, ttsLv.floor)
        ]);
        eqChain = eqAlignChain(rb, tb);
      } catch (_) {
        eqChain = '';
      }
    }
  }

  for (let i = 0; i < segs.length; i += 1) {
    checkCanceled();
    const seg = segs[i];
    const raw = opts.synthFn ? raws[i] : path.join(ttsDir, `${i}.wav`);
    if (!opts.synthFn) {
      const voice = await synth(speakableText(seg.text, langId), raw, langId, opts.voice);
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
    // 3.9.25：克隆音先做「谱减 + 句尾裁剪」，再去清洁链。
    // 3.9.24 的「噪声帧整段拉数字静音」被证明是错的：判据把带谐波的低频闷响判成人声
    // 放过、却把真实的 100~200ms 气口切成空洞，成片听感是「说话断断续续 + 噪音还在」。
    // 现在谱减把气口压到 -46~-64dBFS（逐句增益之后仍在 -40dB 以下），并且**不留数字洞**；
    // 句尾那截 0.5~3.6s 的噪声尾被整段裁掉，所以下面 spoken 必须用裁剪后的时长，
    // 否则顶层会按虚长的时长算 atempo（顶到 1.25 上限）并 afade/atrim 截断真语音 ——
    // 「说话模糊不清、不连贯」的另一半原因（成片实测 17 句被压缩/截断）。
    let src = raw;
    if (opts.synthFn) {
      try {
        const dn = await cleanCloneVoice(raw, path.join(ttsDir, `${i}-clean.wav`));
        if ((dn.spans > 0 || dn.trimmedSec > 0) && fs.existsSync(dn.file)) src = dn.file;
      } catch (_) {
        src = raw;
      }
    }
    const spoken = wavDuration(src) || Math.min(nominal, avail);
    // 每句：限带/降噪/静态倒角/收口（polishGraph）→ 固定增益 → 频带对齐 → 限幅 → 变速 → 首尾微淡入淡出 → 定位。
    // 以前这里是单遍 loudnorm（动态归一），它会把句内停顿处的底噪一起抬起来，
    // 成片里就是一阵一阵的「呼吸声/沙沙声」，这是本次噪音问题的主因。
    // 现在：整句只用一个增益（不泵动），噪底已经在 cleanCloneVoice 里逐频点压到 -60dBFS 以下，
    // 所以「抬增益」再也不会把噪底抬到能听见。
    // 3.9.25 去掉每句的 agate：agate=range=0:release=500 会在词间气口之后把下一个音节
    // 的起音一起压住（起音力度掉 6~10dB），听感就是「说话吞吞吐吐、模模糊糊」；
    // 而且它只认得电平、认不出克隆引擎那层 -33dB 的低频闷响，本来就没起作用。
    const level = await measureSegment(src);
    const gain = segmentGain(level);
    // attack 默认 5ms 会放过瞬时尖峰（实测会顶到 0dBFS），压到 2ms 才能真的守住上限
    // 频带对齐 EQ 放在固定增益之后、限幅之前：如果放在压缩之前，压缩器会把被削掉的高频
    // 又相对抬回来（实测整链 4.8~7k 只降了 1.7dB，放末端能降 4.3dB），也避免增益把它放大。
    // 3.9.21：链首 polishGraph 是纯线性图（限带 + 单级温和降噪 + 固定倒角 + 压缩），
    // 后面这一段是「固定增益 → 频带对齐 → 限幅 → 变速 → 淡入淡出 → 定位」。
    let tail = [`volume=${gain.toFixed(2)}dB`, eqChain, 'alimiter=limit=0.85:attack=2:level=false'].filter(Boolean).join(',');
    let tempo = 1;
    if (spoken > avail) {
      // 克隆音色拉快 1.25 倍以上就明显失真；系统音色可以到 2 倍
      const cap = opts.synthFn ? 1.25 : 2;
      tempo = Math.min(cap, spoken / avail);
      tail += `,atempo=${tempo.toFixed(3)}`;
    }
    // 掐掉句首的爆音：0.006s 淡入，几乎听不出，但能消掉 TTS 起音处的「咔哒」
    tail += ',afade=t=in:st=0:d=0.006';
    const spokenAfter = Math.max(0.02, spoken / tempo);
    if (spokenAfter > avail + 0.005) {
      // 变速上限内仍然塞不进窗口：在窗口末尾淡出后截断（宁可少半句尾音，也绝不与下一句叠音）
      const fd = Math.min(0.12, Math.max(0.03, avail * 0.12));
      tail += `,afade=t=out:st=${Math.max(0, avail - fd).toFixed(3)}:d=${fd.toFixed(3)}`;
      squeezed += 1;
    } else if (spokenAfter < avail - 0.02) {
      // 结尾淡出从 4~12ms 放宽到 12~30ms：太短的淡出在「一句话骤然结束」时
      // 会留下一个极陡的包络台阶，喇叭听感上就是「啪」的一声（也会被当成噪音）。
      const fadeOut = Math.min(0.030, Math.max(0.012, avail / 6));
      tail += `,afade=t=out:st=${Math.max(0, spokenAfter - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`;
    }
    tail += `,apad=whole_dur=${avail.toFixed(3)},atrim=0:${avail.toFixed(3)},adelay=${Math.round(seg.start * 1000)}:all=1`;
    filters.push(`${polishGraph(`[${inputs.length}:a]`)},${tail}[a${i}]`);
    inputs.push(src);
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
  // 试听与成片必须走同一条链（3.9.21 起为纯线性清洁链，试听也要一致，
  // 否则用户按试听预期验收就会觉得成片「另一副嗓子」）。
  await runFf(['-y', '-i', raw, '-filter_complex', `${polishGraph('[0:a]')}[out]`,
    '-map', '[out]', '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', out]);
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
// 伴奏目标响度：比配音（-18 LUFS）低 13dB。
// 原来是 -28 LUFS（只低 10dB），对「展厅/街采」这类素材太高：分离出来的伴奏里
// 没有真正配乐，只有人流、回声和空调底噪，抬到 -28 LUFS 就等于把整片环境噪音
// 放到「只比人声小一点」的档位，听感就是用户说的「非常明显的噪音」。
// 现在留 13dB 的间隔：旋律仍然听得到，但不再抢人声。
const BGM_TARGET_LUFS = -31;
// 「这条床到底是不是配乐」的门槛（降噪+限带之后测的 LUFS）。
// 实测本条口播素材（展馆现场、没有人声之外的配乐）分离出来的床只有 -41.7 LUFS，
// 频谱里 93% 的能量压在 300Hz 以下 —— 那不是音乐，是低频轰鸣 + 人流回声。
// 这种床**一旦被抬到 -31 LUFS 就是成片里最明显的那层噪音**：
// 同一份床，被丢弃的那一版（en 3）停顿噪底 -67.6dB，被抬上来的那一版（ja 2）
// 停顿噪底只有 -46.5dB、80% 能量在 300Hz 以下，听感就是「一直有嗡嗡声」。
// 所以 -38 LUFS 以下一律判定为「没有真正的配乐」，直接丢弃（宁可静音，不放噪）。
// 有旋律的素材实测都在 -30 LUFS 以上，不会被这条门槛误伤。
const BGM_MIN_LUFS = -38;
// 分离残留的嘶声/气声过一遍频域降噪与限带；太狠会把音乐本身削薄。
// 3.9.17 起这里也只用 afftdn（不再叠 anlmdn：它在低电平处会留下「水声」调制，
// 而且和配音轨用两套降噪器时，两轨的残余噪声性质不一样，混起来更难听）。
// 单级 afftdn 改成 nr=20（原来 16）来补上撤掉 anlmdn 的损失：tn=1 让噪声底按帧
// 跟踪，对分离残留的稳定嘶声有效；lowpass 收到 13k 再砍一层。
// 高通从 48 抬到 60：分离出来的床有相当一部分是 80Hz 以下的低频轰鸣，
// 48Hz 的高通基本放它过去了（实测 48→60 只掉 0.4dB 的床响度，真配乐不受影响）。
const BGM_CLEAN = 'highpass=f=60:poles=2,lowpass=f=13000,afftdn=nr=20:nf=-52:tn=1';
// 人声一起，伴奏自动后退；人声停，伴奏回来。阈值必须落在配音的实际电平之下：
// 配音归一后约 -18 LUFS（RMS≈0.125），以前写的 0.16 比语音还高，侧链等于没接，
// 伴奏（还带着分离残留的原语言人声）一直原音量压在译文下面——这就是「几个人同时说」。
// 3.9.17 统一为 threshold=0.004（≈-48dBFS）/ ratio=6 / attack=12ms / release=350ms：
// 比语音电平低近 30dB 才起控，保证任何一句都真的把床压下去；12ms 起、350ms 落，
// 句间不会出现 1~2Hz 的「抽吸」。真正的配乐床被 BGM_MIN_LUFS 门槛保证存在时才用得上。
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
  // 原片没有真正的配乐时，分离出来的「伴奏」只是底噪残渣（实测本片 -41.7 LUFS、
  // 93% 能量在 300Hz 以下）。这种床只要混进成片，句间停顿就会漏出一层低频轰鸣，
  // 正是用户反复反馈的「非常明显的噪音」；直接丢弃，停顿就是干净静音。
  if (lufs == null || lufs < BGM_MIN_LUFS) return null;
  // 抬升上限 +2dB：再往上就是把分离残留（人声剥离后的「空气/人流」）一起放大，
  // 那正是「听起来很吵」的来源；衰减下限 -8dB 防止伴奏被压没
  const gain = Math.max(-8, Math.min(2, BGM_TARGET_LUFS - lufs));
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
    filters.push(`${labels}concat=n=${picks.length}:v=0:a=1,highpass=f=80:poles=2,`
      + 'lowpass=f=9000,afftdn=nr=20:nf=-40:tn=1,afftdn=nr=16:nf=-42:tn=1[ref]');
    // 参考音必须深度降噪：克隆引擎把「说话人条件」里的房间声/嘶声一起复制进每一句配音，
    // 参考音里留多少底噪，成片里就会多一层同样的底噪（这是「背景音噪音」的源头）。
    // 3.9.18 修正：噪声底参数要和**真实噪底**对齐。本片原片的房间噪底实测 -35dB，
    // 旧版写死 nf=-52（比噪底低 17dB），相当于告诉降噪器「这里几乎没有噪声」，
    // 结果 4.8~8k 的参考音噪声只掉了 0.5dB（refA -32.8 vs 源 -31.5），
    // 等于把嘶声原样教给了克隆引擎。改成 nf=-40 / -42 并把低通收到 9k 后，
    // 参考音的 4.8~8k 从 -32.8 降到 -44.0、8~10k 从 -42.4 降到 -78.2（16 段实测），
    // 而 300~2000Hz 的音色带差 ≤0.5dB，音色没有被磨掉。
    // 两级都是 afftdn（频域降噪，不做帧块平滑，不会像 anlmdn 那样给音色条件
    // 「抹上一层水声」）。参考音只用来「教音色」，不直接进成片，压得更狠只会
    // 让克隆更干净，不会让成片变闷；成片的高频收口由 CLEAN 里的 shelf 负责。
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
    '-vn', '-af', 'highpass=f=80:poles=2,lowpass=f=9000,afftdn=nr=18:nf=-40:tn=1,afftdn=nr=14:nf=-42:tn=1', '-ac', '1', '-ar', '24000',
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
  // 引擎重建状态（按这一段配音计）：上次重建时刻 + 已重建次数
  const restart = { at: 0, n: 0 };
  const speakOnce = async (slot, text, out, opts = {}) => {
    const session = ctx.sessions[slot];
    return session.speak(text, out, langId, {
      maxTokens: opts.maxTokens,
      maxSeconds: opts.maxSeconds,
      tag: opts.tag
    });
  };
  return async (text, outWav, index, opts = {}) => {
    const slot = ctx.sessions.length ? (index || 0) % ctx.sessions.length : 0;
    // tag 直接传句子下标：worker 的句内进度事件会原样带回，用于把
    // 「这一句已生成多少 token」折算到进度条的正确位置（并发时多句同时在跑）
    const callOpts = { ...opts, tag: opts.tag != null ? opts.tag : index };
    let lastErr = null;
    // 引擎重建限流：一个坏掉的 worker 会在几秒内反复起/死，每起一次都要
    // 加载约 2.5GB 权重并占满 CPU，实测能把整机拖进换页（load 上百），
    // 界面就停在同一个百分数上不动。所以冷却 15 秒、每段配音最多重建 3 次。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      checkCanceled();
      try {
        const r = await speakOnce(slot, text, outWav, callOpts);
        restart.n = 0;
        return { truncated: !!(r && r.truncated) };
      } catch (e) {
        checkCanceled();
        if (e.message === '已取消') throw e;
        lastErr = e;
        // worker 进程挂了：重建这一路会话再继续，避免后面整段都掉成系统音色
        if (/已退出|已关闭|无响应|超时/.test(e.message) && ctx.refAudio) {
          if (Date.now() - restart.at < 15000 || restart.n >= 3) {
            throw new Error('本地克隆引擎连续异常，已暂停重启以免拖慢整机，请重新开始这条任务');
          }
          restart.at = Date.now();
          restart.n += 1;
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
          const cap = Number(callOpts.maxTokens) > 0
            ? Math.max(24, Math.round(Number(callOpts.maxTokens) / clauses.length * 1.4))
            : 0;
          const sec = Number(callOpts.maxSeconds) > 0
            ? Math.max(30, Math.round(Number(callOpts.maxSeconds) / clauses.length + 20))
            : 0;
          await speakOnce(slot, clauses[k], p, { ...callOpts, maxTokens: cap, maxSeconds: sec });
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
  const LOCAL_CONC = MEM_GB >= 32 ? 8 : 5;
  // 实测（M1 16GB / Metal）：进程内并发 1 路约 2~3 token/s、5 路约 9~15 token/s，
  // 逐 token 解码时 Python 侧的等待正好被 GPU 掩盖；再往上加收益见顶，只增延迟。
  // CPU 回退时上层会把并发降到 3，避免 5 句 × 多线程抢核反而更慢。
  const LOCAL_THREADS = Math.max(2, Math.floor(CPU_N / 3));
  // flow-matching 的采样步数：6 步虽然快，但 vocoder 会留下颗粒感/沙沙的底噪，
  // 8 步的听感明显干净，时间只多约一成，质量优先。
  const LOCAL_STEPS = 8;
  const localPool = [];
  /* GPU 上把并发取满，CPU 回退时降到 3 路（CPU 上 3 路吞吐最高，再多只会抢核） */
  const concOf = (sess) => {
    const dev = (sess && sess.device) || 'cpu';
    return dev === 'mps' ? LOCAL_CONC : Math.min(3, LOCAL_CONC);
  };
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
            if (l.progress && beatBus.sink) {
              beatBus.sink({ tag: l.tag, tokens: l.tokens, cap: l.cap });
              return;
            }
            if (l.elapsed != null && beatBus.sink) { beatBus.sink({ tag: l.tag, elapsed: l.elapsed }); return; }
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
      let trNote = '';
      if (sameLanguage) {
        texts = segs.map((s) => s.text);
        langEmit('翻译字幕', 'translate', W_TR);
      } else {
        langEmit('翻译字幕', 'translate', 0);
        const tr = await translateSegments(segs, langId,
          (p) => langEmit('翻译字幕', 'translate', W_TR * Math.min(1, (Number(p.percent) || 0) / 100)),
          0, 100, translateModel);
        texts = tr.texts;
        // 少数句子三种重试都翻不出来时宁可留空，也绝不让原语言混进成片
        if (tr.dropped.length) trNote = `${tr.dropped.length} 句未能翻译，已跳过（可切换 1.5B 高质量模型重试）`;
      }
      const outSegs = segs.map((s, k) => ({ start: s.start, end: s.end, text: texts[k] || '' }))
        .filter((s) => s.text.trim());
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
          const synthConcurrency = isLocal ? Math.max(1, localPool.length * concOf(localPool[0])) : 3;
          const totalSegs = Math.max(1, outSegs.length);
          // 进度桥：句间按文字长度加权，句内用 worker 的 token 进度（见 makeTtsProgress）
          const ttsProg = makeTtsProgress({
            weights: outSegs.map((s) => Math.max(3, String(s.text || '').length)),
            ttsFrom,
            ttsWidth: W_TTS,
            langEmit,
            totalSegs
          });
          beatBus.sink = isLocal ? (info) => ttsProg.sink(info) : null;
          const built = await buildNarration(outSegs, winDur, langId, dir,
            ttsProg.onDone, 0, 100,
            // 克隆模式下「保不住原声」就是失败：整句失败只会拆句重试，
            // 绝不再退化成系统音色（那会出现两个人声混在同一条片子里）。
            { synthFn, voice: 'clone', allowFallback: false, synthConcurrency, refAudio: isLocal ? cloneRef : '' });
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
  // 口型模型权重是一次性下载，下载器只认 AbortController，这里一并中止，
  // 否则用户点了「停止」还要等几百 MB 下载完才真正结束。
  (activeJob.aborts || []).forEach((c) => { try { c.abort(); } catch (_) {} });
  if (typeof activeJob.killSessions === 'function') {
    try { activeJob.killSessions(); } catch (_) {}
  }
  try { lipsync.cancel(); } catch (_) {}
  ['whisper', 'whisper-base', 'llamacpp', TRANSLATE_LITE, TRANSLATE_FULL].forEach((id) => {
    try { hub.cancelInstall(id); } catch (_) {}
  });
  return true;
}

async function pickFile(win, opts = {}) {
  const res = await dialog.showOpenDialog(win, {
    title: opts.title || '选择长视频',
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

/** 视频翻译选片后立刻要知道时长/有没有音轨，避免用户选了 10 分钟的片子才被拒 */
async function probeVideo(p) {
  describe(p);
  const info = await probe(p);
  return { duration: info.duration, hasAudio: info.hasAudio, fps: info.fps };
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

/* ============================================================
   AI多语口播（OralCast）
   上传口播短视频 → 选目标语言 → 原声克隆配音 → 口型同步 → 出片。

   与「AI多语切片」共用识别 / 翻译 / 克隆配音 / 伴奏分离 / 混音自检，
   差别只有三点：
   1) 不切窗口、不改竖版构图：整条短片原构图输出，口播的景别和手势必须保留；
   2) 必须做口型：配音定稿后逐帧重绘嘴部（Wav2Lip 96），这是本功能的核心；
   3) 单人正面口播才可靠，检测不到人脸时降级为「配音版」并在结果卡片写明原因。
   ============================================================ */

const ORAL_OUT_ROOT = 'TokPure-AI多语口播';

/** 口型输入的基准画面：偶数尺寸（rawvideo 管道要求）、固定帧率、不带音轨。
    手机竖拍的宽高常为奇数，且带旋转元数据，先统一成「解码后真实朝向」再交给模型。 */
async function prepareOralVideo(source, duration, fps, dir, emit, from, to) {
  const out = path.join(dir, 'oral-src.mp4');
  await runFf([
    '-y', '-i', source,
    '-t', duration.toFixed(3),
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-r', String(fps),
    '-an',
    // 这一份是口型模型的输入：嘴部细节要在这里就冻住，压缩过狠会让高频细节
    // 在重绘阶段被当成「原片纹理」回填，等于把压缩噪点放大到嘴上
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
    '-movflags', '+faststart',
    out
  ], (line) => {
    const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m || typeof emit !== 'function') return;
    const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    emit(from + (to - from) * Math.min(1, t / Math.max(0.1, duration)));
  });
  if (!fs.existsSync(out) || fs.statSync(out).size < 4096) throw new Error('口播画面预处理失败');
  return out;
}

/* libass 的 Fontsize/MarginV 以 288 高的脚本画布为基准，会按成片高度等比放大，
   所以同一组数字在 720p / 1080p / 4K 上都保持「约 3% 屏高的字、约 7% 屏高的下边距」。
   切片 / 口播 / 视频翻译三条流程共用这一套样式。 */
function srtForceStyle(color) {
  return [
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
}

function srtFilter(srtFile, color) {
  return `subtitles=${path.basename(srtFile)}:force_style='${srtForceStyle(color)}'`;
}

/** 配音 + 伴奏闪避的混音图（口播与视频翻译共用）：
    [1:a] 配音，[2:a] 伴奏，输出 [a]；narration 为空时保留 [0:a] 原声。
    成片永远只有这一条音轨——原语言人声已经被完全替换，不会再出现双语混叠。 */
function dubAudioChain({ duration, narration, bgm }) {
  const D = duration.toFixed(3);
  if (!narration) {
    return `[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${D},asetpts=PTS-STARTPTS[a]`;
  }
  if (bgm) {
    return [
      `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${D},asetpts=PTS-STARTPTS[vo]`,
      `[2:a]aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${D},asetpts=PTS-STARTPTS,${BGM_CLEAN},volume=${bgm.gain.toFixed(2)}dB[bg]`,
      '[vo]asplit=2[vm][vk]',
      `[bg][vk]${BGM_DUCK}[bd]`,
      `[bd][vm]amix=inputs=2:normalize=0:duration=longest,atrim=0:${D},alimiter=limit=0.95:attack=2:level=false[a]`
    ].join(';');
  }
  return `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${D},asetpts=PTS-STARTPTS,alimiter=limit=0.95:attack=2:level=false[a]`;
}

/** 口播成片：原构图 + 烧录字幕 + 配音与伴奏闪避混音
    （混音链与竖版渲染完全一致，避免再出现「原语言人声叠在译文上」）。 */
async function renderOral({ input, dir, duration, narration, bgm, srtText, srtName, out, color, emit, from, to }) {
  const srtFile = path.join(dir, srtName || 'oral.srt');
  fs.writeFileSync(srtFile, '\ufeff' + srtText, 'utf8');
  const sub = srtFilter(srtFile, color);
  const D = duration.toFixed(3);
  const vChain = `[0:v]trim=0:${D},setpts=PTS-STARTPTS,${sub}[v]`;
  const aChain = dubAudioChain({ duration, narration, bgm });
  const hw = await ffmpegMod.hasEncoder('h264_videotoolbox');
  // 口播成片是「人像特写」，嘴部的高频一旦被压缩磨平就回到那个糊斑问题，
  // 所以这里比竖版切片给更高的码率；回退的 libx264 也从 crf20 提到 18
  const videoArgs = (useHw) => (useHw
    ? ['-c:v', 'h264_videotoolbox', '-b:v', '14M', '-maxrate', '18M', '-bufsize', '36M', '-profile:v', 'high']
    : ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast']);
  const build = (useHw) => [
    '-y', '-i', input,
    ...(narration ? ['-i', narration] : []),
    ...(bgm ? ['-i', bgm.file] : []),
    '-filter_complex', vChain + ';' + aChain,
    '-map', '[v]', '-map', '[a]',
    ...videoArgs(useHw),
    '-pix_fmt', 'yuv420p',
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
    await runFf(build(false), onLine, dir);
  }
}

/**
 * 口播引擎状态。
 * 默认走同步快照（毫秒级返回，deps 可能为 null 表示尚未探测）；
 * deep=true 时起一次 python 探测 OpenCV 依赖（约 3~8 秒），结果进程内缓存。
 */
async function oralStatus(opts) {
  const deep = !!(opts && opts.deep);
  const lips = deep ? await lipsync.statusAsync() : lipsync.status();
  const clone = voicelocal.status();
  return {
    engine: clone.installed,
    python: lips.python,
    deps: lips.deps,
    depsKnown: lips.deps != null,
    weights: lips.weights,
    sr: lips.sr,
    script: lips.script,
    bytes: lips.bytes,
    ready: !!(clone.installed && lips.python && lips.script)
  };
}

/** 首次运行：确认 OpenCV 依赖与口型权重就位（依赖复用克隆引擎的 venv，不另装 torch） */
async function ensureOralReady(proxy, emit, from, to) {
  const span = Math.max(1, to - from);
  if (!voicelocal.status().installed) {
    // 3.9.27：Windows 与 macOS 一样，缺引擎时由应用自己装（venv + torch + chatterbox）
    emit({ stage: '安装本地声音克隆引擎（首次，约 2GB）', percent: from });
    await voicelocal.install({
      proxy,
      onProgress: (p) => {
        emit({ stage: p.stage || '安装本地声音克隆引擎', percent: from + span * 0.35 * (Math.min(100, Number(p.percent) || 0) / 100) });
      },
      onChild: (ctrl) => { if (activeJob && activeJob.aborts) activeJob.aborts.add(ctrl); }
    });
    checkCanceled();
    if (!voicelocal.status().installed) {
      throw new Error('本地声音克隆引擎安装未完成，请到「桌面引擎」重试，或检查 Python 3.9+ 是否可用');
    }
  }
  if (!fs.existsSync(lipsync.weightsPath()) || !fs.statSync(lipsync.weightsPath()).size) {
    emit({ stage: '准备口型引擎（首次约 480MB，仅一次）', percent: from });
  }
  await lipsync.ensureReady({
    proxy,
    onProgress: (p) => {
      const st = String(p.stage || '准备口型引擎');
      const pct = Number(p.percent) || 0;
      emit({ stage: st, percent: from + span * 0.9 * Math.min(1, pct / 100) });
    },
    onChild: (ctrl) => { if (activeJob && activeJob.aborts) activeJob.aborts.add(ctrl); }
  });
  checkCanceled();
  emit({ stage: '口型引擎已就绪', percent: to });
}

async function startOral(payload, proxy, emit) {
  if (activeJob) throw new Error('已有任务进行中，请稍候');
  if (aijobs.isBusy()) throw new Error('已有本地 AI 任务进行中，请稍候');

  const targets = Array.from(new Set((payload.targets || []).filter((id) => langById(id))));
  if (!targets.length) throw new Error('请至少选择一种目标语言');
  if (!payload.input || !fs.existsSync(payload.input)) throw new Error('请先选择口播短视频');
  const sourceLang = payload.sourceLang || 'auto';
  const translateModel = normalizeTranslateModel(payload.translateModel);
  const color = /^#[0-9a-f]{6}$/i.test(payload.subtitleColor || '') ? payload.subtitleColor : '#FFFFFF';
  // 原声克隆是这个功能的默认也是唯一模式：换成系统音色就不是「同一个人」了
  const voiceMode = 'clone';
  const keepBgm = payload.keepBgm !== false;
  const needLip = payload.lipSync !== false;

  activeJob = {
    canceled: false,
    child: null,
    children: new Set(),
    aborts: new Set(),
    killSessions: null
  };
  const dir = makeJobDir();
  const pool = [];
  const MEM_GB = Math.max(1, Math.floor(os.totalmem() / (1024 ** 3)));
  const CPU_N = Math.max(2, (os.cpus() || []).length || 4);
  const LOCAL_CONC = MEM_GB >= 32 ? 8 : 5;
  const LOCAL_THREADS = Math.max(2, Math.floor(CPU_N / 3));
  const LOCAL_STEPS = 8;
  const beatBus = { sink: null };

  /* 实际并发 = 会话数 × 每进程并发句数；GPU 上取满，CPU 回退时降到 3 路
     （实测 CPU 上 3 路吞吐最高，再多只会互相抢核，单句反而更慢）。 */
  const concOf = (sess) => {
    const dev = (sess && sess.device) || 'cpu';
    return dev === 'mps' ? LOCAL_CONC : Math.min(3, LOCAL_CONC);
  };

  try {
    /* 0) FFmpeg 预检：缺失/被覆盖时在开跑前就报清楚，而不是跑到渲染出片才 spawn ENOENT */
    emit({ stage: '检查本地组件', percent: 1 });
    const ffReady = await ffmpegMod.ensure();
    if (!ffReady.ok) {
      throw new Error('未找到可执行的 FFmpeg（应用内 resources/bin/ffmpeg 缺失或已损坏），请重新安装 TokPure 后再试');
    }
    checkCanceled();

    /* 1) 本地引擎 */
    emit({ stage: '准备本地引擎', percent: 1 });
    const whisperModel = await ensureWhisper(proxy, emit, 1, 5);
    const needTranslate = sourceLang === 'auto' || targets.some((t) => t !== sourceLang);
    if (needTranslate) await ensureTranslateEngine(proxy, emit, 5, 8, translateModel);
    checkCanceled();

    /* 2) 读取源片 */
    emit({ stage: '读取口播视频', percent: 9 });
    const info = await probe(payload.input);
    if (!info.duration) throw new Error('无法读取视频时长，请确认文件可正常播放');
    if (!info.hasAudio) throw new Error('该视频没有音轨，无法克隆原声');
    /* 口播不再限制片长：按整片时长处理。口型按帧重绘，长片耗时线性增长，
       进度条与「按 1 分钟片长估算」的提示仍然生效，由用户自己权衡。 */
    const dur = Math.max(0.5, info.duration);
    const fps = Number(info.fps) > 0 ? Math.max(12, Math.min(30, Number(info.fps))) : 25;
    const baseName = path.basename(payload.input);

    emit({ stage: '提取音轨', percent: 10 });
    const wav = path.join(dir, 'asr.wav');
    await runFf(['-y', '-i', payload.input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], (line) => {
      const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return;
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      emit({ stage: '提取音轨', percent: 10 + 2 * Math.min(1, t / Math.max(0.1, dur)) });
    });
    checkCanceled();

    /* 3) 语音识别（全片，不选窗口） */
    emit({ stage: '语音识别', percent: 12 });
    const asr = await transcribe(wav, whisperModel.id, sourceLang, emit, 12, 26);
    const detected = asr.detected || 'en';
    const segs = normalizeSegs(splitLongSegments(asr.segments));
    if (!segs.length) throw new Error('未识别到口播人声，请换一段有人说话的短视频');
    const win = { start: 0, end: dur };

    /* 4) 原声音色克隆（整条任务只建一次，各语言复用同一位说话人） */
    emit({ stage: '克隆原声音色', percent: 28 });
    const refWav = await buildRefWav(payload.input, asr.segments, win, dir);
    const session = await voicelocal.openSession({
      refAudio: refWav,
      lang: detected,
      threads: LOCAL_THREADS,
      conc: LOCAL_CONC,
      steps: LOCAL_STEPS,
      onLog: (l) => {
        if (!l) return;
        if (l.progress && beatBus.sink) {
          beatBus.sink({ tag: l.tag, tokens: l.tokens, cap: l.cap });
          return;
        }
        if (l.elapsed != null && beatBus.sink) { beatBus.sink({ tag: l.tag, elapsed: l.elapsed }); return; }
        if (l.stage) emit({ stage: l.stage, percent: 28 });
      }
    });
    await session.prepare(refWav);
    pool.push(session);
    activeJob.killSessions = () => pool.forEach((s) => { try { s.close(); } catch (_) {} });
    checkCanceled();
    emit({ stage: '原声音色已就绪', percent: 32 });

    /* 5) 口型引擎（首次会装 OpenCV、下权重） */
    if (needLip) await ensureOralReady(proxy, emit, 33, 40);

    /* 6) 伴奏分离：与配音并行准备，成片保留背景音乐、去掉原语言人声 */
    let bgmNote = '';
    let bgmTask = Promise.resolve(null);
    if (keepBgm && targets.some((t) => t !== detected)) {
      emit({ stage: '准备背景音乐分离', percent: 40 });
      bgmTask = (async () => {
        try {
          if (!audiosep.pythonReady()) {
            bgmNote = '背景音乐未保留：分离需要「本地声音克隆」引擎的 Python 环境';
            return null;
          }
          if (!audiosep.modelReady()) {
            emit({ stage: '下载背景音乐分离模型（约 319MB，仅一次）', percent: 40 });
            await audiosep.ensureModel({
              onChild: (c) => { if (activeJob && activeJob.children) activeJob.children.add(c); },
              onProgress: (p) => emit({ stage: `下载背景音乐分离模型 ${p.percent}%`, percent: 40 })
            });
          }
          checkCanceled();
          emit({ stage: '分离背景音乐（去掉原语言人声）', percent: 40 });
          const got = await separateBgm({
            source: payload.input,
            win,
            dur,
            dir,
            onChild: (c) => { if (activeJob && activeJob.children) activeJob.children.add(c); },
            onProgress: (p) => emit({
              stage: `${p.stage || '分离背景音乐'} ${Math.round(Number(p.percent) || 0)}%`,
              percent: 40
            })
          });
          if (!got) {
            bgmNote = '原片未检测到可用背景音乐，成片只保留配音';
            return null;
          }
          return got;
        } catch (e) {
          if (activeJob && activeJob.canceled) return null;
          bgmNote = `背景音乐未保留：${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 80)}`;
          return null;
        }
      })();
    }

    /* 7) 输出目录 + 口型基准画面（只做一次，各语言复用同一份画面） */
    const settings = store.get();
    const outDir = path.join(settings.downloadDir || app.getPath('downloads'), ORAL_OUT_ROOT, safeBase(baseName));
    fs.mkdirSync(outDir, { recursive: true });
    let workVideo = null;
    if (needLip && targets.some((t) => t !== detected)) {
      emit({ stage: '预处理口播画面', percent: 41 });
      workVideo = await prepareOralVideo(payload.input, dur, fps, dir,
        (p) => emit({ stage: '预处理口播画面', percent: p }), 41, 44);
      checkCanceled();
    }

    /* 8) 逐语言：翻译 → 克隆配音 → 口型 → 出片
       口型模型与克隆模型都要占内存，16GB 机器上并行会互相挤到换页，
       所以这里按语言串行，做完一条立刻推给界面。 */
    const total = targets.length;
    const slice = (97 - 44) / total;
    const W_TR = 0.07;
    const W_TTS = 0.48;
    const W_LIP = 0.31;
    const W_RENDER = 0.14;
    let lastGlobal = 44;
    const files = new Array(total);

    for (let i = 0; i < total; i += 1) {
      checkCanceled();
      const langId = targets[i];
      const lang = langById(langId);
      const sameLanguage = langId === detected;
      const base = 44 + slice * i;
      const langEmit = (stage, langStage, frac, detail) => {
        const f = Math.max(0, Math.min(1, Number(frac) || 0));
        lastGlobal = Math.max(lastGlobal, Math.min(97, base + slice * f));
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

      /* 字幕 / 译文
         翻译失败/回显的句子绝不能退回原语言文字：目标语言是英文时字幕里混进
         中文，观感比缺一句更糟。这里直接丢弃这些句子（配音也跳过），
         并把丢弃数量带到结果卡片里，让用户知道可以换高质量模型重试。 */
      let texts;
      let trNote = '';
      if (sameLanguage) {
        texts = segs.map((s) => s.text);
        langEmit('翻译字幕', 'translate', W_TR);
      } else {
        langEmit('翻译字幕', 'translate', 0);
        const tr = await translateSegments(segs, langId,
          (p) => langEmit('翻译字幕', 'translate', W_TR * Math.min(1, (Number(p.percent) || 0) / 100)),
          0, 100, translateModel);
        texts = tr.texts;
        if (tr.dropped.length) {
          trNote = `${tr.dropped.length} 句未能翻译成${lang.zhName || lang.name}，已跳过（可在「翻译模型档位」切换高质量 1.5B 重试）`;
        }
      }
      const outSegs = segs.map((s, k) => ({ start: s.start, end: s.end, text: texts[k] || '' }))
        .filter((s) => s.text.trim());
      const srt = buildSrt(outSegs);
      const srtPath = uniqueOut(outDir, langId, 'srt');
      fs.writeFileSync(srtPath, '\ufeff' + srt, 'utf8');
      checkCanceled();

      /* 克隆配音（源语言直接保留原声） */
      let narration = null;
      let voiceLabel = '保留原声';
      let ttsNote = '';
      let ttsError = '';
      if (!sameLanguage) {
        try {
          const sess0 = pool[0];
          const synthFn = makeLocalSynth({
            ctx: {
              sessions: pool,
              refAudio: refWav,
              threads: LOCAL_THREADS,
              conc: LOCAL_CONC,
              steps: LOCAL_STEPS
            },
            langId
          });
          const synthConcurrency = Math.max(1, pool.length * concOf(sess0));
          const totalSegs = Math.max(1, outSegs.length);
          const ttsProg = makeTtsProgress({
            weights: outSegs.map((s) => Math.max(3, String(s.text || '').length)),
            ttsFrom: W_TR,
            ttsWidth: W_TTS,
            langEmit,
            totalSegs
          });
          beatBus.sink = (info) => ttsProg.sink(info);
          const built = await buildNarration(outSegs, dur, langId, dir, ttsProg.onDone, 0, 100,
            { synthFn, voice: 'clone', allowFallback: false, synthConcurrency, refAudio: refWav });
          beatBus.sink = null;
          narration = built.file;
          if (built.squeezed) ttsNote = `${built.squeezed} 句译文偏长，已收紧时长以对齐口型`;
          voiceLabel = '原声克隆 · 本地引擎（离线）';
        } catch (e) {
          checkCanceled();
          ttsError = String((e && e.message) || e || '配音失败').replace(/\s+/g, ' ').slice(0, 120);
        } finally {
          beatBus.sink = null;
        }
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
        langEmit('配音失败', 'error', 1, ttsError);
        continue;
      }

      /* 口型：吃定稿配音，Detection → Inference 全程本地 */
      let lipNote = '';
      let inputVideo = payload.input;
      let lipDone = false;
      if (!sameLanguage && needLip) {
        const lipOut = path.join(dir, `lip-${langId}.mp4`);
        try {
          langEmit('口型同步', 'lip', W_TR + W_TTS);
          await lipsync.sync({
            video: workVideo,
            audio: narration,
            out: lipOut,
            fps,
            onChild: (c) => { if (activeJob && activeJob.children) activeJob.children.add(c); },
            onProgress: (p) => {
              const frac = Math.max(0, Math.min(1, (Number(p.percent) || 0) / 100));
              const label = p.stage === 'detect' ? '检测人脸'
                : p.stage === 'donor' ? '采集嘴部高清样本'
                  : p.stage === 'infer' ? '重绘口型'
                    : p.stage === 'load' ? '加载口型模型' : '口型同步';
              langEmit(label, 'lip', W_TR + W_TTS + W_LIP * frac, p.detail || '');
            }
          });
          inputVideo = lipOut;
          lipDone = true;
        } catch (e) {
          checkCanceled();
          if (e && e.code === 'NO_FACE') {
            // 口型做不了也不能让整条任务失败：退回配音版并明确提示用户
            lipNote = '未识别到人脸（需正面、单人、无遮挡），已输出配音版';
            inputVideo = workVideo || payload.input;
          } else {
            throw e;
          }
        }
      } else if (sameLanguage) {
        lipNote = '与源语言相同，保留原声与原始口型';
      } else {
        lipNote = '已关闭口型同步，仅替换配音与字幕';
      }

      /* 出片：字幕烧录 + 配音/伴奏闪避混音 */
      const outVideo = uniqueOut(outDir, langId, 'mp4');
      const srtName = `sub-${langId}.srt`;
      const entry = {
        lang: langId,
        name: lang.name,
        video: outVideo,
        srt: srtPath,
        voice: voiceLabel,
        lip: lipDone ? 'synced' : sameLanguage ? 'same' : 'fallback',
        warning: [trNote, ttsNote, lipNote].filter(Boolean).join(' · ')
      };
      files[i] = entry;
      const renderFrom = 1 - W_RENDER;
      langEmit('渲染出片', 'render', renderFrom);
      try {
        const bgm = sameLanguage ? null : await bgmTask;
        if (!sameLanguage && bgmNote) {
          entry.warning = [entry.warning, bgmNote].filter(Boolean).join(' · ');
        }
        await renderOral({
          input: inputVideo,
          dir,
          duration: dur,
          narration: sameLanguage ? null : narration,
          bgm,
          srtText: srt,
          srtName,
          out: outVideo,
          color,
          emit: (p) => langEmit('渲染出片', 'render', renderFrom + (1 - renderFrom) * Math.min(1, (Number(p.percent) || 0) / 100)),
          from: 0,
          to: 100
        });
        const avNotes = await verifyOutput(outVideo, dur);
        if (avNotes.length) entry.warning = [entry.warning, ...avNotes].filter(Boolean).join(' · ');
        langEmit('已完成', 'done', 1);
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
        entry.video = '';
        entry.warning = [entry.warning, `渲染出片失败：${String(e.message || e).replace(/\s+/g, ' ').slice(0, 60)}`]
          .filter(Boolean).join(' · ');
        langEmit('渲染失败', 'done', 1, entry.warning);
      }
    }

    checkCanceled();
    emit({ stage: '已完成', percent: 100 });
    return { outputDir: outDir, files: files.filter((f) => f && f.video), detected, voiceMode };
  } finally {
    activeJob = null;
    pool.forEach((s) => { try { s.close(); } catch (_) {} });
    try { lipsync.cancel(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/* ============================================================
   AI 视频翻译（Voice Translation Lab）

   与原声克隆口播的区别只有一处：参考音不是从原片里抠的，而是用户
   自己上传并克隆好的「我的声音」。因此识别 / 翻译 / 配音 / 混音 / 自检
   全部复用同一套函数，只在最后一步换成「画面直拷 + 单条配音音轨」的封装，
   画面不重编码，成片画质与原片完全一致。
   ============================================================ */

const VT_MAX_SEC = 180;
const VT_OUT_ROOT = 'TokPure-AI视频翻译';

function translateStatus() {
  const base = status();
  const clone = voicelocal.status();
  return {
    whisper: base.whisper,
    translate: base.translate,
    clone: { installed: clone.installed, weights: clone.weights, bytes: clone.bytes },
    ready: !!(base.whisper.engine && base.whisper.model && clone.installed)
  };
}

/** 克隆引擎缺失时自动安装（与口播同一套流程，只是不需要口型权重） */
async function ensureCloneReady(proxy, emit, from, to) {
  if (voicelocal.status().installed) {
    emit({ stage: '本地声音克隆引擎已就绪', percent: to });
    return voicelocal.status();
  }
  const span = Math.max(1, to - from);
  emit({ stage: '安装本地声音克隆引擎（首次，约 2GB）', percent: from });
  await voicelocal.install({
    proxy,
    onProgress: (p) => {
      emit({
        stage: p.stage || '安装本地声音克隆引擎',
        percent: from + span * 0.95 * (Math.min(100, Number(p.percent) || 0) / 100)
      });
    },
    onChild: (ctrl) => { if (activeJob && activeJob.aborts) activeJob.aborts.add(ctrl); }
  });
  checkCanceled();
  if (!voicelocal.status().installed) {
    throw new Error('本地声音克隆引擎安装未完成，请到「桌面引擎」重试，或检查本机 Python 3.9–3.13 是否可用');
  }
  emit({ stage: '本地声音克隆引擎已就绪', percent: to });
  return voicelocal.status();
}

function voiceLibrary() {
  let items = [];
  let error = '';
  try {
    items = voices.list();
  } catch (e) {
    error = String((e && e.message) || e);
  }
  const clone = voicelocal.status();
  return {
    items,
    error,
    engine: { installed: clone.installed, weights: clone.weights, bytes: clone.bytes },
    limits: {
      maxSec: VT_MAX_SEC,
      sampleMin: voiceSample.SAMPLE_MIN_SEC,
      sampleGood: voiceSample.SAMPLE_GOOD_SEC,
      maxProfiles: voiceSample.MAX_PROFILES
    }
  };
}

async function pickVoiceSample(win) {
  const res = await dialog.showOpenDialog(win, {
    title: '选择我的声音样本',
    buttonLabel: '用这段声音',
    properties: ['openFile'],
    filters: [{
      name: '音频 / 视频',
      extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'mkv', 'webm']
    }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  let size = 0;
  try { size = fs.statSync(p).size; } catch (_) {}
  return { path: p, name: path.basename(p), size };
}

function importVoice(payload = {}) {
  return voices.ingest(payload);
}

function renameVoice(id, name) {
  return voices.rename(id, name);
}

function removeVoice(id) {
  return voices.remove(id);
}

/* 试听缓存：每段样本 + 语言只合成一次。首次要加载 0.5B 模型（约 20~40 秒），
   之后同一段试听是毫秒级返回，避免用户反复点试听把内存堆满。 */
const PROFILE_PREVIEW = new Map();

async function previewProfile(payload = {}) {
  if (activeJob) throw new Error('任务进行中，请稍后再试听');
  const profile = voices.get(payload.voiceId);
  const langId = langById(payload.lang) ? payload.lang : 'en';
  const key = `${profile.id}:${langId}`;
  if (PROFILE_PREVIEW.has(key)) return PROFILE_PREVIEW.get(key);
  if (!voicelocal.status().installed) {
    throw new Error('本地声音克隆引擎尚未安装：开始翻译任务时会自动安装，也可以到「桌面引擎」里安装');
  }
  const dir = path.join(app.getPath('temp'), 'tokpure-voice-profile');
  fs.mkdirSync(dir, { recursive: true });
  const tag = `${profile.id}-${langId}`;
  const raw = path.join(dir, `p-${tag}.wav`);
  const clean = path.join(dir, `p-${tag}-clean.wav`);
  const out = path.join(dir, `p-${tag}-out.wav`);
  const session = await voicelocal.openSession({
    refAudio: profile.absRef,
    lang: langId,
    threads: Math.max(2, Math.floor((os.cpus() || []).length / 2)),
    conc: 1,
    steps: 8
  });
  try {
    await session.prepare(profile.absRef);
    await session.speak(VOICE_SAMPLE[langId] || VOICE_SAMPLE.en, raw, langId,
      { maxTokens: 260, maxSeconds: 180, tag: 0 });
    // 与成片同一条清洁链，试听听到的就是最终嗓子
    let src = raw;
    try {
      const dn = await cleanCloneVoice(raw, clean);
      if (dn && dn.file && fs.existsSync(dn.file)) src = dn.file;
    } catch (_) {}
    await runFf(['-y', '-i', src, '-filter_complex', `${polishGraph('[0:a]')}[out]`,
      '-map', '[out]', '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', out]);
    const buf = fs.readFileSync(out);
    const result = {
      dataUrl: `data:audio/wav;base64,${buf.toString('base64')}`,
      voiceId: profile.id,
      name: profile.name,
      lang: langId
    };
    if (PROFILE_PREVIEW.size >= 8) PROFILE_PREVIEW.clear();
    PROFILE_PREVIEW.set(key, result);
    return result;
  } finally {
    try { session.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * 视频翻译出片：画面原封不动，只把音轨换成一条「我的声音」。
 * - 不烧字幕 → `-c:v copy`，不重编码、不掉画质，3 分钟片子几秒封装完；
 * - 烧字幕 / 非 mp4 容器的编码（VP9、AV1）→ 重编码，硬件编码优先。
 */
async function renderVoiceSwap({ input, dir, duration, narration, bgm, srtText, srtName, out, color, subtitles, emit, from, to }) {
  const D = duration.toFixed(3);
  let sub = '';
  if (subtitles && srtText) {
    const srtFile = path.join(dir, srtName || 'translate.srt');
    fs.writeFileSync(srtFile, '\ufeff' + srtText, 'utf8');
    sub = srtFilter(srtFile, color);
  }
  const aChain = dubAudioChain({ duration, narration, bgm });
  const hw = await ffmpegMod.hasEncoder('h264_videotoolbox');
  const videoArgs = (useHw) => (useHw
    ? ['-c:v', 'h264_videotoolbox', '-b:v', '14M', '-maxrate', '18M', '-bufsize', '36M', '-profile:v', 'high']
    : ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast']);
  const build = (plan) => {
    const vChain = plan.copyVideo
      ? ''
      : `[0:v]trim=0:${D},setpts=PTS-STARTPTS${sub ? ',' + sub : ''}[v]`;
    return [
      '-y', '-i', input,
      ...(narration ? ['-i', narration] : []),
      ...(bgm ? ['-i', bgm.file] : []),
      '-filter_complex', (vChain ? vChain + ';' : '') + aChain,
      ...(plan.copyVideo ? ['-map', '0:v:0', '-c:v', 'copy'] : ['-map', '[v]', ...videoArgs(plan.useHw)]),
      '-map', '[a]',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
      '-t', D,
      '-movflags', '+faststart',
      out
    ];
  };
  const onLine = (line) => {
    const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return;
    const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    emit({ percent: from + (to - from) * Math.min(1, t / Math.max(0.1, duration)) });
  };
  const plans = [];
  if (!sub) plans.push({ copyVideo: true, useHw: false });
  plans.push({ copyVideo: false, useHw: hw });
  plans.push({ copyVideo: false, useHw: false });
  let lastErr = null;
  for (let i = 0; i < plans.length; i += 1) {
    try {
      try { fs.unlinkSync(out); } catch (_) {}
      await runFf(build(plans[i]), onLine, dir);
      lastErr = null;
      break;
    } catch (e) {
      checkCanceled();
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  if (!fs.existsSync(out) || fs.statSync(out).size < 4096) throw new Error('成片封装失败');
  return out;
}

/** 自动化测试入口：只跑「画面 + 配音」封装这一段，不依赖克隆引擎 */
async function renderSwapForTest(payload = {}) {
  const dir = makeJobDir();
  try {
    await renderVoiceSwap({
      input: payload.input,
      dir,
      duration: Number(payload.duration) || 3,
      narration: payload.narration,
      bgm: payload.bgm || null,
      srtText: payload.srtText || '',
      srtName: 'smoke.srt',
      out: payload.out,
      color: payload.color || '#FFFFFF',
      subtitles: payload.subtitles !== false,
      emit: () => {},
      from: 0,
      to: 100
    });
    return payload.out;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function startTranslate(payload, proxy, emit) {
  if (activeJob) throw new Error('已有任务进行中，请稍候');
  if (aijobs.isBusy()) throw new Error('已有本地 AI 任务进行中，请稍候');

  const targets = Array.from(new Set((payload.targets || []).filter((id) => langById(id))));
  if (!targets.length) throw new Error('请至少选择一种目标语言');
  if (!payload.input || !fs.existsSync(payload.input)) throw new Error('请先选择原片视频');
  const profile = voices.get(payload.voiceId);
  const sourceLang = payload.sourceLang || 'auto';
  const translateModel = normalizeTranslateModel(payload.translateModel);
  const color = /^#[0-9a-f]{6}$/i.test(payload.subtitleColor || '') ? payload.subtitleColor : '#FFFFFF';
  const keepBgm = payload.keepBgm !== false;
  const burnSubs = payload.subtitles !== false;

  activeJob = {
    canceled: false,
    child: null,
    children: new Set(),
    aborts: new Set(),
    killSessions: null
  };
  const dir = makeJobDir();
  const pool = [];
  const MEM_GB = Math.max(1, Math.floor(os.totalmem() / (1024 ** 3)));
  const CPU_N = Math.max(2, (os.cpus() || []).length || 4);
  const LOCAL_CONC = MEM_GB >= 32 ? 8 : 5;
  const LOCAL_THREADS = Math.max(2, Math.floor(CPU_N / 3));
  const LOCAL_STEPS = 8;
  const beatBus = { sink: null };
  const concOf = (sess) => {
    const dev = (sess && sess.device) || 'cpu';
    return dev === 'mps' ? LOCAL_CONC : Math.min(3, LOCAL_CONC);
  };

  /* 进度闸门：配音阶段的克隆进程日志、后台 BGM 任务会穿插发早阶段的读数，
     统一在这里夹成「只增不减」，进度条永远不会回退 */
  let lastPct = 0;
  const rawEmit = emit;
  emit = (p) => {
    if (!p) return;
    const out = Object.assign({}, p);
    const v = Number(out.percent);
    if (Number.isFinite(v)) {
      out.percent = Math.max(lastPct, Math.min(100, v));
      lastPct = out.percent;
    }
    rawEmit(out);
  };

  try {
    emit({ stage: '检查本地组件', percent: 1 });
    const ffReady = await ffmpegMod.ensure();
    if (!ffReady.ok) {
      throw new Error('未找到可执行的 FFmpeg（应用内 resources/bin/ffmpeg 缺失或已损坏），请重新安装 TokPure 后再试');
    }
    checkCanceled();

    emit({ stage: '准备本地识别与翻译引擎', percent: 2 });
    const whisperModel = await ensureWhisper(proxy, emit, 2, 6);
    const needTranslate = sourceLang === 'auto' || targets.some((t) => t !== sourceLang);
    if (needTranslate) await ensureTranslateEngine(proxy, emit, 6, 9, translateModel);
    checkCanceled();

    /* 1) 原片 */
    emit({ stage: '读取原片', percent: 10 });
    const info = await probe(payload.input);
    if (!info.duration) throw new Error('无法读取视频时长，请确认文件可正常播放');
    if (!info.hasAudio) throw new Error('该视频没有音轨，无从识别原语言人声');
    if (info.duration > VT_MAX_SEC + 0.5) {
      throw new Error(`视频翻译请控制在 ${VT_MAX_SEC} 秒以内（当前 ${Math.round(info.duration)} 秒）。本地克隆配音约为实时的 6~8 倍，片越长等待越久，建议先剪成 3 分钟以内。`);
    }
    const dur = Math.max(0.5, Math.min(info.duration, VT_MAX_SEC));
    const baseName = path.basename(payload.input).replace(/\.\w+$/, '');

    emit({ stage: '提取原片音轨', percent: 11 });
    const wav = path.join(dir, 'asr.wav');
    await runFf(['-y', '-i', payload.input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], (line) => {
      const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return;
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      emit({ stage: '提取原片音轨', percent: 11 + 2 * Math.min(1, t / Math.max(0.1, dur)) });
    });
    checkCanceled();

    emit({ stage: '识别原片语言', percent: 13 });
    const asr = await transcribe(wav, whisperModel.id, sourceLang, emit, 13, 26);
    const detected = asr.detected || 'en';
    const segs = normalizeSegs(splitLongSegments(asr.segments));
    if (!segs.length) throw new Error('未识别到人声，请换一段有人说话的短视频');
    const win = { start: 0, end: dur };

    /* 2) 我的声音：用户上传的参考音，全片只加载一次 */
    emit({ stage: `加载我的声音 · ${profile.name}`, percent: 27 });
    await ensureCloneReady(proxy, emit, 27, 31);
    /* 克隆进程的日志会在配音阶段继续冒出来（含 stage 行），加载完之后只喂心跳不喂 stage，
       否则全局阶段文案会在配音中途跳回「加载模型」 */
    let cloneLoaded = false;
    const session = await voicelocal.openSession({
      refAudio: profile.absRef,
      lang: detected,
      threads: LOCAL_THREADS,
      conc: LOCAL_CONC,
      steps: LOCAL_STEPS,
      onLog: (l) => {
        if (!l) return;
        if (l.progress && beatBus.sink) { beatBus.sink({ tag: l.tag, tokens: l.tokens, cap: l.cap }); return; }
        if (l.elapsed != null && beatBus.sink) { beatBus.sink({ tag: l.tag, elapsed: l.elapsed }); return; }
        if (l.stage && !cloneLoaded) emit({ stage: l.stage, percent: 29 });
      }
    });
    await session.prepare(profile.absRef);
    cloneLoaded = true;
    pool.push(session);
    activeJob.killSessions = () => pool.forEach((s) => { try { s.close(); } catch (_) {} });
    checkCanceled();
    emit({ stage: '我的声音已就绪', percent: 32 });

    /* 3) 伴奏分离：与配音并行，成片保留 BGM、只替换人声 */
    let bgmNote = '';
    let bgmTask = Promise.resolve(null);
    if (keepBgm) {
      emit({ stage: '准备背景音乐分离', percent: 33 });
      bgmTask = (async () => {
        try {
          if (!audiosep.pythonReady()) {
            bgmNote = '背景音乐未保留：分离需要「本地声音克隆」引擎的 Python 环境';
            return null;
          }
          if (!audiosep.modelReady()) {
            emit({ stage: '下载背景音乐分离模型（约 319MB，仅一次）', percent: 33 });
            await audiosep.ensureModel({
              onChild: (c) => { if (activeJob && activeJob.children) activeJob.children.add(c); },
              onProgress: (p) => emit({ stage: `下载背景音乐分离模型 ${p.percent}%`, percent: 33 })
            });
          }
          checkCanceled();
          emit({ stage: '分离背景音乐（去掉原片人声）', percent: 33 });
          const got = await separateBgm({
            source: payload.input,
            win,
            dur,
            dir,
            onChild: (c) => { if (activeJob && activeJob.children) activeJob.children.add(c); },
            onProgress: (p) => emit({
              stage: `${p.stage || '分离背景音乐'} ${Math.round(Number(p.percent) || 0)}%`,
              percent: 33
            })
          });
          if (!got) {
            bgmNote = '原片未检测到可用背景音乐，成片只保留配音';
            return null;
          }
          return got;
        } catch (e) {
          if (activeJob && activeJob.canceled) return null;
          bgmNote = `背景音乐未保留：${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 80)}`;
          return null;
        }
      })();
    }

    const settings = store.get();
    const outDir = path.join(settings.downloadDir || app.getPath('downloads'), VT_OUT_ROOT, safeBase(baseName));
    fs.mkdirSync(outDir, { recursive: true });

    /* 4) 逐语言：翻译 → 用我的声音配音 → 封装成片 */
    const total = targets.length;
    const slice = (97 - 34) / total;
    const W_TR = 0.12;
    const W_TTS = 0.64;
    const W_RENDER = 0.24;
    let lastGlobal = 34;
    const files = new Array(total);

    for (let i = 0; i < total; i += 1) {
      checkCanceled();
      const langId = targets[i];
      const lang = langById(langId);
      const sameLanguage = langId === detected;
      const base = 34 + slice * i;
      const langEmit = (stage, langStage, frac, detail) => {
        const f = Math.max(0, Math.min(1, Number(frac) || 0));
        lastGlobal = Math.max(lastGlobal, Math.min(97, base + slice * f));
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

      let texts;
      let trNote = '';
      if (sameLanguage) {
        texts = segs.map((s) => s.text);
        trNote = '目标语言与原片一致，本次只换声、不翻译';
        langEmit('准备台词', 'translate', W_TR);
      } else {
        langEmit('翻译字幕', 'translate', 0);
        const tr = await translateSegments(segs, langId,
          (p) => langEmit('翻译字幕', 'translate', W_TR * Math.min(1, (Number(p.percent) || 0) / 100)),
          0, 100, translateModel);
        texts = tr.texts;
        if (tr.dropped.length) {
          trNote = `${tr.dropped.length} 句未能翻译成${lang.zhName || lang.name}，已跳过（可在「翻译模型档位」切换高质量 1.5B 重试）`;
        }
      }
      const outSegs = segs.map((s, k) => ({ start: s.start, end: s.end, text: texts[k] || '' }))
        .filter((s) => s.text.trim());
      const srtPath = uniqueOut(outDir, langId, 'srt');
      checkCanceled();

      /* 我的声音配音（所有语言都合成，原语言同语种也一样换掉原人声） */
      let narration = null;
      let finalSegs = outSegs;
      let ttsNote = '';
      let ttsError = '';
      try {
        const sess0 = pool[0];
        const synthFn = makeLocalSynth({
          ctx: {
            sessions: pool,
            refAudio: profile.absRef,
            threads: LOCAL_THREADS,
            conc: LOCAL_CONC,
            steps: LOCAL_STEPS
          },
          langId
        });
        const synthConcurrency = Math.max(1, pool.length * concOf(sess0));
        // 连续语流：短句先并成完整语段再合成，避免逐句起调与窗口截断（3.9.29）
        const units = groupForFlow(outSegs, langId);
        const ttsProg = makeTtsProgress({
          weights: units.map((u) => Math.max(3, u.text.length)),
          ttsFrom: W_TR,
          ttsWidth: W_TTS,
          langEmit,
          totalSegs: Math.max(1, units.length)
        });
        beatBus.sink = (info) => ttsProg.sink(info);
        const built = await buildFlowNarration(units, dur, langId, dir, ttsProg.onDone,
          { synthFn, synthConcurrency, allowFallback: false });
        narration = built.file;
        if (built.timing && built.timing.length) finalSegs = built.timing;
        if (built.tempo > 1.005) ttsNote = `整体语速已微调 ${built.tempo.toFixed(2)}× 以贴合画面`;
      } catch (e) {
        checkCanceled();
        ttsError = String((e && e.message) || e || '配音失败').replace(/\s+/g, ' ').slice(0, 120);
      } finally {
        beatBus.sink = null;
      }
      // 字幕按「实际语音时长」重排：并段后语音不再逐句卡原片窗口，
      // 字幕必须跟着重映射，否则会出现字幕与声音对不上（失败时仍用原片时间轴）
      const srt = buildSrt(finalSegs);
      fs.writeFileSync(srtPath, '\ufeff' + srt, 'utf8');
      if (ttsError) {
        files[i] = {
          lang: langId,
          name: lang.name,
          video: '',
          srt: srtPath,
          voice: '配音失败',
          warning: `配音失败：${ttsError}`
        };
        langEmit('配音失败', 'error', 1, ttsError);
        continue;
      }

      /* 出片：画面直拷 + 我的声音单音轨（可选烧录字幕） */
      const outVideo = uniqueOut(outDir, langId, 'mp4');
      const entry = {
        lang: langId,
        name: lang.name,
        video: outVideo,
        srt: srtPath,
        voice: `我的声音 · ${profile.name}`,
        mode: sameLanguage ? '换声' : '翻译',
        lip: 'n/a',
        warning: [trNote, ttsNote].filter(Boolean).join(' · ')
      };
      files[i] = entry;
      const renderFrom = 1 - W_RENDER;
      langEmit('封装成片', 'render', renderFrom);
      try {
        const bgm = await bgmTask;
        if (bgmNote) entry.warning = [entry.warning, bgmNote].filter(Boolean).join(' · ');
        await renderVoiceSwap({
          input: payload.input,
          dir,
          duration: dur,
          narration,
          bgm,
          srtText: srt,
          srtName: `sub-${langId}.srt`,
          out: outVideo,
          color,
          subtitles: burnSubs,
          emit: (p) => langEmit('封装成片', 'render', renderFrom + (1 - renderFrom) * Math.min(1, (Number(p.percent) || 0) / 100)),
          from: 0,
          to: 100
        });
        const avNotes = await verifyOutput(outVideo, dur);
        if (avNotes.length) entry.warning = [entry.warning, ...avNotes].filter(Boolean).join(' · ');
        langEmit('已完成', 'done', 1);
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
        entry.video = '';
        entry.warning = [entry.warning, `封装成片失败：${String(e.message || e).replace(/\s+/g, ' ').slice(0, 80)}`]
          .filter(Boolean).join(' · ');
        langEmit('封装失败', 'done', 1, entry.warning);
      }
    }

    checkCanceled();
    emit({ stage: '已完成', percent: 100 });
    return { outputDir: outDir, files: files.filter((f) => f && f.video), detected, voice: profile.name };
  } finally {
    activeJob = null;
    pool.forEach((s) => { try { s.close(); } catch (_) {} });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/* 自动化测试用：直接跑一遍连续语流配音（系统音色），回传音轨与字幕时间轴。
   真实任务走克隆合成，但拼接/停顿/变速/字幕重映射是同一份代码，这里能验到。
   传 voiceId 时改用本地克隆引擎，量测噪音/句间电平/连贯性（同一份 buildFlowNarration）。 */
async function flowNarrationForTest(payload = {}) {
  const langId = payload.langId || 'en';
  const duration = Math.max(0.5, Number(payload.duration) || 5);
  const dir = payload.dir || path.join(app.getPath('temp'), `tokpure-flow-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const segs = (payload.segs || []).map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: String(s.text || '')
  })).filter((s) => s.text.trim());
  const units = groupForFlow(segs, langId);
  let session = null;
  let synthFn;
  let synthConcurrency = 1;
  const threads = Math.max(2, Math.floor(((os.cpus() || []).length || 4) / 3));
  const conc = 5;
  const steps = 8;
  try {
    if (payload.voiceId) {
      const profile = voices.get(payload.voiceId);
      session = await voicelocal.openSession({
        refAudio: profile.absRef,
        lang: langId,
        threads,
        conc,
        steps
      });
      await session.prepare(profile.absRef);
      synthFn = makeLocalSynth({
        ctx: { sessions: [session], refAudio: profile.absRef, threads, conc, steps },
        langId
      });
      synthConcurrency = (session.device === 'mps' ? conc : Math.min(3, conc));
    }
    const built = await buildFlowNarration(units, duration, langId, dir, () => {},
      { synthFn, synthConcurrency, allowFallback: !payload.voiceId });
    return { ...built, dir, srt: buildSrt(built.timing) };
  } finally {
    if (session) { try { session.close(); } catch (_) {} }
  }
}

module.exports = {
  status,
  start,
  cancel,
  pickFile,
  describe,
  reveal,
  openFile,
  voices: voiceCatalog,
  preview: previewVoice,
  // 自动化测试用：直接合成一句话到指定 wav，验证 TTS 链路（不经过播放）
  synthForTest: synth,
  testClone,
  oralStatus,
  startOral,
  ensureOralReady,
  // AI 视频翻译（我的声音）
  translateStatus,
  startTranslate,
  voiceLibrary,
  pickVoiceSample,
  importVoice,
  renameVoice,
  removeVoice,
  previewProfile,
  renderSwapForTest,
  flowNarrationForTest,
  probeVideo
};
