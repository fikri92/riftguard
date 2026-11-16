// RIFTGUARD entry program.
//
// The game is the static tree in ./game: `index.html` loads ES modules and three.js from the vendored
// copy beside it, so the browser needs no bundler and no network. This program is the hand-in step the
// grader runs: it copies the playable tree and the dossier's stills into the output directory, then
// writes `dossier.json` with the vendored make.fun builder, which is the file the house judge reads.
//
// Locally, MAKEFUN_OUTPUT_DIR stands in for the grader's /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// The caps below come from the competition's gate, not from taste: an entry over any of them is
// refused silently, so the numbers are kept in one object and passed straight through.

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outputRoot = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// reference/gate.json, as the grader applies it.
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

const gameDir = join(repoRoot, 'game');
const stillsDir = join(repoRoot, 'screenshots');

// Refuse early with a readable line instead of handing the grader an empty folder: a missing
// index.html or a missing screenshot set is a build error here, not a silent zero later.
if (!existsSync(join(gameDir, 'index.html'))) {
  throw new Error(`no game entry point: ${join(gameDir, 'index.html')} does not exist`);
}
if (!existsSync(stillsDir)) {
  throw new Error(`no screenshots folder: ${stillsDir} does not exist`);
}

mkdirSync(join(outputRoot, 'game'), { recursive: true });
cpSync(gameDir, join(outputRoot, 'game'), { recursive: true });

mkdirSync(join(outputRoot, 'screenshots'), { recursive: true });
cpSync(stillsDir, join(outputRoot, 'screenshots'), { recursive: true });

const dossierPath = join(outputRoot, 'dossier.json');
writeFileSync(dossierPath, buildDossier(outputRoot, CAPS));

// One line of evidence for the run log: the two numbers that decide whether the judge sees a game.
const dossierBytes = statSync(dossierPath).size;
const indexBytes = statSync(join(outputRoot, 'game', 'index.html')).size;
console.log(`riftguard: game/index.html ${indexBytes} B, dossier.json ${dossierBytes} B -> ${outputRoot}`);
