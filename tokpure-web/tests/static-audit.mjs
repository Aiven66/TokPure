/**
 * 静态审计：直接检查构建产物 dist/ 里的 HTML、SEO 元信息、内链、资源引用与站点级文件。
 * 不依赖任何第三方库，CI 里可直接跑。
 *
 * 用法：node tests/static-audit.mjs [distDir]
 * 退出码：发现 error 级问题时为 1。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve(process.argv[2] || 'dist');
const SITE = 'https://tokpure.clipopai.com';

/** 公开页面（需要出现在 sitemap 里，且必须有完整 SEO 元信息） */
const PUBLIC_PAGES = ['index.html', 'download.html', 'pricing.html', 'tiktok-stickers.html', 'about.html', 'blog.html'];
/** 非索引页：只要求 noindex，不要求 og / canonical / h1 / JSON-LD */
const NOINDEX_PAGES = new Set(['admin.html', 'auth-callback.html', '404.html', 'login.html']);
/**
 * 客户端渲染页：标题/描述/canonical/JSON-LD 与 h1 由 src/entries/*.tsx 在运行时写入，
 * 交给 e2e 校验。admin / auth-callback 是纯 CSR 的登录态页面，静态 HTML 里只有空容器。
 */
const DYNAMIC_PAGES = new Set(['blog-detail.html', 'admin.html', 'auth-callback.html']);

/** 站点 8 种语言（同 URL 运行时切换），用于校验多语言声明 */
const SITE_LANGS = 8;

const problems = [];
const warnings = [];
const info = [];
const add = (level, page, msg) => {
  (level === 'error' ? problems : warnings).push(`${page}: ${msg}`);
};

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};
const tags = (html, name) => {
  const re = new RegExp(`<${name}\\b[^>]*>`, 'gi');
  return html.match(re) || [];
};
const textOf = (html, name) => {
  const m = html.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
};
const decodeEntities = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

async function exists(p) {
  try { return (await stat(p)).isFile(); } catch (_) { return false; }
}

const htmlFiles = (await readdir(ROOT)).filter((f) => f.endsWith('.html')).sort();
if (!htmlFiles.length) {
  console.error(`未找到 HTML 产物：${ROOT}`);
  process.exit(1);
}

