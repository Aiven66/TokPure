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
  session: null,
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
  labRegions: [],
  hub: null,
  aiTask: null,
  subFile: null,
  subSegments: [],
  subOutput: null,
  enhFile: null,
  enhEngine: 'realsr',
  enhOutput: null,
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

/* ---------------- view switching ---------------- */
function switchView(name) {
  state.currentView = name;
  $$('#nav .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${name}`));
  if (name === 'library') loadLibrary();
  if (name === 'queue') refreshQueueUI();
  if (name === 'engine' || name === 'subtitle' || name === 'enhance') {
    if (!state.hub) loadHub();
    else { renderHub(); updateSubModelSelect(); updateEnhNote(); }
  }
  if (name === 'clips') {
    initClips();
    if (!state.hub) loadHub().then(updateClipModelSelect);
    else updateClipModelSelect();
  }
}

/* ---------------- sidebar collapse / expand ----------------
   纯渲染器偏好：localStorage 持久化，不经过主进程设置。 */
const SIDEBAR_KEY = 'tokpure.sidebar';
function setSidebarCollapsed(collapsed) {
  const sb = $('#sidebar');
  const btn = $('#sidebar-toggle');
  if (!sb || !btn) return;
  sb.classList.toggle('collapsed', collapsed);
  btn.innerHTML = ic(collapsed ? 'chevronsRight' : 'chevronsLeft', 15);
  // 用 setAttribute 而非 .title：i18n 运行时监听 title/aria-label 属性变更并自动翻译
  const tip = collapsed ? '展开侧边栏' : '收起侧边栏';
  btn.setAttribute('aria-label', tip);
  btn.setAttribute('title', tip);
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (_) { /* ignore */ }
}
function initSidebar() {
  $('#sidebar-toggle').addEventListener('click', () => {
    setSidebarCollapsed(!$('#sidebar').classList.contains('collapsed'));
  });
  let saved = '0';
  try { saved = localStorage.getItem(SIDEBAR_KEY) || '0'; } catch (_) { /* ignore */ }
  setSidebarCollapsed(saved === '1');
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
  const navCount = active.length + queued;
  const navCountEl = $('#nav-queue-count');
  navCountEl.textContent = String(navCount);
  // 收起态下 0 不显示红色角标，避免噪音
  navCountEl.classList.toggle('is-zero', navCount === 0);
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
// 路径可能含空格 / 中文 / # 等字符，直接拼 file:// 会让 <video> 静默加载失败
function toFileUrl(p) {
  return 'file://' + String(p).split('/').map(encodeURIComponent).join('/');
}

function applyLabFile(f) {
  if (!f || !f.path) return;
  state.labFile = f;
  state.labOutput = null;
  $('#lab-name').textContent = f.name;
  $('#lab-size').textContent = fmtBytes(f.size);
  const v = $('#lab-video');
  v.src = toFileUrl(f.path);
  v.load();
  $('#lab-reveal').disabled = true;
  $('#lab-hint').textContent = '选择去除范围后导出';
  const drop = $('#lab-drop');
  if (drop) drop.classList.add('hidden');
}

async function labPick() {
  try {
    const f = await api.lab.pickFile();
    if (!f) return;
    applyLabFile(f);
    toast(T('已导入 {0}', f.name), 'ok');
  } catch (e) {
    toast(T('导入失败：{0}', (e && e.message) || e), 'err');
  }
}

// 拖拽进入的文件由 preload 通过 webUtils 还原为本地绝对路径
async function labOpenPath(p) {
  try {
    const f = await api.lab.openPath(p);
    if (f) {
      applyLabFile(f);
      toast(T('已导入 {0}', f.name), 'ok');
    }
  } catch (e) {
    toast(T('导入失败：{0}', (e && e.message) || e), 'err');
  }
}

function wireLabDnd() {
  const preview = $('#lab-preview');
  const drop = $('#lab-drop');
  if (!preview) return;
  ['dragenter', 'dragover'].forEach((ev) =>
    preview.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (drop) drop.classList.add('over');
    })
  );
  preview.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (drop) drop.classList.remove('over');
  });
  preview.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (drop) drop.classList.remove('over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    let p = '';
    try { p = api.fs.pathForFile(file) || ''; } catch (_) { p = ''; }
    if (!p) p = file.path || '';
    if (!p) { toast('无法读取文件路径，请改用「上传视频」按钮选择', 'err'); return; }
    await labOpenPath(p);
  });
  // 阻止窗口其余区域拖入文件时被 Electron 默认「打开文件」行为接管
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

async function labExport() {
  if (!state.labFile) { toast('请先导入本地视频', 'err'); return; }
  const btn = $('#lab-export');
  btn.disabled = true;
  btn.innerHTML = `<span class="spin">${ic('refresh', 16)}</span>本地导出中…`;
  $('#lab-hint').textContent = 'FFmpeg 本地处理中，请稍候…';
  try {
    let res;
    if (state.labMode === 'regions2') {
      if (!state.labRegions.length) { toast('请先添加至少一个修复区域', 'err'); throw new Error('empty-regions'); }
      state.aiTask = 'lab';
      res = await api.ai.clean2({
        input: state.labFile.path,
        mode: 'delogo2',
        regions: state.labRegions.map((r) => ({ ...r }))
      });
    } else {
      const payload = state.labMode === 'crop'
        ? { input: state.labFile.path, mode: 'crop', cropPercent: Number($('#lab-crop').value) || 6 }
        : { input: state.labFile.path, mode: 'delogo', box: { x: Number($('#lab-box-x').value) || 20, y: Number($('#lab-box-y').value) || 20, w: Number($('#lab-box-w').value) || 240, h: Number($('#lab-box-h').value) || 120 } };
      res = await api.lab.process(payload);
    }
    state.labOutput = res.output;
    $('#lab-reveal').disabled = false;
    $('#lab-hint').textContent = '导出完成';
    toast('本地导出完成', 'ok');
    loadLibrary();
  } catch (e) {
    if (e.message !== 'empty-regions') toast(T('导出失败：{0}', e.message || e), 'err');
    if (e.message !== 'empty-regions') $('#lab-hint').textContent = '导出失败';
  } finally {
    state.aiTask = null;
    btn.disabled = false;
    btn.innerHTML = `${ic('save', 16)}开始本地导出 (Export Clean Video)`;
  }
}

/* ============================================================
   v2.5 本地 AI：去水印区域 / 桌面引擎 / 字幕 / 画质增强
   ============================================================ */

/* ---------------- R3：多区域时间轴 ---------------- */
const REGION_PRESETS = {
  tl: { name: '左上用户名', x: 3, y: 10, w: 36, h: 6 },
  tr: { name: '右上', x: 61, y: 10, w: 36, h: 6 },
  bl: { name: '左下', x: 3, y: 88, w: 24, h: 7 },
  br: { name: '右下 Logo', x: 79, y: 87, w: 18, h: 8 },
  cc: { name: '居中花字', x: 30, y: 42, w: 40, h: 8 }
};

