'use strict';

/* ============================================================
   TokPure — 本地 AI 任务运行器（R2 字幕 / R3 去水印 2.0 / R4 超分插帧）
   - 重型任务全局只允许 1 个并发，避免低配机爆内存
   - sidecar 崩溃不影响主进程（独立 child_process）
   - 所有中间文件放临时目录，成功后清理
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const ffmpegMod = require('./ffmpeg');
const hub = require('./enginehub');

let activeJob = null;

function isBusy() {
  return !!activeJob;
}

/* ---------------- 通用子进程 ---------------- */
function runCmd(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      windowsHide: true
    });
    if (activeJob) activeJob.child = child;
    let stderr = '';
    let stdout = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      stderr += s;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
      if (opts.onLine) {
        s.split(/\r|\n/).forEach((line) => { if (line.trim()) opts.onLine(line); });
      }
    };
    child.stdout.on('data', (c) => {
      stdout += c.toString();
      if (opts.onLine) c.toString().split(/\r|\n/).forEach((l) => { if (l.trim()) opts.onLine(l); });
    });
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (activeJob && activeJob.child === child) activeJob.child = null;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`进程退出码 ${code}\n${stderr.slice(-600)}`));
    });
  });
}

function checkCanceled() {
  if (activeJob && activeJob.canceled) throw new Error('已取消');
}

async function runFf(args, onLine, cwd) {
  const bin = ffmpegMod.getFfmpegPath();
  return runCmd(bin, args, { onLine, cwd });
}

/* ---------------- 媒体探测（无 ffprobe，解析 ffmpeg -i 输出） ---------------- */
function parseFraction(s) {
  if (!s) return 0;
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    return b > 0 ? a / b : 0;
  }
  return Number(s) || 0;
}

async function probe(input) {
  let text = '';
  try {
    await runFf(['-hide_banner', '-i', input], (line) => { text += line + '\n'; });
  } catch (_) {
    // 无输出文件时 ffmpeg 必然以非 0 退出，信息在 stderr
  }
  const durM = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durM
    ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3])
    : 0;
  const vLine = text.split('\n').find((l) => /Video:/.test(l)) || '';
  const resM = vLine.match(/(\d{2,5})x(\d{2,5})/);
  let fps = 0;
  const fpsM = vLine.match(/([\d.]+|\d+\/\d+)\s+fps/);
  if (fpsM) fps = parseFraction(fpsM[1]);
  if (!fps) {
    const tbrM = vLine.match(/([\d.]+|\d+\/\d+)\s+tbr/);
    if (tbrM) fps = parseFraction(tbrM[1]);
  }
  if (!fps) fps = 30;
  return {
    duration,
    width: resM ? Number(resM[1]) : 0,
    height: resM ? Number(resM[2]) : 0,
    fps,
    hasAudio: /Audio:/.test(text)
  };
}

/* ---------------- 临时工作目录 ---------------- */
function makeJobDir(id) {
  const dir = path.join(app.getPath('temp'), 'tokpure-ai', `job-${id}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniqueOutput(input, tag, ext = 'mp4') {
  // 输出到下载目录；同名校验自动加序号
  const settings = require('./store').get();
  const dir = settings.downloadDir || app.getPath('downloads');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  let out = path.join(dir, `${base} - ${tag}.${ext}`);
  let n = 2;
  while (fs.existsSync(out)) out = path.join(dir, `${base} - ${tag} ${n}.${ext}`), n += 1;
  return out;
}

function ffProgress(onProgress, duration, weight = 1) {
  return (line) => {
    const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m && duration > 0) {
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      onProgress(Math.min(99, (t / duration) * 100 * weight));
    }
  };
}

/* ---------------- R2：AI 字幕 ---------------- */
function srtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mss = ms % 1000;
  const p = (x, l = 2) => String(x).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(mss, 3)}`;
}

function parseSrtTimestamp(ts) {
  // "00:00:05,120" or "00:00:05.120"
  const m = String(ts).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
}

function buildSrt(segments) {
  return segments
    .map((seg, i) => `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text.trim()}\n`)
    .join('\n');
}

function parseWhisperJson(jsonPath) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const rows = Array.isArray(data.transcription) ? data.transcription : [];
  return rows.map((r) => ({
    start: parseSrtTimestamp(r.timestamps && r.timestamps.from),
    end: parseSrtTimestamp(r.timestamps && r.timestamps.to),
    text: String(r.text || '').trim()
  })).filter((s) => s.text);
}

