import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';
const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 8080);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css' };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = normalize(join(root, decodeURIComponent(url.pathname)));
    if (p !== root && !p.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (url.pathname === '/' || url.pathname.endsWith('/')) p = join(p, 'index.html');
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) { res.writeHead(404).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log('serving', root, port));
