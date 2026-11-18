/**
 * 下载页智能识别（W-01）：
 *  1. 判断系统与芯片架构，在首屏推荐最合适的安装包；
 *  2. 无法确定芯片时（Safari / Firefox 拿不到架构），给出「Apple Silicon / Intel」二选一，
 *     不猜错包；
 *  3. 非桌面端给出明确说明，避免移动端用户反复点。
 *
 * 文案全部来自 HTML 里预置的三个按钮（静态节点），本脚本只负责显隐，
 * 因此 i18n 在加载时就能把它们翻好，不会出现「脚本插入的中文不翻译」。
 */
(function () {
  var box = document.getElementById('dl-recommend');
  var noteEl = document.getElementById('dl-recommend-note');
  if (!box) return;

  var ua = navigator.userAgent || '';
  var uad = navigator.userAgentData;
  var platform = (uad && uad.platform) || '';
  var isMac = /mac/i.test(platform) || /Mac OS X|Macintosh/i.test(ua);
  var isWin = /win/i.test(platform) || /Windows NT/i.test(ua);
  var isMobile = /iPhone|iPad|iPod|Android/i.test(ua);

  function show(id) {
    var el = box.querySelector('[data-dl="' + id + '"]');
    if (!el) return false;
    box.hidden = false;
    el.classList.remove('hidden');
    return true;
  }

  function note(msgId) {
    if (!noteEl) return;
    var span = noteEl.querySelector('[data-note="' + msgId + '"]');
    if (!span) return;
    noteEl.hidden = false;
    span.hidden = false;
  }

  function fallback(msgId) {
    /* 拿不到架构：把两个 macOS 包都摆出来，让用户自己选，避免下错 */
    box.hidden = false;
    box.querySelector('[data-dl="mac-arm64"]').classList.remove('hidden');
    box.querySelector('[data-dl="mac-x64"]').classList.remove('hidden');
    note(msgId);
  }

  function track(kind) {
    if (typeof window.tpTrack === 'function') {
      window.tpTrack('download_recommend', { platform: kind });
    }
  }

  function detectArch() {
    if (!(uad && uad.getHighEntropyValues)) return Promise.resolve('');
    return uad.getHighEntropyValues(['architecture'])
      .then(function (v) { return (v && v.architecture) || ''; })
      .catch(function () { return ''; });
  }

  /* Safari / Firefox 没有 UA-CH，用 WebGL 渲染器名兜底判断 Apple 芯片 */
  function archFromWebGL() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
      if (/Apple\s?M\d/i.test(r)) return 'arm';
    } catch (e) { /* 取不到就按未知处理 */ }
    return '';
  }

  if (isMobile) {
    note('mobile');
    return;
  }

  if (isWin) {
    if (show('win-x64')) track('windows-x64');
    return;
  }

  if (!isMac) {
    note('other');
    return;
  }

  detectArch().then(function (arch) {
    if (arch === 'arm') return show('mac-arm64') && track('macos-arm64');
    if (arch === 'x86') return show('mac-x64') && track('macos-x64');
    var gl = archFromWebGL();
    if (gl === 'arm') return show('mac-arm64') && track('macos-arm64');
    fallback('mac-unknown');
  });
})();
