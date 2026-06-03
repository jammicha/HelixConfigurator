# Multi-X-Source — split one host's apps into multiple Helix business services

> **Status: FUTURE TODO.** Brainstormed + specced; not yet implemented. A future
> session should review this, run `superpowers:writing-plans`, then implement.

## Context

X-Source is an **ingestion-time, per-export-connection** label, not a per-span
attribute. The OTel collector sets it as a header (`X-Source: <source>`) on the
export to Helix (current 26.x convention; the older 24.4 docs put it as a 4th
`::source` segment of the X-Api-Key — both exist, header is current). Confirmed
behaviors from BMC docs:
- **Each distinct X-Source auto-creates a service in BMC Helix AIOps named after
  it** — "A service will be created in BMC Helix AIOps with this name… the
  mapping is automatic" (aiops261). No manual UI link required (reconcile vs the
  older [[helix-tenant-xsource-linking]] note during implementation).
- `service.name` is required on spans; `service.namespace` is used for grouping
  in dashboards/blueprints.

**The pitfall:** the configurator's gateway has **one** `otlphttp/bmchelix`
exporter with `X-Source: ${env:X_SOURCE}`, so *every* app/host routed through it
collapses into **one** X-Source → **one** business service. There is no way today
to put multiple apps on one host into multiple business services.

## Intended outcome

