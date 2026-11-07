/* ============================================================
   TokPure — AI 视频翻译（渲染层 / Voice Translation Lab）
   上传原片 → 上传「我的声音」样本 → 克隆 → 用我的声音换掉原片人声 → 出片。
   后端全部复用 AI多语口播的识别 / 翻译 / 克隆配音 / 混音能力，
   前端只负责「原片 + 声音库 + 目标语言」三件事。
   ============================================================ */
(function () {
  'use strict';

  const LANGS = [
    { id: 'zh', name: '简体中文', sub: '中文' },
    { id: 'en', name: 'English', sub: '英语' },
    { id: 'ja', name: '日本語', sub: '日语' },
    { id: 'ko', name: '한국어', sub: '韩语' },
    { id: 'es', name: 'Español', sub: '西语' },
    { id: 'pt', name: 'Português', sub: '葡语' },
    { id: 'fr', name: 'Français', sub: '法语' },
    { id: 'de', name: 'Deutsch', sub: '德语' }
  ];

  const STAGE_LABEL = {
    translate: '翻译中',
    tts: '用我的声音配音',
    render: '封装成片',
    done: '完成',
    error: '失败'
  };

  const AUDIO_EXT = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus'];
  const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'm4v'];

  const el = (id) => document.getElementById(id);
  const ico = (name, size) => window.TPI(name, size);
  const api = () => (window.tokpure && window.tokpure.vt) || null;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // 动态拼接的文案无法被 i18n 运行时按 textContent 精确命中，必须显式走词表
  const T = (key, a, b, c) => (typeof window.T === 'function' ? window.T(key, a, b, c) : key);

  const state = {
    bound: false,
    source: null,
    voices: [],
    voiceId: null,
    engine: null,
    importing: false,
    targets: new Set(['en']),
    color: '#FFFFFF',
    running: false,
    lastPct: 0,
    jobs: {},
    results: [],
    outDir: null,
    ticker: null,
    preview: null,
    previewId: null
  };

  function fmtBytes(n) {
    if (typeof window.fmtBytes === 'function') return window.fmtBytes(n);
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function notify(msg, kind) {
    if (typeof window.toast === 'function') window.toast(msg, kind || 'ok');
  }

  function cleanError(e) {
    return String((e && e.message) || e || '操作失败')
      .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
      .trim();
  }

  function hint(text, kind) {
    const host = el('vt-voice-hint');
    if (!host) return;
    host.textContent = text;
    host.dataset.kind = kind || '';
  }

  function currentLang() {
    const first = LANGS.find((l) => state.targets.has(l.id));
    return first ? first.id : 'en';
  }

  /* ---------------- 目标语言 ---------------- */
  function renderLangs() {
    const host = el('vt-langs');
    if (!host) return;
    host.innerHTML = LANGS.map((l) => `
      <button type="button" class="vt-lang${state.targets.has(l.id) ? ' on' : ''}" data-id="${l.id}">
        <span class="vt-lang-native">${esc(l.name)}</span>
        <span class="vt-lang-sub">${esc(l.sub)}</span>
      </button>`).join('');
  }

  /* 本机实测（M 系列 / 1.5B 翻译 / 0.5B 克隆）：配音约 8~12 倍实时，封装几乎不耗时。
     片长越长等待越久，先给一个量级，避免用户选了 6 个语种才发现要等一晚上。 */
  function renderEstimate() {
    const host = el('vt-est');
    if (!host) return;
    const n = Math.max(1, state.targets.size);
    if (!state.source || !state.source.duration) {
      host.textContent = '选择原片与声音后显示预计耗时';
      return;
    }
    const mins = Math.max(1, Math.round((state.source.duration / 60) * 10 * n + 1));
    host.textContent = T('原片 {0} × {1} 个语种 ≈ {2} 分钟（克隆配音约 10 倍实时，首句先加载模型）',
      fmtDur(state.source.duration), n, mins);
  }

  /* ---------------- 引擎读数 ---------------- */
  const RO_LABEL = { whisper: 'Whisper 识别', translate: 'Llama.cpp 翻译', clone: 'Chatterbox 克隆' };

  function setRo(key, ok, text) {
    const row = document.querySelector(`#vt-readout .vt-ro[data-ro="${key}"]`);
    if (!row) return;
    row.dataset.state = ok ? 'ok' : 'lack';
    const b = row.querySelector('b');
    if (b) b.textContent = text;
    row.title = ok ? T('{0} · 已就绪', T(RO_LABEL[key])) : `${T(RO_LABEL[key])} · ${T(text)}`;
  }

  function renderEngine(lib) {
    const host = el('vt-engine');
    if (!host) return;
    const engine = (lib && lib.engine) || {};
    const rows = [
      ['Whisper 识别', !!(state.status && state.status.whisper && state.status.whisper.engine && state.status.whisper.model),
        (state.status && state.status.whisper && state.status.whisper.model) ? 'whisper.cpp · 本地离线' : '首次自动下载（约 148MB）'],
      ['Llama.cpp 翻译', !!(state.status && state.status.translate && (state.status.translate.lite || state.status.translate.full)),
        '本地翻译模型 · 不联网'],
      ['我的声音克隆', !!engine.installed, engine.installed
        ? T(engine.weights ? 'Chatterbox · 已安装（权重已缓存）' : 'Chatterbox · 已安装（首次合成会下载权重）')
        : '开始任务时自动安装（约 2GB，需 Python 3.9–3.13）']
    ];
    host.innerHTML = rows.map(([label, ok, detail]) => `
      <div class="vt-engine-row">
        <span class="vt-engine-name">${esc(label)}</span>
        <span class="vt-engine-dot${ok ? ' ok' : ''}"></span>
        <span class="vt-engine-detail mono">${esc(detail)}</span>
      </div>`).join('');
  }

  async function loadStatus() {
    const a = api();
    if (!a) return;
    try {
      const s = await a.status();
      state.status = s;
      const whisperReady = !!(s.whisper && s.whisper.engine && s.whisper.model);
      const trReady = !!(s.translate && (s.translate.lite || s.translate.full));
      setRo('whisper', whisperReady, whisperReady ? '已就绪' : '首次自动安装');
      setRo('translate', trReady, trReady ? '已就绪' : '首次自动安装');
      setRo('clone', !!(s.clone && s.clone.installed), s.clone && s.clone.installed ? '已就绪' : '按需安装 2GB');
      renderEngine({ engine: s.clone });
    } catch (e) {
      setRo('whisper', false, '读取失败');
      setRo('translate', false, '读取失败');
      setRo('clone', false, '读取失败');
    }
  }

  /* ---------------- 原片 ---------------- */
  function setSource(src) {
    state.source = src;
    const bar = el('vt-file');
    const drop = el('vt-drop');
    if (bar) bar.hidden = !src;
    if (drop) drop.hidden = !!src;
    const pill = el('vt-dur-pill');
    if (pill) {
      pill.hidden = !src;
      if (src) {
        pill.textContent = src.hasAudio
          ? T('{0} · 有音轨', fmtDur(src.duration))
          : T('{0} · 无音轨', fmtDur(src.duration));
        pill.dataset.bad = (!src.hasAudio || (src.duration || 0) > 180) ? '1' : '';
      }
    }
    if (src) {
      const name = el('vt-file-name');
      const meta = el('vt-file-meta');
      if (name) name.textContent = src.name;
      if (meta) {
        meta.textContent = `${fmtBytes(src.size)} · ${fmtDur(src.duration)}${src.hasAudio ? '' : ' · ' + T('无音轨')}`;
      }
    }
    renderEstimate();
    syncRun();
  }

  async function pickVideo() {
    if (state.running) return;
    const a = api();
    if (!a) return;
    try {
      const f = await a.pickVideo();
      if (f) setSource(f);
    } catch (e) {
      notify(cleanError(e), 'err');
    }
  }

  async function usePathAsVideo(path, name) {
    const a = api();
    if (!a) return;
    try {
      const f = await a.openPath(path);
      if (f) setSource(f);
    } catch (e) {
      notify(`${cleanError(e)}${name ? `（${name}）` : ''}`, 'err');
    }
  }

  /* ---------------- 我的声音 ---------------- */
  function waveBars(peaks) {
    const arr = Array.isArray(peaks) && peaks.length ? peaks : new Array(64).fill(0.12);
    const n = arr.length;
    return arr.map((v, i) => {
      const h = Math.max(4, Math.round((Number(v) || 0) * 100));
      // 中间略高、两侧略低的包络，让默认波形也不像一条直线
      const env = 0.35 + 0.65 * Math.sin((Math.PI * (i + 1)) / (n + 1));
      return `<i style="height:${Math.max(4, Math.round(h * env))}%"></i>`;
    }).join('');
  }

  function fmtDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (v) => String(v).padStart(2, '0');
    return `${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  }

  function renderVoices() {
    const host = el('vt-voices');
    if (!host) return;
    const lib = { engine: state.engine || {} };
    renderEngine(lib);
    const cards = state.voices.map((v) => {
      const on = v.id === state.voiceId;
      const speech = Math.max(0, Math.min(100, Math.round((1 - (Number(v.ratio) || 0.6)) * 100)));
      return `
      <div class="vt-voice${on ? ' sel' : ''}" data-id="${esc(v.id)}" role="button" tabindex="0" aria-pressed="${on}">
        <div class="vt-vtop">
          <span class="vt-vname">${esc(v.name)}</span>
        </div>
        <div class="vt-wave${state.previewId === v.id ? ' live' : ''}">${waveBars(v.peaks)}</div>
        <div class="vt-vfoot">
          <span class="vt-vmeta mono">${(Number(v.duration) || 0).toFixed(1)}s 有效 · 静音 ${speech}% · ${fmtBytes(v.bytes)} · ${fmtDate(v.createdAt)} 导入</span>
          <span class="vt-vacts">
            <button type="button" class="vt-icon" data-play="${esc(v.id)}" title="试听">${ico('play', 12)}</button>
            <button type="button" class="vt-icon danger" data-del="${esc(v.id)}" title="删除这个声音">${ico('trash', 12)}</button>
          </span>
        </div>
        <span class="vt-vbadge mono">${on ? 'ACTIVE' : ''}</span>
      </div>`;
    }).join('');

    host.innerHTML = `
      <button type="button" class="vt-add${state.importing ? ' busy' : ''}" id="vt-add" ${state.importing ? 'disabled' : ''}>
        <span class="vt-add-ico">${state.importing ? '<span class="vt-spin"></span>' : ico('plus', 15)}</span>
        <span class="vt-add-body">
          <span class="vt-add-t">${state.importing ? '正在解析声音样本…' : '上传我的声音'}</span>
          <span class="vt-add-s mono">${state.importing ? '去静音 · 限带 · 两级降噪' : '8~15 秒连续说话 · 也可把音频拖到这里'}</span>
        </span>
      </button>
      ${cards || `<div class="vt-empty small">还没有克隆过声音。上传一段自己的录音，它会成为你在所有语言里的嗓子。</div>`}`;

    const count = el('vt-voice-count');
    if (count) count.textContent = String(state.voices.length);
    el('vt-add') && (el('vt-add').onclick = addVoice);
  }

  async function loadLibrary(selectId) {
    const a = api();
    if (!a) return;
    try {
      const lib = await a.library();
      state.voices = (lib && lib.items) || [];
      state.engine = (lib && lib.engine) || null;
      if (selectId) state.voiceId = selectId;
      if (!state.voices.some((v) => v.id === state.voiceId)) {
        state.voiceId = state.voices.length ? state.voices[0].id : null;
      }
      renderVoices();
      if (lib && lib.error) hint(T('声音库读取异常：{0}', lib.error), 'err');
    } catch (e) {
      hint(T('声音库读取失败：{0}', cleanError(e)), 'err');
      renderVoices();
    }
    syncRun();
  }

  async function addVoice() {
    if (state.running || state.importing) return;
    const a = api();
    if (!a) return;
    try {
      const picked = await a.pickSample();
      if (!picked) return;
      await importSample(picked.path, picked.name);
    } catch (e) {
      notify(cleanError(e), 'err');
    }
  }

  async function importSample(path, name) {
    const a = api();
    if (!a || state.importing) return;
    state.importing = true;
    renderVoices();
    hint('正在把你的声音处理成 12 秒音色条件：去静音、80Hz 高通、9.5k 低通、两级频域降噪…', 'info');
    try {
      const p = await a.importVoice({ input: path, name });
      await loadLibrary(p && p.id);
      hint(p && p.note ? T('{0}：{1}。之后再上传其他声音可以直接切换。', p.name, p.note) : T('声音已保存。'), 'ok');
      notify('「我的声音」已就绪', 'ok');
    } catch (e) {
      hint(`${cleanError(e)}`, 'err');
      notify(cleanError(e), 'err');
    } finally {
      state.importing = false;
      renderVoices();
    }
  }

  async function removeVoice(id) {
    if (state.running) return;
    const a = api();
    if (!a) return;
    const v = state.voices.find((x) => x.id === id);
    try {
      await a.removeVoice(id);
      if (state.voiceId === id) state.voiceId = null;
      await loadLibrary();
      hint(T('已删除「{0}」。', (v && v.name) || T('声音')), 'ok');
      notify('已删除', 'ok');
    } catch (e) {
      notify(cleanError(e), 'err');
    }
  }

  async function previewVoice(id) {
    if (state.running) return;
    const a = api();
    if (!a) return;
    const v = state.voices.find((x) => x.id === id);
    if (!v) return;
    if (state.preview) {
      try { state.preview.pause(); } catch (_) {}
      state.preview = null;
    }
    state.previewId = id;
    renderVoices();
    const langName = (LANGS.find((l) => l.id === currentLang()) || LANGS[1]).name;
    hint(T('正在用「{0}」的嗓子合成试听（{1}）。首次要加载 0.5B 克隆模型，约 20~40 秒。', v.name, langName), 'info');
    try {
      const res = await a.previewVoice({ voiceId: id, lang: currentLang() });
      if (!res || !res.dataUrl) throw new Error('试听合成返回为空');
      const audio = new Audio(res.dataUrl);
      state.preview = audio;
      audio.onended = () => {
        state.previewId = null;
        renderVoices();
        hint('试听结束。这条嗓子就是成片里会用的嗓子。', 'ok');
      };
      await audio.play();
      hint('正在播放试听 · 与成片同一条降噪/清洁链。', 'ok');
    } catch (e) {
      state.previewId = null;
      renderVoices();
      hint(cleanError(e), 'err');
      notify(cleanError(e), 'err');
    }
  }

  /* ---------------- 运行状态 ---------------- */
  function syncRun() {
    const btn = el('vt-run');
    const sub = el('vt-run-sub');
    const a = api();
    let reason = '';
    if (!state.source) reason = '还缺原片';
    else if (!state.source.hasAudio) reason = '原片没有音轨';
    else if ((state.source.duration || 0) > 180) reason = '原片超过 3 分钟';
    else if (!state.voiceId) reason = '还缺「我的声音」';
    else if (state.targets.size === 0) reason = '还没有选目标语言';
    if (btn) btn.disabled = !!reason || state.running || !a;
    if (sub) {
      const voiceName = (state.voices.find((v) => v.id === state.voiceId) || {}).name || T('我的声音');
      sub.textContent = state.running ? '正在本地运行…' : (reason || T('{0} 个语种 · 用「{1}」', state.targets.size, voiceName));
    }
    renderEstimate();
  }

  function setRunning(on) {
    state.running = on;
    if (state.ticker) { clearInterval(state.ticker); state.ticker = null; }
    if (on) state.ticker = setInterval(() => renderJobs(), 1000);
    const stop = el('vt-cancel');
    const prog = el('vt-progress');
    if (stop) stop.classList.toggle('hidden', !on);
    if (prog) prog.classList.toggle('hidden', !on && !state.results.length);
    ['vt-drop', 'vt-add', 'vt-srclang', 'vt-tmodel', 'vt-bgm', 'vt-subs', 'vt-langs', 'vt-voices'].forEach((id) => {
      const node = el(id);
      if (!node) return;
      if (node.classList.contains('vt-langs') || node.classList.contains('vt-voices')) {
        node.dataset.locked = on ? '1' : '';
      } else if (node.tagName === 'SELECT' || node.tagName === 'INPUT') {
        node.disabled = on;
      } else if (id === 'vt-add') {
        node.disabled = on;
      } else if (id === 'vt-drop') {
        node.dataset.locked = on ? '1' : '';
      }
    });
    if (on) {
      if (el('vt-run')) el('vt-run').disabled = true;
    }
    syncRun();
  }

  function setStage(text, pct) {
    const st = el('vt-stage');
    const pc = el('vt-pct');
    const bar = el('vt-bar');
    if (st) st.textContent = text || '准备中…';
    if (pc) pc.textContent = `${Math.round(Number(pct) || 0)}%`;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
  }

  /* ---------------- 进度 / 产出 ---------------- */
  function resetJobs() {
    state.jobs = {};
    state.results = [];
    state.lastPct = 0;
    renderJobs();
    renderResults();
  }

  function renderJobs() {
    const host = el('vt-jobs');
    if (!host) return;
    const list = LANGS.filter((l) => state.targets.has(l.id));
    if (!list.length) { host.innerHTML = ''; return; }
    host.innerHTML = list.map((l) => {
      const j = state.jobs[l.id] || {};
      const pct = Math.max(0, Math.min(100, Number(j.percent) || 0));
      const label = j.stageLabel || (STAGE_LABEL[j.stage] || '排队中');
      const bad = j.stage === 'error';
      return `
      <div class="vt-job${bad ? ' bad' : ''}">
        <div class="vt-job-top">
          <span class="vt-job-name">${esc(l.name)}</span>
          <span class="vt-job-state mono">${esc(bad ? '失败' : label)}</span>
          <span class="vt-job-pct mono">${pct}%</span>
        </div>
        <div class="vt-job-bar"><i style="width:${pct}%"></i></div>
        ${j.detail ? `<div class="vt-job-detail mono">${esc(j.detail)}</div>` : ''}
      </div>`;
    }).join('');
  }

  function onProgress(p) {
    if (!p) return;
    const pct = Number(p.percent);
    if (Number.isFinite(pct)) {
      state.lastPct = Math.max(state.lastPct, pct);
      setStage(p.stage || '处理中', state.lastPct);
    }
    if (p.lang) {
      const j = state.jobs[p.lang] || {};
      j.stage = p.langStage || j.stage;
      j.percent = Number(p.langPercent) || 0;
      j.stageLabel = p.langStage === 'error' ? '失败' : (p.stage || '');
      j.detail = p.detail || '';
      j.warning = p.warning || j.warning || '';
      if (p.langStage === 'done' || p.langStage === 'error') j.percent = 100;
      state.jobs[p.lang] = j;
    }
    if (p.file && p.file.video) {
      const file = p.file;
      if (!state.results.some((x) => x.video === file.video)) {
        state.results.push(file);
        renderResults();
      }
    }
    renderJobs();
  }

  function renderResults() {
    const host = el('vt-results');
    if (!host) return;
    if (!state.results.length) {
      host.innerHTML = `<div class="vt-empty">还没有产出。选好原片、我的声音和目标语言后点击「开始翻译并换声」。</div>`;
      const btn = el('vt-folder');
      if (btn) btn.disabled = !state.outDir;
      return;
    }
    host.innerHTML = state.results.map((f, i) => {
      const lang = LANGS.find((l) => l.id === f.lang);
      return `
      <div class="vt-result">
        <div class="vt-rhead">
          <span class="vt-rlang">${esc(lang ? lang.name : f.lang)}</span>
          <span class="vt-rmode mono">${esc(f.mode || '翻译')}</span>
          <span class="vt-rindex mono">${String(i + 1).padStart(2, '0')}</span>
        </div>
        <div class="vt-rvoice mono">${esc(f.voice || '')}</div>
        ${f.warning ? `<div class="vt-rwarn">${esc(f.warning)}</div>` : ''}
        <div class="vt-ractions">
          <button type="button" class="btn tiny primary" data-open="${esc(f.video)}">${ico('play', 12)}播放</button>
          <button type="button" class="btn tiny" data-reveal="${esc(f.video)}">${ico('folderOpen', 12)}在访达中显示</button>
          ${f.srt ? `<button type="button" class="btn tiny ghost" data-srt="${esc(f.srt)}">SRT</button>` : ''}
        </div>
      </div>`;
    }).join('');
    const btn = el('vt-folder');
    if (btn) btn.disabled = !state.outDir;
  }

  /* ---------------- 开始 / 停止 ---------------- */
  async function run() {
    if (state.running) return;
    const a = api();
    if (!a) return;
    if (!state.source || !state.voiceId || !state.targets.size) {
      syncRun();
      return;
    }
    state.results = [];
    state.outDir = null;
    state.jobs = {};
    state.lastPct = 0;
    renderResults();
    renderJobs();
    setRunning(true);
    setStage('准备本地组件', 1);
    el('vt-progress') && el('vt-progress').classList.remove('hidden');
    try {
      const res = await a.start({
        input: state.source.path,
        voiceId: state.voiceId,
        targets: Array.from(state.targets),
        sourceLang: el('vt-srclang') ? el('vt-srclang').value : 'auto',
        translateModel: el('vt-tmodel') ? el('vt-tmodel').value : 'qwen-translate',
        keepBgm: el('vt-bgm') ? el('vt-bgm').checked : true,
        subtitles: el('vt-subs') ? el('vt-subs').checked : true,
        subtitleColor: state.color
      });
      state.outDir = (res && res.outputDir) || null;
      const files = (res && res.files) || [];
      files.forEach((f) => {
        if (!state.results.some((x) => x.video === f.video)) state.results.push(f);
      });
      renderResults();
      setStage(T('已完成 · {0} 条成片', files.length), 100);
      notify(T('完成：{0} 条成片已输出', files.length), 'ok');
    } catch (e) {
      const msg = cleanError(e);
      setStage(msg, state.lastPct);
      notify(msg, 'err');
    } finally {
      setRunning(false);
      renderResults();
    }
  }

  async function cancel() {
    const a = api();
    if (!a) return;
    try {
      await a.cancel();
      notify('已停止，正在回收本地进程', 'info');
    } catch (e) {
      notify(cleanError(e), 'err');
    }
  }

  /* ---------------- 交互绑定 ---------------- */
  function bind() {
    if (state.bound) return;
    state.bound = true;

    el('vt-colors') && el('vt-colors').addEventListener('click', (e) => {
      const b = e.target.closest('.lc-swatch');
      if (!b) return;
      state.color = b.dataset.color;
      Array.from(el('vt-colors').children).forEach((n) => n.classList.toggle('sel', n === b));
    });

    el('vt-langs') && el('vt-langs').addEventListener('click', (e) => {
      const b = e.target.closest('.vt-lang');
      if (!b || state.running) return;
      const id = b.dataset.id;
      if (state.targets.has(id)) {
        if (state.targets.size === 1) {
          notify('至少保留一种目标语言', 'info');
          return;
        }
        state.targets.delete(id);
      } else {
        state.targets.add(id);
      }
      renderLangs();
      renderJobs();
      syncRun();
      // 换语言后清掉试听缓存状态，试听语言跟着目标语言走
      state.previewId = null;
      renderVoices();
    });

    el('vt-drop') && el('vt-drop').addEventListener('click', pickVideo);
    el('vt-clear') && el('vt-clear').addEventListener('click', () => setSource(null));

    el('vt-voices') && el('vt-voices').addEventListener('click', (e) => {
      const play = e.target.closest('[data-play]');
      if (play) {
        e.stopPropagation();
        if (!state.running) previewVoice(play.dataset.play);
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        if (!state.running) removeVoice(del.dataset.del);
        return;
      }
      const card = e.target.closest('.vt-voice');
      if (card && !state.running) {
        state.voiceId = card.dataset.id;
        renderVoices();
        syncRun();
      }
    });

    el('vt-results') && el('vt-results').addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      const reveal = e.target.closest('[data-reveal]');
      const srt = e.target.closest('[data-srt]');
      if (open && api()) api().open(open.dataset.open);
      if (reveal && api()) api().reveal(reveal.dataset.reveal);
      if (srt && api()) api().reveal(srt.dataset.srt);
    });

    el('vt-run') && (el('vt-run').onclick = run);
    el('vt-cancel') && (el('vt-cancel').onclick = cancel);
    el('vt-folder') && (el('vt-folder').onclick = () => { if (state.outDir && api()) api().reveal(state.outDir); });
    const a0 = api();
    if (a0 && typeof a0.onProgress === 'function') a0.onProgress(onProgress);
    ['vt-srclang', 'vt-tmodel'].forEach((id) => {
      const n = el(id);
      if (n) n.addEventListener('change', () => { state.tmodel = el('vt-tmodel') ? el('vt-tmodel').value : state.tmodel; syncRun(); });
    });
    ['vt-bgm', 'vt-subs'].forEach((id) => {
      const n = el(id);
      if (n) n.addEventListener('change', syncRun);
    });

    /* 拖拽：拖到「上传声音」卡片上 → 当声音样本；拖到别处 → 当原片 */
    const section = el('view-translate');
    if (section) {
      section.addEventListener('dragover', (e) => {
        if (state.running) return;
        e.preventDefault();
        const overAdd = e.target.closest && e.target.closest('#vt-add');
        el('vt-drop') && el('vt-drop').classList.toggle('hot', !overAdd);
        const add = el('vt-add');
        if (add) add.classList.toggle('hot', !!overAdd);
      });
      section.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && section.contains(e.relatedTarget)) return;
        el('vt-drop') && el('vt-drop').classList.remove('hot');
        el('vt-add') && el('vt-add').classList.remove('hot');
      });
      section.addEventListener('drop', async (e) => {
        if (state.running) return;
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        e.preventDefault();
        el('vt-drop') && el('vt-drop').classList.remove('hot');
        el('vt-add') && el('vt-add').classList.remove('hot');
        const path = window.tokpure && window.tokpure.pathForFile
          ? window.tokpure.pathForFile(file)
          : '';
        const ext = String(file.name || '').split('.').pop().toLowerCase();
        if (!path) { notify('无法读取拖入文件的路径，请用「选择」按钮', 'err'); return; }
        const overAdd = e.target.closest && e.target.closest('#vt-add');
        if (overAdd || AUDIO_EXT.includes(ext)) {
          importSample(path, file.name);
          return;
        }
        if (VIDEO_EXT.includes(ext)) {
          usePathAsVideo(path, file.name);
          return;
        }
        notify('这个格式不支持：原片用 MP4/MOV/WEBM/MKV，声音用 WAV/MP3/M4A/AAC/FLAC/OGG', 'err');
      });
    }
  }

  async function init() {
    if (!el('view-translate')) return;
    bind();
    renderLangs();
    renderResults();
    renderJobs();
    syncRun();
    await loadStatus();
    await loadLibrary();
  }

  window.VideoTranslate = { init, refresh: loadLibrary };
})();
