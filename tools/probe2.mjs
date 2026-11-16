// Round probe: where are the bodies, what are the bots doing. Headless, no renderer.
import { createSimulation, FIXED_STEP } from '../game/src/sim.js';
import { BOXES, SITE } from '../game/src/map.js';

function colliderOf(box) {
  return {
    minX: box.x - box.w / 2, maxX: box.x + box.w / 2,
    minZ: box.z - box.d / 2, maxZ: box.z + box.d / 2,
    minY: box.y, maxY: box.y + box.h,
    role: box.role,
    ramp: box.role === 'ramp' ? { to: box.rampTo ?? box.y + box.h, flip: !!box.flip } : null,
  };
}
const colliders = BOXES.filter((b) => b.role === 'floor' || b.role === 'catwalk' || b.role === 'ramp' || b.blocks !== false).map(colliderOf);
const sim = createSimulation({ seed: 1 });
sim.setWorld({ colliders });
sim.reset(1);
const input = {
  state: { keys: new Set(['KeyW']), firing: false, rightHeld: false, firedThisPress: false, pressReload: false, pressBuy: false, pressUse: false, pressSwitch: false, pressGrenade: false },
  _look: { x: 0, y: 0 },
  takeLook() { const l = this._look; this._look = { x: 0, y: 0 }; return l; },
  requestLock() {}, release() {}, dispose() {},
};
console.log('SITE', SITE);
const report = (t) => {
  const rows = sim.actors.map((a) => ({
    n: a.name, team: a.team, alive: a.alive, hp: Math.round(a.health), w: a.weaponId,
    x: +a.body.position.x.toFixed(1), z: +a.body.position.z.toFixed(1),
    dSite: +Math.hypot(a.body.position.x - SITE.x, a.body.position.z - SITE.z).toFixed(1),
    goal: a.bot ? a.bot.goal : 'player', routeStep: a.bot ? a.bot.routeStep : null,
  }));
  console.log('t=' + t.toFixed(0) + 's phase=' + sim.match.phase + ' timer=' + sim.match.timer.toFixed(1) + ' bomb=' + (sim.match.bomb ? 'yes' : 'no'));
  for (const r of rows) console.log('   ', JSON.stringify(r));
};
for (let i = 0; i <= 60 * 40; i += 1) {
  if (i % (60 * 5) === 0) report(i * FIXED_STEP);
  sim.step(FIXED_STEP, input);
  sim.drainEvents();
  if (i % (60 * 5) === 0) input.state.keys.clear(), input.state.keys.add('KeyW');
}
