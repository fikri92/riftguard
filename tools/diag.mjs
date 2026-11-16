// Diagnostic probe: loads the game's ?shot=start harness, prints the state a playtest cannot see from
// outside (weapon, ammo, money, bomb ownership), then runs a controlled firing test in the live phase.
//
//   node tools/diag.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servePort = 8200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['serve.js', '.', String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve) => { server.stdout.on('data', (d) => { if (d.toString().includes('serving')) resolve(); }); setTimeout(resolve, 3000); });

const profile = mkdtempSync(join(tmpdir(), 'diag-'));
const port = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=640,360', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
async function target() {
  for (let i = 0; i < 120; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); const j = await r.json(); const p = j.find((t) => t.type === 'page'); if (p) return p; } catch { /* wait */ }
    await sleep(150);
  }
  throw new Error('no page');
}
const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
});
const send = (method, params = {}) => { seq += 1; const id = seq; return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000); }); };
const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw'); return r.result?.value; };
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${servePort}/game/index.html?shot=start&seed=1` });
for (let i = 0; i < 200; i += 1) { if (await evalJs('!!(window.__RIFTGUARD&&window.__RIFTGUARD.sim)').catch(() => false)) break; await sleep(150); }

const probe = await evalJs(`(() => {
  const sim = window.__RIFTGUARD.sim;
  const p = sim.player;
  const snap = (tag) => ({
    tag,
    phase: sim.match.phase, timer: +sim.match.timer.toFixed(2), time: +sim.time.toFixed(2),
    weaponId: p.weaponId, money: Math.round(p.money), alive: p.alive, hp: Math.round(p.health),
    shotsFired: p.shotsFired, kills: p.kills,
    weapon: p.weapon ? { ammo: p.weapon.ammo, mag: p.weapon.mag, reloading: !!(p.weapon.reloadingUntil > 0), cooldownUntil: p.weapon.cooldownUntil ?? null } : null,
    bomb: sim.match.bomb ? { carrier: sim.match.bomb.carrier?.name ?? null, planted: sim.match.bomb.planted, state: sim.match.bomb.state } : null,
    teams: { A: sim.actors.filter(a => a.team === 'A').length, B: sim.actors.filter(a => a.team === 'B').length },
    actors: sim.actors.map(a => ({ n: a.name, team: a.team, me: !!a.isPlayer, alive: a.alive, hp: Math.round(a.health), bomb: !!a.hasBomb, weapon: a.weaponId })),
  });
  const out = [];
  out.push(snap('spawn'));
  const input = { state: { keys: new Set(), firing: true, rightHeld: false, firedThisPress: false, pressReload: false, pressBuy: false, pressUse: false, pressSwitch: false, pressGrenade: false }, takeLook() { return { x: 0, y: 0 }; }, requestLock() {}, release() {}, dispose() {} };
  // clear the buy window without waiting it out
  sim.match.timer = 0.02;
  for (let i = 0; i < 120; i += 1) { sim.step(1 / 60, input); sim.drainEvents(); }
  out.push(snap('after-2s-live-firing'));
  for (let i = 0; i < 600; i += 1) { sim.step(1 / 60, input); sim.drainEvents(); }
  out.push(snap('after-12s-live-firing'));
  return out;
})()`);

console.log(JSON.stringify(probe, null, 1));
ws.close(); chrome.kill('SIGKILL'); server.kill('SIGKILL');
process.exit(0);
