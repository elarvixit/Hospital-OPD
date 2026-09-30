'use strict';

/*
 * npm run autopush — watch the project and auto-commit + push when files change.
 *
 * After you stop saving for a few seconds it runs the tests. If they pass, it commits
 * everything and the post-commit hook pushes to GitHub (Vercel then deploys).
 * If the tests fail, nothing is committed — fix the code and save again.
 * Stop it with Ctrl+C.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const QUIET_MS = 8000;
const IGNORE = /^(\.git|node_modules|data|\.claude|\.vercel)([\\/]|$)|(^|[\\/])\.env$|~$|\.swp$/;

const run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
// npm is a .cmd script on Windows, so it has to go through the shell (no user input involved).
const runNpmTest = () => spawnSync(process.platform === 'win32' ? 'npm.cmd test' : 'npm test', { cwd: ROOT, encoding: 'utf8', shell: true });
const time = () => new Date().toLocaleTimeString();

let timer = null;
let busy = false;
let pending = false;

function sync() {
  if (busy) { pending = true; return; }
  busy = true;
  try {
    const status = run('git', ['status', '--porcelain']).stdout.trim();
    if (!status) return;
    const files = status.split('\n').map((l) => l.slice(3).trim());

    console.log(`[${time()}] ${files.length} changed file(s) — running tests...`);
    const test = runNpmTest();
    if (test.status !== 0) {
      console.log(`[${time()}] ✖ Tests failed — NOT pushing. Fix the problem and save again.`);
      console.log((test.stdout + test.stderr).split('\n').filter((l) => /✖|not ok|Error|expected|actual/.test(l)).slice(0, 15).join('\n'));
      return;
    }

    const summary = files.slice(0, 3).map((f) => path.basename(f)).join(', ') + (files.length > 3 ? ` +${files.length - 3} more` : '');
    run('git', ['add', '-A']);
    const commit = run('git', ['commit', '-m', `Update ${summary}`]);
    console.log((commit.stdout + commit.stderr).trim());
    console.log(`[${time()}] ✔ Committed and pushed — Vercel will deploy it shortly.`);
  } finally {
    busy = false;
    if (pending) { pending = false; schedule(); }
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(sync, QUIET_MS);
}

fs.watch(ROOT, { recursive: true }, (event, file) => {
  if (!file || IGNORE.test(file)) return;
  schedule();
});

console.log(`[auto-push] Watching ${ROOT}`);
console.log('[auto-push] Save your files; changes are tested, committed and pushed after 8 s of quiet. Ctrl+C to stop.');
schedule(); // pick up anything already changed
