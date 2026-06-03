# Synthetic error spans — RCA enrichment (exception + code.*) — design

**Date:** 2026-05-30
**Status:** Approved (brainstorm) → ready for implementation plan
**Builds on:** `2026-05-29-otel-class-recreate-design.md` (the slot fix that made these slots first-class)

## Problem

The demo's errored Situations name the probable cause but leave `error_type` and
`code_location` empty, because the synthetic generator's error spans set ERROR status +
a status message but emit **no OTel `exception` event and no `code.*` attributes**.
`deriveProbableCause` therefore has nothing to populate those two slots from, so the
Situation can't deep-link to file:method:line.

## Goal

Make the originating error span of each error scenario emit an `exception` event +
`code.*` attributes, so `error_type` and `code_location` populate. **Producer-only** —
the consumer chain (`otelStore` flattens span+event attrs and extracts span_errors from
`exception` events; `deriveProbableCause` reads `exception.type` and `code.*`) is already
in place and verified.

## Non-goals (YAGNI)

- No new error patterns; no changes to the configurator or any consumer code.
- Cascade/propagation spans (cart-api, checkout-web) stay status-only — so the probable
  cause still resolves to the true origin.
- Stack flavor is Python (psycopg2 / requests), per decision.

## Changes — all in `backend/routes/step-zero/synthetic-scenario.js`

1. **`buildSpan`** gains an optional `events` param; when non-empty it sets
   `span.events` (OTLP shape). No change to existing callers (param defaults absent).
2. **`buildExceptionEvent({ type, message, stacktrace, timeMs })`** → OTLP event
   `{ name: 'exception', timeUnixNano, attributes: [exception.type, exception.message,
   exception.stacktrace] }`.
3. **Pattern B — inventory-db connection refused** (when `injectInventoryError`):
   - `code.*` added to `buildInvDbAttributes` (only in the error case):
     `code.filepath = 'services/inventory/repositories/stock_repository.py'`,
     `code.function = 'get_stock'`, `code.lineno = 142`.
   - exception event on the inventory error spans: type `psycopg2.OperationalError`,
     message `connection refused: inventory-db unreachable` (matches the existing status
     message), short Python traceback as `exception.stacktrace`.
4. **Pattern G — stripe retry storm**, on the two failed attempts (in
   `buildRetryStormStripeSpans`):
   - attempt 1 (timeout): `requests.exceptions.ReadTimeout` —
     `HTTPSConnectionPool(host='api.stripe.com', port=443): Read timed out. (read timeout=5)`.
   - attempt 2 (503): `requests.exceptions.HTTPError` —
     `503 Server Error: Service Unavailable for url: /v1/charges`.
   - `code.*` on those spans: `services/payment/clients/stripe_client.py` · `charge` · `88`.

## Data flow (unchanged, already verified)

`generateTrace` → OTLP `/v1/traces` → `otelStore.extractSpans` flattens span and event
attributes to objects → `getTrace().spans[]` carry `.events` (parsed) + `.attributes` →
`deriveProbableCause` sets `error_type = exception.type`, `error_message =
exception.message`, `code_location = code.filepath:code.function:code.lineno` → convert-trace
event slots → BHOM Situation.

`deriveProbableCause` prefers spans that carry an `exception` event, so adding events only to
the originating spans keeps the origin selection correct (inventory-db for B;
`stripe-mock/POST /v1/charges` for G); the cascade spans, left status-only, are never picked.

## Testing (TDD)

Mirror the existing ~2000-sample approach in
`backend/__tests__/step-zero-synthetic-scenario.test.mjs`:

- **Inventory error:** over a 2000-trace sample, for every trace whose `inventory-db` span
  has `status.code === 2`, assert that span has an `exception` event with
  `exception.type === 'psycopg2.OperationalError'` and the three `code.*` attributes
  (`code.filepath`, `code.function`, `code.lineno`).
- **Retry storm:** for traces whose `stripe-mock` spans include `status.code === 2`, assert
  the failed attempts carry an `exception` event (`requests.exceptions.*`) + `code.*`.
- **Unit:** `buildSpan` attaches `events` when passed one (and omits it otherwise).
- All existing synthetic / `otelStore` / `situations-payloads` tests stay green — the new
  events/attrs are additive; verify nothing pins an exact attribute count or asserts the
  absence of exception events.

## Verification (after implementation)

Rebuild the container, let a fresh errored trace flow through convert-trace, and confirm the
BHOM event now carries non-empty `error_type` (`psycopg2.OperationalError`) and
`code_location` (`services/inventory/repositories/stock_repository.py:get_stock:142`).

## Risks

- An existing test may pin the exact inventory attribute set or span shape — verify and
  adjust if so (the change is additive).
- Stripe error spans are attributed to `service.name = stripe-mock`, so `code_location`
  references the payment-service client that made the call (where the exception is raised) —
  intentional and realistic for an OTel client span.
