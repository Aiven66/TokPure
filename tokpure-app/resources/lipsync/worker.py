#!/usr/bin/env python3
"""TokPure — 本地口型同步（Wav2Lip 96 + 原片高清嘴部回贴）。

输入：已经切片好的口播画面（mp4）+ 目标语言配音（wav，含整段静音填充）
输出：口型跟着配音走的新视频（画面保留原片构图、头部动作、背景）

设计要点：
1. 全程离线：模型权重与代码都在本机，进程内不发任何网络请求；
2. 音频驱动先于口型：配音定稿后再逐帧重绘嘴部，绝不边合成边对齐；
3. **口型重定时（主路径）**：Wav2Lip 的 96×96 输出只用来判断「这一帧该张多大嘴」，
   像素一律取自原片——从原片里挑一张嘴型最接近、且清晰度达标的同一个人「嘴部供体」，
   用 ORB 相似变换对齐后羽化回贴。原片是 800~1080p，嘴部有真实唇线、牙缝、胡渣，
   所以不会再出现「96×96 插值放大 → 发蜡、唇部糊成一团」的老问题；
4. 头部晃动、手势、景别全部保留；人脸检测用 OpenCV 级联（Apache-2.0），
   检测结果 5 帧滑动平均，避免检测框抖动导致嘴部闪烁；
5. 视频解码/编码都走 ffmpeg 管道（bgr24 rawvideo），两遍流式：第一遍只留人脸框与
   嘴部小补丁（绝不把整条视频的所有帧留在内存，82s 视频以前要占 6GB 以上），
   第二遍逐批推理+回贴+编码；
6. 供体不足（<6 张，例如原片全程模糊）时退回「超分 / 反卷积」回贴，任务不中断。

调试约定：进度与分析信息以 `@@PROG {json}` 单行写 stdout，其余日志写 stderr。
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys

import numpy as np


def emit(**kw):
    sys.stdout.write('@@PROG ' + json.dumps(kw, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + '\n')
    sys.stderr.flush()


# ---------------------------------------------------------------- 音频特征
# 与原版 audio.py 保持完全一致（n_fft=800 / hop=200 / 80 mel / fmin=55 / fmax=7600），
# 任何一处改动都会让权重读到的特征分布偏移，嘴型会整体错位。
SAMPLE_RATE = 16000
N_FFT = 800
HOP = 200
WIN = 800
N_MELS = 80
FMIN = 55
FMAX = 7600
PREEMPHASIS = 0.97
REF_LEVEL_DB = 20.0
MIN_LEVEL_DB = -100.0
MAX_ABS = 4.0
MEL_STEP = 16

_mel_basis = None


def load_wav(path, sr=SAMPLE_RATE):
    import librosa
    wav, _ = librosa.load(path, sr=sr, mono=True)
    return wav


def melspectrogram(wav):
    import librosa
    global _mel_basis
    from scipy import signal
    y = signal.lfilter([1, -PREEMPHASIS], [1], wav) if PREEMPHASIS else wav
    D = librosa.stft(y=y, n_fft=N_FFT, hop_length=HOP, win_length=WIN)
    if _mel_basis is None:
        _mel_basis = librosa.filters.mel(sr=SAMPLE_RATE, n_fft=N_FFT, n_mels=N_MELS, fmin=FMIN, fmax=FMAX)
    S = np.dot(_mel_basis, np.abs(D))
    min_level = np.exp(MIN_LEVEL_DB / 20 * np.log(10))
    S = 20 * np.log10(np.maximum(min_level, S)) - REF_LEVEL_DB
    S = np.clip((2 * MAX_ABS) * ((S - MIN_LEVEL_DB) / (-MIN_LEVEL_DB)) - MAX_ABS, -MAX_ABS, MAX_ABS)
    return S


def mel_chunks(mel, fps):
    """每帧画面取 16 个 mel 窗口（80Hz 帧率 / 视频 fps = 每帧跨过的 mel 帧数）"""
    step = 80.0 / max(1.0, fps)
    out = []
    i = 0
    total = mel.shape[1]
    if total < MEL_STEP:
        # 极短配音（不足 0.1 秒）补齐到一帧窗口，避免后面 reshape 时维度对不上
        mel = np.pad(mel, ((0, 0), (0, MEL_STEP - total)), mode='edge')
        total = MEL_STEP
    while True:
        start = int(i * step)
        if start + MEL_STEP > total:
            out.append(mel[:, total - MEL_STEP:])
            break
        out.append(mel[:, start:start + MEL_STEP])
        i += 1
    return out


# ---------------------------------------------------------------- 视频探测
def probe_video(ffmpeg, video):
    p = subprocess.run([ffmpeg, '-hide_banner', '-i', video],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    text = (p.stderr or '') + (p.stdout or '')
    m = re.search(r'Video:.*?(\d{2,5})x(\d{2,5})', text)
    if not m:
        raise RuntimeError('无法读取视频画面尺寸')
    w, h = int(m.group(1)), int(m.group(2))
    fm = re.search(r'(\d+(?:\.\d+)?)\s*fps', text)
    fps = float(fm.group(1)) if fm else 25.0
    dm = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', text)
    dur = 0.0
    if dm:
        dur = float(dm.group(1)) * 3600 + float(dm.group(2)) * 60 + float(dm.group(3))
    return w if w % 2 == 0 else w - 1, h if h % 2 == 0 else h - 1, fps, dur


class FrameReader:
    """ffmpeg 解码成 bgr24 原始帧，按需读一帧"""

    def __init__(self, ffmpeg, video, w, h, fps):
        self.w, self.h = w, h
        self.proc = subprocess.Popen(
            [ffmpeg, '-v', 'error', '-i', video,
             '-vf', 'scale=%d:%d:flags=bicubic' % (w, h), '-r', str(fps),
             '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=w * h * 3)

    def read(self):
        buf = self.proc.stdout.read(self.w * self.h * 3)
        if not buf or len(buf) < self.w * self.h * 3:
            return None
        # 管道里是未压缩的 bgr24，直接 reshape 即可（imdecode 只接受压缩过的图片数据）
        return np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 3).copy()

    def close(self):
        try:
            self.proc.stdout.close()
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass


class FrameWriter:
    """原始帧直接进 ffmpeg 编码；配音作为第二条输入，出片即带目标语言音轨"""

    def __init__(self, ffmpeg, out, audio, w, h, fps, crf):
        self.w, self.h = w, h
        self.proc = subprocess.Popen(
            [ffmpeg, '-y', '-v', 'error',
             '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', '%dx%d' % (w, h), '-r', str(fps), '-i', '-',
             '-i', audio,
             '-map', '0:v', '-map', '1:a',
             '-c:v', 'libx264', '-crf', str(crf), '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
             '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
             '-shortest', '-movflags', '+faststart', out],
            stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, frame):
        self.proc.stdin.write(np.ascontiguousarray(frame).tobytes())

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=120)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


# ---------------------------------------------------------------- 人脸检测
class FaceTracker:
    """级联检测 + 5 帧滑动平均 + 缺帧沿用上一帧

    口播是固定机位正面单人，级联分类器足够稳；关键是「平滑」：
    原始检测框逐帧抖动 2~4px 时，回贴的嘴部会像在抖，肉眼看比不同步还难受。
    """

    def __init__(self, pads):
        import cv2
        self.cv2 = cv2
        self.pads = pads
        path = os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml')
        self.cascade = cv2.CascadeClassifier(path)
        if self.cascade.empty():
            raise RuntimeError('人脸检测器加载失败')

    def detect(self, frame, box=None):
        cv2 = self.cv2
        h, w = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # 缩到 480 宽再检测：1080p 上全尺寸检测一帧要 30ms 以上，缩小后约 5ms
        scale = 480.0 / max(1, w)
        if scale < 1:
            small = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            f = scale
        else:
            small, f = gray, 1.0
        min_size = max(24, int(small.shape[1] * 0.12))
        faces = self.cascade.detectMultiScale(small, scaleFactor=1.1, minNeighbors=5,
                                              minSize=(min_size, min_size))
        if len(faces) == 0:
            return box
        # 单人场景取最大的人脸；多人画面本来就不适合口型重绘，但至少别选错人
        x, y, fw, fh = max(faces, key=lambda r: r[2] * r[3])
        if f != 1.0:
            x, y, fw, fh = [int(v / f) for v in (x, y, fw, fh)]
        pady1, pady2, padx1, padx2 = self.pads
        box = [max(0, x - padx1), max(0, y - pady1), min(w, x + fw + padx2), min(h, y + fh + pady2)]
        return box

    def fill_and_smooth(self, boxes, t=5):
        n = len(boxes)
        # 先补缺帧：中间沿用前一个有效框，开头缺的用第一个有效框
        first = next((b for b in boxes if b), None)
        last = first
        out = []
        for b in boxes:
            if b:
                last = b
            out.append(last)
        # 官方 get_smoothened_boxes 的等价实现：向前取 5 帧均值
        if n < 2:
            return out
        sm = []
        for i in range(n):
            window = out[i:i + t] if i + t <= n else out[n - t:]
            sm.append([int(round(v)) for v in np.mean(window, axis=0)])
        return sm


def clip_box(b, w, h):
    x1, y1, x2, y2 = b
    return max(0, int(x1)), max(0, int(y1)), min(w, int(x2)), min(h, int(y2))


def expand_face_box(b, w, h):
    """把检测框向下、向两侧扩一点，保证「下巴在框内」。

    Haar 检测框在眼镜/刘海下常常只到嘴，下巴被切掉：
    - 口型模型的裁片少了半个下巴，嘴被推到裁片最下沿，重绘结果的下唇会缺失；
    - 嘴部 ROI 按框高比例换算时，也会把下唇/下巴漏在外面。
    扩量按框尺寸比例（下 20%、左右各 5%），比固定像素更适应不同景别。
    """
    x1, y1, x2, y2 = b
    bw, bh = x2 - x1, y2 - y1
    return [max(0, int(x1 - bw * 0.05)), max(0, y1),
            min(w, int(x2 + bw * 0.05)), min(h, int(y2 + bh * 0.20))]


def stabilize_boxes(raw, w, h):
    """人脸框时序稳定化：大框才是「整张脸」，小框只能弃用。

    这张素材里戴了反光眼镜，Haar 会在「整脸」和「只有上半张脸」之间来回跳
    （实测同一秒里 535×545 与 256×266 交替出现）。5 帧平均后会得到一个
    「半张脸的框」——嘴部椭圆直接被算到眼睛上，回贴就成了把嘴糊到眼镜上。
    这里用「全片面积 90 分位」作为真实脸大小的参照，只接受面积 ≥45% 的框，
    并且要求与上一帧接受的框尺寸/位置相容（防止突变）；连续 30 帧都不相容、
    且新候选本身仍是「整张脸大小」的框时，才认为是机位/景别真的变了，重新锁定。
    """
    areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in raw if b]
    if not areas:
        return raw
    ref = float(np.percentile(areas, 90)) if len(areas) >= 5 else float(max(areas))
    min_area = ref * 0.45
    est = None
    misses = 0
    out = []
    for b in raw:
        if b is None:
            out.append(est)
            continue
        bw, bh = b[2] - b[0], b[3] - b[1]
        area = bw * bh
        if est is None:
            if area >= min_area:
                est, misses = b, 0
        else:
            ew, eh = est[2] - est[0], est[3] - est[1]
            size_ok = abs(np.log(max(1e-3, bw / max(1, ew)))) < 0.30 \
                and abs(np.log(max(1e-3, bh / max(1, eh)))) < 0.30
            dx = (b[0] + b[2]) / 2 - (est[0] + est[2]) / 2
            dy = (b[1] + b[3]) / 2 - (est[1] + est[3]) / 2
            pos_ok = abs(dx) < 0.30 * ew and abs(dy) < 0.30 * eh
            if area >= min_area and size_ok and pos_ok:
                est, misses = b, 0
            else:
                misses += 1
                # 重新锁定的前提是「新候选本身还得是一张脸」。
                # 以前的逻辑只要连续 20 帧不相容就无条件接受当前检测框，于是把画面底部
                # 紫色挂绳上的误检当成脸，ROI 直接落到画外，回贴进去的是供体的背景像素
                # （成片里那块灰白噪点补丁就是这么来的），口型自然也全错。
                if misses >= 30 and area >= min_area * 0.85:
                    est, misses = b, 0
        out.append(est)
    if not any(out):
        # 全片没有一张达到参照面积（脸特别小或检测全错）：退回逐帧最大框，保持旧行为
        return raw
    return out


# ---------------------------------------------------------------- 口型重定时
# 病根：口型模型是 96×96 的整脸图，一张 700px 的脸缩进去，嘴只剩约 34px。
# 把这个 34px 的嘴插值放大到 200~500px，无论反卷积、USM 还是 Real-ESRGAN 超分，
# 都只能「把糊边推亮/推平」——超分实测拉普拉斯方差反而从 20.4 掉到 4.4，越洗越塑料。
# 唯一能让唇线、牙缝、胡渣是真像素的办法：像素全部取自原片的高分辨率嘴部。
# 做法（已用真实素材验证：嘴部清晰度指标 15.9 → 31.9，原片 43.7，速度 48ms/帧）：
#   1) 第一遍扫原片，按「描述子相近 + 尺寸相近」去重，收集 200+ 张高清嘴部补丁；
#   2) 每帧把 Wav2Lip 的 96×96 结果放大成「目标嘴型描述子」；
#   3) 在供体库里找描述子最接近的一张（同一个人、同一机位，只是嘴型不同）；
#   4) ORB + RANSAC 估计供体→当前帧的相似变换，LANCZOS4 变形后羽化 + 低频对色回贴。
# 下缘从 1.02 收到 0.90：人脸框（Haar 再往下扩了 20%）的下沿在脖子位置，
# 1.02 会把颈部和紫色挂绳一起抠进供体补丁，回贴后就是「嘴唇上一块紫黑色」。
# 0.90 正好落在下巴尖，嘴部、下唇、下巴都在补丁内，脖子与衣物被排除。
ROI = (0.16, 0.55, 0.84, 0.90)   # 嘴部补丁相对人脸框（上缘含鼻底，下缘齐下巴）
# 实测（oral-src2 全片 7 个采样点，取 ROI 中间 40% 列统计逐行暗像素占比）：
# 鼻腔在上 0~15%，人中 20~38%，**嘴唇 40~75%，暗腔峰值落在 44%~65%，平均 55%**，
# 75% 以下是下巴与颈阴影。所以描述子/对色/张开度都只取 0.34~0.80 这一段（嘴唇本体），
# 否则鼻孔的高对比纹理会盖过嘴唇张合，pick 选到的供体跟目标嘴型几乎无关。
MOUTH_BOX = (0.20, 0.34, 0.80, 0.80)  # 嘴唇子窗（相对 ROI）
DESC = (40, 24)                  # 嘴型描述子尺寸（灰度）
MIN_LAP = 20.0                   # 供体整块清晰度门槛（拉普拉斯方差）
MIN_BLAP = 30.0                  # 供体「唇部」清晰度门槛：低于此值贴上去就是一团粉红
MAX_DONORS = 240                 # 供体上限：约 40~110MB，16GB 机器上留足推理余量
NEAR_WIN = 10                    # 优先在当前帧 ±10 帧（约 0.45s）内挑供体
OPEN_W = 26.0                    # 张嘴程度不匹配的罚分系数（0.1 的差 ≈ 2.6 分）
CHROMA_CLAMP = 14.0              # 唇色偏移上限（LAB 的 a/b 通道），防止把唇彩改成别的颜色


class MouthRetimer:
    """原片高清嘴部供体库 + 逐帧重定时"""

    def __init__(self, w, h):
        import cv2
        self.cv2 = cv2
        self.w, self.h = w, h
        self.donors = []
        self.masks = {}
        self.orb = cv2.ORB_create(nfeatures=400, fastThreshold=12)
        self.bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        self._desc_stack = None
        self._bw = np.zeros(0, np.float32)
        self._blap = np.zeros(0, np.float32)
        self._open = np.zeros(0, np.float32)
        self._open_rank = np.zeros(0, np.float32)
        self._open_sorted = np.zeros(0, np.float32)
        self._idx = np.zeros(0, np.int32)
        self.last_pick = -1
        self.stats = {'affine': 0, 'lip': 0, 'fallback': 0, 'skip': 0, 'score': [], 'openpen': []}
        # 诊断用（TP_LIP_DEBUG=1 时逐帧记录清晰度链路），生产运行零开销
        self.dbg = os.environ.get('TP_LIP_DEBUG') == '1'
        if self.dbg:
            self.dbg_rows = []

    @property
    def count(self):
        return len(self.donors)

    def roi_rect(self, box):
        x1, y1, x2, y2 = box
        bw, bh = max(1, x2 - x1), max(1, y2 - y1)
        return (max(0, int(x1 + bw * ROI[0])), max(0, int(y1 + bh * ROI[1])),
                min(self.w, int(x1 + bw * ROI[2])), min(self.h, int(y1 + bh * ROI[3])))

    def mouth_of(self, patch):
        """ROI 里「嘴唇这一块」的子窗口（相对 ROI 坐标）。

        以前描述子直接拿整块 ROI 算：鼻孔、鼻翼、下巴的纹理在每一帧都一样，
        它们的能量远大于「嘴唇张合」这点变化，归一化之后描述子只剩鼻腔和下巴，
        于是 pick 选到的供体跟目标嘴型几乎无关——实测成片会出现「目标闭嘴、
        贴上来的却是大张嘴」，下唇多出一块暗色口腔阴影（就是用户看到的糊块）。
        把比较范围收到嘴唇，描述子才真正在比「这张嘴张开多少」。"""
        h, w = patch.shape[:2]
        return patch[int(h * MOUTH_BOX[1]):max(int(h * MOUTH_BOX[1]) + 4, int(h * MOUTH_BOX[3])),
                     int(w * MOUTH_BOX[0]):max(int(w * MOUTH_BOX[0]) + 4, int(w * MOUTH_BOX[2]))]

    def desc_of(self, patch):
        cv2 = self.cv2
        g = cv2.cvtColor(self.mouth_of(patch), cv2.COLOR_BGR2GRAY)
        g = cv2.resize(g, DESC, interpolation=cv2.INTER_AREA).astype(np.float32)
        g -= g.mean()
        return g / (g.std() + 1e-3)

    def open_of(self, patch):
        """嘴唇「张开程度」标量：唇部子窗里暗腔（口腔/齿缝阴影）的像素占比。

        光靠描述子相关性挑供体不够：描述子只保证「纹理相似」，不保证「张嘴程度相同」。
        目标帧闭嘴而供体大张嘴时，贴上去就是「当前嘴唇 + 供体口腔阴影」两层叠在一起，
        下唇下方那道紫黑暗带、以及用户看到的「嘴上一团糊」都是这么来的。
        这个标量在原片上随嘴型单调变化（实测闭嘴 ~2%、大张嘴 ~24%），
        阈值按子窗自身的 90 分位取（与曝光/唇彩无关），再转成全库百分位排名比大小，
        这样 96×96 的模糊目标图也能得到可比的张开程度。"""
        cv2 = self.cv2
        sub = self.mouth_of(patch)
        if sub.size < 64:
            return 0.0
        g = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY).astype(np.float32) if sub.ndim == 3 else sub
        thr = max(30.0, float(np.percentile(g, 90)) * 0.62)
        return float((g < thr).mean())

    def _open_rank_of(self, value):
        """把张开程度映射成「在全库里的百分位」，抵消两张图各自曝光/模糊带来的尺度差"""
        if self._open.size == 0:
            return 0.0
        return float(np.searchsorted(self._open_sorted, value, side='left')) / float(self._open.size)

    def mouth_geom(self, patch):
        """嘴唇自身的位置与宽度（ROI 像素坐标）：(中心x, 中心y, 宽度)。

        ORB 是在整块 ROI 上匹配的，鼻孔、镜框、下巴都参与投票，对「嘴」这一块并不精确；
        人一低头/侧脸，贴上去的嘴就整体偏移几像素并轻微错尺度，嘴唇外缘落到脸颊上，
        成片里就是嘴角一道深色印子（肉眼读作「糊」）。这里直接量嘴唇：
        取唇部子窗里「暗于自身 90 分位 62%」的最大连通块（闭嘴时是唇线、张嘴时是口腔），
        用它的包围盒中心与宽度做对位，比 ORB 稳得多也便宜得多。"""
        cv2 = self.cv2
        h, w = patch.shape[:2]
        ox, oy = int(w * MOUTH_BOX[0]), int(h * MOUTH_BOX[1])
        sub = self.mouth_of(patch)
        if sub.size < 64:
            return None
        g = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY).astype(np.float32)
        thr = max(30.0, float(np.percentile(g, 90)) * 0.62)
        m = (g < thr).astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        if n <= 1:
            return None
        k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        bx, by = int(stats[k, cv2.CC_STAT_LEFT]), int(stats[k, cv2.CC_STAT_TOP])
        bw, bh = int(stats[k, cv2.CC_STAT_WIDTH]), int(stats[k, cv2.CC_STAT_HEIGHT])
        # 太小（噪点）或几乎铺满子窗（嘴唇与皮肤对比过弱，阈值把整块都算进去了）都不可信
        if bw < sub.shape[1] * 0.18 or bw > sub.shape[1] * 0.95:
            return None
        return float(ox + bx + bw / 2.0), float(oy + by + bh / 2.0), float(bw)

    def lip_chroma(self, patch):
        """嘴唇「表面」的 LAB 色度均值（a/b 两个通道）。

        只统计唇部子窗里偏亮的一半像素：口腔阴影、齿缝这些暗像素会被排除，
        留下的才是唇面本身的颜色，否则「当前帧张嘴 / 供体闭嘴」时两边的均值
        差着一半暗腔，对完色反而把嘴唇弄成一片发黑的紫红。

        为什么要单独校色：供体隔了几十秒，唇彩高光、反光、阴影都不同；
        低频对色对齐的是大块皮肤，几十像素的嘴唇盖不住，成片里嘴唇总像蒙了层灰。"""
        cv2 = self.cv2
        sub = self.mouth_of(patch)
        lab = cv2.cvtColor(sub, cv2.COLOR_BGR2LAB).astype(np.float32)
        g = lab[:, :, 0]
        bright = g >= np.median(g)
        if bright.sum() < 16:
            return float(lab[:, :, 1].mean()), float(lab[:, :, 2].mean())
        return float(lab[:, :, 1][bright].mean()), float(lab[:, :, 2][bright].mean())

    def add(self, frame, box, idx):
        """第一遍：把一帧的原片高清嘴部补丁放进供体库（在线去重，内存有上限）"""
        cv2 = self.cv2
        rx1, ry1, rx2, ry2 = self.roi_rect(box)
        if rx2 - rx1 < 16 or ry2 - ry1 < 12:
            return
        patch = frame[ry1:ry2, rx1:rx2].copy()
        lap = float(cv2.Laplacian(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY), cv2.CV_32F).var())
        if lap < MIN_LAP:
            return
        # 嘴部局部清晰度：整块补丁里鼻孔、下巴、脸颊的纹理会把平均值抬高，
        # 说话时嘴唇高速运动（22fps 下 1/50s 快门）真正会糊的是唇线这一圈。
        # 实测供体库唇部清晰度 p10=36、p50=74、最小值 14.5（比部分当前帧还糊），
        # 这类供体贴上去就是「粉红一团」——采集阶段就按唇部清晰度筛掉。
        mask = self.mask_of(patch.shape[0], patch.shape[1])
        blap = self._band_lap(patch, mask[:, :, 0] > 0.6)
        if blap < MIN_BLAP:
            return
        bw, bh = float(box[2] - box[0]), float(box[3] - box[1])
        if bw < 16 or bh < 16:
            return
        d = self.desc_of(patch)
        item = {'i': idx, 'roi': (rx1, ry1, rx2, ry2), 'patch': patch, 'desc': d,
                'lap': lap, 'blap': blap, 'bw': bw, 'bh': bh, 'pts': None, 'des': None,
                'open': self.open_of(patch)}
        dup = -1
        for k, old in enumerate(self.donors):
            if abs(bw - old['bw']) / max(1.0, old['bw']) > 0.18:
                continue
            if float(np.abs(d - old['desc']).mean()) < 0.16:
                dup = k
                break
        if dup >= 0:
            # 同一张嘴型只留一张：新帧唇部更清晰就替换，避免库被「一模一样但更糊」的帧占满
            if blap > self.donors[dup]['blap'] * 1.08:
                self.donors[dup] = item
            return
        if len(self.donors) < MAX_DONORS:
            self.donors.append(item)
            return
        # 满仓后的淘汰口径：以前只按「唇部最糊」顶掉，结果库全挤在前半段——
        # 60s 处只能借 40s 前的供体，下巴位置差几像素，回贴后下唇下方多一道暗带。
        # 改成优先顶掉「时间上最冗余」的那张（帧号与邻居最近），库就在全片均匀铺开，
        # 配合 NEAR_WIN 的邻近挑选才真正生效。清晰度不达标的旧供体仍然先被顶掉。
        idxs = np.array([x['i'] for x in self.donors], np.int64)
        order = np.argsort(idxs)
        seq = idxs[order]
        gaps = np.diff(seq)
        pair = int(np.argmin(gaps)) if gaps.size else 0
        cands = [int(order[pair]), int(order[pair + 1])] if gaps.size else [int(order[0])]
        worst = min(cands, key=lambda k: self.donors[k]['blap'])
        if blap >= self.donors[worst]['blap'] * 0.90:
            self.donors[worst] = item

    def finalize(self):
        """第二遍前：把每张供体的 ORB 特征算一次（逐帧只算当前帧，省一半时间）"""
        cv2 = self.cv2
        for d in self.donors:
            kp, des = self.orb.detectAndCompute(d['patch'], None)
            if des is not None and des.shape[0] >= 12:
                d['pts'] = np.float32([p.pt for p in kp]).reshape(-1, 1, 2)
                d['des'] = des
            d['geom'] = self.mouth_geom(d['patch'])
        if self.donors:
            self._desc_stack = np.stack([d['desc'] for d in self.donors])
            self._bw = np.array([d['bw'] for d in self.donors], np.float32)
            self._blap = np.array([d.get('blap', 1.0) for d in self.donors], np.float32)
            self._open = np.array([d.get('open', 0.0) for d in self.donors], np.float32)
            self._idx = np.array([d['i'] for d in self.donors], np.int32)
            self._open_sorted = np.sort(self._open)
            self._open_rank = np.array([self._open_rank_of(v) for v in self._open], np.float32)

    def pick(self, tgt_desc, bw, tgt_blap, tgt_open, cur_idx=-1):
        diff = np.abs(self._desc_stack - tgt_desc[None]).mean(axis=(1, 2))
        size_pen = np.abs(np.log(np.maximum(1e-3, self._bw / max(1.0, bw))))
        score = diff / 0.05 + 0.55 * size_pen
        # 清晰度代价：嘴型相近的候选中优先挑唇部更清晰的那张（权重给小，
        # 只用来在「形状几乎一样」的几张里挑清楚的；给大了会牺牲嘴型匹配，
        # 成片出现「嘴型对不上配音」的重影）
        blur_pen = np.maximum(0.0, 1.0 - self._blap / max(1.0, tgt_blap))
        score = score + 0.9 * blur_pen
        # 张嘴程度代价（按全库百分位排名比大小，抵消两张图各自曝光/模糊带来的尺度差）：
        # 这是「嘴上糊一块」的真正来源——目标闭嘴却贴了一张大张嘴的供体，
        # 下唇下方多出一块口腔阴影，看起来就是一团紫黑色。
        open_pen = np.zeros_like(score)
        if self._open_rank.size and self._open_sorted.size:
            open_pen = OPEN_W * np.abs(self._open_rank - self._open_rank_of(tgt_open))
            score = score + open_pen
        # 轻微的时间连续性惩罚：两帧分数接近时优先用「原来那几张」，
        # 避免同一句话里在两张几乎等价的供体之间反复横跳（会看出嘴部轻微闪烁）
        if self.last_pick >= 0 and len(self._idx):
            jump = np.abs(self._idx - self._idx[self.last_pick]) / 60.0
            score = score + 0.06 * np.minimum(1.0, jump)
        if cur_idx >= 0 and len(self._idx):
            # 只在当前帧附近挑供体：同一秒内的人下巴位置、光照、镜面高光都一样，
            # 跨秒的供体嘴唇会整体差几个像素，贴上去在下唇下方留一道暗带（越看越像糊）。
            # 附近实在没有对应嘴型时才逐步放宽（10 帧 → 30 帧 → 全片）。
            near = np.abs(self._idx - cur_idx)
            for win in (NEAR_WIN, NEAR_WIN * 3, 10 ** 6):
                cand = near <= win
                if not cand.any():
                    continue
                s = np.where(cand, score, np.inf)
                k = int(np.argmin(s))
                if np.isfinite(s[k]):
                    break
            else:
                k = int(np.argmin(score))
        else:
            k = int(np.argmin(score))
        self.last_pick = k
        self.stats['score'].append(float(score[k]))
        self.stats['openpen'].append(float(open_pen[k]))
        return k

    def mask_of(self, h, w):
        """回贴蒙版：只盖嘴唇本体，不盖下巴、鼻底和颈部。

        实测 ROI 里嘴唇在 40%~75% 高度，而旧蒙版是「几乎铺满整块 ROI」的大椭圆
        （center 0.46 / 半径 0.46，等于把整块都盖住），于是下巴与颈部阴影也被供体替换掉，
        供体偏暗就成了一道紫黑横带，边缘只剩 5px 羽化、接缝也更生硬。
        现在收成嘴唇大小并给足羽化，嘴唇以外全部保留当前帧的真实像素。"""
        key = (h, w)
        hit = self.masks.get(key)
        if hit is not None:
            return hit
        cv2 = self.cv2
        m = np.zeros((h, w), np.float32)
        cv2.ellipse(m, (int(w * 0.50), int(h * 0.565)),
                    (max(2, int(w * 0.31)), max(2, int(h * 0.185))), 0, 0, 360, 1.0, -1)
        m = cv2.GaussianBlur(m, (0, 0), max(2.0, min(h, w) * 0.070))
        m /= max(1e-6, m.max())
        m = m[:, :, None]
        self.masks[key] = m
        return m

    def blend(self, cur, patch, mask):
        """低频对色 + 羽化回贴：供体的肤色/光照先向当前帧靠拢，再按蒙版融合"""
        cv2 = self.cv2
        h, w = patch.shape[:2]
        c = cur.astype(np.float32)
        p = patch.astype(np.float32)
        sig = max(2.0, min(h, w) / 60.0)
        lo_c = cv2.GaussianBlur(c, (0, 0), sig)
        lo_p = cv2.GaussianBlur(p, (0, 0), sig)
        p = p + (lo_c - lo_p) * 0.95
        blended = c * (1.0 - mask) + p * mask
        return np.clip(blended, 0, 255).astype(np.uint8)

    def match_chroma(self, cur, patch, mask):
        """唇色校正：把供体嘴唇的 LAB 色度均值搬向当前帧（只动 a/b，不改亮度与纹理）。

        供体隔了几十秒，唇彩高光、口腔阴影、面部反光都不同，直接贴上去嘴唇发紫发黑；
        低频对色对齐的是大块皮肤，几十像素的嘴唇盖不住。偏移量夹在 ±CHROMA_CLAMP，
        既防极端帧把唇色改成别的色调，又按蒙版渐变，边界处不留色痕。"""
        cv2 = self.cv2
        ca, cb = self.lip_chroma(cur)
        pa, pb = self.lip_chroma(patch)
        da = float(np.clip((ca - pa) * 0.85, -CHROMA_CLAMP, CHROMA_CLAMP))
        db = float(np.clip((cb - pb) * 0.85, -CHROMA_CLAMP, CHROMA_CLAMP))
        if abs(da) < 0.4 and abs(db) < 0.4:
            return patch
        lab = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32)
        lab[:, :, 1] += da * mask[:, :, 0]
        lab[:, :, 2] += db * mask[:, :, 0]
        return cv2.cvtColor(np.clip(lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)

    def _lap(self, img):
        cv2 = self.cv2
        return float(cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_32F).var())

    def _band_lap(self, img, band):
        """只统计「嘴部蒙版中心」的清晰度。
        整块 ROI 的拉普拉斯方差会被鼻孔、下巴、脸颊纹理拉平，嘴部局部变糊时
        平均值几乎不动（实测整块 0.95 达标、嘴中心只有 0.6）——必须按蒙版中心统计。"""
        cv2 = self.cv2
        g = cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_32F)
        return float(g[band].var())

    def sharpen_to(self, img, target, band):
        """把嘴部的高频能量补回「当前帧自身水平」。

        供体要经过相似变换重采样、还要过一遍编码，唇部高频会掉 20~40%；
        更糟的是有些供体本身就是「嘴唇正在运动」的帧，唇线天然发糊。
        肉眼看到的就是「嘴像被磨皮、比脸颊虚」。

        做法：拿当前帧原来的唇部清晰度做基准（这一帧真实该有的水平），
        按实测差值做反锐化掩模，力度用「测一次、不够就加倍、过冲就减半」
        的方式收敛到基准的 0.95~1.3 倍。之前固定 3 次、力度上限 1.10，
        轻微发糊能补，糊得厉害（比值 0.5）就补不到位，成片里仍是粉红一团。"""
        cv2 = self.cv2
        if target <= 1.0:
            return img
        cur = self._band_lap(img, band)
        if cur <= 1.0:
            return img
        if cur >= target * 0.95:
            return img
        base = img
        best = img
        best_ratio = cur / target
        # 首猜力度：清晰度按方差计，USM 的增益只作用于高频，经验上力度 ≈ 1/x-1
        amount = min(2.4, max(0.25, (1.0 / max(0.20, best_ratio) - 1.0) * 0.55))
        hi = None
        for _ in range(5):
            cand = cv2.addWeighted(base, 1.0 + amount,
                                   cv2.GaussianBlur(base, (0, 0), 1.0), -amount, 0)
            cand = np.clip(cand, 0, 255).astype(np.uint8)
            ratio = self._band_lap(cand, band) / target
            if ratio > 1.30:
                # 一次就冲过头：嘴唇会出白边，退回当前最好结果前先把力度砍半
                hi = amount
                amount = amount * 0.55
                if hi <= 0.3:
                    break
                continue
            best, best_ratio = cand, ratio
            if ratio >= 0.95:
                return cand
            if hi is not None:
                amount = (amount + hi) * 0.5
            else:
                amount = amount * 1.8
            if amount > 4.0:
                break
        return best

    def apply(self, frame, gen96, box, idx=-1):
        """把「目标嘴型」对应的原片高清嘴部贴回当前帧；返回 False 表示这帧保持原样"""
        cv2 = self.cv2
        if self._desc_stack is None:
            return False
        x1, y1, x2, y2 = clip_box(box, self.w, self.h)
        bw, bh = x2 - x1, y2 - y1
        if bw < 16 or bh < 16:
            return False
        rx1, ry1, rx2, ry2 = self.roi_rect((x1, y1, x2, y2))
        if rx2 - rx1 < 16 or ry2 - ry1 < 12:
            return False
        cur = frame[ry1:ry2, rx1:rx2].copy()
        # 「嘴部蒙版中心」的清晰度统计区：整块 ROI 会被鼻孔/下巴/脸颊的纹理拉平，
        # 但用户一眼看到的就是唇线这一圈，所以基准必须只取蒙版中心。
        band = self.mask_of(cur.shape[0], cur.shape[1])[:, :, 0] > 0.60
        if not bool(band.any()):
            band = np.ones(cur.shape[:2], bool)
        # 当前帧自身的嘴部清晰度 = 回贴后的目标清晰度（这一帧真实该有的水平）
        target_lap = self._band_lap(cur, band)
        # 目标嘴型：把 96×96 的重绘结果放大到人脸框尺寸，再只取嘴部 ROI
        gen_full = cv2.resize(gen96, (bw, bh), interpolation=cv2.INTER_LINEAR)
        tgt_gen = gen_full[ry1 - y1:ry2 - y1, rx1 - x1:rx2 - x1]
        tgt = self.desc_of(tgt_gen)
        k = self.pick(tgt, bw, target_lap, self.open_of(tgt_gen), idx)
        d = self.donors[k]

        # 供体补丁 → 当前 ROI：优先「嘴唇对嘴唇」的相似变换（ORB 只在嘴唇几何不可信时兜底）
        M = None
        used_affine = False
        gd = d.get('geom')
        gc = self.mouth_geom(cur)
        if gd is not None and gc is not None:
            # 尺度仍按人脸框换算（最稳）；水平方向用「嘴唇中心」对位——
            # 人侧脸/低头时供体的嘴在 ROI 里会整体偏左或偏右几像素，
            # 贴上去嘴角就压到脸颊上，留下一道深色印子（肉眼读作糊）。
            # 垂直方向不做嘴唇对位：张嘴程度不同时暗腔质心高低差很多
            # （供体大张嘴、目标闭嘴时会把整张嘴往上顶半个口腔高度），
            # 所以垂直只按 ROI 居中，保持人脸框给的位置。
            s = 0.5 * (bw / max(1.0, d['bw']) + bh / max(1.0, d['bh']))
            h_t = cur.shape[0]
            h_d = d['patch'].shape[0]
            M = np.array([[s, 0, gc[0] - s * gd[0]],
                          [0, s, 0.5 * (h_t - s * h_d)]], np.float32)
            used_affine = True
            self.stats['lip'] += 1
        if M is None and d['des'] is not None:
            kp, des = self.orb.detectAndCompute(cur, None)
            if des is not None and len(kp) >= 12:
                ms = self.bf.match(d['des'], des)
                if len(ms) >= 10:
                    src = d['pts'][[m.queryIdx for m in ms]].reshape(-1, 1, 2)
                    dst = np.float32([kp[m.trainIdx].pt for m in ms]).reshape(-1, 1, 2)
                    A, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                                         ransacReprojThreshold=3.0)
                    if A is not None and inl is not None and int(inl.sum()) >= 8:
                        # 同一张脸同一机位，尺度只该在 1 附近微动；跑出这个区间说明
                        # 匹配点被嘴唇/牙齿的差异带偏了，用它会把嘴拉长、拉糊。
                        # 0.75~1.35 太宽：实测 1.2 倍的供体会把下唇拉成宽条（撕裂帧）
                        s = max(float(np.hypot(A[0, 0], A[1, 0])), float(np.hypot(A[0, 1], A[1, 1])))
                        if 0.88 <= s <= 1.14:
                            M = A
                            used_affine = True
                            self.stats['affine'] += 1
        if M is None:
            # ROI 是人脸框的固定比例，所以「左上角对齐 + 框尺寸缩放」就是正确的兜底矩阵
            sx = bw / max(1.0, d['bw'])
            sy = bh / max(1.0, d['bh'])
            M = np.array([[sx, 0, 0], [0, sy, 0]], np.float32)
            self.stats['fallback'] += 1
        warped = cv2.warpAffine(d['patch'], M, (rx2 - rx1, ry2 - ry1),
                                flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)
        if warped.shape[0] != cur.shape[0] or warped.shape[1] != cur.shape[1]:
            self.stats['skip'] += 1
            return False
        # 变形矩阵被噪声带飞时会出现「嘴被拉成大宽条」的撕裂帧：清晰度会飙到
        # 当前帧的好几倍。这种帧宁可退回纯缩放（只对齐尺寸），也不要贴一张撕裂的嘴。
        if target_lap > 1.0 and self._band_lap(warped, band) > target_lap * 3.0:
            sx = bw / max(1.0, d['bw'])
            sy = bh / max(1.0, d['bh'])
            warped = cv2.warpAffine(d['patch'], np.array([[sx, 0, 0], [0, sy, 0]], np.float32),
                                    (rx2 - rx1, ry2 - ry1),
                                    flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)
        mask = self.mask_of(warped.shape[0], warped.shape[1])
        warped = self.match_chroma(cur, warped, mask)
        blended = self.blend(cur, warped, mask)
        # 只在蒙版覆盖到的嘴部补清晰度，周围原生皮肤保持不动
        sharp = self.sharpen_to(blended, target_lap, band)
        final = np.clip(
            blended.astype(np.float32) + (sharp.astype(np.float32) - blended.astype(np.float32)) * mask,
            0, 255).astype(np.uint8)
        frame[ry1:ry2, rx1:rx2] = final
        if self.dbg:
            self.dbg_rows.append([
                round(target_lap, 1), round(self._band_lap(warped, band), 1),
                round(self._band_lap(blended, band), 1), round(self._band_lap(final, band), 1),
                round(float(d['lap']), 1), 1 if used_affine else 0,
                round(self._open_rank_of(self.open_of(tgt_gen)) if self._open_sorted.size else 0.0, 2),
                round(float(self._open_rank[k]), 2)])
        return True


# ---------------------------------------------------------------- 兜底：超分/插值回贴
# 只在原片实在挑不出供体（全程虚焦、严重压缩）时使用：
# 超分权重缺失或只有 CPU 时自动退化到「反卷积 + LANCZOS4 + 轻度 USM」。
mouth_masks_cache = {}


def mouth_masks(bw, bh):
    """回贴蒙版：只覆盖嘴部与下巴上缘，其余脸皮保持原片清晰度。"""
    key = (bw, bh)
    if key in mouth_masks_cache:
        return mouth_masks_cache[key]
    import cv2
    out = np.zeros((bh, bw), np.float32)
    inner = np.zeros((bh, bw), np.float32)
    cv2.ellipse(out, (int(bw * 0.50), int(bh * 0.79)),
                (max(2, int(bw * 0.29)), max(2, int(bh * 0.19))), 0, 0, 360, 1.0, -1)
    cv2.ellipse(inner, (int(bw * 0.50), int(bh * 0.80)),
                (max(2, int(bw * 0.15)), max(2, int(bh * 0.08))), 0, 0, 360, 1.0, -1)
    sigma = max(1.0, min(bw, bh) * 0.09)
    out = cv2.GaussianBlur(out, (0, 0), sigma)
    if out.max() > 0:
        out /= out.max()
    inner = cv2.GaussianBlur(inner, (0, 0), max(1.0, min(bw, bh) * 0.03))
    if inner.max() > 0:
        inner /= inner.max()
    detail = 0.35 + (0.88 - 0.35) * (1.0 - inner[:, :, None])
    mask = out[:, :, None]
    mouth_masks_cache[key] = (mask, detail)
    return mouth_masks_cache[key]


def rl_deconv(img, sigma=1.1, iters=6):
    """Richardson–Lucy 反卷积：放大之前先按 PSF 反解一次，唇线才不会彻底化掉"""
    import cv2
    if sigma <= 0 or iters <= 0:
        return img.astype(np.float32)
    k = max(3, int(sigma * 4) | 1)
    ax = cv2.getGaussianKernel(k, sigma).astype(np.float32)
    psf = np.outer(ax, ax)
    psf /= psf.sum()
    psf_t = psf[::-1, ::-1]
    obs = np.clip(img.astype(np.float32), 1e-3, 255.0)
    est = obs.copy()
    for _ in range(int(iters)):
        conv = cv2.filter2D(est, -1, psf, borderType=cv2.BORDER_REPLICATE)
        ratio = cv2.filter2D(obs / np.maximum(conv, 1e-3), -1, psf_t, borderType=cv2.BORDER_REPLICATE)
        est = np.clip(est * ratio, 1e-3, 255.0)
    return est


def composite_mouth(region, gen, mask, detail, hi_gain):
    """把还原到原帧分辨率的嘴部贴回原帧：低频对色 + 高频细节回填 + 羽化融合"""
    import cv2
    bwf = region.astype(np.float32)
    bh, bw = bwf.shape[:2]
    sigma = max(2.0, min(bw, bh) / 80.0)
    low_r = cv2.GaussianBlur(bwf, (0, 0), sigma)
    low_g = cv2.GaussianBlur(gen, (0, 0), sigma)
    gen = gen + (low_r - low_g)
    if hi_gain > 0:
        hi = np.clip(bwf - low_r, -24.0, 24.0)
        simg = cv2.cvtColor(np.clip(bwf, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY)
        smag = np.abs(cv2.Laplacian(simg, cv2.CV_32F, ksize=3))
        smag = cv2.GaussianBlur(smag, (0, 0), max(1.0, min(bw, bh) * 0.012))
        wgt = 1.0 / (1.0 + (smag / 20.0) ** 2)
        gen = gen + hi * detail * hi_gain * (0.25 + 0.75 * wgt)[:, :, None]
    blended = bwf * (1.0 - mask) + gen * mask
    return np.clip(blended, 0, 255).astype(np.uint8)


SR_WIN = (0.12, 0.44, 0.88, 1.0)
SR_BOX = (int(96 * SR_WIN[0]), int(96 * SR_WIN[1]),
          max(int(96 * SR_WIN[0]) + 8, int(96 * SR_WIN[2])),
          max(int(96 * SR_WIN[1]) + 8, int(96 * SR_WIN[3])))
SR_HI_GAIN = 1.0
_geom_cache = {}


def mouth_geom(bw, bh):
    """超分窗口在人脸裁片上的落位与羽化权重（同尺寸只算一次）"""
    key = (bw, bh)
    hit = _geom_cache.get(key)
    if hit is not None:
        return hit
    tx0, ty0 = int(bw * SR_WIN[0]), int(bh * SR_WIN[1])
    tx1, ty1 = max(tx0 + 8, int(bw * SR_WIN[2])), max(ty0 + 8, int(bh * SR_WIN[3]))
    w, h = tx1 - tx0, ty1 - ty0
    r = max(3, min(int(min(w, h) * 0.06), min(w, h) // 3))
    ramp = np.linspace(0.0, 1.0, r + 1)[1:].astype(np.float32)
    al = np.ones((h, w), np.float32)
    al[:r] *= ramp[:, None]
    al[h - r:] *= ramp[::-1][:, None]
    al[:, :r] *= ramp[None, :]
    al[:, w - r:] *= ramp[::-1][None, :]
    hit = ((tx0, ty0, tx1, ty1), al[:, :, None])
    _geom_cache[key] = hit
    return hit


class DetailEnhancer:
    """Real-ESRGAN x4：只为兜底路径补嘴部细节"""

    def __init__(self, weights, device):
        import torch
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from rrdbnet import RRDBNet
        net = RRDBNet(3, 3, 4, 64, 23, 32).eval()
        ckpt = torch.load(weights, map_location='cpu')
        state = ckpt.get('params_ema') or ckpt.get('params') or ckpt
        state = {k.replace('module.', ''): v for k, v in state.items()}
        net.load_state_dict(state)
        self.torch = torch
        self.net = net.to(device)
        self.device = device

    def to(self, device):
        self.net = self.net.to(device)
        self.device = device

    def run(self, wins):
        out = []
        step = 8
        for i in range(0, len(wins), step):
            part = wins[i:i + step]
            arr = np.stack([np.transpose(w[:, :, ::-1].astype(np.float32) / 255.0, (2, 0, 1))
                            for w in part])
            with self.torch.no_grad():
                y = self.net(self.torch.from_numpy(arr).to(self.device))
            y = y.permute(0, 2, 3, 1).cpu().numpy()[:, :, :, ::-1]
            out.extend(np.clip(y * 255.0, 0, 255).astype(np.uint8))
        return out


def build_gen(gen96, sr_win, bw, bh):
    """把 96×96 的重绘结果还原到原帧分辨率（兜底路径）"""
    import cv2
    if sr_win is None:
        g = rl_deconv(gen96, 1.1, 6)
        g = cv2.resize(g, (bw, bh), interpolation=cv2.INTER_LANCZOS4).astype(np.float32)
        g = g + 0.30 * (g - cv2.GaussianBlur(g, (0, 0), 1.2))
        return np.clip(g, 0, 255).astype(np.float32)
    base = cv2.resize(gen96, (bw, bh), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    (tx0, ty0, tx1, ty1), al = mouth_geom(bw, bh)
    up = cv2.resize(sr_win, (tx1 - tx0, ty1 - ty0), interpolation=cv2.INTER_LANCZOS4)
    up = np.clip(up, 0, 255).astype(np.float32)
    base[ty0:ty1, tx0:tx1] = base[ty0:ty1, tx0:tx1] * (1.0 - al) + up * al
    return base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True)
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--weights', required=True)
    ap.add_argument('--ffmpeg', required=True)
    ap.add_argument('--fps', type=float, default=25.0)
    ap.add_argument('--pads', default='0,10,0,0')
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--crf', type=int, default=19)
    ap.add_argument('--device', default='auto')
    ap.add_argument('--sr-weights', default='')
    args = ap.parse_args()

    pads = [int(x) for x in args.pads.split(',')]
    emit(stage='load', percent=2)
    import cv2
    import torch
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from w2l_model import Wav2Lip

    if not os.path.exists(args.weights):
        sys.exit('缺少口型模型权重：%s' % args.weights)

    w, h, src_fps, dur = probe_video(args.ffmpeg, args.video)
    fps = args.fps if args.fps > 0 else (src_fps or 25.0)
    fps = max(12.0, min(30.0, fps))

    wav = load_wav(args.audio)
    if wav is None or len(wav) < SAMPLE_RATE // 2:
        sys.exit('配音音轨为空，无法生成口型')
    mel = melspectrogram(wav)
    if np.isnan(mel.reshape(-1)).sum() > 0:
        sys.exit('配音特征包含 NaN，请重新生成配音')
    chunks = mel_chunks(mel, fps)
    total = len(chunks)

    # 设备选择：M 芯片优先 Metal；个别算子不支持时整批退回 CPU（宁可慢，不出黑帧）
    device = 'cpu'
    if args.device in ('auto', 'mps') and torch.backends.mps.is_available():
        device = 'mps'
    elif args.device == 'cuda' and torch.cuda.is_available():
        device = 'cuda'

    model = Wav2Lip()
    ckpt = torch.load(args.weights, map_location='cpu')
    state = ckpt.get('state_dict', ckpt)
    state = {k.replace('module.', ''): v for k, v in state.items()}
    model.load_state_dict(state)
    model = model.to(device).eval()
    emit(stage='load', percent=7, device=device, frames=total)

    tracker = FaceTracker(pads)
    retimer = MouthRetimer(w, h)

    # ---------- 第一遍（流式）：只检测人脸，整帧读完即丢 ----------
    # 这一遍不缓存任何画面：以前把整条视频所有帧留在内存里，82s 视频要占 6GB 以上，
    # 换来的是进程被系统换页拖死。现在内存与片长无关。
    emit(stage='detect', percent=8)
    boxes = []
    reader = FrameReader(args.ffmpeg, args.video, w, h, fps)
    while len(boxes) < total:
        frame = reader.read()
        if frame is None:
            break
        idx = len(boxes)
        if idx % 2 == 0 or not boxes:
            box = tracker.detect(frame, boxes[-1] if boxes else None)
        else:
            box = boxes[-1]
        boxes.append(box)
        if idx % 50 == 0:
            emit(stage='detect', percent=8 + int(8 * idx / max(1, total)),
                 detail='检测人脸 %d/%d' % (idx, total))
    reader.close()

    if not boxes:
        sys.exit('画面解码失败，请确认视频可正常播放')
    if not any(boxes):
        sys.exit('NO_FACE')
    # 解码帧数不足（画面比配音短）时按最后一帧补齐，保证音画长度一致
    while len(boxes) < total:
        boxes.append(boxes[-1])
    boxes = boxes[:total]
    # 先剔掉「只有半张脸」的误检，再补下巴，最后 5 帧平滑
    boxes = stabilize_boxes(boxes, w, h)
    boxes = [expand_face_box(b, w, h) if b else None for b in boxes]
    boxes = tracker.fill_and_smooth(boxes)

    # ---------- 第二遍（流式）：用平滑后的人脸框采集原片高清嘴部供体 ----------
    # 帧本身仍然读完即丢，只留「下脸小补丁」（约 100~400KB/张，上限 240 张）。
    # 必须用平滑框：原始检测框逐帧抖动会让补丁尺寸忽大忽小，ORB 对齐失败率飙升。
    emit(stage='donor', percent=16)
    reader = FrameReader(args.ffmpeg, args.video, w, h, fps)
    for i in range(len(boxes)):
        frame = reader.read()
        if frame is None:
            break
        retimer.add(frame, boxes[i], i)
        if i % 100 == 0:
            emit(stage='donor', percent=16 + int(4 * i / max(1, len(boxes))),
                 detail='采集原片嘴部样本 %d 张' % retimer.count)
    reader.close()
    retimer.finalize()

    use_retime = retimer.count >= 6
    emit(stage='donor', percent=18, donors=retimer.count,
         mode='retime' if use_retime else 'sr',
         detail='原片高清嘴部样本 %d 张' % retimer.count)

    # 兜底才加载超分模型（主路径用不到，省 64MB 内存与一两秒加载时间）
    enhancer = None
    if not use_retime and args.sr_weights and os.path.exists(args.sr_weights):
        if device in ('mps', 'cuda'):
            try:
                enhancer = DetailEnhancer(args.sr_weights, device)
                log('供体不足，启用嘴部超分兜底')
            except Exception as e:
                log('超分模型加载失败，退回插值放大：%s' % e)
                enhancer = None
        else:
            log('未启用 GPU，跳过嘴部超分')
    elif not use_retime and args.sr_weights:
        log('缺少嘴部超分权重，退回插值放大：%s' % args.sr_weights)
    emit(stage='load', percent=20, sr=enhancer is not None, mode='retime' if use_retime else 'sr')
    if not use_retime:
        log('供体不足（%d 张），本片改用超分/插值回贴' % retimer.count)

    # ---------- 第二遍（流式分批）：推理 → 回贴 → 编码 ----------
    reader = FrameReader(args.ffmpeg, args.video, w, h, fps)
    writer = FrameWriter(args.ffmpeg, args.out, args.audio, w, h, fps, args.crf)
    masks = {}
    batch = max(1, args.batch)
    done = 0
    last = None
    try:
        while done < total:
            end = min(total, done + batch)
            frames, crops, mels, metas = [], [], [], []
            for i in range(done, end):
                frame = reader.read()
                if frame is None:
                    # 画面比配音短：用最后一帧填满剩余时长，绝不写出短一截的片子
                    if last is None:
                        raise RuntimeError('画面解码失败，请确认视频可正常播放')
                    frame = last.copy()
                else:
                    last = frame
                x1, y1, x2, y2 = clip_box(boxes[i], w, h)
                if x2 - x1 < 8 or y2 - y1 < 8:
                    x1, y1, x2, y2 = 0, 0, min(w, 8), min(h, 8)
                crop = cv2.resize(frame[y1:y2, x1:x2], (96, 96),
                                  interpolation=cv2.INTER_AREA if (x2 - x1) > 96 else cv2.INTER_LANCZOS4)
                masked = crop.copy()
                masked[48:] = 0
                crops.append(np.concatenate((masked, crop), axis=2) / 255.0)
                mels.append(chunks[i])
                metas.append((x1, y1, x2, y2))
                frames.append(frame)
            img_b = torch.from_numpy(np.transpose(np.asarray(crops, np.float32), (0, 3, 1, 2))).to(device)
            mel_b = torch.from_numpy(np.reshape(np.asarray(mels, np.float32),
                                                (len(mels), mels[0].shape[0], mels[0].shape[1], 1)
                                                ).transpose(0, 3, 1, 2)).to(device)
            with torch.no_grad():
                try:
                    pred = model(mel_b, img_b)
                except Exception as e:
                    if device == 'cpu':
                        raise
                    log('MPS 推理失败，整任务退回 CPU：%s' % e)
                    emit(stage='infer', percent=20, detail='Metal 不可用，改用 CPU')
                    device = 'cpu'
                    model = model.to('cpu')
                    img_b, mel_b = img_b.cpu(), mel_b.cpu()
                    pred = model(mel_b, img_b)
                    enhancer = None
            out = pred.detach().to('cpu').numpy().transpose(0, 2, 3, 1)
            out = np.clip(out * 255.0, 0, 255).astype(np.uint8)

            sr_wins = None
            if not use_retime and enhancer is not None:
                sr_wins = enhancer.run([out[j][SR_BOX[1]:SR_BOX[3], SR_BOX[0]:SR_BOX[2]]
                                       for j in range(len(metas))])
            for j, (x1, y1, x2, y2) in enumerate(metas):
                base = frames[j]
                if use_retime:
                    # 高清供体回贴：嘴型跟着配音，像素是原片真实像素
                    retimer.apply(base, out[j], (x1, y1, x2, y2), done + j)
                else:
                    bw, bh = x2 - x1, y2 - y1
                    key = (bw, bh)
                    if key not in masks:
                        masks[key] = mouth_masks(bw, bh)
                    mask, detail = masks[key]
                    gen = build_gen(out[j], sr_wins[j] if sr_wins else None, bw, bh)
                    gain = SR_HI_GAIN if sr_wins else 1.0
                    base[y1:y2, x1:x2] = composite_mouth(base[y1:y2, x1:x2], gen, mask, detail, gain)
                writer.write(base)
            done = end
            emit(stage='infer', percent=20 + int(79 * done / max(1, total)),
                 detail='口型 %d/%d 帧' % (done, total))
        writer.close()
    finally:
        try:
            reader.close()
        except Exception:
            pass
    if not os.path.exists(args.out) or os.path.getsize(args.out) < 20000:
        sys.exit('口型视频输出失败')
    log('mode=%s donors=%d lip=%d orb=%d fallback=%d skip=%d frames=%d' % (
        'retime' if use_retime else 'sr', retimer.count, retimer.stats['lip'],
        retimer.stats['affine'], retimer.stats['fallback'], retimer.stats['skip'], done))
    if getattr(retimer, 'dbg_rows', None):
        a = np.asarray(retimer.dbg_rows, np.float32)
        med = np.median(a, axis=0)
        log('clarity band p50 | cur=%.1f warped=%.1f blended=%.1f final=%.1f donor=%.1f | '
            'final/cur=%.0f%% warped/cur=%.0f%%' % (
                med[0], med[1], med[2], med[3], med[4],
                100.0 * med[3] / max(1.0, med[0]), 100.0 * med[1] / max(1.0, med[0])))
    emit(stage='done', percent=100, frames=done, fps=fps,
         mode='retime' if use_retime else 'sr', donors=retimer.count)


def _bye(signum, frame):
    sys.exit(0)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, _bye)
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # 把异常压成一行给 Node 层展示
        log('ERROR %s' % e)
        sys.exit(1)
