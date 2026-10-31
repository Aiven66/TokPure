'use strict';

/* ============================================================
   TokPure — 本地口型同步引擎（Wav2Lip 96×96）

   「AI多语口播」最关键的一环：译文配音定稿后，把原片的嘴部逐帧重绘成
   与目标语言语音对齐的口型，头部动作 / 手势 / 背景 / 景别全部保留。

   工程约束：
   - 完全离线推理：模型权重一次性下载到引擎目录，之后不联网；
   - 复用「本地声音克隆」的 Python 环境（torch 2.6 + MPS + OpenCV 检测人脸），
     不额外装一套 PyTorch，省 1GB 以上；
   - 单人正面口播成功率最高；检测不到人脸时明确报错，由上层降级成纯配音版，
     绝不产出「嘴不动 / 嘴乱动」的烂片。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const net = require('./net');
const voicelocal = require('./voicelocal');
const ffmpegMod = require('./ffmpeg');

const MODEL_BYTES = 435801865;
const MIN_BYTES = Math.round(MODEL_BYTES * 0.9);
// 权重来源：HuggingFace 官方与镜像站的同名文件字节一致，逐个尝试
const MODEL_SOURCES = [
  'https://huggingface.co/camenduru/Wav2Lip/resolve/main/checkpoints/wav2lip_gan.pth',
  'https://hf-mirror.com/camenduru/Wav2Lip/resolve/main/checkpoints/wav2lip_gan.pth'
];
/* 嘴部细节增强（Real-ESRGAN x4）：
   口型模型的 96×96 里嘴只有约 34 像素，直接放大到 200~500px 必然发蜡、唇线发虚、
   牙齿糊成一片。回贴前先用它把嘴部窗口超分一次，唇线、牙缝、皮肤纹理才真正立起来。
   67MB，随口型权重一起装，装不上也只是退回插值放大，不影响出片。 */
const SR_BYTES = 67040989;
const SR_SOURCES = [
  'https://hf-mirror.com/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x4.pth',
  'https://huggingface.co/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x4.pth',
  'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth'
];
// OpenCV 只用来做人脸检测：锁定与 chatterbox 兼容的版本，绝不把 numpy 升到 2.x
const PIP_PKGS = ['numpy==1.26.4', 'opencv-python-headless==4.10.0.84'];
const IDLE_TIMEOUT = 300000;

let depsCache = null;
let activeChild = null;

function engineRoot() {
  return path.join(app.getPath('userData'), 'engines', 'lipsync');
}

function weightsPath() {
  return path.join(engineRoot(), 'models', 'wav2lip_gan.pth');
}

function srPath() {
  return path.join(engineRoot(), 'models', 'realesr_x4.pth');
}

/** 超分权重是「增强项」：没有就退回插值放大，绝不能让整条口播任务失败 */
function srReady() {
  try {
    return fs.statSync(srPath()).size > 55 * 1024 * 1024;
  } catch (_) {
    return false;
  }
}

function scriptPath() {
  const list = [];
  if (process.resourcesPath) {
    list.push(path.join(process.resourcesPath, 'resources', 'lipsync', 'worker.py'));
    list.push(path.join(process.resourcesPath, 'lipsync', 'worker.py'));
  }
  list.push(path.join(__dirname, '..', 'resources', 'lipsync', 'worker.py'));
  return list.find((p) => fs.existsSync(p)) || list[0];
}

function modelReady() {
  try {
    return fs.statSync(weightsPath()).size >= MIN_BYTES;
  } catch (_) {
    return false;
  }
}

/** python 环境来自「本地声音克隆」，没装引擎就没有解释器可用 */
function pythonPath() {
  const st = voicelocal.status();
  return st.installed ? st.python : '';
}

function pythonReady() {
  const p = pythonPath();
  return !!p && fs.existsSync(p);
}

