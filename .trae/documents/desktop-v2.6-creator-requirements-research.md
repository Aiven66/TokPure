# TokPure 桌面客户端 v2.6（创作版）产品需求调研清单

> 调研日期：2026-10-11
> 输入：v2.5.0（本地 AI 基础版，commit 0f79cb0）实际交付盘点 + 2026 年 10 月对开源生态与竞品的公开资料核验
> 方法：开源项目以官方仓库 / PyPI / 官方文档为准（P0/P1），竞品以官网定价页为准，单一来源与营销站说法均标注可信度；冲突结论并列呈现，不做无证据取舍
> 总原则延续 v2.5：**100% 本地运算、零云 API**；基准 Apple M1 / 8GB / 核显；瘦安装包 + 引擎模型按需下载；只集成许可证可商用的框架

---

## 一、执行摘要

v2.5.0 已交付 R1 引擎底座、R2 Whisper 字幕、R3 手动多区域时间轴去水印、R4 三引擎超分插帧，且四条链路均在 M1 真机出片验证。但对照 v2.5 原始 PRD，有五项规划内容被裁剪或推迟：**R3 仅交付手动掩膜（OCR/Logo 自动检测未做）、R2 仅有 Whisper（SenseVoice 中文引擎与双语字幕未做）、硬件 S/A/B 分级仅用于展示（低配模式/任务护栏未做）、AI 任务未接入批量队列流水线、Windows/Intel Mac 的 AI sidecar 未就位**。

外部环境在 2025Q4–2026 出现三个对 TokPure 有利的变化：

1. **云端 AI 工具全面转向订阅 + 积分制**：CapCut 全功能 AI 工具包走云端（Veo 3、Seedream 4.0），Pro 约 $7.99–19.99/月且部分区按 800 积分/月计量 [cite:34][cite:35][cite:37]；Topaz Video AI 约 $299/年、UniFab 终身 $319.99、HitPaw 终身约 $350、VideoProc 起价 $34.95 [cite:38][cite:39]。「一次付费、本地无限跑、隐私不出端」的空白定位依然成立。
2. **小模型在 2025–2026 密集换代，8GB 基线可承载的能力变多**：Qwen3-1.7B Q4 量化约 1GB、现代 i5 CPU 约 25–40 token/s [cite:14]；Qwen3-VL-2B 于 2025-10-22 发布并标注手机可跑 [cite:19][cite:20]；Kokoro 82M 纯 CPU 即可合成、Apache-2.0 [cite:1][cite:5]；SenseVoice int8 在低端 ARM 核上 RTF 低至 0.175 [cite:24]。
3. **多语言本地化成为创作者主流工作流**：TikTok 官方 Symphony AI Dubbing 可做 10+ 语种转写翻译配音（云端）[cite:42]；2026 年行业观察显示「同一创作者用自己的克隆声产出西/葡等多语种版本一次拍摄多发」已是成熟做法，巴西葡语等市场体量显著 [cite:44]。这正是「字幕识别 → 本地翻译 → 配音」本地化流水线的需求背书。

**v2.6 范围建议**：在原规划 R5–R9（创作版）之上，插入「v2.5 补账」轨道，并把 R8 本地 LLM 提前到与 R5 同级（因为它同时解锁双语字幕与封面文案）。建议分两次发布：**v2.6.0 = 平台补账 + R5 智能剪辑 + R8 文案助手 + 双语字幕闭环；v2.7.0 = R6 配音 + R7 降噪分离 + R9 智能封面**（声音与视觉两条重资产线分别独立成版，降低 sidecar 打包与测试风险）。R3 自动检测补完与低配护栏建议在 v2.6.0 周期内穿插交付。

---

## 二、v2.5 交付复盘：规划与实际差距

| PRD 项 | v2.5 规划 | 实际交付（0f79cb0） | 差距定性 |
|---|---|---|---|
| R1 引擎底座 | 引擎/模型市场、镜像、硬件分级、低配模式、线程上限、崩溃重启 | 引擎/模型市场（直连+镜像+校验+取消）、硬件 S/A/B 检测与展示；RIFE 包安装时 prune 488MB→35MB | **低配模式开关、按档位置灰、推理线程/内存护栏、崩溃自动重启未做** |
| R2 字幕 | Whisper + SenseVoice 双引擎、SRT/ASS/VTT、双语上下轨、队列流水线 | Whisper tiny/base/small、SRT 导出与烧录、分段可编辑；真机识别+烧录通过 | **SenseVoice 引擎、ASS/VTT、双语字幕、「下载→识别→烧录」队列串联未做** |
| R3 去水印 2.0 | OCR/Logo 自动检测 → 掩膜 → 三档修复 | 多区域 + 时间轴手动 delogo（5 预设 + 自定义）、预览层 | **自动检测（RapidOCR/PicoDet）、MobileSAM/Cutie 跟踪、智能修复档位全部未做**；当前仍是 FFmpeg 修复 |
| R4 超分插帧 | realsr x2/x4、realcugan、rife、tile 防 OOM、CPU 回退提示 | 三引擎真机出片：RealSR 1080p、Real-CUGAN 540p、RIFE 30→60fps | RealSR 官方 Mac 包仅 x4 模型，UI 已据实改为固定 4x；**tile 分块、长视频内存护栏、无 Vulkan 设备的禁用/CPU 回退提示待补** |
| 平台覆盖 | macOS arm64 先行，资产位预留 Win/x64 | ncnn 三引擎 win32-x64 下载地址已配置；Whisper 仅有自编译 macos-arm64 sidecar | **Windows/Intel Mac 用户：Whisper 显示「不支持」，ncnn Windows 资产未真机验证** |

