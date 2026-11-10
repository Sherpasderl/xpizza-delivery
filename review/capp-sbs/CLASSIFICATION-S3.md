# Item S3 refusals — side-by-side vs the APPROVED mockup (MOCKUP-item-s3-refusals.html, owner 11-10)

Two rigs, one mockup:
- **Customer app** — `node review/capp-sbs/sbs.mjs --set s3 --pkg <package-capp web, flags signup,guestCardOnly,ratings,schedulingLive,sdkPay> --out <dir>`
  · 4 scenes × light/dark = 8 renders · 0 unmapped requests · contrast fails 0.
  The mockup draws the installed app's v7 pay bar, so these run like the S2 scenes (NATIVE + member seed + saved card). The order is
  the mockup's: X. Pizza, **Pickup**, Carnivora + Pepperoni, Margherita, Potato & Dill Sausage. `placeSdkOrder` answers ONCE with the
  server's own refusal body (resolve-lines `resolutionRefusal` / extras-intake `refusalBody`+`refusalStatus`, + order_id as index.js
  sends them). A2's fresh menu = the provisioned x_pizza envelope without Potato & Dill Sausage, under a new ETag.
- **Order forms** — `node review/forms-s3-sbs/shoot.mjs --out <dir>` (the forms' own CDP rig, platform/perf/cdp-fonts.mjs) · 8 frames.
  The real page from this tree; the menu from ONE real publish (item-s3-fixtures.mjs); quoteOrder = resolveLines + computeServerTotal over
  that version's tables; chargeOnlineOrder answers ONCE with the server's refusal; any later send is HELD (none happened: sends = 1 in all 8).

Harness facts that apply to every pair (verified, not assumed):
- **The mockup renders offline**: its route answers every outside request 404/fail, so its Google faces (Red Hat Text / DM Sans) never
  load and it draws in the fallback stack. Line breaks in the mockup differ by construction (e.g. A1's title fits one line there, wraps in
  the app's real Red Hat Text). The CSS of the sheets/gates themselves is byte-identical between app and mockup (checked: `.errsheet *`,
  `.pickup-gate*`).
- **The mockup's form drawings inherit its capp `.primary{min-height:54px}`** (measured in the mock page: the gate button's computed
  min-height comes from that rule). The real forms' gate button is the form's own `.pickup-gate-btn` (36 px), which is what the mockup's
  caption says it reuses. → MOCKUP ARTIFACT, not a defect.
- Device insets: the mockup draws a 44-px top and a home-indicator bottom inset; desktop Chrome has 0 for `env(safe-area-inset-*)`.
- Maps are offline in the forms rig (the blank map area in C1/D1/E1/F1); the mockup draws a static map.

## Customer app

| frame | diff L / D | classification |
|---|---|---|
| A1 menu_changed sheet | 6.1 % / 5.6 % | MATCH: icon, title «El menú se actualizó, recargá el menú», body, one «Recargar». FONT (mock fallback) wrap; FOCUS: the app draws its focus ring on the primary (the sheet moves focus to its first action — existing a11y behaviour); DATA: store row / member from the fixtures; FLAG: «Programar» shows (schedulingLive in the package) |
| A2 cart after «Recargar» | 30.8 % / 26.7 % | MATCH: Potato & Dill Sausage dropped, «1 plato ya no está disponible» (existing copy), Carnivora + Pepperoni L 390, Margherita L 299, Subtotal L 689, «Ir al checkout». DATA: the store header (fixture directory: photo, «X Pizza», hours, «2 pizzas» unit word) — the bulk of the %; the mockup's bottom inset |
| B1 extra_not_allowed sheet | 7.1 % / 6.6 % | MATCH: title, body, naming line «Carnivora · extra: Pepperoni», «Quitar extra y seguir» + «Cerrar». FONT / FOCUS / DATA as A1 |
| B2 after the repair | 10.8 % / 11.3 % (re-shot at fd71754e with the fix; 8.7 / 9.0 before it — the % is the scroll offset: the shot centres the note, the mockup sits higher) | MATCH: «Quitamos Pepperoni de Carnivora. Total nuevo: L 938.», Subtotal/Total L 938, pay line «Total L 938», «Hacer pedido · L 938». **DEFECT FOUND + FIXED:** the note kept the cart sheet's 20-px side margins; the approved frame has it flush in «Tu pedido» (the mockup's `.fsec .cartnote{margin:0}`) → capp.css rule + cell S3-CAPP-B2-FLUSH (RED without it). SCROLL: the shot scrolls «Tu pedido» into view as drawn — the app does not scroll there itself (the pay bar, always on screen, carries the new total) |

## Order forms

| frame | classification |
|---|---|
| C1 / E1 menu_changed | MATCH: the gate under the Delivery/Pickup toggle, «El menú se actualizó, recargá la página», ONE «Recargar la página». MOCKUP ARTIFACT: button height (above); HARNESS: map offline; DATA: hero photo, «Entrar» pill (the real header) |
| C2 / E2 after «Recargar la página» | MATCH: the dropped dish gone, summary L 689 / L 683, PixelPay L 689.00 / L 683.00, the toast «1 producto ya no está disponible». **DEFECT FOUND + FIXED (2):** (a) the toast was INVISIBLE for a customer who never opened the account sheet — account.js `toast()` relied on `injectSheetStyles()`, which only `buildOverlay()` ran, so the toast was an unstyled div at the page's end (computed `position: static`) → `toast()` injects its styles (idempotent) + cell S3-FORM-C2-TOAST-SHOWN (RED without it); (b) the toast wrapped at half the screen (`left:50%`, shrink-to-fit) where the approved frame draws ONE line → `width:max-content; max-width:calc(100vw - 32px)` (one line when it fits, wraps only at the screen edge) + cell S3-FORM-C2-TOAST-LINE (mutant killed). Both copies of account.js stay byte-identical. EXISTING: the floating cart pill («2 pizzas · L 689») the mockup does not draw |
| D1 / F1 extra_not_allowed | MATCH: title (the server's detail), naming line «Carnivora · extra: Pepperoni» / «Filete La Muse · acompañamiento: Arroz Blanco», red «Quitar extra y seguir» + ghost «Revisar pedido». MOCKUP ARTIFACT: button height; HARNESS: map |
| D2 / F2 after the repair | MATCH: «Quitamos Pepperoni de Carnivora. Total nuevo: L 938.» / «Quitamos Arroz Blanco de Filete La Muse. Total nuevo: L 881.», the summary without the extra (L 340 / L 384), Total + PixelPay amount. DATA: F2's line order — the form lists lines in MENU order (PLAN-menu-ordering: Wonton, Pork Belly Buns, Filete La Muse); the mockup's cart lists Filete second. Nothing reorders on the repair (E2 before / F2 after are both menu order). EXISTING: the floating cart pill |

No COPY or COLOR differences in any frame. Copy matches the owner's wording: capp «recargá el menú», forms «recargá la página».
