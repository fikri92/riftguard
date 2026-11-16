// The round: one match is best-of-nine. Each round opens with a free buy window, then goes live;
// attackers plant at the site and defenders defuse, or one team is wiped out. Money is earned by
// winning, losing, planting and kills, and spent between rounds — the same loop a tactical shooter
// lives on. Everything here is deterministic given a seed, so a round replays exactly.
export const PHASE = { BUY: 'buy', LIVE: 'live', ENDED: 'ended' };

export const RULES = {
  roundsToWin: 5,
  buySeconds: 18,
  roundSeconds: 115,
  plantSeconds: 3.4,
  defuseSeconds: 6.5,
  bombSeconds: 38,
  startMoney: 800,
  maxMoney: 9000,
  winReward: 3250,
  lossReward: 1900,
  lossBonusStep: 500,
  killReward: 300,
  plantReward: 300,
  defuseReward: 300,
  teamSize: 4,
};

export function createMatch(rng) {
  return {
    rng,
    phase: PHASE.BUY,
    round: 1,
    scoreA: 0,
    scoreB: 0,
    timer: RULES.buySeconds,
    roundTime: RULES.roundSeconds,
    lossStreak: { A: 0, B: 0 },
    bomb: null,
    winner: null,
    matchOver: false,
    roundReason: null,
  };
}

// The money a team is owed for losing this round, rising with its losing streak and capped.
export function lossReward(match, team) {
  const streak = Math.min(3, match.lossStreak[team] ?? 0);
  return RULES.lossReward + streak * RULES.lossBonusStep;
}

export function createBomb(planter) {
  return {
    planted: false,
    x: 0,
    y: 0,
    z: 0,
    timer: RULES.bombSeconds,
    defuseProgress: 0,
    defusing: false,
    plantedBy: planter,
    defusedBy: null,
    exploded: false,
  };
}

// End a round for one side: set the score, pay both teams, and reset the losing streak of the winner.
export function endRound(match, winner, reason) {
  if (match.phase === PHASE.ENDED) return;
  match.phase = PHASE.ENDED;
  match.winner = winner;
  match.roundReason = reason;
  if (winner === 'A') {
    match.scoreA += 1;
    match.lossStreak.A = 0;
    match.lossStreak.B = Math.min(4, (match.lossStreak.B ?? 0) + 1);
  } else if (winner === 'B') {
    match.scoreB += 1;
    match.lossStreak.B = 0;
    match.lossStreak.A = Math.min(4, (match.lossStreak.A ?? 0) + 1);
  }
  if (match.scoreA >= RULES.roundsToWin || match.scoreB >= RULES.roundsToWin) {
    match.matchOver = true;
  }
}

// Advance the round clock, the buy window and the bomb's own fuse.
export function tickRound(match, dt, ctx) {
  if (match.phase === PHASE.ENDED || match.matchOver) return null;
  const events = [];
  if (match.phase === PHASE.BUY) {
    match.timer -= dt;
    if (match.timer <= 0) {
      match.phase = PHASE.LIVE;
      match.timer = match.roundTime;
      events.push({ type: 'live' });
    }
    return events;
  }
  match.timer -= dt;
  if (match.bomb !== null && match.bomb.planted && !match.bomb.exploded) {
    match.bomb.timer -= dt;
    if (match.bomb.timer <= 0) {
      match.bomb.exploded = true;
      events.push({ type: 'explode', bomb: match.bomb });
      endRound(match, 'A', 'bomb');
    }
  }
  if (match.timer <= 0) {
    // Time out: defenders hold the site, and the round goes to them unless the bomb is ticking.
    if (match.bomb !== null && match.bomb.planted && !match.bomb.exploded) {
      // The fuse is the clock now; the round clock runs out only after the bomb is down.
      match.timer = 0.001;
    } else {
      endRound(match, 'B', 'time');
    }
  }
  return events;
}

// Start the next round: reopen the buy window, clear the bomb, and hand every body back its health.
export function nextRound(match) {
  match.round += 1;
  match.phase = PHASE.BUY;
  match.timer = RULES.buySeconds;
  match.roundTime = RULES.roundSeconds;
  match.bomb = null;
  match.winner = null;
  match.roundReason = null;
  return match;
}

// The payout for a finished round, applied once, from the round's result.
export function payRound(match, actors, winner) {
  for (const actor of actors) {
    const won = actor.team === winner;
    let pay = won ? RULES.winReward : lossReward(match, actor.team);
    pay += actor.kills > 0 ? 0 : 0; // kill money is paid at the kill, not here
    actor.money = Math.min(RULES.maxMoney, actor.money + pay);
  }
}