差距来源是 8GB 基线与发布节奏下的主动裁剪，并非缺陷；但 R3「自动检测」与「双语字幕」是 v2.5 对外叙事中用户预期最高的两项，建议 v2.6 优先补账。

---

## 三、外部环境核验（2025Q4–2026）

### 3.1 竞品格局：云端订阅化与高价买断并存

| 产品 | 形态 | 价格（官网公开信息） | AI 能力与 TokPure 的关系 |
|---|---|---|---|
| CapCut 桌面版 | 云端 AI + 编辑器 | Pro 约 $7.99/月、$74.99/年；另有页面列 $19.99/月（区域/端差异） [cite:34][cite:35] | 自动字幕、TTS、AI 视频（Veo 3）、AI 图像（Seedream 4.0）全在云端，部分区按 800 积分/月计量 [cite:36][cite:37]；离线与隐私是 TokPure 的反向卖点 |
| Topaz Video AI | 本地桌面（独显导向） | 约 $299/年（竞品对比页数据） [cite:39] | 超分/插帧直接对标；高价 + 大体积，8GB 核显机不友好，留出中低配市场 |
| UniFab All-In-One | 桌面 | 终身 $319.99 [cite:39] | 超分 4K/8K/16K、SDR→HDR、字幕生成/翻译/配音，功能面与 v2.6+ 路线最接近，价格是 TokPure 订阅档的数十倍 |
| HitPaw（VikPea 等） | 桌面 | 终身约 $350 量级，部分工具转向会员积分 [cite:39][cite:48] | 去水印/背景/超分工具集，质量口碑参差 |
| VideoProc Converter AI | 桌面 | 起价 $34.95 [cite:38] | 超分、插帧、稳像、人声分离、降噪已进官方功能列表 [cite:38]——验证 R7/R4 组合是品类标配 |
| 4K Tokkit | 纯下载器 | 免费 + €15/年 / €20–36 终身 [cite:41] | 2025-10 v25.4 才完成 Apple Silicon 原生适配 [cite:43]；无任何创作能力，下载→创作一体化是 TokPure 的结构优势 |

结论（[MAJORITY]，多官网互证）：**下载器赛道低价高频但无创作纵深；创作工具要么云端订阅积分制、要么高价买断；「$9.9–29/月订阅 + 本地无限算力」的 TokPure 档位没有正面竞争者。**

### 3.2 创作者需求侧：字幕优先、多语言同发

- TikTok 官方 Symphony AI Dubbing 于 2024-06-17 发布，自动检测语种、转写、翻译并产出 10+ 语种配音 [cite:42]（[SINGLE-SOURCE]，行业博客转述官方 newsroom，发布事实可信，效果数据未独立验证）。平台亲自教育市场，用户已建立「一键多语」预期。
- 2026 年创作工作流观察出现「caption-first production」：拍摄时刻意为字幕留白、80pt 大字覆盖 [cite:49]；同一创作者用克隆声把一条录音本地化成多语种版本跨发，西语、巴西葡语被点名为大市场 [cite:44]。
- 中文选购指南显示小语种配音主流方案仍是微软 Azure TTS（140+ 语言，云 API、按字符计费）[cite:45]——这正是 TokPure 零云约束下要用本地多语种 TTS 替代的对象。

对产品的含义：**双语字幕（识别→翻译→双轨烧录）比「配音」更高频、更低成本，应先于 R6 交付；翻译质量由 R8 本地 LLM 保证，语种优先级对齐客户端已有界面语言：英、西、葡、法、德、日。**

### 3.3 开源选型时效核验

