# Weekend Hardening Spec — Wizard + Day-2 (2026-05-15)

**Goal:** Take the Helix Configurator from MVP to a state where prospects and customers can complete onboarding more reliably and notice when day-2 operation drifts. Five targeted additions across the user lifecycle, sized to ~8–12 hours of focused work.

**Tech stack:** No new dependencies. Backend is Express on Node 20; frontend is React 18 + Vite + Tailwind. All five items extend existing files; no new architectural components.

**Audience:** Built for prospects evaluating Helix and customers running the configurator on their own infrastructure (with internal team / SEs as a secondary audience). Polish for demo embarrassment is explicitly NOT in scope.

---

## Out of scope (called out for clarity)

- **Self-verify cron** — periodic synthetic inject-trace runs. Bigger lift; deferred to a future "day-2 stability" iteration if the panel alone isn't enough.
- **Multi-collector smart-add picker** — when more than one collector is detected, Step 2 today falls silent. Out of scope this round.
- **OTel store eviction policy UI** — surface only the %-full number; no UI to configure retention.
- **Help drawer / "what this does" expandables** — onboarding polish items from `5-15OnboardingTODOs.md` deferred.
- **Stepper renames** — also from the onboarding TODO; deferred.

---

## Architecture summary

Two new architectural pieces; everything else extends existing surfaces.

1. **Error ring buffer** — a small in-memory module (`backend/errorLog.js`) capturing the last N tagged errors from lifecycle / diagnostics / discovery routes. Powers the dashboard's "Last error" stat.
2. **Network watchdog** — a `setInterval` running in lifecycle.js (~5 min cadence) that re-applies the boot-time `reconcileBridgedNetworks` logic continuously.

All five user-facing additions read from existing data sources (OtelStore, Docker inspect, env). No new persistence, no new tables.

---

## Item 1 — Step 1 inline "Test connection" affordance

### What

A new secondary button next to **Save & initialize** on Step 1 labeled **Test connection →**. Tests the typed-but-not-yet-saved endpoint + API key against Helix. Informational only — does NOT block submit.

### Behavior

- User fills Step 1 fields, clicks **Test connection**.
- Frontend POSTs `{ endpoint, apiKey }` to a new `/api/diagnostics/test-connection` route (in-form values, not saved yet).
- Backend performs the same OTLP-traces probe the existing `apikey-probe` route does, but uses the supplied creds instead of `process.env`. Returns the same shape: `{ status, message, remediation, httpStatus?, latencyMs? }` where `status ∈ 'valid' | 'rejected' | 'tenant-error' | 'network-error' | 'helix-error'`.
- Result renders inline beneath the field block:
  - `valid` → green check + `Helix accepted the probe (HTTP 200 in 142ms)`
  - other → amber/red icon + message + remediation
- Re-clicking re-runs the probe (no debounce).
- **Save & initialize** remains enabled regardless of test outcome.

### Files

- **Create:** none.
- **Modify:** `backend/routes/diagnostics.js` — extract the OTLP probe logic in `apikey-probe` (currently ~lines 1013–1130) into a reusable internal function `runOtlpProbe(endpoint, apiKey)` that returns the same `{ status, ... }` shape. Existing `apikey-probe` route delegates to it (reads creds from process.env). New `test-connection` route delegates to it (reads creds from request body).
- **Modify:** `frontend/src/components/wizard/Step1.tsx` — new button + result display. Add a `testResult` state + a `testing` boolean. The probe call is fired by an `onTestConnection` prop wired up in `App.tsx`.
- **Modify:** `frontend/src/App.tsx` — new handler `handleTestConnection` that POSTs `/api/diagnostics/test-connection` with current envVars, sets state for Step1 to render.

### Validation

The body schema for `/api/diagnostics/test-connection`:
```ts
{ endpoint: string, apiKey: string }
```
Validate:
- `endpoint` matches `^https?://[^\s]+$`
- `apiKey` matches `^[^:]+::[^:]+::[^:]+$` (three :: parts, non-empty)
- Both required; return `400` if missing.

### Out-of-scope detail

