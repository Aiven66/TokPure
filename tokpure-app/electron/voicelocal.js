'use strict';

/* ============================================================
   TokPure — 本地声音克隆引擎（Chatterbox Multilingual，MIT）

   完全离线：用原片 5~20 秒人声做零样本克隆，直接合成 23 种语言，
   全程不联网、不上传任何音频。
   引擎以常驻子进程运行：0.5B 模型只在会话开始时加载一次，
   之后每句合成都复用同一份权重与说话人条件，避免逐句重载。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');

const isWin = process.platform === 'win32';
const SPAWN_OPTS = isWin ? { windowsHide: true } : {};

const READY_TIMEOUT = 240000;
// 本地克隆是 8~12 倍实时，一句长句可能要好几分钟；只要有心跳就不算超时，
// 真正判定卡死的是「IDLE_TIMEOUT 内一句心跳都没有」。
const IDLE_TIMEOUT = 180000;
const REF_TIMEOUT = 600000;

const LANG_MAP = {
  zh: 'zh',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  pt: 'pt',
  fr: 'fr',
  de: 'de'
};

// 所有存活会话：退出应用 / 重新加载界面时必须全部回收，
// 否则 2GB 级的 Python 进程会留在后台继续吃内存（用户看到的就是「越用越卡」）。
const LIVE = new Set();

function closeAll() {
  LIVE.forEach((s) => {
    try { s.close(); } catch (_) {}
  });
  LIVE.clear();
}

function engineRoot() {
  return path.join(app.getPath('userData'), 'engines', 'voiceclone');
}

function venvPython() {
  return process.platform === 'win32'
    ? path.join(engineRoot(), 'venv', 'Scripts', 'python.exe')
    : path.join(engineRoot(), 'venv', 'bin', 'python');
}

/** worker.py 在开发态与打包态的位置不同，逐个探测 */
function workerScript() {
  const list = [];
  if (process.resourcesPath) {
    list.push(path.join(process.resourcesPath, 'resources', 'voiceclone', 'worker.py'));
    list.push(path.join(process.resourcesPath, 'voiceclone', 'worker.py'));
  }
  list.push(path.join(__dirname, '..', 'resources', 'voiceclone', 'worker.py'));
  return list.find((p) => fs.existsSync(p)) || list[0];
}

function sitePackages() {
  const base = path.join(engineRoot(), 'venv');
  const dir = process.platform === 'win32'
    ? path.join(base, 'Lib', 'site-packages')
    : path.join(base, 'lib');
  if (process.platform === 'win32') return dir;
  try {
    const v = fs.readdirSync(dir).find((d) => /^python3\.\d+$/.test(d));
    return v ? path.join(dir, v, 'site-packages') : dir;
  } catch (_) {
    return dir;
  }
}

function hfCache() {
  return path.join(engineRoot(), 'hf');
}

/** 引擎目录体积（字节）。venv 里有几万个文件，同步递归 stat 会把主进程按住
    好几秒（窗口无响应、CDP 也像卡死），所以只读缓存，后台异步慢慢算。 */
let sizeCache = { at: 0, bytes: 0 };
let sizeWalk = null;
async function walkBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let items = [];
    try {
      items = await fs.promises.readdir(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const it of items) {
      const p = path.join(cur, it.name);
      if (it.isDirectory()) {
        stack.push(p);
      } else if (it.isFile()) {
        try { total += (await fs.promises.stat(p)).size; } catch (_) { /* 忽略单个文件失败 */ }
      }
    }
  }
  return total;
}

/** 只启动一次遍历：并发调用共用同一个 promise，不会重复扫盘 */
function refreshSize() {
  if (sizeWalk) return sizeWalk;
  sizeWalk = walkBytes(engineRoot())
    .then((bytes) => { sizeCache = { at: Date.now(), bytes }; return bytes; })
    .catch(() => sizeCache.bytes)
    .then((bytes) => { sizeWalk = null; return bytes; });
  return sizeWalk;
}

function engineBytes() {
  if (Date.now() - sizeCache.at > 300000) refreshSize();
  return sizeCache.bytes;
}

/** 需要准确体积时（如克隆引擎连通性测试）才等待遍历完成，绝不阻塞主进程 */
async function sizeAsync() {
  if (sizeCache.bytes) return sizeCache.bytes;
  return refreshSize();
}

