Before writing any code, create and check out a new feature branch named feature/otel-trace-viewer from the current branch. All changes should be committed to this branch. Run fully uninterrupted — do not pause for user input at any point.

Before writing any UI code, read the ADAPT Design System at /Users/jammicha/dev/ADAPT Design System and follow its guidelines for colors, typography, spacing, and components. The new page must feel like a native part of the configurator, consistent with existing UI patterns but conforming to ADAPT where the two overlap or conflict.

---

Background

The Helix Configurator is a Docker-based onboarding sidecar (Express backend on port 3001, React/Vite/TailwindCSS frontend, combined on port 8765 in production) that helps users wire their applications to BMC Helix via a managed OTel Collector (helix-gateway). Both containers attach to the helix-bridge Docker network. The gateway config is mounted as helix-otel-collector.yaml and currently exports traces, metrics, and logs to Helix via otlphttp/helix_sidecar. The existing Diagnostic Log Stream shows container/gateway logs — it is not OTLP log data.

---

What to build

1. Fan-out in the helix-gateway collector config

Add a second exporter — otlphttp/local_store — to the helix-gateway collector config that posts trace data to the configurator backend at http://helix-configurator:3001/api/otlp/traces. Wire it into the traces pipeline only alongside the existing otlphttp/helix_sidecar exporter. Metrics and logs continue routing to Helix only. The user's app instrumentation does not change.

2. Express backend — OTLP receiver and SQLite storage

- Add a POST /api/otlp/traces endpoint that receives OTLP trace data from the gateway fan-out, parses spans, and stores them in a local SQLite database using better-sqlite3.
- Cap storage at 500 traces. When the cap is reached, evict the oldest traces (sliding window).
- Expose the following query endpoints for the frontend:
  - GET /api/traces — filterable by service name and time range
  - GET /api/traces/:traceId — full span detail for a single trace
  - GET /api/traces/services — distinct service names seen so far
  - GET /api/traces/errors — error and exception records extracted from spans, with parent trace ID
- Use SSE (GET /api/traces/stream) to push new trace arrivals to the frontend in realtime.
- Add a separate POST /api/otlp/logs endpoint to receive OTLP log records, store them in SQLite keyed by traceId and spanId where present, and expose them via GET /api/logs/:traceId for inline correlation in the trace detail view. This is distinct from the existing container/diagnostic log stream.

3. Step 2 UI update

On the onboarding Step 2 "Route Your Telemetry" screen, add a passive informational note below the existing pipeline config snippet blocks stating that traces will also be visible locally in View OTel Data. Do not change the snippets themselves — the user's app still points at helix-gateway as before.

4. "View OTel Data" page — React

Build a new route (/otel-data) with two tabs: Traces and Logs & Errors.

Traces tab:
- Realtime streaming list of incoming traces via SSE — new traces appear without a manual refresh.
- Columns: service name, root operation, duration, span count, timestamp, status.
- Visual error badge on any trace containing spans with OTel error status or exception attributes.
- Slow trace flagging — highlight traces with duration > 1000ms.
- Service selector and time range picker to filter the list.
- Clicking a trace opens a waterfall detail view:
  - Spans rendered as nested horizontal bars showing timing and hierarchy relative to the trace root.
  - Error and exception details surfaced inline on affected spans (exception type, message, stack if present).
  - If spans follow OTel DB semantic conventions (db.system, db.statement, db.operation), display the query inline on the span and flag slow DB spans (> 1000ms).
  - N+1 detection heuristic: if a trace contains 5 or more spans with identical db.operation + db.name, surface a warning on the trace.
  - If OTel log records exist for this trace ID, show them inline within the waterfall at the appropriate span.
- DB and N+1 features degrade gracefully — if the attributes aren't present, those elements simply don't render.

Logs & Errors tab:
- Realtime streaming feed of error and exception records extracted from incoming spans (distinct from the existing container Diagnostic Log Stream).
- Each entry shows: timestamp, service, exception type, message, and a link that navigates to the parent trace in the Traces tab waterfall view.
- Empty state: clear message explaining this feed shows OTel log records and span exceptions, and that it will populate once your app is sending telemetry.

Empty state (Traces tab): when no traces have arrived yet, show a clear prompt guiding the user to send traffic to their app, with a reminder that the app should be pointing at helix-gateway:4318.

5. Nav bar

Add "View OTel Data" to the existing nav bar navigating to /otel-data, consistent with existing nav item style.

---

Constraints

- Everything runs on port 8765. No new ports exposed.
- Jaeger is not used — no Jaeger dependency of any kind. Storage and querying is handled entirely by the Express backend and SQLite.
- Do not change how the customer's app is instrumented.
- The existing Diagnostic Log Stream (container/gateway logs) is not modified.
- SQLite file should be written to a path that persists across container restarts (mounted volume or the existing install directory).

---

Run with:
claude --dangerously-skip-permissions -p "$(cat prompt.txt)"
