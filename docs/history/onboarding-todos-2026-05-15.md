# Onboarding Wizard — UX TODOs (2026-05-15)

> Derived from the onboarding UX analysis. Items are grouped by step/area and tagged with priority. Top-of-list "Recommended next" is the subset I'd ship first; further down is everything else discovered during the walkthrough, plus items I'd defer with reasoning.

**Repo state at time of analysis:** branch `claude/jolly-edison-8df9e4`, head `652ff53` (Step 1 BSK field added).

---

## Recommended next — bundle these first

Ordered by impact-to-effort. Could ship as one PR or split into two.

| # | Item | Step | Effort |
|---|------|------|--------|
| R1 | Restart-collector snippet on Step 2 manual path | 2 | ~half day |
| R2 | "Send test trace" button on Step 4 | 4 | ~1 hr |
| R3 | Inline "Test connection" on Step 1 | 1 | ~half day |
| R4 | Stepper rename + step subtitles | global | ~1 hr |
| R5 | "What this does" collapsible per step | global | ~2 hrs |
| R6 | Remove or rename Step 2 "POC" badge | 2 | ~5 min |
| R7 | Step 3 visual diagram (small SVG) | 3 | ~half day |

Details for each are in the per-step sections below — items marked **[R1]–[R7]**.

---

## Step 1 — Configure helix-gateway

### S1.1 — Stepper label "Configure" is abstract  [P2] **[R4]**

- **Current:** [Stepper.tsx:5](frontend/src/components/wizard/Stepper.tsx:5) — `{ n: 1, label: 'Configure' }`. First-time user can't tell what's being configured.
- **Change:** Rename to `Connect to Helix`. (Also rename "Exporter" → "Wire collector", "Connect" → "Network", "Verify" → "Test" — bundle in one commit.)
- **Files:** `frontend/src/components/wizard/Stepper.tsx`
- **Effort:** ~1 hr including the inter-step copy fix.

### S1.2 — No "where do I get this?" hint for endpoint or API key  [P1]

- **Current:** Placeholder text says "Paste your API key from the Helix portal" — but the user isn't there. No link.
- **Change:** Add a small `?`-icon tooltip or one-line help next to each field linking to the BMC Helix Portal location. Could be: *"Find in BMC Helix Portal → System Settings → API Keys"*. Confirm exact portal navigation with whoever owns the Helix side before shipping.
- **Files:** `frontend/src/components/wizard/Step1.tsx`
- **Effort:** ~1 hr including copy verification.

### S1.3 — API key validation is reactive, not proactive  [P2]

- **Current:** [Step1.tsx:31-38](frontend/src/components/wizard/Step1.tsx:31) `validateApiKey` fires after user types. Pattern is `TenantID::AccessKey::SecretKey` (three :: parts) but the user doesn't know this until they get the error.
- **Change:** Show the expected pattern as a labeled format hint under the field: `Format: TenantID::AccessKey::SecretKey`. Keep the validator as the fallback.
- **Files:** `frontend/src/components/wizard/Step1.tsx`
- **Effort:** ~15 min.

### S1.4 — No connectivity test on Step 1  [P1] **[R3]**

- **Current:** User types endpoint, doesn't learn it's invalid until Step 4 Verify. 5–10 minute round trip.
- **Change:** Inline "Test connection →" button next to the endpoint or as a small action above "Save & initialize". Probe `${HELIX_ENDPOINT}/api/health` (or whatever the actual reachability surface is) with a HEAD request; show pass/fail inline. Reuse the existing `/api/diagnostics/apikey-probe` flow if it suits.
- **Files:** `frontend/src/components/wizard/Step1.tsx`, `frontend/src/App.tsx` (probe handler), possibly new `backend/routes/diagnostics.js` endpoint if reachability check needs to live server-side (likely, since browser CORS would block direct probes).
- **Effort:** ~half day including the backend route.

### S1.5 — X-Source semantics are ambiguous  [P2]

- **Current:** [Step1.tsx:118-120](frontend/src/components/wizard/Step1.tsx:118) help text says "Choose a name that will map to a business service in Helix AIOps." Doesn't tell the user whether matching an existing service is required.
- **Change:** Rewrite to: *"This becomes the Business Service name in Helix's topology. If a service with this name doesn't exist, Helix creates it on first telemetry."* Verify with the Helix side that this is accurate before shipping — the wording is load-bearing.
- **Files:** `frontend/src/components/wizard/Step1.tsx`
- **Effort:** ~15 min + verification.

### S1.6 — "Save & initialize →" doesn't telegraph the gateway recreate  [P2]

- **Current:** Button text implies a quick save; the operation actually recreates the gateway (5–15 seconds).
- **Change:** Tooltip or microcopy under the button: *"Saves to .env and restarts helix-gateway so new values load."* Or rename to "Save and restart gateway →".
- **Files:** `frontend/src/components/wizard/Step1.tsx`
- **Effort:** ~10 min.

