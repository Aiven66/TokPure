'use strict';

/* ============================================================
   TokPure — AI 批量切片（v2.6）
   面向带货直播/短视频：批量离线分析原始素材，自动找值得剪的片段。

   两阶段架构（重型结果一次性落盘，审核/导出反复消费不重算）：
     阶段1 分析：抽音频 → Whisper 语音识别（普通话/粤语/英语）
                 → 静音检测 → 规则引擎打分 + SKU/价格关联 → 片段库落盘
     阶段2 审核：人工通过/拒绝/微调边界（只读写本地片段库 JSON）
     阶段3 导出：按已通过片段批量渲染 mp4 + manifest

   全程本地运行，不调用任何云端 API。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { app, dialog } = require('electron');
const ffmpegMod = require('./ffmpeg');
const hub = require('./enginehub');
const aijobs = require('./aijobs');
const store = require('./store');
const audiofx = require('./audiofx');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

/* ---------------- 存储 ---------------- */
function rootDir() {
  return path.join(app.getPath('userData'), 'clips');
}
function sourcesDir() {
  return path.join(rootDir(), 'sources');
}
function tmpDir() {
  return path.join(rootDir(), 'tmp');
}
function ensureDirs() {
  [rootDir(), sourcesDir(), tmpDir()].forEach((d) => fs.mkdirSync(d, { recursive: true }));
}
function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

/* ---------------- 默认规则 / 词库（中英 + 粤语口语） ---------------- */
const DEFAULT_CFG = {
  language: 'auto',          // auto | zh | en | yue
  modelId: 'whisper-base',
  minDuration: 12,           // 候选片段最短秒数
  maxDuration: 90,           // 候选片段最长秒数
  targetDuration: 35,        // 期望片段长度
  leadPad: 0.3,              // 切点前留白
  trailPad: 0.5,             // 切点后留白
  silenceDb: -35,            // 静音检测阈值 dB
  silenceDur: 0.55,          // 最短静音秒数
  maxCandidates: 20,         // 每条素材最多候选
  minScore: 45,              // 最低入选分
  autoApprove: 0,            // ≥ 该分自动通过（0 = 关闭，全部人工审）
  requireSku: false,         // 仅保留命中商品库的片段
  burnSubtitles: true,       // 导出时烧录字幕
  fontSize: 18,
  marginV: 64,
  polishStyle: true,         // 成片增强：BGM 垫底 + whoosh/pop 音效 + 花字弹出
  bgmVolume: 0.3,            // BGM 原始音量（人声侧链闪避后约 -24LU，不压话）
  hookZoom: true,            // 片头 0.5s 轻微推近
  positiveWords: '好用 划算 便宜 超值 加厚 实用 性价比 爆款 热卖 好评 回购 正品 质量好 显瘦 百搭 亲肤 透气 买一送一 福利 优惠 立减 返场 闭眼入 不踩雷 好味 美味 新鲜 干净 好料 足料 真材实料 厚肉 厚身 陈年 正宗 地道 干货 饱满 推荐 放心 有保证 值得 好正 抵买 抵食 平靓正 放心买 great deal worth value must-have best seller good quality tasty delicious fresh authentic genuine premium recommended juicy high quality great value well worth it',
  ctaWords: '上车 落单 下单 拍一发 点击 链接 小黄车 购物车 马上下单 赶紧拍 去抢 库存 只剩 包邮 限时 秒杀 抢购 直播间 评论区 拍1号 1号链接 买它 即刻 上架 拍下 带走 带回家 送礼 礼盒 免费送 再送 送给你 特价 优惠价 福利价 折扣 半价 入手 试一试 试下 心动 手慢无 截单 出货 现货 拍低 带走啦 帮衬 钟意 buy now order now link below add to cart shopping cart limited offer limited time offer free shipping click the link grab yours shop now free gift on sale while stocks last check it out',
  negativeWords: '别买 翻车 不好用 踩雷 智商税 退款 退货 差评 质量差 骗人 假货 亏了 呃人 垃圾 过期 变质 不值 中伏 不要买 唔好买 别乱买 don\'t buy waste of money scam bad quality not worth stay away from',
  _vocabVersion: 2
};

/**
 * 老用户 store 里存的是旧词库，把新版本新增词条非破坏性合并进去（幂等、去重）。
 * 注意：必须用“存储值自带的版本号”判断——merge 默认值后的 cfg 永远带最新版本号，
 * 不能用合并结果里的 _vocabVersion 做守卫，否则迁移永远被跳过。
 */
function migrateVocab(stored) {
  const base = { ...DEFAULT_CFG, ...(stored || {}) };
  const storedV = Number((stored && stored._vocabVersion) || 0);
  if (storedV >= DEFAULT_CFG._vocabVersion) return base;
  const merge = (curStr, defStr) => {
    const curWords = String(curStr || '').split(/\s+/).filter(Boolean);
    const have = new Set(curWords.map((w) => w.toLowerCase()));
    const add = String(defStr || '').split(/\s+/).filter((w) => !have.has(w.toLowerCase()));
    return [...curWords, ...add].join(' ');
  };
  return {
    ...base,
    positiveWords: merge(base.positiveWords, DEFAULT_CFG.positiveWords),
    ctaWords: merge(base.ctaWords, DEFAULT_CFG.ctaWords),
    negativeWords: merge(base.negativeWords, DEFAULT_CFG.negativeWords),
    _vocabVersion: DEFAULT_CFG._vocabVersion
  };
}

function getConfig() {
  ensureDirs();
  const stored = readJsonSafe(path.join(rootDir(), 'config.json'), null);
  return migrateVocab(stored);
}
function saveConfig(patch) {
  const next = { ...getConfig(), ...(patch || {}) };
  writeJson(path.join(rootDir(), 'config.json'), next);
  return next;
}

function getSkus() {
  ensureDirs();
  return readJsonSafe(path.join(rootDir(), 'skus.json'), []);
}
function saveSkus(list) {
  const clean = (Array.isArray(list) ? list : []).map((s, i) => ({
    id: s.id || `sku_${Date.now().toString(36)}_${i}`,
    name: String(s.name || '').trim(),
    price: String(s.price == null ? '' : s.price).trim(),
    aliases: Array.isArray(s.aliases)
      ? s.aliases.map((a) => String(a || '').trim()).filter(Boolean)
      : String(s.aliases || '').split(/[;；\n]/).map((a) => a.trim()).filter(Boolean)
  })).filter((s) => s.name);
  writeJson(path.join(rootDir(), 'skus.json'), clean);
  return clean;
}

/** CSV：商品名称,价格,别名1;别名2;别名3 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i += 1; }
      else q = !q;
    } else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

async function importSkusCsv() {
  const res = await dialog.showOpenDialog({
    title: '导入商品库 CSV',
    properties: ['openFile'],
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const raw = fs.readFileSync(res.filePaths[0], 'utf8').replace(/^﻿/, '');
  const rows = raw.split(/\r?\n/).map(parseCsvLine).filter((r) => r.some((c) => c));
  if (!rows.length) return { added: 0, total: getSkus().length };
  // 首行像表头则跳过
  if (/名称|name|商品/i.test(rows[0][0] || '')) rows.shift();
  const incoming = rows.map((r) => ({
    name: r[0] || '',
    price: r[1] || '',
    aliases: (r[2] || '').split(/[;；]/).map((a) => a.trim()).filter(Boolean)
  })).filter((s) => s.name);
  const merged = saveSkus([...getSkus(), ...incoming]);
  return { added: incoming.length, total: merged.length };
}

async function exportSkusCsv() {
  const skus = getSkus();
  const res = await dialog.showSaveDialog({
    title: '导出商品库 CSV',
    defaultPath: path.join(store.get().downloadDir || app.getPath('downloads'), 'tokpure-skus.csv'),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return null;
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = ['商品名称,价格,关键词别名'];
  skus.forEach((s) => lines.push([esc(s.name), esc(s.price), esc(s.aliases.join(';'))].join(',')));
  fs.writeFileSync(res.filePath, '﻿' + lines.join('\n'), 'utf8');
  return res.filePath;
}

/* ---------------- 批量任务（分析/导出全局单并发） ---------------- */
let batch = null;
function isBusy() { return !!batch; }
function cancel() {
  if (!batch) return false;
  batch.canceled = true;
  if (batch.child) { try { batch.child.kill('SIGKILL'); } catch (_) {} }
  return true;
}
function checkCanceled() {
  if (batch && batch.canceled) throw new Error('已取消');
}

