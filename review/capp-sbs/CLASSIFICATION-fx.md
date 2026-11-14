# Functional SBS (2026-11-14, advisor slot): D-fixes re-shoot, G-A..C, rule 10, D4 mount sheet, «wake», C-1b

**What makes these functional:** every scene runs an in-page CHECK that throws on its defect, and a thrown check fails the run. The pixel/layout diff and the review page come on top. Runs use Chrome over CDP, one headless Chrome at a time, 0 unmapped requests.

| Bundle | Built from | Scenes |
|---|---|---|
| A | vclock tip 86d50a44 (signup, guestCardOnly, ratings, schedulingLive) | D1/D2/D3/D6, G-A/B/C, rule 10: 21 scenes, 28 renders |
| B | A + sdkPay | D4: 1 scene, 2 renders |
| N | the NATIVE target, A's flags | «wake»: 7 scenes, 13 renders |
| asm9b | d8256f73, A's flags | C-1b: 9 scenes, on branch `sbs/capp-c1b-fx` (scenes-c1.mjs + the favorites route) |

## Results
- **D1** (desk card meta = f1a's one line), **D2 + Codex P2**, **D3**, **D6**: PASS.
  - D2's rendered bounds were checked at 1280/1440/1680. The cells box sits inside the tools column at every width; below the toggle, full width, when it does not fit beside it. «Envío desde L 45» is on one line.
- **G-A** (cart sheet Subtotal · Envío · Total): PASS, before an address («según tu dirección», Total = subtotal) and priced (the quote's Envío and Total). It matches S7a frame 13's structure.
- **G-B** (the aside's notes row, right after the lines; the tap opens the checkout with `#f-notes` open and focused): PASS.
- **G-C** (the desk row Abierto ahora · Pickup · Menos de 30 min · Envío desde L 45, one line; the fee chip filters to the floor; the phone keeps v6's three): PASS.
- **RULE 10** with today's writer (`complete_writer_raw`, no marker): ZERO claims for a guest (Inicio, store, aside, cart sheet; desk and phone) and for a member (Inicio, store, cart sheet). PASS.
- **D4, the held sheet on MOUNT** (bundle B): PASS.
  - The setup: u_ana's SDK placement gets NO answer (the network fails the response; the fake server holds the attempt in flight); the record is re-bound to u_bea; then a reload.
  - Opening La Musa mounts its UI, and `sdkResume` resolves the live attempt ⇒ `held_other_account` ⇒ «Hay un pago de otra cuenta pendiente en este teléfono» / «Entrá con esa cuenta para terminarlo o cancelarlo.» appears with no place tap. Zero `placeSdkOrder` after the reload.
  - Text fit at 390: a balanced 2-line title, a 1-line body.
- **«wake» frames t = 0/300/600/900/1200 ms vs MOCKUP-capp-splash-animation A** (light + dark): every animation is paused and seeked to t on both pages.
  - Equal: the needle angle (−14° → −3.61° → −0.15° → 0°), the ring group's scale, the halo, the pivot, the mark (104 px, centred) and the colours.
  - Different: the ring PATH, so all 10 FAIL ⇒ **W1**.
- **«wake» controller absent** (capp-splash.js blocked; Codex P2): PASS. Full at +3.8 s; opacity 0 + hidden at +4.25 s; pointer-events none; the app booted underneath.
- **«wake» READY exit**: PASS. READY 144 ms ⇒ `.exit` at once ⇒ `.gone` 201 ms later (light and dark), well inside the 4 s cap.
- **C-1b** (asm9b): PASS for 9.4's row (before «Destacados», header, favorites in order, filled hearts), the in-place un-save (the card stays in the frozen row, no reflow), 9.1's member store heart (pressed, «Quitar de favoritos»; desk + phone), and the guest (no row, no read). FAIL for the first-visit pop-in ⇒ **C1b-P1**.

## The checks die on the old defects (negative control)
- The same checks were run against bundle A packaged at 827373d6 (before the D-fixes, rule 10 and G-C). Each FAILS at its defect:
  - D1: «Abierto · cierra 8:45 p.m. · Envío desde L 45»;
  - D2 (1280): «Envío desde L 45» breaks over 3 lines;
  - D3: a global `.opt` box;
  - D6: the failed image is left in the avatar;
  - G-C: only the 3 phone chips;
  - RULE 10: «Envío gratis» on Inicio.

## Defects
| # | Where | Defect | Rule |
|---|---|---|---|
| W1 | «wake» (native) | The overlay's `<path class="ring">` also matches the app's global spinner `.ring{…animation:spin .9s linear infinite}` (capp.css:616); `.csplash .ring` overrides only fill/stroke. The ring orbits the mark's top-left (rotation ±120°, up to 126 px off-centre) every 0.9 s instead of breathing in place. **Advisor ruling: scope the overlay's class names (a unique prefix) + a RED cell (the overlay's computed animation-name is the wake's own or none, never «spin») + a guard that the overlay's classes share no name with any other capp rule; after the slot, on asm10.** | 14 |
| C1b-P1 | C-1b first Inicio visit (asm9b) | The first Inicio paints before the member resolves (`S.fav` null ⇒ `paraVosOf` returns [] WITHOUT freezing). `favIdentity()` then sets `pvVisit = null` and reads after `setTimeout 0`; a read that lands before the next render freezes the visit gets the row INSERTED into the painted Inicio: 4–5 frames / 59–77 ms after the first card, «Destacados» 234 → 574 px (phone) and 342 → 645 px (desk). CLS reads 0 (a re-render, new nodes), so the geometry is the evidence. Control: the same visit with a 300 ms read never inserts. **Proposal: freeze the visit once the Inicio has painted, whatever the book's state (an unresolved member ⇒ the visit's row is empty), + a cell whose read lands BEFORE the post-identity render.** | 7 |
| C1b-P2 | C-1b «Para vos» card meta (phone + desk) | It wraps with a dangling «·». Phone: «★ 4,8 (124) · ● Abierto · cierra 8:45 p.m. ·» / «Envío gratis · Pediste el 11 nov»; La Musa's line is clipped. Desk: three lines. 9.4 draws ONE line «★ 4,8 (124) · ● Abierto · Pediste el 28 oct» (no closing time, no Envío). D1's desk-meta fix (asm10) may overlap on the desk; re-shoot after the asm9b × asm10 merge. | 16b / 14 |
| C1b-P3 | «Para vos» header | 9.4 draws the «›» see-all button (the desk: «Ver todo», as «Destacados» has); real: none. Minor. | 14 |

## Classified (not defects)
- **Harness:** the focus ring on a sheet's close / primary button after a programmatic `.click()`.
- **Harness:** `addTwo` adds one dish (the first tap re-renders, so the second button detaches). Harmless to these checks.
- **Fixture gap:** the logos are never served (storage `sbs-fixture-assets/img/*-logo.*` 404s in every scene), so every store shows the initials plate. On asm9b (pre-D6) the plates are blank circles; the D6 fix on asm10 draws the initials.
- **Branch state:** on asm9b, «Envío gratis» on the member's cards and filter is shown under the marked promo (rule 10's gate is on asm10). Fixture photos and data differ from the mockups.
- **Deferred by ruling:** «Platos populares» (dish stats); D4/D5 of the asm9 list.
- **Known (rule 20, KNOWN_RED on this branch):** the member checkout's `last_tip.json?auth=` read is unmapped. The swap is on asm9b, so the member-checkout scene runs as a guest here.
