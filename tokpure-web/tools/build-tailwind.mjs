#!/usr/bin/env node
/**
 * 构建期生成 Tailwind CSS，替代运行时 CDN JIT（assets/vendor/tailwind.js，407KB 同步阻塞）。
 *
 * 产物：assets/css/tailwind.build.css（压缩）
 * 用法：node tools/build-tailwind.mjs
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'assets/css/tailwind.build.css');

// safelist 文件可能不存在：先保证存在，避免 content 配置告警
const SNAPSHOT = resolve(root, 'tools/tailwind-safelist.txt');
try {
  await stat(SNAPSHOT);
} catch {
  await writeFile(SNAPSHOT, '# 运行时动态类名快照（由 tools/capture-dynamic-classes.cjs 生成，一行一个）\n');
}

await run(
  resolve(root, 'node_modules/.bin/tailwindcss'),
  ['-c', 'tailwind.config.js', '-i', 'tools/tailwind.input.css', '-o', out, '--minify'],
  { cwd: root },
);

const { size } = await stat(out);
const css = await readFile(out, 'utf8');
console.log(`✔ tailwind.build.css  ${(size / 1024).toFixed(1)}KB  规则数 ${(css.match(/\}/g) || []).length}`);
