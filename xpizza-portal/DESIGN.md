---
name: Sherpa Merchant Portal
description: A bold-editorial merchant OS — stark white, oversized display type, and a decisive green; confident and consumer-grade, with a black dark variant. Frontmatter carries the light default.
colors:
  board: "#FFFFFF"
  board-2: "#F6F6F2"
  panel: "#FFFFFF"
  card: "#FFFFFF"
  card-2: "#F6F6F2"
  line: "#E7E7E1"
  line-2: "#F0F0EB"
  ink: "#0A0A0B"
  mute: "#6C6C70"
  mute-2: "#6E6E72"
  accent: "#0A6E3E"
  accent-2: "#095C34"
  accent-ink: "#FFFFFF"
  accent-line: "#BEE6CE"
  gold: "#8A6A12"
  gold-soft: "#FBF4E1"
  green: "#0E9F5B"
  red: "#D23425"
  amber: "#8A5200"
typography:
  display:
    fontFamily: "Archivo, Söhne, Helvetica Neue, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.045em"
  title:
    fontFamily: "Archivo, Söhne, Helvetica Neue, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 800
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Söhne, Helvetica Neue, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Söhne, Helvetica Neue, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 800
    letterSpacing: "0.15em"
rounded:
  sm: "9px"
  md: "12px"
  lg: "16px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "11px"
  md: "16px"
  lg: "20px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.card}"
    rounded: "{rounded.sm}"
    padding: "9px 15px"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "9px 15px"
  nav-item:
    textColor: "{colors.mute}"
    rounded: "{rounded.sm}"
    padding: "9px 11px"
  nav-item-active:
    backgroundColor: "{colors.card}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  input:
    backgroundColor: "{colors.board-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "11px 12px"
  count-pill:
    backgroundColor: "{colors.board-2}"
    textColor: "{colors.mute}"
    rounded: "{rounded.pill}"
    padding: "0 7px"
---

# Design System: Sherpa Merchant Portal

## Overview

**North Star — "Bold Editorial."** A confident, consumer-grade merchant OS: a stark white ground, oversized editorial display type, and a decisive green. The boldness lives in **typography, contrast, and space — never in heavy black boxes.** Big display headings, heavy tab labels with a thick green active underline, generous rhythm, hairline structure, food treated as first-class imagery. It should feel like a product a merchant is proud to run their business on — closer to UberEats-Merchant confidence than a bank dashboard. **Owner directive (2026-09-08): explicitly NOT financial-software sober — "make it look like a billion dollars."** (This replaces the earlier "Basecamp Console / sober console" North Star, which the owner found read as financial software.)

**Voice:** confident, direct, decisive. Spanish (es-HN). Elegance is as important as functionality — carried by the type and the white space, not decoration.

**Two themes, same world:** light is the default (stark white, near-black ink `#0A0A0B`, decisive green `#0E9F5B`). The dark variant is a true black base (`board #0B0B0C`) with white type and a *luminous* green (`#3FD98A`) — UberEats-Merchant-black energy, same bold-editorial DNA.

**Anti-references:** financial-software sobriety (dense neutral greys, timid hairlines, a cool blue/sapphire accent, small type — the register this design deliberately left behind); generic AI-SaaS (purple-blue gradients, one acid-pop, everything centered); and **big black slabs** — solid-black bars/fills standing in for structure. Confidence comes from type and green, not black boxes.

## Colors

A **dual-theme** system, both driven by the same semantic tokens; the frontmatter carries the **default night** values.

- **Night (default, the KDS identity):** a warm near-black board (`board #0F0E0C`), cream ink (`ink #F2EEE7`), warm greys for mute (`mute #A8A197`, `mute-2 #726B60`).
- **Day (cool, crisp):** pure-white ground (`#FFFFFF`), white cards, cool hairlines (`#E6E9EE`), near-black cool ink (`#181B20`), cool greys; accent deepens to `#2D5FD0` for contrast on white.

