# Multi-connection management

Date: 2026-09-03
Status: approved, ready for implementation planning

## Problem

The configurator can talk to exactly one Helix tenant. Tenant config lives as
five flat keys in `.env` (`HELIX_ENDPOINT`, `HELIX_API_KEY`, `X_SOURCE`,
`BUSINESS_SERVICE_KEY`, `HELIX_EVENTS_ENDPOINT`), read and written by
`backend/routes/env.js`. `helix-otel-collector.yaml` carries a single Helix
exporter, `otlphttp/bmchelix`, which resolves those keys at collector startup
via `${env:...}` substitution.

Pointing the app at a second tenant today means editing the one set of
credentials in place, which destroys the first. There is no way to ship the
same telemetry to two tenants, and no way to keep a staging tenant's
credentials around while working against production.

## Goal

Let a user define multiple named connections, each with its own endpoint, API
key, X-Source and related config, choose which signals each one receives, and
switch which connection the rest of the app acts against. Behind the scenes
each enabled connection becomes its own exporter in the gateway collector.

## Decisions

These were settled during design and are not open questions:

1. **Fan-out with an active default.** Connections can each be enabled or
   disabled for telemetry fan-out. Exactly one is active, and the active one
   drives every feature that can only address a single tenant.
2. **Per-signal toggles.** A connection can receive any subset of traces,
   metrics and logs. Source-based or namespace-based routing is out of scope.
3. **Active follows everything.** Situations and events REST calls,
   business-service linking, container deep-links, diagnostics probes and the
   Helm chart renderer all silently use the active connection. No per-page
   tenant pickers.
4. **Managed block in the YAML, hand edits preserved.** The app owns only the
   Helix exporters and their membership in the pipelines' exporter lists.
   Receivers, processors, the local viewer exporter and anything the user added
   by hand survive untouched. The Monaco gateway config editor stays fully
   editable.
5. **Structure in `data/connections.json`, secrets in `.env`.** The active
   connection is mirrored into the existing bare `HELIX_*` keys.
6. **The Gateway Dashboard stays a one-tenant view** with a switcher that sets
   the active connection.

## Data model

New file `data/connections.json`, covered by the existing `data/` gitignore
entry:

```json
{
  "version": 1,
  "activeId": "acme-prod",
  "connections": [
    {
      "id": "acme-prod",
      "name": "ACME Production",
      "endpoint": "https://acme.onbmc.com",
      "xSource": "acme-payments",
      "businessServiceKey": "",
      "eventsEndpoint": "",
      "signals": { "traces": true, "metrics": true, "logs": true },
      "enabled": true
    }
  ]
}
```

No API key in this file. `id` is a slug derived from `name` at create time and
is then immutable, because it is the stable handle for both the env key names
and the collector exporter name. Renaming a connection must not rewrite YAML
exporter keys. A slug that collides with an existing one gets a numeric suffix
(`acme-prod-2`).

`businessServiceKey` and `eventsEndpoint` live only here. Nothing in the
collector reads them, so they never need namespaced `.env` keys; they reach the
backend features that use them through the bare mirror keys of the active
connection.

`connections.json` is the single source of truth. `endpoint` and `xSource`
appear in both it and `.env` because the collector substitutes them at startup,
but the `.env` copies are a projection that is fully regenerated from
`connections.json` on every write, so the two cannot drift.

There is one concept, not two. `activeId` is what the Gateway Dashboard
switcher writes and what every single-tenant feature follows.

### Env projection

A new `backend/connectionsStore.js` owns load, save and `projectToEnv()`. For
each connection it upserts three namespaced keys into `.env`:

```
HELIX_ENDPOINT_ACME_PROD=https://acme.onbmc.com
HELIX_API_KEY_ACME_PROD=Tenant::Access::Secret
X_SOURCE_ACME_PROD=acme-payments
```

and mirrors the active connection into the existing bare `HELIX_ENDPOINT`,
`HELIX_API_KEY`, `X_SOURCE`, `BUSINESS_SERVICE_KEY` and
`HELIX_EVENTS_ENDPOINT`.

That mirror is what keeps this change tractable. `situations.js`,
`business-service.js`, `containers.js`, `diagnostics.js`,
`k8sChart/renderValues.js` and the support bundle read `process.env.HELIX_*`
in dozens of places and need no changes at all. Decision 3 falls out of the
mirror rather than being threaded through every call site.

Projection also prunes `*_<ID>` keys for connections that no longer exist,
otherwise a deleted tenant's API key sits in `.env` forever. It reuses the
write-lock chain pattern already in `backend/routes/env.js` so concurrent
saves cannot interleave their read-modify-write.

Disabled connections keep their `.env` keys. Pruning them would lose the API
key on every disable.

### Migration

