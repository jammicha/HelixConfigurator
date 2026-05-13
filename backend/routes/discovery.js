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

  // Write `content` to `hostFilePath` (a host-side path) by spawning a
  // transient busybox container that bind-mounts the host directory and runs
  // `cat > /target/<basename>`. Needed because putArchive on the original
  // container goes through tar-extract, which calls `unlink` on existing
  // entries — and bind-mounted files inside a container cannot be unlinked
  // from inside the container. Writing via `cat >` uses O_WRONLY|O_TRUNC, which
  // works against bind mounts.
  const writeFileViaBusyboxSidecar = async (hostFilePath, content) => {
    if (typeof hostFilePath !== 'string' || !hostFilePath.startsWith('/')) {
      throw new Error(`writeFileViaBusyboxSidecar: hostFilePath must be an absolute path, got ${JSON.stringify(hostFilePath)}`);
    }
    const hostDir = path.posix.dirname(hostFilePath);
    const baseName = path.posix.basename(hostFilePath);
    if (!hostDir.startsWith('/') || !baseName) {
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
      HostConfig: { Binds: [`${hostDir}:/target`] },
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

  // Walk the container's Mounts to find the host-side source for an
  // in-container path. Returns the host path if the file (or one of its
  // ancestor dirs) is bind-mounted from the host, otherwise null. Picks the
  // most specific (deepest) matching destination so a file-level mount wins
  // over a directory-level one.
  const resolveHostMountPath = (inspect, inContainerPath) => {
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
    return best.rel ? path.posix.join(best.source, best.rel) : best.source;
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
    const newBlock = [
      `${ci}${exporterName}:`,
      `${ci2}endpoint: http://helix-gateway:4318`,
      `${ci2}tls:`,
      `${ci3}insecure: true`,
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

  const isRecognizedCollectorContainer = async (name) => {
    const containers = await docker.listContainers();
    return containers.some(c => {
      const cName = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
      if (cName !== name) return false;
      const image = c.Image || '';
      const command = c.Command || '';
      return /opentelemetry-collector/i.test(image) || /otelcol/i.test(image) || /otelcol/i.test(command);
    });
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
    try {
      const containers = await docker.listContainers();
      const sidecarNetworks = await (async () => {
        try {
          const inspected = await docker.getContainer(sidecarName).inspect();
          return Object.keys((inspected.NetworkSettings && inspected.NetworkSettings.Networks) || {});
        } catch { return []; }
      })();
      const sidecarNetSet = new Set(sidecarNetworks);
      const candidates = containers
        .map(c => {
          const name = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
          const image = c.Image || '';
          const command = c.Command || '';
          return { c, name, image, command };
        })
        .filter(({ name, image, command }) => {
          if (name === sidecarName) return false;
          const looksLikeCollector =
            /opentelemetry-collector/i.test(image) ||
            /otelcol/i.test(image) ||
            /otelcol/i.test(command);
          return looksLikeCollector;
        })
        .map(({ c, name, image }) => {
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
          return { name, image, networks, sharesNetworkWithSidecar, isKubernetes };
        });
      res.json({ sidecar: sidecarName, sidecarNetworks, collectors: candidates });
    } catch (e) {
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
      const inspect = await container.inspect();
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
      const inspect = await container.inspect();
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
      if (hostConfigPath && hostConfigPath.startsWith('/')) {
        // Bind-mounted config: write via busybox sidecar mounting the host
        // directory, so we don't trigger an unlink on the in-container path.
        console.log(`[smart-add] apply on ${name}: writing via busybox sidecar (bind-mounted at ${hostConfigPath})`);
        await writeFileViaBusyboxSidecar(`${hostConfigPath}.helix-bak`, configText);
        await writeFileViaBusyboxSidecar(hostConfigPath, proposal.proposedYaml);
      } else {
        // Image-baked config (no host bind-mount): putArchive writes into the
        // container's writable overlay and works as-is.
        console.log(`[smart-add] apply on ${name}: writing via putArchive (no resolvable host path)`);
        await writeFileToContainer(container, backupPath, configText);
        await writeFileToContainer(container, configPath, proposal.proposedYaml);
      }
      await container.restart();
      console.log(`[smart-add] apply on ${name}: applied ${proposal.exporterName} into ${proposal.addedToPipelines.join(', ')}; container restarted`);
      res.json({
        success: true,
        configPath,
        backupPath,
        exporterName: proposal.exporterName,
        addedToPipelines: proposal.addedToPipelines,
      });
    } catch (e) {
      console.error(`[smart-add] apply on ${name} failed:`, e);
      res.status(500).json({ error: 'Failed to apply collector config', details: e.message });
    }
  });
}

module.exports = { register };
