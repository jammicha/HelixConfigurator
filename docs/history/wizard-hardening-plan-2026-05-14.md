# Implementation plan — 5-14-26 wizard hardening

Plan against `docs/5-14-26TODO.MD` after a code review on branch `claude/jolly-edison-8df9e4` (commit `281ddb3`). Two TODO items kept as-written, two reframed against current state, one replaced with a universal alternative.

| TODO | Status | What changed in this plan |
|------|--------|---------------------------|
| 1 — Capability-based collector detection | Reframed | Work happens in `discovery.js`, not `lifecycle.js`. Already image-regex, not "name substring." Adds port 4317/4318 as a second signal + selection metadata. |
| 2 — Verify-trace deadline + verdict | Partially stale | Deadline already 15s (commit `c99711c`); bumping to 20s. Real work is dual-side counter reads + 2 new verdicts. |
| 3 — Persist gateway network in compose | Replaced | Original would break non-OTel-demo deployments. Universal alternative: persist bridged networks to disk + auto-reattach on configurator startup. |
| 4 — Step 3 check is topology-only | Kept | Adds receiver-listening + exporter-success checks before showing green. Multi/zero-collector claims already handled in UI today. |
| 5 — Step 3 UI copy hardcodes helix-bridge | Kept (partial) | Heading fix + collector-by-name. Drops the "customer collector must never join helix-bridge" guard — the manual Option B legitimately offers that wiring and the auto path already only attaches helix-gateway. |
| (Sidebar) APP_URL off-host detection | New | When `APP_URL` resolves to a non-loopback hostname that doesn't match any local container, surface a specific "off-host" message instead of generic 404. |

---

## Sequencing

```
Phase A (independent, ship in any order)
├── Item 5 — Step 3 copy                   ~30 min
├── Item 1 — capability detection          ~half day
├── Item 3 — network persistence           ~half day
└── (Sidebar) APP_URL off-host             ~30 min

Phase B (Item 4 depends on Item 2's metrics plumbing)
├── Item 2 — verify-trace dual-side        ~half day
└── Item 4 — deep Step 3 verification      ~half day
```

Phase A items are independent and can land together or separately. Phase B lands as one chunk because Item 4 reuses the customer-collector metrics probe from Item 2.

---

## Item 1 — Capability-based collector detection (reframed)

### Context

Today's detection lives in `routes/discovery.js:415-422` (and a duplicate at `routes/lifecycle.js:308-315`):

```js
/opentelemetry-collector/i.test(image) || /otelcol/i.test(image) || /otelcol/i.test(command)
```

That's already image-regex matching (not "name substring" as the TODO claimed). It misses containers running official-image-with-renamed-tag, vendor distros (Datadog, Honeycomb, Grafana Agent), or k8s-managed collectors with non-standard images. It also includes false positives if a container happens to have `otelcol` in its command for unrelated reasons.

### Changes

1. **Add port 4317/4318 exposure as a second signal.** Container has any of those ports in `c.Ports` → likely a collector.
2. **Combine signals with priority:** `image-match AND port-match` ranks highest, then image-match alone, then port-match alone.
3. **Extract the detection into a shared helper** so `lifecycle.js:308` and `discovery.js:415` stop duplicating regex.
4. **Per-candidate detection metadata** returned to the UI: `detectedVia: 'image+ports' | 'image' | 'ports'`. Step 3 surfaces this so the user can override a port-only match they don't recognize.
5. **Explicit helix-* exclusion** at the top of the filter (already there, just hoist it).
6. **Defensive guard in `lifecycle.js bridge-network`**: assert the target network passed in is not `helix-bridge` (already covered by the system-network denylist at line 261-263, but make the assertion explicit and tested).

### Critical files

- `backend/routes/discovery.js` — new `detectCollectorContainers(containers, sidecarName)` helper; rewrite `/api/discovery/collectors` to call it.
- `backend/routes/lifecycle.js` — replace the inline regex at line 308 with the shared helper.
- `backend/util.js` — host the new helper here so both routes import from one place.
- `frontend/src/components/wizard/Step3.tsx` — render `detectedVia` next to each candidate (small badge: "image+ports" / "image only" / "ports only").
- `backend/__tests__/` — new file `detect-collectors.test.mjs` with fixtures: zero collectors, one image-match, one port-match, one image+port-match, compose-prefixed names like `acme_otel-collector_1`, helix-* must always be excluded.

