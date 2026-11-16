// Objective-loop probe: runs the live phase with no player input at all and reports why attackers do
// or do not plant — their distance to the site over time, whether a plant ever starts, how the round
// ends. Reads SITE/RULES off the game's debug handle.
//
//   node tools/objective.mjs [--secs 140] [--seed 1]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const secs = Number(argOf('--secs', '140'));
const seed = Number(argOf('--seed', '1'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servePort = 8200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['serve.js', '.', String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve) => { server.stdout.on('data', (d) => { if (d.toString().includes('serving')) resolve(); }); setTimeout(resolve, 3000); });
const profile = mkdtempSync(join(tmpdir(), 'obj-'));
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
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } });
const send = (method, params = {}) => { seq += 1; const id = seq; return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000); }); };
const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw'); return r.result?.value; };
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${servePort}/game/index.html?shot=start&seed=${seed}` });
for (let i = 0; i < 200; i += 1) { if (await evalJs('!!(window.__RIFTGUARD&&window.__RIFTGUARD.sim)').catch(() => false)) break; await sleep(150); }

const out = await evalJs(`(() => {
  const g = window.__RIFTGUARD, sim = g.sim, SITE = g.SITE, RULES = g.RULES;
  const input = { state: { keys: new Set(), firing: false, rightHeld: false, firedThisPress: false, pressReload: false, pressBuy: false, pressUse: false, pressSwitch: false, pressGrenade: false }, takeLook() { return { x: 0, y: 0 }; }, requestLock() {}, release() {}, dispose() {} };
  sim.match.timer = 0.02;
  const trace = [];
  const events = {};
  let plantStart = 0, plantCancel = 0, planted = 0, defused = 0, maxProgress = 0;
  const dt = 1 / 60;
  const limit = Math.round(${secs} / dt);
  for (let i = 0; i < limit; i += 1) {
    sim.step(dt, input);
    const evs = sim.drainEvents();
    for (const e of evs) {
      events[e.type] = (events[e.type] ?? 0) + 1;
      if (e.type === 'plantStart') plantStart += 1;
      if (e.type === 'plantCancel') plantCancel += 1;
      if (e.type === 'planted') planted += 1;
      if (e.type === 'defused') defused += 1;
    }
    if (sim.plant.progress > maxProgress) maxProgress = sim.plant.progress;
    if (i % 300 === 0) {
      trace.push({
        t: +sim.time.toFixed(1), phase: sim.match.phase, timer: +sim.match.timer.toFixed(1),
        bomb: sim.match.bomb ? { planted: sim.match.bomb.planted, timer: +sim.match.bomb.timer.toFixed(1), defusing: sim.match.bomb.defusing } : null,
        plant: { who: sim.plant.actor ? sim.plant.actor.name : null, progress: +sim.plant.progress.toFixed(2) },
        attackers: sim.actors.filter(a => a.team === 'A').map(a => ({ n: a.name, alive: a.alive, d: +Math.hypot(a.body.position.x - SITE.x, a.body.position.z - SITE.z).toFixed(1), x: +a.body.position.x.toFixed(1), z: +a.body.position.z.toFixed(1), goal: a.bot ? a.bot.goal : null, rs: a.bot ? a.bot.routeStep : null, rl: a.bot && a.bot.route ? a.bot.route.length : null, vy: +a.body.velocity.y.toFixed(2), sp: +Math.hypot(a.body.velocity.x, a.body.velocity.z).toFixed(2) })),
        defenders: sim.actors.filter(a => a.team === 'B' && a.alive).length,
        score: [sim.match.scoreA, sim.match.scoreB],
      });
    }
    if (sim.match.matchOver) break;
  }
  return { site: SITE, rules: { plantSeconds: RULES.plantSeconds, defuseSeconds: RULES.defuseSeconds, bombSeconds: RULES.bombSeconds, roundSeconds: RULES.roundSeconds }, events, plantStart, plantCancel, planted, defused, maxProgress: +maxProgress.toFixed(2), rounds: sim.match.round, score: [sim.match.scoreA, sim.match.scoreB], trace };
})()`);

console.log(JSON.stringify(out, null, 1));
ws.close(); chrome.kill('SIGKILL'); server.kill('SIGKILL');
process.exit(0);
