# Waterfall spans: color-code by service

**Date:** 2026-05-31
**Status:** Approved
**Scope:** `frontend/src/components/otel-data/trace-detail/SpanRow.tsx` (one file)

## Problem

In the trace-detail view, the **Service breakdown** bar/legend and the **Flame
view** both color services via `colorForService()` (`palette.ts`). The
**Waterfall** is the lone holdout: the service name renders as plain gray text,
and the timeline bar is colored by *semantic state* (red=error, amber=slow,
teal=db, indigo=normal) rather than by service. Users want the waterfall to
match the breakdown so a `frontend` span reads as yellow-gold and a `customer`
span as burnt-orange at a glance.

## Decision

Hue now means **service, exclusively** — consistent with the breakdown legend
and the flame view. Status (error/slow) moves to a **separate visual channel**
(a ring/wash + the existing badges), so it never collides with service hue.

Rejected alternative ("error/slow override the bar hue"): the service palette
already contains a red (`#c42a3f`) and golds/oranges (`#d99100`, `#a84300`) that
overlap the status colors (`danger #b2001e`, `warning #ffd200`). Encoding status
*and* identity in the same hue channel would make a healthy red-service span
indistinguishable from an error. So status gets its own channel.

## Changes (SpanRow.tsx only)

1. **Service swatch by the name.** Prepend an 8px `w-2 h-2 rounded-sm` square
   colored `colorForService(span.serviceName)` to the secondary line that shows
   `{span.serviceName}` — identical to the breakdown legend square.

2. **Bar fill = service color.** Replace the semantic `barColor` classes with an
   inline `backgroundColor: colorForService(span.serviceName)`. Critical-path
   emphasis becomes opacity (mirrors the flame view): on-path → full color
   (matches the breakdown segment hue), off-path → ~0.5 (recedes).

3. **Error/slow accent on its own layer.** A status overlay div over the fill,
   *not* subject to the critical-path opacity (stays crisp off-path):
   - Error: `inset 0 0 0 2px #b2001e` ring + ~30% `#b2001e` wash.
   - Slow: `inset 0 0 0 1.5px #ffd200` ring, no wash (error outranks slow).
   - Existing Error / Slow / db.system badges by the name stay as textual backup.

4. **Unchanged.** The CRISP critical-path "blocking portion" black overlay still
   renders on top.

## Intentionally dropped

Bar hue no longer encodes error/slow/db/normal. DB-ness is still carried by the
`db.system` badge next to the name (and mysql/redis are their own services with
their own colors here anyway).

## Verification

Visual — build the frontend and screenshot a trace's waterfall; confirm swatches
+ bars match the breakdown legend, an error span shows the red ring, a slow span
the amber ring, and off-path spans recede. Add a focused component test if the
existing harness supports it.
