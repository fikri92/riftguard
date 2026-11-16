// Boot and presentation. The simulation owns every piece of game state; this file only steps it at a
// fixed rate and draws what it finds: the camera from the player's body, one low-poly body per actor,
// tracers and impacts as short-lived effects, and a DOM HUD whose numbers are all read from the sim.
//
// The screenshot harness runs the same code with ?shot=start|play|end&seed=N: it steps the simulation a
// fixed number of times, renders one frame, and sets window.__RIFTGUARD_READY__, so a headless capture
// is deterministic and shows the real game rather than a mock-up.
import * as THREE from 'three';
import { createWorld } from './world.js';
import { createSimulation, FIXED_STEP } from './sim.js';
import { createInput } from './input.js';
import { createHud } from './hud.js';
import { BUY_MENU, WEAPONS } from './weapon.js';
import { PALETTE } from './palette.js';
import { SITE, MAP_HALF } from './map.js';
import { PHASE } from './round.js';

const params = new URLSearchParams(location.search);
const shotMode = params.get('shot');
const seed = Number(params.get('seed') ?? '1') || 1;

// ---- renderer ---------------------------------------------------------------------------------

const mount = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
// PCFSoftShadowMap was removed from this three.js release; PCFShadowMap is the soft-filtered map it
// still ships, and asking for the removed one only logs a warning and falls back to it anyway.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
mount.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.06, 260);
const world = createWorld(scene);

const sim = createSimulation({ seed });
sim.setWorld(world);

const hud = createHud(document.getElementById('hud'), BUY_MENU);

// ---- actor bodies -----------------------------------------------------------------------------

// One body per actor, built once: a torso, a head, a pair of legs and a weapon stub. Team colour is
// the only difference between the two sides, so a body is identifiable at a glance across the map.
function buildBody(actor) {
  const group = new THREE.Group();
  const teamColor = actor.team === 'A' ? PALETTE.team : PALETTE.hostile;
  const cloth = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.72, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b2429, roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x8a7358, roughness: 0.9 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.5, 4, 8), cloth);
  torso.position.y = 1.16;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), skin);
  head.position.y = 1.66;
  head.castShadow = true;
  group.add(head);

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.185, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), cloth);
  helmet.position.y = 1.67;
  group.add(helmet);

  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.52, 4, 8), dark);
  legs.position.y = 0.55;
  legs.castShadow = true;
  group.add(legs);

  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.72), dark);
  gun.position.set(0.2, 1.3, -0.34);
  group.add(gun);

  // A small team-coloured lamp above the head: visible from across the map, never blinding up close.
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 6, 6),
    new THREE.MeshBasicMaterial({ color: teamColor }),
  );
  marker.position.y = 2.0;
  group.add(marker);

  scene.add(group);
  return { group, torso, head, legs, gun, marker, material: cloth };
}

const bodies = new Map();
for (const actor of sim.actors) {
  if (actor.isPlayer) continue;
  bodies.set(actor, buildBody(actor));
}

// ---- first-person view model ----------------------------------------------------------------

// The held weapon, in its own scene ride-along: a stubby receiver, a barrel and a sight, placed low and
// to the right so it never covers the reticle.
const viewModel = new THREE.Group();
{
  const receiverMat = new THREE.MeshStandardMaterial({ color: 0x232b30, roughness: 0.6, metalness: 0.35 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x151b1f, roughness: 0.45, metalness: 0.55 });

  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.42), receiverMat);
  receiver.position.set(0, 0, -0.1);
  viewModel.add(receiver);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 8), barrelMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.5);
  viewModel.add(barrel);

  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.05), receiverMat);
  sight.position.set(0, 0.085, -0.16);
  viewModel.add(sight);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.08), receiverMat);
  grip.position.set(0, -0.12, 0.04);
  viewModel.add(grip);

  viewModel.position.set(0.17, -0.19, -0.28);
  camera.add(viewModel);
}
scene.add(camera);

// A muzzle flash: a small emissive card in front of the barrel, shown for two frames per shot.
const muzzle = new THREE.Mesh(
  new THREE.PlaneGeometry(0.22, 0.22),
  new THREE.MeshBasicMaterial({ color: 0xffd27f, transparent: true, opacity: 0, depthWrite: false }),
);
muzzle.position.set(0, 0.012, -0.78);
viewModel.add(muzzle);

