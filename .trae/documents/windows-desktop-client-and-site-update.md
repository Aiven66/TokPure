# TokPure Windows 桌面客户端 + 官网 Windows 信息补充

## 一、Summary

本次交付包含两个目标：

1. **让 `tokpure-app`（Electron 客户端）跨平台化，支持 Windows 11 / 10 (x64)**，功能与 macOS 版对齐：TikTok 解析、无水印下载、系统代理联动、批量队列、本地媒体库、MP3 提取、FFmpeg 本地去水印。
2. **在官网 `tokpure-web` 补充 Windows 版本信息**：下载入口、系统要求、安装步骤、FAQ、版本历史与全站平台措辞。

已与用户确认的 3 个关键决策：

| 决策项 | 选择 |
| --- | --- |
| Windows 版 FFmpeg | **内置 `ffmpeg.exe`**（与 macOS 版一致，「开箱即用、零二次下载」） |
| 交付方式 | **代码 + 构建配置 + 构建说明**（本机无 wine，不在本机交叉构建 NSIS） |
| 官网 Windows 下载按钮 | **占位 `href="#"`**（与现有 macOS 按钮一致） |

---

## 二、Current State Analysis

### 2.1 客户端 `tokpure-app`

目录结构：`electron/`（main.js / preload.js / store.js / net.js / tiktok.js / downloader.js / ffmpeg.js）、`src/`（index.html / app.js / styles.css / icons.js / logo.png）、`resources/bin/ffmpeg`、`build/`（icon.icns / icon.png 1024² / icon-512.png）、`dist/`（既有 mac-arm64 产物）。

**已经跨平台可用的部分（无需改动）**