**Accent — sapphire (`#5B8DEF` night / `#2D5FD0` day):** used *sparingly* and never as a status — active tab underline, selected item, links, focus, small highlights. It pairs with gold (the SAR fiscal seal) as the only two brand hues.

**Semantic status (separate from the accent):** green `#4FA65A` (available / new), red `#CE4B3A` (delete / removed), amber `#E8A23E` (large-change warning), gold `#E3B54A` (fiscal). Each has a `-soft` fill and `-line` border variant. Status hues are reserved — never reused as the accent.

**Contrast is normative, not optional:** all functional text must clear **WCAG AA (4.5:1)** on its ground. `mute-2` on `panel` and white on `accent` are known to fall short today and must be corrected toward AA.

## Typography

**Hanken Grotesk** throughout (self-hosted/CDN with a `system-ui` fallback). A tight scale: `display` 27px/750/-0.03em, `title` 16px/750, `body` 14px/1.45, `label` 11px uppercase +0.12em. Prices and any aligned numerals use `font-variant-numeric: tabular-nums`. **No functional text below 11px** (the 10px section label is a defect to lift).

## Layout

- **Master shell:** a fixed **238px sidebar** (`panel`, sticky, full height) + fluid main; content `max-width: 1120px`.
- **Master–detail:** a **246px rail** + fluid detail, `gap: 24px`.
- **Responsive (must fix):** below 920px the layout collapses to one column — but the sidebar currently `display:none`s, hiding the switcher and logout. Narrow viewports must keep those controls (a top bar or drawer). Touch targets ≥ 44px.

## Elevation & Depth

Low, warm elevation. `--shadow: 0 8px 24px -18px rgba(0,0,0,.85)` on cards; `--shadow-lg: 0 40px 90px -34px rgba(0,0,0,.9)` on overlays (login card, dropdowns). **Commit to one edge treatment per surface:** a hairline `line` border *or* a soft shadow — the current 1px-border-plus-wide-shadow doubling on cards should resolve to one. Depth comes from the board→panel→card tonal step, not heavy shadows.

## Shapes

Rounded, calm corners: `sm 9px` (buttons, inputs, nav), `md 12px` (switcher, dropdown), `lg 16px` (cards, login card), `pill 999px` (counts), `50%` (avatar). 1px hairlines in `line`/`line-2`. No sharp corners, no heavy strokes.

## Components

- **button-primary** — the sober high-contrast move: `ink` background, `card` text (inverts per theme: near-black on day, cream on night). This is the "Save/Publish" register, à la Uber's black button. The accent is *not* a button fill.
- **button-secondary / ghost** — hairline border on `card`; hover lifts the border to `mute-2`.
- **nav-item / active** — muted by default; active is a subtle `card`/tint fill with accent text. Active state must not use a thick side-stripe (a generated-UI tell).
- **card** — `card` bg, hairline `line`, `lg` radius, soft shadow.
- **input** — `board-2` fill, hairline; **focus must show a visible `:focus-visible` ring**, not merely a border-color change (current inputs remove the outline — an accessibility gap).
- **switcher + dropdown** — the restaurant selector; the dropdown is built with `createElement`/`textContent` (no HTML sink) and needs `aria-expanded`/keyboard support.
- **count-pill, avatar** — quiet neutral chips.

**Motion:** subtle, functional — 0.15–0.34s ease on background/border/opacity/transform; theme cross-fades on the ground. Never animate layout properties (width/height). Respect `prefers-reduced-motion`.

## Do's and Don'ts

**Do**
- Keep the accent scarce and status-free; let restraint carry the craft.
- Build **exactly to the approved mockup** — every element realized and functional, pixel and behavior; a fidelity pass (impeccable audit / finish-reviewer) checks the build against this file and the mock.
- Clear **WCAG AA** on all functional text; give every interactive element a visible focus state; keep the sidebar controls reachable on mobile.
- Use `tabular-nums` for prices; render all server-supplied strings via `textContent` (never `innerHTML`) — this is a money surface that must not execute its input.
- Style both themes with equal care; day is cool near-white, not cream.

