# 05 — OTel Blueprints: Phase D Assessment Memo

> **Deliverable for [brief 05](05-otel-blueprints.md) · Phase D (assess) · 2026-06-03**
> Status: **Phase D complete.** Decision below. Build **held** by request — this memo
> is the deliverable; no product code was written.
> Method: brainstorm-first spike. Sources verified against the `open-telemetry/sig-end-user`
> repo + `opentelemetry.io` repo via `gh`, the public intro blog, and James's NotebookLM
> notebook ("OpenTelemetry Reference Architectures and Collector Deployment Patterns").

## Recommendation (TL;DR)

| Track | Verdict | Why |
|---|---|---|
| **A — Align** | **GO, staged** | Cheap, reversible, on-trend; the configurator already *is* a Blueprint's *Implementation* section as software, and maps onto the "Centralized Telemetry Platform" Blueprint (#246). |
| **C — Generate** | **GO, forward-looking + gated** | The configurator already owns the gateway's Collector config; emitting it as a Blueprint-aligned, shareable artifact anticipates issue #315. Gated on #246 publishing. |
| **C — Consume** | **NO** | Blueprints are prose (a Rumelt strategy doc), not a machine schema. There is nothing to parse. |
| **Reference implementation (BMC)** | **Park as follow-on** | Real opportunity, but it is a *positioning* play and must be an end-user account that cannot pitch Helix. Out of scope for the chosen product-alignment goal. |

**Chosen direction:** product alignment → map the configurator onto Blueprint #246
via **approach B** ("generate a Blueprint-conformant Collector config" + a vocabulary
wrapper), scoped to the **current Docker product**, with K8s fidelity deferred to
[brief 01](01-local-to-kubernetes.md). **The substantive build is held** until the
unblock triggers below fire. The actionable work *now* was this memo.

## 1. What Blueprints are (verified)

Prescriptive, **opinionated prose guides** for adopting OTel in a real-world scenario —
explicitly *not* code or a config schema. Each follows a four-part structure taken from
Richard Rumelt's *Good Strategy/Bad Strategy*:

