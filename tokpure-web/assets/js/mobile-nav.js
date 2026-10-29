/**
 * 移动端导航（< 1024px）
 * ---------------------------------------------------------------------------
 * 静态页头部只有桌面导航（nav.hidden lg:flex），手机上既没有入口也无法跳转。
 * 本脚本做三件事，且不改动任何既有文案：
 *   1. 右侧注入汉堡按钮（44×44 触控区）+ 抽屉面板 + 遮罩；
 *   2. 抽屉里复用**原来的 nav 元素**（整体移动到面板内，桌面宽度再移回原位），
 *      这样链接文案仍由 i18n.js 的静态快照管理，切换语言不会冻结在上一种译文；
 *   3. 抽屉底部补充「登录 / 免费下载体验」两个入口（中文原文，i18n 会自动翻译）。
 *
 * 无 JS 时头部保持原样（桌面端不受影响）；>=1024px 时本脚本的 DOM 全部隐藏。
 */
(function () {
  var header = document.querySelector('header');
  if (!header) return;

  var row = header.querySelector('div');
  var nav = row && row.querySelector('nav');
  if (!row || !nav) return;

  // 头部右侧操作区：包含「免费下载体验」按钮的那个容器
  var cta = row.querySelector('a[data-path="download"].inline-flex');
  var actions = cta && cta.parentElement;
  if (!cta || !actions) return;

  cta.classList.add('tp-header-cta');
  actions.classList.add('tp-header-actions');

  /* ── 汉堡按钮 ───────────────────────────────────────────── */
  var burger = document.createElement('button');
  burger.type = 'button';
  burger.className = 'tp-burger';
  burger.setAttribute('aria-controls', 'tp-mnav');
  burger.setAttribute('aria-expanded', 'false');
  // 无障碍名称用可翻译的隐藏文本（i18n 会按词表翻译，aria-label 无法随之更新）
  burger.innerHTML =
    '<span class="tp-burger-box"><span></span><span></span><span></span></span>' +
    '<span class="tp-sr-only">菜单</span>';
  row.appendChild(burger);

  /* ── 抽屉面板 + 遮罩 ────────────────────────────────────── */
  var panel = document.createElement('div');
  panel.id = 'tp-mnav';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'tp-mnav-title');
  panel.setAttribute('aria-hidden', 'true');

  var title = document.createElement('span');
  title.className = 'tp-sr-only';
  title.id = 'tp-mnav-title';
  title.textContent = '菜单';
  panel.appendChild(title);

  var inner = document.createElement('div');
  inner.className = 'tp-mnav-inner';
  panel.appendChild(inner);

  var foot = document.createElement('div');
  foot.className = 'tp-mnav-foot';

  var login = document.createElement('a');
  login.className = 'tp-mnav-login';
  login.href = 'login.html';
  login.textContent = '登录';

  var ctaMobile = document.createElement('a');
  ctaMobile.className = 'tp-mnav-cta';
  ctaMobile.href = cta.getAttribute('href') || 'download.html';
  ctaMobile.textContent = '免费下载体验';

  foot.appendChild(login);
  foot.appendChild(ctaMobile);
  panel.appendChild(foot);
  header.appendChild(panel);

  var backdrop = document.createElement('div');
  backdrop.id = 'tp-mnav-backdrop';
  document.body.appendChild(backdrop);

  /* ── 开关逻辑 ───────────────────────────────────────────── */
  var isOpen = false;

  function setOpen(open) {
    isOpen = open;
    document.documentElement.classList.toggle('tp-mnav-open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      // 已登录（React 岛渲染出头像按钮）时不再展示「登录」入口
      login.hidden = !!document.querySelector('#site-header-auth button');
      var first = panel.querySelector('a');
      if (first) first.focus({ preventScroll: true });
    } else if (document.activeElement && panel.contains(document.activeElement)) {
      burger.focus({ preventScroll: true });
    }
  }

  burger.addEventListener('click', function () {
    setOpen(!isOpen);
  });

  backdrop.addEventListener('click', function () {
    setOpen(false);
  });

  panel.addEventListener('click', function (event) {
    var target = event.target;
    if (target && target.closest && target.closest('a')) setOpen(false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen) setOpen(false);
  });

  /* ── 视口切换：nav 在抽屉与头部之间迁移 ─────────────────── */
  var mq = window.matchMedia('(max-width: 1023.98px)');

  function syncLayout() {
    if (mq.matches) {
      if (nav.parentElement !== inner) inner.appendChild(nav);
    } else {
      if (nav.parentElement !== row) row.insertBefore(nav, actions);
      if (isOpen) setOpen(false);
    }
  }

  syncLayout();
  if (mq.addEventListener) mq.addEventListener('change', syncLayout);
  else if (mq.addListener) mq.addListener(syncLayout);
})();