**Don't**
- No thick colored side-stripe on the active/selected item (the most recognizable AI-UI tell — replace with a quieter selected state).
- No hairline-border *and* wide diffuse shadow on the same surface — pick one.
- No functional text under 11px; no `L0`/`LNaN` — an unpriced value reads "Sin precio".
- No purple-blue gradients, no acid-pop accents, no everything-centered generic-SaaS defaults.
- No `unsafe-inline` styles/scripts (strict CSP); no inline `style=` attributes (they're blocked and won't apply). This includes `style="background:${…}"` on thumbnails/avatars — bind fills through a class map or a CSP-nonce'd rule, never inline.

## Editor write path — the money moment

Editing a price publishes to a live catalog that charges real customers through a SAR factura, so the review-and-publish flow is the most consequential surface in the portal and is designed with the most care.

- **Review is a diff, read as before → after.** Each price change is one row: item name + section, the *was* price struck through in `mute`, an arrow, and the *now* price in `ink` at a heavier weight — all `tabular-nums`. A delta chip (`+%` amber / `−%` green) sits under the name. Never a names-blob; never a count.
- **A large change looks large.** A price swing over 50% (or a zero/new-priced value) carries the **amber** `-soft`/`-line` frame and a "Cambio grande" flag with an alert glyph. Amber is reserved for this — new/removed rows use green/red, never amber. The one row that most needs attention must never render as an ordinary row.
- **The acknowledgement echoes an exact set.** The confirmation replays the precise `{key, surface}` set the server flagged — the same objects, not a re-derived list, not a boolean. It is captured from the server response and sent back verbatim.
- **Fiscal is a per-merchant gold seal, conditional.** For a platform-factura merchant (X. Pizza only), a real fiscal price change raises the **SAR attestation seal**: the gold badge, a plain-language statement, each price listed old→new, and one "Autorizo" checkbox that attests to *that exact set* on the tax document. It gates publish and doubles as the large-change acknowledgement. It never appears for a non-fiscal merchant, and never on a change that touches no fiscal price (a pure "86" toggle is instant and out of this flow).
- **Publish has real states, not an optimistic toast.** In-flight (spinner + "Publicando…"), then one of: a **durable success receipt** (green check, the new version id, a route into Historial with rollback — it stays until dismissed), or a **first-class conflict panel** for `stale_edit` (draft moved), `edit_superseded` (reviewed against stale state), and `store_unavailable` (retryable) — each an icon + a named problem + a recovery action, never a generic error.
- **Owner-only today.** Only owners reach the portal, so `not_owner` is a server-side belt, not a designed screen. If a can-edit-can't-publish role is introduced later, it earns its own disabled-publish-with-reason state then.
- **A zero price cannot publish.** `≤ 0` renders "Sin precio", flags the row, and disables publish.

## Folded craft floor (the corrected bar, above the first mock)

These were drifts in the first editor mock, now corrected and normative:

- **The shell never vanishes on mobile.** Below 920px the desktop sidebar hides but a sticky top bar keeps the restaurant switcher, view nav, and account/theme reachable; no horizontal overflow; touch targets ≥ 44px. (The original mock's media query preceded its base rule and silently lost the cascade — order matters.)
- **Visible focus everywhere.** A `:focus-visible` ring (`--focus`: a 2px offset accent halo) on every interactive element; nav items and toggles are real focusable controls, not `div onclick`.
- **Themed browser surfaces.** Scrollbar, `::selection`, and `caret-color` are drawn from the palette — the cheap tell that a page was built, not assembled.
- **Motion respects `prefers-reduced-motion`** and never animates layout properties (width/height/max-height); depth is one edge treatment per surface, not border + wide shadow.
- **All functional text ≥ 11px**; `mute-2` on white is corrected to clear WCAG AA.