function setLabMode(mode) {
  state.labMode = mode;
  $('#lab-mode-auto').classList.toggle('primary', mode === 'crop');
  $('#lab-mode-manual').classList.toggle('primary', mode === 'delogo');
  $('#lab-mode-regions').classList.toggle('primary', mode === 'regions2');
  $('#lab-regions-card').classList.toggle('hidden', mode !== 'regions2');
  $('#lab-box-card').classList.toggle('hidden', mode === 'regions2');
  $('#lab-region-layer').style.display = mode === 'regions2' ? 'block' : 'none';
  $$('#lab-algos .panel-item').forEach((x, i) => x.classList.toggle('on',
    (mode === 'crop' && i === 0) || (mode === 'delogo' && i === 1)));
  renderLabRegions();
}

function addLabRegion(region) {
  state.labRegions.push({
    id: 'r' + Date.now() + Math.random().toString(36).slice(2, 5),
    name: region.name || ('区域 ' + (state.labRegions.length + 1)),
    x: region.x, y: region.y, w: region.w, h: region.h, start: 0, end: 0
  });
  renderLabRegions();
}

function renderLabRegions() {
  const list = $('#lab-region-list');
  const layer = $('#lab-region-layer');
  if (!list) return;
  list.innerHTML = state.labRegions.map((r, i) => `
    <div class="region-item" data-rid="${r.id}">
      <div class="ri-head">
        <span class="ri-name">${esc(r.name)}</span>
        <button class="icon-btn" data-act="del" title="删除区域">${ic('trash2', 13)}</button>
      </div>
      <div class="ri-grid">
        <div><label>X%</label><input type="number" step="0.5" data-k="x" value="${r.x}"></div>
        <div><label>Y%</label><input type="number" step="0.5" data-k="y" value="${r.y}"></div>
        <div><label>W%</label><input type="number" step="0.5" data-k="w" value="${r.w}"></div>
        <div><label>H%</label><input type="number" step="0.5" data-k="h" value="${r.h}"></div>
        <div><label>起 s</label><input type="number" step="0.1" data-k="start" value="${r.start}"></div>
        <div><label>止 s</label><input type="number" step="0.1" data-k="end" value="${r.end}"></div>
      </div>
    </div>`).join('');
  if (layer) {
    layer.innerHTML = state.labRegions.map((r, i) =>
      `<div class="region-box" style="left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%"><span>${i + 1} ${esc(r.name)}</span></div>`
    ).join('');
  }
}

function bindLabRegions() {
  $$('[data-preset]').forEach((btn) => {
    btn.onclick = () => addLabRegion({ ...REGION_PRESETS[btn.dataset.preset] });
  });
  $('#lab-region-add').onclick = () => addLabRegion({ name: '自定义', x: 30, y: 30, w: 30, h: 8 });
  $('#lab-region-list').addEventListener('input', (e) => {
    const item = e.target.closest('.region-item');
    const k = e.target.dataset.k;
    if (!item || !k) return;
    const r = state.labRegions.find((x) => x.id === item.dataset.rid);
    if (!r) return;
    r[k] = Number(e.target.value) || 0;
    renderLabRegions();
    // 保持正在输入的焦点
    const next = item.querySelector(`[data-k="${k}"]`);
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  });
  $('#lab-region-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="del"]')) {
      const item = e.target.closest('.region-item');
      state.labRegions = state.labRegions.filter((x) => x.id !== item.dataset.rid);
      renderLabRegions();
    }
  });
  $('#lab-mode-regions').onclick = () => setLabMode('regions2');
}

/* ---------------- R1：桌面引擎 ---------------- */
async function loadHub() {
  try {
    state.hub = await api.hub.status();
    renderHub();
    updateSubModelSelect();
    updateEnhNote();
  } catch (e) {
    toast('引擎状态读取失败：' + (e.message || e), 'err');
  }
}

function hubEngine(id) {
  return state.hub && state.hub.engines.find((x) => x.id === id);
}

function renderHub() {
  if (!state.hub) return;
  const hw = state.hub.hw;
  $('#hub-tier').textContent = hw.tierLabel;
  $('#hub-cpu').textContent = (hw.appleSilicon ? 'Apple Silicon · ' : '') + hw.cpuModel.slice(0, 34);
  $('#hub-mem').textContent = fmtBytes(hw.memBytes) + ' · ' + hw.cores + ' 核';
  $('#hub-gpu').textContent = hw.gpuLabel;
  $('#hub-disk').textContent = fmtBytes(hw.freeDisk) + ' / 已用 ' + fmtBytes(state.hub.totalUsed);

  const featIcon = { subtitle: 'captions', enhance: 'zap' };
  $('#hub-engines').innerHTML = state.hub.engines.map((en) => {
    const status = !en.supported
      ? `<span class="hub-pct hub-unsupported">当前平台不支持</span>`
      : en.installed
      ? `<span class="pill emerald square">已安装</span><span class="hub-pct">${fmtBytes(en.installSize)}</span>
         <span class="hub-actions"><button class="btn tiny ghost" data-act="uninstall-engine" data-id="${en.id}">删除</button></span>`
      : `<span class="hub-pct">${en.downloadSize ? fmtBytes(en.downloadSize) : '约 6MB'}</span>
         <span class="hub-actions"><button class="btn tiny primary" data-act="install-engine" data-id="${en.id}">下载</button></span>`;
    return `<div class="hub-row ${en.supported ? '' : 'hub-unsupported'}" data-id="${en.id}">
      <div class="hub-ic">${ic(featIcon[en.feature] || 'cpu', 18)}</div>
      <div class="hub-main">
        <div class="hub-t">${esc(en.name)} <span class="hub-license">${en.license}</span><span class="muted mono" style="font-size:10px;font-weight:400">v${en.version}</span></div>
        <div class="hub-d">${esc(en.summary)}</div>
        <div class="hub-progress hidden" id="hp-${en.id}"><i style="width:0%"></i></div>
      </div>${status}
    </div>`;
  }).join('');

  $('#hub-models').innerHTML = state.hub.models.map((m) => {
    const status = m.installed
      ? `<span class="pill emerald square">已下载</span><span class="hub-pct">${fmtBytes(m.installedSize)}</span>
         <span class="hub-actions"><button class="btn tiny ghost" data-act="uninstall-model" data-id="${m.id}">删除</button></span>`
      : `<span class="hub-pct">${fmtBytes(m.size)}</span>
         <span class="hub-actions"><button class="btn tiny primary" data-act="install-model" data-id="${m.id}">下载</button></span>`;
    return `<div class="hub-row" data-id="${m.id}">
      <div class="hub-ic">${ic('hardDrive', 18)}</div>
      <div class="hub-main">
        <div class="hub-t">${esc(m.name)} <span class="muted" style="font-size:10px;font-weight:400">${esc(m.lang)}</span></div>
        <div class="hub-d">${esc(m.note)}</div>
        <div class="hub-progress hidden" id="hp-${m.id}"><i style="width:0%"></i></div>
      </div>${status}
    </div>`;
  }).join('');
}

