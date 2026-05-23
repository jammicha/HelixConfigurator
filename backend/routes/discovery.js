// Smart-add (Step 2 of the onboarding wizard) lives here: enumerate OTel
// collector containers on this host, read their config, propose a merge that
// wires helix-gateway in as an exporter, and (on confirm) write the new
// config back with a .helix-bak. The customer's collector then restarts to
// pick up the change.
//
// POC scope: targets the *first* --config= path discovered in the
// container's command line. Doesn't merge across multiple --config= overlays.
// dump() loses YAML comments — the original is preserved as a backup.
const path = require('path');
const yaml = require('js-yaml');
const tarStream = require('tar-stream');
const { withDockerTimeout, sendDockerTimeoutResponse, detectCollectorContainers } = require('../util');
const errorLog = require('../errorLog');

function register(app, { docker }) {
  // -- Helpers ---------------------------------------------------------------

  const readFileFromContainer = (container, filePath) => new Promise(async (resolve, reject) => {
    try {
      const archiveStream = await container.getArchive({ path: filePath });
      const extract = tarStream.extract();
      let content = '';
      extract.on('entry', (header, stream, next) => {
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => {
          content = Buffer.concat(chunks).toString('utf8');
          next();
        });
        stream.resume();
      });
      extract.on('finish', () => resolve(content));
      extract.on('error', reject);
      archiveStream.pipe(extract);
    } catch (e) { reject(e); }
  });

  const writeFileToContainer = async (container, filePath, content) => {
    const dir = path.posix.dirname(filePath);
    const fileName = path.posix.basename(filePath);
    const pack = tarStream.pack();
    pack.entry({ name: fileName, mode: 0o644 }, content);
    pack.finalize();
    await container.putArchive(pack, { path: dir });
  };

  // Absolute host path? Accept POSIX (/foo), Windows drive-letter (C:\foo or
  // C:/foo), and UNC (\\server\share). resolveHostMountPath returns whatever
  // Docker reported as Mounts[].Source, which is platform-shaped — on Docker
  // Desktop for Windows that's typically a backslashed drive-letter path.
  const isAbsoluteHostPath = (p) =>
    typeof p === 'string' &&
    (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\'));

  // Split an absolute host path into { dir, base } using the right path
  // semantics for its platform shape.
  const splitHostPath = (p) => {
    if (p.startsWith('/')) {
      return { dir: path.posix.dirname(p), base: path.posix.basename(p) };
    }
    return { dir: path.win32.dirname(p), base: path.win32.basename(p) };
  };

  // Write `content` to `hostFilePath` (a host-side path) by spawning a
  // transient busybox container that bind-mounts the host directory and runs
  // `cat > /target/<basename>`. Needed because putArchive on the original
  // container goes through tar-extract, which calls `unlink` on existing
  // entries — and bind-mounted files inside a container cannot be unlinked
  // from inside the container. Writing via `cat >` uses O_WRONLY|O_TRUNC, which
  // works against bind mounts.
  //
  // Cross-platform: the source path is passed via HostConfig.Mounts (the
  // structured form) instead of HostConfig.Binds (`<src>:<dst>`) so Windows
  // drive-letter paths like `C:\Users\...` don't collide with the
  // colon-separator parsing.
  const writeFileViaBusyboxSidecar = async (hostFilePath, content) => {
    if (!isAbsoluteHostPath(hostFilePath)) {
      throw new Error(`writeFileViaBusyboxSidecar: hostFilePath must be an absolute host path (POSIX, Windows drive-letter, or UNC), got ${JSON.stringify(hostFilePath)}`);
    }
    const { dir: hostDir, base: baseName } = splitHostPath(hostFilePath);
    if (!hostDir || !baseName) {
      throw new Error(`writeFileViaBusyboxSidecar: could not derive a bind mount from ${hostFilePath} (dir=${hostDir}, base=${baseName})`);
    }
    // Pull busybox if not cached locally. Subsequent calls are no-ops.
    try {
      await docker.getImage('busybox:latest').inspect();
    } catch {
      await new Promise((resolve, reject) => {
        docker.pull('busybox:latest', (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
        });
      });
    }
    const quoted = baseName.replace(/'/g, `'\\''`);
    const container = await docker.createContainer({
      Image: 'busybox:latest',
      Cmd: ['sh', '-c', `cat > '/target/${quoted}'`],
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      Tty: false,
      HostConfig: {
        Mounts: [{ Type: 'bind', Source: hostDir, Target: '/target' }],
      },
    });
    try {
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });
      await container.start();
      stream.end(content);
      const result = await container.wait();
      if (result.StatusCode !== 0) {
        throw new Error(`busybox sidecar write exited with code ${result.StatusCode}`);
      }
    } finally {
      try { await container.remove({ force: true }); } catch { /* may already be gone */ }
    }
  };

  // Returns an ordered list of candidate in-container paths for the collector
  // config. The endpoint tries each until one yields parseable
  // receivers:/service: YAML — that's what makes smart-add robust against
  // collectors that don't pass --config explicitly, run from a non-default
  // image, or use a bind mount at an unusual location.
  const detectCollectorConfigPaths = (inspect) => {
    const candidates = [];
    const seen = new Set();
    const add = (p) => {
      if (typeof p !== 'string' || !p) return;
      const clean = p.replace(/^file:/, '');
      if (seen.has(clean)) return;
      seen.add(clean);
      candidates.push(clean);
    };

    // 1. Explicit --config flag, anywhere in Cmd/Args.
    const all = [...((inspect.Config && inspect.Config.Cmd) || []), ...(inspect.Args || [])];
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (typeof a !== 'string') continue;
      if (a.startsWith('--config=')) add(a.substring('--config='.length));
      else if (a === '--config' && i + 1 < all.length) add(String(all[i + 1]));
    }

    // 2. Bind-mounted YAML destinations — these are almost always the config.
    //    Sort by descending length so file-level mounts take precedence over
    //    parent directory mounts (matches resolveHostMountPath's bias).
    const mounts = (inspect.Mounts || []).slice().sort((a, b) => (b.Destination || '').length - (a.Destination || '').length);
    for (const m of mounts) {
      if (m.Type !== 'bind' || !m.Destination) continue;
      if (/\.ya?ml$/i.test(m.Destination)) add(m.Destination);
    }

    // 3. Common defaults across the otel-collector image family. Order: the
    //    contrib image's default first (most common in the wild), then the
    //    upstream non-contrib default, then frequently-seen custom locations.
    add('/etc/otelcol-contrib/config.yaml');
    add('/etc/otelcol/config.yaml');
    add('/etc/otel-collector/config.yaml');
    add('/conf/otel-collector-config.yaml');
    add('/etc/opentelemetry-collector/config.yaml');

    return candidates;
  };

  // Reject in-container paths that could escape their bind mount via `..` or
  // NUL bytes. The in-container path comes from `--config=` args or Mounts[]
  // Destinations — both attacker-controllable in a malicious compose. Without
  // this guard, a `--config=/etc/otel/../../passwd` would resolve to /passwd
  // on the host after path.posix.join.
  const isSafeInContainerPath = (p) =>
    typeof p === 'string' &&
    p.length > 0 &&
    !p.includes('\0') &&
    !p.split('/').some(seg => seg === '..');

  // After resolution, ensure the host path is still under the bind mount's
  // declared Source — i.e. that no `..` slipped through join() to escape the
  // mount. Compares normalized paths in POSIX semantics (Windows host paths
  // hit a separate code path).
  const isHostPathUnderSource = (hostPath, source) => {
    if (!hostPath || !source) return false;
    if (!hostPath.startsWith('/') || !source.startsWith('/')) {
      // Non-POSIX (Windows drive-letter / UNC) — busybox sidecar will refuse
      // anyway since busybox runs Linux; let the existing isAbsoluteHostPath
      // gate handle these.
      return true;
    }
    const normH = path.posix.normalize(hostPath);
    const normS = path.posix.normalize(source);
    return normH === normS || normH.startsWith(normS + '/');
  };

  // Walk the container's Mounts to find the host-side source for an
  // in-container path. Returns the host path if the file (or one of its
  // ancestor dirs) is bind-mounted from the host, otherwise null. Picks the
  // most specific (deepest) matching destination so a file-level mount wins
  // over a directory-level one. Rejects paths that try to escape via `..`
  // segments so smart-add can't be coerced into writing outside the
  // collector's declared mount.
  const resolveHostMountPath = (inspect, inContainerPath) => {
    if (!isSafeInContainerPath(inContainerPath)) return null;
    const mounts = (inspect && inspect.Mounts) || [];
    let best = null;
    for (const m of mounts) {
      if (m.Type !== 'bind' || !m.Source || !m.Destination) continue;
      const dest = m.Destination;
      if (inContainerPath === dest) {
        if (!best || dest.length >= best.dest.length) best = { dest, source: m.Source, rel: '' };
        continue;
      }
      const destWithSlash = dest.endsWith('/') ? dest : dest + '/';
      if (inContainerPath.startsWith(destWithSlash)) {
        const rel = inContainerPath.substring(destWithSlash.length);
        if (!best || dest.length > best.dest.length) best = { dest, source: m.Source, rel };
      }
    }
    if (!best) return null;
    const hostPath = best.rel ? path.posix.join(best.source, best.rel) : best.source;
    if (!isHostPathUnderSource(hostPath, best.source)) return null;
    return hostPath;
  };

  // Indent helpers used by the text-level patcher below.
  const indentOf = (line) => {
    const m = line.match(/^( *)/);
    return m ? m[1].length : 0;
  };
  const isStructural = (line) => !(/^\s*$/.test(line) || /^\s*#/.test(line));
  const escapeRe = (s) => s.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');

  // Find the line index of `key` at exact column 0. Returns -1 if not found.
  const findRootKey = (lines, key) => {
    const re = new RegExp(`^${escapeRe(key)}\\s*:`);
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i;
    return -1;
  };

  // Find a child key `key` directly under the block headed at `parentIdx`
  // (parent is at indent `parentCol`). Children are the first structural lines
  // after parentIdx whose indent is consistent and strictly greater than parent.
  const findChildKey = (lines, parentIdx, parentCol, key) => {
    let childCol = -1;
    for (let i = parentIdx + 1; i < lines.length; i++) {
      if (!isStructural(lines[i])) continue;
      const ind = indentOf(lines[i]);
      if (ind <= parentCol) break;
      if (childCol < 0) childCol = ind;
      if (ind !== childCol) continue;
      if (new RegExp(`^ {${childCol}}${escapeRe(key)}\\s*:`).test(lines[i])) return i;
    }
    return -1;
  };

  // First structural line index past blockHeader at indent ≤ parentCol, or EOF.
  const findBlockEnd = (lines, parentIdx, parentCol) => {
    for (let i = parentIdx + 1; i < lines.length; i++) {
      if (!isStructural(lines[i])) continue;
      if (indentOf(lines[i]) <= parentCol) return i;
    }
    return lines.length;
  };

  // Patch the original YAML text to (a) append the new exporter under the root
  // `exporters:` block and (b) wire it into the named pipelines' exporters
  // lists. Preserves comments, quote styles, flow-vs-block sequence style, and
  // blank lines because the edit is done at the text level, not via load/dump.
  // Throws when the structure isn't supported (multi-doc, missing exporters
  // section, multi-line flow lists, etc.) so callers can fall back gracefully.
  const patchCollectorYaml = (text, plan) => {
    const lines = text.split('\n');
    const { exporterName, addedToPipelines } = plan;

    // --- 1. Wire exporterName into each named pipeline's `exporters:` list.
    const serviceIdx = findRootKey(lines, 'service');
    if (serviceIdx < 0) throw new Error('No `service:` section found');
    const serviceCol = 0;
    const pipelinesIdx = findChildKey(lines, serviceIdx, serviceCol, 'pipelines');
    if (pipelinesIdx < 0) throw new Error('No `service.pipelines:` section found');
    const pipelinesCol = indentOf(lines[pipelinesIdx]);

    // Pipelines are processed back-to-front so earlier insertions don't shift
    // later lookups out from under us.
    const pipelinesByLine = addedToPipelines
      .map((pname) => ({ pname, line: findChildKey(lines, pipelinesIdx, pipelinesCol, pname) }))
      .filter((p) => p.line >= 0)
      .sort((a, b) => b.line - a.line);

    for (const { pname, line: pIdx } of pipelinesByLine) {
      const pCol = indentOf(lines[pIdx]);
      const expIdx = findChildKey(lines, pIdx, pCol, 'exporters');
      if (expIdx < 0) throw new Error(`Pipeline "${pname}" has no exporters key`);
      const expLine = lines[expIdx];

      // Flow style: `exporters: [a, b, c]` on one line.
      const flow = expLine.match(/^(\s*exporters\s*:\s*)\[(.*)\](\s*(?:#.*)?)$/);
      if (flow) {
        const [, prefix, inside, suffix] = flow;
        const trimmed = inside.trim();
        const next = trimmed ? `${trimmed}, ${exporterName}` : exporterName;
        lines[expIdx] = `${prefix}[${next}]${suffix}`;
        continue;
      }
      // Multi-line flow (`exporters: [\n  a,\n  b\n]`) — not supported.
      if (/^\s*exporters\s*:\s*\[\s*(?:#.*)?$/.test(expLine)) {
        throw new Error(`Pipeline "${pname}" uses multi-line flow exporters — not supported`);
      }

      // Block style. Find the first list child (`- item`); append after the last
      // structural child of the block.
      const expCol = indentOf(expLine);
      let firstChild = -1;
      for (let i = expIdx + 1; i < lines.length; i++) {
        if (!isStructural(lines[i])) continue;
        if (indentOf(lines[i]) <= expCol) break;
        firstChild = i; break;
      }
      if (firstChild < 0) {
        lines.splice(expIdx + 1, 0, `${' '.repeat(expCol + 2)}- ${exporterName}`);
        continue;
      }
      const childCol = indentOf(lines[firstChild]);
      const blockEnd = findBlockEnd(lines, expIdx, expCol);
      let lastStructural = blockEnd - 1;
      while (lastStructural > expIdx && !isStructural(lines[lastStructural])) lastStructural--;
      lines.splice(lastStructural + 1, 0, `${' '.repeat(childCol)}- ${exporterName}`);
    }

    // --- 2. Append the new exporter definition under root `exporters:`.
    const exportersIdx = findRootKey(lines, 'exporters');
    if (exportersIdx < 0) throw new Error('No root `exporters:` section found');
    const exportersBlockEnd = findBlockEnd(lines, exportersIdx, 0);
    // Find child indent — default to 2 if the block is empty.
    let childCol = 2;
    for (let i = exportersIdx + 1; i < exportersBlockEnd; i++) {
      if (!isStructural(lines[i])) continue;
      childCol = indentOf(lines[i]);
      break;
    }
    const ci = ' '.repeat(childCol);
    const ci2 = ' '.repeat(childCol + 2);
    const ci3 = ' '.repeat(childCol + 4);
    // sending_queue mirrors the helix-gateway shipped exporter: 100 parallel
    // HTTP workers + 10k queue absorb bursts so the customer's collector
    // doesn't drop telemetry under sustained load.
    const newBlock = [
      `${ci}${exporterName}:`,
      `${ci2}endpoint: http://helix-gateway:4318`,
      `${ci2}tls:`,
      `${ci3}insecure: true`,
      `${ci2}sending_queue:`,
      `${ci3}enabled: true`,
      `${ci3}num_consumers: 100`,
      `${ci3}queue_size: 10000`,
    ];
    // Insert after the last structural line inside the exporters block (so we
    // don't push it past a trailing comment that belongs to the next section).
    let insertAfter = exportersBlockEnd - 1;
    while (insertAfter > exportersIdx && !isStructural(lines[insertAfter])) insertAfter--;
    lines.splice(insertAfter + 1, 0, ...newBlock);

    return lines.join('\n');
  };

  const proposeCollectorMerge = (yamlText) => {
    const parsed = yaml.load(yamlText);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Could not parse collector YAML');
    }
    const exporters = parsed.exporters || {};

    // Already pointing at helix-gateway:4318? Skip.
    for (const [name, def] of Object.entries(exporters)) {
      if (def && typeof def === 'object' && /helix-gateway:4318/.test(def.endpoint || '')) {
        return { alreadyConfigured: true, existingExporterName: name };
      }
    }

    // Pick a non-colliding exporter name. Common case: customer has no
    // helix_sidecar exporter, so we land on the canonical name.
    const baseName = 'otlphttp/helix_sidecar';
    let exporterName = baseName;
    let n = 2;
    while (exporters[exporterName]) {
      exporterName = `${baseName}_${n++}`;
    }

    // Plan: which pipelines need the new exporter wired in. Computed off the
    // parsed object; the actual text edits happen via patchCollectorYaml below.
    const pipelines = (parsed.service && parsed.service.pipelines) || {};
    const addedToPipelines = [];
    for (const [pname, pipeline] of Object.entries(pipelines)) {
      if (!pipeline || typeof pipeline !== 'object') continue;
      const existing = Array.isArray(pipeline.exporters) ? pipeline.exporters : [];
      if (!existing.includes(exporterName)) addedToPipelines.push(pname);
    }

    const proposedYaml = patchCollectorYaml(yamlText, { exporterName, addedToPipelines });
    return {
      alreadyConfigured: false,
      exporterName,
      addedToPipelines,
      existingExporters: Object.keys(exporters),
      existingPipelines: Object.keys(pipelines),
      proposedYaml,
    };
  };

  // Short-lived cache for the collectors-discovery GET. Smart-add polls this
  // on every Step 2 refresh; a host with 50+ containers spends 50-200ms in
  // docker.listContainers() each time. 60s TTL is well short of any
  // meaningful container churn the user might do mid-wizard, and ?refresh=1
  // lets the UI's manual refresh bypass it.
  let collectorsCache = { ts: 0, payload: null };
  const COLLECTORS_CACHE_TTL_MS = 60_000;

  // Authorization gate for collector-mutating routes: only act on containers
  // the detector recognizes. Goes through the same image+ports signal as the
  // listing endpoint so a smart-add target that shows up in the UI also
  // passes the apply check, no matter which signal originally surfaced it.
  //
  // Uses { all: true } so the recognition check survives a container in the
  // brief exited→running gap of a restart cycle. Without this, smart-add's
  // post-apply re-fetch of the proposal (which fires when the just-applied
  // collector container is still restarting) returns a spurious 403 "not a
  // recognized OTel collector" — looks like the user typed a bad name, when
  // really we just hit the restart window. The image/ports signals don't
  // depend on running state, so widening the listing is safe; downstream
  // container.inspect / resolveCollectorConfig still fail cleanly if the
  // container truly doesn't exist.
  const isRecognizedCollectorContainer = async (name) => {
    const sidecarName = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
    const containers = await withDockerTimeout(docker.listContainers({ all: true }), 'docker.listContainers');
    return detectCollectorContainers(containers, { sidecarName }).some(d => d.name === name);
  };

  // Try each candidate config path in order and return the first one that
  // reads AND looks like a collector config (`receivers:` + `service:` at
  // column 0). Returns null when none work, plus a structured `attempts` log
  // so the endpoint can surface which paths it tried.
  const resolveCollectorConfig = async (container, inspect) => {
    const candidates = detectCollectorConfigPaths(inspect);
    const attempts = [];
    for (const candidate of candidates) {
      try {
        const text = await readFileFromContainer(container, candidate);
        // Validate the shape — without this, an unrelated YAML mounted at one
        // of our default paths would be accepted and patched, which would
        // corrupt the container.
        if (/^receivers:/m.test(text) && /^service:/m.test(text)) {
          return { configPath: candidate, configText: text, attempts };
        }
        attempts.push({ path: candidate, reason: 'not a collector config (missing receivers: and/or service:)' });
      } catch (e) {
        attempts.push({ path: candidate, reason: e.message || 'read failed' });
      }
    }
    return { configPath: null, configText: null, attempts };
  };

  // -- Routes ----------------------------------------------------------------

  // GET candidate OTel collectors running on this host. Used by Step 2
  // onboarding to surface a "we found a collector — here's how to plug it in"
  // path, instead of asking the user to choose between YAML and env-var
  // instrumentation blind. Heuristic: image name contains opentelemetry-collector
  // or otelcol, or the command line invokes otelcol. The sidecar itself
  // (helix-gateway) is excluded.
  app.get('/api/discovery/collectors', async (req, res) => {
    const sidecarName = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
    const forceRefresh = req.query.refresh === '1';
    if (!forceRefresh && collectorsCache.payload && (Date.now() - collectorsCache.ts) < COLLECTORS_CACHE_TTL_MS) {
      return res.json({ ...collectorsCache.payload, cached: true });
    }
    try {
      const containers = await withDockerTimeout(docker.listContainers(), 'docker.listContainers');
      const sidecarNetworks = await (async () => {
        try {
          const inspected = await withDockerTimeout(docker.getContainer(sidecarName).inspect(), 'container.inspect', 5_000);
          return Object.keys((inspected.NetworkSettings && inspected.NetworkSettings.Networks) || {});
        } catch { return []; }
      })();
      const sidecarNetSet = new Set(sidecarNetworks);
      const detected = detectCollectorContainers(containers, { sidecarName });
      const candidates = detected.map(({ container: c, name, image, detectedVia }) => {
        const networks = Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {})
          .filter(n => n !== 'host' && n !== 'none' && n !== 'ingress');
        const sharesNetworkWithSidecar = networks.some(n => sidecarNetSet.has(n));
        // K8s containers carry well-known kubelet labels. Detect via labels
        // first (most reliable) then fall back to image / command hints.
        const labels = c.Labels || {};
        const isKubernetes =
          Object.keys(labels).some(k => k.startsWith('io.kubernetes.')) ||
          /\b(kubelet|k8s|kubernetes)\b/i.test(image) ||
          /\b(kubelet|k8s|kubernetes)\b/i.test(c.Command || '');
        return { name, image, networks, sharesNetworkWithSidecar, isKubernetes, detectedVia };
      });
      const payload = { sidecar: sidecarName, sidecarNetworks, collectors: candidates };
      collectorsCache = { ts: Date.now(), payload };
      res.json(payload);
    } catch (e) {
      if (sendDockerTimeoutResponse(res, e)) return;
      res.status(500).json({ error: 'Failed to scan for collectors', details: e.message });
    }
  });

  // GET the customer collector's current config + the proposed merge.
  app.get('/api/discovery/collector-config/:name', async (req, res) => {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid container name' });
    }
    if (!(await isRecognizedCollectorContainer(name))) {
      return res.status(403).json({ error: `Container "${name}" is not a recognized OTel collector` });
    }
    try {
      const container = docker.getContainer(name);
      const inspect = await withDockerTimeout(container.inspect(), 'container.inspect');
      const { configPath, configText, attempts } = await resolveCollectorConfig(container, inspect);
      if (!configPath) {
        return res.status(404).json({
          error: 'Could not locate a collector config inside the container',
          details: `Tried ${attempts.length} candidate path(s); none returned valid OTel collector YAML. Common reasons: the container reads its config from env (--config=env:...) instead of a file, or the config lives at an unexpected path. Apply the snippet below manually.`,
          attempts,
        });
      }
      const hostConfigPath = resolveHostMountPath(inspect, configPath);
      const proposal = proposeCollectorMerge(configText);
      res.json({ name, configPath, hostConfigPath, configText, ...proposal });
    } catch (e) {
      if (sendDockerTimeoutResponse(res, e)) return;
      res.status(500).json({ error: 'Failed to read collector config', details: e.message });
    }
  });

  // POST — apply the merge: write a .helix-bak, write the new config, restart.
  app.post('/api/discovery/collector-apply/:name', async (req, res) => {
    const name = req.params.name;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid container name' });
    }
    if (!(await isRecognizedCollectorContainer(name))) {
      return res.status(403).json({ error: `Container "${name}" is not a recognized OTel collector` });
    }
    try {
      const container = docker.getContainer(name);
      const inspect = await withDockerTimeout(container.inspect(), 'container.inspect');
      const { configPath, configText, attempts } = await resolveCollectorConfig(container, inspect);
      if (!configPath) {
        console.log(`[smart-add] apply on ${name}: no config found, tried ${attempts.length} paths`);
        return res.status(404).json({
          error: 'Could not locate a collector config inside the container',
          details: 'Apply the snippet below manually.',
          attempts,
        });
      }
      const hostConfigPath = resolveHostMountPath(inspect, configPath);
      console.log(`[smart-add] apply on ${name}: configPath=${configPath}, hostConfigPath=${hostConfigPath || '<image-baked>'}`);
      const proposal = proposeCollectorMerge(configText);
      if (proposal.alreadyConfigured) {
        console.log(`[smart-add] apply on ${name}: already configured via ${proposal.existingExporterName}, no-op`);
        return res.json({
          success: true,
          alreadyConfigured: true,
          existingExporterName: proposal.existingExporterName,
          configPath,
        });
      }
      const backupPath = `${configPath}.helix-bak`;
      if (isAbsoluteHostPath(hostConfigPath)) {
        // Bind-mounted config: write via busybox sidecar mounting the host
        // directory, so we don't trigger an unlink on the in-container path.
        // The .helix-bak backup is computed in the host path's native
        // semantics so it ends up alongside the original on disk.
        const { dir: hostDir, base: hostBase } = splitHostPath(hostConfigPath);
        const hostBackup = hostConfigPath.startsWith('/')
          ? path.posix.join(hostDir, `${hostBase}.helix-bak`)
          : path.win32.join(hostDir, `${hostBase}.helix-bak`);
        console.log(`[smart-add] apply on ${name}: writing via busybox sidecar (bind-mounted at ${hostConfigPath})`);
        await writeFileViaBusyboxSidecar(hostBackup, configText);
        await writeFileViaBusyboxSidecar(hostConfigPath, proposal.proposedYaml);
      } else {
        // Image-baked config (no host bind-mount): putArchive writes into the
        // container's writable overlay and works as-is.
        console.log(`[smart-add] apply on ${name}: writing via putArchive (no resolvable host path)`);
        await writeFileToContainer(container, backupPath, configText);
        await writeFileToContainer(container, configPath, proposal.proposedYaml);
      }
      // Defer the restart when the gateway isn't yet on a network this
      // collector can reach. Restarting now would boot the collector with
      // the new helix_sidecar exporter, fail DNS for helix-gateway, and
      // Go's resolver would negative-cache that failure for 5–30s — the
      // tester then completes Step 3, attaches the gateway to the network,
      // but the collector keeps trying with stale DNS until the cache
      // entry expires. The frontend triggers the restart via /api/
      // lifecycle/restart-container right after Step 3's bridge succeeds.
      const gwName = process.env.TARGET_CONTAINER_NAME || 'helix-gateway';
      let restarted = false;
      try {
        const gwInspect = await withDockerTimeout(docker.getContainer(gwName).inspect(), 'container.inspect', 5_000);
        const gwNetworks = new Set(Object.keys(gwInspect.NetworkSettings?.Networks || {}));
        const targetNetworks = Object.keys(inspect.NetworkSettings?.Networks || {});
        const sharesNetwork = targetNetworks.some(n => gwNetworks.has(n));
        if (sharesNetwork) {
          await withDockerTimeout(container.restart(), 'container.restart');
          restarted = true;
          console.log(`[smart-add] apply on ${name}: applied ${proposal.exporterName} into ${proposal.addedToPipelines.join(', ')}; container restarted`);
        } else {
          console.log(`[smart-add] apply on ${name}: applied ${proposal.exporterName} into ${proposal.addedToPipelines.join(', ')}; restart deferred (no shared network with ${gwName})`);
        }
      } catch (e) {
        // Couldn't determine whether networks overlap — fall back to today's
        // behavior and restart immediately.
        console.warn(`[smart-add] apply on ${name}: shared-network check failed (${e.message}); restarting anyway`);
        try {
          await withDockerTimeout(container.restart(), 'container.restart');
          restarted = true;
        } catch { /* upstream catch will surface */ }
      }
      // Mutating the collector population — bust the discovery cache so the
      // next /api/discovery/collectors call sees the just-applied changes
      // (e.g. updated networks once Step 3 bridges).
      collectorsCache = { ts: 0, payload: null };
      res.json({
        success: true,
        configPath,
        backupPath,
        exporterName: proposal.exporterName,
        addedToPipelines: proposal.addedToPipelines,
        containerName: name,
        restarted,
        restartDeferred: !restarted,
      });
    } catch (e) {
      console.error(`[smart-add] apply on ${name} failed:`, e);
      errorLog.push('smart-add.apply', `${name}: ${e.message}`);
      if (sendDockerTimeoutResponse(res, e)) return;
      res.status(500).json({ error: 'Failed to apply collector config', details: e.message });
    }
  });
}

module.exports = { register };
