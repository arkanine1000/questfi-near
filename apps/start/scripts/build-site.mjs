#!/usr/bin/env node
// Builds the whole site into apps/start/dist: the start app at /, Agent World
// at /world/ and the island at /island/. Served from one origin, the three
// apps share the visitor's test account, which lives in the browser's storage.
//
//   VITE_CONTRACT_ID=<contract> VITE_GAME_URL=<game server> npm run build:site
//
// Settings not given get the values that fit this layout. The other two apps'
// dependencies are installed from their lockfiles first, every time: a build
// host may restore an older node_modules from its cache. Pass --no-install
// to reuse what is installed.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const start = fileURLToPath(new URL('..', import.meta.url));
const sibling = (name) => fileURLToPath(new URL(`../../${name}/`, import.meta.url));

const env = { ...process.env };
env.VITE_WORLD_URL ??= './world/?nointro&alt=9000000';
env.VITE_ISLAND_URL ??= '../island';
env.VITE_LOBBY_URL ??= 'https://lobby.questfi.ai';
env.VITE_GUEST_API ??= '/api/guest';
// the island calls the game server by its own setting
if (env.VITE_GAME_URL) env.VITE_BACKEND_URL ??= env.VITE_GAME_URL;

function run(command, cwd) {
  console.log(`\n> ${command}   (in ${cwd})`);
  execSync(command, { cwd, env, stdio: 'inherit' });
}

run('npx vite build', start);
for (const [name, base] of [['world', './'], ['island', '/island/']]) {
  const dir = sibling(name);
  if (!process.argv.includes('--no-install')) run('npm ci --no-audit --no-fund', dir);
  run(`npx vite build --base=${base} --outDir "${start}dist/${name}" --emptyOutDir`, dir);
}
console.log('\nsite built in apps/start/dist: / (start), /world/, /island/');
