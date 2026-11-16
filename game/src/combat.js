// Hit detection. Every body carries four hit boxes — head, torso, arms, legs — rebuilt each step from
// its position and stance, and a shot is a ray tested against them and against the map's own boxes.
// A head hit pays far more than a body hit, and a moving shooter's cone is wide, so stopping to aim
// is the difference between a two-tap and an empty magazine.

const HEAD = 0.62;
const TORSO = 1.16;

// A world-space box, compared lexicographically: min then max, for cheap overlap rejection.
function box(cx, cy, cz, hw, hh, hd) {
  return {
    minX: cx - hw, maxX: cx + hw,
    minY: cy - hh, maxY: cy + hh,
    minZ: cz - hd, maxZ: cz + hd,
  };
}

// The four hit boxes of a body, in the order a shot resolves them: head first, so a ray that clips
// both the head and the torso counts as a head shot.
export function hitBoxesOf(body) {
  const { x, y, z } = body.position;
  const crouch = body.crouching ? 0.72 : 1;
  const top = y + body.height;
  const headY = y + body.height * 0.92;
  return [
    { part: 'head', box: box(x, headY, z, 0.17, 0.17 * crouch, 0.17) },
    { part: 'body', box: box(x, y + body.height * 0.58, z, 0.26, body.height * 0.2, 0.22) },
    { part: 'limb', box: box(x, y + body.height * 0.33, z, 0.3, body.height * 0.19, 0.26) },
    { part: 'limb', box: box(x, top - 0.06, z, 0.26, 0.09, 0.2) },
  ];
}

// Ray versus axis-aligned box: the entry distance along the ray, or null. Slab method, no allocation
// beyond the returned number.
export function rayBox(ox, oy, oz, dx, dy, dz, b, maxT) {
  let tmin = 0;
  let tmax = maxT;
  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (ox < b.minX || ox > b.maxX) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (b.minX - ox) * inv;
    let t2 = (b.maxX - ox) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (oy < b.minY || oy > b.maxY) return null;
  } else {
    const inv = 1 / dy;
    let t1 = (b.minY - oy) * inv;
    let t2 = (b.maxY - oy) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (oz < b.minZ || oz > b.maxZ) return null;
  } else {
    const inv = 1 / dz;
    let t1 = (b.minZ - oz) * inv;
    let t2 = (b.maxZ - oz) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

// The nearest solid the ray meets among the map's boxes, as a distance or null.
export function rayWorld(colliders, ox, oy, oz, dx, dy, dz, maxT) {
  let best = null;
  for (const c of colliders) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, c, maxT);
    if (t !== null && t > 0.001 && (best === null || t < best)) best = t;
  }
  return best;
}

// The whole shot: world first, then every body but the shooter. Returns the nearest body hit with its
// part and distance, or null when the ray meets the map or nothing first.
export function traceShot(world, actors, shooter, ox, oy, oz, dx, dy, dz, maxT) {
  const wall = rayWorld(world.colliders, ox, oy, oz, dx, dy, dz, maxT);
  const limit = wall === null ? maxT : wall;
  let hit = null;
  for (const actor of actors) {
    if (actor === shooter || !actor.body.alive) continue;
    for (const hb of hitBoxesOf(actor.body)) {
      const t = rayBox(ox, oy, oz, dx, dy, dz, hb.box, limit);
      if (t !== null && t > 0.001 && (hit === null || t < hit.distance)) {
        hit = { actor, part: hb.part, distance: t };
      }
    }
  }
  if (hit === null) return wall === null ? null : { wall: true, distance: wall };
  return hit;
}

// Falloff: a shot at range keeps only part of its damage, never more than all of it.
export function damageAt(weapon, part, distance) {
  const base = weapon.damage[part] ?? weapon.damage.body;
  const t = Math.min(1, Math.max(0, distance / weapon.range));
  const scale = 1 - (1 - weapon.falloff) * t;
  return base * scale;
}

// Grenades: a thrown body with gravity that bounces off the map and bursts on its fuse, damaging
// everyone inside the radius with the usual head/body/limb split by distance from the burst.
export function createGrenade(x, y, z, vx, vy, vz, fuseSec, owner) {
  return { x, y, z, vx, vy, vz, fuse: fuseSec, owner, spent: false, bounces: 0 };
}

export function stepGrenade(g, dt, world) {
  if (g.spent) return null;
  g.vy -= 22 * dt;
  let nx = g.x + g.vx * dt;
  let ny = g.y + g.vy * dt;
  let nz = g.z + g.vz * dt;
  const b = 0.34;
  const probe = box(nx, ny, nz, b, b, b);
  for (const c of world.colliders) {
    if (probe.maxX < c.minX || probe.minX > c.maxX) continue;
    if (probe.maxY < c.minY || probe.minY > c.maxY) continue;
    if (probe.maxZ < c.minZ || probe.minZ > c.maxZ) continue;
    // Resolve on the axis of least penetration, reversing that velocity with a bounce.
    const dxMin = probe.maxX - c.minX;
    const dxMax = c.maxX - probe.minX;
    const dzMin = probe.maxZ - c.minZ;
    const dzMax = c.maxZ - probe.minZ;
    const dyMin = probe.maxY - c.minY;
    const dyMax = c.maxY - probe.minY;
    const m = Math.min(dxMin, dxMax, dzMin, dzMax, dyMin, dyMax);
    if (m === dyMax) { ny = c.maxY + b; g.vy = Math.abs(g.vy) * 0.28; }
    else if (m === dyMin) { ny = c.minY - b; g.vy = -Math.abs(g.vy) * 0.28; }
    else if (m === dxMin) { nx = c.minX - b; g.vx = -Math.abs(g.vx) * 0.42; }
    else if (m === dxMax) { nx = c.maxX + b; g.vx = Math.abs(g.vx) * 0.42; }
    else if (m === dzMin) { nz = c.minZ - b; g.vz = -Math.abs(g.vz) * 0.42; }
    else { nz = c.maxZ + b; g.vz = Math.abs(g.vz) * 0.42; }
    g.bounces += 1;
    break;
  }
  g.x = nx;
  g.y = ny;
  g.z = nz;
  g.fuse -= dt;
  if (g.fuse > 0) return null;
  g.spent = true;
  return { x: g.x, y: g.y, z: g.z, owner: g.owner };
}

// Who a burst hurts: everyone within the radius, less the further they are, and never the thrower
// unless the frag went off at their own feet.
export function burstHits(burst, actors, def) {
  const out = [];
  for (const actor of actors) {
    if (!actor.body.alive) continue;
    const p = actor.body.position;
    const d = Math.hypot(p.x - burst.x, p.y + 0.9 - burst.y, p.z - burst.z);
    if (d > def.radius) continue;
    const falloff = 1 - d / def.radius;
    const dmg = def.damage.body * falloff * falloff;
    out.push({ actor, part: 'body', damage: dmg });
  }
  return out;
}
