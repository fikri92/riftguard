// Stills: the dossier's images, captured from the game's own screenshot harness plus one live play
// frame. Each still is a real render of the real game; the only difference between them is the camera
// the game itself composes and how much simulation has been stepped.
//
//   node tools/stills.mjs [--out screenshots] [--width 1280] [--height 720]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const outDir = argOf('--out', 'screenshots');
const W = Number(argOf('--width', '1280'));
const H = Number(argOf('--height', '720'));
const MAX_BYTES = 262144;
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servePort = 8200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['serve.js', '.', String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
let up = false;
server.stdout.on('data', (d) => { if (d.toString().includes('serving')) up = true; });
await sleep(1200);
if (!up) { console.log('FAIL serve'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'still-'));
const port = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--window-size=${W},${H}`, '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

async function target() {
  for (let i = 0; i < 200; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const j = await r.json();
      const page = j.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* wait */ }
    await sleep(150);
  }
  throw new Error('no page: ' + chromeErr.slice(-300));
}
const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
let errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') errors.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('[log] ' + m.params.entry.text);
});
const send = (method, params = {}) => {
  seq += 1;
  const id = seq;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 90000);
  });
};
const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
  return r.result?.value;
};
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const results = [];
async function capture(name) {
  for (const quality of [94, 90, 85, 78, 70, 60]) {
    const s = await send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false });
    const bytes = Buffer.from(s.data, 'base64');
    if (bytes.length <= MAX_BYTES || quality === 60) {
      const path = join(outDir, name);
      writeFileSync(path, bytes);
      results.push({ name, bytes: bytes.length, quality, ok: bytes.length <= MAX_BYTES });
      return;
    }
  }
}

async function loadAndWait(url, mode) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 400; i += 1) {
    const ready = await evalJs(`document.documentElement.dataset.shotReady === ${JSON.stringify(mode)}`).catch(() => false);
    if (ready) return true;
    await sleep(120);
  }
  return false;
}

const base = `http://127.0.0.1:${servePort}/game/index.html`;
const seed = 11;

// 1. Cover: the title frame, the map live behind the panel.
const okStart = await loadAndWait(`${base}?shot=start&seed=${seed}`, 'start');
await sleep(500);
await capture('1-cover.jpg');

// 2. Firefight: ~25 s of play, third-person down the lane the player is holding.
const okPlay = await loadAndWait(`${base}?shot=play&seed=${seed}`, 'play');
await sleep(500);
await capture('2-firefight.jpg');

// 3. End card: the round result plate with the score.
const okEnd = await loadAndWait(`${base}?shot=end&seed=${seed}`, 'end');
await sleep(500);
await capture('3-round-end.jpg');

// 4. Live first-person frame: the real loop, driven by trusted key events, HUD included.
await send('Page.navigate', { url: base });
let live = false;
for (let i = 0; i < 300; i += 1) {
  live = await evalJs('!!(window.__RIFTGUARD && window.__RIFTGUARD.sim)').catch(() => false);
  if (live) break;
  await sleep(120);
}
let liveInfo = null;
if (live) {
  const box = await evalJs(`(() => { const b = document.getElementById('play'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (box) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  const key = (type, code, keyName, vk) => send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(600);
  await key('keyDown', 'KeyW', 'w', 87);
  // 22 s of walking: enough for the buy window to end and the lane to fill with bodies.
  for (let i = 0; i < 44; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(W / 2), y: Math.round(H / 2), button: 'none', deltaX: Math.sin(i / 5) * 22, deltaY: 0 });
    await sleep(500);
  }
  await key('keyUp', 'KeyW', 'w', 87);
  await capture('4-live-hud.jpg');
  liveInfo = await evalJs(`(() => { const s = window.__RIFTGUARD.sim; return { phase: s.match.phase, round: s.match.round, a: s.match.scoreA, b: s.match.scoreB, alive: s.actors.filter(x => x.alive).length, fired: s.player.shotsFired, px: +s.player.body.position.x.toFixed(1), pz: +s.player.body.position.z.toFixed(1) }; })()`).catch(() => null);
}

console.log(JSON.stringify({ okStart, okPlay, okEnd, live, liveInfo, results, errors: errors.slice(0, 10) }, null, 1));
ws.close();
chrome.kill('SIGKILL');
server.kill('SIGKILL');
process.exit(results.length >= 3 && results.every((r) => r.ok) ? 0 : 1);
