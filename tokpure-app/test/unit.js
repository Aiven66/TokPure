'use strict';

/* ============================================================
   TokPure 单元测试（纯 Node，不需要 Electron 运行时）
   npm test

   覆盖 3.9.27 的三件事：
   1) 每个桌面引擎都有 Windows 资产（否则 Windows 端功能一定缺）
   2) Windows 安装包带齐 AI 口播/切片/分离需要的资源
   3) SAPI 音色解析与挑选逻辑（Windows TTS 不再只有「系统默认」）
   ============================================================ */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, message: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

/* ---------------- 1. 引擎资产覆盖 ---------------- */
const hubSrc = read('electron/enginehub.js');
const engineIds = ['whisper', 'realsr', 'realcugan', 'rife', 'llamacpp'];

function engineBlock(id) {
  const start = hubSrc.indexOf(`id: '${id}'`);
  assert.ok(start >= 0, `enginehub.js 里找不到引擎 ${id}`);
  const next = hubSrc.slice(start + 1).search(/\n\s*id: '/);
  return next >= 0 ? hubSrc.slice(start, start + 1 + next) : hubSrc.slice(start);
}

test('每个引擎都声明 win32-x64 资产', () => {
  for (const id of engineIds) {
    assert.ok(/'win32-x64':/.test(engineBlock(id)), `${id} 缺少 win32-x64 资产`);
  }
});

test('whisper 的 Windows 资产指向 whisper.cpp 官方 x64 构建包', () => {
  const block = engineBlock('whisper');
  const m = block.match(/'win32-x64':[\s\S]*?url: '([^']+)'/);
  assert.ok(m, 'whisper 没有 win32-x64 url');
  assert.ok(/whisper\.cpp\/releases\/download\/[^/]+\/whisper-(blas-)?bin-x64\.zip$/.test(m[1]), `whisper Windows 资产 URL 异常：${m[1]}`);
});

test('whisper 的 Windows 可执行文件名是 whisper-cli.exe', () => {
  const block = engineBlock('whisper');
  assert.ok(/bin: \(\) => exe\('whisper-cli'\)/.test(block), 'whisper bin 名称不对');
});

/* ---------------- 2. 安装包资源 ---------------- */
const pkg = JSON.parse(read('package.json'));

test('版本号是 3.x 且为发布格式', () => {
  assert.ok(/^3\.\d+\.\d+$/.test(pkg.version), `版本号异常：${pkg.version}`);
});

test('Windows 包已带上克隆引擎、音轨分离、口型与 ffmpeg.exe', () => {
  const res = (pkg.build.win.extraResources || []).map((r) => r.from);
  for (const need of ['resources/bin/ffmpeg.exe', 'resources/voiceclone', 'resources/audiosep', 'resources/lipsync', 'resources/audio']) {
    assert.ok(res.includes(need), `Windows extraResources 缺少 ${need}`);
  }
});

test('macOS 包仍带上克隆引擎与音轨分离', () => {
  const res = (pkg.build.mac.extraResources || []).map((r) => r.from);
  for (const need of ['resources/bin/ffmpeg', 'resources/voiceclone', 'resources/audiosep', 'resources/lipsync']) {
    assert.ok(res.includes(need), `macOS extraResources 缺少 ${need}`);
  }
});

test('构建文件清单不包含测试目录（不进安装包）', () => {
  assert.ok(!(pkg.build.files || []).some((p) => String(p).includes('test/')), '测试目录被打进了安装包');
});

/* ---------------- 3. SAPI 音色逻辑 ---------------- */
const sapi = require(path.join(ROOT, 'electron', 'sapi.js'));

const SAMPLE = [
  'Microsoft Zira Desktop|en-US|Female',
  'Microsoft David Desktop|en-US|Male',
  'Microsoft Huihui Desktop|zh-CN|Female',
  'Microsoft Haruka Desktop|ja-JP|Female',
  'Microsoft Heami Desktop|ko-KR|Female',
  'Microsoft Sabina Desktop|es-MX|Female',
  'Microsoft Maria Desktop|pt-BR|Female',
  'Microsoft Hortense Desktop|fr-FR|Female',
  'Microsoft Hedda Desktop|de-DE|Female'
].join('\r\n');

