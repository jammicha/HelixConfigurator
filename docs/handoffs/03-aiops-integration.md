# 03 — Configurator ↔ Helix AIOps integration (richer Situations)

> **Handoff brief** · Priority: **Medium** · Created 2026-06-03 · Status: Not started
> Shape: **brainstorm brief.**
> Companion roadmap already exists: [`../situations-gartner-mapping.md`](../history/situations-gartner-mapping.md)
> — read it; this brief frames the brainstorm around it.

## TL;DR

The demo's biggest "wow" was the **local trace viewer ↔ Helix AIOps hooks** —
open a local trace, jump to the same trace in Helix, and create Helix
events/Situations from it. James wants to **push further on that integration**,
and named the highest-value direction himself: **richer Situations**, built by
mining the OTel data the local viewer already extracts.

## Origin (demo feedback)

> "They were wowed by the local trace viewer ↔ Helix tenant hooks… anything on
> the configurator ↔ Helix AIOps integration front we can improve would be a good
> improvement."
>
> Direction (James): **Scenario A** — *the local trace viewer + its OTel data are
> the starting point; use them to make AIOps richer.* "I imagine the highest
> value add will be to have richer Situations." Nothing more specific — this is
> open brainstorming territory.

## Current state

- **The configurator already creates Helix events/Situations.** "Send to AIOps"
  in the trace detail drawer emits a Helix event; there's situation/correlation
  plumbing in `backend/routes/situations.js` and
  `backend/routes/situations-payloads.js`. A correlation policy has been
  provisioned live (non-destructively) so anomalies cluster into Situations.
- **But the Situation is thin.** Per
  [`../situations-gartner-mapping.md`](../history/situations-gartner-mapping.md): today
  the configurator emits essentially **one** Situation type — "≥3 slow/error
  traces on one service in 30s" — which **clusters noise but names no cause,
  carries no impact, and links nowhere.** That gap *is* the opportunity.
- **The local viewer already computes the raw material for a rich Situation** and
  just doesn't forward it: exception type/message, originating service +
  operation, N+1 detection, critical path, per-service breakdown (a blast-radius
  proxy), SQL/HTTP rollups. See
  `.../otel-data/trace-detail/TraceDetailDrawer.tsx` and the store's
  `span_errors` derivation (ARCHITECTURE.md §8).
- **Helix deep-linking exists.** Trace rows link to the same trace in Helix; the
  reusable URL builder is `buildHelixTraceUrl` (referenced in the gartner-mapping
  doc). `BUSINESS_SERVICE_KEY` pins a Situation/event to one Business Service
  instead of fanning across everything sharing a `service.name`.

## The roadmap already exists — use it

`situations-gartner-mapping.md` maps the BMC Helix capability demo (Deep RCA,
agentic blast-radius, change-aware RCA, closed-loop remediation) to **what a
Situation must carry to feed each beat**, and ranks **6 enrichment priorities by
demo-impact-per-effort**:

1. **Name the probable cause** in every event — exception type/message,
   originating service+operation, code location. *Pure function of trace data we
   already store.* (Feeds Deep-RCA / agent beats.)
2. **Dynamic severity / priority + blast-radius hints** — anomaly factor,
   affected services, component count.
3. **Deep-link the trace** from the event (reuse `buildHelixTraceUrl`) so one
   click lands on the waterfall.
4. **Fingerprint dedup** (namespace+service+operation+error_type) so recurring
   anomalies collapse with a repeat count instead of flooding.