/* ---------------- 逐页检查 ---------------- */
for (const file of htmlFiles) {
  const html = await readFile(join(ROOT, file), 'utf8');
  const page = file;
  const isNoindex = NOINDEX_PAGES.has(file);
  const isDynamic = DYNAMIC_PAGES.has(file);

  if (!/^<!doctype html>/i.test(html.trim())) add('error', page, '缺少 <!DOCTYPE html>');

  const htmlTag = tags(html, 'html')[0] || '';
  const lang = attr(htmlTag, 'lang');
  if (!lang) add('error', page, '<html> 缺少 lang 属性');

  const viewport = tags(html, 'meta').find((t) => (attr(t, 'name') || '').toLowerCase() === 'viewport');
  if (!viewport) add('error', page, '缺少 viewport meta（移动端会按 980px 渲染）');

  // 标题 / 描述
  const title = decodeEntities(textOf(html, 'title'));
  if (!title) add('error', page, '缺少 <title>');
  else if (title.length > 65) add('warn', page, `title 过长（${title.length} 字符，建议 ≤ 60）`);
  const desc = tags(html, 'meta').find((t) => (attr(t, 'name') || '').toLowerCase() === 'description');
  const descText = desc ? decodeEntities(attr(desc, 'content') || '') : '';
  if (!descText) {
    if (!isNoindex) add('error', page, '缺少 meta description');
  } else if (descText.length > 160) add('warn', page, `description 过长（${descText.length} 字符，建议 ≤ 158）`);
  else if (descText.length < 60 && !isNoindex) add('warn', page, `description 偏短（${descText.length} 字符，建议 ≥ 60）`);

  // 非索引页必须显式 noindex，避免后台/工具页被搜索引擎收录
  const robots = tags(html, 'meta').find((t) => (attr(t, 'name') || '').toLowerCase() === 'robots');
  const robotsText = robots ? (attr(robots, 'content') || '').toLowerCase() : '';
  if (isNoindex && !/noindex/.test(robotsText)) add('error', page, '非索引页缺少 robots=noindex');
  if (!isNoindex && !robots) add('error', page, '缺少 robots meta');

  // canonical
  const canonical = tags(html, 'link').find((t) => (attr(t, 'rel') || '').toLowerCase() === 'canonical');
  if (!isNoindex && !isDynamic) {
    if (!canonical) add('error', page, '缺少 canonical');
    else {
      const href = attr(canonical, 'href') || '';
      if (!/^https:\/\//.test(href)) add('error', page, `canonical 不是绝对地址：${href}`);
      const expected = file === 'index.html' ? `${SITE}/` : `${SITE}/${file}`;
      if (href !== expected) add('warn', page, `canonical 与页面不一致（${href} ≠ ${expected}）`);
    }
  }

  // Open Graph / Twitter
  const og = {};
  for (const t of tags(html, 'meta')) {
    const p = attr(t, 'property');
    if (p && p.startsWith('og:')) og[p] = attr(t, 'content') || '';
  }
  if (!isNoindex) {
    for (const key of ['og:type', 'og:title', 'og:description', 'og:url', 'og:image', 'og:site_name']) {
      if (!og[key] && !(isDynamic && key === 'og:url')) add('error', page, `缺少 ${key}`);
    }
    if (og['og:image'] && !/^https:\/\//.test(og['og:image'])) add('error', page, 'og:image 必须是绝对地址');
    const twitter = tags(html, 'meta').filter((t) => (attr(t, 'name') || '').startsWith('twitter:'));
    if (!twitter.length) add('error', page, '缺少 twitter:card 系列标签');
  }

  // 多语言声明：站点 8 语言共用同一 URL（运行时切换），所以 hreflang 不适用；
  // 改用 og:locale + og:locale:alternate 与 JSON-LD inLanguage 表达语言覆盖范围。
  if (!isNoindex && !isDynamic) {
    const alternates = tags(html, 'meta').filter((t) => (attr(t, 'property') || '') === 'og:locale:alternate');
    if (alternates.length < SITE_LANGS - 1) {
      add('warn', page, `og:locale:alternate 只有 ${alternates.length} 个（建议 ${SITE_LANGS - 1} 个）`);
    }
  }

  // 结构化数据
  const ld = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!isNoindex && !isDynamic && !ld.length) add('error', page, '缺少 JSON-LD 结构化数据');
  let ldLangCount = 0;
  for (const [, body] of ld) {
    try {
      const parsed = JSON.parse(body);
      if (!parsed['@context'] && !parsed['@graph']) add('warn', page, 'JSON-LD 缺少 @context');
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node.inLanguage)) ldLangCount = Math.max(ldLangCount, node.inLanguage.length);
        for (const v of Object.values(node)) walk(v);
      };
      walk(parsed);
    } catch (e) {
      add('error', page, `JSON-LD 无法解析：${String(e.message).slice(0, 60)}`);
    }
  }
  if (!isNoindex && !isDynamic && ldLangCount && ldLangCount < 2) {
    add('warn', page, `JSON-LD inLanguage 只声明了 ${ldLangCount} 种语言`);
  }

  // 标题层级
  if (!isDynamic) {
    const h1 = tags(html, 'h1').length;
    if (h1 !== 1) add(h1 === 0 ? 'error' : 'warn', page, `h1 数量为 ${h1}（应为 1）`);
  }
  if (!tags(html, 'h2').length && !isDynamic && !isNoindex) add('warn', page, '没有 h2 小标题');

  // 图片
  for (const img of tags(html, 'img')) {
    const src = attr(img, 'src') || '';
    const alt = img.match(/\salt\s*=\s*/) ? attr(img, 'alt') : null;
    if (alt === null && !/data-alt/.test(img)) add('error', page, `图片缺少 alt：${src}`);
    if (!attr(img, 'width') || !attr(img, 'height')) add('warn', page, `图片未声明 width/height（CLS 风险）：${src}`);
  }

  // 重复 id
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) add('error', page, `重复 id：${[...new Set(dup)].join(', ')}`);

  // 内链与资源引用
  const refs = [
    ...tags(html, 'a').map((t) => attr(t, 'href')),
    ...tags(html, 'link').map((t) => attr(t, 'href')),
    ...tags(html, 'script').map((t) => attr(t, 'src')),
    ...tags(html, 'img').map((t) => attr(t, 'src'))
  ].filter(Boolean);

  for (const ref of refs) {
    if (/^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i.test(ref)) continue;
    const clean = ref.split('#')[0].split('?')[0];
    if (!clean) continue;
    const target = clean.startsWith('/') ? join(ROOT, clean) : join(ROOT, clean);
    if (!(await exists(target))) {
      add('error', page, `引用不存在的本地文件：${ref}`);
    }
  }
  // 站内锚点
  for (const href of tags(html, 'a').map((t) => attr(t, 'href') || '').filter((h) => h.startsWith('#') && h.length > 1)) {
    const id = href.slice(1);
    if (!new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html)) {
      add('error', page, `锚点指向不存在的 id：${href}`);
    }
  }

  // 安全 / 混内容
  if (/src="http:\/\//i.test(html) || /href="http:\/\//i.test(html)) add('error', page, '存在 http:// 混内容引用');

  // 页面体积
  const bytes = Buffer.byteLength(html);
  info.push(`${page} HTML ${(bytes / 1024).toFixed(0)}KB`);
  if (bytes > 70 * 1024) add('warn', page, `HTML 体积 ${(bytes / 1024).toFixed(0)}KB（>70KB）`);
}

