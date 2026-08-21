# Local Viewer Fan-out Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gateway's local viewer fan-out endpoint derived and verified instead of hardcoded and assumed, and make any remaining failure diagnosable in one click.

**Architecture:** A new pure module owns the fan-out endpoint and its fallback candidates. The yaml rewrite becomes bidirectional and parameterized so the native and Docker deployment paths stop corrupting each other's config file. The backend binds IPv4 and IPv6 explicitly so a port squatter raises a real error instead of a silent split-brain, and a startup preflight names the squatter. A round-trip canary injects a uniquely-tagged span into the gateway and waits for it to come back through the fan-out, which both drives a fallback ladder at config-write time and backs a one-click diagnostic verdict.

**Tech Stack:** Node 20 CommonJS backend, Express 5, vitest 4, dockerode, axios, better-sqlite3. React 19 + TypeScript frontend, vitest.

## Global Constraints

- Backend modules are CommonJS (`require` / `module.exports`). Do not convert files to ESM.
- Tests are vitest. The repo convention is `backend/__tests__/<kebab-case-name>.test.mjs`, where 33 of the 35 existing suites live. Do NOT colocate new tests beside the module; the two colocated `.test.js` files are legacy.
- Test files use **named ESM imports** from the CJS module, matching `backend/__tests__/collector-fanout.test.mjs`: `import { fn } from '../module.js';`
- Run backend tests with `npm --prefix backend test` from the repo root, or `npx vitest run __tests__/<file>.test.mjs` from `backend/`.
- Every new module must be pure and injectable where it can be: pass `fetchImpl`, `axiosImpl`, `sleep`, and `docker` as options with real defaults, so tests need no network and no Docker.
- Do not enable `sending_queue` or `retry_on_failure` on `otlphttp/helix_local_viewer`. This is an explicit non-goal in the spec.
- Do not make the process refuse to start or auto-select a different port. Degraded states warn loudly and keep running.
- Branch is `viewer-fanout-resilience`, already created off `main`. Commit after every task.
- Work happens in an isolated worktree at `.worktrees/viewer-fanout-resilience`, checked out on the branch with a clean baseline: backend 381 tests in 35 files, frontend 107 tests in 9 files, all passing. **Stage only the files each task names.** Never use `git add -A` or `git commit -a`.

**Spec:** `docs/superpowers/specs/2026-08-21-viewer-fanout-resilience-design.md`

---

### Task 1: Fan-out endpoint module

The endpoint the gateway ships to is currently the literal `host.docker.internal:8765` in `collectorFanout.js`. It ignores `PORT`, so any user who relocates the UI gets a permanently dead viewer. This task makes it derived.

**Files:**
- Create: `backend/viewerEndpoint.js`
- Test: `backend/__tests__/viewer-endpoint.test.mjs`
- Read for context: `backend/portConfig.js`

**Interfaces:**
- Consumes: `resolvePort(env)` from `backend/portConfig.js`
- Produces:
  - `viewerCandidates({ env, containerized, bridgeIp }) -> string[]` (ordered, best first, no trailing slash)
  - `preferredViewerEndpoint({ env, containerized, bridgeIp }) -> string`
  - `CONTAINER_ENDPOINT` constant, the string `'http://helix-configurator:3001'`

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/viewer-endpoint.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { viewerCandidates, preferredViewerEndpoint, CONTAINER_ENDPOINT } from '../viewerEndpoint.js';