On first load, if `connections.json` is absent and `.env` has a non-empty
`HELIX_ENDPOINT`, synthesize one connection: id `default`, name from
`X_SOURCE` or "Default Connection", active, enabled, all three signals. If
`.env` is also empty, the list starts empty and the wizard behaves exactly as
it does today. No user action and no lost config either way.

### Invariants

Enforced server-side rather than trusted from the UI:

- Exactly one active connection, and the active one must be enabled.
  Disabling or deleting the active connection requires naming a replacement;
  delete auto-promotes the next enabled connection.
- Endpoint, API key and X-Source validation moves server-side, reusing the
  rules currently living only in `frontend/src/components/wizard/Step1.tsx`.
  Frontend-only validation is fine for a single form and not fine once there
  is a programmatic CRUD API.
- Zero connections is legal. The collector keeps its viewer exporter and ships
  to no tenant.

## Collector YAML rewrite

### Identification by name, not by markers

Managed exporters are named `otlphttp/bmchelix_<id>`. The rewriter recognizes
them purely by that prefix, so no sentinel comments are needed and a user
reordering the file cannot confuse it. Everything else in `exporters:`,
including `otlphttp/helix_local_viewer` and anything hand-added, is untouched.

In each pipeline's `exporters:` list the rewriter removes entries matching the
prefix and reinserts the current set at the position of the first one removed,
leaving all other entries in place and in order.

The one-time migration also treats the legacy bare `otlphttp/bmchelix` as
managed and renames it to `otlphttp/bmchelix_default`, in both the exporters
map and all three pipelines.

### What gets emitted

A connection appears in `exporters:` only if it is enabled and has at least one
signal on. Its pipeline membership is per signal, so metrics-off means it is
simply absent from the metrics pipeline. Disabled connections vanish from the
YAML entirely. Each generated block carries a comment saying it is managed by
Manage Connections and will be regenerated.

### Mechanism

New `backend/collectorConnections.js`, built with the same discipline as
`backend/collectorFanout.js`: one shared block scanner used by both the reader
and the writer, so the two cannot drift on the subtle rules (blank lines and
comments do not end a YAML block, a dedent does).

Line surgery, not parse-and-reemit. Re-emitting through `js-yaml` would strip
every comment in the file, including the load-bearing "Don't remove this,
/otel-data depends on it" on the viewer exporter.

Surgical rewrites are error prone, so the write is verified before it lands:

1. `yaml.load()` the result.
2. Assert the parsed exporter set and per-pipeline membership match the
   intended connection list exactly.
3. Assert every emitted exporter's three `${env:...}` keys exist in `.env`.

A mismatch aborts the write rather than shipping a broken file. Step 3 matters
because a missing env var is a hard collector startup failure.

### Write path

Connection create, update and delete go through the atomic flow
`backend/routes/config.js` already implements: snapshot, write, restart, watch
the collector settle, roll back on rejection.

Ordering is `connections.json`, then `.env` projection, then YAML, then gateway
recreate. On collector rejection all three are restored from snapshot and the
gateway is recreated on the good config, so a bad tenant config cannot brick
the pipeline.

Recreate rather than restart is mandatory for the reason
`backend/routes/lifecycle.js` already documents: container env is frozen at
create time. `recreateGateway` already re-reads `.env` fresh, so it picks up
new namespaced keys with no change.

Activation is the exception and does not recreate anything. It writes
`activeId`, the five bare mirror keys and `process.env`. The collector reads
only namespaced keys, so the bare ones are inert to it and the switch is
effectively instant.

## Per-exporter health counters

`backend/routes/diagnostics.js` scopes its health counters with an exact-string
filter, `exporter="otlphttp/bmchelix"` (see `sumPromCounter` and
`fetchCounters`). Renaming the exporters silently breaks it: every "sent" count
reads zero and the health banner claims delivery is dead while telemetry flows
fine.

So `sumPromCounter` gains a predicate filter instead of a literal, and
`fetchCounters` matches the managed prefix.

That is not sufficient on its own. The `isDeadExporter` heuristic flags
"failures with zero successes". Summed across tenants, a healthy tenant A masks
a completely dead tenant B because overall `sent > 0`. Counters are therefore
computed per exporter and the verdict is per connection. The health banner
reports the worst case and names the failing tenant.

This also gives Manage Connections a per-connection sent and failed readout for
free, off the `:8888` Prometheus endpoint the app already scrapes, with no
extra calls to any tenant.

## Scoped reset

`POST /api/lifecycle/reset-onboarding` takes `{ connectionIds: string[] }`. An
empty body still means everything, so nothing that calls it today breaks.

The server computes the mode by comparing the selection against the full set
rather than trusting a flag from the client:

- **Full** (the selection covers every connection, or there are none):
  today's behavior unchanged, plus clearing `connections.json` and pruning
  every namespaced `.env` key. Bridged networks dropped, synthetic run
  cleared, gateway recreated with empty env.
