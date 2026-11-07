'use strict';

/* ============================================================
   TokPure — 克隆配音降噪（3.9.25）
   ------------------------------------------------------------
   背景：本地克隆引擎（Chatterbox）在词与词之间、句尾会输出低频闷响 + 一段
   宽带噪声尾。实测（44.1kHz 单声道）：语音 -13~-19dBFS，词间气口 -33~-46dBFS，
   句尾噪声尾 -33~-39dBFS 且长达 0.5~3.6s；频谱能量集中在 100~300Hz。

   三个版本的教训（都是同一个病根：**把噪声当人声放过去了**）：
   - 3.9.21/3.9.23：靠 agate 门限切，但气口噪声电平（-33dB）比轻声说话还响，
     电平上根本分不开，于是短气口全部漏进成片 → 用户听到「非常明显的噪音」。
   - 3.9.24：改用「电平 + 自相关周期性 + 高频占比」三判据，把判成噪声的帧整段
     拉到数字静音。实测这条素材里 163 个 <250ms 的气口被切成空洞 → 用户听到
     「说话断断续续、不连贯」；而真正的低频闷响因为自带 100~130Hz 谐波峰，
     周期性 per 高达 0.4~0.6，反而被判成「像人声」保留下来 → 噪音仍在。
   - 3.9.25 第一版：谱减的噪声底仍然只取「三判据命中帧」，命中帧少且偏轻，
     逐句增益之后只压掉 1.6dB，等于没压。

   3.9.25 最终做法：**安静帧统计噪声底 + 逐频点维纳谱减 + 整帧电平斜坡 + 句尾裁剪**。
   （3.9.37 起「维纳谱减」是真正的决策引导维纳增益，见下方 DD_ALPHA 的说明；
     谱减的金属嘶声、以及整帧电平斜坡起点过低导致的吞字，都已修掉。）
   1) 噪声底不再靠「是不是噪声」的猜测，而是**测**出来：本句电平低于
      「语音电平（95% 分位）-12dB」的帧就是气口/噪声帧，取这些帧逐频点功率的
      **75% 分位**当噪声功率谱 N(f)。谐波不谐波都一样被测进来（上一版漏掉的就是它）；
      取 75% 分位而不是中位数，是因为同一句里气口电平会跳 ±10dB，中位数压不住最响的那几段
      （实测只能降 2~5dB，成片里就是「嗡嗡的底噪还在」）。
   2) 逐频点增益 G(f) = max(1 - 2.5 * N(f) / P(f), -40dB)，再做 3 点频域平滑
      （压掉「音乐噪声」的孤立频点）与「快开快关」的时域平滑（保护语音起音）。
   3) 再叠一层**整帧电平斜坡**：气口里的嘶声是突发的，实测该频点功率比噪声分位高 14~22dB，
      逐频点谱减对它无效；但只要这一帧的电平比本句语音低 8dB 以上就不可能是人声，
      于是 8→18dB 映射到 0→-48dB 整帧衰减。齿音帧（3k~10k 占绝对优势）最多压 18dB，
      避免把 /s/ /ʃ/ 当成噪声吃掉（那是「说话模糊不清」的另一个来源）。
      实测：语音帧电平变化 p50 -0.4dB / p5 -0.9dB，三个语音频带差 ≤1.1dB；
      100~200ms 气口从 -33~-37dBFS 压到 -46~-53dBFS，长气口到 -60~-94dBFS。
   4) 只有「比语音低 15dB 以上、且连续 ≥350ms」的深静音段才拉数字静音
      （这种长度只可能是句尾/长停顿，里面没有人声），进出都走 11.6ms 斜坡。
      100~200ms 的气口一律不切（3.9.24 就是把它们切成了空洞，成片 163 个静音洞）。
   5) **句尾裁剪**：最后一个有声帧 + 0.15s 之后的噪声尾整段切掉并返回。
      这一步同样重要：噪声尾让 TTS 原始时长虚长 1.5~3 倍，上层按这个时长算
      atempo（顶到 1.25 上限）和 afade/atrim 截断，真语音被压快、切掉 ——
      这是用户听到「说话模糊、不连贯」的另一半原因（3.9.24 成片 17 句被压缩/截断）。

   纯 JS 自实现 FFT/IFFT，不引第三方 DSP，不使用 anlmdn。
   ============================================================ */

