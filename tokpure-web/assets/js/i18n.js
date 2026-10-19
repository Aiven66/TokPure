/**
 * TokPure 站点多语言运行时
 *
 * 设计：源码以简体中文为基准，本脚本在运行时按词表做「文案覆盖」，
 * 因此无需给每个 DOM 节点加 data-i18n 标记，新增页面零改造即可支持多语言。
 *
 * 词表位于 assets/i18n/<code>.json，形如 { "中文原文": "译文" }。
 * 简体中文为源语言，不加载词表，直接还原原文。
 */
(function () {
  'use strict';

  var LANGS = [
    { code: 'en', native: 'English' },
    { code: 'zh-CN', native: '简体中文' },
    { code: 'zh-TW', native: '繁體中文' },
    { code: 'es', native: 'Español' },
    { code: 'pt', native: 'Português' },
    { code: 'fr', native: 'Français' },
    { code: 'de', native: 'Deutsch' },
    { code: 'ja', native: '日本語' }
  ];

  var SOURCE = 'zh-CN';
  var FALLBACK = 'en';
  var STORE_KEY = 'tokpure.lang';
  // 只有用户「主动点选语言」时才写入的标记。历史版本在自动判定浏览器语言时也把
  // 结果写进了 STORE_KEY，这类残留值会把中文浏览器永久锁死在简体中文（默认语言
  // 已改为英文后依然如此），因此必须靠这个标记区分「用户偏好」与「旧版残留」。
  var MANUAL_KEY = 'tokpure.lang.manual';
  var ATTRS = ['placeholder', 'title', 'alt', 'aria-label', 'content'];
  var CJK = /[\u4e00-\u9fff]/;

  var nodes = [];        // { node, prefix, core, suffix }
  var attrSlots = [];    // { el, attr, core }
  var dict = {};
  var current = null;

  function norm(v) {
    return String(v).replace(/\s+/g, ' ').trim();
  }

  function i18nBase() {
    var s = document.currentScript;
    if (!s || !s.src) {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && all[i].src.indexOf('i18n.js') !== -1) { s = all[i]; break; }
      }
    }
    var src = (s && s.src) || '';
    var idx = src.indexOf('/assets/');
    return (idx >= 0 ? src.slice(0, idx) + '/assets/' : 'assets/') + 'i18n/';
  }

  // 默认语言固定为英文：仅当用户「手动切换过」时才沿用其偏好，不再依据浏览器语言
  // 自动判定，避免中文浏览器首次访问直接落到简体中文。
  // 同时清理旧版残留：早期版本会把自动判定的结果写进 STORE_KEY，没有 MANUAL_KEY，
  // 若不清理，受影响的用户（含曾访问过的中文浏览器）会一直停在简体中文。
  function detect() {
    var saved = null;
    var manual = null;
    try {
      saved = window.localStorage.getItem(STORE_KEY);
      manual = window.localStorage.getItem(MANUAL_KEY);
    } catch (e) { saved = null; manual = null; }
    if (saved) {
      for (var i = 0; i < LANGS.length; i++) {
        if (LANGS[i].code !== saved) continue;
        if (manual === '1') return saved;
        break;
      }
      try {
        window.localStorage.removeItem(STORE_KEY);
        window.localStorage.removeItem(MANUAL_KEY);
      } catch (e) { /* ignore */ }
    }
    return FALLBACK;
  }

  function collectTextNodes() {
    var walker = document.createTreeWalker(
      document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (!node.nodeValue || !CJK.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          var p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          var tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          if (p.closest && p.closest('[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );
    var out = [];
    var n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function index() {
    nodes = [];
    var list = collectTextNodes();
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      var val = node.nodeValue;
      var lead = val.match(/^\s*/)[0];
      var tail = val.match(/\s*$/)[0];
      var core = val.slice(lead.length, val.length - tail.length);
      var key = norm(core);
      if (!key) continue;
      nodes.push({ node: node, prefix: lead, core: core, suffix: tail, key: key });
      // 快照节点交给 apply() 的静态循环统一处理。必须打标记：否则 MutationObserver
      // 会把「已被翻译成英文/繁中」的节点当新节点登记，其 core 变成译文；之后切换到
      // 其他语言时，动态循环会用这段旧译文覆盖静态循环刚写好的正确译文——表现为
      // 「切到繁体后再切西/法/德/日，界面仍停在繁体」。
      node.__tpStatic = true;
    }

    attrSlots = [];
    var els = document.querySelectorAll('*');
    for (var e = 0; e < els.length; e++) {
      var el = els[e];
      if (el.closest && el.closest('[data-i18n-skip]')) continue;
      for (var a = 0; a < ATTRS.length; a++) {
        var attr = ATTRS[a];
        if (!el.hasAttribute(attr)) continue;
        var raw = el.getAttribute(attr);
        if (!raw || !CJK.test(raw)) continue;
        var k = norm(raw);
        if (!k) continue;
        attrSlots.push({ el: el, attr: attr, core: raw, key: k });
      }
    }
  }

  // ── 动态内容翻译（MutationObserver）────────────────────────
  // React 岛屿（登录表单、账号下拉菜单、Toast 等）在 DOMContentLoaded 之后
  // 才渲染，boot() 里 index() 的快照覆盖不到它们。观察器把「新插入 / 新改写」
  // 的中文文本节点与属性即时套用词表，保证岛屿内容与静态文案一致。
  // 动态节点连同其中文原文登记在 dynNodes，切换语言时 apply() 会像静态快照
  // 一样按原文重新翻译，避免「插入时是英文、切到法文后永远停在英文」。
  var dynNodes = [];
  var dynSeen = typeof WeakSet === 'function' ? new WeakSet() : null;

  function translateTextNode(node) {
    var val = node.nodeValue;
    if (!val || !CJK.test(val)) return; // 非中文（含已翻译的译文）不动
    var p = node.parentElement;
    if (!p) return;
    var tag = p.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') return;
    if (p.closest && p.closest('[data-i18n-skip]')) return;
    var lead = val.match(/^\s*/)[0];
    var tail = val.match(/\s*$/)[0];
    var core = val.slice(lead.length, val.length - tail.length);
    var key = norm(core);
    if (!key) return;
    // 登记动态节点；若 React 改写了已登记节点（当前值 ≠ 我们上次写入的值），
    // 用新的中文原文刷新记录，保证语言切换时按最新原文重译
    if (dynSeen && !node.__tpStatic) {
      if (!dynSeen.has(node)) {
        dynSeen.add(node);
        var rec = { node: node, prefix: lead, core: core, suffix: tail, key: key };
        dynNodes.push(rec);
        node.__tpReg = rec;
      } else if (node.__tpReg && node.__tpLast !== val) {
        // React 改写了本节点（当前值 ≠ 我们上次写入的值）：按最新中文原文刷新记录
        node.__tpReg.core = core;
        node.__tpReg.key = key;
        node.__tpReg.prefix = lead;
        node.__tpReg.suffix = tail;
      }
    }
    var table = current === SOURCE ? null : dict;
    var out = (table && table[key]) || core;
    var next = lead + out + tail;
    if (next !== val) { node.__tpLast = next; node.nodeValue = next; } // 同值不写，避免自触发死循环
  }

  function translateAttr(el, attr) {
    if (!el || el.nodeType !== 1 || !attr) return;
    if (el.closest && el.closest('[data-i18n-skip]')) return;
    var raw = el.getAttribute(attr);
    if (!raw || !CJK.test(raw)) return;
    var key = norm(raw);
    var table = current === SOURCE ? null : dict;
    var out = table && table[key];
    if (out && out !== raw) el.setAttribute(attr, out);
  }

  function scanSubtree(rootEl) {
    if (rootEl.nodeType === 3) { translateTextNode(rootEl); return; }
    if (rootEl.nodeType !== 1) return;
    var w = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null, false);
    var t;
    while ((t = w.nextNode())) translateTextNode(t);
    if (rootEl.querySelectorAll) {
      var els = [rootEl].concat(Array.prototype.slice.call(rootEl.querySelectorAll('*')));
      for (var i = 0; i < els.length; i++) {
        for (var a = 0; a < ATTRS.length; a++) translateAttr(els[i], ATTRS[a]);
      }
    }
  }

  function observeMutations() {
    if (typeof MutationObserver !== 'function') return;
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') {
          translateTextNode(m.target);
        } else if (m.type === 'attributes') {
          translateAttr(m.target, m.attributeName);
        } else if (m.type === 'childList') {
          for (var n = 0; n < m.addedNodes.length; n++) scanSubtree(m.addedNodes[n]);
        }
      }
    });
    mo.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
  }

  function apply(lang) {
    current = lang;
    var table = lang === SOURCE ? null : dict;

    for (var i = 0; i < nodes.length; i++) {
      var it = nodes[i];
      var hit = table && table[it.key];
      it.node.nodeValue = it.prefix + (hit || it.core) + it.suffix;
    }
    for (var j = 0; j < attrSlots.length; j++) {
      var s = attrSlots[j];
      var t = table && table[s.key];
      if (t) s.el.setAttribute(s.attr, t);
      else s.el.setAttribute(s.attr, s.core);
    }
    // 动态节点按登记的中文原文重译（与静态快照同一语义）。
    // 修复「英文模式下插入的节点被译成英文后，再切法/中等语言永远停在英文」的冻结缺陷。
    for (var d = dynNodes.length - 1; d >= 0; d--) {
      var di = dynNodes[d];
      var connected = di.node.isConnected === undefined ? document.contains(di.node) : di.node.isConnected;
      if (!connected) { dynNodes.splice(d, 1); continue; }
      if (di.node.__tpStatic) { dynNodes.splice(d, 1); continue; }
      var dHit = table && table[di.key];
      var dNext = di.prefix + (dHit || di.core) + di.suffix;
      if (di.node.nodeValue !== dNext) {
        di.node.__tpLast = dNext;
        di.node.nodeValue = dNext;
      }
    }

    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('data-lang', lang);

    syncSwitcher();

    // 通知 React 岛屿（public-pkg 的 LocaleBridge）实时跟随，无需刷新页面
    try {
      window.dispatchEvent(new CustomEvent('tokpure:langchange', { detail: { lang: lang } }));
    } catch (e) { /* 老浏览器忽略 */ }
  }

  function load(lang) {
    if (lang === SOURCE) {
      dict = {};
      return Promise.resolve();
    }
    return fetch(i18nBase() + lang + '.json', { cache: 'force-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) { dict = json || {}; })
      .catch(function () { dict = {}; });
  }

  var menuOpen = false;

  function syncSwitcher() {
    var label = document.getElementById('__tp_lang_label');
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i].code === current) {
        if (label) label.textContent = LANGS[i].native;
        break;
      }
    }
    var items = document.querySelectorAll('[data-tp-lang]');
    for (var k = 0; k < items.length; k++) {
      var on = items[k].getAttribute('data-tp-lang') === current;
      items[k].style.background = on ? 'rgba(255,81,104,0.16)' : 'transparent';
      items[k].style.color = on ? '#ffb3b6' : '#e2e2e8';
    }
    var m = document.getElementById('__tp_lang_menu');
    if (m) m.style.display = menuOpen ? 'block' : 'none';
  }

  function buildSwitcher() {
    if (document.getElementById('__tp_lang')) return;

    var wrap = document.createElement('div');
    wrap.id = '__tp_lang';
    wrap.setAttribute('data-i18n-skip', '1');
    wrap.style.cssText = 'position:relative;display:inline-block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans",sans-serif;';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;' +
      'background:#282a2e;color:#e2e2e8;border:1px solid #333539;cursor:pointer;font-size:12px;line-height:1.2;white-space:nowrap;';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ad8889" ' +
      'stroke-width="1.8" stroke-linecap="round" style="flex:none"><circle cx="12" cy="12" r="9"/>' +
      '<path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>' +
      '<span id="__tp_lang_label">English</span>' +
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#ad8889" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="m6 9 6 6 6-6"/></svg>';

    var menu = document.createElement('div');
    menu.id = '__tp_lang_menu';
    menu.setAttribute('role', 'menu');
    menu.style.cssText = 'position:absolute;top:calc(100% + 6px);right:0;min-width:158px;padding:6px;' +
      'border-radius:10px;background:#1e2024;border:1px solid #333539;' +
      'box-shadow:0 12px 32px rgba(0,0,0,0.55);z-index:9999;display:none;';

    for (var i = 0; i < LANGS.length; i++) {
      (function (L) {
        var item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('data-tp-lang', L.code);
        item.setAttribute('role', 'menuitem');
        item.textContent = L.native;
        item.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 10px;border:0;' +
          'border-radius:7px;background:transparent;color:#e2e2e8;font-size:12.5px;cursor:pointer;' +
          'font-family:inherit;white-space:nowrap;';
        item.addEventListener('mouseenter', function () {
          if (L.code !== current) item.style.background = 'rgba(255,255,255,0.06)';
        });
        item.addEventListener('mouseleave', function () {
          if (L.code !== current) item.style.background = 'transparent';
        });
        item.addEventListener('click', function () {
          menuOpen = false;
          btn.setAttribute('aria-expanded', 'false');
          switchTo(L.code);
        });
        menu.appendChild(item);
      })(LANGS[i]);
    }

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      menuOpen = !menuOpen;
      btn.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
      syncSwitcher();
    });
    document.addEventListener('click', function () {
      if (menuOpen) { menuOpen = false; syncSwitcher(); }
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);

    var host = document.querySelector('header');
    if (host) {
      var row = host.querySelector('div');
      if (row) {
        row.appendChild(wrap);
        return;
      }
    }
    // 无 header 的页面（如登录页）：右上角悬浮
    wrap.style.cssText += 'position:fixed;top:16px;right:16px;z-index:9998;';
    document.body.appendChild(wrap);
  }

  // 连续切换语言时，慢的旧请求可能在新的 apply 之后才完成并覆盖状态；
  // 用序号保证只有最后一次请求的切换生效。
  var reqSeq = 0;
  function switchTo(lang) {
    var my = ++reqSeq;
    // 偏好只在用户主动选择时落盘（默认渲染不再写 STORE_KEY，避免产生「非用户偏好」的残留值）
    try {
      window.localStorage.setItem(STORE_KEY, lang);
      window.localStorage.setItem(MANUAL_KEY, '1');
    } catch (e) { /* ignore */ }
    load(lang).then(function () { if (my === reqSeq) apply(lang); });
  }

  function injectStyle() {
    if (document.getElementById('__tp_i18n_style')) return;
    var st = document.createElement('style');
    st.id = '__tp_i18n_style';
    // 译文普遍长于中文原文，禁止在词内折行，避免出现「ホー/ム」这类断字；
    // 头部各元素一律 nowrap + 关键项 shrink-0，杜绝「TokPure 被版本徽标压住、
    // 登录两字竖排、下载按钮文字重叠」这类 flex 压缩遮挡问题。
    st.textContent = '#__tp_lang,#__tp_lang *{white-space:nowrap;}' +
      'header nav a{white-space:nowrap;}' +
      'header nav{gap:2px;}' +
      // 头部容器放宽到 1500px（静态页写死 max-w-7xl=1280，英文译文全展开约需 1300px，
      // 原宽度下必然压缩遮挡）
      'header>div{max-width:1500px!important;}' +
      // logo 组与右侧操作组永不压缩；徽标/按钮文字不折行
      'header a[data-path="home"]{flex-shrink:0;white-space:nowrap;}' +
      'header [data-tp-version-badge]{flex-shrink:0;white-space:nowrap;}' +
      'header [data-tp-compute-badge]{flex-shrink:0;white-space:nowrap;}' +
      'header a[data-path="download"]{white-space:nowrap;}' +
      '#site-header-auth,#site-header-auth *{white-space:nowrap;}' +
      // 设计系统的 -0.05em 字距是为无空格的中文调的，拉丁译文会被压成「Downloadapp」
      // 这类单词粘连；非中文语言下放宽一档，保证词间空隙可见
      'html:not([data-lang="zh-CN"]):not([data-lang="zh-TW"]) .text-headline-sm{letter-spacing:-0.01em!important;}' +
      // 1024~1279px 是导航栏出现的最窄区间，译文较长时头部会溢出把语言按钮挤出屏幕，
      // 因此在该区间精简导航内边距与字号，并只保留地球图标
      // 注意：Tailwind 的 .px-3 / .text-headline-sm 是类选择器，优先级高于本文件的
      // 「header nav a」标签选择器，因此必须用 !important 才能压过
      '@media (max-width:1279.98px){' +
      '#__tp_lang_label{display:none;}' +
      'header nav a{padding-left:7px!important;padding-right:7px!important;}' +
      '}' +
      // 1440px 以下依次隐藏装饰性徽标，为导航与操作按钮留足空间
      '@media (max-width:1535.98px){header [data-tp-compute-badge]{display:none!important;}}' +
      '@media (max-width:1439.98px){header [data-tp-version-badge]{display:none!important;}}';
    document.head.appendChild(st);
  }

  function tagDecorative() {
    // 标记头部纯装饰徽章，供窄屏样式隐藏，为较长的译文腾出空间
    var spans = document.querySelectorAll('header span');
    for (var i = 0; i < spans.length; i++) {
      var txt = spans[i].textContent.trim();
      if (txt === '100% LOCAL COMPUTE') {
        var box = spans[i].closest('div');
        if (box) box.setAttribute('data-tp-compute-badge', '1');
      } else if (/^v\d+(\.\d+)*\s/.test(txt)) {
        // 「v2.4 macOS / Win」版本徽标：窄屏隐藏，避免与 logo 文字叠压
        var vbox = spans[i].closest('div');
        if (vbox) vbox.setAttribute('data-tp-version-badge', '1');
      }
    }
  }

  function boot() {
    injectStyle();
    tagDecorative();
    buildSwitcher();
    index();
    observeMutations();
    var lang = detect();
    reqSeq++;
    load(lang).then(function () { if (reqSeq === 1) apply(lang); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.TokPureI18n = {
    langs: LANGS,
    getLang: function () { return current; },
    setLang: switchTo
  };
})();
