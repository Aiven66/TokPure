'use strict';

/* ============================================================
   TokPure — on-device engine hub (R1)
   瘦安装包策略：所有 AI 引擎/模型都不进安装包，首次使用时按需下载
   到 userData/ai 下；支持多镜像、断点取消、安装清单与删除。
   目录结构：
     userData/ai/engines/<id>/...        引擎二进制（解压原样保留）
     userData/ai/engines/<id>/tokpure-install.json
     userData/ai/models/<relPath>        模型权重
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const net = require('./net');

const GH_PROXY = ['https://gh-proxy.com/', 'https://ghfast.top/'];

/** 为给定直链生成「直连优先、国内镜像兜底」的候选列表 */
function mirrors(origin) {
  const list = [origin];
  if (origin.startsWith('https://github.com/')) {
    GH_PROXY.forEach((p) => list.push(p + origin));
  } else if (origin.startsWith('https://huggingface.co/')) {
    list.push(origin.replace('https://huggingface.co/', 'https://hf-mirror.com/'));
  }
  return list;
}

function aiRoot() {
  return path.join(app.getPath('userData'), 'ai');
}
function enginesDir() {
  return path.join(aiRoot(), 'engines');
}
function modelsDir() {
  return path.join(aiRoot(), 'models');
}
function tmpDir() {
  return path.join(aiRoot(), 'tmp');
}
function ensureDirs() {
  [aiRoot(), enginesDir(), modelsDir(), tmpDir()].forEach((d) => fs.mkdirSync(d, { recursive: true }));
}

const platformKey = () => `${process.platform}-${process.arch}`;
const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? n + '.exe' : n);

/* ---------------- 引擎清单 ----------------
   assets 按 platform-arch 声明；size 为压缩包字节数（0 表示未知）。
   bin 为解压后在引擎目录内的可执行文件名（递归查找）。 */
const ENGINES = [
  {
    id: 'whisper',
    name: 'Whisper.cpp 语音识别引擎',
    version: '1.9.5',
    license: 'MIT',
    feature: 'subtitle',
    summary: '本地语音转文字，驱动「AI 字幕」。多语言、离线运行。',
    bin: () => exe('whisper-cli'),
    assets: {
      'darwin-arm64': {
        url: 'https://github.com/Aiven66/TokPure/releases/download/sidecars-v1/whisper-cpp-1.9.5-macos-arm64.zip',
        size: 0
      }
    }
  },
  {
    id: 'realsr',
    name: 'RealSR 超分辨率引擎',
    version: '20220728',
    license: 'MIT',
    feature: 'enhance',
    summary: '真人视频 4x 超分（官方包仅提供 x4 模型），ncnn + Vulkan 加速。',
    bin: () => exe('realsr-ncnn-vulkan'),
    modelsRel: 'models',
    assets: {
      'darwin-arm64': {
        url: 'https://github.com/nihui/realsr-ncnn-vulkan/releases/download/20220728/realsr-ncnn-vulkan-20220728-macos.zip',
        size: 66 * 1024 * 1024
      },
      'darwin-x64': {
        url: 'https://github.com/nihui/realsr-ncnn-vulkan/releases/download/20220728/realsr-ncnn-vulkan-20220728-macos.zip',
        size: 66 * 1024 * 1024
      },
      'win32-x64': {
        url: 'https://github.com/nihui/realsr-ncnn-vulkan/releases/download/20220728/realsr-ncnn-vulkan-20220728-windows.zip',
        size: 61 * 1024 * 1024
      }
    }
  },
  {
    id: 'realcugan',
    name: 'Real-CUGAN 动漫超分引擎',
    version: '20220728',
    license: 'MIT',
    feature: 'enhance',
    summary: '动漫/二次元视频 2x/3x 超分与降噪，ncnn + Vulkan。',
    bin: () => exe('realcugan-ncnn-vulkan'),
    modelsRel: 'models',
    assets: {
      'darwin-arm64': {
        url: 'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-macos.zip',
        size: 49 * 1024 * 1024
      },
      'darwin-x64': {
        url: 'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-macos.zip',
        size: 49 * 1024 * 1024
      },
      'win32-x64': {
        url: 'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-windows.zip',
        size: 43 * 1024 * 1024
      }
    }
  },
  {
    id: 'rife',
    name: 'RIFE 智能插帧引擎',
    version: '20221029',
    license: 'MIT',
    feature: 'enhance',
    summary: '视频帧率翻倍（30→60fps），慢动作/丝滑化，ncnn + Vulkan。',
    bin: () => exe('rife-ncnn-vulkan'),
    modelsRel: '.', // rife 各模型目录与二进制同级（rife-v4.6/ 等）
    // 官方包内含 v2.3~v4.6 全部模型（416MB），只保留最新 v4.6
    pruneModels: ['rife-v4.6'],
    assets: {
      'darwin-arm64': {
        url: 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-macos.zip',
        size: 416 * 1024 * 1024
      },
      'darwin-x64': {
        url: 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-macos.zip',
        size: 416 * 1024 * 1024
      },
      'win32-x64': {
        url: 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip',
        size: 411 * 1024 * 1024
      }
    }
  }
];