function setHubProgress(p) {
  const row = $(`.hub-row[data-id="${p.id}"]`);
  if (!row) return;
  const bar = row.querySelector('.hub-progress');
  const i = bar && bar.querySelector('i');
  const pct = row.querySelector('.hub-pct');
  if (p.phase === 'download' || p.phase === 'extract') {
    if (bar) bar.classList.remove('hidden');
    const pctVal = p.phase === 'extract' ? 99 : Math.round(p.percent || 0);
    if (i) i.style.width = pctVal + '%';
    if (pct) pct.textContent = p.phase === 'extract' ? '解压中…' : pctVal + '%';
  }
}

function bindHub() {
  $('#hub-refresh').onclick = () => loadHub();
  $('#hub-open-dir').onclick = () => api.hub.openDir();
  $('#hub-engines').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'install-engine') await hubInstall('engine', b.dataset.id, b);
    if (b.dataset.act === 'uninstall-engine') { api.hub.uninstall('engine', b.dataset.id); await loadHub(); toast('引擎已删除', 'info'); }
  });
  $('#hub-models').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'install-model') await hubInstall('model', b.dataset.id, b);
    if (b.dataset.act === 'uninstall-model') { api.hub.uninstall('model', b.dataset.id); await loadHub(); toast('模型已删除', 'info'); }
  });
}

async function hubInstall(kind, id, btn) {
  if (btn) btn.disabled = true;
  try {
    await api.hub.install(kind, id);
    toast('安装完成', 'ok');
  } catch (e) {
    toast('安装失败：' + cleanIpcError(e), 'err');
  } finally {
    await loadHub();
  }
}

/* ---------------- R2：AI 字幕 ---------------- */
function updateSubModelSelect() {
  const sel = $('#sub-model');
  if (!sel || !state.hub) return;
  const cur = sel.value || 'whisper-base';
  sel.innerHTML = state.hub.models.filter((m) => m.engine === 'whisper').map((m) =>
    `<option value="${m.id}" ${m.id === cur ? 'selected' : ''}>${esc(m.name)}${m.installed ? ' · 已下载' : ' · 未下载'}</option>`
  ).join('');
  updateSubRunState();
}

function updateSubRunState() {
  const run = $('#sub-run');
  const note = $('#sub-model-note span:last-child') || $('#sub-model-note').querySelector('span:last-child');
  if (!run || !state.hub) return;
  const mid = $('#sub-model').value;
  const m = state.hub.models.find((x) => x.id === mid);
  const engine = hubEngine('whisper');
  const ready = !!state.subFile && engine && engine.installed && m && m.installed;
  run.disabled = !ready;
  const why = !state.subFile ? '请先选择视频文件'
    : !engine.installed ? '未安装 Whisper.cpp 引擎，请点「管理引擎/模型」下载（约 6MB）'
    : !(m && m.installed) ? `模型「${m ? m.name : ''}」未下载，请点「管理引擎/模型」下载`
    : '就绪：点击生成字幕';
  const noteEl = $('#sub-model-note span:last-child');
  if (noteEl) noteEl.textContent = why;
}

function srtTimestamp(sec) {
  sec = Math.max(0, sec || 0);
  const ms = Math.round(sec * 1000);
  const p = (x, l = 2) => String(x).padStart(l, '0');
  return `${p(ms / 3600000 | 0)}:${p((ms % 3600000) / 60000 | 0)}:${p((ms % 60000) / 1000 | 0)},${p(ms % 1000, 3)}`;
}
function segmentsToSrt(segs) {
  return segs.map((s, i) => `${i + 1}\n${srtTimestamp(s.start)} --> ${srtTimestamp(s.end)}\n${s.text.trim()}\n`).join('\n');
}

function renderSubSegments() {
  $('#sub-segments').innerHTML = state.subSegments.map((s, i) => `
    <div class="sub-seg">
      <div class="sub-time">${srtTimestamp(s.start)}<br>↓<br>${srtTimestamp(s.end)}</div>
      <input type="text" data-i="${i}" value="${esc(s.text)}" />
    </div>`).join('');
  $('#sub-seg-count').textContent = state.subSegments.length + ' 句';
}

async function subPick() {
  const f = await api.ai.pickFile();
  if (!f) return;
  state.subFile = f;
  $('#sub-filebar').style.display = 'flex';
  $('#sub-file-name').textContent = f.name;
  $('#sub-file-meta').textContent = fmtBytes(f.size);
  updateSubRunState();
}

async function subRun() {
  const btn = $('#sub-run');
  btn.disabled = true;
  $('#sub-progress').classList.remove('hidden');
  state.aiTask = 'sub';
  try {
    const res = await api.ai.transcribe({
      input: state.subFile.path,
      modelId: $('#sub-model').value,
      language: $('#sub-lang').value
    });
    state.subSegments = res.segments;
    renderSubSegments();
    $('#sub-result-card').classList.remove('hidden');
    $('#sub-burn-card').classList.remove('hidden');
    toast('字幕识别完成', 'ok');
  } catch (e) {
    toast('识别失败：' + cleanIpcError(e), 'err');
  } finally {
    state.aiTask = null;
    btn.disabled = false;
    updateSubRunState();
  }
}

function bindSubtitle() {
  $('#sub-pick').onclick = subPick;
  $('#sub-goto-engine').onclick = () => switchView('engine');
  $('#sub-model').onchange = updateSubRunState;
  $('#sub-run').onclick = subRun;
  $('#sub-segments').addEventListener('input', (e) => {
    const i = Number(e.target.dataset.i);
    if (state.subSegments[i]) state.subSegments[i].text = e.target.value;
  });
  $('#sub-export-srt').onclick = async () => {
    if (!state.subSegments.length) return;
    const p = await api.ai.saveSrt(state.subFile.path, segmentsToSrt(state.subSegments));
    if (p) toast('SRT 已导出', 'ok');
  };
  $('#sub-burn').onclick = async () => {
    const btn = $('#sub-burn');
    btn.disabled = true;
    $('#sub-burn-progress').classList.remove('hidden');
    state.aiTask = 'burn';
    try {
      const res = await api.ai.burn({
        input: state.subFile.path,
        srt: segmentsToSrt(state.subSegments),
        fontSize: Number($('#sub-fontsize').value) || 18,
        marginV: Number($('#sub-marginv').value) || 36
      });
      state.subOutput = res.output;
      $('#sub-reveal').disabled = false;
      toast('字幕烧录完成', 'ok');
    } catch (e) {
      toast('烧录失败：' + cleanIpcError(e), 'err');
    } finally {
      state.aiTask = null;
      btn.disabled = false;
    }
  };
  $('#sub-reveal').onclick = () => state.subOutput && api.fs.reveal(state.subOutput);
}

