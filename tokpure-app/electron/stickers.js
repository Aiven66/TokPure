'use strict';

/* ============================================================
   TokPure — TikTok 梗图贴纸（GIF Sticker）本地生成引擎

   流程：导入图片 / 视频 → 归一化为 480x480 方画布（模糊底填充）
        → 套用梗图模板（震动 / 推近 / 弹跳 / 旋转 / 呼吸 / 闪爆 / 变色 / 破防）
        → 叠加花字文案 → palettegen/paletteuse 输出 GIF
   全部本地 ffmpeg 运算，零云端依赖；中间产物落盘缓存，重复素材不重算。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, dialog, shell, clipboard } = require('electron');
const ffmpegMod = require('./ffmpeg');
const store = require('./store');

const OUT_ROOT = 'TokPure-Stickers';
const CANVAS = 360;          // 输出画布边长（GIF 贴纸为正方形；360 兼顾清晰度与体积）
const FPS = 12;              // GIF 帧率（动效够顺滑，体积可控）
const CLIP_SEC = 2.4;        // 单张贴纸时长
const MAX_BATCH = 4;         // 一次最多并发生成的模板数
const GIF_COLORS = 96;       // GIF 调色板色数（花字为纯色，96 色已足够清晰）

/* ---------------- 梗图模板 ---------------- */
/* motion：作用在 360x360 归一化画布上的滤镜链（表达式已转义，可在 -vf 中直接拼接）
   注意：内置 FFmpeg 6.0 的 crop 滤镜只在配置阶段求值一次 w/h，含 t 的 w/h 表达式会直接报错，
   因此「缩放 / 推近 / 抖动」统一用 zoompan 实现（z/x/y 逐帧求值，on 为输出帧序号）。
   text：花字样式（fill 主色 / border 描边 / accent 阴影）
   captions：默认有梗台词，可被用户改写 */
const ZOOM_IN_FRAMES = 11; // 推近在约 0.92s 内完成（12fps 下的第 11 帧）

function zp(zExpr, dx = '', dy = '') {
  return (
    `zoompan=z='${zExpr}':d=1:` +
    `x='iw/2-(iw/zoom/2)${dx}':y='ih/2-(ih/zoom/2)${dy}':` +
    `s=${CANVAS}x${CANVAS}:fps=${FPS}`
  );
}

const TEMPLATES = [
  {
    id: 'boom',
    name: '震惊体',
    tip: '镜头急速推近 + 剧烈抖动，「震惊」大字压顶',
    icon: 'zap',
    motion: zp(
      `1.05+0.25*min(on/${ZOOM_IN_FRAMES},1)`,
      `+9*sin(28*on/${FPS})`,
      `+7*cos(23*on/${FPS})`
    ),
    text: { fill: '0xFFE33A', border: '0x111111', accent: '0x000000', pos: 0.72 },
    captions: ['震惊！', '离谱！', '什么鬼！']
  },
  {
    id: 'shake',
    name: '笑不活了',
    tip: '左右猛抖，粉字狂笑，适合「哈哈哈哈」类素材',
    icon: 'sparkles',
    motion: zp('1.062', `+11*sin(26*on/${FPS})`, `+9*cos(31*on/${FPS})`),
    text: { fill: '0xFF5180', border: '0x2A0010', accent: '0x000000', pos: 0.70 },
    captions: ['笑不活了', '哈哈哈哈', '要笑死我']
  },
  {
    id: 'bounce',
    name: '蹦迪',
    tip: '上下弹跳，青字蹦跶，节奏感拉满',
    icon: 'music',
    motion: zp('1.062', '', `-14*abs(sin(3.2*on/${FPS}))`),
    text: { fill: '0x35FBF5', border: '0x00282A', accent: '0x000000', pos: 0.70 },
    captions: ['泰裤辣', '蹦迪现场', '节奏跟上']
  },
  {
    id: 'spin',
    name: '转圈圈',
    tip: '整幅画面左右摇摆旋转，绿字环绕，鬼畜感',
    icon: 'refresh',
    motion: `scale=iw*1.2:ih*1.2,rotate='0.10*sin(2.4*t)':fillcolor=0x111317,crop=${CANVAS}:${CANVAS},setsar=1`,
    text: { fill: '0x4EDEA3', border: '0x00221A', accent: '0x000000', pos: 0.70 },
    captions: ['转晕了', '头晕眼花', '我不听']
  },
  {
    id: 'pulse',
    name: '绝了',
    tip: '呼吸式缩放，橙字稳中带骚，最通用的一套',
    icon: 'activity',
    motion: zp(`1.05+0.15*(sin(5*on/${FPS})+1)`),
    text: { fill: '0xFF7A3C', border: '0x2B0C00', accent: '0x000000', pos: 0.70 },
    captions: ['绝了', '太顶了', '就这？']
  },
  {
    id: 'flash',
    name: '闪爆',
    tip: '高频闪白，白字黑描边，冲击力最强',
    icon: 'bolt',
    motion: `eq=brightness='0.24*abs(sin(9*t))':eval=frame,` + zp(`1.03+0.10*(sin(9*on/${FPS})+1)`),
    text: { fill: '0xFFFFFF', border: '0x000000', accent: '0x000000', pos: 0.72 },
    captions: ['闪爆了', '亮瞎眼', 'boom！']
  },
  {
    id: 'rainbow',
    name: '彩虹病',
    tip: '色相循环流动，白字黑边，抽象又上头',
    icon: 'palette',
    motion: "hue=h='45*t'," + zp(`1.03+0.08*(sin(3*on/${FPS})+1)`),
    text: { fill: '0xFFFFFF', border: '0x101010', accent: '0x000000', pos: 0.70 },
    captions: ['彩虹屁', '抽象艺术', '我看不懂']
  },
  {
    id: 'emo',
    name: '破防',
    tip: '去色 + 颗粒噪点，蓝字低落，「呜呜呜」专用',
    icon: 'alert',
    // allf=p 生成「逐帧稳定」的半规则颗粒：视觉上仍是胶片噪点，但图案不逐帧重掷，
    // 帧间差异极小、体积可控（allf=t 的时间型噪点每帧全变，GIF 压缩率极差、可达 4MB+）
    motion: 'eq=saturation=0.15:contrast=1.12,noise=alls=5:allf=p,' + zp(`1.02+0.06*(sin(2.4*on/${FPS})+1)`),
    text: { fill: '0x8FB6FF', border: '0x0A1430', accent: '0x000000', pos: 0.70 },
    captions: ['破防了', '呜呜呜', '我裂开了']
  }
];

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.heic'];
const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];

