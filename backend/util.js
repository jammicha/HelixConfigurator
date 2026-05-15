// Shared utilities used across multiple route modules. Pure functions where
// possible; the docker-dependent containerLogs is exposed as a factory so
// callers can bind it to their own Docker client.
const os = require('os');

// Demultiplex docker logs() output when the container isn't TTY-attached.
// Each multiplexed frame is: [streamType:1][padding:3][length:4_BE][payload].
const demuxLogBuffer = (buf) => {
  if (!Buffer.isBuffer(buf)) return String(buf || '');
  const out = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    if (streamType !== 0 && streamType !== 1 && streamType !== 2) {
      // Not a header — treat the whole buffer as raw text (TTY container)
      return buf.toString('utf8');
    }
    const length = buf.readUInt32BE(offset + 4);
    out.push(buf.slice(offset + 8, offset + 8 + length).toString('utf8'));
    offset += 8 + length;
  }
  if (offset < buf.length) out.push(buf.slice(offset).toString('utf8'));
  return out.join('');
};

// Factory: bind a docker instance to a containerLogs fetcher so callers
// don't have to thread the docker reference through every call.
const makeContainerLogs = (docker) => async (containerName, options = {}) => {
  const container = docker.getContainer(containerName);
  const buf = await container.logs({
    stdout: true,
    stderr: true,
    follow: false,
    timestamps: false,
    ...options,
  });
  return demuxLogBuffer(buf);
};

// Reject anything that isn't a valid Docker container name to prevent shell
// injection if a route ever reaches exec/spawn with user-controlled input.
const isValidContainerName = (name) =>
  typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name);

// OTLP receiver ports the helix sidecar (and most user collectors) listen on.
// Exposed ports for either port are taken as a "this might be a collector"
// signal independent of image name — used to catch vendor distros and
// renamed images that the image-regex misses.
const OTLP_PORTS = new Set([4317, 4318]);

const containerExposesOtlp = (container) => {
  const ports = (container && container.Ports) || [];
  for (const p of ports) {
    if (p && OTLP_PORTS.has(Number(p.PrivatePort))) return true;
  }
  return false;
};

const containerHasCollectorImage = (container) => {
  const image = (container && container.Image) || '';
  const command = (container && container.Command) || '';
  return /opentelemetry-collector/i.test(image)
      || /otelcol/i.test(image)
      || /otelcol/i.test(command);
};

// Well-known telemetry *backends* (terminal stores / visualization) that
// expose OTLP receive ports but don't act as upstream collectors. They'd
// otherwise be caught by the port-exposure signal and clutter the bridge
// list with candidates the user almost never wants — Jaeger v2, Prometheus
// (with the OTLP receiver feature), Tempo, Loki, Zipkin (otlp-bridge),
// SigNoz, ClickHouse-via-otelcol, and similar. Wiring helix-gateway as a
// downstream exporter of these doesn't generally help because they're
// terminal — they don't re-export. Skip them up front; users who do have
// the unusual "forward from Jaeger" wiring can still attach via the
// Manual tab.
const TERMINAL_BACKEND_IMAGE_PATTERNS = [
  /jaegertracing\//i,
  /grafana\/tempo/i,
  /grafana\/loki/i,
  /grafana\/mimir/i,
  /prom\/prometheus/i,
  /openzipkin\/zipkin/i,
  /signoz\//i,
];
const containerLooksLikeTerminalBackend = (container) => {
  const image = (container && container.Image) || '';
  return TERMINAL_BACKEND_IMAGE_PATTERNS.some(re => re.test(image));
};

