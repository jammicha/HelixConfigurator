# ADAPT Design System

> ADAPT is **BMC Software's** design system — a unified library of components, tokens,
> guidelines, iconography and visual language used to build BMC's enterprise products
> (most notably the **BMC Helix** platform and **HelixGPT** GenAI experiences).

This project is a **design-agent-ready** recreation of ADAPT distilled from the
public `adapt-angular` v20.12.0 source release. It contains tokens, fonts, icon
font, key brand illustrations, JSX UI kits and skill metadata so an agent can
generate well-branded BMC ADAPT artifacts (mocks, prototypes, slides) without
re-reading the original Angular monorepo.

---

## Sources

| Source | Path / URL |
| --- | --- |
| Primary codebase | `adapt-angular-20.12.0/` (locally mounted, read-only) |
| Theme tokens | `libs/adapt-css/src/scss/adapt-theme.scss` |
| Icon font | `libs/dpl-iconfont/` (BMC's "DPL Icon Font 3", 480+ glyphs) |
| Public Figma | https://www.figma.com/files/986665448061326997/project/33485219 (referenced; not opened — we worked from code) |
| Public docs | https://ux-helix.github.io/adapt-angular/ |
| Public icon font docs | https://ux-helix.github.io/dpl-iconfont/ |

---

## Products represented

ADAPT is **a single design system serving many BMC products**. The surface this
project recreates is the **Helix Application Shell** — the in-product
experience: top navigation bar, side menu, dashboards, tables, forms, modals,
and **HelixGPT** chat & alerts. This is the look any BMC Helix product
(ITSM, AIOps, ServiceOps, etc.) wears.

---

## Index

| File / folder | Purpose |
| --- | --- |
| `README.md` | This file — context, fundamentals, iconography, manifest |
| `SKILL.md` | Cross-compatible Claude Skill front-matter for use as a Claude Code skill |
| `colors_and_type.css` | All color + typography + spacing + shadow tokens (light/dark) |
| `fonts/` | DPL icon font (woff2/woff/ttf) + iconfont CSS |
| `assets/` | Logos and brand illustrations |
| `preview/` | Per-card HTML specimens shown in the **Design System** tab |
| `ui_kits/helix-app/` | Helix application shell UI kit (nav, sidebar, table, modal, HelixGPT) |

> **Open Sans** (the official ADAPT typeface) is loaded from Google Fonts.
> No font file substitution was needed — Open Sans is the same family BMC ships.

---

## CONTENT FUNDAMENTALS

ADAPT is enterprise-software copy: clear, brand-deferential, mildly formal but
warmer than typical IBM/Oracle voice. BMC consistently uses *"BMC's"* possessive
when referring to itself.

**Voice & tone**
- **Plain, direct, third-person** in marketing surfaces ("Adapt provides
  components and tools to help product teams work more efficiently").
- **Second-person ("you")** in in-product help text and developer docs
  ("Use this component when you need to…").
- **Avoids "we"** in product copy; "we" appears only in dev/contributor docs.
- **Sentence case** for body copy and most buttons. Display-style headers
  occasionally render in **ALL-CAPS** (e.g. `ADAPT`, `ADAPT-ANGULAR`,
  `ADAPT-CSS`) — these are brand names, not arbitrary headlines.
- **Confident & restrained.** No marketing exclamation marks, no superlatives.
  "Standardized color sets and usage guides" — not "Beautifully crafted".
- **Em dashes / colons** are used to chain a phrase: *"For designers — Get the
  files and assets you need to kickstart your designs."*
- **Numerals**, not spelled-out numbers ("5 reasons to use ADAPT").

**Tone examples** (verbatim from the codebase):
- Hero subhead: *"BMC's design system."*
- Hero body: *"Adapt provides components and tools to help product teams work
  more efficiently, and to make BMC applications more cohesive."*
- Section header: *"5 reasons to use ADAPT"*
- Button copy: *"Get started"*, *"View full release notes"*, *"Submit"*
- Resource card titles: *"For designers"*, *"For developers"*
- Release-notes phrasing: *"Added support for HelixGPT, Voice-to-Voice, Screen
  share, and DPL Icon Font 3."*

**Casing conventions**
- Brand product names: `ADAPT`, `BMC`, `RADAR`, `HelixGPT` (camel-G capital)
- Component names in copy: lowercase except at sentence start ("the carousel
  component", "Use the modal when…")
- Buttons: Sentence case (*"Get started"*, *"Sign in"*, *"Send invitation"*)

**Emoji**
- **None.** Across the entire codebase there is no emoji usage in product or
  marketing copy. Emoji are **off-brand** for ADAPT.

**Vibe**
- **Trusted enterprise software.** Calm, technical, slightly playful in its
  illustrations (gear/clock/card metaphor) but never casual in writing.

---

## VISUAL FOUNDATIONS

**Colors**
- **Brand primary** is `#4040d9` — a deep indigo / blue-violet. Used for
  primary buttons, links, focus accents.
- **Active** `#3759d8` is a slightly cooler companion blue used for selection,
  active states, links in body text (`--text-active-color`).
- **HelixGPT orange** `#f86e00` is the *one* warm accent in the system —
  reserved for AI-generated content & GenAI surfaces. Don't use it for
  generic CTAs.
- **State colors:** info `#389be1`, success `#11845b`, warning `#ffd200`,
  danger `#b2001e`. Each has `*-hover`, `*-pressed`, and `*-muted` (subtle
  tinted background) variants — see `colors_and_type.css`.
- **Neutrals** are a 12-step ramp from `#ffffff` → `#000000` (gray-100 …
  gray-1000) used for text, surfaces, borders.
- **Three themes ship**: `light` (default), `dark`, `accessible` (WCAG-AAA
  variant where `#826900` warning replaces yellow on white, etc.).

**Typography**
- **Open Sans** for everything — body, UI, headings. 400 / 600 / 700 weights.
- Body is **14px / 1.5**. Headings use 600 (semibold), display sizes up to 700.
- **Source Code Pro** for `<code>` / `<pre>`.
- No serif font. No display font.

**Backgrounds**
- The marketing site uses **flat brand-tinted SVG illustrations** with a
  characteristic isometric / tilted-card metaphor (gears, clocks, stacked
  cards). These illustrations have **no gradients, no photography, no
  hand-drawn texture** — clean vector with the indigo/orange palette.
- App surfaces are **flat solid color** — no patterns, no textures, no
  full-bleed photography. The login page is the one exception
  (`--login-background: linear-gradient(to bottom, #000 0%, #393b46 100%)`).
- **No grain, no noise, no glassmorphism.**

**Animation**
- Subtle, functional. ADAPT explicitly mentions in its release notes:
  *"the team re-imagined motion and microinteractions … the new animations
  make the interaction feel smoother and more natural."*
- Standard easing — `ease-out` / `ease-in-out`, **150–250ms** transitions for
  hovers, **300ms** for panel slides.
- **No bouncy / spring physics**, **no large fades**, **no parallax**.

**Hover & press states**
- Hover: **darker** version of the base color (`--color-primary-hover`,
  `#3006c2` for primary). On muted/secondary surfaces hover is a darker
  tint of the muted color, not opacity.
- Pressed: even darker (`--color-primary-pressed` `#4300d5`). No scale shrink.
- Disabled: 40-50% opacity OR `secondary-muted` swap; no full transparency.

**Borders**
- 1px solid, color `--gray-300` `#d5d6dd` (light) / `--gray-300` `#555868`
  (dark). Higher-emphasis borders use `--color-primary` or `--color-active`.

**Shadows / elevation**
- Four-level system, soft and tight (no big diffuse drop shadows).
  `shadow-1` for cards, `shadow-2` for menus, `shadow-3` for popovers,
  `shadow-4` for modals.
- Inner shadows are **not** part of the standard system.

**Corner radii**
- Default `--border-radius: 4px`. Buttons, inputs, cards all 4px.
- 2px for tight chips/badges. 8px for larger callout cards. **No fully-round
  corners except pills/avatars.**

**Cards**
- White surface (or `--bg-surface` in dark), 1px gray-300 border *or*
  `shadow-1` (rarely both), 4px radius. Header band is sometimes tinted
  `--color-primary` with white text (the "card-primary card-inverse"
  pattern).

**Layout**
- 12-column Bootstrap-style grid (ADAPT extends Bootstrap). Container max-
  width ~1200px, gutter 16px.
- Generous vertical rhythm in marketing pages (sections at 80–120px tall);
  dense in product surfaces (forms 8px gaps, table rows 32–40px).

**Transparency / blur**
- Used sparingly. Modal backdrops are `rgba(34,36,42,0.5)`; no `backdrop-
  filter: blur` on standard components.
- Disabled inputs use 50% opacity rather than tint changes.

**Imagery vibe**
- Cool, indigo-led palette. When photography appears (login splash) it's
  desaturated/cool toned. No warm/golden-hour stock.

---

## ICONOGRAPHY

- **Primary system: BMC's "DPL Icon Font 3" (`dpl-iconfont`)**, an icon font
  shipped as a peer of ADAPT itself
  (https://github.com/ux-helix/dpl-iconfont). It contains **480+ glyphs**
  encoded U+E600 → U+E7E0+. Source SVGs live in
  `libs/dpl-iconfont/src/lib/icons/uE6XX-{name}.svg`. Generated font files
  are copied into `fonts/` here.
- **Usage**: classes `dpl-icon-{name}` (e.g. `dpl-icon-search`,
  `dpl-icon-bell`, `dpl-icon-gear`). Icons are monochrome, inherit
  `currentColor`, optical-size'd to render cleanly at 16/20/24px.
- **Stroke / fill style**: mostly **filled** glyphs with `_o` outline
  variants (`circle` vs `circle_o`). Stroke weight roughly equivalent to
  Phosphor "Regular" or Lucide's default.
- **Brand illustrations** (e.g. `assets/send-email.svg`) are one-off inline
  SVGs and are NOT part of the icon font.
- **Logos**: `assets/adapt_logo.svg` and `assets/repository-{angular,css,
  iconfont}.svg`.
- **Emoji**: never used.
- **Unicode pseudo-icons**: not used. All icons go through DPL Icon Font.

If a glyph you need isn't in DPL Icon Font, fall back to **Lucide**
(closest stroke style) and flag the substitution. Do **not** invent SVG
icons.

---

## Caveats / substitutions
- **Open Sans** is loaded from Google Fonts (same family BMC ships) — no
  proprietary font swap needed.
- **Source Code Pro** for code blocks is a Google Fonts pick standing in
  for the unspecified mono in the BMC SCSS — flag if BMC mandates a
  specific monospace.
- The accessible theme is documented but not exposed as a switch in the
  UI kit demos.
- The Figma library is referenced but was not opened — all tokens come
  from the open-source SCSS.