/** 依赖探测会起一次 python（约 1~2 秒），结果进程内缓存 */
function depsReady(force) {
  if (depsCache != null && !force) return Promise.resolve(depsCache);
  const py = pythonPath();
  if (!py) { depsCache = false; return Promise.resolve(false); }
  return new Promise((resolve) => {
    const child = spawn(py, ['-c', 'import cv2, torch, librosa, numpy; print("ok")'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { depsCache = false; resolve(false); });
    child.on('close', (code) => {
      depsCache = code === 0 && /ok/.test(out);
      resolve(depsCache);
    });
  });
}

function status() {
  const st = voicelocal.status();
  return {
    python: pythonReady(),
    engine: st.installed,
    // null = 还没探测过（探测要起 python，约数秒），界面据此显示「检测中」
    deps: depsCache,
    weights: modelReady(),
    sr: srReady(),
    script: fs.existsSync(scriptPath()),
    bytes: modelReady() ? MODEL_BYTES : 0,
    file: weightsPath()
  };
}

/** 异步刷新依赖状态后再给出完整状态（界面首次渲染用） */
async function statusAsync() {
  const s = status();
  s.deps = await depsReady();
  return s;
}

/* ---------------- 依赖安装（OpenCV） ---------------- */
function pipInstall(proxy, onProgress) {
  const py = pythonPath();
  if (!py) return Promise.reject(new Error('本地 Python 环境未安装：请先在「桌面引擎」安装「本地声音克隆」'));
  const proxyUrl = proxy && proxy.host ? `http://${proxy.host}:${proxy.port}` : '';
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    // 让 pip 走与应用一致的代理设置，避免国内直连 PyPI 卡死
    ...(proxyUrl ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl } : {})
  };
  return new Promise((resolve, reject) => {
    const child = spawn(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-q', ...PIP_PKGS], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    activeChild = child;
    let err = '';
    child.stdout.on('data', (d) => { if (onProgress) onProgress({ stage: '安装口型依赖', detail: d.toString().trim().slice(0, 120) }); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { activeChild = null; reject(e); });
    child.on('close', (code) => {
      activeChild = null;
      if (code === 0) resolve(true);
      else reject(new Error(`口型依赖安装失败（${code}）${err.slice(-200).replace(/\s+/g, ' ')}`));
    });
  });
}

async function ensureDeps(proxy, onProgress) {
  if (await depsReady()) return true;
  if (onProgress) onProgress({ stage: '安装口型依赖（OpenCV）', percent: 0 });
  await pipInstall(proxy, onProgress);
  return depsReady(true);
}

/* ---------------- 权重下载 ---------------- */
async function ensureWeights({ proxy, onProgress, onChild } = {}) {
  if (modelReady()) return weightsPath();
  const dest = weightsPath();
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const attempt = async (i, lastErr) => {
    if (i >= MODEL_SOURCES.length) throw lastErr || new Error('口型模型下载失败');
    const url = MODEL_SOURCES[i];
    try {
      const ctrl = new AbortController();
      if (typeof onChild === 'function') onChild(ctrl);
      if (onProgress) onProgress({ stage: `下载口型模型（约 416MB，仅一次）`, percent: 0 });
      await net.downloadToFile(url, tmp, {
        proxy,
        timeout: 60000,
        abortSignal: ctrl.signal,
        onProgress: (got, total) => {
          const t = total || MODEL_BYTES;
          if (onProgress) onProgress({ stage: '下载口型模型', percent: Math.min(99, Math.round((got / t) * 100)) });
        }
      });
      const size = fs.statSync(tmp).size;
      if (Math.abs(size - MODEL_BYTES) > 1024) throw new Error('口型模型下载不完整，请重试');
      fs.renameSync(tmp, dest);
      return dest;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (/已取消/.test(String((e && e.message) || e))) throw e;
      return attempt(i + 1, e);
    }
  };
  return attempt(0, null);
}

async function ensureReady({ proxy, onProgress, onChild } = {}) {
  if (!pythonReady()) throw new Error('口型引擎需要「本地声音克隆」的 Python 环境，请先在桌面引擎安装它');
  await ensureDeps(proxy, onProgress);
  await ensureWeights({ proxy, onProgress, onChild });
  // 嘴部清晰度已改为「原片高清嘴型回贴」：像素直接取自原片同人同机位的真实唇部，
  // 不再依赖 Real-ESRGAN 超分（超分只放大 96×96 的生成结果，反而会造出蜡感）。
  // 这里不再强制下载 64MB 超分权重，仅当本机已存在时由 sync() 顺带传给 worker，
  // 供「供体不足时」的老路径兜底使用。
  return true;
}

/** 嘴部超分权重：失败只降级（退回插值放大），不阻断任务 */
async function ensureSR({ proxy, onProgress, onChild } = {}) {
  if (srReady()) return srPath();
  const dest = srPath();
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const attempt = async (i, lastErr) => {
    if (i >= SR_SOURCES.length) throw lastErr || new Error('嘴部细节增强模型下载失败');
    const url = SR_SOURCES[i];
    try {
      const ctrl = new AbortController();
      if (typeof onChild === 'function') onChild(ctrl);
      if (onProgress) onProgress({ stage: '下载嘴部细节增强模型（约 64MB，仅一次）', percent: 0 });
      await net.downloadToFile(url, tmp, {
        proxy,
        timeout: 30000,
        abortSignal: ctrl.signal,
        onProgress: (got, total) => {
          const t = total || SR_BYTES;
          if (onProgress) onProgress({ stage: '下载嘴部细节增强模型', percent: Math.min(99, Math.round((got / t) * 100)) });
        }
      });
      const size = fs.statSync(tmp).size;
      // 三个来源的字节数略有出入（同一架构的不同训练产物），只校验「够大」即可，
      // 真正的合法性由 worker 里的 load_state_dict 把关
      if (size < 55 * 1024 * 1024) throw new Error('嘴部细节增强模型下载不完整，请重试');
      fs.renameSync(tmp, dest);
      return dest;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (/已取消/.test(String((e && e.message) || e))) throw e;
      return attempt(i + 1, e);
    }
  };
  return attempt(0, null);
}

/* ---------------- 推理 ---------------- */
/**
 * @param {{video:string,audio:string,out:string,fps:number,onProgress:Function,onChild:Function}} opts
 * video: 已切好的口播画面（含完整的窗口时长）
 * audio: 目标语言配音 wav（长度与画面一致）
 */
function sync({ video, audio, out, fps, onProgress, onChild } = {}) {
  if (!pythonReady()) return Promise.reject(new Error('本地 Python 环境未安装'));
  if (!modelReady()) return Promise.reject(new Error('口型模型未下载，请先安装口型引擎'));
  const script = scriptPath();
  if (!fs.existsSync(script)) return Promise.reject(new Error('缺少口型推理脚本，请重新安装客户端'));

  const py = pythonPath();
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    // 绝不往脚本目录写 .pyc：打包后脚本就在 App 包内（Contents/Resources/...），
    // 一旦生成 __pycache__ 就会改动已签名的 bundle，下次启动时 macOS 校验失败
    PYTHONDONTWRITEBYTECODE: '1',
    // 只跑推理，任何 hub 访问都禁止（模型是本地的，走 hub 校验会拖几十秒甚至报错）
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    OMP_NUM_THREADS: String(Math.max(2, Math.min(8, require('os').cpus().length)))
  };
  const args = [
    '-u', script,
    '--video', video,
    '--audio', audio,
    '--out', out,
    '--weights', weightsPath(),
    '--ffmpeg', ffmpegMod.getFfmpegPath(),
    '--fps', String(fps || 25),
    '--batch', '16',
    // 口型重绘是整条链路里最容易糊的一环：源片、口型、成片要各编码一次，
    // CRF 放到 17 尽量少丢高频细节，避免嘴部被连续压缩磨平
    '--crf', '17'
  ];
  // 有超分权重就让 worker 先给嘴部窗口超分再回贴（这是「不发蜡」的关键）
  if (srReady()) args.push('--sr-weights', srPath());

  const child = spawn(py, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChild = child;
  if (typeof onChild === 'function') onChild(child);

  let buf = '';
  let errTail = '';
  let lastBeat = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastBeat > IDLE_TIMEOUT) {
      try { child.kill('SIGKILL'); } catch (_) {}
    }
  }, 10000);
  if (watchdog.unref) watchdog.unref();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const at = line.indexOf('@@PROG ');
      if (at < 0) continue;
      try {
        const msg = JSON.parse(line.slice(at + 7));
        lastBeat = Date.now();
        if (typeof onProgress === 'function') onProgress(msg);
      } catch (_) { /* 半行/脏行忽略 */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    errTail = (errTail + c).slice(-2500);
    lastBeat = Date.now();
  });

  return new Promise((resolve, reject) => {
    child.on('error', (e) => {
      clearInterval(watchdog);
      activeChild = null;
      reject(new Error(`口型引擎启动失败：${e.message}`));
    });
    child.on('close', (code) => {
      clearInterval(watchdog);
      activeChild = null;
      const tail = errTail.split('\n').filter((l) => l.trim()).slice(-2).join(' ');
      if (code === 0 && fs.existsSync(out)) { resolve(out); return; }
      if (/NO_FACE/.test(errTail)) {
        reject(Object.assign(new Error('未能识别到人脸：请使用正面、单人、无遮挡的口播画面'), { code: 'NO_FACE' }));
        return;
      }
      reject(new Error(`口型生成失败（${code}）${tail ? '：' + tail.slice(0, 200) : ''}`));
    });
  });
}

function cancel() {
  if (!activeChild) return false;
  try { activeChild.kill('SIGKILL'); } catch (_) {}
  activeChild = null;
  return true;
}

module.exports = {
  status,
  statusAsync,
  ensureReady,
  ensureWeights,
  ensureSR,
  ensureDeps,
  sync,
  cancel,
  weightsPath,
  srPath,
  srReady,
  engineRoot
};
