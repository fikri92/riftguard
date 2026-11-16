// The map is data first: a list of boxes with a role, a palette key and how it blocks. The renderer,
// the collider set and the bot navigation grid are all built from this one list, so the geometry the
// player walks into is exactly the geometry that is drawn.
//
// Refinery — two spawn halls joined by three lanes: a wide mid with a raised catwalk over a sunken
// trench, a tight north pipe run, and a south cargo lane. Every lane has at least two corners and one
// sightline long enough to hold an angle.

export const MAP_HALF = 26; // the playfield is 52 x 52 world units
export const WALL_H = 4.2;

// role: 'floor' | 'wall' | 'cover' | 'crate' | 'barrel' | 'catwalk' | 'ramp' | 'trim'
// blocks: true for anything the player collides with vertically or horizontally.
export const BOXES = [
  // ---- ground -------------------------------------------------------------------------------
  { role: 'floor', x: 0, z: 0, w: 52, d: 52, h: 0.4, y: 0, color: 'floor', blocks: false },

  // ---- outer shell --------------------------------------------------------------------------
  { role: 'wall', x: 0, z: -26, w: 54, d: 1.2, h: WALL_H, y: 0, color: 'wall' },
  { role: 'wall', x: 0, z: 26, w: 54, d: 1.2, h: WALL_H, y: 0, color: 'wall' },
  { role: 'wall', x: -26, z: 0, w: 1.2, d: 54, h: WALL_H, y: 0, color: 'wall' },
  { role: 'wall', x: 26, z: 0, w: 1.2, d: 54, h: WALL_H, y: 0, color: 'wall' },

  // ---- north pipe run (tight lane, z -19) ---------------------------------------------------
  { role: 'wall', x: -11, z: -15, w: 1.0, d: 12, h: WALL_H, y: 0, color: 'surface' },
  { role: 'wall', x: 11, z: -15, w: 1.0, d: 12, h: WALL_H, y: 0, color: 'surface' },
  { role: 'wall', x: -4, z: -21, w: 12, d: 1.0, h: WALL_H, y: 0, color: 'surface' },
  { role: 'wall', x: 8, z: -21, w: 8, d: 1.0, h: WALL_H, y: 0, color: 'surface' },
  { role: 'crate', x: -7.5, z: -17.5, w: 2.2, d: 2.2, h: 1.6, y: 0, color: 'crate' },
  { role: 'crate', x: -7.5, z: -17.5, w: 1.6, d: 1.6, h: 1.2, y: 1.6, color: 'crate' },
  { role: 'barrel', x: 4.5, z: -18, w: 1.1, d: 1.1, h: 1.9, y: 0, color: 'barrel' },
  { role: 'barrel', x: 6.0, z: -19.2, w: 1.1, d: 1.1, h: 1.9, y: 0, color: 'barrel' },

  // ---- mid: raised catwalk over a sunken trench ---------------------------------------------
  // The trench walls leave a lip on each side; the catwalk crosses above and is reachable by two ramps.
  { role: 'wall', x: -8, z: 0, w: 1.0, d: 18, h: 1.0, y: 0, color: 'surface' },
  { role: 'wall', x: 8, z: 0, w: 1.0, d: 18, h: 1.0, y: 0, color: 'surface' },
  { role: 'catwalk', x: 0, z: 0, w: 6.0, d: 18, h: 0.5, y: 2.6, color: 'surface', blocks: true },
  { role: 'ramp', x: -5.6, z: -6.5, w: 3.4, d: 5.0, h: 0.24, y: 0.0, color: 'trim', rampTo: 2.6 },
  { role: 'ramp', x: 5.6, z: 6.5, w: 3.4, d: 5.0, h: 0.24, y: 0.0, color: 'trim', rampTo: 2.6, flip: true },
  { role: 'cover', x: -3.4, z: 10.5, w: 2.6, d: 1.4, h: 1.1, y: 0, color: 'crate' },
  { role: 'cover', x: 3.4, z: -10.5, w: 2.6, d: 1.4, h: 1.1, y: 0, color: 'crate' },

  // ---- south cargo lane (wide, low cover, one long sightline) --------------------------------
  { role: 'wall', x: -14, z: 15, w: 1.0, d: 14, h: WALL_H, y: 0, color: 'surface' },
  { role: 'wall', x: 14, z: 15, w: 1.0, d: 14, h: WALL_H, y: 0, color: 'surface' },
  { role: 'crate', x: -18, z: 12, w: 3.0, d: 3.0, h: 2.0, y: 0, color: 'crate' },
  { role: 'crate', x: -18, z: 12, w: 2.2, d: 2.2, h: 1.6, y: 2.0, color: 'crate' },
  { role: 'crate', x: -6.5, z: 19, w: 3.4, d: 3.0, h: 2.2, y: 0, color: 'crate' },
  { role: 'crate', x: 7.0, z: 12.5, w: 3.0, d: 3.0, h: 2.0, y: 0, color: 'crate' },
  { role: 'crate', x: 17.5, z: 19.5, w: 2.6, d: 2.6, h: 1.8, y: 0, color: 'crate' },
  { role: 'barrel', x: 0.5, z: 15.5, w: 1.2, d: 1.2, h: 1.9, y: 0, color: 'barrel' },
  { role: 'barrel', x: 12.0, z: 16.5, w: 1.2, d: 1.2, h: 1.9, y: 0, color: 'barrel' },

  // ---- the two spawn halls, one at each end ------------------------------------------------
  // Each hall's inner wall is broken into segments so the three lanes actually open onto the map:
  // the doorways sit at x = -8, 0 and 8, matching the lane hints the bots route through. A wall with
  // no doorway seals a team into its spawn, and the round then can only end on the clock.
  { role: 'wall', x: -12.25, z: -13.5, w: 5.5, d: 0.6, h: 2.2, y: 0, color: 'surface' },
  { role: 'wall', x: -4, z: -13.5, w: 4.0, d: 0.6, h: 2.2, y: 0, color: 'surface' },
  { role: 'wall', x: 4, z: -13.5, w: 4.0, d: 0.6, h: 2.2, y: 0, color: 'surface' },
  { role: 'wall', x: 12.25, z: -13.5, w: 5.5, d: 0.6, h: 2.2, y: 0, color: 'surface' },
  { role: 'wall', x: -12.25, z: 13.5, w: 5.5, d: 0.6, h: 2.2, y: 0, color: 'surface' },
  { role: 'wall', x: -4, z: 13.5, w: 4.0, d: 0.6, h: 2.2, y: 0, color: 'surface' },
  { role: 'wall', x: 4, z: 13.5, w: 4.0, d: 0.6, h: 2.2, y: 0, color: 'surface' },
  { role: 'wall', x: 12.25, z: 13.5, w: 5.5, d: 0.6, h: 2.2, y: 0, color: 'surface' },
  { role: 'trim', x: 0, z: -24.5, w: 10, d: 0.4, h: 0.6, y: 0, color: 'accent', blocks: false },
  { role: 'trim', x: 0, z: 24.5, w: 10, d: 0.4, h: 0.6, y: 0, color: 'accent', blocks: false },
];

// Team A spawns south (positive z), team B north (negative z). Each list is shuffled by the round seed.
export const SPAWNS_A = [
  { x: -8, z: 22.5 }, { x: -4, z: 23.5 }, { x: 0, z: 22.5 }, { x: 4, z: 23.5 }, { x: 8, z: 22.5 },
];
export const SPAWNS_B = [
  { x: -8, z: -22.5 }, { x: -4, z: -23.5 }, { x: 0, z: -22.5 }, { x: 4, z: -23.5 }, { x: 8, z: -22.5 },
];

// The bomb site sits off mid, on the raised catwalk's east shoulder: a small square the attackers
// must reach and hold. Its centre and radius are used by the objective logic and drawn as a plate.
export const SITE = { x: 13.5, z: 2.0, r: 3.2 };
// The two attacker entry points into the site's approach, used to route bots.
export const NAV_HINTS = [
  { x: -8, z: 22.5 }, { x: 0, z: 18 }, { x: 8, z: 20 },
  { x: -8, z: 6 }, { x: 0, z: 0 }, { x: 8, z: -6 },
  { x: -6, z: -18 }, { x: 6, z: -18 },
  { x: 13.5, z: 2 }, { x: -13.5, z: -2 },
];
