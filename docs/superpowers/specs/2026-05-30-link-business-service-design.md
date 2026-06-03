# Link OTel namespace → Business Service (in-configurator)

> **Status: GUIDED-ONLY v1 — design locked after the Task 0 spike; ready to (re)plan + build.**
> Branch `feat/link-business-service` (rooted on `main`). Backend plan:
> `docs/superpowers/plans/2026-05-30-link-business-service-backend.md`.
>
> ⚠️ **Task 0 spike (2026-05-30, live tenant) — why v1 is guided-only:** the OTel
> ingest API key (IMS access key) authenticates IMS-fronted APIs only —
> events-service ✅ and `aiops-config/api/v1.0/situation_configurations` ✅ (both
> `Authorization: Bearer <IMS-JWT>`) — but is **rejected by every service-model /
> CMDB layer** it would need to list or create a Business Service: `/api/cmdb/v1.0`
> + `/api/arsys/v1/entry` → 401 (`AR-JWT` scheme → SSO "Hash Handler" HTML);
> `aiops-config` `services|service_models|blueprints` → 404; `/cloud-services`,
> `/api/v1.0/services`, `/dsm` → 401. **No IMS-Bearer API can list/create AIOps
> Business Services** — that layer needs AR-System creds the ingest key lacks. So
> v1 **guides** the user through the AIOps UI and captures the key; it makes **no
> authenticated Helix calls.** Full automate = future upgrade behind AR creds.

## Context

