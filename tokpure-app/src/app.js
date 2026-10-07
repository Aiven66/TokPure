/* ============================================================
   TokPure — renderer logic
   ============================================================ */
'use strict';

const api = window.tokpure;
const ic = (name, size) => window.TPI(name, size);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  settings: null,
  current: null,
  parsed: null,
  batchMode: false,
  clipSniff: true,
  lastClipUrl: '',
  currentView: 'download',
  libraryFilter: 'all',
  labFile: null,
  labOutput: null,
  labMode: 'crop',
  tasks: [],
  paused: false,
  platform: '',
  revealLabel: '在访达中显示',
  trashLabel: '已移到废纸篓'
};

/* ---------------- helpers ---------------- */
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDur(sec) {
  if (!sec) return '00:00';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function fmtSpeed(bps) {
  if (!bps) return '0 MB/s';
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}
function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
}
function fmtDate(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = 'ok') {
  const wrap = $('#toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const iconName = kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'checkCircle';
  el.innerHTML = `${ic(iconName, 17)}<span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 320);
  }, kind === 'err' ? 5200 : 3200);
}

/* ---------------- icon hydration ---------------- */
function hydrateIcons(root = document) {
  $$('[data-ic]', root).forEach((el) => {
    const size = Number(el.getAttribute('data-size')) || 18;
    el.innerHTML = ic(el.getAttribute('data-ic'), size);
  });
}

/* ---------------- brand logo ---------------- */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
<defs>
<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1e222b"/><stop offset="100%" stop-color="#0e1014"/></linearGradient>
<linearGradient id="pk" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#FF3B5C"/><stop offset="100%" stop-color="#FE2C55"/></linearGradient>
<linearGradient id="cy" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00F2FE"/><stop offset="100%" stop-color="#25F4EE"/></linearGradient>
<filter id="gl" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="b"/><feComposite in="SourceGraphic" in2="b" operator="over"/></filter>
</defs>
<rect x="8" y="8" width="104" height="104" rx="24" fill="url(#bg)" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
<rect x="9" y="9" width="102" height="102" rx="23" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
<g transform="translate(60,58)">
<path d="M-8,-20 C-8,-20 0,-15 12,-15 L12,-6 C4,-6 -2,-9 -8,-9 L-8,12 C-8,17 -13,20 -19,19 C-25,18 -29,13 -28,7 C-27,2 -22,-2 -16,-2 C-13,-2 -10,-1 -8,1 Z" fill="url(#cy)" opacity="0.8" transform="translate(-2,-2)"/>
<path d="M-8,-20 C-8,-20 0,-15 12,-15 L12,-6 C4,-6 -2,-9 -8,-9 L-8,12 C-8,17 -13,20 -19,19 C-25,18 -29,13 -28,7 C-27,2 -22,-2 -16,-2 C-13,-2 -10,-1 -8,1 Z" fill="url(#pk)"/>
<path d="M14,-14 L16,-7 L23,-5 L16,-3 L14,4 L12,-3 L5,-5 L12,-7 Z" fill="#FFFFFF" filter="url(#gl)"/>
<circle cx="21" cy="6" r="2" fill="#25F4EE"/>
<path d="M8,12 L8,24 M4,20 L8,24 L12,20" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</g></svg>`;

/* ---------------- view switching ---------------- */
function switchView(name) {
  state.currentView = name;
  $$('#nav .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${name}`));
  if (name === 'library') loadLibrary();
  if (name === 'queue') refreshQueueUI();
}

/* ---------------- settings ---------------- */
async function loadSettings() {
  state.settings = await api.settings.get();
  const s = state.settings;
  state.clipSniff = !!s.clipboardSniff;
  $('#clip-sniff-toggle').classList.toggle('on', state.clipSniff);
  $('#dl-dir-label').textContent = s.downloadDir;
  $('#net-dir').textContent = s.downloadDir;

  // network view
  const mode = s.proxy.mode || (s.proxy.enabled ? 'custom' : 'direct');
  state.proxyMode = mode;
  $$('#net-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#net-enabled').classList.toggle('on', mode !== 'direct');
  $('#net-protocol').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.proto === s.proxy.protocol));
  $('#net-host').value = s.proxy.host;
  $('#net-port').value = s.proxy.port;
  $('#net-auth').classList.toggle('on', !!s.proxy.authEnabled);
  $('#net-auth-fields').classList.toggle('hidden', !s.proxy.authEnabled);
  $('#net-user').value = s.proxy.username || '';
  $('#net-pass').value = s.proxy.password || '';
  $('#net-ua-custom').value = s.customUA || '';
  $('#net-parse-api').value = s.parseApi || '';
  $$('#net-ua-list .ua-option').forEach((el) => el.classList.toggle('on', el.dataset.ua === s.uaPreset));
  syncManualCardLock();
  updateProxySummary();

  $('#q-concurrency').value = String(s.concurrency || 3);
  $('#opt-poster').checked = !!s.savePoster;
  $('#opt-mp3').checked = !!s.extractMp3;
}

function syncManualCardLock() {
  const manual = (state.proxyMode || 'system') === 'custom';
  const card = $('#net-manual-card');
  if (!card) return;
  card.style.opacity = manual ? '1' : '.45';
  card.style.pointerEvents = manual ? '' : 'none';
  const note = $('#net-mode-note');
  if (note) {
    note.classList.toggle('hidden', manual || state.proxyMode === 'direct');
  }
}

function updateProxySummary() {
  const s = state.settings || { proxy: {} };
  const mode = state.proxyMode || s.proxy.mode || 'system';
  const det = state.detectedProxy;
  let on = false;
  let endpoint = '直接连接 · 无代理';
  if (mode === 'custom') {
    on = true;
    endpoint = `${(s.proxy.protocol || 'http').toUpperCase()} · ${s.proxy.host}:${s.proxy.port}`;
  } else if (mode === 'system') {
    if (det) {
      on = true;
      endpoint = T('系统代理联动 · {0} {1}:{2}', det.protocol.toUpperCase(), det.host, det.port);
    } else {
      on = false;
      endpoint = '系统代理联动 · 未检测到系统代理';
    }
  }
  $('#net-led').style.opacity = on ? '1' : '.35';
  $('#net-status-title').textContent =
    mode === 'system'
      ? on
        ? '系统代理联动已生效'
        : '系统代理联动 · 未检测到'
      : on
      ? '本地代理引擎已启用'
      : '本地代理引擎未启用';
  $('#net-endpoint').textContent = endpoint;
  $('#lan-text').textContent = on
    ? `Proxy Mode — ${endpoint.split('· ').pop()}`
    : 'Local LAN Mode — 127.0.0.1';
}

async function refreshProxyInfo() {
  try {
    const r = await api.system.netDetect();
    state.detectedProxy = r.detected ? { protocol: r.detected.protocol, host: r.detected.host, port: r.detected.port } : null;
    state.effectiveProxy = r.effective;
    updateProxySummary();
    const kv = $('#net-proxy-kv');
    if (kv) {
      const label = r.detected
        ? `${r.detected.protocol.toUpperCase()} ${r.detected.host}:${r.detected.port}`
        : '未检测到';
      kv.textContent = r.mode === 'custom' ? '手动配置' : r.mode === 'direct' ? '已关闭（直连）' : label;
      kv.style.color = r.enabled ? 'var(--secondary)' : 'var(--text-muted)';
    }
  } catch (_) {
    /* ignore */
  }
}

/* ---------------- clipboard sniff ---------------- */
async function pollClipboard() {
  if (!state.clipSniff) return;
  try {
    const text = await api.clipboard.read();
    if (!text) return;
    const m = String(text).match(/https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s"'<>]+/i);
    if (m && m[0] !== state.lastClipUrl) {
      state.lastClipUrl = m[0];
      $('#clip-url').textContent = m[0];
      $('#clip-banner').classList.remove('hidden');
    }
  } catch (_) { /* ignore */ }
}

/* ---------------- download view ---------------- */
function setParseStatus(msg, kind) {
  const box = $('#parse-status');
  if (!msg) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('#parse-status-text').textContent = msg;
  box.style.color = kind === 'err' ? 'var(--error)' : 'var(--text-muted)';
}

async function doParse(url) {
  const raw = (url || $('#url-input').value || '').trim();
  if (!raw) { toast('请先粘贴 TikTok 链接', 'err'); return; }
  if (state.batchMode) {
    await api.downloads.add(raw, {});
    switchView('queue');
    toast('已加入批量队列', 'ok');
    return;
  }
  $('#btn-parse').disabled = true;
  $('#btn-parse').innerHTML = `<span class="spin">${ic('refresh', 16)}</span><span>解析中…</span>`;
  setParseStatus('正在解析 TikTok 元数据…', 'info');
  try {
    const meta = await api.tiktok.parse(raw);
    state.parsed = meta;
    renderResult(meta);
    setParseStatus(
      T(
        '解析成功 · 来源 {0} · {1}',
        meta.source,
        meta.video.noWatermark.length ? T('已命中无水印源') : T('未命中无水印源（将使用兜底）')
      ),
      'info'
    );
  } catch (e) {
    setParseStatus(e.message || String(e), 'err');
    toast('解析失败，请检查链接或代理设置', 'err');
  } finally {
    $('#btn-parse').disabled = false;
    $('#btn-parse').innerHTML = `${ic('bolt', 16)}<span>立即解析 (Extract Now)</span>`;
  }
}

function renderResult(meta) {
  const card = $('#result-card');
  card.classList.remove('hidden');
  const v = meta.video || {};
  const hasNW = v.noWatermark && v.noWatermark.length;
  $('#result-cover').src = v.cover || '';
  $('#result-cover').style.display = v.cover ? 'block' : 'none';
  $('#result-res').textContent = v.width && v.height ? `${v.width} × ${v.height}` : (v.gear || '—');
  $('#result-dur').textContent = fmtDur(v.duration);
  $('#result-nw-badge').textContent = hasNW ? '原生无水印已命中' : '未命中无水印源（兜底清理）';
  $('#result-watermark-note').textContent = hasNW
    ? 'TikTok 直链抽取纯净母带，无瀑布二次压缩，本地保存。'
    : '当前仅获取到带水印源，已自动启用 FFmpeg 本地裁剪兜底。';
  $('#result-author').textContent = (meta.author.nickname || meta.author.uniqueId || '—') + (meta.author.uniqueId ? ` (@${meta.author.uniqueId})` : '');
  $('#result-desc').textContent = meta.desc || '（无描述）';
  $('#result-bitrate').textContent = v.bitrate ? `${(v.bitrate / 1000).toFixed(0)} kbps` : '—';
  $('#result-res2').textContent = v.width && v.height ? `${v.width}×${v.height}${v.ratio ? ` · ${v.ratio}` : ''}` : '—';
  $('#result-dur2').textContent = fmtDur(v.duration);
  $('#result-music').textContent = meta.music && meta.music.title ? `${meta.music.title}` : '—';
  $('#result-stats').textContent = `${fmtNum(meta.stats.play)} / ${fmtNum(meta.stats.digg)}`;
  $('#result-source').textContent = meta.source || '—';
  $('#result-hash').textContent = `HASH: ${(meta.id || 'na').slice(0, 10)}`;
  $('#result-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function startDownload() {
  if (!state.parsed) { toast('请先解析链接', 'err'); return; }
  const opts = {
    poster: $('#opt-poster').checked,
    extraction: $('#opt-mp3').checked
  };
  await api.settings.save({ savePoster: opts.poster, extractMp3: opts.extraction, removeLogo: $('#opt-clean') && $('#opt-clean').checked });
  await api.downloads.add($('#url-input').value || state.parsed.canonicalUrl, opts);
  switchView('queue');
  toast('下载任务已启动', 'ok');
}

/* ---------------- queue ---------------- */
const STATUS_MAP = {
  queued: { label: '排队中', pill: 'square' },
  parsing: { label: '解析中', pill: 'cyan' },
  downloading: { label: '下载中', pill: 'cyan' },
  extracting: { label: '提取音频', pill: 'cyan' },
  cleaning: { label: '本地去水印', pill: 'coral' },
  done: { label: '已完成 · 无水印', pill: 'emerald' },
  error: { label: '失败', pill: 'coral' },
  canceled: { label: '已取消', pill: 'square' }
};

function taskRow(t) {
  const st = STATUS_MAP[t.status] || STATUS_MAP.queued;
  const isActive = ['parsing', 'downloading', 'extracting', 'cleaning'].includes(t.status);
  const thumb = t.cover
    ? `<img class="thumb" src="${esc(t.cover)}" />`
    : `<div class="thumb ph">${ic('film', 20)}</div>`;
  const trackCls = t.status === 'done' ? 'done' : t.status === 'error' ? 'err' : '';
  const pct = t.status === 'done' ? 100 : t.progress || 0;
  const actions = [];
  if (isActive) actions.push(`<button class="icon-btn" data-act="cancel" data-id="${t.id}" title="取消">${ic('x', 16)}</button>`);
  if (t.status === 'error' || t.status === 'canceled') actions.push(`<button class="icon-btn" data-act="retry" data-id="${t.id}" title="重试">${ic('refresh', 16)}</button>`);
  if (t.status === 'done') actions.push(`<button class="icon-btn" data-act="reveal" data-id="${t.id}" title="${state.revealLabel}">${ic('folderOpen', 16)}</button>`);
  if (['done', 'error', 'canceled'].includes(t.status)) actions.push(`<button class="icon-btn" data-act="remove" data-id="${t.id}" title="移除">${ic('trash', 16)}</button>`);
  if (t.status === 'queued') actions.push(`<button class="icon-btn" data-act="remove" data-id="${t.id}" title="移除">${ic('x', 16)}</button>`);

  const metaBits = [];
  if (t.resolution) metaBits.push(`<span>${esc(t.resolution)}</span>`);
  if (t.duration) metaBits.push(`<span>${fmtDur(t.duration)}</span>`);
  if (t.total) metaBits.push(`<span>${fmtBytes(t.total)}</span>`);
  if (t.speed) metaBits.push(`<span style="color:var(--secondary)">${fmtSpeed(t.speed)}</span>`);
  if (t.eta) metaBits.push(`<span>${esc(T('剩余 {0}s', t.eta))}</span>`);
  if (t.note) metaBits.push(`<span style="color:var(--tertiary-bright)">${esc(t.note)}</span>`);
  if (t.status === 'error') metaBits.push(`<span style="color:var(--error)">${esc(t.error || '')}</span>`);

  return `<div class="row-item" data-task="${t.id}">
    ${thumb}
    <div class="row-body">
      <div class="gap-row" style="justify-content:space-between">
        <span class="row-title">${esc(t.title || t.url || '未命名任务')}</span>
        <span class="pill ${st.pill}">${esc(t.stage || st.label)}</span>
      </div>
      <div class="row-meta">${metaBits.join('')}</div>
      <div class="track thin ${trackCls}" style="margin-top:8px"><i style="width:${pct}%"></i></div>
    </div>
    <div class="row-actions">${actions.join('')}</div>
  </div>`;
}

function renderQueue() {
  const list = $('#queue-list');
  if (!state.tasks.length) {
    list.innerHTML = `<div class="empty">${ic('queue', 30)}<p>队列为空，粘贴 TikTok 链接开始批量下载</p></div>`;
  } else {
    list.innerHTML = state.tasks.map(taskRow).join('');
  }
  const active = state.tasks.filter((t) => ['parsing', 'downloading', 'extracting', 'cleaning'].includes(t.status));
  const queued = state.tasks.filter((t) => t.status === 'queued').length;
  const done = state.tasks.filter((t) => t.status === 'done').length;
  const err = state.tasks.filter((t) => t.status === 'error').length;
  $('#tele-active').innerHTML = `${active.length}<small>个</small>`;
  const totalSpeed = active.reduce((a, t) => a + (t.speed || 0), 0);
  $('#tele-speed').innerHTML = `${(totalSpeed / 1024 / 1024).toFixed(1)}<small>MB/s</small>`;
  $('#sb-speed').textContent = fmtSpeed(totalSpeed);
  const qParts = [T('当前队列共 {0} 项', state.tasks.length)];
  if (queued) qParts.push(T('排队 {0}', queued));
  if (err) qParts.push(T('失败 {0}', err));
  $('#q-count').textContent = qParts.join(' · ');
  $('#nav-queue-count').textContent = String(active.length + queued);
  pushWave(totalSpeed);

  const recent = state.tasks.filter((t) => t.status === 'done').slice(-3).reverse();
  const rl = $('#recent-list');
  if (!recent.length) {
    rl.innerHTML = `<div class="empty">${ic('checkCircle', 30)}<p>暂无已完成的下载任务</p></div>`;
  } else {
    rl.innerHTML = recent.map((t) => `<div class="row-item">
      ${t.cover ? `<img class="thumb" src="${esc(t.cover)}" />` : `<div class="thumb ph">${ic('film', 20)}</div>`}
      <div class="row-body"><div class="row-title">${esc(t.title || t.url)}</div>
      <div class="row-meta"><span>${fmtDur(t.duration)}</span><span>${fmtBytes(t.total)}</span><span class="pill emerald square">已去水印</span></div></div>
      <div class="row-actions"><button class="icon-btn" data-act="reveal" data-id="${t.id}">${ic('folderOpen', 16)}</button></div>
    </div>`).join('');
  }
}

const waveSamples = [];
function pushWave(speed) {
  waveSamples.push(speed / 1024 / 1024);
  if (waveSamples.length > 60) waveSamples.shift();
  const max = Math.max(1, ...waveSamples);
  const n = waveSamples.length;
  if (n < 2) return;
  let d = '';
  waveSamples.forEach((v, i) => {
    const x = (i / (n - 1)) * 240;
    const y = 60 - (v / max) * 52;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  });
  $('#tele-wave-path').setAttribute('d', d);
}

async function refreshQueueUI() {
  state.tasks = await api.downloads.list();
  renderQueue();
  await updateQueueStatusbar();
}

/* FFmpeg 状态文案由 T() 产出，切换语言时需要重绘 */
function renderFfmpegLabels() {
  if (state.ffVersion === undefined) return;
  const ok = !!state.ffmpegOk;
  const ver = 'v' + (String(state.ffVersion).replace('ffmpeg version ', '').split(' ')[0] || '—');
  $('#tele-ff').textContent = ok ? T('{0} · 已就绪', ver) : T('未检测到 FFmpeg');
  $('#tele-ff-bar').style.width = ok ? '100%' : '0%';
  $('#nav-ffmpeg-badge').textContent = ok ? 'FFmpeg' : T('未就绪');
  $('#lab-sub').textContent = ok
    ? T('100% 离线 · 本地运算 · {0}', String(state.ffVersion).split(' ').slice(0, 3).join(' '))
    : T('100% 离线 · 未检测到 FFmpeg（MP3/去水印功能不可用）');
}

async function updateQueueStatusbar() {
  const info = await api.system.appInfo();
  const archLabel = info.platform === 'darwin' ? 'Apple Silicon' : info.platform === 'win32' ? 'Windows x64' : info.platform;
  $('#sb-arch').textContent = `${archLabel} · Electron ${info.electron}`;
  $('#sb-dir').textContent = state.settings ? state.settings.downloadDir : '';
  const ff = await api.system.ffmpeg();
  state.ffmpegOk = ff.ok;
  state.ffVersion = ff.version;
  renderFfmpegLabels();
}

/* ---------------- library ---------------- */
async function loadLibrary() {
  const res = await api.fs.library();
  state.libraryFiles = res.files || [];
  $('#lib-dir').textContent = res.dir;
  const total = state.libraryFiles.reduce((a, f) => a + f.size, 0);
  $('#nav-lib-size').textContent = fmtBytes(total);
  renderLibrary();
}

function renderLibrary() {
  const files = (state.libraryFiles || []).filter((f) => state.libraryFilter === 'all' || f.kind === state.libraryFilter);
  $('#lib-count').textContent = T('{0} 个文件', files.length);
  const list = $('#library-list');
  if (!files.length) {
    list.innerHTML = `<div class="empty">${ic('library', 30)}<p>媒体库为空，下载完成的文件会出现在这里</p></div>`;
    return;
  }
  list.innerHTML = files.map((f) => {
    const kindIc = f.kind === 'video' ? 'film' : f.kind === 'audio' ? 'music' : f.kind === 'image' ? 'image' : 'fileDownload';
    return `<div class="row-item">
      <div class="thumb ph">${ic(kindIc, 20)}</div>
      <div class="row-body"><div class="row-title">${esc(f.name)}</div>
      <div class="row-meta"><span>${fmtBytes(f.size)}</span><span>${fmtDate(f.mtime)}</span><span>${f.kind}</span></div></div>
      <div class="row-actions">
        <button class="icon-btn" data-lib="open" data-path="${esc(f.path)}" title="打开">${ic(f.kind === 'video' || f.kind === 'audio' ? 'playFill' : 'eye', 16)}</button>
        <button class="icon-btn" data-lib="reveal" data-path="${esc(f.path)}" title="${state.revealLabel}">${ic('folderOpen', 16)}</button>
        <button class="icon-btn" data-lib="delete" data-path="${esc(f.path)}" title="${esc(T('移到{0}', state.platform === 'win32' ? T('回收站') : T('废纸篓')))}">${ic('trash', 16)}</button>
      </div>
    </div>`;
  }).join('');
}

/* ---------------- network / settings save ---------------- */
function collectNetworkSettings() {
  return {
    proxy: {
      mode: state.proxyMode || 'system',
      enabled: (state.proxyMode || 'system') !== 'direct',
      protocol: $$('#net-protocol button').find((b) => b.classList.contains('on'))?.dataset.proto || 'socks5',
      host: $('#net-host').value.trim() || '127.0.0.1',
      port: Number($('#net-port').value) || 7890,
      authEnabled: $('#net-auth').classList.contains('on'),
      username: $('#net-user').value.trim(),
      password: $('#net-pass').value
    },
    uaPreset: $$('#net-ua-list .ua-option').find((el) => el.classList.contains('on'))?.dataset.ua || 'macos_safari',
    customUA: $('#net-ua-custom').value.trim(),
    parseApi: $('#net-parse-api').value.trim()
  };
}

async function applyNetworkSettings() {
  const patch = collectNetworkSettings();
  state.settings = await api.settings.save(patch);
  state.proxyMode = patch.proxy.mode;
  syncManualCardLock();
  await refreshProxyInfo();
  const saved = $('#net-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2600);
  toast('配置已保存并生效', 'ok');
}

async function runNetTest() {
  const btn = $('#net-test');
  btn.disabled = true;
  btn.innerHTML = `<span class="spin">${ic('refresh', 15)}</span>测试中…`;
  try {
    const r = await api.system.netTest();
    const lat = r.tiktok && r.tiktok.ms;
    $('#net-latency').innerHTML = r.tiktok && r.tiktok.ok ? `${lat}<small>ms</small>` : `失败<small></small>`;
    $('#net-latency-bar').style.width = r.tiktok && r.tiktok.ok ? `${Math.min(100, Math.max(8, 100 - lat / 8))}%` : '0%';
    $('#net-latency-bar').style.background = 'linear-gradient(90deg,var(--tertiary),var(--tertiary-bright))';
    $('#net-cdn').innerHTML = r.cdn && r.cdn.ok ? `${r.cdn.ms}<small>ms</small>` : `失败`;
    $('#net-cdn-bar').style.width = r.cdn && r.cdn.ok ? '84%' : '0%';
    $('#net-cdn-bar').style.background = 'linear-gradient(90deg,var(--secondary-dim),var(--secondary))';
    $('#net-http').innerHTML = r.tiktok && r.tiktok.status ? `${r.tiktok.status}` : `--`;
    $('#net-http-bar').style.width = r.tiktok && r.tiktok.ok ? '100%' : '0%';
    $('#net-http-bar').style.background = r.tiktok && r.tiktok.ok ? 'linear-gradient(90deg,var(--tertiary),var(--tertiary-bright))' : 'linear-gradient(90deg,#f87171,var(--error))';
    if (r.tiktok && r.tiktok.ok) toast(T('网络连通正常 · {0}ms', lat) + (r.effective ? ' · ' + r.effective : ''), 'ok');
    else {
      const why = (r.tiktok && (r.tiktok.error || r.tiktok.status)) || T('未知错误');
      const tip = r.mode === 'direct'
        ? T('（当前为「本地直连」模式，如网络受限请在网络设置中改用「系统代理联动」）')
        : r.mode === 'system' && !r.detected
        ? T('（未检测到系统代理，请在系统中开启代理，或改用「内置代理」手动填写）')
        : '';
      toast(T('TikTok 连接失败：{0}{1}', why, tip), 'err');
    }
  } catch (e) {
    toast(T('测试失败：{0}', e.message || e), 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ic('activity', 15)}立即测试网络连通性`;
  }
}

/* ---------------- lab ---------------- */
async function labPick() {
  const f = await api.lab.pickFile();
  if (!f) return;
  state.labFile = f;
  $('#lab-name').textContent = f.name;
  $('#lab-size').textContent = fmtBytes(f.size);
  const v = $('#lab-video');
  v.src = 'file://' + f.path;
  v.load();
  $('#lab-reveal').disabled = true;
  state.labOutput = null;
}

async function labExport() {
  if (!state.labFile) { toast('请先导入本地视频', 'err'); return; }
  const btn = $('#lab-export');
  btn.disabled = true;
  btn.innerHTML = `<span class="spin">${ic('refresh', 16)}</span>本地导出中…`;
  $('#lab-hint').textContent = 'FFmpeg 本地处理中，请稍候…';
  try {
    const payload = state.labMode === 'crop'
      ? { input: state.labFile.path, mode: 'crop', cropPercent: Number($('#lab-crop').value) || 6 }
      : { input: state.labFile.path, mode: 'delogo', box: { x: Number($('#lab-box-x').value) || 20, y: Number($('#lab-box-y').value) || 20, w: Number($('#lab-box-w').value) || 240, h: Number($('#lab-box-h').value) || 120 } };
    const res = await api.lab.process(payload);
    state.labOutput = res.output;
    $('#lab-reveal').disabled = false;
    $('#lab-hint').textContent = '导出完成';
    toast('本地导出完成', 'ok');
    loadLibrary();
  } catch (e) {
    toast(T('导出失败：{0}', e.message || e), 'err');
    $('#lab-hint').textContent = '导出失败';
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ic('save', 16)}开始本地导出 (Export Clean Video)`;
  }
}

/* ---------------- wire events ---------------- */
function wireUi() {
  // 语言切换后重绘 JS 生成的文案（T() 产出的内容无法被 DOM 词表反向翻译）
  document.addEventListener('tokpure:lang', () => {
    if (state.settings) updateProxySummary();
    renderFfmpegLabels();
    renderQueue();
    if (state.libraryFiles) renderLibrary();
  });

  // window controls
  $('#win-close').onclick = () => api.win.close();
  $('#win-min').onclick = () => api.win.minimize();
  $('#win-max').onclick = () => api.win.maximize();

  // nav
  $('#nav').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (item) switchView(item.dataset.view);
  });
  $('#btn-goto-settings').onclick = () => switchView('network');
  $('#btn-open-folder').onclick = () => api.fs.openFolder();
  $('#btn-open-library').onclick = () => switchView('library');
  $('#btn-clear-completed').onclick = async () => { await api.downloads.clearCompleted(); };

  // clipboard toggle
  $('#clip-sniff-toggle').onclick = async () => {
    state.clipSniff = !state.clipSniff;
    $('#clip-sniff-toggle').classList.toggle('on', state.clipSniff);
    await api.settings.save({ clipboardSniff: state.clipSniff });
  };
  $('#btn-dismiss-clip').onclick = () => $('#clip-banner').classList.add('hidden');
  $('#btn-fill-clip').onclick = () => {
    $('#url-input').value = $('#clip-url').textContent;
    $('#clip-banner').classList.add('hidden');
    doParse();
  };

  // download
  $('#btn-parse').onclick = () => doParse();
  $('#url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doParse(); });
  $('#btn-paste').onclick = async () => {
    const t = await api.clipboard.read();
    if (t) $('#url-input').value = t.trim();
  };
  $('#toggle-batch-mode').onclick = () => {
    state.batchMode = !state.batchMode;
    $('#toggle-batch-mode').classList.toggle('on', state.batchMode);
    toast(state.batchMode ? '已开启批量抓取模式：解析后直接入队' : '已关闭批量抓取模式', 'info');
  };
  $('#btn-change-dir').onclick = async () => {
    const dir = await api.settings.chooseDir();
    if (dir) { state.settings.downloadDir = dir; $('#dl-dir-label').textContent = dir; $('#net-dir').textContent = dir; toast('下载目录已更新', 'ok'); }
  };
  $('#btn-download').onclick = startDownload;
  $('#btn-send-lab').onclick = () => { switchView('lab'); toast('已切换到去水印实验室，可导入本地视频处理', 'info'); };

  // queue
  $('#q-import').onclick = () => {
    $('#q-textarea').classList.toggle('hidden');
    $('#q-import-actions').classList.toggle('hidden');
    $('#q-textarea').focus();
  };
  $('#q-cancel-import').onclick = () => {
    $('#q-textarea').classList.add('hidden');
    $('#q-import-actions').classList.add('hidden');
  };
  $('#q-add-links').onclick = async () => {
    const lines = $('#q-textarea').value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { toast('请输入至少一个链接', 'err'); return; }
    const rule = $('#q-rule').value;
    const opts = { poster: rule === 'nowm_poster', extraction: rule === 'nowm_mp3' };
    for (const l of lines) await api.downloads.add(l, opts);
    $('#q-textarea').value = '';
    $('#q-cancel-import').onclick();
    toast(T('已加入 {0} 个任务', lines.length), 'ok');
  };
  $('#q-sniff').onclick = async () => {
    const t = await api.clipboard.read();
    if (!t) { toast('剪贴板为空', 'err'); return; }
    $('#q-textarea').classList.remove('hidden');
    $('#q-import-actions').classList.remove('hidden');
    $('#q-textarea').value = (($('#q-textarea').value || '') + '\n' + t).trim();
  };
  $('#q-start').onclick = async () => { await api.downloads.resume(); toast('已开始处理队列', 'ok'); };
  $('#q-pause').onclick = async () => { await api.downloads.pause(); toast('队列已暂停', 'info'); };
  $('#q-clear').onclick = async () => { await api.downloads.clearCompleted(); toast('已清除完成/失败任务', 'ok'); };
  $('#q-concurrency').onchange = async (e) => {
    const n = await api.downloads.setConcurrency(Number(e.target.value));
    toast(T('并发限制已设为 {0}', n), 'ok');
  };
  $('#queue-list').addEventListener('click', onTaskAction);
  $('#recent-list').addEventListener('click', onTaskAction);

  // library
  $('#lib-refresh').onclick = () => loadLibrary();
  $('#lib-open').onclick = () => api.fs.openFolder();
  $('#lib-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#lib-filter button').forEach((x) => x.classList.toggle('on', x === b));
    state.libraryFilter = b.dataset.filter;
    renderLibrary();
  });
  $('#library-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-lib]');
    if (!b) return;
    const p = b.dataset.path;
    if (b.dataset.lib === 'open') await api.fs.openPath(p);
    if (b.dataset.lib === 'reveal') await api.fs.reveal(p);
    if (b.dataset.lib === 'delete') {
      const ok = await api.fs.delete(p);
      if (ok) { toast(state.trashLabel, 'ok'); loadLibrary(); }
    }
  });

  // network view
  $('#net-enabled').onclick = () => { $('#net-enabled').classList.toggle('on'); };
  $('#net-auth').onclick = () => {
    $('#net-auth').classList.toggle('on');
    $('#net-auth-fields').classList.toggle('hidden', !$('#net-auth').classList.contains('on'));
  };
  $('#net-protocol').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#net-protocol button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#net-mode').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#net-mode button').forEach((x) => x.classList.toggle('on', x === b));
    const mode = b.dataset.mode;
    state.proxyMode = mode;
    $('#net-enabled').classList.toggle('on', mode !== 'direct');
    syncManualCardLock();
    updateProxySummary();
    // persist immediately and re-detect, so switching modes takes effect at once
    state.settings = await api.settings.save({ proxy: { mode, enabled: mode !== 'direct' } });
    await refreshProxyInfo();
    if (mode === 'system') {
      const ok = !!state.detectedProxy;
      toast(
        ok
          ? T('已切换为系统代理联动 · {0}:{1}', state.detectedProxy.host, state.detectedProxy.port)
          : '已切换为系统代理联动，但未检测到系统代理',
        ok ? 'ok' : 'err'
      );
    } else if (mode === 'direct') {
      toast('已切换为本地直连（不使用代理）', 'ok');
    } else {
      toast('已切换为内置代理，请填写地址与端口后点击「应用配置」', 'ok');
    }
  });
  $('#net-ua-list').addEventListener('click', (e) => {
    const el = e.target.closest('.ua-option');
    if (!el) return;
    $$('#net-ua-list .ua-option').forEach((x) => x.classList.toggle('on', x === el));
  });
  $('#net-test').onclick = runNetTest;
  $('#net-apply').onclick = applyNetworkSettings;
  $('#net-open-dir').onclick = () => api.fs.openFolder();
  $('#net-reset').onclick = async () => {
    state.settings = await api.settings.reset();
    await loadSettings();
    toast('已恢复默认配置', 'ok');
  };
  $('#net-export').onclick = () => {
    const data = JSON.stringify(state.settings, null, 2);
    navigator.clipboard.writeText(data).then(() => toast('配置 JSON 已复制到剪贴板', 'ok')).catch(() => toast('复制失败', 'err'));
  };

  // lab
  $('#lab-pick').onclick = labPick;
  $('#lab-export').onclick = labExport;
  $('#lab-reveal').onclick = () => state.labOutput && api.fs.reveal(state.labOutput);
  $('#lab-crop').oninput = (e) => { $('#lab-crop-val').textContent = e.target.value + '%'; };
  $('#lab-mode-auto').onclick = () => {
    state.labMode = 'crop';
    $('#lab-mode-auto').classList.add('primary');
    $('#lab-mode-manual').classList.remove('primary');
    $$('#lab-algos .panel-item').forEach((x, i) => x.classList.toggle('on', i === 0));
  };
  $('#lab-mode-manual').onclick = () => {
    state.labMode = 'delogo';
    $('#lab-mode-manual').classList.add('primary');
    $('#lab-mode-auto').classList.remove('primary');
    $$('#lab-algos .panel-item').forEach((x, i) => x.classList.toggle('on', i === 1));
  };
  $('#lab-algos').addEventListener('click', (e) => {
    const el = e.target.closest('.panel-item');
    if (!el) return;
    $$('#lab-algos .panel-item').forEach((x) => x.classList.toggle('on', x === el));
    const idx = $$('#lab-algos .panel-item').indexOf(el);
    state.labMode = idx === 1 ? 'delogo' : 'crop';
  });
  $('#lab-original').onchange = (e) => { $('#lab-video').style.filter = e.target.checked ? 'none' : 'saturate(1.05)'; };

  // global keys
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doParse();
    if ((e.metaKey || e.ctrlKey) && e.key === '1') { switchView('download'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '2') { switchView('lab'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '3') { switchView('queue'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '4') { switchView('library'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '5') { switchView('network'); e.preventDefault(); }
  });
}

async function onTaskAction(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const act = b.dataset.act;
  const t = state.tasks.find((x) => x.id === id);
  if (act === 'cancel') await api.downloads.cancel(id);
  if (act === 'retry') await api.downloads.retry(id);
  if (act === 'remove') await api.downloads.remove(id);
  if (act === 'reveal' && t && t.destPath) await api.fs.reveal(t.destPath);
}

/* ---------------- platform adaptation ---------------- */
function applyPlatformUi(platform) {
  state.platform = platform || '';
  const isWin = platform === 'win32';
  state.revealLabel = isWin ? '在资源管理器中显示' : '在访达中显示';
  state.trashLabel = isWin ? '已移到回收站' : '已移到废纸篓';
  document.body.classList.toggle('platform-win', isWin);
  if (isWin) {
    // Windows convention: window controls on the right, square buttons
    const traffic = document.querySelector('.traffic');
    const right = document.querySelector('.tl-right');
    if (traffic && right) right.appendChild(traffic);
  }
  const openFolder = $('#btn-open-folder');
  if (openFolder) openFolder.title = state.revealLabel;
}

/* ---------------- boot ---------------- */
async function boot() {
  $('#brand-logo').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(LOGO_SVG);
  hydrateIcons();
  wireUi();

  const info = await api.system.appInfo();
  applyPlatformUi(info.platform);
  $('#brand-version').textContent =
    info.platform === 'darwin' ? `v${info.version} Native Silicon`
    : info.platform === 'win32' ? `v${info.version} Windows x64`
    : `v${info.version}`;
  const ff = await api.system.ffmpeg();
  state.ffmpegOk = ff.ok;
  state.ffVersion = ff.version;
  renderFfmpegLabels();

  const kvRow = (k, v) => `<div class="kv-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  $('#net-engine-kv').innerHTML = [
    kvRow('运行平台', `${info.platform} / ${info.arch}`),
    kvRow('Electron', info.electron),
    kvRow('Node.js', info.node),
    kvRow('应用版本', `v${info.version}`),
    kvRow('FFmpeg 引擎', ff.ok ? '已就绪' : '未检测到'),
    `<div class="kv-row"><span class="k">代理链路</span><span class="v" id="net-proxy-kv" style="color:var(--text-muted)">检测中…</span></div>`
  ].join('');

  await loadSettings();
  await refreshProxyInfo();
  await refreshQueueUI();
  loadLibrary();
  runNetTest();

  // queue live updates
  api.downloads.onAdd(() => refreshQueueUI());
  api.downloads.onUpdate((t) => {
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i === -1) state.tasks.push(t);
    else state.tasks[i] = t;
    renderQueue();
  });
  api.downloads.onRemove((id) => { state.tasks = state.tasks.filter((x) => x.id !== id); renderQueue(); });
  api.downloads.onPaused((p) => { state.paused = p; $('#q-pause').innerHTML = p ? `${ic('playFill', 14)}继续全部` : `${ic('pause', 14)}暂停全部`; });

  setInterval(pollClipboard, 1600);
  pollClipboard();
  setInterval(() => {
    const total = state.tasks.reduce((a, t) => a + (t.speed || 0), 0);
    $('#sb-speed').textContent = fmtSpeed(total);
  }, 1500);
}

boot();