| 领域 | 候选 | 2026-10 状态 | 许可证 | 结论 |
|---|---|---|---|---|
| 智能剪辑 | auto-editor | 31.7.2（2026），2025-05 起用 Nim 重写、pip 停止发布 CLI、推荐二进制/包管理器；30.3 起支持 OpenTimelineIO 导出 [cite:11][cite:12] | Unlicense | **采用，以预编译二进制 sidecar 接入（不再走 pip）**；第一版甚至可零依赖纯 ffmpeg silencedetect 实现去停顿 |
| 镜头切分 | PySceneDetect | v0.7.1（2026-07），持续维护 [cite:10] | BSD-3 | 采用，供批量切分与 R9 抽帧 |
| 轻量 TTS | Kokoro 82M | 模型约 350MB，ONNX/Transformers.js 可纯 CPU/<1GB 显存，50+ 音色覆盖英/法/日/中/韩/西/葡等，美式英语打磨最好、中文可用但非最优 [cite:2][cite:4][cite:5] | 模型 Apache-2.0、kokoro-onnx MIT [cite:3] | **R6 默认档**；中文为主的用户引导到克隆档 |
| 声音克隆 | GPT-SoVITS | 成熟、中文克隆第一梯队、支持 30+ 语言、CPU 可异步出活 | MIT [cite:47] | **R6 高配档（异步任务）**，沿用 v2.5 结论 |
| 声音克隆 | CosyVoice2 | Apache-2.0、流式、中文方言强 [cite:7]；社区硬件指引建议 8GB 显存或 M2 Pro/16GB 统一内存跑量化 [cite:6]（[SINGLE-SOURCE]，第三方站点） | Apache-2.0 | 列为预研/高配档候选；8GB 基线前必须做 M1 8GB 实测 Spike，不进首发承诺 |
| 声音克隆 | IndexTTS2 / 2.5 | 2.5 支持中英日西阿、情感与时长控制；**官方仓库明确为 bilibili Model Use License，商用须邮件联系 indexspeech@bilibili.com**；网传 Apache-2.0 说法来自非官方站点 [cite:8][cite:9] | bilibili 模型许可（非 OSI） | **禁用，红线维持**；官方已声明唯一下载渠道为其 GitHub 且其他站点不被认可 [cite:8] |
| 录音降噪 | DeepFilterNet3 | 仍是 2025–2026 新项目集成首选（Rust 核心，被第三方音频 crate 集成为 deepfilter feature） | MIT/Apache | 采用，单文件 sidecar |
| 人声/BGM 分离 | Demucs（htdemucs v4） | 仍是音质基准方案 [cite:31]；PyTorch 依赖重，ONNX 转换可用 | MIT（代码） | 作为高质量档；模型随 sidecar 按需下载 |
| 人声/BGM 分离 | audio-separator + UVR ONNX 模型 | Python 包持续更新（0.31+），可直接加载 UVR 系 ONNX 权重（MDX-Net/BS-RoFormer 等），CPU 可跑 [cite:30] | 包 MIT；**各权重许可不一，发布前逐模型核对** | 作为轻量档与 Demucs 并存，权重许可列为发布阻断检查项 |
| 轻量分离（跟踪） | Moises-Light | 2025-10 论文，小参数量 Band-split U-Net [cite:46] | 论文阶段 | 仅技术跟踪 |
| ASR 中文增强 | SenseVoice（sherpa-onnx 承载） | sherpa-onnx 1.12.15（2025-10），离线 onnxruntime，C/C++/Node 等绑定 [cite:26][cite:27]；SenseVoice int8 在 Cortex-A55 四线程 RTF 0.175 [cite:24]；同体积下中文 CER 据称约为 Whisper small 的 1/2.7（厂商博客，[SINGLE-SOURCE]）[cite:25] | Apache-2.0 | **v2.6 补账：作为第二 ASR 引擎接入引擎市场**，中文用户默认推荐 |
| 文案 LLM | Qwen3-1.7B / 4B | llama.cpp b5092 起官方支持，Metal/Accelerate/CUDA/SYCL 全后端 [cite:13]；1.7B Q4_K_M 约 1.0GB，现代 i5 约 25–40 tok/s（社区测评）[cite:14]；4B 有 2507 更新版 [cite:15] | Qwen3 系 Apache-2.0 | **R8 主力**，1.7B 为 A/B 档默认、4B 为 S 档 |
| 集成框架 | node-llama-cpp | v3.19（2026-06），活跃，Qwen 为一等支持模型族，提供 macOS arm64 Metal 预编译包 [cite:32][cite:33] | MIT | 采用；避免自编译 native 模块 |
| 备选 LLM | Gemma 3n E2B/E4B | 有效内存架构（E2 档约 2GB 级），Google 官方提供端侧格式 [cite:18]；**许可为 Gemma Terms，允许商业用途但附带 Prohibited Use Policy 且非标准 OSI 许可** [cite:16][cite:17] | Gemma Terms | 仅备选，发布前法务复核；不默认打包 |
| 封面/视觉打分 | Qwen3-VL-2B | 2025-09-22 系列发布，10-22 增补 2B/32B，官方称手机可跑，2B 版下载量达千万级 [cite:19][cite:20][cite:21] | Qwen 系开放权重（按仓库 LICENSE 复核，通常 Apache-2.0） | **取代 v2.5 规划中的 Florence-2 成为 R9 首选**；多语种图文理解直接服务封面文案 |
| 视觉备选 | SmolVLM / SmolVLM2 | 256M 推理 <1GB 显存，500M 档加入视频理解 [cite:22][cite:23] | Apache-2.0 | 极低配档备选 |
| OCR（R3 补账） | RapidOCR + PP-OCRv5 mobile | 2026 年已到 3.6+，PP-OCRv5 mobile 单字匹配率约 0.92，检测+识别约 20MB，ONNX 单帧百毫秒级；社区已在集成 PP-OCRv6 [cite:28][cite:29] | Apache-2.0 | **立即采用**，是 R3 自动检测性价比最高的一步 |

---

## 四、v2.6 需求优先级总览

