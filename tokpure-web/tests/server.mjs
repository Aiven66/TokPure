/**
 * 本地静态服务器：按 vercel.json 的规则伺服 dist/，供自动化测试使用。
 *  - /blog/<slug>-<id>.html 重写到 blog-detail.html（与 vercel rewrites 一致）
 *  - 找不到的文件回 404.html + 404 状态码
 *  - 不做缓存，避免测试之间互相污染
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif'
};

export async function startServer(root, port = 4173) {
  const server = http.createServer(async (req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    // vercel.json: /blog/:file -> /blog-detail.html
    if (urlPath.startsWith('/blog/') && urlPath.endsWith('.html')) urlPath = '/blog-detail.html';

    const target = join(root, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    try {
      const info = await stat(target);
      if (info.isDirectory()) throw new Error('dir');
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': body.length
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (_) {
      const body = await readFile(join(root, '404.html')).catch(() => Buffer.from('404'));
      res.writeHead(404, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(body);
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}
