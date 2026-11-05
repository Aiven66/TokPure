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

/* ---------------- 4. AI 视频翻译：声音样本纯逻辑 ---------------- */
const vs = require(path.join(ROOT, 'electron', 'voicesample.js'));

function pcmSine({ sec = 1, sr = 24000, freq = 440, amp = 0.6, silenceFrom = 1 } = {}) {
  const n = Math.round(sec * sr);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    pcm[i] = t < silenceFrom ? amp * Math.sin(2 * Math.PI * freq * t) : 0;
  }
  return pcm;
}

test('语音占比能区分「有说话」与「几乎静音」', () => {
  const spoken = vs.speechStats(pcmSine({ sec: 2, silenceFrom: 2 }), 24000);
  assert.ok(spoken.ratio > 0.95, `全程正弦应接近 100%，实际 ${spoken.ratio}`);
  assert.ok(spoken.rmsDb > -12, `电平应正常，实际 ${spoken.rmsDb}`);

  const quiet = vs.speechStats(pcmSine({ sec: 2, amp: 0.0005, silenceFrom: 2 }), 24000);
  assert.ok(quiet.rmsDb < -52, `接近静音的电平应很低，实际 ${quiet.rmsDb}`);

  const empty = vs.speechStats(new Float32Array(0), 24000);
  assert.strictEqual(empty.ratio, 0);
  assert.strictEqual(empty.rmsDb, -100);
});

test('短样本 / 静音样本被拒，6 秒以下给出建议但可用', () => {
  assert.strictEqual(vs.judgeSample({ duration: 0, ratio: 0, rmsDb: -100 }).ok, false);
  assert.strictEqual(vs.judgeSample({ duration: 2.5, ratio: 0.9, rmsDb: -10 }).ok, false);
  assert.ok(/至少需要/.test(vs.judgeSample({ duration: 2.5, ratio: 0.9, rmsDb: -10 }).message));
  assert.strictEqual(vs.judgeSample({ duration: 8, ratio: 0.05, rmsDb: -10 }).ok, false);
  assert.strictEqual(vs.judgeSample({ duration: 8, ratio: 0.9, rmsDb: -70 }).ok, false);

  const warn = vs.judgeSample({ duration: 5, ratio: 0.8, rmsDb: -20 });
  assert.strictEqual(warn.ok, true);
  assert.strictEqual(warn.level, 'warn');

  const good = vs.judgeSample({ duration: 9, ratio: 0.8, rmsDb: -20 });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.level, 'ok');
});

test('波形峰值归一化到 0~1 且长度固定', () => {
  const peaks = vs.peakBuckets(pcmSine({ sec: 1, silenceFrom: 0.5 }), 64);
  assert.strictEqual(peaks.length, 64);
  assert.ok(Math.max(...peaks) === 1, '最大峰值应归一为 1');
  assert.ok(peaks.slice(40).every((v) => v === 0), '后半段静音应为 0');
  assert.ok(peaks.every((v) => v >= 0 && v <= 1), '峰值超出 0~1');
  assert.deepStrictEqual(vs.peakBuckets(new Float32Array(0), 64), new Array(64).fill(0));
});

test('WAV 头解析能得到正确的采样率与时长', () => {
  const sr = 24000;
  const frames = sr * 3;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sr, 4);
  fmt.writeUInt32LE(sr * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const head = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WAVE', 'ascii')]);
  head.writeUInt32LE(36 + frames * 2, 4);
  const fmtChunk = Buffer.concat([Buffer.from('fmt ', 'ascii'), Buffer.alloc(4), fmt]);
  fmtChunk.writeUInt32LE(16, 4);
  const dataChunk = Buffer.concat([Buffer.from('data', 'ascii'), Buffer.alloc(4), Buffer.alloc(frames * 2)]);
  dataChunk.writeUInt32LE(frames * 2, 4);
  const buf = Buffer.concat([head, fmtChunk, dataChunk]);

  const info = vs.readWavInfo(buf);
  assert.ok(info, 'WAV 头应解析成功');
  assert.strictEqual(info.sampleRate, sr);
  assert.strictEqual(info.channels, 1);
  assert.strictEqual(info.bits, 16);
  assert.ok(Math.abs(info.duration - 3) < 0.01, `时长应约 3 秒，实际 ${info.duration}`);
  assert.strictEqual(vs.readWavInfo(Buffer.from('not a wav')), null);
});