| 优先级 | 编号 | 需求 | 一句话价值 | 核心选型（许可证） | 体积增量 | 8GB 基线 |
|---|---|---|---|---|---|---|
| **P0** | C1 | R3 补账：文字水印自动检测 | 兑现「真 AI 去水印」承诺，用户可不点鼠标完成 | RapidOCR + PP-OCRv5 mobile ONNX（Apache-2.0）+ 现有 delogo | ≈ 25MB | ✅ |
| **P0** | C2 | 硬件分级落地：低配模式与任务护栏 | 长任务不崩、低端机不卡死，降低售后 | 自研（tier→线程/分辨率/倍率策略） | 0 | ✅ |
| **P0** | C3 | 平台补账：Windows/Intel Mac AI 侧车 | Windows 是更大的付费桌面市场，AI 不能只给 M1 | whisper.cpp 官方预编译包（MIT）+ ncnn win 资产实测 | 0（按需） | ✅ |
| **P0** | R5 | 智能剪辑（去停顿/切分） | 口播粗剪自动化，零学习成本 | 一期纯 ffmpeg silencedetect；二期 auto-editor 31.x 二进制（Unlicense）+ PySceneDetect（BSD-3） | 0 / ≈ 20MB | ✅ |
| **P0** | R8 | 离线文案助手 | 标题/标签/简介/合规自检，同时是翻译引擎 | node-llama-cpp（MIT）+ Qwen3-1.7B/4B Q4（Apache-2.0） | 1.1–2.5GB 按需 | ✅ |
| **P0** | R2+ | 双语字幕闭环 | 出海最高频需求，v2.5 欠账 | R8 翻译 → 现有烧录双轨 | 复用 R8 | ✅ |
| **P1** | C4 | AI 流水线串联 | 「下载→识别→字幕/去水印/增强」挂机批量 | 现有队列 + aijobs 单并发编排 | 0 | ✅ |
| **P1** | R7 | 人声/BGM 分离 + 录音降噪 | 提取干净人声、BGM 复用、口播降噪 | DeepFilterNet3（MIT/Apache）+ audio-separator ONNX（MIT，权重逐个核许可）/ Demucs 高质量档（MIT） | 10–180MB | ✅ 异步 |
| **P1** | R6 | 本地配音与音色克隆 | 无网出配音、多语种版本同发 | Kokoro 82M（Apache-2.0）默认；GPT-SoVITS（MIT）高配异步克隆 | 350MB / 克隆档 500MB+ | ✅ / ⚠️ 异步 |
| **P1** | R2e | SenseVoice 中文引擎 | 中文识别速度与准确率补强 | sherpa-onnx（Apache-2.0）+ SenseVoiceSmall int8 | ≈ 230–450MB | ✅ |
| **P2** | R9 | 智能封面/关键帧优选 | 动态封面智能化，Top3 候选 + 文案 | 启发式打分 + Qwen3-VL-2B Q4（Apache-2.0）；SmolVLM2-500M 极低配备选 | 1.5–2GB 按需 | ✅（S 档更佳） |
| **P2** | C5 | R4 工程加固 | 长视频可用：tile 分块、断点续跑、无 Vulkan 回退提示 | 自研 + ncnn `-t` 参数 | 0 | ✅ |
| **预研** | R10/R12 | 抠像 / 模板批量出片 | 沿 v2.5 规划（MediaPipe/BiRefNet-lite；Motion Canvas） | Apache/MIT | — | ✅ |
| **预研** | — | CosyVoice2 8GB 实测 Spike；IndexTTS2 许可谈判跟踪 | 决定克隆档是否升级 | Apache-2.0 / 待授权 | — | ❓ |

建议排期：**v2.6.0（约 4–5 周）= C1+C2+C3+R5+R8+R2+**；**v2.7.0（约 4 周）= R6+R7+R2e+C4**；R9 与 C5 视 v2.7 余量进入或沉 v2.8。

---

## 五、P0 需求详细定义

### C1 R3 补账：文字水印自动检测（检测 → 掩膜 → 现有 delogo 修复）

**用户故事**：下载的 TikTok 视频左上/右上用户名水印、片尾 Logo，不想手动框区域，期望「点一下自动去干净」。

**功能点**
1. 抽关键帧（首/中/尾 + 每隔 N 秒）跑 **RapidOCR（PP-OCRv5 mobile det+rec，约 20MB ONNX）**，文本框按时空聚类成稳定区域，自动生成掩膜时间轴，复用 v2.5 已交付的多区域时间轴 delogo2 管线与预览层
2. 启发式过滤：只对持续出现 ≥3 秒、位置固定、文本长度/位置符合水印特征（边缘区、含 @/TikTok 字样）的框生效，避免误伤字幕
3. 检测结果在预览层可一键开关、可手动增删区域（与手动模式共用 UI）
4. Logo 图标检测（PicoDet-S 自训 TikTok/抖音系 Logo）列为 P1 后续，本期不承诺；智能修复（IOPaint/可商用修复权重）不进本期，修复仍走 FFmpeg

**验收标准**
- 1080p 视频检测耗时 < 3 秒（M1）；静态用户名水印召回 ≥ 90%（内部样本集，≥ 50 条）
- 误检率 ≤ 5%：正常内嵌字幕不被当作水印
- 全流程「选择视频 → 自动检测 → 导出」零点击框选可完成；检测失败自动回退手动模式，不报错中断

**许可证**：RapidOCR Apache-2.0、PP-OCRv5 权重 Apache-2.0，发布前留档模型 LICENSE。

---

### C2 硬件分级落地：低配模式与任务护栏

**用户故事**：Intel 核显老笔记本跑超分直接卡死/闪退；8GB MacBook 开着浏览器再跑 RealSR 内存吃紧。

**功能点**
1. 引擎页已有 S/A/B 检测结果落地为策略：按档位对能力按钮置灰/标注（B 档：RealSR 禁用、RIFE 限 720p、模型默认最小档）
2. 「低配模式」开关（默认对 B 档开启）：限制 sidecar 线程数（物理核 ×0.6）、默认小模型、串行推理、超分强制输入降采样到 720p
3. 重型任务前置护栏：预估耗时与峰值内存（分辨率 × 帧数 × 倍率经验系数），超阈值二次确认；运行中内存超水位自动缩小 tile 或中止并保留已完成帧
4. 无 Vulkan/初始化失败：ncnn 失败一次后自动置灰该引擎并展示原因与排查建议（驱动/显卡型号），不允许反复崩溃

