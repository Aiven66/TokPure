/**
 * 移动端底部转化条（W-02）。
 *
 * 触发：视口 < 1024px 且首屏滚出约 640px 后浮出；回到顶部自动收起。
 * 排除：下载页、价格页（本来就在目标页上，再浮一条只会挡内容）。
 * 无障碍：容器 hidden 时不可聚焦；尊重 prefers-reduced-motion（用透明度代替位移）。
 */
(function () {
  var bar = document.getElementById('tp-cta');
  if (!bar) return;
  if (document.body.hasAttribute('data-no-cta')) return;

  var mqDesktop = window.matchMedia('(min-width: 1024px)');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var ticking = false;

  function sync() {
    ticking = false;
    var on = !mqDesktop.matches && window.scrollY > 640;
    if (on === !bar.hidden) return;
    if (on) {
      bar.hidden = false;
      /* 下一帧加类，保证 transition 生效 */
      requestAnimationFrame(function () { bar.classList.add('is-on'); });
    } else {
      bar.classList.remove('is-on');
      if (reduce.matches) {
        bar.hidden = true;
      } else {
        setTimeout(function () {
          if (!bar.classList.contains('is-on')) bar.hidden = true;
        }, 320);
      }
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(sync);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  sync();
})();