test('档案索引会清洗坏条目与字段', () => {
  const out = vs.profilesFromIndex({
    profiles: [
      { id: 'vabc123', name: ' 我的<声音> ', duration: '9.5', peaks: [0.2, 2, -1], createdAt: '123', bytes: -5 },
      { id: 'bad id', name: 'x' },
      { id: 'vxyz987', name: '', duration: -3, peaks: 'oops' }
    ]
  });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, '我的 声音');
  assert.strictEqual(out[0].duration, 9.5);
  assert.deepStrictEqual(out[0].peaks, [0.2, 1, 0]);
  assert.strictEqual(out[0].bytes, 0);
  assert.strictEqual(out[1].name, '我的声音');
  assert.ok(vs.profilesFromIndex(null).length === 0);
});

/* ---------------- 5. AI 视频翻译：接线与硬约束 ---------------- */
const preloadSrc = read('electron/preload.js');
const mainSrc = read('electron/main.js');
const locSrc = read('electron/localize.js');
const uiSrc = read('src/translate.js');
const htmlSrc = read('src/index.html');
const appSrc = read('src/app.js');
const cssSrc = read('src/styles.css');

test('preload 暴露 vt 全套 API', () => {
  assert.ok(/vt:\s*\{/.test(preloadSrc), 'preload 没有 vt 命名空间');
  for (const k of ['status', 'library', 'pickVideo', 'openPath', 'pickSample', 'importVoice', 'previewVoice', 'start', 'cancel', 'reveal', 'open']) {
    assert.ok(new RegExp(`${k}:`).test(preloadSrc), `preload 缺少 vt.${k}`);
  }
});

test('主进程注册 vt:* IPC，进度走独立通道', () => {
  for (const k of ['vt:status', 'vt:library', 'vt:pickVideo', 'vt:openPath', 'vt:pickSample', 'vt:importVoice', 'vt:previewVoice', 'vt:start', 'vt:cancel', 'vt:reveal', 'vt:open']) {
    assert.ok(mainSrc.includes(`'${k}'`), `main.js 缺少 ${k}`);
  }
  assert.ok(/sendToRenderer\('vt:progress'/.test(mainSrc), '进度没有走 vt:progress');
});

test('视频翻译复用识别/翻译/配音/混音链，不复制一份', () => {
  assert.ok(/async function startTranslate/.test(locSrc), '缺少 startTranslate');
  const start = locSrc.slice(locSrc.indexOf('async function startTranslate'));
  for (const fn of ['ensureWhisper(', 'transcribe(', 'translateSegments(', 'buildFlowNarration(', 'groupForFlow(', 'makeLocalSynth(', 'separateBgm(', 'verifyOutput(', 'buildSrt(', 'ensureCloneReady(']) {
    assert.ok(start.includes(fn), `视频翻译没有复用 ${fn}`);
  }
  const render = locSrc.slice(locSrc.indexOf('async function renderVoiceSwap'), locSrc.indexOf('async function renderSwapForTest'));
  assert.ok(render.includes('dubAudioChain({'), '视频翻译没有复用的混音链');
  assert.ok(/function dubAudioChain/.test(locSrc), 'dubAudioChain 应抽成两套流程共用');
  assert.ok(!/function makeLocalSynth/.test(start), '不要在视频翻译里重新实现克隆合成');
});

test('成片画面直拷、音轨只有一条（我的声音）', () => {
  const render = locSrc.slice(locSrc.indexOf('async function renderVoiceSwap'));
  assert.ok(render.includes("'-c:v', 'copy'"), '缺少视频直拷路径');
  assert.ok(render.includes("'-c:v', 'libx264'"), '缺少重编码回退');
  assert.ok(render.includes("'-map', '[a]'"), '没有映射配音音轨');
  assert.ok(!/'-map',\s*'0:a'/.test(render), '不应保留原片音轨');
  assert.ok(render.includes("'-c:a', 'aac'"), '配音音轨未编码为 AAC');
});

test('新页面已接线：菜单 / 视图 / 路由 / 控制器 / 样式', () => {
  assert.ok(/data-view="translate"/.test(htmlSrc), '左侧菜单没有 AI 视频翻译');
  assert.ok(/id="view-translate"/.test(htmlSrc), '缺少 view-translate 页面');
  assert.ok(/<script src="translate.js"><\/script>/.test(htmlSrc), '页面没有加载 translate.js');
  assert.ok(/name === 'translate' && window\.VideoTranslate/.test(appSrc), 'app.js 没有路由到 VideoTranslate');
  assert.ok(/window\.VideoTranslate = \{/.test(uiSrc), 'translate.js 没有导出 VideoTranslate');
  assert.ok(/\.start\(\{/.test(uiSrc), '控制器没有调用 vt:start');
  assert.ok(/onProgress/.test(uiSrc), '控制器没有接收进度');
  assert.ok(/#view-translate/.test(cssSrc), 'styles.css 缺少新页面样式');
  for (const id of ['vt-drop', 'vt-voices', 'vt-langs', 'vt-run', 'vt-progress', 'vt-results']) {
    assert.ok(htmlSrc.includes(`id="${id}"`), `页面缺少 ${id}`);
  }
});

test('声音库导入链保持频域降噪，且不使用 anlmdn', () => {
  const src = read('electron/voices.js');
  const chain = src.slice(src.indexOf('const REF_CHAIN'), src.indexOf('];', src.indexOf('const REF_CHAIN')));
  assert.ok(chain.includes('highpass'), '缺少高通');
  assert.ok(chain.includes('lowpass'), '缺少低通（高频底噪会进克隆条件）');
  assert.strictEqual((chain.match(/afftdn=nr=/g) || []).length, 2, '应有两级 afftdn 频域降噪');
  assert.ok(!/anlmdn=s=/i.test(src), 'voices.js 出现了 anlmdn 参数');
});

test('进度只增不减：全局百分比有单调整闸，配音阶段不再跳回加载阶段', () => {
  const start = locSrc.slice(locSrc.indexOf('async function startTranslate'));
  assert.ok(/emit = \(p\) => \{/.test(start), '缺少 emit 单调整包装');
  assert.ok(/out\.percent = Math\.max\(lastPct/.test(start), '进度没有夹成只增不减');
  assert.ok(/let cloneLoaded = false/.test(start), '缺少克隆加载完成标记');
  assert.ok(/if \(l\.stage && !cloneLoaded\)/.test(start), '配音阶段仍会回退阶段文案');
});

/* ---------------- 5.1 3.9.29 连续语流（不再断断续续 / 更自然） ---------------- */
/** 从源码里切出一个函数声明（按花括号配对），用于直接跑纯函数 */
function extractFn(name) {
  const start = locSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `localize.js 里找不到 ${name}`);
  let i = locSrc.indexOf('{', start);
  const begin = i;
  let depth = 0;
  for (; i < locSrc.length; i += 1) {
    if (locSrc[i] === '{') depth += 1;
    else if (locSrc[i] === '}') {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
    }
  }
  assert.ok(depth === 0 && i > begin, `${name} 的花括号不配对`);
  return locSrc.slice(start, i);
}

test('groupForFlow：相邻短句并成整句，长停口/超长文本不并', () => {
  const groupForFlow = new Function(`return (${extractFn('groupForFlow')})`)();
  // 相邻、停顿 0.2s、总长 12 字 → 合并，句间不加空格（中文）
  const zh = groupForFlow([
    { start: 0, end: 2, text: '大家好，' },
    { start: 2.2, end: 5, text: '今天聊三件事。' }
  ], 'zh');
  assert.strictEqual(zh.length, 1, '相邻短句没有合并');
  assert.strictEqual(zh[0].text, '大家好，今天聊三件事。');
  assert.strictEqual(zh[0].cues.length, 2, '字幕条目必须保留为 2 条');
  assert.strictEqual(zh[0].cues[1].offset, 4, '第二条字幕的字符偏移不对');
  // 停顿 0.8s → 不并（气口本身就是语义分句）
  const longGap = groupForFlow([
    { start: 0, end: 2, text: '第一段。' },
    { start: 2.8, end: 5, text: '第二段。' }
  ], 'zh');
  assert.strictEqual(longGap.length, 2, '长停顿不应合并');
  // 合并后超过 84 字 → 不并，避免单句生成时间翻倍
  const big = '啊'.repeat(60);
  const tooLong = groupForFlow([
    { start: 0, end: 4, text: big },
    { start: 4.1, end: 8, text: big }
  ], 'zh');
  assert.strictEqual(tooLong.length, 2, '超长文本不应合并');
  // 英文相邻句用空格连接
  const en = groupForFlow([
    { start: 0, end: 1, text: 'Hello there.' },
    { start: 1.1, end: 3, text: 'How are you?' }
  ], 'en');
  assert.strictEqual(en[0].text, 'Hello there. How are you?');
});

test('segmentGain：按语音分位归一到固定目标、噪底封顶、不再有跨句台阶', () => {
  const segmentGain = new Function('TARGET_SPEECH_DB', 'GAIN_NOISE_CEIL',
    `return (${extractFn('segmentGain')})`)(-15.5, -34);
  // 语音 0.9 分位 -21.5dBFS → +6dB
  assert.strictEqual(segmentGain({ speech: -21.5 }), 6);
  // 同一句语音电平，哪怕停顿多、LUFS 低得多，增益也完全一致（这就是「忽大忽小」的解）
  assert.strictEqual(segmentGain({ speech: -21.5, lufs: -34 }), 6);
  // 噪底 -35dB 的气声句：抬高会到 -24，被 -34 上限压回到 +1dB
  assert.strictEqual(segmentGain({ speech: -21.5, floor: -35 }), 1);
  // 没有分帧数据时退回整句 LUFS 口径
  assert.strictEqual(segmentGain({ lufs: -24 }), 6);
  // 几乎无声不放大，避免把整段底噪拉满
  assert.strictEqual(segmentGain({ speech: -80 }), 0);
  assert.strictEqual(segmentGain(null), 0);
  // 上限 +12dB
  assert.strictEqual(segmentGain({ speech: -40 }), 12);
});

test('speakableText：中文/日文/韩文里的拉丁缩写按字母名读，英文语种与混合词不转', () => {
  const m = locSrc.match(/const LETTER_NAMES = (\{[\s\S]*?\n\});/);
  assert.ok(m, '源码里找不到 LETTER_NAMES');
  const LETTER_NAMES = new Function(`return (${m[1]})`)();
  const speakableText = new Function('LETTER_NAMES', `return (${extractFn('speakableText')})`)(LETTER_NAMES);
  // 中文：AI 不能按拼音读成「爱」
  assert.strictEqual(speakableText('这个 AI 工具很好用', 'zh'), '这个 诶艾 工具很好用');
  // 缩写串与数字前缀（5G）
  assert.strictEqual(speakableText('GPT-4 和 5G 都支持', 'zh'), '吉皮提-4 和 5吉 都支持');
  // 单个字母
  assert.strictEqual(speakableText('A 股', 'zh'), '诶 股');
  // 日文 / 韩文各用自己的字母名
  assert.strictEqual(speakableText('AI 技術', 'ja'), 'エーアイ 技術');
  assert.strictEqual(speakableText('AI 기술', 'ko'), '에이아이 기술');
  // 英文语种原样返回（模型本来就按英文读）
  assert.strictEqual(speakableText('AI is great', 'en'), 'AI is great');
  // 大小写混合/连续小写的单词不能被拆开（OpenAI / iPhone / TikTok / ChatGPT）
  assert.strictEqual(speakableText('OpenAI 的 iPhone 和 TikTok', 'zh'), 'OpenAI 的 iPhone 和 TikTok');
  assert.strictEqual(speakableText('ChatGPT 很聪明', 'zh'), 'ChatGPT 很聪明');
  // 空值不炸
  assert.strictEqual(speakableText('', 'zh'), '');
  assert.strictEqual(speakableText(null, 'zh'), '');
});

test('tightenPauses：句内长死气口压到 0.14s，语音样本一个不丢', () => {
  const tightenPauses = new Function('DENOISE_RATE',
    `return (${extractFn('tightenPauses')})`)(44100);
  const sr = 44100;
  const build = (gapSec) => {
    const n = () => Math.round(0.5 * sr);
    const out = new Float32Array(n() * 2 + Math.round(gapSec * sr));
    const tone = (base) => {
      for (let i = 0; i < n(); i += 1) out[base + i] = 0.2 * Math.sin(i * 0.3);
    };
    tone(0);
    tone(n() + Math.round(gapSec * sr));
    return out;
  };
  // 0.44s 的死气口 → 压到 0.14s，总长从 1.44s 变成 ~1.14s（边界上恰好过零的样本会有 ±几样本出入）
  const a = build(0.44);
  const ta = tightenPauses(a, sr);
  assert.ok(Math.abs(ta.length - Math.round(1.14 * sr)) <= 4, `总长 ${ta.length} 不在 1.14s±4`);
  // 语音样本原样保留（前 0.5s 正弦逐样本一致）
  for (let i = 0; i < Math.round(0.5 * sr); i += 997) assert.strictEqual(ta[i], a[i]);
  // 后半句也没有丢：最后一个样本必须还在
  assert.strictEqual(ta[ta.length - 1], a[a.length - 1]);
  // 0.1s 的正常呼吸口不折（不是长死气口）
  const b = build(0.1);
  const tb = tightenPauses(b, sr);
  assert.strictEqual(tb.length, b.length);
  // 没有死气口时原样返回（不复制、不改写）
  const c = build(0);
  assert.strictEqual(tightenPauses(c, sr), c);
});

test('buildFlowNarration：整片一次变速、连续语流串接、字幕随实际语音重排', () => {
  const flow = locSrc.slice(locSrc.indexOf('async function buildFlowNarration'),
    locSrc.indexOf('/** 逐句合成后按原时间轴拼接为整条配音轨 */'));
  assert.ok(flow.length > 2000, 'buildFlowNarration 源码切取失败');
  // 合成上限按「语速估算的语音时长 × 25 token/秒」算，不再按字幕窗口
  assert.ok(/25 \* estSec \* 1\.35/.test(flow), '生成上限没有按语速估算（会被 token 上限截断）');
  assert.ok(!/round\(25 \* slot/.test(flow), '仍在按字幕窗口算 token 上限');
  // 混读：送进合成的文本必须过 speakableText，字幕仍用原文
  assert.ok(/speakableText\(unit\.text, langId\)/.test(flow), '中文配音没有做中英混读归一');
  // 连续语流：气口夹在 0.12~0.5s，不再锚回原片起点（长停顿会把配音拆成一段段）
  assert.ok(/const pauses = \[\]/.test(flow), '缺少连续语流的气口数组');
  assert.ok(/Math\.max\(0\.12, Math\.min\(0\.5, want\)\)/.test(flow), '气口没有被夹到 0.12~0.5s');
  assert.ok(!/starts\[i\] = Math\.max\(at, Number\(units\[i\]\.start\)/.test(flow), '仍在按原片起点锚定');
  // 整片最多一次变速，且放慢（<1）也要真的执行
  const tempoUse = flow.match(/atempo=/g) || [];
  assert.strictEqual(tempoUse.length, 1, `buildFlowNarration 出现了 ${tempoUse.length} 处 atempo`);
  assert.ok(/MIN_TEMPO = 0\.90/.test(flow) && /MAX_TEMPO = 1\.20/.test(flow), '整片变速区间不是 0.90~1.20');
  assert.ok(/Math\.abs\(tempo - 1\) > 0\.005/.test(flow), '放慢没有接 atempo');
  assert.ok(/normalizeTrack\(voiceFile\)/.test(flow), '整轨没有做响度收口');
  // 每段有自己的定位与静音补位，amix 后再统一限幅
  assert.ok(/adelay=/.test(flow) && /amix=inputs=/.test(flow), '缺少按时间轴定位拼接');
  assert.ok(/apad=whole_dur=/.test(flow), '缺少补静音');
  // 字幕按实际语音时长重映射，并保证单调、最短 0.35s
  assert.ok(/timing\.push\(\{/.test(flow), '没有重排字幕时间轴');
  assert.ok(/c\.start = Math\.max\(c\.start, prevEnd\)/.test(flow), '字幕没有单调约束');
  assert.ok(/c\.end = c\.start \+ 0\.35/.test(flow), '字幕没有最短停留');
});

test('视频翻译的配音调用点已切到连续语流，字幕在配音后按实况重建', () => {
  const start = locSrc.slice(locSrc.indexOf('async function startTranslate'));
  assert.ok(/const units = groupForFlow\(outSegs, langId\)/.test(start), '没有把字幕并成语段');
  assert.ok(/buildFlowNarration\(units, dur, langId, dir, ttsProg\.onDone/.test(start), '仍在调用旧的逐句 buildNarration');
  // SRT 必须在配音之后写：配音前写会让字幕卡在原片窗口，与并段后的语音对不上
  const writeAt = start.indexOf("fs.writeFileSync(srtPath");
  const ttsAt = start.indexOf('const built = await buildFlowNarration');
  assert.ok(ttsAt >= 0 && writeAt > ttsAt, 'SRT 写入位置不在配音之后');
  assert.ok(/const built\.timing/.test(start) || /built\.timing && built\.timing\.length/.test(start), '没有用实际语音时间轴重建字幕');
  assert.ok(/整体语速已微调/.test(start), '变速提示文案未更新');
  assert.ok(!/句偏长，已收紧时长以贴合画面/.test(start), '仍在用旧的「句偏长」提示');
});

/* ---------------- 6. 硬约束 ---------------- */
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

test('Windows 与 macOS 共用同一套配音修复（降噪 / 电平 / 连读 / 字母名）', () => {
  // 这四件事全部落在跨平台纯 JS 里，两个平台走同一份实现。
  // 断言「不含平台分支」是为了防止以后有人给 Windows 单开一条路径却漏带修复：
  // 一旦分叉，这个测试会先失败，而不是等用户在 Windows 上听出问题。
  const denoise = read('electron/denoise.js');
  assert.ok(!/process\.platform|isWin|win32/.test(denoise), '降噪出现了平台分支，Windows 可能拿不到句尾高通判据');
  const loc = read('electron/localize.js');
  const flow = loc.slice(loc.indexOf('async function buildFlowNarration'), loc.indexOf('async function buildNarration'));
  assert.ok(flow.length > 1000, '定位不到 buildFlowNarration');
  assert.ok(!/isWin|process\.platform/.test(flow), '连续语流出现了平台分支');
  assert.ok(/speakableText\(unit\.text, langId\)/.test(flow), '视频翻译配音没有做字母名展开（AI 会被念成拼音）');
  assert.ok(/normalizeTrack\(voiceFile\)/.test(flow), '视频翻译配音没有整轨响度收口');
  assert.ok(/tightenPauses\(r\.pcm, DENOISE_RATE\)/.test(loc), '句内死气口折叠缺失');
  const nar = loc.slice(loc.indexOf('async function buildNarration'), loc.indexOf('async function renderVertical'));
  assert.ok(!/isWin|process\.platform/.test(nar), '逐句配音出现了平台分支');
  assert.ok(/speakableText\(seg\.text, langId\)/.test(nar), 'Windows 系统音色（System.Speech）配音没有做字母名展开');
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