- **Summary** (audience + environment + outcomes) → · **Common Challenges** (Rumelt's *Diagnosis*)
  · **General Guidelines** (*Guiding Policy*) · **Implementation** (*Coherent Actions*, links
  to existing docs, must not duplicate them).
- **Reference Implementations** are the separate, evidence layer — real end-user accounts
  that back a Blueprint with practice.
- They live in the **`opentelemetry.io`** repo (`content/en/docs/guidance/blueprints/` and
  `.../reference-implementations/`) and are coordinated by the **End-User SIG**
  (`open-telemetry/sig-end-user`: charter, `architecture/blueprint-template.md`, issue templates).

## 2. Maturity & governance — the gate question

**Early, low-velocity, community-controlled, moving target.**

- **Nothing is published.** The Blueprints index page literally says **"Coming soon!"** The
  three "in-progress" Blueprints are open *scoping issues* — [#245](https://github.com/open-telemetry/sig-end-user/issues/245)
  (non-K8s), [#246](https://github.com/open-telemetry/sig-end-user/issues/246) (centralized
  platform), [#247](https://github.com/open-telemetry/sig-end-user/issues/247) (K8s) — all
  opened **2026-01-22** and still scoping more than four months later. No published drafts.
- **Reference implementations *are* live** (Adobe, Mastodon, Skyscanner) — but the index warns
  they are *"point-in-time snapshots… not actively maintained."*
- **Cadence is slow.** Recent repo commits are almost entirely Renovate dependency bumps +
  CodeQL; substantive content happens in issues, slowly. Only 2 open PRs, neither about Blueprints.
- **Governance is real but lightweight:** a CNCF End-User SIG with a charter, CODEOWNERS,
  blueprint/reference-impl templates, and a structured `blueprint_proposal.yml` intake.

**Implication:** building *to* Blueprints now is building on sand (rework risk). Aligning
*cheaply and reversibly* now is low-risk and positions us for when it firms up.

## 3. Overlap with the configurator

| In-progress Blueprint | Maps to | Closeness |
|---|---|---|
| Non-K8s instrumentation (#245) | the current Docker scenario + [brief 04](04-sidecar-auto-instrumentation.md) | Medium (OpAMP-flavored) |
| **Centralized telemetry platform (#246)** | **the configurator's core value prop** | **High — near 1:1** |
| Kubernetes observability (#247) | [brief 01](01-local-to-kubernetes.md) | High (but that's 01's work) |

**#246 is the match.** Its stated scope — an *X-as-a-Service* telemetry platform: consistent
SDK config across teams, taming Collector config sprawl, scalable/reliable ingest for *all
signals*, plus sampling/filtering and telemetry governance — is the configurator's pitch.

**Grounding in the real config (`helix-otel-collector.yaml`):** the configurator runs a
**single-tier Collector gateway** — OTLP in (gRPC + HTTP) → `batch` → fan-out to two exporters
(Helix, plus the local viewer at `/otel-data`). That *is* the gateway deployment model the
Blueprint space centers on. **Gaps vs. #246's reference example** (which sketches a *two-tier*
gateway: ingest/enrich, then tail-sample/export): (a) single-tier, single local gateway — no
multi-cluster / Operator / CR story (that is brief 01); (b) processors today are just `batch`
— none of the **sampling / filtering / governance** tier the Blueprint stresses. Those gaps are
exactly approach B's content when it's time to build.

## 4. Does aligning help or constrain?

- **Helps:** a recognizable, standard-blessed path; the configurator reframed as the
  "easy-button **implementation**" of a published Blueprint; a credible, on-trend Helix funnel;
  cheap to adopt vocabulary/positioning.
- **Constrains:** coupling our narrative to an early, prose, community-owned target we don't
  control; any "Blueprint-conformant" claim is **soft** until #246 actually publishes.
- **Net:** align at low cost now (vocabulary, positioning, a mapping doc); **do not hard-couple**
  product behavior to an unpublished spec.

## 5. Generate / Consume (track C)

- **Consume — NO.** The template is a Rumelt strategy narrative; there is no schema to parse.
  "Consume a Blueprint as data" is not a real capability today.
- **Generate — GO, gated.** Issue [#315](https://github.com/open-telemetry/sig-end-user/issues/315)
  ("evolve Blueprints toward reusable config snippets," opened 2026-05-12, 3 comments, **open/
  unresolved**) proposes optionally shipping example Collector YAML. The configurator emitting
  its config as a Blueprint-aligned, adaptable artifact would *anticipate* that direction.
  **Risk:** #315 is not ratified and #246 is unpublished, so the "Blueprint-aligned" label is
  aspirational until both move.

## 6. Vendor-backend reference implementation (the BMC angle)

There **is** a published-artifact path peer to Adobe/Mastodon/Skyscanner, with a templated
intake — and issue [#240](https://github.com/open-telemetry/sig-end-user/issues/240)
("missing reference architectures to compliment blueprints") signals SIG appetite for more.
**But two constraints reshape it:**

1. It must be an **end-user account** ("a real-world account of how an organization adopted OTel
   in production"). The natural author is a **Helix customer** running OTel at scale, or **BMC's
   own** internal adoption — not "BMC the vendor."
2. Authors **MUST NOT pitch the backend** — the template allows naming the vendor but bars
   *"details related to why that backend was used, or the benefits/drawbacks."*

So this is **credibility / thought-leadership**, not a Helix advertisement. Precedent for vendor
involvement exists (Grafana Labs co-authored Skyscanner's). **Verdict:** real, but a *positioning*
play — out of scope for the chosen product-alignment goal. Park as a follow-on; revisit if the
goal shifts toward positioning.

## 7. Threat read

Does the centralized-platform / K8s Blueprint commoditize the configurator's onboarding?
**Low threat.** A Blueprint commoditizes the *pattern* (prose anyone can read), not the
*tooling*. Being the **easy-button implementation** of that pattern — pre-wired to Helix — is
the differentiation, and an external standard pointing at the same agent-and-gateway
architecture is a **tailwind**, not a headwind.

## 8. Parked design — approach B (ready to execute when unblocked)

Scope: **current Docker product**, forward-compatible with K8s. Not built yet.

1. **Map** `helix-otel-collector.yaml` onto #246's *Implementation* sections; add the
   Blueprint-recommended **sampling / filtering / governance** processors as opt-in (today it's
   only `batch`).
2. **Export "Blueprint-aligned Collector config"** — a one-click, adaptable artifact + appendix-style
   YAML, in the spirit of #315.
3. **Vocabulary wrapper** — adopt #246's language in the wizard/docs + a "this *is* the Centralized
   Telemetry Platform Blueprint, implemented" mapping page.
4. **Design config emission to be structurally portable to K8s CRs** — then hand that fidelity to
   [brief 01](01-local-to-kubernetes.md); do not duplicate.

## 9. Unblock triggers (watch-list)

Re-open this spike when any fire:

- **#246 published** to `opentelemetry.io` → align "conformance" to the real text; firm up vocabulary.
- **#315 resolved / accepted** → match the generated-snippet artifact to the agreed shape.
- **Brief 01 (local→K8s) underway** → fold reference-topology / CR generation in; coordinate to
  avoid overlap.
- *(optional)* **SIG appetite for vendor-adjacent reference impls** (#240) grows → reconsider the
  BMC reference-implementation follow-on.

## 10. Open questions & residual risks

- **Rework risk** if we build before #246/#315 settle — mitigated by holding the build.
- **Soft "conformance"** until publication — keep alignment to vocabulary/positioning until then.
- **Overlap boundary with brief 01** — must be drawn explicitly when 01 starts (this memo draws it
  at: configurator = the on-ramp + single-gateway config; brief 01 = multi-cluster/CR/Operator).
- **Positioning vs. product tension** on the reference-impl idea — only resurfaces if the goal shifts.

## Links

- Intro blog: <https://opentelemetry.io/blog/2026/blueprints-intro/>
- SIG repo: `open-telemetry/sig-end-user` — `architecture/blueprint-template.md`,
  `architecture/reference-implementation-template.md`, `.github/ISSUE_TEMPLATE/blueprint_proposal.yml`,
  `sig-end-user-charter.md`
- Website: `opentelemetry.io` → `content/en/docs/guidance/blueprints/` ("Coming soon!"),
  `.../reference-implementations/` (Adobe, Mastodon, Skyscanner)
- Key issues: [#246](https://github.com/open-telemetry/sig-end-user/issues/246) (centralized platform),
  [#247](https://github.com/open-telemetry/sig-end-user/issues/247) (K8s),
  [#245](https://github.com/open-telemetry/sig-end-user/issues/245) (non-K8s),
  [#315](https://github.com/open-telemetry/sig-end-user/issues/315) (config snippets),
  [#240](https://github.com/open-telemetry/sig-end-user/issues/240) (missing reference architectures)
- Internal: [brief 05](05-otel-blueprints.md), [brief 01](01-local-to-kubernetes.md),
  [brief 04](04-sidecar-auto-instrumentation.md), `helix-otel-collector.yaml`
