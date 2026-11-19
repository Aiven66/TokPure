/* 首页 FAQ 按需渲染：答案不写进 HTML，首次展开时才注入，减少首屏需要解析的字符数。
   答案同时保留在 JSON-LD 的 FAQPage 里，爬虫仍能读到全文。 */
(function () {
  var answers = [
    'It is free to download. The Community tier gets native-stream downloads at 720p and 1080p, M4A audio extraction and two concurrent tasks, with the base end-card logo removal. Local AI inpainting, 4K upscaling and batch concurrency are in Pro at $9.9/month.',
    'Not if you download the native stream — there is no re-encode at all. Repairing an already-reposted clip is different: that is reconstruction from surrounding frames, so a heavily compressed re-post will keep faint traces.',
    'TikTok composites it onto a drifting path rather than at a fixed corner. That is why single-frame removers leave a smeared rectangle instead of a clean area.',
    'No. Download and repair both run locally, there is no cloud step and no telemetry.',
  ];

  var list = document.querySelector('[data-home-faq]');
  if (!list) return;

  function fill(item) {
    var body = item.querySelector('.faq-body');
    if (!body || body.dataset.filled) return;
    var p = document.createElement('p');
    p.textContent = answers[Number(item.dataset.faq)] || '';
    body.appendChild(p);
    body.dataset.filled = '1';
  }

  list.addEventListener('toggle', function (e) {
    if (e.target.tagName === 'DETAILS' && e.target.open) fill(e.target);
  }, true);

  /* 旧版 Safari 里由脚本触发的展开不一定冒泡 toggle，再挂一次 click 兜底 */
  list.addEventListener('click', function (e) {
    var summary = e.target.closest && e.target.closest('summary');
    if (!summary) return;
    var item = summary.parentElement;
    if (item.open) fill(item);
  });
})();
