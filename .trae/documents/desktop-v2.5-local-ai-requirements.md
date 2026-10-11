# TokPure 桌面客户端 v2.5 产品需求清单（本地 AI 版）

> 输入：v2.4.4 现状盘点 + 2026-10-11 对 GitHub 开源生态的实测调研（Star/许可证/更新时间均经 GitHub API 核实）
> 总原则：**100% 本地运算、零云 API 依赖**；基准机型 Apple M1 8GB / Intel i5 六代 8GB / 核显或入门独显；安装包保持瘦身，引擎与模型全部「首启按需下载」；闭源商业产品只集成许可证干净的框架。

---

## 一、v2.4.4 现状与差距

| 已有能力 | 现状 | v2.5 差距 |
|---|---|---|
| URL 抓取与下载 | 本地解析、无水印源、线路回退、429 缓存 | 仅支持 TikTok；解析器热更新慢 |
| AI 智能去水印 | **实际只有 FFmpeg 边缘裁剪 / delogo**，无真实 AI | 无法处理动态/居中水印，是本版本最大短板 |
| 批量任务队列 | 并发编排、遥测、看门狗 | 缺少 AI 后处理任务类型 |
| 本地媒体库 | 文件列表、过滤 | 缺少智能封面、标签、检索 |
| 网络与代理 | 系统代理联动、UA 伪装 | 保持 |
| 语音/字幕/剪辑/增强 | 无 | 全新能力域 |

---

## 二、需求优先级总览

| 优先级 | 需求 | 一句话价值 | 核心选型（许可证） | 模型/体积增量 | 8GB 基线 |
|---|---|---|---|---|---|
| **P0** | R1 端侧引擎底座 +「桌面引擎」页签 | 所有本地 AI 的下载/调度/降级基础设施 | 自研 sidecar 管理器（参考 Jan，Apache-2.0） | 首包 ≈ 0，引擎各 5–70MB | ✅ |
| **P0** | R2 本地 AI 字幕（识别+烧录+双语） | 短视频出海第一刚需 | whisper.cpp（MIT）+ sherpa-onnx/SenseVoice（Apache-2.0） | 75–466MB 按需 | ✅ |
| **P0** | R3 AI 去水印 2.0（检测→掩膜→修复） | 把「假 AI 实验室」升级为真能力 | RapidOCR+PP-OCRv5（Apache-2.0）、PicoDet（Apache-2.0）、FFmpeg delogo / IOPaint（Apache，权重需自选） | ≈ 25–120MB | ✅ |
| **P0** | R4 视频超分 / 插帧 / 增强 | 老素材二次创作清晰度升级 | realsr-ncnn-vulkan、realcugan-ncnn-vulkan、rife-ncnn-vulkan（均 MIT） | 15–70MB/模型 | ✅ Vulkan |
| **P1** | R5 智能剪辑（去停顿/镜头切分） | 口播粗剪自动化 | auto-editor（Unlicense）+ PySceneDetect（BSD-3） | ≈ 0（ffmpeg 复用） | ✅ |
| **P1** | R6 本地配音与音色 | 无网也能出配音 | Kokoro-82M（Apache-2.0，WASM）；克隆档 GPT-SoVITS（MIT，高配包） | 160–350MB / 克隆包 500MB+ | ✅ / ⚠️ 异步 |
| **P1** | R7 人声/BGM 分离与降噪 | 提取干净人声、BGM 复用 | DeepFilterNet3（MIT/Apache）+ Demucs ONNX（MIT） | 10–80MB | ✅ 离线 |
| **P1** | R8 离线文案助手（标题/标签/翻译） | 替代云基座模型 API | llama.cpp（MIT）+ Qwen3-1.7B/4B（Apache-2.0，node-llama-cpp 集成） | Q4 1.1–2.5GB 按需 | ✅ |
| **P1** | R9 智能封面 / 关键帧优选 | 关键帧封面（既定 P0 方向）智能化 | Florence-2-base（MIT）+ 启发式信号 | ≈ 500MB 按需 | ✅ 抽帧调用 |
| **P2** | R10 智能抠像 / 背景替换 | 绿幕自由、换背景 | MediaPipe Selfie（Apache-2.0）预览 + BiRefNet-lite（MIT）导出 | 5–300MB | ✅ |
| **P2** | R11 多平台素材下载 | 扩素材来源 | yt-dlp（Unlicense）独立热更新通道 | ≈ 15MB | ✅ |
| **P2** | R12 模板化批量出片 | 批量带货/字幕样式模板 | Motion Canvas（MIT）优先；Remotion 有 4 人授权线 | ≈ 150MB 渲染器 | ✅ |
| **预研** | R13 数字人 / 对口型 | 长期愿景（对标 Hengen） | DH_live_mini 双 ONNX 架构（**当前无许可证，不可直接商用**） | — | ❌ 合规未解 |

