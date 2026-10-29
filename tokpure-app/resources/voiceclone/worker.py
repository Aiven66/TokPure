#!/usr/bin/env python3
# ============================================================
# TokPure — 本地声音克隆合成 worker
#
# 由 Electron 主进程以常驻子进程方式启动：模型只加载一次，之后通过
# stdin/stdout 的 JSON 行逐句合成，避免每句都重新加载 0.5B 模型。
#
# 协议（每行一个 JSON）：
#   -> {"cmd":"ref","ref":"/path/ref.wav"}        准备参考音色（复用缓存）
#   -> {"cmd":"say","id":1,"text":"...","lang":"fr","out":"/path/x.wav"}
#   <- {"event":"ready","device":"mps","sr":24000}
#   <- {"event":"done","id":1,"sec":2.1,"dur":3.4}
#   <- {"event":"error","id":1,"error":"..."}
#   -> {"cmd":"shutdown"}
#
# 引擎：Chatterbox Multilingual（Resemble AI，MIT，23 语种，零样本克隆）
# ============================================================

import json
import os
import sys
import time
import wave
import re
import gc
import argparse
import threading
import warnings

# 并发合成：一个进程内同时跑多句。Chatterbox 的上游实现每步都回传
# attention（强制 eager 注意力），单句 RTF 高达 20+；这里换成自实现的
# 推理循环后既更快，也可以多线程安全地并发（上游的 alignment 分析器是
# 有状态的，多线程共用会直接崩）。
VC_CONC = max(1, int(os.environ.get("VC_CONC", "1") or 1))
VC_STEPS = int(os.environ.get("VC_STEPS", "10") or 10)
# CFG（无分类器引导）权重：0 时每一步只跑一路前向，速度接近翻倍；
# 0.3 左右仍能保住音色相似度，是速度与听感的折中。
try:
    VC_CFG = float(os.environ.get("VC_CFG", "0.5"))
except Exception:
    VC_CFG = 0.5
_SAY_SEM = threading.Semaphore(VC_CONC)
# 每句的 token 上限：上游 generate() 里把 max_new_tokens 写死成 1000，
# 只能通过线程本地变量传给自实现的推理循环，避免多线程串值。
_CAP = threading.local()

# 单句硬超时（秒）：token 上限只限制「生成多长」，限制不了「生成多慢」。
# 一旦某句落进异常的重复循环，它会把一个并发槽位永久占住，上层看到的就是
# 「进程卡死、一句也不出」。到点就带着已生成的部分停下来（宁可这句短一点，
# 也不让整条任务停住）。上层可用 max_seconds 逐句覆盖。
try:
    VC_SAY_MAX = float(os.environ.get("VC_SAY_MAX", "180") or 180)
except Exception:
    VC_SAY_MAX = 180.0
_DEADLINE = threading.local()

warnings.filterwarnings("ignore")

# 只保留真正的协议通道：把 fd 1 复制出来，再把 fd 1 接到 stderr，
# 这样第三方库任何 print 都不会污染 JSON 协议流。
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr


_SEND_LOCK = threading.Lock()


def send(obj):
    # 多句并发时多个线程会同时写协议通道，必须加锁，否则两条 JSON 行会交错成脏行
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    with _SEND_LOCK:
        _proto.write(line)
        _proto.flush()


class Beat(object):
    """合成期间每 5 秒回一次心跳，避免上层误判为卡死。"""

    def __init__(self, req_id, t0):
        self.req_id = req_id
        self.t0 = t0
        self._stop = threading.Event()
        self._th = threading.Thread(target=self._loop, daemon=True)

    def _loop(self):
        while not self._stop.wait(5.0):
            send({"event": "beat", "id": self.req_id,
                  "elapsed": round(time.time() - self.t0, 1)})

    def __enter__(self):
        self._th.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        return False


class LoadBeat(object):
    """模型加载期间每 10 秒发一条消息。

    上层据此判断「进程还活着」，而不是拿一个固定 240 秒去赌冷加载够快；
    同时最多发 60 条（约 10 分钟），真卡死时心跳会停，超时照常生效。
    """

    def __init__(self, limit=60):
        self._stop = threading.Event()
        self._limit = limit
        self._th = threading.Thread(target=self._loop, daemon=True)

    def _loop(self):
        n = 0
        while n < self._limit and not self._stop.wait(10.0):
            n += 1
            send({"event": "load", "elapsed": n * 10})

    def __enter__(self):
        self._th.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        return False