// ---- effects ----------------------------------------------------------------------------------

// Tracers: a fixed pool of line segments, each with a life. A shot claims one and it fades in place.
const TRACER_COUNT = 48;
const tracerGeo = new THREE.BufferGeometry();
const tracerPos = new Float32Array(TRACER_COUNT * 6);
tracerGeo.setAttribute('position', new THREE.BufferAttribute(tracerPos, 3));
const tracerLines = new THREE.LineSegments(
  tracerGeo,
  new THREE.LineBasicMaterial({ color: 0xffe0a8, transparent: true, opacity: 0.85, depthWrite: false }),
);
tracerLines.frustumCulled = false;
scene.add(tracerLines);
const tracers = Array.from({ length: TRACER_COUNT }, () => ({ life: 0, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 }));
let tracerCursor = 0;

function addTracer(x0, y0, z0, x1, y1, z1) {
  const t = tracers[tracerCursor];
  tracerCursor = (tracerCursor + 1) % TRACER_COUNT;
  t.life = 0.055;
  t.x0 = x0; t.y0 = y0; t.z0 = z0;
  t.x1 = x1; t.y1 = y1; t.z1 = z1;
}

function stepTracers(dt) {
  for (let i = 0; i < TRACER_COUNT; i += 1) {
    const t = tracers[i];
    const o = i * 6;
    if (t.life > 0) {
      t.life -= dt;
      tracerPos[o] = t.x0; tracerPos[o + 1] = t.y0; tracerPos[o + 2] = t.z0;
      tracerPos[o + 3] = t.x1; tracerPos[o + 4] = t.y1; tracerPos[o + 5] = t.z1;
    } else {
      tracerPos[o] = 0; tracerPos[o + 1] = -100; tracerPos[o + 2] = 0;
      tracerPos[o + 3] = 0; tracerPos[o + 4] = -100; tracerPos[o + 5] = 0;
    }
  }
  tracerGeo.attributes.position.needsUpdate = true;
}

// Impact sparks: short-lived points at the hit location, drawn as a small additive sprite.
const SPARK_COUNT = 32;
const sparkGeo = new THREE.BufferGeometry();
const sparkPos = new Float32Array(SPARK_COUNT * 3);
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
const sparks = new THREE.Points(
  sparkGeo,
  new THREE.PointsMaterial({ color: 0xffc46b, size: 0.13, transparent: true, opacity: 0.9, depthWrite: false }),
);
sparks.frustumCulled = false;
scene.add(sparks);
const sparkLife = new Float32Array(SPARK_COUNT);
let sparkCursor = 0;

function addSpark(x, y, z) {
  const i = sparkCursor;
  sparkCursor = (sparkCursor + 1) % SPARK_COUNT;
  sparkPos[i * 3] = x;
  sparkPos[i * 3 + 1] = y;
  sparkPos[i * 3 + 2] = z;
  sparkLife[i] = 0.16;
}

function stepSparks(dt) {
  for (let i = 0; i < SPARK_COUNT; i += 1) {
    if (sparkLife[i] > 0) sparkLife[i] -= dt;
    else sparkPos[i * 3 + 1] = -100;
  }
  sparkGeo.attributes.position.needsUpdate = true;
}

// Explosion: one expanding shell, reused for every burst.
const blast = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0, depthWrite: false }),
);
blast.visible = false;
scene.add(blast);
let blastLife = 0;

function addBlast(x, y, z) {
  blast.position.set(x, y, z);
  blast.scale.setScalar(0.4);
  blast.material.opacity = 0.85;
  blast.visible = true;
  blastLife = 0.34;
}

function stepBlast(dt) {
  if (blastLife <= 0) return;
  blastLife -= dt;
  blast.scale.setScalar(0.4 + (0.34 - blastLife) * 22);
  blast.material.opacity = Math.max(0, blastLife / 0.34) * 0.8;
  if (blastLife <= 0) blast.visible = false;
}

// ---- the bomb prop ----------------------------------------------------------------------------

const bombProp = new THREE.Mesh(
  new THREE.BoxGeometry(0.34, 0.2, 0.24),
  new THREE.MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.6, metalness: 0.3, emissive: 0x000000 }),
);
bombProp.visible = false;
scene.add(bombProp);

