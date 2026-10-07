/* ============================================================
   TokPure — 桌面端多语言运行时
   源码语言为简体中文（zh-CN），运行时按词表覆盖 DOM 文本与属性，
   并通过 MutationObserver 覆盖 app.js 动态渲染出的内容。
   词表由 i18n/<code>.js 提前注册到 window.TokPureI18n.lan。
   ============================================================ */
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
  var ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1 };

  var REG = window.TokPureI18n = window.TokPureI18n || {};
  REG.lan = REG.lan || {};
  if (typeof REG.add !== 'function') {
    // 词表脚本先于本文件执行，这里补齐注册函数
    REG.add = function (code, data) { REG.lan[code] = data; };
  }

  var current = SOURCE;
  var observer = null;

  function norm(s) { return s.replace(/\s+/g, ' ').trim(); }

  function translate(s) {
    if (current === SOURCE) return s;
    var d = REG.lan[current];
    if (!d) return s;
    return typeof d[s] === 'string' ? d[s] : s;
  }

  // 供 app.js 拼接动态文案使用：T('已加入 {0} 个任务', n)
  function T(key, a, b, c) {
    var out = translate(norm(key));
    var args = [a, b, c];
    return out.replace(/\{(\d)\}/g, function (m, i) {
      var v = args[Number(i)];
      return v === undefined || v === null ? '' : String(v);
    });
  }
  window.T = T;

  function skipped(node) {
    var el = node.nodeType === 1 ? node : node.parentNode;
    if (!el || !el.closest) return true;
    return !!el.closest('[data-i18n-skip]');
  }

  function eachText(root, fn) {
    if (root.nodeType === 3) { if (!skipped(root)) fn(root); return; }
    if (root.nodeType !== 1) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p || SKIP_TAGS[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if (skipped(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = walker.nextNode())) fn(n);
  }

  // 把「原文」渲染成当前语言下的完整字符串（保留首尾空白）
  function render(raw) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
    if (!m || !m[2]) return raw;
    return m[1] + translate(norm(m[2])) + m[3];
  }

  function applyText(node) {
    var cur = node.nodeValue;
    if (node.__tpSrc === undefined) {
      if (!cur || !/\S/.test(cur)) return;
      node.__tpSrc = cur;
      node.__tpOut = cur; // 首次见到时尚未翻译，输出即原文
    } else if (cur !== node.__tpOut) {
      // 当前值不等于「我们上次写入的值」=> 内容被外部（app.js / 用户交互）改写过，
      // 缓存原文已失效，改用当前值作为新原文。
      // 注意必须用「上次输出」而非「上一语言下的译文」来判断：切换语言时
      // render(__tpSrc) 的结果必然与旧输出不同，那样会误判成外部改写。
      if (!cur || !/\S/.test(cur)) { delete node.__tpSrc; node.__tpOut = cur; return; }
      node.__tpSrc = cur;
    }
    var next = render(node.__tpSrc);
    if (node.nodeValue !== next) node.nodeValue = next;
    node.__tpOut = node.nodeValue;
  }

  function attrHosts(root) {
    var sel = ATTRS.map(function (a) { return '[' + a + ']'; }).join(',');
    var list = [];
    if (root.nodeType === 1) {
      if (root.matches && root.matches(sel)) list.push(root);
      var found = root.querySelectorAll(sel);
      for (var i = 0; i < found.length; i++) list.push(found[i]);
    } else if (root.nodeType === 9) {
      var all = root.querySelectorAll(sel);
      for (var j = 0; j < all.length; j++) list.push(all[j]);
    }
    return list;
  }

  function applyAttrs(root) {
    var hosts = attrHosts(root);
    for (var i = 0; i < hosts.length; i++) {
      var el = hosts[i];
      if (el.closest && el.closest('[data-i18n-skip]')) continue;
      for (var j = 0; j < ATTRS.length; j++) {
        var a = ATTRS[j];
        if (!el.hasAttribute(a)) continue;
        var slot = '__tpA_' + a;
        var outSlot = '__tpO_' + a;
        var curVal = el.getAttribute(a);
        if (el[slot] === undefined) {
          if (!curVal || !/\S/.test(curVal)) continue;
          el[slot] = curVal;
          el[outSlot] = curVal;
        } else if (curVal !== el[outSlot]) {
          // 与文本同理：属性被外部改写则缓存失效，以当前值为新原文
          if (!curVal || !/\S/.test(curVal)) { delete el[slot]; el[outSlot] = curVal; continue; }
          el[slot] = curVal;
        }
        var out = render(el[slot]);
        if (el.getAttribute(a) !== out) el.setAttribute(a, out);
        el[outSlot] = el.getAttribute(a);
      }
    }
  }

  function apply(root) {
    var scope = root || document.documentElement;
    eachText(scope, applyText);
    applyAttrs(scope);
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(function (records) {
      var i;
      for (i = 0; i < records.length; i++) {
        var rec = records[i];
        if (rec.type === 'childList') {
          for (var k = 0; k < rec.addedNodes.length; k++) {
            var n = rec.addedNodes[k];
            if (n.nodeType === 1 || n.nodeType === 3) apply(n);
          }
        } else if (rec.type === 'characterData') {
          // applyText 内部会用值比对判断缓存是否失效，因此这里无需删除 __tpSrc
          applyText(rec.target);
        } else if (rec.type === 'attributes' && rec.target.nodeType === 1) {
          applyAttrs(rec.target);
        }
      }
      // 丢弃本次翻译自身产生的变更记录，避免自触发死循环
      observer.takeRecords();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }

  var STYLE_ID = '__tp_lang_style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      '#__tp_lang{position:relative;display:flex;align-items:center;-webkit-app-region:no-drag;}' +
      '#__tp_lang_btn{display:flex;align-items:center;gap:5px;height:26px;padding:0 8px;' +
      'background:var(--fill);border:1px solid var(--hairline);border-radius:var(--radius-full);' +
      'color:var(--text-muted);font:inherit;font-size:11px;cursor:pointer;transition:.15s;white-space:nowrap;}' +
      '#__tp_lang_btn:hover{background:var(--fill-hover);color:var(--on-surface);}' +
      '#__tp_lang_btn svg{flex:none;opacity:.85;}' +
      '#__tp_lang_menu{position:absolute;top:calc(100% + 6px);right:0;min-width:150px;padding:5px;' +
      'background:var(--surface-container-high);border:1px solid var(--hairline-strong);' +
      'border-radius:var(--radius-md);box-shadow:var(--shadow-window);display:none;z-index:4000;}' +
      '#__tp_lang.open #__tp_lang_menu{display:block;}' +
      '#__tp_lang_menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
      'width:100%;padding:7px 10px;background:none;border:0;border-radius:var(--radius-xs);' +
      'color:var(--on-surface);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap;}' +
      '#__tp_lang_menu button:hover{background:var(--fill-hover);}' +
      '#__tp_lang_menu button[aria-current="true"]{color:var(--secondary);}' +
      '#__tp_lang_menu .cur{font-size:10px;opacity:.9;}';
    document.head.appendChild(st);
  }

  function buildSwitcher() {
    if (document.getElementById('__tp_lang')) return;
    var host = document.querySelector('.tl-right') || document.querySelector('header') || document.body;
    var wrap = document.createElement('div');
    wrap.id = '__tp_lang';
    wrap.setAttribute('data-i18n-skip', '1');

    var btn = document.createElement('button');
    btn.id = '__tp_lang_btn';
    btn.type = 'button';
    btn.innerHTML = window.TPI('globe', 14) + '<span id="__tp_lang_label">简体中文</span>';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      wrap.classList.toggle('open');
    });

    var menu = document.createElement('div');
    menu.id = '__tp_lang_menu';
    LANGS.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-lang', l.code);
      b.innerHTML = '<span>' + l.native + '</span><span class="cur"></span>';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        wrap.classList.remove('open');
        setLang(l.code);
      });
      menu.appendChild(b);
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    host.appendChild(wrap);

    document.addEventListener('click', function () { wrap.classList.remove('open'); });
    syncSwitcher();
  }

  function syncSwitcher() {
    var wrap = document.getElementById('__tp_lang');
    if (!wrap) return;
    var label = document.getElementById('__tp_lang_label');
    var native = current;
    LANGS.forEach(function (l) { if (l.code === current) native = l.native; });
    if (label) label.textContent = native;
    var items = wrap.querySelectorAll('#__tp_lang_menu button');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-lang') === current;
      items[i].setAttribute('aria-current', on ? 'true' : 'false');
      var cur = items[i].querySelector('.cur');
      if (cur) cur.textContent = on ? '✓' : '';
    }
  }

  function detect() {
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { saved = null; }
    if (saved && LANGS.some(function (l) { return l.code === saved; })) return saved;
    var list = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < list.length; i++) {
      var t = String(list[i]).toLowerCase();
      if (!t) continue;
      if (t.indexOf('zh') === 0) return /hant|tw|hk|mo/.test(t) ? 'zh-TW' : 'zh-CN';
      var base = t.split('-')[0];
      var hit = LANGS.filter(function (l) { return l.code === base; })[0];
      if (hit) return hit.code;
    }
    return FALLBACK;
  }

  function setLang(code) {
    if (!LANGS.some(function (l) { return l.code === code; })) code = SOURCE;
    current = code;
    document.documentElement.setAttribute('lang', code);
    document.documentElement.setAttribute('data-lang', code);
    try { localStorage.setItem(STORE_KEY, code); } catch (e) { /* 忽略隐私模式限制 */ }
    apply(document.documentElement);
    syncSwitcher();
    // 通知 app.js 重绘由 JS 生成的动态文案（它们由 T() 产出，无法靠 DOM 词表反向还原）
    try {
      document.dispatchEvent(new CustomEvent('tokpure:lang', { detail: { lang: code } }));
    } catch (e) { /* 旧内核不支持 CustomEvent 时忽略 */ }
  }

  function start() {
    injectStyle();
    buildSwitcher();
    // app.js 在解析末尾同步执行的 boot() 里已经插入过动态文案，这里补一次覆盖
    apply(document.documentElement);
    startObserver();
  }

  REG.langs = LANGS;
  REG.getLang = function () { return current; };
  REG.setLang = setLang;

  // 必须在本文件加载时就确定语言：app.js 紧随其后加载，其 boot() 内所有 T() 调用
  // 都依赖 current 已正确，否则首屏动态文案会停留在简体中文。
  setLang(detect());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
