/* ============================================================
   TokPure — AI多语切片 长片多语译制（渲染层）
   输入链接/本地长视频 → 选择目标语言 → 本地识别、翻译、配音、
   竖版渲染，一次产出多条带烧录字幕的短视频。
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
    render: '渲染中',
    done: '完成'
  };

  const VOICE_HINT = {
    clone: '本地零样本克隆：直接从原片取 10~60 秒人声，各语言译文都由同一位说话人的嗓音朗读，完全离线。克隆是逐句生成的，本机大约产出 1 分钟配音要 7 分钟（已多核并行）。',
    match: '本地近似：分析原片音高与性别，挑同性别系统音色并变调塑形。听感接近，但不是克隆；速度最快，3 分钟片源约 10 秒/语种。赶时间建议用这个。',
    preset: '直接使用系统里的自然音色（macOS 26 的 Flo / Eddy 等），可逐语言试听后挑选；速度最快。'
  };

  const el = (id) => document.getElementById(id);
  const api = () => (window.tokpure && window.tokpure.loc) || null;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const state = {
    bound: false,
    source: null,
    targets: new Set(['zh', 'ja', 'ko', 'es', 'pt', 'fr']),
    color: '#FFFFFF',
    tmodel: 'qwen-translate',
    // 默认「原声克隆」：这是唯一能保住原片说话人音色的模式。
    // 「本地近似」只是挑一个同性别系统音色再变调，听感是另一个人在念稿，
    // 之前默认走它，用户听到的就是「叠了一条别人的声音」。
    voiceMode: 'clone',
    catalog: {},
    voiceSel: {},
    audio: null,
    status: null,
    running: false,
    // 总进度条的「已到过的最高百分比」：并行上报的支线（背景音乐分离等）
    // 不允许把条往回拽
    lastPct: 0,
    jobs: {},
    results: [],
    outDir: null
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
    const host = el('lc-langs');
    if (!host) return;
    host.innerHTML = LANGS.map((l) => `
      <button type="button" class="lc-lang${state.targets.has(l.id) ? ' on' : ''}" data-id="${l.id}">
        <span class="lc-lang-native">${l.name}</span>
        <span class="lc-lang-sub">${l.sub}</span>
      </button>`).join('');
  }

  /* ---------------- 音色 ---------------- */
  async function loadVoices() {
    const a = api();
    if (!a || !a.voices) return;
    try {
      state.catalog = (await a.voices()) || {};
    } catch (_) { /* 音色枚举失败时退回后端默认音色 */ }
    renderVoices();
  }

  /* 克隆是逐 token 生成：本机实测约 7 分钟才产出一分钟配音。
     提前把预计时长算给用户看，避免选了 6 种语言后才发现要等一个多小时。 */
  const CLONE_MIN_PER_MIN = 7;

  function clipMinutes() {
    const v = Number(el('lc-clip') && el('lc-clip').value);
    if (v > 0) return v / 60;
    // 选「完整长片」时前端拿不到时长，按 3 分钟保守估，宁可先吓一跳也别让人干等
    return 3;
  }

  function cloneEstimate() {
    const langs = Math.max(1, state.targets.size);
    const per = Math.max(1, Math.round(clipMinutes() * CLONE_MIN_PER_MIN));
    return { per, total: per * langs, langs };
  }

  function voiceHintText() {
    const base = VOICE_HINT[state.voiceMode] || '';
    if (state.voiceMode !== 'clone') return T(base);
    const est = cloneEstimate();
    return T('{0}按当前设置（{1} 种语言）预计每个语种约 {2} 分钟、全部约 {3} 分钟，最先完成的语种会立刻出现在结果里。',
      T(base), est.langs, est.per, est.total);
  }

  function renderVoices() {
    const host = el('lc-voices');
    if (!host) return;
    const hint = el('lc-vhint');
    if (hint) hint.textContent = voiceHintText();
    const cloneBox = el('lc-clone');
    if (cloneBox) cloneBox.classList.toggle('hidden', state.voiceMode !== 'clone');
    if (state.voiceMode === 'clone') {
      // 克隆模式下音色由服务商按原片确定，不再提供逐语言预置音色列表
      host.innerHTML = '';
      host.classList.add('hidden');
      return;
    }
    host.classList.remove('hidden');
    const picked = LANGS.filter((l) => state.targets.has(l.id));
    if (!picked.length) {
      host.innerHTML = '<div class="lc-empty muted">选择目标语言后可指定音色。</div>';
      return;
    }
    const autoLabel = state.voiceMode === 'match' ? '自动匹配（跟随原声）' : '推荐音色';
    const dis = state.running ? ' disabled' : '';
    host.innerHTML = picked.map((l) => {
      const entry = state.catalog[l.id] || { list: [] };
      const sel = state.voiceSel[l.id] || '';
      const opts = [`<option value=""${sel ? '' : ' selected'}>${autoLabel}</option>`]
        .concat((entry.list || [])
          .filter((v) => v.name)
          .map((v) => `<option value="${esc(v.name)}"${v.name === sel ? ' selected' : ''}>${esc(v.base)} · ${esc(typeof window.T === 'function' ? window.T(v.style) : v.style)}</option>`));
      return `<div class="lc-voice-row" data-lang="${l.id}">
        <span class="lc-voice-lang">${l.name}</span>
        <div class="field"><select class="lc-select lc-voice-sel" data-lang="${l.id}"${dis}>${opts.join('')}</select></div>
        <button class="btn tiny ghost lc-voice-play" data-lang="${l.id}"${dis}><span data-ic="play" data-size="12"></span>试听</button>
      </div>`;
    }).join('');
    if (typeof window.hydrateIcons === 'function') window.hydrateIcons(host);
  }

  async function preview(langId) {
    const a = api();
    if (!a || state.running) return;
    try {
      const res = await a.preview({ lang: langId, voice: state.voiceSel[langId] || '' });
      if (!res || !res.dataUrl) return;
      if (!state.audio) state.audio = new Audio();
      state.audio.pause();
      state.audio.src = res.dataUrl;
      await state.audio.play();
    } catch (e) {
      notify(T('试听失败：{0}', cleanError(e)), 'err');
    }
  }

  const mmss = (sec) => {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function renderJobs() {
    const host = el('lc-jobs');
    if (!host) return;
    const picked = LANGS.filter((l) => state.targets.has(l.id));
    if (!picked.length) {
      host.innerHTML = '<div class="lc-empty muted">先选择至少一种目标语言。</div>';
      return;
    }
    const now = Date.now();
    host.innerHTML = picked.map((l) => {
      const job = state.jobs[l.id] || { label: '等待中', pct: 0, done: false, err: false };
      // 百分比、进度条、文字必须来自同一个 pct，三者永远一起动
      const pct = Math.max(0, Math.min(100, Math.round(job.pct)));
      const elapsed = job.since ? (now - job.since) / 1000 : 0;
      // 每张卡片显示自己这一语种的已用时长与粗估剩余，长时间任务才不会看着像卡死
      const eta = [];
      if (elapsed > 3) {
        eta.push(T('已用 {0}', mmss(elapsed)));
        if (!job.done && !job.err && pct > 2) {
          const remain = elapsed * (100 - pct) / pct;
          if (remain >= 90) eta.push(T('剩约 {0} 分', Math.round(remain / 60)));
          else if (remain >= 20) eta.push(T('剩约 {0} 秒', Math.max(10, Math.round(remain / 10) * 10)));
        }
      }
      // 卡片宽度有限：把「当前阶段」和「时长」分两列，右侧时长永不换行、不被挤没
      const nowText = job.detail ? `${job.label} · ${esc(job.detail)}` : job.label;
      // 进行中的条带扫光：一句克隆要几十秒，宽度涨得慢也要看得出在动
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

  function syncTargets() {
    const picked = LANGS.filter((l) => state.targets.has(l.id)).length;
    const btn = el('lc-all');
    if (btn) btn.textContent = picked === LANGS.length ? '已全选' : '全选 8 种';
    renderLangs();
    renderVoices();
    if (!state.running) {
      state.jobs = {};
      renderJobs();
    }
    syncRun();
  }

  /* ---------------- 源文件 ---------------- */
  function setSource(src) {
    state.source = src;
    const bar = el('lc-filebar');
    if (bar) bar.style.display = src ? 'flex' : 'none';
    if (src) {
      const name = el('lc-file-name');
      const meta = el('lc-file-meta');
      if (name) name.textContent = src.name;
      if (meta) meta.textContent = src.kind === 'url' ? '在线视频链接' : fmtBytes(src.size);
    }
    syncRun();
  }

  function syncRun() {
    const btn = el('lc-run');
    if (btn) btn.disabled = state.running || !state.source || state.targets.size === 0;
  }

  function setRunning(on) {
    state.running = on;
    // 每秒刷新一次卡片上的「已用/剩余」，即使这一秒没有新事件也要动
    if (state.ticker) { clearInterval(state.ticker); state.ticker = null; }
    if (on) state.ticker = setInterval(() => renderJobs(), 1000);
    const run = el('lc-run');
    const stop = el('lc-cancel');
    if (run) run.classList.toggle('hidden', on);
    if (stop) stop.classList.toggle('hidden', !on);
    const prog = el('lc-progress');
    if (prog) prog.classList.toggle('hidden', !on && !state.results.length);
    el('lc-pick') && (el('lc-pick').disabled = on);
    el('lc-use-url') && (el('lc-use-url').disabled = on);
    el('lc-tmodel') && (el('lc-tmodel').disabled = on);
    // 背景音乐开关在开工时已经写进任务参数，跑的过程中再改不会生效，索性锁住
    el('lc-bgm') && (el('lc-bgm').disabled = on);
    renderVoices();
    syncRun();
  }

  /* ---------------- 引擎状态 ---------------- */
  function pill(ok, text) {
    return `<span class="pill square ${ok ? 'emerald' : ''}">${text}</span>`;
  }

  function renderStatus(s) {
    const host = el('lc-engine');
    if (!host || !s) return;
    state.status = s;
    const asrOk = s.whisper && s.whisper.engine && s.whisper.model;
    const lite = state.tmodel !== 'qwen-translate';
    const trOk = s.translate && s.translate.engine && (lite ? s.translate.lite : s.translate.full);
    const dlOk = s.downloader && s.downloader.installed;
    const row = (label, ok, detail) => `
      <div class="lc-engine-row">
        <span class="lc-engine-name">${label}</span>
        ${pill(ok, ok ? '已就绪' : '按需下载')}
        <span class="lc-engine-detail muted">${detail}</span>
      </div>`;
    host.innerHTML = [
      row('语音识别', asrOk, s.whisper && s.whisper.model ? `Whisper · ${s.whisper.model}` : 'Whisper.cpp · 首次约 148MB'),
      row('翻译模型', trOk, lite ? 'Qwen2.5 0.5B · 首次约 400MB · 质量有限' : 'Qwen2.5 1.5B · 首次约 1.1GB'),
      row('链接下载', dlOk, 'yt-dlp · 仅链接输入时需要')
    ].join('');
  }

  async function loadStatus() {
    const a = api();
    if (!a) return;
    try {
      renderStatus(await a.status());
    } catch (e) {
      /* 状态读取失败不阻塞页面 */
    }
  }

  /* ---------------- 结果 ---------------- */
  function renderResults() {
    const host = el('lc-results');
    const count = el('lc-count');
    const folder = el('lc-open-folder');
    if (count) count.textContent = String(state.results.length);
    if (folder) folder.disabled = !state.outDir;
    if (!host) return;
    if (!state.results.length) {
      host.innerHTML = '<div class="lc-empty muted">还没有产出。导入一条长视频，选择目标语言后点击「开始本地化」。</div>';
      return;
    }
    host.innerHTML = state.results.map((f, i) => `
      <div class="lc-result" data-i="${i}">
        <div class="lc-result-lang">${f.name}</div>
        <div class="lc-result-body">
          <div class="lc-result-name">${f.video.split('/').pop()}</div>
          <div class="lc-result-sub muted">1080×1920 竖版 · 烧录字幕${f.voice ? ' · 音色 ' + esc(f.voice) : ''}${f.warning ? ' · ' + esc(f.warning) : ''}</div>
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
    // 百分比只增不减：背景音乐分离/模型下载会与各语种进度并行上报，
    // 若按上报值直接写会把总进度条往回拽（数字在走、条却回退）。
    const pct = Math.max(state.lastPct || 0, Math.max(0, Math.min(100, Number(p.percent) || 0)));
    state.lastPct = pct;
    const bar = el('lc-bar');
    const pctText = el('lc-pct');
    const stage = el('lc-stage');
    if (bar) {
      bar.style.width = pct + '%';
      // 未完成时给总进度条也加扫光：长时间任务里百分比是跳变的，扫光负责证明「还在跑」
      bar.classList.toggle('meter-pulse', pct > 0 && pct < 100);
    }
    if (pctText) pctText.textContent = Math.round(pct) + '%';
    if (stage && p.stage) stage.textContent = p.stage;
    if (!p.lang) return;

    const total = Number(p.langTotal) || 1;
    const idx = Number(p.langIndex) || 0;
    const old = state.jobs[p.lang] || {};
    const wasWaiting = !old.since;
    // 后端直接给出这一语种自己的进度（渲染与配音重叠时不会互相串台）
    const local = p.langStage === 'done'
      ? 100
      : (p.langPercent != null
        ? Math.max(0, Math.min(99, Number(p.langPercent) || 0))
        : Math.max(0, Math.min(99, ((pct - (50 + (46 / total) * idx)) / (46 / total)) * 100)));
    state.jobs[p.lang] = {
      label: STAGE_LABEL[p.langStage] || p.stage || '处理中',
      detail: p.detail || '',
      pct: local,
      done: p.langStage === 'done',
      err: /失败/.test(String(p.stage || p.langStage || '')),
      since: wasWaiting ? Date.now() : old.since
    };
    renderJobs();
    // 某个语种先出片就立刻进结果列表，不用等其余语种
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
      const url = el('lc-url');
      if (url) url.value = '';
    } catch (e) {
      notify(cleanError(e), 'err');
    }
  }

  function useUrl() {
    const input = el('lc-url');
    const url = (input && input.value || '').trim();
    if (!/^https?:\/\/.+/i.test(url)) {
      notify('请输入有效的视频链接（http/https）', 'err');
      return;
    }
    let name = url;
    try { name = new URL(url).hostname + ' 链接视频'; } catch (_) {}
    setSource({ kind: 'url', url, name, size: 0 });
  }

  async function start() {
    const a = api();
    if (!a || state.running || !state.source) return;
    const targets = LANGS.filter((l) => state.targets.has(l.id)).map((l) => l.id);
    if (!targets.length) {
      notify('请至少选择一种目标语言', 'err');
      return;
    }
    // 云端克隆必须先有 Key；本地引擎不需要
    if (state.voiceMode === 'clone') {
      const provSel = el('lc-clone-provider');
      const provider = provSel && provSel.value ? provSel.value : 'local';
      if (provider !== 'local') {
        const keyInput = el('lc-clone-key');
        if (!keyInput || !keyInput.value.trim()) {
          notify('「原声克隆」需要先填写克隆服务的 API Key（可点「测试连接」验证）', 'err');
          if (keyInput) keyInput.focus();
          return;
        }
      }
      // 估算超过 10 分钟就先说清楚代价（音色优先：不建议为了快而换成系统音色）
      const est = cloneEstimate();
      if (est.total > 10) {
        const ok = window.confirm([
          T('原声克隆是逐句生成的，预计每个语种约 {0} 分钟，{1} 个语种共约 {2} 分钟。', est.per, est.langs, est.total),
          T('这个模式会用原片说话人的真实嗓音朗读译文，是唯一能保住原声音色的方式；「本地近似」虽然快，但用的是系统音色，听起来会是另一个人。'),
          T('仍要开始原声克隆吗？')
        ].join('\n\n'));
        if (!ok) return;
      }
    }
    state.jobs = {};
    LANGS.filter((l) => state.targets.has(l.id)).forEach((l) => {
      state.jobs[l.id] = { label: '等待中', pct: 0 };
    });
    renderJobs();
    setRunning(true);
    // 新一轮任务从 0 开始累计（否则沿用上一轮的最高值，条会直接停在 96%）
    state.lastPct = 0;
    const stage = el('lc-stage');
    if (stage) stage.textContent = '准备中…';
    const bar = el('lc-bar');
    if (bar) {
      bar.style.width = '0%';
      bar.classList.remove('meter-pulse');
    }
    const pctText = el('lc-pct');
    if (pctText) pctText.textContent = '0%';

    const payload = {
      input: state.source.kind === 'file' ? state.source.path : null,
      url: state.source.kind === 'url' ? state.source.url : null,
      sourceLang: (el('lc-srclang') && el('lc-srclang').value) || 'auto',
      targets,
      clipSeconds: Number(el('lc-clip') && el('lc-clip').value) || 0,
      subtitleColor: state.color,
      translateModel: state.tmodel,
      voiceMode: state.voiceMode,
      keepBgm: !!(el('lc-bgm') && el('lc-bgm').checked),
      voiceMap: targets.reduce((acc, id) => {
        if (state.voiceSel[id]) acc[id] = state.voiceSel[id];
        return acc;
      }, {})
    };

    try {
      const res = await a.start(payload);
      state.results = (res && res.files) || [];
      state.outDir = (res && res.outputDir) || null;
      renderResults();
      notify(`译制完成：已产出 ${state.results.length} 条竖版视频`);
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
        // 把真实原因留在卡片上，避免只看到「失败」却不知道卡在哪
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
      notify('已停止译制');
    } catch (_) {}
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    if (state.bound) return;
    state.bound = true;

    el('lc-pick') && el('lc-pick').addEventListener('click', pick);
    el('lc-use-url') && el('lc-use-url').addEventListener('click', useUrl);
    el('lc-url') && el('lc-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') useUrl();
    });
    el('lc-clear') && el('lc-clear').addEventListener('click', () => {
      setSource(null);
      const url = el('lc-url');
      if (url) url.value = '';
    });
    const tmodel = el('lc-tmodel');
    if (tmodel) {
      try {
        if (localStorage.getItem('tokpure.lingocast.tmodel') === 'qwen-translate-lite') {
          state.tmodel = 'qwen-translate-lite';
          tmodel.value = 'qwen-translate-lite';
        }
      } catch (_) {}
      tmodel.addEventListener('change', () => {
        state.tmodel = tmodel.value === 'qwen-translate' ? 'qwen-translate' : 'qwen-translate-lite';
        try { localStorage.setItem('tokpure.lingocast.tmodel', state.tmodel); } catch (_) {}
        renderStatus(state.status);
      });
    }
    el('lc-run') && el('lc-run').addEventListener('click', start);
    el('lc-cancel') && el('lc-cancel').addEventListener('click', cancel);
    // 片段长度直接决定克隆/配音的工作量，改了就刷新预计时长
    el('lc-clip') && el('lc-clip').addEventListener('change', () => renderVoices());
    el('lc-goto-engine') && el('lc-goto-engine').addEventListener('click', () => {
      const item = document.querySelector('#nav .nav-item[data-view="engine"]');
      if (item) item.click();
    });
    el('lc-all') && el('lc-all').addEventListener('click', () => {
      state.targets = new Set(LANGS.map((l) => l.id));
      syncTargets();
    });
    el('lc-none') && el('lc-none').addEventListener('click', () => {
      state.targets.clear();
      syncTargets();
    });

    const langHost = el('lc-langs');
    langHost && langHost.addEventListener('click', (e) => {
      const btn = e.target.closest('.lc-lang');
      if (!btn || state.running) return;
      const id = btn.dataset.id;
      if (state.targets.has(id)) state.targets.delete(id);
      else state.targets.add(id);
      syncTargets();
    });

    /* 音色：模式切换 / 逐语言选择 / 试听 */
    const vmode = el('lc-vmode');
    vmode && vmode.addEventListener('click', (e) => {
      const btn = e.target.closest('.lc-seg-btn');
      if (!btn || state.running) return;
      const m = btn.dataset.mode;
      state.voiceMode = m === 'clone' ? 'clone' : m === 'preset' ? 'preset' : 'match';
      vmode.querySelectorAll('.lc-seg-btn').forEach((b) => b.classList.toggle('on', b === btn));
      try { localStorage.setItem('tokpure.multiclips.vmode', state.voiceMode); } catch (_) {}
      renderVoices();
    });

    const voices = el('lc-voices');
    voices && voices.addEventListener('change', (e) => {
      const sel = e.target.closest('.lc-voice-sel');
      if (!sel) return;
      const langId = sel.dataset.lang;
      if (sel.value) state.voiceSel[langId] = sel.value;
      else delete state.voiceSel[langId];
      try { localStorage.setItem('tokpure.multiclips.voices', JSON.stringify(state.voiceSel)); } catch (_) {}
    });
    voices && voices.addEventListener('click', (e) => {
      const btn = e.target.closest('.lc-voice-play');
      if (!btn) return;
      preview(btn.dataset.lang);
    });

    /* 原声克隆：服务商 / API Key / 连接测试 */
    const cloneProv = el('lc-clone-provider');
    const cloneKey = el('lc-clone-key');
    const cloneKeyRow = el('lc-clone-keyrow');
    const cloneTest = el('lc-clone-test');
    const cloneStatus = el('lc-clone-status');
    const cloneDocs = el('lc-clone-docs');
    const cloneStatusText = (msg) => { if (cloneStatus) cloneStatus.textContent = msg; };

    const providerOf = (v) => (v === 'fishaudio' ? 'fishaudio' : v === 'elevenlabs' ? 'elevenlabs' : 'local');

    // 本地引擎不需要 Key，也不需要「获取 Key」入口
    function applyProviderUI(provider) {
      const local = provider === 'local';
      if (cloneKeyRow) cloneKeyRow.classList.toggle('hidden', local);
      if (cloneDocs) cloneDocs.classList.toggle('hidden', local);
      if (cloneTest) cloneTest.textContent = local ? '检测引擎' : '测试连接';
    }

    // 主进程只回结构化结果，文案按当前语言拼装
    function fmtEngineInfo(r) {
      if (!r) return '';
      if (r.code === 'local') {
        let s = T('离线可用') + ' · ' + T('{0} 语种', r.langCount);
        if (r.gb) s += ' · ' + T('占用 {0}', r.gb);
        return s;
      }
      if (r.code === 'quota') return T('已用 {0}/{1} 字符', r.used, r.limit);
      if (r.code === 'account') return T('账号 {0}', r.account);
      if (r.code === 'ok') return T('连接正常');
      return r.info || '';
    }

    async function probeLocalEngine() {
      cloneStatusText('正在检测本地引擎…');
      try {
        const r = await api().cloneTest({ provider: 'local' });
        cloneStatusText(T('本地引擎已就绪：{0}', fmtEngineInfo(r)));
      } catch (e) {
        cloneStatusText(T('本地引擎不可用：{0}', cleanError(e)));
      }
    }

    async function saveClone(patch) {
      if (!window.tokpure || !window.tokpure.settings) return;
      try { await window.tokpure.settings.save({ voiceClone: patch }); } catch (_) {}
    }

    async function loadClone() {
      if (!window.tokpure || !window.tokpure.settings) return;
      try {
        const s = await window.tokpure.settings.get();
        const cfg = (s && s.voiceClone) || {};
        const provider = providerOf(cfg.provider);
        const keys = cfg.keys || {};
        if (cloneProv) cloneProv.value = provider;
        if (cloneKey) cloneKey.value = keys[provider] || '';
        applyProviderUI(provider);
        if (provider === 'local') {
          cloneStatusText('本地引擎：完全离线，用原片人声直接合成各语译文，无需联网与 API Key。');
          probeLocalEngine();
        } else {
          cloneStatusText(keys[provider]
            ? '已配置。首次生成会用原片人声建立克隆音色，同一视频再次生成会复用。'
            : '尚未配置。填写 Key 后，会用原片人声建立该说话人的克隆音色，各语言译文都由它朗读。');
        }
      } catch (_) { /* 读取失败时保留默认提示 */ }
    }

    cloneProv && cloneProv.addEventListener('change', async () => {
      const provider = providerOf(cloneProv.value);
      try {
        const s = await window.tokpure.settings.get();
        const keys = (s.voiceClone && s.voiceClone.keys) || {};
        if (cloneKey) cloneKey.value = keys[provider] || '';
      } catch (_) { /* ignore */ }
      applyProviderUI(provider);
      await saveClone({ provider });
      if (provider === 'local') probeLocalEngine();
      else cloneStatusText('服务商已切换，请确认 Key 后点「测试连接」。');
    });

    cloneKey && cloneKey.addEventListener('change', async () => {
      const provider = providerOf(cloneProv ? cloneProv.value : 'local');
      const key = cloneKey.value.trim();
      await saveClone({ provider, keys: { [provider]: key } });
      cloneStatusText(key ? 'Key 已保存，可点「测试连接」验证。' : '尚未配置。');
    });

    cloneTest && cloneTest.addEventListener('click', async () => {
      const provider = providerOf(cloneProv ? cloneProv.value : 'local');
      if (provider === 'local') {
        probeLocalEngine();
        return;
      }
      const key = cloneKey ? cloneKey.value.trim() : '';
      if (!key) {
        cloneStatusText('请先填写 API Key');
        if (cloneKey) cloneKey.focus();
        return;
      }
      await saveClone({ provider, keys: { [provider]: key } });
      cloneStatusText('正在测试连接…');
      try {
        const r = await api().cloneTest({ provider, key });
        cloneStatusText(T('连接成功：{0}', fmtEngineInfo(r)));
      } catch (e) {
        cloneStatusText(T('连接失败：{0}', cleanError(e)));
      }
    });

    // 各服务商的 Key 申请页不同，按当前选中的服务商打开
    cloneDocs && cloneDocs.addEventListener('click', () => {
      const provider = providerOf(cloneProv ? cloneProv.value : 'local');
      const url = provider === 'fishaudio'
        ? 'https://fish.audio/zh-CN/developers/'
        : 'https://elevenlabs.io/app/settings/api-keys';
      if (window.tokpure && window.tokpure.auth) window.tokpure.auth.openWeb(url);
    });

    loadClone();

    const colors = el('lc-colors');
    colors && colors.addEventListener('click', (e) => {
      const btn = e.target.closest('.lc-swatch');
      if (!btn) return;
      state.color = btn.dataset.color;
      colors.querySelectorAll('.lc-swatch').forEach((s) => s.classList.toggle('sel', s === btn));
    });

    const folder = el('lc-open-folder');
    folder && folder.addEventListener('click', () => {
      if (state.outDir) api().reveal(state.outDir);
    });

    const results = el('lc-results');
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

    /* 拖拽导入 */
    const view = el('view-localize');
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
          notify('无法读取文件路径，请点「选择本地长视频」', 'err');
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
    try {
      const vm = localStorage.getItem('tokpure.multiclips.vmode');
      // 3.9.2：上一版把默认模式强制迁到了「本地近似」，用户听到的是系统音色，
      // 与「用原片嗓音朗读」的产品承诺不符。这里再迁一次回「原声克隆」；
      // 之后用户自己切换的模式会照常记住，不会再被覆盖。
      const migrated = localStorage.getItem('tokpure.multiclips.vmode.v392');
      if (!migrated) {
        state.voiceMode = 'clone';
        localStorage.setItem('tokpure.multiclips.vmode', 'clone');
        localStorage.setItem('tokpure.multiclips.vmode.v392', '1');
      } else if (vm === 'clone' || vm === 'preset' || vm === 'match') {
        state.voiceMode = vm;
      }
      const vs = JSON.parse(localStorage.getItem('tokpure.multiclips.voices') || '{}');
      if (vs && typeof vs === 'object' && !Array.isArray(vs)) state.voiceSel = vs;
    } catch (_) {}
    document.querySelectorAll('#lc-vmode .lc-seg-btn').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === state.voiceMode);
    });
    bind();
    renderLangs();
    renderJobs();
    loadStatus();
    loadVoices();
    syncTargets();
  }

  window.LingoCast = { init };
})();