工作量：R1≈2 周；R2/R3/R4 各 1.5–2 周；P1 各项 1–1.5 周；P2 各 1–2 周。建议 v2.5 先交付 **R1–R4**，v2.6 交付 R5–R9。

---

## 三、P0 需求详细定义

### R1 端侧引擎底座 + 新增「桌面引擎」页签

**背景**：所有 AI 能力都走本地 sidecar，必须先有统一底座；产品规范要求客户端必须提供本地模型管理页签。

**功能点**
1. 侧边栏新增「桌面引擎」页签（图标 `cpu`，位于「网络与代理设置」之上），内容：
   - 硬件能力检测：芯片/内存/显卡、Vulkan/Metal/DirectML 可用性、推荐档位（S/A/B）
   - 引擎状态：FFmpeg / whisper.cpp / sherpa-onnx / ncnn / llama.cpp 的安装与版本
   - 模型市场：各能力模型的体积、语言、下载进度、校验和、删除/重装；下载多镜像（GitHub Release、ModelScope、自有 CDN）+ 断点续传
   - 功能开关与「低配模式」（限制线程数、默认小模型、关闭并发推理）
2. sidecar 生命周期：`child_process` 拉起、崩溃隔离与自动重启、CPU 线程上限、推理队列（与现有下载队列复用 UI 模式）
3. 瘦安装包：安装包只含 Electron + FFmpeg + 小引擎二进制（控制在 +40MB 内），模型全部首启按需下载到 `userData`

**参考架构**：Jan（https://github.com/janhq/jan ，Apache-2.0）的「瘦客户端 + cortex sidecar + 模型按需下载」；AnythingLLM Desktop（MIT）验证商业产品内嵌 llama.cpp 可行。

**验收标准**
- 断网状态下已下载的全部能力可用；未下载能力点击后引导下载
- 任一 sidecar 崩溃不影响主窗口与下载队列
- 机型能力检测准确：无 Vulkan 的 Intel 核显自动给出「超分不可用/可下载 CPU 慢档」提示，不允许直接卡死

---

### R2 本地 AI 字幕（自动识别 → 编辑 → 烧录 / 导出）

**用户故事**：下载的 TikTok 视频要发国内/其他语种平台，一键得到带样式字幕或双语字幕，全程离线。

**功能点**
1. 语音识别：默认引擎 **whisper.cpp**（https://github.com/ggml-org/whisper.cpp ，MIT，5.4 万★，活跃），tiny/base/small 三档按需下载；中文短视频增加 **sherpa-onnx（Apache-2.0）+ SenseVoiceSmall/Paraformer ONNX**（中英日韩、非自回归、同档比 Whisper 快数倍，int8 ≈ 230MB）
2. 输出：句级/字级时间轴；导出 SRT/ASS/VTT；字幕直接烧录（FFmpeg libass，样式模板：字号/描边/位置/双语上下轨）
3. 双语字幕：识别后调用 R8 的本地 LLM 翻译（轻量备选 Argos Translate 语向包，MIT，约 100MB/语向）
4. 任务化：支持队列内批量「下载→识别→烧录」一条流水线

**选型排除**：WhisperX（BSD，字级对齐强）依赖的 pyannote 为 HuggingFace gated 权重，禁止默认打包，仅留作未来「专业包」；insanely-fast-whisper 已停更且偏 GPU，不采用。

**验收标准（8GB 基线）**
- M1：1 分钟视频 base 档识别 < 15 秒；i5 六代：tiny 档快于实时、small 档 ≥1.5 倍实时
- 中英日混合识别可用；烧录字幕与画面帧率一致、无漂移
- 全程无任何网络请求（模型已下载前提下）

---

### R3 AI 去水印 2.0：检测 → 掩膜 → 修复

**用户故事**：动态飘动水印、居中花字、片尾 Logo，现有 delogo 擦不干净或留糊块；新版本要自动找到水印并智能修复。

**功能点（分档交付，低配可跑）**
1. **掩膜自动定位**
   - 文字水印：**RapidOCR + PP-OCRv5 mobile ONNX**（https://github.com/RapidAI/RapidOCR ，Apache-2.0；检测模型 4.7MB + 识别 16MB，CPU 单帧百毫秒内），OCR 文字框直接生成掩膜
   - Logo 图标：自训 **PicoDet-S**（Apache-2.0，约 3MB，ncnn/ONNX 友好）检测 TikTok/抖音系 Logo；标注集用内部样本积累
   - 交互保底：保留现有手动框选；增加首帧点选 **MobileSAM**（Apache-2.0，约 40MB）补全轮廓；跨帧传播用 **Cutie**（MIT，约 90MB，降分辨率跟踪）
