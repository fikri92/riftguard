# RIFTGUARD

[![best-game-01](https://make.fun/badge/best-game-01.svg)](https://make.fun/bounty/best-game-01)
[![rank](https://make.fun/badge/best-game-01/fikri92/riftguard/rank.svg)](https://make.fun/bounty/best-game-01)
[![reward](https://make.fun/badge/best-game-01/fikri92/riftguard/reward.svg)](https://make.fun/bounty/best-game-01)

A 4v4 tactical bomb-defusal shooter that runs in the browser from static files: three.js for the scene,
plain ES modules for the simulation, no build step, no network calls, no assets to download.

One refinery at dusk, two spawn halls, three lanes. Attackers carry a charge to the site and hold a
3.4 s plant; defenders hold the lanes and defuse in 6.5 s. First side to five rounds takes the match.
Money is earned by winning, losing, planting and killing, and spent in an 18 s buy window — the loop a
tactical shooter lives on.

## What is in the box

| Path | What it holds |
|---|---|
| `game/index.html` | the entry point: HUD, overlay, import map, canvas |
| `game/src/sim.js` | the whole simulation: movement, shots, damage, bomb, money, score. No DOM, no `performance.now()`, fixed 60 Hz |
| `game/src/nav.js` | navigation grid and A* built from the same box list the renderer draws |
| `game/src/bot.js` | bot behaviour: routes, contact, plant, defuse, hold |
| `game/src/world.js` | the map's meshes, colliders and lighting, all from `map.js`'s one box list |
| `game/src/round.js` | round phases, timer, economy, win conditions |
| `tools/simnode.mjs` | whole matches in plain Node, no browser (~15 s per match) |
| `tools/simtest.mjs`, `tools/play.mjs` | the same matches driven in-page through CDP, with real input events |
| `tools/hero2.mjs`, `tools/stills.mjs` | the screenshot harness that produced the dossier's stills |

## Controls

`W A S D` move · mouse look · `LMB` fire · `RMB` aim · `R` reload · `Ctrl` crouch · `Space` jump ·
`B` buy · `F` frag · `Q` swap weapon · `E` plant / defuse.

## Run it

```bash
node serve.js . 8080     # then open http://localhost:8080
```

No install, no bundler: the page loads ES modules directly and three.js from `game/vendor/`.

## Verify it

```bash
node tools/simnode.mjs --seeds 1,2,3     # whole matches headless, prints the round log
node tools/simtest.mjs --seeds 3         # the same match driven in-page, plus a replay check
node tools/hero2.mjs                     # capture the dossier stills
MAKEFUN_OUTPUT_DIR=out node main.ts      # build the dossier the judge reads
```

## Built for

[make.fun](https://make.fun/bounty/best-game-01) · competition `best-game-01` · entry by
[fikri92](https://github.com/fikri92).

MIT licensed. See `LICENSE`.
