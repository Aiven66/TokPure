# AI 视频翻译（Voice Translation Lab）实现说明

版本：3.9.29

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

- 单测（`npm test`，31 项全绿）：样本校验阈值、PCM 语音占比、波形峰值归一化、WAV 头解析、索引清洗、
  版本号、`vt` API 暴露、页面/路由接线、`-c:v copy` 与单音轨约束、进度单调整闸；
  3.9.29 追加 `groupForFlow` 并句边界、`segmentGain` 台阶/噪底钳制、`buildFlowNarration`
  「整片仅一次变速 + 按原片语段时间轴定位 + 字幕单调」、配音调用点已切到连续语流。
- 冒烟（`npm run test:smoke`，Electron 内）：ffmpeg 合成 3 秒测试片 → 用真实 TTS 生成配音 →
  `renderSwapForTest` 出片（开/关字幕两条路径）→ 校验「视频流保留 + 仅 1 条音轨 + 时长一致」；
  再用 `flowNarrationForTest` 跑多短句并段 → 校验「3 条字幕并成 2 段 + 时长精确 6.00s +
  语音区间内无 0.8s 以上硬静音」；最后跑一次声音样本导入 → 列表 → 删除。
- 端到端（本机实测，2026-11-04）：9.9 秒英文原片 + 9.88 秒真人声音样本 → 试听合成 419KB 音频 →
  跑完整链路（126 秒）→ 1 条 `zh.mp4`（13.18MB，视频 1 条 / 音轨 1 条 / 9.90 秒）+
  中文 SRT；把成片音轨抽出来再跑一次 Whisper，识别结果确认为中文配音：

  > 你好,这是我的语音,我正在测试语音翻译实验时,原始音频将被替换为我的各种语音,视频保持不变。

进度链路实测阶段：检查本地组件 → 准备引擎 → 读取原片 → 提取音轨 → 语音识别 →
加载我的声音 → 克隆模型就绪 → 翻译字幕 → 合成配音 → 封装成片 → 已完成（16 段，百分比单调不减）。

## 3.9.29 连续语流（修复「断断续续 / 不自然」）

**根因**（三条同时作用于听感，改一条不够）：

1. 逐句克隆 = 每句从零起调，句尾降调、句首重音重置，句子越短越像念稿；
2. 生成上限按「字幕窗口 × 1.5」算，译文一长就被 token 上限在**句中截断**（实测同一段
   55 字中文只出 5.3 秒语音，后半句直接没了）；
3. 为塞回窗口对每句单独 `atempo`（≤1.25），到上限仍在窗口末尾淡出硬切，词尾被削。

**改法**：

- 相邻短句并成「语段」（停顿 ≤0.4s、总长 ≤84 字、跨度 ≤9s）再合成：句调完整、不再句中截断；
  字幕条目保持原样，逐条按字位比例重映射到实际语音时间。
- token 上限改成「按语速估语音时长 × 25 token/秒 × 1.35」；墙钟上限同步放宽（克隆约 22 倍实时）。
- 时间轴：语段起点落回原片位置（配音跟得上画面），语音超长才顺延；
  超出片长只做**一次**整片变速（≤1.35），还放不下才压缩气口（最小 0.08s）。
- 每段合成后裁掉首尾 -45dB 以下静音（TTS/克隆都会在文件尾垫几百毫秒），
  避免「底噪 + 气口」叠成一处明显空档；句内气口全部保留。
- 电平仍用 `segmentGain`（整句 LUFS 归一 + 噪底封顶 -34dB + 相邻句台阶 ±3dB），不逐句泵动。

**实测（2026-11-04，13.84 秒英文原片 + 本机真人声音样本，翻译成中文）**：

- 成片视频 1 条 / 音轨 1 条、时长 13.84s（与原片一致），warning 为空（无需整片变速）；
- 成片语音覆盖 0–12.36s，唯一静音段是片尾 12.36–13.86（1.50s），**语音区间内无 ≥0.8s 硬静音**；
- 回环 Whisper（中文）识别出 55 个汉字，语义完整、无半句：

  > 你好,大家,今天我想展示给你三个简单的事情首先保持你的桌面整洁其次,计划好你的一天在开始之前最后,至少恢复一下你做的事

- 同一条链路在修复前（3.9.28）同一素材只合成出 5.3 秒语音（后半句被 token 上限截断），
  片尾静默 8.5s；回环 ASR 只剩前 29 个汉字。
