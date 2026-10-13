'use strict';

/* ============================================================
   爆款短视频风格模版（对标美图「开拍」的成套深度风格）。
   一套模版 = 逐句大字双色字幕（ASS 弹入动效）+ 剪辑风格（滤镜/转场）
             + 贴片风格 + BGM 闪避参数。
   clipai.js 渲染时读取本表，把每一项落到 ffmpeg 滤镜链上。
   subtitle 字段说明：
     baseHex/emphColor 字幕底色/强调色（价格、数字、CTA 词自动换强调色）
     font   libass 字体名（macOS 内置：PingFang SC / Heiti SC / STKaiti）
     anim   逐句入场动效：pop 弹入 / popBig 强弹入 / fade 淡入 / fadeSlow 慢淡
     sizeScale 字幕放大倍率（相对表单字号，开拍式大字 ≈1.1-1.2）
   ============================================================ */

/* 贴片形状：burst=外发光粗描边（最抓眼）；band=实心色带；box=浅底彩字 */
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
    grades: [
      'eq=saturation=1.04:contrast=1.04:brightness=0.015',
      'eq=gamma_r=1.06:gamma_b=0.95:saturation=1.02',
      'eq=gamma=1.02:saturation=0.98:contrast=1.03'
    ],
    transition: { type: 'black', color: 'black', duration: 0.22 },
    bgm: { volume: 0.4, threshold: 0.055, ratio: 3.5, attack: 18, release: 400 }
  }
];

const DEFAULT_STYLE_ID = 'vital-sale';

function styleById(id) {
  return STYLE_TEMPLATES.find((x) => x.id === id) || null;
}

/** 取模版（未知 id 一律回退到默认「活力带货」），保证渲染字段永远完整 */
function resolveStyle(id) {
  return styleById(id) || STYLE_TEMPLATES[0];
}

/** 给渲染层/前端的精简清单（不含滤波表达式，只给 UI 预览所需的元信息） */
function styleList() {
  return STYLE_TEMPLATES.map((t) => ({
    id: t.id, name: t.name, desc: t.desc, accent: t.accent,
    subtitle: t.subtitle, bgmVolume: t.bgm.volume
  }));
}

module.exports = { STYLE_TEMPLATES, DEFAULT_STYLE_ID, resolveStyle, styleById, styleList };