**验收标准**
- B 档机型任何任务不死机、不杀主进程；中止任务后临时帧目录自动清理
- S/A/B 判定与引擎可用矩阵在 M1（S）、至少一台 Intel/8GB（A 或 B）真机各验一遍

---

### C3 平台补账：Windows x64 与 Intel Mac 的 AI sidecar

**功能点**
1. **Whisper**：mac-arm64 沿用自编译 Metal 包；**win32-x64 与 darwin-x64 直接引用 whisper.cpp 官方 Release 预编译二进制**（含运行库），新增资产位与 SHA 校验，不再自编译
2. **ncnn 三件套**：enginehub 已配置 win32-x64 官方地址，需在 Windows 真机走通「下载→解压→跑帧→拼回」；验证 DYLD/Library 路径逻辑在 Windows 的等价物（exe 同目录 dll）、`windowsHide` 黑框已处理则回归
3. 引擎页不支持平台从「静态不支持」变为真实下载；安装/删除/镜像逻辑零分支差异
4. 打包：Windows NSIS 的 extraResources 只带 ffmpeg.exe，sidecar 仍全部按需下载

**验收标准**
- Windows 11 x64：字幕识别、Real-CUGAN 2x、RIFE 插帧各真实出片一条
- Intel Mac（x64）：至少 Whisper + RIFE 出片；无设备则在发布说明标注「实验性」

---

### R5 智能剪辑：去停顿与镜头切分

**用户故事**：口播素材 3 分钟剪掉「嗯啊」和空白后变 2 分钟；搬运素材按镜头自动切段供混剪。

**功能点（两期）**
1. **v2.6.0 一期（零新增依赖）**：纯 FFmpeg `silencedetect` 扫描静音段 → 时间码编辑器（可视化波形/静音条、阈值 dB 与最短停顿可调）→ 无损切割重排；保留「删除片段 vs 压缩静音」两种模式
2. **二期（引擎市场按需下载）**：auto-editor 31.x 预编译二进制（Nim 版，约 10–20MB，Unlicense；注意其 2025 年起不再发 pip 包 [cite:11]）支持基于运动画面的剪辑（非口播场景）；PySceneDetect（BSD-3，v0.7.1 持续维护 [cite:10]）做镜头切分，输出片段列表供批量导出，并为 R9 提供镜头边界
3. 剪辑结果可直接送入 R2 字幕 / R4 增强（复用任务编排）

**验收标准**
- 3 分钟口播一期处理 < 10 秒（仅音频分析 + 流复制切割时近似无损秒出）
- 误剪可撤销：时间码编辑提供预览播放与恢复；导出文件命名与现有媒体库一致
- 全程离线

---

### R8 离线文案助手（兼双语字幕翻译引擎）

**用户故事**：视频跑完字幕后，一键得到多平台标题、描述、标签/Hashtag；要发西语市场，字幕自动出西语轨；全部离线，不花钱不泄密。

**功能点**
1. **推理底座**：node-llama-cpp（MIT，v3.x 活跃、Qwen 一等支持、macOS arm64 Metal 有预编译包 [cite:32][cite:33]），以 sidecar/Node addon 形态纳入引擎市场，沿用下载/镜像/删除 UI
2. **模型**：Qwen3-1.7B Q4_K_M（约 1.1GB）为 A/B 档默认，Qwen3-4B（2507 更新版 [cite:15]，Q4 约 2.5GB）为 S 档可选；llama.cpp b5092+ 支持 Qwen3 [cite:13]
3. **功能**：以识别字幕 + 视频元数据为输入，产出多平台标题/简介/标签/Hashtag（可编辑、可重roll、一键复制）；字幕翻译（zh↔en/es/pt/fr/de/ja，对齐客户端界面语种）；中文合规敏感词自检（本地词表 + 模型判断双保险）
4. **R2+ 双语字幕**：翻译结果以双语上下轨 ASS/SRT 烧录（v2.5 烧录管线扩展样式：主副轨字号差、位置、描边模板）
5. 检测到本机已装 Ollama 可选择接入（沿用 v2.5 规划），但不依赖

**验收标准（8GB 基线）**
- M1：1.7B 冷启动 < 5 秒，生成 10 条标题 < 15 秒；i5 六代：1.7B ≥ 20 tok/s（社区基准为现代 i5 25–40 tok/s [cite:14]，老 i5 放宽）
- 翻译 1 分钟字幕（约 150 字）< 20 秒；术语/时间轴不错位，双轨烧录帧率一致
- 推理期间 UI 不卡死（streaming 输出）；内存峰值 ≤ 2.5GB
- 模型未下载时功能按钮引导下载，不做任何云端回退请求

**许可证备注**：Qwen3 权重 Apache-2.0；Gemma 3n 仅备选且其 Gemma Terms 含禁止用途政策、非标准 OSI 许可 [cite:16][cite:17]，不进默认模型位。

---

## 六、P1/P2 需求摘要

