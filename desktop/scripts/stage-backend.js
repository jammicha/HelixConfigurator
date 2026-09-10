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

// better-sqlite3 is the one native module the packaged app ships. For a macOS
// universal build the .node must be a fat binary (arm64 + x86_64); a thin
// host-arch binary copied into both arch trees breaks the electron universal
// merge. better-sqlite3 publishes prebuilt binaries for the Electron runtime
// on both darwin arches, so fetch each and lipo them together. On other
// platforms a single host-arch rebuild is correct (Windows ships nsis x64).
const electronVersion = require(path.join(desktopDir, 'node_modules', 'electron', 'package.json')).version;
const bsqDir = path.join(stageDir, 'node_modules', 'better-sqlite3');
const relNode = path.join('build', 'Release', 'better_sqlite3.node');

if (process.platform === 'darwin') {
  console.log('[stage-backend] building a universal better-sqlite3 for Electron', electronVersion);

  const runPrebuildInstall = (arch) => {
    const cmd = `npx --yes prebuild-install --runtime electron --target ${electronVersion} --arch ${arch} --tag-prefix v`;
    execSync(cmd, { cwd: bsqDir, stdio: 'inherit' });
  };

  const rebuildFromSource = (arch) => {
    console.log(`[stage-backend] no prebuild for ${arch}, building from source...`);
    execSync(
      `npx @electron/rebuild -m "${stageDir}" -o better-sqlite3 -f --arch ${arch}`,
      { cwd: desktopDir, stdio: 'inherit' }
    );
  };

  const fetchArch = (arch) => {
    try {
      runPrebuildInstall(arch);
    } catch (err) {
      rebuildFromSource(arch);
    }
    const dest = path.join(stageDir, `bsq-${arch}.node`);
    fs.copyFileSync(path.join(bsqDir, relNode), dest);
    return dest;
  };

  const armNode = fetchArch('arm64');
  const x64Node = fetchArch('x64');
  execSync(`lipo -create "${armNode}" "${x64Node}" -output "${path.join(bsqDir, relNode)}"`, { stdio: 'inherit' });
  fs.rmSync(armNode, { force: true });
  fs.rmSync(x64Node, { force: true });
} else {
  console.log('[stage-backend] rebuilding better-sqlite3 for the Electron ABI (host arch)...');
  execSync(`npx @electron/rebuild -m "${stageDir}" -o better-sqlite3 -f`, { cwd: desktopDir, stdio: 'inherit' });
}

console.log('[stage-backend] done:', stageDir);