### Reuse

- Existing `c.Ports` array on `docker.listContainers()` results — no new Docker call needed.
- Existing `isKubernetes` detection logic in `discovery.js:488-494`.

---

## Item 2 — Verify-trace deadline (20s) + dual-side verdicts

### Context

`routes/diagnostics.js:221-300` polls *only* the gateway's `:8888/metrics`. Verdicts today: `exported` (sent delta > 0), `rejected` (failed delta > 0), `pending` (neither moved). Already deadline-15s and queue-aware on the gateway side after commit `c99711c`.

What's missing: when a trace doesn't show up, we can't tell whether the customer collector even managed to hand it to the gateway. Reading the customer collector's `otelcol_exporter_*` counters distinguishes:
- **Trace stuck at customer side** → customer collector's `helix_sidecar` exporter is failing/queueing → the gateway isn't reachable from where the collector lives (network or DNS issue).
- **Trace stuck at gateway side** → gateway is receiving but its upstream BMC exporter is failing/queueing → BMC slow or rejecting.

### Changes

1. **Bump deadline 15s → 20s** (`diagnostics.js:271`).
2. **Accept an optional `collectorName` and `collectorMetricsUrl` in the POST body** of `/api/diagnostics/inject-trace-verify`. Frontend passes the Step 3-selected collector. If omitted, falls back to today's gateway-only behavior.
3. **Per-iteration probe of the customer collector's metrics** (default `http://<collectorName>:8888/metrics`, configurable). Pull `otelcol_exporter_sent_*`, `otelcol_exporter_send_failed_*`, `otelcol_exporter_queue_size` for the exporter targeting `helix-gateway` (name starts with `helix_sidecar` or matches what smart-add wrote).
4. **New verdicts** in priority order:
   - `exported` — gateway sent delta > 0 (unchanged).
   - `rejected` — gateway failed delta > 0 (unchanged).
   - `queued_customer` — customer collector queue size grew OR `send_failed_*` grew, while gateway counters did not. Message: *"Trace is stuck at your collector — `helix-gateway` is unreachable from `<collectorName>`."* Remediation: check Step 3 bridge, verify collector container can resolve `helix-gateway`.
   - `queued_gateway` — gateway queue size grew (existing tracking), customer queue stable. Message: *"Trace is stuck at the gateway — BMC Helix is slow or rejecting."* Remediation: check `HELIX_API_KEY` and tenant reachability.
   - `pending` — fallback (everything stable, no movement in 20s).
5. **Frontend (Step4.tsx + App.tsx)** — render the two new statuses with distinct color/icon (warning amber, not danger red) and message + remediation copy from the response.

### Critical files

- `backend/routes/diagnostics.js` — extend `inject-trace-verify`. Add `fetchCustomerCollectorCounters(name, port = 8888)` next to existing `fetchCounters`.
- `frontend/src/App.tsx:1073` — fetch call passes `collectorName` from `detectedCollectors` state.
- `frontend/src/components/wizard/Step4.tsx:235` — handle new statuses, currently only branches on `pending`.

### Reuse

- Existing `fetchCounters(targetContainer)` parser at [diagnostics.js:35-83](backend/routes/diagnostics.js:35) — generalize to accept any container hostname.
- Existing `detectedCollectors` state in App.tsx — already populated for Step 3.

### Caveats

- Customer collector might not expose `:8888/metrics` (depends on their `telemetry.metrics` config). Probe defensively; if unreachable, log and fall through to today's gateway-only behavior — don't fail the verify call.
- Some collectors use Prometheus name `otelcol_exporter_queue_size`, others (older versions) use `otelcol_exporter_queue_capacity`. Parse both.

---

## Item 3 — Universal network persistence (replacement)

### Context

The original TODO proposed hardcoding `opentelemetry-demo` as an external network in `docker-compose.yml`. That'd break any deployment without that exact network name. The underlying problem is real: every `compose down/up` and every gateway recreate drops the gateway's non-helix-bridge network attachments because the bridge is applied imperatively after `compose up`.

### Changes

1. **Persist a list of "should-be-bridged" networks to disk.** New file: `backend/data/bridged-networks.json` (the existing `/app/data` volume mount survives container restarts):
   ```json
   { "networks": ["opentelemetry-demo", "acme-app-net"], "updatedAt": "2026-05-14T18:30:00Z" }
   ```
