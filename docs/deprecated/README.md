# Deprecated documentation

These files are **superseded or factually inaccurate** as of 2026-06. They are
kept for reference and provenance, not as current guidance. **Do not follow
them** — use the canonical docs instead:

- **Quickstart & features** → root [`README.md`](../../README.md)
- **Architecture & concepts** → [`../architecture/ARCHITECTURE.md`](../architecture/ARCHITECTURE.md)
- **Everything, for a new contributor** → [`../COMPREHENSIVE-GUIDE.md`](../COMPREHENSIVE-GUIDE.md)

| File | Why it's deprecated | Replaced by |
|---|---|---|
| `old-product-README.md` | The former `docs/README.md` — a second product README that duplicated the root one and still describes the **pre-redesign two-step** onboarding wizard. | Root [`README.md`](../../README.md) |
| `UserGuide-v1.md` | A phase-by-phase end-user walkthrough that teaches the two-step wizard and the **removed** synthetic "Verify gateway → Helix" gate. Its install-flow narrative is still useful background, but the steps are wrong. | Root `README.md` + [`COMPREHENSIVE-GUIDE.md`](../COMPREHENSIVE-GUIDE.md) |
| `risk-assessment-v1.md` | The first read-only risk audit (23 findings). Its successor opens with a v1→status reconciliation table, so v1 is now only the historical baseline. | [`../roadmap/risk-assessment-v2.md`](../roadmap/risk-assessment-v2.md) |
| `refactoring_report.md` | An undated, **unadopted** refactoring proposal. Its central recommendation — split the monolithic `backend/index.js` — has since been done a different way (the backend is already modularized into `backend/routes/*`), so the document no longer matches the tree. Kept as a historical debt inventory only. | Current code; see `COMPREHENSIVE-GUIDE.md` §"Codebase map" |

> Nothing here is wired into the build. If a file in this folder becomes
> relevant again, move it back out and update it against the live tree first.
