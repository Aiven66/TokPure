'use strict';

/* ============================================================
   爆款短视频风格模版（对标美图「开拍 / 剪映」的成套深度风格）。
   一套模版 = 字幕（ASS 大字/动效）+ 剪辑风格（滤镜/转场/画面外框）
             + 贴片风格 + BGM 闪避参数 + 短视频封面配色。
   clipai.js 渲染时读取本表，把每一项落到 ffmpeg 滤镜链上。

   subtitle 字段说明：
     baseHex/emphColor 字幕底色/强调色（价格、数字、CTA 词自动换强调色）
     font   libass 字体名（macOS 内置：PingFang SC / Heiti SC / STKaiti）
     anim   逐句入场动效：
              pop 弹入 / popBig 强弹入 / fade 淡入 / fadeSlow 慢淡
              zoomIn 小→满格放大 / expand 字距由松收敛 / karaoke 逐字卡拉OK填充
     sizeScale 字幕放大倍率（开拍式大字 ≈1.1-1.2）

   sticker 字段说明（花字贴片）：
     shape  burst 外发光粗描边 / band 实心色带 / box 浅底彩字
            hollow 空心描边（霓虹） / underline 彩字+下方强调条（知识卡）
     fill/border/glow/text 配色    font 花字字体偏好（xingkai/wawa/heiti/pingfang）
     anim   pop 回弹 / zoom 放大 / slide 下滑
     life   停留秒数 / pos 常规纵向位置 / hookPos 开场钩子位置 / spacing 出片间隔 / minGap 最小间隔

   frame 字段说明（画面外框，制造「剪辑感」）：
     bars 上下电影黑边占画面高度比例 / barsColor 黑边色（默认 black）
     vig  暗角强度表达式（PI/4 常规，PI/3.5 更强；留空关闭）
     grain 胶片颗粒强度（noise alls，0 关闭）
     bar  { c, h, pos } 播放进度条：色值 / 高度比例 / top|bottom

   cover 字段说明（短视频封面配色）：tint 叠色底 / tintAlpha 叠色透明度 /
     title 大字色 / stroke 描边色 / accent 强调条色
   ============================================================ */

/* 贴片形状：burst=外发光粗描边（最抓眼）；band=实心色带；box=浅底彩字；
   hollow=空心描边；underline=彩字+下方强调条 */