function runCmd(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: true });
    if (batch) batch.child = child;
    let stderr = '';
    let stdout = '';
    const collect = (chunk) => {
      const s = chunk.toString();
      stderr += s;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
      if (opts.onLine) s.split(/\r|\n/).forEach((line) => { if (line.trim()) opts.onLine(line); });
    };
    child.stdout.on('data', (c) => {
      stdout += c.toString();
      if (opts.onLine) c.toString().split(/\r|\n/).forEach((l) => { if (l.trim()) opts.onLine(l); });
    });
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      if (batch && batch.child === child) batch.child = null;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`进程退出码 ${code}\n${stderr.slice(-500)}`));
    });
  });
}
async function runFf(args, onLine, cwd) {
  return runCmd(ffmpegMod.getFfmpegPath(), args, { onLine, cwd });
}

/* ---------------- 素材选择 / 扫描 ---------------- */
async function pickFiles() {
  const res = await dialog.showOpenDialog({
    title: '选择直播/视频原始素材（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }]
  });
  if (res.canceled) return [];
  return res.filePaths.map(fileMeta).filter(Boolean);
}

function fileMeta(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || !VIDEO_EXTS.has(path.extname(p).toLowerCase())) return null;
    return { path: p, name: path.basename(p), size: st.size, mtimeMs: st.mtimeMs };
  } catch (_) { return null; }
}

async function scanDir() {
  const res = await dialog.showOpenDialog({ title: '选择素材文件夹', properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return [];
  const root = res.filePaths[0];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6 || out.length > 3000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.forEach((e) => {
      if (e.name.startsWith('.') || e.name === 'node_modules') return;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, depth + 1);
      else {
        const m = fileMeta(fp);
        if (m) out.push(m);
      }
    });
  };
  walk(root, 0);
  return out;
}

function sourceIdOf(meta) {
  return crypto.createHash('sha1').update(`${meta.size}:${Math.round(meta.mtimeMs)}:${meta.name}`).digest('hex').slice(0, 16);
}
function sourcePath(id) {
  return path.join(sourcesDir(), `${id}.json`);
}

/* ---------------- 静音检测 ---------------- */
async function detectSilence(input, noiseDb, minDur) {
  let text = '';
  try {
    await runFf([
      '-hide_banner', '-nostats', '-i', input,
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
      '-f', 'null', '-'
    ], (line) => { text += line + '\n'; });
  } catch (_) { /* 信息在 stderr */ }
  const starts = [];
  const ends = [];
  text.split('\n').forEach((line) => {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) starts.push(Number(m[1]));
    m = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (m) ends.push(Number(m[1]));
  });
  const list = [];
  for (let i = 0; i < starts.length; i += 1) {
    const s = Math.max(0, starts[i]);
    const e = i < ends.length ? Math.max(s, ends[i]) : s;
    if (e - s >= 0.1) list.push({ start: s, end: e });
  }
  return list.sort((a, b) => a.start - b.start);
}

/* ---------------- Whisper 识别 ---------------- */
/* 实测（77s 粤语带货素材，CER 对比）：
   tiny/base/small 传 -l yue 会输出乱码 → 退回 zh 解码（CER≈38.8%）；
   medium 以上（含 large-v3-turbo）支持 yue，配合粤语 initial prompt，
   CER 降到 24.9%（繁體粵語：嘅/唔/唔好/即刻 等口语字可保留）。
   zh/en 同样加带货场景提示词，商品名同音错字明显减少。 */
function modelSupportsYue(modelId, modelPath) {
  const s = `${modelId || ''} ${path.basename(modelPath || '')}`.toLowerCase();
  return /turbo|large|medium/.test(s);
}
function buildWhisperPrompt(language, skus) {
  const base = {
    zh: '以下是直播带货口播，包含商品名称、原价、到手价、包邮、点击链接、马上下单、限时优惠、库存不多、买它等话术。',
    yue: '以下係粵語直播帶貨口播，包含商品名稱、原價、到手價、包郵、一號連結、即刻落單、限時優惠、貨源唔多、快啲搶、買佢等講法。',
    en: 'The following is a live shopping stream pitch with product names, original price, deal price, free shipping, click the link, order now, limited time offer, limited stock.'
  };
  let p = base[language] || base.zh + ' ' + base.en;
  // 把商品库名称/别名注入提示词，引导专有名词识别（厨房剪/藍牙耳機/品牌名）
  const terms = [];
  (skus || []).forEach((sku) => {
    [sku.name, ...(sku.aliases || [])].forEach((n) => {
      const t = String(n || '').trim();
      if (t && t.length >= 2 && !terms.includes(t)) terms.push(t);
    });
  });
  if (terms.length) {
    p += language === 'en' ? ' Products: ' + terms.slice(0, 16).join(', ') + '.'
      : ' 商品：' + terms.slice(0, 16).join('、') + '。';
  }
  return p.slice(0, 600);
}
async function runWhisper(wav, model, modelId, language, jobDir, onLine, skus) {
  const bin = hub.engineBin('whisper');
  if (!bin) throw new Error('未安装 Whisper.cpp 引擎，请先到「桌面引擎」下载');
  if (!model) throw new Error('未安装识别模型，请先到「桌面引擎」下载模型（粤语建议 Turbo）');
  const outBase = path.join(jobDir, 'result');
  const useYue = language === 'yue' && modelSupportsYue(modelId, model);
  // 小模型无粤语解码端：yue 退回 zh（输出繁体，规则侧做简繁归一）
  const decodeLang = language === 'yue' ? (useYue ? 'yue' : 'zh')
    : (language && language !== 'auto' ? language : 'auto');
  const args = [
    '-m', model, '-f', wav,
    '-l', decodeLang,
    '-oj', '-of', outBase,
    '-t', String(Math.max(2, Math.min(8, (os.cpus() || []).length - 2 || 4))),
    '-pp' // 必须显式开启，否则 1.9.x 全程不打印 progress（长视频看起来像卡在识别阶段）
  ];
  if (modelSupportsYue(modelId, model)) {
    // 大模型：更大 beam 提准确率；-sow 按词切句避免 turbo 加提示词后段落整段合并
    args.push('-bs', '8', '-sow');
  }
  // 场景 initial prompt（粤语增益最大，zh/en 同音错字也明显减少）
  if (decodeLang !== 'auto') {
    args.push('--prompt', buildWhisperPrompt(language === 'yue' ? (useYue ? 'yue' : 'zh') : decodeLang, skus));
  }
  await runCmd(bin, args, { onLine });
  const data = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
  const rows = Array.isArray(data.transcription) ? data.transcription : [];
  const toSec = (ts) => {
    const m = String(ts || '').trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
  };
  const segments = rows.map((r) => ({
    start: toSec(r.timestamps && r.timestamps.from),
    end: toSec(r.timestamps && r.timestamps.to),
    text: String(r.text || '').trim()
  })).filter((s) => s.text && s.end > s.start);
  const languageUsed = language === 'yue' ? (useYue ? 'yue' : 'yue→zh') : decodeLang;
  return { segments, languageUsed };
}