5. **Change / deploy correlation** — emit a deploy/version-drift marker and fold
   it into the Situation. (The demo's dominant RCA pattern; biggest single gap.)
6. **Auto-close** — emit CLEAR/OK when a service returns to baseline (enables
   MTTR; "the Situation closes" beat).

**Items 1–3 are the active implementation slice; 4–6 are the natural follow-ups.**
The brainstorm should mostly be about *how far up this list to go* and *how to
source the inputs* (esp. the deploy signal for #5 and the "healthy again"
detector for #6) — not about reinventing the priorities.

## Adjacent integration ideas (beyond Situation enrichment)

Worth a brainstorm pass even though James pointed at Situations:

- **Inbound, not just outbound:** pull Helix Situation/health state *back into*
  the local viewer ("here's what Helix did with this trace") to close the loop
  visually. (James ranked this lower than richer Situations, but it pairs well.)
- **Trace ↔ resource-pressure correlation** as a cause signal (**brief 02**):
  "slow trace AND host at 95% CPU."
- **One-click "build the Business Service + link X-Source"** — *but see the auth
  blocker below; this is gated, not free.*

## Open questions & decisions

- How far up the 1–6 list for this pass? (1–3 are mostly data you already have;
  #5 and #6 need new signal sources.)
- **#5 deploy signal source:** where does a deploy/version marker come from? CI
  webhook, image-tag/version-drift detection, a manual "I deployed" event,
  `service.version` resource-attr change?
- **#6 "healthy again" detector:** what defines baseline recovery for auto-close?
- **Dedup fingerprint** definition and repeat-count semantics (#4).
- Inbound integration: is pulling Helix state back worth the API work, or stay
  outbound-only for now?

## Constraints & known blockers

- **Events-service auth:** the REST API needs a **Bearer JWT minted from the API
  key via IMS** (`/ims/api/v1/access_keys/login`) — the raw OTLP ingest key is
  ingest-only. Correlation-policy quirks are real: the selector takes **no
  parens**, and conditions need **empty-string brackets**. (Validated live;
  documented in memory + `situations-payloads.js`.)
- **The CMDB / service-model wall:** the OTLP ingest key reaches IMS-fronted APIs
  (events-service, aiops-config) but is **401'd by the CMDB/service-model layer**,
  so the configurator **cannot list/create Business Services** with it. Anything
  that needs BS creation/linking is blocked on a *different* credential — don't
  design around it without confirming auth. (Spike-confirmed.)
- **Destructive tenant ops stay manual** — no configurator buttons that delete
  classes/policies/events. Non-destructive provisioning via existing Provision
  paths is fine.
- Some Situation enrichment depends on a stable correlation class/policy already
  provisioned in the tenant (live class currently at 21/21 slots).

## Suggested first moves

1. **Finish slice 1–3:** enrich the "Send to AIOps" event payload
   (`situations-payloads.js`) with probable cause (exception type/message,
   service+operation, code location), a dynamic severity, and a deep-link via
   `buildHelixTraceUrl`. All sourced from data already in the trace store.
2. Verify the enriched event lands and the Situation reflects the new fields in a
   live tenant (events-service via the IMS-minted JWT).
3. Brainstorm **#5 (deploy correlation)** separately — it's the highest-impact
   demo beat and the one needing a new signal source.
4. Decide whether to add the **inbound** "what did Helix do with this?" view.

## Related prior art & files

- [`../situations-gartner-mapping.md`](../history/situations-gartner-mapping.md) — **the
  roadmap.** Start here.
- `backend/routes/situations.js`, `backend/routes/situations-payloads.js` — event/
  Situation emission + correlation provisioning.
- `.../otel-data/trace-detail/TraceDetailDrawer.tsx` — where the rich trace
  signals are computed (the inputs to enrichment).
- `buildHelixTraceUrl` (trace deep-link builder) — reuse for event deep-links.
- **Memory:** `project_situations_rca_ready`, `project_situations_rca_slice_progress`,
  `project_helix_situation_correlation_provisioning`,
  `reference_gartner_mq_demo_videos`, `feedback_manual_tenant_destructive_ops`.
- **Background:** the Gartner-MQ demo VO set (transcribed) defines the bar each
  Situation should clear.

## Cross-links

- **Brief 02 (resource metrics):** trace↔CPU/mem correlation is a probable-cause
  input — feed it into enrichment.
- **Brief 04 (auto-instrumentation):** richer/more-consistent spans → richer
  Situations; better instrumentation upstream improves every field here.

## How to use this brief

Don't re-litigate priorities — `situations-gartner-mapping.md` already ranked
them. Brainstorm **how high to climb the 1–6 list this pass** and **how to source
the deploy signal (#5) and recovery detector (#6)**, then ship the 1–3 slice
against a live tenant. Mind the auth boundary: events/Situations work; Business
Service management does not (yet).