/* ---------------- 低层工具 ---------------- */
let activeChild = null;

function runFf(args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegMod.getFfmpegPath(), args, {
      cwd,
      windowsHide: true
    });
    activeChild = child;
    let stderr = '';
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 60000) stderr = stderr.slice(-30000);
      if (onLine) s.split(/\r|\n/).forEach((l) => { if (l.trim()) onLine(l); });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg 退出码 ${code}\n${stderr.slice(-500)}`));
    });
  });
}

function cancel() {
  if (activeChild) {
    try { activeChild.kill('SIGKILL'); } catch (_) {}
    activeChild = null;
  }
  return true;
}

function kindOf(file) {
  const ext = path.extname(file || '').toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

function outRoot() {
  const dir = path.join(store.get().downloadDir || app.getPath('downloads'), OUT_ROOT);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function workRoot() {
  const dir = path.join(app.getPath('temp'), 'tokpure-stickers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function baseName(file) {
  return path
    .basename(file)
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 40);
}

/* ---------------- 字体解析 ---------------- */
const CJK_FONT_CANDS = [
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf'
];
const LATIN_FONT_CANDS = [
  '/System/Library/Fonts/Supplemental/Impact.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  'C:/Windows/Fonts/impact.ttf',
  'C:/Windows/Fonts/arialbd.ttf'
];

function hasCJK(text) {
  return /[\u3000-\u9fff\uff00-\uffef]/.test(String(text || ''));
}

function resolveFont(text) {
  const cands = hasCJK(text) ? CJK_FONT_CANDS.concat(LATIN_FONT_CANDS) : LATIN_FONT_CANDS.concat(CJK_FONT_CANDS);
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

/* ---------------- 素材归一化（480x480 方画布） ---------------- */
/** 方画布滤镜：等比缩小为前景，放大填充做高斯模糊背景，避免黑边 */
const SQUARE_FILTER =
  'split=2[bgs][fgs];' +
  `[bgs]scale=${CANVAS}:${CANVAS}:force_original_aspect_ratio=increase,crop=${CANVAS}:${CANVAS},gblur=sigma=22[bgb];` +
  `[fgs]scale=${CANVAS}:${CANVAS}:force_original_aspect_ratio=decrease[fgl];` +
  '[bgb][fgl]overlay=(W-w)/2:(H-h)/2:format=auto';

/**
 * 选取截取窗口：图片整段静帧；视频取靠前 30% 处（通常是钩子/高光），
 * 短于 CLIP_SEC 的视频直接从 0 开始。
 */
function pickBestWindow(kind, duration) {
  if (kind === 'image' || !duration || duration <= CLIP_SEC) return { ss: 0, dur: CLIP_SEC };
  const ss = Math.max(0, Math.min(duration - CLIP_SEC, duration * 0.3));
  return { ss: Number(ss.toFixed(2)), dur: CLIP_SEC };
}

/** 只解析容器头取时长，不做完整解码（大文件也能秒回） */
function probeDuration(file) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegMod.getFfmpegPath(), ['-hide_banner', '-i', file], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-10000); });
    child.on('error', () => resolve(0));
    // 未指定输出时 ffmpeg 以退出码 1 结束，这里只关心 stderr 里的 Duration
    child.on('close', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err);
      if (!m) return resolve(0);
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

/** 生成（并缓存）归一化方画布底片 base.mp4 */
async function buildBase(file, kind, cacheDir) {
  const out = path.join(cacheDir, 'base.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 2000) return out;

  const args = ['-v', 'error', '-y'];
  if (kind === 'image') {
    args.push('-loop', '1', '-t', String(CLIP_SEC), '-i', file);
  } else {
    const dur = await probeDuration(file);
    const w = pickBestWindow(kind, dur);
    if (w.ss > 0) args.push('-ss', String(w.ss));
    args.push('-t', String(CLIP_SEC), '-i', file);
  }
  args.push(
    '-filter_complex', `[0:v]${SQUARE_FILTER}[v]`,
    '-map', '[v]',
    '-r', String(FPS),
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    out
  );
  await runFf(args, cacheDir);
  if (!fs.existsSync(out) || fs.statSync(out).size < 2000) throw new Error('素材归一化失败，请确认文件可正常解码');
  return out;
}

/* ---------------- 花字 ---------------- */
function drawTextFilter(text, tpl, workDir) {
  const font = resolveFont(text);
  if (!font) return null;
  fs.writeFileSync(path.join(workDir, 'cap.txt'), String(text), 'utf8');
  // 字号自适应：中文按 1 个字宽，拉丁按 0.58 个字宽估算，控制在画布 88% 内
  let units = 0;
  for (const ch of String(text)) units += /[\x20-\x7e]/.test(ch) ? 0.58 : 1;
  const size = Math.max(30, Math.min(76, Math.floor((CANVAS * 0.88) / Math.max(1, units))));
  const st = tpl.text || {};
  // 花字位置保持静止：文字逐帧做亚像素位移会让 GIF 每帧都产生新的抖动噪点，
  // 帧间几乎无重复，体积会翻倍还不止；动感交给画面本身的模板动效即可。
  const yPos = `${CANVAS} * ${st.pos || 0.7} - th/2`;
  const xPos = '(w-tw)/2';
  return (
    `drawtext=fontfile='${font}':textfile=cap.txt:fontsize=${size}:` +
    `fontcolor=${st.fill || '0xFFFFFF'}:` +
    `borderw=${Math.max(4, Math.round(size * 0.11))}:bordercolor=${st.border || '0x000000'}:` +
    `shadowcolor=${st.accent || '0x000000'}@0.55:shadowx=3:shadowy=4:` +
    `x=${xPos}:y=${yPos}`
  );
}

/* ---------------- 单张贴纸生成 ---------------- */
async function renderOne(base, tpl, caption, workDir, outPath) {
  const dt = drawTextFilter(caption, tpl, workDir);
  const chain = [tpl.motion, dt, `fps=${FPS}`].filter(Boolean).join(',');
  // 两段式调色板：先 palettegen 统计全片最具代表性的 96 色，再 paletteuse 套色；
  // dither 用 bayer（scale 4 偏少噪点），diff_mode=rectangle 只重绘变化区域以压体积
  const graph =
    `${chain},split[s0][s1];` +
    `[s0]palettegen=max_colors=${GIF_COLORS}:stats_mode=diff[p];` +
    '[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  await runFf(['-v', 'error', '-y', '-i', base, '-vf', graph, '-loop', '0', outPath], workDir);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1500) {
    throw new Error('贴纸生成失败（输出为空）');
  }
  return outPath;
}

/* ---------------- 对外 API ---------------- */

function listTemplates() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    tip: t.tip,
    icon: t.icon,
    captions: t.captions
  }));
}

/** 选择素材：图片 / 视频 */
async function pick(win) {
  const res = await dialog.showOpenDialog(win, {
    title: '选择图片或视频',
    properties: ['openFile'],
    filters: [
      { name: '图片 / 视频', extensions: [...IMAGE_EXT, ...VIDEO_EXT].map((e) => e.slice(1)) },
      { name: '图片', extensions: IMAGE_EXT.map((e) => e.slice(1)) },
      { name: '视频', extensions: VIDEO_EXT.map((e) => e.slice(1)) }
    ]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return describe(res.filePaths[0]);
}

/** 描述一个本地文件（拖拽上传同样走这里做校验） */
function describe(p) {
  if (!p || !fs.existsSync(p)) throw new Error('文件不存在或已被移动');
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('不是有效的文件');
  const kind = kindOf(p);
  if (!kind) throw new Error('仅支持 JPG / PNG / WEBP / GIF / MP4 / MOV 等图片与视频格式');
  return { path: p, name: path.basename(p), size: st.size, kind };
}

/**
 * 生成梗图贴纸。
 * payload: { input, templates: [id], caption, captions: { id: 默认台词 } }
 * caption 为全局自定义文案；captions 为各模板的本地化默认台词（留空时按模板取用）
 * 返回 { items: [{ id, name, caption, file, ok, error }] }
 */
async function generate(payload, onProgress) {
  const { input, templates, caption } = payload || {};
  const captionMap = (payload && payload.captions) || {};
  const meta = describe(input);
  if (!ffmpegMod.hasFfmpeg()) throw new Error('未检测到 FFmpeg，无法本地生成贴纸');

  const ids = Array.isArray(templates) && templates.length ? templates.slice(0, MAX_BATCH) : ['pulse'];
  // 素材指纹（路径 + 体积 + 修改时间）作缓存目录，同素材重复生成不重算底片
  let sig = meta.path + ':' + meta.size;
  try { sig += ':' + fs.statSync(meta.path).mtimeMs; } catch (_) {}
  const hash = crypto.createHash('md5').update(sig).digest('hex').slice(0, 12);
  const cacheDir = path.join(workRoot(), hash);
  fs.mkdirSync(cacheDir, { recursive: true });

  onProgress && onProgress({ stage: 'base', pct: 8 });
  const base = await buildBase(meta.path, meta.kind, cacheDir);

  const stamp = Date.now().toString().slice(-6);
  const prefix = baseName(meta.path);
  const items = [];
  for (let i = 0; i < ids.length; i++) {
    const tpl = TEMPLATES.find((t) => t.id === ids[i]);
    if (!tpl) continue;
    const text = (caption && String(caption).trim()) || captionMap[tpl.id] || tpl.captions[0];
    const out = path.join(outRoot(), `${prefix}-${tpl.id}-${stamp}.gif`);
    onProgress && onProgress({ stage: 'render', id: tpl.id, index: i + 1, total: ids.length, pct: 15 + Math.round((i / ids.length) * 80) });
    try {
      await renderOne(base, tpl, text, cacheDir, out);
      items.push({ id: tpl.id, name: tpl.name, caption: text, file: out, ok: true });
    } catch (e) {
      items.push({ id: tpl.id, name: tpl.name, caption: text, file: '', ok: false, error: String((e && e.message) || e) });
    }
  }
  onProgress && onProgress({ stage: 'done', pct: 100 });
  const outputs = items.filter((x) => x.ok).map((x) => x.file);
  return { items, outputs, dir: outRoot() };
}

/** 保存单张贴纸到用户选择的位置 */
async function save(win, payload) {
  const { src, name } = payload || {};
  if (!src || !fs.existsSync(src)) throw new Error('贴纸文件不存在');
  const res = await dialog.showSaveDialog(win, {
    title: '保存 GIF 贴纸',
    defaultPath: path.join(outRoot(), name || path.basename(src)),
    filters: [{ name: 'GIF 动图', extensions: ['gif'] }]
  });
  if (res.canceled || !res.filePath) return null;
  fs.copyFileSync(src, res.filePath);
  return { saved: res.filePath };
}

/**
 * 一键分享到 TikTok 好友：
 * TikTok 未开放「分享贴纸」API，因此走最顺滑的本地链路 ——
 * ① 有梗文案写入剪贴板；② 唤起 TikTok 桌面端（未安装则打开网页版私信）；
 * ③ 在访达中高亮 GIF 文件，用户直接拖进好友聊天即可发送。
 */
async function share(payload) {
  const { file, caption } = payload || {};
  if (!file || !fs.existsSync(file)) throw new Error('贴纸文件不存在');
  const text = caption || '';
  if (text) clipboard.writeText(text);
  let opened = 'none';
  try {
    await shell.openExternal('tiktok://');
    opened = 'app';
  } catch (_) {
    try {
      await shell.openExternal('https://www.tiktok.com/messages');
      opened = 'web';
    } catch (_) { opened = 'none'; }
  }
  shell.showItemInFolder(file);
  return { opened, file, caption: text };
}

module.exports = {
  IMAGE_EXT,
  VIDEO_EXT,
  listTemplates,
  pick,
  describe,
  generate,
  save,
  share,
  cancel
};
