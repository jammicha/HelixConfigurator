# HelixConfigurator — Productization TODO

Tracks the gap between the current POC and Fortune 500 enterprise
readiness. Sourced from the honest-assessment conversation on
2026-05-20.

**Current scope: POC for stakeholder demo on 2026-06-11.** Items
below are explicitly **not** in scope for that demo. Productization
happens after stakeholder validation.

**Decision baseline (2026-05-20):**
- Auth revamp, Docker socket lockdown → post-POC (will be redone
  with the auth revamp itself)
- Kubernetes deployment → next phase after POC validation
- HTTPS / rate limiting → consider closer to demo if surface area
  expands beyond localhost
- Audit log of mutations → consider building during POC window
  (small, additive, stakeholder-friendly)
- Backup / restore / config export → out of scope

---

## Critical — security / compliance blockers

These are the items a Fortune 500 security review will block on.

### Auth revamp

Current model is shared-password "casual access prevention" — fine for
single-team trusted-network use, hard fail in any multi-user enterprise
deployment.

- Per-user identity (not a shared password)
- SSO support: SAML, OIDC
- Role-based access (admin can write config, viewer can only read status)
- CSRF token defense (currently relies on SameSite=Lax cookies only)
- Per-user audit attribution (extends the action-side audit log)
- Bootstrap-is-open eliminated (first-user setup needs proof-of-access)
- Session management beyond a 24h TTL (force-logout, concurrent-session
  limits, etc.)

A reasonable migration path: add a "proxy-friendly" mode first
(`TRUSTED_AUTH_HEADER` config so the configurator can defer auth to an
upstream nginx/Traefik with OIDC), then build out native SSO later.

### Docker socket lockdown

Configurator has effective host-root via `/var/run/docker.sock`.
Standard for tools like this; serious attack surface in any
non-trusted-network deployment.

- Mitigation: Tecnativa docker-socket-proxy in front
- Locks down to specific API verbs (inspect, list, restart) against
  specific container-name patterns (`helix-*`)
- Required for any deployment outside a single-team trusted network

### Plaintext secrets in `.env`

- `UI_AUTH_PASSWORD` stored cleartext
- `HELIX_API_KEY` stored cleartext
- Anyone with shell access to the host reads them

Options:
- Integrate with a secret manager at deploy time (Vault, AWS Secrets
  Manager, k8s Secrets)
- At minimum, hash `UI_AUTH_PASSWORD` (bcrypt / scrypt) so the cleartext
  isn't recoverable from disk

---

## High — next phase after POC validation

### Kubernetes deployment story

Today: docker-compose first. Some k8s detection exists (Step 3) but the
smart-add / apply / gateway-recreate flows assume a docker-compose
stack.

- Helm chart for the configurator + gateway
- k8s-native gateway management (operator pattern? or just helm-managed
  ConfigMap + Deployment + Service?)
- Investigate integration with the OpenTelemetry Operator for k8s
- Ingress story (annotations for popular ingress controllers)
- Liveness / readiness probes that work in k8s
- Reference architecture to evaluate: jaeger
  [`examples/otel-demo/`](https://github.com/jaegertracing/jaeger/tree/main/examples/otel-demo).
  One-script (`deploy-all.sh`) helm-based deploy of Jaeger + OpenSearch
  storage + the OpenTelemetry "astronomy shop" polyglot demo + HotROD
  across three namespaces, with port-forward and cleanup scripts.
  Useful as a model for the configurator's own helm chart shape, the
  multi-namespace layout, and a credible end-to-end smoke target
  (polyglot trace producers + real storage backend) for k8s parity
  testing of the smart-add / gateway-recreate flows.

### Operational observability of the configurator itself

If the configurator misbehaves at 2 AM, you currently read container
logs and hope.

- Structured logging (JSON lines)
- `/metrics` endpoint exposing the configurator's own behavior
  (request rates, error rates, gateway-recreate counts, etc.)
- `/api/health` deepened to report per-component state instead of binary
  up/down

### Backup / restore / config export

Out of scope per the 2026-05-20 decision, but documenting for completeness.

- Single endpoint that emits the full configurator state as a portable
  bundle: env vars, bridged networks, applied YAML, applied templates,
  bridged-networks.json, etc.
- Restore-from-bundle on a fresh install
- Versioned so future schema changes can migrate

---

## Medium — operations / DX hardening

### Self-restart edge cases (in-product password flow)

The 2026-05-20 password-management work introduced a self-restart via
the Docker socket. Known edge cases:

- Restart silently fails if the Docker socket isn't mounted (e.g.,
  certain k8s deployments). The `.env` change persists but the new
  env never takes effect.
- No graceful drain of in-flight diagnostic sessions / SSE streams /
  metric polls — they just die.
- No retry / recovery if the container fails to come back (compose
  restart policy must be set correctly).
- Frontend polling assumes the configurator comes back at the same
  origin. Won't work if the user is behind a reverse proxy that
  routes by host header.

### HTTPS guidance

Configurator runs plain HTTP. Users in any non-localhost deployment
need TLS in front (nginx, Traefik, cloud LB).