/* ---------------- 站点级文件 ---------------- */
const sitemapPath = join(ROOT, 'sitemap.xml');
if (!(await exists(sitemapPath))) add('error', 'sitemap.xml', '缺少 sitemap.xml');
else {
  const xml = await readFile(sitemapPath, 'utf8');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeEntities(m[1].trim()));
  if (!locs.length) add('error', 'sitemap.xml', 'sitemap 里没有 URL');
  for (const loc of locs) {
    if (!/^https:\/\//.test(loc)) add('error', 'sitemap.xml', `URL 不是绝对地址：${loc}`);
    const rel = loc.replace(SITE, '').replace(/^\//, '') || 'index.html';
    if (rel.startsWith('blog/')) continue; // 动态博客页由前端渲染
    if (!(await exists(join(ROOT, rel)))) add('error', 'sitemap.xml', `URL 指向不存在的页面：${loc}`);
  }
  for (const p of PUBLIC_PAGES) {
    const urls = p === 'index.html' ? [`${SITE}/`] : [`${SITE}/${p}`];
    if (!urls.some((u) => locs.includes(u))) add('error', 'sitemap.xml', `缺少公开页：${p}`);
  }
  info.push(`sitemap ${locs.length} 条 URL`);
}

const robotsPath = join(ROOT, 'robots.txt');
if (!(await exists(robotsPath))) add('error', 'robots.txt', '缺少 robots.txt');
else {
  const txt = await readFile(robotsPath, 'utf8');
  if (!/sitemap:/i.test(txt)) add('error', 'robots.txt', '没有声明 Sitemap');
  // GEO：让生成式搜索引擎的抓取器可以读到内容
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
    if (!txt.includes(bot)) add('warn', 'robots.txt', `未显式声明 ${bot}（GEO 建议允许抓取）`);
  }
}

const llmsPath = join(ROOT, 'llms.txt');
if (!(await exists(llmsPath))) add('error', 'llms.txt', '缺少 llms.txt（GEO 摘要入口）');
else {
  const txt = await readFile(llmsPath, 'utf8');
  if (txt.length < 500) add('warn', 'llms.txt', '内容过短，建议补充产品事实与关键页面链接');
  for (const p of ['/', '/download.html', '/pricing.html', '/blog.html']) {
    if (!txt.includes(p)) add('warn', 'llms.txt', `未列出关键页面 ${p}`);
  }
}

