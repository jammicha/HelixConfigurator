## 5-14-2026

**Replace name-based container matching with capability-based detection**

Current routes/lifecycle.js:191 matches the customer collector by name substring. Name matching is fundamentally unreliable across arbitrary customer environments, collectors are named anything, and compose adds prefixes and suffixes.

Detect candidate collectors by capability, not name: containers publishing or exposing 4317/4318, and/or running a recognized collector image (otel/opentelemetry-collector*, otel/opentelemetry-collector-contrib*, vendor distros). Use both signals, prefer the intersection.
If exactly one candidate: use it, but show the user which container was selected and let them override.
If multiple candidates: do not auto-pick. Present the list and require the user to choose.
If zero candidates: do not fail silently. Tell the user no collector was detected and provide a manual entry path (container name or network).
The configurator must never attach anything except helix-gateway to helix-bridge. Guard this explicitly.
Tests: fixture with zero collectors, fixture with one, fixture with three (including compose-prefixed names like acme_otel-collector_1). Confirm zero and many both route to user input rather than a guess.

**Verify-trace deadline and verdict**

routes/diagnostics.js inject-trace-verify polls counters for 5s, then returns an ambiguous "pending" that collapses three different root causes into one verdict.

Extend the deadline to 30s minimum. End-to-end inject-to-visible can legitimately take 30s on a busy tenant.
Read otelcol_exporter_queue_size and otelcol_exporter_send_failed_* from BOTH the customer collector and the gateway, not just one. A backup at the customer side points at the gateway being unreachable; a backup at the gateway side points at BMC.
Differentiate the verdicts in the UI: "queued at customer side, gateway unreachable", "queued at gateway side, BMC slow or rejecting", and "rejected, auth or payload". The current single "pending" hides too much and drives users to reload or file tickets.

**Persist the gateway's network attachment in compose**

The gateway repeatedly fell off opentelemetry-demo during the session. Every configurator recreate and every demo down/up knocked it loose because the attachment is done imperatively. Declare both networks in the HelixConfigurator docker-compose.yml:
yamlservices:
  helix-gateway:
    networks:
      - helix-bridge
      - opentelemetry-demo

networks:
  helix-bridge:
    driver: bridge
  opentelemetry-demo:
    external: true
external: true because the customer's stack owns that network. This will not survive the customer destroying their own network, but it eliminates the far more common case where our stack's recreate drops the gateway.

**Step 3 check is topology-only and assumes a single collector**

Two problems. First, the check only confirms a network edge exists, it does not confirm the gateway's receiver is bound on that interface or that the customer collector's exporter is actually succeeding rather than sitting in retry backoff. Second, it assumes "the collector" is singular and present.

Before showing green: confirm the gateway's OTLP receiver is listening on the shared network's interface, and read the chosen customer collector's otelcol_exporter_send_failed_* and queue-size metrics to confirm exports are succeeding.
Handle the multi-collector case: Step 3 operates on whichever collector was selected in the detection step, and should state which one.
Handle the no-collector case: Step 3 cannot pass, and should say why and point back to manual entry.
A network edge existing is necessary but not sufficient for green.

**Step 3 UI copy hardcodes network and collector assumptions**

The heading reads "Connect your collector to helix-bridge" and the body references helix-bridge, but the network that must be shared is the customer collector's network, not ours, and the customer collector should never join helix-bridge. The copy also implies a single known collector.

Replace the hardcoded helix-bridge string with the dynamically detected shared network name throughout heading, body, and success message.
Reference the specific detected or selected collector by name rather than "your collector" in the abstract.
Make the three states visibly distinct: connected and verified, network present but not verified, and no collector or network resolved.