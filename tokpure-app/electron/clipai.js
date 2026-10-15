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
const { resolveStyle, styleList, DEFAULT_STYLE_ID } = require('./stylepresets');

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
  fontSize: 20,              // 与默认风格模版「活力带货」对齐
  marginV: 84,
  subtitleColor: 'white',    // 字幕颜色预设：white|yellow|green|cyan|pink
  polishStyle: true,         // 成片增强：BGM 垫底 + whoosh/pop 音效 + 花字弹出
  bgmVolume: 0.5,            // BGM 原始音量（人声侧链闪避后仍可清晰听到垫底）
  styleTemplate: 'vital-sale', // 爆款风格模版：字幕/剪辑/贴片/BGM 成套生效
  hookZoom: true,            // 片头 0.5s 轻微推近
  visualCheck: true,         // 画面有效性检测：黑屏/纯色/静止画面的候选自动淘汰（不合规成片拦截）
  coverArt: true,            // 导出时自动生成短视频封面（最佳帧+标题花字）并写入 mp4
  composeMode: true,         // 结构化组片：钩子+产品介绍+价格机制 三段拼装成带货短视频
  targetShort: 50,           // 组片目标时长（秒），产出 30-90s、多数 50s 左右
  dedupeFx: true,            // 去重变换：连续缩放 + 随机水平翻转 + 滤镜预设轮换，素材成片互不撞车
  insertShots: false,        // 关键字画中画插镜头：说到关键字时右上角弹出商品展示镜头
  shotsDir: '',              // 「镜头」文件夹（商品展示镜头库，画中画素材来源）
  shotKeywords: '看这个 就这个 就是它 给你们看 看一眼 拍一下 上车 走一个 这个好 look at this take a look check this out',
  funnyQuotes: '',           // 直播间金句/语录库（分号或换行分隔，命中判为「金句钩子」）
  subtitleFixes: '',         // 字幕纠错表：错词=正词，分号或换行分隔（ASR 错别字热词修正）
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
/** 以二进制方式收集 ffmpeg stdout（rawvideo 管道用，runCmd 的字符串收集会破坏字节流） */
function runFfBuf(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegMod.getFfmpegPath(), args, { windowsHide: true });
    if (batch) batch.child = child;
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 20000) stderr = stderr.slice(-10000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (batch && batch.child === child) batch.child = null;
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/* ---------------- 画面有效性检测（黑屏/纯色/静止 → 不合规成片拦截） ----------------
   反例：合成测试素材（纯色静帧）被切成“黑屏+字幕”成片，与原片内容毫无关联。
   做法：把片段降采样为 24x24 灰度 rawvideo，在 Node 侧统计
     detail  帧内空间标准差（纯色画面≈0，任何真实内容>10）
     motion  相邻帧平均差（静止画面≈0，真实拍摄>0.5）
     dark    平均亮度（黑屏≈16）与暗帧占比
   检测失败不误杀（返回 valid:true），绝不阻断导出主流程。 */
const VIS_GRID = 24;
async function sampleGrayFrames(input, start, dur, fps, grid) {
  const g = grid || VIS_GRID;
  const buf = await runFfBuf([
    '-v', 'error', '-ss', String(Math.max(0, start)), '-t', String(Math.max(0.3, dur)),
    '-i', input, '-vf', `fps=${fps},scale=${g}:${g},format=gray`, '-f', 'rawvideo', '-'
  ]);
  const n = g * g;
  const total = Math.floor(buf.length / n);
  const frames = [];
  for (let f = 0; f < total; f += 1) {
    const off = f * n;
    let s = 0;
    for (let i = 0; i < n; i += 1) s += buf[off + i];
    const mean = s / n;
    let sq = 0;
    for (let i = 0; i < n; i += 1) { const d = buf[off + i] - mean; sq += d * d; }
    frames.push({ mean, detail: Math.sqrt(sq / n) });
  }
  let motion = 0;
  for (let f = 1; f < total; f += 1) {
    let md = 0;
    const off = f * n;
    for (let i = 0; i < n; i += 1) md += Math.abs(buf[off + i] - buf[off - n + i]);
    motion += md / n;
  }
  return { frames, motion: total > 1 ? motion / (total - 1) : 0 };
}

/** 判定一个候选窗口的画面是否有效；返回 {valid, detail, motion, darkRatio} 持久化到候选 */
async function checkVisual(input, start, dur) {
  try {
    // 只采样片段前 8s（无效画面从第一帧就是无效的），1.5fps 足够判断
    const st = await sampleGrayFrames(input, start + 0.1, Math.min(8, Math.max(1.5, dur)), 1.5);
    if (!st.frames.length) return { valid: true, skip: true };
    const dark = st.frames.filter((f) => f.mean < 20).length;
    const darkRatio = dark / st.frames.length;
    const brightness = st.frames.reduce((a, f) => a + f.mean, 0) / st.frames.length;
    const detail = st.frames.reduce((a, f) => a + f.detail, 0) / st.frames.length;
    const black = darkRatio > 0.8 || brightness < 22;
    const plain = detail < 3.0;                              // 纯色/合成画面
    const frozen = st.motion < 0.35 && detail < 12;          // 冻结静帧（带噪声的停帧）
    const invalid = black || plain || frozen;
    const out = { valid: !invalid, detail: Number(detail.toFixed(2)), motion: Number(st.motion.toFixed(3)), darkRatio: Number(darkRatio.toFixed(2)) };
    return out;
  } catch (e) {
    return { valid: true, skip: true }; // 检测异常不误杀
  }
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

/* ---------------- 结构化素材（钩子库 / 产品介绍库 / 价格机制库） ----------------
   三宝扎类素材拍摄时就按三段结构分好文件夹：导入时标记角色，组片引擎按
   「钩子 → 介绍 → 价格」拼装成 30-90s 带货短视频（目标 50s）。 */
const ROLES = {
  hook: { label: '钩子', minDuration: 4, maxCandidates: 30 },
  intro: { label: '介绍', minDuration: 12, maxCandidates: 20 },
  price: { label: '价格', minDuration: 6, maxCandidates: 24 }
};
/** 组片时的角色专属参数：钩子允许更短的片段（开场只要 3-10 秒） */
function roleCfg(cfg, role) {
  const r = ROLES[role];
  if (!r) return cfg;
  return { ...cfg, minDuration: r.minDuration, maxCandidates: r.maxCandidates };
}
async function pickStructureFolder(role) {
  const label = (ROLES[role] || {}).label || role;
  const res = await dialog.showOpenDialog({
    title: `选择「${label}」素材文件夹（自动递归扫描）`,
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return { role, files: [] };
  const root = res.filePaths[0];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6 || out.length > 2000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    entries.forEach((e) => {
      if (e.name.startsWith('.') || e.name === 'node_modules') return;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, depth + 1);
      else {
        const m = fileMeta(fp);
        if (m) out.push({ ...m, role });
      }
    });
  };
  walk(root, 0);
  return { role, dir: root, files: out };
}
function setSourceRole(id, role) {
  const rec = readJsonSafe(sourcePath(id), null);
  if (!rec) throw new Error('片段库不存在');
  rec.structureRole = ROLES[role] ? role : null;
  // 角色变化影响候选时长规则，重建候选（复用已落盘 ASR，不重新识别）
  const cfg = getConfig();
  rec.candidates = buildCandidates(rec.asr.segments || [], rec.silences || [], rec.probe || {}, roleCfg(cfg, rec.structureRole), getSkus());
  rec.rules = ruleSignature(cfg);
  writeJson(sourcePath(id), rec);
  return summarize(rec);
}

/* ---------------- 钩子分类器（纯规则，无需云端模型） ----------------
   五类钩子：question 提问钩子 / price 价格钩子 / sellingPoint 卖点开头 /
   funny 金句笑点（语录库命中）/ soft 软性带货（探店玩乐植入） */
const HOOK_Q = /见过|有没有|听过|听说过|知道吗|你们猜|猜猜|是什么|什么是|居然|竟然|谁懂|有人认识|认识这个|见过没|没见过|看过没|你敢信|难以置信|猜不到|看看这个|你见过|信不信|离谱|逆天|什么东西|why|guess what|have you seen|ever seen|did you know|can you believe/i;
const HOOK_PRICE = /破价|市面|专柜|只要|低至|机制|买一送|拍一发|补贴|清仓|特价|白送|免费送|送一包|再送|送东西|送你|有送|工厂价|源头|批发|亏本|亏钱|放血|地板价|全网最低|跳楼价|清货|打骨折|骨折价|破盘价|never this cheap|best price/i;
const HOOK_SP = /吃了|用了|喝了|吃下去|喝下去|连续吃|见效|有效果|功效|效果|改善|帮助|含有|富含|古法|百年|秘方|调理|养生|上火|祛湿|化痰|润肺|养胃|补气|补血|健脾|失眠|手脚冰|体质|适合哪|什么人|建议|坚持|customary|benefit|good for/i;
const HOOK_SOFT = /今天带大家|今天去|探店|打卡|去玩|逛一逛|逛逛|游玩|旅行|日常|跟着我|带你们|周末|好去处|一日游|探秘|揭秘|产地|vlog|come with me|day out/i;

/** 对候选开头 6 秒内的文本判钩子类型；返回 {type, hit} */
function classifyHook(text6, cfg) {
  const t = matchText(text6, cfg); // 钩子词表按简体写，粤语繁体输出先归一再判型
  if (!t.trim()) return { type: 'normal', hit: '' };
  const quotes = String(cfg.funnyQuotes || '').split(/[;;\n]/).map((s) => s.trim()).filter((s) => s.length >= 2);
  for (const q of quotes) {
    if (t.includes(q)) return { type: 'funny', hit: q };
  }
  const mq = t.match(HOOK_Q);
  if (mq) return { type: 'question', hit: mq[0] };
  const mp = t.match(HOOK_PRICE);
  if (mp) return { type: 'price', hit: mp[0] };
  const ms = t.match(HOOK_SP);
  if (ms) return { type: 'sellingPoint', hit: ms[0] };
  const mf = t.match(HOOK_SOFT);
  if (mf) return { type: 'soft', hit: mf[0] };
  return { type: 'normal', hit: '' };
}
const HOOK_LABEL = {
  funny: '金句钩子',
  question: '提问钩子',
  price: '价格钩子',
  sellingPoint: '卖点开头',
  soft: '软性带货',
  normal: '常规'
};

/* 钩子开场包装：按钩子类型在片头叠开场大字花字（老粉一眼识别 IP/钩子类型）。
   模板为通用包装语（不硬编码具体商品），随机选取避开与开头话术重复。 */
const HOOK_STICKERS = {
  funny: ['铭哥名场面', '经典语录', '名场面来了', '老粉都懂'],
  question: ['见过这个没有？', '你们见过没？', '认识这个吗？', '猜猜这是什么'],
  price: ['今天破价了', '机制来了', '手慢无', '只有这个价'],
  sellingPoint: ['吃过的都说好', '效果看这里', '这么吃才对', '坚持吃的变化'],
  soft: ['今天带大家', '跟我逛一天', '日常探店', '好去处分享']
};
function pickHookStickerText(type, firstSegText) {
  const pool = HOOK_STICKERS[type];
  if (!pool) return '';
  const t = String(firstSegText || '');
  const cands = pool.filter((x) => !t.includes(x.replace(/[？?！!]/g, '')));
  const src = cands.length ? cands : pool;
  return src[Math.floor(Math.random() * src.length)];
}

/* ---------------- 字幕热词纠错（ASR 错别字修正，字幕/花字/封面统一应用） ----------------
   三层：手动纠错表最优先 → 内置带货高频错字词典 → 商品库同音错字模糊匹配。
   模糊匹配只接受「等长且恰好一个字不同」的窗口（中文 ASR 同音/近音错字的
   绝对主流形态），其余形态误伤率高一律不动。 */
const BUILTIN_FIXES = [
  ['沉皮', '陈皮'], ['成皮', '陈皮'], ['臣皮', '陈皮'], ['尘皮', '陈皮'], ['橙皮', '陈皮'],
  ['陈皮', '陈皮'], ['沉培', '陈皮'], ['尘培', '陈皮'], ['陈培', '陈皮'], ['沉赔', '陈皮'],
  ['新汇', '新会'], ['新晖', '新会'], ['薪会', '新会'],
  ['三煲扎', '三宝扎'], ['三保扎', '三宝扎'], ['三宝渣', '三宝扎'],
  ['金保保', '金宝宝'], ['金抱抱', '金宝宝'], ['今宝宝', '金宝宝'],
  ['鹿飞丸', '鹿肺丸'], ['鹿费丸', '鹿肺丸'], ['露肺丸', '鹿肺丸'],
  ['牡利素', '牡蛎素'], ['牡砺素', '牡蛎素'], ['暮蛎素', '牡蛎素'],
  ['冲屎茶', '虫屎茶'], ['重屎茶', '虫屎茶'], ['虫使茶', '虫屎茶'],
  ['保邮', '包邮'], ['包由', '包邮'], ['葆邮', '包邮'],
  ['离盒', '礼盒'], ['理盒', '礼盒'], ['礼合', '礼盒']
];
const AUTO_FIX_CACHE = { sig: '', lex: [] };
function autoFixLexicon(cfg) {
  const sig = `${(cfg && cfg.subtitleFixes) || ''}|${JSON.stringify(getSkus().map((s) => [s.name, s.aliases || []]))}`;
  if (AUTO_FIX_CACHE.sig === sig) return AUTO_FIX_CACHE.lex;
  const lex = new Set();
  BUILTIN_FIXES.forEach(([, good]) => lex.add(good));
  getSkus().forEach((sku) => {
    [sku.name, ...(sku.aliases || [])].forEach((n) => {
      const t = String(n || '').trim();
      if (t.length >= 2 && !/[a-zA-Z0-9]/.test(t)) lex.add(t); // 纯中文词才做同音字模糊匹配
    });
  });
  const out = [...lex].sort((a, b) => b.length - a.length); // 长词优先，避免短词破坏长词窗口
  AUTO_FIX_CACHE.sig = sig;
  AUTO_FIX_CACHE.lex = out;
  return out;
}
function applySubtitleFixes(t, cfg) {
  let out = String(t || '');
  // 1) 手动纠错表（用户声明，直接替换）
  String((cfg && cfg.subtitleFixes) || '').split(/[;;\n]/).forEach((pair) => {
    const i = pair.indexOf('=');
    if (i <= 0) return;
    const a = pair.slice(0, i).trim();
    const b = pair.slice(i + 1).trim();
    if (a) out = out.split(a).join(b);
  });
  // 2) 内置词典
  BUILTIN_FIXES.forEach(([bad, good]) => { out = out.split(bad).join(good); });
  // 3) 商品库同音错字：仅 ≥3 字词参与（2 字词单字差误伤面大，走内置词典/手动表）；
  //    等长窗口恰好一个字不同 → 替换为词库词（同音/近音错字的绝对主流形态）
  const lex = autoFixLexicon(cfg);
  const isWordChar = (ch) => ch && /[\u4e00-\u9fff0-9a-zA-Z]/.test(ch);
  for (const w of lex) {
    const n = w.length;
    if (n < 3) continue;
    for (let i = 0; i + n <= out.length; i += 1) {
      let diff = 0;
      for (let j = 0; j < n; j += 1) if (out[i + j] !== w[j]) { diff += 1; if (diff > 1) break; }
      if (diff !== 1) continue;
      if (isWordChar(out[i - 1]) || isWordChar(out[i + n])) continue; // 不拆更长词
      out = out.slice(0, i) + w + out.slice(i + n);
      i += n - 1;
    }
  }
  return out;
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
function buildWhisperPrompt(language, skus, cfg) {
  const base = {
    zh: '以下是直播带货口播，包含商品名称、原价、到手价、包邮、点击链接、马上下单、限时优惠、库存不多、买它等话术。',
    yue: '以下係粵語直播帶貨口播，包含商品名稱、原價、到手價、包郵、一號連結、即刻落單、限時優惠、貨源唔多、快啲搶、買佢等講法。',
    en: 'The following is a live shopping stream pitch with product names, original price, deal price, free shipping, click the link, order now, limited time offer, limited stock.'
  };
  let p = base[language] || base.zh + ' ' + base.en;
  // 把商品库名称/别名注入提示词，引导专有名词识别（厨房剪/藍牙耳機/品牌名）；
  // 纠错词典的正词一并注入——识别端倾向输出正词，防错优于事后纠错
  const terms = [];
  (skus || []).forEach((sku) => {
    [sku.name, ...(sku.aliases || [])].forEach((n) => {
      const t = String(n || '').trim();
      if (t && t.length >= 2 && !terms.includes(t)) terms.push(t);
    });
  });
  BUILTIN_FIXES.forEach(([, good]) => { if (!terms.includes(good)) terms.push(good); });
  String((cfg && cfg.subtitleFixes) || '').split(/[;;\n]/).forEach((pair) => {
    const i = pair.indexOf('=');
    const b = i > 0 ? pair.slice(i + 1).trim() : '';
    if (b && b.length >= 2 && !terms.includes(b)) terms.push(b);
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
    args.push('--prompt', buildWhisperPrompt(language === 'yue' ? (useYue ? 'yue' : 'zh') : decodeLang, skus, getConfig()));
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
  過: '过', 還: '还', 這: '这', 講: '讲', 幫: '帮', 襯: '衬', 塵: '尘', 噉: '的'
};
function t2s(s) {
  return String(s || '').replace(/[^\x00-\x7F]/g, (ch) => T2S_MAP[ch] || ch);
}
function normText(s) {
  return t2s(String(s || '')).toLowerCase();
}
/* 规则匹配专用文本：先跑「同音错字纠错表」（沉皮→陈皮 这类 ASR 错字），再做简繁归一。
   纠错表原先只作用于字幕/花字，锚点识别走的是裸 ASR 文本，导致粤语把商品名识别成
   同音错字时 matchSkus/报价/CTA 全部命中不到，候选稀疏到出不了片。 */
function matchText(s, cfg) {
  return normText(applySubtitleFixes(s, cfg));
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
  const low = matchText(text, cfg);
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

/** 出点收尾对齐：吸附到“最后一句说完后”的最长静音起点，让结尾停在话音自然落点，
    避免切在半句话上导致成片结尾生硬。找不到合适静音则回退原出点。 */
function alignOutPoint(rawEnd, segEnd, silences, probeDur) {
  const cap = probeDur || rawEnd + 5;
  let best = null;
  (silences || []).forEach((z) => {
    if (z.start > rawEnd + 1.2) return;        // 静音起点不能拖出太多，否则节奏松散
    if (z.end < segEnd - 0.4) return;          // 必须覆盖最后一句的收尾（是其后的停顿）
    if (!best || (z.end - z.start) > (best.end - best.start)) best = z;
  });
  if (!best) return rawEnd;
  const out = Math.max(segEnd - 0.3, Math.min(best.start, cap));
  return Number(Math.min(out, cap).toFixed(2));
}

/** 规则引擎：ASR 句段 → 候选片段 */
function buildCandidates(segments, silences, probe, cfg, skus) {
  if (!segments.length) return [];
  const ctaVocab = buildVocab(cfg.ctaWords, PHRASE_BOOK.cta);
  const negVocab = buildVocab(cfg.negativeWords, PHRASE_BOOK.neg);
  const segFeat = segments.map((s) => {
    const low = matchText(s.text, cfg);
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
    // 结尾优先对齐最后一句之后的自然静音（顺滑收尾），无则退回最近边界
    const end = alignOutPoint(rawEnd, winSegs[winSegs.length - 1].end, silences, probe.duration);
    // 钩子分类：开头 6 秒文本判钩子类型，钩子句在组片时当开场用
    const text6 = winSegs.filter((s) => s.start < start + 6).map((s) => s.text).join(' ');
    const hk = classifyHook(text6, cfg);
    const hookBonus = hk.type === 'question' || hk.type === 'price' ? 8
      : hk.type === 'sellingPoint' || hk.type === 'funny' ? 6
        : hk.type === 'soft' ? 3 : 0;
    const sc = scoreWindow(winSegs, start, end, cfg, skus);
    windows.push({ l, r, start, end, ...sc, score: sc.score + hookBonus, hookType: hk.type, hookHit: hk.hit });
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
  const isHookRole = cfg.structureRole === 'hook'; // 钩子库片段作开场用，不要求报价/CTA 锚点
  const picked = kept
    .filter((w) => w.score >= cfg.minScore)
    // 成片必须有转化钩子（报价或 CTA）；只有商品名的讲解/故事段不切片，
    // 除非分极高（≥60，即多商品+多正向词的强种草段）。钩子库片段豁免。
    .filter((w) => isHookRole || w.prices.length || w.reasons.some((r) => r.c === 'cta') || w.score >= 60)
    .filter((w) => !(cfg.requireSku && !w.skuIds.length))
    .filter((w) => !(w.negCount > 0 && !w.skuIds.length));
  // 锚点候选为空时改用连续语音段兜底切段：否则导出必然失败（见 genericWindows 注释）
  const final = picked.length ? picked : genericWindows(segments, silences, probe, cfg);
  return final
    .slice(0, cfg.maxCandidates)
    .map((w, i) => ({
      id: `c${i + 1}`,
      start: Number(w.start.toFixed(2)),
      end: Number(w.end.toFixed(2)),
      text: segments.slice(w.l, w.r + 1).map((s) => s.text).join(' '),
      score: w.score,
      reasons: w.reasons,
      hookType: w.hookType || 'normal',
      hookHit: w.hookHit || '',
      skuIds: w.skuIds,
      skuNames: w.skuNames,
      priceMatches: w.prices,
      status: cfg.autoApprove > 0 && w.score >= cfg.autoApprove ? 'approved' : 'candidate',
      output: null
    }));
}

/** 无锚点兜底切段：把连续语音段按目标时长聚成通用窗口（对齐静音边界），
    只按语速/时长/正向词打分。用于整条素材没有任何 SKU/报价/CTA 锚点的场景
    （无转化话术的口播、方言识别质量差、未配置商品库），保证有语音就能出片。 */
function genericWindows(segments, silences, probe, cfg) {
  const maxD = Math.max(10, Number(cfg.maxDuration) || 90);
  const target = Math.min(maxD, Math.max(10, Number(cfg.targetDuration) || 35));
  const groups = [];
  let i = 0;
  while (i < segments.length) {
    let j = i;
    while (j + 1 < segments.length && segments[j + 1].end - segments[i].start <= target) j += 1;
    groups.push([i, j]);
    i = j + 1;
  }
  // 尾部碎片过短时并回上一组（不超过最长时长）
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const prev = groups[groups.length - 2];
    if (segments[last[1]].end - segments[last[0]].start < 6
      && segments[last[1]].end - segments[prev[0]].start <= maxD) {
      prev[1] = last[1];
      groups.pop();
    }
  }
  const out = [];
  groups.forEach(([l, r]) => {
    const winSegs = segments.slice(l, r + 1);
    const lastSeg = winSegs[winSegs.length - 1];
    if (lastSeg.end - winSegs[0].start < 4) return; // 短于 4s 无法成片
    const rawStart = Math.max(0, winSegs[0].start - Number(cfg.leadPad || 0));
    const rawEnd = Math.min(probe.duration || lastSeg.end, lastSeg.end + Number(cfg.trailPad || 0));
    const start = snapBoundary(rawStart, silences, 'start', probe.duration);
    const end = alignOutPoint(rawEnd, lastSeg.end, silences, probe.duration);
    const text6 = winSegs.filter((s) => s.start < start + 6).map((s) => s.text).join(' ');
    const hk = classifyHook(text6, cfg);
    const sc = scoreWindow(winSegs, start, end, cfg, []);
    out.push({
      l, r, start, end,
      score: Math.max(sc.score, Number(cfg.minScore) || 45),
      reasons: [...(sc.reasons || []), { c: 'generic' }],
      skuIds: [], skuNames: [], prices: [], negCount: sc.negCount || 0,
      hookType: hk.type || 'normal', hookHit: hk.hit || '', generic: true
    });
  });
  return out;
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
      const role = ROLES[f.role] ? f.role : null; // 结构化导入时逐文件携带的角色
      const cachePath = sourcePath(id);
      const span = (p) => basePct + (p / files.length);

      if (!opts.force && fs.existsSync(cachePath)) {
        const cached = readJsonSafe(cachePath, null);
        // 模型或识别语言变化（如 tiny 换 Turbo、普通话改粤语）时缓存作废，重新 ASR
        const asrStale = cached && cached.asr
          && (cached.asr.modelId !== (cfg.modelId || 'whisper-base') || cached.asr.language !== (cfg.language || 'auto'));
        if (cached && Array.isArray(cached.candidates) && fs.existsSync(meta.path) && !asrStale) {
          const effRole = role || cached.structureRole || null;
          // 规则/商品库变化时可直接重算候选（不重新 ASR）
          if (opts.rerunRules || (effRole && cached.structureRole !== effRole)) {
            cached.structureRole = effRole;
            cached.candidates = buildCandidates(cached.asr.segments, cached.silences, cached.probe, roleCfg(cfg, effRole), skus);
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
      const candidates = buildCandidates(segments, silences, probe, roleCfg(cfg, role), skus);

      // 画面有效性检测：黑屏/纯色/静止画面的候选直接淘汰（不合规成片在审核期就拦下）
      if (cfg.visualCheck !== false && candidates.length) {
        onProgress({ stage: '画面有效性检测', percent: span(96), index: i + 1, total: files.length, name: meta.name });
        let invalidN = 0;
        for (const c of candidates) {
          const v = await checkVisual(meta.path, c.start, c.end - c.start);
          c.visual = v;
          if (!v.valid) { c.status = 'rejected'; c.visualInvalid = true; invalidN += 1; }
        }
        if (invalidN) {
          onProgress({ stage: `画面检测淘汰 ${invalidN} 条无效候选`, percent: span(97), index: i + 1, total: files.length, name: meta.name });
        }
      }

      const rec = {
        version: 1,
        id,
        source: { id, path: meta.path, name: meta.name, size: meta.size, mtimeMs: meta.mtimeMs },
        structureRole: role || null,
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
  const hooks = {};
  c.forEach((x) => { hooks[x.hookType || 'normal'] = (hooks[x.hookType || 'normal'] || 0) + 1; });
  return {
    id: rec.id,
    name: rec.source.name,
    path: rec.source.path,
    structureRole: rec.structureRole || null,
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
    hooks,
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
/* 字幕按显示宽度折行（中文/全角记 2，西文记 1）。 */
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
/* ---------------- 字幕颜色预设（描边固定黑，保证任何底色下可读） ---------------- */
const SUBTITLE_COLORS = {
  white: '#FFFFFF',
  yellow: '#FFDE33',
  green: '#4DFF7C',
  cyan: '#3AE5FF',
  pink: '#FF66A3'
};
/** #RRGGBB → ASS 主色 &H00BBGGRR */
function assColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '&H00FFFFFF';
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  const p = (x) => x.toString(16).toUpperCase().padStart(2, '0');
  return `&H00${p(b)}${p(g)}${p(r)}`;
}

/* ---------------- 开拍式深度字幕：逐句大字 + 关键词双色强调 + 弹入动效（ASS） ---------------- */
// 强调命中：价格/数字/CTA 词/高转化短语 → 自动换模版强调色
function emphRegex(cfg) {
  const words = [...new Set(String(cfg.ctaWords || '').split(/\s+/).filter((w) => w.length >= 2))]
    .slice(0, 60)
    .concat(FX_PHRASES)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = [
    '[¥$]\\s?\\d+(?:\\.\\d+)?',
    '\\d+(?:\\.\\d+)?\\s?(?:元|块|折|蚊|瓶|罐|包|盒|件|个|只|片|份)',
    '\\d{2,}'
  ];
  return new RegExp('(' + parts.concat(words).join('|') + ')', 'g');
}

const ASS_ANIM = {
  pop: '{\\fad(60,80)\\t(0,100,\\fscx112\\fscy112)\\t(100,200,\\fscx100\\fscy100)}',
  popBig: '{\\fad(40,80)\\t(0,90,\\fscx120\\fscy120)\\t(90,210,\\fscx100\\fscy100)}',
  fade: '{\\fad(160,120)}',
  fadeSlow: '{\\fad(320,260)}',
  /* 从很小放大到满格（电影感/知识卡的开场重音） */
  zoomIn: '{\\fad(140,110)\\fscx42\\fscy42\\t(0,220,\\fscx100\\fscy100)}',
  /* 字距由松收敛到紧（干货/科技类「定格」感） */
  expand: '{\\fad(150,120)\\fsp34\\t(0,280,\\fsp0)}',
  /* 逐字卡拉OK填充（\kf 扫色，颜色由 Primary/Secondary 决定） */
  karaoke: '{\\fad(50,70)}'
};

/** 逐字卡拉OK：把一句字幕拆成一字符一个 \kf 时长标签（中日韩按 1 份、西文 0.55 份分配时间） */
function karaokeText(text, a, b) {
  const lines = String(text || '').split('\\N').filter(Boolean);
  const w = (ch) => (/[\x20-\x7e]/.test(ch) ? 0.55 : 1);
  const items = [];
  lines.forEach((ln, i) => {
    if (i) items.push(null);
    for (const ch of ln) items.push(ch);
  });
  const tot = items.reduce((s, c) => s + (c ? w(c) : 0), 0) || 1;
  const cs = Math.max(10, Math.round((Math.max(0.1, b - a)) * 100));
  return items.map((c) => (c === null ? '\\N' : `{\\kf${Math.max(4, Math.round(cs * w(c) / tot))}}${c}`)).join('');
}

function assTime(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = Math.floor(t % 60);
  const cs = Math.min(99, Math.round((t - Math.floor(t)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** 长句拆成 ≤2 行的逐句卡拉OK事件（时长按字数比例细分），短段保持原时间 */
function karaokeEvents(segments, start, end, maxChars) {
  const evs = [];
  (segments || []).forEach((s) => {
    const a = Math.max(s.start, start);
    const b = Math.min(s.end, end);
    if (b - a < 0.12) return;
    const text = String(s.text || '').trim().replace(/\{/g, '｛').replace(/\}/g, '｝');
    if (!text) return;
    const lines = wrapSubtitle(text, maxChars).split('\n').filter(Boolean);
    if (lines.length <= 2) { evs.push({ a, b, text: lines.join('\\N') }); return; }
    const groups = [];
    for (let i = 0; i < lines.length; i += 2) groups.push(lines.slice(i, i + 2).join('\\N'));
    const lens = groups.map((g) => g.replace(/\\N/g, '').length);
    const total = lens.reduce((x, y) => x + y, 0) || 1;
    let t = a;
    groups.forEach((g, k) => {
      const d = (b - a) * lens[k] / total;
      evs.push({ a: t, b: t + d, text: g });
      t += d;
    });
  });
  return evs;
}

function buildClipAss(segments, start, end, opts) {
  const { baseHex, emphHex, font, fontsize, outline, marginV, bold, anim, maxChars, cfg } = opts;
  const base = assColor(baseHex);
  const emph = assColor(emphHex);
  const re = emphRegex(cfg);
  const events = karaokeEvents(segments, start, end, maxChars);
  if (!events.length) return '';
  // 卡拉OK：底色=未唱色（SecondaryColour）→ 强调色=已唱色（PrimaryColour），逐字扫色
  const kara = anim === 'karaoke';
  const lines = events.map((e) => {
    let text = e.text;
    if (kara) {
      text = karaokeText(text, e.a, e.b);
    } else if (emphHex && String(emphHex).toUpperCase() !== String(baseHex).toUpperCase()) {
      text = text.replace(re, (m0) => `{\\c${emph}}${m0}{\\c${base}}`);
    }
    const pre = ASS_ANIM[anim] || ASS_ANIM.fade;
    return `Dialogue: 0,${assTime(e.a - start)},${assTime(e.b - start)},Default,,0,0,0,,${pre}${text}`;
  });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 720',
    'PlayResY: 1280',
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${fontsize},${kara ? emph : base},${kara ? base : '&H000000FF'},&H00000000,&HA0000000,${bold ? 1 : 0},0,0,0,100,100,0,0,1,${outline},2,2,40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines
  ].join('\n');
}

/* ---------------- 成片风格化：行楷花字贴片（黄字红边，弹入） ---------------- */
// 花字锚点：① 报价（¥199 / 一百九十九蚊）② 高转化短语；密度由风格模版控制。
const FX_PHRASES = ['买一送一', '免费送', '送一包', '再送', '秒杀', '手慢无', '包邮', '上架',
  '福利价', '特价', '到手价', '试一试', '最后', '库存', '买它', '仅此一批', '限时', '抢购',
  '现货', '包退', '送运费险', '不满意退款', '拍一送一', '两件更划算', '今晚特价', '直播价',
  '批发价', '出厂价', '成本价', '亏本冲量', '最后一批', '清仓', '抢空', '手快有', '别犹豫'];

/* 趣味贴片：内容反应式（命中内容→对应趣味文案）+ 通用补位池（同片内不重复）。
   「趣味性贴片」既要有梗、又不能偏离带货语境，故只做轻量感叹/提醒，不写无意义 emoji。 */
const FUN_RULES = [
  [/划算|便宜|抵买|平靓正|超值|性价比|优惠|特价|福利|减|折/, ['这价真香', '闭眼入', '抵到烂', '太划算啦']],
  [/好吃|好味|美味|好食|鲜|香|甜|正|清甜|弹牙/, ['馋哭了', '这口绝了', '吃货快冲', '香迷糊了']],
  [/送|免费|礼盒|赠|包邮|附赠/, ['有东西送', '手快有', '赚到了']],
  [/最后|只剩|库存|限量|抢|清仓|截单/, ['手慢无', '冲就完了', '最后一波']],
  [/功效|效果|坚持|改善|管用|有用|调理|养生|滋补/, ['效果看这', '亲测有用', '真的有感']],
  [/推荐|放心|保证|正品|靠谱|正宗/, ['放心冲', '可以信', '不踩雷']],
  [/孩子|宝宝|大人|老人|全家|家里|一家人/, ['全家都爱', '老少都有份']]
];
const FUN_FILLER = ['划重点', '看这里', '注意了', '重点来了', '记好了', '别划走', '这波稳了', '真香', '就它了'];
function pickFunText(segText, used) {
  const t = String(segText || '');
  const pool = [];
  for (const [re, arr] of FUN_RULES) if (re.test(t)) pool.push(...arr);
  const src = pool.length ? pool : FUN_FILLER;
  const free = src.filter((x) => !used.has(x));
  const list = free.length ? free : src;
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

/* 花字字体偏好（不同风格模版用不同字型；缺字型自动回退到系统中文字体） */
const FONT_PREFS = {
  xingkai: ['Xingkai.ttc', 'WawaSC-Regular.otf'],
  wawa: ['WawaSC-Regular.otf', 'Xingkai.ttc'],
  heiti: ['STHeiti Medium.ttc', 'PingFang.ttc'],
  pingfang: ['PingFang.ttc', 'STHeiti Medium.ttc']
};
const _fxFontCache = {};
function fxFontFile(pref) {
  const key = pref || 'xingkai';
  if (_fxFontCache[key] !== undefined) return _fxFontCache[key] || null;
  const cands = [];
  try {
    const root = '/System/Library/AssetsV2/com_apple_MobileAsset_Font8';
    if (fs.existsSync(root)) {
      const dirs = fs.readdirSync(root);
      (FONT_PREFS[key] || FONT_PREFS.xingkai).forEach((want) => {
        dirs.forEach((d) => {
          const p = path.join(root, d, 'AssetData', want);
          if (fs.existsSync(p)) cands.push(p);
        });
      });
      dirs.forEach((d) => {
        const p = path.join(root, d, 'AssetData');
        ['Xingkai.ttc', 'WawaSC-Regular.otf'].forEach((f) => {
          const fp = path.join(p, f);
          if (fs.existsSync(fp)) cands.push(fp);
        });
      });
    }
  } catch (_) {}
  cands.push('/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/PingFang.ttc');
  const hit = cands.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || '';
  _fxFontCache[key] = hit;
  return hit || null;
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

/* 选择本片段的花字/趣味贴片时间点：[{t:相对秒, text, fun}]。
   密度（spacing）与最小间隔（minGap）由风格模版决定：
   ① 先取内容锚点（报价 / 高转化短语）；② 不足时用趣味贴片补位（内容反应式→通用池）。 */
function pickStickerMoments(segments, start, end, duration, opts) {
  const o = opts || {};
  if (duration < 3.2) return [];
  const spacing = Math.max(3, Number(o.spacing) || 7);
  const minGap = Math.max(1.2, Number(o.minGap) || 2.0);
  const maxN = Math.max(1, Math.min(12, Math.floor(duration / spacing) + 1));
  const segs = (segments || []).filter((s) => s.start >= start - 0.05 && s.start < end - 0.2);
  const relOf = (s) => Math.max(0.85, Number((s.start - start + 0.12).toFixed(2)));
  const fits = (rel) => rel + 1.9 <= duration - 0.15; // 贴片尾部留余量
  const picked = [];
  // ① 内容锚点（报价优先）
  segs.forEach((s) => {
    if (picked.length >= maxN) return;
    const text = fxTextFromSeg(s.text);
    if (!text) return;
    const rel = relOf(s);
    if (!fits(rel)) return;
    if (picked.some((e) => Math.abs(e.t - rel) < minGap)) return;
    picked.push({ t: rel, text, price: text.startsWith('¥') });
  });
  picked.sort((a, b) => (a.price === b.price ? a.t - b.t : a.price ? -1 : 1));
  const out = picked.slice(0, maxN);
  // ② 趣味贴片补位（与已选点保持更大间隔，避免贴片糊在一起）
  const used = new Set(out.map((p) => p.text));
  for (const s of segs) {
    if (out.length >= maxN) break;
    const rel = relOf(s);
    if (!fits(rel)) continue;
    if (out.some((e) => Math.abs(e.t - rel) < minGap * 1.25)) continue;
    const fun = pickFunText(s.text, used);
    if (!fun) continue;
    out.push({ t: rel, text: fun, fun: true });
    used.add(fun);
  }
  out.sort((a, b) => a.t - b.t);
  return out.map(({ t, text, fun }) => ({ t, text, fun: !!fun }));
}

/* 花字画布尺寸（与 makeStickerPng 保持一致），用于叠加时的缩放基准；色带类形状留更宽内边距 */
function stickerSize(text, shape) {
  const fsPx = 96;
  let w = 30;
  for (const ch of text) w += /[\x20-\x7e]/.test(ch) ? fsPx * 0.62 : fsPx * 1.06;
  const band = shape === 'band' || shape === 'box';
  const tall = shape === 'underline';
  const hollow = shape === 'hollow';
  const chH = tall
    ? Math.ceil(fsPx * 1.72 + 150)
    : Math.ceil(fsPx * (band ? 2.0 : 1.72) + (band ? 80 : hollow ? 72 : 48));
  return { cw: Math.ceil(w + (band ? 92 : hollow ? 84 : 56)), chH };
}

/* 贴片弹入动画（由风格模版选择）：pop=过冲回弹；zoom=从小放大；slide=自上滑入 */
function stickerAnim(anim, Ts) {
  const dt = `(t-${Ts})`;
  if (anim === 'zoom') return { sc: `min(1\\,0.30+0.70*${dt}/0.22)`, y: null };
  if (anim === 'slide') return { sc: '1.0', y: `if(lt(${dt}\\,0.26)\\,-0.14*H*(1-${dt}/0.26)\\,0)` };
  return {
    sc: `if(lt(${dt}\\,0.14)\\,0.55+0.60*${dt}/0.14\\,if(lt(${dt}\\,0.3)\\,1.15-0.15*(${dt}-0.14)/0.16\\,1))`,
    y: null
  };
}

/* 用 ffmpeg 生成透明底花字 PNG。形状由风格模版决定：
   burst = 外发光 + 粗描边（最抓眼）；band = 实心色带；box = 浅色底 + 彩字；
   hollow = 空心描边大字（霓虹/赛博）；underline = 彩字 + 下方强调色条（知识卡/干货） */
async function makeStickerPng(text, outPath, style) {
  const st = style || {};
  const shape = st.shape || 'burst';
  const font = fxFontFile(st.font || 'xingkai');
  if (!font) return null;
  const fill = st.fill || '0xFFE33A';
  const border = st.border || '0xB00000';
  const glow = st.glow || '0xFFC800';
  const textColor = st.text || (shape === 'burst' ? '0xFFE33A' : fill);
  const { cw, chH } = stickerSize(text, shape);
  const fsPx = 96;
  const pos = `x=(w-tw)/2:y=(h-th)/2`;
  const common = `fontfile='${font}':textfile=fx.txt:fontsize=${fsPx}:${pos}`;
  let vf;
  if (shape === 'band') {
    vf = [
      `format=rgba,colorchannelmixer=aa=0,drawtext=${common}:fontcolor=${border}@0.0:box=1:boxcolor=${border}:boxborderw=34`,
      `drawtext=${common}:fontcolor=${fill}@0.0:box=1:boxcolor=${fill}:boxborderw=26`,
      `drawtext=${common}:fontcolor=${textColor}:borderw=0:shadowcolor=black@0.35:shadowx=3:shadowy=4`
    ].join(',');
  } else if (shape === 'box') {
    vf = [
      `format=rgba,colorchannelmixer=aa=0,drawtext=${common}:fontcolor=${border}@0.0:box=1:boxcolor=${border}:boxborderw=36`,
      `drawtext=${common}:fontcolor=${fill}@0.0:box=1:boxcolor=${fill}:boxborderw=28`,
      `drawtext=${common}:fontcolor=${textColor}:borderw=0`
    ].join(',');
  } else if (shape === 'hollow') {
    // 空心描边：先铺一层柔光，再叠硬描边（字体本身不填充）
    const ty = `x=(w-tw)/2:y=(h-th)/2`;
    const hollow = `fontfile='${font}':textfile=fx.txt:fontsize=${fsPx}:${ty}`;
    vf = [
      `format=rgba,colorchannelmixer=aa=0,drawtext=${hollow}:fontcolor=${fill}@0.0:borderw=16:bordercolor=${glow}@0.5,boxblur=6:1`,
      `drawtext=${hollow}:fontcolor=${fill}@0.0:borderw=6:bordercolor=${border}`,
      `drawtext=${hollow}:fontcolor=${fill}@0.0:borderw=2:bordercolor=${textColor}`
    ].join(',');
  } else if (shape === 'underline') {
    // 彩字 + 下方强调色条：文字上移，色条压在底部
    const ty = `x=(w-tw)/2:y=(h-th)/2-26`;
    const ul = `fontfile='${font}':textfile=fx.txt:fontsize=${fsPx}:${ty}`;
    vf = [
      `format=rgba,colorchannelmixer=aa=0,drawtext=${ul}:fontcolor=${textColor}:borderw=2:bordercolor=black@0.5:shadowcolor=black@0.45:shadowx=3:shadowy=4:box=1:boxcolor=${fill}@0.92:boxborderw=18`,
      `drawbox=x=(iw-iw*0.86)/2:y=ih*0.63:w=iw*0.86:h=14:color=${border}@1:t=fill`
    ].join(',');
  } else {
    vf = [
      `format=rgba,colorchannelmixer=aa=0,drawtext=${common}:fontcolor=${fill}@0.0:borderw=22:bordercolor=${glow}@0.5,boxblur=8:1`,
      `drawtext=${common}:fontcolor=${fill}@0.0:borderw=12:bordercolor=${border}:shadowcolor=black@0.55:shadowx=3:shadowy=4`,
      `drawtext=${common}:fontcolor=${textColor}:borderw=0`
    ].join(',');
  }
  fs.writeFileSync(path.join(path.dirname(outPath), 'fx.txt'), text, 'utf8');
  try {
    await runFf(['-v', 'error', '-f', 'lavfi', '-i', `color=black:s=${cw}x${chH}:d=1`,
      '-vf', vf, '-frames:v', '1', '-y', outPath], () => {}, path.dirname(outPath));
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 0 ? { cw, chH } : null;
  } catch (e) {
    return null;
  }
}

/* ---------------- 短视频封面：最佳帧 + 标题花字，写入 mp4 cover art ---------------- */
/** 封面标题文案：花字报价/话术优先 → ¥价格 → 商品名；没有可用的就返回 null（纯画面封面） */
function coverTitleText(c, moments) {
  if (moments && moments.length) return moments[0].text;
  const price = (c.priceMatches || []).find((p) => /^¥/.test(String(p)) && String(p).length > 2);
  if (price) return price;
  if (Array.isArray(c.skuNames) && c.skuNames.length) return c.skuNames[0];
  return null;
}

async function makeCover(input, clipStart, clipDur, titleText, workDir, outPath, W, H, style, cfg) {
  try {
    // 1) 扫前 70% 片段（避开片头弹入与结尾淡出）选最佳帧：细节 × 亮度加权
    const scanDur = Math.min(Math.max(2, clipDur * 0.7), 24);
    const st = await sampleGrayFrames(input, clipStart + 0.3, scanDur, 3, 48);
    if (!st.frames.length) return null;
    let bestIdx = -1;
    let bestScore = -1;
    st.frames.forEach((f, idx) => {
      const bright = f.mean >= 45 && f.mean <= 215 ? 1 : 0.35;
      const score = f.detail * bright + f.mean * 0.06;
      if (score > bestScore) { bestScore = score; bestIdx = idx; }
    });
    const t = clipStart + 0.3 + bestIdx / 3;

    // 2) 抽全尺寸帧
    const frameJpg = path.join(workDir, 'cover-frame.jpg');
    await runFf(['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', input,
      '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-q:v', '2', frameJpg]);
    if (!fs.existsSync(frameJpg) || fs.statSync(frameJpg).size < 1000) return null;
    if (!titleText || !String(titleText).trim()) {
      // 没有可用标题文案 → 纯画面封面（画质最佳帧，不做任何叠字）
      fs.copyFileSync(frameJpg, outPath);
      return outPath;
    }

    // 3) 叠封面层：整幅压暗 + 超大描边花字标题（参考附件封面风格）+ 强调条
    const cv = (style && style.cover) || {};
    const plate = await makeCoverPlate(cfg || {}, style, titleText, W, H, workDir, path.join(workDir, 'cover-plate.png'));
    if (!plate) { fs.copyFileSync(frameJpg, outPath); return outPath; }
    const tint = Number(cv.tintAlpha);
    const ta = Number.isFinite(tint) ? tint.toFixed(2) : '0.44';
    await runFf(['-v', 'error', '-y', '-i', frameJpg, '-i', path.join(workDir, 'cover-plate.png'),
      '-filter_complex',
      `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=${hexToFf(cv.tint)}@${ta}:t=fill[t];` +
      `[t][1:v]overlay=0:0:format=auto,format=yuvj420p`,
      '-frames:v', '1', '-q:v', '2', outPath]);
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 1000 ? outPath : null;
  } catch (_) {
    return null; // 封面失败绝不阻断导出
  }
}

/** 把封面 JPG 写进成片 mp4 的 cover art（流复制主轨，秒级完成） */
async function attachCover(mp4Path, coverJpg) {
  const tmp = `${mp4Path}.cover.mp4`;
  await runFf(['-v', 'error', '-y', '-i', mp4Path, '-i', coverJpg,
    '-map', '0:v:0', '-map', '0:a?', '-map', '1:v:0',
    '-c', 'copy', '-c:v:1', 'mjpeg',
    '-disposition:v:0', 'default', '-disposition:v:1', 'attached_pic',
    '-movflags', '+faststart', tmp]);
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) throw new Error('cover remux failed');
  fs.renameSync(tmp, mp4Path);
}

/* ---------------- 短视频封面 2.0：叠色底 + 超大描边花字标题 + 强调条 ----------------
   配色来自风格模版的 cover 字段；标题文案取自价格段报价/商品名/花字短语。 */

/** 颜色归一：'#RRGGBB' / '0xRRGGBB' / 'black' → ffmpeg 可用色值 */
function hexToFf(hex, fallback = '0xFFFFFF') {
  const s = String(hex == null ? '' : hex).trim();
  if (/^#?[0-9a-f]{6}$/i.test(s)) return `0x${s.replace(/^#/, '').toUpperCase()}`;
  if (/^0x[0-9a-f]{6}$/i.test(s)) return `0x${s.slice(2).toUpperCase()}`;
  if (/^[a-z]{3,20}$/i.test(s)) return s; // 具名色：black / white / red …
  return fallback;
}

/** 按像素宽度折行（封面大字用；中文/全角≈字号宽，西文≈0.55 字号宽），最多两行 */
function wrapByPixel(text, maxWidth, fs) {
  const w = (ch) => (/[\u2E80-\uFFEF]/.test(ch) ? fs : fs * 0.55);
  const out = [];
  let line = '';
  let acc = 0;
  for (const ch of String(text)) {
    const cw = w(ch);
    if (acc + cw > maxWidth && line) { out.push(line); line = ''; acc = 0; }
    line += ch;
    acc += cw;
  }
  if (line) out.push(line);
  return out.slice(0, 2);
}

/** 封面叠加层：透明底 PNG（超大描边花字标题 + 强调条），不含任何账号文案 */
async function makeCoverPlate(cfg, style, titleText, W, H, workDir, outPath) {
  const cv = (style && style.cover) || {};
  const font = fxFontFile('heiti');
  if (!font) return null;
  const parts = [];
  const FT = Math.round(H * 0.075);
  const title = String(titleText || '').trim();
  const lines = title ? wrapByPixel(title, W * 0.90, FT) : [];
  let titleBottom = Math.round(H * 0.34);
  if (lines.length) {
    fs.writeFileSync(path.join(workDir, 'cv-title.txt'), lines.join('\n'), 'utf8');
    parts.push(`drawtext=fontfile='${font}':textfile=cv-title.txt:fontsize=${FT}:line_spacing=${Math.round(FT * 0.22)}:fontcolor=${hexToFf(cv.title)}:borderw=${Math.round(FT * 0.11)}:bordercolor=${hexToFf(cv.stroke)}@0.92:x=(w-tw)/2:y=${titleBottom}:shadowcolor=black@0.55:shadowx=3:shadowy=5`);
    titleBottom += FT + (lines.length - 1) * Math.round(FT * 1.22) + Math.round(H * 0.035);
  }
  parts.push(`drawbox=x=(iw-iw*0.20)/2:y=${titleBottom}:w=iw*0.20:h=${Math.round(H * 0.008)}:color=${hexToFf(cv.accent)}@0.95:t=fill`);
  try {
    await runFf(['-v', 'error', '-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=1`,
      '-vf', `format=rgba,colorchannelmixer=aa=0,${parts.join(',')}`, '-frames:v', '1', '-y', outPath], () => {}, workDir);
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 0 ? { bw: W, bh: H } : null;
  } catch (_) { return null; }
}

function tsName() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function safeName(s) {
  return String(s).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80).trim() || 'clip';
}

/* 去重滤镜预设（轮换套用，配合随机缩放/翻转让同一素材的多条成片互不撞车） */
const DEDUPE_EQ = [
  'eq=saturation=1.06:contrast=1.04',
  'eq=saturation=0.94:brightness=0.02:contrast=1.02',
  'eq=gamma_r=1.05:gamma_b=0.97:saturation=1.08', // eq 无 hue 选项（hue 是独立滤镜），用通道 gamma 微偏色替代
  'eq=gamma=0.96:contrast=1.06:saturation=1.03',
  'eq=brightness=-0.012:saturation=1.0:contrast=1.08:gamma=1.02'
];

function listShotPool(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3 || out.length > 400) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    entries.forEach((e) => {
      if (e.name.startsWith('.')) return;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp, depth + 1);
      else { const m = fileMeta(fp); if (m && m.size >= 20480) out.push(m); } // 过滤损坏/测试用超小文件
    });
  };
  walk(dir, 0);
  return out;
}

/** 收集镜头插入事件：ASR 文本命中关键字的位置 → 画中画展示随机商品镜头 */
function buildShotEvents(segments, c, cfg, shotPool, maxEvents) {
  if (!shotPool.length) return [];
  const words = String(cfg.shotKeywords || '').split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  const DUR = c.end - c.start;
  const events = [];
  const usedShots = new Set();
  (segments || []).forEach((s) => {
    if (events.length >= maxEvents) return;
    const st = s.start, en = Math.min(s.end, c.end);
    if (en <= c.start || st >= c.end) return;
    const txt = applySubtitleFixes(s.text, cfg);
    if (!words.some((w) => txt.includes(w))) return;
    let t = (Math.max(st, c.start) + en) / 2 - c.start;
    t = Math.max(0.6, Math.min(DUR - 1.8, t));
    if (events.some((e) => Math.abs(e.t - t) < 4)) return; // 间隔至少 4s，避免连环弹窗
    let k = Math.floor(Math.random() * shotPool.length);
    for (let tries = 0; tries < shotPool.length && usedShots.has(k); tries += 1) k = (k + 1) % shotPool.length;
    usedShots.add(k);
    events.push({ t, shot: shotPool[k], offset: Math.max(0, Math.random() * 2.5) });
  });
  return events;
}

/** 组片候选池：已分类素材按分类入池；未分类素材按片段内容自动归类，
    命中报价/CTA → 价格池，命中钩子题型 → 钩子池，其余 → 介绍池。
    任何未分类素材都能参与组片（v3.0.0 删掉分类选择器后，未分类素材原本完全无法组片）。 */
function buildComposePools() {
  const pools = { hook: [], intro: [], price: [] };
  const all = [];
  listSources().forEach((sum) => {
    if (!sum.exists) return;
    const rec = readJsonSafe(sourcePath(sum.id), null);
    if (!rec) return;
    const explicit = ROLES[sum.structureRole] ? sum.structureRole : null;
    (rec.candidates || []).forEach((c) => {
      if (c.status === 'rejected' || (c.visual && c.visual.valid === false)) return;
      const item = { rec, c };
      all.push(item);
      if (explicit) { pools[explicit].push(item); return; }
      const quote = (c.priceMatches && c.priceMatches.length) || (c.reasons || []).some((r) => r.c === 'cta');
      const hooky = c.hookType && c.hookType !== 'normal';
      if (hooky && !quote) pools.hook.push(item);
      else if (quote) pools.price.push(item);   // 报价/CTA 段最适合收尾（兼作钩子的也归这里）
      else pools.intro.push(item);
    });
  });
  const byScore = (a, b) => (b.c.score || 0) - (a.c.score || 0);
  ['hook', 'intro', 'price'].forEach((r) => pools[r].sort(byScore));
  all.sort(byScore);
  return { pools, all };
}

/** 覆盖窗口池：把每条素材整段 ASR 按短视频时长聚成通用窗口（对齐静音边界），
    作为组片「介绍位」的补料。锚点候选稀疏时（整条直播只有结尾一处报价），
    只靠评审候选拼不出多条成片，靠这些窗口补位。
    质量闸门：窗口文本高度重复（Whisper 在纯音乐/静音段的循环幻觉）直接丢弃；
    返回前按分数排序，优先含正向卖点话术的段。 */
function buildCoverageWindows(cfg) {
  const target = Math.min(90, Math.max(30, Number(cfg.targetShort) || 50));
  const per = Math.min(30, Math.max(16, Math.round(target * 0.45)));
  const out = [];
  listSources().forEach((sum) => {
    if (!sum.exists) return;
    const rec = readJsonSafe(sourcePath(sum.id), null);
    const segs = rec && rec.asr && rec.asr.segments;
    if (!segs || !segs.length) return;
    const wins = genericWindows(segs, rec.silences || [], rec.probe || {}, {
      ...cfg, targetDuration: per, maxDuration: Math.min(60, per + 18)
    });
    wins.forEach((w) => {
      const texts = segs.slice(w.l, w.r + 1).map((s) => normText(s.text || '')).filter((t) => t.length >= 2);
      if (texts.length >= 4 && new Set(texts).size / texts.length < 0.5) return; // 循环幻觉段
      out.push({
        rec,
        c: {
          id: `g${w.l + 1}`,
          start: Number(w.start.toFixed(2)),
          end: Number(w.end.toFixed(2)),
          text: segs.slice(w.l, w.r + 1).map((s) => s.text).join(' '),
          score: w.score || 0,
          reasons: w.reasons || [],
          hookType: w.hookType || 'normal',
          skuIds: [], skuNames: [], priceMatches: [],
          status: 'approved', generic: true, output: null
        }
      });
    });
  });
  return out;
}

/** 覆盖窗口与「已通过/待审」评审候选时间重叠（超过 40%）时，本质是同一段画面
    （同一时间段既当候选又当补料），直接剔除。否则「介绍位」补上的可能正是
    另一条成片开场/收尾用的同一段画面，多条成片看起来就会一模一样。 */
function dedupeCoverageWindows(windows) {
  const cache = new Map();
  const rangesOf = (rec) => {
    if (!cache.has(rec.id)) {
      cache.set(rec.id, (rec.candidates || [])
        .filter((c) => c.status !== 'rejected' && (!c.visual || c.visual.valid !== false))
        .map((c) => ({ start: c.start, end: c.end })));
    }
    return cache.get(rec.id);
  };
  return windows.filter((x) => !rangesOf(x.rec).some((r) => {
    const inter = Math.min(r.end, x.c.end) - Math.max(r.start, x.c.start);
    return inter > Math.min(r.end - r.start, x.c.end - x.c.start) * 0.4;
  }));
}

/** 结构化组片：按「钩子 → 介绍 → 价格」拼装 30-90s 带货短视频（目标 targetShort 秒）。
    多成片策略（v3.4 重写，修复「多条成片内容雷同、毫无区别」）：
    1. 片段全局唯一——同一素材的同一片段（评审候选或覆盖窗口）只能被一条成片占用，
       废掉原来「按使用次数降级复用」的凑条数逻辑（同一段画面反复出现在多条成片里
       正是成片雷同的根因）；
    2. 条数由素材容量推导——只要能再拼出一条合格成片就继续，上限 12 条；素材只够
       一条时只出 1 条，绝不复刻同一条成片；
    3. 覆盖窗口与评审候选时间重叠的（同一段画面既是候选又是补料）直接剔除，
       避免「介绍位」用的其实正是另一条成片开场/收尾的同一段画面；
    4. 纯覆盖窗口开场时沿同一素材顺延紧邻窗口，拼成一段连续画面而非无关碎片。
    全批只剩一段有效片段时按整段开场导出，保证有素材就有成片。 */
function buildComposeJobs(cfg) {
  const { pools, all } = buildComposePools();
  if (!all.length) return { combos: [], jobs: [] };
  const coverage = dedupeCoverageWindows(buildCoverageWindows(cfg));
  // 覆盖窗口按「素材 → 时间」排序：纯窗口开场时要顺延紧邻窗口拼成连续画面
  coverage.sort((a, b) => (a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : a.c.start - b.c.start));

  const key = (x) => `${x.rec.id}:${x.c.id}`;
  const dur = (x) => x.c.end - x.c.start;
  // 同一条成片内不允许出现「同一素材、时间重叠」的两个片段（避免同一段画面重复出现）
  const clash = (a, b) => {
    if (a.rec.id !== b.rec.id) return false;
    const inter = Math.min(a.c.end, b.c.end) - Math.max(a.c.start, b.c.start);
    return inter > Math.min(dur(a), dur(b)) * 0.4;
  };

  const target = Math.min(90, Math.max(30, Number(cfg.targetShort) || 50));
  const MAX_CLIPS = 12;      // 单批成片上限：素材再多也不超过
  const MIN_CLIP_SECS = 30;  // 成片最短时长（30-90s 带货区间）：剩余素材凑不够就收工，宁缺毋滥

  // 全局片段台账：任一片段（评审候选或覆盖窗口）只允许被一条成片占用；
  // usedRanges 再兜一层「画面区间」——覆盖窗口带前后留白，相邻窗口会各重叠零点几秒，
  // 只按片段 id 去重仍会让两条成片在头尾露出同一画面。seenSets 记下已出成片的片段集合，
  // 杜绝「同一组片段换个顺序再出一遍」。
  const usedKeys = new Set();
  const usedRanges = new Map(); // rec.id → [{ start, end }]：已出成片占用的画面区间
  const seenSets = new Set();
  const busyRange = (x) => (usedRanges.get(x.rec.id) || [])
    .some((r) => Math.min(r.end, x.c.end) - Math.max(r.start, x.c.start) > 0.5);
  // 候选排序：先按列表给出的池优先级，同池内按分数降序；
  // 已被其它成片占用画面、或与本条已选片段时间撞车的直接剔除。
  const rank = (lists, combo) => lists.flatMap((arr) => arr
    .filter((x) => dur(x) >= 3.5 && !usedKeys.has(key(x)) && !busyRange(x)
      && !combo.some((y) => key(y) === key(x) || clash(y, x)))
    .sort((a, b) => (b.c.score || 0) - (a.c.score || 0)));

  const combos = [];
  // 有几条出几条：每轮占用一批全新片段，素材用尽（或凑不出合格成片）即停
  while (combos.length < MAX_CLIPS) {
    const combo = [];
    // 开场：钩子池优先，其它池兜底（保住「开头必须有钩子」的结构）
    const hook = rank([pools.hook, pools.intro, pools.price, coverage], combo)[0];
    if (!hook) break; // 已无可用开场片段 = 素材用尽
    combo.push(hook);
    const isGeneric = !!hook.c.generic; // 覆盖窗口开场：无报价/CTA 结构，走「连续画面」路线

    const intros = [];
    let acc = 0;
    if (isGeneric) {
      // 沿同一素材顺延紧邻窗口，拼成一段连续画面（而不是几个互不相干的碎片）
      let prev = hook;
      let cont = 0;
      while (dur(hook) + cont < target) {
        const nxt = coverage.find((x) => x.rec.id === hook.rec.id && !usedKeys.has(key(x))
          && !busyRange(x) && x.c.start >= prev.c.end - 1.5 && x.c.start <= prev.c.end + 3);
        if (!nxt) break;
        combo.push(nxt);
        intros.push(nxt);
        prev = nxt;
        cont += dur(nxt);
      }
      acc += cont;
    }

    let price = null;
    if (!isGeneric) { // 收尾：报价/CTA 池优先（保住转化收尾）；片段不复用，故无降级兜底
      price = rank([pools.price, pools.intro, pools.hook, coverage], combo)[0] || null;
      if (price) combo.push(price);
    }
    // 评审候选开场裁成 4-9s 短钩子；覆盖窗口本身已是短视频长度，整段用（不拦腰截断句子）
    const hookDur = isGeneric ? dur(hook) : Math.min(dur(hook), 9);
    const priceDur = price ? Math.min(Math.max(dur(price), 8), 25) : 0; // 价格/CTA 8-25s
    if (!isGeneric) {
      const remaining = target - hookDur - priceDur;
      for (const x of rank([pools.intro, coverage], combo)) { // 介绍贪心凑时长：最多 2 段
        if (intros.length >= 2) break;
        const d = dur(x);
        if (d >= 8 && acc + d <= remaining + 8) { intros.push(x); combo.push(x); acc += d; }
      }
    }

    let total = hookDur + priceDur + acc;
    if (!intros.length && total < MIN_CLIP_SECS) {            // 太短时补一段（宁可略长）
      const extra = rank([pools.intro, coverage], combo)[0];
      if (extra) { intros.push(extra); combo.push(extra); acc += dur(extra); total += dur(extra); }
    }
    const setKey = combo.map(key).sort().join('|');
    // 拼不出合格成片，或与已出成片片段集合完全相同 → 不再凑数，直接收工
    if (total < MIN_CLIP_SECS || seenSets.has(setKey)) break;
    combo.forEach((x) => {
      usedKeys.add(key(x));
      usedRanges.set(x.rec.id, [...(usedRanges.get(x.rec.id) || []), { start: x.c.start, end: x.c.end }]);
    });
    seenSets.add(setKey);
    combos.push({ hook, price, intros, hookDur, priceDur, introDur: acc });
  }
  // 极简兜底：整批只有一条有效片段时，也按整段开场导出，不再因「结构凑不齐」直接失败
  if (!combos.length && all.length) {
    const only = all[0];
    combos.push({ hook: only, price: null, intros: [], hookDur: Math.min(dur(only), 45), priceDur: 0, introDur: 0 });
  }
  const jobs = [];
  combos.forEach((combo, ci) => {
    const mkPart = (x, role, part, isLast, durOverride) => {
      const c2 = { ...x.c, of: x.c }; // of 指回落盘候选对象：渲染期检测/输出要同步回原候选才能随 rec 持久化
      if (durOverride) c2.end = Number((x.c.start + durOverride).toFixed(2));
      return { rec: x.rec, c: c2, compose: { combo: ci, role, part, isLast } };
    };
    let part = 0;
    const hookOnly = !combo.intros.length && !combo.price; // 单段成片的收尾淡出落在开场段上
    jobs.push(mkPart(combo.hook, 'hook', part++, hookOnly, combo.hookDur));
    // 无报价收尾时（纯覆盖窗口拼的成片）收尾淡出落在最后一段介绍位，保证结尾不硬截断
    const lastIntro = !combo.price && combo.intros.length > 0;
    combo.intros.forEach((x, k) => jobs.push(mkPart(x, 'intro', part++, lastIntro && k === combo.intros.length - 1, null)));
    if (combo.price) jobs.push(mkPart(combo.price, 'price', part++, true, combo.priceDur));
  });
  return { combos, jobs };
}

async function render(options = {}, onProgress) {
  if (isBusy()) throw new Error('已有批量任务进行中');
  if (aijobs.isBusy()) throw new Error('已有 AI 任务进行中，请稍候');
  const cfg = { ...getConfig(), ...options };
  ensureDirs();

  // 收集任务：普通模式 = 全部已通过候选；组片模式 = 钩子+介绍+价格三段拼装
  const compose = !!options.compose;
  let combos = [];
  const jobs = [];
  if (compose) {
    const built = buildComposeJobs(cfg);
    combos = built.combos;
    jobs.push(...built.jobs);
    if (!combos.length) {
      const analyzed = listSources().filter((s) => s.exists);
      if (!analyzed.length) {
        throw new Error('组片失败：还没有已分析的素材，请先点「开始批量分析」');
      }
      const valid = analyzed.reduce((n, s) => n + Math.max(0, s.total - s.rejected), 0);
      throw new Error(valid
        ? '组片失败：素材分类与有效片段凑不齐成片，请在素材卡上检查分类后重试'
        : '组片失败：素材里没有通过校验的有效片段（可在素材卡上设置分类，或调低「最低入选分」后重新分析）');
    }
  } else {
    listSources().forEach((sum) => {
      if (options.sourceIds && options.sourceIds.length && !options.sourceIds.includes(sum.id)) return;
      if (!sum.exists) return;
      const rec = readJsonSafe(sourcePath(sum.id), null);
      if (!rec) return;
      (rec.candidates || []).forEach((c) => {
        if (c.status !== 'rejected') jobs.push({ rec, c });
      });
    });
  }
  if (!jobs.length) throw new Error('没有可导出的候选片段，请先完成批量分析');

  const batchName = options.batchName ? safeName(options.batchName) : `clips-${tsName()}`;
  const outDir = path.join(store.get().downloadDir || app.getPath('downloads'), 'TokPure-Clips', batchName);
  fs.mkdirSync(outDir, { recursive: true });
  const partsDir = path.join(outDir, 'parts');
  if (compose) fs.mkdirSync(partsDir, { recursive: true });
  const workDir = path.join(tmpDir(), `render-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  // 「镜头」库（画中画商品展示镜头）：导出前扫描一次
  const shotPool = (cfg.insertShots && cfg.shotsDir && fs.existsSync(cfg.shotsDir))
    ? listShotPool(cfg.shotsDir) : [];
  if (compose) {
    // 组片统一走 polish 管线（跨素材拼接需要统一分辨率与滤镜链）
    cfg.polishStyle = true;
  }
  // 风格模版只在整批导出前解析一次（贴片形状/滤镜/转场/BGM 闪避/画面外框全批一致；
  // combo 封面在循环外生成，也依赖这里的 sStk）
  const style = resolveStyle(cfg.styleTemplate);
  const sStk = style.sticker || {};
  const sFrame = style.frame || {};

  batch = { kind: 'render', canceled: false, child: null };
  const manifest = [];
  try {
    const comboParts = {}; // 组片模式：combo 序号 → parts 落盘信息，循环结束后 concat
    for (let i = 0; i < jobs.length; i += 1) {
      checkCanceled();
      const job = jobs[i];
      const { rec, c } = job;
      const composeRole = job.compose ? job.compose.role : null;
      const lastPart = !job.compose || job.compose.isLast;
      const input = rec.source.path;
      const base = safeName(rec.source.name);
      const outFile = job.compose
        ? path.join(partsDir, `combo-${String(job.compose.combo + 1).padStart(2, '0')}-part${job.compose.part}.mp4`)
        : path.join(outDir, `${base}-${String(i + 1).padStart(2, '0')}.mp4`);
      const duration = c.end - c.start;
      const span = (p) => ((i + p) / jobs.length) * 100;

      // 不合规防线：画面无效（黑屏/纯色/静止）的候选一律不导出。
      // 老缓存里没有 visual 数据的在导出前现补一次检测并落盘。
      if (cfg.visualCheck !== false) {
        if (!c.visual && c.of && c.of.visual) c.visual = c.of.visual; // 复用已落盘检测结果
        if (!c.visual) c.visual = await checkVisual(input, c.start, duration);
        if (c.visual && c.visual.valid === false) {
          c.visualInvalid = true;
          if (c.of) { c.of.visual = c.visual; c.of.visualInvalid = true; } // 同步回落盘候选
          writeJson(sourcePath(rec.id), rec);
          onProgress({ stage: `跳过不合规片段（画面与原片无关）`, percent: span(1), index: i + 1, total: jobs.length, name: path.basename(outFile) });
          continue;
        }
      }

      const fixedSegs = (rec.asr.segments || []).map((s) => ({ ...s, text: applySubtitleFixes(s.text, cfg) }));
      // 开拍式深度字幕（ASS）：逐句大字 + 关键词双色强调 + 弹入动效。
      // 用户在色板手动改色（与模版底色名不一致）时优先用户色，否则用模版成套底色
      const sSub = style.subtitle || {};
      const userPick = SUBTITLE_COLORS[cfg.subtitleColor] ? cfg.subtitleColor : null;
      let baseHex = (userPick && userPick !== sSub.color) ? SUBTITLE_COLORS[userPick] : (sSub.baseHex || '#FFFFFF');
      const emphHex = sSub.emphColor || '#FFDE33';
      if (String(baseHex).toUpperCase() === String(emphHex).toUpperCase()) baseHex = sSub.baseHex || '#FFFFFF';
      const assFontsize = Math.round((Number(cfg.fontSize) || sSub.fontSize || 18) * 4.44 * (sSub.sizeScale || 1));
      const assOutline = Math.round((Number(sSub.outline) || 3) * 2.2);
      const assMarginV = Math.round((Number(cfg.marginV) || sSub.marginV || 64) * 4.44);
      const assMaxChars = Math.max(6, Math.floor(720 * 0.84 / assFontsize));
      const ass = buildClipAss(fixedSegs, c.start, c.end, {
        baseHex, emphHex, font: sSub.font || 'PingFang SC', fontsize: assFontsize,
        outline: assOutline, marginV: assMarginV, bold: sSub.bold ? 1 : 0,
        anim: sSub.anim || 'pop', maxChars: assMaxChars, cfg
      });
      const useSub = cfg.burnSubtitles && !!ass.trim();
      if (useSub) fs.writeFileSync(path.join(workDir, 'sub.ass'), ass, 'utf8');

      onProgress({ stage: `导出 ${i + 1}/${jobs.length}`, percent: span(0), index: i + 1, total: jobs.length, name: path.basename(outFile) });

      const DUR = duration;
      const probe = rec.probe || {};
      // 组片模式统一 720x1280 竖屏：跨素材 concat -c copy 需要所有分段参数一致
      const W = compose ? 720 : (probe.width || 720) - ((probe.width || 720) % 2);
      const H = compose ? 1280 : (probe.height || 1280) - ((probe.height || 1280) % 2);
      const polish = !!cfg.polishStyle;
      // 爆款风格模版：字幕（字号/颜色/描边）走 cfg（模版切换时会写入表单），
      // 贴片形状/动画/密度、滤镜、转场、BGM 闪避参数由模版直接决定（sStk 已在循环外解析）
      const hasAudio = probe.hasAudio !== false;

      // 花字贴片：先生成 PNG（失败/无字则跳过，绝不阻断导出）；时间点同时供封面复用
      const moments = pickStickerMoments(fixedSegs, c.start, c.end, DUR, { spacing: sStk.spacing, minGap: sStk.minGap });
      // 钩子开场包装：组片钩子段按 hookType 叠开场大字（提问「见过这个没有？」等），
      // 位置偏上更醒目；与普通花字过密时丢弃近的普通花字
      if (composeRole === 'hook' && c.hookType && c.hookType !== 'normal') {
        const firstSeg = fixedSegs.find((s) => s.end > c.start && s.start < c.end);
        const hookText = pickHookStickerText(c.hookType, firstSeg && firstSeg.text);
        if (hookText) {
          moments.unshift({ t: 0.15, text: hookText, hook: true });
          for (let k = moments.length - 1; k >= 1; k -= 1) {
            if (moments[k].t < 2.5) moments.splice(k, 1); // 开场大字下方留出阅读空间
          }
        }
      }
      // 画中画插镜头：ASR 文本命中关键字 → 右上角随机商品镜头 1.4s
      const shots = (cfg.insertShots && shotPool.length) ? buildShotEvents(fixedSegs, c, cfg, shotPool, 3) : [];
      let stickers = [];
      if (polish && fxFontFile()) {
        for (let k = 0; k < moments.length; k += 1) {
          const dim = await makeStickerPng(moments[k].text, path.join(workDir, `fx${k}.png`), sStk);
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
        audiofx.buildSfxTrack(DUR, stickers.map((st) => ({ t: st.t, type: 'pop' })), sfxPath);
        ffArgs.push('-i', sfxPath);
        // 镜头输入必须在 -t 之前 push（-t 是输出选项，落在 -i 后会被当成输入选项）；
        // 偏移用 trim=start 实现——「-stream_loop -1 + 输入 -ss」组合会让 trim=duration 拿不到帧
        shots.forEach((ev) => {
          ffArgs.push('-stream_loop', '-1', '-i', ev.shot.path);
        });
        ffArgs.push('-t', DUR.toFixed(3));

        const fc = [];
        const vchain = [];
        // 组片：跨素材统一画布（缩放裁剪到 720x1280、SAR 归一、帧率统一 30，保证 concat -c copy 可拼）
        if (compose) vchain.push(`scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30`);
        if (cfg.dedupeFx !== false) {
          // 去重变换：整段连续缓推/缓拉 + 35% 随机水平翻转 + 5 套滤镜预设轮换 → 同素材多条成片互不撞车
          const zin = Math.random() < 0.5;
          const z0 = 1 + Math.random() * 0.05;
          const dz = 0.05 + Math.random() * 0.07;
          const frames = Math.max(2, Math.round(DUR * 30));
          const zexpr = zin ? `${z0.toFixed(3)}+${dz.toFixed(3)}*on/${frames}` : `${(z0 + dz).toFixed(3)}-${dz.toFixed(3)}*on/${frames}`;
          if (Math.random() < 0.35) vchain.push('hflip');
          vchain.push(`zoompan=z='${zexpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,setsar=1`);
          // 色调走风格模版的同族滤镜轮换（既保风格、又让同素材多条成片互不撞车）
          const grades = (style.grades && style.grades.length) ? style.grades : DEDUPE_EQ;
          vchain.push(grades[Math.floor(Math.random() * grades.length)]);
        } else if (cfg.hookZoom !== false) {
          // 片头 0.5s 轻微推近（约 7%，呼应目标片的开场节奏）；zoompan 逐帧求值，crop 的 w/h 不支持
          const fps = Math.max(1, Number(probe.fps) || 30);
          const zn = Math.max(2, Math.round(fps * 0.5));
          vchain.push(`zoompan=z='1+0.07*(1-min(1\\,on/${zn}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},setsar=1`);
        }
        // 画面外框效果（风格模版决定）：暗角 / 胶片颗粒 / 电影黑边。
        // 都放在字幕与贴片之前，保证文字与花字依旧锐利。
        if (sFrame.vig) vchain.push(`vignette=${sFrame.vig}`);
        if (sFrame.grain && Number(sFrame.grain) > 0) vchain.push(`noise=alls=${Math.round(Number(sFrame.grain))}:allf=t+u`);
        if (sFrame.bars && Number(sFrame.bars) > 0) {
          const barH = Math.min(0.2, Math.max(0, Number(sFrame.bars))).toFixed(4);
          const bc = hexToFf(sFrame.barsColor || 'black');
          vchain.push(`drawbox=x=0:y=0:w=iw:h=ih*${barH}:color=${bc}@1:t=fill`);
          vchain.push(`drawbox=x=0:y=ih-ih*${barH}:w=iw:h=ih*${barH}:color=${bc}@1:t=fill`);
        }
        if (useSub) vchain.push('ass=sub.ass');
        // 转场：组片中间段按模版加一个短闪（flash=白闪 / black=黑场缓切），
        // 与下段开头 whoosh 音效呼应；末段由 tailFade 收尾，不加片头闪
        if (compose && !lastPart && style.transition && style.transition.type && style.transition.type !== 'none') {
          const td = Number(style.transition.duration) || 0.14;
          const tc = style.transition.color ? `:color=${style.transition.color}` : '';
          vchain.push(`fade=t=in:st=0:d=${td}${tc}`);
        }

        // 贴片弹入动画与停留时长由风格模版决定
        const LIFE = Number(sStk.life) || 1.9;
        stickers.forEach((s, k) => {
          const inIdx = 1 + (useBgm ? 1 : 0) + k;
          const Ts = Number(s.t.toFixed(2));
          const Te = Number((Ts + LIFE).toFixed(2));
          const bs = (W * 0.72 / s.cw).toFixed(4);
          const an = stickerAnim(sStk.anim, Ts);
          fc.push(`[${inIdx}:v]format=rgba,fade=t=in:st=${Ts}:d=0.1:alpha=1,fade=t=out:st=${(Te - 0.22).toFixed(2)}:d=0.22:alpha=1,scale=w='trunc(iw*${bs}*${an.sc}/2)*2':h=-2:eval=frame:flags=lanczos[s${k}]`);
        });
        // 画中画商品镜头：右上角小窗展示 1.4s（不动时间轴，enable 窗口控制）；
        // overlay 按时间戳同步副输入，pip 帧必须 setpts 平移到事件时刻 Ts，
        // 否则帧落在 0-1.4s 被 enable 窗口外的主画面消费（EOF 后 eof_action=pass 直接透传）
        shots.forEach((ev, k) => {
          const inIdx = sfxIdx + 1 + k;
          const pw = Math.round(W * 0.4);
          const ph = Math.round(H * 0.3);
          const off = Number(ev.offset || 0).toFixed(2);
          const Ts = Number(ev.t.toFixed(2));
          fc.push(`[${inIdx}:v]trim=start=${off}:duration=${Number((ev.offset || 0) + 1.4).toFixed(2)},setpts=PTS-STARTPTS+${Ts}/TB,scale=${pw}:${ph}:force_original_aspect_ratio=decrease[pips${k}]`);
        });
        // 结尾 0.45s 视频淡出（叠加在花字之后，整幅画面收黑，消除“戛然而止”的截断感）；
        // 组片模式下只有最后一段（价格/CTA）收尾，中段保持 hard cut + 下段 whoosh 作转场
        const tailFade = lastPart ? `fade=t=out:st=${Math.max(0, DUR - 0.45).toFixed(2)}:d=0.45` : null;
        {
          let cur = '0:v';
          if (vchain.length) {
            fc.push(`[${cur}]${vchain.join(',')}[vbase]`);
            cur = 'vbase';
          }
          stickers.forEach((s, k) => {
            const Ts = Number(s.t.toFixed(2));
            const Te = Number((s.t + LIFE).toFixed(2));
            // 位置由模版决定：钩子开场大字偏上更醒目；slide 动画再叠一段纵向滑入位移
            const baseY = s.hook ? `(H-h)*${Number(sStk.hookPos) || 0.18}` : `(H-h)*${Number(sStk.pos) || 0.4}`;
            const an = stickerAnim(sStk.anim, Ts);
            const yExpr = an.y ? `${baseY}+${an.y}` : baseY;
            fc.push(`[${cur}][s${k}]overlay=x=(W-w)/2:y='${yExpr}':enable='between(t\\,${Ts}\\,${Te})':eof_action=pass[vx${k}]`);
            cur = `vx${k}`;
          });
          shots.forEach((ev, k) => {
            const Ts = Number(ev.t.toFixed(2));
            const Te = Number((ev.t + 1.4).toFixed(2));
            fc.push(`[${cur}][pips${k}]overlay=x=W-w-24:y='H*0.08':enable='between(t\\,${Ts}\\,${Te})':eof_action=pass[px${k}]`);
            cur = `px${k}`;
          });
          // 画面进度条（竖屏短视频「播放进度」质感）：随播放时间从左向右生长，压在最上层
          const tail = [];
          if (sFrame.bar && DUR > 0) {
            const b = sFrame.bar;
            const bh = Math.max(4, Math.round(H * (Number(b.h) || 0.007)));
            const by = b.pos === 'bottom' ? `${H - bh}` : '0';
            tail.push(`drawbox=x=0:y=${by}:w=iw*t/${DUR.toFixed(3)}:h=${bh}:color=${hexToFf(b.c)}@0.95:t=fill`);
          }
          if (tailFade) tail.push(tailFade);
          fc.push(`[${cur}]${tail.length ? tail.join(',') : 'null'}[vout]`);
        }

        // BGM 音量：用户滑块为准（模版只负责切换模版时写入滑块初值）
        const vol = Math.min(0.85, Math.max(0, Number(cfg.bgmVolume) || 0.5));
        // 人声闪避参数由风格模版决定（旧默认 threshold=0.025/ratio=8 会全程把 BGM 压没）
        const bk = style.bgm || {};
        const duck = `sidechaincompress=threshold=${Number(bk.threshold) || 0.06}:ratio=${Number(bk.ratio) || 4}:attack=${Number(bk.attack) || 15}:release=${Number(bk.release) || 380}:makeup=1`;
        const fo = Math.max(0.2, DUR - 0.8).toFixed(2);
        const ao = Math.max(0, DUR - 0.55).toFixed(2);
        // 结尾音频淡出只落在组片的最后一段；中段音频随画面 hard cut，由下段 whoosh 掩护
        const master = `alimiter=limit=0.95,loudnorm=I=-16:TP=-1.2:LRA=11,aresample=44100${lastPart ? `,afade=t=out:st=${ao}:d=0.55` : ''}`;
        const bgmOut = lastPart ? `,afade=t=out:st=${fo}:d=0.8` : '';
        if (useBgm && hasAudio) {
          // 垫底 BGM 先抬到模版音量（BGM 素材本身已归一，无需再乘增益），再做侧链闪避
          fc.push(`[${bgmIdx}:a]atrim=0:${DUR.toFixed(3)},asetpts=PTS-STARTPTS,volume=${vol},afade=t=in:st=0:d=0.4${bgmOut}[bg]`);
          fc.push(`[bg][0:a]${duck}[duck]`);
          fc.push(`[0:a][duck][${sfxIdx}:a]amix=inputs=3:duration=first:weights=1 0.9 0.85:normalize=0,${master}[aout]`);
        } else if (useBgm) {
          fc.push(`[${bgmIdx}:a]atrim=0:${DUR.toFixed(3)},asetpts=PTS-STARTPTS,volume=${Math.min(1, vol * 1.6).toFixed(2)},afade=t=in:st=0:d=0.4${bgmOut}[bg]`);
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
        const tailFade = `fade=t=out:st=${Math.max(0, DUR - 0.45).toFixed(2)}:d=0.45`;
        if (useSub) ffArgs.push('-vf', `ass=sub.ass,${tailFade}`);
        else ffArgs.push('-vf', tailFade);
        if (hasAudio) ffArgs.push('-af', `afade=t=out:st=${Math.max(0, DUR - 0.55).toFixed(2)}:d=0.55`);
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

      // 短视频封面：最佳帧 + 标题花字 → cover-NN.jpg，并写入 mp4 cover art（Finder/QuickTime 直接可见）；
      // 组片模式分段不出封面，等 concat 拼完整条 combo 后统一生成
      let coverFile = null;
      if (cfg.coverArt && !compose) {
        onProgress({ stage: `生成封面 ${i + 1}/${jobs.length}`, percent: span(0.985), index: i + 1, total: jobs.length, name: path.basename(outFile) });
        const coverPath = path.join(outDir, `cover-${String(i + 1).padStart(2, '0')}.jpg`);
        const made = await makeCover(input, c.start, DUR, coverTitleText(c, moments), workDir, coverPath, W, H, style, cfg);
        if (made) {
          coverFile = path.basename(made);
          try { await attachCover(outFile, made); } catch (_) { /* cover art 写入失败不影响成片 */ }
        }
      }

      if (compose) {
        (comboParts[job.compose.combo] = comboParts[job.compose.combo] || []).push({
          part: job.compose.part, role: composeRole, file: outFile, rec, c, duration
        });
      } else {
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
          cover: coverFile,
          text: applySubtitleFixes(c.text || '', cfg)
        });
      }
      onProgress({ stage: `导出 ${i + 1}/${jobs.length}`, percent: span(1), index: i + 1, total: jobs.length, name: path.basename(outFile) });
    }

    // 组片：把「钩子 + 介绍 + 价格」分段拼成完整带货短视频（concat -c copy，秒级、零转码）
    if (compose) {
      const comboIdxs = Object.keys(comboParts).map(Number).sort((a, b) => a - b);
      for (let ci = 0; ci < comboIdxs.length; ci += 1) {
        checkCanceled();
        const comboNo = comboIdxs[ci] + 1;
        const parts = comboParts[comboIdxs[ci]].sort((a, b) => a.part - b.part);
        const outFile = path.join(outDir, `combo-${String(comboNo).padStart(2, '0')}.mp4`);
        const bodyDur = parts.reduce((s, p) => s + p.duration, 0);
        const totalDur = bodyDur;
        onProgress({ stage: `拼接成片 ${ci + 1}/${comboIdxs.length}`, percent: ((ci + 0.2) / comboIdxs.length) * 100, index: ci + 1, total: comboIdxs.length, name: path.basename(outFile) });
        const listPath = path.join(workDir, `combo-${comboNo}.txt`);
        const seq = parts.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`);
        fs.writeFileSync(listPath, seq.join('\n'), 'utf8');
        await runFf(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outFile]);
        checkCanceled();

        // combo 封面：标题取价格段的报价/商品名（转化点优先）
        let coverFile = null;
        if (cfg.coverArt) {
          onProgress({ stage: `生成封面 ${ci + 1}/${comboIdxs.length}`, percent: ((ci + 0.7) / comboIdxs.length) * 100, index: ci + 1, total: comboIdxs.length, name: path.basename(outFile) });
          const pc = parts[parts.length - 1].c;
          const priceSegs = parts[parts.length - 1].rec.asr.segments || [];
          const cMoments = pickStickerMoments(priceSegs.map((s) => ({ ...s, text: applySubtitleFixes(s.text, cfg) })), pc.start, pc.end, pc.end - pc.start, { spacing: sStk.spacing, minGap: sStk.minGap });
          const title = coverTitleText(pc, cMoments) || (parts[0].c.skuNames || [])[0] || null;
          const coverPath = path.join(outDir, `cover-${String(comboNo).padStart(2, '0')}.jpg`);
          // 封面帧优先取「价格段源素材原帧」（无烧录字幕/栏头，画面干净，更贴近参考封面）；失败再退回成片帧
          const pLast = parts[parts.length - 1];
          const srcPath = pLast.rec && pLast.rec.source ? pLast.rec.source.path : '';
          const made = (srcPath && fs.existsSync(srcPath)
            ? await makeCover(srcPath, pc.start, pLast.duration, title, workDir, coverPath, 720, 1280, style, cfg)
            : null) || await makeCover(outFile, 0, bodyDur, title, workDir, coverPath, 720, 1280, style, cfg);
          if (made) {
            coverFile = path.basename(made);
            try { await attachCover(outFile, made); } catch (_) {}
          }
        }

        manifest.push({
          file: path.basename(outFile),
          source: parts.map((p) => p.rec.source.name).join(' + '),
          structure: parts.map((p) => `${ROLES[p.role] ? ROLES[p.role].label : p.role} ${Number(p.duration.toFixed(1))}s`).join(' + '),
          hookType: parts[0].c.hookType || 'normal',
          sourcePath: parts.map((p) => p.rec.source.path).join(' + '),
          start: parts[0].c.start,
          end: parts[parts.length - 1].c.end,
          duration: Number(totalDur.toFixed(2)),
          score: Math.round(parts.reduce((s, p) => s + (p.c.score || 0), 0) / parts.length),
          skus: [...new Set(parts.flatMap((p) => p.c.skuNames || []))],
          prices: parts.flatMap((p) => p.priceFixes || p.c.priceMatches || []),
          cover: coverFile,
          text: parts.map((p) => applySubtitleFixes(p.c.text || '', cfg)).filter(Boolean).join(' ')
        });
      }
    }

    writeJson(path.join(outDir, 'manifest.json'), { batch: batchName, createdAt: new Date().toISOString(), count: manifest.length, clips: manifest });
    const escCsv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const csv = [['文件', '封面', '来源素材', '开始', '结束', '时长', '分数', '钩子类型', '商品', '价格', '文案'].join(',')];
    manifest.forEach((m) => csv.push([
      escCsv(m.file), escCsv(m.cover || ''), escCsv(m.source), m.start, m.end, m.duration, m.score,
      escCsv(HOOK_LABEL[m.hookType] || (m.hookType || '')),
      escCsv(m.skus.join(';')), escCsv(m.prices.join(';')), escCsv(m.text)
    ].join(',')));
    fs.writeFileSync(path.join(outDir, 'manifest.csv'), '﻿' + csv.join('\n'), 'utf8');

    onProgress({ stage: '全部导出完成', percent: 100, index: jobs.length, total: jobs.length, name: '' });
    return { dir: outDir, count: manifest.length };
  } finally {
    batch = null;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function getStyleTemplates() {
  return styleList();
}

module.exports = {
  pickFiles,
  scanDir,
  getStyleTemplates,
  getConfig,
  saveConfig,
  getSkus,
  saveSkus,
  importSkusCsv,
  exportSkusCsv,
  pickStructureFolder,
  setSourceRole,
  analyze,
  listSources,
  getSource,
  updateCandidate,
  removeSource,
  render,
  cancel,
  isBusy
};