async function transcribe(params, onProgress) {
  const { input, modelId, language } = params;
  if (!input || !fs.existsSync(input)) throw new Error('文件不存在');
  const bin = hub.engineBin('whisper');
  if (!bin) throw new Error('未安装 Whisper.cpp 引擎，请先到「桌面引擎」下载');
  const model = hub.modelPath(modelId || 'whisper-base');
  if (!model) throw new Error('未安装识别模型，请先到「桌面引擎」下载模型');
  if (isBusy()) throw new Error('已有 AI 任务进行中，请稍候');

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jobDir = makeJobDir(jobId);
  activeJob = { id: jobId, canceled: false, child: null };
  try {
    onProgress({ stage: '准备音频', percent: 1 });
    checkCanceled();
    const wav = path.join(jobDir, 'audio.wav');
    const info = await probe(input);
    await runFf(['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
      ffProgress(() => onProgress({ stage: '提取音频', percent: 6 }), info.duration, 0.05));
    checkCanceled();

    onProgress({ stage: '语音识别中', percent: 8 });
    const outBase = path.join(jobDir, 'result');
    const args = [
      '-m', model,
      '-f', wav,
      '-l', language && language !== 'auto' ? language : 'auto',
      '-oj',
      '-of', outBase,
      '-t', String(Math.max(2, Math.min(8, (require('os').cpus() || []).length - 2 || 4)))
    ];
    await runCmd(bin, args, {
      onLine: (line) => {
        const m = line.match(/progress\s*=\s*(\d+)/i);
        if (m) onProgress({ stage: '语音识别中', percent: 8 + Math.min(88, Number(m[1]) * 0.88) });
      }
    });
    checkCanceled();
    const segments = parseWhisperJson(outBase + '.json');
    if (!segments.length) throw new Error('未识别到任何人声，请检查视频音轨');
    onProgress({ stage: '完成', percent: 100 });
    return { segments, srt: buildSrt(segments), probe: info };
  } finally {
    activeJob = null;
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/** 把字幕烧录进视频；srt 为 SRT 文本内容 */
async function burnSubtitles(params, onProgress) {
  const { input, srt, fontSize = 18, marginV = 36 } = params;
  if (!input || !fs.existsSync(input)) throw new Error('文件不存在');
  if (!srt || !srt.trim()) throw new Error('字幕内容为空');
  if (isBusy()) throw new Error('已有 AI 任务进行中，请稍候');

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jobDir = makeJobDir(jobId);
  activeJob = { id: jobId, canceled: false, child: null };
  try {
    // cwd 设为临时目录，字幕滤镜用相对文件名，规避路径转义地狱
    fs.writeFileSync(path.join(jobDir, 'sub.srt'), '\ufeff' + srt, 'utf8');
    const info = await probe(input);
    const out = uniqueOutput(input, '字幕');
    const force =
      `Fontsize=${Number(fontSize) || 18},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=${Number(marginV) || 36}`;
    const vf = `subtitles=sub.srt:force_style='${force}'`;
    onProgress({ stage: '烧录字幕', percent: 1 });
    await runFf(['-y', '-i', input, '-vf', vf,
      '-c:v', 'libx264', '-crf', '19', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', out],
      ffProgress((p) => onProgress({ stage: '烧录字幕', percent: Math.max(2, p) }), info.duration),
      jobDir);
    checkCanceled();
    onProgress({ stage: '完成', percent: 100 });
    return { output: out };
  } finally {
    activeJob = null;
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/* ---------------- R3：去水印 2.0（多区域 + 时间轴） ---------------- */
async function cleanRegions(params, onProgress) {
  const { input, regions, cropPercent = 6 } = params;
  if (!input || !fs.existsSync(input)) throw new Error('文件不存在');
  if (isBusy()) throw new Error('已有 AI 任务进行中，请稍候');
  const info = await probe(input);
  const W = info.width;
  const H = info.height;
  if (!W || !H) throw new Error('无法读取视频分辨率');

  let vf;
  if (params.mode === 'crop') {
    const p = Math.max(0, Math.min(20, Number(cropPercent) || 6)) / 100;
    vf = `crop=iw*(1-${p}):ih*(1-${p}):0:0`;
  } else {
    if (!Array.isArray(regions) || !regions.length) throw new Error('请至少添加一个修复区域');
    const parts = regions.map((r) => {
      const x = Math.max(1, Math.round((Number(r.x) || 0) / 100 * W));
      const y = Math.max(1, Math.round((Number(r.y) || 0) / 100 * H));
      const w = Math.max(2, Math.round((Number(r.w) || 10) / 100 * W));
      const h = Math.max(2, Math.round((Number(r.h) || 4) / 100 * H));
      // delogo 区域不能贴边，留 1px 安全边界
      const x2 = Math.min(W - 2, x + w);
      const y2 = Math.min(H - 2, y + h);
      const rw = Math.max(2, x2 - x);
      const rh = Math.max(2, y2 - y);
      let s = `delogo=x=${x}:y=${y}:w=${rw}:h=${rh}`;
      const start = Number(r.start) || 0;
      const end = Number(r.end) || 0;
      if (end > start) s += `:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`;
      return s;
    });
    vf = parts.join(',');
  }

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  activeJob = { id: jobId, canceled: false, child: null };
  try {
    const out = uniqueOutput(input, 'clean');
    onProgress({ stage: '区域修复', percent: 1 });
    await runFf(['-y', '-i', input, '-vf', vf, '-c:v', 'libx264', '-crf', '18',
      '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', out],
      ffProgress((p) => onProgress({ stage: '区域修复', percent: Math.max(2, p) }), info.duration));
    checkCanceled();
    onProgress({ stage: '完成', percent: 100 });
    return { output: out };
  } finally {
    activeJob = null;
  }
}

/* ---------------- R4：超分 / 插帧 ---------------- */
function countFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).length;
  } catch (_) {
    return 0;
  }
}

async function enhance(params, onProgress) {
  const { input, engine = 'realsr', scale = 2 } = params;
  if (!input || !fs.existsSync(input)) throw new Error('文件不存在');
  const bin = hub.engineBin(engine);
  if (!bin) throw new Error('未安装该画质引擎，请先到「桌面引擎」下载');
  if (isBusy()) throw new Error('已有 AI 任务进行中，请稍候');

  const info = await probe(input);
  if (!info.width) throw new Error('无法读取视频信息');
  const isRife = engine === 'rife';
  // RealSR 官方包仅提供 x4 模型；RIFE 固定帧率翻倍
  const effScale = isRife ? 2 : (engine === 'realsr' ? 4 : Number(scale) || 2);
  const totalFrames = Math.max(1, Math.round(info.duration * info.fps));

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jobDir = makeJobDir(jobId);
  const inDir = path.join(jobDir, 'in');
  const outDir = path.join(jobDir, 'out');
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  activeJob = { id: jobId, canceled: false, child: null };

  const tag = isRife ? '60fps' : `${effScale}x`;
  try {
    // 1) 抽帧
    onProgress({ stage: '抽取帧', percent: 1 });
    await runFf(['-y', '-i', input, '-vsync', '0', path.join(inDir, '%08d.png')],
      ffProgress((p) => onProgress({ stage: '抽取帧', percent: 1 + p * 0.12 }), info.duration));
    checkCanceled();

    // 2) 抽音轨（无音轨时跳过）
    const audioPath = path.join(jobDir, 'audio.aac');
    let hasAudio = false;
    if (info.hasAudio) {
      try {
        await runFf(['-y', '-i', input, '-vn', '-c:a', 'copy', audioPath], () => {});
        hasAudio = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0;
      } catch (_) { hasAudio = false; }
    }
    checkCanceled();

    // 3) 运行 ncnn 引擎（cwd 为二进制目录，保证 libMoltenVK 可被加载）
    // 各官方包的模型目录命名与可用倍率不同：
    //   realsr(20220728) 仅带 x4 模型（models-DF2K_JPEG，压缩视频更稳）
    //   realcugan(20220728) models-se 内含 up2x/up3x/up4x
    //   rife(20221029) 二进制同级 rife-v4.6/（安装时已 prune）
    const binDir = path.dirname(bin);
    const modelDirs = {
      realsr: path.join(binDir, 'models-DF2K_JPEG'),
      realcugan: path.join(binDir, 'models-se'),
      rife: path.join(binDir, 'rife-v4.6') // rife 模型与二进制同级；-n 为目标帧数（默认 N*2，勿传）
    };
    const args = ['-i', inDir, '-o', outDir, '-m', modelDirs[engine] || path.join(binDir, 'models')];
    if (!isRife) {
      args.push('-s', String(effScale), '-t', '200');
      if (engine === 'realcugan') args.push('-n', '-1'); // 不降噪，保留细节
    }
    onProgress({ stage: isRife ? 'AI 插帧中' : 'AI 超分中', percent: 14 });
    let polled = 0;
    const poller = setInterval(() => {
      polled = countFiles(outDir);
      const expect = isRife ? totalFrames * 2 : totalFrames;
      const pct = 14 + Math.min(78, (polled / Math.max(1, expect)) * 78);
      onProgress({ stage: isRife ? 'AI 插帧中' : 'AI 超分中', percent: pct, frames: polled, totalFrames: expect });
    }, 1000);
    let failed = null;
    try {
      await runCmd(bin, args, { cwd: binDir, env: { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: binDir } });
    } catch (e) {
      failed = e;
    } finally {
      clearInterval(poller);
    }
    if (failed) {
      if (activeJob && activeJob.canceled) throw new Error('已取消');
      throw new Error(`画质引擎运行失败（可能是显卡不支持 Vulkan）：${failed.message.slice(-300)}`);
    }
    checkCanceled();
    if (countFiles(outDir) === 0) throw new Error('引擎未产出任何帧，请更换引擎或机型重试');

    // 4) 拼回视频
    const outFps = isRife ? info.fps * 2 : info.fps;
    const out = uniqueOutput(input, tag);
    onProgress({ stage: '合成视频', percent: 93 });
    const ffArgs = ['-y', '-framerate', String(outFps), '-i', path.join(outDir, '%08d.png')];
    if (hasAudio) ffArgs.push('-i', audioPath);
    ffArgs.push(
      '-map', '0:v:0',
      ...(hasAudio ? ['-map', '1:a:0'] : []),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-c:a', 'copy'] : []),
      '-shortest', out
    );
    await runFf(ffArgs, (line) => {
      const m = line.match(/frame=\s*(\d+)/);
      if (m) onProgress({ stage: '合成视频', percent: 93 + Math.min(6, (Number(m[1]) / Math.max(1, totalFrames)) * 6) });
    });
    checkCanceled();
    onProgress({ stage: '完成', percent: 100 });
    return { output: out, frames: countFiles(outDir) };
  } finally {
    activeJob = null;
    // 中间帧可能非常占磁盘，无论成败都清理（失败时保留可后续改日志排查，这里改为清理）
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function cancel() {
  if (!activeJob) return false;
  activeJob.canceled = true;
  if (activeJob.child) {
    try { activeJob.child.kill('SIGKILL'); } catch (_) {}
  }
  return true;
}

module.exports = { transcribe, burnSubtitles, cleanRegions, enhance, cancel, isBusy, probe, buildSrt };