/* ---------------- R4：画质增强 ---------------- */
function updateEnhNote() {
  if (!state.hub) return;
  const en = hubEngine(state.enhEngine);
  const btn = $('#enh-run');
  $('#enh-engine-note').textContent = en && en.installed
    ? '引擎已就绪，可直接开始增强。'
    : '选中的引擎尚未下载，请点「下载引擎」（50–420MB，仅一次）。';
  if (btn) btn.disabled = !(state.enhFile && en && en.installed);
}

async function enhPick() {
  const f = await api.ai.pickFile();
  if (!f) return;
  state.enhFile = f;
  $('#enh-filebar').style.display = 'flex';
  $('#enh-file-name').textContent = f.name;
  $('#enh-file-meta').textContent = fmtBytes(f.size);
  updateEnhNote();
}

function setEnhEngine(engine) {
  state.enhEngine = engine;
  $$('#enh-modes .enh-mode').forEach((el) => el.classList.toggle('on', el.dataset.engine === engine));
  updateEnhNote();
}

function bindEnhance() {
  $('#enh-pick').onclick = enhPick;
  $('#enh-goto-engine').onclick = () => switchView('engine');
  $('#enh-modes').addEventListener('click', (e) => {
    const card = e.target.closest('.enh-mode');
    if (card) setEnhEngine(card.dataset.engine);
  });
  $('#enh-run').onclick = async () => {
    const btn = $('#enh-run');
    btn.disabled = true;
    $('#enh-progress').classList.remove('hidden');
    $('#enh-done').classList.add('hidden');
    const scaleRadio = $(`input[name="${state.enhEngine}-scale"]:checked`);
    const scale = state.enhEngine === 'realsr' ? 4 : (scaleRadio ? Number(scaleRadio.value) : 2);
    state.aiTask = 'enh';
    try {
      const res = await api.ai.enhance({ input: state.enhFile.path, engine: state.enhEngine, scale });
      state.enhOutput = res.output;
      $('#enh-done').classList.remove('hidden');
      $('#enh-frames').textContent = '产出 ' + res.frames + ' 帧';
      toast('画质增强完成', 'ok');
    } catch (e) {
      const msg = cleanIpcError(e);
      if (msg !== '已取消') toast('增强失败：' + msg, 'err');
      else toast('任务已取消', 'info');
    } finally {
      state.aiTask = null;
      btn.disabled = false;
      updateEnhNote();
    }
  };
  $('#enh-cancel').onclick = () => api.ai.cancel();
  $('#enh-reveal').onclick = () => state.enhOutput && api.fs.reveal(state.enhOutput);
}

/* ---------------- v2.6：AI 批量切片 ---------------- */
state.clips = {
  inited: false,
  files: [],
  cfg: null,
  skus: [],
  sources: [],
  currentId: null,
  current: null,
  filter: 'all',
  selectedCid: null,
  busy: null,
  exportDir: null
};

const REASON_LABEL = {
  sku: '命中商品',
  price: '命中价格',
  cta: '转化话术',
  pos: '卖点词',
  neg: '负向词',
  filler: '口头禅多',
  len: '时长不佳',
  density: '语速异常'
};
function clipReasonLabel(code) { return T(REASON_LABEL[code] || code); }

function clipTime(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function updateClipModelSelect() {
  const sel = $('#clip-model');
  if (!sel || !state.hub) return;
  const cur = sel.value || (state.clips.cfg && state.clips.cfg.modelId) || 'whisper-base';
  sel.innerHTML = state.hub.models.filter((m) => m.engine === 'whisper').map((m) =>
    `<option value="${m.id}" ${m.id === cur ? 'selected' : ''}>${esc(m.name)}${m.installed ? ' · 已下载' : ' · 未下载'}</option>`
  ).join('');
  updateClipAnalyzeState();
}

function updateClipAnalyzeState() {
  const btn = $('#clip-analyze');
  const hint = $('#clip-hint');
  if (!btn) return;
  btn.disabled = !(state.clips.files.length && state.clips.busy !== 'analyze');
  if (!state.hub) return;
  const mid = $('#clip-model').value;
  const m = state.hub.models.find((x) => x.id === mid);
  const engine = state.hub.engines.find((x) => x.id === 'whisper');
  const why = !state.clips.files.length ? T('请先添加素材文件')
    : !(engine && engine.installed) ? T('未安装 Whisper.cpp 引擎')
    : !(m && m.installed) ? T('模型未下载：{0}', m ? m.name : mid)
    : T('{0} 个素材待分析', state.clips.files.length);
  if (hint) hint.textContent = why;
}

function renderClipFiles() {
  const wrap = $('#clip-files');
  if (!state.clips.files.length) {
    wrap.innerHTML = `<div class="clip-empty"><span>${ic('inbox', 20)}</span><span>${T('还没有素材：点右上角选择视频文件，或直接选择整个素材文件夹（自动递归扫描）。')}</span></div>`;
  } else {
    wrap.innerHTML = state.clips.files.map((f, i) => `
      <div class="clip-file-row">
        <span class="clip-file-ic">${ic('film', 15)}</span>
        <span class="clip-file-name" title="${esc(f.path)}">${esc(f.name)}</span>
        <span class="muted mono">${fmtBytes(f.size)}</span>
        <button class="btn tiny" data-act="remove-file" data-i="${i}">${ic('x', 13)}</button>
      </div>`).join('');
  }
  updateClipAnalyzeState();
}

function collectClipCfg() {
  const num = (id, dft) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : dft;
  };
  return {
    modelId: $('#clip-model').value,
    language: $('#clip-lang').value,
    minDuration: num('#clip-min', 12),
    maxDuration: num('#clip-max', 90),
    targetDuration: num('#clip-target', 35),
    maxCandidates: num('#clip-maxc', 20),
    minScore: num('#clip-minscore', 45),
    autoApprove: num('#clip-auto', 0),
    leadPad: num('#clip-lead', 0.3),
    trailPad: num('#clip-trail', 0.5),
    requireSku: $('#clip-require-sku').checked,
    positiveWords: $('#clip-words-pos').value,
    ctaWords: $('#clip-words-cta').value,
    negativeWords: $('#clip-words-neg').value,
    burnSubtitles: $('#clip-burn-out').checked,
    fontSize: num('#clip-fontsize', 18),
    marginV: num('#clip-marginv', 64)
  };
}