2. **Write the file on successful bridge.** Both `/api/lifecycle/bridge` (auto) and `/api/lifecycle/bridge-network` (manual) append on success. Idempotent — same network twice is a no-op.
3. **On configurator startup**, read the file and reconcile:
   - For each persisted network, check helix-gateway's current networks.
   - If missing, attempt `docker network connect <name> helix-gateway`.
   - On 404 (network gone), drop it from the persisted list.
   - On 403 (already attached), no-op.
   - On other failure, log and leave the entry for next attempt.
4. **Expose `/api/lifecycle/bridged-networks`** — GET returns the persisted list (so the dashboard can show "gateway is bridged to: foo, bar"); DELETE `/api/lifecycle/bridged-networks/:name` lets the user drop a stale entry without going to the docker CLI.

### Why this works for all use cases

- Doesn't hardcode any network name.
- Doesn't require modifying the user's compose.
- Survives configurator restart, gateway restart, and `compose down/up` cycles (because the configurator starts before the gateway is needed and re-applies the bridge).
- Self-heals — networks that no longer exist get dropped.

### Critical files

- `backend/routes/lifecycle.js` — add `loadBridgedNetworks()`, `saveBridgedNetworks()`, `reconcileBridgedNetworks()`. Call `reconcileBridgedNetworks` from `register(app, { docker })` after the routes are registered.
- `backend/index.js` — ensure the `data/` directory exists at boot (already does, for the OTel store).
- `frontend/src/components/OverviewTab.tsx` or `frontend/src/App.tsx` — small "Bridged networks" pill on the dashboard. Optional for v1.

### Reuse

- Existing `/app/data` volume mount (currently hosts `otel-store.db`).
- Existing `withDockerTimeout` helper.

### Caveats

- If two configurator instances ran against the same Docker socket (rare), they could fight over the file. Single-writer assumption is fine for v1.
- The file is the *desired* state, not the actual state. A reconcile-on-boot is "best effort"; we don't watchdog continuously. If the gateway gets disconnected from a network during runtime (rare), it won't be re-attached until next configurator restart. Watchdog can be added later if real-world shows this matters.

---

## Item 4 — Deep Step 3 verification

### Context

`Step3.tsx:49` decides green/done based on `sharesNetworkWithSidecar`, which is a pure topology check (does the customer collector list any network the sidecar also lists?). It doesn't verify:
- That helix-gateway's OTLP receiver is actually listening on the shared network's interface (could be: receiver disabled in config, gateway crashed but container still exists, port not bound).
- That the customer collector's `helix_sidecar` exporter is succeeding (could be: stuck in retry backoff, DNS failure resolving `helix-gateway`, TLS misconfig).

The user clicks "Continue to Verify" thinking Step 3 passed, then Step 4 fails and they have to dig.

### Changes

1. **New backend route `POST /api/diagnostics/step3-verify`** taking `{ network, collectorName }`. Returns:
   ```json
   {
     "topology": "ok" | "missing",
     "gatewayReceiver": "ok" | "unreachable" | "unknown",
     "collectorExporter": "ok" | "failing" | "unknown" | "not-probed",
     "overall": "green" | "yellow" | "red",
     "message": "...",
     "remediation": "..."
   }
   ```
