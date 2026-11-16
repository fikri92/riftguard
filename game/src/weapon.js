// Weapons are data, and one function fires any of them. Each has a magazine, a reserve, a rate, a
// damage model split head/body/limb, and a spread that grows with movement and shrinks when still —
// which is what makes stopping to aim pay. Three guns and one grenade, all bought in the buy menu.
export const WEAPONS = {
  sidearm: {
    id: 'sidearm',
    name: 'K-9 Sidearm',
    slot: 'primary',
    price: 0,
    auto: false,
    magSize: 12,
    reserve: 48,
    rpm: 330,
    damage: { head: 78, body: 26, limb: 17 },
    spread: { still: 0.0022, moving: 0.021, restored: 6.0 },
    recoil: { pitch: 0.0055, yaw: 0.0022 },
    reloadSec: 1.5,
    range: 70,
    falloff: 0.72,
  },
  rifle: {
    id: 'rifle',
    name: 'AR-7 Marlin',
    slot: 'primary',
    price: 2700,
    auto: true,
    magSize: 30,
    reserve: 90,
    rpm: 640,
    damage: { head: 132, body: 34, limb: 21 },
    spread: { still: 0.0018, moving: 0.038, restored: 4.6 },
    recoil: { pitch: 0.0072, yaw: 0.0034 },
    reloadSec: 2.15,
    range: 90,
    falloff: 0.88,
  },
  smg: {
    id: 'smg',
    name: 'VX-4 Cinder',
    slot: 'primary',
    price: 1500,
    auto: true,
    magSize: 25,
    reserve: 100,
    rpm: 820,
    damage: { head: 74, body: 21, limb: 13 },
    spread: { still: 0.0034, moving: 0.026, restored: 5.4 },
    recoil: { pitch: 0.0046, yaw: 0.0042 },
    reloadSec: 1.85,
    range: 62,
    falloff: 0.7,
  },
  sniper: {
    id: 'sniper',
    name: 'LR-90 Longview',
    slot: 'primary',
    price: 4200,
    auto: false,
    magSize: 5,
    reserve: 25,
    rpm: 48,
    damage: { head: 400, body: 155, limb: 96 },
    spread: { still: 0.0004, moving: 0.075, restored: 2.2 },
    recoil: { pitch: 0.024, yaw: 0.004 },
    reloadSec: 2.9,
    range: 140,
    falloff: 1.0,
  },
  frag: {
    id: 'frag',
    name: 'Frag',
    slot: 'grenade',
    price: 300,
    throwSec: 0.62,
    radius: 6.0,
    damage: { head: 120, body: 108, limb: 72 },
    fuseSec: 1.9,
  },
};

export const BUY_MENU = [
  { id: 'armor', name: 'Kevlar', price: 650, note: 'Half the damage from every body shot while it holds.' },
  { id: 'rifle', price: 2700, note: 'Full-auto rifle. The all-round pick.' },
  { id: 'smg', price: 1500, note: 'Cheap, fast, best while moving.' },
  { id: 'sniper', price: 4200, note: 'One shot to the head; almost useless on the move.' },
  { id: 'frag', price: 300, note: 'Carry one frag; throw it with F.' },
];

// The spread in radians for a shot, from the weapon's two ends and how fast the body is travelling.
export function spreadFor(weapon, speed, airFactor) {
  const s = weapon.spread;
  const move = Math.min(1, speed / 6.4);
  const base = s.still + (s.moving - s.still) * move;
  return base * airFactor;
}

// A fresh weapon instance, one per body per round.
export function createWeaponState(id) {
  const w = WEAPONS[id];
  return {
    id,
    mag: w.magSize,
    reserve: w.reserve,
    nextShotAt: 0,
    reloadingUntil: 0,
    reloadFrom: 0,
  };
}

// Refill a state's magazine from its reserve, in whole rounds.
export function takeRounds(state, weapon, count) {
  const need = Math.min(count, weapon.magSize - state.mag);
  const given = Math.min(need, state.reserve);
  state.mag += given;
  state.reserve -= given;
  return given;
}