### S1.7 — Abrupt transition to Step 2 with no inline confirmation  [P3]

- **Current:** Click → loading → suddenly on Step 2.
- **Change:** Brief inline checkmark or toast: *"Saved. Gateway restarted."* before the transition.
- **Files:** `frontend/src/App.tsx` (`handleInitialize`), `frontend/src/components/wizard/Step1.tsx`
- **Effort:** ~20 min.

---

## Step 2 — Add helix-gateway as an exporter

### S2.1 — "POC" badge unnerves cautious users  [P3] **[R6]**

- **Current:** [Step2.tsx:90](frontend/src/components/wizard/Step2.tsx:90) renders a "POC" pill next to the Smart-add header.
- **Change:** Either remove (if smart-add is production-ready) or change to "Beta" / "Preview". Confirm with project owner before removing — the badge was deliberate.
- **Files:** `frontend/src/components/wizard/Step2.tsx`
- **Effort:** ~5 min.

### S2.2 — Smart-add gated on exactly one detected collector  [P2]

- **Current:** [useSmartAdd.ts:135-146](frontend/src/hooks/useSmartAdd.ts:135) only fires `refreshProposal` when `detectedCollectors.length === 1`. Multi-collector setups silently fall back to manual snippets.
- **Change:** When `length > 1`, show a collector selector ("Smart-add — choose collector:") that re-uses the same proposal/apply machinery against the user's pick.
- **Files:** `frontend/src/hooks/useSmartAdd.ts`, `frontend/src/components/wizard/Step2.tsx`
- **Effort:** ~half day.

### S2.3 — Manual path doesn't help locate the collector config  [P1]

- **Current:** "In your main collector config (e.g. `otelcol-config.yaml`)" — no hint about typical locations or how to find it.
- **Change:** Add a small "Where is my collector config?" expandable section listing common paths (`/etc/otelcol-contrib/config.yaml`, `/etc/otelcol/config.yaml`, the bind-mounted host path if detected). The backend's `detectCollectorConfigPaths` ([discovery.js:130-169](backend/routes/discovery.js:130)) already knows these — surface them.
- **Files:** `frontend/src/components/wizard/Step2.tsx`, optionally a new endpoint `/api/discovery/typical-config-paths` that returns the known-locations list.
- **Effort:** ~2 hrs.

### S2.4 — No restart-collector command for manual path  [P1] **[R1]**

- **Current:** [Step2.tsx:198-201](frontend/src/components/wizard/Step2.tsx:198) — "After saving, restart your collector container" with no command.
- **Change:** Add a SnippetBlock with `docker restart <your-collector-container>`. When exactly one collector is detected, pre-substitute the name. When multiple, show `<your-collector-container>` placeholder.
- **Files:** `frontend/src/components/wizard/Step2.tsx`
- **Effort:** ~half day (mostly because the substitution path needs the `detectedCollectors` prop wired through; small actual code change).

### S2.5 — No undo/revert for smart-add  [P2]

- **Current:** Smart-add writes `.helix-bak` ([discovery.js:530-548](backend/routes/discovery.js:530)) but the UI never mentions or surfaces it.
- **Change:** After smart-add success, render a small "Restore previous config" link next to the success banner. New backend route `POST /api/discovery/collector-restore/:name` that swaps `.helix-bak` back and restarts the collector.
- **Files:** `backend/routes/discovery.js`, `frontend/src/hooks/useSmartAdd.ts`, `frontend/src/components/wizard/Step2.tsx`
- **Effort:** ~half day.

### S2.6 — Verify-failure copy doesn't differentiate smart-add path from manual  [P3]

- **Current:** [Step2.tsx:62](frontend/src/components/wizard/Step2.tsx:62) — "Not detected — apply the snippet and restart the collector, then re-verify." Wrong advice when smart-add just applied and the verify is checking whether the restart took effect.
- **Change:** Branch on whether smart-add was the source: "Smart-add applied but the collector hasn't restarted yet — give it 10–15s and re-verify, or click Try smart-add again." vs the manual case.
- **Files:** `frontend/src/components/wizard/Step2.tsx`
- **Effort:** ~30 min.

---

## Step 3 — Connect helix-gateway and your collector to a shared Docker network

### S3.1 — Concept is hard without a visual  [P1] **[R7]**

