// The simulation: one place that owns all mutable state, stepped at a fixed 60 Hz with no reference to
// the renderer, the DOM or performance.now. main.js reads it and draws it. Everything a round does —
// movement, shots, damage, the bomb, money, the score — happens inside step() and nowhere else.
import { createPlayer, aimDirection } from './player.js';
import { createBot, planRoute, stepBot } from './bot.js';
import { WEAPONS, createWeaponState, spreadFor, takeRounds } from './weapon.js';
import { traceShot, rayWorld, damageAt, createGrenade, stepGrenade, burstHits } from './combat.js';
import { SPAWNS_A, SPAWNS_B, SITE } from './map.js';
import { createMatch, createBomb, tickRound, endRound, nextRound, payRound, PHASE, RULES } from './round.js';
import { makeRng } from './rng.js';

export const FIXED_STEP = 1 / 60;

// One actor is either the player or a bot: the same shape, so combat, damage and the round treat both
// alike. `isPlayer` decides only who the camera follows.
function makeActor({ team, name, body, mover, isPlayer, weaponId }) {
  return {
    team,
    name,
    body,
    mover,
    isPlayer,
    health: 100,
    armor: 0,
    money: RULES.startMoney,
    weaponId,
    weapon: createWeaponState(weaponId),
    grenade: null,
    kills: 0,
    deaths: 0,
    shotsFired: 0,
    shotsHit: 0,
    alive: true,
    // Simulation bookkeeping
    lastFireAt: -1,
    reloadEndsAt: -1,
    switchLockUntil: -1,
  };
}

