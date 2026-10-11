'use strict';

/* ============================================================
   TokPure — 本机硬件能力探测（R1）
   用于「桌面引擎」页签的能力分级 S/A/B 与功能开关。
   ============================================================ */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function freeDiskBytes() {
  try {
    // Electron 内置 Node >=20，fs.statfsSync 可用
    const st = fs.statfsSync(app.getPath('userData'));
    return Number(st.bavail) * Number(st.bsize);
  } catch (_) {
    return 0;
  }
}

function detect() {
  const cpus = os.cpus() || [];
  const cores = cpus.length || 4;
  const mem = os.totalmem();
  const platform = process.platform;
  const arch = process.arch;
  const appleSilicon = platform === 'darwin' && arch === 'arm64';

  let cpuModel = 'Unknown CPU';
  if (cpus[0] && cpus[0].model) cpuModel = cpus[0].model.trim();

  // ncnn-vulkan 三件套在 macOS 随包携带 libMoltenVK（Metal 转译），Apple 芯片可用；
  // Windows/Linux 需要系统 Vulkan 运行时，首次运行引擎自检失败再降级提示。
  const vulkan = platform === 'darwin' ? 'metal' : 'runtime';
  const gpuLabel = appleSilicon
    ? 'Apple GPU（Metal，经 MoltenVK 加速 Vulkan）'
    : platform === 'win32'
    ? '系统 GPU（需 Vulkan 运行时，多数显卡驱动已自带）'
    : '系统 GPU（Vulkan）';

  // 能力分级：S 全部能力 / A 主流档 / B 保底档
  let tier = 'B';
  let tierLabel = 'B · 轻量保底（tiny 模型 / delogo / 剪辑）';
  if (appleSilicon || mem >= 14 * 1024 ** 3) {
    tier = 'S';
    tierLabel = 'S · 完整能力（超分 / 插帧 / 4B 本地模型）';
  } else if (mem >= 7 * 1024 ** 3 && cores >= 4) {
    tier = 'A';
    tierLabel = 'A · 主流档（字幕 / 2x 超分 / 插帧 / 1.7B 本地模型）';
  }

  return {
    platform,
    arch,
    cpuModel,
    cores,
    memBytes: mem,
    freeDisk: freeDiskBytes(),
    appleSilicon,
    vulkan,
    gpuLabel,
    tier,
    tierLabel,
    osRelease: os.release()
  };
}

module.exports = { detect };
