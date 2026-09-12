// Serves public/ under BASE_PATH with relative-URL friendly redirects and no path traversal.
import { createReadStream, promises as fs } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
});

const LONG_CACHE = new Set(['.wasm', '.onnx', '.png', '.svg']);

/** Map a request pathname to a path relative to public/, or a redirect/404 decision. Pure. */
export function resolveRoute(pathname, basePath) {
  if (basePath) {
    if (pathname === basePath) return { kind: 'redirect', location: `${basePath}/` };
    if (!pathname.startsWith(`${basePath}/`)) return { kind: 'notFound' };
  }
  const relative = basePath ? pathname.slice(basePath.length) : pathname;
  if (relative === '/healthz') return { kind: 'health' };
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return { kind: 'notFound' };
  }
  if (decoded.includes('\0') || decoded.split('/').includes('..')) return { kind: 'notFound' };
  return { kind: 'file', relative: decoded === '/' ? '/index.html' : decoded };
}

export function createStaticHandler({ publicDir, basePath }) {
  const root = resolve(publicDir);

  return async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url, 'http://localhost');
    const route = resolveRoute(url.pathname, basePath);

    if (route.kind === 'redirect') {
      res.writeHead(302, { Location: `${route.location}${url.search}` });
      res.end();
      return true;
    }
    if (route.kind === 'health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('ok');
      return true;
    }
    if (route.kind !== 'file') return false;

    const filePath = resolve(root, `.${route.relative}`);
    if (filePath !== root && !filePath.startsWith(root + sep)) return false;

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': LONG_CACHE.has(ext) ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(filePath).pipe(res);
    return true;
  };
}