/* ---------------- 规则引擎 ---------------- */
const PRICE_RE = [
  /[¥￥$]\s?\d{1,5}(?:\.\d{1,2})?/g
];
/* 数字 + 货币单位（可带一位口语小数，如 59块9 / 99蚊8） */
const PRICE_UNIT_RE = /(\d{1,5})(\.\d{1,2})?\s*(?:蚊鸡|蚊|块钱|块|元钱|元|圆|港幣|港币|港元|港纸|dollars?|bucks?)(\s?[0-9])?/gi;
const PRICE_WORDS = /(到手价|券后价?|券后|原价|现价|售价|福利价|秒杀价|活动价|特价|包邮|立减|直降|优惠价|only\s*\$\s*\d+(?:\.\d+)?|was\s*\$\s*\d+(?:\.\d+)?|now\s*\$\s*\d+(?:\.\d+)?)/gi;
const FILLER_RE = /(呃+|嗯+|那个|这个|就是说|然后呢|对吧?|啊吧)/g;
const CJK_RE = /[一-鿿]/g;

/* 简繁归一（覆盖带货话术常见字；粤语 ASR 可能输出繁体），
   仅用于规则匹配，展示与字幕仍保留识别原文。 */
const T2S_MAP = {
  繁: '繁', 體: '体', 這: '这', 麼: '么', 個: '个', 們: '们', 來: '来',
  連: '连', 結: '结', 單: '单', 線: '线', 時: '时', 優: '优', 郵: '邮',
  車: '车', 購: '购', 點: '点', 擊: '击', 搶: '抢', 價: '价', 賣: '卖',
  貨: '货', 質: '质', 鋼: '钢', 鏽: '锈', 廚: '厨', 藍: '蓝', 機: '机',
  電: '电', 續: '续', 裏: '里', 頭: '头', 嘅: '的', 係: '是', 咗: '了',
  冇: '没', 喺: '在', 啲: '些', 亂: '乱', 買: '买', 雜: '杂', 閉: '闭',
  會: '会', 圓: '圆', 幣: '币', 號: '号', 鏈: '链', 欄: '栏', 銀: '银',
  碼: '码', 現: '现', 發: '发', 熱: '热', 銷: '销', 評: '评', 論: '论',
  區: '区', 間: '间',
  // 真实粤语直播语料补充（v2.6.2）
  陳: '陈', 鹽: '盐', 鮮: '鲜', 乾: '干', 淨: '净', 禮: '礼', 試: '试',
  場: '场', 鍾: '钟', 鐘: '钟', 動: '动', 夠: '够', 嚟: '来', 哋: '们',
  櫃: '柜', 飯: '饭', 曬: '晒', 產: '产',
  養: '养', 臘: '腊', 腸: '肠', 網: '网', 紅: '红', 標: '标', 準: '准',
  過: '过', 還: '还', 這: '这', 講: '讲', 幫: '帮', 襯: '衬'
};
function t2s(s) {
  return String(s || '').replace(/[^\x00-\x7F]/g, (ch) => T2S_MAP[ch] || ch);
}
function normText(s) {
  return t2s(String(s || '')).toLowerCase();
}

/* 对比语境抑制：「其他直播间买的」「别的评论区看到的」里的直播间/评论区不是自家 CTA，
   真实直播大量用这种对比句，会造成假锚点。仅在统计 CTA 命中时摘除。 */
const CMP_CTX_RE = /(其他|其它|别的|人家|人们|外面|人地|第二|出边|出面)[^，。,.！!？?；;]{0,8}(直播间|评论区|小黄车|购物车)/g;
function ctaText(low) {
  return String(low || '').replace(CMP_CTX_RE, ' ');
}
const CMP_PENALTY_RE = /(做对比|做對比|对比一下|對比一下|来对比|來對比|做比较|做比較|其他(直播间|直播間|人买|人買|店|家)|别的(直播间|人买|店|家))/;

/* 中文数字价格：二十九块九 / 一百九十九蚊 / 二十九個九 → 29.9 / 199 / 29.9 */
const ZH_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function zhNumber(s) {
  let n = 0;
  let d = 0;
  for (const ch of s) {
    if (ch in ZH_DIGIT) d = ZH_DIGIT[ch];
    else if (ch === '十') { n += (d || 1) * 10; d = 0; }
    else if (ch === '百') { n += (d || 1) * 100; d = 0; }
    else if (ch === '千') { n += (d || 1) * 1000; d = 0; }
  }
  return n + d;
}
const ZH_PRICE_RE = /([零〇一二两三四五六七八九十百千]{1,6})\s*(?:蚊鸡|蚊|块钱|块|元钱|元|圆|港幣|港币|港元|港纸|dollars?|bucks?)\s*(?:九?钱?\s*([零〇一二两三四五六七八九])(?![零〇一二两三四五六七八九十百千]))?/gi;
function zhPrices(text) {
  const out = [];
  let m;
  ZH_PRICE_RE.lastIndex = 0;
  while ((m = ZH_PRICE_RE.exec(text))) {
    const intPart = zhNumber(m[1]);
    if (!intPart) continue;
    out.push(m[2] !== undefined ? `${intPart}.${ZH_DIGIT[m[2]]}` : String(intPart));
  }
  return out;
}
/* 粤语口语「N 个 M」= N.M 元：N/M 均可为阿拉伯或中文数字（59个9 / 二十九個九） */
const GE_PRICE_RE = /(?:(\d{1,5})|([零〇一二两三四五六七八九十百千]{1,6}))\s*个\s*([0-9]|[零〇一二两三四五六七八九])(?![0-9零〇一二两三四五六七八九十百千])/gi;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 命中 SKU：中文直接包含；长度>=3 的英文做词边界匹配 */
function matchSkus(text, skus) {
  const hits = []; // {id,name}
  skus.forEach((sku) => {
    const names = [sku.name, ...(sku.aliases || [])].filter(Boolean);
    const hit = names.some((n) => {
      const nn = normText(n.trim());
      if (!nn) return false;
      if (/[一-鿿]/.test(nn)) return text.includes(nn);
      if (nn.length < 3) return false;
      return new RegExp(`(^|[^a-z0-9])${escapeRe(nn)}([^a-z0-9]|$)`).test(text);
    });
    if (hit) hits.push({ id: sku.id, name: sku.name, price: sku.price });
  });
  return hits;
}

function matchPrices(text) {
  const found = new Set();
  PRICE_RE.forEach((re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) found.add(m[0].replace(/\s+/g, ''));
  });
  PRICE_UNIT_RE.lastIndex = 0;
  let um;
  while ((um = PRICE_UNIT_RE.exec(text))) {
    const dec = um[2] || (um[3] !== undefined ? `.${um[3].trim()}` : '');
    found.add(`¥${um[1]}${dec}`);
  }
  zhPrices(text).forEach((p) => found.add(`¥${p}`));
  // 口语「29 个 9 / 二十九個九」（粤语「個」、ASR 数字可能是阿拉伯或中文）
  GE_PRICE_RE.lastIndex = 0;
  let gm;
  while ((gm = GE_PRICE_RE.exec(text))) {
    const intPart = gm[1] !== undefined ? gm[1] : zhNumber(gm[2]);
    const dec = /[0-9]/.test(gm[3]) ? gm[3] : ZH_DIGIT[gm[3]];
    if (intPart) found.add(`¥${intPart}.${dec}`);
  }
  PRICE_WORDS.lastIndex = 0;
  let m;
  while ((m = PRICE_WORDS.exec(text))) found.add(m[0]);
  return Array.from(found);
}