export function createSimulation({ seed = 1, teamSize = RULES.teamSize } = {}) {
  const rng = makeRng(seed);
  const match = createMatch(rng);
  const events = [];

  // The map's collider list is built by world.js and injected; the simulation never builds meshes.
  let world = { colliders: [] };

  const playerBody = createPlayer(world.colliders);
  const player = makeActor({
    team: 'A', name: 'You', body: playerBody.body, mover: playerBody, isPlayer: true, weaponId: 'sidearm',
  });

  const bots = [];
  for (let i = 0; i < teamSize; i += 1) {
    const b = createBot('A', i, makeRng(seed * 31 + i + 1));
    const p = createPlayer(world.colliders);
    b.body = p.body;
    const actor = makeActor({
      team: 'A', name: `Rift-${i + 2}`, body: p.body, mover: p, isPlayer: false, weaponId: i === 0 ? 'rifle' : 'sidearm',
    });
    // A bot's own movement is the player-body stepper, so bots obey the same collision and stance rules.
    actor.player = p;
    actor.bot = b;
    b.weapon = actor.weapon;
    b.health = actor.health;
    b.money = actor.money;
    bots.push(actor);
  }
  for (let i = 0; i < teamSize; i += 1) {
    const b = createBot('B', i, makeRng(seed * 71 + i + 101));
    const p = createPlayer(world.colliders);
    b.body = p.body;
    const actor = makeActor({
      team: 'B', name: `Warden-${i + 1}`, body: p.body, mover: p, isPlayer: false, weaponId: i === 0 ? 'rifle' : 'smg',
    });
    actor.player = p;
    actor.bot = b;
    b.weapon = actor.weapon;
    b.health = actor.health;
    b.money = actor.money;
    bots.push(actor);
  }

  const actors = [player, ...bots];
  const grenades = [];
  const damageQueue = [];
  const tmpDir = { x: 0, y: 0, z: 0 };

  let time = 0;
  let shotCount = 0;

  // ---- buying --------------------------------------------------------------------------------

  // Spend money on an item during the buy window. Returns true when the purchase happened, so the
  // caller can play the sound and redraw the list without the simulation knowing about either.
  function buyItem(actor, id) {
    if (match.phase !== PHASE.BUY) return false;
    if (id === 'armor') {
      if (actor.armor >= 100) return false;
      if (actor.money < 650) return false;
      actor.money -= 650;
      actor.armor = 100;
      events.push({ type: 'buy', actor, id });
      return true;
    }
    if (id === 'frag') {
      if (actor.grenade !== null) return false;
      if (actor.money < WEAPONS.frag.price) return false;
      actor.money -= WEAPONS.frag.price;
      actor.grenade = { kind: 'frag' };
      events.push({ type: 'buy', actor, id });
      return true;
    }
    const w = WEAPONS[id];
    if (w === undefined || w.price === undefined) return false;
    if (actor.weaponId === id) return false;
    if (actor.money < w.price) return false;
    actor.money -= w.price;
    actor.weaponId = id;
    actor.weapon = createWeaponState(id);
    actor.reloadEndsAt = -1;
    events.push({ type: 'buy', actor, id });
    return true;
  }

  function spawnRound() {
    const spawnsA = SPAWNS_A.slice();
    const spawnsB = SPAWNS_B.slice();
    for (const actor of actors) {
      const list = actor.team === 'A' ? spawnsA : spawnsB;
      const point = list.length > 0 ? list.splice(Math.floor(rng.next() * list.length), 1)[0] : { x: 0, z: actor.team === 'A' ? 22 : -22 };
      actor.mover.respawn(point.x, point.z);
      // Team A spawns on the south side (+z) and must travel to the site at the map's middle, so it
      // faces -z; team B faces the other way. A yaw of 0 aims at -z (see aimDirection in player.js).
      actor.body.yaw = actor.team === 'A' ? 0 : Math.PI;
      actor.body.pitch = 0;
      actor.alive = true;
      actor.health = 100;
      actor.armor = actor.money >= 1000 ? 50 : 0;
      actor.weapon = createWeaponState(actor.weaponId);
      actor.reloadEndsAt = -1;
      actor.lastFireAt = -1;
      if (actor.bot !== undefined) {
        const bot = actor.bot;
        bot.body = actor.body;
        bot.alive = true;
        bot.health = 100;
        bot.target = null;
        bot.routeStep = 0;
        bot.aimProgress = 0;
        bot.reactAt = 0;
        bot.holdUntil = 0;
        bot.weapon = actor.weapon;
        const role = actor.team === 'A' ? ['objective', 'flank', 'hold', 'objective'][actor.bot.index] ?? 'objective'
          : ['hold', 'hold', 'flank', 'hold'][actor.bot.index] ?? 'hold';
        planRoute(bot, role);
      }
    }
    match.bomb = null;
    grenades.length = 0;

    // Bots spend their money at the top of the round, the way a player does in the buy window: the
    // best weapon they can afford, then armour out of what is left.
    for (const actor of bots) {
      let pick = 'sidearm';
      if (actor.money >= WEAPONS.rifle.price) pick = 'rifle';
      else if (actor.money >= WEAPONS.smg.price) pick = 'smg';
      if (pick !== 'sidearm') actor.money -= WEAPONS[pick].price;
      actor.weaponId = pick;
      actor.weapon = createWeaponState(pick);
      actor.reloadEndsAt = -1;
      if (actor.money >= 650) {
        actor.money -= 650;
        actor.armor = 100;
      } else {
        actor.armor = 0;
      }
      if (actor.bot !== undefined) {
        actor.bot.weapon = actor.weapon;
        actor.bot.money = actor.money;
      }
    }
  }

  function setWorld(next) {
    world = next;
    playerBody.takeWorld(next.colliders);
    for (const actor of actors) {
      if (actor.player !== undefined) actor.player.takeWorld(next.colliders);
    }
  }

  // ---- shots ---------------------------------------------------------------------------------

  function fireShot(actor, spreadScale = 1) {
    const w = WEAPONS[actor.weaponId];
    const st = actor.weapon;
    if (actor.weaponId === 'frag') return;
    if (st.reloadingUntil !== undefined && time < st.reloadEndsAt) return;
    if (time < actor.lastFireAt + 60 / w.rpm) return;
    if (st.mag <= 0) {
      beginReload(actor);
      return;
    }
    st.mag -= 1;
    actor.lastFireAt = time;
    actor.shotsFired = (actor.shotsFired ?? 0) + 1;
    shotCount += 1;

    const body = actor.body;
    const speed = Math.hypot(body.velocity.x, body.velocity.z);
    const spread = spreadFor(w, speed, body.onGround ? 1 : 2.6) * spreadScale;
    aimDirection(body, tmpDir);
    // The cone: two independent random angles inside the spread, one for each axis.
    const yawJitter = rng.signed() * spread;
    const pitchJitter = rng.signed() * spread;
    const cy = Math.cos(yawJitter);
    const sy = Math.sin(yawJitter);
    let dx = tmpDir.x * cy - tmpDir.z * sy;
    let dz = tmpDir.x * sy + tmpDir.z * cy;
    let dy = tmpDir.y + pitchJitter;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;

    const ox = body.position.x;
    const oy = body.position.y + body.eye;
    const oz = body.position.z;
    const hit = traceShot(world, actors, actor, ox, oy, oz, dx, dy, dz, w.range);

    body.recoilPitch += w.recoil.pitch;
    body.recoilYaw += rng.signed() * w.recoil.yaw;

    if (hit !== null && hit.actor !== undefined) {
      const dmg = damageAt(w, hit.part, hit.distance);
      damageQueue.push({ target: hit.actor, amount: dmg, part: hit.part, from: actor, weapon: w.name });
      actor.shotsHit = (actor.shotsHit ?? 0) + 1;
      events.push({ type: 'hit', actor, part: hit.part });
      events.push({
        type: 'shot', actor,
        x0: ox, y0: oy, z0: oz,
        x1: ox + dx * hit.distance, y1: oy + dy * hit.distance, z1: oz + dz * hit.distance,
      });
    } else if (hit !== null && hit.wall) {
      events.push({ type: 'impact', x: ox + dx * hit.distance, y: oy + dy * hit.distance, z: oz + dz * hit.distance });
      events.push({
        type: 'shot', actor,
        x0: ox, y0: oy, z0: oz,
        x1: ox + dx * hit.distance, y1: oy + dy * hit.distance, z1: oz + dz * hit.distance,
      });
    } else {
      events.push({
        type: 'shot', actor,
        x0: ox, y0: oy, z0: oz,
        x1: ox + dx * w.range, y1: oy + dy * w.range, z1: oz + dz * w.range,
      });
    }
    if (st.mag === 0) beginReload(actor);
  }

  function beginReload(actor) {
    const w = WEAPONS[actor.weaponId];
    const st = actor.weapon;
    if (actor.weaponId === 'frag') return;
    if (st.mag >= w.magSize) return;
    if (st.reserve <= 0) return;
    if (time < actor.reloadEndsAt) return;
    st.reloadFrom = st.mag;
    actor.reloadEndsAt = time + w.reloadSec;
    st.reloadingUntil = actor.reloadEndsAt;
  }

  function finishReload(actor) {
    const w = WEAPONS[actor.weaponId];
    takeRounds(actor.weapon, w, w.magSize);
  }

  function throwFrag(actor) {
    if (actor.grenade === null) return;
    const g = actor.grenade;
    actor.grenade = null;
    const body = actor.body;
    aimDirection(body, tmpDir);
    const ox = body.position.x + tmpDir.x * 0.5;
    const oy = body.position.y + body.eye - 0.12;
    const oz = body.position.z + tmpDir.z * 0.5;
    grenades.push(createGrenade(
      ox, oy, oz,
      tmpDir.x * 19 + body.velocity.x * 0.4,
      tmpDir.y * 19 + 3.4,
      tmpDir.z * 19 + body.velocity.z * 0.4,
      WEAPONS.frag.fuseSec,
      actor,
    ));
    events.push({ type: 'throw', actor });
  }

  // ---- damage --------------------------------------------------------------------------------

  function applyDamage(entry) {
    const { target, amount, part, from } = entry;
    if (!target.alive || amount <= 0) return;
    let left = amount;
    if (target.armor > 0) {
      const absorbed = Math.min(target.armor, left * 0.5);
      target.armor -= absorbed;
      left -= absorbed;
    }
    target.health -= left;
    if (target.bot !== undefined) target.bot.health = Math.max(0, target.health);
    events.push({ type: 'damage', target, amount: left, part });
    if (target.health <= 0) killActor(target, from, entry.weapon, part === 'head');
  }

  function killActor(target, killer, weaponName, headshot) {
    if (!target.alive) return;
    target.alive = false;
    target.deaths += 1;
    target.body.alive = false;
    if (target.bot !== undefined) { target.bot.alive = false; }
    if (killer !== null && killer !== undefined) {
      killer.kills += 1;
      killer.money = Math.min(RULES.maxMoney, killer.money + RULES.killReward);
      if (killer.bot !== undefined) killer.bot.kills = killer.kills;
    }
    events.push({ type: 'kill', killer, target, weapon: weaponName, headshot });
  }

  // ---- round flow ----------------------------------------------------------------------------

  function teamAlive(team) {
    return actors.some((a) => a.team === team && a.alive);
  }

  function checkRoundEnd() {
    if (match.phase !== PHASE.LIVE) return;
    const a = teamAlive('A');
    const b = teamAlive('B');
    if (!a && !b) return endRound(match, null, 'draw');
    if (!b) return endRound(match, 'A', 'elimination');
    if (!a) return endRound(match, 'B', 'elimination');
  }

  function completeRound() {
    if (match.phase !== PHASE.ENDED) return;
    payRound(match, actors, match.winner);
    if (match.matchOver) return;
    nextRound(match);
    spawnRound();
    events.push({ type: 'roundStart', round: match.round });
  }

  // ---- the step ------------------------------------------------------------------------------

  function step(dt, input) {
    time += dt;

    for (const actor of actors) {
      if (!actor.alive) continue;
      if (actor.reloadEndsAt > 0 && time >= actor.reloadEndsAt) {
        finishReload(actor);
        actor.reloadEndsAt = -1;
        actor.weapon.reloadingUntil = 0;
      }
    }

    const phaseEvents = tickRound(match, dt, { actors });
    if (phaseEvents !== null) for (const e of phaseEvents) events.push(e);

    // The player: look, move, fire, reload, throw, plant.
    if (player.alive && !match.matchOver) {
      const look = input.takeLook();
      playerBody.look(look.x, look.y);
      const aiming = input.state.rightHeld === true;
      playerBody.step(dt, input.state.keys, aiming);

      const wantFire = input.state.firing && match.phase === PHASE.LIVE;
      const w = WEAPONS[player.weaponId];
      if (wantFire && (w.auto || !input.state.firedThisPress)) {
        fireShot(player, aiming ? 0.55 : 1);
        input.state.firedThisPress = true;
      }
      if (!input.state.firing) input.state.firedThisPress = false;

      if (input.state.pressReload) {
        input.state.pressReload = false;
        beginReload(player);
      }
      if (input.state.pressSwitch) {
        input.state.pressSwitch = false;
        player.weaponId = player.weaponId === 'rifle' || player.weaponId === 'smg' || player.weaponId === 'sniper' ? 'sidearm' : 'rifle';
        player.weapon = createWeaponState(player.weaponId);
        player.reloadEndsAt = -1;
      }
      if (input.state.pressGrenade) {
        input.state.pressGrenade = false;
        if (player.grenade !== null) throwFrag(player);
      }
      if (input.state.pressUse) {
        input.state.pressUse = false;
        handleUse(player);
      }
    }

    // Bots: same body stepper, own decisions.
    for (const actor of bots) {
      const bot = actor.bot;
      if (!actor.alive) continue;
      bot.health = actor.health;
      const mates = actors.filter((a) => a.team === bot.team && a !== actor);
      const foes = actors.filter((a) => a.team !== bot.team);
      stepBot(bot, dt, {
        world,
        allies: mates,
        enemies: foes,
        traceWorld: rayWorld,
        time,
        move: (b, d, keys, aiming) => actor.player.step(d, keys, aiming),
        fire: () => fireShot(actor, 1),
      });
      actor.body.yaw = bot.body.yaw;
      actor.body.pitch = bot.body.pitch;
    }

    // Grenades, then the damage they deal.
    for (let i = grenades.length - 1; i >= 0; i -= 1) {
      const burst = stepGrenade(grenades[i], dt, world);
      if (burst !== null) {
        for (const h of burstHits(burst, actors, WEAPONS.frag)) {
          damageQueue.push({ target: h.actor, amount: h.damage, part: 'body', from: burst.owner, weapon: 'Frag' });
        }
        events.push({ type: 'explode', x: burst.x, y: burst.y, z: burst.z });
        grenades.splice(i, 1);
      }
    }

    // Damage is applied after every shot and burst this step, in the order it was queued.
    while (damageQueue.length > 0) applyDamage(damageQueue.shift());

    // The bomb: its owner must be standing in the site for the plant to finish.
    tickBomb(dt);
    checkRoundEnd();

    if (match.matchOver) return events;
    if (match.phase === PHASE.ENDED && match.endHold === undefined) {
      match.endHold = 2.6;
    }
    if (match.phase === PHASE.ENDED) {
      match.endHold -= dt;
      if (match.endHold <= 0) {
        match.endHold = undefined;
        completeRound();
      }
    }
    return events;
  }

  function tickBomb(dt) {
    const bomb = match.bomb;
    if (bomb === null || !bomb.planted) return;
    if (bomb.defusing) {
      bomb.defuseProgress += dt;
      if (bomb.defuseProgress >= RULES.defuseSeconds) {
        bomb.defusedBy = null;
        events.push({ type: 'defused', bomb });
        endRound(match, 'B', 'defuse');
      }
    } else {
      bomb.defuseProgress = Math.max(0, bomb.defuseProgress - dt * 1.6);
    }
  }

  // The use key: plant when an attacker stands in the site carrying the bomb, or defuse when a
  // defender stands on a planted one.
  function handleUse(actor) {
    const p = actor.body.position;
    const inSite = Math.hypot(p.x - SITE.x, p.z - SITE.z) <= SITE.r;
    if (actor.team === 'A' && match.bomb === null && inSite && match.phase === PHASE.LIVE) {
      match.bomb = createBomb(actor);
      match.bomb.planted = true;
      match.bomb.x = p.x;
      match.bomb.y = p.y;
      match.bomb.z = p.z;
      actor.money = Math.min(RULES.maxMoney, actor.money + RULES.plantReward);
      events.push({ type: 'planted', bomb: match.bomb });
    } else if (actor.team === 'B' && match.bomb !== null && match.bomb.planted) {
      const d = Math.hypot(p.x - match.bomb.x, p.z - match.bomb.z);
      match.bomb.defusing = d <= 1.9;
      if (match.bomb.defusing) match.bomb.defusedBy = actor;
    }
  }

  function drainEvents() {
    const out = events.slice();
    events.length = 0;
    return out;
  }

  function reset(nextSeed) {
    if (nextSeed !== undefined) match.rng = makeRng(nextSeed);
    match.phase = PHASE.BUY;
    match.round = 1;
    match.scoreA = 0;
    match.scoreB = 0;
    match.timer = RULES.buySeconds;
    match.bomb = null;
    match.winner = null;
    match.matchOver = false;
    match.lossStreak.A = 0;
    match.lossStreak.B = 0;
    for (const actor of actors) {
      actor.money = RULES.startMoney;
      actor.kills = 0;
      actor.deaths = 0;
    }
    spawnRound();
  }

  spawnRound();

  return {
    get match() { return match; },
    get actors() { return actors; },
    get player() { return player; },
    get bots() { return bots; },
    get time() { return time; },
    get grenades() { return grenades; },
    get shotCount() { return shotCount; },
    step,
    setWorld,
    drainEvents,
    reset,
    fireShot,
    beginReload,
    handleUse,
    finishReload,
    buyItem,
  };
}
