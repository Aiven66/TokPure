'use strict';

/* ============================================================
   TokPure — 本地背景音乐分离

   原片音轨里「原语言说话人 + 背景音乐 + 环境底噪」是混在一起的，
   直接铺在原声轨下面就会在句间停顿漏出原语言人声（用户反馈的「噪音」）。
   这里用 torchaudio 自带的 HDemucs（facebook research 的 hdemucs_high，
   MIT 许可）把人声剥出来丢掉，只留伴奏，再交给渲染层按固定电平混入。

   完全离线：模型权重一次性下载到引擎目录（$TORCH_HOME/hub/torchaudio），
   之后推理过程不联网。分离跑在「本地声音克隆」那套 Python 环境里，
   不额外安装依赖（torch / torchaudio / soundfile 都已经在里面）。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const voicelocal = require('./voicelocal');

const MODEL_KEY = 'models/hdemucs_high_trained.pt';
// 权重来源（按顺序尝试）：
// 国内直连 hf-mirror 通常比官方 download.pytorch.org 快一个数量级
//（实测 500KB/s vs 60KB/s，319MB 差出半小时）；
// 两个源上的文件字节数完全一致，逐字节相同，所以只做长度校验即可。
const MODEL_SOURCES = [
  'https://hf-mirror.com/paobukaidecha/hdemucs_high_trained/resolve/main/hdemucs_high_trained.pt',
  'https://download.pytorch.org/torchaudio/models/hdemucs_high_trained.pt'
];
const MODEL_BYTES = 334697255;
const MIN_BYTES = Math.round(MODEL_BYTES * 0.95);

const IDLE_TIMEOUT = 180000;

function torchHome() {
  return path.join(voicelocal.engineRoot(), 'torch');
}

/** torchaudio 把权重放在 torch.hub.get_dir()/torchaudio/<key> 下 */
function modelFile() {
  return path.join(torchHome(), 'hub', 'torchaudio', MODEL_KEY);
}

function scriptPath() {
  const list = [];
  if (process.resourcesPath) {
    list.push(path.join(process.resourcesPath, 'resources', 'audiosep', 'separate.py'));
    list.push(path.join(process.resourcesPath, 'audiosep', 'separate.py'));
  }
  list.push(path.join(__dirname, '..', 'resources', 'audiosep', 'separate.py'));
  return list.find((p) => fs.existsSync(p)) || list[0];
}

/** 复用本地克隆引擎的 venv（torch 2.6 + torchaudio 2.6 + soundfile 都在里面） */
function python() {
  const st = voicelocal.status();
  return st.python || '';
}

function pythonReady() {
  const py = python();
  return !!py && fs.existsSync(py);
}

function modelReady() {
  try {
    const st = fs.statSync(modelFile());
    return st.size >= MIN_BYTES;
  } catch (_) {
    return false;
  }
}

function status() {
  return {
    python: pythonReady(),
    script: fs.existsSync(scriptPath()),
    weights: modelReady(),
    bytes: modelReady() ? MODEL_BYTES : 0,
    file: modelFile()
  };
}

/** 首次使用下载权重。onChild 让取消按钮能真的掐断下载。 */
function ensureModel({ onProgress, onChild } = {}) {
  if (modelReady()) return Promise.resolve(modelFile());
  const dest = modelFile();
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const request = (url, depth) => new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('模型下载重定向次数过多')); return; }
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (err) reject(err); else resolve();
    };
    const req = https.get(url, { headers: { 'User-Agent': 'TokPure/1.0' }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        request(new URL(res.headers.location, url).toString(), depth + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        done(new Error(`分离模型下载失败（HTTP ${res.statusCode}）`));
        return;
      }
      const total = Number(res.headers['content-length']) || MODEL_BYTES;
      let got = 0;
      const out = fs.createWriteStream(tmp);
      res.on('data', (buf) => {
        got += buf.length;
        if (typeof onProgress === 'function') {
          onProgress({ percent: Math.min(99, Math.round((got / total) * 100)), bytes: got, total });
        }
      });
      res.on('error', (e) => { out.destroy(); done(e); });
      out.on('error', done);
      out.on('finish', () => {
        out.close(() => {
          try {
            const size = fs.statSync(tmp).size;
            // 两个源的文件长度是固定的：长度不符说明是半截文件或换了版本，直接判失败
            if (Math.abs(size - MODEL_BYTES) > 1024) {
              done(new Error('分离模型下载不完整，请重试'));
              return;
            }
            fs.renameSync(tmp, dest);
            done(null);
          } catch (e) { done(e); }
        });
      });
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error('分离模型下载超时')));
    req.on('error', done);
    if (typeof onChild === 'function') {
      onChild({ kill: () => { try { req.destroy(new Error('已取消')); } catch (_) {} } });
    }
  });

  // 逐个源尝试：一个不通/太慢就换下一个，全失败才报错
  const attempt = (i, lastErr) => {
    if (i >= MODEL_SOURCES.length) {
      return Promise.reject(lastErr || new Error('分离模型下载失败'));
    }
    return request(MODEL_SOURCES[i], 0)
      .catch((e) => {
        if (/已取消/.test(String((e && e.message) || e))) throw e;
        return attempt(i + 1, e);
      });
  };
  return attempt(0, null).then(() => modelFile());
}

function separate({ input, outdir, onProgress, onChild } = {}) {
  const py = python();
  if (!py || !fs.existsSync(py)) {
    return Promise.reject(new Error('本地分离引擎未安装：请先在「桌面引擎」安装「本地声音克隆」'));
  }
  const script = scriptPath();
  if (!fs.existsSync(script)) return Promise.reject(new Error('缺少分离脚本，请重新安装客户端'));

  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    TORCH_HOME: torchHome(),
    HF_HOME: voicelocal.hfCache(),
    // 权重必须在本地：没装就明确失败，绝不偷偷联网下载
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1'
  };
  const child = spawn(py, ['-u', script, '--input', input, '--outdir', outdir], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  if (typeof onChild === 'function') onChild(child);

  let buf = '';
  let errTail = '';
  let done = false;
  let idle = null;
  const result = { file: '', stats: null };

  return new Promise((resolve, reject) => {
    const finish = (err) => {
      if (done) return;
      done = true;
      if (idle) { clearTimeout(idle); idle = null; }
      if (err) reject(err); else resolve(result);
    };
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        finish(new Error('背景音乐分离长时间无响应'));
      }, IDLE_TIMEOUT);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      arm();
      buf += c;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.event === 'log' && typeof onProgress === 'function') {
          onProgress({ stage: msg.stage || '', percent: Number(msg.percent) || 0 });
        } else if (msg.event === 'done') {
          result.file = msg.bgm || '';
          result.stats = msg.stats || null;
        } else if (msg.event === 'error') {
          finish(new Error(msg.error || '背景音乐分离失败'));
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { errTail = (errTail + c).slice(-2000); });
    child.on('error', (e) => finish(new Error(`背景音乐分离启动失败：${e.message}`)));
    child.on('close', (code) => {
      if (code === 0 && result.file && fs.existsSync(result.file)) finish(null);
      else {
        const tail = errTail.split('\n').filter((l) => l.trim()).slice(-1)[0] || '';
        finish(new Error(`背景音乐分离失败（${code}）${tail ? '：' + tail.slice(0, 160) : ''}`));
      }
    });
    arm();
  });
}

module.exports = { status, pythonReady, modelReady, ensureModel, separate, modelFile, MODEL_BYTES };
