# Step 0 Layer 3 — Instrument your apps

> ⚠️ **SUPERSEDED — 2026-05-20.** This design was implemented (commits `7060f90`…
> `0165459` on `worktree-step-zero-layer3`) and then walked back. Detection of
> running containers was fragile and the Apply-for-me path was too invasive for
> a demo tool. The replacement shape — a static guide panel with four language
> tabs and tailored snippets — landed as commits `f1f5142` + `b5010f0` on the
> same branch. See those commit messages for the new design summary; this
> document is kept for historical context only.

## Context

Step 0's first two layers shipped on this branch's predecessor:

- **Layer 1** (agentless host/container metrics) was built then removed. Generic
  infrastructure data didn't carry the demo and risked sending unwanted data to
  the user's tenant.
- **Layer 2** (synthetic e-commerce scenario) is the headline of `/step-zero`:
  a one-button burst of 8 diagnostic patterns that populates Helix with
  believable traces. Users see *what Helix can do*. But they're still not
  instrumented.

Layer 3 closes the loop. It's the "now do it for your own apps" step:

- Scan the user's running containers via `dockerode`
- Classify each by language signature (Java / Python / .NET / Node)
- Generate copy-paste-ready zero-code OTel auto-instrumentation snippets,
  pre-filled with the gateway endpoint and a derived `service.name`
- For containers we can safely edit (docker-compose-managed, file accessible),
  offer a one-click **"Apply for me"** that writes a non-destructive override
  file, recreates the container, and watches for traces