2. **`gatewayReceiver` probe**: from inside the configurator, attempt `GET http://helix-gateway:4318/` with 2s timeout. 404 is fine (the receiver responds but doesn't serve GET) — that proves the listener is bound. Connection-refused or timeout → `unreachable`.
3. **`collectorExporter` probe**: reuse the customer-collector metrics fetcher from Item 2. Look at `otelcol_exporter_send_failed_*` for the helix-targeted exporter. Non-zero growth in a 3s window → `failing`. Stable at zero → `ok`. If the collector doesn't expose metrics → `not-probed`.
4. **Frontend Step3.tsx** — after a successful bridge, fire the verify call. Replace the static "helix-gateway is on a network with a detected collector. You can continue to Verify." with one of:
   - **Green** (`overall: green`): "helix-gateway is bridged to `<network>` and `<collectorName>` is exporting cleanly. Continue to Verify."
   - **Yellow** (`overall: yellow`): one of the deeper checks couldn't be performed (e.g., collector has no metrics endpoint). "Network looks good but I couldn't verify the exporter is succeeding. You can continue, but watch Step 4."
   - **Red** (`overall: red`): "Network is connected but `<reason>`. Resolve before continuing." (Continue button still allowed but de-emphasized.)

### Critical files

- `backend/routes/diagnostics.js` — new `step3-verify` route.
- `frontend/src/components/wizard/Step3.tsx` — call the new endpoint on bridge success; replace lines 207-215 with the tri-state result.
- `frontend/src/App.tsx` — orchestrate the verify call after `attachResult.ok` lands.

### Reuse

- Customer-collector metrics fetcher built in Item 2.
- Existing `withDockerTimeout` for any docker probes if needed.
- Existing `axios` import in diagnostics.js for the receiver HTTP probe.

---

## Item 5 — Step 3 copy

### Context

`Step3.tsx:53` heading hardcodes "helix-bridge"; body at line 54 says "helix-gateway and your collector need to share a Docker network" (good — generic). Success message at line 59 already names the dynamic network correctly. The hardcoded copy is in the heading and in the Manual Option B snippet.

### Changes

1. **Heading**: change "Connect your collector to `helix-bridge`" to "Connect your collector and helix-gateway to a shared Docker network." (Generic — doesn't pre-decide which side joins which.)
2. **Reference the detected collector by name** in the body when exactly one collector is detected: "We'll bridge `helix-gateway` to `<collectorName>`'s network." When multiple, leave as today.
3. **Manual Option B**: keep the snippet (it's a legitimate alternative path) but reword: "Option B — alternative: attach your container to helix-bridge (use this if your collector can't accept new networks at runtime)."
4. **Three visibly distinct states** (ties in with Item 4 once Item 4 lands):
   - Connected + verified: green banner with both pieces of evidence.
   - Network present, not verified: yellow banner.
   - No collector / no network: existing copy in the empty-state branch.

### Critical files

- `frontend/src/components/wizard/Step3.tsx` only.

---

## Sidebar — APP_URL off-host detection

### Context

When `APP_URL` is set to `https://my-app.example.com` (app deployed elsewhere), `/api/lifecycle/bridge` returns a generic 404 "No running container matches hostname `my-app.example.com`." The user might mistakenly think their setup is broken; really, auto-bridge is the wrong tool because the app isn't on this Docker host.

### Changes

In `routes/lifecycle.js` after the existing `looksLikeIp`/`isLoopback` checks, add a "looks-like-public-hostname" classifier (contains a `.` and isn't a single-word DNS name). If the hostname has dots and didn't match any local container, return 200 with `{ skipped: true, reason: 'APP_URL points off-host. Auto-bridge only works when the app runs on this Docker host. Expose helix-gateway's :4318 to your remote app's network instead.' }` rather than 404.

### Critical files

- `backend/routes/lifecycle.js:162-186` (the existing classifier block).

---

## Verification

Per-item manual checks:

| Item | Check |
|------|-------|
| 1 | Add a fixture container that exposes 4318 but has a non-otel image name. `/api/discovery/collectors` should include it with `detectedVia: 'ports'`. Helix containers must never appear. |
| 2 | With a customer collector that has `helix_sidecar` queued but no gateway reachability, hit Verify → `queued_customer` status with the new message, not `pending`. |
| 3 | Bridge helix-gateway to a network, `docker compose down && docker compose up -d`, observe helix-gateway re-attached to the same network on configurator boot. `cat backend/data/bridged-networks.json` shows the entry. |
| 4 | Stop the customer collector's `helix_sidecar` exporter pipeline (e.g. break the YAML), trigger Step 3 verify → `overall: yellow` or `red` with `collectorExporter: failing`. |
| 5 | Detected collector with name `acme-otelcol`, single instance: Step 3 heading and body reference `acme-otelcol` by name. |
| Sidebar | Set `APP_URL=https://foo.example.com`, trigger Step 1 → response includes the off-host reason, not a 404. |

Run after each phase:
```bash
cd backend && npm test
cd frontend && npm run build
```

Existing 9 otelStore tests should continue passing. Item 1 adds new tests for the detector helper.

---

## Open questions

None I'd block on. Two judgment calls baked in that you can override:

1. **Item 3 reconcile on boot vs. continuous watchdog** — picked boot-only for simplicity. Watchdog can be added later if compose down/up isn't the dominant failure mode.
2. **Item 4 verify endpoint shape** — picked a single `step3-verify` route that returns all three sub-results, rather than three separate endpoints. Easier for the frontend to render a tri-state in one call; trade-off is the endpoint does multiple things.
