# Configurator Situations ↔ Gartner MQ Demo: One-Pager

*Source: the 9-element BMC Helix capability demo (voice-over set, transcribed
2026-05-29). This maps what each demo element showcases to what the
configurator's Helix **Situation** must carry to feed it — and where we stand.*

## The thesis

The configurator **is the live on-ramp** the demo opens with: Element 1 (OTel
onboarding → auto business service + topology from traces) and Element 2-1
(policy routing of error traces) are, almost verbatim, what the configurator
already does. Everything the demo sells *after* that — Deep RCA (E4), agentic
blast-radius (E6), change-aware RCA (E8), autonomous closed-loop remediation
(E9) — runs **downstream of a Situation**.

So the leverage is simple: **the richer each event/Situation the configurator
emits, the closer the *live* demo gets to the polished video.** Today the
configurator emits one Situation type — "≥3 slow/error traces on one service in
30s" — which clusters noise but names no cause, carries no impact, and links
nowhere. That's the gap.

## Element-by-element

| # | What the element showcases | What a Situation must carry to feed it | Configurator today |
|---|---|---|---|
| **1** | OTel onboarding: namespace → auto business service + topology | (on-ramp — produces the telemetry) | ✅ This is the configurator |
| **2** | Pipeline cost: route error traces, PII redaction, archive rehydration | Error-trace routing as the anomaly trigger | ✅ Error/outlier → event |
| **3** | Telemetry-cost observability + adaptive collection | (platform capability) | — |
| **4** | **Service monitoring + Deep RCA**: feature-flag & version-drift root cause, "eliminated event noise" | **Probable cause named** in the event; noise collapsed via dedup | ❌ no cause; ⚠️ dedup is per-trace-id only |
| **5** | LLM / AI-agent observability; tool-overload Situations | Anomaly events carrying operation + error type | ❌ no error type/operation slots |
| **6** | Agentic day-in-life: "ML correlated all events → total blast radius across topology" | **Blast radius**: affected services / component count | ❌ single service+namespace only |
| **7** | SLO + business/revenue impact | Impact + dynamic severity to triage by | ❌ flat CRITICAL/PRIORITY_2 |
| **8** | **Change/CI-CD-aware RCA**: "unauthorized deployment" → guided rollback | **Change/deploy correlation** on the Situation | ❌ no change signal (biggest gap) |
| **9** | Autonomous evidence-grounded Deep RCA + closed-loop remediation; **"situation closes"** | Deep-link to trace/evidence; **auto-close** when healthy | ❌ no deep link; ❌ never auto-closes |

## Enrichment priorities (demo-impact per effort)

1. **Name the probable cause** in every event — exception type/message,
   originating service+operation, code location (file:method:line). Pure
   function of trace data we already store. *Feeds E4, E5, E6, E9.*
2. **Dynamic severity / priority + blast-radius hints** (anomaly factor,
   affected services, component count). *Feeds E6, E7.*
3. **Deep-link the trace** from the event so one click lands on the waterfall.
   *Feeds E6, E9.* (Reuse the proven `buildHelixTraceUrl` shape.)
4. **Fingerprint dedup** (namespace+service+operation+error_type) so recurring
   anomalies collapse with a repeat count instead of flooding. *Feeds E4's
   "eliminated event noise."*
5. **Change/deploy correlation** — emit a deploy/version-drift marker and fold
   it into the Situation. *Feeds E8 — the demo's dominant RCA pattern.*
6. **Auto-close** — emit CLEAR/OK when a service returns to baseline. *Feeds
   E9's "the situation closes" beat; enables MTTR.*

Items 1–3 are the current implementation slice. 4–6 are the natural follow-ups.

## Honest caveats

- HelixGPT, the agentic "ops" assistant, and Deep RCA are **Helix platform
  capabilities** the videos showcase — they define the *bar a Situation must
  clear*, not the configurator's field schema. The "must carry" column is
  inferred from what the Situations are shown *doing*, not from a Helix spec.
- Transcribed from voice-over audio; product terms were mis-heard and corrected
  (OTel↔"hotel", Deep RCA↔"DIPRCA", Opsformer/HelixGPT, company "Apex").