Onboarding OTel into Helix has a confusing hump (BMC "Ingesting data from
OpenTelemetry" Tasks 3–4): after telemetry flows, you must associate the OTel
service/namespace with a **Business Service** in AIOps and enable the **"Default
Blueprint for OTel Service"** so topology/health/Situations roll up. Today the
configurator only papers over the *output*: it deep-links to the AIOps Business
Service **iff** the operator manually hunted down the opaque service key and
pasted it into `BUSINESS_SERVICE_KEY` (`buildHelixBusinessServiceUrl`, the
nav-menu `aiopsServiceUrl`, the trace "Send to AIOps" pin all depend on it). The
linking itself is done by hand in AIOps.

This feature makes that hump a guided, in-configurator flow and captures the key
automatically — so it stops being "hunt-and-paste an opaque key."

## Intended outcome (guided-only v1)

From inside the configurator, a user onboarding their app: sees the OTel
namespace(s) actually arriving; gets walked through creating-or-picking the
Business Service and binding the OTel blueprint in AIOps (every value pre-filled
and explained); pastes back the resulting service URL/key; and the configurator
captures it to `BUSINESS_SERVICE_KEY` — lighting up every existing deep-link. No
key-hunting, and no AIOps expertise needed beyond following the checklist.

## Decisions locked
- **Audience:** customer self-serve, any production tenant.
- **Write appetite: GUIDED-ONLY (forced by the Task 0 spike).** The configurator
  makes **no authenticated Helix REST calls** for this feature — it reads local
  telemetry, builds a guided deep-link + checklist, and writes only its own
  `.env`. Automate (CMDB search/create/verify) is deferred behind **optional
  AR-System creds** (future upgrade — see Out of scope).
- **Entity scope:** Business Service only.
- **Placement:** hybrid — wizard **Step 5** + **dashboard card** (one shared flow).

## Relationship to adjacent specs / memory
- **Feeds `multi-xsource-business-services`:** that spec's source-mapping table
  needs a `businessServiceKey` per namespace; this is how the operator *obtains*
  it (guided capture). Shared surface: `BUSINESS_SERVICE_KEY`.
- **Reconcile with [[helix-tenant-xsource-linking]]** (manual link needed in
  practice) and [[helix-otel-namespace-model]] (BS → OTel Namespace =
  `service.namespace` → OTel Service). The auth boundary above is recorded in
  [[link-business-service-feature]].

---

## User flow — guided-only, one 4-state component (wizard + dashboard share it)

1. **Detect.** List the OTel namespace(s) already arriving (local `otelStore`;
   un-namespaced traces fall back to `X_SOURCE`). Per namespace: *arriving · key
   captured?* Grounds the task in real data: "namespace `checkout` is arriving —
   not yet linked to a Business Service."
2. **Guide.** A pre-filled checklist + deep-link into AIOps: create or open a
   Business Service → **Add Dynamic content → "Default Blueprint for OTel
   Service"** → select namespace `checkout` → Save. No API writes — the user does
   it in AIOps (the only place it's possible).
3. **Capture.** The user copies the AIOps Business Service URL (or key) and pastes
   it back; the configurator extracts the key (reusing `extractServiceKey`) and
   persists `BUSINESS_SERVICE_KEY` to `.env` **and** `process.env` (no restart —
   the key is read per-request). Existing deep-links light up immediately.
4. **Confirm (guided).** One-click open the Namespace/BS dashboard so the user can
   eyeball the rollup. No API verify (that layer isn't reachable with the key).

Wizard entry = "finish onboarding"; dashboard card = ongoing ("namespace
`payments` showed up — link it too").

---

## Architecture (guided-only — small, no auth, no Helix REST)

### Backend
- **`otelStore.listNamespaces()`** — distinct `service.namespace`s seen, with
  trace counts + last-seen (local SQLite; null = un-namespaced).
- **`envFile.js`** — `upsertEnvVar(envPath, key, value)`, a generalized `.env`
  line writer (new code; `auth.js` left untouched).
- **`business-service-payloads.js`** (pure) — `buildBindInstructions({endpoint,
  namespace, xSource})` → `{ steps[], aiopsUrl, dashboardUrl }`; reuses the
  existing namespace-overview URL pattern for `dashboardUrl`. No CMDB builders.
- **`routes/business-service.js`** — three thin, **unauthenticated-to-Helix**
  handlers: `GET /api/business-service/namespaces` (otelStore + `X_SOURCE`
  fallback), `GET /api/business-service/bind-instructions` (pure builder),
  `POST /api/business-service/persist-key` (`.env` + `process.env`).
- **NOT needed (dropped — YAGNI):** `helixRest.js` extraction, IMS/CMDB calls, a
  DI `helix` seam, the `search`/`create`/`verify` endpoints. The spike proved
  none can work with the OTel key.

### Frontend (Plan 2)
- **`components/business-service/LinkBusinessService.tsx`** — the 4-state flow
  (Detect → Guide → Capture → Confirm); `context: 'wizard' | 'dashboard'`.
- **`useBusinessServiceLink.ts`** — fetches + state machine (mirrors `useSmartAdd`).
- **Wizard:** new `Step5.tsx` + `Stepper.tsx` update + App orchestration.
- **Dashboard:** `BusinessServiceCard.tsx`.
- Reuse `extractServiceKey`, `buildHelixBusinessServiceUrl`, `hasRealHelixEndpoint`.

### Data flow
app emits `service.namespace=checkout` → gateway → `otelStore` → **Detect** lists
it unlinked → **Guide** shows the AIOps checklist + deep-link → user creates/binds
in AIOps, copies the BS URL → **Capture** extracts the key, writes
`BUSINESS_SERVICE_KEY` (`.env` + `process.env`) → deep-links + `convert-trace` pin
resolve → **Confirm** opens the dashboard to eyeball the rollup.

### Error handling (small surface — no auth/CMDB calls)
- No telemetry yet → Detect shows "no namespaces arriving yet — start your app or
  run a synthetic scenario," with a link to Step 0.
- `persist-key`: `400` on empty key; otherwise writes and echoes the saved key.
- Placeholder/empty endpoint → the deep-link/dashboard builders return null and
  the UI hides those affordances (reuse `hasRealHelixEndpoint`).

### Testing
- `listNamespaces` (seeded `:memory:` db), `upsertEnvVar` (temp file),
  `buildBindInstructions` (pure) — all unit-tested. Routes via **supertest with
  no network or mocking** (they touch only otelStore + a temp `.env`).
- Frontend: state-machine transitions + rendering (Plan 2).

## Open items — mostly resolved by Task 0
1. **Auto-create vs manual** (aiops262): worth reflecting in the Guide copy — if a
   service auto-exists for the X-Source/namespace, the step is "open & bind"
   rather than "create"; the checklist should cover both. Confirm live during
   Plan 2.
2. **Exact AIOps "Services" list deep-link route** — v1 can link to `/aiops/` +
   instructions; nice-to-have to deep-link straight to the services list. Confirm
   the route (or have the user point me to it) during Plan 2.
3–6 (CMDB endpoint/class, JWT scope, verify read, blueprint readability):
   **RESOLVED / N/A** — the OTel key can't reach those layers (see Status); no API
   automate in v1.

## Out of scope (v1) / Upgrade seam
- **Automate search/create/verify via CMDB — future, behind optional AR-System
  creds.** When a tenant can supply an AR-System account, the configurator could
  mint an `AR-JWT` (`POST /api/jwt/login`) and add real `search`/`create`/`verify`
  endpoints; the guided flow stays the universal fallback. This is the "Guided
  core + optional AR creds" option from the decision history.
- Technical Service / Business Application; multiple Helix tenants.

## Sources
- [BMC AIOps 262 — Ingesting data from OpenTelemetry](https://docs.helixops.ai/bin/IT-Operations-Management/Operations-Management/BMC-Helix-AIOps/aiops262/Using-OpenTelemetry-to-identify-application-issues/Ingesting-data-from-OpenTelemetry/) (Tasks 3–4).
- [Managing services and situations by using REST APIs (AIOps 262)](https://docs.helixops.ai/bin/IT-Operations-Management/Operations-Management/BMC-Helix-AIOps/aiops262/Managing-services-and-situations-by-using-REST-APIs/) — `aiops-config/api/v1.0/` (IMS Bearer; situations only, no services CRUD).
- [BMC Helix CMDB REST API](https://docs.bmc.com/docs/ac233/learning-about-the-rest-api-1236622321.html) — needs AR-System auth (`POST /api/jwt/login` → `AR-JWT`), not the IMS key (Task 0 finding).
- Adjacent spec: `2026-05-29-multi-xsource-business-services-design.md`.