// ---- camera, HUD and the frame ----------------------------------------------------------------

let buyOpen = false;
let matchEnded = false;

function placeCamera() {
  const body = sim.player.body;
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(body.yaw);
  camera.rotateX(body.pitch + body.recoilPitch);
  camera.rotateZ(Math.sin(sim.time * 5.2) * 0.006 * Math.min(1, Math.hypot(body.velocity.x, body.velocity.z) / 6));
  // The view model sways with the walk and kicks with the recoil.
  const speed = Math.hypot(body.velocity.x, body.velocity.z);
  const bob = Math.sin(sim.time * 9.2) * 0.006 * Math.min(1, speed / 6.4);
  const sway = Math.cos(sim.time * 4.6) * 0.005 * Math.min(1, speed / 6.4);
  viewModel.position.set(0.17 + sway, -0.19 + bob - body.recoilPitch * 0.5, -0.28 + body.recoilPitch * 0.6);
  viewModel.rotation.set(-body.recoilPitch * 1.6, body.recoilYaw * 0.4, 0);
}

function syncBodies(dt) {
  for (const [actor, view] of bodies) {
    const body = actor.body;
    const alive = actor.alive;
    view.group.visible = alive || body.position.y > -50;
    if (!alive) {
      // A dead body falls over and stops.
      view.group.rotation.z += (Math.PI / 2 - view.group.rotation.z) * Math.min(1, dt * 6);
      view.group.position.set(body.position.x, Math.max(0, body.position.y), body.position.z);
      view.marker.visible = false;
      continue;
    }
    view.marker.visible = true;
    view.group.rotation.z *= 1 - Math.min(1, dt * 8);
    view.group.position.set(body.position.x, body.position.y, body.position.z);
    view.group.rotation.y = body.yaw;
    // Crouch shortens the legs and lowers the torso a little, so stance is readable at distance.
    const crouch = body.crouching ? 0.86 : 1;
    view.torso.scale.y = crouch;
    view.torso.position.y = 1.16 * crouch;
    view.head.position.y = 1.66 * crouch;
    view.legs.scale.y = crouch;
  }
}

function syncBomb() {
  const bomb = sim.match.bomb;
  if (bomb === null || !bomb.planted) { bombProp.visible = false; return; }
  bombProp.visible = true;
  bombProp.position.set(bomb.x, bomb.y + 0.12, bomb.z);
  const pulse = 0.5 + 0.5 * Math.sin(sim.time * (bomb.timer < 10 ? 18 : 7));
  bombProp.material.emissive.setRGB(pulse * 0.9, pulse * 0.15, 0);
}

function handleEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case 'shot':
        addTracer(ev.x0, ev.y0, ev.z0, ev.x1, ev.y1, ev.z1);
        if (ev.actor === sim.player) muzzle.material.opacity = 0.9;
        break;
      case 'impact':
        addSpark(ev.x, ev.y, ev.z);
        break;
      case 'hit':
        if (ev.actor === sim.player) hud.hitMarker(ev.part === 'head');
        break;
      case 'kill':
        hud.killFeed(
          ev.killer === null || ev.killer === undefined ? 'World' : ev.killer.name,
          ev.target.name,
          ev.weapon ?? '—',
          ev.headshot === true,
        );
        break;
      case 'explode':
        addBlast(ev.x, ev.y, ev.z);
        break;
      case 'planted':
        hud.banner('CHARGE PLANTED', 'defenders must defuse', 2200);
        break;
      case 'defused':
        hud.banner('CHARGE DEFUSED', 'warden holds', 2000);
        break;
      case 'live':
        hud.banner(`ROUND ${sim.match.round}`, 'live — take the site', 1400);
        break;
      case 'roundStart':
        buyOpen = false;
        hud.hideEnd();
        hud.banner(`ROUND ${sim.match.round}`, 'buy — press B', 1200);
        break;
      default:
        break;
    }
  }
}

