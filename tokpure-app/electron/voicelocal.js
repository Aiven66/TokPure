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
const { spawn } = require('child_process');
const { app } = require('electron');

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
      log({ stage: '合成中', beat: true, elapsed: msg.elapsed || 0 });
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
  try {
    await readyPromise;
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
    const entry = { resolve, reject, timer: null };
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

module.exports = {
  status,
  requireEngine,
  openSession,
  closeAll,
  size: sizeAsync,
  engineRoot,
  hfCache
};