test('能解析 PowerShell 枚举出的音色行', () => {
  const rows = sapi.parseSapiVoices(SAMPLE);
  assert.strictEqual(rows.length, 9);
  assert.strictEqual(rows[0].name, 'Microsoft Zira Desktop');
  assert.strictEqual(rows[0].culture, 'en-US');
  assert.strictEqual(rows[0].gender, 'f');
});

test('兼容 CRLF、空行与噪声输出', () => {
  const rows = sapi.parseSapiVoices('\r\n\r\nfoo bar\r\nMicrosoft Zira Desktop|en-US|Female\r\n\r\n');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Microsoft Zira Desktop');
});

test('按语言挑默认音色，并尊重性别偏好', () => {
  const rows = sapi.parseSapiVoices(SAMPLE);
  assert.strictEqual(sapi.chooseVoice(rows, 'en', '', 'm'), 'Microsoft David Desktop');
  assert.strictEqual(sapi.chooseVoice(rows, 'en'), 'Microsoft Zira Desktop');
  assert.strictEqual(sapi.chooseVoice(rows, 'zh'), 'Microsoft Huihui Desktop');
  assert.strictEqual(sapi.chooseVoice(rows, 'ja'), 'Microsoft Haruka Desktop');
  assert.strictEqual(sapi.chooseVoice(rows, 'xx'), null);
});

test('用户显式指定的音色优先，无效名字回落到默认', () => {
  const rows = sapi.parseSapiVoices(SAMPLE);
  assert.strictEqual(sapi.chooseVoice(rows, 'en', 'Microsoft David Desktop'), 'Microsoft David Desktop');
  assert.strictEqual(sapi.chooseVoice(rows, 'en', 'Not Installed'), 'Microsoft Zira Desktop');
});

test('voiceEntry 与 macOS 侧字段结构一致', () => {
  const rows = sapi.parseSapiVoices(SAMPLE);
  const e = sapi.voiceEntry(rows[0]);
  for (const k of ['name', 'base', 'locale', 'gender', 'style', 'tier', 'label']) {
    assert.ok(k in e, `voiceEntry 缺少字段 ${k}`);
  }
  assert.strictEqual(e.locale, 'en_US');
});

/* ---------------- 4. 硬约束 ---------------- */
test('源码里不存在生效的 anlmdn 噪声参数（成片噪音回归）', () => {
  const files = fs.readdirSync(path.join(ROOT, 'electron')).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = read(path.join('electron', f));
    assert.ok(!/['"]?anlmdn=s=/i.test(src), `${f} 里出现了 anlmdn=s= 参数`);
  }
});

test('Windows 与 macOS 的 TTS 链路都在（say / PowerShell System.Speech）', () => {
  const src = read('electron/localize.js');
  assert.ok(/await run\('say',/.test(src), '缺少 macOS say 合成');
  assert.ok(/System\.Speech/.test(src), '缺少 Windows System.Speech 合成');
  assert.ok(/SelectVoice/.test(src), 'Windows 合成没有选择音色');
});

test('安装克隆引擎的流程存在（venv + pip + 校验 import）', () => {
  const src = read('electron/voicelocal.js');
  assert.ok(/async function install/.test(src), 'voicelocal 没有 install');
  assert.ok(/-m', 'venv'/.test(src), '没有创建 venv');
  assert.ok(/import torch, numpy, librosa, cv2, soundfile, chatterbox/.test(src), '缺少依赖校验');
  assert.ok(/download\.pytorch\.org\/whl\/cpu/.test(read('electron/voicelocal.js')), 'Windows 没有用 torch CPU 轮子源');
});

/* ---------------- 汇总 ---------------- */
console.log(`\n${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  failures.forEach((f) => console.log(` - ${f.name}: ${f.message}`));
  process.exit(1);
}