// Classify a list of docker.listContainers() results into collector candidates.
// Combines two signals: image/command regex (catches renamed contrib builds
// and `otelcol`-invoking entrypoints) and OTLP port exposure (catches vendor
// distros — Datadog, Honeycomb, Grafana Agent — and locally-built images that
// don't carry the upstream name). Helix-managed containers and the sidecar
// itself are excluded explicitly so the caller doesn't have to remember.
// Returns one object per detected candidate:
//   { container, name, image, command, detectedVia: 'image+ports' | 'image' | 'ports' }
// Containers matching neither signal are filtered out. The helix-* exclusion
// is upfront so a container that happens to be named helix-collector can't
// slip through via the image-regex.
const detectCollectorContainers = (containers, { sidecarName, includeHelix = false } = {}) => {
  const sidecar = sidecarName || 'helix-gateway';
  const out = [];
  for (const c of containers || []) {
    const name = (c.Names && c.Names[0] && c.Names[0].replace(/^\//, '')) || '';
    if (!name) continue;
    if (name === sidecar) continue;
    if (!includeHelix && name.startsWith('helix-')) continue;
    // Known telemetry backends (Jaeger v2, Prometheus, Tempo, Loki, Zipkin,
    // ...) expose OTLP receive ports but aren't upstream collectors. Skip
    // them so the bridge list doesn't surface "attach to Jaeger" as an
    // option when the user really wants their app's collector.
    if (containerLooksLikeTerminalBackend(c)) continue;
    const byImage = containerHasCollectorImage(c);
    const byPorts = containerExposesOtlp(c);
    if (!byImage && !byPorts) continue;
    const detectedVia = byImage && byPorts ? 'image+ports' : byImage ? 'image' : 'ports';
    out.push({
      container: c,
      name,
      image: c.Image || '',
      command: c.Command || '',
      detectedVia,
    });
  }
  // Rank: dual-signal first, then image-only, then port-only. Within a band,
  // keep Docker's listing order (which is creation order).
  const rank = (v) => v === 'image+ports' ? 0 : v === 'image' ? 1 : 2;
  out.sort((a, b) => rank(a.detectedVia) - rank(b.detectedVia));
  return out;
};

class DockerTimeoutError extends Error {
  constructor(label, ms) {
    super(`Docker operation "${label}" timed out after ${ms}ms`);
    this.name = 'DockerTimeoutError';
    this.label = label;
    this.timeoutMs = ms;
  }
}

// Race a Docker promise against a timeout so a wedged daemon doesn't hang
// the Express handler for Express's default 120s. Callers should catch
// DockerTimeoutError and translate to 504 with a label-aware error payload
// (see sendDockerTimeoutResponse).
const withDockerTimeout = (promise, label, ms = 15_000) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DockerTimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// Standard 504 shape so the UI can distinguish a slow Docker socket from a
// real operational failure. Returns true if the error was a docker timeout
// (and a response was sent); false otherwise so callers can fall through to
// their normal error handling.
const sendDockerTimeoutResponse = (res, err) => {
  if (err instanceof DockerTimeoutError) {
    res.status(504).json({
      error: 'Docker socket slow or unreachable',
      op: err.label,
      timeoutMs: err.timeoutMs,
    });
    return true;
  }
  return false;
};

// Best LAN-routable IPv4 from any non-virtual interface, prioritizing
// 192.168.* over 10.* (the typical home/lab vs corp ordering).
const getLanIPv4 = () => {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    if (/docker|bridge|vbox|vmnet|utun|tun|tap|wg/i.test(name)) continue;
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }
  const priority = (ip) => /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : 2;
  candidates.sort((a, b) => priority(a.address) - priority(b.address));
  return candidates[0]?.address || null;
};

// Chained proxies (cloudflared → vite → backend) append to X-Forwarded-*
// rather than overwrite, so the value can be a comma-joined list like
// "https,http". The first entry is the outermost client-facing value.
const firstHeaderValue = (raw) => (raw ? raw.split(',')[0].trim() : null);

// Build the URL we'll embed in copyable install commands and inside the
// generated install scripts themselves. Resolution order:
//   1. INSTALL_BASE_URL env var — explicit override for any tunnel/proxy.
//   2. X-Forwarded-Host header — set by cloudflared / ngrok / reverse proxies.
//      We trust 'loopback' so this is only honored when the tunnel runs
//      locally (the typical demo setup).
//   3. LAN IP substitution — if the request came from localhost, swap in the
//      machine's LAN IPv4 so the URL works from another box on the same network.
//   4. Bare Host header — same-machine demos.
const computeInstallBaseUrl = (req) => {
  if (process.env.INSTALL_BASE_URL) {
    return process.env.INSTALL_BASE_URL.replace(/\/$/, '');
  }
  const fwdHost = firstHeaderValue(req.get('x-forwarded-host'));
  if (fwdHost) {
    const proto = firstHeaderValue(req.get('x-forwarded-proto')) || req.protocol;
    return `${proto}://${fwdHost}`;
  }
  const host = req.get('host') || 'localhost:3001';
  const lanIp = getLanIPv4();
  if (lanIp && /^(localhost|127\.0\.0\.1)(:|$)/.test(host)) {
    return `${req.protocol}://${host.replace(/^(localhost|127\.0\.0\.1)/, lanIp)}`;
  }
  return `${req.protocol}://${host}`;
};

module.exports = {
  demuxLogBuffer,
  makeContainerLogs,
  isValidContainerName,
  getLanIPv4,
  firstHeaderValue,
  computeInstallBaseUrl,
  DockerTimeoutError,
  withDockerTimeout,
  sendDockerTimeoutResponse,
  detectCollectorContainers,
  containerExposesOtlp,
  containerHasCollectorImage,
  containerLooksLikeTerminalBackend,
  OTLP_PORTS,
};