function fillClipCfgForm(cfg) {
  const set = (id, v) => { if ($(id) && v !== undefined) $(id).value = v; };
  set('#clip-lang', cfg.language);
  set('#clip-min', cfg.minDuration);
  set('#clip-max', cfg.maxDuration);
  set('#clip-target', cfg.targetDuration);
  set('#clip-maxc', cfg.maxCandidates);
  set('#clip-minscore', cfg.minScore);
  set('#clip-auto', cfg.autoApprove);
  set('#clip-lead', cfg.leadPad);
  set('#clip-trail', cfg.trailPad);
  $('#clip-require-sku').checked = !!cfg.requireSku;
  set('#clip-words-pos', cfg.positiveWords);
  set('#clip-words-cta', cfg.ctaWords);
  set('#clip-words-neg', cfg.negativeWords);
  $('#clip-burn-out').checked = cfg.burnSubtitles !== false;
  set('#clip-fontsize', cfg.fontSize);
  set('#clip-marginv', cfg.marginV);
}

async function clipAddFiles(list) {
  list.forEach((f) => {
    if (f && f.path && !state.clips.files.some((x) => x.path === f.path)) state.clips.files.push(f);
  });
  renderClipFiles();
}

/* ---------------- 商品库 ---------------- */
function renderSkus() {
  const wrap = $('#clip-sku-list');
  const rows = state.clips.skus;
  $('#clip-sku-count').textContent = T('{0} 个商品', rows.length);
  if (!rows.length) {
    wrap.innerHTML = `<div class="clip-empty" style="padding:14px"><span>${ic('tags', 18)}</span><span>${T('商品库为空：点「添加商品」或导入 CSV，识别到商品名/别名时会自动关联片段。')}</span></div>`;
    return;
  }
  wrap.innerHTML = `<div class="clip-sku-row clip-sku-head"><span>${T('商品名称')}</span><span>${T('价格')}</span><span>${T('别名（; 分隔）')}</span><span></span></div>` +
    rows.map((s, i) => `
      <div class="clip-sku-row" data-i="${i}">
        <input type="text" data-field="name" value="${esc(s.name)}" placeholder="${T('商品名称')}" />
        <input type="text" data-field="price" value="${esc(s.price)}" placeholder="29.9" />
        <input type="text" data-field="aliases" value="${esc((s.aliases || []).join(';'))}" placeholder="${T('剪刀;不锈钢剪')}" />
        <button class="btn tiny" data-act="sku-del">${ic('x', 13)}</button>
      </div>`).join('');
}

async function persistSkusFromTable() {
  const rows = $$('#clip-sku-list .clip-sku-row[data-i]').map((row) => ({
    id: (state.clips.skus[Number(row.dataset.i)] || {}).id,
    name: row.querySelector('[data-field="name"]').value.trim(),
    price: row.querySelector('[data-field="price"]').value.trim(),
    aliases: row.querySelector('[data-field="aliases"]').value
  }));
  state.clips.skus = await api.clips.saveSkus(rows);
  renderSkus();
}

/* ---------------- 素材库 / 候选审核 ---------------- */
async function loadClipSources(preselect) {
  state.clips.sources = await api.clips.list();
  const sel = $('#clip-source-select');
  if (!state.clips.sources.length) {
    sel.innerHTML = `<option value="">${T('暂无已分析素材')}</option>`;
    state.clips.current = null;
    state.clips.currentId = null;
    renderCandidates();
  } else {
    sel.innerHTML = state.clips.sources.map((s) =>
      `<option value="${s.id}" ${s.id === state.clips.currentId ? 'selected' : ''}>${esc(s.name)} · ${s.total} ${T('候选')} · ${s.approved}✓</option>`
    ).join('');
    const want = preselect || (state.clips.currentId && state.clips.sources.some((s) => s.id === state.clips.currentId) ? state.clips.currentId : state.clips.sources[0].id);
    state.clips.currentId = want;
    sel.value = want;
    await loadClipSource(want);
  }
  updateClipApprovedCount();
  updateClipAnalyzeState();
}

async function loadClipSource(id) {
  if (!id) { state.clips.current = null; renderCandidates(); return; }
  state.clips.current = await api.clips.get(id);
  state.clips.currentId = id;
  renderCandidates();
}

function updateClipApprovedCount() {
  const n = state.clips.sources.reduce((a, s) => a + (s.approved || 0), 0);
  $('#clip-approved-count').textContent = T('已通过 {0} 条', n);
  const btn = $('#clip-export');
  if (btn) btn.disabled = state.clips.busy === 'render' || n === 0;
}

function statusLabel(st) {
  return st === 'approved' ? T('已通过') : st === 'rejected' ? T('已淘汰') : T('待审');
}

function renderCandidates() {
  const wrap = $('#clip-candidates');
  const rec = state.clips.current;
  if (!rec || !rec.candidates || !rec.candidates.length) {
    wrap.innerHTML = `<div class="clip-empty"><span>${ic('inbox', 20)}</span><span>${T('该素材还没有候选片段：先批量分析，或调低「最低入选分」后按新规则重算。')}</span></div>`;
    return;
  }
  const list = rec.candidates
    .filter((c) => state.clips.filter === 'all' || c.status === state.clips.filter)
    .slice()
    .sort((a, b) => b.score - a.score);
  if (!list.length) {
    wrap.innerHTML = `<div class="clip-empty"><span>${ic('inbox', 20)}</span><span>${T('当前筛选下没有片段。')}</span></div>`;
    return;
  }
  const scoreCls = (n) => (n >= 75 ? 's-hi' : n >= 55 ? 's-md' : 's-lo');
  wrap.innerHTML = list.map((c) => {
    const tags = [];
    (c.reasons || []).forEach((r) => {
      const cls = r.c === 'neg' || r.c === 'filler' || r.c === 'len' || r.c === 'density' ? 'tag-warn'
        : r.c === 'sku' ? 'tag-sku' : 'tag-hit';
      const txt = r.v ? `${clipReasonLabel(r.c)}·${r.v}` : clipReasonLabel(r.c);
      tags.push(`<span class="clip-tag ${cls}">${esc(txt)}</span>`);
    });
    return `
    <div class="clip-cand st-${c.status} ${state.clips.selectedCid === c.id ? 'sel' : ''}" data-cid="${c.id}">
      <div class="clip-cand-top">
        <span class="clip-score ${scoreCls(c.score)}">${c.score}</span>
        <span class="clip-status st-${c.status}">${statusLabel(c.status)}</span>
        <span class="clip-tr mono">${clipTime(c.start)} – ${clipTime(c.end)} · ${(c.end - c.start).toFixed(1)}s</span>
        <span class="clip-tr-edit mono">
          <input type="number" step="0.1" class="clip-tin" data-field="start" value="${c.start}" aria-label="start" />
          <i>–</i>
          <input type="number" step="0.1" class="clip-tin" data-field="end" value="${c.end}" aria-label="end" />
        </span>
        <span class="clip-cand-btns">
          <button class="btn tiny" data-act="preview" title="${T('预览 (I)')}">${ic('play', 13)}</button>
          <button class="btn tiny cyan" data-act="approve" title="J">${ic('check', 13)} ${T('通过')}</button>
          <button class="btn tiny danger" data-act="reject" title="K">${ic('x', 13)} ${T('淘汰')}</button>
        </span>
      </div>
      ${tags.length ? `<div class="clip-tags">${tags.join('')}</div>` : ''}
      <p class="clip-cand-text">${esc(c.text || '')}</p>
    </div>`;
  }).join('');
}