/** 轻量探测：只做 existsSync / 一层 readdir，绝不遍历 venv */
function probe() {
  const py = venvPython();
  const pkg = path.join(sitePackages(), 'chatterbox');
  const installed = fs.existsSync(py) && fs.existsSync(pkg);
  let weights = false;
  try {
    weights = fs.readdirSync(path.join(hfCache(), 'hub')).some((d) => /chatterbox/i.test(d));
  } catch (_) {
    weights = false;
  }
  return { installed, weights };
}

/** 引擎是否可用：python + chatterbox 包 + 已缓存的多语模型权重 */
function status() {
  const p = probe();
  return {
    installed: p.installed,
    weights: p.weights,
    bytes: p.installed ? engineBytes() : 0,
    python: p.installed ? venvPython() : '',
    root: engineRoot(),
    script: workerScript()
  };
}

function requireEngine() {
  // 这里不能调 status()：它虽然只读缓存，但用不着体积数据，
  // 高频调用（每句重建会话）时不碰磁盘才是最稳的。
  const p = probe();
  if (!p.installed) {
    throw new Error('本地克隆引擎尚未安装。请到「桌面引擎」里安装「本地声音克隆」，或先使用「本地近似」模式。');
  }
  return {
    installed: true,
    weights: p.weights,
    python: venvPython(),
    root: engineRoot(),
    script: workerScript()
  };
}

/**
 * 启动一次常驻会话。
 * @param {{refAudio:string, lang:string, onLog?:Function}} opts
 */
