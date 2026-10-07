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

  function detect() {
    var saved = null;
    try { saved = window.localStorage.getItem(STORE_KEY); } catch (e) { saved = null; }
    if (saved) {
      for (var i = 0; i < LANGS.length; i++) {
        if (LANGS[i].code === saved) return saved;
      }
    }
    var nav = navigator.languages || [navigator.language || FALLBACK];
    for (var n = 0; n < nav.length; n++) {
      var tag = String(nav[n]).toLowerCase();
      if (tag.indexOf('zh') === 0) {
        return /hant|tw|hk|mo/.test(tag) ? 'zh-TW' : 'zh-CN';
      }
      for (var j = 0; j < LANGS.length; j++) {
        var base = LANGS[j].code.split('-')[0].toLowerCase();
        if (tag === base || tag.indexOf(base + '-') === 0) return LANGS[j].code;
      }
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

    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('data-lang', lang);
    try { window.localStorage.setItem(STORE_KEY, lang); } catch (e) { /* ignore */ }

    syncSwitcher();
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

  function switchTo(lang) {
    load(lang).then(function () { apply(lang); });
  }

  function injectStyle() {
    if (document.getElementById('__tp_i18n_style')) return;
    var st = document.createElement('style');
    st.id = '__tp_i18n_style';
    // 译文普遍长于中文原文，禁止在词内折行，避免出现「ホー/ム」这类断字
    st.textContent = '#__tp_lang,#__tp_lang *{white-space:nowrap;}' +
      'header nav a{white-space:nowrap;}' +
      'header nav{gap:2px;}' +
      // 1024~1279px 是导航栏出现的最窄区间，译文较长时头部会溢出把语言按钮挤出屏幕，
      // 因此在该区间精简导航内边距与字号，并只保留地球图标
      // 注意：Tailwind 的 .px-3 / .text-headline-sm 是类选择器，优先级高于本文件的
      // 「header nav a」标签选择器，因此必须用 !important 才能压过
      '@media (max-width:1279.98px){' +
      '#__tp_lang_label{display:none;}' +
      'header nav a{padding-left:7px!important;padding-right:7px!important;}' +
      'header [data-tp-compute-badge]{display:none!important;}' +
      '}';
    document.head.appendChild(st);
  }

  function tagDecorative() {
    // 标记头部纯装饰徽章，供窄屏样式隐藏，为较长的译文腾出空间
    var spans = document.querySelectorAll('header span');
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].textContent.trim() === '100% LOCAL COMPUTE') {
        var box = spans[i].closest('div');
        if (box) box.setAttribute('data-tp-compute-badge', '1');
        break;
      }
    }
  }

  function boot() {
    injectStyle();
    tagDecorative();
    buildSwitcher();
    index();
    var lang = detect();
    load(lang).then(function () { apply(lang); });
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