- **Current:** Text-only explanation. Users who don't think in container networks have no anchor.
- **Change:** Small SVG diagram showing two boxes (helix-gateway + the user's collector) with a network line between them. States: disconnected (gray dashed line), verifying (animated), connected+verified (solid green). Label the network name when known.
- **Files:** New `frontend/src/components/wizard/NetworkDiagram.tsx`; integrate into `Step3.tsx`.
- **Effort:** ~half day.

### S3.2 — Detected vs Manual tabs imply equivalent paths  [P3]

- **Current:** [Step3.tsx:80-90](frontend/src/components/wizard/Step3.tsx:80) — two tabs, no hierarchy hint.
- **Change:** Rename to "Detected (recommended)" and "Manual (advanced)". The Manual tab is a fallback for cases where the detector misses something or the user has a specific routing need.
- **Files:** `frontend/src/components/wizard/Step3.tsx`
- **Effort:** ~10 min.

### S3.3 — Detach link is easy to miss  [P3]

- **Current:** [Step3.tsx:158-170](frontend/src/components/wizard/Step3.tsx:158) — small underlined gray text below the green Attached pill.
- **Change:** Replace text-only with a small unplug/×icon next to or replacing the text. Tooltip on hover with the network name being detached.
- **Files:** `frontend/src/components/wizard/Step3.tsx`
- **Effort:** ~15 min.

### S3.4 — K8s template button is destructive without obvious warning  [P2]

- **Current:** [Step3.tsx:97-115](frontend/src/components/wizard/Step3.tsx:97) — Apply template button. Confirmed via the existing ConfirmDialog wired in App.tsx (`requestApplyK8sTemplate`), but the in-Step-3 UI doesn't telegraph that this *overwrites the entire gateway YAML*.
- **Change:** Add an inline "Overwrites your gateway YAML" warning below the Apply button, plus a "Show what will change" link that opens a preview modal (or a diff against the current YAML if you want to be fancy).
- **Files:** `frontend/src/components/wizard/Step3.tsx`; optionally a new `TemplatePreviewModal.tsx`.
- **Effort:** ~2 hrs.

---

## Step 4 — Verify telemetry is flowing

### S4.1 — Verify button is amber/warning-colored  [P1]

- **Current:** [Step4.tsx:295](frontend/src/components/wizard/Step4.tsx:295) — `bg-warning hover:bg-warning-hover`. Reads as caution. The page also uses amber for partial-failure banners, so the visual language conflicts.
- **Change:** Switch to `bg-primary hover:bg-primary-hover` — same color as Step 1's "Save & initialize". Verify is the action that *proves* setup works.
- **Files:** `frontend/src/components/wizard/Step4.tsx`
- **Effort:** ~5 min.

### S4.2 — Live counters at 0 with no explanation  [P2]

- **Current:** Three CounterCards show 0/0/0 if no traffic has flowed. Users can't tell if the system's broken or just idle.
- **Change:** Add a help line above the counters: *"Counters increment as telemetry arrives — they'll stay at 0 until your app sends data or you click Verify below."* Hide once any counter goes non-zero.
- **Files:** `frontend/src/components/wizard/Step4.tsx`
- **Effort:** ~15 min.

### S4.3 — No "Send test trace" CTA on Step 4  [P1] **[R2]**

- **Current:** OverviewTab has one ([OverviewTab.tsx:166-180](frontend/src/components/OverviewTab.tsx:166)) but Step 4 doesn't. The Verify-trace path is conceptually similar but framed differently.
- **Change:** Add a tertiary "Send test trace" button next to "Verify gateway → Helix" that POSTs `/api/diagnostics/inject-trace`. Mostly a copy of the OverviewTab CTA. Lets a user see *anything* flow without configuring their app.
- **Files:** `frontend/src/components/wizard/Step4.tsx`, possibly `frontend/src/App.tsx` for the handler.
- **Effort:** ~1 hr.

### S4.4 — Restart warning competes with verify result panel  [P3]

- **Current:** "Helix gateway is not running" banner has its own restart button. If gateway becomes unreachable mid-verify, the verify result panel still shows stale pending/error.
- **Change:** When `gatewayStatus === 'restarting'`, suppress the verify result block — show only the restart banner. Restore the verify panel once gateway is back up.
- **Files:** `frontend/src/components/wizard/Step4.tsx`
- **Effort:** ~20 min.

### S4.5 — "After launch" tip list lives below the fold  [P3]

- **Current:** [Step4.tsx:317-325](frontend/src/components/wizard/Step4.tsx:317) — useful but scroll-distant from the Launch button.
- **Change:** Promote the bullet list higher, OR show as a tooltip on the Launch button. Easier: move it to right above the button, smaller text.
- **Files:** `frontend/src/components/wizard/Step4.tsx`
- **Effort:** ~10 min.

### S4.6 — Launch-gating tooltip is hover-only  [P3]

- **Current:** [Step4.tsx:305](frontend/src/components/wizard/Step4.tsx:305) — `title` attribute explains why the button is disabled, but only on hover.
- **Change:** Add a small inline `(run Verify first)` next to the button when disabled. Plus the existing tooltip.
- **Files:** `frontend/src/components/wizard/Step4.tsx`
- **Effort:** ~10 min.

---

## Cross-cutting

### C1 — No time estimate or progress feel  [P2]

- **Current:** Stepper shows 1-2-3-4 but no time hint.
- **Change:** Subtitle under the wizard title: *"~5 minutes • Saves automatically"*. Tweak as accurate to your real onboarding times.
- **Files:** `frontend/src/App.tsx` (wizard wrapper)
- **Effort:** ~10 min.

### C2 — No help / docs link  [P2] **[R5 partial]**

- **Current:** No `?` icon, no docs link, nothing.
- **Change (small):** "What this does" expandable per step — 2-3 sentences of plain-English explanation. **[R5]**
- **Change (larger):** Persistent `?` in nav opening a side drawer with FAQs: "What does X-Source do?", "How do I find my API key?", "What if my collector isn't detected?", "What does Step 3 actually do to my network?". Defer the drawer if you do R5 first.
- **Files:** Each Step component for the expandable; `frontend/src/App.tsx` nav for the drawer.
- **Effort:** ~2 hrs for the per-step expandables; ~half day for a real help drawer.

### C3 — Reset onboarding is subtle  [P3]

- **Current:** Small underlined link below the Stepper.
- **Change:** Kebab/3-dot menu next to the wizard title containing Reset. Keeps it discoverable but not accidentally-clickable.
- **Files:** `frontend/src/App.tsx`
- **Effort:** ~30 min.

### C4 — In-flight verify/attach state lost on refresh  [P3]

- **Current:** `setupStep` is persisted via `useLocalStorageState`; verify result, attach result, smart-add proposal are not.
- **Change:** Persist these to sessionStorage so a refresh mid-wizard doesn't make the user re-run probes. OR add a clear hint: *"Refresh resets verification state, but not your saved settings."*
- **Files:** `frontend/src/App.tsx` (state declarations), per-step components.
- **Effort:** ~half day for the sessionStorage approach; ~10 min for the hint.

### C5 — No "you can close this tab and come back" reassurance  [P3]

- **Current:** Persistence works (recent fix) but invisible to user.
- **Change:** Small footer line: *"Progress saved automatically. You can close this tab and come back."*
- **Files:** `frontend/src/App.tsx` (wizard footer)
- **Effort:** ~5 min.

### C6 — No skip/express mode for repeat users  [P3]

- **Current:** No fast-path for demo presenters or repeat testers.
- **Change:** `?onboarding=express` query param that collapses help text, hides explanatory copy, and surfaces only the inputs + actions. Stretch goal.
- **Files:** `frontend/src/App.tsx`
- **Effort:** ~2 hrs.

### C7 — Stepper jumps to future steps even when prior steps are incomplete  [P2]

- **Current:** [Stepper.tsx](frontend/src/components/wizard/Stepper.tsx) — clicking step 4 from step 1 lands on a half-broken page.
- **Change:** Disable forward jumps when the prior step isn't verifiably complete (env saved, smart-add applied or skipped, collector attached). Backward jumps stay free.
- **Files:** `frontend/src/components/wizard/Stepper.tsx`, `frontend/src/App.tsx` (passes step-completion booleans).
- **Effort:** ~half day.

---

## Deferred (real but not blocking)

These came up during the analysis but I'd hold them unless someone reports them:

- **Mobile/narrow-viewport pass.** `max-w-4xl` works on laptops; tablet portrait overflows the Step 2 smart-add panel + Detected list. Admin tools rarely target tablets — defer unless real users complain.
- **Persisting verify state in sessionStorage (C4 path B).** The hint version is enough for most users. Real persistence is a bigger change.
- **Help drawer (C2 large).** Wait until the per-step expandables prove the demand.
- **Forward-jump gating in Stepper (C7).** Real correctness improvement, but rework — defer behind the smaller items.

---

## Out of scope (called out for clarity)

- **Backend route renames.** Names like `/api/lifecycle/bridge` are now misleading after the APP_URL decoupling (the route no longer bridges). Rename to `/api/lifecycle/apply-env` or similar — but that's an API surface change, do it in a dedicated commit with deprecation handling.
- **OTel trace store reset.** Reset-onboarding doesn't wipe traces. That's a separate concern, surface it via the dashboard instead of bundling.
- **Multi-tenant / multi-environment support.** Wizard assumes one Helix tenant. Real product would want named environments — out of scope for the current iteration.

---

## How to use this doc

Three reasonable ways to consume it:

1. **Pick the recommended-next bundle**, ship that, come back later.
2. **One-step-at-a-time**: pick a single item, scope it, commit. The TODO items are small enough that most fit one commit each.
3. **Hand to a fresh agent**: this doc has enough context (file:line, current state, desired state) that a new session can pick any item and act on it without needing more background.
