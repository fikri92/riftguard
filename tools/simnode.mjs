// Headless match harness: runs the real simulation (game/src/sim.js) in plain Node, no browser, no
// renderer. The world's colliders are built from map.js exactly the way world.js builds them, so the
// ray tests a shot resolves against are the same AABBs the browser game uses.
//
// The player is driven like a human who knows the objective: walk the nav path to the site, aim at the
// nearest enemy in view, tap the trigger, stand on the site to plant.
//
//   node tools/simnode.mjs [--seeds 1,2,3] [--out out/simnode.json]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSimulation, FIXED_STEP } from '../game/src/sim.js';
import { BOXES, SITE } from '../game/src/map.js';
import { findPath, clearSight } from '../game/src/nav.js';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const seeds = (argOf('--seeds', '1,2,3')).split(',').map(Number);
const outPath = argOf('--out', 'out/simnode.json');

// world.js: a walkable box carries the player; role floor/catwalk/ramp always walk, others by `blocks`.
function colliderOf(box) {
  return {
    minX: box.x - box.w / 2, maxX: box.x + box.w / 2,
    minZ: box.z - box.d / 2, maxZ: box.z + box.d / 2,
    minY: box.y, maxY: box.y + box.h,
    role: box.role,
    ramp: box.role === 'ramp' ? { to: box.rampTo ?? box.y + box.h, flip: !!box.flip } : null,
  };
}
const colliders = BOXES
  .filter((b) => b.role === 'floor' || b.role === 'catwalk' || b.role === 'ramp' || b.blocks !== false)
  .map(colliderOf);

const sim = createSimulation({ seed: seeds[0] });
sim.setWorld({ colliders });

const DT = FIXED_STEP;
const SENS = 0.0022;

function makeInput() {
  return {
    state: {
      keys: new Set(), firing: false, rightHeld: false, firedThisPress: false,
      pressReload: false, pressBuy: false, pressUse: false, pressSwitch: false, pressGrenade: false,
    },
    _look: { x: 0, y: 0 },
    takeLook() { const l = this._look; this._look = { x: 0, y: 0 }; return l; },
    requestLock() {}, release() {}, dispose() {},
  };
}

const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

