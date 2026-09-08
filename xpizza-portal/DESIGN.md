---
name: Sherpa Merchant Portal
description: A KDS-cued, sober operator's console for merchants — warm-dark by default, crisp near-white by day, precise in sapphire.
colors:
  board: "#0F0E0C"
  board-2: "#151310"
  panel: "#161512"
  card: "#1A1815"
  card-2: "#211F1B"
  line: "#2A2823"
  line-2: "#221F1B"
  ink: "#F2EEE7"
  mute: "#A8A197"
  mute-2: "#726B60"
  accent: "#5B8DEF"
  accent-2: "#4577DC"
  accent-ink: "#FFFFFF"
  gold: "#E3B54A"
  green: "#4FA65A"
  red: "#CE4B3A"
  amber: "#E8A23E"
typography:
  display:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "27px"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 750
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 750
    letterSpacing: "0.12em"
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

**North Star — "Basecamp Console."** A calm, precise instrument panel where a merchant runs their menu — the warmth of a kitchen pass with the trust of financial software. It reads as an operator's tool, not a marketing page: money-adjacent, so it must feel dependable before it feels expressive. The identity is **KDS-cued** — a warm near-black board with white/cream content on it — carried into a **sober** software register (neutral-forward, restraint over flourish). Brand lives in precise details, not decoration.

**Voice:** confident, quiet, exact. Spanish (es-HN). Elegance is a requirement, not a finish — but never at the cost of legibility or task speed.

**Anti-references:** generic AI-SaaS (purple-blue gradients, one acid-pop, everything centered, `rounded-lg` everywhere, side-stripe accent rails). Cream/editorial warmth in day mode (the day theme is deliberately *cool* near-white, not cozy cream).

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
- No `unsafe-inline` styles/scripts (strict CSP); no inline `style=` attributes (they're blocked and won't apply).