- Watch for incoming traces with the suggested `service.name` and surface a
  per-app **verification status** ("✓ 12 traces received" or "⚠ no traces in
  60s")

The narrative arc: Layer 2 showed the user a populated Helix; Layer 3 shows
them how to populate Helix *with their own apps' data* — and on the easy
cases, just does it for them.

## Intended outcome

A user landing on `/step-zero` sees the demo panel (Layer 2) at the top and
the instrumentation panel (Layer 3) below it. Layer 3 lists every detected
candidate container with a per-language card. On compatible containers, one
click instruments the app and a verification pill flips to "✓ traces
received" within ~60 seconds. On incompatible containers, the user copies a
ready-to-paste snippet, applies it themselves, clicks "I applied it", and
gets the same verification feedback.

## Decisions locked during brainstorm

| Dimension | Choice |
|---|---|
| Active vs passive | **Hybrid** — passive snippets default; "Apply for me" button only when the container is docker-compose-managed AND we can safely write to its compose directory AND language is `java` or `node` |
| Verification | Watch for traces with the specific `service.name` we suggested. 60s window. Per-card status pill: idle → waiting → receiving / timeout |
| Language coverage | Easy 4 only: **Java, Python, .NET, Node**. Other languages don't appear as candidates |
| Page placement | **Stacked below Layer 2** on `/step-zero`. Default state: expanded. **Collapsible** via a chevron in the section header so users can skip past Layer 3 if they just want the demo. Collapsed state persists in `localStorage` so it sticks across reloads. |
| Endpoint default in snippets | Per-card toggle: Compose service / Standalone container / Host process. Snippet text + required network config update live |

---

## Architecture

### Routing & page layout

`/step-zero` body becomes:

```
Header: "Start from zero"

┌─ Layer 2 (existing) ─────────────────────┐
│ Demo hero: "See Helix populated"         │
└──────────────────────────────────────────┘

┌─ Layer 3 (new) ──────────────────────────┐
│ Instrument your apps                     │
│   Detected runtimes: java(3), node(2)... │
│   <RuntimeCard /> × N                    │
└──────────────────────────────────────────┘

Footer: "Continue to the full wizard →"
```

### Components

| File | Responsibility |
|---|---|
| `frontend/src/components/step-zero/Layer3Instrument.tsx` | Panel shell. Fetches `/detect`, renders one card per candidate, owns the rescan affordance. **Section is collapsible**: header has a chevron + "Instrument your apps" + summary count (e.g., "4 candidates detected"); clicking toggles expanded/collapsed. State persisted in `localStorage` under key `helix-configurator.layer3.collapsed`. When collapsed, the body — detect call, polling, card list — is skipped entirely (no network requests). Default state: expanded. |
| `frontend/src/components/step-zero/RuntimeCard.tsx` | Per-container card. Holds the endpoint-mode toggle, snippet display, Apply / "I applied it" buttons, and verification status pill. Polls `apply-status` while applying and `verify-status` while waiting/receiving. |
| `frontend/src/components/step-zero/StepZero.tsx` | Modified to add `<Layer3Instrument />` below `<Layer2Synthetic />`. |
| `backend/routes/step-zero/instrument.js` | Express handlers, in-memory state for apply flow. |
| `backend/routes/step-zero/instrument-detect.js` | Pure detection logic — takes inspect output, returns classification. Testable in isolation. |
| `backend/routes/step-zero/instrument-templates.js` | Pure snippet rendering — takes `{ language, serviceName, endpointMode }`, returns rendered compose + shell strings. Testable in isolation. |
| `backend/routes/step-zero/instrument-apply.js` | Apply / undo orchestration. Spawns docker compose CLI via `child_process`. |

### Server state

In-memory module-scope per container:
- Apply state: `{ container, applyState, appliedAt, overrideFilePath, error }`
- Verification anchor: `{ container, serviceName, since }`

Detection results: 60s server-side cache, bypassable with `?refresh=1`.

No persistence — restarts wipe state, the user re-applies if they want.

### Reuse callouts

- `dockerode` wrapper from `backend/util.js` — existing
- `withDockerTimeout` / `sendDockerTimeoutResponse` — existing
- `otelStore` query for spans-by-service-name — existing helper
- Auth-gated route mount in `backend/index.js` — same pattern as Layer 2's `synthetic.js`

---

## Detection logic

### Enumerate candidate containers

`docker.listContainers()` → for each, `docker.getContainer(name).inspect()`. Filter:

| Filter rule | Why |
|---|---|
| Skip name matching `^helix-` | Our own containers |
| Skip image matching `otel/opentelemetry-collector*` | Other collectors the user runs |
| Skip if `Config.Env` contains `OTEL_EXPORTER_OTLP_ENDPOINT=` (any value) | Already instrumented |
| Skip if `Config.Cmd`/`Entrypoint` contains `-javaagent:.*opentelemetry-javaagent.jar` | Java agent already attached |

The skipped containers are reported back in two buckets: `alreadyInstrumented` (still surfaced as informational so the user sees their instrumented apps) and silently-skipped (helix-* and other-collector cases).

### Classify by language

`detectLanguage({ cmd, entrypoint, image })` returns `{ language, confidence }` using these signals in priority order (first match wins):

1. **Command-line signature** (`confidence: 'high'`) — dispositive:
   - `java`, `*.jar` → `java`
   - `python`, `python3`, `*.py`, `uvicorn`, `gunicorn`, `flask`, `fastapi` → `python`
   - `dotnet`, `*.dll` → `dotnet`
   - `node`, `npm`, `yarn`, `pnpm`, `*.js`, `*.mjs` → `node`

2. **Entrypoint signature** — same patterns, applied when cmd is empty.

3. **Image hint** (`confidence: 'low'`) — image basename matches:
   - `openjdk|eclipse-temurin|amazoncorretto` → `java`
   - `python` → `python`
   - `mcr.microsoft.com/dotnet` → `dotnet`
   - `node` → `node`
   - We still surface the card but with a warning: "image suggests <lang>; verify before applying"

4. **No match** → `language: 'unknown'`. Not shown as a candidate; lumped into a footer disclosure ("we didn't recognize N containers").

### Service-name derivation

```
1. If Labels['com.docker.compose.service'] is set → use that (user-authored)
2. Else, strip container name:
   - Leading `<Labels['com.docker.compose.project']>_` or `-`
   - Trailing `_1` / `-1` / `_<digits>` (compose replica suffix)
3. Fallback: raw container name (without leading `/`)
```

Example: `step-zero-smoke_cart-api_1` → `cart-api`. `random-name` (no compose) → `random-name`.

### Apply-compatible flag

For each detected runtime, also compute `applyCompatible: boolean` based on:

- `Labels['com.docker.compose.project']` AND `Labels['com.docker.compose.config-files']` both set
- The config-files path is readable from the configurator's filesystem (test via `fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK)`)
- The detected language is `java` or `node` (Python and .NET are passive-only per Section "Snippets" below)
- For `node` only: the container's image has `@opentelemetry/auto-instrumentations-node` in its `package.json`, detected via `docker.getContainer(name).getArchive('/app/package.json')` (best-effort)

If any fails, `applyCompatible: false` with `applyReason` populated for the UI to display.

### Response shape

```json
{
  "detected": [
    {
      "container": "cart-api",
      "image": "openjdk:21-slim",
      "language": "java",
      "confidence": "high",
      "suggestedServiceName": "cart-api",
      "applyCompatible": true,
      "applyReason": null
    }
  ],
  "alreadyInstrumented": [
    { "container": "...", "serviceName": "..." }
  ],
  "unknown": [
    { "container": "...", "image": "...", "reason": "could not classify" }
  ],
  "scannedAt": 1747590000000
}
```

---

## Snippets

Per-language templates live in `instrument-templates.js`. Each renders two flavors:

1. **Compose patch** — YAML block the user pastes under `services.<name>:`
2. **Shell wrapper** — bash command for non-compose setups

Both set the OTel-standard env vars:

```
OTEL_SERVICE_NAME=<derived>
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint depends on mode>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=dev,service.namespace=step-zero-instrumented
```

### Per-language additions

| Lang | Snippet additions | Apply-for-me? |
|---|---|---|
| **Java** | `JAVA_TOOL_OPTIONS=-javaagent:/otel-agent/opentelemetry-javaagent.jar` + named volume mount for the agent JAR | ✅ Yes (JAR is self-contained, mountable) |
| **Node** | `NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register` + note about adding the package to `package.json` | ⚠️ Conditional (only when we detect the package in the user's image) |
| **Python** | `command:` prefix with `opentelemetry-instrument` + note "pip install opentelemetry-distro" | ❌ Passive only (image rebuild risk) |
| **.NET** | Full CoreCLR profiler env block (CORECLR_*, DOTNET_STARTUP_HOOKS, OTEL_DOTNET_AUTO_HOME) + shared volume for the dotnet auto-instr install | ❌ Passive only (installer script too involved to auto-run) |

### Endpoint-mode toggle

Each card has a small radio:

| Mode | Endpoint URL | Compose network requirement |
|---|---|---|
| Compose service (default) | `http://helix-gateway:4318` | `networks: [helix-bridge]` added; `helix-bridge` declared `external: true` |
| Standalone container | `http://host.docker.internal:4318` | Note "works on Docker Desktop / Windows; on Linux Docker, add `--add-host=host.docker.internal:host-gateway`" |
| Host process | `http://localhost:4318` | No network change needed; relies on the gateway publishing port 4318 on the host |

Frontend re-fetches the snippet via `POST /snippet` when the toggle changes.

---

## Apply-for-me flow

Only enabled when `applyCompatible === true`. Flow:

### Confirm dialog

Before any disk writes:

> **About to instrument `<container>` for OpenTelemetry**
>
> We'll create `<compose-dir>/docker-compose.helix-instrument.yml` next to
> your existing `<config-files>` and recreate the `<service>` container with
> `JAVA_TOOL_OPTIONS` set to attach the OTel Java agent.
>
> - **No changes to your existing compose file.** The override is a separate
>   file we manage.
> - **Easy undo**: deleting `docker-compose.helix-instrument.yml` and
>   re-running `docker compose up -d` reverts.
> - **About 30 seconds of downtime** while the container recreates.
>
> `[Cancel]` `[Apply]`

### Backend flow

1. **Generate override file** `docker-compose.helix-instrument.yml` in the
   same directory as the original. Contains only the additions: env vars,
   volume mount (Java only), and `networks: [helix-bridge]` (declared
   `external: true`).

2. **Download the Java agent** (Java only) into a Docker named volume
   `helix-otel-agents`, populated once via a one-shot busybox container that
   curls the latest agent JAR from the OTel Java instrumentation GitHub
   release. Subsequent applies see the JAR already present (idempotent).

3. **Recreate the user's service** with both compose files:
   ```
   docker compose -p <project> -f <main-compose> -f docker-compose.helix-instrument.yml up -d --no-deps <service>
   ```
   `--no-deps` keeps us from restarting sibling services.

   **Implementation note**: the configurator runs from a Node image
   which may not have the `docker` CLI installed. Two options to
   resolve during implementation:
   - **(A) Add the docker CLI to the configurator image**: a small
     `apt-get install docker-ce-cli` line in the `Dockerfile` —
     ~50 MB image growth. The CLI then drives the recreate via
     the mounted `/var/run/docker.sock`.
   - **(B) Skip the CLI and use the Docker Engine API directly via
     `dockerode`**: read the user's compose file ourselves, parse the
     service definition, merge our override into the resulting
     container config, and call `docker.createContainer()` +
     `start()`. More code but no shell dependency.
   The choice doesn't affect the user-facing behavior; pick during
   implementation based on which is faster to ship reliably. Option A
   is likely simpler.

4. **Poll for ≤30s** waiting for the new container to reach `running` with
   `StartedAt` > 5s ago (same pattern as `config.js#waitForGatewaySettle`).

5. **On success**: store apply-state in memory, kick off verification loop.
   Anchor `since` to now.

6. **On failure**: delete the override file, run another `up -d --no-deps`
   (which rolls back to the original config), surface the docker error in
   the card.

### Out-of-band cases

| Case | Handling |
|---|---|
| User already has `docker-compose.helix-instrument.yml` (re-apply) | Read it, merge in updates, re-run. Treat as idempotent. |
| User has their own `docker-compose.override.yml` | Untouched. Our file is uniquely named. Re-running passes both via `-f`. |
| `helix-bridge` network doesn't exist | Pre-check via `docker network inspect helix-bridge`. If missing, fail with specific message: "Start the Helix stack first via `docker compose up -d`". No auto-create. |
| `helix-otel-agents` volume missing or empty | Idempotently created/populated as part of step 2. |

### State surfaced to UI

Per-container in-memory:
```json
{
  "container": "cart-api",
  "applyState": "idle | confirming | downloading-agent | writing-override | recreating | waiting-for-up | applied | failed | rolling-back",
  "appliedAt": null | <timestamp>,
  "overrideFilePath": "/Users/jam/myapp/docker-compose.helix-instrument.yml",
  "error": null | "..."
}
```

Drives the card's button label (`Apply for me` → `Applying...` → `✓ Applied` → `Undo`) and progress sub-text.

### Undo

Once `applyState === 'applied'`, card shows an `Undo` button. Click:

1. Delete `docker-compose.helix-instrument.yml`
2. Run `docker compose -p <project> -f <main-compose> up -d --no-deps <service>` (without our override)
3. Remove apply-state, reset verification status

---

## Verification loop

Watches the configurator's local SQLite-backed OTel store for traces with the
suggested `service.name`. The store is populated by the gateway's
`helix_local_viewer` exporter fan-out, so traces are visible within seconds.

### Backend endpoint

`GET /api/step-zero/instrument/verify-status?service=<name>&since=<applyMs>`

Stateless. Each call runs:
```sql
SELECT COUNT(*), MAX(received_at_ms)
FROM spans
WHERE service_name = ? AND received_at_ms >= ?
```

Response:
```json
{
  "service": "cart-api",
  "traceCount": 12,
  "lastSeenAt": 1747590000000,
  "elapsedMs": 8500,
  "status": "waiting | receiving | timeout"
}
```

The server derives `status` from `traceCount` and `elapsedMs`:
- `traceCount > 0` → `receiving`
- `traceCount === 0 && elapsedMs < 60_000` → `waiting`
- `traceCount === 0 && elapsedMs >= 60_000` → `timeout`

### Frontend poll cadence

- `waiting` state → poll every 2s
- `receiving` state → poll every 10s (just to keep count fresh)
- `timeout` state → stop polling; show troubleshooting block

### Card status pill

| Status | Pill content |
|---|---|
| `idle` | (no pill; show buttons) |
| `waiting` | `⏳ Waiting for traces… 8s of 60s` |
| `receiving` | `✓ 12 traces received` + small text "last seen 3s ago" + `Open in /otel-data →` link filtered to `service.name = <name>` |
| `timeout` | `⚠ No traces in 60s` + troubleshooting block (see below) + `Verify again` button (resets the 60s window) |

### Timeout troubleshooting block

> Check that your app is actually running and that it can reach
> `http://helix-gateway:4318` from inside its container. Common fixes:
>
> - Confirm `helix-bridge` is in your service's `networks:` block
> - Check `docker logs <container>` for the OTel agent's startup message
> - For Java, look for `[opentelemetry.javaagent]` lines in stdout

### Manual reset

Small `×` on the status pill drops back to `idle`. Pure client-side
(server-side state is just anchor + service name; clearing on frontend
naturally stops polling).

---

## Backend API surface

All routes auth-gated, mounted after `app.use('/api', requireAuth)`.

| Endpoint | Purpose |
|---|---|
| `GET /api/step-zero/instrument/detect` | Scan + classify. 60s cache; `?refresh=1` bypasses. |
| `POST /api/step-zero/instrument/snippet` | Body `{ language, serviceName, endpointMode }` → returns rendered compose + shell strings. Called when the card's toggle changes. |
| `POST /api/step-zero/instrument/apply` | Body `{ container }` → starts the apply flow. Returns immediately with the apply-state object. Async loop runs server-side. |
| `GET /api/step-zero/instrument/apply-status?container=<name>` | Polled by frontend during apply. Returns current apply-state for the named container. |
| `POST /api/step-zero/instrument/undo` | Body `{ container }` → delete override, recreate without it, clear state. |
| `POST /api/step-zero/instrument/mark-applied` | Body `{ container, serviceName }` → records timestamp + service name for the passive path. Starts verification window. |
| `GET /api/step-zero/instrument/verify-status?service=<name>&since=<ms>` | Stateless count query against the local OTel store. |

---

## Files to create / modify (preview)

### Create
- `backend/routes/step-zero/instrument.js` — handlers + in-memory state
- `backend/routes/step-zero/instrument-detect.js` — pure detection
- `backend/routes/step-zero/instrument-templates.js` — pure snippet rendering
- `backend/routes/step-zero/instrument-apply.js` — apply/undo orchestration
- `backend/__tests__/step-zero-instrument-detect.test.mjs`
- `backend/__tests__/step-zero-instrument-templates.test.mjs`
- `backend/__tests__/step-zero-instrument.test.mjs` — handler tests with stubbed docker + filesystem
- `frontend/src/components/step-zero/Layer3Instrument.tsx`
- `frontend/src/components/step-zero/RuntimeCard.tsx`

### Modify
- `backend/index.js` — mount the new route module
- `backend/routes/lifecycle.js` — extend `reset-onboarding` to call a `clearAllApplied()` helper from `instrument.js` so reset wipes apply-state and undoes any active applies (best-effort)
- `frontend/src/components/step-zero/StepZero.tsx` — add `<Layer3Instrument />` below `<Layer2Synthetic />`

### Reuse (do NOT duplicate)
- `dockerode` wrapper + `withDockerTimeout` from `backend/util.js`
- OTLP self-metric scraping pattern from `backend/routes/diagnostics.js` (only if needed; the verify loop uses the SQLite store, not Prometheus)
- `otelStore` query helpers — extend if a "spans-since-timestamp-by-service" helper doesn't already exist; otherwise use raw SQL via the existing better-sqlite3 handle
- Confirm-dialog pattern from `App.tsx#setConfirmDialog`

---

## Out of scope (deferred)

- Languages beyond Java / Python / .NET / Node (no Ruby, PHP, Go, Rust)
- Kubernetes-managed containers (`kubectl`, K8s API)
- Containers started by raw `docker run` (not compose) — passive only
- Multi-environment picker (single hardcoded `deployment.environment=dev`)
- Build-time instrumentation / Dockerfile injection / image rebuilds
- Auto-installing dependencies into the user's image (`pip install` / `npm install` injection)
- AIOps Business Service auto-creation (separate deferred work)
- Custom OTel resource attributes beyond the standard set
- Existing-instrumentation migration (we detect-and-skip, never modify)

---

## Verification plan (manual smoke once implemented)

1. **Detection accuracy.** Run a stack with at least one container per
   detected language (Java, Python, .NET, Node) plus a couple of unknowns
   (e.g., a redis or nginx). Open `/step-zero`, scroll to Layer 3. Confirm:
   - All four language candidates appear with `confidence: high`
   - Unknowns are summarized in the footer disclosure
   - `helix-*` and the gateway are excluded
   - The dummy "already-instrumented" app (e.g. one we manually set
     `OTEL_EXPORTER_OTLP_ENDPOINT` on) appears in the `alreadyInstrumented`
     row, not as a candidate

2. **Passive snippet flow.** On a Python or .NET card:
   - Toggle endpoint context. Confirm snippet text + network block update
     live.
   - Copy compose patch, paste it into a separate test compose file, run
     `docker compose up -d`, click "I applied the snippet".
   - Card status flips to "waiting" → "✓ N traces received" within 60s.

3. **Active apply (Java).** On a Java card with `applyCompatible: true`:
   - Click "Apply for me". Confirm dialog appears with the actual file
     path the override will live at.
   - Click Apply. Card progresses through `writing-override` →
     `recreating` → `waiting-for-up` → `applied`.
   - Within 60s after apply, verification flips to "✓ traces received".
   - Confirm `docker-compose.helix-instrument.yml` exists at the expected
     path, contains only the override block, does NOT modify the original.

4. **Active apply (Node, with package present).** Same as Java but for a
   Node container whose image has the auto-instrumentations-node package
   in package.json.

5. **Undo.** On an applied container, click `Undo`. Container recreates
   without our override. Override file is deleted. Verification status
   resets. Span count for that service stops increasing (existing spans
   stay in the store).

6. **Failure paths:**
   - Rename the agent volume out from under us mid-apply → backend should
     surface a clear error, roll back the override file write.
   - Pre-create the override file with malformed YAML → apply should fail
     cleanly, not produce a half-applied state.
   - Stop the gateway, then apply → apply itself succeeds (we're only
     touching the user's container), but verification times out at 60s.
     User sees the troubleshooting block.

7. **Reset onboarding.** With one or more applies active, click "Reset
   onboarding". Confirm: override files are deleted, containers are
   recreated without them, apply-state and verification-state are wiped.

8. **Regression checks.** Layer 2 unchanged. Existing wizard Steps 1-4
   unchanged. Backend test suite green (existing + new instrument tests).
