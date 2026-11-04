'use strict';

/* ============================================================
   TokPure 冒烟测试（在 Electron 运行时里跑，macOS / Windows 通用）
   npm run test:smoke

   验证「安装完能不能真的用」：
   - FFmpeg 能解析到并成功执行（3.9.26 起固化到 userData）
   - 当前平台有 Whisper 引擎资产（Windows 3.9.27 新补）
   - 8 种目标语言都有音色目录（Windows 走 SAPI 枚举）
   - 真的合成一句 wav（macOS: say；Windows: System.Speech）
   - AI 视频翻译：合成测试片 → 画面直拷 / 烧录字幕两条路径出片
     → 校验「视频流保留 + 只有 1 条音轨 + 时长一致」
   - 声音样本导入 → 声音库列表 → 删除（验证去静音/两级降噪/索引全链）
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

  /* 6) AI 视频翻译：画面直拷 + 单条配音音轨；声音样本导入 → 列表 → 删除 */
  const tmpFiles = [];
  try {
    const ffmpegPath = ffmpeg.getFfmpegPath();
    const dir = path.join(app.getPath('temp'), 'tokpure-smoke-vt');
    fs.mkdirSync(dir, { recursive: true });
    const video = path.join(dir, 'src.mp4');
    tmpFiles.push(video);
    const re = await runCapture(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video
    ]);
    const videoOk = fs.existsSync(video) && fs.statSync(video).size > 20000;
    assertTrue(videoOk, `测试原片生成：${videoOk ? fs.statSync(video).size + ' 字节' : '失败 ' + re.slice(-200)}`);

    // 配音用真实 TTS 结果，保证封装链吃到的是正常语音而不是正弦
    const narration = path.join(dir, 'narration.wav');
    tmpFiles.push(narration);
    await localize.synthForTest('This is a TokPure video translation smoke test.', narration, 'en');
    const srtText = '1\n00:00:00,000 --> 00:00:01,400\nVoice translation smoke test\n\n'
      + '2\n00:00:01,400 --> 00:00:03,000\nOnly one audio track\n';
    const noSub = path.join(dir, 'swap-copy.mp4');
    const withSub = path.join(dir, 'swap-subs.mp4');
    tmpFiles.push(noSub, withSub);
    await localize.renderSwapForTest({ input: video, narration, duration: 3, srtText, out: noSub, subtitles: false });
    await localize.renderSwapForTest({ input: video, narration, duration: 3, srtText, out: withSub, subtitles: true });

    for (const [label, file] of [['画面直拷', noSub], ['烧录字幕', withSub]]) {
      const exists = fs.existsSync(file) && fs.statSync(file).size > 20000;
      assertTrue(exists, `${label} 出片：${exists ? fs.statSync(file).size + ' 字节' : '文件缺失'}`);
      if (!exists) continue;
      const info = await runCapture(ffmpegPath, ['-hide_banner', '-i', file]);
      const audioStreams = (info.match(/Stream #\d+:\d+[^\n]*: Audio:/g) || []).length;
      const videoStreams = (info.match(/Stream #\d+:\d+[^\n]*: Video:/g) || []).length;
      assertTrue(videoStreams === 1 && audioStreams === 1,
        `${label} 流结构：视频 ${videoStreams} 条 / 音轨 ${audioStreams} 条（必须 1 / 1）`);
      const dm = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const dur = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0;
      assertTrue(Math.abs(dur - 3) < 0.6, `${label} 时长 ${dur.toFixed(2)}s（原片 3.00s）`);
    }

    // 声音样本导入：8 秒「连续说话」（用真实 TTS 循环拼接），验证去静音/降噪/索引
    const sampleWav = path.join(dir, 'voice-sample.wav');
    tmpFiles.push(sampleWav);
    await runCapture(ffmpegPath, ['-y', '-stream_loop', '2', '-i', narration, '-t', '8',
      '-ac', '1', '-ar', '24000', sampleWav]);
    const imported = await localize.importVoice({ input: sampleWav, name: 'smoke-voice' });
    assertTrue(!!(imported && imported.id), `声音样本导入成功：${imported ? imported.duration.toFixed(2) + 's，波形 ' + imported.peaks.length + ' 段' : '失败'}`);
    const lib = localize.voiceLibrary();
    assertTrue(lib.items.some((v) => v.id === imported.id), `声音库列出 ${lib.items.length} 个声音（含新导入）`);
    if (imported) {
      localize.removeVoice(imported.id);
      const after = localize.voiceLibrary();
      assertTrue(!after.items.some((v) => v.id === imported.id), '声音库删除后不再列出');
    }
  } catch (e) {
    bad('AI 视频翻译链路失败：' + (e && e.message));
  } finally {
    tmpFiles.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
    try { fs.rmSync(path.join(app.getPath('temp'), 'tokpure-smoke-vt'), { recursive: true, force: true }); } catch (_) {}
  }

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