const FRAME = 1024;            // 23.2ms @44.1kHz
const HOP = 512;               // 11.6ms 帧移，同时也是斜坡长度
const NFFT = 2048;             // 频点 1024 个（21.5Hz/bin）
const REL_DB = 12;             // 噪声帧电平必须低于本句语音电平 12dB
const NOISE_FLOOR_Q = 0.15;    // 噪底取帧电平的 15% 分位（真正的气口/静音）
const NOISE_GUARD_DB = 8;      // 噪声候选帧不得高于噪底 8dB（防止把轻声字当噪声）
const QUIET_CAP_DB = -22;      // 绝对电平上限（比这更响的帧绝不当噪声统计）
const NOISE_Q = 0.75;          // 噪声谱取候选帧的 75% 分位（贴住最响气口）
/* 3.9.37：谱减（1 - 2.5·N/P）换成「决策引导维纳」增益。
   谱减在低信噪比频点上会把增益推到地板，相邻帧的留存频点随机跳变，
   听感就是「呲呲呲」的金属嘶声（musical noise）；实测同一句克隆音，
   4.8~11k 的逐帧能量抖动（标准差）从 15.6dB 被抬到 19.3dB —— 噪声是降噪器自己造出来的。
   维纳增益只跟「先验信噪比」走，再加决策引导（用上一帧的增益与后验 SNR 平滑），
   增益曲线连续、没有随机尖峰；地板从 -40dB 抬到 -24dB，不再把频点挖成空洞。 */
const DD_ALPHA = 0.90;         // 决策引导平滑：上一帧估计占 90%（≈145ms 时间常数）
const GAIN_FLOOR_DB = -24;     // 每个频点的最低增益
const GAIN_RELEASE = 0.6;      // 增益回落：每帧保留 60%（约 4 帧 / 46ms 落到位）
/* 整帧电平斜坡的起点从 8dB 抬到 14dB、压到底从 18dB 抬到 26dB：
   正常说话的句内动态就有 12~18dB（轻声字、词尾、虚词天然低一截），
   8dB 起压等于把「轻声的字」按噪声一起吃掉——实测 474 帧里有 97 帧落在 8~18dB
   的斜坡里，中位帧被压掉约 9dB，听感就是「吞字、不清晰」。
   气口/噪声帧实测都在语音电平 25dB 以下（本句 166 帧 >18dB），抬高起点不会漏噪。 */
const GATE_START_DB = 14;      // 整帧电平低于语音 14dB 起开始按斜坡压
const GATE_FULL_DB = 26;       // 低到 26dB 时压到底
const GATE_DB = 48;            // 整帧最大衰减
const SIB_DB = 12;             // 3k~10k/100~1500 ≥ +12dB 视为齿音
const SIB_FLOOR_DB = 18;       // 齿音帧最多压 18dB（保住 /s/ /ʃ/ 的可懂度）
const DEEP_DB = 15;            // 深静音：低于语音电平 15dB
const DEEP_RUN_SEC = 0.35;     // ≥350ms 的深静音段才拉数字静音
const TAIL_PAD = 0.15;         // 句尾保留 0.15s 余量再裁掉
const MIN_NOISE_FRAMES = 6;    // 噪声帧太少时不做谱减（宁可不降噪，也不要误伤语音）
const TRIM_FADE_SEC = 0.012;   // 裁剪点的收尾淡出，避免极陡包络台阶