/* ---------------- 模型清单 ----------------
   引擎专用模型存 models/<engine>/ 下，按文件存在与否判断已安装。 */
const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MODELS = [
  {
    id: 'whisper-tiny',
    engine: 'whisper',
    name: 'Whisper Tiny（极速）',
    lang: '多语言',
    size: 75 * 1024 * 1024,
    rel: path.join('whisper', 'ggml-tiny.bin'),
    urls: mirrors(HF_WHISPER + 'ggml-tiny.bin'),
    note: '75MB · 速度最快，准确率一般，适合老电脑'
  },
  {
    id: 'whisper-base',
    engine: 'whisper',
    name: 'Whisper Base（均衡，推荐）',
    lang: '多语言',
    size: 148 * 1024 * 1024,
    rel: path.join('whisper', 'ggml-base.bin'),
    urls: mirrors(HF_WHISPER + 'ggml-base.bin'),
    note: '148MB · 速度/准确率均衡，M 芯片接近实时'
  },
  {
    id: 'whisper-small',
    engine: 'whisper',
    name: 'Whisper Small（高精度）',
    lang: '多语言',
    size: 466 * 1024 * 1024,
    rel: path.join('whisper', 'ggml-small.bin'),
    urls: mirrors(HF_WHISPER + 'ggml-small.bin'),
    note: '466MB · 准确率更高，耗时约 Base 的 3 倍'
  }
];

/* ---------------- 状态查询 ---------------- */
function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function dirSize(p) {
  let total = 0;
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else {
          try { total += fs.statSync(fp).size; } catch (_) {}
        }
      }
    };
    walk(p);
  } catch (_) {}
  return total;
}

function engineStatus(spec) {
  const pk = platformKey();
  const asset = spec.assets[pk];
  const dir = path.join(enginesDir(), spec.id);
  let installed = false;
  let binPath = null;
  let binRel = null;
  const manifest = readJsonSafe(path.join(dir, 'tokpure-install.json'));
  if (manifest && manifest.binRel) {
    const bp = path.join(dir, manifest.binRel);
    if (fs.existsSync(bp)) {
      installed = true;
      binPath = bp;
      binRel = manifest.binRel;
    }
  }
  return {
    id: spec.id,
    name: spec.name,
    version: spec.version,
    license: spec.license,
    feature: spec.feature,
    summary: spec.summary,
    supported: !!asset,
    downloadSize: asset ? asset.size : 0,
    installed,
    binPath,
    binRel,
    installSize: installed ? dirSize(dir) : 0
  };
}

function modelStatus(m) {
  const fp = path.join(modelsDir(), m.rel);
  let size = 0;
  let installed = false;
  try {
    const st = fs.statSync(fp);
    if (st.isFile() && st.size > 1024) { installed = true; size = st.size; }
  } catch (_) {}
  return { id: m.id, engine: m.engine, name: m.name, lang: m.lang, size: m.size, rel: m.rel, note: m.note, installed, installedSize: size, path: installed ? fp : null };
}

function status() {
  ensureDirs();
  return {
    root: aiRoot(),
    enginesDir: enginesDir(),
    modelsDir: modelsDir(),
    engines: ENGINES.map(engineStatus),
    models: MODELS.map(modelStatus),
    totalUsed: dirSize(aiRoot())
  };
}

function getEngine(id) {
  return ENGINES.find((e) => e.id === id);
}
function getModel(id) {
  return MODELS.find((m) => m.id === id);
}

/** 已安装引擎的可执行文件绝对路径；未安装返回 null */
function engineBin(id) {
  const spec = getEngine(id);
  if (!spec) return null;
  return engineStatus(spec).binPath;
}
function modelPath(id) {
  const m = getModel(id);
  if (!m) return null;
  const fp = path.join(modelsDir(), m.rel);
  return fs.existsSync(fp) ? fp : null;
}

/* ---------------- 下载与安装 ---------------- */
const actives = new Map(); // id -> AbortController

/** 按镜像顺序下载，全部失败才抛错 */
async function downloadWithMirrors(urls, dest, proxy, onProgress, signal) {
  let lastErr = null;
  for (const u of urls) {
    if (signal && signal.aborted) throw new Error('已取消');
    try {
      const r = await net.downloadToFile(u, dest, {
        proxy,
        signal,
        timeout: 45000,
        onProgress: (received, total) => onProgress(received, total, u)
      });
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return r;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(dest); } catch (_) {}
    }
  }
  throw lastErr || new Error('全部下载源均失败');
}

function walkFind(dir, matcher) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = walkFind(fp, matcher);
      if (hit) return hit;
    } else if (matcher(e.name, fp)) {
      return fp;
    }
  }
  return null;
}

function execTar(args) {
  return new Promise((resolve, reject) => {
    // macOS/Windows10+ 自带 bsdtar（tar.exe），可解压 zip 与 tar.bz2；Linux 用 tar/unzip
    const child = spawn('tar', args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-500) || `tar 退出码 ${code}`))));
  });
}

