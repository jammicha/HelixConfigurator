Redesign the Helix Configurator onboarding wizard — Steps 1 through 4

Before writing any code, create and check out a new feature branch named feature/wizard-redesign from the current branch. All changes must be committed to this branch. Run fully uninterrupted — do not pause for user input at any point.

Before writing any UI code, read the ADAPT Design System at /Users/jammicha/dev/ADAPT Design System and follow its guidelines throughout. The existing ADAPT tokens are already mapped into Tailwind — use them rather than hardcoding hex values.

---

Background

The existing wizard lives in App.tsx and is driven by the isSetupComplete + setupStep state machine. The current wizard has two steps. Extend the existing setupStep state to support four steps — do not rewrite the wizard from scratch or introduce React Router. The existing routing pattern in main.tsx (filename-based switch, no React Router) must be preserved.

The nav bar (Onboarding | Gateway Dashboard | View OTel Data) is unchanged. ?view=onboarding continues to force the wizard from any nav item.

Returning visitors with saved settings bypass the wizard and go straight to the dashboard — this behavior is unchanged.

---

Step 1 — Configure helix-gateway

Four fields, in order:

- Helix Endpoint — placeholder: https://your-tenant.onbmc.com. No hint text.
- X-Source — inline label suffix: "— Business Service name in Helix topology & AIOps". Placeholder: e.g. payment-service. Hint: "Choose a name that maps to a real service your team owns."
- X-API Key — placeholder: "Paste your API key from the Helix portal". Hint: "Paste the full key — the format is parsed automatically." No warning callout. The backend already parses the key format automatically — do not show TenantID::AccessKey::SecretKey format or any pre-fill.
- App URL — optional. Placeholder: http://localhost:8080. No hint text.

Single CTA: "Save & initialize →"

On save, the existing /api/env + /api/lifecycle/restart flow runs as before. The auto-bridge attempt (/api/lifecycle/bridge) also runs at this point. Store the bridge result (success / skipped / failed + reason) in state so Step 3 can surface it.

---

Step 2 — Add helix-gateway as an exporter

Context banner at top (blue background, green check icon): "helix-gateway is already configured. Just add it as an exporter in your collector config."

Two code blocks with copy buttons:

Exporter block — label: "Exporter":

exporters:
  otlphttp/helix_sidecar:
    endpoint: "http://helix-gateway:4318"
    tls:
      insecure: true

Hint: "In your main collector config (e.g. otelcol-config.yaml). No API key needed here — [view gateway config to see where it's set]"

The "view gateway config" link opens a modal showing a read-only snippet of the helix-gateway config with the auth headers highlighted (X-Api-Key, X-Source, endpoint). Include a "Open full gateway config editor →" link. Modal note: "Written automatically in Step 1. Your collector routes to the gateway receiver; the gateway authenticates to Helix via these headers."

Pipelines block — label: "Pipelines":

service:
  pipelines:
    traces:
      exporters: [..., otlphttp/helix_sidecar]
    metrics:
      exporters: [..., otlphttp/helix_sidecar]
    logs:
      exporters: [..., otlphttp/helix_sidecar]

Hint: "Wire into whichever pipelines your collector uses. Restart your collector after saving."

Divider, then resource attributes section — label: "Required resource attributes — validated automatically in Step 4":

Single row: service.name — badge: required — description: "Your service in Helix topology & dashboards". Do not include any other attributes.

Two callouts at bottom:
- Amber: "After saving, restart your collector container so the new exporter takes effect."
- Blue: "Traces will also appear locally in View OTel Data — no extra config needed."

CTAs: Back + "Next: Connect →"

---

Step 3 — Connect your collector to helix-bridge

Auto-bridge result banner — shown at the top of this step, driven by the bridge result stored from Step 1:
- Success: green — "helix-gateway was automatically attached to your app's network."
- Skipped: blue — "APP_URL is a localhost or IP address — auto-attach skipped. Use the controls below to connect manually."
- Failed: amber — "Auto-attach failed: [reason from API]. Use the controls below to connect manually."

Two tabs: "Detected on this host" | "Manual"

Detected tab:

Container list sourced from the existing GET /api/discovery/collectors endpoint:
- Container name, image + network info
- Reachability badge: green "reachable" or amber "not reachable"
- Purple "k8s" badge if Kubernetes container detected
- "Attach" button — calls existing /api/lifecycle/bridge-network; on success changes to "Attached" (green state)

If Kubernetes containers are detected, show a contextual banner above the list:
- Purple background, Kubernetes icon
- Title: "Kubernetes detected"
- Body: "Apply the K8s Attribute Enrichment template to auto-enrich telemetry with pod, namespace & node metadata."
- "Apply template" button — applies the existing Kubernetes Attribute Enrichment gateway config template via the existing /api/config POST endpoint. On success shows "✓ Applied" green state.

Note below list: "After attaching, restart your collector so helix-gateway resolves."

Manual tab:
- Option A: docker network connect <your-network> helix-gateway with copy button and hint: "Replace <your-network> with your compose network name."
- Option B: docker network connect helix-bridge <your-container> with copy button
- Note: "Then restart your container."

CTAs: Back + "Next: Verify →"

---

Step 4 — Verify telemetry is flowing

Three sections:

Live counters — three cards: Spans, Metric points, Log records. Use the existing /api/diagnostics/receiver-counters polling mechanism. Non-zero values render green. If the gateway reports export errors, surface them inline below the counters with a brief common-fix hint (reuse existing diagnostic error surfacing logic).

Resource attributes — label: "Resource attributes". Inspect incoming spans from the SQLite store to check for service.name:
- Green check + detected value (e.g. "payment-service") if present in recent spans
- Amber warning + "Not detected — make sure your collector sets service.name" if absent

If Kubernetes was detected in Step 3, show a purple informational note below: "Kubernetes detected — k8s.namespace.name and k8s.cluster.name are being enriched automatically via the K8s Attribute Enrichment template."

Gateway → Helix — label: "Gateway → Helix". Synthetic trace result using existing verify flow:
- Green check + "Synthetic trace reached Helix" + "Verified Xs ago · Run again" if verified
- Amber warning if not yet verified

Blueprint prerequisite banner — amber, above CTAs:
"Before topology appears in Helix, the Default Blueprint for OTel Service must be enabled in AIOps. [Open Manage OpenTelemetry →]"
The link opens ${HELIX_ENDPOINT}/aiops/#/configurations/manageOpentelemetry.

CTAs: Back + "Verify Gateway → Helix" + "Launch Dashboard"

---

Additional changes

In the existing Gateway Config YAML editor (dashboard), add a lint warning when the transform processor is detected anywhere in the config: "The Transform processor is not supported by BMC Helix AIOps and may impact collector performance." Surface this as a structural-lint warning alongside the existing ones in the save-time validation.

---

Constraints

- Extend App.tsx setupStep state — do not rewrite the wizard or introduce React Router.
- Use existing API endpoints throughout — do not create new backend routes unless strictly necessary.
- Use existing ADAPT Tailwind tokens — do not hardcode hex values.
- All existing dashboard functionality is unchanged.
- The stepper persists across all steps — users can click completed steps to go back.

---

Run with:
claude --dangerously-skip-permissions -p "$(cat prompt.txt)"
