# Capture plan — driver earnings slice (one Chrome pass, 9 scenes)

_2f, 2026-10-31. Pre-staged so the Chrome window is pure execution (advisor ruling). Tip to capture: **48bf138e** (ganancias) for #31/#32; the 7 re-verify scenes re-captured at the same tip (regen-at-exact-tip rule). NO Chrome/CDP launches while writing this — only `node --check` on the script + the fixture-sanity test in `ganancias.test.js`._

## Scope — all 9 rows in one pass
| # | scene | prototype id | app render | status before this pass |
|---|---|---|---|---|
| 31 | ganancias (Hoy) | `S.ganancias` | `renderGanancias('hoy')` | BUILT 48bf138e — NEW capture |
| 32 | gananciasSemana | `S.gananciasSemana` | `renderGanancias('semana')` | BUILT 48bf138e — NEW capture |
| 6 | practica | `S.practica` (base `disponible`) | companion practica demo | VISUAL-ACCEPTED — re-capture at tip |
| 23 | apOferta | `S.apOferta` | onshift board (offer branch) | VISUAL-ACCEPTED — re-capture at tip |
| 25 | apParada1 | `S.apParada1` | onshift board (stacked, stop 1) | VISUAL-ACCEPTED — re-capture at tip |
| 26 | apDetalle2 | `S.apDetalle2` | onshift board (detail, stop 2) | VISUAL-ACCEPTED — re-capture at tip |
| 27 | apAvance | `S.apAvance` | interlude overlay | VISUAL-ACCEPTED — re-capture at tip |
| 28 | apParada2 | `S.apParada2` | onshift board (stacked, stop 2) | VISUAL-ACCEPTED — re-capture at tip |
| 29 | apCancelada | `S.apCancelada` | onshift board (cancel banner) | VISUAL-ACCEPTED — re-capture at tip |

## Viewport & theme
- **One viewport:** 390×860 CSS px, `--force-device-scale-factor=2`, `--virtual-time-budget=4500` (the re-verify standard; matches the prototype `.device` 390-wide frame).
- **Light only.** The driver app ships light-only — there are NO `[data-theme="dark"]` / `prefers-color-scheme` rules in index.html (the GANANCIAS-CSS block is light-only, like CUENTA-CARD). The prototype's reference for the diff is its LIGHT theme (`.device` tokens, not `[data-theme="dark"]`). A dark capture of the app would be byte-identical to the light one (no dark CSS), so "dark" is N/A for the app surface; capture light, and if a dark pass is run it is only to PROVE the screen does not shift (same pixels), not to diff against the proto's dark.

## State fixtures

### #31 ganancias (Hoy) — `renderGanancias('hoy')`
Seed so the app reproduces the prototype's displayed numbers exactly (clean side-by-side; only the date-derived text legitimately differs):
- `PAGOS_LIVE` is a const (`false`) — the capture harness renders `renderGanancias` directly into `#screen-ganancias` (it does not depend on the tab gate), so no source edit is needed.
- `driverRateEntries = { r: { cents: 7000, effective_from: <todayMidnight − 1 day> } }` → rate L70.
- `computeShiftCash` stub → `{ cashOwed: 1430 }` (proto «L 1,430»).
- `allOrders` = 6 delivered orders for uid `drv`, `delivered_at` today, matching the proto list rows (time · colonia · brand), newest first:
  1. 8:52 · `address_area:"Bo. Río de Piedras"` · `restaurant_display_name:"La Musa"`
  2. 8:31 · `Col. Universidad` · `X. Pizza`
  3. 8:05 · `Res. Las Lomas` · `X. Pizza`
  4. 7:44 · `Col. Trejo` · `X. Pizza`
  5. 7:52 · `Res. Los Castaños` · `La Musa`
  6. 7:21 · `Bo. Suyapa` · `X. Pizza`
  (All `delivered_by_driver_uid:"drv"`, `delivered_at ≥ todayMidnight`. `readyTimeHHMM` renders UTC-6 — seed the epoch so it prints the listed HH:MM.)
- **Expected render:** «Ganado hoy» `L 420` (6×7000¢), sub «6 entregas × L 70 · se paga aparte del efectivo», cash row `L 1,430`, 6 list rows with `+ L 70`. Verified by `ganancias.test.js` (no Chrome).