/* 英文多词短语必须整体匹配（否则 buy/quality 等单词会在无关句子里误命中）。
   短语命中后从文本中摘除，再统计中文词 / 英文单词。 */
const PHRASE_BOOK = {
  cta: ['limited time offer', 'click the link', 'add to cart', 'shopping cart', 'order now', 'free shipping', 'buy now', 'link below', 'grab yours', 'limited offer', 'shop now', 'free gift', 'on sale', 'while stocks last', 'check it out'],
  pos: ['great deal', 'best seller', 'good quality', 'must have', 'must-have', 'high quality', 'great value', 'worth every penny', 'well worth it'],
  neg: ["don't buy", 'do not buy', 'waste of money', 'bad quality', 'not worth', 'stay away from']
};
const vocabCache = new Map();
function buildVocab(cfgStr, phrases) {
  const key = `${phrases.length}|${cfgStr}`;
  if (vocabCache.has(key)) return vocabCache.get(key);
  let s = ` ${normText(cfgStr)} `;
  const usedPhrases = [];
  phrases.forEach((p) => {
    if (s.includes(p)) { usedPhrases.push(p); s = s.split(p).join(' '); }
  });
  const singles = s.split(/[^a-z0-9'一-鿿-]+/)
    .filter((w) => /[一-鿿]/.test(w) || w.length >= 3);
  const vocab = { phrases: usedPhrases, singles: Array.from(new Set(singles)) };
  vocabCache.set(key, vocab);
  return vocab;
}
function countTerms(text, vocab) {
  let work = text;
  let n = 0;
  const hits = [];
  vocab.phrases.forEach((p) => {
    const re = new RegExp(escapeRe(p).replace(/\s+/g, '[\\s-]+'), 'g');
    const c = (work.match(re) || []).length;
    if (c) { n += c; hits.push(p); work = work.replace(re, ' '); }
  });
  vocab.singles.forEach((w) => {
    const re = /[一-鿿]/.test(w)
      ? new RegExp(escapeRe(w), 'g')
      : new RegExp(`(^|[^a-z0-9])${escapeRe(w)}(?![a-z0-9])`, 'g');
    const c = (work.match(re) || []).length;
    if (c) { n += c; hits.push(w); }
  });
  return { n, hits };
}

/** 为一个候选窗口打分；返回分数与命中明细 */
function scoreWindow(segs, winStart, winEnd, cfg, skus) {
  const text = segs.map((s) => s.text).join(' ');
  const low = normText(text);
  const reasons = [];

  const skuHits = matchSkus(low, skus);
  const prices = matchPrices(low);
  const cta = countTerms(ctaText(low), buildVocab(cfg.ctaWords, PHRASE_BOOK.cta));
  const pos = countTerms(low, buildVocab(cfg.positiveWords, PHRASE_BOOK.pos));
  const neg = countTerms(low, buildVocab(cfg.negativeWords, PHRASE_BOOK.neg));
  const fillers = (low.match(FILLER_RE) || []).length;

  let score = 0;
  if (skuHits.length) {
    score += Math.min(34, 18 + skuHits.length * 10);
    skuHits.slice(0, 3).forEach((h) => reasons.push({ c: 'sku', v: h.name }));
  }
  if (prices.length) {
    score += Math.min(22, 12 + prices.length * 6);
    prices.slice(0, 3).forEach((p) => reasons.push({ c: 'price', v: p }));
  }
  if (cta.n) {
    score += Math.min(20, cta.n * 7);
    reasons.push({ c: 'cta', v: String(Math.min(3, cta.n)) });
  }
  if (pos.n) {
    score += Math.min(12, pos.n * 3);
    reasons.push({ c: 'pos' });
  }
  if (neg.n) {
    score -= neg.n * 25;
    reasons.push({ c: 'neg' });
  }
  if (fillers) {
    score -= Math.min(8, fillers);
    reasons.push({ c: 'filler' });
  }
  // 纯对比展示（“拿剪刀做对比/其他直播间买的”）没有报价，不成片；
  // 有价格对比（“别家399我们199”）的窗口不受影响。
  if (!prices.length && CMP_PENALTY_RE.test(low)) {
    score -= 14;
    reasons.push({ c: 'cmp' });
  }

  const dur = winEnd - winStart;
  if (dur >= cfg.minDuration && dur <= cfg.maxDuration) score += 10;
  else { score -= 8; reasons.push({ c: 'len' }); }

  // 语速密度：每秒汉字数 / 英文词数
  const cjkCount = (low.match(CJK_RE) || []).length;
  const latinWords = (low.replace(CJK_RE, ' ').match(/[a-z0-9']{2,}/g) || []).length;
  const density = dur > 0 ? (cjkCount + latinWords) / dur : 0;
  if (density >= 1.8 && density <= 7) score += 8;
  else if (density > 0) { score -= 4; reasons.push({ c: 'density' }); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    reasons,
    skuIds: Array.from(new Set(skuHits.map((h) => h.id))),
    skuNames: Array.from(new Set(skuHits.map((h) => h.name))),
    prices,
    negCount: neg.n,
    hasHit: skuHits.length > 0 || prices.length > 0 || cta.n > 0
  };
}

/** 吸附到最近静音边界（避免硬切半句） */
function snapBoundary(raw, silences, type, probeDur) {
  let best = raw;
  let bestDist = Infinity;
  silences.forEach((z) => {
    const point = type === 'start' ? z.end : z.start;
    const dist = Math.abs(point - raw);
    if (dist < bestDist) { bestDist = dist; best = point; }
  });
  const range = type === 'start' ? 1.2 : 1.5;
  if (bestDist > range) best = raw;
  return Math.max(0, Math.min(probeDur || raw + 1, best));
}

/** 规则引擎：ASR 句段 → 候选片段 */
function buildCandidates(segments, silences, probe, cfg, skus) {
  if (!segments.length) return [];
  const ctaVocab = buildVocab(cfg.ctaWords, PHRASE_BOOK.cta);
  const negVocab = buildVocab(cfg.negativeWords, PHRASE_BOOK.neg);
  const segFeat = segments.map((s) => {
    const low = normText(s.text);
    const skuHits = matchSkus(low, skus);
    const prices = matchPrices(low);
    const cta = countTerms(ctaText(low), ctaVocab);
    const neg = countTerms(low, negVocab).n;
    return { hasAnchor: skuHits.length > 0 || prices.length > 0 || cta.n > 0, hits: skuHits.length + prices.length + cta.n, neg };
  });

  // 从每个锚点句扩张窗口
  const windows = [];
  segments.forEach((s, i) => {
    if (!segFeat[i].hasAnchor) return;
    let l = i;
    let r = i;
    let gapL = 0;     // 本侧距上一个命中句连续跨越的无命中时长（秒）
    let gapR = 0;
    let padSecs = 0;  // 窗口内无命中内容总时长（防闲聊稀释）
    const durOf = () => segments[r].end - segments[l].start;
    const fits = (nl, nr) => segments[nr].end - segments[nl].start <= cfg.maxDuration;
    // 扩张原则（按“时间”而非句数：turbo 切出的句子常只有 0.8-2s）：
    // 1) 优先并入有命中的相邻句（把同一段话术吃完整）；
    // 2) 两个命中簇之间允许跨越无命中内容去接续（每句≤6s、累计≤10s、无负向词），
    //    连续直播几乎没有静音停顿，软销话术（送礼/试吃）常夹在报价句之间；
    // 3) 时长不足最短值时再用无命中句做缓冲（每句≤8s、缓冲总时长≤20s），
    //    17s 长闲聊句因超时长永远不会被并入，最终还有最低分过滤兜底。
    const BRIDGE_SECS = 10;
    const PAD_SECS_MAX = 20;
    const hitWithin = (j, dir) => {
      let k = j;
      let cum = 0;
      while (cum < BRIDGE_SECS) {
        if (k < 0 || k >= segments.length) return false;
        const d = segments[k].end - segments[k].start;
        if (segFeat[k].neg > 0 || d > 6) return false;
        if (segFeat[k].hits > 0) return true;
        cum += d;
        k += dir;
      }
      return false;
    };
    while (durOf() < cfg.maxDuration && (l > 0 || r < segments.length - 1)) {
      const canL = l > 0 && fits(l - 1, r);
      const canR = r < segments.length - 1 && fits(l, r + 1);
      const jL = l - 1;
      const jR = r + 1;
      const hL = canL ? segFeat[jL].hits : -1;
      const hR = canR ? segFeat[jR].hits : -1;
      const dL = canL ? segments[jL].end - segments[jL].start : 0;
      const dR = canR ? segments[jR].end - segments[jR].start : 0;
      // 含负向词的句子不并入相邻窗口（避免带货段吃到“别买/假货/翻车”）。
      const mergeL = canL && segFeat[jL].neg === 0 && hL > 0;
      const mergeR = canR && segFeat[jR].neg === 0 && hR > 0;
      const bridgeL = canL && !mergeL && segFeat[jL].neg === 0 && dL <= 6 &&
        gapL + dL <= BRIDGE_SECS && hitWithin(jL, -1);
      const bridgeR = canR && !mergeR && segFeat[jR].neg === 0 && dR <= 6 &&
        gapR + dR <= BRIDGE_SECS && hitWithin(jR, 1);
      const padL = canL && !mergeL && !bridgeL && segFeat[jL].neg === 0 && dL <= 8 &&
        durOf() < cfg.minDuration && padSecs + dL <= PAD_SECS_MAX;
      const padR = canR && !mergeR && !bridgeR && segFeat[jR].neg === 0 && dR <= 8 &&
        durOf() < cfg.minDuration && padSecs + dR <= PAD_SECS_MAX;
      const okL = mergeL || bridgeL || padL;
      const okR = mergeR || bridgeR || padR;
      if (!okL && !okR) break;
      if (okL && (!okR || hL >= hR)) {
        l -= 1;
        if (hL > 0) gapL = 0;
        else { gapL += dL; padSecs += dL; }
      } else {
        r += 1;
        if (hR > 0) gapR = 0;
        else { gapR += dR; padSecs += dR; }
      }
    }
    const winSegs = segments.slice(l, r + 1);
    const rawStart = Math.max(0, winSegs[0].start - Number(cfg.leadPad || 0));
    const rawEnd = Math.min(probe.duration || winSegs[winSegs.length - 1].end, winSegs[winSegs.length - 1].end + Number(cfg.trailPad || 0));
    const start = snapBoundary(rawStart, silences, 'start', probe.duration);
    const end = snapBoundary(rawEnd, silences, 'end', probe.duration);
    const sc = scoreWindow(winSegs, start, end, cfg, skus);
    windows.push({ l, r, start, end, ...sc });
  });

  // NMS：按分排序，重叠度高的只留高分
  windows.sort((a, b) => b.score - a.score);
  const kept = [];
  const overlap = (a, b) => {
    const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
    return union > 0 ? inter / union : 0;
  };
  for (const w of windows) {
    if (kept.some((k) => overlap(k, w) > 0.35)) continue;
    kept.push(w);
  }
  // 回到时间顺序并编号；再按最低分/商品过滤
  kept.sort((a, b) => a.start - b.start);
  return kept
    .filter((w) => w.score >= cfg.minScore)
    // 成片必须有转化钩子（报价或 CTA）；只有商品名的讲解/故事段不切片，
    // 除非分极高（≥60，即多商品+多正向词的强种草段）。
    .filter((w) => w.prices.length || w.reasons.some((r) => r.c === 'cta') || w.score >= 60)
    .filter((w) => !(cfg.requireSku && !w.skuIds.length))
    .filter((w) => !(w.negCount > 0 && !w.skuIds.length))
    .slice(0, cfg.maxCandidates)
    .map((w, i) => ({
      id: `c${i + 1}`,
      start: Number(w.start.toFixed(2)),
      end: Number(w.end.toFixed(2)),
      text: segments.slice(w.l, w.r + 1).map((s) => s.text).join(' '),
      score: w.score,
      reasons: w.reasons,
      skuIds: w.skuIds,
      skuNames: w.skuNames,
      priceMatches: w.prices,
      status: cfg.autoApprove > 0 && w.score >= cfg.autoApprove ? 'approved' : 'candidate',
      output: null
    }));
}

/* ---------------- 阶段1：批量分析 ---------------- */
async function analyze(files, opts = {}, onProgress) {
  if (isBusy()) throw new Error('已有批量任务进行中');
  if (aijobs.isBusy()) throw new Error('已有 AI 任务进行中，请稍候');
  if (!Array.isArray(files) || !files.length) throw new Error('请先添加素材');
  const cfg = { ...getConfig(), ...opts };
  const skus = getSkus();
  ensureDirs();

  batch = { kind: 'analyze', canceled: false, child: null };
  const done = [];
  try {
    for (let i = 0; i < files.length; i += 1) {
      checkCanceled();
      const f = files[i];
      const meta = fileMeta(f.path || f);
      const basePct = (i / files.length) * 100;
      if (!meta) {
        onProgress({ stage: '跳过无法读取的文件', percent: basePct, index: i + 1, total: files.length, name: f.name || path.basename(String(f)) });
        continue;
      }
      const id = sourceIdOf(meta);
      const cachePath = sourcePath(id);
      const span = (p) => basePct + (p / files.length);

      if (!opts.force && fs.existsSync(cachePath)) {
        const cached = readJsonSafe(cachePath, null);
        // 模型或识别语言变化（如 tiny 换 Turbo、普通话改粤语）时缓存作废，重新 ASR
        const asrStale = cached && cached.asr
          && (cached.asr.modelId !== (cfg.modelId || 'whisper-base') || cached.asr.language !== (cfg.language || 'auto'));
        if (cached && Array.isArray(cached.candidates) && fs.existsSync(meta.path) && !asrStale) {
          // 规则/商品库变化时可直接重算候选（不重新 ASR）
          if (opts.rerunRules) {
            cached.candidates = buildCandidates(cached.asr.segments, cached.silences, cached.probe, cfg, skus);
            cached.rules = ruleSignature(cfg);
            writeJson(cachePath, cached);
          }
          done.push(summarize(cached));
          onProgress({ stage: '已分析（命中本地缓存）', percent: span(100), index: i + 1, total: files.length, name: meta.name });
          continue;
        }
      }

      onProgress({ stage: '读取视频信息', percent: span(1), index: i + 1, total: files.length, name: meta.name });
      const probe = await aijobs.probe(meta.path);
      checkCanceled();

      const jobDir = path.join(tmpDir(), id);
      fs.rmSync(jobDir, { recursive: true, force: true });
      fs.mkdirSync(jobDir, { recursive: true });
      const wav = path.join(jobDir, 'audio.wav');

      onProgress({ stage: '提取音频', percent: span(5), index: i + 1, total: files.length, name: meta.name });
      await runFf(['-y', '-i', meta.path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], null);
      checkCanceled();

      const model = hub.modelPath(cfg.modelId || 'whisper-base');
      let whisperPct = 8;
      let asrProgress = 0; // whisper 自报的 0-100（长视频首个窗口前可能长时间为 0）
      const asrStart = Date.now();
      const asrStage = cfg.language === 'yue' ? '语音识别中（粤语）' : '语音识别中';
      // Turbo 实测约 0.4 倍实时：超过 5 分钟的素材给明确等待提示，避免误判“卡死”
      const longHint = probe.duration > 300 ? 'longAsr' : '';
      const emitAsr = () => {
        const elapsed = Math.round((Date.now() - asrStart) / 1000);
        let eta = 0;
        if (asrProgress >= 3) eta = Math.max(0, Math.round(elapsed * (100 / asrProgress - 1)));
        onProgress({
          stage: asrStage, percent: span(whisperPct), index: i + 1, total: files.length, name: meta.name,
          asrElapsed: elapsed, asrEta: eta, hint: longHint
        });
      };
      emitAsr();
      // 心跳：模型加载 + 首个 30s 窗口约 20-60s 没有 progress 行，也要让用户看到时间在走
      const heartbeat = setInterval(emitAsr, 3000);
      let segments, languageUsed;
      try {
        ({ segments, languageUsed } = await runWhisper(wav, model, cfg.modelId || 'whisper-base', cfg.language || 'auto', jobDir, (line) => {
          const m = line.match(/progress\s*=\s*(\d+)/i);
          if (m) {
            asrProgress = Number(m[1]);
            whisperPct = 8 + Math.min(78, asrProgress * 0.7);
            emitAsr();
          }
        }, skus));
      } finally {
        clearInterval(heartbeat);
      }
      checkCanceled();

      onProgress({ stage: '检测停顿', percent: span(88), index: i + 1, total: files.length, name: meta.name });
      const silences = await detectSilence(meta.path, cfg.silenceDb, cfg.silenceDur);
      checkCanceled();

      onProgress({ stage: '规则匹配与打分', percent: span(94), index: i + 1, total: files.length, name: meta.name });
      const candidates = buildCandidates(segments, silences, probe, cfg, skus);

      const rec = {
        version: 1,
        id,
        source: { id, path: meta.path, name: meta.name, size: meta.size, mtimeMs: meta.mtimeMs },
        probe,
        asr: {
          engine: 'whisper',
          modelId: cfg.modelId || 'whisper-base',
          language: cfg.language || 'auto',
          languageUsed,
          segments,
          createdAt: new Date().toISOString()
        },
        silences,
        rules: ruleSignature(cfg),
        candidates,
        analyzedAt: new Date().toISOString()
      };
      writeJson(cachePath, rec);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
      done.push(summarize(rec));
      onProgress({ stage: '分析完成', percent: span(100), index: i + 1, total: files.length, name: meta.name });
    }
    onProgress({ stage: '全部完成', percent: 100, index: files.length, total: files.length, name: '' });
    return done;
  } finally {
    batch = null;
  }
}

function ruleSignature(cfg) {
  const keys = ['minDuration', 'maxDuration', 'targetDuration', 'leadPad', 'trailPad', 'silenceDb', 'silenceDur',
    'maxCandidates', 'minScore', 'autoApprove', 'requireSku', 'positiveWords', 'ctaWords', 'negativeWords'];
  const sig = {};
  keys.forEach((k) => { sig[k] = cfg[k]; });
  return sig;
}

function summarize(rec) {
  const c = rec.candidates || [];
  return {
    id: rec.id,
    name: rec.source.name,
    path: rec.source.path,
    exists: fs.existsSync(rec.source.path),
    size: rec.source.size,
    duration: rec.probe.duration,
    width: rec.probe.width,
    height: rec.probe.height,
    languageUsed: rec.asr.languageUsed,
    modelId: rec.asr.modelId,
    segCount: (rec.asr.segments || []).length,
    total: c.length,
    approved: c.filter((x) => x.status === 'approved').length,
    rejected: c.filter((x) => x.status === 'rejected').length,
    analyzedAt: rec.analyzedAt
  };
}

function listSources() {
  ensureDirs();
  let files = [];
  try { files = fs.readdirSync(sourcesDir()); } catch (_) { return []; }
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJsonSafe(path.join(sourcesDir(), f), null))
    .filter(Boolean)
    .map(summarize)
    .sort((a, b) => String(b.analyzedAt).localeCompare(String(a.analyzedAt)));
}

function getSource(id) {
  const rec = readJsonSafe(sourcePath(id), null);
  if (!rec) throw new Error('片段库不存在或已被删除');
  rec.summary = summarize(rec);
  return rec;
}

function updateCandidate(id, cid, patch) {
  const rec = readJsonSafe(sourcePath(id), null);
  if (!rec) throw new Error('片段库不存在');
  const c = (rec.candidates || []).find((x) => x.id === cid);
  if (!c) throw new Error('候选片段不存在');
  if (patch.status) {
    if (!['candidate', 'approved', 'rejected'].includes(patch.status)) throw new Error('状态无效');
    c.status = patch.status;
  }
  if (Number.isFinite(Number(patch.start))) {
    const v = Math.max(0, Math.min(c.end - 1, Number(patch.start)));
    c.start = Number(v.toFixed(2));
  }
  if (Number.isFinite(Number(patch.end))) {
    const v = Math.max(c.start + 1, Number(patch.end));
    c.end = Number(v.toFixed(2));
  }
  writeJson(sourcePath(id), rec);
  return summarize(rec);
}

function removeSource(id) {
  try { fs.unlinkSync(sourcePath(id)); } catch (_) {}
  return true;
}

/* ---------------- 阶段3：批量导出 ---------------- */
function srtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const ms = Math.round(sec * 1000);
  const p = (x, l = 2) => String(x).padStart(l, '0');
  return `${p(ms / 3600000 | 0)}:${p((ms % 3600000) / 60000 | 0)}:${p((ms % 60000) / 1000 | 0)},${p(ms % 1000, 3)}`;
}
/* 字幕按显示宽度折行（中文/全角记 2，西文记 1）。
   libass 实际字宽约为 Fontsize 的 2.65px，按视频宽度与字号反推每行容量。 */
function subtitleMaxWidth(fontSize, videoWidth) {
  const w = videoWidth || 720;
  const fs = Number(fontSize) || 18;
  return Math.max(14, Math.floor((w * 0.86) / (fs * 1.325)));
}
function wrapSubtitle(text, maxWidth = 23) {
  const str = String(text).replace(/\s+/g, ' ').trim();
  // 中文/全角记 2，数字与大写字母实测接近全角也记 2，其余西文记 1
  const width = (ch) => (/[　-鿿＀-￯0-9A-Z]/.test(ch) ? 2 : 1);
  const out = [];
  let line = '';
  let w = 0;
  for (const ch of str) {
    const cw = width(ch);
    if (w + cw > maxWidth && line) {
      out.push(line);
      line = '';
      w = 0;
    }
    line += ch;
    w += cw;
  }
  if (line) out.push(line);
  return out.join('\n');
}
function buildClipSrt(segments, start, end, maxWidth) {
  const lines = [];
  let idx = 1;
  segments.forEach((s) => {
    const a = Math.max(s.start, start);
    const b = Math.min(s.end, end);
    if (b - a < 0.12) return;
    lines.push(`${idx}\n${srtTime(a - start)} --> ${srtTime(b - start)}\n${wrapSubtitle(s.text.trim(), maxWidth)}\n`);
    idx += 1;
  });
  return lines.join('\n');
}

/* ---------------- 成片风格化：行楷花字贴片（黄字红边，弹入） ---------------- */
// 只打两类点：① 报价（¥199 / 一百九十九蚊）② 高转化短语。每片最多 2 条，宁少勿多。
const FX_PHRASES = ['买一送一', '免费送', '送一包', '再送', '秒杀', '手慢无', '包邮', '上架', '福利价', '特价', '到手价', '试一试', '最后', '库存', '买它'];
let _fxFont = null;
function fxFontFile() {
  if (_fxFont !== null) return _fxFont || null;
  const cands = [];
  try {
    const root = '/System/Library/AssetsV2/com_apple_MobileAsset_Font8';
    if (fs.existsSync(root)) {
      fs.readdirSync(root).forEach((d) => {
        const p = path.join(root, d, 'AssetData');
        const xk = path.join(p, 'Xingkai.ttc');
        if (fs.existsSync(xk)) cands.push(xk);
        const ww = path.join(p, 'WawaSC-Regular.otf');
        if (fs.existsSync(ww)) cands.push(ww);
      });
    }
  } catch (_) {}
  cands.push('/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/PingFang.ttc');
  _fxFont = cands.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || '';
  return _fxFont || null;
}

// 从一句识别文本中提取花字文案（报价优先）；无则返回 null。小面额（<10）信息量低，不上花字
function fxTextFromSeg(segText) {
  const t = String(segText || '');
  const m = t.match(/(\d{1,5})(?:\.(\d{1,2}))?\s*(?:蚊鸡|蚊|块钱|块|元钱|元|圆)/);
  if (m) {
    if (Number(`${m[1]}.${m[2] || 0}`) < 10) return null;
    return `¥${m[1]}${m[2] ? '.' + m[2] : ''}`;
  }
  const zh = zhPrices(t);
  if (zh.length && Number(zh[0]) >= 10) return `¥${zh[0]}`;
  for (const p of FX_PHRASES) if (t.includes(p)) return p;
  return null;
}

/* 选择本片段的花字时间点：[{t:相对秒, text}]；只看片段内开始的句子 */
function pickStickerMoments(segments, start, end, duration) {
  if (duration < 3.6) return [];
  const maxN = duration < 6.5 ? 1 : 2;
  const minGap = 2.4;
  const picked = [];
  (segments || []).forEach((s) => {
    if (picked.length >= maxN) return;
    if (s.start < start - 0.05 || s.start >= end - 0.2) return;
    const text = fxTextFromSeg(s.text);
    if (!text) return;
    const isPrice = text.startsWith('¥');
    const rel = Math.max(0.85, Number((s.start - start + 0.12).toFixed(2)));
    if (rel + 1.8 > duration - 0.15) return; // 贴片尾部留余量
    if (picked.some((e) => Math.abs(e.t - rel) < minGap)) return;
    picked.push({ t: rel, text, price: isPrice });
  });
  picked.sort((a, b) => (a.price === b.price ? a.t - b.t : a.price ? -1 : 1));
  return picked.slice(0, maxN).map(({ t, text }) => ({ t, text }));
}

/* 花字画布尺寸（与 makeStickerPng 保持一致），用于叠加时的缩放基准 */
function stickerSize(text) {
  const fsPx = 96;
  let w = 30;
  for (const ch of text) w += /[\x20-\x7e]/.test(ch) ? fsPx * 0.62 : fsPx * 1.06;
  return { cw: Math.ceil(w + 56), chH: Math.ceil(fsPx * 1.72 + 48) };
}

/* 用 ffmpeg 生成透明底花字 PNG：黄色外发光 + 深红描边 + 明黄填充 */
async function makeStickerPng(text, outPath) {
  const font = fxFontFile();
  if (!font) return null;
  const { cw, chH } = stickerSize(text);
  const fsPx = 96;
  const pos = `x=(w-tw)/2:y=(h-th)/2`;
  const common = `fontfile='${font}':textfile=fx.txt:fontsize=${fsPx}:${pos}`;
  const vf = [
    `format=rgba,colorchannelmixer=aa=0,drawtext=${common}:fontcolor=yellow@0.0:borderw=22:bordercolor=0xFFC800@0.5,boxblur=8:1`,
    `drawtext=${common}:fontcolor=yellow@0.0:borderw=12:bordercolor=0xB00000:shadowcolor=black@0.55:shadowx=3:shadowy=4`,
    `drawtext=${common}:fontcolor=0xFFE33A:borderw=0`
  ].join(',');
  fs.writeFileSync(path.join(path.dirname(outPath), 'fx.txt'), text, 'utf8');
  try {
    await runFf(['-v', 'error', '-f', 'lavfi', '-i', `color=black:s=${cw}x${chH}:d=1`,
      '-vf', vf, '-frames:v', '1', '-y', outPath], () => {}, path.dirname(outPath));
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 0 ? { cw, chH } : null;
  } catch (e) {
    return null;
  }
}

function tsName() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function safeName(s) {
  return String(s).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80).trim() || 'clip';
}

async function render(options = {}, onProgress) {
  if (isBusy()) throw new Error('已有批量任务进行中');
  if (aijobs.isBusy()) throw new Error('已有 AI 任务进行中，请稍候');
  const cfg = { ...getConfig(), ...options };
  ensureDirs();

  // 收集全部已通过候选
  const jobs = [];
  listSources().forEach((sum) => {
    if (options.sourceIds && options.sourceIds.length && !options.sourceIds.includes(sum.id)) return;
    if (!sum.exists) return;
    const rec = readJsonSafe(sourcePath(sum.id), null);
    if (!rec) return;
    (rec.candidates || []).forEach((c) => {
      if (c.status === 'approved') jobs.push({ rec, c });
    });
  });
  if (!jobs.length) throw new Error('没有已通过的候选片段，请先在审核区通过至少一个片段');

  const batchName = options.batchName ? safeName(options.batchName) : `clips-${tsName()}`;
  const outDir = path.join(store.get().downloadDir || app.getPath('downloads'), 'TokPure-Clips', batchName);
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = path.join(tmpDir(), `render-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  batch = { kind: 'render', canceled: false, child: null };
  const manifest = [];
  try {
    for (let i = 0; i < jobs.length; i += 1) {
      checkCanceled();
      const { rec, c } = jobs[i];
      const input = rec.source.path;
      const base = safeName(rec.source.name);
      const outFile = path.join(outDir, `${base}-${String(i + 1).padStart(2, '0')}.mp4`);
      const duration = c.end - c.start;
      const span = (p) => ((i + p) / jobs.length) * 100;

      const maxWidth = subtitleMaxWidth(cfg.fontSize, rec.probe && rec.probe.width);
      const srt = buildClipSrt(rec.asr.segments || [], c.start, c.end, maxWidth);
      const useSub = cfg.burnSubtitles && srt.trim();
      if (useSub) fs.writeFileSync(path.join(workDir, 'sub.srt'), '﻿' + srt, 'utf8');

      onProgress({ stage: `导出 ${i + 1}/${jobs.length}`, percent: span(0), index: i + 1, total: jobs.length, name: path.basename(outFile) });

      const DUR = duration;
      const probe = rec.probe || {};
      const W = (probe.width || 720) - ((probe.width || 720) % 2);
      const H = (probe.height || 1280) - ((probe.height || 1280) % 2);
      const polish = !!cfg.polishStyle;
      const hasAudio = probe.hasAudio !== false;
      const forceStyle = `Fontsize=${Number(cfg.fontSize) || 18},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,MarginV=${Number(cfg.marginV) || 64}`;

      // 花字贴片：先生成 PNG（失败/无字则跳过，绝不阻断导出）
      let stickers = [];
      if (polish && fxFontFile()) {
        const moments = pickStickerMoments(rec.asr.segments || [], c.start, c.end, DUR);
        for (let k = 0; k < moments.length; k += 1) {
          const dim = await makeStickerPng(moments[k].text, path.join(workDir, `fx${k}.png`));
          if (dim) stickers.push({ ...moments[k], ...dim });
        }
      }

      const ffArgs = ['-y', '-ss', String(c.start), '-i', input];
      let needCwd = useSub;
      let mapAudio = true;

      if (polish) {
        const bgmPath = audiofx.audioAsset('bgm-bed.wav');
        const useBgm = fs.existsSync(bgmPath);
        let bgmIdx = -1;
        if (useBgm) {
          bgmIdx = 1;
          ffArgs.push('-stream_loop', '-1', '-i', bgmPath);
        }
        stickers.forEach((s, k) => {
          ffArgs.push('-loop', '1', '-t', DUR.toFixed(3), '-i', path.join(workDir, `fx${k}.png`));
        });
        // 音效轨：片头 whoosh + 花字 pop（纯合成，随片生成）
        const sfxIdx = 1 + (useBgm ? 1 : 0) + stickers.length;
        const sfxPath = path.join(workDir, 'sfx.wav');
        audiofx.buildSfxTrack(DUR, stickers.map((s) => ({ t: s.t, type: 'pop' })), sfxPath);
        ffArgs.push('-i', sfxPath);
        ffArgs.push('-t', DUR.toFixed(3));

        const fc = [];
        const vchain = [];
        // 片头 0.5s 轻微推近（约 7%，呼应目标片的开场节奏）；zoompan 逐帧求值，crop 的 w/h 不支持
        if (cfg.hookZoom !== false) {
          const fps = Math.max(1, Number(probe.fps) || 30);
          const zn = Math.max(2, Math.round(fps * 0.5));
          vchain.push(`zoompan=z='1+0.07*(1-min(1\\,on/${zn}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},setsar=1`);
        }
        if (useSub) vchain.push(`subtitles=sub.srt:force_style='${forceStyle}'`);

        // 弹入：0→0.14s 从 0.55 放大到 1.15（过冲），0.14→0.30s 回落到 1.0；末段 0.22s 淡出
        const LIFE = 1.9;
        stickers.forEach((s, k) => {
          const inIdx = 1 + (useBgm ? 1 : 0) + k;
          const Ts = Number(s.t.toFixed(2));
          const Te = Number((Ts + LIFE).toFixed(2));
          const bs = (W * 0.72 / s.cw).toFixed(4);
          const dt = `(t-${Ts})`;
          const pop = `if(lt(${dt}\\,0.14)\\,0.55+0.60*${dt}/0.14\\,if(lt(${dt}\\,0.3)\\,1.15-0.15*(${dt}-0.14)/0.16\\,1))`;
          fc.push(`[${inIdx}:v]format=rgba,fade=t=in:st=${Ts}:d=0.1:alpha=1,fade=t=out:st=${(Te - 0.22).toFixed(2)}:d=0.22:alpha=1,scale=w='trunc(iw*${bs}*${pop}/2)*2':h=-2:eval=frame:flags=lanczos[s${k}]`);
        });
        if (stickers.length) {
          fc.push(`[0:v]${vchain.join(',')}[vbase]`);
          let acc = 'vbase';
          stickers.forEach((s, k) => {
            const Ts = Number(s.t.toFixed(2));
            const Te = Number((s.t + LIFE).toFixed(2));
            const out = k === stickers.length - 1 ? 'vout' : `va${k}`;
            fc.push(`[${acc}][s${k}]overlay=x=(W-w)/2:y='(H-h)*0.40':enable='between(t\\,${Ts}\\,${Te})':eof_action=pass[${out}]`);
            acc = out;
          });
        } else {
          fc.push(`[0:v]${vchain.join(',') || 'null'}[vout]`);
        }

        const vol = Math.min(0.6, Math.max(0, Number(cfg.bgmVolume) || 0.3));
        const fo = Math.max(0.2, DUR - 0.8).toFixed(2);
        const master = 'alimiter=limit=0.95,loudnorm=I=-16:TP=-1.2:LRA=11,aresample=44100';
        if (useBgm && hasAudio) {
          fc.push(`[${bgmIdx}:a]atrim=0:${DUR.toFixed(3)},asetpts=PTS-STARTPTS,volume=${vol},afade=t=in:st=0:d=0.4,afade=t=out:st=${fo}:d=0.8[bg]`);
          fc.push('[bg][0:a]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=350:makeup=1[duck]');
          fc.push(`[0:a][duck][${sfxIdx}:a]amix=inputs=3:duration=first:weights=1 0.9 0.85:normalize=0,${master}[aout]`);
        } else if (useBgm) {
          fc.push(`[${bgmIdx}:a]atrim=0:${DUR.toFixed(3)},asetpts=PTS-STARTPTS,volume=${(vol * 1.7).toFixed(2)},afade=t=in:st=0:d=0.4,afade=t=out:st=${fo}:d=0.8[bg]`);
          fc.push(`[bg][${sfxIdx}:a]amix=inputs=2:duration=first:weights=1 0.9:normalize=0,${master}[aout]`);
        } else if (hasAudio) {
          fc.push(`[0:a][${sfxIdx}:a]amix=inputs=2:duration=first:weights=1 0.85:normalize=0,${master}[aout]`);
        } else {
          mapAudio = false;
        }

        ffArgs.push('-filter_complex', fc.join(';'), '-map', '[vout]');
        if (mapAudio) ffArgs.push('-map', '[aout]');
        ffArgs.push('-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
        ffArgs.push(...(mapAudio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']), '-movflags', '+faststart', outFile);
        needCwd = true;
      } else {
        if (useSub) ffArgs.push('-vf', `subtitles=sub.srt:force_style='${forceStyle}'`);
        ffArgs.push('-t', DUR.toFixed(3), '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outFile);
      }

      await runFf(ffArgs, (line) => {
        const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m && DUR > 0) {
          const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          onProgress({ stage: `导出 ${i + 1}/${jobs.length}`, percent: span(Math.min(0.98, t / DUR)), index: i + 1, total: jobs.length, name: path.basename(outFile) });
        }
      }, needCwd ? workDir : undefined);
      checkCanceled();

      c.output = outFile;
      writeJson(sourcePath(rec.id), rec);
      manifest.push({
        file: path.basename(outFile),
        source: rec.source.name,
        sourcePath: rec.source.path,
        start: c.start,
        end: c.end,
        duration: Number(duration.toFixed(2)),
        score: c.score,
        skus: c.skuNames || [],
        prices: c.priceMatches || [],
        text: c.text
      });
      onProgress({ stage: `导出 ${i + 1}/${jobs.length}`, percent: span(1), index: i + 1, total: jobs.length, name: path.basename(outFile) });
    }

    writeJson(path.join(outDir, 'manifest.json'), { batch: batchName, createdAt: new Date().toISOString(), count: manifest.length, clips: manifest });
    const escCsv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const csv = [['文件', '来源素材', '开始', '结束', '时长', '分数', '商品', '价格', '文案'].join(',')];
    manifest.forEach((m) => csv.push([
      escCsv(m.file), escCsv(m.source), m.start, m.end, m.duration, m.score,
      escCsv(m.skus.join(';')), escCsv(m.prices.join(';')), escCsv(m.text)
    ].join(',')));
    fs.writeFileSync(path.join(outDir, 'manifest.csv'), '﻿' + csv.join('\n'), 'utf8');

    onProgress({ stage: '全部导出完成', percent: 100, index: jobs.length, total: jobs.length, name: '' });
    return { dir: outDir, count: jobs.length };
  } finally {
    batch = null;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  pickFiles,
  scanDir,
  getConfig,
  saveConfig,
  getSkus,
  saveSkus,
  importSkusCsv,
  exportSkusCsv,
  analyze,
  listSources,
  getSource,
  updateCandidate,
  removeSource,
  render,
  cancel,
  isBusy
};
