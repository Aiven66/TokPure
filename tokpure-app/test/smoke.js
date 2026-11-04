'use strict';

/* ============================================================
   TokPure 冒烟测试（在 Electron 运行时里跑，macOS / Windows 通用）
   npm run test:smoke

   验证「安装完能不能真的用」：
   - FFmpeg 能解析到并成功执行（3.9.26 起固化到 userData）
   - 当前平台有 Whisper 引擎资产（Windows 3.9.27 新补）
   - 8 种目标语言都有音色目录（Windows 走 SAPI 枚举）
   - 真的合成一句 wav（macOS: say；Windows: System.Speech）
   - 报告 Python 可用性（克隆/口型引擎的安装前提）
   ============================================================ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { app } = require('electron');

const LANGS = ['zh', 'en', 'ja', 'ko', 'es', 'pt', 'fr', 'de'];
const failures = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failures.push(m); console.log(`  ✗ ${m}`); };

function assertTrue(cond, msg) {
  if (cond) ok(msg); else bad(msg);
}

/** 跑一个可执行文件并收集 stdout+stderr（Windows 上 `-h` 会写 stderr） */
function runCapture(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

async function main() {
  console.log(`[smoke] platform=${process.platform} arch=${process.arch} electron=${process.versions.electron}`);

  /* 1) FFmpeg */
  const ffmpeg = require('../electron/ffmpeg');
  const ff = await ffmpeg.ensure();
  assertTrue(!!ff.ok, `FFmpeg 自检：${ff.ok ? (ff.version || ff.path) + ' (' + (ff.source || '?') + ')' : '失败 ' + JSON.stringify(ff)}`);

  /* 2) 引擎资产 */
  const hub = require('../electron/enginehub');
  const st = hub.status();
  const whisper = st.engines.find((e) => e.id === 'whisper');
  assertTrue(!!(whisper && whisper.supported), `Whisper 引擎在本平台有资产（${whisper ? whisper.downloadSize : 0} 字节）`);
  for (const id of ['realsr', 'realcugan', 'rife', 'llamacpp']) {
    const e = st.engines.find((x) => x.id === id);
    assertTrue(!!(e && e.supported), `引擎 ${id} 在本平台有资产`);
  }

  /* 3) 音色目录 */
  const localize = require('../electron/localize');
  const cat = await localize.voices();
  for (const l of LANGS) {
    const entry = cat && cat[l];
    assertTrue(!!(entry && Array.isArray(entry.list) && entry.list.length >= 1), `音色目录 ${l}：${entry && entry.list ? entry.list.length : 0} 项，默认 ${entry && entry.default ? entry.default : '系统默认'}`);
  }

  /* 3b) 可选：真装一次 Whisper 引擎并跑起来（CI 上开，验证 Windows 资产/解压/DLL 齐全）
     TOKPURE_SMOKE_INSTALL=1 时才跑，避免日常冒烟联网。 */
  if (process.env.TOKPURE_SMOKE_INSTALL === '1') {
    try {
      const emit = (e) => {
        if (e && e.phase === 'download' && e.percent >= 0 && e.percent >= 99) console.log('    whisper 下载完成');
      };
      await hub.installEngine('whisper', null, emit);
      const bin = hub.engineBin('whisper');
      assertTrue(!!bin && fs.existsSync(bin), `Whisper 引擎安装完成：${bin}`);
      if (bin && fs.existsSync(bin)) {
        const help = await runCapture(bin, ['-h']);
        assertTrue(help.length > 0 && /whisper|usage/i.test(help), `Whisper 可执行（输出 ${help.length} 字节）`);
      }
    } catch (e) {
      bad('Whisper 引擎安装/执行失败：' + (e && e.message));
    }
  }

  /* 4) 真合成一句 */
  const out = path.join(app.getPath('temp'), 'tokpure-smoke-tts.wav');
  try { fs.unlinkSync(out); } catch (_) {}
  try {
    await localize.synthForTest('This is a TokPure smoke test sentence.', out, 'en');
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    assertTrue(size > 20000, `TTS 合成成功：${size} 字节`);
  } catch (e) {
    bad('TTS 合成失败：' + (e && e.message));
  }
  try { fs.unlinkSync(out); } catch (_) {}

  /* 5) Python（克隆/口型引擎的安装前提；CI 上仅报告） */
  const voicelocal = require('../electron/voicelocal');
  try {
    const py = await voicelocal.findPython();
    if (py.ok) console.log(`  ✓ Python：${py.version} (${py.cmd})`);
    else console.log(`  ! Python：${py.reason}`);
  } catch (e) {
    console.log('  ! Python 探测异常：' + (e && e.message));
  }
  const vs = voicelocal.status();
  // 开发态 app.getName() 是 Electron，userData 与正式安装不同，不能当成「引擎缺失」
  const devNote = app.isPackaged ? '' : '（开发态 userData 不同，仅供参考）';
  console.log(`  ${vs.installed ? '✓' : '!'} 本地克隆引擎：${vs.installed ? '已安装' : '未安装，首次运行「AI多语口播」会自动安装'}${devNote}`);

  console.log(`[smoke] ${failures.length ? 'FAILED' : 'PASSED'} (${failures.length} 项失败)`);
  process.exitCode = failures.length ? 1 : 0;
}

app.whenReady()
  .then(main)
  .catch((e) => {
    console.error('[smoke] 异常：', e && (e.stack || e.message));
    process.exitCode = 1;
  })
  .finally(() => {
    // 用 exitCode + quit 保证 CI 能拿到真实结果
    setTimeout(() => app.quit(), 200);
  });