const STYLE_TEMPLATES = [
  {
    id: 'vital-sale',
    name: '活力带货',
    desc: '逐句弹入大字（白字黄强调）+ 密集弹入贴片 + 暖调高饱和 + 白闪转场',
    accent: '#FFE33A',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#FFDE33',
      fontSize: 20, marginV: 84, outline: 4,
      font: 'Heiti SC', bold: 1, anim: 'pop', sizeScale: 1.15
    },
    sticker: {
      shape: 'burst',
      fill: '0xFFE33A', border: '0xB00000', glow: '0xFFC800', text: '0xFFE33A',
      font: 'xingkai', anim: 'pop', life: 1.9,
      pos: 0.40, hookPos: 0.18, spacing: 5.6, minGap: 2.8
    },
    cover: {
      tint: '0x2A1400', tintAlpha: 0.44, title: '#FFE33A', stroke: 'black', accent: '#FF3B30'
    },
    grades: [
      'eq=saturation=1.16:contrast=1.07:brightness=0.02',
      'eq=saturation=1.10:contrast=1.10:gamma=1.03',
      'eq=saturation=1.20:contrast=1.04:brightness=0.01'
    ],
    transition: { type: 'flash', color: 'white', duration: 0.14 },
    bgm: { volume: 0.5, threshold: 0.06, ratio: 4, attack: 15, release: 380 }
  },
  {
    id: 'funny-show',
    name: '搞笑综艺',
    desc: '逐句强弹入大字（白字黄强调）+ 黄底黑字色带贴片 + 高反差 + 黑场切',
    accent: '#FFD400',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#FFD400',
      fontSize: 22, marginV: 96, outline: 5,
      font: 'PingFang SC', bold: 1, anim: 'popBig', sizeScale: 1.2
    },
    sticker: {
      shape: 'band',
      fill: '0xFFD400', border: '0x1A1A1A', text: '0x1A1A1A',
      font: 'wawa', anim: 'slide', life: 2.1,
      pos: 0.42, hookPos: 0.20, spacing: 6.0, minGap: 3.0
    },
    cover: {
      tint: '0x101020', tintAlpha: 0.42, title: '#FFD400', stroke: 'black', accent: '#FFD400'
    },
    grades: [
      'eq=saturation=1.22:contrast=1.14',
      'eq=saturation=1.12:contrast=1.18:gamma=0.97',
      'eq=brightness=0.02:saturation=1.18:contrast=1.10'
    ],
    transition: { type: 'black', color: 'black', duration: 0.16 },
    bgm: { volume: 0.45, threshold: 0.055, ratio: 4, attack: 12, release: 360 }
  },
  {
    id: 'simple-premium',
    name: '简约质感',
    desc: '逐句淡入字幕（白字蓝强调·开拍同款）+ 稀疏浅底贴片 + 低饱和中性调',
    accent: '#F2F2F2',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#6E9BFF',
      fontSize: 16, marginV: 62, outline: 2,
      font: 'PingFang SC', bold: 0, anim: 'fade', sizeScale: 0.95
    },
    sticker: {
      shape: 'band',
      fill: '0xF2F2F2', border: '0x2B2B2B', text: '0x2B2B2B',
      font: 'pingfang', anim: 'zoom', life: 1.6,
      pos: 0.44, hookPos: 0.24, spacing: 14.0, minGap: 5.0
    },
    cover: {
      tint: '0x111318', tintAlpha: 0.40, title: '#FFFFFF', stroke: 'black', accent: '#6E9BFF'
    },
    grades: [
      'eq=saturation=0.96:contrast=1.02',
      'eq=saturation=1.02:brightness=0.015:contrast=1.03',
      'eq=gamma=0.98:saturation=0.98:contrast=1.04'
    ],
    transition: { type: 'none', duration: 0.1 },
    bgm: { volume: 0.32, threshold: 0.05, ratio: 3, attack: 20, release: 420 }
  },
  {
    id: 'chinese-classic',
    name: '国风文韵',
    desc: '逐句慢淡楷体字幕（米字金强调）+ 酒红包金贴片 + 暖调低饱和 + 黑场缓切',
    accent: '#E8C87A',
    subtitle: {
      color: 'yellow', baseHex: '#F7E7B0', emphColor: '#E8C87A',
      fontSize: 18, marginV: 78, outline: 3,
      font: 'STKaiti', bold: 0, anim: 'fadeSlow', sizeScale: 1.05
    },
    sticker: {
      shape: 'band',
      fill: '0x8C1B1B', border: '0xE8C87A', text: '0xF7E7B0',
      font: 'xingkai', anim: 'zoom', life: 2.2,
      pos: 0.41, hookPos: 0.19, spacing: 7.0, minGap: 3.2
    },
    cover: {
      tint: '0x2A0E0E', tintAlpha: 0.46, title: '#F7E7B0', stroke: 'black', accent: '#8C1B1B'
    },
    grades: [
      'eq=saturation=1.04:contrast=1.04:brightness=0.015',
      'eq=gamma_r=1.06:gamma_b=0.95:saturation=1.02',
      'eq=gamma=1.02:saturation=0.98:contrast=1.03'
    ],
    transition: { type: 'black', color: 'black', duration: 0.22 },
    bgm: { volume: 0.4, threshold: 0.055, ratio: 3.5, attack: 18, release: 400 }
  },
  {
    id: 'tech-knowledge',
    name: '科技知识号',
    desc: '深蓝冷调 + 字距收敛大字字幕（白字金强调）+ 极简浅底贴片 + 低沉 BGM 闪避',
    accent: '#FFD24A',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#FFD24A',
      fontSize: 19, marginV: 150, outline: 5,
      font: 'PingFang SC', bold: 1, anim: 'expand', sizeScale: 1.12
    },
    sticker: {
      shape: 'box',
      fill: '0x0F2A5C', border: '0xFFD24A', glow: '0xFFD24A', text: '0xFFFFFF',
      font: 'heiti', anim: 'zoom', life: 1.7,
      pos: 0.30, hookPos: 0.26, spacing: 15.0, minGap: 5.5
    },
    cover: {
      tint: '0x081026', tintAlpha: 0.50, title: '#FFD24A', stroke: 'black', accent: '#3AA0FF'
    },
    frame: { bar: { c: '#FFD24A', h: 0.006, pos: 'bottom' } },
    grades: [
      'eq=saturation=1.06:contrast=1.10:brightness=-0.01',
      'eq=gamma=1.02:saturation=1.02:contrast=1.12',
      'eq=saturation=1.10:contrast=1.06:gamma_b=1.04'
    ],
    transition: { type: 'black', color: 'black', duration: 0.2 },
    bgm: { volume: 0.34, threshold: 0.045, ratio: 3.2, attack: 22, release: 440 }
  },
  {
    id: 'luxury-gold',
    name: '轻奢金质',
    desc: '黑金配色 + 米金细体慢淡入大字字幕 + 描金浅底贴片 + 冷调微降饱和',
    accent: '#D4AF37',
    subtitle: {
      color: 'yellow', baseHex: '#F3E3B3', emphColor: '#D4AF37',
      fontSize: 17, marginV: 92, outline: 3,
      font: 'PingFang SC', bold: 0, anim: 'fadeSlow', sizeScale: 1.06
    },
    sticker: {
      shape: 'box',
      fill: '0x1A1608', border: '0xD4AF37', text: '0xF3E3B3',
      font: 'xingkai', anim: 'zoom', life: 2.0,
      pos: 0.38, hookPos: 0.22, spacing: 9.0, minGap: 3.6
    },
    cover: {
      tint: '0x0A0A0C', tintAlpha: 0.50, title: '#D4AF37', stroke: 'black', accent: '#D4AF37'
    },
    grades: [
      'eq=saturation=0.98:contrast=1.06',
      'eq=gamma_r=1.03:gamma_b=0.97:saturation=1.02:contrast=1.05',
      'eq=gamma=0.99:saturation=1.0:contrast=1.07:brightness=0.005'
    ],
    transition: { type: 'black', color: 'black', duration: 0.24 },
    bgm: { volume: 0.36, threshold: 0.05, ratio: 3.4, attack: 20, release: 420 }
  },
  {
    id: 'fresh-life',
    name: '清新生活',
    desc: '柔和暖调 + 圆润浅底贴片 + 白字青绿强调淡入字幕 + 柔光转场',
    accent: '#7BE0B0',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#7BE0B0',
      fontSize: 18, marginV: 72, outline: 3,
      font: 'PingFang SC', bold: 1, anim: 'fade', sizeScale: 1.02
    },
    sticker: {
      shape: 'box',
      fill: '0xE8FFF4', border: '0x2E7D5B', text: '0x1E6B4C',
      font: 'pingfang', anim: 'pop', life: 1.8,
      pos: 0.42, hookPos: 0.22, spacing: 10.0, minGap: 3.8
    },
    cover: {
      tint: '0x123A2C', tintAlpha: 0.38, title: '#FFFFFF', stroke: 'black', accent: '#7BE0B0'
    },
    grades: [
      'eq=saturation=1.08:brightness=0.02:contrast=1.02',
      'eq=saturation=1.04:gamma=1.03:contrast=1.03',
      'eq=brightness=0.025:saturation=1.10:contrast=1.02'
    ],
    transition: { type: 'flash', color: 'white', duration: 0.18 },
    bgm: { volume: 0.42, threshold: 0.055, ratio: 3.6, attack: 18, release: 400 }
  },
  {
    id: 'street-trend',
    name: '潮酷街头',
    desc: '青紫霓虹 + 斜切色带贴片 + 白字青色细描边字幕 + 高饱和快节奏',
    accent: '#39E6FF',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#39E6FF',
      fontSize: 21, marginV: 88, outline: 4,
      font: 'Heiti SC', bold: 1, anim: 'popBig', sizeScale: 1.16
    },
    sticker: {
      shape: 'band',
      fill: '0x39E6FF', border: '0x1A0A2E', text: '0x1A0A2E',
      font: 'wawa', anim: 'slide', life: 1.9,
      pos: 0.40, hookPos: 0.20, spacing: 6.5, minGap: 3.0
    },
    cover: {
      tint: '0x1A0A2E', tintAlpha: 0.46, title: '#39E6FF', stroke: 'black', accent: '#FF3AC8'
    },
    frame: { vig: 'PI/4.6', grain: 3 },
    grades: [
      'eq=saturation=1.24:contrast=1.12',
      'eq=saturation=1.16:contrast=1.16:gamma_b=1.05',
      'eq=saturation=1.28:brightness=0.01:contrast=1.08'
    ],
    transition: { type: 'flash', color: 'white', duration: 0.12 },
    bgm: { volume: 0.48, threshold: 0.06, ratio: 4, attack: 14, release: 360 }
  },

  /* ===== 以下为对标「开拍 / 剪映」的深度成套模版（结构与前 8 套明显区分） ===== */

  {
    id: 'cine-film',
    name: '电影胶片',
    desc: '上下电影黑边 + 胶片颗粒 + 暗角 + 米白细体慢淡字幕 + 空心描边花字 + 冷调低饱和 + 慢黑场',
    accent: '#E8D9B0',
    subtitle: {
      color: 'white', baseHex: '#F2E9D4', emphColor: '#E8D9B0',
      fontSize: 17, marginV: 104, outline: 3,
      font: 'PingFang SC', bold: 0, anim: 'fadeSlow', sizeScale: 1.02
    },
    sticker: {
      shape: 'hollow',
      fill: '0x000000', border: '0xE8D9B0', glow: '0x8C7A4A', text: '0xE8D9B0',
      font: 'pingfang', anim: 'zoom', life: 2.3,
      pos: 0.36, hookPos: 0.20, spacing: 13.0, minGap: 5.0
    },
    cover: {
      tint: '0x0A0A0C', tintAlpha: 0.56, title: '#E8D9B0', stroke: 'black', accent: '#8C7A4A'
    },
    frame: { bars: 0.075, barsColor: 'black', vig: 'PI/4.4', grain: 6 },
    grades: [
      'eq=saturation=0.88:contrast=1.08:gamma_r=0.98:gamma_b=1.03',
      'eq=saturation=0.92:contrast=1.06:brightness=-0.01:gamma_b=1.05',
      'eq=saturation=0.86:contrast=1.10:gamma=0.97'
    ],
    transition: { type: 'black', color: 'black', duration: 0.3 },
    bgm: { volume: 0.3, threshold: 0.05, ratio: 3, attack: 22, release: 440 }
  },
  {
    id: 'neon-cyber',
    name: '霓虹赛博',
    desc: '逐字卡拉OK填充字幕（白字→青）+ 空心霓虹描边花字 + 强暗角 + 顶部青色进度条 + 青紫高饱和 + 白闪',
    accent: '#39E6FF',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#39E6FF',
      fontSize: 22, marginV: 124, outline: 5,
      font: 'PingFang SC', bold: 1, anim: 'karaoke', sizeScale: 1.18
    },
    sticker: {
      shape: 'hollow',
      fill: '0x000000', border: '0x39E6FF', glow: '0xFF3AC8', text: '0xE39BFF',
      font: 'wawa', anim: 'pop', life: 1.8,
      pos: 0.34, hookPos: 0.18, spacing: 7.5, minGap: 3.2
    },
    cover: {
      tint: '0x0A0A1E', tintAlpha: 0.55, title: '#39E6FF', stroke: 'black', accent: '#FF3AC8'
    },
    frame: { vig: 'PI/3.6', grain: 4, bar: { c: '#39E6FF', h: 0.006, pos: 'top' } },
    grades: [
      'eq=saturation=1.30:contrast=1.16:gamma_b=1.08',
      'eq=saturation=1.22:contrast=1.20:gamma_r=0.94:gamma_b=1.12',
      'eq=saturation=1.34:brightness=0.01:contrast=1.12,hue=h=8'
    ],
    transition: { type: 'flash', color: 'white', duration: 0.1 },
    bgm: { volume: 0.5, threshold: 0.06, ratio: 4, attack: 12, release: 340 }
  },
  {
    id: 'knowledge-card',
    name: '干货知识卡',
    desc: '字距收敛大字字幕（白字黄强调）+ 深蓝底黄条贴片 + 底部黄色进度条 + 冷调高对比 + 黑场切',
    accent: '#FFD24A',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#FFD24A',
      fontSize: 19, marginV: 142, outline: 5,
      font: 'PingFang SC', bold: 1, anim: 'expand', sizeScale: 1.1
    },
    sticker: {
      shape: 'underline',
      fill: '0x14213A', border: '0xFFD24A', text: '0xFFFFFF',
      font: 'heiti', anim: 'slide', life: 1.9,
      pos: 0.46, hookPos: 0.24, spacing: 12.0, minGap: 4.5
    },
    cover: {
      tint: '0x101A2E', tintAlpha: 0.50, title: '#FFD24A', stroke: 'black', accent: '#3AA0FF'
    },
    frame: { bar: { c: '#FFD24A', h: 0.006, pos: 'bottom' } },
    grades: [
      'eq=saturation=1.02:contrast=1.09:brightness=-0.005',
      'eq=gamma=1.01:saturation=1.05:contrast=1.10',
      'eq=saturation=1.08:contrast=1.05:gamma_b=1.03'
    ],
    transition: { type: 'black', color: 'black', duration: 0.18 },
    bgm: { volume: 0.35, threshold: 0.05, ratio: 3.2, attack: 20, release: 420 }
  },
  {
    id: 'retro-vhs',
    name: '复古 VHS',
    desc: '窄幅黑边 + 重颗粒 + 暖黄褪色滤镜 + 黄底黑字色带贴片 + 暗角 + 慢黑场转场',
    accent: '#FFC24A',
    subtitle: {
      color: 'yellow', baseHex: '#FFE7B8', emphColor: '#FFC24A',
      fontSize: 20, marginV: 96, outline: 5,
      font: 'Heiti SC', bold: 1, anim: 'pop', sizeScale: 1.1
    },
    sticker: {
      shape: 'band',
      fill: '0xFFC24A', border: '0x3A1E00', text: '0x3A1E00',
      font: 'xingkai', anim: 'zoom', life: 2.0,
      pos: 0.42, hookPos: 0.20, spacing: 8.5, minGap: 3.4
    },
    cover: {
      tint: '0x2A1600', tintAlpha: 0.50, title: '#FFC24A', stroke: 'black', accent: '#FF6B35'
    },
    frame: { bars: 0.05, barsColor: 'black', vig: 'PI/4', grain: 12 },
    grades: [
      'eq=saturation=1.12:contrast=1.10:gamma_r=1.06:gamma_b=0.94',
      'colorbalance=rs=0.06:bs=-0.06:gs=0.02,eq=saturation=1.10:contrast=1.08',
      'eq=saturation=1.18:contrast=1.06:brightness=0.01:gamma_r=1.05'
    ],
    transition: { type: 'black', color: 'black', duration: 0.26 },
    bgm: { volume: 0.4, threshold: 0.055, ratio: 3.5, attack: 18, release: 400 }
  },
  {
    id: 'punch-sale',
    name: '爆点冲刺',
    desc: '超大强弹入字幕（白字红强调）+ 红底白边爆闪贴片 + 顶部红色进度条 + 高饱和高对比 + 短白闪',
    accent: '#FF3B30',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#FF3B30',
      fontSize: 24, marginV: 100, outline: 6,
      font: 'Heiti SC', bold: 1, anim: 'popBig', sizeScale: 1.24
    },
    sticker: {
      shape: 'band',
      fill: '0xFF3B30', border: '0xFFFFFF', glow: '0xFFE33A', text: '0xFFFFFF',
      font: 'wawa', anim: 'pop', life: 1.6,
      pos: 0.40, hookPos: 0.16, spacing: 5.4, minGap: 2.6
    },
    cover: {
      tint: '0x180000', tintAlpha: 0.48, title: '#FFFFFF', stroke: 'black', accent: '#FF3B30'
    },
    frame: { bar: { c: '#FF3B30', h: 0.008, pos: 'top' } },
    grades: [
      'eq=saturation=1.28:contrast=1.18',
      'eq=saturation=1.20:contrast=1.22:gamma=0.98',
      'eq=saturation=1.32:brightness=0.015:contrast=1.14'
    ],
    transition: { type: 'flash', color: 'white', duration: 0.12 },
    bgm: { volume: 0.52, threshold: 0.065, ratio: 4, attack: 10, release: 320 }
  },
  {
    id: 'fresh-vlog',
    name: '元气 Vlog',
    desc: '明亮通透暖调 + 橙底白字+橙色下划线贴片 + 白字橙强调弹入字幕 + 底部细进度条 + 无转场',
    accent: '#FF9F1C',
    subtitle: {
      color: 'white', baseHex: '#FFFFFF', emphColor: '#FF9F1C',
      fontSize: 18, marginV: 78, outline: 3,
      font: 'PingFang SC', bold: 1, anim: 'pop', sizeScale: 1.05
    },
    sticker: {
      shape: 'underline',
      fill: '0xFFF3E0', border: '0xFF9F1C', text: '0xFF6B00',
      font: 'pingfang', anim: 'pop', life: 1.7,
      pos: 0.44, hookPos: 0.22, spacing: 11.0, minGap: 4.2
    },
    cover: {
      tint: '0x1B1206', tintAlpha: 0.40, title: '#FF9F1C', stroke: 'black', accent: '#FFD166'
    },
    frame: { bar: { c: '#FFD166', h: 0.005, pos: 'bottom' } },
    grades: [
      'eq=saturation=1.12:brightness=0.03:contrast=1.02',
      'eq=brightness=0.035:saturation=1.16:contrast=1.03:gamma=1.02',
      'eq=saturation=1.10:brightness=0.02:contrast=1.05'
    ],
    transition: { type: 'none', duration: 0.1 },
    bgm: { volume: 0.44, threshold: 0.055, ratio: 3.6, attack: 16, release: 380 }
  }
];

