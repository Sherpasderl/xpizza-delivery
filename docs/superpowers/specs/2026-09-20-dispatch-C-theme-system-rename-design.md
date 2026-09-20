# Dispatch C — Pastel theme system, contrast/legibility, dead-CSS cleanup, rename

**Status:** DESIGN (from `/impeccable critique` P2 + nits + approved mockup) → relay to auditor for **codex gate** → owner deploy.
**Date:** 2026-09-20
**Base:** verify `origin/main` directly before building. File: `xpizza-dispatch/index.html`. Own worktree.
**Fidelity target — EXACT:** the approved mockup **https://claude.ai/artifact/FhdBztp7Uce9NN5uUgQP5g**. Reproduce its token system and both themes verbatim.
**Money-adjacency:** the theme/contrast/dead-CSS/rename work is NOT money-adjacent (presentation only). **One money-adjacent carve-out:** replacing the reconciliation `prompt()` (below) touches the refund/abandon note path → that piece is **money-adjacent, gate accordingly** ([[codex-gate-money-adjacent.md]]); if it complicates the gate, split it into its own relay. Everything is still a **full codex gate**.

## Motivation
- **P2** — muted labels fail AA: `--text-dim:#64748b` on `#232b39` is ~3.0:1 (detector-confirmed 9×) on 10–12px order codes, cash labels, timeline times, `.dm` meta.
- **P2 volume** — 29 combined 10–10.5px functional micro-labels below the 11px floor.
- **Nits** — dead CSS `.order-card`/`.driver-card`/`.sidebar`/`.layout` (~:528–922, zero markup uses them; stale `calc(100vh - 52px)` vs the 60px header); undefined `--success-hover` (used ~:404, hover no-ops); native `prompt()` for the reconciliation refund note (~:4231); off-center KPI cluster.
- **Direction** — the board must adopt the mockup's pastel theme system with a persisted light/dark toggle and the "Despacho" name.

## Goal
Ship the mockup's exact visual system: a **tokenized pastel palette** with two themes, all AA-clean, drawn line icons, themed browser surfaces, and the "Despacho" rename — while cleaning the contrast/dead-CSS/undefined-var debt the critique found.

## Scope (all in `xpizza-dispatch/index.html`, presentation only)
1. **Tokenize the palette to the mockup's system** — a `:root` (dark) + `:root[data-theme="light"]` set: surfaces, borders, text (3 tiers), one lilac accent, muted semantic green/blue/amber/red, chip tiers, button tokens, badge fg, map tokens, scrim/overlay/avatar/toast/tip, scrollbar/selection, focus ring, and the two-layer background wash. **Use the mockup's exact values** (dark = the original warmed slate ground + lilac accent; light = cool porcelain + periwinkle/lilac wash — **not cream/peach**, owner rejected warm cream twice). Replace hardcoded colors throughout the board CSS with these tokens.
2. **Theme toggle** — a topbar sun/moon control that sets `data-theme` on the root and persists to `localStorage` (wrapped in try/catch; render correctly with no stored value). Default dark.
3. **Contrast fixes (fold the critique P2 in)** — the muted-text tier lands ≥4.5:1 on its surface (tint from the surface hue, never flat gray); every functional label ≥11px (raise the 10–10.5px ones). Verify computed contrast, not intent.
4. **Icons + browser surfaces** — drawn single-stroke line icons (no emoji — [[no-cheap-emoji-in-form-chrome]]); themed selection, focus ring, scrollbars, and tabular numerals, per the mockup.
5. **Cleanup** — delete the dead `.order-card`/`.driver-card`/`.sidebar`/`.layout` blocks (confirm zero live markup references first); define or remove `--success-hover`; center the KPI cluster.
6. **Reconciliation note (money-adjacent carve-out)** — replace the native `prompt()` (~:4231) with a styled, keyboard-operable in-board field; **the refund/abandon value + server call it feeds are byte-identical** — only the input surface changes. Gate this as money-adjacent or split out.
7. **Rename** — "Torre de Control" → **"Despacho"** in the `<title>`, topbar, and nav (owner-approved; alts Central / Centro de Despacho if owner prefers). Customer address strings containing "Torre …" are data, untouched.

## Invariants (no-regression)
- **Pure presentation** — no data, state, assignment, cancel, or write path changes (except the reconciliation input *surface* in item 6, whose fed value/logic is unchanged).
- **Deleting dead CSS changes nothing rendered** — prove the four blocks are unreferenced (grep every class against live markup) before removal.
- **Every theme token defined in both themes** — no color defined only in one theme; `body` paints an explicit token background.
- **AA everywhere** — no functional text below 4.5:1 (large ≥3:1) in either theme; no label below 11px.
- **Brand-agnostic** — no brand literal; shared file, both brands.
- **Fidelity** — both themes match the mockup pixel-for-token.

## Gate focus (codex, on the build diff)
- Contrast: sample the muted-text tier and small labels in both themes — all ≥4.5:1 (list the pairs).
- Dead-CSS removal is provably unreferenced (no live class match); nothing else lost.
- `--success-hover` resolved; no remaining undefined `var(--…)`.
- Theme toggle persists and both themes are complete (no unstyled/borrowed-theme elements); localStorage access guarded.
- Reconciliation note: the value passed to the refund/abandon call is byte-identical to today; only the input surface changed (money-adjacent scrutiny).
- Visual fidelity to the mockup.

## Test plan
- Toggle dark↔light: every surface re-themes cleanly; reload keeps the choice; private-window/no-storage renders correctly.
- Contrast audit both themes (order codes, cash labels, timeline, `.dm`, chips) — all ≥4.5:1.
- Grep the four dead classes against markup → zero refs; remove; board renders identically.
- Reconciliation refund/abandon still produces the same server request with the note (unchanged), now via the styled field.
- Rename shows "Despacho" everywhere the app names itself; customer "Torre …" addresses intact.
- Side-by-side vs mockup, both themes.

## If APPROVED → deploy (owner)
`git fetch` + confirm `origin/main`. Dispatch Netlify `xpizzadispatch` git-CD (explicit `--site …778` if CLI). No functions/rules (unless the reconciliation carve-out is split and any server piece is involved — it should not be). Verify both themes against the mockup.
