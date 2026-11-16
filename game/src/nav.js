// Navigation grid: a coarse occupancy map over the playfield built from the same box list the renderer
// and the collider set use, plus an A* that returns a walked path. Bots use it because pressing W at a
// waypoint walks them into the first barrel between them and it; a path that goes around the props is
// the difference between a round that resolves and a round that times out.
//
// The grid is built once (the map is static) and shared: every query is read-only.
import { BOXES, MAP_HALF } from './map.js';

const CELL = 0.5; // world units per cell
const BODY_RADIUS = 0.42; // the collision radius a path must keep clear of a solid box
const STEP_OVER = 0.45; // a box shorter than this is walked over, not around (trim, plate)

// A box blocks walking when it is tall enough to matter and low enough to be in the way: a wall, a
// crate, a barrel, the catwalk deck. Floors and ramps never block; neither does a low trim.
function blocksWalking(b) {
  if (b.role === 'floor' || b.role === 'ramp' || b.role === 'trim') return false;
  const top = b.y + b.h;
  const bottom = b.y;
  return top > STEP_OVER && bottom < 1.7;
}

const N = Math.round((MAP_HALF * 2) / CELL);

function buildGrid() {
  const blocked = new Uint8Array(N * N);
  const boxes = BOXES.filter(blocksWalking);
  for (const b of boxes) {
    const minX = b.x - b.w / 2 - BODY_RADIUS;
    const maxX = b.x + b.w / 2 + BODY_RADIUS;
    const minZ = b.z - b.d / 2 - BODY_RADIUS;
    const maxZ = b.z + b.d / 2 + BODY_RADIUS;
    let i0 = Math.ceil((minX + MAP_HALF) / CELL - 0.5);
    let i1 = Math.floor((maxX + MAP_HALF) / CELL - 0.5);
    let j0 = Math.ceil((minZ + MAP_HALF) / CELL - 0.5);
    let j1 = Math.floor((maxZ + MAP_HALF) / CELL - 0.5);
    i0 = Math.max(0, i0); j0 = Math.max(0, j0);
    i1 = Math.min(N - 1, i1); j1 = Math.min(N - 1, j1);
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) blocked[j * N + i] = 1;
    }
  }
  // Keep the outer ring walkable-off so a path never leaves the playfield.
  for (let i = 0; i < N; i += 1) {
    blocked[i] = 1; blocked[(N - 1) * N + i] = 1;
    blocked[i * N] = 1; blocked[i * N + N - 1] = 1;
  }
  return blocked;
}

const BLOCKED = buildGrid();

export function isBlockedAt(x, z) {
  const i = Math.round((x + MAP_HALF) / CELL - 0.5);
  const j = Math.round((z + MAP_HALF) / CELL - 0.5);
  if (i < 0 || j < 0 || i >= N || j >= N) return true;
  return BLOCKED[j * N + i] === 1;
}

// The nearest free cell to a world point: a spawn or a waypoint can sit a hair inside an inflated box.
function freeCell(x, z) {
  let i = Math.round((x + MAP_HALF) / CELL - 0.5);
  let j = Math.round((z + MAP_HALF) / CELL - 0.5);
  i = Math.min(N - 1, Math.max(0, i));
  j = Math.min(N - 1, Math.max(0, j));
  if (BLOCKED[j * N + i] === 0) return [i, j];
  for (let r = 1; r <= 8; r += 1) {
    for (let di = -r; di <= r; di += 1) {
      for (let dj = -r; dj <= r; dj += 1) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const ni = i + di; const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        if (BLOCKED[nj * N + ni] === 0) return [ni, nj];
      }
    }
  }
  return [i, j];
}

const toWorld = (i, j) => ({ x: (i + 0.5) * CELL - MAP_HALF, z: (j + 0.5) * CELL - MAP_HALF });

// Boxes that stop a shot at torso height, before any body-radius inflation: the real sightline test.
const SIGHT_BOXES = BOXES.filter((b) => b.role !== 'floor' && b.role !== 'trim' && b.blocks !== false && b.y + b.h > 0.9);

