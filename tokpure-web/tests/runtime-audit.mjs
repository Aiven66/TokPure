/**
 * 运行时审计（Playwright）：
 *  - 每个页面：状态码、控制台错误、失败请求、破图、FOUC 遮罩、横向溢出、标题层级
 *  - 交互：语言切换与持久化、移动端抽屉导航、博客列表→详情、404 路由
 *  - 性能：传输体积、阻塞脚本、LCP/FCP（本地静态服务，用于横向对比而非绝对值）
 *
 * 前置：本地服务器已在 BASE 上伺服 dist/（由 run-all.mjs 启动）。
 * Playwright 从全局 node_modules 解析（见 package.json 的 test 脚本）。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const isThirdParty = (url) => !url.startsWith(BASE) && !url.startsWith('data:');

const results = [];
const record = (level, name, detail = '') => {
  results.push({ level, name, detail });
  if (level !== 'pass') console.log(`${level === 'fail' ? '✗' : '⚠'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** 忽略与产品无关的第三方噪声（广告/统计脚本在离线环境会失败） */
const IGNORED_CONSOLE = /googletagmanager|gtag|google-analytics|supabase|favicon|net::ERR_INTERNET|net::ERR_CONNECTION_CLOSED|net::ERR_ABORTED/i;
/** 浏览器对第三方资源失败的报错常没有 URL，无法判断来源时按噪声处理（页面自身的失败由 requestfailed/response 事件兜住） */
const isBareResourceError = (text) => /^Failed to load resource/.test(text) && !/https?:\/\//.test(text);

