/**
 * 站点 GA4 漏斗埋点（静态页 + React 岛共用）。
 *
 * 只负责「点击/浏览」类事件；purchase / refund 一律由服务端 webhook 上报
 * （见 api/_ga4.js），避免广告拦截与回跳失败导致漏单或重复计收入。
 *
 * 对外 API：
 *   window.tpTrack(name, params)   安全上报，未加载 gtag 时静默忽略
 *   window.tpGaClientId()          取 _ga cookie 里的 client_id（传给后端做归因）
 */
(function () {
  var GA_PAGE_EVENTS = {
    'pricing.html': 'view_pricing',
    'answers.html': 'view_answers',
    'download.html': 'view_download'
  };

  function gtagReady() {
    return typeof window.gtag === 'function';
  }

  /** 统一出口：参数里去掉 undefined，避免 GA4 收到 "undefined" 字符串。 */
  function tpTrack(name, params) {
    if (!gtagReady()) return;
    var clean = {};
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') clean[k] = params[k];
    });
    try {
      window.gtag('event', name, clean);
    } catch (e) {
      /* 埋点异常绝不影响页面交互 */
    }
  }

  /** GA4 的 client_id 存在 `_ga=GA1.1.<随机>.<时间戳>`，服务端 webhook 归因要用。 */
  function tpGaClientId() {
    var m = /(?:^|;\s*)_ga=GA\d\.\d\.(\d{1,20}\.\d{1,20})/.exec(document.cookie || '');
    return m ? m[1] : '';
  }

  window.tpTrack = tpTrack;
  window.tpGaClientId = tpGaClientId;

  function currentPage() {
    var p = window.location.pathname.split('/').pop();
    return p || 'index.html';
  }

  function query(name) {
    try {
      return new URLSearchParams(window.location.search).get(name) || '';
    } catch (e) {
      return '';
    }
  }

  // 页面浏览类事件：只上报与付费漏斗相关的几个页面
  var pageEvent = GA_PAGE_EVENTS[currentPage()];
  if (pageEvent) {
    if (pageEvent === 'view_pricing') {
      tpTrack('view_pricing', {
        // from=desktop 来自客户端「升级到 Pro」按钮，用来区分站内自然流量
        source: query('from') || 'direct',
        default_plan: query('plan') || 'pro',
        lang: document.documentElement.getAttribute('lang') || ''
      });
    } else {
      tpTrack(pageEvent, { lang: document.documentElement.getAttribute('lang') || '' });
    }
  }

  // 选套餐：capture 阶段先于业务点击逻辑，登录跳转前也能记到意图
  document.addEventListener(
    'click',
    function (event) {
      var el = event.target && event.target.closest ? event.target.closest('[data-checkout]') : null;
      if (!el) return;
      var plan = el.getAttribute('data-checkout') || '';
      tpTrack('select_plan', {
        plan: plan === 'studio' ? 'tokpure-studio' : 'tokpure-pro',
        plan_name: plan,
        lang: document.documentElement.getAttribute('lang') || ''
      });
    },
    true
  );

  // 下载点击：安装包直链 + 任何标了 data-ga="download" 的按钮
  document.addEventListener(
    'click',
    function (event) {
      var el = event.target && event.target.closest ? event.target.closest('a[href], [data-ga="download"]') : null;
      if (!el) return;
      var href = el.getAttribute('href') || '';
      var isPkg = /\.(dmg|exe|pkg|zip)(\?|$)/i.test(href);
      if (!isPkg && el.getAttribute('data-ga') !== 'download') return;
      var platform = /\.dmg|\.pkg/i.test(href) ? 'macos' : /\.exe/i.test(href) ? 'windows' : 'unknown';
      tpTrack('download_click', {
        platform: platform,
        link_url: href,
        page: currentPage()
      });
    },
    true
  );

  // 语言切换：i18n.js 切换完成后派发 tp:lang 事件
  document.addEventListener('tp:lang', function (event) {
    var detail = (event && event.detail) || {};
    tpTrack('language_switch', { from: detail.from || '', to: detail.to || '' });
  });
})();