// The buy menu: open with B during the buy window, buy with 1-5.
const buyIds = BUY_MENU.map((i) => i.id);
addEventListener('keydown', (event) => {
  if (event.code === 'KeyB') {
    buyOpen = sim.match.phase === PHASE.BUY && !buyOpen;
    hud.showBuy(buyOpen, sim.match.timer);
    return;
  }
  if (buyOpen && /^Digit[1-5]$/.test(event.code)) {
    const id = buyIds[Number(event.code.slice(5)) - 1];
    if (id !== undefined && sim.buyItem(sim.player, id)) {
      hud.highlightBuy([sim.player.weaponId, sim.player.grenade !== null ? 'frag' : null, sim.player.armor >= 100 ? 'armor' : null].filter(Boolean));
      hud.setMoney(sim.player.money);
      setTimeout(() => hud.showBuy(buyOpen, sim.match.timer), 0);
    }
  }
});

// ---- the HUD, each frame ----------------------------------------------------------------------

function updateHud(dt) {
  const p = sim.player;
  const w = WEAPONS[p.weaponId];
  hud.setVitals(p.health, p.armor);
  hud.setAmmo(p.weapon.mag, p.weapon.reserve, w.name.replace(/^[A-Z0-9-]+ /, ''));
  hud.setScore(sim.match.scoreA, sim.match.scoreB);
  hud.setMoney(p.money);
  hud.setClock(sim.match.timer, sim.match.phase === PHASE.BUY ? 'BUY' : sim.match.phase === PHASE.LIVE ? 'LIVE' : 'OVER');

  const bomb = sim.match.bomb;
  if (bomb !== null && bomb.planted) {
    hud.setObjective(`Charge ${Math.max(0, Math.ceil(bomb.timer))}s — defend`, true);
  } else if (p.team === 'A') {
    const d = Math.hypot(p.body.position.x - SITE.x, p.body.position.z - SITE.z);
    hud.setObjective(d <= SITE.r ? 'In site — press E to plant' : `Site ${Math.round(d)}m`, false);
  } else {
    hud.setObjective('Hold the site', false);
  }

  if (buyOpen) {
    hud.showBuy(sim.match.phase === PHASE.BUY, sim.match.timer);
    if (sim.match.phase !== PHASE.BUY) {
      buyOpen = false;
      hud.showBuy(false);
    }
  }

  if (sim.match.matchOver && !matchEnded) {
    matchEnded = true;
    const win = sim.match.scoreA > sim.match.scoreB;
    hud.showEnd(win ? 'RIFT TAKES THE MAP' : 'WARDEN HOLDS', `${sim.match.scoreA} — ${sim.match.scoreB}`);
  }

  hud.step(dt);
}

// ---- screenshot harness ------------------------------------------------------------------------

// A scripted input for the still frames: walk forward, swing the view slowly, fire in short bursts.
function scriptedInput(steps) {
  const keys = new Set(['KeyW']);
  let n = 0;
  return {
    state: { keys, firing: true, rightHeld: false, firedThisPress: false, pressReload: false, pressBuy: false, pressUse: false, pressSwitch: false, pressGrenade: false },
    takeLook() {
      n += 1;
      return { x: Math.sin(n / 40) * 1.4, y: Math.sin(n / 63) * 0.6 };
    },
    requestLock() {},
    release() {},
    dispose() {},
    _steps: steps,
  };
}

// A capture still is judged as a thumbnail, so each frame has to say something at 320px wide. These
// three camera setups are composed for that: a wide establishing shot that shows the map and the two
// teams, a close shot down a lane with bodies in frame, and the end card with the score.
const SHOT_DIRECTORY = {
  start: { height: 3.4, back: 9.0, pitch: -0.10, fov: 62 },
  play: { height: 1.95, back: 4.2, pitch: -0.04, fov: 68 },
  end: { height: 2.7, back: 7.0, pitch: -0.07, fov: 66 },
};

// Frame the player's own body from a fixed offset, looking along the direction that has the most
// action: the nearest living enemy, the site, or straight down the lane the player is holding.
function frameShot(mode) {
  const cfg = SHOT_DIRECTORY[mode] ?? SHOT_DIRECTORY.play;
  const me = sim.player.body.position;
  const alive = sim.actors.filter((a) => a.alive && !a.isPlayer);

  let target = null;
  let best = Infinity;
  for (const actor of alive) {
    const p = actor.body.position;
    const d = Math.hypot(p.x - me.x, p.z - me.z);
    if (d < best && d > 1.2) { best = d; target = p; }
  }
  if (target === null) target = { x: SITE.x, z: SITE.z };

  // Stand behind the player, on the far side from the target, so the body is between camera and action.
  let dx = target.x - me.x;
  let dz = target.z - me.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;

  camera.fov = cfg.fov;
  camera.updateProjectionMatrix();
  camera.position.set(me.x - dx * cfg.back, cfg.height, me.z - dz * cfg.back);
  camera.rotation.set(0, 0, 0);
  camera.lookAt(target.x, cfg.height + cfg.pitch * 6, target.z);

  // The held weapon belongs to the first-person view; a third-person still does not show it.
  viewModel.visible = false;
  muzzle.material.opacity = 0;
}

