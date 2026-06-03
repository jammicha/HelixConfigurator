# Show the problematic span in a Helix AIOps Situation

**Date:** 2026-06-02
**Status:** Design approved (pending spec review)
**Spike result:** Helix Dashboards Text panel (HTML mode) renders an external `<iframe>` — embedding is viable (confirmed live, 2026-06-02).

## Goal

When an OTel trace anomaly becomes a Situation in BMC Helix AIOps, make the **problematic span** (the originating error span) visible to an operator looking at the Situation — both as readable text *on* the Situation and as the live, highlighted span in a waterfall embedded in a linked Helix dashboard.

## Background / why

- The Situation details page is a fixed BMC product UI — not extensible, no in-context trace view (trace viewing is an explicit click-out to BMC Helix Dashboards).
- BMC Helix has **no span-level waterfall** of its own; the native OTel Trace Details dashboard is aggregate panels + a hierarchical service list, and takes only a Trace ID (no span anchor).
- The only real span waterfall (with highlight logic) is the configurator's own OTel viewer.
- The anomaly event already identifies the problem span via `deriveProbableCause()` and ships its service/operation/error/code-location — but not the span id, and the existing `trace_url` deep-links to the whole trace on the native dashboard.

## Chosen approach: Options 2 + 3 (additive)

One enriched event, two surfaces:
- **Option 3 (in-situation text):** surface the problem span's identity as Event Details slots + let HelixGPT narrate it. Lives on the Situation page. No click-out.
- **Option 2 (embedded waterfall):** a custom Helix dashboard with a Text/HTML panel that iframes the configurator's chromeless waterfall (trace + span), highlighted. Linked from the Situation's event. Lives in a Helix dashboard.

Explicitly **not** doing: a literal embed inside the Situation details page (not possible); a click-out as the primary UX (user declined) — though the same embed route degrades to a clickable link if a future tenant's CSP differs.

## Non-goals

