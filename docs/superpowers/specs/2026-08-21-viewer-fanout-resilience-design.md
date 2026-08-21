# Local viewer fan-out resilience

Date: 2026-08-21
Status: approved, ready for implementation planning

## Problem

The gateway ships telemetry to two exporters. `otlphttp/bmchelix` delivers to the
Helix tenant. `otlphttp/helix_local_viewer` fans the same signals back to the
configurator's own `/api/otlp/*` routes so the View OTel Data page can render
them. The second path failed completely and silently: the UI showed
"No traces received yet" and "No traffic yet, 0 spans/s" while roughly 900
items per minute were shipping to Helix successfully, and the gateway health
banner reported healthy throughout.

### Observed failure

Every drop event in the gateway log was the viewer exporter, with a bare `EOF`:

```
[CRITICAL OTEL DROP] Exporting failed. Rejecting data.
{"kind":"exporter","data_type":"traces","name":"otlphttp/helix_local_viewer",
 "error":"failed to make an HTTP request: Post
 \"http://host.docker.internal:8765/api/otlp/traces\": EOF","rejected_items":131}
```

`EOF` means the TCP connection was accepted and then closed with no HTTP
response. Not a 404, not a 415, not a timeout, not a DNS failure. Failures were
independent of batch size, which rules out payload limits.

### Root cause

An IPv4 / IPv6 split-brain on port 8765, caused by a stale Docker Desktop port
proxy. Two processes were listening:

```
com.docke   7579  IPv4  TCP *:8765 (LISTEN)   <- Docker Desktop port proxy
node       14924  IPv6  TCP *:8765 (LISTEN)   <- native configurator
```

`backend/index.js` calls `app.listen(port)` with no host argument, so Node binds
`::` dual-stack. Because Docker had already taken the IPv4 wildcard (a leftover
`8765:3001` publish from a previous run of the configurator compose stack),
Node's bind succeeded on the IPv6 side only, with no `EADDRINUSE` and no
warning. The configurator container itself was not running, so Docker's proxy
was fronting a backend that did not exist.

Confirmed by direct probe:

```
curl -6 http://[::1]:8765/api/health        -> 200 in 2.8ms
curl -4 http://127.0.0.1:8765/api/health    -> 000 after 1.6s, connection dropped
```

The browser reached the app because macOS resolves `localhost` to `::1` first.
The gateway could not, because `host.docker.internal` resolves to an IPv4
address, so every export landed on the dead proxy and was hung up on.

An earlier diagnostic pass concluded the server was bound to `127.0.0.1` and
should be restarted with `--host 0.0.0.0`. That is incorrect. There is no such
flag, the server already binds every interface, and a restart would not have
changed anything.

### Contributing weaknesses

These turned a recoverable misconfiguration into an invisible one.

1. **The fan-out target is a hardcoded guess that is never verified.**
   `collectorFanout.js` pins `host.docker.internal:8765`. Nothing ever confirms
   the gateway can reach it.
2. **The hardcoded port ignores `PORT`.** The backend resolves its port through
   `portConfig.resolvePort`, but the rewrite always writes `:8765`. Any user who
   sets `PORT` in `.env`, which the README tells them to do on a collision, gets
   a permanently dead viewer with no warning.
3. **The rewrite is one-way.** `rewriteLocalViewerToHost` flips
   `helix-configurator:3001` to `host.docker.internal:8765` and nothing flips it
   back. Once the native path runs, the yaml is stuck in host mode. Running the
   compose path afterwards publishes `8765:3001`, which is what leaves a Docker
   proxy squatting IPv4 8765. The two deployment modes sabotage each other
   through a shared on-disk file.
4. **The health path is structurally blind to the viewer exporter.**
   `fetchCounters` in `routes/diagnostics.js` filters exporter counters to
   `otlphttp/bmchelix` by design, so viewer failures cannot appear in the banner
   at all. The banner was not wrong about what it measured, it was measuring
   only half the fan-out.
5. **The viewer exporter discards on failure.** `sending_queue: enabled: false`
   and `retry_on_failure: enabled: false` mean every failed batch is dropped
   instantly with no buffering.

