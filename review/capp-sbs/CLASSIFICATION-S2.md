# S2 side-by-sides: classification (slot run 2026-11-09)

Run: `node review/capp-sbs/sbs.mjs --set s2 --pkg <bundle> --out <dir>`. The bundle is packaged at the tip with `--target web --env production --flags signup,guestCardOnly,ratings,schedulingLive,sdkPay`.

Targets:
- Checkout: MOCKUP-capp-S2-sdk-checkout.html (owner-approved v7).
- Adjustment: MOCKUP-capp-S2-adjustment.html (owner-approved r3).

The SBS method is (A), approved by the advisor on 11-09.

**Final run**: bundle @22fc012f, 34 renders (17 scenes × light/dark), 0 unmapped requests. Frames 2, 4b, 6 and 7 come from the re-run after a scroll fix to the mockup clip. Numbers are in `results.json`. Diff is the % of pixels whose RGB distance is over 48. Layout is the same with text and images masked.

## Injections (every frame states its own)

| tag | what | where |
|---|---|---|
| NATIVE | `capp-runtime.js` is served with `"mode":"native"`. The bundle already carries the sdkPay flag; the patch refuses one without it. | sbs.mjs, per page (`sc.native`) |
| STAND-IN | The stand-in pay binding: the bundle's own strict `CappPaySdk.createPaySdk` around a raw binding, plus a field host that draws the mockup's own `<input>` markup. Frame 3 only. | standin-paysdk.mjs (pre-boot) |
| GEO | A device position for the delivery pin. | sbs.mjs (`sc.geo`), every S2 scene |
| directory_endpoint | The standing ruling (A) of 11-02, the same as every capp SBS. | sbs.mjs server |

**Fixtures:**
- Card availability (frame 7) comes from the server's `sdkPayStatus` fixture, not from the binding.
- The fixture bodies come from the strict fakes (`test/fake-sdk-checkout.mjs`, `test/fake-sdk-pay.mjs`).
- The order_tracking node comes from the real writer (`buildCreateOrderUpdates`).
- quoteOrder composes the real handler pieces, including the **real `issueQuote`**. Its unsigned fallback gives `net_total_cents`. The fixture used to drop it, which printed «Total L NaN»; that was a harness defect, fixed in this run.
- `restaurants/{rid}/public.json` is served as `null`: no prep stats written, which is a real production state.

