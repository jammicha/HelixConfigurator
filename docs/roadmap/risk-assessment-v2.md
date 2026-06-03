# Helix Configurator — Risk & Weak-Point Assessment v2

## Context

This is a follow-up to [v1](../deprecated/risk-assessment-v1.md) (23 findings, May 2026). Since v1, the "weekend hardening" PR shipped, plus significant new surface area: Step Zero synthetic e-commerce demo, dashboard rework (Pipeline banner, System Health panel, Quick Actions, Helix Connection Settings drawer), in-product UI password management, view-OTel namespace/container filters with range-aware errors/logs, and nav restructuring.

Three parallel reviewers (backend, frontend, new-surface deep dive) covered the project. Findings de-duplicated against v1 — anything addressed by weekend hardening is summarized in "v1 status" below and not re-listed. Items that *extend* a v1 finding are explicitly cross-referenced.

Severity: P1 (ship-blocking, data-loss, security) / P2 (significant degradation) / P3 (polish).

---

## v1 status

| v1 # | Status |
|------|--------|
| 1 timing-safe password compare | ✅ fixed |
| 2 path traversal via bind-mount Source | ✅ fixed (POSIX only — see v2 #28) |
| 3 wizard setupStep not persisted | ✅ fixed (but validation gap — see v2 #6) |
| 4 SSE failures not surfaced | ⚠ partially — pill landed, but reconnect missing (see v2 #1) |
| 5 smart-add silent dismiss | ✅ fixed |
| 6 overview-bundle 6 serial scans | ⚠ partial; serviceMap filter gap remains (see v2 #20) |
| 7 listTraces correlated subqueries | ✅ fixed (CTE rewrite) |
| 8 SSE + 30s poll double-write | ✅ fixed (poll short-circuits while SSE healthy) |
| 9 network attach failures swallowed | ⚠ still open (deferred from v1 bundle) |
| 10 no Docker timeouts | ⚠ partial — helper landed, several lifecycle call sites still unwrapped (see v2 #10) |
| 11 listContainers cached | ⚠ partial — cache landed, smart-add path bypasses it (see v2 #9) |
| 12 unbounded `limit` | ✅ fixed (clamped to 500) |
| 13 Heatmap memoization | ✅ fixed |
| 14 TimelineChart memoization | ✅ fixed |
| 15 form aria-invalid | ✅ fixed |
| 16 ConfirmDialog Esc | ✅ fixed |
| 17 AiopsPage demo gate | ✅ fixed |
| 18 OverviewTab empty-state | ✅ fixed |
| 19 YAML smart-add engine surface | ⏸ deferred (product call) |
| 20 toast cap | ⏸ deferred (intentional) |
| 21 WizardModals focus trap | ⏸ still open; SetPasswordModal has the same gap (see v2 #18) |
| 22 SSE heartbeat leak on close | ✅ fixed |
| 23 otelStore eviction labeling | ⏸ deferred (product call) |

---

## P1 — Critical

### Stability — live OTel viewer

1. **SSE never reconnects after the first drop** — [`frontend/src/components/OtelDataPage.tsx:577-701`](frontend/src/components/OtelDataPage.tsx:577)
   The `EventSource` is opened in a `useEffect(…, [])` with no recovery. `onerror` flips `sseConnected` → false (so the "Reconnecting…" pill we added in PR #3 lights up correctly) but no code re-opens the stream. After any transient drop, or the ~1-hour Cloudflare proxy idle-timeout, the live view silently stops forever until the user reloads. *Extends v1 #4 — the indicator landed, the recovery didn't.* Fix: on `onerror`, close + recreate the EventSource with exponential backoff; mirror the `sseAttempt`-based pattern App.tsx already uses for the main connection.

2. **No 30s fallback poll on Logs and Errors tabs** — [`frontend/src/components/OtelDataPage.tsx:534-541`](frontend/src/components/OtelDataPage.tsx:534)
   Only `refreshTraces` has a 30s fallback. Once SSE dies (see #1), traces eventually recover via the fallback tick but logs and errors freeze indefinitely. Add the same pattern to `refreshLogs`/`refreshErrors`.

### Security — auth-off mode is the attack surface

3. **CORS wildcard with `credentials: true`** — [`backend/index.js:27`](backend/index.js:27)
   `cors({ credentials: true })` sends `Access-Control-Allow-Origin: *`. With `UI_AUTH_REQUIRED=false` (the default tunneled-demo mode), every state-changing POST — lifecycle restart, env write, set-password, smart-add, inject-trace — is reachable cross-origin from any web page the tester has open in another tab. Browsers refuse `*` + credentials for cookied calls, but with auth off the entire API is cross-origin-callable without cookies. Fix: lock `origin` to an allowlist derived from `req.get('host')` or the explicit tunnel hostname; require an `Origin` check on mutating POSTs.

4. **`POST /api/auth/set-password` is reachable unauthenticated** — [`backend/auth.js:171`](backend/auth.js:171)
   When `UI_AUTH_REQUIRED=false`, `requireAuth` is a passthrough, so the bootstrap-set route is openly callable. Any tunnel visitor can write a password into `.env` and trigger a self-restart, locking the legitimate operator out. The route's own comment treats this as intentional "bootstrap," but combined with #3 and tunnel exposure it's drive-by lockout. Fix: gate behind a one-time bootstrap token (printed to stdout on first boot) when no password is set; or refuse unless the request is from loopback.

5. **`.env` injection via password value** — [`backend/auth.js:84-106`](backend/auth.js:84)
   `persistUiPasswordToEnv` only `trim()`s the input before writing `UI_AUTH_PASSWORD=<raw>` to disk. A password containing `\n` injects arbitrary `KEY=value` lines (`hunter2\nDEBUG=*`, `hunter2\nUI_AUTH_REQUIRED=false`). Loaded on next boot. Also breaks the `split('=')` parser in `env.js`. Fix: reject `\n`/`\r`/`\0`/`=`-at-col-0 in the password, or base64-encode/quote-escape on persist and decode on read.

### Functionality — wrong-mental-model bugs

6. **`setupStep` hydrates from localStorage without env validation** — [`frontend/src/App.tsx:36-40, 273`](frontend/src/App.tsx:36)
   A user with `helix-configurator.setupStep=4` but no `HELIX_API_KEY` (cleared `.env`, or rolled back the container, or hit the new reset-onboarding mid-wizard) lands on Step 4 Verify with empty env. The button silently no-ops against Helix. Also: `handleJumpToOnboarding` calls `setSetupStep(1)` without clearing the persisted key. *Extends v1 #3 — persistence landed, validation didn't.* Fix: on hydrate, downgrade `setupStep` to 1 when required env is empty; clear the key in `handleJumpToOnboarding`.

7. **`waitForRestart` treats any HTTP error as "server died"** — [`frontend/src/components/dashboard/SetPasswordModal.tsx:292-312`](frontend/src/components/dashboard/SetPasswordModal.tsx:292)
   `waitForRestart` flips `sawDeath=true` on any `!r.ok`. A mid-restart 401 from auth-required boot, or a proxy 502, satisfies "saw death," then the next 401 reads as "back up" → reload → login loop. Fix: only the catch branch (network failure) counts as "saw death" — HTTP error responses prove the server is answering.

8. **Namespace / container filter tooltip lies on Logs and Errors tabs** — [`frontend/src/components/OtelDataPage.tsx:920-957`](frontend/src/components/OtelDataPage.tsx:920) + [`backend/routes/traces.js:53-60, 311-322`](backend/routes/traces.js:53)
   The dropdowns claim "Applies to every tab." `/api/logs` and `/api/traces/errors` accept neither param; `listLogs`/`listErrors` don't take them. Client-side `visibleLogs`/`visibleErrors` only apply `serviceFilter`. So setting `namespace=foo` silently does nothing on those tabs. Fix: thread filters into `listLogs`/`listErrors` (join via `spans.trace_id` like `listOperations` does), or revise the tooltip + dim the pill on those tabs.

### Performance — ingest path

9. **30-minute `VACUUM` takes an exclusive lock on the ingest DB** — [`backend/otelStore.js:227-236`](backend/otelStore.js:227)
   `VACUUM` rewrites the whole DB under an exclusive lock; with WAL + in-process writer this can stall OTLP ingest (and every read, every SSE fan-out) for seconds-to-minutes on a populated store. `_evictIfNeeded` runs inside every ingest transaction — concurrent VACUUM can block live traces entirely. Fix: switch to `PRAGMA auto_vacuum=INCREMENTAL` + periodic `incremental_vacuum`, or only VACUUM after N seconds of WAL quiet.

---

## P2 — High

### Backend stability — Docker call gaps after v1 #10

10. **Several lifecycle Docker calls still not wrapped in `withDockerTimeout`** — [`backend/routes/lifecycle.js:149-205`](backend/routes/lifecycle.js:149)
    `old.inspect()`, `old.stop()`, `old.remove()`, `createContainer`, `network.connect`, `fresh.start()` all unbounded. `recreateGateway` is the hot path for `/restart`, `/bridge`, `/bridge-network`, `/unbridge-network`, `/reset-onboarding`. A wedged daemon hangs each for the full 120s Express default. *Extends v1 #10 — helper landed, these sites missed during the wrap.* Fix: wrap them.

11. **`isRecognizedCollectorContainer` bypasses the 60s collectors cache** — [`backend/routes/discovery.js:438-442`](backend/routes/discovery.js:438)
    `docker.listContainers({ all: true })` runs on every `/collector-config` and `/collector-apply` without consulting `collectorsCache`. A burst (smart-add wizard click-through) serializes 50-200ms calls. *Extends v1 #11 — cache landed, this code path bypasses it.* Fix: reuse the cache, or maintain a small `Set<name>` invalidated on apply.

### Backend stability — data correctness & ergonomics

12. **`POST /api/env` mirrors UNTRIMMED values into `process.env`** — [`backend/routes/env.js:91-96`](backend/routes/env.js:91)
    The trimmed values are written to disk (line 53-58) but the un-trimmed `req.body` is copied into `process.env`. Same-process consumers (`situations.js`, `demo.js`, `helix-link.js`) see one version; the gateway-recreate path reads the trimmed disk version — silent drift like a trailing newline in `HELIX_API_KEY` shipping to event-class provisioning. Fix: use the trimmed `updates` object for `process.env` too.

13. **API-key fragments can leak into the support bundle via gateway log scraping** — [`backend/routes/diagnostics.js:1185-1192`](backend/routes/diagnostics.js:1185)
    The apikey diagnostic greps the gateway's recent stdout for `401`/`403`/`unauthorized`. Some Helix tenants echo (partial) submitted credentials into the failure response body, which the collector logs verbatim. That 15s window then surfaces via `/diagnostics/logs/recent` and the Copy Support Bundle — risk that a paste-into-Slack leaks credential fragments. Fix: redact `X-Api-Key:`, `apikey ` bearer prefixes, and anything matching the 3-part-colon key shape from the log buffer before returning.

14. **`/api/diagnostics/inject-trace` keeps looping after client disconnect** — [`backend/routes/diagnostics.js:576-615`](backend/routes/diagnostics.js:576)
    Up to 10 attempts × 1s with no `req.aborted` check. A user who navigates away leaves the loop POSTing to the gateway; repeated taps stack independent loops. Fix: check `req.aborted` between attempts.

### Step Zero — synthetic demo

15. **`/api/step-zero/synthetic/start` has no atomic guard** — [`backend/routes/step-zero/synthetic.js:14, 156-193`](backend/routes/step-zero/synthetic.js:14)
    `activeRun` is module-scope; two POSTs both pass the `if (activeRun && activeRun.running)` check before either assigns. Second clobbers the first; the first loop's `try/finally` clears the *second* run's `running` flag, leaving an orphaned loop POSTing traces forever (until `/stop`). Convergent finding across two reviewers. Fix: set a synchronous sentinel before any awaited step, or wrap in a per-process async lock.

16. **Step Zero ignores the placeholder-endpoint check** — [`backend/routes/step-zero/synthetic.js:51-58, 156-180`](backend/routes/step-zero/synthetic.js:51)
    `useGateway` is decided by `HELIX_ENDPOINT` presence only. The wizard already has `isPlaceholderEndpoint` in [`helix-link.js`](backend/routes/step-zero/helix-link.js) for the default `your-tenant.onbmc.com`. With that placeholder, the Step Zero toast says "Streaming through Helix Gateway → your Helix tenant" while traces dead-letter into nowhere. Fix: reuse `isPlaceholderEndpoint`; fall back to local sink.

17. **`useSyntheticRun` polls independently from each consumer** — [`frontend/src/hooks/useSyntheticRun.ts:57-61`](frontend/src/hooks/useSyntheticRun.ts:57)
    `Layer2Synthetic`, `PipelineStatusBanner.SyntheticRunCompact`, and any other mount each install their own 1s/5s interval. Effect dep `[fetchStatus, status?.running]` recreates the interval on every status object (new ref every tick). Convergent finding. Fix: hoist to a shared context/provider; depend on the boolean only.

### Dashboard / auth UI

18. **`SetPasswordModal`: fragile Enter handler + no focus trap** — [`frontend/src/components/dashboard/SetPasswordModal.tsx:96-101`](frontend/src/components/dashboard/SetPasswordModal.tsx:96)
    Enter walks the DOM via `parentElement.parentElement.querySelector` — any wrapper change breaks it. Modal claims `aria-modal="true"` but doesn't trap Tab. *Same shape as v1 #21 (WizardModals), still open.* Fix: refs on both inputs; standard focus-trap pattern.

19. **`HelixConnectionSettingsDrawer` doesn't snapshot envVars on open** — [`frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx`](frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx) + [`frontend/src/App.tsx:859-898`](frontend/src/App.tsx:859)
    Inputs are controlled directly on `envVars` state. Edit + Cancel does NOT revert. The next "Update Settings" or wizard re-init pushes the unsaved edit through. Fix: snapshot on open, restore on cancel; or only `setEnvVars` on Save.

20. **`/api/overview-bundle` `serviceMap` ignores namespace/container filters** — [`backend/routes/traces.js:200-242`](backend/routes/traces.js:200)
    Every other call in the bundle (`overview`, `heatmap`, `insights`, `tracesHistogram`) honors the filters; `serviceMap` (line 229) doesn't. Result: the service map keeps showing every service even when the user has filtered to one namespace. Inconsistent inside one endpoint response. Fix: thread filters through, or drop the service map from the namespace-aware bundle.

21. **`handleInitialize` advances to Step 2 even when bridge fails** — [`frontend/src/App.tsx:957-1010`](frontend/src/App.tsx:957)
    Only `diagData.status !== 'Success'` throws; a `!bridgeRes.ok` is logged but ignored. User sees Step 2 with their `.env` un-applied; the warning shows up on a future Step 3/4 banner they may never see if they restart first. Fix: throw on `!bridgeRes.ok`, or surface the bridge error inline on Step 1.

22. **`SetPasswordModal.waitForRestart`: container restart is fire-and-forget** — [`backend/auth.js:113-123, 171-196`](backend/auth.js:113)
    If `container.restart()` throws (socket unmounted, permissions, container renamed), the server has already returned `{ok:true, restarting:true}` 5s earlier; the client polls `/api/health` for 30s and then shows "Restart didn't complete." Real cause buried in server stderr. Fix: catch + persist last-restart-error to a status endpoint; or dry-run an inspect before returning OK.

### View-OTel filters

23. **`spans` ns/container filter has no covering index; `listFilterValues` grows forever** — `backend/otelStore.js` (operations + filter paths)
    `WHERE trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE service_namespace = ?)` runs without a `(service_namespace, trace_id)` index. `listFilterValues` is lifetime-wide (no time window) so the dropdown keeps growing as old namespaces evict from `traces`. Fix: add the index; cap or window the filter-value listing.

24. **30s fallback interval rebuilds on every filter-state change** — [`frontend/src/components/OtelDataPage.tsx:534-541`](frontend/src/components/OtelDataPage.tsx:534)
    Effect deps include `serviceFilter`/`namespaceFilter`/`containerFilter`/`range`/`customRange`. Typing in URL-sync'd filter inputs rebuilds the interval every keystroke and can fire an immediate `refreshTraces` during the debounce window. Fix: read filters via refs you already maintain; keep the interval on empty deps.

### Frontend stability / a11y

25. **Body-scroll lock isn't ref-counted across stacked modals** — [`frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx:42-47`](frontend/src/components/dashboard/HelixConnectionSettingsDrawer.tsx:42)
    Each component captures the previous `body.style.overflow` and restores it on close. Two open at once → inner restores `''` and unlocks the outer. Fix: shared ref-counted lock helper.

26. **System Health relative-time badges go stale** — [`frontend/src/components/dashboard/SystemHealthPanel.tsx:30-34`](frontend/src/components/dashboard/SystemHealthPanel.tsx:30)
    `fmtAgo` is computed once per render. "Last error 2s ago" stays "2s ago" for minutes; user thinks the error just happened. Fix: a 30s tick (or shared `useNow`) so relative times refresh even when health data doesn't.

27. **Nav menus lack keyboard a11y patterns** — [`frontend/src/components/NavAvatar.tsx:60-72, 197-204`](frontend/src/components/NavAvatar.tsx:60)
    No `role="menu"`/`menuitem`, no arrow-key nav, no focus return to trigger on Esc/click-outside. Keyboard users open the menu and lose context. Fix: standard menu-button pattern with focus management.

28. **`Layer3Instrument` collapsible isn't keyboard-operable** — [`frontend/src/components/step-zero/Layer3Instrument.tsx:45-63`](frontend/src/components/step-zero/Layer3Instrument.tsx:45)
    `<div role="button" onClick>` with no `tabIndex={0}` and no `onKeyDown`. Keyboard users can't expand the section. Fix: use a real `<button>`.

29. **External-app URLs not URL-encoded** — [`frontend/src/App.tsx:1722-1730`](frontend/src/App.tsx:1722), [`frontend/src/components/NavAvatar.tsx:121-127`](frontend/src/components/NavAvatar.tsx:121)
    `helixConfig.source` / `tenantId` / BSK concatenated raw into URLs. An `&`, `#`, `?`, or space in `X_SOURCE` breaks or silently injects a param. Fix: `encodeURIComponent`.

---

## P3 — Polish

30. **PipelineStatusBanner shows "loading" in `degraded`/warning color** — [`frontend/src/components/dashboard/PipelineStatusBanner.tsx:25-72`](frontend/src/components/dashboard/PipelineStatusBanner.tsx:25). First impression on a slow first paint is "something's wrong." Fix: neutral until first probe returns.

31. **`TraceDetailDrawer.sentEvents` localStorage unbounded across trace count** — [`frontend/src/components/otel-data/trace-detail/TraceDetailDrawer.tsx:34-38`](frontend/src/components/otel-data/trace-detail/TraceDetailDrawer.tsx:34). Capped at 10/trace, never pruned globally; long-lived install eventually hits quota. Fix: LRU at ~500 trace IDs.

32. **Discovered Services drawer breaks responsive layout** — [`frontend/src/App.tsx:2300-2375`](frontend/src/App.tsx:2300). Inline 450px sibling shrinks the main content. Fix: convert to fixed-position overlay drawer like `HelixConnectionSettingsDrawer`.

33. **External `target="_blank"` links use `rel="noreferrer"` without `noopener`** — `NavAvatar.tsx:137-167`, `App.tsx:1722-1730`, `App.tsx:2326`. Modern browsers default `noopener` since 2021, but legacy Safari/Edge can still leak `window.opener`. Fix: `rel="noopener noreferrer"`.

34. **`/otel-data` page doesn't render `NavAvatar`** — uses its own inline nav. Means the unified app-switcher / "currentPage" highlighting goal isn't met on the OTel viewer. Fix: render `NavAvatar` with `currentPage="otel-data"` (or document the divergence).

35. **`Math.min(...arr)` / `Math.max(...arr)` on potentially large arrays** — [`backend/otelStore.js:1056-1058, 1208`](backend/otelStore.js:1056). Stack-blower at TRACE_CAP growth (related to v1 #23). Fix: `arr.reduce`.

36. **`synthetic.js` reads `.env` synchronously on every `/start`** — [`backend/routes/step-zero/synthetic.js:60-71`](backend/routes/step-zero/synthetic.js:60). Bypasses `env.js`'s write lock; a `/start` racing a `POST /api/env` can read a half-written file. Fix: read from `process.env`, or share the env lock.

37. **Step Zero pattern B emits per-trace metrics for `checkout-web` only** — [`backend/routes/step-zero/synthetic-scenario.js:299-301, 121`](backend/routes/step-zero/synthetic-scenario.js:299). Comment claims "per-service latency observations" but only one service gets a data point. Fix: emit one per service, or trim the comment.

38. **Windows host-path containment check is a no-op** — [`backend/routes/discovery.js:188-199`](backend/routes/discovery.js:188). `isHostPathUnderSource` skips drive-letter / UNC paths. The v1 #2 fix is POSIX-only. Fix: equivalent `win32.normalize` containment, or refuse Windows host paths.

39. **Legacy `/diagnostics/apikey` accepts unstripped CRLF in headers** — [`backend/routes/diagnostics.js:1166-1174`](backend/routes/diagnostics.js:1166). `apikey-probe` trims; the legacy disk-read path doesn't. A trailing newline in `HELIX_API_KEY=foo::bar::baz\n` ships a literal newline in the next `X-Api-Key` header. Fix: trim before regex; reject embedded `\r\n` explicitly.

40. **`/api/_demo/aiops/latest.zip` archiver doesn't tear down on client disconnect** — [`backend/routes/demo.js:1039-1051`](backend/routes/demo.js:1039). A slow client + abort leaves the glob walking the project root. Fix: `res.on('close', () => archive.abort())`.

41. **Quick Actions "Copy support bundle" has no busy state, no clipboard-error hint** — [`frontend/src/components/dashboard/QuickActions.tsx:55-57`](frontend/src/components/dashboard/QuickActions.tsx:55). User can fire 5 in a row; clipboard fails silently on HTTP contexts. Fix: busy state + actionable error.

---

## Themes

1. **Auth-off mode is the attack surface.** Findings #3, #4, #5, plus implications for #12, all hinge on `UI_AUTH_REQUIRED=false` being the default for tunneled demos. The mode is documented as "the random tunnel URL is the secret" but the API surface has grown beyond what that assumption covers. Minimum bar: refuse mutating routes when auth is off unless the request is from loopback, or behind a bootstrap token.
2. **The "Reconnecting…" pill is the highest-leverage UX bug.** It's the most-visible promise PR #3 made and it's broken (#1). ~30 LOC.
3. **Persistence outran validation.** localStorage `setupStep`, drawer `envVars`, SSE event id, sent-events map — multiple places persist or accumulate without bounds or hydration guards.
4. **The new filter axes are half-wired.** Tooltip and filter UI advertise a unified-filter abstraction the backend honors on traces/heatmap/insights but ignores on logs/errors/serviceMap (#8, #20).
5. **Partial fixes from v1 left ragged edges.** v1 #10 (timeouts) and #11 (cache) each shipped a helper but not all call sites; #4 shipped the indicator but not the recovery. Worth a "fix-the-gaps" sweep before adding more.

---

## Blind spots

- No reviewer ran the tests or `EXPLAIN QUERY PLAN`. Perf claims are static-analysis level.
- `routes/situations.js` (event-class provisioning) — read but not deeply audited.
- Bash/PowerShell install scripts in `routes/demo.js` — quoting edge cases not inspected.
- The hand-rolled OTLP protobuf encoder in `diagnostics.js:171-241` — read, not wire-verified.
- Mobile / narrow-viewport behavior of `OtelDataPage` and Discovered Services drawer — not tested.
- Backend test files — not read; could surface untested error paths.

---

## What I would do next if asked to act

Smallest-blast-radius fixes that buy the most:

1. **#1 SSE reconnect** — restores PR #3's promise; ~30 LOC.
2. **#3–#5 auth-off hardening** — three connected fixes (CORS allowlist, loopback-only mutations when auth off, `.env` injection guard). Closes the demo attack surface in one pass.
3. **#10 finish the `withDockerTimeout` wrap** — already-built helper, just thread through the missed call sites.
4. **#8 + #20 filter consistency** — either honor the filters on logs/errors/serviceMap, or remove them from the UI for those tabs. Pick a side.
5. **#9 incremental VACUUM** — replace the 30-min `VACUUM` with `auto_vacuum=INCREMENTAL` + periodic `incremental_vacuum`. One-time migration, large payoff.

Everything else can wait or fold into TODO.md.

---

## Verification

This is an assessment, not an implementation. To verify high-impact findings before acting:
- **#1 SSE reconnect**: stop the gateway with the OTel Data page open in Live mode → confirm "Reconnecting…" pill lights up → restart gateway → confirm the pill does NOT clear without reload.
- **#3 CORS**: from another origin, `curl -X POST -H "Origin: https://evil.example" https://<tunnel>/api/lifecycle/restart` → confirm it succeeds when auth is off.
- **#4 set-password**: `curl -X POST https://<tunnel>/api/auth/set-password -d '{"password":"x"}' -H 'Content-Type: application/json'` with auth off → confirm 200.
- **#5 .env injection**: try password `"x\nDEBUG=*"` via the UI → confirm `.env` has a `DEBUG=*` line after.
- **#6 setupStep validation**: complete Step 1 → manually clear `HELIX_API_KEY` from `.env` → refresh → confirm whether you land on Step 4 with empty env.
- **#8 filter lies**: set a namespace filter → switch to Logs tab → confirm no filtering happens.
- **#9 VACUUM stall**: time `curl /api/traces` while VACUUM runs.
- **#10 Docker timeouts**: pause the Docker daemon → `curl -X POST /api/lifecycle/restart` → confirm it takes 120s, not 15s.

No tests need to run for the audit itself.
