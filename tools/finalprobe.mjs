// Final-plate probe: loads the game's ?shot=final&seed=N harness (a whole match stepped by the
// simulation) for a range of seeds, reports each match's result, and saves the results still from the
// first seed the player's side wins, so the dossier shows a victory plate rather than a loss.
//
//   node tools/finalprobe.mjs [--seeds 1,2,3] [--out screenshots] [--name 3-round-end.jpg]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const seeds = argOf('--seeds', '1,2,3,4,5,6').split(',').map(Number);
const outDir = argOf('--out', 'screenshots');
const name = argOf('--name', '3-round-end.jpg');
const W = 1280, H = 720;
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servePort = 8200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['serve.js', '.', String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
let up = false;
server.stdout.on('data', (d) => { if (d.toString().includes('serving')) up = true; });
await sleep(1200);
if (!up) { console.log('FAIL serve'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'probe-'));
const port = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--window-size=${W},${H}`, '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function target() {
  for (let i = 0; i < 200; i += 1) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = j.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up */ }
    await sleep(150);
  }
  throw new Error('no page');
}
const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const m = JSON.parse(event.data);
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const send = (method, params = {}) => {
  seq += 1;
  const id = seq;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 120000);
  });
};
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw');
  return r.result?.value;
};
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const base = `http://127.0.0.1:${servePort}/game/index.html`;
const results = [];
let saved = null;

for (const seed of seeds) {
  await send('Page.navigate', { url: `${base}?shot=final&seed=${seed}` });
  let ready = false;
  for (let i = 0; i < 900; i += 1) {
    ready = await evalJs('document.documentElement.dataset.shotReady === "final"').catch(() => false);
    if (ready) break;
    await sleep(120);
  }
  if (!ready) { results.push({ seed, error: 'not ready' }); continue; }
  const st = await evalJs(`(() => { const s = window.__RIFTGUARD.sim, p = s.player; return {
    matchOver: s.match.matchOver, round: s.match.round, a: s.match.scoreA, b: s.match.scoreB,
    kills: p.kills, fired: p.shotsFired, hits: p.shotsHit }; })()`);
  const win = st.a > st.b;
  results.push({ seed, ...st, win });
  if (win && saved === null) {
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
    const bytes = Buffer.from(shot.data, 'base64');
    writeFileSync(join(outDir, name), bytes);
    saved = { seed, bytes: bytes.length, name };
  }
}

console.log(JSON.stringify({ results, saved }, null, 1));
ws.close();
chrome.kill('SIGKILL');
server.kill('SIGKILL');
process.exit(saved === null ? 1 : 0);