describe('viewerCandidates', () => {
  it('defaults to host.docker.internal on the default port', () => {
    expect(viewerCandidates({ env: {} })).toEqual(['http://host.docker.internal:8765']);
  });

  it('honours a PORT override so a relocated UI still receives fan-out', () => {
    expect(viewerCandidates({ env: { PORT: '9100' } }))
      .toEqual(['http://host.docker.internal:9100']);
  });

  it('appends the bridge gateway IP as a fallback when one is known', () => {
    expect(viewerCandidates({ env: {}, bridgeIp: '172.18.0.1' })).toEqual([
      'http://host.docker.internal:8765',
      'http://172.18.0.1:8765',
    ]);
  });

  it('uses the compose service name when the configurator is containerized', () => {
    expect(viewerCandidates({ env: { PORT: '3001' }, containerized: true }))
      .toEqual([CONTAINER_ENDPOINT]);
  });

  it('ignores a bridge IP in the containerized path', () => {
    expect(viewerCandidates({ env: {}, containerized: true, bridgeIp: '172.18.0.1' }))
      .toEqual([CONTAINER_ENDPOINT]);
  });

  it('preferredViewerEndpoint returns the first candidate', () => {
    expect(preferredViewerEndpoint({ env: {}, bridgeIp: '172.18.0.1' }))
      .toBe('http://host.docker.internal:8765');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/viewer-endpoint.test.mjs` from `backend/`
Expected: FAIL, cannot resolve `./viewerEndpoint.js`

- [ ] **Step 3: Write minimal implementation**

Create `backend/viewerEndpoint.js`:

```js
// backend/viewerEndpoint.js
// Single source of truth for "what URL should the gateway ship the local
// viewer fan-out to". This used to be a hardcoded literal in
// collectorFanout.js which ignored PORT and was never verified, so a user
// who relocated the UI got a permanently dead View OTel Data page.
// Pure functions only: no I/O, no docker, no env mutation.
const { resolvePort } = require('./portConfig');

// In-container path: the configurator shares the helix-bridge network with
// the gateway, so the compose service name resolves and the internal port is
// fixed at 3001 regardless of the published host port.
const CONTAINER_ENDPOINT = 'http://helix-configurator:3001';

// Ordered list of endpoints to try, best first. Native installs run the
// configurator as a host process, so the gateway has to cross the container
// boundary: host.docker.internal on Docker Desktop, with the bridge gateway
// IP as a fallback for Linux Docker Engine where that name can fail to
// resolve even with the injected ExtraHosts mapping.
function viewerCandidates({ env = process.env, containerized = false, bridgeIp = null } = {}) {
  if (containerized) return [CONTAINER_ENDPOINT];
  const port = resolvePort(env);
  const candidates = [`http://host.docker.internal:${port}`];
  if (bridgeIp) candidates.push(`http://${bridgeIp}:${port}`);
  return candidates;
}

function preferredViewerEndpoint(opts = {}) {
  return viewerCandidates(opts)[0];
}

module.exports = { viewerCandidates, preferredViewerEndpoint, CONTAINER_ENDPOINT };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/viewer-endpoint.test.mjs` from `backend/`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add backend/viewerEndpoint.js backend/__tests__/viewer-endpoint.test.mjs
git commit -m "feat(viewer): derive the fan-out endpoint from PORT instead of hardcoding it"
```

---

### Task 2: Bidirectional, parameterized yaml rewrite

`rewriteLocalViewerToHost` only rewrites container-to-host. Nothing rewrites back, so once the native path runs, the yaml is stuck pointing at `host.docker.internal` even when the configurator is later run in Docker. That is how the two deployment modes sabotage each other through a shared file.

**Files:**
- Modify: `backend/collectorFanout.js` (whole file)
- Rewrite: `backend/__tests__/collector-fanout.test.mjs`. **This suite already exists** and its 6 tests all call `rewriteLocalViewerToHost`, which this task deletes. Replace its contents wholesale with the tests below. Leaving it in place breaks the suite.
- Modify: `backend/routes/lifecycle.js:16` (import) and `backend/routes/lifecycle.js:53` (call site)

**Interfaces:**
- Consumes: `preferredViewerEndpoint` from Task 1
- Produces: `rewriteLocalViewerEndpoint(yamlString, target) -> string`. `target` is an origin like `http://host.docker.internal:8765` with no path and no trailing slash. `VIEWER_EXPORTER_KEY` stays exported. `rewriteLocalViewerToHost` and `LOCAL_VIEWER_HOST` are **removed**.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `backend/__tests__/collector-fanout.test.mjs` with:

```js
import { describe, it, expect } from 'vitest';
import { rewriteLocalViewerEndpoint } from '../collectorFanout.js';

const CONTAINER_YAML = `exporters:
  otlphttp/bmchelix:
    endpoint: \${env:HELIX_ENDPOINT}
  # keep this comment
  otlphttp/helix_local_viewer:
    traces_endpoint: http://helix-configurator:3001/api/otlp/traces
    logs_endpoint: http://helix-configurator:3001/api/otlp/logs
    metrics_endpoint: http://helix-configurator:3001/api/otlp/metrics
    encoding: json
  otlphttp/user_added:
    traces_endpoint: http://my-own-collector:4318/v1/traces
`;

describe('rewriteLocalViewerEndpoint', () => {
  it('rewrites only the viewer block to the given target, preserving paths', () => {
    const out = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:9100');
    expect(out).toContain('traces_endpoint: http://host.docker.internal:9100/api/otlp/traces');
    expect(out).toContain('logs_endpoint: http://host.docker.internal:9100/api/otlp/logs');
    expect(out).toContain('metrics_endpoint: http://host.docker.internal:9100/api/otlp/metrics');
  });

  it('leaves a user-added exporter using the same endpoint form untouched', () => {
    const out = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:8765');
    expect(out).toContain('traces_endpoint: http://my-own-collector:4318/v1/traces');
  });

  it('preserves comments and formatting', () => {
    const out = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:8765');
    expect(out).toContain('# keep this comment');
    expect(out).toContain('encoding: json');
  });

  it('round-trips: container to host to container returns the original bytes', () => {
    const toHost = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:8765');
    const back = rewriteLocalViewerEndpoint(toHost, 'http://helix-configurator:3001');
    expect(back).toBe(CONTAINER_YAML);
  });

  it('strips a trailing slash from the target', () => {
    const out = rewriteLocalViewerEndpoint(CONTAINER_YAML, 'http://host.docker.internal:8765/');
    expect(out).toContain('traces_endpoint: http://host.docker.internal:8765/api/otlp/traces');
    expect(out).not.toContain('8765//api');
  });

  it('returns non-string input unchanged', () => {
    expect(rewriteLocalViewerEndpoint(null, 'http://x:1')).toBe(null);
  });

  it('throws when the target is missing or empty', () => {
    expect(() => rewriteLocalViewerEndpoint(CONTAINER_YAML, '')).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/collector-fanout.test.mjs` from `backend/`
Expected: FAIL, `rewriteLocalViewerEndpoint is not a function`

- [ ] **Step 3: Write minimal implementation**

Replace the whole of `backend/collectorFanout.js` with:

```js
// backend/collectorFanout.js
// Shared rewrite: point the local-viewer exporter at wherever the configurator
// is actually reachable from inside the gateway container. Used by BOTH the
// native-Docker gateway path (configurator on the host, gateway in a
// container) and the K8s local-cluster path. Callers pass YAML text in/out.
//
// The target is a parameter, not a constant. It used to be a hardcoded
// host.docker.internal:8765 with no inverse, which meant a PORT override
// silently killed the viewer and a native run left the yaml stuck in host
// mode forever. See viewerEndpoint.js for where targets come from.

const VIEWER_EXPORTER_KEY = 'otlphttp/helix_local_viewer';

// Surgically rewrite ONLY the local-viewer exporter's endpoint hosts,
// preserving comments/formatting (this rewrites the user's on-disk collector
// yaml in place, so we must not clobber their config).
// Scoped line-by-line to the `otlphttp/helix_local_viewer:` block: an earlier
// global regex rewrote per-signal `*_endpoint:` keys in ANY exporter, silently
// redirecting user-added exporters that used that (legal) otlphttp form.
function rewriteLocalViewerEndpoint(yamlString, target) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('rewriteLocalViewerEndpoint: target must be a non-empty URL string');
  }
  if (typeof yamlString !== 'string') return yamlString;
  const base = target.replace(/\/+$/, '');
  const viewerKeyRe = /^(\s*)otlphttp\/helix_local_viewer:\s*(#.*)?$/;
  const endpointRe = /\b(traces_endpoint|logs_endpoint|metrics_endpoint):(\s*)https?:\/\/[^/\s]+/;
  const lines = yamlString.split('\n');
  let viewerIndent = -1; // -1 = not inside the viewer block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = line.match(viewerKeyRe);
    if (key) { viewerIndent = key[1].length; continue; }
    if (viewerIndent < 0) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue; // blanks/comments don't end a YAML block
    if (line.match(/^(\s*)/)[1].length <= viewerIndent) { viewerIndent = -1; continue; } // dedent -> block over
    lines[i] = line.replace(endpointRe, (_m, k, ws) => `${k}:${ws}${base}`);
  }
  return lines.join('\n');
}

module.exports = { rewriteLocalViewerEndpoint, VIEWER_EXPORTER_KEY };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/collector-fanout.test.mjs` from `backend/`
Expected: PASS, 7 tests

- [ ] **Step 5: Update the one existing call site**

In `backend/routes/lifecycle.js`, change the import on line 16 from:

```js
const { rewriteLocalViewerToHost } = require('../collectorFanout');
```

to:

```js
const { rewriteLocalViewerEndpoint } = require('../collectorFanout');
const { preferredViewerEndpoint } = require('../viewerEndpoint');
```

Then in `createGatewayFromScratch`, change the rewrite line (currently `await fsp.writeFile(tmp, rewriteLocalViewerToHost(current));`) to:

```js
    const target = preferredViewerEndpoint({ containerized: IS_CONTAINERIZED });
    await fsp.writeFile(tmp, rewriteLocalViewerEndpoint(current, target));
```

`IS_CONTAINERIZED` is already imported at the top of `lifecycle.js` from `../util`.

- [ ] **Step 6: Verify nothing else references the removed names**

Run: `grep -rn "rewriteLocalViewerToHost\|LOCAL_VIEWER_HOST" --include="*.js" . | grep -v node_modules`
Expected: no output

- [ ] **Step 7: Run the full backend suite**

Run: `npm --prefix backend test` from the repo root
Expected: PASS, no regressions

- [ ] **Step 8: Commit**

```bash
git add backend/collectorFanout.js backend/__tests__/collector-fanout.test.mjs backend/routes/lifecycle.js
git commit -m "feat(viewer): make the fan-out yaml rewrite bidirectional and parameterized"
```

---

### Task 3: Instance identity and port-ownership classification

To tell "the port answers, and it is us" from "the port answers, and it is somebody else", the health endpoint needs a per-process identity. This task adds it and the pure classifier that consumes it. Wiring into startup is Task 4.

**Files:**
- Modify: `backend/index.js:57-59` (the `/api/health` handler)
- Create: `backend/preflight.js`
- Create: `backend/__tests__/preflight.test.mjs`

**Interfaces:**
- Produces:
  - `INSTANCE_ID` exported from `backend/index.js` is **not** needed by other modules; it is passed in as an argument. Do not export it.
  - `classifyPortOwnership({ port, instanceId, ipv4Bound, fetchImpl, timeoutMs }) -> Promise<Verdict>`
  - `Verdict` is `{ verdict, ipv4, ipv6, message, remediation }` where `verdict` is one of `'healthy' | 'ipv4-foreign' | 'ipv4-unreachable'`, and `ipv4` / `ipv6` are each one of `'self' | 'foreign' | 'unreachable'`.
  - `reportPortOwnership(verdict, { log = console }) -> void`

- [ ] **Step 1: Add the instance id to the health payload**

In `backend/index.js`, just below the `const VERSION = require('./package.json').version;` line, add:

```js
// Per-process identity. The startup preflight probes our own port on both IP
// stacks and compares this value, which is the only reliable way to tell
// "the port answers and it is us" from "the port answers and it is a stale
// Docker port proxy".
const INSTANCE_ID = require('node:crypto').randomUUID();
```

Then change the health handler to include it:

```js
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: VERSION, demoInstall: false, instanceId: INSTANCE_ID });
});
```

This is an additive change to a documented public response shape. Existing consumers reading `ok` and `version` are unaffected.

- [ ] **Step 2: Write the failing test**

Create `backend/__tests__/preflight.test.mjs`:

```js
import { describe, it, expect, vi } from 'vitest';
import { classifyPortOwnership, reportPortOwnership } from '../preflight.js';

const ID = 'instance-under-test';

// Build a fetch stub that answers per-host. `answers` maps a substring of the
// URL to either a response-like object or the string 'reject'.
const stubFetch = (answers) => vi.fn(async (url) => {
  for (const [needle, answer] of Object.entries(answers)) {
    if (String(url).includes(needle)) {
      if (answer === 'reject') throw new Error('socket hang up');
      return answer;
    }
  }
  throw new Error('unexpected url ' + url);
});

const jsonOk = (body) => ({ ok: true, json: async () => body });

describe('classifyPortOwnership', () => {
  it('reports healthy when both stacks answer with our own instance id', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': jsonOk({ ok: true, instanceId: ID }),
      '[::1]': jsonOk({ ok: true, instanceId: ID }),
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: true, fetchImpl });
    expect(v.verdict).toBe('healthy');
    expect(v.ipv4).toBe('self');
    expect(v.ipv6).toBe('self');
  });

  it('names a foreign listener when the IPv4 bind was refused and IPv4 answers as someone else', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': jsonOk({ ok: true, instanceId: 'someone-else' }),
      '[::1]': jsonOk({ ok: true, instanceId: ID }),
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: false, fetchImpl });
    expect(v.verdict).toBe('ipv4-foreign');
    expect(v.ipv4).toBe('foreign');
    expect(v.message).toContain('8765');
    expect(v.remediation).toContain('Docker');
  });

  it('detects the stale-proxy fingerprint: IPv4 bind refused and IPv4 connections dropped', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': 'reject',
      '[::1]': jsonOk({ ok: true, instanceId: ID }),
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: false, fetchImpl });
    expect(v.verdict).toBe('ipv4-unreachable');
    expect(v.ipv4).toBe('unreachable');
    expect(v.message).toContain('accepts connections');
    expect(v.remediation).toContain('Docker');
  });

  it('treats a non-JSON response on our port as a foreign listener', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': { ok: true, json: async () => { throw new Error('not json'); } },
      '[::1]': jsonOk({ ok: true, instanceId: ID }),
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: false, fetchImpl });
    expect(v.ipv4).toBe('foreign');
  });

  it('trusts a successful IPv4 bind even when the loopback probe is blocked', async () => {
    const fetchImpl = stubFetch({ '127.0.0.1': 'reject', '[::1]': 'reject' });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: true, fetchImpl });
    expect(v.verdict).toBe('healthy');
  });

  it('stays healthy on an IPv6-less host where only IPv4 bound and answers', async () => {
    const fetchImpl = stubFetch({
      '127.0.0.1': jsonOk({ ok: true, instanceId: ID }),
      '[::1]': 'reject',
    });
    const v = await classifyPortOwnership({ port: 8765, instanceId: ID, ipv4Bound: true, fetchImpl });
    expect(v.verdict).toBe('healthy');
    expect(v.ipv6).toBe('unreachable');
  });
});

describe('reportPortOwnership', () => {
  it('prints nothing when healthy', () => {
    const log = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    reportPortOwnership({ verdict: 'healthy', message: '', remediation: '' }, { log });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('warns with both the message and the remediation when degraded', () => {
    const log = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    reportPortOwnership(
      { verdict: 'ipv4-unreachable', message: 'MSG', remediation: 'FIX' },
      { log },
    );
    const printed = log.warn.mock.calls.flat().join('\n');
    expect(printed).toContain('MSG');
    expect(printed).toContain('FIX');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run __tests__/preflight.test.mjs` from `backend/`
Expected: FAIL, cannot resolve `./preflight.js`

- [ ] **Step 4: Write minimal implementation**

Create `backend/preflight.js`:

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/preflight.test.mjs` from `backend/`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add backend/preflight.js backend/__tests__/preflight.test.mjs backend/index.js
git commit -m "feat(preflight): classify port ownership across both IP stacks"
```

---

### Task 4: Explicit dual-stack bind

The implicit `app.listen(port)` is what let the split-brain form in silence. Binding each family explicitly turns it into a real, catchable `EADDRINUSE`.

**Files:**
- Modify: `backend/index.js:111-140` (the listen block and the shutdown handler)

**Interfaces:**
- Consumes: `classifyPortOwnership`, `reportPortOwnership` from Task 3
- Produces: nothing importable. This is wiring.

- [ ] **Step 1: Add the import**

At the top of `backend/index.js`, beside the other requires, add:

```js
const { classifyPortOwnership, reportPortOwnership } = require('./preflight');
```

- [ ] **Step 2: Replace the listen block**

Replace everything from `const server = app.listen(port, () => {` through the closing of the `server.on('error', ...)` handler with:

```js
// Bind each address family explicitly. A single app.listen(port) binds `::`
// dual-stack, and when another process already holds the IPv4 wildcard the
// bind silently degrades to IPv6-only with no error at all. That is invisible
// in the browser (localhost resolves to ::1 first) and fatal to the gateway's
// viewer fan-out (host.docker.internal is IPv4). Two explicit listeners turn
// that into a real EADDRINUSE we can see and explain.
const listenOn = (opts) => new Promise((resolve, reject) => {
  const s = app.listen(opts);
  s.once('listening', () => resolve(s));
  s.once('error', reject);
});

const servers = [];
let ipv4Bound = false;

const start = async () => {
  // IPv6 first, and ipv6Only so it cannot claim the v4 wildcard implicitly.
  try {
    servers.push(await listenOn({ port, host: '::', ipv6Only: true }));
  } catch (e) {
    // A host with no IPv6 at all is fine; we fall through to the v4 bind.
    if (e.code !== 'EADDRINUSE' && e.code !== 'EAFNOSUPPORT' && e.code !== 'EADDRNOTAVAIL') throw e;
  }

  try {
    servers.push(await listenOn({ port, host: '0.0.0.0' }));
    ipv4Bound = true;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }

  if (servers.length === 0) {
    console.error(`\nPort ${port} is in use. Set PORT in .env to a free port and relaunch.\n`);
    process.exit(1);
  }

  console.log(`Backend listening at http://localhost:${port}`);
  console.log(`Helix Ingest Endpoint: ${process.env.HELIX_ENDPOINT || 'NOT CONFIGURED'}`);

  // Non-fatal, and deliberately after the listening log so the URL is the
  // first thing a user sees. Failures here must never block startup.
  try {
    reportPortOwnership(await classifyPortOwnership({ port, instanceId: INSTANCE_ID, ipv4Bound }));
  } catch (e) {
    console.warn('Port preflight skipped:', e.message);
  }
};

start().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
```

- [ ] **Step 3: Update the shutdown handler to close both listeners**

In the `shutdown` function, replace the single `server.close(...)` call with:

```js
  Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))))
    .then(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
```

Leave the 5 second force-exit timer exactly as it is.

- [ ] **Step 4: Verify the server still starts and serves both stacks**

Run from `backend/`: `node index.js` in one shell, then in another:

```bash
curl -s -6 "http://[::1]:8765/api/health"; echo; curl -s -4 "http://127.0.0.1:8765/api/health"
```

Expected: both return JSON containing `"ok":true` and the **same** `instanceId`. No preflight warning is printed. Stop the server with Ctrl-C and confirm it prints `HTTP server closed.` and exits without hanging.

- [ ] **Step 5: Verify the degraded path is detected**

With the configurator stopped, occupy IPv4 only, then start the configurator:

```bash
python3 -c "import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('0.0.0.0',8765)); s.listen(1); time.sleep(120)" &
```

Then run `node index.js` from `backend/`.
Expected: it still starts, still serves on `[::1]`, and prints the "Local viewer fan-out will not work" warning naming port 8765 and the Docker remediation. Kill the python process afterwards.

- [ ] **Step 6: Run the full backend suite**

Run: `npm --prefix backend test` from the repo root
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/index.js
git commit -m "fix(server): bind IPv4 and IPv6 explicitly so a port squatter is not silent"
```

---

### Task 5: Round-trip viewer canary

A shell probe inside the gateway is impossible: `otel/opentelemetry-collector-contrib` ships without `/bin/sh`. Verified with `docker run --rm --entrypoint /bin/sh otel/opentelemetry-collector-contrib:0.119.0 -c echo`, which fails with `stat /bin/sh: no such file or directory`. So the gateway proves reachability with its own exporter instead, which is a stronger signal anyway.

**Files:**
- Create: `backend/viewerCanary.js`
- Create: `backend/__tests__/viewer-canary.test.mjs`
- Read for context: `backend/routes/diagnostics.js:606-645` (the existing `inject-trace` payload shape), `backend/otelStore.js:1408` (`getTrace` returns `null` or `{ summary, spans }`)

**Interfaces:**
- Consumes: `resolveGatewayOtlpBase` from `backend/util.js`, an `OtelStore` instance
- Produces:
  - `runViewerCanary({ otelStore, otlpBase, timeoutMs, pollIntervalMs, axiosImpl, sleep, traceId }) -> Promise<Result>`
  - `Result` is `{ verdict, traceId, detail, remediation, elapsedMs }` where `verdict` is one of `'ok' | 'gateway-unreachable' | 'fanout-failed'`
  - `CANARY_SERVICE_NAME` constant, the string `'helix-configurator-canary'`

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/viewer-canary.test.mjs`:

```js
import { describe, it, expect, vi } from 'vitest';
import { runViewerCanary, CANARY_SERVICE_NAME } from '../viewerCanary.js';

const noSleep = async () => {};

describe('runViewerCanary', () => {
  it('returns ok as soon as the injected trace appears in the store', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = {
      getTrace: vi.fn((id) => (id === 'fixed-trace-id' ? { summary: {}, spans: [{ spanId: 'a' }] } : null)),
    };
    const r = await runViewerCanary({
      otelStore, axiosImpl, sleep: noSleep, traceId: 'fixed-trace-id',
      otlpBase: 'http://localhost:4318',
    });
    expect(r.verdict).toBe('ok');
    expect(r.traceId).toBe('fixed-trace-id');
    expect(axiosImpl.post).toHaveBeenCalledOnce();
    expect(axiosImpl.post.mock.calls[0][0]).toBe('http://localhost:4318/v1/traces');
  });

  it('tags the span with the canary service name so it is filterable in the UI', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = { getTrace: () => ({ summary: {}, spans: [{ spanId: 'a' }] }) };
    await runViewerCanary({ otelStore, axiosImpl, sleep: noSleep, otlpBase: 'http://localhost:4318' });
    const payload = axiosImpl.post.mock.calls[0][1];
    const attrs = payload.resourceSpans[0].resource.attributes;
    expect(attrs).toContainEqual({ key: 'service.name', value: { stringValue: CANARY_SERVICE_NAME } });
  });

  it('reports gateway-unreachable when the OTLP receiver refuses the injection', async () => {
    const axiosImpl = { post: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) };
    const otelStore = { getTrace: vi.fn(() => null) };
    const r = await runViewerCanary({
      otelStore, axiosImpl, sleep: noSleep, otlpBase: 'http://localhost:4318',
    });
    expect(r.verdict).toBe('gateway-unreachable');
    expect(r.detail).toContain('ECONNREFUSED');
    expect(otelStore.getTrace).not.toHaveBeenCalled();
  });

  it('reports fanout-failed when the gateway accepts the span but it never comes back', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = { getTrace: vi.fn(() => null) };
    const r = await runViewerCanary({
      otelStore, axiosImpl, sleep: noSleep, timeoutMs: 30, pollIntervalMs: 10,
      otlpBase: 'http://localhost:4318',
    });
    expect(r.verdict).toBe('fanout-failed');
    expect(otelStore.getTrace).toHaveBeenCalled();
  });

  it('treats a stored trace with zero spans as not yet arrived', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = { getTrace: vi.fn(() => ({ summary: {}, spans: [] })) };
    const r = await runViewerCanary({
      otelStore, axiosImpl, sleep: noSleep, timeoutMs: 30, pollIntervalMs: 10,
      otlpBase: 'http://localhost:4318',
    });
    expect(r.verdict).toBe('fanout-failed');
  });

  it('generates a unique 32-hex trace id when none is supplied', async () => {
    const axiosImpl = { post: vi.fn(async () => ({ status: 200 })) };
    const otelStore = { getTrace: () => ({ summary: {}, spans: [{ spanId: 'a' }] }) };
    const a = await runViewerCanary({ otelStore, axiosImpl, sleep: noSleep, otlpBase: 'http://x:4318' });
    const b = await runViewerCanary({ otelStore, axiosImpl, sleep: noSleep, otlpBase: 'http://x:4318' });
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.traceId).not.toBe(b.traceId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/viewer-canary.test.mjs` from `backend/`
Expected: FAIL, cannot resolve `./viewerCanary.js`

- [ ] **Step 3: Write minimal implementation**

Create `backend/viewerCanary.js`:

```js
// backend/viewerCanary.js
// End-to-end proof that the gateway's local viewer fan-out actually works.
//
// The existing /api/diagnostics/inject-trace endpoint reports success as soon
// as the GATEWAY accepts a span, which is exactly the half of the path that
// was never broken. This closes the loop: inject a uniquely-tagged span into
// the gateway's OTLP receiver, then wait for that specific trace id to come
// back through otlphttp/helix_local_viewer into our own store.
//
// A shell probe inside the gateway container is not an option: the collector
// contrib image ships without /bin/sh. Using the real exporter over the real
// path is a stronger signal in any case.
const crypto = require('node:crypto');
const axios = require('axios');
const { resolveGatewayOtlpBase } = require('./util');

const CANARY_SERVICE_NAME = 'helix-configurator-canary';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildCanaryPayload = (traceId, spanId, nowMs) => ({
  resourceSpans: [{
    resource: {
      attributes: [
        { key: 'service.name', value: { stringValue: CANARY_SERVICE_NAME } },
        { key: 'service.namespace', value: { stringValue: CANARY_SERVICE_NAME } },
      ],
    },
    scopeSpans: [{
      spans: [{
        traceId,
        spanId,
        name: 'viewer-fanout-canary',
        kind: 1,
        startTimeUnixNano: String(nowMs * 1000000),
        endTimeUnixNano: String((nowMs + 1) * 1000000),
        status: { code: 1 },
      }],
    }],
  }],
});

const GATEWAY_UNREACHABLE_FIX =
  'The configurator could not reach the gateway OTLP receiver. Check that the '
  + 'gateway container is running and that port 4318 is published, or set '
  + 'GATEWAY_OTLP_URL in .env if you remapped it.';

const FANOUT_FAILED_FIX =
  'The gateway accepted the span but it never came back through the local viewer '
  + 'exporter. Check the gateway logs for otlphttp/helix_local_viewer errors. A bare '
  + '"EOF" there means something accepts the connection and closes it without '
  + 'responding, which usually means a stale Docker port proxy owns the IPv4 side of '
  + 'the configurator port. Delivery to your Helix tenant is unaffected.';

const runViewerCanary = async ({
  otelStore,
  otlpBase = resolveGatewayOtlpBase(),
  timeoutMs = 15000,
  pollIntervalMs = 500,
  axiosImpl = axios,
  sleep = defaultSleep,
  traceId = crypto.randomBytes(16).toString('hex'),
} = {}) => {
  const startedAt = Date.now();
  const spanId = crypto.randomBytes(8).toString('hex');
  const elapsed = () => Date.now() - startedAt;

  try {
    await axiosImpl.post(
      `${otlpBase}/v1/traces`,
      buildCanaryPayload(traceId, spanId, Date.now()),
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 },
    );
  } catch (e) {
    return {
      verdict: 'gateway-unreachable',
      traceId,
      detail: e.message,
      remediation: GATEWAY_UNREACHABLE_FIX,
      elapsedMs: elapsed(),
    };
  }

  const deadline = startedAt + timeoutMs;
  for (;;) {
    const trace = otelStore.getTrace(traceId);
    if (trace && Array.isArray(trace.spans) && trace.spans.length > 0) {
      return { verdict: 'ok', traceId, detail: '', remediation: '', elapsedMs: elapsed() };
    }
    if (Date.now() >= deadline) break;
    await sleep(pollIntervalMs);
  }

  return {
    verdict: 'fanout-failed',
    traceId,
    detail: `Span accepted by the gateway but not received back within ${timeoutMs}ms.`,
    remediation: FANOUT_FAILED_FIX,
    elapsedMs: elapsed(),
  };
};

module.exports = { runViewerCanary, buildCanaryPayload, CANARY_SERVICE_NAME };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/viewer-canary.test.mjs` from `backend/`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add backend/viewerCanary.js backend/__tests__/viewer-canary.test.mjs
git commit -m "feat(viewer): add a round-trip canary that proves the fan-out path"
```

---

### Task 6: Candidate ladder on gateway create and recreate

Now the ladder can use the canary as its oracle.

**Scope note to carry into the code comment:** every native candidate resolves to an IPv4 host address, so in the split-brain case no candidate can succeed. The ladder fixes the resolvable cases, a non-default `PORT` and Linux Docker Engine name resolution. The split-brain case is what Task 4's preflight and Task 7's diagnostics exist to name.

**Files:**
- Create: `backend/viewerLadder.js`
- Create: `backend/__tests__/viewer-ladder.test.mjs`
- Verify (do not rewrite unless it fails): `backend/__tests__/create-gateway.test.mjs`. Its 4 tests call `createGatewayFromScratch`, whose signature this task changes. They pass no `otelStore`, so the early return keeps them green; run them and fix only if they break.
- Modify: `backend/routes/lifecycle.js` (`createGatewayFromScratch`, around lines 35-65)

**Interfaces:**
- Consumes: `viewerCandidates` (Task 1), `rewriteLocalViewerEndpoint` (Task 2), `runViewerCanary` (Task 5)
- Produces: `selectViewerEndpoint({ configHostPath, candidates, otelStore, restartGateway, fsp, canary, rewrite }) -> Promise<{ endpoint, verdict, attempts }>` where `attempts` is an array of `{ endpoint, verdict }`, and `endpoint` is `null` when no candidate round-tripped.

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/viewer-ladder.test.mjs`:

```js
import { describe, it, expect, vi } from 'vitest';
import { selectViewerEndpoint } from '../viewerLadder.js';

// Minimal fs promises double backed by a string.
const makeFsp = (initial) => {
  const state = { yaml: initial };
  return {
    state,
    readFile: vi.fn(async () => state.yaml),
    writeFile: vi.fn(async (_p, data) => { state.pending = data; }),
    rename: vi.fn(async () => { state.yaml = state.pending; }),
  };
};

const rewrite = (yaml, target) => `yaml-for:${target}`;

describe('selectViewerEndpoint', () => {
  it('keeps the first candidate when it round-trips', async () => {
    const fsp = makeFsp('original');
    const canary = vi.fn(async () => ({ verdict: 'ok' }));
    const restartGateway = vi.fn(async () => {});
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway, fsp, canary, rewrite,
    });
    expect(r.endpoint).toBe('http://a:1');
    expect(r.verdict).toBe('ok');
    expect(canary).toHaveBeenCalledOnce();
    expect(fsp.state.yaml).toBe('yaml-for:http://a:1');
  });

  it('falls through to the next candidate and persists the one that works', async () => {
    const fsp = makeFsp('original');
    const canary = vi.fn()
      .mockResolvedValueOnce({ verdict: 'fanout-failed' })
      .mockResolvedValueOnce({ verdict: 'ok' });
    const restartGateway = vi.fn(async () => {});
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway, fsp, canary, rewrite,
    });
    expect(r.endpoint).toBe('http://b:2');
    expect(r.attempts).toEqual([
      { endpoint: 'http://a:1', verdict: 'fanout-failed' },
      { endpoint: 'http://b:2', verdict: 'ok' },
    ]);
    expect(fsp.state.yaml).toBe('yaml-for:http://b:2');
    expect(restartGateway).toHaveBeenCalledTimes(2);
  });

  it('stops immediately when the gateway itself is unreachable', async () => {
    const fsp = makeFsp('original');
    const canary = vi.fn(async () => ({ verdict: 'gateway-unreachable' }));
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway: vi.fn(async () => {}), fsp, canary, rewrite,
    });
    expect(r.endpoint).toBe(null);
    expect(r.verdict).toBe('gateway-unreachable');
    expect(canary).toHaveBeenCalledOnce();
  });

  it('leaves the first candidate written when every candidate fails', async () => {
    const fsp = makeFsp('original');
    const canary = vi.fn(async () => ({ verdict: 'fanout-failed' }));
    const r = await selectViewerEndpoint({
      configHostPath: '/tmp/c.yaml', candidates: ['http://a:1', 'http://b:2'],
      otelStore: {}, restartGateway: vi.fn(async () => {}), fsp, canary, rewrite,
    });
    expect(r.endpoint).toBe(null);
    expect(r.verdict).toBe('fanout-failed');
    expect(r.attempts).toHaveLength(2);
    expect(fsp.state.yaml).toBe('yaml-for:http://a:1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/viewer-ladder.test.mjs` from `backend/`
Expected: FAIL, cannot resolve `./viewerLadder.js`

- [ ] **Step 3: Write minimal implementation**

Create `backend/viewerLadder.js`:

```js
// backend/viewerLadder.js
// Write a fan-out endpoint, restart the gateway, and prove the endpoint with
// the round-trip canary. On failure, try the next candidate.
//
// Scope limit, deliberately: every native candidate resolves to an IPv4 host
// address, so when another process owns the IPv4 side of the configurator's
// port no candidate can succeed. The ladder fixes the cases that ARE
// resolvable (a non-default PORT, and Linux Docker Engine where
// host.docker.internal may not resolve). The IPv4/IPv6 split-brain is named by
// the startup preflight and by /api/diagnostics/verify-fanout instead.
const fspDefault = require('fs').promises;
const { rewriteLocalViewerEndpoint } = require('./collectorFanout');
const { runViewerCanary } = require('./viewerCanary');

const writeEndpoint = async (fsp, configHostPath, rewrite, endpoint) => {
  const current = await fsp.readFile(configHostPath, 'utf8');
  const tmp = `${configHostPath}.tmp`;
  await fsp.writeFile(tmp, rewrite(current, endpoint));
  await fsp.rename(tmp, configHostPath);
};

const selectViewerEndpoint = async ({
  configHostPath,
  candidates,
  otelStore,
  restartGateway,
  fsp = fspDefault,
  canary = runViewerCanary,
  rewrite = rewriteLocalViewerEndpoint,
}) => {
  const attempts = [];
  let lastVerdict = 'fanout-failed';

  for (const endpoint of candidates) {
    await writeEndpoint(fsp, configHostPath, rewrite, endpoint);
    await restartGateway();
    const result = await canary({ otelStore });
    attempts.push({ endpoint, verdict: result.verdict });
    lastVerdict = result.verdict;

    if (result.verdict === 'ok') return { endpoint, verdict: 'ok', attempts };
    // A gateway we cannot reach at all is not an endpoint problem. Trying the
    // remaining candidates would restart the gateway again for nothing.
    if (result.verdict === 'gateway-unreachable') break;
  }

  // Nothing worked. The first candidate is the best guess for the deployment
  // mode, so leave that one on disk rather than the last one tried.
  if (candidates.length > 1 && attempts.length > 1) {
    await writeEndpoint(fsp, configHostPath, rewrite, candidates[0]);
  }
  return { endpoint: null, verdict: lastVerdict, attempts };
};

module.exports = { selectViewerEndpoint };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/viewer-ladder.test.mjs` from `backend/`
Expected: PASS, 4 tests

- [ ] **Step 5: Wire the ladder into gateway creation**

In `backend/routes/lifecycle.js`, add to the imports:

```js
const { viewerCandidates } = require('../viewerEndpoint');
const { selectViewerEndpoint } = require('../viewerLadder');
```

`createGatewayFromScratch` currently writes the yaml **before** creating the container, which cannot work with a canary because there is no gateway to inject into yet. Restructure it so the plain write happens first (unchanged, so the container starts with a usable config), then the ladder runs after `container.start()`.

Change the signature to accept the store and return the ladder result:

```js
async function createGatewayFromScratch(docker, { name, env, configHostPath, otelStore }) {
```

Keep the existing image pull, network create, and the existing pre-create rewrite exactly as Task 2 left them. After the existing `await container.start();` succeeds, append:

```js
  // Prove the fan-out endpoint end to end now that the gateway is running,
  // and fall through the candidate list if the first one does not round-trip.
  // Never throw: a gateway that is up but whose viewer sink is unproven is
  // still a working gateway for Helix delivery.
  if (!otelStore) return { viewer: null };
  try {
    const bridgeIp = await resolveBridgeGatewayIp(docker);
    const result = await selectViewerEndpoint({
      configHostPath,
      candidates: viewerCandidates({ containerized: IS_CONTAINERIZED, bridgeIp }),
      otelStore,
      restartGateway: async () => {
        await withDockerTimeout(container.restart({ t: 5 }), 'container.restart', 30_000);
      },
    });
    if (result.verdict !== 'ok') {
      errorLog.push('gateway.viewer.unproven',
        `viewer fan-out unproven: ${result.verdict} after ${result.attempts.length} candidate(s)`);
    }
    return { viewer: result };
  } catch (e) {
    console.warn('createGatewayFromScratch: viewer endpoint selection skipped:', e.message);
    return { viewer: null };
  }
```

Add this helper above `createGatewayFromScratch`:

```js
// The helix-bridge gateway address, used as the IPv4 fallback for hosts where
// host.docker.internal does not resolve. Returns null when it cannot be read;
// callers treat that as "no fallback candidate".
const resolveBridgeGatewayIp = async (docker) => {
  try {
    const net = await withDockerTimeout(
      docker.getNetwork('helix-bridge').inspect(), 'network.inspect', 5_000,
    );
    const cfg = (net.IPAM?.Config || [])[0];
    return cfg?.Gateway || null;
  } catch {
    return null;
  }
};
```

- [ ] **Step 6: Pass the store through at the call site**

Find the caller of `createGatewayFromScratch` inside `lifecycle.js` (around line 345, in the commit path) and add `otelStore` to its options object. `register` in `lifecycle.js` must accept `otelStore` in its destructured options, and `backend/index.js` must pass it:

```js
require('./routes/lifecycle').register(app, { docker, configPath: CONFIG_PATH, otelStore });
```

- [ ] **Step 7: Run the full backend suite**

Run: `npm --prefix backend test` from the repo root
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/viewerLadder.js backend/__tests__/viewer-ladder.test.mjs backend/routes/lifecycle.js backend/index.js
git commit -m "feat(viewer): prove the fan-out endpoint with a candidate ladder at gateway create"
```

---

### Task 7: Viewer-scoped counters and the verify-fanout endpoint

`fetchCounters` filters exporter counters to `otlphttp/bmchelix` by design, so the viewer exporter's failures cannot appear in the health banner at all. That is why the banner reported healthy while the viewer sink was 100% dead.

**Files:**
- Modify: `backend/routes/diagnostics.js` (add `fetchViewerCounters` beside `fetchCounters` around line 73, add the new route beside `inject-trace` around line 606)
- Create: `backend/__tests__/diagnostics-viewer.test.mjs`
- Read for context: `backend/routes/diagnostics.js:49` (`sumPromCounter` already accepts `{ exporterFilter }`)

**Interfaces:**
- Consumes: `runViewerCanary` (Task 5), `sumPromCounter` (existing, in-file)
- Produces:
  - `fetchViewerCounters(metricsText) -> { sent, failed }`, exported from the module for testing
  - `POST /api/diagnostics/verify-fanout` returning `{ verdict, traceId, detail, remediation, elapsedMs, counters }` with HTTP 200 for every verdict. This is a diagnostic result, not a request failure, so a failing verdict must not be an HTTP error.

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/diagnostics-viewer.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { fetchViewerCounters } from '../routes/diagnostics.js';

const METRICS = `
# HELP otelcol_exporter_sent_spans
otelcol_exporter_sent_spans{exporter="otlphttp/bmchelix"} 894
otelcol_exporter_sent_spans{exporter="otlphttp/helix_local_viewer"} 0
otelcol_exporter_send_failed_spans{exporter="otlphttp/bmchelix"} 0
otelcol_exporter_send_failed_spans{exporter="otlphttp/helix_local_viewer"} 131
otelcol_exporter_send_failed_log_records{exporter="otlphttp/helix_local_viewer"} 12
`;

describe('fetchViewerCounters', () => {
  it('reads counters scoped to the viewer exporter, not the helix exporter', () => {
    expect(fetchViewerCounters(METRICS)).toEqual({ sent: 0, failed: 143 });
  });

  it('returns zeroes when the viewer exporter is absent from the metrics', () => {
    expect(fetchViewerCounters('otelcol_exporter_sent_spans{exporter="otlphttp/bmchelix"} 5'))
      .toEqual({ sent: 0, failed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/diagnostics-viewer.test.mjs` from `backend/`
Expected: FAIL, `fetchViewerCounters is not a function`

- [ ] **Step 3: Write minimal implementation**

In `backend/routes/diagnostics.js`, immediately after the existing `fetchCounters` definition, add:

```js
// Counters scoped to the LOCAL VIEWER exporter. fetchCounters deliberately
// filters to otlphttp/bmchelix, which is why a totally dead viewer sink could
// never show up in the health banner. Both are reported now, so "Helix
// delivery healthy, local viewer failing" is a state we can actually express.
const fetchViewerCounters = (metricsText) => {
  const sum = (baseName) =>
    sumPromCounter(metricsText, baseName, { exporterFilter: 'otlphttp/helix_local_viewer' });
  return {
    sent:
      sum('otelcol_exporter_sent_spans')
      + sum('otelcol_exporter_sent_metric_points')
      + sum('otelcol_exporter_sent_log_records'),
    failed:
      sum('otelcol_exporter_send_failed_spans')
      + sum('otelcol_exporter_send_failed_metric_points')
      + sum('otelcol_exporter_send_failed_log_records'),
  };
};
```

At the top of the file, beside the other requires, add:

```js
const { runViewerCanary } = require('../viewerCanary');
```

Change the module export at the bottom of the file from `module.exports = { register, closeActiveLogProcesses };` (or whatever it currently is; keep every existing key) to also export the new helper:

```js
module.exports = { register, closeActiveLogProcesses, fetchViewerCounters };
```

Then add the route inside `register`, directly after the existing `inject-trace` route:

```js
  // POST run the end-to-end viewer fan-out canary. Unlike inject-trace, which
  // reports success as soon as the GATEWAY accepts a span, this waits for the
  // span to come back through otlphttp/helix_local_viewer into our own store.
  // Always answers 200: a failing verdict is a diagnostic result, not a
  // request error, and the UI renders it as a check cell either way.
  app.post('/api/diagnostics/verify-fanout', async (req, res) => {
    const result = await runViewerCanary({ otelStore });
    let counters = null;
    try {
      const response = await axios.get(`${resolveGatewayMetricsBase()}/metrics`, { timeout: 2000 });
      counters = fetchViewerCounters(response.data);
    } catch {
      counters = null; // metrics endpoint unavailable; the verdict still stands
    }
    res.json({ ...result, counters });
  });
```

`register` already receives `otelStore` in its options (it is passed from `index.js` in the existing `diagnostics.register(app, { docker, containerLogs, configPath: CONFIG_PATH, otelStore })` call), and `axios` and `resolveGatewayMetricsBase` are already imported in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/diagnostics-viewer.test.mjs` from `backend/`
Expected: PASS, 2 tests

- [ ] **Step 5: Verify the route end to end against the running stack**

Start the configurator and the gateway, then:

```bash
curl -s -X POST http://localhost:8765/api/diagnostics/verify-fanout | head -20
```

Expected: JSON with a `verdict` of `ok`, `gateway-unreachable`, or `fanout-failed`, a 32-hex `traceId`, and a `counters` object or `null`. HTTP status 200 in all cases.

- [ ] **Step 6: Run the full backend suite**

Run: `npm --prefix backend test` from the repo root
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/routes/diagnostics.js backend/__tests__/diagnostics-viewer.test.mjs
git commit -m "feat(diagnostics): add viewer-scoped counters and a verify-fanout endpoint"
```

---

### Task 8: Surface the verdict in the Diagnostics panel, and document it

**Files:**
- Modify: `frontend/src/components/dashboard/DiagnosticChecksGrid.tsx`
- Modify: `frontend/src/App.tsx:78-80` (state), `frontend/src/App.tsx:1562-1571` (the grid call site)
- Modify: `README.md` (the "Port & Process Reference" section, around line 351)

**Interfaces:**
- Consumes: `POST /api/diagnostics/verify-fanout` from Task 7
- Produces: a fifth check cell titled `Local Viewer Fan-out`

- [ ] **Step 1: Add the prop and the case to the grid**

In `frontend/src/components/dashboard/DiagnosticChecksGrid.tsx`, add `viewerDiag: DiagState;` to the `Props` type, add `viewerDiag,` to the destructured parameters, and add this case to `evaluate` before the `default`:

```tsx
      case 'Local Viewer Fan-out':
        return {
          isPass: viewerDiag.status === 'ok',
          isChecking: viewerDiag.status === 'unknown' || viewerDiag.status === 'CHECKING',
          subDetail: viewerDiag.error || '',
          remediation: viewerDiag.remediation || '',
        };
```

Then change the titles array and the column count. The grid is currently `grid-cols-4` with four titles:

```tsx
      <div className="grid grid-cols-5 gap-4">
        {['Collector Configuration', 'X-API Key Format', 'X-Source Format', 'Tenant URL Endpoint', 'Local Viewer Fan-out'].map((title, i) => {
```

- [ ] **Step 2: Add the state and the fetch in App.tsx**

Beside the existing `collectorDiag` / `networkDiag` state declarations around line 78, add:

```tsx
  const [viewerDiag, setViewerDiag] = useState({ status: 'unknown', error: '', remediation: '' });
```

Add an effect that runs the check when the diagnostics drawer opens. Place it beside the other diagnostic effects:

```tsx
  // The viewer fan-out check is a real end-to-end probe (it injects a span and
  // waits for it to come back), so it runs on demand when the drawer opens
  // rather than on a poll.
  useEffect(() => {
    if (!showDiagnostics) return;
    let cancelled = false;
    setViewerDiag({ status: 'CHECKING', error: '', remediation: '' });
    fetch('/api/diagnostics/verify-fanout', { method: 'POST', credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setViewerDiag({
          status: d.verdict === 'ok' ? 'ok' : 'FAIL',
          error: d.verdict === 'ok' ? '' : (d.detail || d.verdict),
          remediation: d.remediation || '',
        });
      })
      .catch(e => {
        if (cancelled) return;
        setViewerDiag({ status: 'FAIL', error: e.message, remediation: '' });
      });
    return () => { cancelled = true; };
  }, [showDiagnostics]);
```

Then pass it at the call site around line 1563:

```tsx
                    viewerDiag={viewerDiag}
```

- [ ] **Step 3: Verify in the browser**

Run the app, open the Diagnostics drawer, and confirm a fifth cell appears titled "Local Viewer Fan-out". It shows Checking, then Pass when the fan-out works. Break it deliberately (stop the gateway) and confirm it shows Fail with a "View Fix" button whose remediation text names the gateway OTLP receiver.

- [ ] **Step 4: Run the frontend suite**

Run: `npm --prefix frontend test` from the repo root
Expected: PASS

- [ ] **Step 5: Document the failure mode**

In `README.md`, in the "Port & Process Reference" section, after the paragraph describing the fan-out endpoint, add:

```markdown
The fan-out endpoint is derived from `PORT`, not hardcoded, so relocating the UI
moves the fan-out target with it. It is also verified: after the configurator
creates the gateway it injects a canary span and waits for it to come back, and
falls through to the bridge gateway IP if `host.docker.internal` does not
resolve. You can re-run that check any time from the Diagnostics panel's
**Local Viewer Fan-out** cell.

**If View OTel Data is empty while Helix delivery works**, the usual cause is
another process owning the IPv4 side of the configurator's port, most often a
stale Docker Desktop port proxy left by a previous `docker compose up` of the
configurator stack. The browser still works, because `localhost` resolves to
`::1` first, but the gateway reaches the configurator over IPv4 via
`host.docker.internal` and gets a connection that is accepted and then closed,
which the collector logs as a bare `EOF`. The configurator prints a warning at
startup when it detects this. Confirm with `lsof -nP -iTCP:8765 -sTCP:LISTEN`:
two listeners on the same port, one IPv4 and one IPv6, is the fingerprint. Clear
it with `docker compose down --remove-orphans` or by restarting Docker Desktop.
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/dashboard/DiagnosticChecksGrid.tsx frontend/src/App.tsx README.md
git commit -m "feat(diagnostics): surface the viewer fan-out verdict and document the split-brain"
```

---

## Verification

After all eight tasks:

- [ ] `npm --prefix backend test` passes
- [ ] `npm --prefix frontend test` passes
- [ ] `npm run lint` passes
- [ ] `grep -rn "rewriteLocalViewerToHost\|LOCAL_VIEWER_HOST" --include="*.js" . | grep -v node_modules` returns nothing
- [ ] A fresh `node backend/index.js` on a clean port prints no preflight warning, and `curl -4` and `curl -6` against `/api/health` return the same `instanceId`
- [ ] With IPv4 8765 occupied by another process, startup still succeeds, serves on IPv6, and prints the warning naming the port and the Docker remediation
- [ ] `POST /api/diagnostics/verify-fanout` returns `{"verdict":"ok"}` against a working stack
- [ ] The Diagnostics panel shows five cells, with Local Viewer Fan-out passing