- **C4 AI 流水线串联**：下载任务完成事件可触发 AI 编排（识别→翻译→烧录 / 去水印 / 超分），队列 UI 复用现有批量队列；aijobs 保持全局单并发，队列侧只做排队与顺序唤起；支持失败单步重试不重跑前序。
- **R7 降噪/分离**：DeepFilterNet3（模型约 10MB，远超实时）处理录音/口播降噪；分离轻量档用 audio-separator 生态的 UVR ONNX 权重（MDX-Net，CPU 友好）[cite:30]，高质量档 Demucs v4 异步 [cite:31]；输出人声/伴奏/鼓/贝斯分轨供二次创作。**权重逐个核对许可证并在引擎页展示，不接受非商用权重。**
- **R6 配音**：默认 Kokoro 82M（Apache-2.0，纯 CPU 可跑、<1GB 显存 [cite:1][cite:5]；含普通话但英文音色最成熟 [cite:4]），固定预览文案、男声参考必出男声、合成后立即试听；高配克隆档 GPT-SoVITS（MIT）CPU 异步 [cite:47]，用户上传参考音的授权链路做勾选承诺；克隆质量先给「克隆声 + 多语文案」跨发场景（对接 R2/R8 的翻译结果）。CosyVoice2（Apache-2.0 [cite:7]）因社区硬件指引指向 8GB 显存/16GB 统一内存 [cite:6]，仅立项 Spike 验证 M1 8GB，不进承诺；IndexTTS2/2.5 维持禁用。
- **R2e SenseVoice 引擎**：sherpa-onnx（Apache-2.0，离线 onnxruntime，2025-10 仍高频更新 [cite:26][cite:27]）+ SenseVoiceSmall int8（约 230–450MB），低端核 RTF 0.175 量级 [cite:24]；中文短视频默认引擎，Whisper 保留给多语种/音乐场景；引擎市场并列安装。
- **R9 智能封面**：PySceneDetect 镜头边界抽帧 → 清晰度/人脸占比/运动幅度启发式初筛 → Qwen3-VL-2B Q4（2025-10 发布、手机可跑 [cite:20][cite:21]）做内容可看性打分输出 Top3，并由 R8 给出封面文案；极低配档可退 SmolVLM2-500M（<1GB [cite:23]）。多模态在 node-llama-cpp/llama.cpp 的工程成熟度需先做一周 Spike，不通过则仅交付启发式版本。
- **C5 R4 加固**：ncnn `-t` tile 分块暴露为自动策略、输出帧断点续跑、RealSR 长视频输入尺寸护栏、耗时预估（M1 实测 RealSR 4x 约 10 秒/帧，必须在 UI 明示）。

---

## 七、硬件分档矩阵（v2.6 更新）

| 档位 | 判定 | 新增可用能力 |
|---|---|---|
| S（M 系列 / 独显 + Vulkan） | 全部 | Qwen3-4B、Qwen3-VL-2B、Demucs 高质量档、GPT-SoVITS、RealSR 4x、长任务 |
| A（i5 六代+/8GB/核显） | 主流 | Qwen3-1.7B、Kokoro、DeepFilter、UVR-MDX ONNX、RIFE≤1080p、Real-CUGAN 2x、SenseVoice |
| B（<8GB/老 CPU/无 Vulkan） | 保底 | Qwen3-1.7B（限并发）、Kokoro、去停顿、OCR 去水印、Whisper tiny/SenseVoice int8；超分/分离/Demucs 置灰并说明 |

统一护栏：预估耗时/内存 → 超阈值二次确认 → 限线程/降采样/小模型自动降级 → 崩溃可续跑（沿用 v2.5 既定原则，本期 C2 首次实现）。

---

## 八、许可证与合规清单（发布前 Checklist）

- **禁止集成**：IndexTTS2/2.5（bilibili Model Use License，商用须官方授权 [cite:8]）、ProPainter/E2FGVI/big-lama 原始权重、F5-TTS、XTTS、Wav2Lip/DH_live（沿用 v2.5 红线）
- **条款需法务复核**：Gemma 3n（Gemma Terms + Prohibited Use Policy，非 OSI 标准许可 [cite:16][cite:17]）；Qwen3-VL 各尺寸按模型仓库 LICENSE 逐档留档
- **权重逐个核对**：audio-separator/UVR 系每个 ONNX 权重的来源许可；GPT-SoVITS 用户上传克隆音声需产品内授权承诺与 AI 生成标识提示（行业监管趋势已要求 AI 配音内容披露 [cite:44]）
- **放心商用主力**：auto-editor（Unlicense）、PySceneDetect（BSD-3）、Kokoro（Apache-2.0）、GPT-SoVITS（MIT）、DeepFilterNet（MIT/Apache）、Demucs（MIT）、Qwen3/Qwen3-VL（Apache-2.0）、node-llama-cpp（MIT）、RapidOCR/PP-OCRv5（Apache-2.0）、sherpa-onnx/SenseVoice（Apache-2.0）、SmolVLM2（Apache-2.0）
- 所有 sidecar 在引擎页展示 LICENSE 与来源链接；去水印功能保留合规使用声明（沿用现状）

---

## 九、主要风险与对策

