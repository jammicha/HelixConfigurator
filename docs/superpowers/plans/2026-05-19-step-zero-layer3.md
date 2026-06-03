# Step 0 — Layer 3 (Instrument Your Apps) Implementation Plan

> ⚠️ **SUPERSEDED — 2026-05-20.** This plan was implemented end-to-end on branch
> `worktree-step-zero-layer3` (commits `7060f90`…`0165459`), then walked back via a
> product pivot. Runtime container detection turned out to be fragile (image-tag
> drift, low-confidence false positives) and the Apply-for-me automation carried
> too much risk relative to its demo value — mutating the user's compose files and
> recreating their containers on a click is more invasive than the configurator
> should be by default.
>
> The replacement design ships as part of the same branch (commits `f1f5142` +
> `b5010f0`): Layer 3 becomes a static guide panel with four language tabs
> (Java / Python / .NET / Node), each rendering tailored zero-code snippets +
> a manual SDK section + outbound links to the official OTel docs. No detection,
> no apply, no undo, no verification polling. Only the pure snippet renderer
> (`instrument-templates.js`) and the `POST /snippet` endpoint survive from the
> original design.
>
> The detailed task-by-task plan below is preserved for history. Do NOT execute
> it. If you're continuing Layer 3 work, start from the current state of the
> branch and the design described in the commit message of `b5010f0`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Before starting, ensure an isolated git worktree exists via superpowers:using-git-worktrees.

**Goal:** Add a collapsible "Instrument your apps" panel on `/step-zero` below the existing Layer 2 demo panel. Detect running Java/Python/.NET/Node containers, generate copy-paste-ready OTel auto-instrumentation snippets, offer a one-click "Apply for me" for safe docker-compose-managed cases, and verify by watching for traces with the suggested `service.name`.

**Architecture:** New `backend/routes/step-zero/instrument*` module suite (detect, templates, apply, handlers) + new `frontend/src/components/step-zero/Layer3Instrument.tsx` + `RuntimeCard.tsx`. Apply-for-me uses the docker CLI inside the configurator container (added to the Dockerfile in Task 1) to run `docker compose -f <main> -f docker-compose.helix-instrument.yml up -d --no-deps <service>` so compose's project bookkeeping stays correct. Verification polls the configurator's local OTel store for spans with the suggested `service.name` since the apply timestamp.

**Tech Stack:** Node 20 + Express + dockerode + js-yaml + axios + `child_process.execFile` (for docker CLI) (backend); React 18 + Vite + TypeScript + Tailwind + lucide-react (frontend); vitest + supertest for backend tests.

---

## Scope boundaries

- IN: GET /detect, POST /snippet, POST /apply, GET /apply-status, POST /undo, POST /mark-applied, GET /verify-status backend endpoints. Detection + classification of 4 languages. Snippet templates × 3 endpoint modes per language. Apply-for-me for Java + (conditional) Node only. Override file `docker-compose.helix-instrument.yml`. Verification by service.name. Layer3Instrument + RuntimeCard frontend. StepZero integration. Collapsible section with localStorage persistence.
- OUT (deferred): Ruby/PHP/Go/Rust language support. Kubernetes-managed containers. Raw `docker run` containers (passive only). Auto-installing dependencies in user's image. Build-time instrumentation / image rebuild. Multi-environment picker. Custom OTel attributes UI. AIOps Business Service auto-creation.

---

## File Structure

**New files (backend):**
- `backend/routes/step-zero/instrument-detect.js` — pure detection & classification. Exports `classifyContainer(inspect)` returning `{ language, confidence, suggestedServiceName, applyCompatible, applyReason, alreadyInstrumented }`. ~180 lines.
- `backend/routes/step-zero/instrument-templates.js` — pure snippet rendering. Exports `renderSnippet({ language, serviceName, endpointMode })` returning `{ compose, shell, prereqs, agentDownload }`. ~250 lines.
- `backend/routes/step-zero/instrument-apply.js` — apply/undo orchestration. Exports `applyToService(opts)`, `undoForService(opts)`, `clearAllApplied()`. Uses `child_process.execFile('docker', ...)`. ~250 lines.
- `backend/routes/step-zero/instrument.js` — Express handlers, in-memory state (apply states + verification anchors). ~200 lines.
- `backend/__tests__/step-zero-instrument-detect.test.mjs` — unit tests for detection. ~150 lines.
- `backend/__tests__/step-zero-instrument-templates.test.mjs` — unit tests for snippet rendering. ~120 lines.
- `backend/__tests__/step-zero-instrument.test.mjs` — route handler tests with DI-stubbed docker + fs + apply. ~200 lines.

**New files (frontend):**
- `frontend/src/components/step-zero/Layer3Instrument.tsx` — collapsible panel shell, fetches /detect, renders per-container cards. ~150 lines.
- `frontend/src/components/step-zero/RuntimeCard.tsx` — per-container card with endpoint toggle, snippet display, Apply / "I applied it" buttons, verification status pill. ~250 lines.
- `frontend/src/components/step-zero/instrument-types.ts` — shared TypeScript types matching backend response shapes. ~50 lines.

**Modified files:**
- `Dockerfile` — install `docker` CLI in the configurator image (Task 1).
- `backend/index.js` — mount the new route module.
- `backend/routes/lifecycle.js` — extend `reset-onboarding` to also call `clearAllApplied()` (best-effort, like the existing `clearSyntheticRun` call from Layer 2).
- `backend/otelStore.js` — add `countSpansSinceForService(serviceName, sinceMs)` helper (small addition, sibling to existing percentile/recentThroughput helpers).
- `frontend/src/components/step-zero/StepZero.tsx` — add `<Layer3Instrument />` below `<Layer2Synthetic />`.