// Whether a straight line at waist height between two world points is clear of the map. Unlike the path
// grid this carries no body radius: it answers "could one see the other", not "could one walk it".
export function clearSight(a, b) {
  const from = { x: a.x, z: a.z };
  const to = { x: b.x, z: b.z };
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const steps = Math.max(2, Math.ceil(Math.hypot(dx, dz) / 0.25));
  for (let s = 1; s < steps; s += 1) {
    const t = s / steps;
    const x = from.x + dx * t;
    const z = from.z + dz * t;
    for (const box of SIGHT_BOXES) {
      if (x > box.x - box.w / 2 && x < box.x + box.w / 2 && z > box.z - box.d / 2 && z < box.z + box.d / 2) return false;
    }
  }
  return true;
}

// A straight line between two world points that never crosses a blocked cell (sampled at half a cell).
export function clearLine(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const steps = Math.ceil(Math.hypot(dx, dz) / (CELL * 0.5));
  for (let s = 1; s < steps; s += 1) {
    const t = s / steps;
    if (isBlockedAt(a.x + dx * t, a.z + dz * t)) return false;
  }
  return true;
}

// A* over the grid, 8-neighbour, no corner cutting. Returns a world-space path (start excluded, goal
// included, then string-pulled to the fewest points that stay clear), or [] when no route exists.
export function findPath(from, to) {
  const [si, sj] = freeCell(from.x, from.z);
  const [gi, gj] = freeCell(to.x, to.z);
  const start = sj * N + si;
  const goal = gj * N + gi;
  if (start === goal) return [toWorld(gi, gj)];

  const open = [];
  const gScore = new Float64Array(N * N).fill(Infinity);
  const fScore = new Float64Array(N * N).fill(Infinity);
  const came = new Int32Array(N * N).fill(-1);
  const closed = new Uint8Array(N * N);
  const heur = (i, j) => {
    const di = Math.abs(i - gi); const dj = Math.abs(j - gj);
    return (di + dj) + (Math.SQRT2 - 2) * Math.min(di, dj);
  };
  gScore[start] = 0;
  fScore[start] = heur(si, sj);
  open.push(start);
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  let found = false;
  let guard = 0;
  while (open.length > 0 && guard < 40000) {
    guard += 1;
    let bestAt = 0;
    for (let k = 1; k < open.length; k += 1) if (fScore[open[k]] < fScore[open[bestAt]]) bestAt = k;
    const cur = open.splice(bestAt, 1)[0];
    if (cur === goal) { found = true; break; }
    if (closed[cur] === 1) continue;
    closed[cur] = 1;
    const ci = cur % N; const cj = (cur - ci) / N;
    for (const [di, dj, cost] of NB) {
      const ni = ci + di; const nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const nIdx = nj * N + ni;
      if (BLOCKED[nIdx] === 1 || closed[nIdx] === 1) continue;
      // No corner cutting: a diagonal step needs both orthogonal neighbours free.
      if (di !== 0 && dj !== 0) {
        if (BLOCKED[cj * N + ni] === 1 || BLOCKED[nj * N + ci] === 1) continue;
      }
      const tentative = gScore[cur] + cost;
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative;
        fScore[nIdx] = tentative + heur(ni, nj);
        came[nIdx] = cur;
        open.push(nIdx);
      }
    }
  }
  if (!found) return [];

  const cells = [];
  for (let c = goal; c !== -1; c = came[c]) {
    const ci = c % N; const cj = (c - ci) / N;
    cells.push(toWorld(ci, cj));
    if (c === start) break;
  }
  cells.reverse();
  cells.shift(); // drop the start cell: the bot is standing in it

  // String-pull: keep only the points that the next leg cannot see past.
  const out = [];
  let anchor = { x: from.x, z: from.z };
  let i = 0;
  while (i < cells.length) {
    let j = cells.length - 1;
    for (; j > i; j -= 1) if (clearLine(anchor, cells[j])) break;
    out.push(cells[j]);
    anchor = cells[j];
    i = j + 1;
  }
  const last = out[out.length - 1];
  if (!last || Math.hypot(last.x - to.x, last.z - to.z) > 0.6) out.push(to);
  return out;
}

export const NAV = { CELL, N, BODY_RADIUS };