/** 迭代基-2 FFT（原地） */
function makeFft(n) {
  const levels = Math.round(Math.log2(n));
  if ((1 << levels) !== n) throw new Error('FFT 尺寸必须是 2 的幂');
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    let x = i;
    let r = 0;
    for (let j = 0; j < levels; j += 1) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  return { n, cos, sin, rev };
}

function fftRun(f, re, im) {
  const { n, cos, sin, rev } = f;
  for (let i = 0; i < n; i += 1) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j += 1, k += step) {
        const c = cos[k];
        const s = sin[k];
        const a = i + j;
        const b = a + half;
        const xr = re[b];
        const xi = im[b];
        const tr = xr * c + xi * s;
        const ti = xi * c - xr * s;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** 逆变换：ifft(X) = conj(FFT(conj(X))) / n */
function ifftRun(f, re, im) {
  const n = f.n;
  for (let i = 0; i < n; i += 1) im[i] = -im[i];
  fftRun(f, re, im);
  for (let i = 0; i < n; i += 1) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

/** 取分位值（输入必须是升序） */
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

/**
 * 整帧衰减：一帧的电平比本句语音电平低得越多，越不可能是人声。
 * 8dB 以内不动（正常说话的强弱起伏），8→18dB 线性压到 -48dB，18dB 以下就是噪声。
 * 齿音帧（3k~10k 占绝对优势）最多压 18dB —— /s/ /ʃ/ /f/ 的能量天生集中在高频，
 * 电平也比元音低一截，按电平一刀切会把词尾吃掉，听感就是「说话模糊不清」。
 */
function frameGate(over, hiRel, opts = {}) {
  const start = opts.gateStartDb != null ? opts.gateStartDb : GATE_START_DB;
  const full = opts.gateFullDb != null ? opts.gateFullDb : GATE_FULL_DB;
  const maxDb = opts.gateDb != null ? opts.gateDb : GATE_DB;
  if (!(over > start)) return 1;
  const t = Math.min(1, (over - start) / Math.max(0.1, full - start));
  let g = Math.pow(10, (-maxDb * t) / 20);
  if (hiRel >= (opts.sibDb != null ? opts.sibDb : SIB_DB)) {
    const lim = Math.pow(10, -(opts.sibFloorDb != null ? opts.sibFloorDb : SIB_FLOOR_DB) / 20);
    if (g < lim) g = lim;
  }
  return g;
}

/**
 * 逐句分析：帧电平、噪声功率谱、句尾切点、深静音段。
 * 只对「电平低于噪声门限」的帧做 FFT，开销约为总帧数的 20~60%。
 */
function analyzeFrames(pcm, rate, opts = {}) {
  const n = pcm.length;
  const relDb = opts.relDb != null ? opts.relDb : REL_DB;
  const capDb = opts.quietCapDb != null ? opts.quietCapDb : QUIET_CAP_DB;
  const deepDb = opts.deepDb != null ? opts.deepDb : DEEP_DB;
  const deepRun = Math.max(1, Math.round(((opts.deepRunSec != null ? opts.deepRunSec : DEEP_RUN_SEC) * rate) / HOP));
  const frames = n < FRAME ? 0 : Math.floor((n - FRAME) / HOP) + 1;
  const empty = {
    frames: 0, lv: new Float64Array(0), hiRel: new Float64Array(0), spans: [], noisePsd: null,
    tailFrom: n, speechRef: 0, noiseFrames: 0, thr: 0, bins: 0
  };
  if (frames < 4) return empty;

  // 第一遍：只算帧电平（便宜）。语音电平取 95% 分位：一句里通常七成以上帧是语音，
  // 气口只占两三成；85% 分位会落在轻声段，门限跟着偏低，气口就漏过去了。
  // 同时算一条「一阶差分」的帧能量：它等价于 +6dB/oct 高通，
  // 100~300Hz 的句尾闷响被压掉十几 dB，而人声的 500Hz~4kHz 基本不损。
  const lv = new Float64Array(frames);
  const hp = new Float64Array(frames);
  for (let k = 0; k < frames; k += 1) {
    const s = k * HOP;
    let e = 0;
    let h = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const v = pcm[s + i];
      e += v * v;
      const d = v - (s + i > 0 ? pcm[s + i - 1] : 0);
      h += d * d;
    }
    lv[k] = 10 * Math.log10(e / FRAME + 1e-30);
    hp[k] = 10 * Math.log10(h / FRAME + 1e-30);
  }
  const sortedLv = Array.prototype.slice.call(lv).sort((a, b) => a - b);
  const speechRef = quantile(sortedLv, 0.95);
  /* 3.9.37：噪声帧的门限再压一道「噪底闸」。
     旧版只要求「低于语音 12dB」，而克隆引擎的气口实测在 -66dBFS、语音 -18dBFS，
     于是 speech-12dB 这条线落在 -30dB，把大量「轻声的字」也当成噪声统计进 N(f)。
     实测后果：N(f) 几乎等于轻声字的功率谱，维纳增益在语音段也只剩 -3.6dB
     （4.8~11k 高频尤其明显），声音被削薄、发闷 —— 这正是「不够清晰」的来源之一。
     现在再取帧电平的 15% 分位当噪底，候选帧必须落在噪底 +8dB 以内：
     真正的气口/静音才参与噪声谱统计，轻声字不再被误判。 */
  const noiseFloor = quantile(sortedLv, opts.noiseFloorQ != null ? opts.noiseFloorQ : NOISE_FLOOR_Q);
  const noiseGuard = opts.noiseGuardDb != null ? opts.noiseGuardDb : NOISE_GUARD_DB;
  const thr = Math.min(speechRef - relDb, capDb, noiseFloor + noiseGuard);
  const sortedHp = Array.prototype.slice.call(hp).sort((a, b) => a - b);
  const hpRef = quantile(sortedHp, 0.95);

  // 第二遍：只分析低于门限的帧（这些就是气口/噪声帧），逐频点功率存成紧凑数组
  const bins = NFFT / 2 + 1;
  const f = makeFft(NFFT);
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const cand = [];
  for (let k = 0; k < frames; k += 1) if (lv[k] < thr) cand.push(k);
  // 齿音保护：候选帧里 3k~10k 相对 100~1500 的能量占比。
  // 气口噪声的嘶声是宽带的、且只在部分频点冒尖；真正的 /s/ /ʃ/ 整段高频都强。
  // 判据「高频占比 ≥ +12dB」即认为是齿音，不做整帧重压。
  const hiRel = new Float64Array(frames);
  let noisePsd = null;
  if (cand.length >= Math.max(MIN_NOISE_FRAMES, opts.minNoiseFrames || MIN_NOISE_FRAMES)) {
    const power = new Float64Array(cand.length * bins);
    const binHz = rate / NFFT;
    const lo0 = Math.max(1, Math.floor(100 / binHz));
    const lo1 = Math.floor(1500 / binHz);
    const hi0 = Math.max(lo0 + 1, Math.floor(3000 / binHz));
    const hi1 = Math.min(bins - 1, Math.ceil(10000 / binHz));
    for (let c = 0; c < cand.length; c += 1) {
      const s = cand[c] * HOP;
      for (let i = 0; i < NFFT; i += 1) {
        re[i] = i < FRAME ? pcm[s + i] * win[i] : 0;
        im[i] = 0;
      }
      fftRun(f, re, im);
      const base = c * bins;
      let loSum = 0;
      let hiSum = 0;
      for (let b = 0; b < bins; b += 1) {
        const p = re[b] * re[b] + im[b] * im[b];
        power[base + b] = p;
        if (b >= lo0 && b <= lo1) loSum += p;
        else if (b >= hi0 && b <= hi1) hiSum += p;
      }
      hiRel[cand[c]] = loSum > 1e-20 ? 10 * Math.log10(hiSum / loSum + 1e-20) : -99;
    }
    // 逐频点分位值（默认 75%）：中位数只代表「典型气口」，而实测同一句里气口的
    // 电平会在 ±10dB 内跳，取中位数会让最响的那几段气口 P≫N、增益压不下来
    // （实测只降 2~5dB）。取 75% 分位正好落在最响气口附近：最响的、更轻的都落到
    // 增益地板。单帧的尖峰（爆音、齿音残留）不会污染噪声底，因为用的是分位而不是最大值。
    const noiseQ = opts.noiseQ != null ? opts.noiseQ : NOISE_Q;
    noisePsd = new Float64Array(bins);
    const vals = new Float64Array(cand.length);
    for (let b = 0; b < bins; b += 1) {
      for (let c = 0; c < cand.length; c += 1) vals[c] = power[c * bins + b];
      vals.sort();
      noisePsd[b] = quantile(vals, noiseQ);
    }
  }

  // 句尾切点：最后一个「还有明确人声」的帧之后 0.15s。
  // 3.9.30 之前只看电平（本句语音 -14dB 以内），判决被句尾噪声尾里的「低频闷响」
  // 一路推到最后：同一条 14 字句子合成出 5.68s，其中后 3.2s 是 -30~-55dBFS 的
  // 100~300Hz 液压声，电平只比语音低十几 dB，听感就是「嗡嗡的噪音」。
  // 现在再加一条高通能量判据：噪声尾几乎没有 500Hz 以上的能量，
  // 人声（包括轻声收尾）高频占比正常，两者一测就能分开（实测切点 5.68s → 2.35s）。
  // 两条都取 5 帧中值平滑，避免一个爆音把切点拖到最后。
  const smooth = new Float64Array(frames);
  const smoothHp = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const vals = [];
    const valsHp = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(frames - 1, i + 2); j += 1) {
      vals.push(lv[j]);
      valsHp.push(hp[j]);
    }
    vals.sort((a, b) => a - b);
    valsHp.sort((a, b) => a - b);
    smooth[i] = vals[Math.floor(vals.length / 2)];
    smoothHp[i] = valsHp[Math.floor(valsHp.length / 2)];
  }
  let endFrame = -1;
  for (let i = frames - 1; i >= 0; i -= 1) {
    if (smooth[i] >= speechRef - 17 && smoothHp[i] >= hpRef - 24) { endFrame = i; break; }
  }
  const tailFrom = endFrame < 0
    ? n
    : Math.min(n, endFrame * HOP + FRAME + Math.round(TAIL_PAD * rate));

  // 深静音段：只有「比语音低 15dB 以上、连续 ≥350ms」才拉数字静音。
  // 3.9.24 的教训是 100~200ms 的气口也被切，一句话被打成碎片；这里门槛放在
  // 350ms 且要求深电平，剩下的气口交给谱减（压到 -76dBFS，听不见但不留洞）。
  const spans = [];
  const deepThr = speechRef - deepDb;
  let k = 0;
  while (k < frames) {
    if (lv[k] < deepThr) {
      let j = k;
      while (j < frames && lv[j] < deepThr) j += 1;
      if (j - k >= deepRun) {
        const c0 = Math.max(0, k * HOP + FRAME / 2 - HOP);
        const c1 = Math.min(n, (j - 1) * HOP + FRAME / 2 + HOP);
        spans.push([c0, c1]);
      }
      k = j;
    } else {
      k += 1;
    }
  }
  if (tailFrom < n) {
    const last = spans.length ? spans[spans.length - 1] : null;
    if (last && tailFrom <= last[1] + HOP) last[1] = n;
    else spans.push([tailFrom, n]);
  }
  return { frames, lv, hiRel, spans, noisePsd, tailFrom, speechRef, noiseFrames: cand.length, thr, bins };
}

