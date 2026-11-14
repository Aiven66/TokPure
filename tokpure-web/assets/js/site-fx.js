/**
 * 全站通用视觉效果（内页用；首页首屏有自己的一套更强动效）。
 *
 * 只做两件事：
 *  1. 给 main 里除首屏外的 <section> 加滚动揭示；
 *  2. 尊重 prefers-reduced-motion，并在观察器异常时兜底显示，绝不让内容空白。
 *
 * 说明：样式在 assets/css/site.css 的「视觉升级：全站统一语言」段，
 * 这里只负责加 data-reveal / is-in 两个标记，改样式不需要动 JS。
 */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var main = document.querySelector('main');
  if (!main || reduce || !('IntersectionObserver' in window)) return;

  var items = [].slice.call(main.querySelectorAll('section')).slice(1);
  if (!items.length) return;

  for (var i = 0; i < items.length; i++) items[i].setAttribute('data-reveal', '');
  document.documentElement.classList.add('reveal-on');

  var fired = false;
  var io = new IntersectionObserver(function (entries) {
    fired = true;
    for (var j = 0; j < entries.length; j++) {
      if (!entries[j].isIntersecting) continue;
      entries[j].target.classList.add('is-in');
      io.unobserve(entries[j].target);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
  items.forEach(function (el) { io.observe(el); });

  /* 兜底：观察器从未回调（浏览器异常）时全部显示，避免长页面一片空白 */
  setTimeout(function () {
    if (!fired) for (var k = 0; k < items.length; k++) items[k].classList.add('is-in');
  }, 2200);
})();