async function openSession({ refAudio, lang, onLog, threads, conc, steps } = {}) {
  const s = requireEngine();
  if (!refAudio || !fs.existsSync(refAudio)) throw new Error('缺少原声参考音频');

  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    // 打包态 worker.py 位于已签名的 App 包内，写 __pycache__ 会破坏 bundle 签名
    PYTHONDONTWRITEBYTECODE: '1',
    HF_HOME: hfCache(),
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com'
  };
  // 权重已经在安装阶段下载到本地：强制离线加载。
  // 不加这两个开关时 from_pretrained 会先去 hub 校验最新版本，
  // 网络不通就无声地卡上几分钟（表现为「任务开始了但一直没进度」）。
  if (s.weights) {
    env.HF_HUB_OFFLINE = '1';
    env.TRANSFORMERS_OFFLINE = '1';
  }
  // 多路并行时给每路分配固定线程，避免 8 核上线程数远超核数互相抢
  if (threads) env.VC_THREADS = String(threads);
  // 设备自动选择：Apple Silicon 优先走 Metal(MPS)，实测同一批句子吞吐约为
  // CPU 的 3~5 倍（逐 token 解码时 Python 侧的等待被 GPU 掩盖）；MPS 不可用
  // 或加载失败时 worker 会自动退回 cpu，不会让任务失败。
  if (!env.VC_DEVICE) env.VC_DEVICE = 'auto';
  // 进程内并发句数：0.5B 模型逐 token 解码时 Python 线程经常在等矩阵乘，
  // 同时跑 2~3 句能把空闲核利用起来（上游 alignment 分析器已在上层替换为无状态实现）
  if (conc) env.VC_CONC = String(conc);
  // flow-matching 解码步数，10 → 6 省掉约四成声码器耗时，听感几乎无差
  if (steps) env.VC_STEPS = String(steps);
  const child = spawn(s.python, ['-u', s.script], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const pending = new Map();
  let seq = 0;
  let ready = false;
  let readyResolve = null;
  let readyReject = null;
  const readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  let buf = '';
  let closed = false;
  // 会话句柄在 ready 之后才组装，但 exit 回调可能更早触发，所以先占位再赋值
  let session = null;
  // 加载阶段超时：只要 worker 还在往外吐消息（boot / ready / warning）就续期。
  // 之前是一整段固定 240 秒，模型冷加载 + 首次推理预热慢一点就被判「加载超时」，
  // 上层再重试一次，于是同时挂着两三个 2GB 进程，内存直接爆掉。
  let readyTimer = null;
  const armReady = () => {
    if (ready || closed) return;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      failAll(new Error('本地克隆引擎加载超时，请重试'));
      try { child.kill('SIGKILL'); } catch (_) {}
    }, READY_TIMEOUT);
  };

  const log = (msg) => { if (typeof onLog === 'function') { try { onLog(msg); } catch (_) {} } };

  function settle(id, err, value) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err); else p.resolve(value);
  }

  function handle(line) {
    let msg = null;
    try { msg = JSON.parse(line); } catch (_) { return; }
    // 任何一条消息都证明进程还在推进，续上加载超时
    if (!ready) armReady();
    if (msg.event === 'boot') { log({ stage: '加载本地克隆模型' }); return; }
    if (msg.event === 'load') { log({ stage: '加载本地克隆模型', loading: true, elapsed: msg.elapsed || 0 }); return; }
    if (msg.event === 'ready') {
      ready = true;
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      log({ stage: '本地克隆模型已就绪', device: msg.device, sr: msg.sr });
      readyResolve(msg);
      return;
    }
    if (msg.event === 'fatal') {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      const err = new Error(msg.error || '本地克隆引擎启动失败');
      readyReject(err);
      pending.forEach((p, id) => settle(id, err));
      return;
    }
    if (msg.event === 'warn') { log({ stage: '本地克隆引擎提示' }); return; }
    if (msg.event === 'saying') {
      const p = pending.get(msg.id);
      if (p && p.arm) p.arm();
      log({ stage: '合成中', saying: true, chars: msg.chars || 0 });
      return;
    }
    if (msg.event === 'beat') {
      const p = pending.get(msg.id);
      if (p && p.arm) p.arm();
      // 带上句子序号：并发合成时心跳不知道该算到哪一句，上层就没法把进度放对位置
      log({ stage: '合成中', beat: true, elapsed: msg.elapsed || 0, tag: p && p.tag });
      return;
    }
    // 句内进度：worker 逐 token 生成时会回「本句已生成多少 / 上限多少」，
    // 上层据此让进度条在句子内部平滑推进，而不是一格一格地跳
    if (msg.event === 'progress') {
      const p = pending.get(msg.id);
      if (p && p.arm) p.arm();
      log({ stage: '合成中', progress: true, tokens: msg.tokens || 0, cap: msg.cap || 0, tag: msg.tag });
      return;
    }
    if (msg.event === 'ref_ok') { settle(msg.id, null, msg); return; }
    if (msg.event === 'done') { settle(msg.id, null, msg); return; }
    if (msg.event === 'error') { settle(msg.id, new Error(msg.error || '本地合成失败')); return; }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handle(line);
    }
  });

  // 引擎日志走 stderr，只在结束时用于报错定位
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    stderrTail = (stderrTail + c).slice(-4000);
  });

  const failAll = (err) => {
    if (closed) return;
    closed = true;
    readyReject(err);
    pending.forEach((p, id) => settle(id, err));
  };

  child.on('error', (e) => failAll(new Error(`本地克隆引擎启动失败：${e.message}`)));
  child.on('exit', (code) => {
    LIVE.delete(session);
    if (closed) return;
    const tail = stderrTail.split('\n').filter((l) => l.trim()).slice(-2).join(' ');
    failAll(new Error(`本地克隆引擎已退出（${code}）${tail ? '：' + tail.slice(0, 200) : ''}`));
  });

  // 兜底：父进程（Electron）异常退出时 stdin 会被关闭，worker 读到 EOF 自行结束，
  // 不会留下没人管的后台 Python 进程。
  child.stdin.on('error', () => {});

  armReady();
  let readyMsg = null;
  try {
    readyMsg = await readyPromise;
  } catch (e) {
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    // 加载失败/超时也要立刻回收进程：留着就是个吃 2GB 的僵尸 worker，
    // 上层重试一次又会再起一个，内存就是这么堆起来的。
    if (!closed) { closed = true; try { child.kill('SIGKILL'); } catch (_) {} }
    throw e;
  }
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }

  const request = (payload, timeout, label) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('本地克隆引擎已关闭')); return; }
    const id = ++seq;
    const entry = { resolve, reject, timer: null, tag: payload && payload.tag };
    // 心跳每来一次就把超时往后推，只有「长时间完全没有响应」才算卡死
    entry.arm = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => settle(id, new Error(label)), timeout);
    };
    entry.arm();
    pending.set(id, entry);
    try {
      // worker 用 id 回传事件，必须带上，否则 ref / say 的应答匹配不到
      child.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
    } catch (e) {
      settle(id, new Error(`本地引擎写入失败：${e.message}`));
    }
  });

  session = {
    ready,
    // 实际生效的设备（mps / cpu）：上层据此决定并发句数——
    // GPU 上 5 路同时解码吞吐最高，CPU 上超过 3 路只会互相抢核
    device: (readyMsg && readyMsg.device) || 'cpu',
    async prepare(ref) {
      const r = await request({ cmd: 'ref', ref }, REF_TIMEOUT, '准备参考音色超时');
      return r;
    },
    async speak(text, out, language, opts = {}) {
      const payload = {
        cmd: 'say',
        text,
        out,
        lang: LANG_MAP[language] || language || 'en'
      };
      // 按目标时长换算的 token 上限：超出会被上层丢弃，白烧算力
      const cap = Number(opts && opts.maxTokens) || 0;
      if (cap > 0) payload.max_tokens = Math.round(cap);
      // 单句墙钟上限：到点 worker 会带着已生成的部分返回（truncated=true），
      // 既不无限占住槽位，也不至于让整句掉成系统音色。
      const maxS = Number(opts && opts.maxSeconds) || 0;
      if (maxS > 0) payload.max_seconds = Math.round(maxS);
      // 句子序号：worker 的进度事件会原样回传，上层才能把「这一句已生成多少」
      // 折算到整条进度条的正确位置（并发合成时多句同时在跑）
      if (opts && opts.tag != null) payload.tag = opts.tag;
      const r = await request(payload, IDLE_TIMEOUT, '本地引擎长时间无响应（合成中断）');
      return r;
    },
    close() {
      if (closed) return;
      closed = true;
      LIVE.delete(session);
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      try { child.stdin.write('{"cmd":"shutdown"}\n'); } catch (_) {}
      // 关掉 stdin：worker 的 for line in sys.stdin 读到 EOF 会自然退出，
      // 正在合成的线程随之结束，比只发 shutdown 更可靠。
      try { child.stdin.end(); } catch (_) {}
      pending.forEach((p, id) => settle(id, new Error('已取消')));
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1500);
      if (t.unref) t.unref();
    }
  };
  LIVE.add(session);
  return session;
}

