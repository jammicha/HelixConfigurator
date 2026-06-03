# 04 — Sidecar auto-instrumentation (instrument the app, no customer code changes)

> **Handoff brief** · Priority: **Spike → POC** · Created 2026-06-03 · Status: Not started
> Shape: **brainstorm + spike.** Goal is a **concrete POC**, but the magic level
> is *an output of the spike*, not a precondition.
> Read [`../ARCHITECTURE.md`](../architecture/ARCHITECTURE.md) §10 (the "never modifies the
> app" promise this idea deliberately challenges).

## TL;DR

Today the configurator **tells** the customer how to instrument their app
(copy-paste snippets per language). The team asked: **could the sidecar
*instrument the app for them*, with no changes to the customer's app — shifting
the complexity out of the customer's code and into the product?** James wants a
**concrete POC**, covering (in principle) **all runtimes that fully support OTel
auto-instrumentation**, with the acceptable level of "magic" decided *by the
spike*.

## Origin (demo feedback)

> "Another idea: could the configurator that runs as a sidecar handle app
> instrumentation without the customer needing to make changes to their own app?
> Could we somehow shift complexity from the customer's app into the product?"

James: candidate runtimes = "all runtimes that fully support auto
instrumentation." Acceptable magic level = "dependent on the spike done." Goal =
"a concrete POC."

## Current state

- **The configurator deliberately does *not* touch the customer's app.**
  ARCHITECTURE.md §10: "The configurator never modifies the customer's app
  config… the Step 2 snippet is suggestive, not enforced." **This idea
  intentionally crosses that line** — flag the tradeoff explicitly.
- **It already provides instrumentation *guidance*.** A "Step 0" instrument layer
  hands out per-language setup: `backend/routes/step-zero/instrument.js`,
  `backend/routes/step-zero/instrument-templates.js`, and frontend
  `.../step-zero/LanguageGuide.tsx`, `Layer3Instrument.tsx`, `instrument-types.ts`.
  **The spike is to automate what these screens currently instruct.**
- **The configurator has the lever to do it: the Docker socket.** It already
  recreates containers (the gateway) with new env/volumes via dockerode. The same
  capability could mount an agent + set env on the *customer's* container.

## The technical landscape (brainstorm the two arms)

**Arm A — Per-language zero-code agents.** OTel ships drop-in auto-instrumentation
that needs *no app code change* — just the agent present in the container + env
vars + a process restart:

- **Java** — `-javaagent:opentelemetry-javaagent.jar` via `JAVA_TOOL_OPTIONS`.
- **Node** — `--require @opentelemetry/auto-instrumentations-node/register` via
  `NODE_OPTIONS`.
- **Python** — `opentelemetry-instrument` / `sitecustomize` on `PYTHONPATH`.
- **.NET** — CLR profiler env vars.
- (Ruby, PHP similar.) **Go/Rust/C++ have no SDK agent → see Arm B.**

In the Docker scenario the configurator would: detect the app container's
runtime → **recreate it with the agent volume-mounted + the right env var set +
`OTEL_EXPORTER_OTLP_ENDPOINT=helix-gateway:4318`**. No rebuild, no code change —
but the container *is* restarted and modified. This is the literal "shift
complexity into the product" path.

**Arm B — eBPF / zero-instrumentation.** A privileged sidecar that watches the
kernel (uprobes/syscalls) and synthesizes spans for HTTP/gRPC/SQL with **zero
changes to the target container**, language-agnostic (covers Go/Rust/compiled):

- **Grafana Beyla** → donated to OpenTelemetry as **OpenTelemetry eBPF
  Instrumentation (OBI)**.
- **Odigos** (third-party, combines eBPF + agent injection).

**Tradeoff:** Arm B needs elevated privileges (host PID / `CAP_BPF` / kernel
access) and yields coarser data (no custom spans, limited cross-service context
propagation), but requires *truly nothing* from the app — including no restart in
some modes. Arm A is richer but per-language and needs a restart.

**The K8s answer is already standard (brief 01):** the **OpenTelemetry Operator's
`Instrumentation` CR** auto-injects agents via pod annotations + an init
container. So in K8s "instrument with no code change" is a solved, idiomatic
pattern — the Docker version is the configurator doing the Operator's job
manually via the Docker socket. **Design A/B with the K8s Operator path in view.**

## What the POC could be

A defensible first POC (refine in brainstorm):

- Pick **one runtime + one arm** to prove the mechanism end to end — e.g. **Node
  or Java via Arm A**: configurator detects the container's runtime, shows an
  **"Auto-instrument this app"** action, recreates the container with the agent +
  env, and spans appear in the local viewer within seconds (reuse the Step 2 live
  counter as the proof).
- **Or** an **Arm B Beyla/OBI sidecar** POC for language-agnostic coverage of an
  un-instrumentable (e.g. Go) app — strong because it shows *zero* app
  cooperation.
- Ideally the spike does a **small bake-off**: run both arms against the same app,
  compare coverage / data quality / setup cost / invasiveness, then build the POC
  for the winner.

## Open questions & decisions (the spike answers these)

- **Which arm wins on effort-vs-coverage** — per-language agent injection vs.
  eBPF? (Likely "both, for different cases.")
- **Acceptable invasiveness / "magic."** Recreating a customer's container is a
  real intervention — what consent + rollback model makes it safe? (Snapshot the
  prior container spec; one-click revert.)
- **Which runtime first** for the POC?
- **Restart tolerance** — Arm A needs a process restart; some customer containers
  are stateful or restart-sensitive. How is that gated/communicated?
- **eBPF privileges** — is a privileged sidecar acceptable in the target
  environment? (It often isn't in locked-down prod — informs the K8s story.)
- **Where does config detection live** — extend the existing `step-zero/instrument`
  detection, or new code?

## Constraints & known blockers

- **Breaks the "never touch the app" promise** — this is a deliberate product
  posture change. It needs explicit user consent, a clear preview of what will
  change, and reliable rollback.
- **Docker-socket dependency** — Arm A injection rides the Docker socket;
  productization already flags socket lockdown. In K8s, this becomes RBAC +
  Operator (brief 01).
- **Restart side effects** — no graceful-drain story today for recreating
  containers; stateful apps are risky.
- **Data-quality ceiling (Arm B)** — eBPF spans are coarser than SDK spans;
  manage expectations vs. the rich waterfalls the viewer shows for SDK traces.

## Suggested first moves

1. Pick a sample app per arm (a Java/Node app for Arm A; a Go app for Arm B).
2. **Arm A spike:** from the configurator, recreate the app container with the
   agent volume-mounted + `JAVA_TOOL_OPTIONS`/`NODE_OPTIONS` + the OTLP endpoint;
   confirm spans hit the local viewer.
3. **Arm B spike:** run a **Beyla/OBI** sidecar against the Go app; confirm spans
   hit the viewer with zero app changes.
4. **Compare** coverage / quality / setup / invasiveness; write the recommendation.
5. Design the **consent + rollback** UX (snapshot prior container spec → revert).
6. Build the POC for the winning arm; note the K8s Operator path as the prod
   evolution.

## Related prior art & files

- `backend/routes/step-zero/instrument.js`,
  `backend/routes/step-zero/instrument-templates.js` — current per-language
  guidance to automate.
- `frontend/src/components/step-zero/LanguageGuide.tsx`, `Layer3Instrument.tsx`,
  `instrument-types.ts` — the UI that tells users what this spike would do for
  them.
- dockerode container recreate path (the gateway-recreate flow in
  `backend/routes/lifecycle.js` / `backend/index.js`) — the mechanism to reuse on
  the customer's container.
- ARCHITECTURE.md §10 (the promise being crossed), README "Route Your Telemetry"
  (Step 2 snippet + live counter to reuse as POC proof).
- **External:** OTel auto-instrumentation per language; OpenTelemetry Operator
  `Instrumentation` CRD; Grafana Beyla / OpenTelemetry eBPF Instrumentation (OBI);
  Odigos.

## Cross-links

- **Brief 01 (K8s):** the Operator's `Instrumentation` CR is the native K8s form
  of this — co-design.
- **Brief 05 (OTel Blueprints):** the Blueprints post calls out an "Injector" for
  simplifying instrumentation deployment — this is the same problem space.
- **Brief 02 (resource metrics):** auto-instrumentation can switch on runtime
  metrics (Option A there) for free.

## How to use this brief

It's a spike: **prove the mechanism before polishing.** The two questions worth
the most are *which arm (agent-injection vs eBPF) fits which case* and *what
consent/rollback makes "the product modifies your container" safe*. Let the spike
— not a guess — set the acceptable magic level, then build the POC.