def clean_text(text):
    """去掉表情符号与不可朗读符号，保留语言字符与常规标点。"""
    text = str(text or "")
    text = re.sub(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def write_wav(path, wav_tensor, sr):
    import numpy as np

    data = wav_tensor.detach().to("cpu").float().numpy()
    if data.ndim > 1:
        data = data.squeeze(0)
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak > 1.0:
        data = data / peak
    pcm = (data * 32767.0).clip(-32768, 32767).astype("<i2")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(int(sr))
        f.writeframes(pcm.tobytes())


_FAST_LOCK = threading.Lock()


def patch_fast_inference():
    """用自实现的推理循环替换 Chatterbox 的上游实现。

    上游每一步都传 output_attentions=True，会强制所有层走 eager 注意力，
    并且每次调用都重建带状态的 alignment 分析器（无法并发）。
    这里只保留真正需要的部分：CFG 合并 + 采样 + KV cache，
    同时按「句子时长」限制最大 token 数，避免生成被丢弃的多余语音。
    """
    import torch
    from transformers.generation.logits_process import (
        TopPLogitsWarper, MinPLogitsWarper, RepetitionPenaltyLogitsProcessor
    )
    from chatterbox.models.t3.t3 import T3, _ensure_BOT_EOT
    from chatterbox.models.t3.inference.t3_hf_backend import T3HuggingfaceBackend

    def fast_inference(self, t3_cond, text_tokens, max_new_tokens=None, temperature=0.8, top_p=1.0,
                       min_p=0.05, repetition_penalty=2.0, cfg_weight=0.5, **_):
        text_tokens = torch.atleast_2d(text_tokens).to(dtype=torch.long, device=self.device)
        # 上游为 CFG 固定复制成两路（cond / uncond）。cfg=0 时第二路完全用不上，
        # 直接砍成单路前向，每步计算量减半，速度接近翻倍。
        use_cfg = float(cfg_weight) > 1e-6
        if not use_cfg:
            text_tokens = text_tokens[:1]
        _ensure_BOT_EOT(text_tokens, self.hp)
        backend = getattr(self, "_fast_backend", None)
        if backend is None:
            with _FAST_LOCK:
                backend = getattr(self, "_fast_backend", None)
                if backend is None:
                    backend = T3HuggingfaceBackend(
                        config=self.cfg, llama=self.tfmr, speech_enc=self.speech_emb,
                        speech_head=self.speech_head, alignment_stream_analyzer=None)
                    self._fast_backend = backend
        init_speech = self.hp.start_speech_token * torch.ones_like(text_tokens[:, :1])
        embeds, _ = self.prepare_input_embeds(t3_cond=t3_cond, text_tokens=text_tokens,
                                              speech_tokens=init_speech, cfg_weight=cfg_weight)
        start = torch.full((1, 1), self.hp.start_speech_token, dtype=torch.long, device=self.device)
        bos = self.speech_emb(start) + self.speech_pos_emb.get_fixed_embedding(0)
        bos = torch.cat([bos, bos]) if use_cfg else bos
        out = backend(inputs_embeds=torch.cat([embeds, bos], dim=1), past_key_values=None,
                      use_cache=True, output_attentions=False, return_dict=True)
        past = out.past_key_values
        gen = start.clone()
        preds = []
        w_top_p = TopPLogitsWarper(top_p=top_p)
        w_min_p = MinPLogitsWarper(min_p=min_p)
        w_rep = RepetitionPenaltyLogitsProcessor(penalty=float(repetition_penalty))
        # 优先级：本句的 token 上限（按目标句长算好的）> 上游传入的 1000 > 按文本长度估算
        cap = int(getattr(_CAP, "n", None) or max_new_tokens or 0)
        if cap <= 0:
            cap = min(1000, int(25 * (len(text_tokens[0]) / 12.0 * 1.7 + 1.5)) + 24)
        deadline = getattr(_DEADLINE, "t", None)
        for i in range(cap):
            # 硬超时：必须放在「已经有 token」之后判断，否则空序列会让上层拿到 0 帧音频
            if preds and deadline and time.time() >= deadline:
                _DEADLINE.trunc = True
                break
            lg = out.logits[:, -1, :]
            if use_cfg:
                cond, uncond = lg[0:1, :], lg[1:2, :]
                cfg = torch.as_tensor(cfg_weight, device=cond.device, dtype=cond.dtype)
                logits = cond + cfg * (cond - uncond)
            else:
                logits = lg[0:1, :]
            ids = gen[:1, ...]
            logits = w_rep(ids, logits)
            if temperature != 1.0:
                logits = logits / temperature
            logits = w_top_p(ids, w_min_p(ids, logits))
            nxt = torch.multinomial(torch.softmax(logits, dim=-1), num_samples=1)
            preds.append(nxt)
            gen = torch.cat([gen, nxt], dim=1)
            if nxt.view(-1) == self.hp.stop_speech_token:
                break
            e = self.speech_emb(nxt) + self.speech_pos_emb.get_fixed_embedding(i + 1)
            if use_cfg:
                e = torch.cat([e, e])
            out = backend(inputs_embeds=e, past_key_values=past,
                          use_cache=True, output_attentions=False, return_dict=True)
            past = out.past_key_values
        return torch.cat(preds, dim=1)

    T3.inference = fast_inference


def tune_vocoder(model):
    """flow matching 默认 10 步；6 步听感几乎无差，但解码耗时降四成。"""
    if VC_STEPS >= 10:
        return
    orig = model.s3gen.inference

    def wrapped(*args, **kwargs):
        kwargs.setdefault("n_cfm_timesteps", VC_STEPS)
        return orig(*args, **kwargs)

    model.s3gen.inference = wrapped



def _watch_parent(parent_pid):
    """父进程（Electron）消失就自杀。

    stdin 的 EOF 在「应用被强制退出 / 崩溃」时不一定能到达：管道的写端可能
    还挂在别的子进程里。曾实测有 3 个 2GB 的 worker 在后台常驻，把 16G 机器
    的可用内存吃到只剩几十 MB，后续任务全被拖成龟速。父进程没了就重挂到
    launchd（ppid 变 1），这里每 15 秒认一次，认不到就立刻退出。
    """
    while True:
        time.sleep(15.0)
        if os.getppid() != parent_pid or parent_pid <= 1:
            os._exit(0)


def main():
    ap = argparse.ArgumentParser()
    # 设备可由上层用 VC_DEVICE 指定（cpu / mps / auto），命令行参数优先。
    # 默认 cpu：不需要 GPU 也能跑，且多进程时内存更可控。
    ap.add_argument("--device", default=os.environ.get("VC_DEVICE", "cpu"))
    args = ap.parse_args()

    parent_pid = os.getppid()
    # 只在确实有父进程时开看守：万一被直接托管启动（ppid=1），不能把自己判死
    if parent_pid > 1:
        threading.Thread(target=_watch_parent, args=(parent_pid,), daemon=True).start()

    send({"event": "boot"})
    # 整个加载阶段都挂着心跳：模型冷加载 + 首次 JIT 慢一点也只会让上层续期，
    # 而不是被判「加载超时」后杀掉重试（重试会再多挂一个 2GB 进程）。
    with LoadBeat():
        try:
            import torch
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        except Exception as e:  # 依赖缺失时给出可读原因
            send({"event": "fatal", "error": "本地引擎依赖缺失：%s" % str(e)[:300]})
            return

        # 多路并行时由上层分配到每路的线程数
        try:
            nt = int(os.environ.get("VC_THREADS", "0"))
            if nt > 0:
                torch.set_num_threads(nt)
        except Exception:
            pass

        device = args.device
        if device == "auto":
            try:
                device = "mps" if torch.backends.mps.is_available() else "cpu"
            except Exception:
                device = "cpu"

        model = None
        for dev in ([device] if device != "mps" else ["mps", "cpu"]):
            try:
                model = ChatterboxMultilingualTTS.from_pretrained(device=dev)
                device = dev
                break
            except Exception as e:
                if dev == "cpu":
                    send({"event": "fatal", "error": "模型加载失败：%s" % str(e)[:300]})
                    return

    sr = int(getattr(model, "sr", 24000))
    # 换成自实现的推理循环，并按句长限制 token 上限
    try:
        patch_fast_inference()
        tune_vocoder(model)
    except Exception as e:
        send({"event": "warn", "error": "快速推理不可用，已回退：%s" % str(e)[:200]})
    send({"event": "ready", "device": device, "sr": sr, "conc": VC_CONC})

    ref_path = None
    ready_ref = None

    def say(msg):
        text = clean_text(msg.get("text"))
        out = msg.get("out")
        lang = str(msg.get("lang") or "en")
        rid = msg.get("id")
        if not text or not out:
            send({"event": "error", "id": rid, "error": "空文本或缺少输出路径"})
            return
        # 上限按目标句长换算：25 token ≈ 1 秒语音，多留 2.2 倍余量防跑飞
        cap = int(msg.get("max_tokens") or 0)
        if cap <= 0:
            cap = None
        # 单句墙钟上限：上层按句长给出，缺省用 VC_SAY_MAX
        try:
            max_s = float(msg.get("max_seconds") or VC_SAY_MAX)
        except Exception:
            max_s = VC_SAY_MAX
        max_s = min(900.0, max(20.0, max_s))
        t0 = time.time()
        truncated = False
        send({"event": "saying", "id": rid, "chars": len(text)})
        try:
            # 心跳必须从「排队」阶段就开始：并发槽位被占满时这一句要等前面合成完，
            # 期间没有任何事件，上层会以为进程卡死并把整句判超时。
            with Beat(rid, t0):
                with _SAY_SEM:
                    kwargs = {"language_id": lang}
                    if ref_path and ready_ref is None:
                        kwargs["audio_prompt_path"] = ref_path
                    if VC_CFG != 0.5:
                        kwargs["cfg_weight"] = VC_CFG
                    # 上游 generate() 不接受 max_new_tokens，只能经线程本地变量传进推理循环
                    _CAP.n = cap
                    # 超时从「真正开始算」这一刻起算：排队等待不算这一句的账
                    _DEADLINE.trunc = False
                    _DEADLINE.t = time.time() + max_s
                    try:
                        wav = model.generate(text, **kwargs)
                    finally:
                        truncated = bool(getattr(_DEADLINE, "trunc", False))
                        _DEADLINE.t = None
                        _CAP.n = None
            write_wav(out, wav, sr)
            send({
                "event": "done",
                "id": rid,
                "sec": round(time.time() - t0, 2),
                "dur": round(float(wav.shape[-1]) / sr, 2),
                "truncated": truncated,
            })
        except Exception as e:
            send({"event": "error", "id": rid, "error": str(e)[:300]})
        finally:
            # 每句结束立刻回收：中间张量（attention / KV / 波形）在长任务里会不断堆积，
            # 16GB 机器上一次克隆跑久了 RSS 能涨到 4GB 以上，靠的就是这里主动释放。
            gc.collect()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue

        cmd = msg.get("cmd")
        if cmd == "shutdown":
            break

        if cmd == "ref":
            path = msg.get("ref")
            if not path or not os.path.exists(path):
                send({"event": "error", "id": msg.get("id"), "error": "参考音频不存在"})
                continue
            if path != ref_path or ready_ref is None:
                t0 = time.time()
                try:
                    # 先把说话人条件算好并缓存，后续每句复用，省掉重复编码
                    model.prepare_conditionals(path)
                    ref_path = path
                    ready_ref = time.time() - t0
                except Exception as e:
                    # 老版本没有 prepare_conditionals 时就退化为每句传参考音频
                    ref_path = path
                    ready_ref = None
                    if not hasattr(model, "prepare_conditionals"):
                        pass
                    else:
                        send({"event": "error", "id": msg.get("id"), "error": "参考音色准备失败：%s" % str(e)[:200]})
                        continue
            send({"event": "ref_ok", "id": msg.get("id"), "sec": round(ready_ref or 0.0, 2)})
            continue

        if cmd == "say":
            # 多句并发：每句一个线程，由信号量限制同时合成的数量
            threading.Thread(target=say, args=(msg,), daemon=True).start()
            continue

    send({"event": "exit"})


if __name__ == "__main__":
    main()
