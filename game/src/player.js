// The player body: a capsule walked against the map's axis-aligned colliders, with acceleration on the
// ground, friction, air control, crouch (slower, lower eye), and step-up so a low crate is climbable.
// The step function is pure apart from the body it owns, so the same call drives play and screenshots.
import { MAP_HALF } from './map.js';

const RADIUS = 0.34;
const HEIGHT_STAND = 1.78;
const HEIGHT_CROUCH = 1.16;
const EYE_STAND = 1.62;
const EYE_CROUCH = 1.02;

// Movement tuning: these numbers decide whether stopping to aim pays. Ground acceleration is high
// enough to feel responsive, but firing while moving costs accuracy through weapon.js's spread.
const GROUND_ACCEL = 62;
const AIR_ACCEL = 14;
const FRICTION = 9.2;
const MAX_SPEED = 6.4;
const MAX_SPEED_CROUCH = 2.9;
const MAX_SPEED_AIM = 3.3;
const GRAVITY = 22;
const JUMP_SPEED = 6.6;
const STEP_UP = 0.55;

export function createPlayer(colliders) {
  // The collider list is swappable so the simulation can hand each body the world's colliders once
  // world.js has built them, without rebuilding the body.
  let solids = colliders;
  const body = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    crouching: false,
    eye: EYE_STAND,
    height: HEIGHT_STAND,
    recoilPitch: 0,
    recoilYaw: 0,
    spreadPulse: 0,
    alive: true,
  };

  // Which collider the body is standing on, or null. A ramp reports its interpolated top.
  function groundAt(x, z, feetY) {
    let best = null;
    let bestTop = -Infinity;
    for (const c of solids) {
      if (x + RADIUS < c.minX || x - RADIUS > c.maxX) continue;
      if (z + RADIUS < c.minZ || z - RADIUS > c.maxZ) continue;
      let top = c.maxY;
      if (c.ramp !== null) {
        const t = (z - c.minZ) / (c.maxZ - c.minZ);
        const u = c.ramp.flip ? 1 - t : t;
        top = c.minY + (c.ramp.to - c.minY) * Math.min(1, Math.max(0, u));
      }
      if (top <= feetY + STEP_UP && top > bestTop) {
        bestTop = top;
        best = c;
      }
    }
    return best === null ? null : { collider: best, top: bestTop };
  }

  // Push the body out of any collider it overlaps horizontally, on the shallower axis.
  function resolveHorizontal(next) {
    for (const c of solids) {
      const feet = next.y;
      if (feet >= c.maxY - 0.02) continue;
      if (feet + body.height <= c.minY + 0.02) continue;
      const minX = c.minX - RADIUS;
      const maxX = c.maxX + RADIUS;
      const minZ = c.minZ - RADIUS;
      const maxZ = c.maxZ + RADIUS;
      if (next.x <= minX || next.x >= maxX || next.z <= minZ || next.z >= maxZ) continue;
      const dxMin = next.x - minX;
      const dxMax = maxX - next.x;
      const dzMin = next.z - minZ;
      const dzMax = maxZ - next.z;
      const m = Math.min(dxMin, dxMax, dzMin, dzMax);
      if (m === dxMin) next.x = minX;
      else if (m === dxMax) next.x = maxX;
      else if (m === dzMin) next.z = minZ;
      else next.z = maxZ;
    }
    // The playfield's own edge.
    const lim = MAP_HALF - 1.2;
    next.x = Math.min(lim, Math.max(-lim, next.x));
    next.z = Math.min(lim, Math.max(-lim, next.z));
  }

  function look(dx, dy) {
    if (!body.alive) return;
    const sensitivity = 0.0022;
    body.yaw -= dx * sensitivity;
    body.pitch -= dy * sensitivity;
    const limit = Math.PI / 2 - 0.02;
    body.pitch = Math.min(limit, Math.max(-limit, body.pitch));
  }

  // A kick applied to the view on each shot; it decays and pulls the aim up and to the side.
  function addRecoil(pitch, yaw) {
    body.recoilPitch += pitch;
    body.recoilYaw += yaw;
    body.spreadPulse = Math.min(1, body.spreadPulse + 0.34);
  }

  function step(dt, keys, aiming) {
    body.crouching = keys.has('ControlLeft') || keys.has('ControlRight');
    const targetHeight = body.crouching ? HEIGHT_CROUCH : HEIGHT_STAND;
    body.height += (targetHeight - body.height) * Math.min(1, dt * 12);
    body.eye = body.crouching ? EYE_CROUCH : EYE_STAND;

    // Recoil decays toward zero: the shot's kick is transient, the aim returns where it was left.
    const decay = Math.exp(-dt * 7.5);
    body.recoilPitch *= decay;
    body.recoilYaw *= decay;
    body.spreadPulse *= Math.exp(-dt * 4.2);

    // Wish direction in world space from the held keys, relative to the current yaw.
    let fwd = 0;
    let side = 0;
    if (keys.has('KeyW')) fwd += 1;
    if (keys.has('KeyS')) fwd -= 1;
    if (keys.has('KeyD')) side += 1;
    if (keys.has('KeyA')) side -= 1;
    const len = Math.hypot(fwd, side);
    if (len > 0) {
      fwd /= len;
      side /= len;
    }
    const sin = Math.sin(body.yaw);
    const cos = Math.cos(body.yaw);
    const wishX = -sin * fwd + cos * side;
    const wishZ = -cos * fwd - sin * side;

    const speedCap = body.crouching ? MAX_SPEED_CROUCH : aiming ? MAX_SPEED_AIM : MAX_SPEED;
    const accel = body.onGround ? GROUND_ACCEL : AIR_ACCEL;

    // Friction first, like a Quake-lineage movement model: it bites the fastest while grounded.
    if (body.onGround) {
      const speed = Math.hypot(body.velocity.x, body.velocity.z);
      if (speed > 0.001) {
        const drop = Math.max(speed, 2.0) * FRICTION * dt;
        const k = Math.max(0, speed - drop) / speed;
        body.velocity.x *= k;
        body.velocity.z *= k;
      }
    }

    if (len > 0) {
      const cur = body.velocity.x * wishX + body.velocity.z * wishZ;
      const add = Math.min(accel * dt, Math.max(0, speedCap - cur));
      body.velocity.x += wishX * add;
      body.velocity.z += wishZ * add;
    }

    // Jump: only from the ground, and it lifts the body off whatever it stands on.
    if (keys.has('Space') && body.onGround) {
      body.velocity.y = JUMP_SPEED;
      body.onGround = false;
    }

    body.velocity.y -= GRAVITY * dt;

    const next = {
      x: body.position.x + body.velocity.x * dt,
      y: body.position.y + body.velocity.y * dt,
      z: body.position.z + body.velocity.z * dt,
    };
    resolveHorizontal(next);

    // Vertical: land on the highest surface under the body that is not above the step height.
    const ground = groundAt(next.x, next.z, Math.max(body.position.y, next.y));
    if (ground !== null && next.y <= ground.top + 0.001) {
      next.y = ground.top;
      if (body.velocity.y < 0) body.velocity.y = 0;
      body.onGround = true;
    } else {
      body.onGround = false;
    }

    // A body that falls through the floor is put back on it rather than lost.
    if (next.y < -4) {
      next.y = 0.4;
      body.velocity.y = 0;
      body.onGround = true;
    }

    body.position.x = next.x;
    body.position.y = next.y;
    body.position.z = next.z;
  }

  function respawn(x, z) {
    body.position.x = x;
    body.position.y = 0.4;
    body.position.z = z;
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    body.yaw = 0;
    body.pitch = 0;
    body.recoilPitch = 0;
    body.recoilYaw = 0;
    body.spreadPulse = 0;
    body.onGround = true;
    body.alive = true;
  }

  // Point the body at a new collider set. Used once, when the world is built after the bodies exist.
  function takeWorld(nextSolids) {
    solids = nextSolids;
  }

  return { body, step, look, addRecoil, respawn, takeWorld, RADIUS, EYE_STAND, EYE_CROUCH };
}

// Where a shot goes from a body: the aim direction with the transient recoil folded in. Shared by the
// player's own fire and by bots, so both are held to the same rule.
export function aimDirection(body, out) {
  const pitch = body.pitch + body.recoilPitch;
  const yaw = body.yaw + body.recoilYaw;
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}