**Reuse (do NOT duplicate):**
- `dockerode` wrapper + `withDockerTimeout` + `sendDockerTimeoutResponse` from `backend/util.js` (existing).
- Auth-gated route mount pattern from `backend/index.js` (existing, used by Layer 2's `synthetic.js`).
- Confirm-dialog pattern from `frontend/src/App.tsx#setConfirmDialog` (existing — passed down to the Layer 3 component as a prop or via a small React context).
- The existing `helix-bridge` Docker network — declared `external: true` in our override file.

---

## Task 1: Install docker CLI in the configurator container

Apply-for-me invokes `docker compose -p <project> -f <main> -f <override> up -d --no-deps <service>` so compose's project bookkeeping (labels, networks, etc.) stays consistent with the user's existing stack. The configurator's current Node-based image doesn't ship the docker CLI, so install it.

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Read the existing Dockerfile**

Run: `cat /Users/jammicha/dev/HelixConfigurator/Dockerfile`
Note the base image and the existing layer structure.

- [ ] **Step 2: Add docker CLI install layer**

Open `Dockerfile`. After the existing `FROM` line and before the application copy/install lines, add a layer that installs the Docker CLI. The exact recipe depends on the base image:

If base is `node:<version>` (Debian-flavored — the default):

```dockerfile
# Install docker CLI so Step 0 Layer 3's "Apply for me" can run
# `docker compose up -d --no-deps <service>` against the host's docker
# daemon (mounted via /var/run/docker.sock). compose plugin is also
# needed because the configurator uses `docker compose` not the
# legacy `docker-compose`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
  && chmod a+r /etc/apt/keyrings/docker.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*
```

If base is `node:<version>-alpine`:

```dockerfile
RUN apk add --no-cache docker-cli docker-cli-compose
```

If base is something else, ask the user before guessing.

- [ ] **Step 3: Rebuild the configurator container locally to verify**

Run from the repo root: `docker compose -p helixconfigurator build helix-configurator`
Expected: build succeeds. Image grows by ~50–100 MB (CLI binaries).

Then verify the CLI is present inside the container:
Run: `docker compose -p helixconfigurator run --rm helix-configurator docker --version && docker compose -p helixconfigurator run --rm helix-configurator docker compose version`
Expected: prints docker version and docker-compose-plugin version. If "command not found", the install didn't land — check the Dockerfile layer.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat(step-zero): install docker CLI + compose plugin in configurator image

Step 0 Layer 3's 'Apply for me' flow runs:
  docker compose -p <project> -f <main> -f docker-compose.helix-instrument.yml up -d --no-deps <service>
to recreate the user's container with a non-destructive override file
without disturbing compose's project bookkeeping. The configurator's
Node image didn't ship the docker CLI; install it now.

The docker daemon socket is already mounted (docker-compose.yml line 14),
so the CLI just needs to be present inside the container.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure detection — classifyContainer + detectLanguage

Detects language from a container's inspect output. Returns the full classification object the /detect endpoint will emit.

**Files:**
- Create: `backend/routes/step-zero/instrument-detect.js`
- Test: `backend/__tests__/step-zero-instrument-detect.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `backend/__tests__/step-zero-instrument-detect.test.mjs`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
  deriveServiceName,
  classifyContainer,
} from '../routes/step-zero/instrument-detect.js';

// Helper: fabricate a minimal inspect-like object.
const mk = ({ name = 'app', cmd = [], entrypoint = null, image = '', env = [], labels = {} } = {}) => ({
  Name: '/' + name,
  Config: { Cmd: cmd, Entrypoint: entrypoint, Image: image, Env: env, Labels: labels },
});

describe('detectLanguage', () => {
  it('matches java from command-line', () => {
    expect(detectLanguage({ cmd: ['java', '-jar', 'app.jar'], image: 'busybox' })).toMatchObject({ language: 'java', confidence: 'high' });
    expect(detectLanguage({ cmd: ['/usr/bin/java', '-Xmx512m', '-jar', 'cart.jar'], image: 'x' })).toMatchObject({ language: 'java', confidence: 'high' });
  });

  it('matches python from command-line', () => {
    expect(detectLanguage({ cmd: ['python3', 'app.py'], image: 'x' })).toMatchObject({ language: 'python', confidence: 'high' });
    expect(detectLanguage({ cmd: ['uvicorn', 'main:app'], image: 'x' })).toMatchObject({ language: 'python', confidence: 'high' });
    expect(detectLanguage({ cmd: ['gunicorn', 'wsgi:app'], image: 'x' })).toMatchObject({ language: 'python', confidence: 'high' });
  });

  it('matches dotnet from command-line', () => {
    expect(detectLanguage({ cmd: ['dotnet', 'MyApp.dll'], image: 'x' })).toMatchObject({ language: 'dotnet', confidence: 'high' });
  });

  it('matches node from command-line', () => {
    expect(detectLanguage({ cmd: ['node', 'server.js'], image: 'x' })).toMatchObject({ language: 'node', confidence: 'high' });
    expect(detectLanguage({ cmd: ['npm', 'start'], image: 'x' })).toMatchObject({ language: 'node', confidence: 'high' });
    expect(detectLanguage({ cmd: ['yarn', 'serve'], image: 'x' })).toMatchObject({ language: 'node', confidence: 'high' });
  });

  it('falls back to image hint with low confidence', () => {
    expect(detectLanguage({ cmd: [], entrypoint: null, image: 'openjdk:21-slim' })).toMatchObject({ language: 'java', confidence: 'low' });
    expect(detectLanguage({ cmd: [], image: 'python:3.11' })).toMatchObject({ language: 'python', confidence: 'low' });
    expect(detectLanguage({ cmd: [], image: 'mcr.microsoft.com/dotnet/aspnet:8.0' })).toMatchObject({ language: 'dotnet', confidence: 'low' });
    expect(detectLanguage({ cmd: [], image: 'node:20-alpine' })).toMatchObject({ language: 'node', confidence: 'low' });
  });

  it('returns unknown for unrecognized commands and images', () => {
    expect(detectLanguage({ cmd: ['/bin/sh', '-c', 'sleep infinity'], image: 'busybox' })).toMatchObject({ language: 'unknown' });
    expect(detectLanguage({ cmd: ['nginx', '-g', 'daemon off;'], image: 'nginx:latest' })).toMatchObject({ language: 'unknown' });
    expect(detectLanguage({ cmd: ['redis-server'], image: 'redis:7' })).toMatchObject({ language: 'unknown' });
  });
});

describe('deriveServiceName', () => {
  it('uses compose service label when present', () => {
    expect(deriveServiceName(mk({ name: 'projectx_cart-api_1', labels: { 'com.docker.compose.service': 'cart-api', 'com.docker.compose.project': 'projectx' } }))).toBe('cart-api');
  });

  it('strips compose project prefix when label is missing', () => {
    expect(deriveServiceName(mk({ name: 'projectx_cart-api_1', labels: { 'com.docker.compose.project': 'projectx' } }))).toBe('cart-api');
  });

  it('strips trailing _<digits> replica suffix', () => {
    expect(deriveServiceName(mk({ name: 'orders_3' }))).toBe('orders');
  });

  it('falls back to raw container name when no compose info', () => {
    expect(deriveServiceName(mk({ name: 'random-name' }))).toBe('random-name');
  });
});

describe('classifyContainer', () => {
  it('classifies a happy-path Java container', () => {
    const result = classifyContainer(mk({
      name: 'projectx_cart-api_1',
      cmd: ['java', '-jar', '/app/cart.jar'],
      image: 'openjdk:21-slim',
      labels: {
        'com.docker.compose.service': 'cart-api',
        'com.docker.compose.project': 'projectx',
        'com.docker.compose.config-files': '/Users/jam/projectx/docker-compose.yml',
      },
    }));
    expect(result.language).toBe('java');
    expect(result.suggestedServiceName).toBe('cart-api');
    expect(result.alreadyInstrumented).toBe(false);
    // applyCompatible is null here because we don't have a real fs check;
    // the consumer in instrument.js fills it in. Verify the classifier
    // surfaces enough info for that check.
    expect(result.composeProject).toBe('projectx');
    expect(result.composeConfigFiles).toBe('/Users/jam/projectx/docker-compose.yml');
  });

  it('marks already-instrumented when OTEL_EXPORTER_OTLP_ENDPOINT is set in env', () => {
    const result = classifyContainer(mk({
      name: 'instrumented_app',
      cmd: ['python', 'main.py'],
      env: ['OTEL_EXPORTER_OTLP_ENDPOINT=http://gateway:4318', 'PATH=/usr/bin'],
    }));
    expect(result.alreadyInstrumented).toBe(true);
    expect(result.alreadyInstrumentedReason).toMatch(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it('marks already-instrumented when -javaagent points at opentelemetry-javaagent.jar', () => {
    const result = classifyContainer(mk({
      name: 'java_with_agent',
      cmd: ['java', '-javaagent:/opt/opentelemetry-javaagent.jar', '-jar', 'app.jar'],
    }));
    expect(result.alreadyInstrumented).toBe(true);
    expect(result.alreadyInstrumentedReason).toMatch(/javaagent/);
  });

  it('returns null language when image is helix-related (filter at caller)', () => {
    // The classifier doesn't filter helix-* itself — caller does that. But
    // for our own image we want unknown so it falls into the silent skip.
    const result = classifyContainer(mk({ name: 'helix-gateway', image: 'otel/opentelemetry-collector-contrib:latest', cmd: ['/otelcol-contrib'] }));
    expect(result.language).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jammicha/dev/HelixConfigurator/backend && npx vitest run __tests__/step-zero-instrument-detect.test.mjs`
Expected: FAIL with `Cannot find module '../routes/step-zero/instrument-detect.js'`.

- [ ] **Step 3: Write the implementation**

Create `backend/routes/step-zero/instrument-detect.js`:

```javascript
// Step 0 Layer 3 — pure detection of language runtime + classification of
// a container from its `docker inspect` output. No I/O.
//
// Returns enough information for instrument.js's /detect handler to decide
// whether to surface the container as an Apply-for-me candidate, a passive
// snippet candidate, or skip it.

const LANG_CMD_PATTERNS = [
  // Order matters — first match wins.
  { language: 'java',   re: /(^|\/)java($|\s|$)|\.jar(\s|$)|^java$/i },
  { language: 'python', re: /(^|\/)(python3?|uvicorn|gunicorn|flask|fastapi)($|\s)|\.py(\s|$)/i },
  { language: 'dotnet', re: /(^|\/)dotnet($|\s)|\.dll(\s|$)/i },
  { language: 'node',   re: /(^|\/)(node|npm|yarn|pnpm)($|\s)|\.m?js(\s|$)/i },
];

const LANG_IMAGE_PATTERNS = [
  { language: 'java',   re: /^(openjdk|eclipse-temurin|amazoncorretto|adoptopenjdk)\b/i },
  { language: 'python', re: /^python(:|$)/i },
  { language: 'dotnet', re: /^mcr\.microsoft\.com\/dotnet\b/i },
  { language: 'node',   re: /^node(:|$)/i },
];

const stringifyCmd = (cmd, entrypoint) => {
  const parts = [];
  if (Array.isArray(entrypoint) && entrypoint.length) parts.push(...entrypoint);
  if (Array.isArray(cmd) && cmd.length) parts.push(...cmd);
  return parts.join(' ');
};

const detectLanguage = ({ cmd = [], entrypoint = null, image = '' }) => {
  const cmdString = stringifyCmd(cmd, entrypoint);
  // 1. Command-line signature (high confidence).
  if (cmdString) {
    for (const { language, re } of LANG_CMD_PATTERNS) {
      if (re.test(cmdString)) return { language, confidence: 'high' };
    }
  }
  // 2. Image hint (low confidence).
  for (const { language, re } of LANG_IMAGE_PATTERNS) {
    if (re.test(image)) return { language, confidence: 'low' };
  }
  return { language: 'unknown', confidence: 'low' };
};

const stripContainerName = (raw) =>
  String(raw || '').replace(/^\//, '');

const deriveServiceName = (inspect) => {
  const labels = inspect?.Config?.Labels || {};
  const svc = labels['com.docker.compose.service'];
  if (svc) return svc;
  const name = stripContainerName(inspect?.Name);
  const proj = labels['com.docker.compose.project'];
  let trimmed = name;
  if (proj && (trimmed.startsWith(proj + '_') || trimmed.startsWith(proj + '-'))) {
    trimmed = trimmed.slice(proj.length + 1);
  }
  // Strip trailing _<digits> or -<digits> (compose replica suffix).
  trimmed = trimmed.replace(/[_-]\d+$/, '');
  return trimmed || name;
};

const ALREADY_INSTRUMENTED_ENV_KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];

const checkAlreadyInstrumented = ({ cmd, entrypoint, env }) => {
  const envArr = Array.isArray(env) ? env : [];
  for (const e of envArr) {
    for (const key of ALREADY_INSTRUMENTED_ENV_KEYS) {
      if (e.startsWith(key + '=')) {
        return { alreadyInstrumented: true, alreadyInstrumentedReason: `${key} already set in env` };
      }
    }
  }
  const cmdString = stringifyCmd(cmd, entrypoint);
  if (/-javaagent:[^ ]*opentelemetry-javaagent\.jar/i.test(cmdString)) {
    return { alreadyInstrumented: true, alreadyInstrumentedReason: '-javaagent points at opentelemetry-javaagent.jar' };
  }
  return { alreadyInstrumented: false, alreadyInstrumentedReason: null };
};

const classifyContainer = (inspect) => {
  const cfg = inspect?.Config || {};
  const labels = cfg.Labels || {};
  const ctx = {
    cmd: cfg.Cmd || [],
    entrypoint: cfg.Entrypoint || null,
    image: cfg.Image || '',
    env: cfg.Env || [],
  };
  const lang = detectLanguage(ctx);
  const instrumented = checkAlreadyInstrumented(ctx);
  return {
    container: stripContainerName(inspect?.Name),
    image: ctx.image,
    language: lang.language,
    confidence: lang.confidence,
    suggestedServiceName: deriveServiceName(inspect),
    composeProject: labels['com.docker.compose.project'] || null,
    composeConfigFiles: labels['com.docker.compose.config-files'] || null,
    composeService: labels['com.docker.compose.service'] || null,
    alreadyInstrumented: instrumented.alreadyInstrumented,
    alreadyInstrumentedReason: instrumented.alreadyInstrumentedReason,
  };
};

module.exports = { detectLanguage, deriveServiceName, classifyContainer };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run __tests__/step-zero-instrument-detect.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/step-zero/instrument-detect.js backend/__tests__/step-zero-instrument-detect.test.mjs
git commit -m "feat(step-zero): pure detection of container language runtime

Pattern-based language classification from docker inspect output:
java / python / dotnet / node, with cmd-line signatures preferred over
image-name hints. Returns the full classification object the /detect
endpoint surfaces. Also detects already-instrumented containers
(OTEL_EXPORTER_OTLP_ENDPOINT set or -javaagent attached) so we don't
offer to instrument them again.

Pure function — no I/O. Tested in isolation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure snippet templates — renderSnippet for 4 languages × 3 endpoint modes

Pure function that returns the rendered compose patch + shell wrapper for a given language and endpoint mode.

**Files:**
- Create: `backend/routes/step-zero/instrument-templates.js`
- Test: `backend/__tests__/step-zero-instrument-templates.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `backend/__tests__/step-zero-instrument-templates.test.mjs`:

```javascript
import { describe, it, expect } from 'vitest';
import { renderSnippet } from '../routes/step-zero/instrument-templates.js';

describe('renderSnippet', () => {
  const baseArgs = { serviceName: 'cart-api' };

  describe('java', () => {
    it('compose-mode includes JAVA_TOOL_OPTIONS and helix-bridge network', () => {
      const out = renderSnippet({ ...baseArgs, language: 'java', endpointMode: 'compose' });
      expect(out.compose).toContain('OTEL_SERVICE_NAME: cart-api');
      expect(out.compose).toContain('OTEL_EXPORTER_OTLP_ENDPOINT: http://helix-gateway:4318');
      expect(out.compose).toContain('JAVA_TOOL_OPTIONS');
      expect(out.compose).toContain('-javaagent:/otel-agent/opentelemetry-javaagent.jar');
      expect(out.compose).toContain('helix-bridge');
      expect(out.compose).toContain('external: true');
    });
    it('host-mode uses localhost endpoint and omits networks block', () => {
      const out = renderSnippet({ ...baseArgs, language: 'java', endpointMode: 'host' });
      expect(out.shell).toContain('http://localhost:4318');
      expect(out.shell).toContain('-javaagent:');
      expect(out.compose).toContain('http://localhost:4318');
      expect(out.compose).not.toContain('helix-bridge');
    });
    it('standalone-mode uses host.docker.internal', () => {
      const out = renderSnippet({ ...baseArgs, language: 'java', endpointMode: 'standalone' });
      expect(out.compose).toContain('http://host.docker.internal:4318');
    });
    it('exposes agentDownload URL for Java', () => {
      const out = renderSnippet({ ...baseArgs, language: 'java', endpointMode: 'compose' });
      expect(out.agentDownload).toMatch(/opentelemetry-javaagent\.jar$/);
    });
  });

  describe('python', () => {
    it('compose-mode prefixes command with opentelemetry-instrument', () => {
      const out = renderSnippet({ ...baseArgs, language: 'python', endpointMode: 'compose' });
      expect(out.compose).toContain('opentelemetry-instrument');
      expect(out.prereqs).toContain('pip install');
    });
    it('shell-mode is a wrapper command', () => {
      const out = renderSnippet({ ...baseArgs, language: 'python', endpointMode: 'host' });
      expect(out.shell).toContain('opentelemetry-instrument');
    });
  });

  describe('node', () => {
    it('sets NODE_OPTIONS with the auto-instrumentations require', () => {
      const out = renderSnippet({ ...baseArgs, language: 'node', endpointMode: 'compose' });
      expect(out.compose).toContain('NODE_OPTIONS');
      expect(out.compose).toContain('@opentelemetry/auto-instrumentations-node/register');
      expect(out.prereqs).toContain('npm install');
    });
  });

  describe('dotnet', () => {
    it('sets CoreCLR profiler env vars', () => {
      const out = renderSnippet({ ...baseArgs, language: 'dotnet', endpointMode: 'compose' });
      expect(out.compose).toContain('CORECLR_ENABLE_PROFILING');
      expect(out.compose).toContain('CORECLR_PROFILER');
      expect(out.compose).toContain('DOTNET_STARTUP_HOOKS');
      expect(out.prereqs).toMatch(/install/);
    });
  });

  it('throws for unknown language', () => {
    expect(() => renderSnippet({ language: 'rust', serviceName: 'x', endpointMode: 'compose' })).toThrow(/language/i);
  });

  it('throws for unknown endpointMode', () => {
    expect(() => renderSnippet({ language: 'java', serviceName: 'x', endpointMode: 'kubernetes' })).toThrow(/endpointMode/i);
  });
});
```

- [ ] **Step 2: Run to verify failing**

Run: `cd backend && npx vitest run __tests__/step-zero-instrument-templates.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/routes/step-zero/instrument-templates.js`:

```javascript
// Step 0 Layer 3 — pure snippet renderer. Returns the compose patch +
// shell wrapper command + prereq notes + (Java only) agent download URL
// for a given language and endpoint mode. No I/O.

const VALID_LANGUAGES = ['java', 'python', 'dotnet', 'node'];
const VALID_MODES = ['compose', 'standalone', 'host'];

const ENDPOINT_BY_MODE = {
  compose: 'http://helix-gateway:4318',
  standalone: 'http://host.docker.internal:4318',
  host: 'http://localhost:4318',
};

const JAVA_AGENT_URL = 'https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar';

// Indent multiline string by N spaces.
const indent = (s, n) => s.split('\n').map(line => line ? ' '.repeat(n) + line : line).join('\n');

const composeEnvBlock = (serviceName, endpoint, extraLines = []) => {
  const lines = [
    `OTEL_SERVICE_NAME: ${serviceName}`,
    `OTEL_EXPORTER_OTLP_ENDPOINT: ${endpoint}`,
    `OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf`,
    `OTEL_RESOURCE_ATTRIBUTES: deployment.environment=dev,service.namespace=step-zero-instrumented`,
    ...extraLines,
  ];
  return lines.join('\n');
};

const networksBlockIfNeeded = (endpointMode) => {
  if (endpointMode !== 'compose') return '';
  return `    networks:\n      - helix-bridge\n\nnetworks:\n  helix-bridge:\n    external: true`;
};

const renderJava = ({ serviceName, endpointMode }) => {
  const endpoint = ENDPOINT_BY_MODE[endpointMode];
  const envInner = composeEnvBlock(serviceName, endpoint, [
    `JAVA_TOOL_OPTIONS: "-javaagent:/otel-agent/opentelemetry-javaagent.jar"`,
  ]);
  const composeVolume = endpointMode === 'compose'
    ? `\n    volumes:\n      - helix-otel-agents:/otel-agent:ro`
    : `\n    volumes:\n      - ./otel-agent:/otel-agent:ro  # mount the dir containing opentelemetry-javaagent.jar`;
  const volumesBlock = endpointMode === 'compose'
    ? `\n\nvolumes:\n  helix-otel-agents:\n    external: true`
    : '';
  const networks = networksBlockIfNeeded(endpointMode);
  const compose = [
    `services:`,
    `  ${serviceName}:`,
    `    environment:`,
    indent(envInner, 6),
    composeVolume.trimStart() ? composeVolume : '',
    networks ? `\n${networks}` : '',
    volumesBlock,
  ].filter(Boolean).join('\n');

  const shell = [
    `# 1. Download the agent JAR (one-time)`,
    `curl -fsSL -o /tmp/opentelemetry-javaagent.jar \\`,
    `  "${JAVA_AGENT_URL}"`,
    ``,
    `# 2. Run your app with the agent attached`,
    `OTEL_SERVICE_NAME=${serviceName} \\`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} \\`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\`,
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=dev,service.namespace=step-zero-instrumented \\`,
    `java -javaagent:/tmp/opentelemetry-javaagent.jar -jar your-app.jar`,
  ].join('\n');

  const prereqs = `Java agent JAR is self-contained — no image rebuild needed. The "Apply for me" button (if shown) handles the download into a shared Docker volume automatically.`;

  return { compose, shell, prereqs, agentDownload: JAVA_AGENT_URL };
};

