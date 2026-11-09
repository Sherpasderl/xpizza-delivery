# S2 side-by-sides: classification sheet (filled in during the slot run)

Run: `node review/capp-sbs/sbs.mjs --set s2 --pkg <bundle> --out <dir>`. Package the bundle at the tip with `--target web --flags signup,guestCardOnly,ratings,schedulingLive,sdkPay`.

Targets:
- Checkout: MOCKUP-capp-S2-sdk-checkout.html (owner-approved v7).
- Adjustment: MOCKUP-capp-S2-adjustment.html (owner-approved r3).

The SBS method is (A), approved by the advisor on 11-09.

## Injections (every frame states its own)

| tag | what | where |
|---|---|---|
| NATIVE | `capp-runtime.js` is served with `"mode":"native"`. The bundle already carries the sdkPay flag; the patch refuses one without it. | sbs.mjs, per page (`sc.native`) |
| STAND-IN | The stand-in pay binding: the bundle's own strict `CappPaySdk.createPaySdk` around a raw binding, plus a field host that draws the mockup's own `<input>` markup. Frame 3 only. | standin-paysdk.mjs (pre-boot) |
| GEO | A device position for the delivery pin. Used only in scenes that place an order. | sbs.mjs (`sc.geo`) |
| directory_endpoint | The standing ruling (A) of 11-02, the same as every capp SBS. | sbs.mjs server |

Card availability (frame 7) comes from the server's `sdkPayStatus` fixture, not from the binding. The fixture bodies come from the strict fakes (`test/fake-sdk-checkout.mjs`, `test/fake-sdk-pay.mjs`). The order_tracking node comes from the real writer (`buildCreateOrderUpdates`).

The isolation guard is `customer-app/capp-guards.test.mjs` «S2 SBS». No tracked code file outside review/ carries the stand-in or names the harness. Neither packaged bundle (web or native, every flag) carries them. Each runtime keeps its own mode. A leak mutant was killed at SBS-1.

## Frames

Classes: MATCH · DATA (fixture data differs from the mockup's sample) · STAND-IN (native field host) · SHELL (the real shell around the frame) · DEFECT (fix before hand-back) · OWNER-PENDING.

| scene | mockup | injections | light | dark | classification + notes |
|---|---|---|---|---|---|
| S2ck-1-checkout-row | mk-1 / mk-1d | NATIVE | | | |
| S2ck-2-chooser | mk-2 | NATIVE | | | |
| S2ck-3-add-card | mk-3 (mid-entry) / mk-3d (valid) | NATIVE + STAND-IN | | | Field pixels = STAND-IN (native field host) |
| S2ck-4-processing | mk-4 | NATIVE + GEO | | | |
| S2ck-4b-under-review | mk-4b | NATIVE + GEO | | | |
| S2ck-5-declined-retryable | mk-5 | NATIVE + GEO | | | |
| S2ck-6-expired | mk-6 | NATIVE | | | |
| S2ck-7-unavailable | mk-7 | NATIVE | | | |
| S2ck-8-pedido-recibido | mk-8 | NATIVE + GEO | | | |
| S2adj-A-decrease | mk-a | NATIVE + GEO | | | |
| S2adj-B-help | mk-b | NATIVE + GEO | | | |
| S2adj-C-consent | mk-c | NATIVE + GEO | | | |
| S2adj-D-accepted | mk-d | NATIVE + GEO | | | |
| S2adj-E-verifying | mk-e | NATIVE + GEO | | | |
| S2adj-F-expired | mk-f | NATIVE + GEO | | | |
| S2adj-G-declined | mk-g | NATIVE + GEO | | | |

## OPEN OBLIGATION: owed by the native-shell slice

- A real-plugin SBS of frame 3, with the native secure fields from `@pixelpay/capacitor-plugin`, replaces the STAND-IN pixels above.
- A real-plugin SBS of frame 4c, the bank's challenge themed to match the app (not shot here; it is the plugin's own view).
- The production wiring that passes `paySdk` to CappUI.mount. Today no production code passes one, so without the binding the installed app has no «Agregar tarjeta» fields (ruling 5).