## Goals

Chosen priorities: prevent the breakage in the first place, and make any
remaining breakage diagnosable in one click.

Explicit non-goals:

- **No backfill or buffering.** Enabling `sending_queue` and `retry_on_failure`
  on the viewer exporter is deliberately excluded. Buffering a local debug sink
  converts a loud failure into a quiet delay, which works against the goal.
- **No auto-relocating the UI port.** The configurator will not refuse to boot
  or silently move to a free port. This is a demo and onboarding tool where
  people bookmark `localhost:8765`, and relocating the UI trades a visible
  failure for a confusing one. Prevention comes from making the endpoint correct
  by construction and verifying it, not from evacuating the port.

## Design

### 1. `backend/viewerEndpoint.js`, one source of truth for the fan-out target

New module owning the question "what URL should the gateway ship to." It takes
the resolved port from `portConfig` and the deployment mode
(`IS_CONTAINERIZED` from `util.js`) and returns the preferred endpoint plus an
ordered list of fallback candidates:

1. `http://host.docker.internal:<PORT>` for the native path
2. the `host-gateway` bridge IP at the same port, for Linux Docker Engine where
   `host.docker.internal` may not resolve even with the injected `ExtraHosts`
3. `http://helix-configurator:3001` for the in-container path

Pure functions, no I/O. This fixes weakness 2 by construction: the port is
derived, never literal.

### 2. `collectorFanout.js` becomes bidirectional and parameterized

`rewriteLocalViewerToHost(yaml)` is replaced by
`rewriteLocalViewerEndpoint(yaml, target)`. The existing line-scoped rewrite
logic is preserved unchanged, including the guard that keeps the rewrite inside
the `otlphttp/helix_local_viewer:` block so user-added exporters using the same
legal `*_endpoint` form are not clobbered. `LOCAL_VIEWER_HOST` is removed.

Callers pass the target from `viewerEndpoint`. The Docker path gains the
inverse rewrite it never had, so switching deployment modes no longer leaves the
yaml pointing at the wrong stack. This fixes weakness 3.

Property to hold: rewriting native, then container, then native returns the
original yaml byte for byte, comments and formatting intact.

### 3. Deterministic dual-stack bind, and a startup preflight that names the squatter

`index.js` keeps one Express app and binds two explicit listeners: one on
`0.0.0.0` and one on `::` with `ipv6Only: true`. The current implicit `::` bind
is precisely what allowed the split-brain to form in silence. With an explicit
IPv4 listener, the same situation raises `EADDRINUSE`, which the existing
handler at `index.js:116` already catches.

The preflight then upgrades that message from a generic "port in use" to the
actual diagnosis. After listen, it probes its own port on both stacks and
classifies:

- both stacks answered by us: healthy, no output beyond the normal startup line
- IPv4 answered by a foreign listener: report that another process owns the IPv4
  side of the port, that the gateway fan-out to `host.docker.internal` will fail
  as a result, that Docker Desktop's port proxy is the usual culprit, and how to
  clear it
- IPv4 unbindable and unreachable: report IPv6-only operation and the same
  fan-out consequence

The process still starts in the degraded cases. It never starts silently in
them. Startup failure modes stay legible rather than becoming a new class of
"the app will not launch" support load.

### 4. Verify the endpoint by round-trip, and walk a fallback ladder

Correction to the original approach: a `docker exec` probe inside the gateway
container is not possible. `otel/opentelemetry-collector-contrib` ships without
a shell, confirmed by `docker run --entrypoint /bin/sh`, which fails with
`stat /bin/sh: no such file or directory`. There is no `sh`, `wget`, or `curl`
to exec.

Instead, the gateway proves reachability using its own exporter, over the real
path, which is a stronger signal than a shell probe anyway. `viewerCanary.js`
injects a uniquely-tagged synthetic span into the gateway's OTLP receiver and
then polls `otelStore.getTrace(traceId)` for it with a bounded timeout. If the
span comes back, the fan-out endpoint currently written in the yaml is proven
end to end.

