# Helix Configurator — Documentation

Start here.

## 📖 New to the project?

Read **[COMPREHENSIVE-GUIDE.md](COMPREHENSIVE-GUIDE.md)** — a single, detailed,
all-in-one onboarding guide covering what the product is, how it's built, the
full feature tour, the BMC Helix/AIOps integration, key engineering decisions
and gotchas, project history, and the roadmap. It's the fastest way to get
full context.

For the short version, the repo-root [`README.md`](../README.md) is the
quickstart + feature summary, and [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md)
is the canonical architecture tour.

## 🗂 Folder map

| Folder | What's in it |
|---|---|
| **`COMPREHENSIVE-GUIDE.md`** | The full new-contributor guide (the big one). |
| **`architecture/`** | Canonical design docs: `ARCHITECTURE.md` (concepts + data flow + API surface) and `Blueprints-v1.md` (deeper per-component engineering reference). |
| **`guides/`** | Operator how-tos, e.g. `cloudflare-tunnel-demo.md` (expose the configurator for a remote demo). |
| **`roadmap/`** | Live forward-looking work: `otel-data-todo.md`, `productization-todo.md`, and `risk-assessment-v2.md` (current weak-point backlog). |
| **`handoffs/`** | Forward-looking brainstorm briefs spun out of the 2026-06-03 demo (K8s, trace resource metrics, AIOps enrichment, auto-instrumentation, OTel Blueprints). See its own `README.md`. |
| **`history/`** | Completed-but-accurate records: shipped TODO checklists, the weekend-hardening plan/spec, the Situations↔Gartner mapping, and the original `kickoff-prompts/`. |
| **`superpowers/`** | The design archive from the "superpowers" planning workflow — dated `specs/` (design) and `plans/` (implementation) for shipped features. Actively appended to as new work is designed. |
| **`deprecated/`** | Superseded or inaccurate docs, kept for reference. See its `README.md`. |

## 🔖 Conventions

- **Markdown only is version-controlled.** `docs/.gitignore` scopes git to
  `*.md`. The demo deck (`artifacts/HelixConfigurator-Demo.pptx`), its
  `build_deck.py` generator, the Python `venv/`, and the `.env` template live on
  local disk only — their content is folded into `COMPREHENSIVE-GUIDE.md`.
- **`superpowers/` is a working archive.** It is appended to by ongoing design
  sessions; treat dated files there as point-in-time records, and trust the code
  over any doc when they disagree.
