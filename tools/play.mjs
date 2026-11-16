// Live play-test: launches Chrome, serves the repo, clicks "play", then drives the game with real CDP
// input events (keyboard + mouse) and reads the simulation through window.__RIFTGUARD. Prints one JSON
// verdict line plus any console noise, and writes the three stills it captures.
//
//   node tools/play.mjs [--url http://127.0.0.1:8099/game/index.html] [--secs 90] [--shots screenshots]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = argOf('--url', '');
const secs = Number(argOf('--secs', '90'));
const shotDir = argOf('--shots', 'screenshots');
mkdirSync(shotDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let serveErr = '';
const chromeErrNote = (tag, d) => { serveErr += `[${tag}] ` + d.toString().slice(-300); };

// ---- serve the repo (game/ is static) -----------------------------------------------------------
const servePort = 8200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['serve.js', '.', String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
let serveUp = false;
await new Promise((resolve) => {
  server.stdout.on('data', (d) => { if (d.toString().includes('serving')) { serveUp = true; resolve(); } });
  server.stderr.on('data', (d) => { chromeErrNote('serve', d); });
  setTimeout(resolve, 3000);
});
const target_url = url || `http://127.0.0.1:${servePort}/game/index.html`;

// ---- chrome ------------------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'play-'));
const port = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=1280,720', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

async function target() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const j = await r.json();
      const page = j.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('chrome did not expose a page: ' + chromeErr.slice(-500));
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description ?? d.text));
  }
  if (msg.method === 'Log.entryAdded') logs.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
});
function send(method, params = {}) {
  seq += 1;
  const myId = seq;
  return new Promise((resolve, reject) => {
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 60000);
  });
}
await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: target_url });

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw');
  return r.result?.value;
};

// wait for the live loop
let ready = false;
for (let i = 0; i < 200; i += 1) {
  ready = await evalJs('!!(window.__RIFTGUARD && window.__RIFTGUARD.sim)').catch(() => false);
  if (ready) break;
  await sleep(150);
}

const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(shotDir, name);
  writeFileSync(path, Buffer.from(s.data, 'base64'));
  return { path, bytes: Buffer.from(s.data, 'base64').length };
};

const shots = [];
if (ready) {
  shots.push(await shot('live-1-start.png'));

  // click PLAY: a trusted gesture, which is what pointer lock needs
  const box = await evalJs(`(() => { const b = document.getElementById('play'); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(500);
  const locked = await evalJs('!!document.pointerLockElement');

  const key = async (type, code, keyName, vk) => send('Input.dispatchKeyEvent', {
    type, code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });

  // walk forward while sweeping the view and firing in bursts
  await key('keyDown', 'KeyW', 'w', 87);
  const trail = [];
  const t0 = Date.now();
  let n = 0;
  let shooting = false;
  while (Date.now() - t0 < secs * 1000) {
    n += 1;
    // sweep the view: relative mouse movement is what a locked pointer reports
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 360, button: 'none', deltaX: Math.sin(n / 6) * 26, deltaY: Math.cos(n / 9) * 5 });
    // fire in bursts of ~700 ms
    const wantShoot = Math.floor((Date.now() - t0) / 700) % 2 === 0;
    if (wantShoot && !shooting) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 360, button: 'left', clickCount: 1 });
      shooting = true;
    } else if (!wantShoot && shooting) {
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 360, button: 'left', clickCount: 1 });
      shooting = false;
    }
    const st = await evalJs(`(() => {
      const g = window.__RIFTGUARD, s = g.sim, p = s.player;
      return {
        t: +s.time.toFixed(2),
        phase: s.match.phase,
        round: s.match.round,
        a: s.match.scoreA, b: s.match.scoreB,
        aliveA: s.actors.filter(a => a.team === 'A' && a.alive).length,
        aliveB: s.actors.filter(a => a.team === 'B' && a.alive).length,
        bombs: s.match.bomb ? s.match.bomb.state : null,
        px: +p.body.position.x.toFixed(2), pz: +p.body.position.z.toFixed(2),
        hp: Math.round(p.health), alive: p.alive,
        kills: p.kills, deaths: p.deaths, fired: p.shotsFired, hits: p.shotsHit,
        money: Math.round(p.money),
      };
    })()`);
    trail.push(st);
    if (n === Math.floor(secs * 1000 / 1200)) shots.push(await shot('live-2-mid.png'));
    await sleep(400);
    if (st.phase === 'MATCH_OVER' || st.round > 1) break;
  }
  await key('keyUp', 'KeyW', 'w', 87);
  if (shooting) await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 360, button: 'left', clickCount: 1 });
  shots.push(await shot('live-3-end.png'));

  const first = trail[0];
  const last = trail[trail.length - 1];
  const moved = Math.hypot(last.px - first.px, last.pz - first.pz);
  const phases = [...new Set(trail.map((s) => s.phase))];
  const verdict = {
    ready: true,
    pointerLocked: locked,
    samples: trail.length,
    simSeconds: +(last.t - first.t).toFixed(1),
    movedMetres: +moved.toFixed(2),
    phasesSeen: phases,
    rounds: last.round,
    score: [last.a, last.b],
    kills: last.kills,
    deaths: last.deaths,
    shotsFired: last.fired,
    shotsHit: last.hits,
    accuracyPct: last.fired ? Math.round((last.hits / last.fired) * 100) : 0,
    aliveAtEnd: [last.aliveA, last.aliveB],
    bombs: trail.map((s) => s.bombs).filter((v, i, a) => v && a.indexOf(v) === i),
    exceptions: logs.filter((l) => l.startsWith('[exception]')),
    consoleErrors: logs.filter((l) => l.startsWith('[error]') || l.startsWith('[log:error]')),
    shots,
  };
  if (!moved || moved < 0.5) verdict.fail = 'player did not move';
  else if (!last.fired) verdict.fail = 'no shots fired';
  console.log('VERDICT ' + JSON.stringify(verdict));
} else {
  console.log('VERDICT ' + JSON.stringify({ ready: false, chromeErr: chromeErr.slice(-400), logs }));
}

ws.close();
chrome.kill('SIGKILL');
server.kill('SIGKILL');
process.exit(0);
