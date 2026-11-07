'use strict';

/* ============================================================
   TokPure — 云端声音克隆适配层（AI多语切片专用）

   「原声音色」若只做音高匹配，听起来永远不是原片那个人。真正要做到
   「译文仍由原片说话人朗读」，必须先从原片音频里建立该说话人的克隆音色，
   再用这个音色去朗读各语言译文——也就是本模块负责的两步：

     1) cloneVoice()  用 10~60 秒原片人声，在服务商侧建一个私有克隆音色
     2) speak()       用该克隆音色合成一句目标语言语音

   目前支持 ElevenLabs（IVC，多语种覆盖最全）与 Fish Audio（30 秒克隆，
   中文语料友好、价格低）。两者都走 HTTPS，可通过应用内的代理设置访问。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const net = require('./net');
const voicelocal = require('./voicelocal');

const PROVIDERS = {
  local: {
    id: 'local',
    name: '本地克隆引擎',
    keyHint: '',
    docs: '',
    local: true
  },
  elevenlabs: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    keyHint: 'sk_...',
    docs: 'https://elevenlabs.io/app/settings/api-keys',
    base: 'https://api.elevenlabs.io'
  },
  fishaudio: {
    id: 'fishaudio',
    name: 'Fish Audio',
    keyHint: 'Fish Audio API Key',
    docs: 'https://fish.audio/zh-CN/developers/',
    base: 'https://api.fish.audio'
  }
};

function providerById(id) {
  return PROVIDERS[id] || PROVIDERS.elevenlabs;
}

/* ---------------- HTTP ---------------- */

function multipart(fields, files) {
  const boundary = `----TokPure${crypto.randomBytes(10).toString('hex')}`;
  const parts = [];
  Object.keys(fields || {}).forEach((k) => {
    const v = fields[k] == null ? '' : String(fields[k]);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  });
  (files || []).forEach((f) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
      `Content-Type: ${f.type || 'application/octet-stream'}\r\n\r\n`
    ));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function pickError(provider, res) {
  const text = String(res.text || '').slice(0, 400);
  let detail = '';
  try {
    const d = res.data || {};
    detail = d.detail ? (typeof d.detail === 'string' ? d.detail : d.detail.message || JSON.stringify(d.detail))
      : d.message || d.error || d.msg || '';
    if (detail && typeof detail === 'object') detail = JSON.stringify(detail);
  } catch (_) { /* ignore */ }
  if (!detail) detail = text;
  const who = providerById(provider).name;
  return `${who} 返回 HTTP ${res.status}${detail ? '：' + String(detail).slice(0, 240) : ''}`;
}

async function call({ url, method = 'GET', headers = {}, body = null, proxy, timeout = 90000 }) {
  const res = await net.requestBuffer(url, { method, headers, body, proxy, timeout, limitBytes: 40 * 1024 * 1024 });
  const text = res.body.toString('utf8');
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = null; }
  return { status: res.statusCode, headers: res.headers, body: res.body, text, data };
}

/* ---------------- ElevenLabs ---------------- */

async function elevenTest(key, proxy) {
  const res = await call({
    url: `${PROVIDERS.elevenlabs.base}/v1/user`,
    headers: { 'xi-api-key': key },
    proxy,
    timeout: 30000
  });
  if (res.status !== 200) throw new Error(pickError('elevenlabs', res));
  const d = res.data || {};
  const sub = d.subscription || {};
  const used = sub.character_count;
  const limit = sub.character_limit;
  const hasQuota = used != null && limit != null;
  const quota = hasQuota ? `已用 ${used}/${limit} 字符` : '';
  return {
    ok: true,
    info: quota || (d.first_name ? `账号 ${d.first_name}` : '连接正常'),
    code: hasQuota ? 'quota' : d.first_name ? 'account' : 'ok',
    account: d.first_name || '', quota, used: hasQuota ? used : null, limit: hasQuota ? limit : null
  };
}