- 窗口控制 IPC：`win:minimize` / `win:maximize` / `win:close`（[main.js L232-L239](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/electron/main.js#L232-L239)）
- 渲染层自绘窗口控制按钮：`#win-close` / `#win-min` / `#win-max`（[index.html L55-L64](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/index.html#L55-L64)，[app.js L551-L553](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L551-L553)）
- `window-all-closed` 已正确对非 darwin 平台退出：`if (process.platform !== 'darwin') app.quit();`（[main.js L350-L352](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/electron/main.js#L350-L352)）
- 全部文件系统操作使用 `shell.*` / `fs.*`，本身跨平台
- 代理链路基于 `session.defaultSession.resolveProxy()`，Electron 在 Windows 上同样读取系统代理
- UA 池已含 `windows_chrome`（[net.js L14-L15](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/electron/net.js#L14-L15)）
- `sharp` 仅为 devDependency，运行时代码未 `require`，不存在原生模块跨平台障碍

**需要改动的跨平台缺口（已实际读文件确认）**

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | [main.js L57-L77](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/electron/main.js#L57-L77) | `titleBarStyle:'hidden'`、`trafficLightPosition`、`vibrancy:'under-window'`、`visualEffectState`、`roundedCorners` 均为 macOS 专属选项，需按平台分支 |
| 2 | [main.js L87-L119](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/electron/main.js#L87-L119) | `buildMenu()` 为 macOS 应用菜单结构，Windows 下需调整为不显示 mac 式菜单 |
| 3 | [store.js L8](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/electron/store.js#L8) | 默认下载目录硬编码 `~/Movies/TokPure/Downloads`（Windows 应为 `~/Videos`） |
| 4 | [store.js L23](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/electron/store.js#L23) | 默认 UA 预设硬编码 `macos_safari`，Windows 应默认 `windows_chrome` |
| 5 | [ffmpeg.js L10-L29](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/electron/ffmpeg.js#L10-L29) | 候选路径无 `.exe`；系统路径候选全为 macOS/Unix 路径 |
| 6 | [ffmpeg.js L61-L75](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/electron/ffmpeg.js#L61-L75) | `spawn` / `execFile` 未加 `windowsHide`，Windows 下会闪黑框 |
| 7 | [package.json](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/package.json) | `win.icon` 指向**不存在**的 `build/icon.ico`；`win.target` 未指定 arch；`extraResources` 为顶层全局配置，会把 mac 的 ARM64 二进制塞进 Windows 包（反之亦然） |
| 8 | `resources/bin/` | 只有 macOS ARM64 的 `ffmpeg`，缺 Windows 的 `ffmpeg.exe` |
| 9 | [app.js L318](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L318)、[L437](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L437)、[L652](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L652) | `在访达中显示` / `已移到废纸篓` 为 macOS 措辞 |
| 10 | [app.js L402](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L402)、[L762](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L762) | `Apple Silicon` / `Native Silicon` 硬编码品牌文案 |
| 11 | [index.html L19](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/index.html#L19)、[L28](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/index.html#L28)、[L75](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/index.html#L75)、[L215](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/index.html#L215) | 静态 macOS 品牌文案与访达提示 |
| 12 | [styles.css L293-L305](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/styles.css#L293-L305) | 窗口控制为左侧 mac 红绿灯视觉；字体回退链仅含 `-apple-system` |

### 2.2 官网 `tokpure-web`

5 个静态页面：`index.html` / `about.html` / `pricing.html` / `download.html` / `login.html`，共用同一套 header（含 `v2.4 macOS` 版本徽章）与 footer。

macOS 专属文案分布（grep 实测）：

| 页面 | 命中数 |
| --- | --- |
| download.html | 48 |
| about.html | 24 |
| index.html | 20 |
| pricing.html | 12 |
| login.html | 4 |

`download.html` 是 Windows 信息的主要落点，现状结构：

- Hero：`下载 TokPure for macOS` + 徽章 `v2.4.0 · 经过 Apple 公证`
- 双卡片：Card1 `lg:col-span-7` Apple Silicon 原生版（`.dmg` 92.4 MB + Homebrew）、Card2 `lg:col-span-5` Intel 通用版（`.dmg` 108.6 MB + SHA256）
- 系统要求 3 卡片（macOS 12.0+ / 8GB 统一内存 / 500MB）
- 3 步安装（打开 .dmg → 拖入 Applications → 启动授权）
- 版本历史 v2.4.0 / v2.3.2 / v2.2.0
- FAQ 4 问，其中 **Q4 明确写「Windows (DirectML) 与 Linux (CUDA) 客户端已列入 2025 Q3 计划路线图」**（必须改写）
- 底部 CTA + 共用 footer（`基于 Apple Silicon 神经网络引擎的下一代 macOS 桌面…`、`© 2024 TokPure Studio Inc. 专为 macOS 打造。`）

`index.html` 相关：L18-L19 hero 徽章、L28 副标题、L34 CTA、L43-L51 兼容性条、L329、L431、L459。

---

## 三、Proposed Changes

### A. 客户端跨平台化（`tokpure-app`）

#### A1. `electron/main.js` — 窗口与菜单按平台分支

- 在文件顶部引入 `const isMac = process.platform === 'darwin';`。
- `createWindow()`：把 macOS 专属窗口选项抽成条件对象，其余共用：

```js
const platformWindow = isMac
  ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: -100, y: -100 },
      vibrancy: 'under-window',
      visualEffectState: 'active',
      roundedCorners: true
    }
  : {}; // Windows：保持 frame:false 自绘标题栏，不加 mac 专属效果
```

然后在 `new BrowserWindow({ ...共用项, ...platformWindow, webPreferences })` 中展开。`frame:false`、`backgroundColor:'#111317'`、`show:false`、`ready-to-show` 逻辑保持不变。

- `buildMenu()`：mac 保留现有模板；非 mac 调用 `Menu.setApplicationMenu(null)`（Windows 下 `frame:false` 本就不显示菜单栏，置空避免 mac 式「TokPure/编辑/窗口」菜单残留；Chromium 对输入框原生支持 Ctrl+C/V）。

#### A2. `electron/store.js` — 默认下载目录与 UA 预设按平台

```js
const DEFAULT_DOWNLOAD_DIR =
  process.platform === 'win32'
    ? path.join(os.homedir(), 'Videos', 'TokPure', 'Downloads')
    : path.join(os.homedir(), 'Movies', 'TokPure', 'Downloads');
```

```js
uaPreset: process.platform === 'win32' ? 'windows_chrome' : 'macos_safari',
```

注意：`DEFAULTS` 只在首次运行生效，已有 `settings.json` 的用户配置不受影响（`deepMerge` 以存储值为准）。两个 UA 选项继续保留在选择器中。

#### A3. `electron/ffmpeg.js` — Windows 二进制解析与静默执行

```js
const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
```

- `candidates()`：三处 bundled 路径改为 `'ffmpeg' + EXE`；mac 专属系统路径用 `if (!isWin)` 包裹；Windows 额外加入 `path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe')` 与 `'C:\\ffmpeg\\bin\\ffmpeg.exe'` 作为兜底。
- `run()` 的 `spawn(bin, args, { windowsHide: true })`、`verifyFfmpeg()` 的 `execFile(bin, ['-version'], { windowsHide: true }, cb)`。
- `getFfmpegPath()` 最终兜底保持 `'ffmpeg'`（Windows 下 `spawn` 会按 `PATHEXT` 解析到 `ffmpeg.exe`）。

#### A4. `resources/bin/ffmpeg.exe` — 内置 Windows 二进制

- 下载 Windows x64 静态构建（含 `libmp3lame`，保证 MP3 提取可用）：
  `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip`
- 解压后仅取 `bin/ffmpeg.exe` 放到 `resources/bin/ffmpeg.exe`，校验文件头为 PE 可执行（`file` 输出应含 `PE32+ executable (console) x86-64`）。
- 若下载失败：保留 `ffmpeg.js` 的 PATH 回退逻辑并在最终回复中明确告知用户需自行放置该文件（不静默跳过）。

#### A5. `build/icon.ico` — 生成 Windows 图标

`build/icon.png` 已确认为 1024×1024、`sharp` 可用（devDependency，已安装）。用内联 Node 脚本（不新增文件）把 1024² 源图缩放为 16/24/32/48/64/128/256 共 7 档 PNG，按 ICO 容器格式（ICONDIR + ICONDIRENTRY + PNG payload）打包输出 `build/icon.ico`。

兜底：若脚本失败，则删除 `win.icon` 字段，让 electron-builder 从 `build/icon.png` 自动转换（尺寸已满足 ≥256 要求）。

#### A6. `package.json` — Windows 构建配置

- 把顶层 `extraResources` 改为**按平台**配置，避免两个平台的二进制互相污染：

```json
"mac": {
  "extraResources": [{ "from": "resources/bin/ffmpeg", "to": "resources/bin/ffmpeg" }]
},
"win": {
  "extraResources": [{ "from": "resources/bin/ffmpeg.exe", "to": "resources/bin/ffmpeg.exe" }]
}
```

（`ffmpeg.js` 读取路径 `process.resourcesPath + '/resources/bin/ffmpeg[.exe]'` 对两个平台仍然一致。）

- `win` 补齐：

```json
"win": {
  "target": [{ "target": "nsis", "arch": ["x64"] }],
  "icon": "build/icon.ico",
  "artifactName": "${productName}-Setup-${version}-${arch}.${ext}"
}
```

- 新增 `nsis` 段（允许改安装目录、建桌面与开始菜单快捷方式）：

```json
"nsis": {
  "oneClick": false,
  "perMachine": false,
  "allowToChangeInstallationDirectory": true,
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true,
  "shortcutName": "TokPure"
}
```

- 脚本：`"dist:win": "electron-builder --win --x64"`（macOS 侧 `dist:mac` 不变）。

#### A7. `src/index.html` + `src/app.js` + `src/styles.css` — 渲染层平台适配

- **窗口控制位置与视觉**：`app.js` boot 中取到 `info` 后，若 `info.platform === 'win32'`：给 `<body>` 加类 `platform-win`，并把 `.traffic` 节点从 `.tl-left` 移动（`appendChild`）到 `.tl-right` 末尾。`styles.css` 新增 `platform-win` 规则：`.traffic button` 变为 30×26 圆角方块、透明底、hover 高亮，并用 `::before` 伪元素绘制 `—`（最小化）、`□`（最大化）、`×`（关闭）字形。macOS 下 `.platform-win` 规则不生效，红绿灯视觉完全不变。
- **字体回退链**：[styles.css L41](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/styles.css#L41) 的 `--font-sans` 在 `-apple-system, BlinkMacSystemFont, 'SF Pro Text'` 之后补入 `'Segoe UI'`。
- **平台措辞**：`app.js` boot 中根据 `info.platform` 计算：
  - `state.revealLabel` = `darwin` → `'在访达中显示'`，否则 `'在资源管理器中显示'`；用于 [L318](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L318)、[L437](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L437) 以及 `index.html` 的 `#btn-open-folder` 的 `title`。
  - 删除提示词：`darwin` → `'已移到废纸篓'`，否则 `'已移到回收站'`（[L652](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L652)）。
- **品牌文案**：
  - [app.js L402](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L402)：`darwin` → `Apple Silicon`，`win32` → `Windows x64`，其余回退原值。
  - [app.js L762](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/app.js#L762)：`darwin` → `v${v} Native Silicon`，`win32` → `v${v} Windows x64`。
  - [index.html L19](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/index.html#L19) 静态值改为 `v1.0.0`（boot 会立即覆写）。
  - [index.html L28](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/index.html#L28) 侧栏徽章 `CoreML` → `Local`（boot L408 会覆写为 `FFmpeg`/`未就绪`）。
  - [index.html L215](file:///Users/aiven/Desktop/AI/tare-solo/tiktok/tokpure-app/src/index.html#L215) `Apple Neural Engine` → `Local Neural Engine`（跨平台中性表述）。

#### A8. 版本号（需用户确认，默认执行）

官网宣传 `v2.4.0`，而 `package.json` 为 `1.0.0`。本次作为「Windows 正式版发布」一并将 `version` 对齐为 `2.4.0`，使安装包名与官网一致（产物将变为 `TokPure-Setup-2.4.0-x64.exe`）。

> 如需保留 `1.0.0`，请在审批时指出，将跳过此项。

### B. 官网补充 Windows 信息（`tokpure-web`）

#### B1. 5 页共用区块（header / footer）

- header 版本徽章：`v2.4 macOS` → `v2.4 macOS / Win`（出现在 5 个页面）。
- footer 品牌介绍：`基于 Apple Silicon 神经网络引擎的下一代 macOS 桌面极速无水印视频下载与 AI 超分无损重构套件` → `…基于本地离线引擎的下一代 macOS / Windows 桌面极速无水印视频下载与 AI 智能修复套件`。
- footer 版权行：`© 2024 TokPure Studio Inc. 专为 macOS 打造。` → `专为 macOS 与 Windows 打造。`
- footer「产品矩阵」第 2 项：`macOS 通用客户端` → `桌面客户端 (macOS / Windows)`。

#### B2. `download.html`（主要落点）

1. `<title>` / `<meta name="description">`：加入 Windows，例如 title → `下载客户端 · TokPure for macOS & Windows`。
2. Hero：
   - H1 `下载 TokPure for macOS` → `下载 TokPure 桌面客户端`。
   - 副标题改为同时说明 macOS 与 Windows（保留「Universal 双架构」「本地离线」表述）。
   - 顶部徽章 `v2.4.0 (Build 2408) · 2025 年最新稳定版 · 经过 Apple 公证 (Notarized)` → 追加/替换为双平台描述（如 `v2.4.0 (Build 2408) · macOS 与 Windows 双平台稳定版`）。
   - 信任徽章条：新增一项 `Windows Defender SmartScreen 兼容`，`Apple Gatekeeper 签名公证` 保留。
3. **新增 Windows 下载卡片**（`lg:col-span-12`，排在两张 mac 卡片之后）：
   - 图标 `desktop_windows`，标题 `Windows 11 / 10 原生版`，架构标签 `x64`。
   - 三条卖点：内置 FFmpeg 离线引擎（MP3 提取 / 本地去水印开箱即用）、系统代理自动联动（读取 Windows 系统代理设置）、NSIS 安装向导支持自定义安装目录与桌面快捷方式。
   - 主按钮：`下载 .exe 安装包 (Windows 11 / 10 · x64)`，`href="#"`（用户已确认占位）。
   - 附一行 SHA256 占位文本，与 Intel 卡片风格保持一致。
   - 卡片文案明确标注：内置完整 FFmpeg，无需额外安装任何依赖。
4. 系统要求区：由「macOS 单平台 3 卡片」改为 **4 卡片**（`md:grid-cols-2 lg:grid-cols-4`）：macOS 版本（保留 12.0+）、**Windows 版本（新增：Windows 10 21H2 / Windows 11，x64）**、运行内存（措辞去掉「统一内存」，改为「建议 8GB 及以上」）、磁盘存储（500MB，措辞去掉 CoreML 专指）。区块副标题改为兼顾双平台。
5. 安装步骤区：改为两行——「macOS 3 步安装」（保留现有 3 步）与「**Windows 3 步安装**」（新增：① 双击 `.exe` 运行 NSIS 安装向导 → ② 选择安装目录并创建桌面快捷方式 → ③ 启动并授予网络/防火墙放行）。视觉复用现有 step card 结构。
6. 版本历史 `v2.4.0` 列表新增一条：`Windows 11 / 10 (x64) 原生客户端首发：内置 FFmpeg 离线引擎、系统代理联动、NSIS 安装向导`。
7. FAQ：
   - **Q4 重写**：`未来是否支持 Windows 或 Linux 平台？` → 改为 `是否支持 Windows 平台？`，答案改为「已正式支持 Windows 11 / Windows 10 (x64)，下载页提供原生 `.exe` 安装包；Linux 版本仍在评估中」。
   - **新增 Q5**：`Windows 版需要额外安装 FFmpeg 吗？` 答案：不需要，安装包内置完整 FFmpeg 引擎。
8. 底部 CTA：`立即下载 Apple Silicon 版` 保留，并在其旁新增 `下载 Windows 版` 按钮（`href="#"`）。

#### B3. `index.html`

- L18-L19 hero 徽章：`专为 macOS 打造 · 本地 CoreML 视频去水印引擎` → `macOS 与 Windows 双平台 · 本地离线去水印引擎`；徽章 `M1-M4 Ready` → `Mac / Win Ready`。
- L28 副标题：`完全基于 Mac 本地 Apple Silicon 神经网络引擎驱动` → `完全基于本机离线引擎驱动（macOS / Windows 通用）`，其余「零云端中转」等表述保留。
- L32-L36 CTA：`免费下载 macOS 客户端 (DMG 92MB)` → `免费下载桌面客户端 (macOS / Windows)`（版本徽章 `v2.4.0` 保留）。
- L43-L51 兼容性条：`支持 macOS Sonoma 14+ / Sequoia 15` 之后补一项 `支持 Windows 11 / 10 (x64)`。
- L329 `TokPure macOS 客户端` → `TokPure 桌面客户端`。
- L431 `完全支持 Apple Silicon M1-M4 及所有 Intel 64位 Mac 设备` → 末尾追加 `以及 Windows 11 / 10 (x64) 设备`。
- L429-L449 底部下载区：新增 Windows 下载按钮/一行说明，风格与既有 macOS 下载块一致。
- 共用 header 版本徽章与 footer 同 B1。

#### B4. `pricing.html` / `login.html`（轻量对齐）

- `pricing.html` L144：`支持同时激活 2 台 Mac 设备 (支持 Apple Silicon & Intel)` → `支持同时激活 2 台桌面设备 (macOS / Windows)`。
- `pricing.html` L379：`本地 macOS 沙盒缓存目录` → `本地应用沙盒缓存目录`。
- `login.html` L151：`基于 Apple Neural Engine 硬件签名加密` → `基于桌面客户端本地硬件签名加密`。

---

## 四、Assumptions & Decisions

1. **不修改 `about.html` 的品牌叙事**。该页存在「拒绝粗制滥造的 Electron 封装方案」「原生 Swift & CoreML 引擎」等深度技术叙事，与 Electron 实现本身不符，且改写篇幅大、属于既有历史文案，超出「补充 Windows 信息」范围。本次仅同步其共用 header 徽章与 footer 平台措辞。
2. **官网 Windows 下载按钮使用 `href="#"` 占位**（用户已确认），与现有 macOS 按钮行为一致。
3. **不在本机执行 Windows 打包**（用户已确认）。本机为 Apple Silicon macOS、未安装 wine。最终回复中给出在 Windows 机器上的构建步骤。
4. **构建说明写在最终回复中，不新增文档文件**（遵守「不主动创建 `*.md` 文档」约定）。
5. **内置 `ffmpeg.exe` 而非 PATH 回退**（用户已确认）；同时保留 `ffmpeg.js` 中「内置 → ffmpeg-static → 系统路径 → PATH」的既有回退顺序，仅做平台补齐。
6. **应用版本对齐 `2.4.0`**（见 A8），如需保留 `1.0.0` 请审批时说明。
7. **不修改 macOS 现有构建行为**：`mac.target` 仍为 arm64 的 dmg + zip，`identity: null` 不变；`resources/bin/ffmpeg`（Mach-O arm64）不动，仅通过平台化 `extraResources` 隔离。
8. Windows 采用 `frame:false` 自绘标题栏（与 mac 一致），窗口控制按钮在 Windows 下移到右侧并改为方形；Electron 在 Windows 上会为无边框窗口提供边缘拖拽缩放，无需额外实现。
9. 官网改动只使用页面内已有的 Tailwind 类与 Material Symbols 图标，不引入新依赖、不新增图片资源（保持零网络依赖）。

---

## 五、Verification

### 5.1 客户端

1. **语法检查**：对改动的每个主进程文件执行 `node --check electron/main.js electron/store.js electron/ffmpeg.js`。
2. **FFmpeg 解析路径单测**（macOS 上运行）：`node -e "require('./electron/ffmpeg').verifyFfmpeg().then(console.log)"` 需返回 `ok: true` 且路径仍指向 `resources/bin/ffmpeg`，证明 mac 行为未被破坏。

   > 注：`ffmpeg.js` 顶部 `require('electron')`，若在纯 Node 下报错，改为通过 `npm start` 启动后调用渲染层 IPC `system.ffmpeg` 验证。

3. **Windows 二进制校验**：`file resources/bin/ffmpeg.exe` 输出应包含 `PE32+ executable (console) x86-64`；体积与 `ffmpeg -version` 首行（若本机可用 wine 则不用）仅做静态校验。
4. **图标校验**：`file build/icon.ico` 应识别为 `MS Windows icon resource`，且至少含 256×256 一档。
5. **配置一致性**：读取 `package.json`，确认 `win.icon` 指向的文件存在、`win.target` 含 `arch: ["x64"]`、`mac/win` 各自有 `extraResources`、顶层不再有全局 `extraResources`。
6. **macOS 冒烟测试**：`npm start` 启动应用，确认：窗口正常显示（vibrancy 生效）、标题栏左侧红绿灯与拖拽正常、自定义导航/解析/媒体库/网络设置页面可切换、`#brand-version` 显示 `Native Silicon`。测试后关闭窗口。
7. **Windows 静态走查**（本机无 Windows，无法运行）：逐条核对 A1–A7 的 `process.platform === 'win32'` / `isMac` 分支覆盖了全部 macOS 专属项；确认无遗留 `titleBarStyle`/`vibrancy` 无条件生效。

### 5.2 官网

1. 启动本地服务：`python3 -m http.server 8099`（在 `tokpure-web` 目录）。
2. `curl -s -o /dev/null -w "%{http_code}"` 校验 5 个页面均返回 200。
3. 用无头 Chrome 截图 `download.html` 与 `index.html`，确认：新增 Windows 卡片排版正常、4 卡片系统要求区不溢出、双行安装步骤对齐、FAQ Q5 渲染正常、深色模式配色一致。
4. 全站网络依赖复检：确认新增内容未引入任何 `https://` 资源引用（保持既有零网络依赖结论）。
5. 5 个页面中 `v2.4 macOS / Win` 徽章与 footer 平台措辞均已更新，无 `专为 macOS 打造` 残留在共用区块。

---

## 六、执行顺序

1. `electron/main.js`（A1）
2. `electron/store.js`（A2）
3. `electron/ffmpeg.js`（A3）
4. 下载并落位 `resources/bin/ffmpeg.exe`（A4）
5. 生成 `build/icon.ico`（A5）
6. `package.json` 构建配置（A6，含 A8 版本号）
7. `src/index.html` / `src/app.js` / `src/styles.css`（A7）
8. 客户端验证（5.1）
9. 官网 `download.html`（B2）
10. 官网 `index.html`（B3）
11. 官网 `pricing.html` / `login.html`（B4）
12. 5 页共用 header/footer（B1）
13. 官网验证（5.2）
14. 输出 Windows 构建步骤说明（最终回复）