const DEFAULT_STYLE_ID = 'vital-sale';

/* cover/frame 的兜底配色（老模版或自定义模版缺字段时保证渲染完整） */
const DEFAULT_COVER = {
  tint: '0x101018', tintAlpha: 0.44, title: '#FFE33A', stroke: 'black', accent: '#FFE33A'
};
const DEFAULT_FRAME = {
  bars: 0, barsColor: 'black', vig: '', grain: 0, bar: null
};

function styleById(id) {
  return STYLE_TEMPLATES.find((x) => x.id === id) || null;
}

/** 取模版（未知 id 一律回退到默认「活力带货」），保证渲染字段永远完整 */
function resolveStyle(id) {
  const t = styleById(id) || STYLE_TEMPLATES[0];
  return {
    ...t,
    cover: { ...DEFAULT_COVER, ...(t.cover || {}) },
    frame: { ...DEFAULT_FRAME, ...(t.frame || {}) }
  };
}

/** 给渲染层/前端的精简清单（不含滤波表达式，只给 UI 预览所需的元信息） */
function styleList() {
  return STYLE_TEMPLATES.map((t) => ({
    id: t.id, name: t.name, desc: t.desc, accent: t.accent,
    subtitle: t.subtitle, bgmVolume: t.bgm.volume
  }));
}

module.exports = { STYLE_TEMPLATES, DEFAULT_STYLE_ID, resolveStyle, styleById, styleList };