1. **R8 体验风险**：1.7B 模型的西/葡/德/日翻译质量可能不及云端大模型。对策：首版限定「字幕翻译」场景（短句、上下文窗口小、术语表注入），提供「原文/译文可编辑」兜底；不追求文学翻译，目标是可发布水准；翻译质量在 6 个语向各做 ≥ 30 条盲评。
2. **node-llama-cpp 打包风险**：native 模块在 Electron 版本/arm64/x64 下的重建问题。对策：优先使用官方预编译二进制 [cite:33]，Spike 先行（1 周内验证打包与 notarization），失败则退回独立 llama.cpp server sidecar 方案（HTTP loopback）。
3. **Windows 长尾**：ncnn Vulkan 在 Intel 核显/老驱动的失败率高于 Mac。对策：C3 真机矩阵 + 一次性失败自动禁用 + 可复制的诊断信息；Windows 首版 AI 能力允许标注「Beta」。
4. **OCR 误伤**：TikTok 视频内嵌硬字幕与用户名水印形态接近。对策：时序稳定性 + 位置 + 词典三重过滤，默认只勾选高置信区域，用户可一键全不选。
5. **Kokoro 中文质量**：其普通话音色打磨弱于英文 [cite:4]。对策：UI 如实标注音色语言；中文场景引导 GPT-SoVITS 克隆档；不在营销中宣称中文配音 SOTA。
6. **包体积与首启下载疲劳**：v2.6 模型总量（LLM+TTS+ASR+视觉）理论可达 4–5GB。对策：引擎市场按场景推荐（不装就不提示）、模型删除入口保持显眼、每个功能首用处说明「仅下载一次」。
7. **竞品平台化**：CapCut 等持续把 AI 能力打包进低价订阅并由云厂商补贴 [cite:36]。TokPure 不可拼功能数量，必须坚持「隐私离线 + 一次订阅无限跑 + 低配可跑」的差异叙事，官网与应用内文案在 v2.6 同步更新。

---

## 十、版本节奏建议

- **v2.6.0 创作版·上（P0，约 4–5 周）**：C1 OCR 自动去水印 → C2 低配护栏 → C3 Windows/Intel 侧车 → R5 智能剪辑（一期零依赖）→ R8 文案助手 → R2+ 双语字幕闭环
- **v2.7.0 声音与流水线（约 4 周）**：R6 配音（Kokoro + GPT-SoVITS）→ R7 降噪分离 → R2e SenseVoice → C4 下载-AI 流水线；含 R5 二期 auto-editor
- **v2.8.0 视觉与量产**：R9 智能封面（视 Spike）、C5 R4 长视频加固、R10 抠像预研
- R12 模板出片、R13 数字人沿 v2.5 结论继续预研，不排期

---

## 参考来源

