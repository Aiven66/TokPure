'use strict';

/* ============================================================
   Windows 系统音色（SAPI / System.Speech）纯逻辑

   3.9.27：Windows 端的配音一直只暴露「系统默认音色」一项，
   macOS 上的自然音色列表、逐语言挑选、试听在 Windows 上全部缺失。
   本模块只做纯字符串处理（不 import electron / child_process），
   枚举与合成仍放在 localize.js，这样单元测试可以直接跑。
   ============================================================ */

/* PowerShell 的枚举输出：Name|Culture|Gender，每行一个 */
const LINE_RE = /^(.+?)\|([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\|([A-Za-z]+)$/;

function parseSapiVoices(text) {
  const rows = [];
  String(text || '').split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(LINE_RE);
    if (!m) return;
    const name = m[1].trim();
    if (!name) return;
    const culture = m[2].replace('_', '-');
    const gender = /^female$/i.test(m[3]) ? 'f' : /^male$/i.test(m[3]) ? 'm' : '';
    rows.push({ name, culture, gender, base: name });
  });
  return rows;
}

/** 'zh-CN' → 'zh'；'en-GB' → 'en' */
function cultureLang(culture) {
  return String(culture || '').split(/[-_]/)[0].toLowerCase();
}

/** 同一语言下按「性别匹配 → 系统默认顺序」挑一个音色，返回音色名或 null */
function chooseVoice(rows, langId, explicit, gender) {
  const rowsSafe = Array.isArray(rows) ? rows : [];
  if (explicit) {
    const hit = rowsSafe.find((r) => r.name === explicit);
    if (hit) return hit.name;
  }
  const same = rowsSafe.filter((r) => cultureLang(r.culture) === langId);
  if (!same.length) return null;
  if (gender) {
    const byGender = same.find((r) => r.gender === gender);
    if (byGender) return byGender.name;
  }
  // Windows 桌面版英文通常有 Zira(F) 与 David(M)；中文系统一般只有 Huihui。
  // 无性别要求时优先女声（与 macOS 侧默认女声的听感保持一致）。
  return (same.find((r) => r.gender === 'f') || same[0]).name;
}

/** 把 SAPI 行转成统一的音色条目（字段与 macOS 侧对齐，渲染层无需分支） */
function voiceEntry(row) {
  const gender = row.gender;
  return {
    name: row.name,
    base: row.base,
    locale: row.culture.replace('-', '_'),
    gender,
    style: gender === 'f' ? '系统女声' : gender === 'm' ? '系统男声' : '系统音色',
    tier: 0,
    label: `${row.base} · ${gender === 'f' ? '系统女声' : gender === 'm' ? '系统男声' : '系统音色'}`
  };
}

/** 未装任何该语言音色时的兜底条目（值仍是空，等价于系统默认） */
const DEFAULT_ENTRY = { name: null, base: '', gender: '', style: '', tier: 0, label: '系统默认音色' };

module.exports = { parseSapiVoices, cultureLang, chooseVoice, voiceEntry, DEFAULT_ENTRY };
