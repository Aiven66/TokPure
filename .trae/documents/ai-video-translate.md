# AI 视频翻译（Voice Translation Lab）实现说明

版本：3.9.28

## 功能边界

用户上传原片视频 → 上传自己的声音样本 → 本地克隆成「我的声音」→ 选择该声音
→ 把原片人声换成「用我的声音说目标语言」→ 输出成片。

- 只换人声，不做口型重绘（口型对齐仍在「AI多语口播」里，避免重复 5 倍实时开销）。
- 目标语言与原片语言相同时，不做翻译，只做「换声」。
- 视频画面默认无损直拷（`-c:v copy`）；开启「烧录字幕」时才重编码并叠加 libass 字幕。
- 成片固定为「一条画面 + 一条音轨」，音轨 = 克隆配音（可选保留原片 BGM，侧链闪避）。
- 全离线：Whisper.cpp 识别、Llama.cpp 翻译、Chatterbox 克隆合成、ffmpeg 封装，
  不调用任何第三方模型 API。

## 复用清单（不复制粘贴）

| 能力 | 复用来源 |
| --- | --- |
| 媒体探测 / 时长 | `localize.probe` |
| 语音识别 | `localize.ensureWhisper` + `transcribe` |
| 本地翻译 | `localize.ensureTranslateEngine` + `translateSegments` |
| 字幕 | `localize.buildSrt` |
| 克隆引擎安装 | `voicelocal.install`（经 `ensureCloneReady`） |
| 克隆会话 | `voicelocal.openSession` + `makeLocalSynth` |
| 逐句配音装配 | `localize.buildNarration`（含谱减降噪、增益台阶、限幅、变速） |
| BGM 分离与闪避 | `localize.separateBgm` + `dubAudioChain` + `BGM_CLEAN/BGM_DUCK` |
| 成片自检 | `localize.verifyOutput` |
| 字幕样式 | `srtForceStyle`（与口播/切片同一套） |

## 新增文件

- `electron/voicesample.js`：纯函数（样本校验、PCM 统计、波形峰值、WAV 头解析、索引归一化），
  不依赖 Electron，单测直接 require。
- `electron/voices.js`：声音档案库（`userData/voices/<id>/ref.wav` + `index.json`），
  负责导入（ffmpeg 去静音/限带/两级 afftdn/截 12 秒）、列出、删除。
- `src/translate.js`：页面控制器（上传、声音库、语言、进度、结果）。
- `test/unit.js` / `test/smoke.js` 扩展。

## 修改文件

- `electron/localize.js`：`ensureCloneReady`、`renderVoiceSwap`、
  `startTranslate`、`translateStatus`、`previewProfile`、声音库 IPC 包装；
  把口播的混音链抽成 `dubAudioChain`、字幕样式抽成 `srtForceStyle`，两条流程共用。
- `electron/main.js` / `electron/preload.js`：新增 `vt:*` IPC 与 `window.tokpure.vt`。
- `src/index.html`：左侧菜单新增「AI 视频翻译」，新增 `#view-translate` 页面。
- `src/app.js`：路由到 `window.VideoTranslate.init()`。
- `src/styles.css`：`#view-translate` 专属样式（暖琥珀 / 录音棚控制台）。

## 页面结构（01 / 02 / 03 / 04）

1. `01 原片`：拖拽/选择视频，显示文件名、大小与时长；无音轨或超 3 分钟会即时标红并禁用运行。
2. `02 我的声音`：上传样本、声音卡片（波形、有效时长、试听、删除、选中），支持把音频文件直接拖到上传卡上。
3. `03 输出`：目标语言多选、原片语言、翻译档位、保留 BGM、烧录字幕、字幕颜色、预计耗时、运行/停止、进度与逐语种进度。
4. `04 产出`：每种语言一张卡（配音音色、模式、提示、播放 / 访达 / SRT），以及「输出文件夹」。

## 测试

- 单测（`npm test`，27 项全绿）：样本校验阈值、PCM 语音占比、波形峰值归一化、WAV 头解析、索引清洗、
  版本号、`vt` API 暴露、页面/路由接线、`-c:v copy` 与单音轨约束、进度单调整闸。
- 冒烟（`npm run test:smoke`，Electron 内）：ffmpeg 合成 3 秒测试片 → 用真实 TTS 生成配音 →
  `renderSwapForTest` 出片（开/关字幕两条路径）→ 校验「视频流保留 + 仅 1 条音轨 + 时长一致」；
  再跑一次声音样本导入 → 列表 → 删除。
- 端到端（本机实测，2026-11-04）：9.9 秒英文原片 + 9.88 秒真人声音样本 → 试听合成 419KB 音频 →
  跑完整链路（126 秒）→ 1 条 `zh.mp4`（13.18MB，视频 1 条 / 音轨 1 条 / 9.90 秒）+
  中文 SRT；把成片音轨抽出来再跑一次 Whisper，识别结果确认为中文配音：

  > 你好,这是我的语音,我正在测试语音翻译实验时,原始音频将被替换为我的各种语音,视频保持不变。

进度链路实测阶段：检查本地组件 → 准备引擎 → 读取原片 → 提取音轨 → 语音识别 →
加载我的声音 → 克隆模型就绪 → 翻译字幕 → 合成配音 → 封装成片 → 已完成（16 段，百分比单调不减）。