function filteredCandidates() {
  const rec = state.clips.current;
  if (!rec) return [];
  return rec.candidates
    .filter((c) => state.clips.filter === 'all' || c.status === state.clips.filter)
    .sort((a, b) => b.score - a.score);
}

async function previewCandidate(cid, autoplay = true) {
  const rec = state.clips.current;
  const c = rec && rec.candidates.find((x) => x.id === cid);
  if (!c) return;
  state.clips.selectedCid = cid;
  const v = $('#clip-video');
  const url = toFileUrl(rec.source.path);
  if (v.dataset.src !== url) { v.src = url; v.dataset.src = url; }
  v.currentTime = c.start;
  v.dataset.loopEnd = c.end;
  try { await v.play(); } catch (_) { /* 自动播放被拦时点 I 或卡片 */ }
  renderCandidates();
}

async function setCandidateStatus(cid, status) {
  const rec = state.clips.current;
  if (!rec) return;
  await api.clips.candidate(rec.id, cid, { status });
  const c = rec.candidates.find((x) => x.id === cid);
  if (c) c.status = status;
  // 同步素材库汇总
  const sum = state.clips.sources.find((s) => s.id === rec.id);
  if (sum) {
    sum.approved = rec.candidates.filter((x) => x.status === 'approved').length;
    sum.rejected = rec.candidates.filter((x) => x.status === 'rejected').length;
  }
  updateClipApprovedCount();
  renderCandidates();
}

function advanceSelection(step = 1) {
  const list = filteredCandidates();
  if (!list.length) return null;
  let idx = list.findIndex((c) => c.id === state.clips.selectedCid);
  if (idx < 0) idx = step > 0 ? -1 : list.length;
  idx += step;
  if (idx < 0 || idx >= list.length) return null;
  return list[idx];
}

async function clipTriage(statusOrNext) {
  if (state.currentView !== 'clips' || state.clips.busy) return;
  if (!state.clips.selectedCid) {
    const first = filteredCandidates()[0];
    if (first) previewCandidate(first.id);
    return;
  }
  if (statusOrNext === 'next') {
    const n = advanceSelection(1);
    if (n) previewCandidate(n.id);
    return;
  }
  await setCandidateStatus(state.clips.selectedCid, statusOrNext);
  // 优先跳到下一条待审
  const rec = state.clips.current;
  const rest = rec.candidates
    .filter((c) => c.status === 'candidate')
    .sort((a, b) => b.score - a.score);
  const next = rest[0] || advanceSelection(1);
  if (next) previewCandidate(next.id);
}

/* ---------------- 分析 / 导出 ---------------- */
async function clipAnalyze(rerunCurrent) {
  let files;
  if (rerunCurrent) {
    if (!state.clips.current) return;
    files = [{ path: state.clips.current.source.path, name: state.clips.current.source.name, size: state.clips.current.source.size }];
  } else {
    files = state.clips.files.slice();
    if (!files.length) { toast(T('请先添加素材文件'), 'err'); return; }
  }
  const opts = collectClipCfg();
  if (rerunCurrent) opts.rerunRules = true;
  state.clips.cfg = await api.clips.saveConfig(opts);
  state.clips.busy = 'analyze';
  $('#clip-analyze').disabled = true;
  $('#clip-cancel-analyze').classList.remove('hidden');
  $('#clip-progress').classList.remove('hidden');
  $('#clip-progress-bar').style.width = '0%';
  try {
    await api.clips.analyze(files, opts);
    if (rerunCurrent) await loadClipSource(state.clips.currentId);
    else {
      state.clips.files = [];
      renderClipFiles();
      await loadClipSources();
    }
    toast(rerunCurrent ? T('已按新规则重算') : T('批量分析完成'), 'ok');
  } catch (e) {
    const msg = cleanIpcError(e);
    if (msg === '已取消') toast(T('任务已取消'), 'info');
    else toast(T('分析失败：{0}', msg), 'err');
  } finally {
    state.clips.busy = null;
    $('#clip-cancel-analyze').classList.add('hidden');
    $('#clip-progress-label').textContent = '';
    $('#clip-progress-time').textContent = '';
    $('#clip-progress-hint').textContent = '';
    $('#clip-progress-bar').classList.remove('meter-pulse');
    updateClipAnalyzeState();
  }
}

async function clipExport() {
  const opts = collectClipCfg();
  opts.batchName = $('#clip-batch-name').value.trim();
  state.clips.busy = 'render';
  $('#clip-export').disabled = true;
  $('#clip-export-cancel').classList.remove('hidden');
  $('#clip-export-progress').classList.remove('hidden');
  $('#clip-export-bar').style.width = '0%';
  try {
    const res = await api.clips.render(opts);
    state.clips.exportDir = res.dir;
    $('#clip-reveal-dir').disabled = false;
    await loadClipSources();
    toast(T('已导出 {0} 条片段', res.count), 'ok');
    api.fs.reveal(res.dir);
  } catch (e) {
    const msg = cleanIpcError(e);
    if (msg === '已取消') toast(T('任务已取消'), 'info');
    else toast(T('导出失败：{0}', msg), 'err');
  } finally {
    state.clips.busy = null;
    $('#clip-export-cancel').classList.add('hidden');
    updateClipApprovedCount();
  }
}

async function initClips() {
  if (state.clips.inited) return;
  state.clips.inited = true;
  const [cfg, skus] = await Promise.all([api.clips.getConfig(), api.clips.getSkus()]);
  state.clips.cfg = cfg;
  state.clips.skus = skus;
  fillClipCfgForm(cfg);
  renderSkus();
  renderClipFiles();
  await loadClipSources();
}

