# SBS asm9 (2026-11-13) — capp tip dc0b6507, bundles A (signup,guestCardOnly,ratings,schedulingLive) and B (+ sdkPay)

Runs:
- `--set main`: 41 renders.
- `--set c1`: 13 renders, 0 unmapped.
- `--set s2 --only C3r-dot-390`.
- `D4-heldsheet-sdk-390`: NOT completed, see the end.

Review: real | mock pairs downscaled per scene (the review page is index.html in each run dir). Rules 16b (text fit) and 16c (density) were checked on every reviewed pair.

## Defects (to fix, each a small capp item)
| # | scene | defect | rule |
|---|---|---|---|
| D1 | C-6b home 1440 | the open card's meta wraps over 3 lines: «Abierto» / «· cierra 8:45 p.m. · Envío desde L 45» (a «·» dangling at the line start) / the pill. The frame draws one line «Abierto · Envío desde L 45» | 16b |
| D2 | C-6c store 1440 | the desk fee cell «Envío desde L 45 ⓘ» breaks over 4 lines («Envío / desde L ⓘ / 45 / según tu dirección»); the frame draws «Envío desde L 45» on 2 | 16b |
| D3 | C-2 rate phone 390 | «· opcional, lo lee el restaurante» renders inside its own bordered box ABOVE the textarea (a stray second field), instead of beside the «COMENTARIO» label; the sheet's footer note is then clipped | 16b / 16c |
| D4 | C-2 rate phone 390 | the subtitle lacks the frame's time («X. Pizza · Orden #4821 · hoy 7:48 p. m.»); real: «X Pizza · Orden #4821» | rule 14 |
| D5 | C-5 help phone 390 | the subtitle lacks the frame's status and window («· va en camino · llega 7:40–7:55 p. m.») | rule 14 |
| D6 | every store page | a logo that fails to load shows the browser's broken-image glyph + the alt text «X Pizza» overflowing the avatar; it should fall back to the initials plate (the cards already render an empty plate) | robustness / 16b |

## Classified (not defects)
- **Harness artefact:** a focus ring on the sheets' heading / close button (C-2, C-5, the dish sheet). Programmatic focus after a JS `.click()` (no real pointer) shows `:focus-visible` in Chrome; a finger tap does not.
- **Deferred by ruling:**
  - dish badges «Más pedido» / «97 % lo recomienda» / «#1 más pedido» (C-4, the 3a publish);
  - «Lo más pedido» / «Platos populares» rows (dish stats);
  - 9.4 «Para vos» (C-1b);
  - C-5's four reasons (X-1);
  - the C-2 rider name (3a).
- **Fixture data:** the store count (2, not 4); the photos vs the mockups' art; the address «Tu ubicación» vs «Col. Trejo»; the store address absent from the facts; «X Pizza» vs «X. Pizza».
- **WCAG-exempt:** the «−» at qty 1 (1.97) and the sold-out «+» (2.59) are DISABLED controls.
- **Expected C-1a:** the heart / share / search group on every store (9.1).
- **Pre-existing (not this range), to classify with the owner:**
  - the phone cart sheet shows Subtotal only (the S7a frame-13 capture also draws Envío + «Creá tu cuenta y tu envío es gratis» + Total);
  - the desk store aside lacks «Agregar notas al restaurante»;
  - the home filters lack a 4th «Envío desde L 45» chip.

## Matches (the new slices)
- **C-1a 9.1 phone:** «★ 4,8 (124) · Abierto · cierra 8:45 p.m.» on ONE line at 390 (16b OK); the heart / share / search in the frame's place (a guest: the outline heart); «Nuevo en Sherpa» on La Musa; the member's heart slot reserved (invisible, no shift).
- **C-1a 9.1 desk / 9.4 home:** the rating as the first fact / meta, matching the frames; 9.4's «Para vos» row absent (C-1b).
- **C-3r frame 13:** «Cambió el precio de Margherita: antes L 250, ahora L 299.» with the struck L 500 → L 598, exact.
- **C-3r G4:** the phone «Pedidos» tab carries the 10 px dot with an active order, light and dark.
- **Unmapped requests (main run):** the 2 were exactly the rule-20 read (`…/last_tip.json?auth=` on the member checkout) — the getMyLastTip swap removes it.

## Not completed
- **D4-heldsheet-sdk-390:** the «under review» SDK attempt is settled, so the mount sheet does not fire, and after the reload the order screen owns the app, so the place-time path cannot reach a store.
  - Needs a fixture-level live (network-unknown) placement.
  - The copy itself is pinned by HELDCOPY-sdk / -sdk-place, and its title (52 chars) and body (50) are shorter than the SBS-checked legacy sheet's (59 / 43).
- **The «wake» animation:** no scene yet. It needs the NATIVE bundle and a timed capture vs MOCKUP-capp-splash-animation; queued with the Codex P2 fix.