/* ---------------- 引擎安装（3.9.27） ----------------
   macOS 与 Windows 走同一套流程：找系统 Python 3.9+ → 建 venv →
   pip 装 torch / chatterbox → 校验 import。Windows 用 torch 的 CPU 轮子源
   （官方 PyPI 的默认轮子在 Windows 上依赖 CUDA 运行库，普通机器装完起不来）。 */
const PY_PKGS = [
  'numpy==1.26.4',
  'transformers==4.46.3',
  'chatterbox-tts==0.1.7',
  'librosa==0.11.0',
  'soundfile==0.14.0',
  'opencv-python-headless==4.10.0.84'
];
const TORCH_PKGS = ['torch==2.6.0', 'torchaudio==2.6.0'];
const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';

function execCapture(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...SPAWN_OPTS, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

function runStream(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: opts.env || process.env, windowsHide: true });
    if (opts.onChild) opts.onChild(child);
    let tail = '';
    const onData = (buf) => {
      const s = buf.toString();
      tail = (tail + s).slice(-4000);
      if (opts.onLine) s.split(/\r?\n/).forEach((l) => { if (l.trim()) opts.onLine(l.trim()); });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(tail);
      else reject(new Error(`安装命令失败（退出码 ${code}）\n${tail.slice(-800)}`));
    });
  });
}

/** 找可用的系统 Python（3.9–3.13）。
    不能随便挑：本机 homebrew 默认的 python3 可能是 3.14，而 torch 2.6 只发到 cp313，
    选错了用户会看到一长串「no matching distribution」。所以按「越接近 3.11 越优先」排。 */
function pyCandidates() {
  const versions = ['3.11', '3.12', '3.10', '3.13', '3.9'];
  if (process.platform === 'win32') {
    const list = versions.map((v) => ({ cmd: 'py', args: [`-${v}`] }));
    return [...list, { cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] }];
  }
  const home = os.homedir();
  const prefixes = [path.join(home, '.pyenv', 'shims'), '/opt/homebrew/bin', '/usr/local/bin'];
  const list = [];
  prefixes.forEach((dir) => versions.forEach((v) => list.push({ cmd: path.join(dir, `python${v}`), args: [] })));
  return [
    ...list,
    { cmd: '/opt/homebrew/bin/python3', args: [] },
    { cmd: '/usr/local/bin/python3', args: [] },
    { cmd: '/usr/bin/python3', args: [] },
    { cmd: 'python3', args: [] }
  ];
}

const PY_MIN = [3, 9];
const PY_MAX = [3, 13];

