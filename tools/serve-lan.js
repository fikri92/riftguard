// LAN/tailnet preview server: same static rules as serve.js, but bound to every interface so the game
// can be opened from another machine on the same tailnet or LAN. Read-only, no directory listing.
//
//   node tools/serve-lan.js [root] [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 8089);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = normalize(join(root, decodeURIComponent(url.pathname)));
    if (p !== root && !p.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (url.pathname === '/' || url.pathname.endsWith('/')) p = join(p, 'index.html');
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '0.0.0.0', () => console.log('serving', root, 'on 0.0.0.0:' + port));
