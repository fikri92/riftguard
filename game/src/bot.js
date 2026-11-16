// Bots: a small behaviour set, not one monolithic AI. Each bot picks a goal from the round state, walks
// a route of waypoints through the map, watches a cone in front of it, and shoots only once its own
// aim has settled. They hold angles, fall back to cover when hurt, and hear gunfire.
import { NAV_HINTS, SITE } from './map.js';
import { aimDirection } from './player.js';

const VIEW_RANGE = 52;
const FOV_COS = Math.cos(1.15); // about 66 degrees either side
const AIM_TIME = 0.34;
const REACTION = 0.22;

function dist2(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

// The nearest waypoint to a point, as an index.
function nearestWaypoint(point) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < NAV_HINTS.length; i += 1) {
    const d = dist2(point, NAV_HINTS[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function createBot(team, index, rng) {
  return {
    team,
    index,
    body: null,
    alive: true,
    health: 100,
    armor: 0,
    money: 800,
    weaponId: 'sidearm',
    weapon: null,
    kills: 0,
    deaths: 0,
    // Behaviour
    goal: 'advance',
    waypoint: 0,
    route: null,
    routeStep: 0,
    target: null,
    seenAt: 0,
    aimProgress: 0,
    reactAt: 0,
    holdUntil: 0,
    strafeDir: 1,
    strafeUntil: 0,
    lastShotAt: 0,
    burstLeft: 2,
    burstPauseUntil: 0,
    hasFrag: false,
    rng,
  };
}

// A route from a spawn to the objective, or to a defensive hold: a short list of waypoint indices the
// bot walks in order. The map is open enough that a waypoint chain reads as a real lane rotation.
export function planRoute(bot, role) {
  const attacks = bot.team === 'A';
  const order = [];
  if (role === 'objective') {
    order.push(nearestWaypoint({ x: 0, z: attacks ? 18 : -18 }));
    order.push(nearestWaypoint({ x: attacks ? 8 : -8, z: attacks ? 20 : -20 }));
    order.push(nearestWaypoint({ x: 0, z: 0 }));
    order.push(nearestWaypoint(SITE));
  } else if (role === 'flank') {
    order.push(nearestWaypoint({ x: attacks ? -8 : 8, z: attacks ? 6 : -6 }));
    order.push(nearestWaypoint({ x: attacks ? -6 : 6, z: attacks ? -18 : 18 }));
    order.push(nearestWaypoint(SITE));
  } else {
    // A hold: park on a lane and watch it.
    order.push(nearestWaypoint({ x: attacks ? 8 : -8, z: attacks ? -6 : 6 }));
  }
  bot.route = order;
  bot.routeStep = 0;
  bot.goal = role === 'hold' ? 'hold' : 'advance';
  return order;
}

// Can this bot see that actor? A cone check plus a straight line that the map does not block.
export function canSee(bot, other, world, traceWorld) {
  const a = bot.body.position;
  const b = other.body.position;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  if (dist > VIEW_RANGE || dist < 0.001) return false;
  const fwdX = -Math.sin(bot.body.yaw);
  const fwdZ = -Math.cos(bot.body.yaw);
  const dot = (dx * fwdX + dz * fwdZ) / dist;
  if (dot < FOV_COS) return false;
  const ey = a.y + bot.body.eye;
  const ty = b.y + other.body.height * 0.6;
  const len = Math.hypot(dx, ty - ey, dz);
  const wall = traceWorld(world.colliders, a.x, ey, a.z, dx / len, (ty - ey) / len, dz / len, dist);
  return wall === null || wall > dist - 0.4;
}

// One simulation step for a bot: decide, turn toward what it wants to face, move, and shoot.
export function stepBot(bot, dt, ctx) {
  if (!bot.body.alive) return;
  const { world, enemies, allies, traceWorld, time, fire } = ctx;

  // ---- 1. Perception: the nearest visible enemy, and whether gunfire was heard nearby this step.
  let target = null;
  let targetDist = Infinity;
  for (const other of enemies) {
    if (!other.body.alive) continue;
    if (!canSee(bot, other, world, traceWorld)) continue;
    const d = dist2(bot.body.position, other.body.position);
    if (d < targetDist) { targetDist = d; target = other; }
  }
  if (target !== null && target !== bot.target) {
    bot.target = target;
    bot.reactAt = time + REACTION * (0.7 + bot.rng.next() * 0.9);
    bot.aimProgress = 0;
  }
  if (target === null && bot.target !== null && !bot.target.body.alive) bot.target = null;

  // ---- 2. Goal selection: engage what is visible, otherwise walk the route, otherwise hold.
  const p = bot.body.position;
  if (target !== null) {
    if (bot.goal !== 'engage') { bot.goal = 'engage'; bot.strafeUntil = 0; }
  } else if (bot.goal === 'engage') {
    bot.goal = bot.route !== null && bot.routeStep < bot.route.length ? 'advance' : 'hold';
    bot.target = null;
  }

  // ---- 3. Facing: turn toward the target, or toward the next waypoint, at a bounded rate.
  const turnRate = 5.4 * dt;
  const wantYaw = (() => {
    if (bot.target !== null) {
      const t = bot.target.body.position;
      return Math.atan2(-(t.x - p.x), -(t.z - p.z));
    }
    const wp = currentWaypoint(bot);
    if (wp === null) return bot.body.yaw;
    return Math.atan2(-(wp.x - p.x), -(wp.z - p.z));
  })();
  let dyaw = wantYaw - bot.body.yaw;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2;
  while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  bot.body.yaw += Math.max(-turnRate, Math.min(turnRate, dyaw));

  // ---- 4. Movement: advance along the route, strafe while engaging, hold otherwise.
  const keys = new Set();
  if (bot.goal === 'engage') {
    if (bot.strafeUntil < time) {
      bot.strafeDir = bot.rng.next() < 0.5 ? -1 : 1;
      bot.strafeUntil = time + 0.5 + bot.rng.next() * 0.9;
    }
    keys.add(bot.strafeDir > 0 ? 'KeyD' : 'KeyA');
    // Back off if the target is very close, close in if it is far.
    const d = Math.sqrt(targetDist);
    if (d < 5) keys.add('KeyS');
    else if (d > 22) keys.add('KeyW');
    if (bot.health < 45 && bot.rng.next() < dt * 3.2) keys.add('KeyS');
  } else if (bot.goal === 'advance') {
    const wp = currentWaypoint(bot);
    if (wp === null) {
      bot.goal = 'hold';
      bot.holdUntil = time + 4 + bot.rng.next() * 5;
    } else {
      const d = Math.hypot(wp.x - p.x, wp.z - p.z);
      if (d < 1.8) {
        bot.routeStep += 1;
      } else {
        keys.add('KeyW');
      }
    }
  } else if (bot.goal === 'hold' && bot.holdUntil < time) {
    bot.holdUntil = time + 5 + bot.rng.next() * 6;
    bot.body.yaw += (bot.rng.next() - 0.5) * 1.6;
  }

  // A bot holds a stance: it crouches when it stops to shoot from a hold at range.
  if (bot.goal === 'hold' && bot.target === null && bot.rng.next() < 0.5) keys.add('ControlLeft');

  ctx.move(bot, dt, keys, bot.target !== null);

  // ---- 5. Fire: only after the reaction time, only once the aim has settled on the target.
  if (bot.target !== null && time >= bot.reactAt) {
    aim(bot, dt, bot.target);
    const aimError = Math.abs(angleTo(bot, bot.target));
    const settled = aimError < 0.05;
    bot.aimProgress = settled ? bot.aimProgress + dt : 0;
    if (settled && bot.aimProgress > AIM_TIME * (0.5 + bot.rng.next() * 0.7)) {
      fire(bot, time);
    }
  } else {
    bot.body.pitch *= 0.94;
  }
}

function currentWaypoint(bot) {
  if (bot.route === null || bot.routeStep >= bot.route.length) return null;
  return NAV_HINTS[bot.route[bot.routeStep]];
}

// How far the bot's aim is from its target, in radians of yaw.
function angleTo(bot, target) {
  const p = bot.body.position;
  const t = target.body.position;
  const want = Math.atan2(-(t.x - p.x), -(t.z - p.z));
  let d = want - (bot.body.yaw + bot.body.recoilYaw);
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Turn the bot's pitch onto its target and let it track the torso, not the feet.
function aim(bot, dt, target) {
  const p = bot.body.position;
  const t = target.body.position;
  const eye = p.y + bot.body.eye;
  const ty = t.y + target.body.height * 0.72;
  const dx = t.x - p.x;
  const dz = t.z - p.z;
  const flat = Math.hypot(dx, dz) || 1;
  const want = Math.atan2(ty - eye, flat);
  bot.body.pitch += (want - bot.body.pitch) * Math.min(1, dt * 9);
}