2. **修复（三档）**
   - 档位 A 默认：FFmpeg `delogo/removelogo`（零成本，固定/小面积水印）
   - 档位 B：**IOPaint**（https://github.com/Sanster/IOPaint ，Apache-2.0，CPU 友好）小区域逐帧修复 + 时序平滑；**注意：官方 big-lama 权重为 CC BY-NC-SA 非商用，商用必须换许可宽松权重或自训——发布前阻断项**
   - 档位 C（研究，不发布）：ProPainter 质量最高但**非商用许可**且 1080p 需 19GB+ 显存；DiffuEraser 依赖非商用模型 + 高端独显——均仅作技术跟踪
3. 前后对比：保留「显示原始画面」对比开关；导出时支持仅片尾 N 秒处理

**许可证红线**：Ultralytics YOLO11n（AGPL-3.0）落地最快但闭源商用需企业授权，**默认选 PicoDet 规避**；不引入 ProPainter/E2FGVI（非商用）。

**验收标准**
- TikTok 常见静态用户名水印：自动检测召回 ≥ 90%，修复后主观无明显糊块（1080p，i5 处理速度 ≥ 0.3 倍实时或给出明确耗时预估）
- 动态水印：首帧框选后整段跟踪无明显漂移（720p 基线）
- 用户可全程不点鼠标完成「上传→检测→导出」

---

### R4 视频超分 / 插帧 / 增强（离线画质包）

**用户故事**：老视频/搬运素材二创，一键 2K/4K 增强、补到 60fps，夜间挂机出片。

**功能点**
1. 三个 MIT 单文件 sidecar（ncnn-Vulkan，三平台预编译，随包或按需下载）：
   - 真人超分：**realsr-ncnn-vulkan**（https://github.com/nihui/realsr-ncnn-vulkan ，MIT，x2/x4，模型 15–64MB）
   - 动漫/竖屏增强：**realcugan-ncnn-vulkan**（MIT，nose/fast 档）
   - 插帧：**rife-ncnn-vulkan**（https://github.com/nihui/rife-ncnn-vulkan ，MIT，低配友好度最高的 AI 能力之一）
2. 产品化：倍率选择（x2/x3/x4）、tile 分块防 OOM、任务队列、与 R3/R7 自由组合；无 Vulkan 设备提供 CPU 慢档或明确禁用提示
3. 下一代轻量模型 **SPAN**（Apache-2.0，约 15MB）列入预研替换 Real-ESRGAN
4. 只学架构不抄代码：Upscayl（AGPL-3.0）是 Electron+ncnn 成功先例，**其代码不可并入**，所调用 ncnn 二进制本身为 MIT

**验收标准**
- M1：1080p→4K 离线任务可完成不崩、8GB 内存有峰值护栏；720p RIFE 插帧接近实时
- i5 核显：x2 + 分块可用；不满足条件时 UI 置灰并说明原因
- FFmpeg 拼回后音画同步、元数据保留

---

## 四、P1 需求摘要

- **R5 智能剪辑**：auto-editor（Unlicense）自动去口播停顿/废片（先用纯 ffmpeg `silencedetect`+时间码重排实现，零新增依赖）；PySceneDetect（BSD-3）镜头切分供批量混剪；TransNetV2（MIT 但停更）仅在精度不够时以 ONNX 引入。
- **R6 本地配音**：默认 **Kokoro-82M v1.1**（Apache-2.0，含中英日韩语 ONNX，WASM/WebGPU 在渲染进程实时；无 GPU 依赖）；Piper 兼容 VITS 经 sherpa-onnx（Apache）加载，规避 Piper 新仓 GPL 问题。**音色克隆作为「高配包」走 GPT-SoVITS（MIT，中文克隆第一梯队，CPU 异步生成）**；遵守既定体验要求：克隆后预览立即播放、朗读固定预览语文案、男声参考必出男声。排除：F5-TTS 权重 CC-BY-NC、XTTS-v2 权重 CPML 非商用且停更、ChatTTS AGPL、IndexTTS2 低配机跑不动（仅未来高配观望）。
- **R7 降噪/分离**：DeepFilterNet3（MIT/Apache，模型约 10MB，核显都远超实时）录音降噪；Demucs ONNX（MIT）做人声/BGM/鼓/贝斯分离，异步任务，替代当前仅「提取 MP3」的单一场景。
- **R8 离线文案助手**：node-llama-cpp（MIT）或 llama.cpp server sidecar + **Qwen3-1.7B（老 i5 默认）/4B（M1 默认）Q4 量化**（Apache-2.0）；功能：根据识别字幕+元数据生成多平台标题/描述/标签/Hashtag、字幕翻译、内容合规自检；Ollama 仅做「检测到本机已安装则接入」。Gemma 3n（有效内存 2–3GB，含多模态）作备选但条款非标准 OSI 许可，发布前法务确认。
- **R9 智能封面**：当前「保存动态封面」升级——镜头切分抽帧 → 清晰度/人脸/运动启发式打分 + **Florence-2-base**（MIT，约 0.5GB，ONNX/OpenVINO，单图秒级）内容理解打分 → Top3 候选；同时输出封面文案建议（复用 R8）。

