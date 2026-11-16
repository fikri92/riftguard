// Full-match logic test, no rendering: loads the game's capture harness (?shot=start) which exposes the
// simulation, then drives whole matches in-page with a synthetic input object — the same shape the DOM
// input layer produces. Proves spawn -> live -> fire -> kills -> plant/defuse -> round end -> match over,
// and that a seed replays identically (determinism gate).
//
//   node tools/simtest.mjs [--seeds 5] [--out out/simtest.json]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CHROME = '/root/.hermes/tools/chromium-1208/chrome-linux64/chrome';
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const seedsToRun = Number(argOf('--seeds', '5'));
const outPath = argOf('--out', 'out/simtest.json');
mkdirSync(dirname(outPath), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const servePort = 8200 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['serve.js', '.', String(servePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve) => {
  server.stdout.on('data', (d) => { if (d.toString().includes('serving')) resolve(); });
  setTimeout(resolve, 3000);
});

const profile = mkdtempSync(join(tmpdir(), 'sim-'));
const port = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--window-size=640,360', '--hide-scrollbars',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

async function target() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const j = await r.json();
      const p = j.find((t) => t.type === 'page');
      if (p) return p;
    } catch { /* not up */ }
    await sleep(150);
  }
  throw new Error('chrome did not expose a page: ' + chromeErr.slice(-400));
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
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push('[exception] ' + (d.exception?.description ?? d.text));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') logs.push('[error] ' + msg.params.entry.text);
});
function send(method, params = {}) {
  seq += 1;
  const myId = seq;
  return new Promise((resolve, reject) => {
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 120000);
  });
}
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw');
  return r.result?.value;
};

await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${servePort}/game/index.html?shot=start&seed=1` });

let ready = false;
for (let i = 0; i < 200; i += 1) {
  ready = await evalJs('!!(window.__RIFTGUARD && window.__RIFTGUARD.sim)').catch(() => false);
  if (ready) break;
  await sleep(150);
}
if (!ready) {
  console.log('FAIL not ready: ' + JSON.stringify({ chromeErr: chromeErr.slice(-300), logs }));
  ws.close(); chrome.kill('SIGKILL'); server.kill('SIGKILL'); process.exit(3);
}

// One match per seed, inside the page. The player walks forward, sweeps the view and fires in bursts;
// the aim is nudged onto the nearest living enemy so the player's own gun is exercised, not just bots.
const runner = (seeds) => {
  const g = window.__RIFTGUARD;
  const sim = g.sim;
  const DT = 1 / 60;
  const results = [];
  for (const seed of seeds) {
    sim.reset(seed);
    const input = {
      state: {
        keys: new Set(['KeyW']), firing: false, rightHeld: false, firedThisPress: false,
        pressReload: false, pressBuy: false, pressUse: false, pressSwitch: false, pressGrenade: false,
      },
      _look: { x: 0, y: 0 },
      takeLook() { const l = this._look; this._look = { x: 0, y: 0 }; return l; },
      requestLock() {}, release() {}, dispose() {},
    };
    const seen = { phases: [], events: {}, kills: 0, playerKills: 0, plants: 0, defuses: 0, roundEnds: [] };
    let steps = 0;
    const startFired = sim.player.shotsFired;
    while (!sim.match.matchOver && steps < 240000) {
      // aim assist: swing the view toward the nearest living enemy every few steps
      if (steps % 6 === 0) {
        const me = sim.player.body;
        let best = null; let bd = Infinity;
        for (const a of sim.actors) {
          if (!a.alive || a.isPlayer || a.team === sim.player.team) continue;
          const d = Math.hypot(a.body.position.x - me.position.x, a.body.position.z - me.position.z);
          if (d < bd) { bd = d; best = a; }
        }
        if (best) {
          const dx = best.body.position.x - me.position.x;
          const dz = best.body.position.z - me.position.z;
          const want = Math.atan2(-dx, -dz);
          let err = want - me.yaw;
          while (err > Math.PI) err -= Math.PI * 2;
          while (err < -Math.PI) err += Math.PI * 2;
          input._look.x += err * 40;
          input.state.firing = bd < 32;
        } else {
          input.state.firing = false;
        }
      }
      sim.step(DT, input);
      // the simulation keeps one live event buffer; drain it or every step replays its whole history
      const evs = sim.drainEvents();
      for (const e of evs) {
        seen.events[e.type] = (seen.events[e.type] ?? 0) + 1;
        if (e.type === 'kill') { seen.kills += 1; if (e.killer && e.killer.isPlayer) seen.playerKills += 1; }
        if (e.type === 'planted') seen.plants += 1;
        if (e.type === 'defused') seen.defuses += 1;
      }
      const ph = sim.match.phase;
      if (seen.phases[seen.phases.length - 1] !== ph) seen.phases.push(ph);
      if (sim.match.phase === 'ended' && sim.match.lastReason && seen.roundEnds.length < sim.match.round) {
        seen.roundEnds.push(sim.match.lastReason);
      }
      steps += 1;
    }
    results.push({
      seed,
      steps,
      simSeconds: +(steps * DT).toFixed(1),
      matchOver: sim.match.matchOver,
      rounds: sim.match.round,
      score: [sim.match.scoreA, sim.match.scoreB],
      winner: sim.match.winner,
      playerKills: sim.player.kills,
      playerDeaths: sim.player.deaths,
      shotsFired: sim.player.shotsFired - startFired,
      shotsHit: sim.player.shotsHit,
      totalKills: seen.kills,
      plants: seen.plants,
      defuses: seen.defuses,
      eventTypes: seen.events,
      roundEnds: seen.roundEnds,
    });
  }
  return results;
};

const seeds = [];
for (let i = 1; i <= seedsToRun; i += 1) seeds.push(i, i); // each seed twice: replay must be identical
const all = await evalJs(`(${runner.toString()})(${JSON.stringify(seeds)})`);

const key = (r) => JSON.stringify([r.rounds, r.score, r.playerKills, r.winner, r.totalKills, r.plants, r.defuses, r.shotsFired]);
const pairs = [];
for (let i = 0; i < all.length; i += 2) pairs.push({ seed: all[i].seed, identical: key(all[i]) === key(all[i + 1]), a: all[i], b: all[i + 1] });
const results = pairs.map((p) => p.a);
const replaySame = pairs.every((p) => p.identical);
const allDone = results.every((r) => r.matchOver === true);
const allFought = results.every((r) => r.totalKills > 0 && r.playerKills > 0 && r.shotsFired > 0);

const verdict = {
  ok: allDone && allFought && replaySame && logs.length === 0,
  distinctSeeds: results.length,
  runsPerSeed: 2,
  replayIdentical: replaySame,
  allReachedMatchOver: allDone,
  everyMatchHadPlayerKills: allFought,
  exceptions: logs,
  results,
};
writeFileSync(outPath, JSON.stringify(verdict, null, 2));
console.log('VERDICT ' + JSON.stringify({ ...verdict, results: verdict.results.map((r) => ({ seed: r.seed, rounds: r.rounds, score: r.score, winner: r.winner, playerKills: r.playerKills, totalKills: r.totalKills, plants: r.plants, defuses: r.defuses, shotsFired: r.shotsFired, shotsHit: r.shotsHit, simSeconds: r.simSeconds })) }));
console.log('WROTE ' + outPath);
ws.close(); chrome.kill('SIGKILL'); server.kill('SIGKILL');
process.exit(verdict.ok ? 0 : 1);
