/* 首页交互：特性切换 + 滚动揭示/光标聚光（外置以减少 HTML 体积） */

(function () {
  var tabs = [].slice.call(document.querySelectorAll('[data-tp-feat]'));
  var panels = [].slice.call(document.querySelectorAll('[data-tp-feat-panel]'));
  if (!tabs.length || !panels.length) return;
  function select(id, moveFocus) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tp-feat') === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('tabindex', on ? '0' : '-1');
      t.classList.toggle('tp-feat-on', on);
      if (on && moveFocus) t.focus();
    });
    panels.forEach(function (p) {
      p.classList.toggle('hidden', p.getAttribute('data-tp-feat-panel') !== id);
    });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t.getAttribute('data-tp-feat')); });
    t.addEventListener('keydown', function (e) {
      var n = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % tabs.length;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = tabs.length - 1;
      if (n === null) return;
      e.preventDefault();
      select(tabs[n].getAttribute('data-tp-feat'), true);
    });
  });
})();



(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* 滚动揭示：JS 可用时才隐藏内容，脚本失效或观察器报错时页面照常可见 */
  var items = [].slice.call(document.querySelectorAll('[data-reveal]'));
  if (!reduce && 'IntersectionObserver' in window && items.length) {
    document.documentElement.classList.add('reveal-on');
    var fired = false;
    var io = new IntersectionObserver(function (entries) {
      fired = true;
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        entries[i].target.classList.add('is-in');
        io.unobserve(entries[i].target);
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    items.forEach(function (el) { io.observe(el); });
    /* 兜底：观察器从未回调（浏览器异常）时才全部显示，不影响正常的滚动揭示 */
    setTimeout(function () { if (!fired) items.forEach(function (el) { el.classList.add('is-in'); }); }, 2200);
  }
  /* 首屏聚光：仅精确指针设备，且尊重「减少动效」 */
  var hero = document.querySelector('.hero-hot');
  if (hero && !reduce && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    var raf = 0, mx = 0, my = 0;
    var paint = function () {
      raf = 0;
      hero.style.setProperty('--mx', mx + 'px');
      hero.style.setProperty('--my', my + 'px');
    };
    hero.addEventListener('pointermove', function (e) {
      var r = hero.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
      if (!raf) raf = requestAnimationFrame(paint);
    }, { passive: true });
  }
})();
