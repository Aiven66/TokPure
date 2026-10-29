import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * 官网的 assets/ 里有几类「运行时按原路径加载」的静态资源，Vite 不会改写也不会哈希：
 *   js/*.js（i18n / 移动端导航脚本）、i18n/*.json（运行时 fetch）、
 *   og/*.jpg（社交分享图，必须保持稳定 URL，否则 og:image 会随哈希变化而失效）。
 * 构建后必须仍在 dist/assets/ 下，否则页面 404。其余图片/字体/CSS 都由 Vite 处理成
 * 带哈希的 /bundles/*，无需重复拷贝。
 *
 * 注：Tailwind 已改为构建期预编译（tools/build-tailwind.mjs → assets/css/tailwind.build.css），
 * 不再有 vendor/tailwind.js 这个 407KB 的同步阻塞脚本。
 */
function copyRuntimeAssets(): Plugin {
  const src = resolve(root, 'assets');
  const runtimeDirs = ['js', 'i18n', 'og'];
  return {
    name: 'tokpure:copy-runtime-assets',
    apply: 'build',
    writeBundle() {
      const out = resolve(root, 'dist/assets');
      mkdirSync(out, { recursive: true });
      for (const dir of runtimeDirs) {
        const from = resolve(src, dir);
        if (existsSync(from)) cpSync(from, resolve(out, dir), { recursive: true });
      }
      // 站点级 SEO 文件（不属于 assets，必须落在站点根）
      for (const file of ['robots.txt', 'llms.txt']) {
        const from = resolve(root, file);
        if (existsSync(from)) cpSync(from, resolve(root, 'dist', file));
      }
    },
  };
}

const SITE_URL = 'https://tokpure.clipopai.com';
/** 固定收录的公开页面（登录、后台、回调、404 不进 sitemap） */
const STATIC_ROUTES: Array<{ path: string; priority: string }> = [
  { path: '/', priority: '1.0' },
  { path: '/download.html', priority: '0.9' },
  { path: '/pricing.html', priority: '0.9' },
  { path: '/tiktok-stickers.html', priority: '0.8' },
  { path: '/about.html', priority: '0.6' },
  { path: '/blog.html', priority: '0.7' }
];

/**
 * 与 public-pkg/blog/blog-model.ts 的 slugifyTitle 保持一致：
 * sitemap 里的文章 URL 必须和前台实际生成的 URL 完全相同，否则收录到的是 404。
 */
function slugifyTitle(title: string): string {
  return (
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u0590-\u05FF\u0600-\u06FF\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 构建期生成 sitemap.xml：静态页面 + Supabase 已发布博客文章。
 * 取不到数据（无环境变量 / 断网 / 表结构变化）时静默降级为仅静态页面，
 * 绝不让 SEO 的附加产物影响正常构建。
 */
function emitSitemap(env: Record<string, string>): Plugin {
  return {
    name: 'tokpure:emit-sitemap',
    apply: 'build',
    async writeBundle() {
      const baseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
      const anonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '';
      const today = new Date().toISOString().slice(0, 10);

      const urls: Array<{ loc: string; lastmod: string; priority: string }> = STATIC_ROUTES.map((r) => ({
        loc: `${SITE_URL}${r.path}`,
        lastmod: today,
        priority: r.priority
      }));

      if (baseUrl && anonKey) {
        try {
          const q = '/rest/v1/blogs?select=id,title,updated_at,created_at&is_published=eq.true&order=created_at.desc&limit=500';
          const res = await fetch(`${baseUrl}${q}`, {
            headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
            signal: AbortSignal.timeout(5000)
          });
          if (res.ok) {
            const rows = (await res.json()) as Array<{ id: string; title: string; updated_at?: string; created_at?: string }>;
            for (const row of rows) {
              if (!row || !row.id || !row.title) continue;
              const shortId = String(row.id).replace(/-/g, '').slice(0, 8).toLowerCase();
              urls.push({
                loc: `${SITE_URL}/blog/${slugifyTitle(row.title)}-${shortId}.html`,
                lastmod: String(row.updated_at || row.created_at || today).slice(0, 10),
                priority: '0.6'
              });
            }
          }
        } catch (_) {
          // 构建期拿不到博客数据时保持静态 sitemap，不影响构建
        }
      }

      const body = urls
        .map(
          (u) =>
            `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <priority>${u.priority}</priority>\n  </url>`
        )
        .join('\n');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
      writeFileSync(resolve(root, 'dist/sitemap.xml'), xml, 'utf8');
    }
  };
}

/**
 * public-pkg 位于仓库根目录（本工程之外），它自己的裸模块导入（react / clsx /
 * lucide-react / @supabase/supabase-js / @radix-ui/* …）无法从自身位置向上找到
 * node_modules（仓库根没有）。这里把「来自 public-pkg 的裸导入」强制按本工程的
 * node_modules 解析，既单一真源、不复制源码，也保证 react 只有一份实例。
 */
function resolvePublicPkgDeps(): Plugin {
  const anchor = resolve(root, 'src/pkg-import-anchor.ts');
  return {
    name: 'tokpure:resolve-public-pkg-deps',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!importer || !importer.includes('/public-pkg/')) return null;
      if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) return null;
      const resolved = await this.resolve(source, anchor, { skipSelf: true });
      return resolved ?? null;
    },
  };
}

/**
 * 多页应用：仓库根目录下的每个 .html 都作为一个入口。
 * 这样 index/about/download/login/pricing 这些既有静态页保持原样，
 * 只在其内部新增的容器上挂载 React 岛屿（public-pkg 公共组件）。
 */
function htmlEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const file of readdirSync(root)) {
    if (!file.endsWith('.html') || file.startsWith('.')) continue;
    const name = file.replace(/\.html$/, '');
    entries[name === 'index' ? 'main' : name] = resolve(root, file);
  }
  return entries;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  return {
    plugins: [resolvePublicPkgDeps(), copyRuntimeAssets(), emitSitemap({ ...(process.env as Record<string, string>), ...env }), react()],
    // assets/ 不做 publicDir（否则会被拷到 dist 根而非 dist/assets），
    // 由 copyRuntimeAssets 精确拷贝运行时资源；打包产物放 dist/bundles。
    publicDir: false,
    resolve: {
      alias: [
        // public-pkg 是「自包含源码目录」，直接以源码形式引用，不做构建发布
        { find: /^@pkg$/, replacement: resolve(root, '../public-pkg/index.ts') },
        { find: /^@pkg\/(.*)$/, replacement: resolve(root, '../public-pkg/$1') },
        // public-pkg 内 6 个文件使用 next/navigation、next/link，这里用轻量 shim 替代
        { find: /^next\/navigation$/, replacement: resolve(root, 'src/shims/next-navigation.tsx') },
        { find: /^next\/link$/, replacement: resolve(root, 'src/shims/next-link.tsx') },
        { find: /^@\/(.*)$/, replacement: resolve(root, 'src/$1') },
      ],
    },
    define: {
      // public-pkg 的 resolveSupabaseCredentials 会读 process.env；浏览器端统一兜空。
      // 实际连接信息由 src/lib/pkg-config.ts 通过 config.supabase 显式注入。
      'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL || ''),
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY || ''),
      'process.env.COZE_SUPABASE_URL': '""',
      'process.env.COZE_SUPABASE_ANON_KEY': '""',
    },
    server: {
      fs: { allow: [root, resolve(root, '../public-pkg')] },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      assetsDir: 'bundles',
      rollupOptions: { input: htmlEntries() },
    },
  };
});