- No saving of test results across page reloads — test is ephemeral.
- No "test on every keystroke" debounce — explicit button click only.

---

## Item 2 — Step 2 restart-collector snippet

### What

Add a SnippetBlock to Step 2's manual path showing the docker command to restart the user's collector after they've copy-pasted the exporter/pipelines snippets.

### Behavior

- New SnippetBlock appended after the existing Pipelines snippet, BEFORE the "After saving, restart your collector container" amber warning.
- Snippet text depends on detection state:
  - Exactly one detected collector → `docker restart <detected-name>` (substituted)
  - Zero or multiple → `docker restart <your-collector>` (placeholder)
- Hidden when smart-add successfully applied (`compactAfterApply` is true; the snippets section is already hidden in that case, so this section sits inside the same `!compactAfterApply` block).

### Files

- **Modify only:** `frontend/src/components/wizard/Step2.tsx`. Add the SnippetBlock inside the existing `{!compactAfterApply && (...)}` wrapper, after the Pipelines block at roughly line 192.
- No new props needed — the component already receives `smartAddProposal` (which has `.name` when smart-add detected something). For the multi-collector case where smart-add doesn't fire, fall back to the placeholder text.

### Code pattern

```tsx
<div className="mb-2 flex items-baseline justify-between gap-3">
  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Restart your collector</span>
</div>
<SnippetBlock text={`docker restart ${smartAddProposal?.name || '<your-collector>'}`} />
<p className="text-tiny text-gray-500 -mt-4 mb-6">
  Runs from your terminal. After the collector finishes restarting, head to Step 3 to wire the network.
</p>
```

---

## Item 3 — Step 4 "Send test trace" button

### What

A tertiary "Send test trace" button next to "Verify gateway → Helix" on Step 4. Fires the existing `/api/diagnostics/inject-trace` endpoint. Fire-and-forget — no polling, no verdict.

### Behavior

- New button to the right of Verify, smaller ghost styling so it doesn't compete with the primary.
- Click → POST `/api/diagnostics/inject-trace` (existing route in diagnostics.js — no new route).
- Inline status next to the button (not a banner — keep tight):
  - Idle → button text "Send test trace"
  - In flight → button text "Sending…" + spinner
  - Success → "Sent ✓" for 3 seconds, then fade back to "Send test trace"
  - Error → "Failed — retry" with tooltip showing the error
- Does NOT trigger or affect the Verify polling.
- Does NOT unlock Launch Dashboard (only Verify does — gating rule unchanged).

### Files

- **Modify only:** `frontend/src/components/wizard/Step4.tsx`. Add the button in the existing button row near the Verify button (~line 290–305). Add local state for the send status.
- No `App.tsx` changes — the call is self-contained inside Step4 (the endpoint requires no input).

### Code pattern

The button + state lives entirely in Step4:

```tsx
const [testTraceStatus, setTestTraceStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
const sendTestTrace = async () => {
  if (testTraceStatus === 'sending') return;
  setTestTraceStatus('sending');
  try {
    const res = await fetch('/api/diagnostics/inject-trace', { method: 'POST' });
    if (!res.ok) throw new Error('Inject failed');
    setTestTraceStatus('sent');
    setTimeout(() => setTestTraceStatus('idle'), 3000);
  } catch {
    setTestTraceStatus('error');
  }
};
// ...JSX next to the Verify button
<button onClick={sendTestTrace} className="...">
  {testTraceStatus === 'sending' ? 'Sending…' : testTraceStatus === 'sent' ? 'Sent ✓' : testTraceStatus === 'error' ? 'Failed — retry' : 'Send test trace'}
</button>
```

---

## Item 4 — Dashboard "System health" panel

### What

A new dashboard section near the top showing 4 small stat cards + a tiny event log. Complements the existing user-initiated "Diagnostic Health Check" (kept as-is).

### Cards

| Card | Source | Value format |
|---|---|---|
| Gateway | Existing `gatewayStatus` state | `running` / `restarting` / `exited (<code>)` |
| Throughput (1h) | OtelStore: count of spans in last hour ÷ 3600 | `<n.n> spans/sec` |
| Store size | OtelStore caps (TRACE_CAP, LOG_CAP) and current row counts | `<n>%` (red badge when >85%) |
| Last error | New ring buffer (see below) | Relative timestamp + 1-line message |