const renderPython = ({ serviceName, endpointMode }) => {
  const endpoint = ENDPOINT_BY_MODE[endpointMode];
  const envInner = composeEnvBlock(serviceName, endpoint);
  const networks = networksBlockIfNeeded(endpointMode);
  const compose = [
    `services:`,
    `  ${serviceName}:`,
    `    environment:`,
    indent(envInner, 6),
    `    command: opentelemetry-instrument python your-app.py  # replace with your actual command`,
    networks ? `\n${networks}` : '',
  ].filter(Boolean).join('\n');

  const shell = [
    `OTEL_SERVICE_NAME=${serviceName} \\`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} \\`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\`,
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=dev,service.namespace=step-zero-instrumented \\`,
    `opentelemetry-instrument python your-app.py`,
  ].join('\n');

  const prereqs = `Inside the Python image, run:\n  pip install opentelemetry-distro opentelemetry-exporter-otlp opentelemetry-instrumentation\n  opentelemetry-bootstrap -a install\nAdd both lines to your Dockerfile, or rebuild your image once with them included.`;

  return { compose, shell, prereqs, agentDownload: null };
};

const renderNode = ({ serviceName, endpointMode }) => {
  const endpoint = ENDPOINT_BY_MODE[endpointMode];
  const envInner = composeEnvBlock(serviceName, endpoint, [
    `NODE_OPTIONS: "--require @opentelemetry/auto-instrumentations-node/register"`,
  ]);
  const networks = networksBlockIfNeeded(endpointMode);
  const compose = [
    `services:`,
    `  ${serviceName}:`,
    `    environment:`,
    indent(envInner, 6),
    networks ? `\n${networks}` : '',
  ].filter(Boolean).join('\n');

  const shell = [
    `OTEL_SERVICE_NAME=${serviceName} \\`,
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint} \\`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\`,
    `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=dev,service.namespace=step-zero-instrumented \\`,
    `NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register" \\`,
    `node your-server.js`,
  ].join('\n');

  const prereqs = `Inside the Node image, run:\n  npm install @opentelemetry/auto-instrumentations-node @opentelemetry/api\nAdd to your package.json and rebuild your image.`;

  return { compose, shell, prereqs, agentDownload: null };
};

const renderDotnet = ({ serviceName, endpointMode }) => {
  const endpoint = ENDPOINT_BY_MODE[endpointMode];
  const envInner = composeEnvBlock(serviceName, endpoint, [
    `CORECLR_ENABLE_PROFILING: "1"`,
    `CORECLR_PROFILER: "{918728DD-259F-4A6A-AC2B-B85E1B658318}"`,
    `CORECLR_PROFILER_PATH: /otel-dotnet-auto/linux-x64/OpenTelemetry.AutoInstrumentation.Native.so`,
    `DOTNET_ADDITIONAL_DEPS: /otel-dotnet-auto/AdditionalDeps`,
    `DOTNET_SHARED_STORE: /otel-dotnet-auto/store`,
    `DOTNET_STARTUP_HOOKS: /otel-dotnet-auto/net/OpenTelemetry.AutoInstrumentation.StartupHook.dll`,
    `OTEL_DOTNET_AUTO_HOME: /otel-dotnet-auto`,
  ]);
  const networks = networksBlockIfNeeded(endpointMode);
  const compose = [
    `services:`,
    `  ${serviceName}:`,
    `    environment:`,
    indent(envInner, 6),
    `    volumes:`,
    `      - ./otel-dotnet-auto:/otel-dotnet-auto:ro  # populated by the OTel .NET install script`,
    networks ? `\n${networks}` : '',
  ].filter(Boolean).join('\n');

  const shell = [
    `# 1. Install the OTel .NET auto-instrumentation (one-time)`,
    `curl -sSfL https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/latest/download/otel-dotnet-auto-install.sh -O`,
    `sh ./otel-dotnet-auto-install.sh`,
    `. $HOME/.otel-dotnet-auto/instrument.sh`,
    ``,
    `# 2. Set env + run your app`,
    `export OTEL_SERVICE_NAME=${serviceName}`,
    `export OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
    `export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`,
    `dotnet YourApp.dll`,
  ].join('\n');

  const prereqs = `Run the OTel .NET auto-instrumentation installer once to populate /otel-dotnet-auto. See https://opentelemetry.io/docs/zero-code/net/ for the full setup. "Apply for me" is NOT offered for .NET because the installer is too involved to automate safely.`;

  return { compose, shell, prereqs, agentDownload: null };
};

const RENDERERS = {
  java: renderJava,
  python: renderPython,
  node: renderNode,
  dotnet: renderDotnet,
};

const renderSnippet = ({ language, serviceName, endpointMode }) => {
  if (!VALID_LANGUAGES.includes(language)) {
    throw new Error(`renderSnippet: unknown language "${language}" — expected one of ${VALID_LANGUAGES.join(', ')}`);
  }
  if (!VALID_MODES.includes(endpointMode)) {
    throw new Error(`renderSnippet: unknown endpointMode "${endpointMode}" — expected one of ${VALID_MODES.join(', ')}`);
  }
  if (!serviceName || typeof serviceName !== 'string') {
    throw new Error('renderSnippet: serviceName is required');
  }
  return RENDERERS[language]({ serviceName, endpointMode });
};

module.exports = { renderSnippet, VALID_LANGUAGES, VALID_MODES, JAVA_AGENT_URL };
```

- [ ] **Step 4: Run to verify passing**

Run: `cd backend && npx vitest run __tests__/step-zero-instrument-templates.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/step-zero/instrument-templates.js backend/__tests__/step-zero-instrument-templates.test.mjs
git commit -m "feat(step-zero): pure snippet renderer for 4 languages × 3 endpoint modes

Returns compose patch + shell wrapper + prereq notes + agent download
URL for java/python/dotnet/node × compose/standalone/host endpoint
modes. Pure function — no I/O. Used by the /snippet endpoint (next
task) and the per-card endpoint toggle in the UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: otelStore helper — countSpansSinceForService

Verification needs to count spans by service.name since the apply timestamp. Add a small helper to the existing otelStore module.

**Files:**
- Modify: `backend/otelStore.js`
- Test: `backend/__tests__/otelStore.test.mjs` (existing — extend if it covers similar helpers; otherwise the helper is exercised via instrument.js handler tests in Task 5)

- [ ] **Step 1: Find a place to insert the helper**

Read `backend/otelStore.js`. Locate the section where other count/percentile helpers live (around the `percentile` / `recentThroughput` functions). The new helper goes alongside them.

- [ ] **Step 2: Add the helper**

Inside the `OtelStore` class (or alongside the existing query helpers, whichever pattern the file uses), add:

```javascript
  // Count spans for a given service.name received since a timestamp (ms).
  // Used by Step 0 Layer 3's verification loop: after a user applies an
  // instrumentation snippet to `service.name=cart-api`, we poll this to
  // confirm traces are arriving.
  countSpansSinceForService(serviceName, sinceMs) {
    if (!serviceName || typeof sinceMs !== 'number') {
      return { count: 0, lastSeenAt: null };
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(received_at_ms) AS last_seen
      FROM spans
      WHERE service_name = ? AND received_at_ms >= ?
    `).get(serviceName, sinceMs);
    return {
      count: Number(row?.count || 0),
      lastSeenAt: row?.last_seen ? Number(row.last_seen) : null,
    };
  }
```

If the spans table doesn't have a `received_at_ms` column today, instead use whichever column tracks ingest time (likely `received_at_unix_nano` divided by 1_000_000, or `start_time_unix_nano` as a fallback). Verify with: `grep -n "CREATE TABLE.*spans\b" backend/otelStore.js` and adapt the query to match the real schema.

- [ ] **Step 3: Quick verification**

Run: `cd backend && npx vitest run` to confirm the existing suite still passes (no regression in the modified file).
Expected: same test count as before; nothing turns red.

- [ ] **Step 4: Commit**

```bash
git add backend/otelStore.js
git commit -m "feat(step-zero): add countSpansSinceForService helper to otelStore

Layer 3's verification loop needs to count spans by service.name
arriving after a given timestamp. Tiny SQL helper alongside the
existing percentile / throughput query helpers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Route module scaffold + /detect + /snippet + /verify-status

The simpler handlers first — pure read endpoints that don't mutate state. Sets up the route module wiring.

