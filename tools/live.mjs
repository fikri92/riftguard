// Live still: a first-person frame from the real game loop. The page is left running its own loop; the
// script clicks PLAY, walks with trusted key events, points the view at the nearest living enemy through
// the simulation's own yaw, taps the trigger, and captures the moment a firefight is on screen.
//
//   node tools/live.mjs [--out screenshots/2-firefight.jpg] [--secs 120]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const outPath = argOf('--out', 'screenshots/2-firefight.jpg');
const secs = Number(argOf('--secs', '120'));
const W = 1280; const H = 720; const MAX_BYTES = 262144;
mkdirSync(dirname(outPath), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servePort = 8200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['serve.js', '.', String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
await sleep(1200);
const profile = mkdtempSync(join(tmpdir(), 'live-'));
const port = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--window-size=${W},${H}`, '--hide-scrollbars', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function target() {
  for (let i = 0; i < 200; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const j = await r.json();
      const p = j.find((t) => t.type === 'page');
      if (p) return p;
    } catch { /* wait */ }
    await sleep(150);
  }
  throw new Error('no page');
}
const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') errors.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
});
const send = (method, params = {}) => {
  seq += 1; const id = seq;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 120000);
  });
};
const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
  return r.result?.value;
};
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${servePort}/game/index.html` });

let ready = false;
for (let i = 0; i < 400; i += 1) {
  ready = await evalJs('!!(window.__RIFTGUARD && window.__RIFTGUARD.sim)').catch(() => false);
  if (ready) break;
  await sleep(120);
}
if (!ready) { console.log(JSON.stringify({ ok: false, reason: 'not ready', errors })); process.exit(3); }
await sleep(900);

// PLAY: a trusted click, so pointer lock has a user gesture behind it (headless may still refuse it,
// which does not stop the loop or the keys).
const box = await evalJs(`(() => { const b = document.getElementById('play'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
if (box) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
const key = (type, code, keyName, vk) => send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });

const tick = () => evalJs(`(() => {
  const g = window.__RIFTGUARD, s = g.sim, p = s.player;
  const foes = s.actors.filter(a => a.team !== p.team && a.alive);
  let best = null, bd = Infinity;
  for (const a of foes) {
    const d = Math.hypot(a.body.position.x - p.body.position.x, a.body.position.z - p.body.position.z);
    if (d < bd) { bd = d; best = a; }
  }
  if (best !== null) {
    // Point the view at the enemy: the same yaw/pitch the mouse drives.
    const dx = best.body.position.x - p.body.position.x;
    const dz = best.body.position.z - p.body.position.z;
    const eye = p.body.position.y + p.body.eye;
    const dy = (best.body.position.y + best.body.height * 0.72) - eye;
    p.body.yaw = Math.atan2(-dx, -dz);
    p.body.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    p.body.recoilPitch = 0; p.body.recoilYaw = 0;
  }
  return {
    phase: s.match.phase, round: s.match.round, over: s.match.matchOver,
    alive: s.actors.filter(a => a.alive).length,
    hp: Math.round(p.health), aliveP: p.alive, kills: p.kills, fired: p.shotsFired, hits: p.shotsHit,
    d: best === null ? null : +bd.toFixed(1), target: best === null ? null : best.name,
    px: +p.body.position.x.toFixed(1), pz: +p.body.position.z.toFixed(1),
    bomb: s.match.bomb ? (s.match.bomb.planted ? 'planted' : 'carried') : null,
    score: [s.match.scoreA, s.match.scoreB],
  };
})()`);

let captured = null;
let shooting = false;
const t0 = Date.now();
const trail = [];
await key('keyDown', 'KeyW', 'w', 87);
while (Date.now() - t0 < secs * 1000) {
  const st = await tick();
  trail.push(st);
  if (st.phase === 'buy') { await sleep(500); continue; }
  if (!st.aliveP) { await sleep(500); continue; }
  // fire in taps while an enemy is in front of the crosshair
  const wantShoot = st.d !== null && st.d < 28;
  if (wantShoot && !shooting) { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.floor(W / 2), y: Math.floor(H / 2), button: 'left', clickCount: 1 }); shooting = true; }
  else if (!wantShoot && shooting) { await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.floor(W / 2), y: Math.floor(H / 2), button: 'left', clickCount: 1 }); shooting = false; }
  // capture the first live frame where an enemy is close and shots are on the wire
  if (captured === null && st.d !== null && st.d < 18 && st.fired > 2) {
    await sleep(120);
    const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 94, captureBeyondViewport: false });
    const bytes = Buffer.from(s.data, 'base64');
    writeFileSync(outPath, bytes);
    captured = { bytes: bytes.length, at: st };
  }
  await sleep(260);
}
await key('keyUp', 'KeyW', 'w', 87);
if (shooting) await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.floor(W / 2), y: Math.floor(H / 2), button: 'left', clickCount: 1 });
const last = trail[trail.length - 1];
console.log(JSON.stringify({
  ok: captured !== null && captured.bytes <= MAX_BYTES,
  out: captured ? outPath : null, bytes: captured?.bytes ?? null,
  capturedAt: captured?.at ?? null,
  samples: trail.length, last, errors: errors.slice(0, 6),
}, null, 1));
ws.close(); chrome.kill('SIGKILL'); server.kill('SIGKILL');
process.exit(captured !== null && captured.bytes <= MAX_BYTES ? 0 : 1);