Below the cards: small event log showing the last 5 entries from the ring buffer, collapsed by default behind a "Show recent errors" disclosure.

### Backend

- **Create:** `backend/errorLog.js` — module exporting `push(tag, message, detail?)` and `recent(limit = 10)`. In-memory ring buffer, capped at 50 entries.
- **Modify:** `backend/routes/lifecycle.js`, `backend/routes/diagnostics.js`, `backend/routes/discovery.js` — at each existing `console.warn` / `console.error` call site that represents a user-relevant failure, also call `errorLog.push(...)`. Roughly 6–10 call sites; see the "Instrumentation map" below.
- **Modify:** `backend/routes/diagnostics.js` — new GET `/api/diagnostics/system-health` returning everything the panel needs in one round-trip:
  ```ts
  {
    gatewayStatus: 'running' | 'restarting' | 'exited' | 'error',
    gatewayExitCode?: number,
    throughput: { spansPerSec: number, totalSpans: number, windowMs: number },
    storeUsage: { tracesUsedPct: number, logsUsedPct: number, errorsUsedPct: number },
    recentErrors: Array<{ ts: number, tag: string, message: string }>,
  }
  ```
  Single endpoint keeps the polling cadence cheap. Internally delegates to `errorLog.recent()`, `otelStore.recentThroughput()`, `otelStore.storeUsage()`, and the existing gateway-inspect path.
- **Modify:** `backend/otelStore.js` — new method `recentThroughput(windowMs = 3_600_000)` returning `{ spansPerSec: number, totalSpans: number }`. Reuses the existing time-window queries.
- **Modify:** `backend/otelStore.js` — new method `storeUsage()` returning `{ tracesUsedPct, logsUsedPct, errorsUsedPct }` based on TRACE_CAP / LOG_CAP / ERROR_CAP and current counts.

### Instrumentation map

Wrap these existing log calls with parallel `errorLog.push()` calls:

- `lifecycle.js`: `recreateGateway` stop/remove warnings; bridge-network failures; reset-onboarding recreate failure; watchdog re-attach failures (new — see Item 5).
- `diagnostics.js`: gateway-metrics-unreachable case in verify-trace; toggle-debug restart failures.
- `discovery.js`: smart-add apply failures.

Each call passes a short tag (e.g. `'gateway.recreate'`, `'bridge-network'`, `'smart-add.apply'`) so the UI can group/filter later if needed.

### Frontend

- **Create:** `frontend/src/components/dashboard/SystemHealthPanel.tsx` — the new component.
- **Modify:** `frontend/src/App.tsx` — render the panel near the top of the dashboard (above existing live counters). Wire a new `useEffect` that polls `/api/diagnostics/system-health` every 30s and passes the response to `<SystemHealthPanel>` as a prop. Keep the polling logic in App.tsx (not the panel) so the panel stays a presentational component.
- **Reuse:** `StatCard` component (exists, used by OverviewTab).

### Polling cadence

- Stat cards refresh every 30s.
- Ring buffer refresh: same 30s.
- "Clear store" button is a no-op for v1 — surface the link but make it a placeholder with a `disabled` tooltip ("Coming soon"). Keeps the UI complete without committing to store reset semantics this weekend.

---

## Item 5 — Network watchdog

### What

A `setInterval` in lifecycle.js (~5 min cadence) that reconciles helix-gateway's actual attached networks against `bridged-networks.json` continuously, not just at boot.

### Behavior

- On each tick:
  - Read `bridged-networks.json`.
  - Inspect helix-gateway's current networks.
  - For each expected-but-missing network: attempt `docker.getNetwork(name).connect({ Container: sidecar })`.
  - On success: `console.log('bridged-networks: watchdog re-attached <name>')` and `errorLog.push('watchdog.reattach', '...')`.
  - On 404 (network gone): drop from `bridged-networks.json` (same as boot-time reconcile).
  - On other failure: log + push to ring buffer, leave the entry for next tick.