- Document the suggested nginx config (with example certs / paths)
- Startup banner / log warning if running on a non-localhost interface
  with no proxy detected (heuristic; not enforcement)

### Rate limiting

- In-process token bucket on `/api/auth/login`
- Stops trivial brute-force of an 8-char password
- ~30 lines of code; trivial to add when the auth surface expands

### Brittle Docker assumptions

Hardcoded container names (`helix-gateway`, `helix-bridge`,
`helix-configurator`). Some env-var overrides exist
(`TARGET_CONTAINER_NAME`, `SELF_CONTAINER_NAME`); not all.

- Audit all hardcoded names; expose each as an env override
- Document the env-var overrides for users with renamed compose
  services

### Smart-add backup of user's compose file

Smart-add edits the user's compose file in place. Some history is
preserved in Step 2 but not as a first-class versioned backup.

- Auto-backup to `.helix-configurator/backups/` on every edit
- Restore-previous affordance in the wizard
- Optional: write a `.bak` alongside the original file (more
  discoverable for users who don't know to look in our backup dir)

### Upgrade story / schema migrations

No defined upgrade path between configurator versions.

- SQLite schema migrations (when schema starts evolving)
- env-var compatibility (deprecation, renames)
- Document supported upgrade paths
- Possibly a "compatibility check" endpoint that flags incompatible
  state on startup

### Integration test coverage

Current: 101 backend unit tests, all small / pure-function focused.

Missing:
- Smart-add against a real compose file (real Docker daemon)
- Gateway recreate (real Docker daemon)
- Self-restart (real Docker daemon, real restart policy)
- Full wizard end-to-end against a real Helix tenant (probably
  mocked with a fake Helix server)

---

## Lower priority

### Multi-tenancy

- Single configurator → single gateway → single Helix tenant today
- Multiple gateways for HA / regional failover
- Possibly multi-tenant SaaS-style configurator (one configurator, many
  Helix tenants for many customers)

### Internationalization

- All copy is English
- Standard for v1; eventual blocker for global use

### AIOps Business Service auto-creation + X-Source linking

Earlier follow-up still pending — see the deferred-work mention in
session summaries. A "Create Business Service" button on Step 0 or the
AIOps page that calls the Helix CMDB API directly, saving a manual
step in the user's Helix tenant setup.

**Sharpened 2026-05-21:** the manual step has two parts, not one.
Confirmed on a fresh `seal1-itom-demo` tenant: traces ingest fine but
don't surface on the OTel Namespace Overview dashboard until the
X-Source value is *linked* to a business service in the tenant. Just
creating the BS isn't enough — the X-Source → BS mapping is the gate.
Two X-Sources matter for the configurator:
- the user's configured `X_SOURCE` (their real apps)
- the fixed `Helix-Configurator-Demo` X-Source the Layer 2 synthetic
  emits (see `backend/routes/step-zero/synthetic-scenario.js` — kept
  hardcoded by design so demo data stays quarantined from the user's
  real namespace)

Both need linking before the demo-vs-real-app handoff in Step 0 → Step 1
feels clean. Open questions for the implementation:
- Does the Helix admin/CMDB API expose BS creation *and* source linking
  as separate calls, or one combined call?
- Auth scope — does the API key the user pastes in Step 1 have CMDB
  write permission, or is a separate credential required?
- If we can't auto-link, the fallback is detect-and-warn: poll the
  tenant for unlinked X-Sources after a Layer 2 run and surface a
  banner with the exact tenant URL + values to paste.

**Multi-X-Source split (one host → many business services) — spec'd 2026-05-29.**
Related but distinct: splitting *multiple apps on one host* into multiple
X-Sources/business services via the OTel routing connector (route by
`service.namespace` → per-source exporters, mapping defined in a Settings
table). Full design, files-to-touch, and validate-first open items in
`docs/superpowers/specs/2026-05-29-multi-xsource-business-services-design.md`
(FUTURE TODO — review → `superpowers:writing-plans` → implement). Note: BMC
AIOps 26.1 docs say each X-Source *auto-creates* its AIOps service (no manual
link) — reconcile against the manual-linking finding above when implementing.

---

## In-POC consideration (2026-05-20 decision pending)

These two were called out during the productization conversation as
"could be useful for the POC stakeholder demo" but weren't decided
on at the time. Revisit if there's runway.

### Audit log of mutations (#4)

Append-only `audit.jsonl` in the data volume. Each entry: timestamp,
action, target, session (if auth on), success/error. Covers `.env`
edits, gateway recreate, YAML apply, password changes, container
restarts.

- ~150 lines including helper + call sites + basic tests
- Useful at the demo: "show me what changed last Tuesday" is a real
  question stakeholders ask
- Could ship before June 11 with low risk

### HTTPS startup guidance + rate limiting (#3)

Pre-demo, only matters if the demo environment isn't pure localhost.
Skip unless that changes.

- Login-endpoint rate limiter (~30 lines, real anti-brute-force)
- Startup banner detecting non-localhost interface without HTTPS
  (pure guidance, no enforcement)
- Documentation: suggested nginx config