- [cite:1] Kokoro TTS: Lightweight 82M Browser Text-to-Speech Guide — https://kokoroweb.app/en/blog/kokoro-tts-lightweight-browser-text-to-speech
- [cite:2] Kokoro TTS: Efficient Text-to-Speech Model（模型 350MB、语种、Apache-2.0）— https://kokorotts-ai.com/about
- [cite:3] kokoro-onnx · PyPI（kokoro-onnx MIT、Kokoro 模型 Apache-2.0）— https://pypi.org/project/kokoro-onnx/0.4.9/
- [cite:4] Kokoro TTS 评测：82M 开源音色模型（54 音色、英文最成熟）— https://www.visionstory.ai/zh-cn/open-source/kokoro-tts
- [cite:5] Best TTS Model for Every Use Case in 2026 — https://voicecreator.pro/blog/best-tts-model-for-every-use-case
- [cite:6] What Hardware Runs CosyVoice 2.0（第三方硬件指引，单来源）— https://www.madebyagents.com/models/cosyvoice-2-0
- [cite:7] CosyVoice: Multilingual TTS（Apache-2.0）— https://cosyvoice.art/
- [cite:8] index-tts 官方仓库（bilibili Model Use License、商用联系方式、2.5 语种）— https://github.com/index-tts/index-tts
- [cite:9] IndexTTS 2 — OpenSpeech（许可证：Bilibili Model Use License）— https://www.openspeech.dev/models/indextts2
- [cite:47] GPT-SoVITS – AI Voice Cloning & TTS（MIT）— https://gpt-sovits.org/
- [cite:10] PySceneDetect 官网（Latest v0.7.1, 2026-07）— https://www.scenedetect.com/
- [cite:11] auto-editor 包信息（31.7.2、pip 停发、OpenTimelineIO）— https://pkg.so/fr/brew/auto-editor/
- [cite:12] Basswood-io Blog（auto-editor Nim 重写时间线）— https://basswood.io/blog/
- [cite:13] Qwen 官方文档：llama.cpp（b5092 支持 Qwen3、Metal 等后端）— https://qwen.readthedocs.io/zh-cn/latest/run_locally/llama.cpp.html
- [cite:14] Fastest Local LLMs for Low-End PCs 2026（社区测评，单来源）— https://www.promptquorum.com/es/local-llms/fastest-local-llms-low-end-pcs
- [cite:15] Qwen3-4B-Instruct-2507 GGUF — https://skywork.ai/blog/models/qwen3-4b-instruct-2507-gguf-free-chat-online-skywork-ai/
- [cite:16] Gemma 3n 模型简介（Google AI 官方文档，商业使用条款）— https://ai.google.dev/gemma/docs/gemma-3n
- [cite:17] Gemma 3n 许可证全文（Use Restrictions / Prohibited Use Policy）— https://ollama.com/bjoernb/gemma3n-e4b:latest/blobs/1adbfec9dcf0
- [cite:18] Google AI Edge MediaPipe LLM Inference（E2B/E4B 端侧格式）— https://developers.google.com/edge/mediapipe/solutions/genai/llm_inference
- [cite:19] Qwen3-VL 模型尺寸总览（2B/4B/8B/32B + MoE）— https://qwen3lm.com/qwen-vl/
- [cite:20] IT之家：Qwen3-VL 新增 2B、32B，手机也能跑（2025-10-22）— http://m.toutiao.com/group/7563919272255160873/
- [cite:21] Qwen 模型目录（Qwen3-VL 2025-09-22 发布、2B 下载量）— https://tongyis.com/models/
- [cite:22] SmolVLM 论文（256M <1GB 显存）— https://arxiv.org/html/2504.05299v1
- [cite:23] HuggingFace：VLM 2025（SmolVLM2 500M 视频理解）— https://huggingface.co/blog/VirtualOasis/vlms-2025-zh-translation
- [cite:24] sherpa-onnx 官方文档：SenseVoice RTF（Cortex-A55 int8）— https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html
- [cite:25] FunASR on llama.cpp — Whisper.cpp Alternative for Chinese ASR（厂商博客，CER 对比单来源）— https://www.funasr.com/en/blog/funasr-llama-cpp-whisper-cpp-alternative.html
- [cite:26] sherpa-onnx · PyPI 1.12.15（2025-10-22）— https://pypi.org/project/sherpa-onnx/1.12.15/
- [cite:27] k2-fsa/sherpa-onnx 官方仓库（离线 onnxruntime、多语言绑定）— https://patch-diff.githubusercontent.com/k2-fsa/sherpa-onnx
- [cite:28] RapidOCR 官方文档：RapidOCR 与 PaddleOCR 对比（3.6.0、PP-OCRv5 指标）— https://rapidai.github.io/RapidOCRDocs/latest/blog/2026/02/06/rapidocr-vs-paddleocr/
- [cite:29] RapidOCR 集成 PP-OCRv6 Rec 记录 — https://rapidai.github.io/RapidOCRDocs/main/en/blog/2026/06/18/rapidocr-%E9%9B%86%E6%88%90-pp-ocrv6-rec-%E6%A8%A1%E5%9E%8B%E8%AE%B0%E5%BD%95/
- [cite:30] audio-separator · PyPI（UVR ONNX 权重、多轨分离）— https://pypi.org/project/audio-separator/0.31.0/
- [cite:31] 人声分离模型推荐：UVR / Demucs / Spleeter（社区对比，P3）— https://blog.csdn.net/Angry_Mills/article/details/154933703
- [cite:32] node-llama-cpp 官方博客（v3.19、Qwen/Gemma 支持）— https://node-llama-cpp.withcat.ai/blog/
- [cite:33] @realtimex/node-llama-cpp-mac-arm64-metal（macOS Metal 预编译包）— https://www.npmjs.com/package/@realtimex/node-llama-cpp-mac-arm64-metal
- [cite:34] CapCut Desktop Download（Pro $7.99/月、$74.99/年、自动字幕）— https://www.capcut.com/resource/capcut-desktop-download/
- [cite:35] CapCut Standard vs Pro（$19.99/月等区域价格）— https://www.capcut.com/resource/capcut-standard-vs-pro
- [cite:36] CapCut Free Video Editing Software with AI Tools（Veo 3 / Seedream 4.0 云端 AI）— https://www.capcut.com/tools/video-editing-software
- [cite:37] CapCut Pro PC（800 月度积分）— https://www.capcut.com/resource/capcut-pro-pc
- [cite:38] VideoProc Converter AI 定价与功能（$34.95 起、超分/插帧/人声分离/降噪）— https://www.videoproc.com/video-converting-software/feature-free-vs-full.htm ；https://www.videoproc.com/video-converting-software/buy.htm
- [cite:39] UniFab AI Video Enhancer 对比页（UniFab $319.99、Topaz $299/年、HitPaw $350.39）— https://unifab.ai/ai-video-enhancer.htm
- [cite:48] HitPaw 2026 促销页（会员积分与定价）— https://www.hitpaw.com/sales-promotion.html
- [cite:41] 4K Tokkit 许可证价格（免费/€15 年/€20–36 终身）— https://www.4kdownload.com/products/tokkit/17
- [cite:43] 4K Tokkit 25.4 Apple Silicon 原生（2025-10-10）— https://www.4kdownload.com/blog/2025/10/10/4k-tokkit-optimized-for-apple-silicon/
- [cite:42] TikTok Symphony AI Dubbing vs CapzAi 2026（2024-06-17 发布、10+ 语种）— https://capzai.com/en/blog/tiktok-symphony-ai-dubbing-vs-capzai-2026
- [cite:49] Caption Language Trends 2026 — https://capzai.com/en/blog/caption-language-trends-2026
- [cite:44] TikTok AI Voice Trends 2027（多语种同创作者跨发、AI 披露要求）— https://www.voxbooster.com/blog/voice-changer-for-tiktok-ai-trends-2027/
- [cite:45] 2026 多语言/小语种 AI 配音选购指南（Azure TTS 140+ 语言）— https://g.pconline.com.cn/zhikeji/article/1651082
- [cite:46] Moises-Light: Resource-efficient Band-split U-Net（2025-10 论文）— https://arxiv.org/html/2510.06785
