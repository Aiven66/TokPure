/* ============================================================
   TokPure — AI多语口播（渲染层）
   上传口播短视频 → 选择目标语言 → 原声克隆配音 → 口型同步 → 出片。
   与「AI多语切片」共用后端识别/翻译/克隆能力，但成片保持原构图，
   并且嘴型必须跟目标语言配音对齐。
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
    tts: '配音中',
    lip: '口型同步',
    render: '出片中',
    done: '完成',
    error: '失败'
  };

  const LIP_LABEL = {
    synced: '口型已对齐',
    fallback: '配音版（未检测到人脸）',
    same: '原声 · 原口型'
  };

  const el = (id) => document.getElementById(id);
  const api = () => (window.tokpure && window.tokpure.oral) || null;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const state = {
    bound: false,
    source: null,
    // 口播默认只产出一条：多语种会成倍增加口型耗时，先跑通一个再全选更稳妥
    targets: new Set(['en']),
    color: '#FFFFFF',
    tmodel: 'qwen-translate',
    status: null,
    running: false,
    lastPct: 0,
    jobs: {},
    results: [],
    outDir: null,
    ticker: null
  };

  function fmtBytes(n) {
    if (typeof window.fmtBytes === 'function') return window.fmtBytes(n);
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function notify(msg, kind) {
    if (typeof window.toast === 'function') window.toast(msg, kind || 'ok');
  }

  function cleanError(e) {
    return String((e && e.message) || e || '操作失败')
      .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
      .trim();
  }

  /* ---------------- 目标语言 ---------------- */
  function renderLangs() {
    const host = el('oc-langs');
    if (!host) return;
    host.innerHTML = LANGS.map((l) => `
      <button type="button" class="lc-lang${state.targets.has(l.id) ? ' on' : ''}" data-id="${l.id}">
        <span class="lc-lang-native">${l.name}</span>
        <span class="lc-lang-sub">${l.sub}</span>
      </button>`).join('');
  }

  /* 本机实测：克隆配音约 7 倍实时，口型约 5 倍实时，加出片约 1 分钟。
     按「1 分钟片长」给个量级，避免用户选了 6 个语种才发现要等一晚上。 */
  function renderEstimate() {
    const host = el('oc-est');
    if (!host) return;
    const n = Math.max(1, state.targets.size);
    const lip = el('oc-lip') && el('oc-lip').checked;
    const per = lip ? 13 : 8;
    host.textContent = `按 1 分钟片长估算：每个语种约 ${per} 分钟（克隆配音 ${lip ? '约 7 分钟 + 口型约 5 分钟' : '约 7 分钟'} + 出片），`
      + `当前 ${n} 个语种约 ${per * n} 分钟；片长按比例变化。`;
  }

  function syncTargets() {
    const picked = LANGS.filter((l) => state.targets.has(l.id)).length;
    const btn = el('oc-all');
    if (btn) btn.textContent = picked === LANGS.length ? '已全选' : '全选 8 种';
    renderLangs();
    renderEstimate();
    if (!state.running) {
      state.jobs = {};
      renderJobs();
    }
    syncRun();
  }

  /* ---------------- 源文件 ---------------- */
  function setSource(src) {
    state.source = src;
    const bar = el('oc-filebar');
    if (bar) bar.style.display = src ? 'flex' : 'none';
    if (src) {
      const name = el('oc-file-name');
      const meta = el('oc-file-meta');
      if (name) name.textContent = src.name;
      if (meta) meta.textContent = fmtBytes(src.size);
    }
    syncRun();
  }

  function syncRun() {
    const btn = el('oc-run');
    if (btn) btn.disabled = state.running || !state.source || state.targets.size === 0;
  }

  function setRunning(on) {
    state.running = on;
    if (state.ticker) { clearInterval(state.ticker); state.ticker = null; }
    if (on) state.ticker = setInterval(() => renderJobs(), 1000);
    const run = el('oc-run');
    const stop = el('oc-cancel');
    if (run) run.classList.toggle('hidden', on);
    if (stop) stop.classList.toggle('hidden', !on);
    const prog = el('oc-progress');
    if (prog) prog.classList.toggle('hidden', !on && !state.results.length);
    el('oc-pick') && (el('oc-pick').disabled = on);
    el('oc-tmodel') && (el('oc-tmodel').disabled = on);
    el('oc-bgm') && (el('oc-bgm').disabled = on);
    el('oc-lip') && (el('oc-lip').disabled = on);
    el('oc-srclang') && (el('oc-srclang').disabled = on);
    renderEstimate();
    syncRun();
  }

  /* ---------------- 引擎状态 ---------------- */
  function pill(ok, text) {
    return `<span class="pill square ${ok ? 'emerald' : ''}">${text}</span>`;
  }

  const ENGINE_ROWS = ['声音克隆', '口型依赖', '口型模型', '推理脚本'];

  /* 依赖探测要起一次 python（导入 torch 约需数秒），先占位避免面板空白 */
  function renderStatusPending(detail) {
    const host = el('oc-engine');
    if (!host) return;
    host.innerHTML = ENGINE_ROWS.map((label) => `
      <div class="lc-engine-row">
        <span class="lc-engine-name">${label}</span>
        <span class="pill square">检测中…</span>
        <span class="lc-engine-detail muted">${detail || '正在读取本地引擎'}</span>
      </div>`).join('');
  }

  function renderStatus(s) {
    const host = el('oc-engine');
    if (!host || !s) return;
    state.status = s;
    const row = (label, ok, detail, pending) => `
      <div class="lc-engine-row">
        <span class="lc-engine-name">${label}</span>
        ${pill(ok, pending ? '检测中…' : ok ? '已就绪' : '按需准备')}
        <span class="lc-engine-detail muted">${detail}</span>
      </div>`;
    const depsPending = s.deps == null;
    host.innerHTML = [
      row('声音克隆', !!(s.engine && s.python), s.engine ? 'Chatterbox · 本地离线' : '需在「桌面引擎」安装「本地声音克隆」'),
      row('口型依赖', !!s.deps, depsPending ? '正在探测 OpenCV 依赖' : 'OpenCV 人脸检测 · 复用克隆引擎', depsPending),
      row('口型模型', !!s.weights, s.weights ? 'Wav2Lip GAN · 96×96' : '首次约 416MB，仅一次'),
      row('嘴部细节增强', !!s.sr, s.sr ? 'Real-ESRGAN x4 · 唇线/牙缝超分' : '首次约 64MB，仅一次'),
      row('推理脚本', !!s.script, s.script ? '本地 worker.py' : '客户端文件缺失，请重新安装')
    ].join('');
  }

  /* 先同步渲染快照（毫秒级），再补一次深度探测把 OpenCV 依赖结果填上 */
  async function loadStatus() {
    const a = api();
    if (!a) return;
    try {
      const fast = await a.status();
      renderStatus(fast);
      if (fast && fast.deps == null) {
        const deep = await (a.statusDeep ? a.statusDeep() : a.status());
        renderStatus(deep);
      }
    } catch (_) {
      renderStatusPending('引擎状态读取失败，可点「管理引擎」检查');
    }
  }

  /* ---------------- 产出队列 ---------------- */
  const mmss = (sec) => {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function renderJobs() {
    const host = el('oc-jobs');
    if (!host) return;
    const picked = LANGS.filter((l) => state.targets.has(l.id));
    if (!picked.length) {
      host.innerHTML = '<div class="lc-empty muted">先选择至少一种目标语言。</div>';
      return;
    }
    const now = Date.now();
    host.innerHTML = picked.map((l) => {
      const job = state.jobs[l.id] || { label: '等待中', pct: 0, done: false, err: false };
      const pct = Math.max(0, Math.min(100, Math.round(job.pct)));
      const elapsed = job.since ? (now - job.since) / 1000 : 0;
      const eta = [];
      if (elapsed > 3) {
        eta.push(`已用 ${mmss(elapsed)}`);
        if (!job.done && !job.err && pct > 2) {
          const remain = elapsed * (100 - pct) / pct;
          if (remain >= 90) eta.push(`剩约 ${Math.round(remain / 60)} 分`);
          else if (remain >= 20) eta.push(`剩约 ${Math.max(10, Math.round(remain / 10) * 10)} 秒`);
        }
      }
      const nowText = job.detail ? `${job.label} · ${esc(job.detail)}` : job.label;
      const running = !job.done && !job.err && pct > 0 && pct < 100;
      return `<div class="lc-job${job.done ? ' ok' : ''}${job.err ? ' err' : ''}" data-lang="${l.id}">
        <div class="lc-job-top">
          <span class="lc-job-name">${l.name}</span>
          <span class="lc-job-sub">${l.sub}</span>
          <span class="lc-job-pct">${pct}%</span>
        </div>
        <div class="lc-job-bar"><i${running ? ' class="running"' : ''} style="width:${pct}%"></i></div>
        <div class="lc-job-state">
          <span class="lc-job-now${job.err ? ' err' : job.done ? ' ok' : ''}">${nowText}</span>
          ${eta.length ? `<span class="lc-job-eta">${eta.join(' · ')}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  /* ---------------- 结果 ---------------- */
  function renderResults() {
    const host = el('oc-results');
    const count = el('oc-count');
    const folder = el('oc-open-folder');
    if (count) count.textContent = String(state.results.length);
    if (folder) folder.disabled = !state.outDir;
    if (!host) return;
    if (!state.results.length) {
      host.innerHTML = '<div class="lc-empty muted">还没有产出。上传一条口播短视频，选择目标语言后点击「开始多语口播」。</div>';
      return;
    }
    host.innerHTML = state.results.map((f, i) => `
      <div class="lc-result" data-i="${i}">
        <div class="lc-result-lang">${f.name}</div>
        <div class="lc-result-body">
          <div class="lc-result-name">${esc(f.video.split('/').pop())}</div>
          <div class="lc-result-sub muted">${LIP_LABEL[f.lip] || '口型已对齐'} · 烧录字幕${f.voice ? ' · ' + esc(f.voice) : ''}${f.warning ? ' · ' + esc(f.warning) : ''}</div>
        </div>
        <div class="lc-result-acts">
          <button class="btn tiny" data-act="play"><span data-ic="play" data-size="13"></span>打开视频</button>
          <button class="btn tiny ghost" data-act="srt"><span data-ic="captions" data-size="13"></span>查看字幕</button>
          <button class="btn tiny ghost" data-act="reveal"><span data-ic="folderOpen" data-size="13"></span>显示</button>
        </div>
      </div>`).join('');
    if (typeof window.hydrateIcons === 'function') window.hydrateIcons(host);
  }

  /* ---------------- 进度 ---------------- */
  function onProgress(p) {
    if (!p) return;
    const pct = Math.max(state.lastPct || 0, Math.max(0, Math.min(100, Number(p.percent) || 0)));
    state.lastPct = pct;
    const bar = el('oc-bar');
    const pctText = el('oc-pct');
    const stage = el('oc-stage');
    if (bar) {
      bar.style.width = pct + '%';
      bar.classList.toggle('meter-pulse', pct > 0 && pct < 100);
    }
    if (pctText) pctText.textContent = Math.round(pct) + '%';
    if (stage && p.stage) stage.textContent = p.stage;
    if (!p.lang) return;

    const total = Number(p.langTotal) || 1;
    const idx = Number(p.langIndex) || 0;
    const old = state.jobs[p.lang] || {};
    const wasWaiting = !old.since;
    const local = p.langStage === 'done' || p.langStage === 'error'
      ? 100
      : (p.langPercent != null
        ? Math.max(0, Math.min(99, Number(p.langPercent) || 0))
        : Math.max(0, Math.min(99, ((pct - (44 + (53 / total) * idx)) / (53 / total)) * 100)));
    state.jobs[p.lang] = {
      label: STAGE_LABEL[p.langStage] || p.stage || '处理中',
      detail: p.detail || '',
      pct: local,
      done: p.langStage === 'done',
      err: p.langStage === 'error' || /失败/.test(String(p.stage || p.langStage || '')),
      since: wasWaiting ? Date.now() : old.since
    };
    renderJobs();
    if (p.file && p.file.video) {
      state.results = state.results.filter((f) => f.lang !== p.file.lang).concat([p.file]);
      state.outDir = String(p.file.video).replace(/[\\/][^\\/]+$/, '');
      renderResults();
    }
  }

  /* ---------------- 主交互 ---------------- */
  async function pick() {
    const a = api();
    if (!a) return;
    try {
      const f = await a.pickFile();
      if (!f) return;
      setSource({ kind: 'file', path: f.path, name: f.name, size: f.size });
    } catch (e) {
      notify(cleanError(e), 'err');
    }
  }

  async function start() {
    const a = api();
    if (!a || state.running || !state.source) return;
    const targets = LANGS.filter((l) => state.targets.has(l.id)).map((l) => l.id);
    if (!targets.length) {
      notify('请至少选择一种目标语言', 'err');
      return;
    }
    if (targets.length > 2) {
      const ok = window.confirm(
        `口型同步是逐帧重绘，每个语种都要单独跑一遍。\n\n当前选了 ${targets.length} 个语种，`
        + `按 1 分钟片长每个约 13 分钟，预计共约 ${13 * targets.length} 分钟。\n\n`
        + '建议先跑 1 个语种确认口型和音色，满意后再批量。仍要继续吗？'
      );
      if (!ok) return;
    }
    state.jobs = {};
    LANGS.filter((l) => state.targets.has(l.id)).forEach((l) => {
      state.jobs[l.id] = { label: '等待中', pct: 0 };
    });
    renderJobs();
    setRunning(true);
    state.lastPct = 0;
    const stage = el('oc-stage');
    if (stage) stage.textContent = '准备中…';
    const bar = el('oc-bar');
    if (bar) {
      bar.style.width = '0%';
      bar.classList.remove('meter-pulse');
    }
    const pctText = el('oc-pct');
    if (pctText) pctText.textContent = '0%';

    const payload = {
      input: state.source.path,
      sourceLang: (el('oc-srclang') && el('oc-srclang').value) || 'auto',
      targets,
      subtitleColor: state.color,
      translateModel: state.tmodel,
      keepBgm: !!(el('oc-bgm') && el('oc-bgm').checked),
      lipSync: !!(el('oc-lip') && el('oc-lip').checked)
    };

    try {
      const res = await a.start(payload);
      state.results = (res && res.files) || [];
      state.outDir = (res && res.outputDir) || null;
      renderResults();
      const n = state.results.length;
      const fallback = state.results.filter((f) => f.lip === 'fallback').length;
      const failed = Object.keys(state.jobs).filter((k) => state.jobs[k] && state.jobs[k].err).length;
      if (fallback) notify(`已产出 ${n} 条口播，其中 ${fallback} 条因未识别到人脸降级为配音版`, 'warn');
      else if (!n && failed) notify(`口播未产出：${failed} 个语种失败，请查看产出队列中的提示`, 'err');
      else notify(`口播完成：已产出 ${n} 条口型对齐的多语视频`);
      loadStatus();
    } catch (e) {
      const msg = cleanError(e);
      const canceled = /已取消|已停止/.test(msg);
      if (!canceled) notify(msg, 'err');
      Object.keys(state.jobs).forEach((k) => {
        const job = state.jobs[k];
        if (!job || job.done) return;
        job.err = true;
        job.label = canceled ? '已停止' : '失败';
        job.detail = canceled ? '' : cleanError(msg).replace(/\s+/g, ' ').slice(0, 50);
      });
      renderJobs();
    } finally {
      setRunning(false);
    }
  }

  async function cancel() {
    const a = api();
    if (!a) return;
    try {
      await a.cancel();
      notify('已停止口播任务');
    } catch (_) {}
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    if (state.bound) return;
    state.bound = true;

    el('oc-pick') && el('oc-pick').addEventListener('click', pick);
    el('oc-clear') && el('oc-clear').addEventListener('click', () => setSource(null));
    el('oc-run') && el('oc-run').addEventListener('click', start);
    el('oc-cancel') && el('oc-cancel').addEventListener('click', cancel);
    el('oc-goto-engine') && el('oc-goto-engine').addEventListener('click', () => {
      const item = document.querySelector('#nav .nav-item[data-view="engine"]');
      if (item) item.click();
    });
    el('oc-all') && el('oc-all').addEventListener('click', () => {
      state.targets = new Set(LANGS.map((l) => l.id));
      syncTargets();
    });
    el('oc-none') && el('oc-none').addEventListener('click', () => {
      state.targets.clear();
      syncTargets();
    });
    el('oc-lip') && el('oc-lip').addEventListener('change', renderEstimate);

    const langHost = el('oc-langs');
    langHost && langHost.addEventListener('click', (e) => {
      const btn = e.target.closest('.lc-lang');
      if (!btn || state.running) return;
      const id = btn.dataset.id;
      if (state.targets.has(id)) state.targets.delete(id);
      else state.targets.add(id);
      syncTargets();
    });

    const tmodel = el('oc-tmodel');
    if (tmodel) {
      try {
        if (localStorage.getItem('tokpure.oralcast.tmodel') === 'qwen-translate-lite') {
          state.tmodel = 'qwen-translate-lite';
          tmodel.value = 'qwen-translate-lite';
        }
      } catch (_) {}
      tmodel.addEventListener('change', () => {
        state.tmodel = tmodel.value === 'qwen-translate' ? 'qwen-translate' : 'qwen-translate-lite';
        try { localStorage.setItem('tokpure.oralcast.tmodel', state.tmodel); } catch (_) {}
      });
    }

    const colors = el('oc-colors');
    colors && colors.addEventListener('click', (e) => {
      const btn = e.target.closest('.lc-swatch');
      if (!btn) return;
      state.color = btn.dataset.color;
      colors.querySelectorAll('.lc-swatch').forEach((s) => s.classList.toggle('sel', s === btn));
    });

    const folder = el('oc-open-folder');
    folder && folder.addEventListener('click', () => {
      if (state.outDir) api().reveal(state.outDir);
    });

    const results = el('oc-results');
    results && results.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.lc-result');
      const file = state.results[Number(row && row.dataset.i)];
      if (!file) return;
      if (btn.dataset.act === 'play') api().open(file.video);
      if (btn.dataset.act === 'srt') api().reveal(file.srt);
      if (btn.dataset.act === 'reveal') api().reveal(file.video);
    });

    /* 拖拽导入：口播片段通常就在桌面上，拖进来最快 */
    const view = el('view-oralcast');
    if (view) {
      view.addEventListener('dragover', (e) => {
        if (state.running) return;
        e.preventDefault();
        view.classList.add('lc-drag');
      });
      view.addEventListener('dragleave', (e) => {
        if (e.target === view) view.classList.remove('lc-drag');
      });
      view.addEventListener('drop', async (e) => {
        if (state.running) return;
        e.preventDefault();
        view.classList.remove('lc-drag');
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        const a = api();
        const p = window.tokpure && window.tokpure.fs && window.tokpure.fs.pathForFile
          ? window.tokpure.fs.pathForFile(file)
          : '';
        if (!p) {
          notify('无法读取文件路径，请点「选择口播短视频」', 'err');
          return;
        }
        try {
          const f = await a.openPath(p);
          setSource({ kind: 'file', path: f.path, name: f.name, size: f.size });
        } catch (err) {
          notify(cleanError(err), 'err');
        }
      });
    }

    const a = api();
    if (a) a.onProgress(onProgress);
  }

  function init() {
    bind();
    renderLangs();
    renderJobs();
    renderResults();
    renderEstimate();
    renderStatusPending();
    loadStatus();
    syncTargets();
  }

  window.OralCast = { init };
})();
