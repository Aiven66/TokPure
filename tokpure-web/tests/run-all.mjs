/**
 * 一键跑完整个 web 自动化检查：
 *   1) 构建（可选，--build）
 *   2) 静态审计（dist/）
 *   3) 本地服务器 + 运行时审计（Playwright）
 *
 * 用法：
 *   node tests/run-all.mjs            # 用现有 dist
 *   node tests/run-all.mjs --build    # 先构建再测
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const PORT = Number(process.env.PORT || 4173);
const dist = resolve('dist');

const run = (cmd, args) => new Promise((res) => {
  const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
  child.on('close', (code) => res(code ?? 1));
});

let code = 0;

if (process.argv.includes('--build')) {
  console.log('\n▶ 构建 dist/');
  code = await run('npm', ['run', 'build']);
  if (code) process.exit(code);
}

if (!existsSync(dist)) {
  console.error('缺少 dist/，请先执行 npm run build（或加 --build）');
  process.exit(1);
}

console.log('\n▶ 静态审计');
const staticCode = await run('node', ['tests/static-audit.mjs']);

console.log(`\n▶ 运行时审计（http://127.0.0.1:${PORT}）`);
const server = await startServer(dist, PORT);
const runtimeCode = await run('node', ['tests/runtime-audit.mjs']);
await new Promise((r) => server.close(r));

console.log(`\n▶ 汇总：静态 ${staticCode ? 'FAIL' : 'PASS'} · 运行时 ${runtimeCode ? 'FAIL' : 'PASS'}`);
process.exit(staticCode || runtimeCode ? 1 : 0);