/**
 * 谱减 + 句尾裁剪。返回 {pcm, spans, mutedSec, tailSec, trimmedSec, ...}
 * @param {Float32Array} pcm 单声道 -1~1
 * @param {number} rate 采样率
 */
function suppressNoise(pcm, rate, opts = {}) {
  const n = pcm.length;
  const a = analyzeFrames(pcm, rate, opts);
  const { frames, spans, tailFrom, speechRef, noiseFrames, noisePsd, lv, hiRel } = a;
  if (!frames) {
    return { pcm: new Float32Array(pcm), spans: 0, mutedSec: 0, tailSec: 0, trimmedSec: 0, speechRef: 0, noiseFrames: 0, frames: 0 };
  }
  const f = makeFft(NFFT);
  const bins = NFFT / 2 + 1;
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const floorLin = Math.pow(10, (opts.gainFloorDb != null ? opts.gainFloorDb : GAIN_FLOOR_DB) / 20);

  // 重叠相加（前置一帧的余量，保证首帧也有完整重叠）。
  // sqrt-hann 分析窗 + sqrt-hann 合成窗，50% 重叠，sum(w^2)=1 严格单位增益重建
  // （自检：gains 全 1 时输出与输入逐采样差 3e-17）。
  const pad = FRAME;
  const total = pad + n + FRAME;
  const acc = new Float64Array(total);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const gain = new Float64Array(bins);
  const gainS = new Float64Array(bins);
  const prev = new Float64Array(bins).fill(1);
  const prevGamma = new Float64Array(bins).fill(1);
  // 噪声功率谱直接用 analyzeFrames 的分位统计结果，不随帧自适应：
  // 向下自适应会跟着「最轻的那段气口」跑，反而把更响的几段气口漏掉（实测只压 2~5dB）。
  const noise = noisePsd ? Float64Array.from(noisePsd) : null;
  const lastStart = Math.max(0, total - FRAME);
  for (let s = 0; s - pad < n; s += HOP) {
    if (s > lastStart) break;
    const k = (s - pad) / HOP;
    const ki = k < 0 ? 0 : (k >= frames ? frames - 1 : k);
    for (let i = 0; i < NFFT; i += 1) {
      const p = s + i - pad;
      re[i] = (i < FRAME && p >= 0 && p < n) ? pcm[p] * win[i] : 0;
      im[i] = 0;
    }
    fftRun(f, re, im);
    if (noise) {
      const over = speechRef - lv[ki];
      // 逐频点「决策引导维纳」增益：
      //   gamma = P/N（后验 SNR）
      //   xi    = alpha·(G_prev²·gamma_prev) + (1-alpha)·max(gamma-1, 0)（先验 SNR）
      //   G     = xi / (1 + xi)
      // 与谱减相比少了 1 - k·N/P 这一项，增益不会因为 N/P 的细微波动在
      // 「全通」与「地板」之间来回跳，这正是「呲呲呲」金属嘶声的来源。
      for (let b = 0; b < bins; b += 1) {
        const p = re[b] * re[b] + im[b] * im[b];
        const gamma = p / (noise[b] + 1e-20);
        const prior = DD_ALPHA * (prev[b] * prev[b] * prevGamma[b])
          + (1 - DD_ALPHA) * Math.max(gamma - 1, 0);
        let g = prior / (1 + prior);
        if (g < floorLin) g = floorLin;
        gain[b] = g;
        prevGamma[b] = gamma;
      }
      // 5 点频域平滑（[0.15 0.2 0.3 0.2 0.15]）：维纳增益本身已连续，
      // 这里只抹掉单个频点的残余抖动；只平滑 3 点时高频窄带仍会留下颗粒感。
      for (let b = 0; b < bins; b += 1) {
        const l2 = gain[b > 1 ? b - 2 : 0];
        const l1 = gain[b > 0 ? b - 1 : 0];
        const r1 = gain[b < bins - 1 ? b + 1 : bins - 1];
        const r2 = gain[b < bins - 2 ? b + 2 : bins - 1];
        gainS[b] = 0.15 * l2 + 0.2 * l1 + 0.3 * gain[b] + 0.2 * r1 + 0.15 * r2;
      }
      // 时域：增益变大立刻跟（保住语音起音），变小按 GAIN_RELEASE 平滑回落。
      // 另外叠一层「整帧电平」衰减：气口里的嘶声是突发的，逐频点增益对它无效；
      // 只要这一帧的电平明显低于本句语音电平，这个帧里就不可能是人声。
      const rel = opts.release != null ? opts.release : GAIN_RELEASE;
      const gate = frameGate(over, hiRel[ki], opts);
      for (let b = 0; b < bins; b += 1) {
        const g = gainS[b];
        const gm = g < gate ? g : gate;
        const p = prev[b];
        prev[b] = gm > p ? gm : rel * p + (1 - rel) * gm;
      }
      for (let b = 0; b < bins; b += 1) {
        const g = prev[b];
        re[b] *= g;
        im[b] *= g;
        if (b > 0 && b < bins - 1) {
          // 补回负频率（实信号要求共轭对称）
          const mirror = NFFT - b;
          if (mirror > bins - 1) {
            re[mirror] = re[b];
            im[mirror] = -im[b];
          }
        }
      }
    }
    ifftRun(f, re, im);
    for (let i = 0; i < FRAME; i += 1) {
      const p = s + i;
      if (p < total) acc[p] += re[i] * win[i];
    }
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = acc[pad + i];

  // 深静音段：数字静音，hop 之间线性插值 → 11.6ms 斜坡
  let mutedSec = 0;
  if (spans.length) {
    const hops = Math.ceil(n / HOP) + 2;
    const g = new Float32Array(hops).fill(1);
    spans.forEach(([x, y]) => {
      const i0 = Math.floor(x / HOP);
      const i1 = Math.min(hops - 1, Math.ceil(y / HOP));
      for (let i = i0; i <= i1; i += 1) g[i] = 0;
    });
    for (let i = 0; i < n; i += 1) {
      const q = i / HOP;
      const k0 = Math.floor(q);
      const r = q - k0;
      const gg = g[k0] * (1 - r) + g[Math.min(hops - 1, k0 + 1)] * r;
      if (gg !== 1) out[i] *= gg;
    }
  }
  const trimEnd = Math.min(n, tailFrom);
  // 句内深静音段的静音时长（句尾那段已经整段裁掉，不计入）
  spans.forEach(([x, y]) => { mutedSec += Math.max(0, Math.min(y, trimEnd) - x) / rate; });

  // 句尾裁剪：噪声尾整段切掉，上层按裁剪后的时长算变速/截断。
  // 剪切点本身只有 -36~-50dBFS，但陡台阶会有「咔」，用 12ms 余弦淡出收口。
  let result = out;
  if (trimEnd < n) {
    result = new Float32Array(trimEnd);
    result.set(out.subarray(0, trimEnd));
    const fl = Math.min(trimEnd, Math.round(TRIM_FADE_SEC * rate));
    for (let i = 0; i < fl; i += 1) {
      const t = 0.5 - 0.5 * Math.cos((Math.PI * i) / Math.max(1, fl - 1));
      result[trimEnd - fl + i] *= t;
    }
  }
  return {
    pcm: result,
    spans: spans.length,
    mutedSec,
    tailSec: Math.max(0, (n - trimEnd) / rate),
    trimmedSec: Math.max(0, (n - trimEnd) / rate),
    speechRef,
    noiseFrames,
    frames
  };
}

/** 写 16bit 单声道 WAV（克隆音只有这一种落盘格式） */
function writeWavS16(file, pcm, rate) {
  const fs = require('fs');
  const n = pcm.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const v = pcm[i];
    const s = v > 1 ? 32767 : v < -1 ? -32768 : Math.round(v * 32767);
    buf.writeInt16LE(s, 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return file;
}

/* ---------------- 句内响度拉平（3.9.31） ----------------
   克隆引擎同一句里会「前几个字很响、后半句突然轻」，或者整句慢慢往下掉。
   逐句做一次固定增益只能把「整句的平均水位」对齐，句内的慢漂移原样留在成片里，
   听感就是「一个字一个字音量不一样」。这里按 20ms 帧量电平，用 **450ms 长窗**
   求慢包络：窗长比一个音节（150~250ms）长得多，所以音节重音、句尾降调都保留，
   只把「几百毫秒级的整段偏轻/偏响」拉回去。
   - 只在有语音的帧上动手（低于语音分位 -34dB 的帧一律不动，气口/噪声不会被抬起来）
   - 增益夹在 ±9dB，且做了 100ms 平滑，不会有抽吸感
   ============================================================ */

function medianFilter(src, win) {
  const n = src.length;
  const half = Math.floor(win / 2);
  const out = new Float64Array(n);
  const buf = [];
  for (let i = 0; i < n; i += 1) {
    buf.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j += 1) buf.push(src[j]);
    buf.sort((a, b) => a - b);
    out[i] = buf[Math.floor(buf.length / 2)];
  }
  return out;
}

function movingAvg(src, win) {
  const n = src.length;
  const half = Math.max(0, Math.floor(win / 2));
  const out = new Float64Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) pre[i + 1] = pre[i] + src[i];
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

const AGC_MAX_DB = 9;
const AGC_SMOOTH_SEC = 0.45;
/* 增益平滑从 0.1s 放慢到 0.28s：0.1s 时增益追着每个音节跑，句内的重音与词尾被来回
   加减，听感就是「同一句里声音忽大忽小」。放慢之后只修整句/半句级别的电平漂移，
   音节内部的强弱关系原样保留（那才是自然的语气）。 */
const AGC_GAIN_SEC = 0.28;

function flattenLevel(pcm, rate, opts = {}) {
  const sr = Number(rate) > 0 ? Number(rate) : 44100;
  const n = pcm.length;
  const fl = Math.round(0.02 * sr);
  const hop = Math.round(0.01 * sr);
  if (n < fl * 20) return pcm;
  const frames = Math.floor((n - fl) / hop) + 1;
  const lv = new Float64Array(frames);
  for (let k = 0; k < frames; k += 1) {
    const s = k * hop;
    let e = 0;
    for (let i = 0; i < fl; i += 1) {
      const v = pcm[s + i];
      e += v * v;
    }
    lv[k] = 10 * Math.log10(e / fl + 1e-30);
  }
  const sorted = Array.prototype.slice.call(lv).sort((a, b) => a - b);
  const speech = quantile(sorted, 0.9);
  if (!(speech > -70)) return pcm;
  const maxDb = opts.maxDb != null ? opts.maxDb : AGC_MAX_DB;
  const env = movingAvg(medianFilter(lv, 7), Math.max(3, Math.round(AGC_SMOOTH_SEC / 0.01)));
  const gains = new Float64Array(frames);
  for (let k = 0; k < frames; k += 1) {
    gains[k] = 1;
    if (lv[k] < speech - 34) continue;
    const db = Math.max(-maxDb, Math.min(maxDb, speech - env[k]));
    gains[k] = Math.pow(10, db / 20);
  }
  const smooth = movingAvg(gains, Math.max(3, Math.round(AGC_GAIN_SEC / 0.01)));
  const out = new Float32Array(n);
  const order = new Float64Array(frames);
  for (let k = 0; k < frames; k += 1) order[k] = smooth[k];
  for (let i = 0; i < n; i += 1) {
    const q = i / hop;
    const k0 = Math.min(frames - 1, Math.floor(q));
    const k1 = Math.min(frames - 1, k0 + 1);
    const r = Math.max(0, q - k0);
    out[i] = pcm[i] * (order[k0] * (1 - r) + order[k1] * r);
  }
  return out;
}

module.exports = { analyzeFrames, suppressNoise, writeWavS16, flattenLevel, FRAME, HOP, NFFT };
