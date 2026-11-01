#!/usr/bin/env python3
"""TokPure — 本地口型同步（配音包络驱动 + 原片高清嘴部回贴）。

输入：已经切片好的口播画面（mp4）+ 目标语言配音（wav，含整段静音填充）
输出：口型跟着配音走的新视频（画面保留原片构图、头部动作、背景）

设计要点：
1. 全程离线：模型权重与代码都在本机，进程内不发任何网络请求；
2. 音频驱动先于口型：配音定稿后再逐帧重绘嘴部，绝不边合成边对齐；
3. **口型重定时（主路径）**：「这一帧该张多大嘴」由**配音自己的元音包络**算出来
   （子句切分 → 按句音量选一张供体 → 句内包络映射到纵向形变，逐帧限速）。
   旧的 Wav2Lip 96×96 预测值实测与配音包络相关系数只有 0.00（纯噪声），
   用它驱动会让嘴在上下限之间逐帧抽动，所以主路径不再推理。
   像素一律取自原片——从原片里挑一张嘴型合适的同一个人「嘴部供体」，
   按「嘴唇中心对嘴唇中心 + 唇宽缩放」对齐后羽化回贴（不再用 ORB/人脸框比例，
   两者在嘴唇/牙齿差异大、人脸框跳变时都会把嘴错位）。原片是 800~1080p，
   嘴部有真实唇线、牙缝、胡渣，所以不会再出现「96×96 插值放大 → 发蜡、糊成一团」；
4. 头部晃动、手势、景别全部保留；人脸检测用 YuNet 关键点（Apache-2.0），
   逐帧嘴位再做零相位平滑，避免检测框抖动导致嘴部闪烁；
5. 视频解码/编码都走 ffmpeg 管道（bgr24 rawvideo），全程流式：第一遍只留人脸框与
   嘴部小补丁（绝不把整条视频的所有帧留在内存，82s 视频以前要占 6GB 以上），
   第二遍逐帧回贴+编码；
6. 供体不足（<6 张，例如原片全程模糊）时退回「Wav2Lip + 超分 / 反卷积」回贴，
   任务不中断（这条兜底路径才加载 torch 与模型权重）。

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


def count_frames(ffmpeg, video):
    """用 demux 计数（-c copy，不解码）拿到视频的**真实帧数**，用来校验标称帧率。

    手机竖拍素材的容器标称帧率经常与真实帧数对不上，而本流程的「帧号 ↔ 音频时间」
    完全依赖这个帧率：帧率偏大等于每个音频窗口少走几帧，整条口型会越走越超前。
    实测本片（816×1440、标称「21.82 fps, 30 tbr」、82.83 秒）demux 得到 1804 个
    视频包 = 21.78 fps，与标称 21.82 只差 0.2%，所以这里不会改动 fps；
    但同一条链路对真正的 VFR 素材（标称 30、实际 22 之类）会自动改用真实帧率。
    多一遍 demux 计数（132MB 约 1 秒）换取「帧号与音频时间严格对齐」是划算的。
    注意：`ffmpeg -f null -` 打印的 frame= 是**包数**，不是解码帧数；
    而裸 rawvideo 输出不加 -r 时 ffmpeg 会按 vsync 重复取样（实测会把 1804 帧
    报成 2481 帧），两者都不能直接当帧数用——所以只认这里的 demux 计数。
    """
    text = ''
    try:
        proc = subprocess.run([ffmpeg, '-hide_banner', '-nostdin', '-i', video,
                               '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                              timeout=180)
        text = (proc.stderr or '') + (proc.stdout or '')
    except Exception as e:
        log('帧数统计失败（沿用标称帧率）：%s' % e)
        return 0
    hits = re.findall(r'frame=\s*(\d+)', text)
    return int(hits[-1]) if hits else 0


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
        # 首选 YuNet（ONNX，230KB，随包分发，全离线）：它除了人脸框还直接给出
        # 「双眼 / 鼻尖 / 双嘴角」5 个关键点，嘴角连线就是真实唇宽，
        # 唇色投影在这张素材上对比度只有 8~20 灰阶（嘴唇偏淡、暖光把皮肤也照红了），
        # 阈值稍微一动唇宽就在 52~182px 之间跳，根本没法用来放蒙版。
        self.yunet = None
        self.lm = None
        model = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             'face_detection_yunet_2023mar.onnx')
        if os.path.exists(model):
            try:
                self.yunet = cv2.FaceDetectorYN.create(model, '', (320, 320), 0.55, 0.3, 5000)
                self._yn_size = None
            except Exception as e:
                log('YuNet 载入失败，退回 Haar：%s' % e)
                self.yunet = None
        path = os.path.join(cv2.data.haarcascades, 'haarcascade_frontalface_default.xml')
        self.cascade = cv2.CascadeClassifier(path)
        if self.cascade.empty() and self.yunet is None:
            raise RuntimeError('人脸检测器加载失败')
        # 最近一次成功的高度角（度）：口播里头部倾角几乎不变，命中一次就沿用到下一帧，
        # 首帧命中率接近 100%，多角度扫描只在「换镜/转头」时才会真正跑满
        self.angle = 0.0
        self._cand = None
        self._cand_votes = 0

    def _yn_hit(self, frame):
        """YuNet：返回 (框, 5 关键点) 或 None（都已换算回原帧坐标）

        缩到 640 宽再检测：全尺寸 816×1440 喂进去计算量约 11 倍，单帧要上百毫秒；
        640 宽时约 10ms，关键点误差换算回原帧也只有 2~3px。
        """
        cv2 = self.cv2
        h, w = frame.shape[:2]
        scale = min(1.0, 640.0 / max(1, w))
        if scale < 1.0:
            img = cv2.resize(frame, (int(w * scale), int(h * scale)),
                             interpolation=cv2.INTER_AREA)
        else:
            img = frame
        sw, sh = img.shape[1], img.shape[0]
        if self._yn_size != (sw, sh):
            self.yunet.setInputSize((sw, sh))
            self._yn_size = (sw, sh)
        _, faces = self.yunet.detect(img)
        if faces is None or not len(faces):
            return None
        f = max(faces, key=lambda r: float(r[2]) * float(r[3]))
        if float(f[2]) * float(f[3]) < 0.02 * sw * sh:
            return None
        inv = 1.0 / scale
        x, y, fw, fh = [float(v) * inv for v in f[:4]]
        lm = np.asarray(f[4:14], np.float32).reshape(5, 2) * inv
        return [x, y, x + fw, y + fh], lm

    def _hit(self, small, ang, min_size):
        """在指定倾角上跑一次全脸级联，返回画面内最大的可信人脸框或 None"""
        cv2 = self.cv2
        if abs(ang) < 1.0:
            rot = small
        else:
            c = (small.shape[1] / 2.0, small.shape[0] / 2.0)
            M = cv2.getRotationMatrix2D(c, ang, 1.0)
            rot = cv2.warpAffine(small, M, (small.shape[1], small.shape[0]),
                                 flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        for mn in (5, 3):
            faces = self.cascade.detectMultiScale(rot, scaleFactor=1.08, minNeighbors=mn,
                                                  minSize=(min_size, min_size))
            if len(faces):
                break
        if not len(faces):
            return None
        x, y, fw, fh = max(faces, key=lambda r: int(r[2]) * int(r[3]))
        # 画面底部那串紫色挂绳/展台 logo 会被当成脸（60×60 级别的小框）：
        # 真实人脸至少占画面 3%，低于这个面积的一律不认
        if fw * fh < 0.03 * rot.shape[0] * rot.shape[1]:
            return None
        R = None
        if abs(ang) >= 1.0:
            c = (small.shape[1] / 2.0, small.shape[0] / 2.0)
            R = cv2.invertAffineTransform(cv2.getRotationMatrix2D(c, ang, 1.0))
        return x, y, fw, fh, R

    def detect(self, frame, box=None):
        """正立 + 多倾角扫描的人脸定位。

        这张素材是自拍广角，头歪 10~20°，正立 `haarcascade_frontalface_default`
        实测 48 帧里只检出 3 帧，而且检出的那几帧锁在画面底部的紫色挂绳上。
        框一丢，后面的眼锚、嘴位、蒙版全都跟着丢——这才是「嘴上一块糊斑」和
        「口型不跟配音」在上游的真正源头。
        现在按「上次成功的角度 → 0° → ±10° → ±20°」依次扫，命中就记住角度，
        下一帧直接从该角度开始，常规帧仍然只跑一次级联（约 5ms）。
        """
        cv2 = self.cv2
        h, w = frame.shape[:2]
        if self.yunet is not None:
            hit = self._yn_hit(frame)
            if hit is not None:
                b, lm = hit
                self.lm = lm
                pady1, pady2, padx1, padx2 = self.pads
                x1, y1, x2, y2 = b
                return [max(0, int(x1 - padx1)), max(0, int(y1 - pady1)),
                        min(w, int(x2 + padx2)), min(h, int(y2 + pady2))]
        self.lm = None
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # 缩到 480 宽再检测：1080p 上全尺寸检测一帧要 30ms 以上，缩小后约 5ms
        scale = 480.0 / max(1, w)
        if scale < 1:
            small = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            f = scale
        else:
            small, f = gray, 1.0
        min_size = max(24, int(small.shape[1] * 0.10))
        order = [self.angle] + [a for a in (0.0, -10.0, 10.0, -20.0, 20.0) if a != self.angle]
        hit = None
        hit_ang = self.angle
        for ang in order:
            hit = self._hit(small, ang, min_size)
            if hit is not None:
                hit_ang = ang
                break
        if hit is None:
            self._cand, self._cand_votes = None, 0
            return box
        if hit_ang != self.angle:
            # 角度要「连续两帧都成立」才切换：否则会在 -10/0 之间来回跳，
            # 每跳一次框就整体平移十几像素，嘴位跟着抖（实测 cx 标准差 116px）
            if self._cand == hit_ang:
                self._cand_votes += 1
            else:
                self._cand, self._cand_votes = hit_ang, 1
            if self._cand_votes < 2:
                # 仍用旧角度重新检一次；检不到才接受新角度
                hit = self._hit(small, self.angle, min_size)
                if hit is None:
                    hit = self._hit(small, hit_ang, min_size)
                    if hit is None:
                        return box
                else:
                    hit_ang = self.angle
            else:
                self.angle = hit_ang
                self._cand, self._cand_votes = None, 0
        x, y, fw, fh, R = hit
        if R is not None:
            # 旋转是绕画面中心做的，框中心必须反算回原坐标系
            cx, cy = x + fw / 2.0, y + fh / 2.0
            cx, cy = (R[0][0] * cx + R[0][1] * cy + R[0][2],
                      R[1][0] * cx + R[1][1] * cy + R[1][2])
            x, y = cx - fw / 2.0, cy - fh / 2.0
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


# ---------------------------------------------------------------- 嘴位定位
# 为什么不用眼睛级联：这张素材头歪 10~20°、戴反光圆框眼镜，正立眼睛级联在
# 连续 48 帧里只命中 18 帧，命中的那些也会在两眉/镜框上漂——由此推出来的嘴位
# 帧间标准差 40~50px，而蒙版半高只有 0.23 唇宽（约 28px），一漂就把鼻下、下巴
# 的皮肤换进嘴里，成片里那块「磨皮带」糊斑正是这么来的。
# 现在改成「旋正人脸 → 唇色投影」：全脸级联只负责给一个稳定的框（多角度检测），
# 绕框心旋正后嘴唇是画面里唯一「红度显著高于皮肤」的横向结构，
# 按行取红度质心得到唇线，按列取红度质心与半高宽得到唇心与唇宽。
# 全链路只依赖色彩，与张口程度、牙齿、唇彩高光都无关，帧间抖动只有几像素。

MOUTH_V_REF = 0.76      # 朗读时嘴心在旋正人脸框高度的典型位置（位置先验峰值）
MOUTH_V_SPAN = 0.10     # 先验的高斯宽度（相对框高）
MOUTH_V_SHIFT = 0.07    # 嘴角连线中点 → 嘴唇本体中心的竖向偏移（相对唇宽，正=向下）
MOUTH_W_MIN = 0.09      # 唇宽下限（相对框宽）：再小就不是嘴了
MOUTH_W_MAX = 0.36      # 唇宽上限


def mouth_from_landmarks(lm, w, h):
    """由 YuNet 的 5 点（右眼、左眼、鼻尖、右嘴角、左嘴角）求唇心与唇宽。

    嘴角连线中点 ≈ 唇缝位置；实测嘴唇本体中心比它低约 0.05 唇宽
    （上唇薄、下唇厚），所以统一加 MOUTH_V_SHIFT 下移。
    唇宽直接取两嘴角的像素距离，是这张素材上唯一「与颜色、张口、牙齿、眼镜反光
    全都无关」的唇部几何量。
    """
    if lm is None or lm.shape[0] < 5:
        return None
    a, b = lm[3], lm[4]
    lw = float(np.hypot(a[0] - b[0], a[1] - b[1]))
    if lw < max(16.0, 0.04 * w):
        return None
    cx = float(a[0] + b[0]) / 2.0
    cy = float(a[1] + b[1]) / 2.0 + lw * MOUTH_V_SHIFT
    if not (0 <= cx < w and 0 <= cy < h):
        return None
    return cx, cy, min(lw, 0.6 * w), 1.0


def _mouth_in_upright(up):
    """在旋正的人脸裁片里求 (u, v, 唇宽, 置信度)，均为相对裁片宽/高的比例。"""
    H, W = up.shape[:2]
    if H < 80 or W < 60:
        return None
    b = up[:, :, 0].astype(np.float32)
    g = up[:, :, 1].astype(np.float32)
    r = up[:, :, 2].astype(np.float32)
    red = r - g
    x0, x1 = int(W * 0.20), int(W * 0.80)
    y0, y1 = int(H * 0.62), int(H * 0.92)
    if y1 - y0 < 20 or x1 - x0 < 40:
        return None
    rows = red[y0:y1, x0:x1].mean(axis=1)
    rows = np.convolve(rows, np.ones(7) / 7.0, mode='same')
    # 位置先验：鼻子（更红更暗）与下巴阴影都在窗口边缘，用高斯权重压住
    ys = (np.arange(y0, y1) / float(H)) - MOUTH_V_REF
    wgt = np.maximum(0.0, rows - float(np.percentile(rows, 20))) * np.exp(-(ys / MOUTH_V_SPAN) ** 2)
    s = float(wgt.sum())
    if s < 1e-3:
        return None
    v = float((np.arange(y0, y1) * wgt).sum() / s) / float(H)
    py = int(round(v * H))
    # 横向：在唇线上下若干像素的红度列剖面里取质心与半高宽。
    # ⚠️ 这里必须把列剖面限制在脸框中央（x0:x1）：以前用了整幅宽度 `red[..., :]`，
    # 画面底部的紫色挂绳、蓝色展台、暖色背景全都被算进列剖面，把 u 拉向背景、
    # 把唇宽压到下限（实测 12s 得到 57px，真值约 127px），蒙版于是压在牙齿/鼻下。
    hb = max(6, int(round(H * 0.011)))          # 唇线带半高：随人脸尺寸自适应
    band = red[max(0, py - hb):py + hb, x0:x1]
    if band.shape[0] < 4 or band.shape[1] < 20:
        return None
    cols = np.convolve(band.mean(axis=0), np.ones(13) / 13.0, mode='same')
    cbase = float(np.percentile(cols, 25))
    cw = np.maximum(0.0, cols - cbase)
    s2 = float(cw.sum())
    if s2 < 1e-3:
        return None
    u = float((x0 + float((np.arange(cw.size) * cw).sum()) / s2) / float(W))
    k = int(np.argmax(cw))
    half = cw[k] * 0.5
    lo = hi = k
    while lo > 0 and cw[lo - 1] >= half:
        lo -= 1
    while hi < cw.size - 1 and cw[hi + 1] >= half:
        hi += 1
    ww = (hi - lo + 1) / float(W)
    conf = float(cw[k] / max(1.0, cbase + 1.0))
    if not (MOUTH_W_MIN <= ww <= MOUTH_W_MAX):
        # 唇宽落在上下限之外说明这一帧没量到嘴唇（多半被手/麦克风挡住），
        # 宁可返回 None 交给时序插值，也不要塞一个错值把平滑链带偏
        return None
    return u, v, ww, conf


def locate_mouth(frame, box, w, h, angle=0.0, lm=None):
    """求唇心与唇宽，返回 (cx, cy, 唇宽, 置信度) 或 None。

    主路径是 YuNet 的双嘴角关键点（见 mouth_from_landmarks）：唇宽是两嘴角的真实
    像素距离，不受唇色深浅、张口、牙齿、眼镜反光影响，帧间抖动只是关键点本身的
    一两像素。只有在 YuNet 未命中（侧脸/遮挡/画面过小）时，才退回「旋正人脸 +
    唇色投影」。
    """
    import cv2
    m = mouth_from_landmarks(lm, w, h)
    if m is not None:
        return m
    x1, y1, x2, y2 = clip_box(box, w, h)
    if x2 - x1 < 60 or y2 - y1 < 80:
        return None
    roi = frame[y1:y2, x1:x2]
    if abs(angle) >= 1.0:
        c = (roi.shape[1] / 2.0, roi.shape[0] / 2.0)
        M = cv2.getRotationMatrix2D(c, angle, 1.0)
        up = cv2.warpAffine(roi, M, (roi.shape[1], roi.shape[0]),
                            flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        inv = cv2.invertAffineTransform(M)
    else:
        up, inv = roi, None
    res = _mouth_in_upright(up)
    if res is None:
        return None
    u, v, ww, conf = res
    up_h, up_w = up.shape[:2]
    px, py = u * up_w, v * up_h
    if inv is None:
        cx, cy = px + x1, py + y1
    else:
        cx = inv[0][0] * px + inv[0][1] * py + inv[0][2] + x1
        cy = inv[1][0] * px + inv[1][1] * py + inv[1][2] + y1
    bw = float(x2 - x1)
    lw = max(MOUTH_W_MIN * bw, min(MOUTH_W_MAX * bw, ww * up_w))
    cy += lw * MOUTH_V_SHIFT
    return float(cx), float(cy), float(lw), conf



def zero_phase_smooth(v, sigma):
    """对称高斯平滑（**零相位、零滞后**）。

    因果滤波（EMA / 滑动平均）压抖动一定会带滞后：嘴位滞后两帧，蒙版就切在嘴唇
    边上。这里对整段序列做中心对称卷积，只削「帧间来回跳」的高频，不改变运动的
    相位——单调运动的中段几乎不变形，只在起点/终点做镜像延拓。
    """
    v = np.asarray(v, np.float64)
    if v.size < 3 or sigma <= 0:
        return v.copy()
    r = max(1, int(round(3.0 * sigma)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1, dtype=np.float64) / float(sigma)) ** 2)
    k /= k.sum()
    pad = np.pad(v, (r, r), mode='reflect' if v.size > r else 'edge')
    return np.convolve(pad, k, mode='valid')


def audio_gate_seq(wav, fps, total):
    """逐帧配音「该说话/该闭嘴」系数（0=静音段，1=正常说话）。

    嘴抖的第二个来源是「模型每帧独立预测张口度」：同一句话里相邻帧的预测值会来回
    跳，供体就跟着在几张几乎等价的嘴型之间横跳，肉眼看就是嘴唇在抖。这里把三件事
    一起做掉：
      1) 用配音自己的 RMS 包络算出「语音/静音」权重，静音帧强制闭嘴；
      2) 包络与权重都过零相位平滑，不再有逐帧锯齿；
      3) 张嘴度最终 = 模型张口度 × 权重，停顿处一定是闭着的。
    第 1 条同时解决「嘴型没和配音对齐」：观众判断对齐，很大程度就看「没声音的时候
    嘴有没有闭上」，以前的成片在句间停顿仍然半张着嘴。
    """
    sr = SAMPLE_RATE
    hop = sr / max(1.0, float(fps))
    n = int(min(total, max(1, int(len(wav) / max(1.0, hop))))
            ) if len(wav) else 0
    gate = np.ones(max(1, total), np.float64)
    if n < 3:
        return gate
    step = max(1, int(round(hop)))
    db = np.empty(n, np.float64)
    for i in range(n):
        a = i * step
        b = min(len(wav), a + step)
        seg = wav[a:max(b, a + 1)]
        e = float(np.sqrt(np.mean(np.asarray(seg, np.float64) ** 2) + 1e-12))
        db[i] = 20.0 * np.log10(max(e, 1e-6))
    db = zero_phase_smooth(db, 1.5)
    act = db > float(np.percentile(db, 50))
    ref = float(np.median(db[act])) if bool(act.any()) else float(np.median(db))
    # 比「典型说话电平」低 13dB 视为静音；5dB 的斜坡保证开合是渐变而不是一刀切
    g = np.clip((db - (ref - 13.0)) / 5.0, 0.0, 1.0)
    g = zero_phase_smooth(g, 1.2)
    gate[:n] = g
    return gate


def band_env_seq(wav, fps, total):
    """逐帧「元音能量」包络（dB）：只取 90~1100Hz。

    张口的主要物理来源是元音（低波段能量），而 /s/ /ʃ/ /f/ 这类摩擦音能量几乎
    全在高频、嘴巴基本不动。用全带宽 RMS 会把这些音也当成「该张大嘴」，成片里
    就会出现「嘶—」的时候嘴张得最大。带通后再取 RMS，开口曲线才跟语音对得上。
    """
    from scipy import signal
    sr = SAMPLE_RATE
    step = max(1, int(round(sr / max(1.0, float(fps)))))
    n = int(min(total, max(1, int(len(wav) / float(step))))) if len(wav) else 0
    db = np.full(max(1, total), -90.0, np.float64)
    if n < 3:
        return db
    sos = signal.butter(2, [90.0, 1100.0], btype='bandpass', fs=sr, output='sos')
    y = signal.sosfilt(sos, np.asarray(wav, np.float64))
    for i in range(n):
        a = i * step
        b = min(len(wav), a + step)
        seg = np.asarray(y[a:max(b, a + 1)], np.float64)
        e = float(np.sqrt(np.mean(seg ** 2) + 1e-12))
        db[i] = 20.0 * np.log10(max(e, 1e-6))
    db = zero_phase_smooth(db, 1.6)
    return db


def audio_mouth_plan(wav, fps, total, bank_open):
    """配音 → 逐帧 (档位, 纵向形变系数)。整条片子只由音频决定，不看模型输出。

    规则：
      1) 子句（配音门 ≥ PAUSE_GATE 的连续段）内固定同一张供体——不换嘴就不抖；
      2) 子句的「典型开口」由这一句的音量决定（响的句子换一张更张的嘴），
         换档只发生在子句起点，而且立刻被形变吸收，没有逐帧换嘴；
      3) 子句内的逐帧开合 = 该句自己的元音包络（按句内 15/85 分位归一化），
         直接映射到 [开口下限/供体, 开口上限/供体] 这一段形变区间；
      4) 停顿：换到最闭合那张供体 + 形变 1（闭着的两张嘴长得一样，换档看不见）；
      5) 所有形变逐帧限速 FY_SLEW，任何情况下逐帧变化都不会超过这个量。

    返回 (lvl_seq, fy_seq, gate)。
    """
    n = max(1, int(total))
    bank = np.asarray(bank_open, np.float64)
    if bank.size == 0:
        return np.zeros(n, np.int32), np.ones(n, np.float64), np.ones(n, np.float64)
    db = band_env_seq(wav, fps, n)
    gate = audio_gate_seq(wav, fps, n)
    speech = gate >= PAUSE_GATE
    if int(speech.sum()) < 10:
        speech = np.ones(n, bool)
    # 子句切分
    clauses = []
    i = 0
    while i < n:
        if speech[i]:
            j = i
            while j + 1 < n and speech[j + 1]:
                j += 1
            clauses.append((i, j + 1))
            i = j + 1
        else:
            i += 1
    voiced = db[speech]
    p10, p90 = float(np.percentile(voiced, 10)), float(np.percentile(voiced, 90))
    o_lo = float(np.percentile(bank, PLAN_LO_PCT))
    o_hi = float(np.percentile(bank, PLAN_HI_PCT))
    # 目标表：每帧该用的档位与形变（未限速）
    tgt_lvl = np.zeros(n, np.int32)
    tgt_fy = np.ones(n, np.float64)
    for (a, b) in clauses:
        seg = db[a:b]
        if p90 > p10 + 1.0 and seg.size >= 3:
            rank = float(np.clip((np.median(seg) - p10) / (p90 - p10), 0.0, 1.0))
        else:
            rank = 0.5
        want = o_lo + rank * (o_hi - o_lo)
        L = int(np.argmin(np.abs(bank - want)))
        lo_c = float(np.percentile(seg, PLAN_DB_LO)) if seg.size >= 3 else p10
        hi_c = float(np.percentile(seg, PLAN_DB_HI)) if seg.size >= 3 else p90
        if hi_c < lo_c + 2.0:
            lo_c, hi_c = p10, p90
        span = max(2.0, hi_c - lo_c)
        # 形变区间 = 这一句自身的开口 × [0.72, 1.30]（相对、按句归一）。
        # 不能再用「全库 20/80 分位」的绝对区间：供体档位一变，同一个绝对区间
        # 就要靠 0.42~2.2 倍的形变去凑，实际只能截在 [0.78,1.36]，
        # 结果每句都在上下限之间把嘴拉长又压扁，句内合成动作还一模一样。
        bopen = max(1e-3, float(bank[L]))
        f_lo = float(np.clip(want * PLAN_FY_LO / bopen, FY_FLOOR, FY_CEIL))
        f_hi = float(np.clip(min(want * PLAN_FY_HI, PLAN_OPEN_MAX) / bopen, FY_FLOOR, FY_CEIL))
        if f_hi < f_lo + 0.12:
            f_hi = min(FY_CEIL, f_lo + 0.12)
        tgt_lvl[a:b] = L
        for k in range(a, b):
            s = float(np.clip((db[k] - lo_c) / span, 0.0, 1.0))
            tgt_fy[k] = f_lo + s * (f_hi - f_lo)
    # 停顿帧：最闭合供体 + 形变 1
    sil = ~speech
    tgt_lvl[sil] = 0
    tgt_fy[sil] = 1.0
    # 逐帧限速（停顿往闭合收的速度可以稍快一点，人闭嘴本来就比张嘴快）
    lvl = np.zeros(n, np.int32)
    fy = np.ones(n, np.float64)
    cur = 1.0
    sw = 0
    prev_l = 0
    for k in range(n):
        t = float(tgt_fy[k])
        lim = FY_SLEW * (1.6 if bool(sil[k]) else 1.0)
        cur += float(np.clip(t - cur, -lim, lim))
        cur = float(np.clip(cur, FY_FLOOR, FY_CEIL))
        lvl[k] = int(tgt_lvl[k])
        if lvl[k] != prev_l:
            sw += 1
            prev_l = int(lvl[k])
        fy[k] = cur
    log('mouth-plan clauses=%d levels=%d switches=%d fy(p50=%.2f p05=%.2f p95=%.2f) '
        'open(p50=%.3f)' % (
            len(clauses), len(set(lvl.tolist())), sw, float(np.median(fy)),
            float(np.percentile(fy, 5)), float(np.percentile(fy, 95)),
            float(np.median([bank[l] * f for l, f in zip(lvl, fy) if l]))))
    return lvl, fy, gate


def smooth_mouths(mouths, w, h):
    """嘴位修复：剔粗差 → 补缺帧 → 3 帧中值（去尖峰）→ 零相位高斯（去抖动）。

    以前这里是「9 帧中值 + 5 帧均值」。这个窗口在头部左右移动时会把嘴位平均到
    4 帧之前的位置——蒙版就滞后于真实的嘴唇，于是每帧都切掉一部分下唇、又把
    下唇下方的皮肤换进来，肉眼看就是嘴角那块「糊斑」。回贴的对齐用的是同一个
    估计量，常数偏差会自我抵消，真正需要的只有「平滑噪声」而不是「抹平运动」。
    但只有 3 帧中值还不够：YuNet 嘴角关键点在静止头部上逐帧仍有 ±1px 抖动，
    「a,b,a,b」这种交替抖动的中值正好等于抖动本身，等于没滤——用户看到的
    「嘴在抖」就是它，外加蒙版接缝在皮肤上来回移动。零相位高斯没有滞后，
    正好只削这种帧间高频。
    """
    n = len(mouths)
    if n == 0:
        return []
    idx = [i for i, m in enumerate(mouths) if m]
    if not idx:
        return [None] * n
    a = np.array([mouths[i][:3] for i in idx], np.float64)
    # 粗差剔除：与前后各 1 个有效锚点的中值比，位移或唇宽突变过大就判误检
    ref = a.copy()
    for k in range(len(a)):
        lo, hi = max(0, k - 1), min(len(a), k + 2)
        med = np.median(a[lo:hi], axis=0)
        bad = (abs(a[k, 0] - med[0]) > max(8.0, 0.12 * med[2])) \
            or (abs(a[k, 1] - med[1]) > max(8.0, 0.12 * med[2])) \
            or (abs(np.log(a[k, 2] / max(1.0, med[2]))) > 0.22)
        if bad:
            ref[k] = med
    xs = np.arange(n, dtype=np.float64)
    out = np.empty((n, 3), np.float64)
    for j in range(3):
        out[:, j] = np.interp(xs, np.array(idx, np.float64), ref[:, j])
    # 3 帧中值：只压单帧尖峰，零滞后
    sm = out.copy()
    for i in range(n):
        lo, hi = max(0, i - 1), min(n, i + 2)
        for j in range(3):
            sm[i, j] = np.median(out[lo:hi, j])
    # 零相位高斯：唇心/唇宽各削一层帧间抖动。唇宽在对数域平滑（它是乘性量）。
    # sigma=1.1 帧约 50ms，只压 ±1~2px 的来回跳，不抹掉真实的说话动作。
    sm[:, 0] = zero_phase_smooth(sm[:, 0], 1.1)
    sm[:, 1] = zero_phase_smooth(sm[:, 1], 1.1)
    lw = zero_phase_smooth(np.log(np.maximum(1.0, sm[:, 2])), 1.4)
    sm[:, 2] = np.exp(lw)
    seq = []
    for r in sm:
        cur = [float(r[0]), float(r[1]), float(r[2])]
        cur[0] = min(max(1.0, cur[0]), w - 1.0)
        cur[1] = min(max(1.0, cur[1]), h - 1.0)
        cur[2] = min(max(24.0, cur[2]), 0.7 * w)
        seq.append((cur[0], cur[1], cur[2]))
    return seq
# ---------------------------------------------------------------- 口型重定时
# 病根（两轮实测）：
#  1) 上一版按「人脸框固定比例」框嘴：Haar 在反光眼镜 + 人群背景里会整段锁到
#     「只剩上半张脸」甚至画面底部的紫色挂绳上，ROI 落到眼镜/下巴/画外。
#  2) 再上一版改成「脸下半部按暗+红搜嘴唇」：嘴唇线索太弱，实测 76s 定位误差 80px，
#     描述子/张开度/蒙版全部落在下巴上 → 成片里嘴角一片粉红糊斑，口型与配音无关
#     （自检互相关只有 0.075，lag 在 ±1.5s 乱跳）。
#  3) 蒙版半高取 0.85 倍唇高，而「唇高」按 lw/1.75 估成了 1.75:1 的扁椭圆——
#     实际唇高只有唇宽的 1/4.6，于是蒙版比嘴唇高 3 倍，把鼻下、下巴整段换了像素；
#     供体与当前帧的肤色/光照再一致，低频一叠就是一条「磨皮带」（用户截图那块）。
#  4) lip_chroma 按蒙版把供体色度整体平移，蒙版没落在嘴上时嘴角立刻多一块红斑。
# 现在：人脸用多角度级联（歪头也能检），唇心/唇宽用「旋正 + 唇色投影」（色彩定位，
# 不依赖眼镜、牙齿、张口）；蒙版只贴合嘴唇本体，对色只在蒙版外的「皮肤环」上做加性
# 校正，唇线/牙缝一律不动。唇心估计若有常数偏差，供体与当前帧用同一个估计量对齐，
# 偏差会自我抵消——真正要紧的是帧间方差，由 smooth_mouths 的时序滤波负责压掉。
MASK_RX = 0.57                   # 蒙版半宽 / 唇宽（蒙版横向就压在两侧嘴角上）
# 蒙版半高必须**贴着真实嘴唇**，不能按「嘴唇占多大一块」凭感觉给。
# 在这条 816×1440 的口播上量（YuNet 双嘴角 = 唇宽基准）：
#   闭嘴时上下唇外缘总高 ≈0.30 唇宽 → 半高 0.15；全张时（含牙齿）≈0.60 → 半高 0.30。
# 以前写 0.26 / 0.34（合计 0.60）等于「闭嘴也按半张来盖」，蒙版上沿压在人中、
# 下沿压在下唇下方的下巴上，那两个位置被换成供体的皮肤；供体来自另一时刻，
# 光照/白平衡本来就有差，叠上去就是用户截图里「嘴上一圈灰斑」和嘴角的双层唇线。
# 现在闭嘴 0.17（≈1.15 倍真实半高），全张 0.32，只多盖 2~3 像素作为羽化余量。
MASK_RY = 0.16                   # 蒙版半高 / 唇宽（闭嘴）
# 张口时（上唇上抬、下唇下沉、牙齿整块露出来）纵向必须跟着长，否则上/下排牙齿
# 正好压在羽化带上，会被「供体的牙齿」和「当前帧自己的牙齿」各掺一半，
# 唇齿交界处就是一片发丝状的网纹重影（用户在 01:16 反馈的那块「糊斑」）。
MASK_RY_OPEN = 0.18              # 张口到最大时，蒙版半高再增加 0.18 倍唇宽
REGION_RH = 1.34                 # 回贴区域高 / 唇宽（要装得下最张的蒙版 + 一圈皮肤环）
MASK_DY = 0.0                    # 蒙版中心相对嘴中心的下移（实测≈0，留着便于微调）
MASK_FEATHER = 0.12              # 羽化带占半径的比例（越小越硬，接缝越干净）
AB_FIELD_CLAMP = 26.0            # 低频光照场 a/b 的上限（超过这个量级已是换了场景）
# 亮度场单独放宽：5.0s 那一段实测供体（来自 77s）整片比当前帧亮 36 个灰阶，
# 夹在 26 就等于「只搬了三分之二」，剩下的 10 个灰阶留在嘴唇上 → 嘴唇发白发冷。
# L 是加性偏移，跟着当前帧的曝光走，放到 ±48 也不会破坏唇线结构。
L_FIELD_CLAMP = 48.0
# 唇度判别量：lipness = (a-128) - k*(b-128)。
# 暖光/红光下皮肤是「a≈+10、b≈+18」，嘴唇是「a≈+13、b≈+8」，按色度大小排序
# 皮肤反而比嘴唇高——这就是旧蒙版把下巴/人中选进来的原因。嘴唇的特征是
# 「a 相对 b 更高」，这个比值与曝光无关，实测唇面比皮肤高 6~10，两种光线下都成立。
LIP_AB_RATIO = 0.55
LIP_MIN_CONTRAST = 3.0           # lipness 对比度下限：低于此判不出唇（退椭圆蒙版）
# 唇形分割版本：供体库里存的 mmask/cav/marks 必须与当前 matte_parts 同版本。
# 换算法而不重建供体库时，_warp_donor 会按这个标记就地重算（见下面的自愈逻辑）。
MATTE_VER = 2
DESC = (40, 20)                  # 嘴型描述子尺寸（灰度）
MIN_LAP = 20.0                   # 供体整块清晰度门槛（拉普拉斯方差）
MIN_BLAP = 30.0                  # 供体「唇部」清晰度门槛：低于此值贴上去就是一团粉红
MAX_DONORS = 240                 # 供体上限：约 40~110MB，16GB 机器上留足推理余量
# 张口度档位数：每档只认**一张**供体（见 MouthRetimer._build_bank）。
# 逐帧自由挑供体时，两张几乎等价的供体会互相顶替（实测每 100 帧换 37 次脸），
# 唇线厚度/牙齿形状/高光位置每换一次就跳一次，肉眼就是「嘴在抖」；
# 档位化之后整条片子最多只出现 LEVELS 张嘴，档位不变就不换像素。
# 13 档实测还是太密：整片 1805 帧里档位变了 454 次（25%），每变一次像素就换一张嘴，
# 肉眼看仍然是「说话时嘴在跳」。现在换嘴只在「一子句一次」量级（见 audio_mouth_plan）：
# 档位仍然保留 LEVELS 张备选，但一句只锁一张，开合由纵向形变吸收。
LEVELS = 9
# ---------------------------------------------------------------- 开口计划
# 张口度不再取自 Wav2Lip 的 96×96 输出。实测那份重绘图里量出来的「唇内暗腔占比」
# 与配音包络的相关系数只有 0.00（纯噪声，见 docs 与 sim 记录），用它驱动会让嘴部
# 张合和目标语言完全脱钩——用户反馈的「嘴型没和目标语言对齐」「嘴抖得厉害」都是它：
# 噪声每帧在 0.78/1.42 两个形变极限之间来回撞，等于每帧把嘴拉长又压扁。
# 现在的驱动量是配音本身：元音（90~1100Hz 带通能量）才让下巴落下去，齿音/气声
# 几乎不改变开口。逐子句归一化后套到「原片同一张嘴」的纵向形变上，逐帧限速，
# 于是「张合 = 配音音节」且连续无跳。
PAUSE_GATE = 0.18                # 配音门低于此值算停顿：闭嘴上换档（看不见）
PLAN_LO_PCT = 20                 # 子句开口下限 = 供体库张口度的 20 分位
PLAN_HI_PCT = 80                 # 子句开口上限 = 供体库张口度的 80 分位
PLAN_DB_LO = 15                  # 子句内包络归一化的下分位（dB）
PLAN_DB_HI = 85                  # 子句内包络归一化的上分位（dB）
FY_FLOOR = 0.66                  # 形变硬下限（再小嘴唇薄得失真）
FY_CEIL = 1.36                   # 形变硬上限（再大嘴唇拉长失真）
# 逐帧形变限速。以前 0.065 是为了压住「96px 预测噪声驱动」时的抽动；现在驱动量
# 是平滑后的元音包络（本身没有抖动），再夹这么小就等于把嘴变慢：从峰值 1.30
# 合到 0.72 要走 9 帧（22fps 下 0.41 秒），而真实音节切换只要 0.15~0.2 秒，
# 成片看起来就是「嘴比配音慢半拍」（用户反馈的「没对齐」有很大一部分是它）。
# 0.13 下同样的行程 4.5 帧 ≈0.2 秒，和音节切换一致；全片实测 0.13 时 29% 的帧
# 顶在限幅上（还在拖慢），放到 0.18 后全片开口序列与配音包络的相关性 0.80、
# 与目标开口的逐帧偏差 p50 只有 0.007，形变幅度 p95 仍是 0.18 以内，不会抖。
FY_SLEW = 0.18
PLAN_FY_LO = 0.68                # 子句内最轻音节：把这张嘴压到 0.68（基本合上）
PLAN_FY_HI = 1.32                # 子句内最响音节：拉到 1.32（开口峰值）
PLAN_OPEN_MAX = 0.52             # 贴上去的嘴最多张到这个「原片尺度」（≈全库 95 分位）
OPEN_W = 26.0                    # 张嘴程度不匹配的罚分系数（0.1 的差 ≈ 2.6 分）


class MouthRetimer:
    """原片高清嘴部供体库 + 逐帧重定时"""

    def __init__(self, w, h):
        import cv2
        self.cv2 = cv2
        self.w, self.h = w, h
        self.donors = []
        self._desc_stack = None
        self._lw = np.zeros(0, np.float32)
        self._blap = np.zeros(0, np.float32)
        self._open = np.zeros(0, np.float32)
        self._open_sorted = np.zeros(0, np.float32)
        self._open_rank = np.zeros(0, np.float32)
        self._idx = np.zeros(0, np.int32)
        # 色度签名（唇相对皮肤的色差）与换档打分的缓存项（见 lip_sig / _pick_donor）
        self._sig = None
        self._sig_ok = None
        self._base = None
        self._size_pen = None
        self._clear = None
        self._med_blap = 1.0
        self._med_lw = 1.0
        # 上一帧的低频光照场（LAB 三通道），供体换帧时用它做时序混合，避免色温跳
        self._df = None
        # 档位 → 固定供体（见 _build_bank）：整条片子只用这 LEVELS 张嘴
        self._bank = []
        self._bank_open = []
        self._bank_rank = []
        # 上一帧贴的是哪张供体（换档时做一次同开口混合，把纹理跳变摊平）
        self._last_k = None
        self._last_lvl = 0
        self._last_i = -99
        self._last_fy = 1.0
        self._last_fy_use = 1.0
        # 当前正在用的供体（档位不变就一直用它；换档时按当前帧重挑，见 _pick_donor）
        self._ctx_k = None
        self._ctx_lvl = -1
        self._lc = None             # 唇面 (L, a, b) 偏移的上一帧值（时序平滑用）
        self._dlip = None           # 唇内低频色场的上一帧值（时序平滑用）
        self.stats = {'lip': 0, 'skip': 0, 'scale': 0, 'selfwarp': 0,
                      'score': [], 'openpen': [], 'fy': []}
        # _warp_donor 在「按唇形分段配准」路径里算出的 (计划口腔高度, 本帧口腔高度)，
        # apply 据此判断这一帧能否直接对**当前帧自己的嘴**做纵向形变（见 self_warp）
        self._warp_h = None
        self._grids = {}
        # 诊断用（TP_LIP_DEBUG=1 时逐帧记录清晰度链路），生产运行零开销
        self.dbg = os.environ.get('TP_LIP_DEBUG') == '1'
        if self.dbg:
            self.dbg_rows = []

    @property
    def count(self):
        return len(self.donors)

    # ---------------- 几何：全部以嘴唇为准，与人脸框解耦 ----------------
    def region(self, mouth):
        """取像素/回贴区域（全帧坐标）：宽 1.9 倍唇宽、高 1.34 倍唇宽。

        只由「嘴唇中心 + 唇宽」决定，所以供体与当前帧在区域里的相对位置恒为
        「嘴唇中心」，对齐就退化成「平移 + 按唇宽缩放」，不再依赖人脸框比例，
        也不需要 ORB/RANSAC——那套在嘴唇/牙齿差异大时正好会被带偏，把嘴拉长拉糊。
        区域贴边时整体内移（不截断），保证每一帧区域尺寸一致，缩放系数才对得上。
        高度取 1.34 倍唇宽：最张的时候蒙版半高会到 0.60 倍唇宽（上下共 1.2 倍），
        再留出上下各一圈皮肤，蒙版才不会顶到区域边缘（顶到就有了硬边接缝）。
        """
        cx, cy, lw = mouth[0], mouth[1], mouth[2]
        rw = max(48, int(round(lw * 1.9)))
        rh = max(40, int(round(lw * REGION_RH)))
        rx1 = int(round(cx - rw / 2.0))
        ry1 = int(round(cy - rh / 2.0))
        if rx1 < 0:
            rx1 = 0
        if rx1 + rw > self.w:
            rx1 = max(0, self.w - rw)
        if ry1 < 0:
            ry1 = 0
        if ry1 + rh > self.h:
            ry1 = max(0, self.h - rh)
        return rx1, ry1, min(self.w, rx1 + rw), min(self.h, ry1 + rh)

    def sub_rect(self, h, w, ex, ey, lw):
        """嘴唇自身子窗（区域坐标）：1.1 唇宽 × 0.44 唇宽（≈ 上下唇 + 一点余量）。"""
        hw = max(8.0, lw * 0.55)
        hh = max(6.0, lw * 0.22)
        x1 = int(max(0, ex - hw))
        x2 = int(min(w, ex + hw))
        y1 = int(max(0, ey + lw * MASK_DY - hh))
        y2 = int(min(h, ey + lw * MASK_DY + hh))
        if x2 - x1 < 12 or y2 - y1 < 8:
            return None
        return x1, y1, x2, y2

    def desc_of(self, patch, ex, ey, lw):
        cv2 = self.cv2
        rect = self.sub_rect(patch.shape[0], patch.shape[1], ex, ey, lw)
        if rect is None:
            return None
        x1, y1, x2, y2 = rect
        g = cv2.cvtColor(patch[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)
        g = cv2.resize(g, DESC, interpolation=cv2.INTER_AREA).astype(np.float32)
        g -= g.mean()
        return g / (g.std() + 1e-3)

    def open_of(self, patch, ex, ey, lw):
        """嘴唇「张开程度」：嘴心小块里暗腔（口腔/齿缝/唇缝阴影）的像素占比。

        光靠描述子相关性挑供体不够：描述子只保证「纹理相似」，不保证「张嘴程度相同」。
        目标帧闭嘴而供体大张嘴时，贴上去就是「当前嘴唇 + 供体口腔阴影」两层叠在一起，
        下唇下方那道紫黑暗带、以及「嘴上一团糊」都是这么来的。阈值按子窗自身的
        90 分位取（与曝光/唇彩无关），再转成全库百分位排名比大小，
        这样 96×96 的模糊目标图也能得到可比的张开程度。
        窗口只取嘴心（0.64 唇宽 × 0.28 唇宽）：恰好是口腔/牙齿所在的范围，
        嘴角与下巴都在外面，不会把唇线重点或下颌阴影当成暗腔。
        """
        cv2 = self.cv2
        h, w = patch.shape[:2]
        hw = max(6.0, lw * 0.32)
        hh = max(4.0, lw * 0.14)
        cy = ey + lw * MASK_DY
        x1 = int(max(0, ex - hw))
        x2 = int(min(w, ex + hw))
        y1 = int(max(0, cy - hh))
        y2 = int(min(h, cy + hh))
        if x2 - x1 < 8 or y2 - y1 < 5:
            return 0.0
        sub = patch[y1:y2, x1:x2]
        g = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY).astype(np.float32) if sub.ndim == 3 else sub
        thr = max(30.0, float(np.percentile(g, 90)) * 0.62)
        return float((g < thr).mean())

    def lip_edges(self, patch, ex, ey, lw):
        """供体「上唇下缘 → 下唇上缘」两行（补丁坐标），用来做「只拉开口腔」的形变。

        整块补丁等比纵向缩放时，fy 一拉嘴唇厚度也跟着变（fy=1.3 时厚 30%，
        下唇那道高光被拉成一条厚白带，看着像涂了唇釉），下巴还被压缩，脸型都在动。
        真实的张嘴是「上唇基本不动、下颌下移」，所以必须先知道口腔那一段在哪儿。
        做法：口腔/牙齿的色度（LAB chroma）天然低于唇面，取嘴心中心列的行中位
        色度，低于窗口内「唇面 80 分位 → 最低值」的 45% 视为口腔，再以最靠近
        嘴中心的那一段为准并限制在嘴心 ±0.34 唇宽内；判不准就退回「整段等于
        嘴中心」，此时形变等同于旧行为，不会比现在更差。
        """
        cv2 = self.cv2
        h, w = patch.shape[:2]
        half = max(4, int(round(lw * 0.30)))
        x1, x2 = int(max(0, ex - half)), int(min(w, ex + half))
        y1 = int(max(0, ey - lw * 0.34))
        y2 = int(min(h, ey + lw * 0.36))
        if x2 - x1 < 6 or y2 - y1 < 8:
            return None
        lab = cv2.cvtColor(patch[y1:y2, x1:x2], cv2.COLOR_BGR2LAB).astype(np.float32)
        ch = np.maximum(np.abs(lab[:, :, 1] - 128.0), np.abs(lab[:, :, 2] - 128.0))
        cw = ch.shape[1]
        mid = ch[:, int(cw * 0.25):max(int(cw * 0.75), int(cw * 0.25) + 1)]
        prof = np.median(mid, axis=1)
        hi = float(np.percentile(prof, 80))
        lo = float(np.min(prof))
        if hi < 7.0 or hi - lo < 3.0:
            return None
        inside = prof < (lo + 0.45 * (hi - lo))
        rows = np.where(inside)[0]
        if rows.size == 0:
            return None
        k = int(rows[np.argmin(np.abs(rows - (ey - y1)))])
        a = k
        while a - 1 >= 0 and bool(inside[a - 1]):
            a -= 1
        b = k
        while b + 1 < inside.size and bool(inside[b + 1]):
            b += 1
        u = float(y1 + a)
        l = float(y1 + b + 1)
        if (l - u) > lw * 0.55 or u > ey + lw * 0.10 or l < ey - lw * 0.10:
            return None
        return (u, l)

    def _open_rank_of(self, value):
        """把张开程度映射成「在全库里的百分位」，抵消两张图各自曝光/模糊带来的尺度差"""
        if self._open.size == 0:
            return 0.0
        return float(np.searchsorted(self._open_sorted, value, side='left')) / float(self._open.size)

    def mask_of(self, h, w, ex, ey, lw, open01=0.0, fy=1.0):
        """回贴蒙版：**只盖住嘴唇本体** + 一圈羽化，外加一圈外侧「皮肤环」供对色。

        上一版蒙版半宽 0.72 唇宽、半高 0.85「唇高」(=lw/1.75≈0.57lw)，整块约
        1.44lw × 0.97lw——而真实嘴唇只有 1.0lw × 0.22lw。多出来的 3 倍高度全是
        鼻下与下巴的皮肤，供体又是另一帧（头动几像素），低频一叠就成了一条
        「磨皮带」（用户 01:16 截图里那块糊斑正是它）。
        现在是：半宽 0.57 唇宽；半高闭嘴时 0.20 唇宽、张口时按张口程度最多长到
        0.36 唇宽（open01 就是贴上去那张嘴的开口归一值），再乘纵向形变 fy：
        贴上去的嘴被拉高 fy 倍时，蒙版必须同步长高，否则「当前帧自己的嘴唇」
        会从蒙版上下边缘露出来，就在嘴唇外面留一圈淡影（实测 y±0.25 唇宽处
        色相从暖粉( B-R=-50 )变成中性白( B-R≈0 )，肉眼就是「一圈紫白口红」）。
        羽化 12% 半径，接缝落在嘴角外侧的皮肤上，肉眼看不出来。
        """
        key = ('m', h, w)
        grid = self._grids.get(key)
        if grid is None:
            yy, xx = np.mgrid[0:h, 0:w]
            grid = (xx.astype(np.float32), yy.astype(np.float32))
            self._grids[key] = grid
        xx, yy = grid
        o = float(np.clip(open01, 0.0, 1.0))
        f = float(np.clip(fy, FY_FLOOR, FY_CEIL))
        rx = max(6.0, lw * MASK_RX)
        ry = max(4.0, lw * (MASK_RY + MASK_RY_OPEN * o) * (0.90 + 0.10 * f))
        cy = ey + lw * MASK_DY
        r = np.sqrt(((xx - ex) / rx) ** 2 + ((yy - cy) / ry) ** 2)
        mask = np.clip((1.0 - r) / MASK_FEATHER, 0.0, 1.0)
        # 皮肤环：蒙版外 1.12~1.7 号半径，只在这里统计色差（唇内的唇线/牙缝不动）
        ring = np.clip((r - 1.12) / 0.12, 0.0, 1.0) * np.clip((1.70 - r) / 0.20, 0.0, 1.0)
        return mask[:, :, None], ring[:, :, None]

    @staticmethod
    def open01_of(value):
        """把原片尺度的张口度归一化到 0~1（闭嘴≈0.15、最大≈0.55），给蒙版用"""
        return float(np.clip((float(value) - 0.15) / 0.40, 0.0, 1.0))

    def lip_stats(self, patch, mask):
        """唇面统计 → (校正权重, 均值权重, (L, a, b) 加权均值)，量不到返回 None。

        旧做法是「亮度 35~80 分位 ∩ a ≥ 55 分位」的硬选择 + 膨胀 3px，两个死角：
          · 选出来的永远是**最红**的那一块，而真正出问题的是「偏淡/偏蓝」的那一块
            （用户截图红框里的淡紫唇），硬选择恰好把它排除在可校范围之外，
            于是每帧都在修「已经不紫的地方」，紫的地方一直修不到；
          · 求均值的集合里混着嘴唇上方的皮肤（a≈13 对唇面 a≈25），均值被拉淡
            → 目标本身偏灰白，校完就是淡紫唇。
        现在拆成两份软权重：
          w_app（校正范围）= 蒙版 × 色度权重。色度权重按「偏离中性多少」平滑取值
            （|a-128|、|b-128| 各到 8 为满值），所以唇面（无论浓淡）都是 1，
            牙齿/齿间高光（近中性）≈0 —— 白牙不会被染成黄牙或蓝牙。
          w_tgt（求均值）= 校正范围 × 亮度权重（蒙版内 25~72 分位当唇面，更亮
            是牙齿、更暗是口腔，两头 6 灰阶平滑衰减），牙齿与下巴皮肤不进均值。
        """
        cv2 = self.cv2
        band = mask[:, :, 0] if mask.ndim == 3 else mask
        band = np.clip(band.astype(np.float32), 0.0, 1.0)
        core = band > 0.55
        if int(core.sum()) < 40:
            return None
        lab = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32)
        L = lab[:, :, 0]
        chroma = np.maximum(np.abs(lab[:, :, 1] - 128.0), np.abs(lab[:, :, 2] - 128.0))
        # /4 而不是 /8：上唇偏淡时 |a-128| 只有 5~8，/8 会把它降到 0.6~0.8，
        # 于是「越淡的地方修的越少」，淡紫上唇永远修不回来（实测 t8 上唇 a 比
        # 原片低 6 就是这个原因）。/4 下只要不是严格中性（牙齿 a±2）就按满权修。
        w_app = np.clip(chroma / 4.0, 0.0, 1.0) * band
        # 亮度分位只在「有唇色」的像素上取：蒙版现在把口腔（填洞）也包进来了，
        # 直接用 core 求分位会把暗腔压进 25 分位、把牙齿抬进 72 分位，
        # 得到的「唇面亮度窗口」正好错开真正的唇面，目标均值又偏灰。
        lpk = core & (chroma >= 5.0)
        if int(lpk.sum()) < 40:
            lpk = core
        # 亮度窗口用「几乎整片唇面」而不是 25~72 分位：窗口太窄等于只取唇心最浓的
        # 那一小块，目标均值天然偏饱和（实测 25 分位窗口给出的目标 a+25.5，
        # 而整片唇面只有 a+24.0），闭环再把整片唇面推到唇心 → 颜色过冲。
        # 牙齿/暗腔本来就不是唇色（色度权重≈0），不需要靠亮度窗口排除。
        lo = float(np.percentile(L[lpk], 12))
        hi = float(np.percentile(L[lpk], 88))
        wl = (np.clip((L - (lo - 9.0)) / 9.0, 0.0, 1.0)
              * np.clip(((hi + 9.0) - L) / 9.0, 0.0, 1.0))
        w_tgt = w_app * wl
        s = float(w_tgt.sum())
        if s < 60.0:
            # 整张嘴都是牙齿/暗腔（例如大笑）时退化成按色度权重求均值
            w_tgt = w_app
            s = float(w_app.sum())
            if s < 60.0:
                return None
        mean = tuple(float((lab[:, :, ch] * w_tgt).sum() / s) for ch in range(3))
        return w_app[:, :, None], w_tgt[:, :, None], mean

    def lip_sig(self, patch, ex, ey, lw, matte=None, ring=None):
        """唇面「相对皮肤」的色度签名（6 维：ΔL/Δa/Δb + 唇面 L/a/b）。

        用来挑**同一段光照**下的供体。只比绝对值没用：供体来自另一段光照时
        整片亮 30~40 个灰阶，绝对值全对不上；但「唇比皮肤暗多少、红多少」在同一
        段光里几乎不变。实测 5.0s 当前帧的唇比皮肤暗 15 个灰阶、黄 7 个单位，
        而 77s 那张供体的唇比它**自己的皮肤还亮** 13 个灰阶——这种供体贴上去，
        调色再准也是「嘴唇比脸亮一档」，肉眼就是一块贴纸。
        """
        cv2 = self.cv2
        m = matte if matte is not None else self.mouth_matte(patch, ex, ey, lw)
        if m is None:
            return None
        st = self.lip_stats(patch, m[:, :, None])
        if st is None:
            return None
        if ring is None:
            ring = self.mask_of(patch.shape[0], patch.shape[1], ex, ey, lw,
                                self.open01_of(self.open_of(patch, ex, ey, lw)))[1]
        wr = np.clip(ring[:, :, 0].astype(np.float32), 0.0, 1.0)
        s = float(wr.sum())
        if s < 60.0:
            return None
        lab = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32)
        sk = np.array([float((lab[:, :, c] * wr).sum() / s) for c in range(3)], np.float32)
        lip = np.asarray(st[2], np.float32)
        return np.concatenate([lip - sk, lip])

    def mouth_matte(self, patch, ex, ey, lw):
        """嘴唇本体蒙版（补丁坐标），见 matte_parts"""
        return self.matte_parts(patch, ex, ey, lw)[0]

    def cavity(self, patch, ex, ey, lw):
        """口腔（牙齿/暗腔）的上下缘（补丁坐标），给 _warp_donor 只拉伸这一段。

        旧版用 lip_edges 在中列找「低色度行」：暖光下上唇自身色度也低，
        实测 5.0s 那帧把整片上唇判成口腔，u 落到上唇上方 10 多像素，
        fy=1.36 的形变于是把**上唇整块往上拉**——成片上唇糊成一片、人中处
        多出一条唇色带（这就是「贴上去」最明显的地方）。
        这里直接用填洞：唇面围起来的那块必然是口腔，上下缘就是开口。
        判不出（闭嘴没有内孔）时退回 lip_edges。
        """
        _, holes = self.matte_parts(patch, ex, ey, lw)
        if holes is not None:
            ys, _ = np.nonzero(holes > 0.5)
            if ys.size >= 40:
                u, l = float(ys.min()), float(ys.max() + 1)
                # 合理性：口腔必须跨过嘴心，且高度不超过 0.6 唇宽
                if (l - u) >= 3.0 and (l - u) <= lw * 0.60 and u < ey + 0.12 * lw \
                        and l > ey - 0.12 * lw:
                    return (u, l)
        return self.lip_edges(patch, ex, ey, lw)

    def matte_parts(self, patch, ex, ey, lw):
        """嘴唇本体（含口腔内孔）的软蒙版 + 内孔（补丁坐标）。

        唇色分割在这张素材上有两种历史失败，两头都很难看：
          · 只留**一个**连通域时经常只切到半张嘴（5.0s 只到上唇、21.0s 只到右半、
            66.0s 只剩一小块）：开口时上下唇在嘴角处断开成两块，暖光下左右半张脸的
            唇度也不一样（实测 21s 左边差 6 个色度），留一块就丢掉另一半。所有锚点、
            唇色目标、回贴蒙版都跟着偏 → 供体嘴角压在皮肤上、原片嘴角露在外面，
            用户看到的就是「一张嘴贴在脸上」；
          · 逐列自适应阈值又会**过度分割**（74s/80s 抓到 259px ≈ 1.3 唇宽，把下巴、
            人中一起吞进来），因为逐列归一化后皮肤上的微弱暖色也被判成唇。
        现在两头一起收：
          · 判别仍用与曝光无关的唇度 lipness = (a-128) - 0.55*(b-128)（唇=a 高 b 低，
            皮肤=a 中 b 高，实测唇面高出 6~10），阈值取带内 30/96 分位的中点；
          · **低阈值取并集**，但只认「穿过唇心核心带」的块：核心带 = 嘴心 ±0.30 唇宽、
            上下 -0.30/+0.38 唇宽。上唇弧与下唇弧都会穿过它，而人中、鼻影、下巴、
            嘴角外侧的皮肤不会；
          · 再加一层**几何支撑**（YuNet 双嘴角给出的唇部先验）：横 ±0.54 唇宽、
            纵 -0.32/+0.42 唇宽、外缘 0.05 唇宽羽化。即使色度在这张暖光素材上判错，
            蒙版也不可能跑到嘴外——「贴上去的嘴比脸上真实的嘴宽一圈」从几何上被掐死；
          · 口腔（牙齿/暗腔）用**填洞**得到，不再猜行（旧版 lip_edges 在 5.0s 把
            整片上唇当成口腔，矩形连同人中一起盖住，成片上是唇左上角一块红斑）。
        """
        cv2 = self.cv2
        h, w = patch.shape[:2]
        # 几何先验窗口（YuNet 嘴角）：比支撑再放宽一圈，给阈值统计留边
        hx = int(round(lw * 0.56))
        hu = int(round(lw * 0.38))
        hd = int(round(lw * 0.50))
        x1, x2 = int(max(0, ex - hx)), int(min(w, ex + hx))
        y1, y2 = int(max(0, ey - hu)), int(min(h, ey + hd))
        if x2 - x1 < 12 or y2 - y1 < 12:
            return None, None
        sub = patch[y1:y2, x1:x2]
        lab = cv2.cvtColor(sub, cv2.COLOR_BGR2LAB).astype(np.float32)
        lp = (lab[:, :, 1] - 128.0) - LIP_AB_RATIO * (lab[:, :, 2] - 128.0)
        base = float(np.percentile(lp, 30))
        top = float(np.percentile(lp, 96))
        if top - base < LIP_MIN_CONTRAST:
            return None, None
        lo = base + 0.30 * (top - base)
        binm = (lp >= lo).astype(np.uint8)
        binm = cv2.morphologyEx(binm, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        n, labc, st, cent = cv2.connectedComponentsWithStats(binm, 8)
        if n <= 1:
            return None, None
        area_min = max(60.0, lw * lw * 0.020)
        kx0, kx1 = ex - x1 - 0.30 * lw, ex - x1 + 0.30 * lw
        ky0, ky1 = ey - y1 - 0.30 * lw, ey - y1 + 0.38 * lw
        keep = np.zeros_like(binm)
        for i in range(1, n):
            if float(st[i, cv2.CC_STAT_AREA]) < area_min:
                continue
            ys_, xs_ = np.nonzero(labc == i)
            hit = int(((xs_ >= kx0) & (xs_ <= kx1) & (ys_ >= ky0) & (ys_ <= ky1)).sum())
            if hit < 30:
                continue
            keep[labc == i] = 1
        if not keep.any():
            return None, None
        comp = keep.astype(np.uint8)
        # 填洞：唇面围起来的牙齿/暗腔一起换，否则「供体的牙」和「原片的牙」叠成网纹
        ff = np.pad(comp, 1)
        ffm = np.zeros((ff.shape[0] + 2, ff.shape[1] + 2), np.uint8)
        cv2.floodFill(ff, ffm, (0, 0), 1)
        holes = (ff[1:-1, 1:-1] == 0).astype(np.uint8)
        # 内孔只保留「真正露出来的口腔」：细的唇缝（闭嘴时那一条）不算，否则
        # cavity() 会把开口高度算成 2~3px，形变等于没生效。
        n2, labh, sth, _ = cv2.connectedComponentsWithStats(holes, 8)
        holes2 = np.zeros_like(holes)
        for i in range(1, n2):
            hgt = float(sth[i, cv2.CC_STAT_HEIGHT])
            wid = float(sth[i, cv2.CC_STAT_WIDTH])
            if float(sth[i, cv2.CC_STAT_AREA]) >= max(30.0, lw * lw * 0.008) \
                    and hgt >= 3.0 and wid >= 0.18 * lw:
                holes2[labh == i] = 1
        matte = np.maximum(comp, holes).astype(np.float32)
        matte = cv2.GaussianBlur(matte, (0, 0), float(max(1.0, lw * 0.010)))
        # 几何支撑：把「唇色判出来的形状」裁进 YuNet 给出的唇部范围。
        # 支撑外缘用 0.05 唇宽羽化到 0，所以蒙版边界不会有一条直边接缝，
        # 但它**不可能**越过 ±0.54 唇宽——这条约束就是「贴上去的嘴比脸宽一圈」的
        # 兜底（色度失灵时也不会出贴纸）。纵向给得宽（-0.36/+0.52 唇宽）：
        # 张嘴那一帧嘴唇本体能低到 +0.44 唇宽，支撑只做上限、不主动加面积。
        X = np.arange(w, dtype=np.float32)[None, :]
        Y = np.arange(h, dtype=np.float32)[:, None]
        fx = max(1.0, 0.05 * lw)
        wx = np.clip((0.54 * lw + fx - np.abs(X - ex)) / fx, 0.0, 1.0)
        wy = np.clip(((ey + 0.52 * lw + fx) - Y) / fx, 0.0, 1.0) \
            * np.clip((Y - (ey - 0.36 * lw - fx)) / fx, 0.0, 1.0)
        support = np.minimum(wx, wy).astype(np.float32)
        out = np.zeros((h, w), np.float32)
        out[y1:y2, x1:x2] = matte
        out = np.clip(out * support, 0.0, 1.0)
        cav = np.zeros((h, w), np.float32)
        cav[y1:y2, x1:x2] = holes2.astype(np.float32)
        return out, cav

    def match_lip_color(self, cur, mcur, out, mout, lw=80.0, smooth=True, split=None):
        """把供体的**整片唇面** L/a/b 对齐到当前帧自己的唇面（均值闭环 + 唇内色场）。

        两个参考蒙版必须分开，混用就会在 5.0s 那种暖光帧上校出「一块深红唇块」：
          mcur —— 当前帧**自己的唇形**（mouth_matte）。目标均值只从真正的唇面来；
                  旧版这里是「唇心椭圆」，上唇上方的皮肤 b 比嘴唇高 6 个色度，
                  目标被拉偏，校完上唇发灰、下唇偏红（同一张嘴两截颜色）。
          mout —— 回贴蒙版（供体唇形 ∪ 当前唇形），只表示要改哪块像素。

        三步（限幅是这一版的重点）：
          ① 均值闭环：把整片唇面的 (L,a,b) 均值拉到目标。第一轮 L±14 / a,b±10，
             之后 L±10 / a,b±7，最多 4 轮。旧版第一轮 L±12 / a,b±8、之后 ±6/±5，
             供体跨光照段时差 30 个灰阶根本收不进去——5.0s 成片唇面 L 比原片低
             12、a 高 3.6，就是「夹住收不动」留下的残差（肉眼=深红块 + 白唇带）。
             限幅只作用在唇面软蒙版内（w_app），越界不会抹到嘴边皮肤上。
          ② 唇内低频色场：只对齐均值时供体「上唇偏淡、内部偏红」的结构会原样保留，
             这里用唇面权重归一化的模糊相减，只在两侧都判定为唇面的位置叠回去。
          ③ 色场会让均值略微偏移，最后再补几轮（±5 / ±4）。
        时间平滑只在同一张供体内做（±6/±4）；换供体时由 apply() 清空初值，
        否则要拖 4~5 帧才追上，肉眼就是换嘴时「闪一下颜色」。
        """
        cv2 = self.cv2
        ref = self.lip_stats(cur, mcur)
        if ref is None:
            return out
        if mout is None:
            mout = mcur
        # 校色只作用在**唇面核心**，不作用在回贴蒙版的羽化带。
        # mask 是「供体唇形 ∪ 当前唇形」再羽化，边缘 3~5px 已经压到唇外皮肤上；
        # 在那里加唇色偏移就是把嘴周的皮肤染成唇色（实测 jointband 边缘 a+5.9，
        # 唇面本身只 +2.1）——那一圈红边正是「贴上去」最直接的观感来源。
        # 羽化带的颜色由 blend 的皮肤环光照场负责，本来就和当前帧皮肤对齐。
        mband = mcur[:, :, 0] if mcur.ndim == 3 else mcur
        mband = np.clip(mband.astype(np.float32), 0.0, 1.0)
        mcore = np.clip((mband - 0.25) / 0.45, 0.0, 1.0)
        # 校色只能改**真正被换过**的像素（mout = 回贴蒙版）。mcur 是当前帧整片嘴唇，
        # 而上唇/嘴角这些地方由 apply() 特意保留原片（上唇不动，见那里的注释）：
        # 若按 mcur 校色，就是在原片像素上叠一个本该给供体的色偏，而且闭环的时序
        # 平滑（0.55*d + 0.45*prev）在 d≈0 时也会把上一帧的偏移带进来 —— 上唇于是
        # 逐帧被推得发白发淡（实测 21.0s 上唇比原片淡 2~3 个色度、像蒙了一层）。
        mout_c = np.clip((mout[:, :, 0] if mout.ndim == 3 else mout).astype(np.float32), 0.0, 1.0)
        mcore = mcore * mout_c

        def adjust(lab, d, w):
            w = w[:, :, None] if w.ndim == 2 else w
            return cv2.cvtColor(np.clip(lab + np.asarray(d, np.float32) * w, 0, 255)
                                .astype(np.uint8), cv2.COLOR_LAB2BGR)

        tgt = ref[2]
        # 上唇 / 下唇**分开**做均值闭环。
        # 同一帧自己嘴里，上唇通常比下唇淡 4~10 个色度（下唇有镜面高光、更厚），
        # 而供体是另一帧：它的上唇往往比当前帧红 3~4（实测 cur 上唇 a+12.7、
        # 供体 a+16.7）。只对齐「整片均值」时这一半的偏差只能靠低频色场去补，
        # 而色场有 ±6 限幅 + 0.08 唇宽的模糊，正好补不回这 4 个 a——成片里
        # 上唇就是一条比原片红、比原片暗的带子，紧贴牙齿上方，最像「画上去的」。
        # 现在以上唇下缘为界分两段，各段自己求目标、自己闭环，段界落在唇线/牙缝
        # （本来就有强边）上，看不见接缝。
        h = out.shape[0]
        if split is not None:
            ucut = float(np.clip(float(split[0]), 3.0, h - 3.0))
        else:
            ucut = float(np.average(np.arange(h, dtype=np.float32),
                                    weights=np.maximum(mcore.sum(axis=1), 1e-3)))
        rows = np.arange(h, dtype=np.float32)[:, None]
        upw = mcore * np.clip((ucut - rows) / 2.0 + 0.5, 0.0, 1.0)
        loww = mcore * np.clip((rows - ucut) / 2.0 + 0.5, 0.0, 1.0)
        if self._lc is None or not isinstance(self._lc, list) or len(self._lc) != 2:
            self._lc = [None, None]

        def close_loop(out, wmask, tgt_b, slot, caps, eps, use_smooth):
            for it in range(len(caps)):
                # 度量与作用都放在同一块（唇面核心 × 上/下唇段）上：
                # 只在核心上改色、却在整片蒙版上求均值，闭环会把核心推过冲。
                got = self.lip_stats(out, wmask)
                if got is None:
                    return out
                d = np.array([tgt_b[ch] - got[2][ch] for ch in range(3)], np.float32)
                # 时序平滑：逐帧独立量到的唇面均值会随嘴型跳 2~4 个色度单位，
                # 直接闭环就是「一帧偏粉一帧偏灰」（帧间闪烁）。目标仍是绝对值。
                if it == 0 and use_smooth:
                    prev = self._lc[slot]
                    if prev is not None:
                        prev = np.asarray(prev, np.float32)
                        lim = np.array([6.0, 4.0, 4.0], np.float32)
                        d = np.clip(0.55 * d + 0.45 * prev, prev - lim, prev + lim)
                    self._lc[slot] = tuple(float(v) for v in d)
                d = np.clip(d, -np.asarray(caps[it], np.float32),
                            np.asarray(caps[it], np.float32))
                if float(np.abs(d).max()) < eps:
                    break
                lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB).astype(np.float32)
                out = adjust(lab, d, got[0] * wmask[:, :, None])
            return out

        caps1 = ([14.0, 10.0, 10.0], [10.0, 7.0, 7.0], [10.0, 7.0, 7.0], [10.0, 7.0, 7.0])
        for wmask, slot in ((upw, 0), (loww, 1)):
            tb = self.lip_stats(cur, wmask)
            out = close_loop(out, wmask, (tb[2] if tb is not None else tgt), slot,
                             caps1, 0.6, True)

        # ② 唇内低频色场：只对齐均值时，供体「上唇偏淡、内部偏红」的结构会原样
        #    保留（均值对了，上唇还是淡紫）。这里求两边的唇内低频色图（权重归一化
        #    模糊）并相减，只在两侧**都判定为唇面**的位置叠回去，唇线/牙缝不动。
        got = self.lip_stats(out, mcore)
        if got is None:
            return out
        sig = float(max(2.0, lw * 0.08))
        lab_c = cv2.cvtColor(cur, cv2.COLOR_BGR2LAB).astype(np.float32)
        lab_o = cv2.cvtColor(out, cv2.COLOR_BGR2LAB).astype(np.float32)
        wc = ref[0][:, :, 0] * mcore
        wo = got[0][:, :, 0] * mcore
        field = self._wblur(lab_c, wc, sig) - self._wblur(lab_o, wo, sig)
        if self._dlip is not None and self._dlip.shape == field.shape:
            field = 0.62 * field + 0.38 * self._dlip
        self._dlip = field
        field = np.clip(field, np.array([-10.0, -6.0, -6.0], np.float32),
                        np.array([10.0, 6.0, 6.0], np.float32))
        out = adjust(lab_o, field, np.minimum(wc, wo)[:, :, None])

        # ③ 色场会让两段的均值各自偏移，最后按同样分段再补几轮（±5 / ±4）
        for wmask, slot in ((upw, 0), (loww, 1)):
            tb = self.lip_stats(cur, wmask)
            if tb is None:
                continue
            out = close_loop(out, wmask, tb[2], slot, ([5.0, 4.0, 4.0],), 0.4, False)
        return out

    def _wblur(self, lab, w, sig):
        """按权重归一化的三维高斯：只统计 w>0 的像素，得到一张平滑的「唇内色图」"""
        cv2 = self.cv2
        num = cv2.GaussianBlur(lab * w[:, :, None], (0, 0), sig)
        den = cv2.GaussianBlur(w, (0, 0), sig)
        return num / np.maximum(den, 0.10)[:, :, None]


    def blend(self, cur, patch, mask, ring, lw=80.0):
        """低频基色迁移（detail transfer）+ 羽化回贴。

        旧做法是「蒙版外的皮肤环上逐通道估 增益×补丁 + 偏移」，两个硬伤：
          1. 逐通道独立估：70~78s 这一段实测估出过 B+30 / R-25（供体在冷光蓝厅、
             当前帧在暖光红帘），整块嘴唇被推成「蓝色口红」；
          2. 增益在整个补丁上是**同一个常数**，一进蒙版羽化带就变成「分段常数场」，
             边界内侧残留的那一圈正是用户截图里「嘴唇周围一圈紫灰光晕」。
        现在是 detail transfer：色差只在皮肤环（漫反射、不含口红）上量，再用
        半径 0.30 唇宽的**加权模糊**把它平滑内插成一张「光照/白平衡场」。
        L 全额、色度也全额（皮肤对皮肤必须给足，否则环上残留一条冷灰带），但色度
        项按供体自身的「偏离中性程度」加权 —— 牙齿/齿间高光（近中性）≈0，
        白牙不会被染成蓝牙或黄牙。唇面绝对色随后由 match_lip_color 按当前帧
        自己的唇面闭环收敛（那一步只认绝对值，不掺这个场）。
        场与上一帧 62:38 混合 + 限幅 ±26，档位换供体时色温不会跳帧。
        供体的高频（唇线、牙缝、胡渣、高光）一个像素都不动，所以既不虚也不糊。
        """
        cv2 = self.cv2
        c_lab = cv2.cvtColor(cur, cv2.COLOR_BGR2LAB).astype(np.float32)
        p_lab = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32)
        if ring is not None:
            ref = np.clip(ring[:, :, 0].astype(np.float32), 0.0, 1.0)
        else:
            ref = np.clip(1.0 - mask[:, :, 0], 0.0, 1.0)
        if float(ref.sum()) < 40.0:
            ref = np.clip(1.0 - mask[:, :, 0], 0.0, 1.0)
        # 半径 0.30 唇宽：皮肤环本身就铺在这个尺度上，场能跟着「上唇上方那条阴影 /
        # 嘴角一侧的补光」走；再大就退化成全脸平均（局部冷斑压不掉），
        # 再小则在环与唇之间留下明显台阶。
        sig = float(max(3.0, lw * 0.30))
        d = c_lab - p_lab
        num = cv2.GaussianBlur(d * ref[:, :, None], (0, 0), sig)
        den = cv2.GaussianBlur(ref, (0, 0), sig)
        # den 下限不能给到 1e-3：补丁四角几乎没有皮肤环覆盖，除以一个接近 0 的
        # 权重会把单像素噪声放大成花斑。0.15 只让角上的场自然衰减，中间照旧。
        field = num / np.maximum(den, 0.15)[:, :, None]
        # L 与 a/b 分开限幅：亮度是加性偏移，跟着曝光走（实测同一支视频里
        # 5.0s 与 77s 的供体差 36 个灰阶），夹在 26 就永远差 10 个灰阶——
        # 那 10 个灰阶留在嘴唇上就是「比脸亮一档」的贴纸感。
        field[:, :, 0] = np.clip(field[:, :, 0], -L_FIELD_CLAMP, L_FIELD_CLAMP)
        field[:, :, 1:] = np.clip(field[:, :, 1:], -AB_FIELD_CLAMP, AB_FIELD_CLAMP)
        if self._df is not None and self._df.shape == field.shape:
            field = 0.62 * field + 0.38 * self._df
        self._df = field
        wch = np.clip(np.maximum(np.abs(p_lab[:, :, 1] - 128.0),
                                 np.abs(p_lab[:, :, 2] - 128.0)) / 8.0, 0.0, 1.0)
        field[:, :, 1] *= wch
        field[:, :, 2] *= wch
        p_lab = np.clip(p_lab + field, 0.0, 255.0)
        out = c_lab * (1.0 - mask) + p_lab * mask
        return cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)

    def _lap(self, img):
        cv2 = self.cv2
        return float(cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_32F).var())

    def _band_lap(self, img, band):
        """只统计「嘴部蒙版中心」的清晰度。
        整块区域的拉普拉斯方差会被鼻孔、下巴、脸颊纹理拉平，嘴部局部变糊时
        平均值几乎不动——必须按蒙版中心统计。"""
        cv2 = self.cv2
        g = cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_32F)
        return float(g[band].var())

    def sharpen_to(self, img, target, band):
        """把嘴部的高频能量补回「当前帧自身水平」。

        供体要经过相似变换重采样、还要过一遍编码，唇部高频会掉 20~40%；
        更糟的是有些供体本身就是「嘴唇正在运动」的帧，唇线天然发糊。
        肉眼看到的就是「嘴像被磨皮、比脸颊虚」。这里拿当前帧原来的唇部清晰度
        做基准（这一帧真实该有的水平），按实测差值做反锐化掩模，
        力度用「测一次、不够就加倍、过冲就减半」收敛到基准的 0.95~1.3 倍。
        """
        cv2 = self.cv2
        if target <= 1.0:
            return img
        cur = self._band_lap(img, band)
        if cur <= 1.0 or cur >= target * 0.95:
            return img
        base = img
        best = img
        # 上限 1.6：反锐化掩模的力度再大，唇线与牙齿边缘就会出现「白色描边 +
        # 齿缝发丝状重影」（用户截图里那种糊成一团的网纹），比轻微发虚更难看。
        # 宁可让这张供体比当前帧略软一点，也不要靠硬锐化把它拉上来。
        amount = min(1.6, max(0.25, (1.0 / max(0.20, cur / target) - 1.0) * 0.55))
        hi = None
        for _ in range(5):
            cand = cv2.addWeighted(base, 1.0 + amount,
                                   cv2.GaussianBlur(base, (0, 0), 1.0), -amount, 0)
            cand = np.clip(cand, 0, 255).astype(np.uint8)
            ratio = self._band_lap(cand, band) / target
            if ratio > 1.15:
                hi = amount
                amount = amount * 0.55
                if hi <= 0.3:
                    break
                continue
            best = cand
            if ratio >= 0.95:
                return cand
            amount = (amount + hi) * 0.5 if hi is not None else amount * 1.8
            if amount > 1.6:
                break
        return best

    # ---------------- 供体库 ----------------
    def add(self, frame, mouth, idx):
        """第二遍：把一帧的原片高清嘴部补丁放进供体库（在线去重，内存有上限）"""
        if mouth is None:
            return
        cv2 = self.cv2
        rx1, ry1, rx2, ry2 = self.region(mouth)
        if rx2 - rx1 < 40 or ry2 - ry1 < 32:
            return
        patch = frame[ry1:ry2, rx1:rx2].copy()
        lap = float(cv2.Laplacian(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY), cv2.CV_32F).var())
        if lap < MIN_LAP:
            return
        ex, ey, lw = mouth[0] - rx1, mouth[1] - ry1, float(mouth[2])
        op = self.open_of(patch, ex, ey, lw)
        mask = self.mask_of(patch.shape[0], patch.shape[1], ex, ey, lw, self.open01_of(op))[0]
        band = mask[:, :, 0] > 0.6
        if not bool(band.any()):
            return
        # 嘴部局部清晰度：整块补丁里鼻孔、下巴、脸颊的纹理会把平均值抬高，
        # 说话时嘴唇高速运动（22fps 下 1/50s 快门）真正会糊的是唇线这一圈。
        # 这类供体贴上去就是「粉红一团」——采集阶段就按唇部清晰度筛掉。
        blap = self._band_lap(patch, band)
        if blap < MIN_BLAP:
            return
        d = self.desc_of(patch, ex, ey, lw)
        if d is None:
            return
        item = {'i': idx, 'mouth': (float(mouth[0]), float(mouth[1]), float(mouth[2]),
                                    ex, ey, lw),
                'roi': (rx1, ry1, rx2, ry2), 'patch': patch,
                'desc': d, 'lap': lap, 'blap': blap,
                'open': op, 'lw': lw,
                # 口腔上下缘：回贴时只拉伸这一段（见 _warp_donor），唇厚不变
                'edges': self.lip_edges(patch, ex, ey, lw)}
        # 口腔真实上下缘（填洞得到，比 lip_edges 可靠，见 cavity）
        item['cav'] = self.cavity(patch, ex, ey, lw)
        # 唇形边界锚点（上唇上缘/口腔上下缘/下唇下缘）：回贴时按它分段对齐，
        # 供体上唇线整体贴到当前帧上唇线，不再靠「唇色质心」对唇心（见 lip_marks）
        item['marks'] = self.lip_marks(patch, ex, ey, lw)
        # 嘴唇本体蒙版 + 「唇相对皮肤」的色度签名：回贴只换这块像素，换档时按
        # 签名挑同一段光照下的供体（见 mouth_matte / lip_sig / _pick_donor）
        item['mmask'] = self.mouth_matte(patch, ex, ey, lw)
        item['sig'] = self.lip_sig(patch, ex, ey, lw, item['mmask'])
        item['mv'] = MATTE_VER
        dup = -1
        for k, old in enumerate(self.donors):
            if abs(lw - old['lw']) / max(1.0, old['lw']) > 0.18:
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
        # 满仓后的淘汰口径：优先顶掉「时间上最冗余」的那张（帧号与邻居最近），
        # 库就在全片均匀铺开，按音量子句选档时才不会集中在某一段；
        # 唇部清晰度明显更差的旧供体仍然先被顶掉。
        idxs = np.array([x['i'] for x in self.donors], np.int64)
        order = np.argsort(idxs)
        seq = idxs[order]
        gaps = np.diff(seq)
        pair = int(np.argmin(gaps)) if gaps.size else 0
        cands = [int(order[pair]), int(order[pair + 1])] if gaps.size else [int(order[0])]
        worst = min(cands, key=lambda k: self.donors[k]['blap'])
        if blap >= self.donors[worst]['blap'] * 0.90:
            self.donors[worst] = item

    def finalize(self, mouths=None):
        """供体收尾：按「平滑后的嘴位」修正每个供体，再建检索索引。

        采集时用的是逐帧原始嘴位（平滑要等全片扫完才能算）；这里把每个供体
        按平滑后的嘴位挪几像素，描述子/张开度/清晰度全部重算，避免量到唇缘外。
        修正量大到嘴已经不在补丁里（原始定位本来就离谱）的供体直接丢掉。
        """
        cv2 = self.cv2
        keep = []
        for d in self.donors:
            rx1, ry1, rx2, ry2 = d['roi']
            m = d['mouth']
            sm = None
            if mouths is not None and 0 <= d['i'] < len(mouths):
                sm = mouths[d['i']]
            if sm is None:
                sm = (m[0], m[1], m[2])
            ex, ey, lw = sm[0] - rx1, sm[1] - ry1, float(sm[2])
            patch = d['patch']
            ph, pw = patch.shape[:2]
            if abs(ex - pw / 2.0) > 0.30 * lw or abs(ey - ph / 2.0) > 0.35 * lw:
                continue
            op = self.open_of(patch, ex, ey, lw)
            mask = self.mask_of(ph, pw, ex, ey, lw, self.open01_of(op))[0]
            band = mask[:, :, 0] > 0.6
            if not bool(band.any()):
                continue
            blap = self._band_lap(patch, band)
            if blap < MIN_BLAP:
                continue
            desc = self.desc_of(patch, ex, ey, lw)
            if desc is None:
                continue
            d['mouth'] = (sm[0], sm[1], lw, ex, ey, lw)
            d['desc'] = desc
            d['blap'] = blap
            d['open'] = op
            d['lw'] = lw
            # 嘴位已经平移过几像素：唇形蒙版/口腔段/色度签名必须按新嘴位重算，
            # 否则回贴蒙版整体偏 2~3px（那正是「嘴角一点原像素没盖住」的来源）
            ed = self.lip_edges(patch, ex, ey, lw)
            if ed is not None:
                d['edges'] = ed
            cav = self.cavity(patch, ex, ey, lw)
            if cav is not None:
                d['cav'] = cav
            mk = self.lip_marks(patch, ex, ey, lw)
            if mk is not None:
                d['marks'] = mk
            mm = self.mouth_matte(patch, ex, ey, lw)
            if mm is not None:
                d['mmask'] = mm
            sg = self.lip_sig(patch, ex, ey, lw, d.get('mmask'))
            if sg is not None:
                d['sig'] = sg
            d['mv'] = MATTE_VER
            keep.append(d)
        self.donors = keep
        if not self.donors:
            return
        self._desc_stack = np.stack([d['desc'] for d in self.donors])
        self._lw = np.array([d['lw'] for d in self.donors], np.float32)
        self._blap = np.array([d.get('blap', 1.0) for d in self.donors], np.float32)
        self._open = np.array([d.get('open', 0.0) for d in self.donors], np.float32)
        self._idx = np.array([d['i'] for d in self.donors], np.int32)
        self._open_sorted = np.sort(self._open)
        self._open_rank = np.array([self._open_rank_of(v) for v in self._open], np.float32)
        # 色度签名矩阵：缺签名的供体用全库中位数填，并记下来（挑的时候给罚分）
        ok = [i for i, d in enumerate(self.donors) if d.get('sig') is not None]
        fill = (np.median(np.stack([self.donors[i]['sig'] for i in ok]), axis=0)
                if ok else np.zeros(6, np.float32))
        self._sig = np.stack([d['sig'] if d.get('sig') is not None else fill
                              for d in self.donors]).astype(np.float32)
        self._sig_ok = np.array([d.get('sig') is not None for d in self.donors], bool)
        self._build_bank()

    def _build_bank(self):
        """预建「张口度档位 → 固定供体」表——嘴抖的根治点。

        逐帧自由挑供体的做法有个死结：库里存在大量「张口度几乎一样、但纹理不同」
        的帧（相邻帧、同一个音节的两次发音），打分差只有零点几分，于是 A/B 两张
        逐帧互相顶替。实测 3.9.12 的成片每 100 帧换 37 次供体，唇线厚度、牙齿
        形状、口角高光每换一次就跳一次，用户看到的就是「嘴抖得厉害」，同时
        「这一帧糊、下一帧锐」的交替也让嘴部像一直在虚焦。

        这里按供体库自身的张口度百分位切成 LEVELS 档，每档固定一张：
          · 优先「最像全片典型嘴型」——用全库描述子中位数做参照，而不是当前帧。
            当前帧作参照时，每帧的轻微曝光/角度差异都会把选择推向另一张供体，
            嘴型就跟着逐帧漂；用全片中位参照，整条片子只有一个「长相」。
          · 同样像的候选里挑唇部更清楚的（清晰度给正向奖励，而不是罚分）。
          · 尺度也要接近全片中位，避免忽大忽小的嘴。
        换嘴只发生在「子句边界 / 停顿」这两处（见 audio_mouth_plan）：
        整条片子通常只出现十几张嘴，且每一次都是开合真的变了。
        """
        if self._desc_stack is None or self._desc_stack.shape[0] == 0:
            return
        n = self._desc_stack.shape[0]
        med_desc = np.median(self._desc_stack, axis=0)
        med_blap = float(np.median(self._blap)) if n else 1.0
        med_lw = float(np.median(self._lw)) if n else 1.0
        diff = np.abs(self._desc_stack - med_desc[None]).mean(axis=(1, 2))
        size_pen = np.abs(np.log(np.maximum(1e-3, self._lw / max(1.0, med_lw)))
                          )
        # 正向清晰度奖励：对数比，封顶 ±1（≈2.7 倍差异），系数 0.45
        clear = -0.45 * np.clip(np.log(np.maximum(1e-3, self._blap / max(1.0, med_blap)))
                                , -1.0, 1.0)
        base = diff + 0.55 * size_pen + clear
        # 存下来给 _pick_donor 复用（换档时要按当前帧重新打分，不能只靠全片中位）
        self._base, self._size_pen, self._clear = base, size_pen, clear
        self._med_blap, self._med_lw = med_blap, med_lw
        step = 1.0 / max(1, LEVELS - 1)
        self._bank, self._bank_open, self._bank_rank = [], [], []
        for l in range(LEVELS):
            c = l * step
            # 档宽的一半 + 一点点重叠：保证每档都有候选
            cand = np.abs(self._open_rank - c) <= 0.5 * step + 0.02
            if cand.any():
                # 清晰度兜底：这一档里只要有「足够清楚」的，就只在这个子集里挑，
                # 否则宁可放宽到整库（模糊供体贴上去就是一块粉红糖，不能为了分档硬选）
                ok = cand & (self._blap >= max(MIN_BLAP * 1.2, med_blap * 0.70))
                if bool(ok.any()):
                    cand = ok
                s = np.where(cand, base, np.inf)
                k = int(np.argmin(s))
            else:
                k = int(np.argmin(np.abs(self._open_rank - c)))
            self._bank.append(k)
            self._bank_open.append(float(self._open[k]))
            self._bank_rank.append(float(self._open_rank[k]))

    def _pick_donor(self, lvl, sig, cur, ex, ey, lw, idx):
        """按**当前帧**现场挑这一档的供体：档位变了才调一次，档位之内不换。

        旧版是「全片一次定死」（每档一张），5.0s 那一帧挑到的是第 1691 帧（77s）
        的嘴：供体整片亮 36 个灰阶、嘴唇比它自己的皮肤还亮 13 个灰阶。贴上去
        再靠调色压回来——颜色能压到接近，但「嘴唇比脸亮一档」的明暗关系压不回来，
        边缘再羽化也是「一块贴纸」。现在每次换档（= 子句边界/停顿，全片 70 次量级）
        按当前帧重挑：
          · 唇-皮肤**相对**色差最近（与曝光/白平衡无关，这一项权重最高）；
          · 嘴型描述子像当前帧（贴上去的纹理/阴影才跟这一帧的脸对得上）；
          · 尺度别跳、唇部别更糊；时间上别离得太远（颗粒、胡渣、模糊方向）。
        档位不变就沿用上一张（`self._ctx_k`），所以嘴照样不会抖。
        """
        if self._desc_stack is None or not self.donors:
            return -1
        n = self._desc_stack.shape[0]
        step = 1.0 / max(1, LEVELS - 1)
        c = lvl * step
        cand = np.abs(self._open_rank - c) <= 0.5 * step + 0.02
        if bool(cand.any()):
            ok = cand & (self._blap >= max(MIN_BLAP * 1.2, self._med_blap * 0.70))
            if bool(ok.any()):
                cand = ok
        else:
            cand = np.ones(n, bool)
        d = self.desc_of(cur, ex, ey, lw)
        if d is not None:
            desc_d = np.abs(self._desc_stack - d[None]).mean(axis=(1, 2))
        else:
            desc_d = self._base
        score = desc_d + 0.55 * self._size_pen + self._clear
        # 尺度项必须跟**当前帧**的唇宽比，而不是全片中位：个别供体的嘴特别小/大
        # （景别或检测偏差），选中它回贴时唇宽要缩放 1.4 倍以上，整块嘴会像贴纸一样
        # 忽大忽小，甚至超出安全缩放区间只能跳过这一帧（嘴就不动了）。
        if self._lw.size == n:
            ratio = np.maximum(1e-3, float(lw) / np.maximum(1.0, self._lw))
            score = score + 0.85 * np.abs(np.log(ratio))
        if sig is not None and self._sig.shape[0] == n:
            rel = np.abs(self._sig[:, :3] - sig[None, :3]).mean(axis=1)
            abso = np.abs(self._sig[:, 3:] - sig[None, 3:]).mean(axis=1)
            score = score + 0.85 * rel + 0.30 * abso
            score[~self._sig_ok] += 1.2
        # 时间距离：6 秒（≈140 帧 @22fps）之外封顶，别让时间压过颜色/嘴型
        score = score + 0.35 * np.minimum(1.0, np.abs(self._idx - idx) / 140.0)
        score[~cand] = np.inf
        k = int(np.argmin(score))
        prev = self._ctx_k
        # 上一张本来就在候选里、唇色关系也够近，就继续用它：少换一次是一次
        if prev is not None and 0 <= prev < n and bool(cand[prev]) and score[prev] < np.inf:
            if sig is None or float(np.abs(self._sig[prev, :3] - sig[:3]).mean()) < 3.0:
                if score[prev] <= score[k] + 6.0:
                    return prev
        return k

    def paste_window(self, matte, lw):
        """「只换当前帧自己嘴唇」的硬窗口（0~1 软窗）：bbox 内 1，向外 0.04 唇宽羽化到 0。

        蒙版是「供体唇形 ∪ 当前唇形」的并集，两块来自不同帧：供体的唇形只要比
        当前帧宽出 0.05~0.10 唇宽（咧嘴、半张嘴的幻影分割都会），并集就在嘴角
        两侧各多出一条——实测 21.0s 蒙版左边缘比原唇左缘宽出 15px（0.08 唇宽），
        那块皮肤换成了供体的像素，放大看就是嘴角外侧一块贴片，也是「整块贴上去」
        最直接的证据。这里按当前帧**自己**的唇形外接框（0.5 等值线）加一点点
        容差开窗：窗口外一个像素都不换，嘴不可能比脸上真实的嘴大一圈，
        接缝永远落在唇-皮那道本来就很强的边上。
        """
        if matte is None:
            return None
        core = matte > 0.5
        rows = np.nonzero(core.sum(axis=1) >= 3)[0]
        cols = np.nonzero(core.sum(axis=0) >= 3)[0]
        if rows.size < 2 or cols.size < 2:
            return None
        h, w = matte.shape[:2]
        yt, yb = float(rows[0]), float(rows[-1] + 1)
        xl, xr = float(cols[0]), float(cols[-1] + 1)
        # 羽化宽度 0.04 唇宽（≈8px）：既能让嘴角那一小条皮肤平滑地退回去，
        # 又不会因为窗口太软把「宽出一圈」又放回来。
        fx = float(max(1.5, 0.04 * lw))
        Y = np.arange(h, dtype=np.float32)[:, None]
        X = np.arange(w, dtype=np.float32)[None, :]
        wy = (np.clip((Y - (yt - 1.5 - fx)) / fx, 0.0, 1.0)
              * np.clip(((yb + 1.5 + fx) - Y) / fx, 0.0, 1.0))
        wx = (np.clip((X - (xl - 1.5 - fx)) / fx, 0.0, 1.0)
              * np.clip(((xr + 1.5 + fx) - X) / fx, 0.0, 1.0))
        return np.minimum(wx, wy).astype(np.float32)

    def match_cavity(self, cur, ccav, out, ex, ey, lw, mask):
        """把回贴后口腔（牙齿/齿间高光/暗腔）的亮度与对比拉回当前帧自己的水平。

        供体是「另一时刻的牙」：供体库偏爱清晰、张嘴的帧，那些帧的牙被灯照得
        又白又亮，而当前帧的牙缩在唇影里偏灰。唇色闭环只改「有唇色」的像素
        （牙齿近中性，w_app≈0），所以牙齿的曝光**完全**是供体带来的——成片里
        就是一块白得发亮的牙齿夹在暗唇之间，这就是「贴上去」最刺眼的那一层。
        实测 21.0s：当前帧口腔 L 119.5 / 标准差 56.9（齿缝对比），成片 L 128.6 /
        标准差 50.5 —— 牙整体偏亮 9 个灰阶、齿缝还被压平，看着像一整块白板。

        区域不用再对成片做一次分割（成片的牙是全白的，重新分割出来的「口腔」
        只剩 566px，正好漏掉真正的牙）：直接用**当前帧口腔的上下行带** × 回贴
        蒙版 × 「近中性」权重（嘴唇有色度，牙齿/齿缝没有），两边各按自己的权重
        求加权均值/标准差，再对成片做限幅的 gain+offset。a/b 只做小幅偏移。
        """
        cv2 = self.cv2
        if ccav is None or mask is None:
            return out
        rows = np.nonzero((ccav > 0.5).sum(axis=1) >= 3)[0]
        if rows.size < 2:
            return out
        u, l = float(rows[0]), float(rows[-1] + 1)
        if l - u < 2.0:
            return out
        h, w = mask.shape[:2]
        Yr = np.arange(h, dtype=np.float32)[:, None]
        fy_ = float(max(1.2, 0.02 * lw))
        bw = (np.clip((Yr - (u - fy_)) / fy_, 0.0, 1.0)
              * np.clip(((l + fy_) - Yr) / fy_, 0.0, 1.0))
        mb = np.clip(mask[:, :, 0], 0.0, 1.0) * bw
        lab_c = cv2.cvtColor(cur, cv2.COLOR_BGR2LAB).astype(np.float32)
        lab_o = cv2.cvtColor(out, cv2.COLOR_BGR2LAB).astype(np.float32)
        ch_c = np.maximum(np.abs(lab_c[:, :, 1] - 128.0), np.abs(lab_c[:, :, 2] - 128.0))
        ch_o = np.maximum(np.abs(lab_o[:, :, 1] - 128.0), np.abs(lab_o[:, :, 2] - 128.0))
        # 近中性才算牙齿/齿缝/暗腔：|a-128|、|b-128| ≤ 4 给满权，≥ 10 归零（唇面≈1 色度差 10+）
        wc = mb * np.clip((10.0 - ch_c) / 6.0, 0.0, 1.0)
        wo = mb * np.clip((10.0 - ch_o) / 6.0, 0.0, 1.0)
        sc, so = float(wc.sum()), float(wo.sum())
        if sc < 40.0 or so < 40.0:
            return out
        Lc, Lo = lab_c[:, :, 0], lab_o[:, :, 0]
        mc = float((Lc * wc).sum() / sc)
        mo = float((Lo * wo).sum() / so)
        vc = float((((Lc - mc) ** 2) * wc).sum() / sc)
        vo = float((((Lo - mo) ** 2) * wo).sum() / so)
        sd_c, sd_o = float(np.sqrt(vc)), float(np.sqrt(vo))
        if sd_o < 1.0:
            return out
        gain = float(np.clip(sd_c / sd_o, 0.70, 1.45))
        nl = lab_o.copy()
        nl[:, :, 0] = mc + gain * (Lo - mo)
        for ch in (1, 2):
            dch = float(np.clip((float((lab_c[:, :, ch] * wc).sum() / sc)
                                 - float((lab_o[:, :, ch] * wo).sum() / so)) * 0.85,
                                -8.0, 8.0))
            nl[:, :, ch] += dch * wo
        nl = np.clip(nl, 0.0, 255.0)
        res = cv2.cvtColor(nl.astype(np.uint8), cv2.COLOR_LAB2BGR)
        # 牙齿的高频也要对齐：供体来自清晰帧，齿缝与牙面细节比当前帧锐一档，
        # 「一块又白又清楚的牙」放在本来就糊的原片里格外扎眼（实测 21.0s 口腔带
        # 的拉普拉斯均值比当前帧高 27%）。这里只在成片更锐时做收缩，绝不加锐
        # （加锐会在齿缝上打出白边）。
        def _cav_lap(img, wgt):
            g = cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_32F)
            return float(np.sqrt(float((g * g * wgt).sum()) / max(1e-3, float(wgt.sum()))))
        lap_c = _cav_lap(cur, wc)
        lap_o = _cav_lap(res, wo)
        if lap_c > 1.0 and lap_o > lap_c * 1.12:
            best = res
            for sg2 in (0.6, 0.9, 1.2, 1.6, 2.0, 2.6):
                cand = cv2.GaussianBlur(res, (0, 0), sg2)
                best = cand
                if _cav_lap(cand, wo) <= lap_c * 1.04:
                    break
            res = best
        w3 = np.clip(wo * 1.05, 0.0, 1.0)[:, :, None]
        return np.clip(res.astype(np.float32) * w3 + out.astype(np.float32) * (1.0 - w3),
                       0, 255).astype(np.uint8)

    @staticmethod
    def marks_ok(mk, lw):
        """锚点是否可信：唇带高度/口腔高度必须像一张嘴。

        分割在这一帧只切到半张嘴（或整块落到下巴阴影）时，用它当配准锚点会把
        供体的嘴钉到错误的位置——垂直方向一错就是 0.2~0.3 唇宽（40~70px），
        原片的嘴唇/暗腔留在外面，肉眼就是「另一张嘴贴在脸上」。宁可退回
        「嘴心 + 唇宽」的相似变换，也不要用一个坏锚点。
        """
        if mk is None or len(mk) < 8:
            return False
        yt, u, l, yb = float(mk[0]), float(mk[1]), float(mk[2]), float(mk[3])
        if (yb - yt) < 0.26 * lw or (yb - yt) > 0.98 * lw:
            return False
        if (l - u) < 1.0 or (l - u) > 0.55 * lw:
            return False
        return True

    def lip_marks(self, patch, ex, ey, lw):
        """唇形关键位（补丁坐标）：(上唇上缘, 口腔上缘, 口腔下缘, 下唇下缘,
        左唇缘 x, 右唇缘 x, 唇形质心 x, 唇形宽)。

        回贴对齐只靠「唇心 + 唇宽」是不够的：
          · 唇心（唇色加权质心）在相邻帧之间会漂 5~10px，上下唇厚薄一变就左右挪，
            两张相邻帧的唇心差 0.1~0.2 唇宽（实测 21s：当前帧 +0.21 唇宽、供体 -0.05），
            供体的嘴角于是贴到当前帧的唇面上，并集蒙版直接比原嘴唇宽 20%——这就是
            用户看到的「整块贴纸」；
          · 左右唇缘（外接框）在同一个人、同一段光里稳定得多，因为它是「唇色到皮肤的
            硬边界」，不随唇内高光/阴影变化。
        所以横向配准改用左右唇缘（xr-xl）成对映射（见 _warp_donor），唇心只作兜底。
        横向外接框用较低阈值（0.30）取「可见唇缘」：唇缘那 1~2px 一定是半唇色半皮肤，
        用 0.5 阈值会往里缩，两张都缩同一边还好，缩的比例不同就会错开。

        纵向仍按**可见的唇形边界**对齐：上唇上缘贴到当前帧上唇上缘、口腔上下缘
        按开口比例拉伸、下唇下缘随之平移——上唇完全不动（真实张嘴也是上唇基本不动），
        下唇随开口下沉，唇线始终只有一条。
        """
        matte, cav = self.matte_parts(patch, ex, ey, lw)
        if matte is None:
            return None
        core = matte > 0.5
        rows = np.nonzero(core.sum(axis=1) >= 3)[0]
        if rows.size < 2:
            return None
        yt, yb = float(rows[0]), float(rows[-1] + 1)
        # 横向唇缘一律取**几何**（YuNet 双嘴角）：色度给出的左右外接在暖光下会
        # 左右不对称（实测 21s 左边 -0.48、右边 +0.37 唇宽），拿它对当前帧算
        # 横向缩放等于按色偏随机平移整张嘴，越对越歪。
        xl, xr = ex - 0.5 * lw, ex + 0.5 * lw
        wid = lw
        if (yb - yt) < max(4.0, lw * 0.12) or wid < max(8.0, lw * 0.30):
            return None
        wsum = float(matte.sum())
        xs_idx = np.arange(matte.shape[1], dtype=np.float32)[None, :]
        xc = float((xs_idx * matte).sum() / max(1e-3, wsum))
        u, l = yt + 0.42 * (yb - yt), yt + 0.58 * (yb - yt)
        if cav is not None:
            crows = np.nonzero((cav > 0.5).sum(axis=1) >= 3)[0]
            if crows.size >= 2 and float(crows[-1] + 1 - crows[0]) >= 2.0:
                u, l = float(crows[0]), float(crows[-1] + 1)
        return (yt, u, l, yb, xl, xr, xc, wid)

    def _warp_donor(self, k, ex, ey, lw, fy, rw, rh, anchor=None):
        """把第 k 张供体按「唇形边界分段配准 + 唇宽缩放 + 张-闭形变」重采样进回贴区域。

        旧的纵向形变是「整块补丁按唇心等比缩放」（warpAffine 一个 [[s,0],[0, s*fy]]），
        两个硬伤都是肉眼可见的：
          · 嘴唇厚度跟着 fy 一起变。fy=1.30 时上下唇各厚 30%，下唇那道镜面高光
            被拉成一条厚白带、唇线变宽（实测放大图上就是「像涂了唇釉的厚嘴唇」）；
          · 下巴被同比例压缩，脸型在动。
        再往后的版本改成了「分段行映射」，但锚点仍来自**供体自己的唇厚**，于是供体
        与当前帧开口不同时（开口大的帧上唇更薄），推算出来的口腔上缘比原片的口腔
        上缘高十几像素，原片的上唇直接被供体的暗口腔盖住——一条贴牙的暗带。
        现在四段锚点全部落在**当前帧自己的唇形边界**上（见下方 by_marks 分支）：
        上唇段 = 当前帧上唇全幅，口腔段 = 计划开口（fy 拉伸），下唇段 = 当前帧下唇
        厚度且整体随开口下移。

        横向也不是「按唇宽缩放 + 唇心对唇心」了：两次实测（21s、33s）都发现
        当前帧的唇色质心比 YuNet 嘴心偏右 0.2 唇宽，供体的偏左 0.05，两者相对错开
        0.25 唇宽 ≈ 45px，回贴后并集蒙版比原嘴唇宽 26%、面积 1.8 倍——供体的嘴角
        压在当前帧的皮肤上、当前帧的嘴角还露在外面，肉眼就是「一张嘴贴在脸上」。
        改成把供体的**左右唇缘**映射到当前帧的左右唇缘（唇缘是唇-皮硬边，稳定），
        纵向四锚点 + 横向两锚点，一共六个锚点的分段线性配准。
        """
        cv2 = self.cv2
        if k < 0 or k >= len(self.donors):
            return None, None
        self._warp_h = None
        d = self.donors[k]
        # 供体里存的唇形蒙版/口腔/锚点是「采集那一刻」的分割算法产物。换了分割算法
        # 又不重建供体库（387MB、20 分钟）时，先用新算法就地重算一次并打上版本标记。
        if d.get('mv') != MATTE_VER:
            d_ex, d_ey = float(d['mouth'][3]), float(d['mouth'][4])
            d['mmask'] = self.mouth_matte(d['patch'], d_ex, d_ey, float(d['lw']))
            cav = self.cavity(d['patch'], d_ex, d_ey, float(d['lw']))
            if cav is not None:
                d['cav'] = cav
            d['marks'] = self.lip_marks(d['patch'], d_ex, d_ey, float(d['lw']))
            d['mv'] = MATTE_VER
        s = lw / max(1.0, d['mouth'][2])
        # 安全缩放区间：挑供体时已经按当前帧唇宽罚过（_pick_donor），正常都在
        # 0.85~1.18 之间；真遇到极端值宁可夹住，也不要贴一张大 40% 的嘴
        if s < 0.72 or s > 1.38:
            self.stats['scale'] += 1
        s = float(np.clip(s, 0.72, 1.38))
        fy = float(fy)
        cx_d, cy_d = d['mouth'][3], d['mouth'][4]
        ph = d['patch'].shape[0]
        dmark = d.get('marks')
        amark = anchor
        # 旧版供体只存了 6 元组（没有唇缘）：按补丁重算一次，不用重建供体库
        if dmark is not None and len(dmark) < 8:
            dmark = self.lip_marks(d['patch'], cx_d, cy_d, d['lw'])
        # 有唇形边界锚点就走「按唇形分段配准」，否则退回旧的「唇心 + 唇宽」
        by_marks = (dmark is not None and amark is not None and len(amark) >= 8
                    and self.marks_ok(dmark, float(d['lw'])) and self.marks_ok(amark, lw)
                    and float(dmark[3]) - float(dmark[0]) >= 3.0)
        sx = s
        dx = dy = 0.0
        if not by_marks:
            dx = ex - s * cx_d
            dy = ey - s * cy_d
        if (not by_marks) and (abs(s - 1.0) < 0.015 and abs(fy - 1.0) < 0.02
                               and d['patch'].shape[0] == rh and d['patch'].shape[1] == rw
                               and abs(dx) < 0.5 and abs(dy) < 0.5):
            # 几何恰好是恒等变换时别重采样：插值只会让原片高清嘴唇掉一点锐度
            mm = d.get('mmask')
            return d['patch'].copy(), (mm.copy() if mm is not None else None)
        ys = np.arange(ph, dtype=np.float32)
        if by_marks:
            # 分段线性（按**可见唇形边界**）：四个锚点分别是「上唇上缘 / 口腔上缘 /
            # 口腔下缘 / 下唇下缘」。其中**上唇上缘与口腔上缘都取当前帧自己的位置**：
            #   · 上唇上缘不动 → 供体唇线不会再叠出一条（旧版按「唇色质心」对齐，
            #     质心在相邻帧间会漂 5~10px，供体上唇线比原片高几像素就被蒙版一起
            #     盖住，放大后是一圈完整的双唇线描边 = 用户说的「贴纸感」）；
            #   · 口腔上缘也必须钉在当前帧的口腔上缘。这一条是 5.0s 那一帧的关键：
            #     供体（开口更大的帧）上唇更薄，若按「上唇上缘 + 供体唇厚」推算口腔
            #     上缘，它会比原片高 19px，于是原片的上唇被供体的**暗口腔**盖住，
            #     实测上唇 L 直接掉 4.7 个灰阶 —— 一条紧贴牙齿上方的暗带，最像画上去的。
            # 由此：上唇段 = 当前帧上唇的全幅（供体唇纹纵向拉伸填满），
            # 口腔段 = 计划开口（fy 拉伸，保证口型仍跟着配音走），
            # 下唇段 = 当前帧下唇的厚度（下颌随开口整体下移）。
            yt_d, u_d, l_d, yb_d = (float(dmark[0]), float(dmark[1]),
                                    float(dmark[2]), float(dmark[3]))
            yt_c, u_c, l_c, yb_c = (float(amark[0]), float(amark[1]),
                                    float(amark[2]), float(amark[3]))
            # 边界必须严格有序，否则 np.interp 的 src 不单调，行映射会折返
            yt_d = min(yt_d, u_d - 1.0)
            u_d = max(u_d, yt_d + 1.0)
            l_d = max(l_d, u_d + 1.0)
            yb_d = max(yb_d, l_d + 1.0)
            l_c = max(l_c, u_c + 1.0)
            yb_c = max(yb_c, l_c + 1.0)
            th_d = s * max(1.0, u_d - yt_d)
            th_c = float(np.clip(u_c - yt_c, 0.45 * th_d, 2.50 * th_d))
            u_dst = yt_c + max(1.0, th_c)
            # 口腔高度 = 计划开口，但**相对本帧原生开口只允许 ±（0.70~1.35）倍**。
            # 供体的口腔/牙齿来自另一时刻的嘴：若计划要把一张本来就闭着的嘴开到
            # 供体那么宽（实测 5.0s：本帧口腔 28px，计划要 43px），贴上去就是
            # 「一口亮白牙 + 一条横贯嘴角的暗红膛」——脸的其他部分还是闭着嘴的
            # 光影，这块嘴立刻变成贴纸。夹在本帧原生开口附近，状态变化就不出戏；
            # 本帧几乎闭嘴时给 0.10 唇宽的下限，嘴该张还是要张（口型仍跟配音走）。
            h_plan = fy * s * (l_d - u_d)
            h_cur = max(1.0, l_c - u_c)
            h_cav = float(np.clip(h_plan, 0.70 * h_cur,
                                 max(1.35 * h_cur, 0.10 * float(lw))))
            # 计划开口与本帧原生开口的比值：apply 用它判断这一帧该走「贴供体」
            # 还是走「自形变」（self_warp，只动当前帧自己的像素）
            self._warp_h = (float(h_cav), float(h_cur))
            l_dst = u_dst + max(1.0, h_cav)
            lb_d = s * max(1.0, yb_d - l_d)
            # 下唇的下缘必须**钉在当前帧下唇下缘**（yb_c），厚度让供体自己去填满：
            # 旧写法取「当前帧下唇厚度」当长度（lb_c = yb_c - l_c），开口比本帧小时
            # l_dst 会上移，下唇就整体跟着上移，嘴唇下缘与当前唇缘之间那 5~8px 露出来
            # 的其实是**供体下巴皮肤**（蒙版盖着，贴上去就是下唇底下一圈肤色糊边）。
            # 现在改成 lb_c = yb_c - l_dst（限幅在供体下唇厚度的 0.40~2.60 倍内），
            # 下唇厚度随开口自动补足，唇缘永远落在原片那道唇-皮硬边上。
            lb_c = float(np.clip(yb_c - l_dst, 0.40 * lb_d, 2.60 * lb_d))
            yb_dst = l_dst + max(1.0, lb_c)
            pad = 30.0
            src = np.array([-pad, yt_d, u_d, l_d, yb_d, ph + pad], np.float32)
            dst = np.array([yt_c + s * (-pad - yt_d), yt_c, u_dst, l_dst, yb_dst,
                            yb_dst + s * (ph + pad - yb_d)], np.float32)
            yd = np.interp(ys, src, dst)
            order = np.argsort(yd)
            ysrc = np.interp(np.arange(rh, dtype=np.float32), yd[order],
                             ys[order]).astype(np.float32)
            # 横向：供体的左右唇缘 → 当前帧的左右唇缘。唇缘是「唇色 ↔ 皮肤」的硬边，
            # 对齐它才能让贴上去的嘴正好落在当前帧的嘴唇轮廓里；用唇色质心对唇心时，
            # 质心在相邻帧间能漂 0.2 唇宽，并集蒙版就比原嘴唇宽 20~30%（= 贴纸）。
            xl_d, xr_d = float(dmark[4]), float(dmark[5])
            xl_c, xr_c = float(amark[4]), float(amark[5])
            wid_d = max(4.0, xr_d - xl_d)
            wid_c = max(4.0, xr_c - xl_c)
            sx = wid_c / wid_d
            # 唇缘宽比就是「这张供体的嘴要横向拉伸多少」。正常同一机位在 0.85~1.18；
            # 超出就说明供体的嘴形（抿嘴/咧嘴）与当前帧差太多，夹住只损失一点相似度，
            # 不夹则会把嘴角压到皮肤上（那才是明显的贴纸边）。
            if sx < 0.62 or sx > 1.60:
                self.stats['scale'] += 1
            sx = float(np.clip(sx, 0.62, 1.60))
            xs = (xl_d + (np.arange(rw, dtype=np.float32) - xl_c) / sx).astype(np.float32)
            # 几何本身就基本是恒等变换（同一机位、同一景别）时别重采样，
            # 任何一次插值都会让原片本来清晰的唇线掉一层锐度
            if (d['patch'].shape[0] == rh and d['patch'].shape[1] == rw
                    and float(np.abs(ysrc - ys).max()) < 0.6
                    and float(np.abs(xs - np.arange(rw, dtype=np.float32)).max()) < 0.6):
                mm = d.get('mmask')
                return d['patch'].copy(), (mm.copy() if mm is not None else None)
        else:
            ed = d.get('cav') if d.get('cav') is not None else d.get('edges')
            u, l = (float(ed[0]), float(ed[1])) if ed else (cy_d, cy_d)
            u = max(0.0, min(float(ph - 1), u))
            l = max(u, min(float(ph - 1), l))
            seg = l - u
            # 行位移：口腔段按 fy 拉伸，其下整体平移，其上不动
            below = np.clip(ys - u, 0.0, seg) if seg > 0.5 else (ys - u)
            yd = s * (ys - cy_d) + ey + (fy - 1.0) * s * below
            order = np.argsort(yd)
            ysrc = np.interp(np.arange(rh, dtype=np.float32), yd[order],
                             ys[order]).astype(np.float32)
            xs = ((np.arange(rw, dtype=np.float32) - ex) / s + cx_d).astype(np.float32)
        map_x = np.repeat(xs[None, :], rh, axis=0)
        map_y = np.repeat(ysrc[:, None], rw, axis=1)
        flags = cv2.INTER_LANCZOS4 if (max(abs(sx - 1.0), abs(s - 1.0)) > 0.08
                                      or abs(fy - 1.0) > 0.10) else cv2.INTER_CUBIC
        w = cv2.remap(d['patch'], map_x, map_y, flags, borderMode=cv2.BORDER_REFLECT_101)
        if w.shape[:2] != (rh, rw):
            return None, None
        mm = d.get('mmask')
        m = None
        if mm is not None:
            m = cv2.remap(mm, map_x, map_y, cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            m = np.clip(m, 0.0, 1.0)
        return w, m

    def self_warp(self, cur, ccav, anchor, ex, ey, lw, h_target):
        """把**当前帧自己的嘴**按计划开口做纵向弹性形变，不放任何外来像素。

        这是「像一块贴纸贴上去」的根因修法。贴纸感的四件事——唇缘宽一圈、唇纹/
        高光来自另一时刻、牙齿比脸亮一档、嘴唇比脸锐一档——全部来自「内容不是
        这一帧的」。只要形变源就是当前帧自己，这几项在物理上就不可能出现：
        唇线位置、唇纹、下唇镜面高光、牙齿曝光、压缩噪点、运动模糊，全部原样保留，
        蒙版/羽化/唇色闭环/锐度闭环也就不需要了（没有接缝要处理，唯一的改动就是
        「这张嘴张开多少」本身）。

        形变只做纵向，且是一个**连续单调**的分段行映射（dst row → src row）：
          · 口腔上缘以上：恒等 —— 上唇、人中、鼻下皮肤一个像素都不动；
          · 口腔段 [u, l]：映射到 [u, u+h_target]，也就是牙齿/口腔随之伸缩；
          · 下唇段 [l, yb]：平移 + 厚度自动补足，下唇下缘落在 yb+(h_target-h_cur)；
          · 下缘以下（下巴）：按同一比例连续压缩，位移在补丁底部自然收敛到 0，
            不会留下空洞、硬缝，也不会把下巴"拉长"。
        横向恒等：同一帧的嘴横向本来就不该变，于是也不可能「宽一圈」。

        h_target 会被夹在 h_cur 的 0.62~1.45 倍之间：把 2px 的缝撑成 19px 的洞只能靠
        别的帧的真实牙齿，那正是「贴纸」的来源；宁可少开一点，也不搬外来像素。
        """
        cv2 = self.cv2
        if anchor is None or len(anchor) < 8:
            return None
        rh, rw = cur.shape[:2]
        crows = (np.nonzero((ccav > 0.5).sum(axis=1) >= 3)[0]
                 if ccav is not None else np.array([], np.int64))
        # 口腔段优先用真实内孔；内孔太薄（嘴几乎合拢时只剩唇缝那几个像素）就别用它，
        # 那几行拉伸十几倍只会变成「一条被撑开的唇缝」。这时改用唇形锚点里的
        # 「口腔上缘 / 口腔下缘」（唇形高的 0.42~0.58 段，也是 _warp_donor 算计划
        # 开口时用的那一段，口径一致）：看起来就是「嘴微微张开」，仍是本帧自己的像素。
        if crows.size >= 2 and float(crows[-1] + 1 - crows[0]) >= 0.065 * lw:
            u, l = float(crows[0]), float(crows[-1] + 1)
        else:
            # 实测 12.0s 正是「没有内孔」的帧：以前这里返回 None 就退回供体路径，
            # 贴上去是一块带直边的梯形——「贴纸」感最重的一帧。
            u, l = float(anchor[1]), float(anchor[2])
        h_cur = l - u
        h_target = float(h_target)
        if h_cur < 6.0 or h_target < 4.0:
            return None
        # 计划开口超过本帧±（0.62~1.45）倍时**夹住**，而不是改走「贴供体」：
        # 供体那条路会把另一时刻的牙齿/唇面整块搬上来（实测 33.0s、57.0s 成片
        # 上突然冒出一口比脸亮一档的白牙，正是用户说的「贴纸」）。夹住只损失几帧
        # 极端的开口幅度，视觉上始终是这张嘴自己在动。
        h_target = float(np.clip(h_target, 0.62 * h_cur, 1.45 * h_cur))
        yb = float(anchor[3])
        yb = float(min(yb, rh - 2.0))
        if yb <= l + 1.0 or u <= 1.0 or u >= rh - 3.0:
            return None
        shift = h_target - h_cur
        l_dst = u + h_target
        yb_dst = yb + shift
        # 下唇厚度：随开口自动补足，但不许被压薄到 0.55 倍（否则先合拢再贴边）
        lb = max(0.55 * (yb - l), yb_dst - l_dst)
        yb_dst = l_dst + lb
        if yb_dst >= rh - 1.5:
            return None
        ys = np.arange(rh, dtype=np.float32)
        src = np.zeros(rh, np.float32)
        m_up = ys <= u
        src[m_up] = ys[m_up]
        m_cav = (ys > u) & (ys <= l_dst)
        src[m_cav] = u + (ys[m_cav] - u) * (h_cur / h_target)
        m_lip = (ys > l_dst) & (ys <= yb_dst)
        src[m_lip] = l + (ys[m_lip] - l_dst) * ((yb - l) / lb)
        m_chin = ys > yb_dst
        if bool(m_chin.any()):
            # 下巴段：(yb_dst, rh] 连续映射回 (yb, rh]，位移在补丁底部收敛为 0
            span_d = max(1e-3, rh - yb_dst)
            src[m_chin] = yb + (ys[m_chin] - yb_dst) * ((rh - yb) / span_d)
        if not np.all(np.isfinite(src)):
            return None
        map_y = np.repeat(src[:, None], rw, axis=1).astype(np.float32)
        map_x = np.tile(np.arange(rw, dtype=np.float32)[None, :], (rh, 1))
        out = cv2.remap(cur, map_x, map_y, cv2.INTER_CUBIC,
                        borderMode=cv2.BORDER_REPLICATE)
        if out.shape[:2] != (rh, rw):
            return None
        return out, (h_cur, h_target)

    def apply(self, frame, mouth, idx=-1, lvl=0, fy=1.0):
        """按配音开口计划把「原片同一张嘴」贴回当前帧；返回 False 表示这帧保持原样。

        lvl / fy 由 audio_mouth_plan() 预先算好：整条片子的开口只跟配音走，
        子句内不换供体、形变逐帧限速，所以既不会「每 4.6 帧换一张嘴」的抖，
        也不会出现「噪声把嘴在 0.78/1.42 之间来回拉」的抽动。
        """
        cv2 = self.cv2
        if self._desc_stack is None or mouth is None or not self._bank:
            return False
        rx1, ry1, rx2, ry2 = self.region(mouth)
        rw, rh = rx2 - rx1, ry2 - ry1
        if rw < 40 or rh < 32:
            self.stats['skip'] += 1
            return False
        ex, ey, lw = mouth[0] - rx1, mouth[1] - ry1, float(mouth[2])
        lvl = int(max(0, min(LEVELS - 1, int(lvl))))
        cur = frame[ry1:ry2, rx1:rx2].copy()
        # 当前帧自己的唇形蒙版：既进回贴并集（保证当前唇形被完整覆盖），
        # 也是唇色闭环的**目标**（见 match_lip_color 里 mcur 的说明）；
        # 顺带拿到自己的口腔（牙齿/暗腔）范围，给「上唇/下唇分段闭环」当分界线
        cmat, ccav = self.matte_parts(cur, ex, ey, lw)
        split = None
        if ccav is not None:
            cys, _ = np.nonzero(ccav > 0.5)
            if cys.size >= 40:
                split = (float(cys.min()), float(cys.max() + 1))
        # 当前帧自己的唇形边界：供体按它分段配准（上唇线/口腔/下唇都钉到本帧
        # 真实位置，贴上去的嘴与本帧嘴唇完全同一块地方，不会高/低错开半张嘴）。
        # 只有锚点本身可信时才用（见 marks_ok），否则退回「嘴心 + 唇宽」相似变换。
        cmarks = self.lip_marks(cur, ex, ey, lw)
        anchor = cmarks if self.marks_ok(cmarks, lw) else None
        # 供体：档位变了才按当前帧重挑（同一档位/子句内不换，嘴不会抖）
        if self._ctx_lvl != lvl or self._ctx_k is None:
            sg = self.lip_sig(cur, ex, ey, lw, cmat)
            k = int(self._pick_donor(lvl, sg, cur, ex, ey, lw, idx))
            if k != self._ctx_k:
                # 换供体 → 唇色时序平滑清零，否则要拖 4~5 帧才追上（肉眼看是闪一下）
                self._lc = None
                self._dlip = None
            self._ctx_k, self._ctx_lvl = k, lvl
        k = int(self._ctx_k)
        if k < 0 or k >= len(self.donors):
            self.stats['skip'] += 1
            return False
        dop = float(self.donors[k].get('open', 0.0))
        # 计划给的开口是「档位的标准开口 × 形变」；换了一张开合略有不同的供体时，
        # 用形变补回来，保证贴上去的开口仍等于计划值（嘴型与配音对齐不变）
        fy_use = float(np.clip(float(fy) * float(self._bank_open[lvl]) / max(1e-3, dop),
                               FY_FLOOR, FY_CEIL))
        warped, wmat = self._warp_donor(k, ex, ey, lw, fy_use, rw, rh, anchor=anchor)
        # ---------------------------------------------------------------- 自形变优先
        # 只要「计划开口 / 本帧原生开口」落在 ±（0.62~1.45）倍以内，这一帧就**只
        # 动当前帧自己的像素**（self_warp：口腔段纵向伸缩 + 下唇随开口平移），
        # 完全不贴任何供体。这样唇线位置、唇纹、下唇高光、牙齿曝光、噪点、
        # 运动模糊全部还是原片的，蒙版/羽化/唇色闭环/锐度闭环一并省掉——没有
        # 外来内容，就没有「一块贴纸」可言（实测 21.0s、66.0s 都走这条）。
        # 供体只在「几乎闭嘴的帧要突然张开」等极端开口差时才用（0.62/1.45 之外）。
        sw = None
        if self._warp_h is not None and anchor is not None:
            sw = self.self_warp(cur, ccav, anchor, ex, ey, lw, self._warp_h[0])
        if sw is not None:
            patch, (h_cur_s, h_tgt_s) = sw
            frame[ry1:ry2, rx1:rx2] = patch
            self.stats['lip'] += 1
            self.stats['selfwarp'] = self.stats.get('selfwarp', 0) + 1
            self.stats['fy'].append(float(fy))
            self.stats['score'].append(float(self._bank_rank[lvl]))
            self._last_k, self._last_lvl, self._last_i = k, lvl, idx
            self._last_fy, self._last_fy_use = float(fy), fy_use
            # 唇色时序平滑只服务供体路径；这条路径不校色，留着上一帧的偏移会在
            # 下次回到供体路径的第一帧把唇面推偏，所以直接清掉
            self._lc = None
            self._dlip = None
            if self.dbg:
                bb = (cmat > 0.6) if cmat is not None else (patch[:, :, 0] > 0)
                self.dbg_rows.append([
                    round(self._band_lap(cur, bb), 1), round(self._band_lap(patch, bb), 1),
                    round(self._band_lap(patch, bb), 1), round(self._band_lap(patch, bb), 1),
                    round(float(self.donors[k]['lap']), 1),
                    round(float(self._bank_open[lvl]) * float(fy), 3),
                    float(lvl),
                    round(self.open_of(patch, ex, ey, lw), 4),
                    round(self.open_of(cur, ex, ey, lw), 4),
                    round(float(self.donors[k]['blap']), 1), round(float(fy), 3),
                    round(float(h_tgt_s) / max(1e-3, h_cur_s), 3)])
            return True
        if warped is None:
            self.stats['skip'] += 1
            return False
        eff = float(self._bank_open[lvl]) * float(fy)
        # 换档的那一帧做一次「同开口、同位置」的 50% 混合，把纹理跳变摊到两帧上。
        # 两张都是按当前帧的唇心/唇宽/开口重采样的，混合不会像旧版那样出现双层唇线。
        if self._last_k is not None and self._last_k != k and (idx - self._last_i) <= 2:
            old_w, old_m = self._warp_donor(self._last_k, ex, ey, lw,
                                            self._last_fy_use, rw, rh, anchor=anchor)
            if old_w is not None:
                warped = cv2.addWeighted(warped, 0.5, old_w, 0.5, 0)
                if wmat is not None and old_m is not None:
                    wmat = 0.5 * (wmat + old_m)
        self._last_k, self._last_lvl, self._last_i = k, lvl, idx
        self._last_fy, self._last_fy_use = float(fy), fy_use
        # 回贴区域 = **嘴唇本体**（供体唇形 ∪ 当前唇形），不再是「唇心椭圆」也不是
        # 「口腔矩形」。椭圆会把嘴唇上下各 10~20px 的皮肤一起换成供体那一帧的像素；
        # 口腔矩形（ed_cur ±0.03 唇宽、0.80 唇宽宽）再被 σ=0.045 唇宽的高斯外扩
        # 两倍，上沿能压到人中和嘴角外侧——5.0s 那一帧唇左上角那块红斑就是它。
        # 现在两块都是唇形的，皮肤（鼻下、下巴、嘴角、法令纹）全部保留当前帧自己的，
        # 接缝落在唇线这道本来就很强的边上；羽化只做 0.016 唇宽（≈3px）。
        op_cur = self.open_of(cur, ex, ey, lw)
        o_mask = max(self.open01_of(eff), self.open01_of(op_cur))
        _, ring = self.mask_of(rh, rw, ex, ey, lw, o_mask, float(fy_use))
        if wmat is not None and cmat is not None:
            if anchor is not None:
                # 只换**当前帧自己的唇形**（不用并集），alpha 也用它自己的唇缘羽化：
                # 供体已经按唇形锚点「上唇上缘 / 口腔上下缘 / 下唇下缘」分段钉到
                # 当前帧上，贴上去的内容本来就不会超出当前唇形；而并集会把供体嘴角
                # 外那一条皮肤、以及供体唇缘外面 1~2px 的半唇色一起带上来（实测
                # 21.0s 并集蒙版左边缘比原唇左缘宽 15px = 0.08 唇宽）。唇缘变宽、
                # 再叠上羽化，左嘴角那道唇-皮硬边就变成「两块唇色各一半」的糊边，
                # 放大看就是一块贴片。用 cmat 做蒙版，唇缘还是原片那道清晰的边。
                # 蒙版再做一次「收核」：cmat 是唇色软蒙版，外缘那 0.25~0.6 的一段是
                # 「半唇色半皮肤」的过渡（宽 8~15px）。供体的唇缘过渡叠上去，两条
                # 不同的渐变相加，唇缘就从「一道 2~3px 的硬边」变成「一圈糊边」，
                # 嘴唇看起来还宽了一圈（实测 21.0s 唇色区域从 142px 涨到 156px）。
                # alpha 抬到 (cmat-0.25)/0.55：唇面核心（≥0.8）照旧全换，外缘过渡
                # 留给原片，唇缘的清晰度与位置就还是原片的。
                m0 = np.clip((cmat.astype(np.float32) - 0.25) / 0.55, 0.0, 1.0)
            else:
                m0 = np.maximum(wmat, cmat)
        elif wmat is not None:
            m0 = wmat
        elif cmat is not None:
            m0 = cmat
        else:
            m0 = self.mask_of(rh, rw, ex, ey, lw, o_mask, float(fy_use))[0][:, :, 0]
        # 只换「当前帧自己的嘴唇」（见 paste_window）：并集会把供体嘴角外那一小条
        # 皮肤一起带上来，放大就是嘴角外侧一块贴片
        win = self.paste_window(cmat, lw) if cmat is not None else None
        if win is not None:
            m0 = m0 * win
        sig = float(max(1.1, lw * 0.009))
        mask0 = np.clip(cv2.GaussianBlur(m0, (0, 0), sig) * 1.04, 0.0, 1.0)
        if win is not None:
            mask0 = np.minimum(mask0, win)
        # 上唇完全保留原片：真实说话时上唇几乎不动，供体这一块除了纹理没有任何
        # 新信息，而它恰好是最容易露馅的地方——供体上唇的「白滚」高光/唇纹与当前帧
        # 不同，35%/65% 混两张唇纹理又只会把唇线糊淡（实测 t=21s 放大后上唇发白、
        # 唇线上方一道横向亮线）。口腔上缘以上给 0，往下 0.05 唇宽过渡到满权：
        # 形状（开口）仍然由供体补——口腔上下缘钉在当前帧自己的位置上，上唇的
        # 内缘就是口腔上缘，接缝落在「唇-齿」这道本来就很硬的边上。
        ucut = None
        if anchor is not None and len(anchor) >= 4:
            ucut = float(anchor[1])
        elif ccav is not None:
            cy_rows = np.nonzero((ccav > 0.5).sum(axis=1) >= 3)[0]
            if cy_rows.size >= 2:
                ucut = float(cy_rows[0])
        if ucut is not None and 2 < ucut < rh - 2:
            Yr = np.arange(rh, dtype=np.float32)[:, None]
            fw = max(2.0, 0.05 * lw)
            wup = np.clip((Yr - (ucut - fw)) / fw, 0.0, 1.0)
            mask0 = mask0 * wup.astype(np.float32)
        mask = mask0[:, :, None]
        ring = np.clip(ring[:, :, 0] - mask0 * 1.5, 0.0, 1.0)[:, :, None]
        band = mask[:, :, 0] > 0.60
        if not bool(band.any()):
            self.stats['skip'] += 1
            return False
        # 当前帧自身的嘴部清晰度 = 回贴后这一帧真实该有的目标清晰度
        target_lap = self._band_lap(cur, band)
        # 供体是按「全片最清楚」挑的，而当前帧的嘴唇往往正处在运动模糊里。
        # 供体比当前帧锐 10% 以上时压回来（压到 1.02 倍）：一张脸上
        # 「嘴唇比脸颊清楚 20%+」是典型的贴纸感来源，比轻微发虚难看得多。
        d = self.donors[k]
        wlap = self._band_lap(warped, band)
        if target_lap > 1.0 and wlap > target_lap * 1.10:
            lo, hi = 1e-3, 3.0
            best = warped
            for _ in range(6):
                mid = (lo + hi) / 2.0
                cand = cv2.GaussianBlur(warped, (0, 0), mid)
                if self._band_lap(cand, band) > target_lap * 1.02:
                    lo = mid
                else:
                    best, hi = cand, mid
            warped = best
        blended = self.blend(cur, warped, mask, ring, lw)
        # 唇色必须在**混合之后**校：blend 把当前帧的光照场搬到供体上之后，
        # 唇面（尤其中性化过的牙齿/高光）还会带走一部分供体自己的色温，
        # 先校后被推回去等于白校（用户截图红框那圈淡紫就是这么留下的）。
        # 参考蒙版用**当前帧自己的唇形**（cmat），不能用椭圆：椭圆跨到上唇上方的
        # 皮肤（b 比嘴唇高 6 个色度），目标被拉偏，校完上唇发灰、下唇偏红。
        mcur = (cmat if cmat is not None
                else self.mask_of(rh, rw, ex, ey, lw, self.open01_of(op_cur), 1.0)[0])
        blended = self.match_lip_color(cur, mcur, blended, mask, lw, split=split)
        # 只在蒙版覆盖到的嘴部补清晰度，周围原生皮肤保持不动；目标就是当前帧
        # 唇部自身的清晰度（以前取 1.15 倍，实测收在 1.3 上限 → 唇线出现白色
        # 描边、下唇高光被打成一条白带）。现在 1.0 倍、上限 1.10。
        sharp = self.sharpen_to(blended, target_lap * 1.0, band)
        final = np.clip(blended.astype(np.float32)
                        + (sharp.astype(np.float32) - blended.astype(np.float32)) * mask,
                        0, 255).astype(np.uint8)
        # 锐化会抬高一圈高频（唇面均值随之偏亮 1~4 个灰阶），最后再闭环校一次
        final = self.match_lip_color(cur, mcur, final, mask, lw, smooth=False, split=split)
        # 牙齿/口腔是供体带来的像素（见 match_cavity）：唇色闭环在近中性像素上
        # 权重≈0，牙齿的曝光完全由供体决定 → 一块白得发亮的牙，最像贴上去。
        final = self.match_cavity(cur, ccav, final, ex, ey, lw, mask)
        frame[ry1:ry2, rx1:rx2] = final
        self.stats['lip'] += 1
        self.stats['fy'].append(float(fy))
        self.stats['score'].append(float(self._bank_rank[lvl]))
        if self.dbg:
            self.dbg_rows.append([
                round(target_lap, 1), round(self._band_lap(warped, band), 1),
                round(self._band_lap(blended, band), 1), round(self._band_lap(final, band), 1),
                round(float(d['lap']), 1), round(eff, 3), float(lvl),
                round(self.open_of(final, ex, ey, lw), 4),
                round(self.open_of(cur, ex, ey, lw), 4),
                round(float(d['blap']), 1), round(float(fy), 3), round(float(eff), 3)])
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
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    w, h, src_fps, dur = probe_video(args.ffmpeg, args.video)
    fps = args.fps if args.fps > 0 else (src_fps or 25.0)
    # 真实帧率优先：标称帧率与「帧数/时长」差 6% 以上时，说明容器标称是错的
    # （VFR）。此时按真实帧率做 CFR，一帧不丢，运动才连续（见 count_frames）。
    n_frames = count_frames(args.ffmpeg, args.video)
    if n_frames > 10 and dur > 1.0:
        real = float(n_frames) / float(dur)
        if abs(real - fps) / max(1.0, real) > 0.06:
            log('标称帧率 %.2f 与真实帧率 %.2f 不符，改用真实帧率（%d 帧 / %.2f 秒）'
                % (fps, real, n_frames, dur))
            fps = real
    fps = max(12.0, min(60.0, fps))
    emit(stage='load', percent=3, fps=round(fps, 3), frames=n_frames)

    wav = load_wav(args.audio)
    if wav is None or len(wav) < SAMPLE_RATE // 2:
        sys.exit('配音音轨为空，无法生成口型')
    mel = melspectrogram(wav)
    if np.isnan(mel.reshape(-1)).sum() > 0:
        sys.exit('配音特征包含 NaN，请重新生成配音')
    chunks = mel_chunks(mel, fps)
    total = len(chunks)

    # 主路径（原片高清嘴部回贴）只靠配音包络决定开口，不需要模型推理：
    # 权重与 torch 一律不在主路径加载（省 1.2s 加载、省 300MB 内存、整片快 3 倍）。
    # 只有供体不足（<6 张，全程虚焦）时才走「超分/插值回贴」兜底，那里才要模型。
    tracker = FaceTracker(pads)
    retimer = MouthRetimer(w, h)

    # ---------- 第一遍（流式）：只检测人脸，整帧读完即丢 ----------
    # 这一遍不缓存任何画面：以前把整条视频所有帧留在内存里，82s 视频要占 6GB 以上，
    # 换来的是进程被系统换页拖死。现在内存与片长无关。
    emit(stage='detect', percent=8)
    boxes = []
    angles = []
    lms = []
    reader = FrameReader(args.ffmpeg, args.video, w, h, fps)
    while len(boxes) < total:
        frame = reader.read()
        if frame is None:
            break
        idx = len(boxes)
        # 每一帧都真检测：YuNet 缩到 640 宽只要 ~10ms，逐帧关键点才能让嘴位与
        # 当前帧的嘴唇严格重合（隔帧沿用上一帧会在头部运动时滞后 ~1/3 帧，
        # 蒙版就会切到嘴唇边上，那才是肉眼看到的「糊边」）。
        box = tracker.detect(frame, boxes[-1] if boxes else None)
        boxes.append(box)
        angles.append(tracker.angle)
        lms.append(tracker.lm.copy() if tracker.lm is not None else None)
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
        angles.append(angles[-1] if angles else 0.0)
        lms.append(lms[-1] if lms else None)
    boxes = boxes[:total]
    angles = angles[:total]
    lms = lms[:total]
    # 先剔掉「只有半张脸」的误检，再补下巴，最后 5 帧平滑
    boxes = stabilize_boxes(boxes, w, h)
    boxes = [expand_face_box(b, w, h) if b else None for b in boxes]
    boxes = tracker.fill_and_smooth(boxes)

    # ---------- 第二遍（流式）：逐帧定位嘴唇 + 采集原片高清嘴部供体 ----------
    # 每帧用 YuNet 的双嘴角关键点定唇心与唇宽；YuNet 未命中时才退回「多角度人脸 +
    # 唇色投影」。帧读完即丢，只留嘴部小补丁（约 40~150KB/张，上限 240 张）与逐帧嘴位。
    emit(stage='donor', percent=16)
    reader = FrameReader(args.ffmpeg, args.video, w, h, fps)
    mouths = []
    for i in range(len(boxes)):
        frame = reader.read()
        if frame is None:
            break
        m = locate_mouth(frame, boxes[i], w, h, angles[i], lms[i]) if boxes[i] else None
        mouths.append(m)
        retimer.add(frame, m, i)
        if i % 100 == 0:
            emit(stage='donor', percent=16 + int(4 * i / max(1, len(boxes))),
                 detail='采集原片嘴部样本 %d 张' % retimer.count)
    reader.close()
    while len(mouths) < len(boxes):
        mouths.append(None)
    if not any(mouths):
        sys.exit('NO_FACE')
    # 唇色投影失败（严重欠曝/极端偏色/画面太小）时，退回人脸框比例，
    # 宁可精度差一点也别让任务直接失败——后面 smooth_mouths 仍会做时序平滑。
    valid = sum(1 for m in mouths if m)
    if valid < 0.25 * len(mouths):
        log('唇色投影覆盖不足（%d/%d 帧），退回人脸框比例嘴位' % (valid, len(mouths)))
        for i, m in enumerate(mouths):
            if m or not boxes[i]:
                continue
            x1, y1, x2, y2 = boxes[i]
            bw, bh = x2 - x1, y2 - y1
            mouths[i] = (x1 + 0.50 * bw, y1 + 0.78 * bh, 0.20 * bw, 0.3)
    mouths = smooth_mouths(mouths, w, h)
    retimer.finalize(mouths)

    use_retime = retimer.count >= 6
    edges = [(d['edges'], d['lw']) for d in retimer.donors if d.get('edges')]
    if retimer.count:
        gl = float(np.median([(b - a) / max(1.0, lw) for (a, b), lw in edges])) if edges else 0.0
        log('供体口腔段定位 %d/%d 张（中位开口 %.3f 唇宽），其余退回嘴心形变'
            % (len(edges), retimer.count, gl))
    emit(stage='donor', percent=18, donors=retimer.count,
         mode='retime' if use_retime else 'sr',
         detail='原片高清嘴部样本 %d 张' % retimer.count)

    # 主路径的「开口计划」：逐帧档位 + 纵向形变 + 说话门，全部直接由配音算出来。
    # 这一步取代了 Wav2Lip 的 96×96 推理——那个预测值的「张嘴度」与配音包络相关
    # 只有 0.00（纯噪声），用它驱动必然逐帧抽动；现在开口与配音由构造保证对齐。
    lvl_seq = fy_seq = gate = None
    if use_retime:
        lvl_seq, fy_seq, gate = audio_mouth_plan(wav, fps, total, retimer._bank_open)
        log('配音停顿占比 %.0f%%，停顿帧统一换到最闭合嘴型'
            % (100.0 * float(np.mean(np.asarray(gate) < PAUSE_GATE))))
        emit(stage='load', percent=20, sr=False, mode='retime')

    # 兜底路径（供体不足）才加载 Wav2Lip 与超分模型：主路径完全不碰 torch，
    # 省 1.2 秒载入、省 300MB 常驻内存，整片还快约 3 倍。
    device = 'cpu'
    model = None
    enhancer = None
    if not use_retime:
        import torch
        from w2l_model import Wav2Lip
        if not os.path.exists(args.weights):
            sys.exit('缺少口型模型权重：%s' % args.weights)
        # 设备选择：M 芯片优先 Metal；个别算子不支持时整批退回 CPU（宁可慢，不出黑帧）
        if args.device in ('auto', 'mps') and torch.backends.mps.is_available():
            device = 'mps'
        elif args.device == 'cuda' and torch.cuda.is_available():
            device = 'cuda'
        model = Wav2Lip()
        ckpt = torch.load(args.weights, map_location='cpu')
        state = {k.replace('module.', ''): v for k, v in ckpt.get('state_dict', ckpt).items()}
        model.load_state_dict(state)
        model = model.to(device).eval()
        # 兜底才加载超分模型（主路径用不到，省 64MB 内存与一两秒加载时间）
        if args.sr_weights and os.path.exists(args.sr_weights):
            if device in ('mps', 'cuda'):
                try:
                    enhancer = DetailEnhancer(args.sr_weights, device)
                    log('供体不足，启用嘴部超分兜底')
                except Exception as e:
                    log('超分模型加载失败，退回插值放大：%s' % e)
                    enhancer = None
            else:
                log('未启用 GPU，跳过嘴部超分')
        elif args.sr_weights:
            log('缺少嘴部超分权重，退回插值放大：%s' % args.sr_weights)
        emit(stage='load', percent=20, sr=enhancer is not None, device=device, mode='sr')
        log('供体不足（%d 张），本片改用超分/插值回贴' % retimer.count)

    # ---------- 第二遍（流式）：主路径逐帧回贴 / 兜底路径推理 → 回贴 → 编码 ----------
    reader = FrameReader(args.ffmpeg, args.video, w, h, fps)
    writer = FrameWriter(args.ffmpeg, args.out, args.audio, w, h, fps, args.crf)
    masks = {}
    batch = max(1, args.batch)
    done = 0
    last = None

    def src_frame(_i):
        """读下一帧；画面比配音短时用最后一帧填满剩余时长，绝不写出短一截的片子"""
        nonlocal last
        frame = reader.read()
        if frame is None:
            if last is None:
                raise RuntimeError('画面解码失败，请确认视频可正常播放')
            return last.copy()
        last = frame
        return frame

    try:
        if use_retime:
            # 主路径：零推理。开口完全由 lvl_seq / fy_seq 决定（已经按子句选好供体档位、
            # 按子句内元音包络算好形变并做了逐帧限速），这里只是把它们贴到画面上。
            while done < total:
                frame = src_frame(done)
                retimer.apply(frame, mouths[min(len(mouths) - 1, done)], done,
                              int(lvl_seq[done]), float(fy_seq[done]))
                writer.write(frame)
                done += 1
                if done % 8 == 0 or done == total:
                    emit(stage='infer', percent=20 + int(79 * done / max(1, total)),
                         detail='口型 %d/%d 帧' % (done, total))
        else:
            while done < total:
                end = min(total, done + batch)
                frames, crops, mels, metas = [], [], [], []
                for i in range(done, end):
                    frame = src_frame(i)
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
                if enhancer is not None:
                    sr_wins = enhancer.run([out[j][SR_BOX[1]:SR_BOX[3], SR_BOX[0]:SR_BOX[2]]
                                            for j in range(len(metas))])
                for j, (x1, y1, x2, y2) in enumerate(metas):
                    base = frames[j]
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
    if use_retime:
        fyv = np.asarray(retimer.stats['fy'], np.float64)
        dfy = np.abs(np.diff(fyv)) if fyv.size > 1 else np.zeros(1)
        log('mode=retime donors=%d lip=%d skip=%d scale=%d selfwarp=%d frames=%d fy(p50=%.2f p05=%.2f p95=%.2f) '
            '|dfy|(p50=%.3f p95=%.3f max=%.3f)' % (
                retimer.count, retimer.stats['lip'], retimer.stats['skip'],
                retimer.stats['scale'], retimer.stats.get('selfwarp', 0), done,
                float(np.median(fyv)) if fyv.size else 1.0,
                float(np.percentile(fyv, 5)) if fyv.size else 1.0,
                float(np.percentile(fyv, 95)) if fyv.size else 1.0,
                float(np.median(dfy)), float(np.percentile(dfy, 95)), float(dfy.max())))
    else:
        log('mode=sr donors=%d lip=%d skip=%d frames=%d' % (
            retimer.count, retimer.stats['lip'], retimer.stats['skip'], done))
    if getattr(retimer, 'dbg_rows', None):
        a = np.asarray(retimer.dbg_rows, np.float32)
        med = np.median(a, axis=0)
        log('clarity band p50 | cur=%.1f warped=%.1f blended=%.1f final=%.1f donor=%.1f | '
            'final/cur=%.0f%% warped/cur=%.0f%%' % (
                med[0], med[1], med[2], med[3], med[4],
                100.0 * med[3] / max(1.0, med[0]), 100.0 * med[1] / max(1.0, med[0])))
        # 逐帧轨迹落到成片旁边，供 verify 脚本算「音频包络 ↔ 张口度」互相关
        try:
            np.savetxt(args.out + '.trace.csv', a, fmt='%.4f', delimiter=',',
                       header='cur_lap,warped_lap,blended_lap,final_lap,donor_lap,'
                              'eff_open,lvl,ap_final,ap_cur,donor_blap,morph_fy,eff_open_chk',
                       comments='')
        except Exception as e:
            log('轨迹写出失败：%s' % e)
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
        if os.environ.get('TP_LIP_DEBUG') == '1':
            import traceback
            log(traceback.format_exc())
        sys.exit(1)