**Harness normalisations (mockup side only; the app's CSS is unchanged):**
- The device bezel and the drawn OS status bar are removed.
- The mockups' fixed 44-px top inset (`.mk .flow .flowbar` padding, `.mk .order-map .ovl` top) is set to 0. The app gets that inset from `env(safe-area-inset-top)`, which is 0 in desktop Chrome.
- Width transitions and smooth scrolling are turned off before the clip.

The isolation guard is `customer-app/capp-guards.test.mjs` «S2 SBS». No tracked code file outside review/ carries the stand-in or names the harness. Neither packaged bundle (web or native, every flag) carries them. Each runtime keeps its own mode. A leak mutant was killed at SBS-1.

## Defects found by this SBS (all fixed RED-first, at the tip)

| # | where | was | fix |
|---|---|---|---|
| D1 | the FULL light at f7ae357b, `pselfupdate-wrapper-lint` | `capp-shell-ui.js:738`: getPayAdjust/respondPayAdjust used a bare `win.fetch` (from 051e2534) | 3a141483: the canonical `sherpaFetch` (SherpaClient.fetch); a production-path cell |
| D2 | frame 1 | the listed card showed in the row but `flow.pay` stayed `''` when the device knows no last method. The primary was a disabled «Elegí cómo pagar» beside the card (v7: «the member's last card is preselected»). | 31b6443e: `sdkAdopt()`. The adopted card is the tender; a known last method still wins. SDKUI-1b. |
| D3 | frame 1, before the quote | «Total L 0 · Se cobra al recibir tu pedido.» | 31b6443e, advisor ruling (option 1): v7 frame 8's sentence with no amount; the quote adds «Total L X · » in place. CO-PQ (never «L 0» / «NaN»), SDKUI-PQ (held quote), CO-PQ-h (one layout). |
| D4 | frame 3 | «Guardar tarjeta» sat right under the content, not pinned to the bottom | 6d63efd8: `.app:not(.desk) .flow.px .paybar{margin-top:auto}` (the mockup's rule, scoped to phone). CO-3L. |
| D5 | frame 3 | the lock note's class `sec` picked up the menu's global `.sec{padding:28px 16px 0}`, so it was pushed down and indented | 6d63efd8: `.line.pxlock`. CO-3L: no lock-note class with a stand-alone global rule. |

**Owed, out of this batch** (advisor 11-09; STATUS-capp-1102 «Open findings»): `capp-checkout.js:231-232` `totals()` fails open, reporting `ready:true` with an undefined total when a quote is `ok` but has no `net_total_cents`.

## Frames

**Classes:**
- **MATCH**
- **DATA**: the fixture differs from the mockup's sample: store and dish, the saved address, the geocoded line, times, order number.
- **SHELL**: the real, already-approved shell around the frame.
- **FLOW**: an approved flow step the mockup folds away.
- **STAND-IN**: the native field host.
- **HARNESS**: an artefact of the capture.
- **MOCKUP**: the mockup's own drawing limit.
- **SUPERSEDED**: an older mockup overruled by a later approved one.
- **OWNER-PENDING**
- **STATE v7 DOES NOT DRAW**

**Seen in nearly every frame** (the table says «see list»):
- DATA: La Musa, «1 plato · Sichuan Spicy Wonton», L 249/294/314 vs the mockup's «La Musa · Centro», 3 dishes, L 585; «Ana Pérez» vs «Ana Mejía»; the store logo; «Tu ubicación» vs the geocoded address, since the harness has no geocoder.
- FLOW (checkout frames 1, 4, 4b, 5): v6's approved delivery flow is «Continuar» → the tip step → «Hacer pedido». The pay row also sits in the tip footer (the `S2-checkout 1` test: «the TIP footer carries the same row (advisor ruling 3)»). v7 draws the checkout after the tip (a «Propina L 20» row, «Hacer pedido · L 585» on the checkout), and sheets 4–5 over the checkout instead of the tip step. **Advisor to confirm.**
- SHELL (adjustment frames A–G): the live, approved order screen: «Tu pedido se está preparando», «ORDEN #4833 · Te avisamos por WhatsApp», the «Resumen del pedido» row, the «Pago y entrega» block, C-5's WhatsApp «Ayuda» and «✕», the dock. r3 redraws an older order screen: «Preparando tu pedido», the «LM» status row, «Tu pedido 2 productos · L 520», a «Pago» accordion, «‹» and «? Ayuda». The time window's format («Llega 7:10 – 7:20 p. m.» vs «Llega entre 7:35 y 7:50 p.m.») is v6's live-status formatter.
- OWNER-PENDING: the checkout support footer «¿Problemas con tu pedido? Escribinos al …» is omitted pending a ruling (capp-ui.js, «pending a ruling»).

| scene | mockup | injections | light diff / layout | dark diff / layout | classification + notes |
|---|---|---|---|---|---|
| S2ck-1-checkout-row | mk-1 / mk-1d | NATIVE + GEO | 7.25 / 4.44 | 7.88 / 5.38 | **MATCH**: the v7 pay row, «Visa ···· 4242», «Total L X · Se cobra al recibir tu pedido.», «Más información» on its own line. DATA: the mockup's member has a saved address (a collapsed «Portón negro / Detalles adicionales» row with «Cambiar»); the seed has none, so the pin row and field show. FLOW: «Continuar» vs «Hacer pedido · L 585» and the «Propina» row. OWNER-PENDING: the support footer. The bar keeps its height at the quote: checked in Chrome on the way, the scene fails on any change. |
| S2ck-1q-prequote | (none) | NATIVE + GEO | (no mockup) | (no mockup) | **STATE v7 DOESN'T DRAW; resolved with v7 frame-8 copy (advisor ruling)**: «Se cobra al recibir tu pedido.» + «Más información», no amount, while the quote is held 60 s. The scene fails unless that exact line shows. «Total —» in the body is today's approved state. Contrast only. |
| S2ck-2-chooser | mk-2 | NATIVE + GEO | 5.98 / 4.05 | 6.27 / 4.94 | **MATCH**: «Elegí cómo pagar», two saved cards (the mockup's Visa + Mastercard ···· 8810), ✓ on the selected one, «Agregar tarjeta», «Efectivo al entregar». HARNESS: a focus ring on «✕», from the programmatic open (Chrome treats it as :focus-visible; a touch open shows none). |
| S2ck-3-add-card | mk-3 (mid-entry) / mk-3d (valid) | NATIVE + GEO + STAND-IN | 3.94 / 3.37 | 2.62 / 2.47 | **MATCH** after D4/D5: the back arrow, the stacked fields, «Revisá la fecha de vencimiento», the save toggle, the lock note, «Guardar tarjeta» pinned to the bottom. **STAND-IN (native field host)**: the field pixels, including the CVV focus border (the mockup's `input.focus`); the native secure fields draw their own. |
| S2ck-4-processing | mk-4 | NATIVE + GEO | 13.02 / 10.03 | 13.21 / 10.33 | **MATCH**: «Procesando tu pago…», the amount, the brand tile + «Visa ···· 4242», «Esto toma unos segundos. No cerrés la app.» FLOW: over the tip step, not the checkout. DATA: the amount. |
| S2ck-4b-under-review | mk-4b | NATIVE + GEO | 14.37 / 10.68 | 14.57 / 10.99 | **MATCH**: 4 + «Estamos confirmando tu pago con el banco. Te avisamos en cuanto esté listo.» FLOW and DATA as in 4. |
| S2ck-5-declined-retryable | mk-5 | NATIVE + GEO | 13.25 / 10.6 | 13.38 / 10.85 | **MATCH**: «Tu banco no autorizó el pago» + its body, «Probar otra tarjeta», «Pagar en efectivo». HARNESS: the focus ring on the primary (focus moves into the sheet on a programmatic open). FLOW as in 4. |
| S2ck-6-expired | mk-6 | NATIVE + GEO | 6.98 / 4.8 | 7.53 / 5.68 | **MATCH**: the dimmed «Visa ···· 4242 / Venció en 10/26» row, the «Tu tarjeta guardada venció» well, «Agregar tarjeta» / «Pagar en efectivo», the disabled «Elegí cómo pagar». **MOCKUP → owner:** the dimmed «Venció en 10/26» is drawn as v7 draws it, at 2.6:1 (light) and 3.5:1 (dark), under AA's 4.5:1. The row is still tappable (it opens the chooser), so the inactive-control exemption doesn't apply. Flagged as an accessibility question on the mockup, not changed. |
| S2ck-7-unavailable | mk-7 | NATIVE + GEO | 14.46 / 11.53 | 10.12 / 7.28 | **MATCH**: no row, the «El pago con tarjeta no está disponible ahora» well with «Pagar en efectivo», the disabled «Elegí cómo pagar». HARNESS: mk-7's clip lands about 27 px right; it is the last figure in the mockup's horizontal strip, so part of the bezel shows and the right edge is cut. That inflates the diff; every element is matched by eye. |
| S2ck-8-pedido-recibido | mk-8 | NATIVE + GEO | 25.26 / 23.29 | 35.83 / 32.28 | **MATCH**: «Pedido recibido» (status new), «Estamos por empezar a preparar tu pedido», «Detalles de entrega», «TU PEDIDO» lines + Envío + Propina + Total, «PAGO Y ENTREGA»: «Pago · Visa ···· 4242», Total, «Se cobra al recibir tu pedido.» + «Más información». SHELL: the map header and the dock (the mockup draws the sheet expanded). DATA as listed. |
| S2adj-A-decrease | mk-a | NATIVE + GEO | 11 / 14.82 | 24.44 / 10.12 | **MATCH**: the «Actualizamos tu total» card, its body, «Más información». SHELL as listed. MOCKUP: r3's map stays light in dark mode, while the real map is themed; that explains the higher dark diff. |
| S2adj-B-help | mk-b | NATIVE + GEO | 8.36 / 5.77 | 19.62 / 5.39 | **MATCH**: «¿Cómo funciona el cobro?», both paragraphs (L 520), «Entendido». The copy stays OWNER-PENDING (BAC wording, slice). SHELL behind. |
| S2adj-C-consent | mk-c | NATIVE + GEO | 7.65 / 5.63 | 18.41 / 4.71 | **MATCH**: «La Musa cambió tu pedido», the body, «+ Agua Pura 600 ml L 40», «Total ~~L 585~~ L 625», «Se cobra a tu Visa ···· 4242 al recibir tu pedido.», «Más información», «Aceptar nuevo total», «Mantener mi pedido», «Tenés 3 min para responder» (server clock). SHELL behind. |
| S2adj-D-accepted | mk-d | NATIVE + GEO | 10.49 / 14.84 | 25.63 / 12.06 | **MATCH**: «Nuevo total aceptado · …» leads the status line, Total L 625. SHELL: the status line's v6 tail («Te avisaremos cuando vaya en camino» vs r3's «te avisamos cuando salga»). **SUPERSEDED**: r3 draws «Se cobra al recibir tu pedido.» with no «Más información». v7 frame 8 (later, owner-approved) draws that block WITH the link and calls it «the same block as adjustment frame A», so it's built to v7. **Advisor to confirm.** |
| S2adj-E-verifying | mk-e | NATIVE + GEO | 5.33 / 3.7 | 16.61 / 3.36 | **MATCH**: the spinner, «Verificando con tu banco…», the body, the challenge well. The well's content is the PixelPay plugin's own view: **OWED by the native-shell slice**, with 4c. |
| S2adj-F-expired | mk-f | NATIVE + GEO | 10.4 / 14.62 | 25.45 / 11.73 | **MATCH**: «Tu pedido sigue como estaba. Total L 585.» SHELL as listed. |
| S2adj-G-declined | mk-g | NATIVE + GEO | 6.87 / 4.72 | 18.22 / 4.47 | **MATCH**: «No pudimos actualizar tu total», the body (L 585), the single «Mantener mi pedido» (owner ruling; the slice's §9 note). SHELL behind. |

## OPEN OBLIGATION: owed by the native-shell slice

- A real-plugin SBS of frame 3, with the native secure fields from `@pixelpay/capacitor-plugin`, replaces the STAND-IN pixels above.
- A real-plugin SBS of frame 4c, the bank's challenge themed to match the app (not shot here; it is the plugin's own view). The same view fills adjustment E's challenge well.
- The production wiring that passes `paySdk` to CappUI.mount. Today no production code passes one, so without the binding the installed app has no «Agregar tarjeta» fields (ruling 5).

## Owner-facing questions surfaced by this run (for the advisor to route)

1. FLOW: v7 frames 1 and 4–5 draw the checkout after the tip (a «Propina» row, «Hacer pedido · L 585» on the checkout). The build keeps v6's tip step, with «Continuar» on the checkout. Confirm this is the intended reading.
2. SUPERSEDED: adjustment D/F's «Pago» block, r3 (no link) vs v7 frame 8 (with «Más información»). The build follows v7.
3. Accessibility: frame 6's dimmed «Venció en 10/26» is at 2.6:1, as drawn.
