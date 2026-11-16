// Capture harness: boots the real game in headless Chrome, plays it with trusted input events, grades
// the run from the simulation itself, and writes the three stills a dossier needs (cover, firefight,
// round end) as JPEG under the screenshot gate: 1280x720, quality tuned down until each file is under
// 256 KiB.
//
//   node tools/capture.mjs [--secs 120] [--out screenshots] [--width 1280] [--height 720]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const secs = Number(argOf('--secs', '120'));
const outDir = argOf('--out', 'screenshots');
const W = Number(argOf('--width', '1280'));
const H = Number(argOf('--height', '720'));
const MAX_BYTES = Number(argOf('--max-bytes', '262144'));
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servePort = 8200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['serve.js', '.', String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
let serveUp = false;
server.stdout.on('data', (d) => { if (d.toString().includes('serving')) serveUp = true; });
await sleep(1200);
if (!serveUp) { console.log('FAIL serve did not start'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'cap-'));
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
    } catch { /* not up */ }
    await sleep(150);
  }
  throw new Error('no page: ' + chromeErr.slice(-400));
}
const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (event) => {
  const m = JSON.parse(event.data);
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('[log:error] ' + m.params.entry.text);
});
const send = (method, params = {}) => {
  seq += 1;
  const id = seq;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
  });
};
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw');
  return r.result?.value;
};
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${servePort}/game/index.html` });

let ready = false;
for (let i = 0; i < 300; i += 1) {
  ready = await evalJs('!!(window.__RIFTGUARD && window.__RIFTGUARD.sim)').catch(() => false);
  if (ready) break;
  await sleep(120);
}
if (!ready) {
  console.log('FAIL not ready ' + JSON.stringify({ logs, chromeErr: chromeErr.slice(-300) }));
  process.exit(3);
}
await sleep(1200); // let the first frames settle so the cover is not a black canvas

const shots = [];
async function shot(name) {
  for (const quality of [92, 86, 80, 72, 64, 55]) {
    const s = await send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false });
    const bytes = Buffer.from(s.data, 'base64');
    if (bytes.length <= MAX_BYTES || quality === 55) {
      const path = join(outDir, name);
      writeFileSync(path, bytes);
      shots.push({ name, path, bytes: bytes.length, quality });
      return { path, bytes: bytes.length, quality };
    }
  }
  return null;
}

// Cover: the title screen with the map live behind it.
await shot('1-cover.jpg');

// Click PLAY (a trusted gesture: pointer lock needs one).
const box = await evalJs(`(() => { const b = document.getElementById('play'); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await sleep(600);
const locked = await evalJs('!!document.pointerLockElement').catch(() => false);

const key = (type, code, keyName, vk) => send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });

const snapshot = () => evalJs(`(() => {
  const g = window.__RIFTGUARD, s = g.sim, p = s.player;
  const foes = s.actors.filter(a => a.team !== p.team && a.alive);
  let best = null, bd = Infinity;
  for (const a of foes) { const d = Math.hypot(a.body.position.x - p.body.position.x, a.body.position.z - p.body.position.z); if (d < bd) { bd = d; best = a; } }
  return {
    t: +s.time.toFixed(2), phase: s.match.phase, round: s.match.round,
    a: s.match.scoreA, b: s.match.scoreB, matchOver: s.match.matchOver,
    aliveA: s.actors.filter(x => x.team === 'A' && x.alive).length,
    aliveB: s.actors.filter(x => x.team === 'B' && x.alive).length,
    bombState: s.match.bomb ? (s.match.bomb.planted ? 'planted' : 'carried') : null,
    px: +p.body.position.x.toFixed(2), pz: +p.body.position.z.toFixed(2),
    yaw: +p.body.yaw.toFixed(3), pitch: +p.body.pitch.toFixed(3),
    hp: Math.round(p.health), alive: p.alive, kills: p.kills, deaths: p.deaths,
    fired: p.shotsFired, hits: p.shotsHit, money: Math.round(p.money),
    target: best === null ? null : { dx: +(best.body.position.x - p.body.position.x).toFixed(2), dz: +(best.body.position.z - p.body.position.z).toFixed(2), d: +bd.toFixed(1), name: best.name },
  };
})()`);