- Refactor the existing `reconcileBridgedNetworks` to be the shared "diff and reconcile" function called by both the boot path and the watchdog.
- Cadence configurable via env var `BRIDGED_NETWORKS_WATCHDOG_INTERVAL_MS`; default `300_000` (5 min). Set to `0` to disable.
- The interval is `.unref()`'d so it doesn't block process exit.

### Files

- **Modify only:** `backend/routes/lifecycle.js`. The existing `reconcileBridgedNetworks` function stays; add a `startBridgedNetworksWatchdog(docker)` function that sets up the interval and calls `reconcileBridgedNetworks(docker)` on each tick. Call `startBridgedNetworksWatchdog` from inside `register(app, { docker })` after the existing boot reconcile.

### Error handling

- Watchdog never throws — wrap each `reconcileBridgedNetworks` call in `.catch()`.
- If the gateway is `exited`, the inside-inspect will fail; reconcile logs and skips. Watchdog continues firing.

---

## Acceptance criteria

For each item, the "done" definition:

1. **Test connection**: typing valid creds + click returns green check + latency. Typing a bogus endpoint returns network-error. Typing a real endpoint with wrong key returns rejected with 401 hint. The Save & initialize button remains clickable in all cases.
2. **Restart-collector snippet**: visible on Step 2 manual path. When exactly one collector is detected, the command has the detected name. When zero/multiple, the placeholder `<your-collector>` shows.
3. **Send test trace**: button click → "Sending…" → "Sent ✓" within ~1s. Spans counter on the dashboard increments. No effect on Verify state or Launch button gating.
4. **System health panel**: visible on the dashboard. Gateway card matches the existing status. Throughput card shows a non-zero number when traces are flowing. Store size card reflects actual store usage. Last error card empty when no errors; shows the most recent push within 30s of a failure.
5. **Network watchdog**: after bridging to a customer network, manually `docker network disconnect <name> helix-gateway` from the CLI — within 5 min, the watchdog re-attaches and the event appears in the ring buffer.

## Testing approach

- **Unit tests (backend):**
  - `backend/errorLog.js` — push/recent/cap-overflow.
  - The extracted `runOtlpProbe` — mock axios responses for 200 / 401 / 404 / timeout / connection-refused.
- **Integration / manual:**
  - End-to-end walk through the wizard verifying items 1–3 work.
  - Deliberate disconnect of helix-gateway from a bridged network → confirm watchdog reattaches (item 5).
  - Stop the gateway → confirm health panel reflects `exited` (item 4 gateway card).

## Files changed (summary)

**Create:**
- `backend/errorLog.js`
- `frontend/src/components/dashboard/SystemHealthPanel.tsx`

**Modify:**
- `backend/routes/diagnostics.js` (extract `runOtlpProbe`, new `test-connection` route, new `recent-errors` route, instrument existing warnings)
- `backend/routes/lifecycle.js` (watchdog setup, refactor `reconcileBridgedNetworks` for reuse, instrument warnings)
- `backend/routes/discovery.js` (instrument smart-add failures)
- `backend/otelStore.js` (`recentThroughput`, `storeUsage` methods)
- `frontend/src/components/wizard/Step1.tsx` (Test connection button + result display)
- `frontend/src/components/wizard/Step2.tsx` (Restart snippet)
- `frontend/src/components/wizard/Step4.tsx` (Send test trace button)
- `frontend/src/App.tsx` (handler for test-connection; mount SystemHealthPanel)

## Estimated effort breakdown

| Item | Estimate |
|---|---|
| Item 1 (Test connection) | 2–3 hrs (backend route + frontend wiring + new unit tests) |
| Item 2 (Restart snippet) | 30 min |
| Item 3 (Send test trace) | 1 hr |
| Item 4 (Health panel) | 4–5 hrs (panel component + 2 new otelStore methods + ring buffer + instrumentation) |
| Item 5 (Network watchdog) | 1–2 hrs (refactor + interval + tests) |
| **Total** | **8.5–11.5 hrs** |

Within the 8–12 hour budget. If the panel runs long, defer the "Clear store" placeholder link and the disclosure-collapsed event log to a follow-up.