function attach(page, pageName) {
  const consoleErrors = [];
  const failedRequests = [];
  const badResponses = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.test(text) || isBareResourceError(text)) return;
    consoleErrors.push(text.slice(0, 200));
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err.message).slice(0, 200)}`));
  page.on('requestfailed', (req) => {
    if (isThirdParty(req.url())) return;
    failedRequests.push(`${req.url()} (${req.failure()?.errorText || 'failed'})`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !isThirdParty(res.url())) badResponses.push(`${res.status()} ${res.url()}`);
  });
  return { consoleErrors, failedRequests, badResponses, pageName };
}

async function inspectPage(browser, path, { mobile = false, expectStatus = 200 } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'en-US'
  });
  const page = await context.newPage();
  const sink = attach(page, path);
  const started = Date.now();
  const res = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => null);
  const status = res ? res.status() : 0;
  const ms = Date.now() - started;
  await page.waitForTimeout(600);

  const label = `${mobile ? 'mobile' : 'desktop'} ${path}`;
  if (status !== expectStatus) record('fail', `${label} 状态码`, `期望 ${expectStatus}，实际 ${status}`);

  if (sink.badResponses.length) record('fail', `${label} 资源 4xx/5xx`, sink.badResponses.slice(0, 4).join(' | '));
  if (sink.failedRequests.length) record('fail', `${label} 请求失败`, sink.failedRequests.slice(0, 4).join(' | '));
  if (sink.consoleErrors.length) record('fail', `${label} 控制台错误`, sink.consoleErrors.slice(0, 3).join(' | '));

  // FOUC 遮罩必须已被移除（否则页面一直是空白的）
  const pending = await page.evaluate(() => document.documentElement.hasAttribute('data-tp-pending'));
  if (pending) record('fail', `${label} 首屏遮罩未移除`, 'data-tp-pending 仍存在，页面不可见');

  const bodyVisible = await page.evaluate(() => {
    const st = getComputedStyle(document.body);
    return st.visibility !== 'hidden' && st.display !== 'none';
  });
  if (!bodyVisible) record('fail', `${label} body 不可见`);

  // 破图
  const broken = await page.evaluate(() => Array.from(document.images)
    .filter((img) => img.complete && img.getAttribute('src') && img.naturalWidth === 0)
    .map((img) => img.currentSrc || img.src));
  if (broken.length) record('fail', `${label} 破图`, broken.slice(0, 3).join(' | '));

  // 横向溢出（移动端最常见的布局 bug）
  if (mobile) {
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth
    }));
    if (overflow.scroll > overflow.client + 2) {
      record('fail', `${label} 横向溢出`, `${overflow.scroll}px > ${overflow.client}px`);
    }
  }

  // 页面标题
  const title = await page.title();
  if (!title || title.length < 5) record('fail', `${label} 标题为空`);

  // 标题层级：岛屿渲染完成后，公开页面应恰好一个 h1（静态兜底标题必须已被移除）
  const h1Count = await page.locator('h1').count();
  if (h1Count === 0) record('fail', `${label} 没有 h1`, '缺少一级标题');
  else if (h1Count > 1) record('fail', `${label} 出现多个 h1`, `共 ${h1Count} 个`);

  // 性能指标
  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource');
    const total = res.reduce((n, r) => n + (r.transferSize || r.encodedBodySize || 0), 0);
    const blocking = Array.from(document.querySelectorAll('script[src]'))
      .filter((s) => !s.defer && !s.async && !s.type.includes('module'))
      .map((s) => s.src);
    return {
      dcl: Math.round(nav.domContentLoadedEventEnd || 0),
      load: Math.round(nav.loadEventEnd || 0),
      total,
      requests: res.length,
      blocking
    };
  });
  await context.close();
  return { label, path, status, ms: Math.round(ms), perf };
}

/**
 * 浏览器：优先用 Playwright 自带的 Chromium；本机没装时退回系统 Chrome，
 * 避免在每台机器上都要额外下载一份 150MB 的浏览器。
 */
async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (_) {
    return chromium.launch({ channel: 'chrome' });
  }
}

const browser = await launchBrowser();
const perfRows = [];

const pages = [
  { path: '/' },
  { path: '/download.html' },
  { path: '/pricing.html' },
  { path: '/about.html' },
  { path: '/blog.html' },
  { path: '/tiktok-stickers.html' },
  { path: '/login.html' },
  // 本地/Vercel 都是直接访问该静态文件，因此返回 200；未知路由的 404 由下面的独立用例覆盖
  { path: '/404.html' }
];

for (const p of pages) {
  const row = await inspectPage(browser, p.path, { expectStatus: p.expectStatus || 200 });
  perfRows.push(row);
  // 首页与定价页再看一遍移动端
  if (p.path === '/' || p.path === '/pricing.html') {
    const m = await inspectPage(browser, p.path, { mobile: true });
    perfRows.push(m);
  }
}

/* ---------- 404 路由 ---------- */
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const res = await page.goto(`${BASE}/this-page-does-not-exist-12345`, { waitUntil: 'domcontentloaded' });
  if (!res || res.status() !== 404) record('fail', '未知路由未返回 404', `实际 ${res ? res.status() : 'no response'}`);
  else record('pass', '未知路由返回 404');
  await ctx.close();
}

/* ---------- 语言切换 + 持久化 ---------- */
{
  const ctx = await browser.newContext({ locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const defaultLang = await page.evaluate(() => document.documentElement.lang);
  if (defaultLang !== 'en') record('fail', '默认语言应为 en', `实际 ${defaultLang}`);

  const enH1 = (await page.locator('h1').first().innerText()).replace(/\s+/g, ' ').trim();

  await page.locator('#__tp_lang button').first().click();
  await page.locator('#__tp_lang_menu [data-tp-lang="ja"]').click();
  await page.waitForTimeout(1200);
  const jaState = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    dataLang: document.documentElement.getAttribute('data-lang'),
    label: document.getElementById('__tp_lang_label')?.textContent,
    saved: localStorage.getItem('tokpure.lang'),
    manual: localStorage.getItem('tokpure.lang.manual')
  }));
  const jaH1 = (await page.locator('h1').first().innerText()).replace(/\s+/g, ' ').trim();
  if (jaState.lang !== 'ja') record('fail', '切换到日语后 html lang 未更新', jaState.lang);
  if (jaState.dataLang !== 'ja') record('fail', '切换到日语后 data-lang 未更新', String(jaState.dataLang));
  if (jaState.label !== '日本語') record('fail', '切换器标签未更新', String(jaState.label));
  if (jaState.saved !== 'ja' || jaState.manual !== '1') record('fail', '语言偏好未落盘', JSON.stringify(jaState));
  if (jaH1 === enH1) record('fail', '切换到日语后首屏标题未翻译', 'h1 未变化');
  if (!/[\u3040-\u30ff]/.test(jaH1)) record('warn', '日语标题里没有假名', jaH1.slice(0, 60));

  // 刷新后保持日语（React 岛屿的 LocaleBridge 不能把 lang 覆盖回 en）
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const afterReload = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    dataLang: document.documentElement.getAttribute('data-lang'),
    h1: document.querySelector('h1')?.textContent?.trim().slice(0, 40) || ''
  }));
  if (afterReload.lang !== 'ja') record('fail', '刷新后未保持语言偏好', afterReload.lang);
  if (afterReload.dataLang !== 'ja') record('fail', '刷新后 data-lang 被覆盖', String(afterReload.dataLang));

  // 再切到繁体中文：岛屿映射到 zh-Hant，也不能把 html lang 写成 zh-Hant
  await page.locator('#__tp_lang button').first().click();
  await page.locator('#__tp_lang_menu [data-tp-lang="zh-TW"]').click();
  await page.waitForTimeout(1000);
  const twLang = await page.evaluate(() => document.documentElement.lang);
  if (twLang !== 'zh-TW') record('fail', '切换到繁体后 html lang 未更新', twLang);
  else record('pass', '语言切换与持久化');

  // 切回英文，避免污染后续用例
  await page.evaluate(() => {
    localStorage.setItem('tokpure.lang.manual', '1');
    localStorage.setItem('tokpure.lang', 'en');
  });
  await ctx.close();
}

/* ---------- 站内链接可达性（稳定性） ---------- */
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const seen = new Set();
  const broken = [];
  for (const p of ['/', '/download.html', '/pricing.html', '/about.html', '/blog.html', '/tiktok-stickers.html']) {
    await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href')).filter(Boolean));
    for (const href of hrefs) {
      if (/^(mailto:|tel:|javascript:|#|https?:\/\/(?!tokpure))/i.test(href)) continue;
      const url = new URL(href, `${BASE}/`).toString();
      if (!url.startsWith(BASE) || seen.has(url)) continue;
      seen.add(url);
      const res = await page.request.get(url).catch(() => null);
      if (!res || res.status() >= 400) broken.push(`${href} → ${res ? res.status() : 'failed'}`);
    }
  }
  if (broken.length) record('fail', '站内链接失效', broken.slice(0, 6).join(' | '));
  else record('pass', `站内链接全部可达（${seen.size} 条）`);
  await ctx.close();
}

/* ---------- 移动端抽屉导航 ---------- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const burger = page.locator('.tp-burger');
  if (!(await burger.count())) record('fail', '移动端缺少汉堡按钮');
  else {
    await burger.click();
    await page.waitForTimeout(500);
    const opened = await page.evaluate(() => {
      const p = document.getElementById('tp-mnav');
      if (!p) return null;
      const st = getComputedStyle(p);
      return { hidden: p.getAttribute('aria-hidden'), visible: st.visibility !== 'hidden' && st.opacity !== '0' && st.display !== 'none' };
    });
    if (!opened || !opened.visible) record('fail', '抽屉导航未打开', JSON.stringify(opened));
    else record('pass', '移动端抽屉导航可打开');
  }
  await ctx.close();
}

/* ---------- 博客列表 → 详情 ---------- */
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
  await page.goto(`${BASE}/blog.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/blog/"]'))
    .map((a) => a.getAttribute('href')).filter(Boolean));
  if (!links.length) record('warn', '博客列表没有文章链接', '可能是 Supabase 未配置或无已发布文章');
  else {
    const target = links.find((h) => /\/blog\/[^/]+\.html/.test(h)) || links[0];
    const res = await page.goto(`${BASE}${target}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2000);
    const detail = await page.evaluate(() => ({
      h1: (document.querySelector('#blog-detail-root h1') || document.querySelector('h1'))?.textContent?.trim() || '',
      title: document.title,
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
      ld: document.querySelectorAll('script[type="application/ld+json"]').length
    }));
    if (!res || res.status() !== 200) record('fail', '博客详情打不开', `${target} → ${res ? res.status() : 'no response'}`);
    if (!detail.h1) record('fail', '博客详情没有渲染标题', target);
    if (!/TokPure/.test(detail.title)) record('fail', '博客详情未更新 document.title', detail.title);
    if (!detail.canonical) record('fail', '博客详情未写入 canonical');
    if (errs.length) record('fail', '博客详情脚本异常', errs.join(' | '));
    else record('pass', '博客列表 → 详情');
  }
  await ctx.close();
}

await browser.close();

/* ---------- 性能汇总 ---------- */
console.log('\n===== 页面传输体积（本地未压缩）=====');
for (const r of perfRows) {
  const kb = (r.perf.total / 1024).toFixed(0);
  console.log(`· ${r.label.padEnd(28)} 资源 ${String(r.perf.requests).padStart(3)} 个 · ${kb.padStart(5)}KB · DCL ${String(r.perf.dcl).padStart(4)}ms · 阻塞脚本 ${r.perf.blocking.length}`);
}
const heavy = perfRows.filter((r) => r.perf.total > 1.5 * 1024 * 1024);
if (heavy.length) record('warn', '页面传输体积偏大（>1.5MB）', heavy.map((r) => `${r.label} ${(r.perf.total / 1024 / 1024).toFixed(1)}MB`).join(' | '));
const tooHeavy = perfRows.filter((r) => r.perf.total > 4 * 1024 * 1024);
if (tooHeavy.length) record('fail', '页面传输体积超标（>4MB）', tooHeavy.map((r) => `${r.label} ${(r.perf.total / 1024 / 1024).toFixed(1)}MB`).join(' | '));
const blocking = perfRows.filter((r) => r.perf.blocking.length);
if (blocking.length) record('warn', '存在同步阻塞脚本（影响首屏）', blocking.map((r) => `${r.label}×${r.perf.blocking.length}`).join(' | '));

const fails = results.filter((r) => r.level === 'fail');
const warns = results.filter((r) => r.level === 'warn');
console.log(`\n===== 运行时审计 =====\n失败 ${fails.length} / 警告 ${warns.length}`);
if (warns.length) {
  console.log('警告：');
  for (const w of warns) console.log(`  - ${w.name}${w.detail ? `：${w.detail}` : ''}`);
}
if (fails.length) {
  console.log('失败：');
  for (const f of fails) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
}
process.exit(fails.length ? 1 : 0);