- Automating creation of the Helix dashboard from the configurator (it's a manual, one-time tenant artifact — consistent with [[feedback_manual_tenant_destructive_ops]]).
- Enabling HelixGPT (tenant subscription/Support task; out of scope — we only feed it richer slots).
- Replacing the native OTel Trace Details dashboard link (keep it as a secondary "see it in Helix" beat).

## Components

### A. Span enrichment (shared backbone) — backend

- `deriveProbableCause()` (`backend/routes/situations-payloads.js:163`): also return `probable_cause_span_id` from the already-computed `origin` span.
- `buildAnomalyEventPayload()` (`:66`): add slots:
  - `probable_cause_span_id`
  - `hot_path` — compact ordered path with the failing op marked, e.g.
    `frontend → driver → redis-manual ✗ Fetch Driver Profile (4.2× p95 · errors.errorString @ profile.go:88)`
- Class definition: register `probable_cause_span_id` and `hot_path` in `buildClassDefinition()` (`:8`); they flow through the existing non-destructive class-update path (`buildClassUpdateBody`, `:50` — PUT by UUID, drop built-in attrs).
- Preserve the legacy no-spans collapse: with no spans, output must still equal the original event shape (existing pinned tests).

### B. Option 3 surfacing — backend + tenant verification

- The new slots render in **Event Details**; `hot_path` makes the failing span legible at a glance.
- Optionally extend the correlation-policy ALARM `msg` (`:319`) to include code location. (Keep leading with reliably-populated slots — error_message / probable_cause_operation / component_count.)
- HelixGPT narration is automatic on the enabled tenant; no build work — it just consumes the richer slots + causal graph.
- **Verify in target tenant:** Event Details shows the new custom slots in the default view (may require the customizable-slots feature).

### C. Option 2 surfacing — frontend + backend + manual dashboard

- **C1. Chromeless embed route (frontend, definite):** `/otel-data/embed?trace=<id>&span=<spanId>`
  - Renders only the waterfall (reusing `TraceDetailDrawer`/Waterfall, no app shell/nav).
  - Reads `?trace`/`?span`, auto-opens the trace (reuse the `selectedTraceId`/`onJumpToTrace` path, `OtelDataPage.tsx:1400`), drives the existing highlight pass to scroll to + highlight that span.
- **C2. Frame-permissive headers (backend, definite):** for the embed route, set
  `Content-Security-Policy: frame-ancestors https://<helix-tenant-host>` and ensure no `X-Frame-Options: DENY/SAMEORIGIN`.
  - Task: audit current security-header middleware (helmet?) and exempt/override the embed route. Make the allowed frame-ancestor host configurable (env).
- **C3. Span-anchored dashboard link (backend):** extend the `buildHelixTraceUrlFromSummary()` pattern (`:255`) to build a URL to the **custom** dashboard with `var-TraceId` and `var-SpanId`, e.g.
  `https://<tenant>/dashboards/d/<uid>/otel-problem-span?orgId=<tid>&var-TraceId=<ID>&var-SpanId=<spanId>`
  - Dashboard UID configurable (env/config). Put this in a slot (e.g. `span_dashboard_url`) and the `details` text. Keep existing `trace_url` (native dashboard) as secondary.
- **C4. Custom Helix dashboard (manual, one-time):** "OTel Problem Span" dashboard with template vars `TraceId`/`SpanId` and a Text panel (HTML mode):
  `<iframe src="https://<viewer-base>/otel-data/embed?trace=${TraceId}&span=${SpanId}" width="100%" height="800" frameborder="0"></iframe>`
  - `<viewer-base>` = configurator public/tunnel base (same as `computeInstallBaseUrl`, `backend/routes/demo.js:1083`).
  - Confirm Grafana Text-panel variable interpolation in this Helix version (standard, near-certain).

## Data flow

anomaly trace → enrich event (span id + hot_path + cause fields + span-anchored dashboard URL) → events-service → correlation policy → Situation.
Operator opens Situation → reads enriched slots + HelixGPT summary (Option 3) → clicks the span-dashboard link → custom Helix dashboard renders the embedded waterfall with the problem span highlighted (Option 2).

## Configuration additions

- `HELIX_PORTAL_HOST` / frame-ancestor host (for C2 CSP) — derivable from existing endpoint config.
- Viewer public base for the iframe src (reuse install-base logic).
- Custom dashboard UID (for C3 link building).

## Risks / open items (now small)

- **CSP frame-ancestors (C2):** the only real build risk — our own headers must permit framing. Fully in our control.
- **Event Details slot visibility (B):** confirm custom slots surface without extra config.
- **Text-panel var interpolation (C4):** confirm `${TraceId}` substitution; fallback is a per-trace dashboard URL with the src hardcoded (worse, avoid).
- **Tunnel base in the iframe src:** ephemeral tunnel URL must match what's baked into the dashboard panel; if the tunnel rotates, the panel src goes stale. Mitigation: use a stable base, or template the host too.

## Testing

- **Backend unit:** `deriveProbableCause` returns `probable_cause_span_id`; payload includes `probable_cause_span_id`/`hot_path`/span-dashboard URL; **legacy no-spans path still collapses to the original shape** (existing pinned tests stay green).
- **Frontend:** embed route renders the waterfall and highlights the `?span=` span; renders standalone (no shell) and inside an iframe.
- **Live:** inject a synthetic error trace → send event → confirm new slots in Helix Event Details → open the custom dashboard URL → confirm embedded highlighted span end-to-end.

## Sequencing

1. **A + B** (Option 3) — safe, immediate, independent.
2. **C1 + C2 + C3** (embed route + headers + link).
3. **C4** manual dashboard + live end-to-end verification.

## Implementation notes

- Per [[reference_helix_worktree_and_docs_workflow]]: isolate code edits in a manual git worktree (the tree is shared with a concurrent session; the EnterWorktree hook is broken), symlink node_modules. This `docs/` spec is gitignored / local-only.