function bindClips() {
  api.clips.onProgress((p) => {
    const pct = Math.round(p.percent || 0) + '%';
    if (state.clips.busy === 'analyze') {
      $('#clip-progress-label').textContent = `${p.name ? p.name + ' · ' : ''}${p.stage || ''}${p.total ? `（${p.index}/${p.total}）` : ''}`;
      $('#clip-progress-pct').textContent = pct;
      const bar = $('#clip-progress-bar');
      bar.style.width = pct;
      // ASR 阶段（8%-86%）进度可能长时间不动（30s 一个识别窗口）：显示耗时/预计剩余并加脉冲动画
      const inAsr = /语音识别/.test(p.stage || '');
      bar.classList.toggle('meter-pulse', inAsr);
      const timeEl = $('#clip-progress-time');
      if (inAsr && Number.isFinite(p.asrElapsed)) {
        const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        timeEl.textContent = p.asrEta > 0
          ? T('已用 {0} · 预计剩余 {1}', fmt(p.asrElapsed), fmt(p.asrEta))
          : T('已用 {0}', fmt(p.asrElapsed));
      } else if (!inAsr) {
        timeEl.textContent = '';
      }
      $('#clip-progress-hint').textContent = inAsr && p.hint === 'longAsr'
        ? T('长视频首次本地识别需要数分钟，请耐心等待；完成后再次分析将直接命中缓存。') : '';
    } else if (state.clips.busy === 'render') {
      $('#clip-export-label').textContent = `${p.name || ''} ${p.stage || ''}`;
      $('#clip-export-pct').textContent = pct;
      $('#clip-export-bar').style.width = pct;
    }
  });

  $('#clip-pick').onclick = async () => clipAddFiles(await api.clips.pickFiles());
  $('#clip-scan').onclick = async () => {
    const list = await api.clips.scanDir();
    await clipAddFiles(list);
    if (list.length) toast(T('已扫描到 {0} 个视频', list.length), 'ok');
  };
  $('#clip-goto-engine').onclick = () => switchView('engine');
  $('#clip-clear').onclick = () => { state.clips.files = []; renderClipFiles(); };
  $('#clip-model').onchange = updateClipAnalyzeState;
  $('#clip-analyze').onclick = () => clipAnalyze(false);
  $('#clip-cancel-analyze').onclick = () => api.clips.cancel();

  $('#clip-files').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'remove-file') {
      state.clips.files.splice(Number(b.dataset.i), 1);
      renderClipFiles();
    }
  });

  $('#clip-save-rules').onclick = async () => {
    state.clips.cfg = await api.clips.saveConfig(collectClipCfg());
    toast(T('规则已保存'), 'ok');
  };

  $('#clip-sku-add').onclick = async () => {
    state.clips.skus.push({ id: '', name: '', price: '', aliases: [] });
    renderSkus();
    const rows = $$('#clip-sku-list .clip-sku-row[data-i]');
    if (rows.length) rows[rows.length - 1].querySelector('[data-field="name"]').focus();
  };
  $('#clip-sku-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'sku-del') {
      const row = b.closest('.clip-sku-row[data-i]');
      state.clips.skus.splice(Number(row.dataset.i), 1);
      state.clips.skus = await api.clips.saveSkus(state.clips.skus);
      renderSkus();
    }
  });
  $('#clip-sku-list').addEventListener('change', persistSkusFromTable);
  $('#clip-sku-csv').onclick = async () => {
    const r = await api.clips.importCsv();
    if (r) { state.clips.skus = await api.clips.getSkus(); renderSkus(); toast(T('已导入 {0} 个，共 {1} 个商品', r.added, r.total), 'ok'); }
  };
  $('#clip-sku-export').onclick = async () => {
    const p = await api.clips.exportCsv();
    if (p) toast(T('CSV 已导出'), 'ok');
  };

  $('#clip-source-select').onchange = (e) => loadClipSource(e.target.value);
  $('#clip-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#clip-filter button').forEach((x) => x.classList.toggle('on', x === b));
    state.clips.filter = b.dataset.filter;
    renderCandidates();
  });
  $('#clip-rerun').onclick = () => clipAnalyze(true);
  $('#clip-remove-source').onclick = async () => {
    if (!state.clips.currentId) return;
    if (!window.confirm(T('删除该素材的片段库？原始视频不会被删除，可重新分析。'))) return;
    await api.clips.remove(state.clips.currentId);
    state.clips.currentId = null;
    await loadClipSources();
  };

  $('#clip-candidates').addEventListener('click', async (e) => {
    const card = e.target.closest('.clip-cand');
    if (!card) return;
    const cid = card.dataset.cid;
    const b = e.target.closest('button[data-act]');
    if (b) {
      if (b.dataset.act === 'preview') previewCandidate(cid);
      if (b.dataset.act === 'approve') await clipTriageFromCard(cid, 'approved');
      if (b.dataset.act === 'reject') await clipTriageFromCard(cid, 'rejected');
      return;
    }
    previewCandidate(cid);
  });
  $('#clip-candidates').addEventListener('change', async (e) => {
    const inp = e.target.closest('input.clip-tin');
    if (!inp) return;
    const card = inp.closest('.clip-cand');
    const rec = state.clips.current;
    const c = rec.candidates.find((x) => x.id === card.dataset.cid);
    const patch = {};
    patch[inp.dataset.field] = Number(inp.value);
    await api.clips.candidate(rec.id, c.id, patch);
    Object.assign(c, (await api.clips.get(rec.id)).candidates.find((x) => x.id === c.id));
    renderCandidates();
  });

  const vid = $('#clip-video');
  vid.addEventListener('timeupdate', () => {
    if (vid.dataset.loopEnd && vid.currentTime >= Number(vid.dataset.loopEnd)) vid.pause();
  });
  vid.addEventListener('loadedmetadata', () => {
    if (state.clips.selectedCid && state.clips.current) {
      const c = state.clips.current.candidates.find((x) => x.id === state.clips.selectedCid);
      if (c) { vid.currentTime = c.start; vid.dataset.loopEnd = c.end; }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (state.currentView !== 'clips') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return;
    if (state.clips.busy) return;
    const key = e.key.toLowerCase();
    if (key === 'j') { e.preventDefault(); clipTriage('approved'); }
    else if (key === 'k') { e.preventDefault(); clipTriage('rejected'); }
    else if (key === 'enter') { e.preventDefault(); clipTriage('next'); }
    else if (key === 'i') {
      e.preventDefault();
      const cid = state.clips.selectedCid;
      if (!cid) { const first = filteredCandidates()[0]; if (first) previewCandidate(first.id); return; }
      if (vid.paused) previewCandidate(cid);
      else vid.pause();
    }
  });

  $('#clip-export').onclick = clipExport;
  $('#clip-export-cancel').onclick = () => api.clips.cancel();
  $('#clip-reveal-dir').onclick = () => state.clips.exportDir && api.fs.reveal(state.clips.exportDir);
}

