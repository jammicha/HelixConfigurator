// backend/preflight.js
// Startup port-ownership check.
//
// Why this exists: index.js used to call app.listen(port) with no host, so
// Node bound `::` dual-stack. When another process already held the IPv4
// wildcard on the same port (a stale Docker Desktop port proxy left behind by
// a previous compose run), Node's bind quietly succeeded on the IPv6 side
// ONLY, with no EADDRINUSE and no warning. The browser still worked, because
// macOS resolves localhost to ::1 first. The gateway did not, because
// host.docker.internal resolves to an IPv4 address, so every viewer fan-out
// export landed on the dead proxy and came back as a bare EOF.
//
// This module classifies that state and produces a message that names it.
// It never exits the process: a degraded bind is loud, not fatal.

const DEFAULT_TIMEOUT_MS = 1500;

// Probe one address family. Returns 'self', 'foreign' or 'unreachable'.
const probeStack = async (url, instanceId, { fetchImpl, timeoutMs }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal });
  } catch {
    return 'unreachable'; // refused, dropped mid-request, or timed out
  } finally {
    clearTimeout(timer);
  }
  if (!res || res.ok === false) return 'foreign';
  try {
    const body = await res.json();
    return body && body.instanceId === instanceId ? 'self' : 'foreign';
  } catch {
    return 'foreign'; // answered on our port, but it is not our API
  }
};

const FAN_OUT_CONSEQUENCE =
  'The gateway reaches the configurator over IPv4 via host.docker.internal, so '
  + 'the local viewer fan-out will fail and the View OTel Data page will stay empty. '
  + 'Delivery to your Helix tenant is unaffected.';

const DOCKER_REMEDIATION =
  'Usually a stale Docker Desktop port proxy from a previous `docker compose up` of '
  + 'the configurator stack, still holding the port with no container behind it. '
  + 'Check with `lsof -nP -iTCP:%PORT% -sTCP:LISTEN`. Clear it by running '
  + '`docker compose down --remove-orphans` in the configurator directory, or by '
  + 'restarting Docker Desktop, then restart the configurator. '
  + 'If a different application owns the port, set PORT in .env to a free port instead.';

const classifyPortOwnership = async ({
  port,
  instanceId,
  ipv4Bound,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const opts = { fetchImpl, timeoutMs };
  const ipv4 = await probeStack(`http://127.0.0.1:${port}/api/health`, instanceId, opts);
  const ipv6 = await probeStack(`http://[::1]:${port}/api/health`, instanceId, opts);
  const remediation = DOCKER_REMEDIATION.replaceAll('%PORT%', String(port));

  // A successful bind of the IPv4 wildcard IS ownership: nobody else can hold
  // it at the same time. The probes are corroborating detail for the report,
  // never an override, so a blocked loopback probe cannot be misread as a
  // squatter.
  if (ipv4Bound) {
    return { verdict: 'healthy', ipv4, ipv6, message: '', remediation: '' };
  }
  if (ipv4 === 'unreachable') {
    return {
      verdict: 'ipv4-unreachable',
      ipv4,
      ipv6,
      message:
        `Another process owns IPv4 port ${port}. It accepts connections and then closes them `
        + `without responding. ${FAN_OUT_CONSEQUENCE}`,
      remediation,
    };
  }
  return {
    verdict: 'ipv4-foreign',
    ipv4,
    ipv6,
    message:
      `Another process owns IPv4 port ${port} and is answering on it. `
      + `This configurator is reachable over IPv6 only. ${FAN_OUT_CONSEQUENCE}`,
    remediation,
  };
};

const reportPortOwnership = (verdict, { log = console } = {}) => {
  if (!verdict || verdict.verdict === 'healthy') return;
  log.warn(
    `\n  Local viewer fan-out will not work.\n`
    + `  ${verdict.message}\n\n`
    + `  ${verdict.remediation}\n`,
  );
};

module.exports = { classifyPortOwnership, reportPortOwnership };