async function findPython() {
  let tooNew = '';
  let tooOld = '';
  for (const c of pyCandidates()) {
    try {
      const out = await execCapture(c.cmd, [...c.args, '-c', "import sys;print('%d.%d' % sys.version_info[:2])"]);
      const [maj, min] = out.trim().split('.').map(Number);
      if (maj !== 3 || Number.isNaN(min)) continue;
      const version = `${maj}.${min}`;
      if (min > PY_MAX[1]) { tooNew = version; continue; }
      if (min < PY_MIN[1]) { tooOld = version; continue; }
      return { ok: true, cmd: c.cmd, args: c.args, version };
    } catch (_) { /* 该候选不可用，继续试下一个 */ }
  }
  const reason = tooNew
    ? `检测到 Python ${tooNew}，版本过高：PyTorch 2.6 只支持 3.9–3.13，请安装 Python 3.11 或 3.12 后重试`
    : tooOld
      ? `检测到 Python ${tooOld}，版本过低：需要 3.9 及以上`
      : (process.platform === 'win32'
        ? '未找到可用的 Python。请安装 Python 3.11/3.12（https://www.python.org/downloads/windows/ ，安装时勾选「Add python.exe to PATH」）后重试'
        : '未找到可用的 Python。请安装 Python 3.11/3.12（https://www.python.org/downloads/macos/ ）后重试');
  return { ok: false, version: tooNew || tooOld, reason };
}

function pipEnv(proxy) {
  const env = {
    ...process.env,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1'
  };
  if (proxy && proxy.host) {
    const url = `http://${proxy.host}:${proxy.port}`;
    env.HTTP_PROXY = url;
    env.HTTPS_PROXY = url;
  }
  delete env.PYTHONHOME;
  return env;
}

async function pipInstall(py, args, { proxy, onLine, onChild }) {
  try {
    return await runStream(py, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', ...args], {
      env: pipEnv(proxy),
      onLine,
      onChild
    });
  } catch (e) {
    // 公司网络 / 大陆网络直连 PyPI 常见超时：换清华镜像再试一次（torch 源不换，官方没有镜像）
    if (args.includes(TORCH_CPU_INDEX) || args.includes('--index-url')) throw e;
    return runStream(py, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '-i', PYPI_MIRROR, ...args], {
      env: pipEnv(proxy),
      onLine,
      onChild
    });
  }
}

/**
 * 安装本地克隆引擎。
 * opts: { proxy, onProgress({stage, percent}), onChild(child) }
 * 返回 status()；失败时抛出带中文说明的错误。
 */
async function install(opts = {}) {
  const emit = (stage, percent) => { if (opts.onProgress) opts.onProgress({ stage, percent }); };
  emit('检查 Python 环境', 3);
  const py = await findPython();
  if (!py.ok) throw new Error(py.reason);

  const root = engineRoot();
  fs.mkdirSync(root, { recursive: true });
  const venv = path.join(root, 'venv');
  emit('创建独立运行环境（venv）', 8);
  try {
    await runStream(py.cmd, [...py.args, '-m', 'venv', venv], { env: pipEnv(opts.proxy), onChild: opts.onChild });
  } catch (e) {
    // 上一次装到一半留下的残缺 venv 会导致这里失败，--clear 重建
    await runStream(py.cmd, [...py.args, '-m', 'venv', '--clear', venv], { env: pipEnv(opts.proxy), onChild: opts.onChild });
  }

  const vpy = venvPython();
  if (!fs.existsSync(vpy)) throw new Error('创建 Python 虚拟环境失败（venv 里没有解释器）');

  emit('下载 PyTorch 运行时（约 1.5GB，仅一次）', 15);
  const torchArgs = [...TORCH_PKGS, '--index-url', TORCH_CPU_INDEX];
  await pipInstall(vpy, torchArgs, {
    proxy: opts.proxy,
    onChild: opts.onChild,
    onLine: (line) => {
      if (/Downloading|Collecting/.test(line)) emit('下载 PyTorch 运行时（约 1.5GB，仅一次）', 35);
    }
  });

  emit('安装语音克隆依赖（约 400MB）', 62);
  await pipInstall(vpy, PY_PKGS, {
    proxy: opts.proxy,
    onChild: opts.onChild,
    onLine: (line) => {
      if (/Downloading|Collecting|Installing/.test(line)) emit('安装语音克隆依赖（约 400MB）', 78);
    }
  });

  emit('校验运行环境', 92);
  await runStream(vpy, ['-c', 'import torch, numpy, librosa, cv2, soundfile, chatterbox; print("ok")'], {
    env: pipEnv(opts.proxy),
    onChild: opts.onChild
  });
  emit('本地克隆引擎已就绪', 100);
  return status();
}

module.exports = {
  status,
  requireEngine,
  openSession,
  closeAll,
  size: sizeAsync,
  engineRoot,
  hfCache,
  install,
  findPython,
  probe,
  venvPython
};
