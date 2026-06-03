# 05 — Explore OpenTelemetry Blueprints

> **Handoff brief** · Priority: **Spike → POC** · Created 2026-06-03 · Status: **Phase D complete** → see [the assessment memo](05-otel-blueprints-assessment.md)
> Shape: **assess-first spike.** Do the **assessment pass (Phase D) first**; only
> proceed to align/generate work — and a POC — if the assessment says go.
> Primary source: <https://opentelemetry.io/blog/2026/blueprints-intro/>

## TL;DR

OpenTelemetry has introduced **Blueprints** — prescriptive, opinionated
deployment guides for real-world OTel scenarios, backed by published reference
implementations. The configurator is, in effect, **"a Blueprint implemented as
software."** James wants to explore **aligning** the configurator to a Blueprint
(A) and **generating/consuming** Blueprint artifacts (C) — but **assess first**
(D) whether this is worth engaging with at all, and do a POC **only if** the
assessment says go.

## Origin (James's added item)

> "I want to add another item called *Explore OTel Blueprints* as a spike."
> Interest: **A (align)** and **C (generate/consume)** most of all — "but we
> should do **D (assess)** as an exercise first. Depending on the outcome of D,
> I'd like to see a POC of it."

So the sequence is fixed: **D → (if go) A/C → POC.**

## What OTel Blueprints are (from the intro post)

- **Prescriptive, opinionated guides** for deploying OTel in real scenarios —
  *not* code or a config schema. They bridge the gap between OTel's vast docs and
  "just tell me the right way to do X."
