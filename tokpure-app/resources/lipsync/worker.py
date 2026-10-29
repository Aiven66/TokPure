#!/usr/bin/env python3
"""TokPure — 本地口型同步（Wav2Lip 96）推理脚本。

输入：已经切片好的口播画面（mp4）+ 目标语言配音（wav，含整段静音填充）
输出：口型跟着配音走的新视频（画面保留原片构图、头部动作、背景）

设计要点：
1. 全程离线：模型权重与代码都在本机，进程内不发任何网络请求；
2. 音频驱动先于口型：配音定稿后再逐帧重绘嘴部，绝不边合成边对齐；
3. 只重绘「人脸区域」并羽化回贴，头部晃动、手势、景别全部保留；
4. 人脸检测用 OpenCV 的级联分类器（Apache-2.0），逐帧结果做 5 帧滑动平均，
   避免检测框抖动导致嘴部闪烁；
5. 视频解码/编码都走 ffmpeg 管道（bgr24 rawvideo），不依赖 ImageIO 之类的额外轮子。

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


def feather_mask(w, h):
    """回贴用的羽化蒙版：边缘 6% 线性过渡，避免嘴部四周出现硬边框"""
    f = max(2, int(min(w, h) * 0.06))
    ax = np.ones(w, np.float32)
    ay = np.ones(h, np.float32)
    ax[:f] = np.linspace(0.0, 1.0, f)
    ax[-f:] = np.linspace(1.0, 0.0, f)
    ay[:f] = np.linspace(0.0, 1.0, f)
    ay[-f:] = np.linspace(1.0, 0.0, f)
    return ay[:, None] * ax[None, :]


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
    emit(stage='load', percent=6, device=device, frames=len(chunks))

    reader = FrameReader(args.ffmpeg, args.video, w, h, fps)
    writer = FrameWriter(args.ffmpeg, args.out, args.audio, w, h, fps, args.crf)
    tracker = FaceTracker(pads)
    masks = {}

    total = len(chunks)
    frames = []
    boxes = []
    emit(stage='detect', percent=8)
    # 先解码 + 检测一遍：检测与推理分开，才能在推理阶段按批推进
    # 检测每 2 帧做一次（固定机位头部变化很慢），中间帧沿用前一个框
    while len(frames) < total:
        frame = reader.read()
        if frame is None:
            break
        idx = len(frames)
        if idx % 2 == 0 or not boxes:
            boxes.append(tracker.detect(frame, boxes[-1] if boxes else None))
        else:
            boxes.append(boxes[-1])
        frames.append(frame)
        if idx % 50 == 0:
            emit(stage='detect', percent=8 + int(17 * idx / max(1, total)), detail='检测人脸 %d/%d' % (idx, total))
    reader.close()

    if not frames:
        sys.exit('画面解码失败，请确认视频可正常播放')
    if not any(boxes):
        sys.exit('NO_FACE')
    # 解码帧数不足（画面比配音短）时用最后一帧补齐，保证音画长度一致
    while len(frames) < total:
        frames.append(frames[-1].copy())
        boxes.append(boxes[-1])
    frames = frames[:total]
    boxes = tracker.fill_and_smooth(boxes[:total])

    batch = max(1, args.batch)
    done = 0
    try:
        for start in range(0, total, batch):
            end = min(total, start + batch)
            crops, mels, metas = [], [], []
            for i in range(start, end):
                x1, y1, x2, y2 = boxes[i]
                # 框可能被平滑成 0 宽/越界，兜底钳到画面内
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(w, max(x1 + 8, x2)), min(h, max(y1 + 8, y2))
                crop = frames[i][y1:y2, x1:x2]
                crop = cv2.resize(crop, (96, 96))
                masked = crop.copy()
                masked[48:] = 0
                crops.append(np.concatenate((masked, crop), axis=2) / 255.0)
                mels.append(chunks[i])
                metas.append((x1, y1, x2, y2))
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
                    emit(stage='infer', percent=25, detail='Metal 不可用，改用 CPU')
                    device = 'cpu'
                    model = model.to('cpu')
                    img_b, mel_b = img_b.cpu(), mel_b.cpu()
                    pred = model(mel_b, img_b)
            out = pred.detach().to('cpu').numpy().transpose(0, 2, 3, 1)
            out = np.clip(out * 255.0, 0, 255).astype(np.uint8)
            for j, (x1, y1, x2, y2) in enumerate(metas):
                bw, bh = x2 - x1, y2 - y1
                mouth = cv2.resize(out[j], (bw, bh), interpolation=cv2.INTER_CUBIC)
                key = (bw, bh)
                if key not in masks:
                    masks[key] = feather_mask(bw, bh)[:, :, None]
                base = frames[start + j]
                blended = base[y1:y2, x1:x2].astype(np.float32) * (1 - masks[key]) + mouth.astype(np.float32) * masks[key]
                base[y1:y2, x1:x2] = np.clip(blended, 0, 255).astype(np.uint8)
                writer.write(base)
            done = min(total, end)
            emit(stage='infer', percent=25 + int(74 * done / max(1, total)),
                 detail='口型 %d/%d 帧' % (done, total))
        writer.close()
    finally:
        try:
            reader.close()
        except Exception:
            pass
    if not os.path.exists(args.out) or os.path.getsize(args.out) < 20000:
        sys.exit('口型视频输出失败')
    emit(stage='done', percent=100, frames=done, fps=fps)


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