**Files:**
- Create: `backend/routes/step-zero/instrument.js`
- Modify: `backend/index.js`
- Test: `backend/__tests__/step-zero-instrument.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `backend/__tests__/step-zero-instrument.test.mjs`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { register, __resetForTests } from '../routes/step-zero/instrument.js';

const makeApp = (deps = {}) => {
  const app = express();
  app.use(express.json());
  register(app, deps);
  return app;
};

const mkInspect = ({ name = 'app', cmd = [], image = '', env = [], labels = {} } = {}) => ({
  Name: '/' + name,
  Config: { Cmd: cmd, Entrypoint: null, Image: image, Env: env, Labels: labels },
});

beforeEach(() => { __resetForTests(); });

describe('GET /api/step-zero/instrument/detect', () => {
  it('classifies running containers, skips helix-*, marks already-instrumented', async () => {
    const docker = {
      listContainers: vi.fn().mockResolvedValue([
        { Names: ['/cart-api'], Id: 'c1' },
        { Names: ['/helix-gateway'], Id: 'c2' },
        { Names: ['/payment-svc'], Id: 'c3' },
        { Names: ['/already-instrumented'], Id: 'c4' },
      ]),
      getContainer: vi.fn((name) => ({
        inspect: vi.fn().mockResolvedValue(
          name === 'cart-api' ? mkInspect({ name: 'cart-api', cmd: ['java', '-jar', '/app.jar'], labels: { 'com.docker.compose.service': 'cart-api', 'com.docker.compose.project': 'demo', 'com.docker.compose.config-files': '/tmp/no-such-file.yml' } }) :
          name === 'helix-gateway' ? mkInspect({ name: 'helix-gateway', image: 'otel/opentelemetry-collector-contrib:latest' }) :
          name === 'payment-svc' ? mkInspect({ name: 'payment-svc', cmd: ['node', 'server.js'] }) :
          name === 'already-instrumented' ? mkInspect({ name: 'already-instrumented', cmd: ['python', 'app.py'], env: ['OTEL_EXPORTER_OTLP_ENDPOINT=http://x:4318'] }) :
          null
        ),
      })),
    };
    const app = makeApp({ docker });
    const r = await request(app).get('/api/step-zero/instrument/detect');
    expect(r.status).toBe(200);
    const containers = r.body.detected.map(c => c.container);
    expect(containers).toContain('cart-api');
    expect(containers).toContain('payment-svc');
    expect(containers).not.toContain('helix-gateway');
    expect(containers).not.toContain('already-instrumented');
    expect(r.body.alreadyInstrumented.map(c => c.container)).toContain('already-instrumented');

    // The fake compose file path doesn't actually exist on disk, so
    // applyCompatible should be false with an "not readable" reason.
    const cartCard = r.body.detected.find(c => c.container === 'cart-api');
    expect(cartCard.applyCompatible).toBe(false);
    expect(cartCard.applyReason).toMatch(/not readable|not docker-compose/i);
    // payment-svc has no compose labels at all → not docker-compose-managed.
    const paymentCard = r.body.detected.find(c => c.container === 'payment-svc');
    expect(paymentCard.applyCompatible).toBe(false);
    expect(paymentCard.applyReason).toMatch(/not docker-compose/i);
  });

  it('marks applyCompatible: true when compose file exists and language is supported', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l3-detect-'));
    const composeFile = path.join(dir, 'docker-compose.yml');
    fs.writeFileSync(composeFile, 'services:\n  java-app:\n    image: openjdk:21\n', 'utf8');

    const docker = {
      listContainers: vi.fn().mockResolvedValue([{ Names: ['/java-app'] }]),
      getContainer: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({
          Name: '/java-app',
          Config: {
            Cmd: ['java', '-jar', '/app.jar'], Entrypoint: null,
            Image: 'openjdk:21-slim', Env: [],
            Labels: {
              'com.docker.compose.service': 'java-app',
              'com.docker.compose.project': 'demo',
              'com.docker.compose.config-files': composeFile,
            },
          },
        }),
      })),
    };
    const app = makeApp({ docker });
    const r = await request(app).get('/api/step-zero/instrument/detect');
    const card = r.body.detected.find(c => c.container === 'java-app');
    expect(card.applyCompatible).toBe(true);
    expect(card.applyReason).toBe(null);
  });

  it('honors 60s cache; ?refresh=1 bypasses', async () => {
    const docker = {
      listContainers: vi.fn().mockResolvedValue([]),
      getContainer: vi.fn(),
    };
    const app = makeApp({ docker });
    await request(app).get('/api/step-zero/instrument/detect');
    await request(app).get('/api/step-zero/instrument/detect');
    expect(docker.listContainers).toHaveBeenCalledTimes(1); // cached
    await request(app).get('/api/step-zero/instrument/detect?refresh=1');
    expect(docker.listContainers).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/step-zero/instrument/snippet', () => {
  it('returns compose + shell for a java/compose request', async () => {
    const app = makeApp({});
    const r = await request(app).post('/api/step-zero/instrument/snippet').send({
      language: 'java', serviceName: 'cart-api', endpointMode: 'compose',
    });
    expect(r.status).toBe(200);
    expect(r.body.compose).toContain('OTEL_SERVICE_NAME: cart-api');
    expect(r.body.compose).toContain('helix-bridge');
    expect(r.body.shell).toContain('java -javaagent');
  });

  it('400s on invalid language', async () => {
    const app = makeApp({});
    const r = await request(app).post('/api/step-zero/instrument/snippet').send({
      language: 'rust', serviceName: 'x', endpointMode: 'compose',
    });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/step-zero/instrument/verify-status', () => {
  it('returns waiting when no spans seen yet within window', async () => {
    const otelStore = {
      countSpansSinceForService: vi.fn().mockReturnValue({ count: 0, lastSeenAt: null }),
    };
    const app = makeApp({ otelStore });
    const since = Date.now() - 5000; // 5 seconds ago
    const r = await request(app).get(`/api/step-zero/instrument/verify-status?service=cart-api&since=${since}`);
    expect(r.body.status).toBe('waiting');
    expect(r.body.traceCount).toBe(0);
  });

  it('returns receiving when spans found', async () => {
    const otelStore = {
      countSpansSinceForService: vi.fn().mockReturnValue({ count: 12, lastSeenAt: Date.now() }),
    };
    const app = makeApp({ otelStore });
    const r = await request(app).get(`/api/step-zero/instrument/verify-status?service=cart-api&since=${Date.now() - 5000}`);
    expect(r.body.status).toBe('receiving');
    expect(r.body.traceCount).toBe(12);
  });

  it('returns timeout when no spans after 60s', async () => {
    const otelStore = {
      countSpansSinceForService: vi.fn().mockReturnValue({ count: 0, lastSeenAt: null }),
    };
    const app = makeApp({ otelStore });
    const since = Date.now() - 65_000; // 65s ago
    const r = await request(app).get(`/api/step-zero/instrument/verify-status?service=cart-api&since=${since}`);
    expect(r.body.status).toBe('timeout');
  });
});
```

- [ ] **Step 2: Run to verify failing**

Run: `cd backend && npx vitest run __tests__/step-zero-instrument.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/routes/step-zero/instrument.js`:

```javascript
// Step 0 Layer 3 — Instrument your apps. Three handler groups split across
// this file:
//   1. Read-only: /detect, /snippet, /verify-status
//   2. Apply state machine: /apply, /apply-status, /undo  (added in Task 6)
//   3. Passive-path verification anchor: /mark-applied  (added in Task 7)
//
// Module-scope state covers (2) and (3); the read-only handlers are
// stateless.

const fs = require('fs');
const { classifyContainer } = require('./instrument-detect');
const { renderSnippet, VALID_LANGUAGES, VALID_MODES } = require('./instrument-templates');
const { withDockerTimeout, sendDockerTimeoutResponse } = require('../../util');

// Apply-compatibility check: container must be docker-compose-managed
// (both labels present), the compose file must be readable + writable from
// our filesystem, AND the language must be one of the ones we can safely
// apply for ('node' may still be filtered later if the container's image
// doesn't have @opentelemetry/auto-instrumentations-node — that's a
// separate best-effort check we may skip for MVP).
const computeApplyCompatibility = (cls) => {
  if (!cls.composeProject || !cls.composeConfigFiles) {
    return { applyCompatible: false, applyReason: 'not docker-compose-managed' };
  }
  if (cls.language !== 'java' && cls.language !== 'node') {
    return { applyCompatible: false, applyReason: `${cls.language} requires image-level changes; apply manually` };
  }
  try {
    fs.accessSync(cls.composeConfigFiles, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return { applyCompatible: false, applyReason: 'compose file not readable/writable from the configurator' };
  }
  return { applyCompatible: true, applyReason: null };
};

// Module-scope state.
let detectCache = { ts: 0, payload: null };
const DETECT_CACHE_TTL_MS = 60_000;
const VERIFY_WINDOW_MS = 60_000;

// Reset for tests.
const __resetForTests = () => {
  detectCache = { ts: 0, payload: null };
};

// Helper used by /detect to filter out our own containers + collectors.
const shouldSkipContainer = (containerName, imageName) => {
  if (/^helix-/i.test(containerName)) return true;
  if (/^otel\/opentelemetry-collector(-contrib)?/i.test(imageName || '')) return true;
  return false;
};

function register(app, deps = {}) {
  const docker = deps.docker;
  const otelStore = deps.otelStore;

  // GET /detect — scan + classify running containers.
  app.get('/api/step-zero/instrument/detect', async (req, res) => {
    const refresh = req.query.refresh === '1';
    if (!refresh && detectCache.payload && (Date.now() - detectCache.ts) < DETECT_CACHE_TTL_MS) {
      return res.json({ ...detectCache.payload, cached: true });
    }

    try {
      const list = await withDockerTimeout(docker.listContainers(), 'docker.listContainers');
      const detected = [];
      const alreadyInstrumented = [];
      const unknown = [];
      for (const summary of list) {
        const rawName = (summary.Names?.[0] || '').replace(/^\//, '');
        // Cheap pre-check on the image from the list response, before
        // doing the more expensive inspect.
        if (shouldSkipContainer(rawName, summary.Image || '')) continue;
        let inspectData;
        try {
          inspectData = await withDockerTimeout(docker.getContainer(rawName).inspect(), 'container.inspect', 5_000);
        } catch { continue; }
        const cls = classifyContainer(inspectData);
        if (shouldSkipContainer(cls.container, cls.image)) continue;
        if (cls.alreadyInstrumented) {
          alreadyInstrumented.push({
            container: cls.container,
            serviceName: cls.suggestedServiceName,
            reason: cls.alreadyInstrumentedReason,
          });
          continue;
        }
        if (cls.language === 'unknown') {
          unknown.push({ container: cls.container, image: cls.image, reason: 'language not detected' });
          continue;
        }
        const { applyCompatible, applyReason } = computeApplyCompatibility(cls);
        detected.push({
          container: cls.container,
          image: cls.image,
          language: cls.language,
          confidence: cls.confidence,
          suggestedServiceName: cls.suggestedServiceName,
          applyCompatible,
          applyReason,
          composeProject: cls.composeProject,
          composeConfigFiles: cls.composeConfigFiles,
        });
      }
      const payload = { detected, alreadyInstrumented, unknown, scannedAt: Date.now() };
      detectCache = { ts: Date.now(), payload };
      res.json({ ...payload, cached: false });
    } catch (e) {
      if (sendDockerTimeoutResponse(res, e)) return;
      res.status(500).json({ error: 'Failed to detect containers', details: e.message });
    }
  });

  // POST /snippet — pure render of compose + shell for a language/mode.
  app.post('/api/step-zero/instrument/snippet', (req, res) => {
    const { language, serviceName, endpointMode } = req.body || {};
    if (!VALID_LANGUAGES.includes(language)) {
      return res.status(400).json({ error: `invalid language "${language}"`, valid: VALID_LANGUAGES });
    }
    if (!VALID_MODES.includes(endpointMode)) {
      return res.status(400).json({ error: `invalid endpointMode "${endpointMode}"`, valid: VALID_MODES });
    }
    if (!serviceName || typeof serviceName !== 'string') {
      return res.status(400).json({ error: 'serviceName is required' });
    }
    try {
      const out = renderSnippet({ language, serviceName, endpointMode });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /verify-status — stateless query for spans-since-timestamp.
  app.get('/api/step-zero/instrument/verify-status', (req, res) => {
    const service = String(req.query.service || '').trim();
    const sinceMs = Number(req.query.since);
    if (!service) return res.status(400).json({ error: 'service param required' });
    if (!Number.isFinite(sinceMs)) return res.status(400).json({ error: 'since param required (ms epoch)' });
    const elapsedMs = Date.now() - sinceMs;
    const { count, lastSeenAt } = otelStore.countSpansSinceForService(service, sinceMs);
    let status;
    if (count > 0) status = 'receiving';
    else if (elapsedMs < VERIFY_WINDOW_MS) status = 'waiting';
    else status = 'timeout';
    res.json({
      service,
      traceCount: count,
      lastSeenAt,
      elapsedMs,
      status,
    });
  });
}

module.exports = { register, __resetForTests };
```

- [ ] **Step 4: Run to verify passing**

Run: `cd backend && npx vitest run __tests__/step-zero-instrument.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 5: Mount the route in index.js**

Open `backend/index.js`. Find the synthetic mount line (around line 103). Insert immediately after it:

```javascript
require('./routes/step-zero/instrument').register(app, { docker, otelStore });
```

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && npx vitest run`
Expected: All tests pass, including the new ones.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/step-zero/instrument.js backend/__tests__/step-zero-instrument.test.mjs backend/index.js
git commit -m "feat(step-zero): GET /detect + POST /snippet + GET /verify-status

First three Layer 3 endpoints, all read-only/stateless:
- /detect: scan running containers, classify, return candidates +
  already-instrumented + unknown. 60s cache, ?refresh=1 bypasses.
- /snippet: pure render via instrument-templates. Used by the per-card
  endpoint toggle in the UI.
- /verify-status: stateless count of spans for a given service.name
  since a timestamp. Derives waiting/receiving/timeout status from
  count + elapsed.

The applyCompatible flag in /detect is a preview; the next task
refines it with an fs.access check on the compose file path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Apply orchestration — instrument-apply.js + POST /apply + GET /apply-status

The apply state machine. Writes the override file, downloads the Java agent (idempotent), runs `docker compose up -d --no-deps <service>`, polls for the container to settle.

**Files:**
- Create: `backend/routes/step-zero/instrument-apply.js`
- Modify: `backend/routes/step-zero/instrument.js`
- Modify: `backend/__tests__/step-zero-instrument.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `backend/__tests__/step-zero-instrument.test.mjs`:

```javascript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const writeTempCompose = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l3-apply-'));
  const file = path.join(dir, 'docker-compose.yml');
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
};

