// backend/applyUpdate.js — the detached self-update applier.
//
// The running configurator can't overwrite its own tree, so /api/update/apply
// COPIES this file out to <installRoot>/.update/apply.js and spawns it with
// the STAGED (new) node binary, then exits. This process waits for the old
// pid to die, swaps the install root with the staged tree (never touching
// user state), restores executable bits the zip extraction may have dropped,
// and relaunches the new version with the same environment.
//
// Run from outside the tree being replaced — never from backend/ itself.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};

const installRoot = arg('--install-root');
const staged = arg('--staged');
const oldPid = Number(arg('--old-pid'));

// User state the swap must never touch. Mirrors PRESERVED_ENTRIES in
// routes/update.js (duplicated on purpose: this file runs standalone from
// .update/, with no require() path back into the app tree).
const PRESERVE = new Set(['.env', 'data', 'helix-otel-collector.yaml', '.update']);

const log = (m) => console.log(`[apply-update ${new Date().toISOString()}] ${m}`);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!installRoot || !staged || !oldPid) throw new Error(`bad args: ${process.argv.slice(2).join(' ')}`);
  log(`waiting for old process ${oldPid} to exit`);
  for (let i = 0; i < 120 && pidAlive(oldPid); i++) await sleep(250); // ≤30s
  if (pidAlive(oldPid)) throw new Error('old process never exited; aborting (install untouched)');

  // Swap: replace every top-level entry the new package ships; leave user
  // state and anything else (user notes, logs) alone.
  for (const entry of fs.readdirSync(staged)) {
    if (PRESERVE.has(entry)) continue;
    const dest = path.join(installRoot, entry);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(staged, entry), dest, { recursive: true });
    log(`swapped ${entry}`);
  }
  // Zip extraction drops POSIX mode bits — restore them on the runtime bits.
  for (const f of ['node', 'start.sh', 'start.command']) {
    try { fs.chmodSync(path.join(installRoot, f), 0o755); } catch { /* may not exist per-platform */ }
  }

  log('relaunching the configurator');
  const child = spawn(path.join(installRoot, 'node'), [path.join(installRoot, 'backend', 'index.js')], {
    detached: true,
    stdio: 'ignore',
    cwd: installRoot,
    env: process.env, // inherited from the old process via the spawn chain — PORT etc. survive
  });
  child.unref();
  log(`launched pid ${child.pid}; updater done`);
  process.exit(0);
})().catch((e) => {
  log(`FAILED: ${e.stack || e}`);
  process.exit(1);
});
