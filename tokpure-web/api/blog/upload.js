'use strict';

/**
 * /api/blog/upload —— 博客图片上传（仅管理员）。
 *
 * 入参为 base64 JSON（非 multipart）：Vercel Node runtime 不会自动解析
 * multipart 的 req.body，手工切 boundary 无依赖下很脆，故由前端 FileReader
 * 读成 base64 后 POST。代价是体积膨胀约 33%，因此单文件上限收紧到 3MB。
 *
 * 请求体：
 *   { data: string(base64, 可含 data:...;base64, 前缀), mimeType: string,
 *     scope?: 'cover' | 'gallery', name?: string }
 * 响应：
 *   200 { ok: true, path, url }
 *   400 unsupported mime type / invalid payload
 *   413 file too large
 *   401/403 由 requireAdmin 写出
 *   500 upload failed
 *
 * 写入用 service role（绕过 Storage RLS，无需任何 storage 策略），
 * key 形如 `${scope}/${YYYY-MM}/{ts}-{rand}-{slug}.{ext}`，便于日后按前缀清理。
 */

const { requireAdmin, configured } = require('../_lib');

const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const BUCKET = 'blog-images';
const MAX_BYTES = 3 * 1024 * 1024;
const SCOPES = ['cover', 'gallery'];

/** MIME 白名单 → 扩展名。刻意不含 image/svg+xml（SVG 可内嵌脚本）。 */
const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** 文件名 → 安全的 ASCII slug（非 ASCII 一律丢弃，兜底为 image）。 */
function slugify(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'image';
}

/** 4 字节随机十六进制，配合时间戳避免同秒重名。 */
function randomHex() {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0').slice(0, 8);
}

function monthPath() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = async (req, res) => {
  if (!configured()) {
    return res.status(503).json({ error: 'supabase not configured' });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const body = req.body || {};
  const raw = typeof body.data === 'string' ? body.data : '';
  if (!raw) {
    return res.status(400).json({ error: 'invalid payload' });
  }

  const mimeType = String(body.mimeType || '').toLowerCase().split(';')[0].trim();
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) {
    return res.status(400).json({ error: 'unsupported mime type' });
  }

  // 允许前端直接传 data URL，这里剥掉前缀
  const base64 = raw.replace(/^data:[^;]+;base64,/, '');
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid payload' });
  }
  if (!buffer.length) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  if (buffer.length > MAX_BYTES) {
    return res.status(413).json({ error: 'file too large' });
  }

  const scope = SCOPES.includes(body.scope) ? body.scope : 'gallery';
  const key = `${scope}/${monthPath()}/${Date.now()}-${randomHex()}-${slugify(body.name)}.${ext}`;

  try {
    const uploadRes = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${key}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'x-upsert': 'false',
      },
      body: buffer,
    });
    if (!uploadRes.ok) {
      const detail = await uploadRes.text().catch(() => '');
      return res.status(500).json({ error: 'upload failed', detail });
    }
  } catch (err) {
    return res.status(500).json({
      error: 'upload failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return res.status(200).json({
    ok: true,
    path: key,
    url: `${BASE}/storage/v1/object/public/${BUCKET}/${key}`,
  });
};