function chmodTree(dir) {
  // 可执行文件与动态库补执行权限（zip 不带 unix 权限位时必需）
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.(dylib|so|exe)$/i.test(e.name) || !path.extname(e.name)) {
        try { fs.chmodSync(fp, 0o755); } catch (_) {}
      }
    }
  };
  walk(dir);
}

function pruneModelDir(modelsRoot, keep) {
  if (!keep || !fs.existsSync(modelsRoot)) return;
  for (const e of fs.readdirSync(modelsRoot, { withFileTypes: true })) {
    // 只裁剪模型目录；二进制 / README / LICENSE 等文件一律保留
    if (!e.isDirectory()) continue;
    const base = e.name.replace(/\.(pth|param|bin|onnx)$/i, '');
    if (!keep.includes(e.name) && !keep.includes(base)) {
      try { fs.rmSync(path.join(modelsRoot, e.name), { recursive: true, force: true }); } catch (_) {}
    }
  }
}

async function installEngine(id, proxy, emit) {
  const spec = getEngine(id);
  if (!spec) throw new Error('未知引擎');
  const pk = platformKey();
  const asset = spec.assets[pk];
  if (!asset) throw new Error(`当前平台暂不支持该引擎（${pk}）`);
  if (actives.has(id)) throw new Error('该引擎正在安装中');

  const controller = new AbortController();
  actives.set(id, controller);
  ensureDirs();
  const target = path.join(enginesDir(), id);
  const stage = path.join(tmpDir(), `engine-${id}-${Date.now()}`);
  const archive = path.join(tmpDir(), `${id}-${Date.now()}.pkg`);
  const startedAt = Date.now();
  try {
    await downloadWithMirrors(mirrors(asset.url), archive, proxy, (received, total, url) => {
      const speed = received / Math.max(1, (Date.now() - startedAt) / 1000);
      emit({ id, kind: 'engine', phase: 'download', received, total, percent: total ? Math.min(99, (received / total) * 100) : -1, speed });
    }, controller.signal);
    if (controller.signal.aborted) throw new Error('已取消');

    emit({ id, kind: 'engine', phase: 'extract', percent: 0 });
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    await execTar(['-xf', archive, '-C', stage]);

    const wantBin = spec.bin();
    const binFull = walkFind(stage, (name) => name === wantBin);
    if (!binFull) throw new Error(`压缩包内未找到可执行文件 ${wantBin}`);
    chmodTree(stage);
    if (spec.pruneModels && spec.modelsRel) {
      const rel = spec.modelsRel === '.' ? '' : spec.modelsRel;
      pruneModelDir(path.join(path.dirname(binFull), rel), spec.pruneModels);
    }

    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(stage, target);
    try { fs.unlinkSync(archive); } catch (_) {}

    const finalBin = walkFind(target, (name) => name === wantBin);
    const binRel = path.relative(target, finalBin);
    fs.writeFileSync(path.join(target, 'tokpure-install.json'), JSON.stringify({
      id, version: spec.version, binRel, installedAt: Date.now(), platform: pk
    }, null, 2));
    emit({ id, kind: 'engine', phase: 'ready', percent: 100 });
    return engineStatus(spec);
  } catch (e) {
    emit({ id, kind: 'engine', phase: 'error', message: e.message });
    throw e;
  } finally {
    actives.delete(id);
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(archive); } catch (_) {}
  }
}

async function installModel(id, proxy, emit) {
  const m = getModel(id);
  if (!m) throw new Error('未知模型');
  const key = `model:${id}`;
  if (actives.has(key)) throw new Error('该模型正在下载中');
  const controller = new AbortController();
  actives.set(key, controller);
  ensureDirs();
  const dest = path.join(modelsDir(), m.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const startedAt = Date.now();
  try {
    await downloadWithMirrors(m.urls, dest, proxy, (received, total) => {
      const speed = received / Math.max(1, (Date.now() - startedAt) / 1000);
      emit({ id, kind: 'model', phase: 'download', received, total, percent: total ? Math.min(99, (received / total) * 100) : -1, speed });
    }, controller.signal);
    if (controller.signal.aborted) throw new Error('已取消');
    emit({ id, kind: 'model', phase: 'ready', percent: 100 });
    return modelStatus(m);
  } catch (e) {
    emit({ id, kind: 'model', phase: 'error', message: e.message });
    throw e;
  } finally {
    actives.delete(key);
  }
}

function cancelInstall(id) {
  ['engine', 'model'].forEach(() => {});
  const ctrl = actives.get(id) || actives.get(`model:${id}`);
  if (ctrl) ctrl.abort();
  return !!ctrl;
}

function uninstall(kind, id) {
  if (kind === 'engine') {
    const spec = getEngine(id);
    if (!spec) return false;
    fs.rmSync(path.join(enginesDir(), id), { recursive: true, force: true });
  } else {
    const m = getModel(id);
    if (!m) return false;
    try { fs.unlinkSync(path.join(modelsDir(), m.rel)); } catch (_) {}
  }
  return true;
}

module.exports = {
  status,
  installEngine,
  installModel,
  cancelInstall,
  uninstall,
  engineBin,
  modelPath,
  getEngine,
  getModel
};
