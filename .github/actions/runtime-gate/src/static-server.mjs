// Minimal static file server for apps whose build output is plain files
// (CRA, Vite, webpack, exported sites). No dependencies, so nothing to fetch
// at CI time.
//
//   node static-server.mjs <dir> <port> [--spa]
//
// --spa serves index.html for unknown extensionless paths (client-side
// routing); without it they get 404.html if present, else a plain 404.
// Port 0 picks a free port; the one in use is printed as "static: <dir> on :<port>".
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [, , dirArg = '.', portArg = '3000', ...flags] = process.argv;
const root = path.resolve(dirArg);
const port = Number(portArg);
const spa = flags.includes('--spa');

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function send(res, status, file) {
  res.writeHead(status, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

// path.relative, not a string prefix: /w/dist must not admit /w/dist-secret
// (or /w/dist.html, which "/" + ".html" would otherwise reach).
function inside(file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function resolveFile(urlPath) {
  let clean;
  // A malformed escape (e.g. %E0%A4%A) is a bad request, not a crash.
  try { clean = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  const target = path.resolve(root, `.${path.sep}${clean}`);
  if (target !== root && !inside(target)) return null;
  for (const candidate of [target, `${target}.html`, path.join(target, 'index.html')]) {
    if (!inside(candidate)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* try the next one */ }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const file = resolveFile(req.url || '/');
  if (file) return send(res, 200, file);
  const index = path.join(root, 'index.html');
  if (spa && !path.extname((req.url || '/').split('?')[0]) && fs.existsSync(index)) return send(res, 200, index);
  const notFound = path.join(root, '404.html');
  if (fs.existsSync(notFound)) return send(res, 404, notFound);
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});
server.listen(port, '0.0.0.0', () => console.log(`static: ${root} on :${server.address().port}${spa ? ' (spa)' : ''}`));