/* ---------------- 体积预算（构建产物） ---------------- */
async function dirBytes(dir) {
  let total = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await stat(p)).size;
    }
  };
  try { await walk(dir); } catch (_) { /* 目录不存在 */ }
  return total;
}
const bundles = await dirBytes(join(ROOT, 'bundles'));
const assetsDir = await dirBytes(join(ROOT, 'assets'));
const distAll = await dirBytes(ROOT);
info.push(`bundles ${(bundles / 1024 / 1024).toFixed(2)}MB · assets ${(assetsDir / 1024 / 1024).toFixed(2)}MB · dist ${(distAll / 1024 / 1024).toFixed(2)}MB`);

const iconFont = await dirBytes(join(ROOT, 'assets/fonts/material-symbols-outlined.woff2'))
  || (await readdir(join(ROOT, 'bundles')).catch(() => []))
    .filter((f) => f.startsWith('material-symbols')).reduce(async (acc, f) => (await acc) + (await stat(join(ROOT, 'bundles', f))).size, Promise.resolve(0));
if (iconFont > 300 * 1024) add('warn', 'assets/fonts', `图标字体 ${(iconFont / 1024 / 1024).toFixed(2)}MB（应子集化到 <300KB）`);

const tw = await dirBytes(join(ROOT, 'assets/vendor/tailwind.js'));
if (tw) add('error', 'assets/vendor', `仍存在 Tailwind CDN 运行时 ${(tw / 1024).toFixed(0)}KB（应改为构建期预编译的样式表）`);
const twPages = [];
const noCssPages = [];
for (const f of htmlFiles) {
  const html = await readFile(join(ROOT, f), 'utf8');
  if (html.includes('assets/vendor/tailwind.js')) twPages.push(f);
  if (!tags(html, 'link').some((t) => (attr(t, 'rel') || '').toLowerCase() === 'stylesheet')) noCssPages.push(f);
}
if (twPages.length) add('error', 'performance', `${twPages.length} 个页面同步加载 Tailwind 运行时（阻塞首屏渲染）：${twPages.slice(0, 3).join(', ')}`);
if (noCssPages.length) add('error', 'performance', `${noCssPages.length} 个页面没有引用任何样式表：${noCssPages.slice(0, 3).join(', ')}`);

// CSS 体积预算：全站样式表合计应远小于旧的 407KB Tailwind 运行时
let cssBytes = 0;
for (const f of (await readdir(join(ROOT, 'bundles')).catch(() => [])).filter((n) => n.endsWith('.css'))) {
  cssBytes += (await stat(join(ROOT, 'bundles', f))).size;
}
info.push(`CSS 合计 ${(cssBytes / 1024).toFixed(0)}KB`);
if (cssBytes > 250 * 1024) add('warn', 'performance', `CSS 合计 ${(cssBytes / 1024).toFixed(0)}KB（>250KB）`);

for (const img of (await readdir(join(ROOT, 'bundles')).catch(() => [])).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))) {
  const size = (await stat(join(ROOT, 'bundles', img))).size;
  if (size > 300 * 1024) add('warn', 'images', `${img} ${(size / 1024).toFixed(0)}KB（>300KB，建议 WebP/压缩）`);
  if (/\.(jpe?g|png)$/i.test(img) && size > 120 * 1024) add('warn', 'images', `${img} ${(size / 1024).toFixed(0)}KB 为 JPG/PNG（建议转 WebP）`);
}

if (distAll > 8 * 1024 * 1024) add('warn', 'performance', `dist 总体积 ${(distAll / 1024 / 1024).toFixed(1)}MB（建议 < 8MB）`);

/* ---------------- 输出 ---------------- */
console.log('\n===== 静态审计 =====');
for (const line of info) console.log(`· ${line}`);
if (warnings.length) {
  console.log(`\n⚠ 警告 ${warnings.length} 条`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (problems.length) {
  console.log(`\n✗ 错误 ${problems.length} 条`);
  for (const p of problems) console.log(`  - ${p}`);
}
console.log(`\n结果：${problems.length ? 'FAIL' : 'PASS'}（错误 ${problems.length} / 警告 ${warnings.length}）\n`);
process.exit(problems.length ? 1 : 0);
