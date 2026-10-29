/**
 * Tailwind 构建期配置（替代运行时 CDN JIT）。
 *
 * 主题值唯一真源：tools/tailwind-theme.json（原先内联在每个 HTML 的
 * `<script id="tailwind-config">` 里，现已抽成一份文件，避免 11 页重复维护），
 * 并合并 assets/js/tailwind-tokens.js 注入的 shadcn 语义色 token。
 *
 * 重新生成样式：npm run build:css（npm run build 会先跑这一步）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Tailwind CLI 通过 jiti 以 CJS 方式加载本文件，因此不能用 import.meta.dirname；
// CLI 总是在仓库根目录执行（npm run build:css），所以用 cwd 作为根路径。
const root = process.cwd();
const { theme } = JSON.parse(readFileSync(resolve(root, 'tools/tailwind-theme.json'), 'utf8'));
const extend = theme.extend;

/** shadcn/ui 语义 token（与 assets/js/tailwind-tokens.js 保持一致） */
const shadcnTokens = {
  foreground: '#e2e2e8',
  background: '#111317',
  card: '#1e2024',
  'card-foreground': '#e2e2e8',
  popover: '#1e2024',
  'popover-foreground': '#e2e2e8',
  'primary-foreground': '#680019',
  'secondary-foreground': '#003735',
  muted: '#282a2e',
  'muted-foreground': '#ad8889',
  accent: '#282a2e',
  'accent-foreground': '#e2e2e8',
  destructive: '#ffb4ab',
  'destructive-foreground': '#690005',
  border: '#5d3f40',
  input: '#5d3f40',
  ring: '#ffb3b6',
};
for (const [key, value] of Object.entries(shadcnTokens)) {
  if (!(key in extend.colors)) extend.colors[key] = value;
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './*.html',
    './src/**/*.{ts,tsx}',
    './assets/js/*.js',
    '../public-pkg/**/*.{ts,tsx}',
    // 博客正文里的历史类名兜底（tools/capture-dynamic-classes.cjs 生成）
    './tools/tailwind-safelist.txt',
  ],
  theme: { extend },
  plugins: [],
};