// Aim: pointer-lock mouse movement is dx * 0.0022 radians of yaw (player.look).
async function aimAt(dx, dz, yaw) {
  const want = Math.atan2(-dx, -dz);
  let err = want - yaw;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;
  const deltaX = -err / 0.0022; // look subtracts dx * sensitivity from yaw
  if (Math.abs(deltaX) < 1) return;
  const cx = Math.floor(W / 2); const cy = Math.floor(H / 2);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', deltaX, deltaY: 0 });
}

const trail = [];
let shooting = false;
const t0 = Date.now();
let n = 0;
let midShot = false;
let endShot = false;
const sights = [];

while (Date.now() - t0 < secs * 1000) {
  n += 1;
  const st = await snapshot();
  trail.push(st);

  // mid-fight still: taken while a firefight is on and the player is in the live phase
  if (!midShot && st.phase === 'live' && st.target !== null && st.target.d < 26 && st.round >= 1) {
    if (shooting) { await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.floor(W / 2), y: Math.floor(H / 2), button: 'left', clickCount: 1 }); shooting = false; }
    await shot('2-firefight.jpg');
    midShot = true;
  }

  if (st.matchOver) break;

  if (st.phase === 'buy') {
    await key('keyDown', 'KeyB', 'b', 66);
    await sleep(60);
    await key('keyUp', 'KeyB', 'b', 66);
    await sleep(400);
    continue;
  }

  if (!st.alive) { await sleep(500); continue; }

  // Walk toward the objective: the bomb site, or the nearest enemy if it is close.
  const wantW = st.target !== null && st.target.d < 15 ? false : true;
  if (wantW) await key('keyDown', 'KeyW', 'w', 87); else await key('keyUp', 'KeyW', 'w', 87);

  if (st.target !== null) {
    await aimAt(st.target.dx, st.target.dz, st.yaw);
    const wantShoot = st.target.d < 30;
    if (wantShoot && !shooting) { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.floor(W / 2), y: Math.floor(H / 2), button: 'left', clickCount: 1 }); shooting = true; }
    else if (!wantShoot && shooting) { await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.floor(W / 2), y: Math.floor(H / 2), button: 'left', clickCount: 1 }); shooting = false; }
  } else if (shooting) {
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.floor(W / 2), y: Math.floor(H / 2), button: 'left', clickCount: 1 });
    shooting = false;
  }

  await sleep(220);
}

await key('keyUp', 'KeyW', 'w', 87);
if (shooting) await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.floor(W / 2), y: Math.floor(H / 2), button: 'left', clickCount: 1 });

// End still: the round-over plate or the live HUD, whichever is on screen.
if (!endShot) { await sleep(400); await shot('3-round-end.jpg'); endShot = true; }

const first = trail[0];
const last = trail[trail.length - 1];
const verdict = {
  ready: true,
  pointerLocked: locked,
  samples: trail.length,
  simSeconds: +(last.t - first.t).toFixed(1),
  movedMetres: +Math.hypot(last.px - first.px, last.pz - first.pz).toFixed(2),
  phasesSeen: [...new Set(trail.map((s) => s.phase))],
  rounds: last.round,
  score: [last.a, last.b],
  matchOver: last.matchOver,
  kills: last.kills,
  deaths: last.deaths,
  shotsFired: last.fired,
  shotsHit: last.hits,
  accuracyPct: last.fired ? Math.round((last.hits / last.fired) * 100) : 0,
  bombSeen: [...new Set(trail.map((s) => s.bombState).filter(Boolean))],
  shots,
  logs: logs.slice(0, 20),
};
console.log(JSON.stringify(verdict, null, 1));
ws.close();
chrome.kill('SIGKILL');
server.kill('SIGKILL');
process.exit(verdict.logs.length === 0 && verdict.shotsFired > 0 && verdict.movedMetres > 1 ? 0 : 1);
