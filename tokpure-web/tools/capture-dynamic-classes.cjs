/**
 * 采集「运行时真实出现过的类名」并写入 tools/tailwind-safelist.txt。
 *
 * 为什么需要：Tailwind 现在是构建期预编译（tools/build-tailwind.mjs），只会扫描仓库源码
 * 与根目录 HTML。博客正文是后台通过 Supabase 录入的 HTML，构建期扫不到；如果正文里用到
 * 了源码中没出现的类名，预编译样式表就会缺这些规则。本工具把线上页面真实渲染出的 class
 * 全部抓成一份快照，作为 Tailwind 的 content 兜底。
 *
 * 用法（需要全局 playwright）：
 *   NODE_PATH=$(npm root -g) node tools/capture-dynamic-classes.cjs
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');

const PAGES = [
  'index.html', 'download.html', 'pricing.html', 'tiktok-stickers.html',
  'about.html', 'blog.html', 'login.html', 'admin.html', '404.html', 'auth-callback.html',
];
const PORT = 4197;

(async () => {
  const { startServer } = await import('file://' + require('node:path').resolve('tests/server.mjs'));
  const server = await startServer(require('node:path').resolve('dist'), PORT);
  const browser = await chromium.launch({ channel: 'chrome' });
  const tokens = new Set();

  for (const p of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/${p}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const classes = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[class]')) out.push(el.getAttribute('class') || '');
      return out;
    });
    for (const cls of classes) for (const t of cls.split(/\s+/)) if (t) tokens.add(t);
    console.log(`${p}: 累计 ${tokens.size} 个类名`);
    await ctx.close();
  }

  await browser.close();
  await new Promise((r) => server.close(r));

  const sorted = [...tokens].sort();
  require('node:fs').writeFileSync(
    require('node:path').resolve('tools/tailwind-safelist.txt'),
    `# 线上真实出现过的类名快照（${PAGES.length} 个页面 / ${sorted.length} 个类）\n` +
      '# 重新生成：NODE_PATH=$(npm root -g) node tools/capture-dynamic-classes.cjs\n' +
      sorted.join('\n') + '\n',
  );
  console.log(`✔ 已写入 tools/tailwind-safelist.txt（${sorted.length} 个类名）`);
})();