- **Four building blocks each:** *Summary* (who it's for), *Common Challenges*,
  *General Guidelines* (design patterns + architecture diagrams), *Implementation*
  (concrete steps that link to existing docs). Explicitly **do not rewrite docs** —
  they tie components together holistically.
- **Grounded in real reference implementations** — **Adobe, Mastodon, and
  Skyscanner** have published theirs.
- **Three Blueprints in progress:** **(1) instrumentation in non-Kubernetes
  environments, (2) Kubernetes observability, (3) centralized telemetry
  platform.** All three map onto the configurator's world.
- **Where they live:** the `open-telemetry/sig-end-user` repo, with a public
  `blueprint-template.md` and `reference-implementation-template.md`. Maturity is
  **early** — templates + three in-progress drafts; this is a young, community
  effort (end-user SIG), not a stable spec.
- **Related components named:** the Collector (DaemonSets via the OTel Operator),
  **declarative configuration**, the OTel Operator, and an **"Injector"** for
  simplifying instrumentation deployment.

## Why this is interesting for the configurator

The configurator is **already an opinionated, prescriptive OTel on-ramp** — i.e.
a Blueprint's *Implementation* section, but as running software. The three
in-progress Blueprints line up almost 1:1 with the other briefs:

| In-progress Blueprint | Maps to |
|---|---|
| Instrumentation in **non-K8s** environments | the current Docker scenario + **brief 04** (auto-instrumentation) |
| **Kubernetes observability** | **brief 01** (local → K8s) |
| **Centralized telemetry platform** | the gateway + fan-out architecture itself |

That overlap is the whole reason to look: Blueprints are both a **positioning
opportunity** (be the recognized "easy button" / reference implementation for a
Blueprint, landing customers on Helix) and a **standardization pressure** worth
understanding (does this commoditize the onboarding the configurator sells?).

## Phase D — Assess (do this first; it's the gate)

Deliverable: a short **assessment memo** with a go/no-go on A and C. It should
answer:

- **What exactly are Blueprints, and how mature/stable?** Governance, cadence,
  who owns them, how much churn to expect. (Confirm against the SIG repo, not just
  the blog.)
- **Which existing/in-progress Blueprints overlap us**, and how closely? (Use the
  table above as a starting hypothesis; verify against the actual drafts.)
- **Does aligning help or constrain?** Upside: recognizable, standard-blessed
  path; a credible funnel ("follow the OTel Blueprint → land on Helix"). Downside:
  coupling our story to patterns we don't control; an early, moving target.
- **Is there a "vendor backend" / "land OTel on an AIOps platform" Blueprint or
  reference-implementation opportunity** for BMC — peer to Adobe/Mastodon/
  Skyscanner? Is there SIG appetite for that?
- **Threat read:** does the "Kubernetes observability" / "centralized telemetry
  platform" Blueprint make the configurator's onboarding less differentiated — or
  is *being the easy button for it* the differentiation?
- **Recommendation:** go/no-go on **A (align)** and **C (generate/consume)**, with
  the reasoning.

## Phase A — Align (only if D says go)

- Map the configurator's onboarding flow (wizard steps, gateway topology) onto a
  chosen Blueprint's *General Guidelines* + *Implementation*; adopt its
  terminology and architecture so customers see a familiar, standard path.
- Position the configurator as **the easy-button reference implementation** of
  that Blueprint.
- Optionally **author + publish a BMC reference implementation** (the Adobe/
  Mastodon/Skyscanner pattern) — thought leadership + a natural Helix funnel.

## Phase C — Generate / consume (only if D says go)

- **Generate:** have the configurator emit **Blueprint-conformant artifacts** —
  e.g. the "Kubernetes observability" Blueprint's recommended Collector topology
  as Helm/Operator CRs. This **directly reuses brief 01's output**; consider
  merging that slice.
- **Consume:** drive the configurator's recommendations from a Blueprint's
  guidance. **Caveat to surface in D:** Blueprints are *prose*, not a machine
  schema, so "consume" is loose today — it likely means "encode a Blueprint's
  recommendations into our logic," not "parse a Blueprint file." Validate this
  framing during assessment.

## POC (only if D says go)

Shape depends on whether A or C wins. Candidates:

- A **"Deploy via the OTel Kubernetes-Observability Blueprint"** path in the
  configurator that emits the Blueprint's reference topology pre-wired to Helix
  (overlaps brief 01 — coordinate).
- A **published BMC reference implementation** in the SIG format, with the
  configurator as the tooling.

## Open questions & decisions

- Blueprint **maturity/stability** — is it stable enough to build on now, or
  "watch and align later"? (Lead question for D.)
- How much of this should **merge with brief 01** vs. stay a distinct workstream?
- Does "**generate/consume**" survive contact with the fact that Blueprints are
  prose, not schema?
- Appetite (ours + the SIG's) for a **vendor-backend reference implementation**.

## Constraints & known blockers

- **Early-stage target.** Templates + three in-progress drafts; expect change.
  Don't over-invest before D's maturity read.
- **Prose, not schema.** "Consume Blueprint artifacts" may not mean what it sounds
  like — confirm in D before scoping C.
- **Overlap risk.** Phase C and brief 01 can collide; decide the boundary early.

## Related prior art & links

- **Primary:** the intro post — <https://opentelemetry.io/blog/2026/blueprints-intro/>
- The **`open-telemetry/sig-end-user`** repo: `blueprint-template.md`,
  `reference-implementation-template.md`, and the three in-progress Blueprints.
- Published reference implementations: **Adobe, Mastodon, Skyscanner**.
- Internal: [`01-local-to-kubernetes.md`](01-local-to-kubernetes.md) (the K8s
  Blueprint overlap), [`04-sidecar-auto-instrumentation.md`](04-sidecar-auto-instrumentation.md)
  (the "Injector" overlap), [`../ARCHITECTURE.md`](../architecture/ARCHITECTURE.md) (what we'd
  be aligning).

## How to use this brief

**Respect the gate: Phase D first.** Produce the assessment memo and a clear
go/no-go on align (A) and generate/consume (C) before writing any code. If it's a
go, the POC most likely rides on brief 01's Kubernetes work — plan to coordinate
rather than duplicate.