describe('POST /api/step-zero/instrument/apply', () => {
  const composeContent = `services:\n  cart-api:\n    image: openjdk:21\n`;

  it('writes the override file, kicks off compose up, returns immediately with applyState', async () => {
    const { dir, file } = writeTempCompose(composeContent);
    const inspectByName = (name) => ({
      Name: '/cart-api', Id: 'c1',
      Config: {
        Cmd: ['java', '-jar', '/app.jar'], Entrypoint: null,
        Image: 'openjdk:21-slim', Env: [],
        Labels: {
          'com.docker.compose.service': 'cart-api',
          'com.docker.compose.project': 'projectx',
          'com.docker.compose.config-files': file,
        },
      },
    });
    const docker = {
      listContainers: vi.fn().mockResolvedValue([{ Names: ['/cart-api'], Id: 'c1' }]),
      getContainer: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue(inspectByName('cart-api')),
      })),
    };
    // Stub the compose-up runner: pretend it succeeded immediately.
    const composeUp = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    // Stub the agent download to a no-op (the volume already exists).
    const ensureJavaAgentVolume = vi.fn().mockResolvedValue();
    // Stub the post-recreate wait — return running immediately.
    const waitForContainerUp = vi.fn().mockResolvedValue({ running: true });
    const app = makeApp({ docker, composeUp, ensureJavaAgentVolume, waitForContainerUp });

    const r = await request(app).post('/api/step-zero/instrument/apply').send({ container: 'cart-api' });
    expect(r.status).toBe(200);
    expect(r.body.container).toBe('cart-api');
    expect(r.body.applyState).toMatch(/recreating|writing-override|applied/);
    expect(r.body.overrideFilePath).toBe(path.join(dir, 'docker-compose.helix-instrument.yml'));

    // Wait briefly for the async loop to settle.
    await new Promise(r => setTimeout(r, 100));
    const status = await request(app).get('/api/step-zero/instrument/apply-status?container=cart-api');
    expect(['recreating', 'applied']).toContain(status.body.applyState);
    expect(composeUp).toHaveBeenCalled();
  });

  it('rolls back the override file on compose-up failure', async () => {
    const { dir, file } = writeTempCompose(composeContent);
    const docker = {
      listContainers: vi.fn().mockResolvedValue([{ Names: ['/cart-api'], Id: 'c1' }]),
      getContainer: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({
          Name: '/cart-api',
          Config: {
            Cmd: ['java', '-jar', '/app.jar'], Entrypoint: null,
            Image: 'openjdk:21-slim', Env: [],
            Labels: {
              'com.docker.compose.service': 'cart-api',
              'com.docker.compose.project': 'projectx',
              'com.docker.compose.config-files': file,
            },
          },
        }),
      })),
    };
    const composeUp = vi.fn().mockRejectedValue(new Error('compose up failed: image not found'));
    const ensureJavaAgentVolume = vi.fn().mockResolvedValue();
    const waitForContainerUp = vi.fn();
    const app = makeApp({ docker, composeUp, ensureJavaAgentVolume, waitForContainerUp });

    await request(app).post('/api/step-zero/instrument/apply').send({ container: 'cart-api' });
    await new Promise(r => setTimeout(r, 200));
    const status = await request(app).get('/api/step-zero/instrument/apply-status?container=cart-api');
    expect(status.body.applyState).toBe('failed');
    expect(status.body.error).toMatch(/image not found/);
    // Override file should have been removed.
    expect(fs.existsSync(path.join(dir, 'docker-compose.helix-instrument.yml'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failing**

Run: `cd backend && npx vitest run __tests__/step-zero-instrument.test.mjs`
Expected: the new tests FAIL with 404 (POST /apply not registered yet). Existing tests still pass.

- [ ] **Step 3: Create instrument-apply.js**

Create `backend/routes/step-zero/instrument-apply.js`:

```javascript
// Step 0 Layer 3 — apply/undo orchestration. Writes a non-destructive
// docker-compose.helix-instrument.yml override next to the user's main
// compose file, then runs `docker compose -f <main> -f <override> up -d
// --no-deps <service>` to recreate the user's container with OTel env
// vars + (Java) the agent JAR mount + (compose mode) the helix-bridge
// network attached. Rolls back the override on any failure.
//
// All I/O paths are dependency-injected so tests can stub them.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const OVERRIDE_FILE_NAME = 'docker-compose.helix-instrument.yml';
const JAVA_AGENT_VOLUME = 'helix-otel-agents';
const JAVA_AGENT_URL = 'https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar';

// Default: spawn docker compose via execFile. Replaceable in tests.
const defaultComposeUp = ({ project, mainFile, overrideFile, service }) =>
  new Promise((resolve, reject) => {
    execFile('docker', ['compose', '-p', project, '-f', mainFile, '-f', overrideFile, 'up', '-d', '--no-deps', service], (err, stdout, stderr) => {
      if (err) return reject(new Error(`docker compose up failed: ${stderr || err.message}`));
      resolve({ stdout, stderr });
    });
  });

const defaultComposeUpNoOverride = ({ project, mainFile, service }) =>
  new Promise((resolve, reject) => {
    execFile('docker', ['compose', '-p', project, '-f', mainFile, 'up', '-d', '--no-deps', service], (err, stdout, stderr) => {
      if (err) return reject(new Error(`docker compose up (no-override) failed: ${stderr || err.message}`));
      resolve({ stdout, stderr });
    });
  });

// Default: populate the named Docker volume with the OTel Java agent JAR
// using a one-shot busybox container. Idempotent — checks if the volume
// already has the JAR first.
const defaultEnsureJavaAgentVolume = async ({ docker }) => {
  const volumes = await docker.listVolumes();
  const exists = (volumes.Volumes || []).some(v => v.Name === JAVA_AGENT_VOLUME);
  if (!exists) await docker.createVolume({ Name: JAVA_AGENT_VOLUME });
  // Use a one-shot busybox to test for the JAR + download if needed.
  // (The busybox image is widely cached; if not, this pulls ~5MB.)
  await new Promise((resolve, reject) => {
    docker.run(
      'busybox:latest',
      ['sh', '-c', `if [ ! -f /target/opentelemetry-javaagent.jar ]; then wget -q -O /target/opentelemetry-javaagent.jar "${JAVA_AGENT_URL}"; fi`],
      process.stdout,
      { HostConfig: { Binds: [`${JAVA_AGENT_VOLUME}:/target`], AutoRemove: true } },
      (err) => err ? reject(err) : resolve()
    );
  });
};

// Wait until a container is in `running` state with StartedAt > 5s ago,
// or timeoutMs elapses. Mirrors config.js#waitForGatewaySettle.
const defaultWaitForContainerUp = async ({ docker, container, timeoutMs = 30_000 }) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const inspect = await docker.getContainer(container).inspect();
      const state = inspect?.State || {};
      const startedAt = state.StartedAt ? Date.parse(state.StartedAt) : 0;
      const upMs = startedAt ? Date.now() - startedAt : 0;
      if (state.Status === 'running' && upMs >= 5_000) {
        return { running: true, state };
      }
      if (state.Status === 'exited') {
        return { running: false, state, exitCode: state.ExitCode };
      }
    } catch { /* container missing momentarily during recreate */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return { running: false, state: null, timeout: true };
};

// Build the override YAML body for a given language + service.
const buildOverrideYaml = ({ language, serviceName }) => {
  const lines = [
    `# Auto-generated by Helix Configurator Step 0 Layer 3.`,
    `# This file is managed by the configurator's "Apply for me" flow.`,
    `# Delete it (and run \`docker compose up -d\`) to revert.`,
    `services:`,
    `  ${serviceName}:`,
    `    environment:`,
    `      OTEL_SERVICE_NAME: ${serviceName}`,
    `      OTEL_EXPORTER_OTLP_ENDPOINT: http://helix-gateway:4318`,
    `      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf`,
    `      OTEL_RESOURCE_ATTRIBUTES: deployment.environment=dev,service.namespace=step-zero-instrumented`,
  ];
  if (language === 'java') {
    lines.push(`      JAVA_TOOL_OPTIONS: "-javaagent:/otel-agent/opentelemetry-javaagent.jar"`);
    lines.push(`    volumes:`);
    lines.push(`      - ${JAVA_AGENT_VOLUME}:/otel-agent:ro`);
  }
  if (language === 'node') {
    lines.push(`      NODE_OPTIONS: "--require @opentelemetry/auto-instrumentations-node/register"`);
  }
  lines.push(`    networks:`);
  lines.push(`      - helix-bridge`);
  lines.push(``);
  lines.push(`networks:`);
  lines.push(`  helix-bridge:`);
  lines.push(`    external: true`);
  if (language === 'java') {
    lines.push(``);
    lines.push(`volumes:`);
    lines.push(`  ${JAVA_AGENT_VOLUME}:`);
    lines.push(`    external: true`);
  }
  return lines.join('\n') + '\n';
};

// applyToService: the whole flow. Returns immediately by virtue of being
// called via a fire-and-forget loop in instrument.js; updates the state
// object in place as it progresses.
const applyToService = async ({ state, classification, deps }) => {
  const composeDir = path.dirname(classification.composeConfigFiles);
  const overrideFilePath = path.join(composeDir, OVERRIDE_FILE_NAME);
  state.overrideFilePath = overrideFilePath;

  try {
    if (classification.language === 'java') {
      state.applyState = 'downloading-agent';
      await (deps.ensureJavaAgentVolume || defaultEnsureJavaAgentVolume)({ docker: deps.docker });
    }
    state.applyState = 'writing-override';
    const yaml = buildOverrideYaml({ language: classification.language, serviceName: classification.suggestedServiceName });
    fs.writeFileSync(overrideFilePath, yaml, 'utf8');

    state.applyState = 'recreating';
    await (deps.composeUp || defaultComposeUp)({
      project: classification.composeProject,
      mainFile: classification.composeConfigFiles,
      overrideFile: overrideFilePath,
      service: classification.suggestedServiceName,
    });

    state.applyState = 'waiting-for-up';
    const settled = await (deps.waitForContainerUp || defaultWaitForContainerUp)({
      docker: deps.docker, container: state.container,
    });
    if (!settled.running) {
      throw new Error(`container did not reach running state${settled.timeout ? ' (timed out)' : (settled.exitCode != null ? ` (exit code ${settled.exitCode})` : '')}`);
    }
    state.applyState = 'applied';
    state.appliedAt = Date.now();
  } catch (e) {
    state.applyState = 'rolling-back';
    // Best-effort: remove the override and recreate without it.
    try { fs.unlinkSync(overrideFilePath); } catch { /* may not exist if write hadn't completed */ }
    try {
      await (deps.composeUpNoOverride || defaultComposeUpNoOverride)({
        project: classification.composeProject,
        mainFile: classification.composeConfigFiles,
        service: classification.suggestedServiceName,
      });
    } catch { /* best effort */ }
    state.applyState = 'failed';
    state.error = e.message;
  }
};

const undoForService = async ({ state, classification, deps }) => {
  if (!state.overrideFilePath) {
    throw new Error('No override file recorded for this container');
  }
  try { fs.unlinkSync(state.overrideFilePath); } catch { /* may have been removed already */ }
  await (deps.composeUpNoOverride || defaultComposeUpNoOverride)({
    project: classification.composeProject,
    mainFile: classification.composeConfigFiles,
    service: classification.suggestedServiceName,
  });
  state.applyState = 'idle';
  state.appliedAt = null;
  state.error = null;
  state.overrideFilePath = null;
};

module.exports = {
  applyToService,
  undoForService,
  buildOverrideYaml,
  OVERRIDE_FILE_NAME,
  JAVA_AGENT_VOLUME,
};
```

- [ ] **Step 4: Wire /apply + /apply-status into instrument.js**

Open `backend/routes/step-zero/instrument.js`. After the `register` function's existing handlers and before the closing `}`, add:

```javascript
  // POST /apply — kick off the apply flow for a container. Returns
  // immediately with the initial apply-state; the flow runs async.
  app.post('/api/step-zero/instrument/apply', async (req, res) => {
    const container = (req.body || {}).container;
    if (!container || typeof container !== 'string') {
      return res.status(400).json({ error: 'container param required' });
    }
    if (applyStates.get(container)?.applyState && !['idle', 'failed'].includes(applyStates.get(container).applyState)) {
      return res.status(409).json({ error: 'apply already in progress', current: applyStates.get(container) });
    }
    // Re-inspect (don't trust the cache for write operations).
    let classification;
    try {
      const inspect = await withDockerTimeout(docker.getContainer(container).inspect(), 'container.inspect', 5_000);
      classification = classifyContainer(inspect);
    } catch (e) {
      if (sendDockerTimeoutResponse(res, e)) return;
      return res.status(404).json({ error: `container ${container} not found`, details: e.message });
    }
    if (!classification.composeProject || !classification.composeConfigFiles) {
      return res.status(400).json({ error: 'container is not docker-compose-managed' });
    }
    const state = {
      container,
      applyState: 'confirming',
      appliedAt: null,
      overrideFilePath: null,
      error: null,
      serviceName: classification.suggestedServiceName,
    };
    applyStates.set(container, state);
    res.json(state);
    // Fire and forget.
    require('./instrument-apply').applyToService({
      state, classification, deps: {
        docker,
        composeUp: deps.composeUp,
        composeUpNoOverride: deps.composeUpNoOverride,
        ensureJavaAgentVolume: deps.ensureJavaAgentVolume,
        waitForContainerUp: deps.waitForContainerUp,
      },
    }).catch(() => { /* state already records the error */ });
  });

  // GET /apply-status — poll the in-memory apply-state for a container.
  app.get('/api/step-zero/instrument/apply-status', (req, res) => {
    const container = String(req.query.container || '');
    if (!container) return res.status(400).json({ error: 'container param required' });
    const state = applyStates.get(container);
    if (!state) return res.json({ container, applyState: 'idle' });
    res.json(state);
  });
```

Also, at the top of the module-scope state section (above `let detectCache = ...`), add:

```javascript
const applyStates = new Map(); // container name → state object
```

And update `__resetForTests`:

```javascript
const __resetForTests = () => {
  detectCache = { ts: 0, payload: null };
  applyStates.clear();
};
```

- [ ] **Step 5: Run to verify passing**

Run: `cd backend && npx vitest run __tests__/step-zero-instrument.test.mjs`
Expected: PASS — all tests including the two new apply tests.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/step-zero/instrument-apply.js backend/routes/step-zero/instrument.js backend/__tests__/step-zero-instrument.test.mjs
git commit -m "feat(step-zero): POST /apply + GET /apply-status + apply orchestration

Writes docker-compose.helix-instrument.yml next to the user's main
compose file, downloads the Java agent into a managed Docker volume
(idempotent), runs \`docker compose -f <main> -f <override> up -d
--no-deps <service>\` to recreate the container with OTel env vars +
helix-bridge network, polls for it to reach running state. Rolls back
the override file on any failure.

All I/O paths are dependency-injected so tests can stub them without
actually touching docker. State machine: confirming → downloading-agent
→ writing-override → recreating → waiting-for-up → applied | failed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: POST /undo + POST /mark-applied + apply-compatible refinement

The remaining backend endpoints. Undo reverses an apply. `/mark-applied` is the passive-path "I applied the snippet manually" affordance — just records a verification anchor.

**Files:**
- Modify: `backend/routes/step-zero/instrument.js`
- Modify: `backend/__tests__/step-zero-instrument.test.mjs`

- [ ] **Step 1: Write failing tests**

Append to `backend/__tests__/step-zero-instrument.test.mjs`:

```javascript
describe('POST /api/step-zero/instrument/mark-applied', () => {
  it('records the anchor and the next /verify-status uses the same since', async () => {
    const otelStore = {
      countSpansSinceForService: vi.fn().mockReturnValue({ count: 5, lastSeenAt: Date.now() }),
    };
    const app = makeApp({ otelStore });
    const before = Date.now();
    const r = await request(app).post('/api/step-zero/instrument/mark-applied').send({
      container: 'cart-api',
      serviceName: 'cart-api',
    });
    expect(r.status).toBe(200);
    expect(r.body.since).toBeGreaterThanOrEqual(before);

    const status = await request(app).get(`/api/step-zero/instrument/verify-status?service=cart-api&since=${r.body.since}`);
    expect(status.body.status).toBe('receiving');
  });
});

describe('POST /api/step-zero/instrument/undo', () => {
  it('removes the override file and recreates the service without it', async () => {
    const { dir, file } = writeTempCompose(`services:\n  cart-api:\n    image: openjdk:21\n`);
    // Pretend a previous apply already happened.
    const overridePath = path.join(dir, 'docker-compose.helix-instrument.yml');
    fs.writeFileSync(overridePath, 'fake override content', 'utf8');
    expect(fs.existsSync(overridePath)).toBe(true);

    const docker = {
      listContainers: vi.fn().mockResolvedValue([{ Names: ['/cart-api'] }]),
      getContainer: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({
          Name: '/cart-api',
          Config: {
            Cmd: ['java', '-jar', '/app.jar'], Entrypoint: null,
            Image: 'openjdk:21-slim', Env: [],
            Labels: {
              'com.docker.compose.service': 'cart-api',
              'com.docker.compose.project': 'projectx',
              'com.docker.compose.config-files': file,
            },
          },
        }),
      })),
    };
    const composeUpNoOverride = vi.fn().mockResolvedValue({});
    const app = makeApp({ docker, composeUpNoOverride });

    // Seed apply state to "applied" so undo has something to revert.
    // (Reach in via __resetForTests + a tiny helper would be cleaner;
    // for this test we set up via a real /apply call but stub everything
    // to succeed instantly.)
    const composeUp = vi.fn().mockResolvedValue({});
    const ensureJavaAgentVolume = vi.fn().mockResolvedValue();
    const waitForContainerUp = vi.fn().mockResolvedValue({ running: true });
    const seededApp = makeApp({ docker, composeUp, composeUpNoOverride, ensureJavaAgentVolume, waitForContainerUp });
    await request(seededApp).post('/api/step-zero/instrument/apply').send({ container: 'cart-api' });
    await new Promise(r => setTimeout(r, 100));

    const r = await request(seededApp).post('/api/step-zero/instrument/undo').send({ container: 'cart-api' });
    expect(r.status).toBe(200);
    expect(r.body.undone).toBe(true);
    expect(fs.existsSync(overridePath)).toBe(false);
    expect(composeUpNoOverride).toHaveBeenCalled();
  });

  it('404s when there is no apply state for the container', async () => {
    const app = makeApp({ docker: { listContainers: vi.fn(), getContainer: vi.fn() } });
    const r = await request(app).post('/api/step-zero/instrument/undo').send({ container: 'nonexistent' });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failing**

Run: `cd backend && npx vitest run __tests__/step-zero-instrument.test.mjs`
Expected: the new tests FAIL with 404 (routes not registered).

- [ ] **Step 3: Add handlers + state**

Open `backend/routes/step-zero/instrument.js`. Add this state declaration alongside the others:

```javascript
const verifyAnchors = new Map(); // container → { serviceName, since }
```

Update `__resetForTests`:

```javascript
const __resetForTests = () => {
  detectCache = { ts: 0, payload: null };
  applyStates.clear();
  verifyAnchors.clear();
};
```

Add an exported `clearAllApplied()` helper (used by reset-onboarding):

```javascript
const clearAllApplied = () => {
  applyStates.clear();
  verifyAnchors.clear();
};
```

Inside `register()`, after the existing handlers, add:

```javascript
  // POST /mark-applied — passive-path "I applied the snippet manually".
  // Just records the verification anchor.
  app.post('/api/step-zero/instrument/mark-applied', (req, res) => {
    const { container, serviceName } = req.body || {};
    if (!container || !serviceName) {
      return res.status(400).json({ error: 'container and serviceName required' });
    }
    const since = Date.now();
    verifyAnchors.set(container, { serviceName, since });
    res.json({ container, serviceName, since });
  });

  // POST /undo — revert a previous apply.
  app.post('/api/step-zero/instrument/undo', async (req, res) => {
    const container = (req.body || {}).container;
    if (!container) return res.status(400).json({ error: 'container required' });
    const state = applyStates.get(container);
    if (!state || !state.overrideFilePath) {
      return res.status(404).json({ error: 'no apply to undo for this container' });
    }
    try {
      const inspect = await withDockerTimeout(docker.getContainer(container).inspect(), 'container.inspect', 5_000);
      const classification = classifyContainer(inspect);
      await require('./instrument-apply').undoForService({
        state, classification, deps: { docker, composeUpNoOverride: deps.composeUpNoOverride },
      });
      applyStates.delete(container);
      verifyAnchors.delete(container);
      res.json({ undone: true, container });
    } catch (e) {
      if (sendDockerTimeoutResponse(res, e)) return;
      res.status(500).json({ error: 'undo failed', details: e.message });
    }
  });
```

Also update `module.exports` at the bottom of the file:

```javascript
module.exports = { register, __resetForTests, clearAllApplied };
```

- [ ] **Step 4: Run to verify**

Run: `cd backend && npx vitest run __tests__/step-zero-instrument.test.mjs`
Expected: PASS — all tests including new ones.

- [ ] **Step 5: Wire clearAllApplied into reset-onboarding**

Open `backend/routes/lifecycle.js`. Find the `clearSyntheticRun` import (added by Layer 2). Add a sibling import:

```javascript
const { clearAllApplied: clearInstrumentApplied } = require('./step-zero/instrument');
```

In the `reset-onboarding` handler, find the `clearSyntheticRun()` call (step 0). Right after it, add:

```javascript
    try { clearInstrumentApplied(); } catch { /* best effort */ }
```

- [ ] **Step 6: Run full backend suite**

Run: `cd backend && npx vitest run`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/step-zero/instrument.js backend/__tests__/step-zero-instrument.test.mjs backend/routes/lifecycle.js
git commit -m "feat(step-zero): POST /undo + POST /mark-applied; reset-onboarding clears applied state

Three additions:
- /mark-applied records the verification anchor (since timestamp) for
  the passive path so the user's manual snippet-paste gets the same
  verification feedback as Apply-for-me.
- /undo deletes the override file and reruns docker compose up -d
  --no-deps <service> without it, then clears apply + verify state.
- reset-onboarding now also calls clearAllApplied() so resets wipe
  Layer 3's in-memory state alongside Layer 2's synthetic run state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Frontend types + Layer3Instrument shell with collapsible

Frontend foundation. The collapsible panel that fetches /detect and renders nothing visible until expanded.

**Files:**
- Create: `frontend/src/components/step-zero/instrument-types.ts`
- Create: `frontend/src/components/step-zero/Layer3Instrument.tsx`

- [ ] **Step 1: Create instrument-types.ts**

Create `frontend/src/components/step-zero/instrument-types.ts`:

```typescript
// Backend response shapes for /api/step-zero/instrument/*.
// Kept in sync with backend/routes/step-zero/instrument.js by convention
// (no shared schema; if the backend changes, update here).

export type Language = 'java' | 'python' | 'dotnet' | 'node';
export type EndpointMode = 'compose' | 'standalone' | 'host';

export type DetectedContainer = {
  container: string;
  image: string;
  language: Language;
  confidence: 'high' | 'low';
  suggestedServiceName: string;
  applyCompatible: boolean;
  applyReason: string | null;
  composeProject: string | null;
  composeConfigFiles: string | null;
};

export type AlreadyInstrumented = {
  container: string;
  serviceName: string;
  reason: string;
};

export type DetectResponse = {
  detected: DetectedContainer[];
  alreadyInstrumented: AlreadyInstrumented[];
  unknown: { container: string; image: string; reason: string }[];
  scannedAt: number;
  cached?: boolean;
};

export type SnippetResponse = {
  compose: string;
  shell: string;
  prereqs: string;
  agentDownload: string | null;
};

export type ApplyState =
  | 'idle'
  | 'confirming'
  | 'downloading-agent'
  | 'writing-override'
  | 'recreating'
  | 'waiting-for-up'
  | 'applied'
  | 'failed'
  | 'rolling-back';

export type ApplyStatusResponse = {
  container: string;
  applyState: ApplyState;
  appliedAt: number | null;
  overrideFilePath: string | null;
  error: string | null;
  serviceName?: string;
};

export type VerifyStatus = 'waiting' | 'receiving' | 'timeout';

export type VerifyStatusResponse = {
  service: string;
  traceCount: number;
  lastSeenAt: number | null;
  elapsedMs: number;
  status: VerifyStatus;
};
```

- [ ] **Step 2: Create Layer3Instrument.tsx (collapsible shell)**

Create `frontend/src/components/step-zero/Layer3Instrument.tsx`:

```tsx
import React, { useEffect, useState, useCallback } from 'react';
import { ChevronRight, RefreshCw } from 'lucide-react';
import type { DetectResponse } from './instrument-types';

const COLLAPSED_KEY = 'helix-configurator.layer3.collapsed';

export const Layer3Instrument: React.FC = () => {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch { return false; }
  });
  const [detect, setDetect] = useState<DetectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchDetect = useCallback(async (refresh = false) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/step-zero/instrument/detect${refresh ? '?refresh=1' : ''}`, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as DetectResponse;
      setDetect(data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount (or expand from collapsed). Skip while collapsed to
  // avoid unnecessary docker calls.
  useEffect(() => {
    if (collapsed) return;
    if (!detect) fetchDetect(false);
  }, [collapsed, detect, fetchDetect]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch {}
  };

  const candidateCount = detect?.detected.length ?? 0;
  const summary = collapsed
    ? (detect ? `${candidateCount} candidate${candidateCount === 1 ? '' : 's'} detected — click to expand` : 'click to expand')
    : '';

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-1000">
      <header
        className="flex items-center justify-between px-6 py-4 cursor-pointer select-none"
        onClick={toggle}
        role="button"
        aria-expanded={!collapsed}
      >
        <div className="flex items-center gap-3">
          <ChevronRight
            className={`w-4 h-4 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          <div>
            <div className="text-tiny uppercase tracking-wider text-blue-300 mb-0.5">Instrument your apps</div>
            <div className="text-base font-semibold text-gray-100">
              {collapsed ? 'Auto-instrument detected runtimes' : 'Detected runtimes'}
            </div>
          </div>
        </div>
        {collapsed && summary && (
          <div className="text-tiny text-gray-500">{summary}</div>
        )}
        {!collapsed && (
          <button
            onClick={(e) => { e.stopPropagation(); fetchDetect(true); }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-tiny text-gray-400 hover:text-gray-200 disabled:opacity-60"
            title="Rescan now (bypass cache)"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Rescan
          </button>
        )}
      </header>

      {!collapsed && (
        <div className="px-6 pb-6">
          {err && (
            <div className="rounded border border-red-900 bg-red-950/40 text-red-200 text-sm p-3 mb-3">
              Failed to detect containers: {err}
            </div>
          )}
          {loading && !detect && (
            <div className="text-tiny text-gray-500">Scanning running containers…</div>
          )}
          {detect && detect.detected.length === 0 && (
            <div className="rounded border border-gray-800 bg-gray-1100 p-4 text-sm text-gray-400">
              No instrumentable runtimes detected. Layer 3 looks for Java, Python, .NET, and Node
              containers running on this host. If you have apps in other languages, see the OpenTelemetry
              language pages directly.
            </div>
          )}
          {detect && detect.detected.length > 0 && (
            <div className="space-y-3">
              {/* RuntimeCard list lands in Task 9. For now: stub list. */}
              {detect.detected.map(c => (
                <div key={c.container} className="rounded border border-gray-800 bg-gray-1100 p-4 text-sm">
                  <span className="font-mono text-gray-200">{c.container}</span>{' '}
                  <span className="text-tiny uppercase text-blue-300">{c.language}</span>{' '}
                  <span className="text-tiny text-gray-500">→ service.name=<code>{c.suggestedServiceName}</code></span>
                </div>
              ))}
            </div>
          )}
          {detect && detect.alreadyInstrumented.length > 0 && (
            <details className="mt-4 text-tiny text-gray-500">
              <summary className="cursor-pointer hover:text-gray-300">
                {detect.alreadyInstrumented.length} container{detect.alreadyInstrumented.length === 1 ? '' : 's'} already instrumented
              </summary>
              <ul className="mt-2 space-y-1 ml-4">
                {detect.alreadyInstrumented.map(c => (
                  <li key={c.container}>
                    <code className="font-mono text-gray-300">{c.container}</code> — {c.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {detect && detect.unknown.length > 0 && (
            <details className="mt-3 text-tiny text-gray-500">
              <summary className="cursor-pointer hover:text-gray-300">
                {detect.unknown.length} unrecognized container{detect.unknown.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-2 space-y-1 ml-4">
                {detect.unknown.map(c => (
                  <li key={c.container}>
                    <code className="font-mono text-gray-300">{c.container}</code> ({c.image}) — {c.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
};
```

- [ ] **Step 3: Build to verify TypeScript**

Run: `cd /Users/jammicha/dev/HelixConfigurator/frontend && npm run build`
Expected: `tsc && vite build` succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/step-zero/instrument-types.ts frontend/src/components/step-zero/Layer3Instrument.tsx
git commit -m "feat(step-zero): Layer3Instrument collapsible shell + types

Collapsible panel header with chevron, collapsed-state summary
('N candidates detected'), and localStorage persistence under
helix-configurator.layer3.collapsed. When collapsed, the body is
not rendered and /detect is not called — saves docker round-trips
for users who only want the demo.

When expanded, fetches /detect on mount, renders a stub list of
detected runtimes (real card lands in the next task), and exposes
'already-instrumented' and 'unknown' as collapsed details disclosures.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: RuntimeCard component — endpoint toggle, snippet display, Apply / I-applied buttons

The meaty frontend work: one card per detected container with the full UX (toggle, two snippet tabs, two action buttons, status pill).

**Files:**
- Create: `frontend/src/components/step-zero/RuntimeCard.tsx`
- Modify: `frontend/src/components/step-zero/Layer3Instrument.tsx` (use RuntimeCard instead of stub)

- [ ] **Step 1: Create RuntimeCard.tsx**

Create `frontend/src/components/step-zero/RuntimeCard.tsx`:

```tsx
import React, { useEffect, useState, useCallback } from 'react';
import { Copy, Loader2, Check, Play, Undo2, ExternalLink, AlertTriangle, Clock } from 'lucide-react';
import type {
  DetectedContainer, EndpointMode, SnippetResponse, ApplyStatusResponse, VerifyStatusResponse,
} from './instrument-types';

type Props = {
  container: DetectedContainer;
};

const APPLY_SUPPORTED_LANGS = ['java', 'node'] as const;
type ApplySupportedLang = typeof APPLY_SUPPORTED_LANGS[number];
const isApplySupported = (lang: string): lang is ApplySupportedLang =>
  (APPLY_SUPPORTED_LANGS as readonly string[]).includes(lang);

export const RuntimeCard: React.FC<Props> = ({ container: c }) => {
  const [endpointMode, setEndpointMode] = useState<EndpointMode>('compose');
  const [snippetTab, setSnippetTab] = useState<'compose' | 'shell'>('compose');
  const [snippet, setSnippet] = useState<SnippetResponse | null>(null);
  const [copied, setCopied] = useState<'compose' | 'shell' | null>(null);
  const [applyState, setApplyState] = useState<ApplyStatusResponse | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<VerifyStatusResponse | null>(null);
  const [verifyAnchor, setVerifyAnchor] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Fetch snippet whenever language / serviceName / endpointMode changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/step-zero/instrument/snippet', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language: c.language, serviceName: c.suggestedServiceName, endpointMode }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as SnippetResponse;
        if (!cancelled) setSnippet(data);
      } catch { /* transient; user can interact again */ }
    })();
    return () => { cancelled = true; };
  }, [c.language, c.suggestedServiceName, endpointMode]);

  // Poll apply-status while a non-terminal apply is in flight.
  useEffect(() => {
    if (!applyState) return;
    const terminal = ['idle', 'applied', 'failed'].includes(applyState.applyState);
    if (terminal) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`/api/step-zero/instrument/apply-status?container=${encodeURIComponent(c.container)}`, { credentials: 'include' });
        if (!r.ok) return;
        const data = (await r.json()) as ApplyStatusResponse;
        setApplyState(data);
        if (data.applyState === 'applied' && !verifyAnchor) {
          // Apply just completed — kick off verification window.
          setVerifyAnchor(data.appliedAt ?? Date.now());
        }
      } catch {}
    }, 1000);
    return () => clearInterval(id);
  }, [applyState, verifyAnchor, c.container]);

  // Poll verify-status while we have an anchor + status isn't terminal.
  useEffect(() => {
    if (!verifyAnchor) return;
    const tick = async () => {
      try {
        const r = await fetch(`/api/step-zero/instrument/verify-status?service=${encodeURIComponent(c.suggestedServiceName)}&since=${verifyAnchor}`, { credentials: 'include' });
        if (!r.ok) return;
        const data = (await r.json()) as VerifyStatusResponse;
        setVerifyState(data);
      } catch {}
    };
    tick();
    // 2s while waiting; 10s while receiving; stop polling on timeout.
    const cadence = verifyState?.status === 'receiving' ? 10_000 : 2_000;
    if (verifyState?.status === 'timeout') return;
    const id = setInterval(tick, cadence);
    return () => clearInterval(id);
  }, [verifyAnchor, c.suggestedServiceName, verifyState?.status]);

  const copy = async (kind: 'compose' | 'shell') => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(kind === 'compose' ? snippet.compose : snippet.shell);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  };

  const startApplyConfirm = () => setConfirming(true);
  const cancelApply = () => setConfirming(false);
  const submitApply = async () => {
    setConfirming(false);
    setApplyError(null);
    try {
      const r = await fetch('/api/step-zero/instrument/apply', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container: c.container }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as ApplyStatusResponse;
      setApplyState(data);
    } catch (e) {
      setApplyError((e as Error).message);
    }
  };

  const markApplied = async () => {
    try {
      const r = await fetch('/api/step-zero/instrument/mark-applied', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container: c.container, serviceName: c.suggestedServiceName }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setVerifyAnchor(data.since);
      setVerifyState(null); // force next poll to populate
    } catch {}
  };

  const undo = async () => {
    try {
      await fetch('/api/step-zero/instrument/undo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container: c.container }),
      });
      setApplyState(null);
      setVerifyAnchor(null);
      setVerifyState(null);
    } catch {}
  };

  const applySupported = isApplySupported(c.language) && c.applyCompatible;
  const isApplying = applyState && !['idle', 'applied', 'failed'].includes(applyState.applyState);
  const isApplied = applyState?.applyState === 'applied';
  const isFailed = applyState?.applyState === 'failed';

  return (
    <div className="rounded border border-gray-800 bg-gray-1100 p-4">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="font-mono text-sm text-gray-100 truncate">{c.container}</div>
          <div className="text-tiny text-gray-500 truncate">{c.image}</div>
        </div>
        <span className="text-tiny uppercase tracking-wider text-blue-300">{c.language}</span>
      </div>

      <div className="text-tiny text-gray-400 mb-3">
        Suggested <code className="font-mono text-gray-300">service.name = {c.suggestedServiceName}</code>
        {c.confidence === 'low' && <span className="ml-2 inline-flex items-center gap-1 text-amber-400"><AlertTriangle className="w-3 h-3" /> low confidence — verify before applying</span>}
      </div>

      <div className="mb-3">
        <div className="text-tiny uppercase tracking-wider text-gray-500 mb-1">Endpoint context</div>
        <div className="flex items-center gap-1 text-tiny">
          {(['compose', 'standalone', 'host'] as EndpointMode[]).map(m => (
            <button
              key={m}
              onClick={() => setEndpointMode(m)}
              className={`px-2 py-1 rounded ${endpointMode === m ? 'bg-primary/30 text-primary' : 'text-gray-400 hover:text-gray-200'}`}
            >
              {m === 'compose' ? 'Docker compose' : m === 'standalone' ? 'Standalone container' : 'Host process'}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1 text-tiny">
            {(['compose', 'shell'] as const).map(t => (
              <button
                key={t}
                onClick={() => setSnippetTab(t)}
                className={`px-2 py-1 rounded uppercase tracking-wider ${snippetTab === t ? 'bg-gray-800 text-gray-100' : 'text-gray-500 hover:text-gray-300'}`}
              >
                {t === 'compose' ? 'Compose patch' : 'Shell wrapper'}
              </button>
            ))}
          </div>
          <button
            onClick={() => copy(snippetTab)}
            disabled={!snippet}
            className="inline-flex items-center gap-1 text-tiny text-gray-400 hover:text-gray-200 disabled:opacity-60"
          >
            {copied === snippetTab ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied === snippetTab ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="bg-gray-1000 border border-gray-800 rounded p-3 text-tiny font-mono text-gray-200 overflow-x-auto whitespace-pre">
{snippet ? (snippetTab === 'compose' ? snippet.compose : snippet.shell) : 'Loading…'}
        </pre>
        {snippet?.prereqs && (
          <div className="text-tiny text-gray-500 mt-1.5 whitespace-pre-wrap">{snippet.prereqs}</div>
        )}
      </div>

      {confirming ? (
        <div className="rounded border border-blue-900 bg-blue-950/30 p-3 text-tiny text-blue-100 mb-2">
          <div className="font-semibold mb-1">About to instrument {c.container} for OpenTelemetry</div>
          <div className="text-blue-200/80 mb-2">
            We'll create <code className="font-mono">{c.composeConfigFiles ? c.composeConfigFiles.replace(/\/[^\/]+$/, '/docker-compose.helix-instrument.yml') : 'docker-compose.helix-instrument.yml'}</code> next to your compose file and recreate <code className="font-mono">{c.suggestedServiceName}</code>. About 30s of downtime.
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={cancelApply} className="text-tiny text-gray-300 hover:text-gray-100 px-2 py-1">Cancel</button>
            <button onClick={submitApply} className="text-tiny bg-primary text-white rounded px-3 py-1 hover:bg-primary/90">Apply</button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap">
        {applySupported && !isApplied && !isApplying && (
          <button
            onClick={startApplyConfirm}
            className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-tiny font-semibold text-white hover:bg-primary/90"
          >
            <Play className="w-3.5 h-3.5" /> Apply for me
          </button>
        )}
        {isApplying && (
          <button disabled className="inline-flex items-center gap-1.5 rounded bg-primary/60 px-3 py-1.5 text-tiny font-semibold text-white">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {applyState!.applyState}…
          </button>
        )}
        {isApplied && (
          <>
            <span className="inline-flex items-center gap-1.5 rounded bg-green-950/40 border border-green-900 px-3 py-1.5 text-tiny font-semibold text-green-200">
              <Check className="w-3.5 h-3.5" /> Applied
            </span>
            <button onClick={undo} className="inline-flex items-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-tiny text-gray-200 hover:bg-gray-900">
              <Undo2 className="w-3.5 h-3.5" /> Undo
            </button>
          </>
        )}
        {!isApplying && !isApplied && (
          <button onClick={markApplied} className="inline-flex items-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-tiny text-gray-200 hover:bg-gray-900">
            I applied the snippet
          </button>
        )}

        {/* Apply error inline */}
        {(isFailed || applyError) && (
          <div className="text-tiny text-red-300">
            {applyError || applyState!.error}
          </div>
        )}

        {/* Apply-incompatible note */}
        {!applySupported && c.applyReason && (
          <div className="text-tiny text-gray-500" title={c.applyReason}>
            Apply unavailable: {c.language === 'python' || c.language === 'dotnet' ? `${c.language} requires image rebuild` : c.applyReason}
          </div>
        )}
      </div>

      {/* Verification status */}
      {verifyState && (
        <div className="mt-3 pt-3 border-t border-gray-800">
          {verifyState.status === 'waiting' && (
            <div className="inline-flex items-center gap-1.5 text-tiny text-gray-400">
              <Clock className="w-3.5 h-3.5" />
              Waiting for traces… {Math.round(verifyState.elapsedMs / 1000)}s of 60s
            </div>
          )}
          {verifyState.status === 'receiving' && (
            <div className="inline-flex items-center gap-3 text-tiny">
              <span className="inline-flex items-center gap-1.5 text-green-300">
                <Check className="w-3.5 h-3.5" /> {verifyState.traceCount} traces received
              </span>
              {verifyState.lastSeenAt && (
                <span className="text-gray-500">
                  last seen {Math.round((Date.now() - verifyState.lastSeenAt) / 1000)}s ago
                </span>
              )}
              <a
                href={`/otel-data?service=${encodeURIComponent(c.suggestedServiceName)}`}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Open in /otel-data <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
          {verifyState.status === 'timeout' && (
            <div className="text-tiny">
              <div className="inline-flex items-center gap-1.5 text-amber-300 mb-1">
                <AlertTriangle className="w-3.5 h-3.5" /> No traces in 60s
              </div>
              <div className="text-gray-500 leading-relaxed">
                Check that your app is actually running and can reach <code className="font-mono">http://helix-gateway:4318</code> from inside its container. Common fixes:
                <ul className="list-disc ml-4 mt-1">
                  <li>Confirm <code>helix-bridge</code> is in your service's <code>networks:</code> block</li>
                  <li>Check <code>docker logs {c.container}</code> for the OTel agent's startup message</li>
                  <li>For Java, look for <code>[opentelemetry.javaagent]</code> lines in stdout</li>
                </ul>
              </div>
              <button
                onClick={() => { setVerifyAnchor(Date.now()); setVerifyState(null); }}
                className="mt-2 inline-flex items-center gap-1.5 text-tiny text-gray-300 hover:text-gray-100 underline"
              >
                Verify again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Update Layer3Instrument to use RuntimeCard**

Open `frontend/src/components/step-zero/Layer3Instrument.tsx`. At the top, add the import:

```tsx
import { RuntimeCard } from './RuntimeCard';
```

Replace the stub list block:

```tsx
{detect.detected.map(c => (
  <div key={c.container} className="rounded border border-gray-800 bg-gray-1100 p-4 text-sm">
    <span className="font-mono text-gray-200">{c.container}</span>{' '}
    <span className="text-tiny uppercase text-blue-300">{c.language}</span>{' '}
    <span className="text-tiny text-gray-500">→ service.name=<code>{c.suggestedServiceName}</code></span>
  </div>
))}
```

With:

```tsx
{detect.detected.map(c => (
  <RuntimeCard key={c.container} container={c} />
))}
```

- [ ] **Step 3: Build to verify**

Run: `cd frontend && npm run build`
Expected: clean build, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/step-zero/RuntimeCard.tsx frontend/src/components/step-zero/Layer3Instrument.tsx
git commit -m "feat(step-zero): RuntimeCard with endpoint toggle, snippet tabs, apply + verify

Per-container card. Endpoint mode toggle (compose/standalone/host)
refetches the snippet from /snippet whenever it changes. Two snippet
tabs (compose patch / shell wrapper) with copy buttons. Apply-for-me
button (only when language is java or node + compose-managed), with
inline confirm dialog before any mutation. Passive 'I applied the
snippet' button starts a verification window. Verification status
pill cycles through waiting → receiving / timeout with the standard
troubleshooting block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: StepZero integration

Add Layer3Instrument below Layer2Synthetic on `/step-zero`. Single small change.

**Files:**
- Modify: `frontend/src/components/step-zero/StepZero.tsx`

- [ ] **Step 1: Edit StepZero.tsx**

Open `frontend/src/components/step-zero/StepZero.tsx`. The file is currently a thin shell (header + Layer2Synthetic + footer). Add the Layer3 import and place it below Layer 2.

Find this section:

```tsx
import { Layer2Synthetic } from './Layer2Synthetic';
```

Add immediately after:

```tsx
import { Layer3Instrument } from './Layer3Instrument';
```

Find the JSX section:

```tsx
        <Layer2Synthetic />
```

Replace with:

```tsx
        <Layer2Synthetic />

        <Layer3Instrument />
```

- [ ] **Step 2: Build to verify**

Run: `cd frontend && npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/step-zero/StepZero.tsx
git commit -m "feat(step-zero): add Layer3Instrument panel below Layer2Synthetic

Final integration. /step-zero now shows Demo (Layer 2) at the top
and Instrument (Layer 3, collapsible) below it. Layer 3 defaults
to expanded; collapsed state persists in localStorage so users who
prefer the demo-only experience aren't nagged each visit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: End-to-end smoke verification

Final acceptance check. Walks through the user-visible behavior end-to-end against a rebuilt stack.

**Files:** None. Manual verification.

- [ ] **Step 1: Rebuild the configurator (Dockerfile changed in Task 1)**

```bash
cd /Users/jammicha/dev/HelixConfigurator/.claude/worktrees/<your-worktree>
docker compose -p helixconfigurator up -d --build helix-configurator
```

Wait for the container to be healthy: `docker ps` shows `helix-configurator` running.

- [ ] **Step 2: Confirm docker CLI is present in the configurator**

Run: `docker exec helix-configurator docker --version`
Expected: prints docker client version.

Run: `docker exec helix-configurator docker compose version`
Expected: prints compose plugin version.

- [ ] **Step 3: Prepare a test app for instrumentation**

In another directory, create a tiny test compose project that runs a stock Java container without instrumentation:

```bash
mkdir -p /tmp/l3-test-java
cat > /tmp/l3-test-java/docker-compose.yml <<'EOF'
services:
  cart-api:
    image: openjdk:21-slim
    command: ["sh", "-c", "while true; do echo running; sleep 5; done"]
EOF
cd /tmp/l3-test-java && docker compose -p l3-test up -d
```

Confirm the container is running: `docker ps | grep cart-api`.

(For a more realistic test, replace the `command:` with a tiny Java HTTP server. The instrumentation flow doesn't care whether the app actually serves requests; it only needs the JVM to start with the agent attached.)

- [ ] **Step 4: Walk the detection flow in the browser**

Open `http://localhost:8765/step-zero`. Scroll to Layer 3.

Expected:
- Layer 3 panel header visible, expanded by default
- Eyebrow "Instrument your apps", title "Detected runtimes"
- The test cart-api container appears as a Java candidate card
- helix-gateway, helix-configurator are NOT shown
- The card shows: container name, image (openjdk:21-slim), language (JAVA), suggested service.name (cart-api), endpoint toggle (Docker compose / Standalone container / Host process), two snippet tabs (Compose patch / Shell wrapper) with copy buttons, and an "Apply for me" button (since this is a compose-managed Java container)

- [ ] **Step 5: Verify the endpoint toggle**

Click each of the three endpoint modes. Expected:
- Compose: snippet shows `OTEL_EXPORTER_OTLP_ENDPOINT: http://helix-gateway:4318` + `networks: [helix-bridge]` block at bottom
- Standalone: shows `host.docker.internal:4318`
- Host: shows `localhost:4318`, no `networks:` block

- [ ] **Step 6: Apply-for-me (Java)**

Click "Apply for me". Confirm dialog appears mentioning `/tmp/l3-test-java/docker-compose.helix-instrument.yml` as the override path.

Click "Apply". Status text cycles through `downloading-agent` → `writing-override` → `recreating` → `waiting-for-up` → `Applied`.

Expected on disk: `/tmp/l3-test-java/docker-compose.helix-instrument.yml` exists and contains the OTel env block + helix-bridge network attachment.

Expected in Docker: `docker inspect cart-api` shows the new env vars present.

- [ ] **Step 7: Verification loop (Java)**

For the test command above (sleep loop), the JVM doesn't actually run a real app so no traces fire. Replace the test container with something that loads the Java agent. Easiest: use a one-shot HTTP server image like `bbc/jvm-otel-demo` if available, OR modify the command to:

```bash
docker run --rm -v helix-otel-agents:/agent:ro -d --name cart-api --network helix-bridge \
  -e JAVA_TOOL_OPTIONS='-javaagent:/agent/opentelemetry-javaagent.jar' \
  -e OTEL_SERVICE_NAME=cart-api -e OTEL_EXPORTER_OTLP_ENDPOINT=http://helix-gateway:4318 \
  openjdk:21-slim java -version
```

The agent emits a "[opentelemetry.javaagent]" log line on startup even before any spans. With a real app, you'd see spans within 60s.

Expected card state once the apply completes: pill flips from `Waiting for traces…` to `✓ N traces received` (for a real instrumented app) OR `⚠ No traces in 60s` with the troubleshooting block (for our minimal openjdk sleep loop).

- [ ] **Step 8: Undo**

Click Undo on the applied card. Expected:
- Override file `docker-compose.helix-instrument.yml` is deleted from `/tmp/l3-test-java/`
- The cart-api container is recreated without OTel env vars
- The card returns to its idle pre-apply state

- [ ] **Step 9: Passive path for Python or .NET**

Spin up a quick Python container:

```bash
docker run -d --name py-test python:3.11 sh -c "while true; do sleep 5; done"
```

Click Rescan in Layer 3. Expected: py-test appears as a Python candidate WITHOUT the "Apply for me" button (passive only).

Click "I applied the snippet". Verification window starts. Confirm the pill goes through `waiting` and eventually `timeout` (since we haven't actually instrumented the container).

- [ ] **Step 10: Collapsible section**

Click the section header (the area with the chevron + "Instrument your apps"). Expected: section collapses, only the header remains visible. The summary in the collapsed header reads something like "2 candidates detected — click to expand".

Reload the page. Expected: section is STILL collapsed (localStorage persistence).

Click again to expand. Expected: section reopens with the same content (or fresh data if more than 60s passed).

- [ ] **Step 11: Already-instrumented disclosure**

Set up a container with `OTEL_EXPORTER_OTLP_ENDPOINT` already in its env:

```bash
docker run -d --name pre-instr -e OTEL_EXPORTER_OTLP_ENDPOINT=http://x:4318 python:3.11 sh -c "while true; do sleep 5; done"
```

Click Rescan. Expected: `pre-instr` does NOT appear as a candidate card. The "N containers already instrumented" details disclosure at the bottom of the panel includes it.

- [ ] **Step 12: Reset onboarding wipes Layer 3 state**

With at least one apply still active, click the "Reset onboarding and start over" link in the wizard sidebar. Confirm.

Expected: any active applies' override files are NOT deleted by reset-onboarding (we don't roll back the user's compose changes — that's not what reset is for). However, the in-memory apply-state and verification anchors ARE cleared, so the cards return to their idle state on reload.

(If you want reset-onboarding to actually roll back applies, that's a follow-up plan — not in this scope.)

- [ ] **Step 13: Regression check — Layer 2 still works**

Run the synthetic scenario via Layer 2's "Run scenario" button. Confirm traces still flow as before. Layer 2 and Layer 3 don't interfere with each other.

- [ ] **Step 14: Final cleanup**

Run: `docker rm -f cart-api py-test pre-instr 2>/dev/null || true`
Run: `docker compose -p l3-test down -v`
Run: `rm -rf /tmp/l3-test-java`

- [ ] **Step 15: Final git status check**

Run: `git status`
Expected: working tree clean. All 11 task commits in `git log --oneline -15`.

---

## Self-review checklist (run before declaring done)

- [ ] All 11 task commits present in `git log` in order, plus any inline-fix commits
- [ ] `cd backend && npx vitest run` — all tests pass (existing + new instrument-detect, instrument-templates, instrument tests)
- [ ] `cd frontend && npm run build` — clean
- [ ] Layer 3 detection flow works end-to-end against a real Java container (Task 11 Step 4-6)
- [ ] Apply-for-me writes the override file and recreates the container; Undo cleanly reverses it (Task 11 Step 6 + 8)
- [ ] Collapsible section persists state in localStorage (Task 11 Step 10)
- [ ] Verification status pill cycles through waiting → receiving/timeout correctly
- [ ] No regression on Layer 2 (Task 11 Step 13)
- [ ] Reset-onboarding clears Layer 3 in-memory state (Task 11 Step 12)
- [ ] Working tree clean at the end