async function elevenClone({ key, audioFile, name, proxy }) {
  const mp = multipart({ name, description: 'TokPure — AI多语切片' }, [{
    field: 'files',
    filename: path.basename(audioFile),
    type: 'audio/mpeg',
    data: fs.readFileSync(audioFile)
  }]);
  const res = await call({
    url: `${PROVIDERS.elevenlabs.base}/v1/voices/add`,
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': mp.contentType },
    body: mp.body,
    proxy,
    timeout: 180000
  });
  if (res.status !== 200 || !res.data || !res.data.voice_id) throw new Error(pickError('elevenlabs', res));
  return res.data.voice_id;
}

async function elevenSpeak({ key, voiceId, text, proxy }) {
  const body = Buffer.from(JSON.stringify({
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.4, similarity_boost: 0.9, style: 0, use_speaker_boost: true }
  }));
  const res = await call({
    url: `${PROVIDERS.elevenlabs.base}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body,
    proxy,
    timeout: 120000
  });
  if (res.status !== 200 || !res.body || !res.body.length) throw new Error(pickError('elevenlabs', res));
  if (/json/i.test(String(res.headers['content-type'] || ''))) throw new Error(pickError('elevenlabs', res));
  return res.body;
}

/* ---------------- Fish Audio ---------------- */

async function fishTest(key, proxy) {
  const res = await call({
    url: `${PROVIDERS.fishaudio.base}/model?page_size=1`,
    headers: { Authorization: `Bearer ${key}` },
    proxy,
    timeout: 30000
  });
  if (res.status !== 200) throw new Error(pickError('fishaudio', res));
  return { ok: true, info: '连接正常' };
}

async function fishClone({ key, audioFile, name, proxy }) {
  const mp = multipart({ title: name, visibility: 'private', train_mode: 'fast' }, [{
    field: 'voices',
    filename: path.basename(audioFile),
    type: 'audio/mpeg',
    data: fs.readFileSync(audioFile)
  }]);
  const res = await call({
    url: `${PROVIDERS.fishaudio.base}/model`,
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': mp.contentType },
    body: mp.body,
    proxy,
    timeout: 180000
  });
  const id = res.data && (res.data._id || res.data.id);
  if (res.status >= 300 || !id) throw new Error(pickError('fishaudio', res));
  return String(id);
}

async function fishSpeak({ key, voiceId, text, proxy }) {
  const body = Buffer.from(JSON.stringify({
    text,
    reference_id: voiceId,
    format: 'mp3',
    mp3_bitrate: 128,
    chunk_length: 200,
    normalize: true,
    latency: 'normal'
  }));
  const res = await call({
    url: `${PROVIDERS.fishaudio.base}/v1/tts`,
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body,
    proxy,
    timeout: 120000
  });
  if (res.status !== 200 || !res.body || !res.body.length) throw new Error(pickError('fishaudio', res));
  if (/json/i.test(String(res.headers['content-type'] || ''))) throw new Error(pickError('fishaudio', res));
  return res.body;
}

/* ---------------- 对外接口 ---------------- */

async function test(provider, key, proxy) {
  const id = providerById(provider).id;
  if (id === 'local') {
    const s = voicelocal.status();
    if (!s.installed) throw new Error('本地克隆引擎尚未安装（安装后占用约 2.4GB 磁盘）');
    if (!s.weights) throw new Error('本地克隆模型权重不完整，请保持联网后重试');
    // 体积统计是异步遍历磁盘的，这里等一下，避免刚启动时显示成 0 占用
    const bytes = s.bytes || (await voicelocal.size());
    const gb = bytes ? (bytes / 1024 / 1024 / 1024).toFixed(1) + 'GB' : '';
    return {
      ok: true,
      info: `离线可用 · 23 语种${gb ? ' · 占用 ' + gb : ''}`,
      // 结构化字段供渲染层按当前语言拼装，info 保留给旧调用方兜底
      code: 'local', langCount: 23, gb
    };
  }
  if (!key) throw new Error('请先填写 API Key');
  if (id === 'fishaudio') return fishTest(key, proxy);
  return elevenTest(key, proxy);
}

async function clone({ provider, key, audioFile, name, proxy }) {
  const id = providerById(provider).id;
  if (id === 'local') {
    if (!audioFile || !fs.existsSync(audioFile)) throw new Error('缺少原声参考音频');
    // 本地零样本克隆不需要「建音色」这一步，参考音频本身就是音色
    return audioFile;
  }
  if (!key) throw new Error('请先填写 API Key');
  if (!audioFile || !fs.existsSync(audioFile)) throw new Error('缺少原声参考音频');
  if (id === 'fishaudio') return fishClone({ key, audioFile, name, proxy });
  return elevenClone({ key, audioFile, name, proxy });
}

/** 用克隆音色合成一句，返回 mp3 Buffer（仅云端服务商） */
async function speak({ provider, key, voiceId, text, proxy }) {
  const id = providerById(provider).id;
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('空文本');
  if (id === 'fishaudio') return fishSpeak({ key, voiceId, text: clean, proxy });
  return elevenSpeak({ key, voiceId, text: clean, proxy });
}

/* ---------------- 克隆音色缓存 ----------------
   同一段原片重复生成（换语言、重跑）时不必每次都上传音频重建音色，
   既省时间也省服务商侧的克隆次数。缓存按「服务商 + 文件指纹 + 片段窗口」区分。 */

function cachePath() {
  return path.join(app.getPath('userData'), 'voiceclone', 'cache.json');
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

function writeCache(data) {
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) { /* 缓存写入失败不影响主流程 */ }
}

function cacheKey(provider, source, win) {
  let stat = { size: 0, mtimeMs: 0 };
  try { stat = fs.statSync(source); } catch (_) { /* ignore */ }
  const raw = `${provider}|${source}|${stat.size}|${Math.round(stat.mtimeMs)}|${Number(win && win.start || 0).toFixed(1)}|${Number(win && win.end || 0).toFixed(1)}`;
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 20);
}

async function resolveVoice({ provider, key, proxy, source, win, audioFile, name, emit, force }) {
  const id = providerById(provider).id;
  if (id === 'local') {
    // 本地零样本克隆：参考音频即时生效，无需建音色与缓存
    if (!audioFile || !fs.existsSync(audioFile)) throw new Error('缺少原声参考音频');
    return { voiceId: audioFile, cached: false };
  }
  const ck = cacheKey(id, source, win);
  const cache = readCache();
  if (!force && cache[ck] && cache[ck].voiceId) {
    return { voiceId: cache[ck].voiceId, cached: true };
  }
  if (emit) emit({ stage: '克隆原声音色', percent: 0 });
  const voiceId = await clone({ provider: id, key, audioFile, name: name || 'TokPure 原声克隆', proxy });
  cache[ck] = { voiceId, provider: id, at: Date.now(), name: name || '' };
  // 同一服务商下只保留最近 30 条，避免缓存无限增长
  const keys = Object.keys(cache)
    .filter((k) => cache[k] && cache[k].provider === id)
    .sort((a, b) => (cache[b].at || 0) - (cache[a].at || 0));
  keys.slice(30).forEach((k) => { delete cache[k]; });
  writeCache(cache);
  return { voiceId, cached: false };
}

module.exports = {
  PROVIDERS,
  providerById,
  test,
  clone,
  speak,
  resolveVoice,
  // 供 UI 展示：各服务商的能力说明与申请地址
  catalog: () => Object.keys(PROVIDERS).map((k) => ({
    id: PROVIDERS[k].id,
    name: PROVIDERS[k].name,
    keyHint: PROVIDERS[k].keyHint,
    docs: PROVIDERS[k].docs,
    local: !!PROVIDERS[k].local
  }))
};