function runShot(mode) {
  const input = scriptedInput(0);
  // Enough simulation for bodies to leave spawn, meet and trade shots: 4 s of buy plus ~20 s of play.
  const frames = mode === 'start' ? 0 : mode === 'end' ? 5400 : 1500;
  for (let i = 0; i < frames; i += 1) {
    if (sim.match.phase === PHASE.BUY && sim.match.timer > 0.1 && i < 8) sim.match.timer = 0.02;
    const evs = sim.step(FIXED_STEP, input);
    handleEvents(evs);
    if (mode === 'end' && sim.match.phase === PHASE.ENDED) break;
  }
  document.getElementById('overlay').hidden = true;
  document.getElementById('brief').hidden = true;
  syncBodies(0.016);
  syncBomb();
  updateHud(0.016);

  if (mode === 'start') {
    // The title frame: overlay up, camera wide enough to read the whole map behind the panel.
    const p = sim.player.body;
    camera.fov = 74;
    camera.updateProjectionMatrix();
    camera.position.set(p.position.x - 2.0, 2.35, p.position.z + 1.5);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(p.yaw - 0.55);
    camera.rotateX(-0.015);
    viewModel.visible = false;
    document.getElementById('overlay').hidden = false;
    document.getElementById('brief').hidden = false;
  } else {
    frameShot(mode);
  }

  if (mode === 'end') {
    const p = sim.player;
    const acc = p.shotsFired > 0 ? Math.round((p.shotsHit / p.shotsFired) * 100) : 0;
    hud.showEnd('RIFT TAKES THE ROUND', 'charge detonation', {
      kicker: `ROUND ${sim.match.round} · RESOLVED`,
      a: sim.match.scoreA,
      b: sim.match.scoreB,
      kills: p.kills,
      accuracy: acc,
      money: p.money,
    });
  }

  renderer.render(scene, camera);
  document.documentElement.dataset.shotReady = mode;
}

// ---- main loop ----------------------------------------------------------------------------------

function boot() {
  if (shotMode !== null) {
    // The capture harness may inspect and re-frame the scene it just drew.
    window.__RIFTGUARD = { scene, camera, renderer, sim, THREE, hud };
    runShot(shotMode);
    window.__RIFTGUARD_READY__ = true;
    return;
  }

  const input = createInput(renderer.domElement, (locked) => {
    if (!locked) buyOpen = false, hud.showBuy(false);
  });

  const overlay = document.getElementById('overlay');
  const play = document.getElementById('play');
  play.addEventListener('click', () => {
    overlay.hidden = true;
    input.requestLock();
    hud.banner('ROUND 1', 'buy — press B', 1600);
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  addEventListener('keydown', (event) => {
    if (event.code === 'Escape') hud.showBuy(false), (buyOpen = false);
  });

  let last = performance.now();
  let acc = 0;

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;

    // Fixed-step simulation: the same step count regardless of frame rate, capped so a long stall
    // does not spiral.
    let steps = 0;
    while (acc >= FIXED_STEP && steps < 5) {
      const evs = sim.step(FIXED_STEP, input);
      handleEvents(evs);
      acc -= FIXED_STEP;
      steps += 1;
    }
    if (steps === 5) acc = 0;

    stepTracers(dt);
    stepSparks(dt);
    stepBlast(dt);
    syncBodies(dt);
    syncBomb();
    placeCamera();
    updateHud(dt);

    // Muzzle flash decays on wall-clock time, not simulation time.
    muzzle.material.opacity = Math.max(0, muzzle.material.opacity - dt * 22);
    if (sim.player.weaponId !== 'frag') {
      viewModel.visible = true;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