After `createGatewayFromScratch` or a gateway recreate writes the yaml,
`lifecycle.js` runs the canary. On failure it rewrites the yaml to the next
candidate from `viewerEndpoint`, restarts the gateway, and retries, bounded by
the candidate list. The first candidate that round-trips is persisted.

Scope limit, stated so this does not overpromise: every native-path candidate
resolves to an IPv4 host address, so in the split-brain case that caused the
original failure, no candidate can succeed. The ladder fixes the resolvable
cases (a non-default `PORT`, and Linux Docker Engine where
`host.docker.internal` does not resolve). The split-brain case is caught and
named by the preflight in section 3 and the diagnosis in section 5. Together
they cover it: the ladder prevents what is preventable, the preflight makes the
rest loud and specific.

If no candidate works, the write still completes, but the lifecycle route
returns the failure with the canary verdict attached and the Diagnostics panel
shows it, rather than deferring it to a user noticing an empty page days later.

This is the control that would have surfaced the original failure at
config-write time. It fixes weakness 1.

### 5. One-click diagnosis

Two additions to the diagnostics surface.

**Viewer-scoped counters.** `sumPromCounter` already accepts an
`exporterFilter`, so add a read scoped to `otlphttp/helix_local_viewer`
alongside the existing `otlphttp/bmchelix` read. Both are reported, so the split
between "Helix delivery healthy" and "local viewer failing" is representable
instead of invisible. This addresses weakness 4 without changing what the
existing banner measures.

**`POST /api/diagnostics/verify-fanout`.** Exposes the same `viewerCanary`
module from section 4 over HTTP, so the user can run on demand what the
lifecycle path runs automatically. It closes the loop that the current
`inject-trace` endpoint leaves open: `inject-trace` pushes a synthetic span into
the gateway and reports success as soon as the gateway accepts it, which is
exactly the half of the path that was never broken. The new endpoint returns one
of three verdicts, each with a specific
remediation string:

- the span never reached the gateway: gateway receiver or connectivity problem
- the gateway accepted it but it never arrived in the store: viewer exporter
  problem, with the viewer-scoped failure counters and the most recent viewer
  exporter error included. When the error is `EOF` and the preflight has flagged
  a foreign IPv4 listener, name the split-brain case directly, since that
  combination is a recognizable fingerprint.
- the span round-tripped: viewer path healthy

The remediation strings are the deliverable here. A verdict of "fan-out failed"
is not one-click diagnosis. "Another process owns IPv4 port 8765, so the gateway
cannot reach the configurator" is.

## Testing

- `viewerEndpoint`: unit tests over port derivation and candidate ordering in
  both deployment modes, including a non-default `PORT`.
- `collectorFanout`: existing tests updated for the new signature, plus the
  native / container / native round-trip identity property, plus the existing
  guard that user-added exporters are untouched.
- Preflight: tests against a stub listener occupying one stack, asserting each
  of the three classifications, and asserting the process still starts in the
  degraded cases.
- Gateway-side probe: tests with a faked dockerode exec covering first-candidate
  success, fallback success, and total failure.
- `verify-fanout`: tests for all three verdicts using a stubbed store and
  stubbed counters.

## Files affected

- `backend/viewerEndpoint.js` (new)
- `backend/collectorFanout.js` (signature change, `LOCAL_VIEWER_HOST` removed)
- `backend/index.js` (dual-stack bind, preflight invocation)
- `backend/preflight.js` (new, port ownership classification)
- `backend/viewerCanary.js` (new, round-trip span canary)
- `backend/viewerLadder.js` (new, candidate selection driven by the canary)
- `backend/routes/lifecycle.js` (candidate ladder on gateway create and recreate)
- `backend/routes/diagnostics.js` (viewer-scoped counters, `verify-fanout`)
- frontend Diagnostics panel (surface the new verdict and remediation)
- `README.md` (Port and Process Reference: document the split-brain failure and
  the `PORT` override now flowing through to the fan-out endpoint)

## Open risk

The tracked `helix-otel-collector.yaml` is also the live runtime config that the
app rewrites in place, so normal operation dirties the working tree. That is out
of scope here, but it is the reason a stale endpoint can persist across
deployment modes unnoticed, and it is worth addressing separately.
