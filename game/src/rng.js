// Seeded randomness in one place: the simulation never calls Math.random, so a seed replays a round
// exactly and the screenshot harness renders the same frame every run.
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // A spread in [-1, 1) without allocating.
  const signed = () => next() * 2 - 1;
  const range = (lo, hi) => lo + next() * (hi - lo);
  const pick = (list) => list[Math.floor(next() * list.length) % list.length];
  return { next, signed, range, pick };
}