## 五、P2 与预研

- **R10 智能抠像**：MediaPipe Selfie Segmentation（Apache-2.0，WASM 数 MB）实时预览绿幕；导出高质量档用 BiRefNet-lite ONNX（MIT）+ 时序滤波；RVM 效果稳但是 GPL-3.0，仅在接受 sidecar 聚合合规义务时备选；MODNet 停更不采用。
- **R11 多平台下载**：yt-dlp（Unlicense，19.7 万★）以独立 sidecar + **独立热更新通道**接入（extractor 易失效），默认仍只放开合规站点；TikTok ToS 风险在 UI 做责任声明。
- **R12 模板出片**：优先 Motion Canvas（MIT）；Remotion 需 4 人以上公司授权，商务确认后再定。
- **R13 数字人预读（不发布）**：MuseTalk/LatentSync/Hallo/EchoMimic 均需中高端独显，8GB 不可用；Wav2Lip 无 LICENSE、DH_live_mini 无 LICENSE——**唯一端侧实时架构 DH_live_mini（双小 ONNX、浏览器可实时）值得研究其架构，需自训或取得授权后方可产品化**。建议 v2.6 立项做可行性 Spike，不进入 v2.5 承诺。

## 六、硬件适配与降级策略

| 档位 | 判定 | 可用能力 |
|---|---|---|
| S（M1/M2/M3 或独显+Vulkan） | 全部 | 含超分 4K、Qwen3-4B、GPT-SoVITS 异步克隆 |
| A（i5 六代及以上 / 8GB / 核显） | 主流 | whisper base/small、字幕、去水印 A/B 档、RIFE、x2 超分、Qwen3-1.7B、Kokoro |
| B（< 8GB 或老 CPU/无 Vulkan） | 保底 | whisper tiny、delogo、剪辑、降噪、Kokoro WASM；重型任务禁用并说明 |

所有重型操作统一：任务预估耗时/内存 → 超出安全阈值二次确认 → tile/降采样/限线程自动降级 → 崩溃可续跑。

## 七、许可证红线（发布前 Checklist）

- **禁止直接集成**：ProPainter / E2FGVI（非商用）、big-lama 原始权重（CC BY-NC-SA）、NLLB（CC-BY-NC）、F5-TTS 官方权重（CC-BY-NC）、XTTS-v2（CPML）、Wav2Lip/DH_live（无 LICENSE）
- **AGPL 强传染，闭源产品不直接用**：Ultralytics YOLO、Upscayl、LibreTranslate、ChatTTS（代码）
- **GPL 可 sidecar 聚合但需履约**：RVM（GPL-3.0）、OHF Piper1（GPL-3.0）——独立进程调用、提供许可声明与源码获取途径
- **可放心商用（推荐主力）**：whisper.cpp、sherpa-onnx、SenseVoice/Paraformer、Kokoro、DeepFilterNet、Demucs、llama.cpp、Qwen3、Florence-2、PicoDet、MobileSAM、Cutie、三个 nihui ncnn 工具、RapidOCR、MediaPipe、BiRefNet、auto-editor、PySceneDetect、yt-dlp、Motion Canvas
- **发行前二次确认**：Gemma 3n 模型条款、GPT-SoVITS 音色授权（用户上传克隆人声的授权链路需产品侧管控）

## 八、版本节奏建议

- **v2.5（本地 AI 基础版）**：R1 引擎底座与页签 → R2 字幕 → R3 去水印 2.0 → R4 超分插帧；侧边栏收缩/展开（已在 v2.4.x 提前落地）
- **v2.6（创作版）**：R5 智能剪辑 → R6 配音 → R7 降噪分离 → R8 文案助手 → R9 智能封面
- **v3.0（探索版）**：R10 抠像、R12 模板批量出片、R13 数字人 Spike 转产品（视授权与硬件普及度）

## 九、主要风险

1. **合规 > 技术**：去水印 SOTA 模型几乎全为非商用条款，v2.5 必须以「PicoDet/OCR + delogo/可商用修复权重」组合上线，LaMa 类权重替换是发布阻断项
2. **Vulkan 兼容长尾**：部分 Intel 核显/老驱动 ncnn 初始化失败，需黑名单与 CPU 回退
3. **模型下载体验**：国内用户访问 HuggingFace/GitHub 不稳定，ModelScope + 自有 CDN 镜像要在 R1 首日就绪，带校验和与断点续传
4. **包体积与用户预期**：瘦安装包 + 首启下载是正确架构（Jan 已验证），但要在首次使用处明确「模型仅下载一次、支持删除」
