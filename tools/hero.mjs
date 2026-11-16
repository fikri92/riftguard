// Hero still: the firefight frame for the dossier. The shipped capture harness frames the player's body
// from behind, which can land on a blank wall; this steps the real simulation in the page until two
// opposing bodies are actually trading shots, then renders that moment through the game's own renderer.
//
//   node tools/hero.mjs [--out screenshots/2-firefight.jpg] [--seeds 1,2,3,4,5,6]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const outPath = argOf('--out', 'screenshots/2-firefight.jpg');
const seedList = argOf('--seeds', '1,2,3,4,5,6').split(',').map(Number);
const W = 1280; const H = 720; const MAX_BYTES = 262144;
mkdirSync(dirname(outPath), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servePort = 8200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['serve.js', '.', String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
await sleep(1200);
const profile = mkdtempSync(join(tmpdir(), 'hero-'));
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
// The compositor only hands back frames it has painted; a single render() is not enough, and a
// throttled headless tab can serve a stale frame. A one-frame screencast forces the paint.
async function grabFrame() {
  const frames = [];
  const onFrame = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.screencastFrame') {
      frames.push(m.params);
      send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
    }
  };
  ws.addEventListener('message', onFrame);
  await send('Page.startScreencast', { format: 'jpeg', quality: 94, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  for (let i = 0; i < 60 && frames.length < 3; i += 1) await sleep(100);
  await send('Page.stopScreencast').catch(() => {});
  ws.removeEventListener('message', onFrame);
  if (frames.length === 0) return null;
  const last = frames[frames.length - 1];
  return { bytes: Buffer.from(last.data, 'base64'), meta: last.metadata };
}

await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const base = `http://127.0.0.1:${servePort}/game/index.html`;

// In-page: step until two opposing bodies are trading shots, then pick a camera that is outside the
// geometry and has a clear line to both of them.
const compose = `(() => {
  const g = window.__RIFTGUARD, sim = g.sim, cam = g.camera, boxes = (g.world && g.world.colliders) || [];
  if (!g.syncBodies) return { ok: false, reason: 'no syncBodies' };
  const DT = 1 / 60;
  const input = {
    state: { keys: new Set(['KeyW']), firing: true, rightHeld: false, firedThisPress: false, pressReload: false, pressBuy: false, pressUse: false, pressSwitch: false, pressGrenade: false },
    takeLook() { return { x: Math.sin(sim.time * 0.8) * 0.7, y: 0 }; },
    requestLock() {}, release() {}, dispose() {},
  };
  let steps = 0; let kills = 0; let fired = 0; let best = null; let bestDist = Infinity;
  while (steps < 60 * 45) {
    sim.step(DT, input);
    for (const e of sim.drainEvents()) { if (e.type === 'kill') kills += 1; if (e.type === 'shot') fired += 1; }
    steps += 1;
    if (sim.match.phase !== 'live') continue;
    for (const a of sim.actors) {
      if (!a.alive) continue;
      for (const b of sim.actors) {
        if (!b.alive || b.team === a.team) continue;
        const d = Math.hypot(a.body.position.x - b.body.position.x, a.body.position.z - b.body.position.z);
        if (d < bestDist && d > 2.0 && d < 16) { bestDist = d; best = [a, b]; }
      }
    }
    if (best !== null && fired > 14) break;
  }
  g.syncBodies(0.016); g.syncBomb(); g.updateHud(0.016);
  if (g.viewModel) g.viewModel.visible = false;

  const alive = sim.actors.filter(a => a.alive);
  if (alive.length === 0) return { ok: false, reason: 'none alive', steps };

  // Segment versus AABB: is the view from p to q blocked by a collider that is tall enough to matter?
  const blocked = (p, q) => {
    const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
    for (const c of boxes) {
      if (c.maxY < 1.0) continue; // low lips and trim do not hide a body
      let tmin = 0, tmax = 1;
      let ok = true;
      for (const [o, d, lo, hi] of [[p.x, dx, c.minX, c.maxX], [p.y, dy, c.minY, c.maxY], [p.z, dz, c.minZ, c.maxZ]]) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { ok = false; break; } continue; }
        let t1 = (lo - o) / d; let t2 = (hi - o) / d;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { ok = false; break; }
      }
      if (ok && tmax > 0.02 && tmin < 0.98) return true;
    }
    return false;
  };
  const insideSolid = (p) => boxes.some((c) => c.maxY > 1.0
    && p.x > c.minX - 0.5 && p.x < c.maxX + 0.5
    && p.z > c.minZ - 0.5 && p.z < c.maxZ + 0.5
    && p.y > c.minY - 0.2 && p.y < c.maxY + 0.2);

  const pair = best;
  const focus = pair
    ? { x: (pair[0].body.position.x + pair[1].body.position.x) / 2, z: (pair[0].body.position.z + pair[1].body.position.z) / 2 }
    : (() => { const c = alive.reduce((m, a) => ({ x: m.x + a.body.position.x / alive.length, z: m.z + a.body.position.z / alive.length }), { x: 0, z: 0 }); return c; })();

  // Try a ring of camera placements around the pair; keep the closest one with a clear view of both.
  const targets = pair
    ? [{ x: pair[0].body.position.x, y: pair[0].body.position.y + 1.3, z: pair[0].body.position.z },
       { x: pair[1].body.position.x, y: pair[1].body.position.y + 1.3, z: pair[1].body.position.z }]
    : [{ x: focus.x, y: 1.3, z: focus.z }];
  let chosen = null;
  for (const dist of [6.5, 8.5, 11, 14]) {
    for (let k = 0; k < 16; k += 1) {
      const ang = (k / 16) * Math.PI * 2;
      for (const height of [2.6, 3.6, 5.0]) {
        const p = { x: focus.x + Math.cos(ang) * dist, y: height, z: focus.z + Math.sin(ang) * dist };
        if (insideSolid(p)) continue;
        if (targets.some((t) => blocked(p, t))) continue;
        chosen = { p, dist, ang, height };
        break;
      }
      if (chosen) break;
    }
    if (chosen) break;
  }
  if (chosen === null) {
    chosen = { p: { x: focus.x + 8, y: 7.5, z: focus.z + 8 }, dist: 11.3, height: 7.5, fallback: true };
  }
  cam.fov = 60; cam.updateProjectionMatrix();
  cam.position.set(chosen.p.x, chosen.p.y, chosen.p.z);
  cam.rotation.set(0, 0, 0);
  cam.lookAt(focus.x, 1.25, focus.z);
  g.renderer.render(g.scene, cam);
  // Keep presenting this frame: the compositor only captures what the page has painted since the last
  // commit, so a single render() right before capture can hand back the previous camera's frame.
  if (window.__HERO_LOOP) clearInterval(window.__HERO_LOOP);
  window.__HERO_LOOP = setInterval(() => {
    cam.position.set(chosen.p.x, chosen.p.y, chosen.p.z);
    cam.rotation.set(0, 0, 0);
    cam.lookAt(focus.x, 1.25, focus.z);
    g.renderer.render(g.scene, cam);
  }, 16);
  return {
    ok: true, steps, kills, fired, alive: alive.length,
    closePair: pair ? +bestDist.toFixed(1) : null,
    pair: pair ? [pair[0].name, pair[1].name] : null,
    camera: { dist: chosen.dist, height: chosen.height, fallback: !!chosen.fallback },
    phase: sim.match.phase, round: sim.match.round,
    planted: !!(sim.match.bomb && sim.match.bomb.planted),
    focus: { x: +focus.x.toFixed(1), z: +focus.z.toFixed(1) },
  };
})()`;

const candidates = [];
for (const seed of seedList) {
  await send('Page.navigate', { url: `${base}?shot=play&seed=${seed}` });
  let ready = false;
  for (let i = 0; i < 300; i += 1) {
    ready = await evalJs(`document.documentElement.dataset.shotReady === 'play'`).catch(() => false);
    if (ready) break;
    await sleep(120);
  }
  if (!ready) { candidates.push({ seed, ok: false, reason: 'not ready' }); continue; }
  let info = null;
  try { info = await evalJs(compose); } catch (e) { candidates.push({ seed, ok: false, reason: String(e).slice(0, 160) }); continue; }
  if (!info || !info.ok) { candidates.push({ seed, ok: false, info }); continue; }
  await sleep(600);
  const got = await grabFrame();
  await evalJs('(() => { if (window.__HERO_LOOP) { clearInterval(window.__HERO_LOOP); window.__HERO_LOOP = null; } return true; })()').catch(() => {});
  if (got === null) { candidates.push({ seed, ok: false, reason: 'no screencast frame', info }); continue; }
  const bytes = got.bytes;
  candidates.push({ seed, ok: true, bytes: bytes.length, info, data: bytes.toString('base64') });
}
ws.close(); chrome.kill('SIGKILL'); server.kill('SIGKILL');

const good = candidates.filter((c) => c.ok);
if (good.length === 0) {
  console.log(JSON.stringify({ ok: false, candidates }, null, 1));
  process.exit(1);
}
// Prefer a photographable pair: close without being inside each other, more bodies alive, more shots.
const score = (c) => (c.info.closePair === null ? 0 : 40 - Math.abs(c.info.closePair - 6) * 3) + c.info.alive * 3 + Math.min(20, c.info.fired);
good.sort((a, b) => score(b) - score(a));
const best = good[0];
writeFileSync(outPath, Buffer.from(best.data, 'base64'));
console.log(JSON.stringify({
  ok: true, out: outPath, bytes: best.bytes, seed: best.seed, score: score(best), picked: best.info,
  others: candidates.map((c) => ({ seed: c.seed, ok: c.ok, alive: c.info?.alive, pair: c.info?.closePair, fired: c.info?.fired, bytes: c.bytes })),
  errors: errors.slice(0, 6),
}, null, 1));
process.exit(best.bytes <= MAX_BYTES ? 0 : 1);
