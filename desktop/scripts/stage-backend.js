// Stage a production-only copy of the backend for packaging. The live
// backend/node_modules carries devDependencies (vitest and its rolldown and
// lightningcss native binaries) whose single-arch Mach-O files break the macOS
// universal merge, so the packaged app must ship production dependencies only.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');
const backendSrc = path.join(repoRoot, 'backend');
const stageDir = path.join(desktopDir, '.backend-stage');

const SKIP_TOP = new Set(['node_modules', '.git', '__tests__', '.nyc_output', 'coverage']);

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

fs.cpSync(backendSrc, stageDir, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(backendSrc, src);
    if (rel === '') return true;
    const first = rel.split(path.sep)[0];
    if (SKIP_TOP.has(first)) return false;
    if (src.endsWith('.test.js')) return false;
    return true;
  },
});

console.log('[stage-backend] installing production dependencies in the stage...');
execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: stageDir, stdio: 'inherit' });

console.log('[stage-backend] rebuilding better-sqlite3 for the Electron ABI...');
execSync(`npx @electron/rebuild -m "${stageDir}" -o better-sqlite3 -f`, { cwd: desktopDir, stdio: 'inherit' });

console.log('[stage-backend] done:', stageDir);
