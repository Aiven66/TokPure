import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * 官网的 assets/ 里有三类「运行时按原路径加载」的静态资源，Vite 不会改写也不会哈希：
 *   vendor/tailwind.js（Tailwind CDN）、js/*.js（i18n 脚本）、i18n/*.json（运行时 fetch）。
 * 构建后必须仍在 dist/assets/ 下，否则页面 404。其余图片/字体/CSS 都由 Vite 处理成
 * 带哈希的 /bundles/*，无需重复拷贝。
 */
function copyRuntimeAssets(): Plugin {
  const src = resolve(root, 'assets');
  const runtimeDirs = ['vendor', 'js', 'i18n'];
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
    },
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
    plugins: [resolvePublicPkgDeps(), copyRuntimeAssets(), react()],
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