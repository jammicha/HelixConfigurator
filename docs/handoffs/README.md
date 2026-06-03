# Handoff briefs

Local-only working notes (`docs/` is gitignored). Each file here is a
self-contained **brainstorm brief** for one idea that came out of the
**2026-06-03 team demo feedback**. Hand one to a fresh Claude Code session and it
should be able to start cold — problem, current state, vision, open questions,
constraints, and first moves are all inside.

These are **starting points for brainstorming, not specs.** They deliberately
leave the solution open. Run `superpowers:brainstorming` (or just think out loud
with the session) before converging on an approach.

## The five briefs

| # | Brief | Priority | Shape |
|---|-------|----------|-------|
| 01 | [Local → Kubernetes](01-local-to-kubernetes.md) | **High** | Brainstorm |
| 02 | [Trace resource metrics (CPU/mem per trace)](02-trace-resource-metrics.md) | **High** | Brainstorm |
| 03 | [AIOps integration — richer Situations](03-aiops-integration.md) | **Medium** | Brainstorm |
| 04 | [Sidecar auto-instrumentation](04-sidecar-auto-instrumentation.md) | **Spike → POC** | Brainstorm |
| 05 | [Explore OTel Blueprints](05-otel-blueprints.md) | **Spike → POC** | Brainstorm |

## Origin

All five trace back to a demo with the team on/around **2026-06-03**. The team
was wowed by the **local trace viewer ↔ Helix tenant hooks** — view a trace in
the local viewer, then open the *same* trace in Helix; create Helix
events/Situations straight from a trace. The feedback clustered into:

- "More of the configurator ↔ Helix AIOps magic" → **03**
- "Can we tie CPU/memory to each trace in the viewer?" → **02**
- "Could the sidecar instrument the app so the customer doesn't have to?" → **04**
- "How do we go from local-Docker-Desktop to production-Kubernetes?" → **01**
- (added by James) "Explore OTel Blueprints" — see <https://opentelemetry.io/blog/2026/blueprints-intro/> → **05**

## Sequencing notes

- **01 and 02 are the High-priority pair** — start here.
- **04 and 05 are spikes that gate a POC.** Don't build before the spike's
  assessment says go. **05 explicitly runs an "assess only" pass first** (is this
  movement worth engaging with at all?) before any align/generate work; James
  wants a POC only if that assessment says go.
- **They cross-link.** 01 (Kubernetes) ↔ 04 (in K8s the OpenTelemetry Operator
  auto-injects instrumentation — exactly what 04 wants to do manually) ↔ 05 (the
  OTel "Kubernetes observability" Blueprint is one of the three in progress).
  Whoever picks up one should skim the siblings.

## Shared grounding (read once)

Every brief assumes the architecture in [`../ARCHITECTURE.md`](../architecture/ARCHITECTURE.md)
and the env/feature summary in [`../../README.md`](../../README.md). One-line
recap: **two containers** — `helix-configurator` (Express + React UI on :8765,
API on :3001, a better-sqlite3 trace store, talks to the Docker socket via
dockerode) and `helix-gateway` (an `otel/opentelemetry-collector-contrib`
instance on :4317/:4318). The gateway **fans traces + logs out to both Helix and
the configurator's local viewer; metrics go only to Helix.**

> **Heads-up on doc staleness.** `docs/` is shared with concurrent sessions and
> some older notes drift. `ARCHITECTURE.md` still describes a "two-step wizard";
> the UI has since grown a Step 0 plus more steps. **Trust the code**
> (`frontend/src/components/wizard/`, `.../step-zero/`, `backend/routes/`) over
> any doc on specifics. Each brief flags staleness where it matters.
