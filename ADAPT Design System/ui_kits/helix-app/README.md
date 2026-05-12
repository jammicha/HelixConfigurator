# Helix App Shell UI Kit

Recreates the in-product look any **BMC Helix** application wears (ITSM,
AIOps, ServiceOps). Composed of:

- **`App.jsx`** — top-level shell, manages modal + HelixGPT panel state
- **`HelixTopBar.jsx`** — dark application header: brand, search, global
  tools, notification badge, **HelixGPT** trigger, avatar
- **`HelixSideMenu.jsx`** — grouped left navigation (Operate / Knowledge /
  Configure) with active-state accent and item counts
- **`HelixWorkspace.jsx`** — page header, KPI cards, incidents data table,
  activity feed
- **`NewIncidentModal.jsx`** — standard form modal (severity, service,
  description) with an inline **HelixGPT suggestion** alert
- **`HelixGPTPanel.jsx`** — slide-in right rail for the GenAI experience.
  Uses the brand `--helix-gpt-color` (`#f86e00`) as the *one* warm accent —
  never on generic CTAs.

## Demonstrated patterns
- Full app chrome (top bar + side nav + main + slide-in panel)
- Data table with status / severity badges
- Activity feed with semantic icons
- Modal form pattern with HelixGPT integration
- HelixGPT context chips, suggestions, and AI-disclaimer footer

## Tokens & assets used
- `colors_and_type.css` (project-wide tokens)
- `fonts/dpl-iconfont.css` (DPL Icon Font 3 glyphs throughout)