function runMatch(seed) {
  sim.reset(seed);
  const input = makeInput();
  const seen = { kills: 0, playerKills: 0, plants: 0, defuses: 0, events: {}, roundLog: [] };
  const shotsStart = sim.player.shotsFired;
  let steps = 0;
  const maxSteps = 240000;
  let path = null;
  let pathStep = 0;
  let repathAt = -1;
  let tap = 0;
  let aimedSteps = 0; let fireSteps = 0;

  while (!sim.match.matchOver && steps < maxSteps) {
    const me = sim.player.body;
    const keys = input.state.keys;
    keys.clear();

    // Objective: walk the nav path to the site unless a target is close enough to fight.
    let best = null; let bestD = Infinity;
    for (const a of sim.actors) {
      if (a === sim.player || !a.alive || a.team === sim.player.team) continue;
      const d = Math.hypot(a.body.position.x - me.position.x, a.body.position.z - me.position.z);
      if (d < bestD && (d < 45)) { bestD = d; best = a; }
    }
    const inSite = Math.hypot(me.position.x - SITE.x, me.position.z - SITE.z) <= SITE.r;
    if (inSite && sim.match.phase === 'live') {
      // stand on the site: the plant finishes only while the planter holds still
    } else {
      if (path === null || steps * DT > repathAt || (sim.match.bomb !== null && !sim.match.bomb.planted === false)) {
        path = findPath({ x: me.position.x, z: me.position.z }, { x: SITE.x, z: SITE.z });
        pathStep = 0;
        repathAt = steps * DT + 6;
      }
      while (path !== null && pathStep < path.length
        && Math.hypot(path[pathStep].x - me.position.x, path[pathStep].z - me.position.z) < 0.8) pathStep += 1;
      const node = path !== null && pathStep < path.length ? path[pathStep] : { x: SITE.x, z: SITE.z };
      const yaw = me.yaw;
      const dx = node.x - me.position.x;
      const dz = node.z - me.position.z;
      const fwd = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
      const side = dx * Math.cos(yaw) + dz * -Math.sin(yaw);
      if (fwd > 0.2) keys.add('KeyW'); else if (fwd < -0.2) keys.add('KeyS');
      if (side > 0.5) keys.add('KeyD'); else if (side < -0.5) keys.add('KeyA');
      if (keys.size === 0) keys.add('KeyW');
    }

    // Aim at the target if one is in a clear line; tap the trigger so a semi-auto keeps firing.
    let aimPoint = best === null ? null : best.body.position;
    if (aimPoint !== null && !clearSight({ x: me.position.x, z: me.position.z }, { x: aimPoint.x, z: aimPoint.z })) {
      aimPoint = bestD < 8 ? aimPoint : null; // close enough that the shot may still clear the corner
    }
    if (aimPoint !== null) {
      aimedSteps += 1;
      const want = Math.atan2(-(aimPoint.x - me.position.x), -(aimPoint.z - me.position.z));
      const err = wrap(want - me.yaw);
      input._look.x += err / SENS * 0.5;
      tap += 1;
      input.state.firing = tap % 8 < 5; // release every few frames: the sidearm needs a fresh press
    } else {
      input.state.firing = false;
      if (path !== null && pathStep < path.length) {
        const node = path[pathStep];
        const want = Math.atan2(-(node.x - me.position.x), -(node.z - me.position.z));
        input._look.x += wrap(want - me.yaw) / SENS * 0.25;
      }
    }
    if (sim.match.phase === 'buy' && !sim.player.hasRifleAttempt) {
      input.state.pressBuy = true;
      sim.player.hasRifleAttempt = true;
    }

    if (input.state.firing) fireSteps += 1;
    sim.step(DT, input);
    for (const e of sim.drainEvents()) {
      seen.events[e.type] = (seen.events[e.type] ?? 0) + 1;
      if (e.type === 'kill') { seen.kills += 1; if (e.killer && e.killer.isPlayer) seen.playerKills += 1; }
      if (e.type === 'planted') seen.plants += 1;
      if (e.type === 'defused') seen.defuses += 1;
    }
    if (sim.match.phase === 'ended' && seen.roundLog.length < sim.match.round) {
      seen.roundLog.push({ round: sim.match.round, reason: sim.match.roundReason, winner: sim.match.winner, atSec: +(steps * DT).toFixed(1) });
      path = null; repathAt = -1;
    }
    if (sim.match.phase === 'buy') path = null;
    steps += 1;
  }

  return {
    seed,
    steps,
    simSeconds: +(steps * DT).toFixed(1),
    matchOver: sim.match.matchOver,
    rounds: sim.match.round,
    score: [sim.match.scoreA, sim.match.scoreB],
    winner: sim.match.winner,
    playerKills: sim.player.kills,
    playerDeaths: sim.player.deaths,
    shotsFired: sim.player.shotsFired - shotsStart,
    shotsHit: sim.player.shotsHit,
    totalKills: seen.kills,
    plants: seen.plants,
    defuses: seen.defuses,
    events: seen.events,
    aimedSteps, fireSteps, mag: sim.player.weapon.mag, weapon: sim.player.weaponId, alive: sim.player.alive,
    roundLog: seen.roundLog,
  };
}

const results = [];
for (const seed of seeds) results.push(runMatch(seed));
const replay = runMatch(seeds[0]);
const key = (r) => JSON.stringify([r.rounds, r.score, r.playerKills, r.winner, r.totalKills, r.plants, r.defuses, r.shotsFired]);
const deterministic = key(results[0]) === key(replay);

const verdict = {
  ok: results.every((r) => r.matchOver && r.playerKills > 0 && r.shotsFired > 0) && deterministic,
  deterministic,
  results,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(verdict, null, 2));
console.log(JSON.stringify({
  ok: verdict.ok,
  deterministic,
  results: results.map((r) => ({
    seed: r.seed, secs: r.simSeconds, rounds: r.rounds, score: r.score, winner: r.winner,
    pKills: r.playerKills, pDeaths: r.playerDeaths, shots: r.shotsFired, hits: r.shotsHit,
    kills: r.totalKills, plants: r.plants, defuses: r.defuses, rounds2: r.roundLog.map((x) => x.reason + ':' + x.winner),
  })),
}, null, 1));