- **Partial**: delete only the selected connections, prune only their
  `*_<ID>` keys, promote a new active connection if the active one was among
  them, re-project the bare mirror keys, drop those exporters from the managed
  YAML block, recreate the gateway. Bridged networks, synthetic run, wizard
  progress and `localStorage` are left alone.

The response returns `{ mode, deleted, activeId }`. `frontend/src/App.tsx`
currently wipes wizard state regardless of backend outcome, on the reasoning
that a user who asked to start over should not be stranded half-cleared. That
reasoning holds for a full reset and is wrong for a partial one, so the
frontend branches on `mode` and only takes the Step 1 bounce path on `full`.

The single `ConfirmDialog` becomes a modal listing every connection with a
checkbox, name, endpoint and active badge. The warning text below is live and
changes with the selection: a subset says which tenants stop receiving
telemetry and which connection becomes active, while checking all switches to
today's full-reset warning so nobody trips into a total wipe by clicking
"select all". Selecting nothing disables the confirm button.

## API

New `backend/routes/connections.js`:

| Route | Purpose |
|---|---|
| `GET /api/connections` | list plus `activeId` |
| `POST /api/connections` | create, slug assigned from name |
| `PUT /api/connections/:id` | update, slug immutable |
| `DELETE /api/connections/:id` | delete, auto-promotes active if needed |
| `POST /api/connections/:id/activate` | fast path, no gateway recreate |
| `POST /api/connections/:id/test` | reachability and auth, reusing the existing test-connection probe |
| `GET /api/connections/health` | per-exporter sent, failed and verdict |

Create, update and delete go through the atomic write path above. Activate does
not.

`GET` and `POST /api/env` stay, reimplemented as a thin facade over the active
connection, so `Step1.tsx`, the settings drawer and the support bundle keep
working unchanged during and after the migration.

API keys are returned in full, matching what `/api/env` does today and what the
drawer's show/hide toggle expects. Masking is a reasonable hardening change but
should be applied to both endpoints at once, so it is out of this scope.

## UI

**Manage Connections page** at `/connections`, reachable from the NavAvatar
apps menu and from a link in the existing settings drawer. Rows show name,
endpoint, X-Source, active badge, enabled toggle, three signal chips, a health
dot from the per-exporter counters, and actions for edit, test, activate and
delete.

A `<ConnectionForm>` component is extracted and shared by this page, the
`HelixConnectionSettingsDrawer`, and wizard Step 1. The validators move out of
`Step1.tsx` into a module the server-side validation mirrors.

**Wizard Step 1** keeps its current single-form shape and creates or edits the
active connection. It gains a small "Manage connections" link once more than
one exists.

**Gateway Dashboard** gains an "Active connection" dropdown in the header and
otherwise keeps its one-tenant shape. The one thing a single-tenant view would
lose is visibility of a failing tenant you are not looking at, so every entry
in the dropdown carries its own health dot. A dead tenant B is visible from
tenant A's dashboard without switching, which is the payoff for computing
verdicts per exporter.

**OTel Data viewer** is unchanged, with a one-line note: it receives telemetry
through the fan-out exporter before export, so it is not splittable by
connection. That is a property of where the fan-out sits, not a gap to fill
later.

**Helm chart** renders the active connection only. The Manage Connections page
says so explicitly so nobody assumes an exported chart fans out to every
tenant.

## Testing

Following the existing vitest `.test.mjs` conventions in `backend/__tests__`:

- `connectionsStore`: env projection, pruning on delete, stale-key cleanup,
  migration from a populated single-tenant `.env`, migration from nothing,
  slug immutability across renames, the one-active and active-must-be-enabled
  invariants.
- `collectorConnections`, modeled on `collector-fanout.test.mjs`: add, remove,
  rename, per-signal pipeline membership, a hand-edited file with extra
  processors and a custom exporter surviving a rewrite intact, the legacy
  `otlphttp/bmchelix` rename, and the verification step rejecting a
  deliberately corrupted rewrite.
- Reset: mode computation, partial delete leaving bridged networks and the
  synthetic run untouched, full reset matching today's behavior.
- Counters: per-exporter parsing, and specifically the masking case where a
  healthy tenant must not hide a fully dead one.
- A regression guard asserting the diagnostics counter filter still matches
  after the exporter rename, since that is the exact failure that would
  otherwise be silent.
- Integration: save a connection and assert `connections.json`, `.env` and the
  container `Env` all agree; force a collector rejection and assert all three
  roll back.
- Frontend vitest: the extracted validators, and the reset modal's mode
  switching between partial and full warning text.

## Out of scope

Named here so they are deliberate omissions rather than oversights:

- Source-based or namespace-based routing of specific services to specific
  tenants, which would need filter processors and per-connection pipelines.
- Multi-tenant Helm chart output.
- Per-connection views in the OTel Data viewer.
- API key masking in the connections and env APIs.
- Per-page tenant pickers on Situations or diagnostics.
