#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TokPure — 本地背景音乐分离（torchaudio 内置 HDemucs）

AI多语切片的原片音轨里，「原语言说话人 + 背景音乐 + 环境底噪」是混在一起的。
译制成片如果直接铺原声，句间停顿就会漏出原语言人声和底噪（用户说的「很多噪音」）。
这里用 HDemucs 把人声分离出来丢掉，只保留伴奏（背景音乐），
再交给上层按固定响度 + 侧链闪避混进新配音。

完全离线：权重一次性下载到 $TORCH_HOME/hub/torchaudio/models 后，推理过程不联网。
输入/输出都是 44.1kHz wav（上层用 ffmpeg 先转好），输出 int16 PCM。

协议：stdout 一行一个 JSON。
  {"event":"log","stage":"..."}        进度/日志
  {"event":"done","bgm":"...","vocals":"...","stats":{...}}
  {"event":"error","error":"..."}
"""

import argparse
import json
import os
import sys
import time

SOURCE_NAMES = ["drums", "bass", "other", "vocals"]


def emit(**kw):
    kw.setdefault("event", "log")
    try:
        sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def fail(msg):
    emit(event="error", error=str(msg))


def load_wav(path):
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(path, dtype="float32", always_2d=True)
    # (samples, channels) -> (channels, samples)
    wav = np.ascontiguousarray(data.T)
    ch = wav.shape[0]
    if ch == 1:
        wav = np.concatenate([wav, wav], axis=0)
    elif ch > 2:
        wav = wav[:2]
    return wav, sr, ch


def stretch_to_stereo(x):
    """模型固定吃双声道；单声道来源复制一份即可（不会引入假立体声信息）"""
    if x.shape[0] == 1:
        return x.repeat(2, 1)
    return x


def separate(model, mix, sr, segment, overlap, device):
    """分块重叠相加（hann 窗 + 权重归一），返回 (vocals, 每块耗时秒数)

    整段一起推理在 3 分钟片源上会吃掉十几 GB 内存，所以按模型训练时的
    segment（默认 7.8s）+ 25% 重叠切块，用 hann 窗重叠相加；
    末尾再按「实际累加的窗权重」归一，边缘也不会掉音量。
    """
    import torch

    seg_len = int(max(1.0, segment) * sr)
    stride = max(1, int(seg_len * (1.0 - max(0.0, min(0.9, overlap)))))
    length = int(mix.shape[-1])
    window = torch.hann_window(seg_len, periodic=False, device=device).clamp(min=1e-3)

    acc = torch.zeros((1, mix.shape[0], length), dtype=torch.float32, device=device)
    wsum = torch.zeros((1, 1, length), dtype=torch.float32, device=device)

    # 与 demucs 官方 apply_model 一致：先按整段 mix 的均值/标准差归一，
    # 再乘回去。模型内部还会按块再归一，外层这一步保证块与块之间的电平一致。
    ref = mix.mean(dim=0)
    mean = float(ref.mean().item())
    std = float(ref.std().item()) or 1.0
    x = (mix - mean) / std

    offsets = list(range(0, length, stride))
    per_chunk = []
    for idx, off in enumerate(offsets):
        t0 = time.time()
        end = min(length, off + seg_len)
        chunk = x[:, off:end]
        if chunk.shape[-1] < seg_len:
            pad = torch.zeros((chunk.shape[0], seg_len - chunk.shape[-1]),
                              dtype=chunk.dtype, device=device)
            chunk = torch.cat([chunk, pad], dim=-1)
        seg = model(chunk.unsqueeze(0))[0]           # (sources, channels, seg_len)
        vocals = seg[SOURCE_NAMES.index("vocals")]
        valid = end - off
        acc[0, :, off:end] += vocals[:, :valid] * window[:valid]
        wsum[0, 0, off:end] += window[:valid]
        per_chunk.append(time.time() - t0)
        emit(event="log", stage="分离背景音乐",
             percent=round(100.0 * (idx + 1) / max(1, len(offsets)), 1))

    vocals = (acc[0] / wsum[0].clamp(min=1e-6)) * std + mean
    return vocals


def rms(x):
    import torch
    if x.numel() == 0:
        return 0.0
    return float(torch.sqrt(torch.mean(x.to(torch.float32) ** 2)).item())


def peak(x):
    import torch
    if x.numel() == 0:
        return 0.0
    return float(torch.max(torch.abs(x.to(torch.float32))).item())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--device", default="")
    ap.add_argument("--segment", type=float, default=7.8)
    ap.add_argument("--overlap", type=float, default=0.25)
    ap.add_argument("--vocals", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        fail("找不到输入音频")
        return 2
    if os.path.getsize(args.input) < 1024:
        fail("输入音频为空")
        return 2
    os.makedirs(args.outdir, exist_ok=True)

    try:
        import torch
        import soundfile as sf
    except Exception as e:                                    # pragma: no cover
        fail(f"缺少分离依赖（torch / soundfile）：{e}")
        return 3

    device = args.device or "cpu"
    if device == "mps" and not torch.backends.mps.is_available():
        device = "cpu"
    # 只占一半核：分离通常和克隆配音同时进行，吃满反而把两句都拖慢
    try:
        n = max(1, (os.cpu_count() or 4) // 2)
        torch.set_num_threads(n)
    except Exception:
        pass

    try:
        from torchaudio.pipelines import HDEMUCS_HIGH_MUSDB_PLUS as bundle
    except Exception as e:                                    # pragma: no cover
        fail(f"当前 torchaudio 版本不含 HDemucs：{e}")
        return 3

    emit(event="log", stage="加载分离模型", percent=0)
    try:
        model = bundle.get_model().to(device).eval()
    except Exception as e:
        # 权重缺失时 get_model 会去联网下载；上层已经提前检查过，这里只报错
        fail(f"分离模型加载失败：{e}")
        return 4

    try:
        wav, sr, ch = load_wav(args.input)
    except Exception as e:
        fail(f"读取音频失败：{e}")
        return 5

    need = bundle.sample_rate
    if sr != need:
        import torch
        import torchaudio
        tensor = torch.from_numpy(wav)
        wav = torchaudio.functional.resample(tensor, sr, need).numpy()
        sr = need
    audio = torch.from_numpy(wav).to(device)
    if audio.shape[0] != 2:
        audio = stretch_to_stereo(audio)

    started = time.time()
    with torch.no_grad():
        vocals = separate(model, audio, sr, args.segment, args.overlap, device)
        # 伴奏 = 原混音 - 人声。demucs 的四条 stem 相加即原混音，
        # 用减法比「把另外三条相加」更不容易留下分离残留。
        bgm = audio - vocals
        if bgm.is_cuda or (device == "mps"):
            bgm = bgm.cpu()
    elapsed = time.time() - started

    # 轻微限幅：极少量的分离溢出可能超过 1.0，写盘前压住，避免后续滤镜被削波
    bgm = bgm.clamp(-1.0, 1.0)
    if vocals.is_cuda or (device == "mps"):
        vocals = vocals.cpu()

    bgm_path = os.path.join(args.outdir, "bgm.wav")
    sf.write(bgm_path, bgm.T.cpu().numpy(), sr, subtype="PCM_16")
    vocal_path = ""
    if args.vocals:
        vocal_path = os.path.join(args.outdir, "vocals.wav")
        sf.write(vocal_path, vocals.T.numpy(), sr, subtype="PCM_16")

    stats = {
        "seconds": round(elapsed, 1),
        "duration": round(audio.shape[-1] / sr, 2),
        "bgm_rms": round(rms(bgm), 5),
        "bgm_peak": round(peak(bgm), 5),
        "vocals_rms": round(rms(vocals), 5),
        "vocals_peak": round(peak(vocals), 5),
        "device": device,
        "channels": int(ch),
        "src_rate": int(sr),
    }
    emit(event="done", bgm=bgm_path, vocals=vocal_path, stats=stats)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:                                  # pragma: no cover
        fail(f"分离失败：{exc}")
        sys.exit(1)