/** 卡片按钮审核后自动跳到下一条待审 */
async function clipTriageFromCard(cid, status) {
  await setCandidateStatus(cid, status);
  const pending = state.clips.current.candidates
    .filter((c) => c.status === 'candidate')
    .sort((a, b) => b.score - a.score);
  if (pending[0]) previewCandidate(pending[0].id);
}

/* AI 任务进度统一分发 */
function bindAiProgress() {
  api.ai.onProgress((p) => {
    const pct = Math.round(p.percent || 0) + '%';
    if (state.aiTask === 'sub') {
      $('#sub-progress-label').textContent = p.stage || '';
      $('#sub-progress-pct').textContent = pct;
      $('#sub-progress-bar').style.width = pct;
    } else if (state.aiTask === 'burn') {
      $('#sub-burn-label').textContent = p.stage || '';
      $('#sub-burn-pct').textContent = pct;
      $('#sub-burn-bar').style.width = pct;
    } else if (state.aiTask === 'enh') {
      $('#enh-progress-label').textContent = p.stage || '';
      $('#enh-progress-pct').textContent = pct;
      $('#enh-progress-bar').style.width = pct;
      if (p.totalFrames) $('#enh-frames').textContent = `${p.frames || 0} / ${p.totalFrames} 帧`;
    } else if (state.aiTask === 'lab') {
      $('#lab-hint').textContent = `${p.stage || '处理中'} ${pct}`;
    }
  });
  api.hub.onProgress((p) => setHubProgress(p));
}

/* ---------------- account / auth ---------------- */
function cleanIpcError(e) {
  const msg = e && e.message ? String(e.message) : '';
  return msg.replace(/^Error invoking remote method '[^']+':\s*/, '') || '操作失败，请重试';
}

/** 依据登录态刷新标题栏账号区与登录门禁。 */
function renderAccount(session) {
  state.session = session || null;
  const loggedIn = !!state.session;
  const name = loggedIn ? state.session.name || state.session.email || '已登录' : '未登录';
  const mail = loggedIn ? state.session.email || '—' : '—';

  const gate = $('#auth-gate');
  if (gate) gate.classList.toggle('hidden', loggedIn);
  $('#account').classList.toggle('logged-in', loggedIn);
  $('#account-name').textContent = name;
  $('#account-menu-name').textContent = name;
  $('#account-menu-mail').textContent = mail;
  $('#account-menu-signin').classList.toggle('hidden', loggedIn);
  $('#account-menu-logout').classList.toggle('hidden', !loggedIn);
  $('#account').classList.remove('open');
}

async function initAuth() {
  const btn = $('#auth-gate-login');
  try {
    const session = await api.auth.getSession();
    renderAccount(session);
    $('#auth-gate-status').textContent = session ? '' : '尚未登录，请点击下方按钮完成登录或注册。';
  } catch (e) {
    $('#auth-gate-status').textContent = cleanIpcError(e);
  } finally {
    if (btn) btn.disabled = false;
  }
  api.auth.onChanged((s) => renderAccount(s));
}

/** 打开系统浏览器完成登录；网页登录成功回跳后 Promise 才 resolve。 */
async function doLogin() {
  const status = $('#auth-gate-status');
  const btn = $('#auth-gate-login');
  if (btn.disabled) return;
  btn.disabled = true;
  if (status) status.textContent = '已打开浏览器，请在网页中完成登录，完成后会自动返回本客户端…';
  try {
    const session = await api.auth.login();
    renderAccount(session);
    toast(T('已登录：{0}', session.email || session.name || ''));
  } catch (e) {
    const msg = cleanIpcError(e);
    if (status) status.textContent = msg;
    toast(msg, 'err');
  } finally {
    btn.disabled = false;
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
    if (state.clips && state.clips.inited) {
      renderSkus();
      renderClipFiles();
      loadClipSources();
    }
  });

  // window controls
  $('#win-close').onclick = () => api.win.close();
  $('#win-min').onclick = () => api.win.minimize();
  $('#win-max').onclick = () => api.win.maximize();

  // account
  $('#account-btn').onclick = (e) => {
    e.stopPropagation();
    $('#account').classList.toggle('open');
  };
  document.addEventListener('click', () => $('#account').classList.remove('open'));
  $('#account-menu-signin').onclick = () => doLogin();
  $('#account-menu-web').onclick = () => api.auth.openWeb();
  $('#account-menu-logout').onclick = async () => {
    await api.auth.logout();
    renderAccount(null);
    $('#auth-gate-status').textContent = '已退出登录。';
    toast('已退出登录', 'info');
  };
  $('#auth-gate-login').onclick = () => doLogin();
  $('#auth-gate-web').onclick = () => api.auth.openWeb();

  // nav
  $('#nav').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (item) switchView(item.dataset.view);
  });
  initSidebar();
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
  $('#lab-pick-2').onclick = (e) => { e.stopPropagation(); labPick(); };
  $('#lab-drop').onclick = labPick;
  wireLabDnd();
  $('#lab-export').onclick = labExport;
  $('#lab-reveal').onclick = () => state.labOutput && api.fs.reveal(state.labOutput);
  // 预览解码失败时给出提示（导出走 FFmpeg，不受影响），避免用户误以为「上传失败」
  $('#lab-video').addEventListener('error', () => {
    if (state.labFile) toast('该视频无法在本机预览，但导出仍可正常进行', 'err');
  });
  $('#lab-crop').oninput = (e) => { $('#lab-crop-val').textContent = e.target.value + '%'; };
  $('#lab-mode-auto').onclick = () => setLabMode('crop');
  $('#lab-mode-manual').onclick = () => setLabMode('delogo');
  $('#lab-algos').addEventListener('click', (e) => {
    const el = e.target.closest('.panel-item');
    if (!el) return;
    const idx = $$('#lab-algos .panel-item').indexOf(el);
    setLabMode(idx === 1 ? 'delogo' : 'crop');
  });
  $('#lab-original').onchange = (e) => { $('#lab-video').style.filter = e.target.checked ? 'none' : 'saturate(1.05)'; };

  // v2.5 本地 AI
  bindLabRegions();
  bindHub();
  bindSubtitle();
  bindEnhance();
  bindClips();
  bindAiProgress();
  setEnhEngine('realsr');
  setLabMode('crop');

  // global keys
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doParse();
    if ((e.metaKey || e.ctrlKey) && e.key === '1') { switchView('download'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '2') { switchView('lab'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '3') { switchView('queue'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '4') { switchView('library'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '5') { switchView('network'); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      setSidebarCollapsed(!$('#sidebar').classList.contains('collapsed'));
      e.preventDefault();
    }
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
  $('#brand-logo').src = 'logo.png';
  hydrateIcons();
  wireUi();
  initAuth();

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