A user running several apps through one configurator/gateway declares a distinct
`service.namespace` per app, maps each namespace → its own X-Source + business
service in the configurator's Settings, and the configurator generates a
collector that routes each app's traces to its own X-Source exporter (→ its own
auto-created AIOps service). Send-to-AIOps attributes each event to the right
source. Apps with no mapping fall back to the default (today's single source),
so existing setups are unaffected.

## Decisions locked during brainstorm
- **Scope:** "full multi-source" was selected. In design this resolves to
  **trace routing + per-source `convert-trace` event attribution**. Per-source
  correlation *policies* turned out to be **unnecessary** — the existing
  class+`service_namespace` policy already produces per-app Situations (see §4),
  so they're deliberately deferred, not silently dropped.
- **Split key:** `service.namespace`.
- **Mapping UX:** a Settings UI table.

---

## Architecture

### 1. Source-mapping store (new)
- Shape: `{ default: { xSource, businessServiceKey }, mappings: [ { serviceNamespace, xSource, businessServiceKey } ] }`.
- `default` is seeded from the existing `X_SOURCE` / `BUSINESS_SERVICE_KEY` (back-compat: empty `mappings` ⇒ today's behavior exactly).
- Persisted as JSON at `backend/data/source-mappings.json` (survives via the
  `./data` volume). New routes: `GET /api/source-mappings`, `PUT /api/source-mappings`.
- Pure helper `resolveSource(serviceNamespace, store)` → `{ xSource, businessServiceKey }`
  (exact-match on namespace, else `default`). Unit-testable.

### 2. Collector-config generation — routing connector (modify the generator)
When `mappings` is non-empty, the collector-yaml generator emits:
- a `routing` connector on `resource.attributes["service.namespace"]`,
- one `otlphttp/bmchelix-<slug>` exporter per mapping (each with its `X-Source`
  header; same `X-Api-Key`), plus the `default` exporter,
- per-source trace pipelines, **each also fanning to `otlphttp/helix_local_viewer`**
  so local `/otel-data` stays unified.

```yaml
connectors:
  routing:
    default_pipelines: [traces/default]
    table:
      - context: resource
        condition: attributes["service.namespace"] == "team-checkout"
        pipelines: [traces/checkout]
exporters:
  otlphttp/bmchelix-checkout: { traces_endpoint: ${HELIX_ENDPOINT}/..., headers: { X-Api-Key: ${HELIX_API_KEY}, X-Source: "Checkout-BizSvc" } }
  otlphttp/bmchelix-default:  { ... headers: { X-Source: ${X_SOURCE} } }
service:
  pipelines:
    traces/in:       { receivers: [otlp], processors: [batch], exporters: [routing] }
    traces/checkout: { receivers: [routing], exporters: [otlphttp/bmchelix-checkout, otlphttp/helix_local_viewer] }
    traces/default:  { receivers: [routing], exporters: [otlphttp/bmchelix-default,  otlphttp/helix_local_viewer] }
```
The gateway image (`otel/opentelemetry-collector-contrib`) already bundles the
routing connector — confirm the pinned version's OTTL syntax (validation step).
Logs/metrics pipelines stay single-source for v1 (out of scope to split).

### 3. Per-source Send-to-AIOps (modify `convert-trace`)
`convert-trace` resolves the source from the trace's root `service_namespace`
(already on `otelStore` summary) via `resolveSource(...)`, then feeds the
resulting `xSource` + `businessServiceKey` into `buildAnomalyEventPayload`
(which already takes both params — no builder change). Falls back to `default`.

### 4. Correlation policy — no change
The provisioned `OTEL_TRACE_ANOMALY` policy selects by class and groups by
`service_name` + `service_namespace`, so it already produces correct per-app
Situations regardless of source. Per-source business mapping rides on the
event's `service_id`/`x_source`, not the policy. (Per-source policies deferred.)

### 5. Frontend — Settings "Source mappings" table
Add a table to `HelixConnectionSettingsDrawer`: a default row (X-Source +
Business Service Key, bound to the existing env) plus add/remove mapping rows
(service.namespace, X-Source, Business Service Key). Persists via
`PUT /api/source-mappings`. Copy: "Apps set `service.namespace`; each mapping
routes that namespace to its own X-Source/business service. Changing this
regenerates the collector config — restart the gateway to apply."

### Data flow
app `service.namespace=team-checkout` → gateway `routing` matches → `otlphttp/bmchelix-checkout` (`X-Source: Checkout-BizSvc`) → Helix auto-creates service `Checkout-BizSvc`. `convert-trace` on a checkout trace → `resolveSource("team-checkout")` → event `x_source=Checkout-BizSvc`, `service_id=<checkout key>`.

---

## Files to create / modify (preview)
- **Create:** `backend/routes/source-mappings.js` (GET/PUT + JSON store), `resolveSource` helper (pure, in situations-payloads.js or a shared util) + tests; `backend/data/source-mappings.json` (runtime).
- **Modify:** the collector-yaml generator (routing connector emission); `convert-trace` (namespace→source lookup); `HelixConnectionSettingsDrawer.tsx` (mappings table); env load to seed `default`.
- **Reuse (no change):** `buildAnomalyEventPayload` (already param'd), `buildCorrelationPolicy`/provisioning, `getHelixBearerToken`/`bmcHeaders`.

## Error handling
- Unmatched namespace → `default` source (never drop). Validate: unique
  namespaces, non-empty X-Source, slug-safe exporter names. Regenerate the
  collector atomically; surface "restart gateway to apply".

## Testing
- **Pure unit:** `resolveSource` (match + default fallback, empty store);
  collector-yaml generator (given mappings → routing connector + N exporters +
  default, each fanning to local viewer).
- **Manual smoke:** two apps with distinct namespaces → confirm two AIOps
  services auto-created + per-app Situations.

## Open items to validate FIRST (implementing session)
1. Routing-connector OTTL syntax for the pinned collector-contrib version.
2. X-Source auto-service-creation on the live tenant (261 says auto; reconcile
   with the older manual-link note) — and whether a business-service *model*
   still needs the key linked for health rollup.
3. Gateway reload after collector-config change (restart vs hot reload).
4. Confirm `otelStore` summary's root `service_namespace` is the right grouping
   value for the lookup (vs participating namespaces).

## Out of scope (v1)
- Per-source correlation policies; routing by `service.name`; splitting
  logs/metrics by source; multiple Helix tenants.

## Sources
- [BMC AIOps 26.1 — Ingesting data from OpenTelemetry](https://docs.helixops.ai/bin/IT-Operations-Management/Operations-Management/BMC-Helix-AIOps/aiops261/Using-OpenTelemetry-to-identify-application-issues/Ingesting-data-from-OpenTelemetry/) (X-Source header; auto service creation)
- [OTel routing connector](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/routingconnector/README.md)
