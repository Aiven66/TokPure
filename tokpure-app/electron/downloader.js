'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const net = require('./net');
const tiktok = require('./tiktok');
const ffmpeg = require('./ffmpeg');

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}${ext}`);
  let i = 1;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return p;
}

function dedupeUrls(list) {
  const seen = new Set();
  const out = [];
  for (const u of list) {
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function formatBytesLabel(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

let seq = 0;

class Downloader extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.tasks = new Map();
    this.order = [];
    this.active = new Set();
    this.paused = false;
    this.maxConcurrent = 3;
  }

  setConcurrency(n) {
    this.maxConcurrent = Math.max(1, Math.min(8, Number(n) || 3));
    this._pump();
  }

  add(input, opts = {}) {
    const settings = this.getSettings();
    this.setConcurrency(settings.concurrency || 3);
    const id = `task_${++seq}_${Date.now()}`;
    const task = {
      id,
      url: (input || '').trim(),
      status: 'queued',
      stage: '排队中',
      progress: 0,
      received: 0,
      total: 0,
      speed: 0,
      eta: 0,
      title: '',
      author: '',
      cover: '',
      duration: 0,
      resolution: '',
      destPath: '',
      audioPath: '',
      posterPath: '',
      error: '',
      note: '',
      options: {
        extraction: opts.extraction !== undefined ? opts.extraction : settings.extractMp3,
        poster: opts.poster !== undefined ? opts.poster : settings.savePoster
      },
      meta: null,
      createdAt: Date.now(),
      finishedAt: null,
      _abort: null,
      _speedSamples: []
    };
    this.tasks.set(id, task);
    this.order.push(id);
    this.emit('add', this.serialize(task));
    this._pump();
    return this.serialize(task);
  }

  list() {
    return this.order.map((id) => this.serialize(this.tasks.get(id))).filter(Boolean);
  }

  get(id) {
    const t = this.tasks.get(id);
    return t ? this.serialize(t) : null;
  }

  serialize(t) {
    if (!t) return null;
    const { _abort, _speedSamples, meta, ...rest } = t;
    return { ...rest };
  }

  update(t, patch) {
    Object.assign(t, patch);
    this.emit('update', this.serialize(t));
  }

  _pump() {
    if (this.paused) return;
    for (const id of this.order) {
      if (this.active.size >= this.maxConcurrent) break;
      const t = this.tasks.get(id);
      if (t && t.status === 'queued' && !this.active.has(id)) {
        this.active.add(id);
        this._run(t).catch(() => {}).finally(() => {
          this.active.delete(id);
          this._pump();
        });
      }
    }
  }

  async _run(task) {
    const settings = this.getSettings();
    const controller = new AbortController();
    task._abort = controller;
    const proxy = settings.proxy;

    try {
      // 1. parse
      this.update(task, { status: 'parsing', stage: '解析中' });
      const meta = await tiktok.parse(task.url, settings);
      task.meta = meta;
      const title = meta.desc || meta.id || 'tiktok_video';
      const author = (meta.author && meta.author.uniqueId) || 'tiktok';
      this.update(task, {
        title: title.slice(0, 120),
        author,
        cover: meta.video.cover || '',
        duration: meta.video.duration || 0,
        resolution: meta.video.width && meta.video.height ? `${meta.video.width}x${meta.video.height}` : (meta.video.gear || '')
      });

      const dir = settings.downloadDir;
      fs.mkdirSync(dir, { recursive: true });

      // photo (image gallery) post
      if (meta.isPhoto && meta.images && meta.images.length) {
        await this._downloadImages(task, meta, dir, settings, controller);
        this.update(task, { status: 'done', stage: '已完成', progress: 100, finishedAt: Date.now(), note: `${meta.images.length} 张图片` });
        return;
      }

      // 2. choose source (prefer no-watermark)
      // TikTok returns several candidate streams; some CDN hosts reject requests with
      // HTTP 403 depending on region/anti-bot, so try them in order until one downloads.
      const candidates = dedupeUrls([
        ...(meta.video.noWatermark || []),
        ...(meta.video.watermarked || [])
      ]);
      if (!candidates.length) throw new Error('未找到可下载的视频地址');
      const noWatermarkSet = new Set(meta.video.noWatermark || []);

      const base = sanitize(`${author} - ${title}`) || `tiktok_${meta.id}`;
      const rawPath = uniquePath(dir, `${base} [${meta.id || 'na'}]`, '.mp4');

      // 3. download
      this.update(task, { status: 'downloading', stage: '下载中', destPath: rawPath });
      let srcUrl = '';
      let usedWatermark = false;
      let lastErr = null;
      for (let i = 0; i < candidates.length; i++) {
        if (controller.signal.aborted) throw new Error('已取消');
        const cand = candidates[i];
        if (i > 0) {
          // reset per-attempt progress so the UI does not show a stale/skewed rate
          task._speedSamples = [];
          this.update(task, { received: 0, total: 0, progress: 0, speed: 0, eta: 0 });
        }
        try {
          await net.downloadToFile(cand, rawPath, {
            proxy,
            headers: {
              'User-Agent': net.resolveUA(settings),
              Referer: 'https://www.tiktok.com/'
            },
            abortSignal: controller.signal,
            onProgress: (received, total) => this._progress(task, received, total)
          });
          srcUrl = cand;
          usedWatermark = !noWatermarkSet.has(cand);
          lastErr = null;
          break;
        } catch (e) {
          if (controller.signal.aborted) throw new Error('已取消');
          lastErr = e;
          this.update(task, {
            stage: `下载中 · 线路 ${i + 1}/${candidates.length} 不可用，自动切换`
          });
        }
      }
      if (lastErr) throw lastErr;
      if (!srcUrl) throw new Error('未找到可下载的视频地址');

      let finalPath = rawPath;

      // 4. local watermark cleanup fallback
      const needCleanup = (usedWatermark || settings.removeLogo) && ffmpeg.hasFfmpeg();
      if (needCleanup) {
        this.update(task, { status: 'cleaning', stage: '本地去水印处理中' });
        const cleaned = uniquePath(dir, `${base} [${meta.id || 'na'}] - clean`, '.mp4');
        try {
          await ffmpeg.cleanupWatermark(rawPath, cleaned, { mode: 'crop', cropPercent: 6 });
          fs.unlink(rawPath, () => {});
          finalPath = cleaned;
        } catch (e) {
          this.update(task, { note: `去水印处理失败，已保留原始文件: ${e.message}` });
        }
      }

      // 5. poster
      if (task.options.poster && meta.video.cover) {
        try {
          this.update(task, { status: 'downloading', stage: '保存封面' });
          const posterPath = uniquePath(dir, `${base} [${meta.id || 'na'}] - cover`, '.jpg');
          await net.downloadToFile(meta.video.cover, posterPath, {
            proxy,
            headers: { 'User-Agent': net.resolveUA(settings), Referer: 'https://www.tiktok.com/' },
            abortSignal: controller.signal
          });
          task.posterPath = posterPath;
        } catch (_) {
          /* poster is optional */
        }
      }

      // 6. mp3 extraction
      if (task.options.extraction && ffmpeg.hasFfmpeg()) {
        try {
          this.update(task, { status: 'extracting', stage: '提取 MP3 音频' });
          const audioPath = uniquePath(dir, `${base} [${meta.id || 'na'}]`, '.mp3');
          await ffmpeg.extractAudio(finalPath, audioPath, { bitrate: '320k' });
          task.audioPath = audioPath;
        } catch (e) {
          task.note = `音频提取失败: ${e.message}`;
        }
      }

      this.update(task, {
        status: 'done',
        stage: '已完成 · 无水印',
        progress: 100,
        destPath: finalPath,
        posterPath: task.posterPath,
        audioPath: task.audioPath,
        finishedAt: Date.now()
      });
    } catch (e) {
      if (controller.signal.aborted) {
        this.update(task, { status: 'canceled', stage: '已取消', finishedAt: Date.now() });
      } else {
        this.update(task, { status: 'error', stage: '失败', error: e.message || String(e), finishedAt: Date.now() });
      }
    }
  }

  async _downloadImages(task, meta, dir, settings, controller) {
    const base = sanitize(`${task.author} - ${task.title}`) || `tiktok_${meta.id}`;
    let i = 0;
    const paths = [];
    for (const imgUrl of meta.images) {
      i += 1;
      const p = uniquePath(dir, `${base} [${meta.id || 'na'}]_${String(i).padStart(2, '0')}`, '.jpg');
      await net.downloadToFile(imgUrl, p, {
        proxy: settings.proxy,
        headers: { 'User-Agent': net.resolveUA(settings), Referer: 'https://www.tiktok.com/' },
        abortSignal: controller.signal,
        onProgress: (received, total) =>
          this._progress(task, received, total, i, meta.images.length)
      });
      paths.push(p);
    }
    task.destPath = paths[0] || '';
    task.imagePaths = paths;
  }

  _progress(task, received, total, index, count) {
    const now = Date.now();
    const pct = total ? Math.min(99, Math.round((received / total) * 100)) : task.progress;
    task._speedSamples.push({ t: now, b: received });
    task._speedSamples = task._speedSamples.filter((s) => now - s.t < 3000);
    let speed = 0;
    if (task._speedSamples.length >= 2) {
      const first = task._speedSamples[0];
      const last = task._speedSamples[task._speedSamples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0) speed = (last.b - first.b) / dt;
    }
    const eta = speed > 0 && total ? Math.max(0, Math.round((total - received) / speed)) : 0;
    const stageBase = count ? `下载图片 ${index}/${count}` : '下载中';
    this.update(task, {
      received,
      total,
      progress: pct,
      speed,
      eta,
      stage: `${stageBase} ${formatBytesLabel(received)}${total ? ' / ' + formatBytesLabel(total) : ''}`
    });
  }

  pauseAll() {
    this.paused = true;
    this.emit('paused', true);
  }

  resumeAll() {
    this.paused = false;
    this.emit('paused', false);
    this._pump();
  }

  cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t._abort) t._abort.abort();
    else this.update(t, { status: 'canceled', stage: '已取消', finishedAt: Date.now() });
  }

  retry(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    this.update(t, { status: 'queued', stage: '排队中', progress: 0, received: 0, total: 0, speed: 0, eta: 0, error: '', finishedAt: null });
    this._pump();
  }

  remove(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t._abort) t._abort.abort();
    this.tasks.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit('remove', id);
  }

  clearCompleted() {
    const removed = [];
    for (const id of [...this.order]) {
      const t = this.tasks.get(id);
      if (t && ['done', 'error', 'canceled'].includes(t.status)) {
        this.tasks.delete(id);
        removed.push(id);
      }
    }
    this.order = this.order.filter((id) => this.tasks.has(id));
    removed.forEach((id) => this.emit('remove', id));
    return removed;
  }

  stats() {
    const all = this.list();
    return {
      total: all.length,
      active: all.filter((t) => ['parsing', 'downloading', 'extracting', 'cleaning'].includes(t.status)).length,
      queued: all.filter((t) => t.status === 'queued').length,
      done: all.filter((t) => t.status === 'done').length,
      error: all.filter((t) => t.status === 'error').length,
      paused: this.paused
    };
  }
}

module.exports = Downloader;