### #32 gananciasSemana — `renderGanancias('semana')`
- `driverRateEntries = { r: { cents: 7000, effective_from: <weekStart − 1 day> } }`.
- `allOrders` = 27 delivered orders for `drv` across the current week, bucketed to the prototype's per-day counts: **Lun 6 · Mar 3 · Mié 5 · Jue 4 · Vie 3 · Sáb 6 · Dom 0** (each at `weekStart + dayOffset*DAY + 10h..`).
- **Expected render:** «Ganado esta semana» `L 1,890` (27×7000¢), sub «27 entregas · {current-week range}» (the range text is the real current week, NOT the proto's hardcoded «lun 13 a dom 19» — classify that diff as *data: date, expected*), bars `L 420 / L 210 / L 350 / L 280 / L 210 / L 420 / —`, tariff line. Verified by `ganancias.test.js` (no Chrome).

### #6 + the 6 ap* scenes (re-verify)
Reuse the EXISTING scene harness (`scratchpad/gen-harness.js` + `proto-iso-scene.js`) that produced their VISUAL-ACCEPTED captures — same scene params, re-run against the worktree at 48bf138e. No new fixtures; the state is encoded in the harness scene params (`?scene=apOferta` etc.) and the practica base (`disponible`). This plan only ADDS #31/#32; the 7 ride the same pass for freshness at the tip.

## Capture script
`capture-earnings.mjs` (committed, this dir). For #31/#32 it: lifts the main `<style>` + the `SLICE3:GANANCIAS-CSS` block + `renderGanancias`/`gananciasWeekStartMs` + `escapeHtml`/`CUADRE_WD` + the real `shiftDeliveries`/`coloniaOf`/`brandLabel`/`readyTimeHHMM` from index.html, loads `pay-rate.js` as `window.PayRate` (the classic-script path), seeds the fixture above, renders into `#screen-ganancias`, and (under `--shoot`, NOT now) drives chrome-headless-shell to screenshot at 390×860@2x + dumps `getComputedStyle` for the diff targets below. Without `--shoot` it only builds + writes the harness HTML (safe, no Chrome). For the 7 ap* scenes it shells the existing gen-harness with each scene param. `node --check capture-earnings.mjs` must pass (static syntax check is the only gate run now).

## Computed-style diff list (per scene, app vs prototype at equal specificity)
Dump `getComputedStyle` for these and compare to the prototype element's computed style; classify every diff as **MATCH / approved-deviation(cite) / data / BUG(fix+re-capture)**:
- **gn-seg / proto .pseg** (toggle): `background, border-radius, padding, gap`; each `span`: `flex, font-weight, font-size, padding, border-radius, color`; `.on`: `background, color, box-shadow`.
- **gn-big / proto .big.ok** (amount): `font-family, font-weight, font-size, letter-spacing, line-height, color, font-variant-numeric`; `.gn-cur`/.cur: `font-size, color, font-weight, vertical-align, margin-right, line-height`.
- **gn-lbl / proto .lbl**: `font-size, font-weight, letter-spacing, text-transform, color`.
- **gn-sub / proto .sub**: `font-size, color`.
- **gn-card / proto .card**: `background, border-radius, box-shadow, padding`; **gn-flat**: `background, box-shadow, padding`.
- **gn-row + gn-ic / proto .row + .ic**: row `display, gap, align-items, padding`; ic `width, height, border-radius, background, color`; `.gn-rt/.gn-rd/.gn-rv` vs `.t/.d/.v` (`font-*`, `color`).
- **gn-drow + gn-dic / proto .row + .ic.ok** (list): `border-top`, ic `background(okwash), color(ok)`, `.gn-dt` (weight 600), `.gn-dv` (fd, ok color).
- **gn-bars / proto .bars** (Semana): `.gn-bar` grid `grid-template-columns:34px 1fr 58px, gap, align-items`; `.gn-blb` (weight, color); `.gn-btr` (height, border-radius, background) + `i` (background ok, height, border-radius); `.gn-bv` (fd, tabular-nums).
- **gn-hdr / proto hdr**: title `font-family(Red Hat Display), font-weight, font-size, letter-spacing, color`; header `padding`.
- **O6 tab bar** (`.tabs`): already APPROVED on the other tab-root screens; confirm it mounts on #screen-ganancias with `Ganancias` active and the same computed style.

## Gotchas (carried from the re-verify)
- `'Plus Jakarta Sans'` is an @font-face ALIAS: weight ≥501 → Red Hat **Display**, ≤500 → Red Hat **Text**. The computed `font-family` NAME is identical; verify the RENDERED face by weight (see [[driver-font-alias-redhat]]).
- A full computed-style diff beats an overlay; strip the proto's `[data-n]` marker chrome before diffing.
- Re-capture on the clean hand-back tip (48bf138e), never a dirty tree.
