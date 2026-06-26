# Browser sandbox test — click through a real 3DS payment

Exercises the full online-payment flow (chargeOnlineOrder → SDK 3DS auth →
confirmOnlinePayment → materialize) in a real browser, against the PixelPay
**sandbox** (no real money). Uses `payments-probe/sandbox-test.html`.

## Why a harness (not the order form)
The harness hits the real backend but skips the menu→cart→address flow, so you can
iterate on payments fast. The real order form (`xpizza-orders/index.html`) uses the
exact same backend; test it once end-to-end separately if you want.

## Sandbox amount mapping (important)
The PixelPay sandbox ONLY accepts `order_amount` 1–14 (1=success, 2=declined, …);
real menu totals (L251+) return "test case N doesn't exist". So in `PIXELPAY_MODE=
sandbox` the server charges a fixed **test amount** (default **1 = success**) while
the order keeps its real total. Change the outcome by redeploying with
`PIXELPAY_SANDBOX_AMOUNT=2` (declined), etc. To test 3DS variants, keep amount=1 and
just switch the **card** (the harness has presets).

## 1. Make the functions run in sandbox mode
`xpizza-functions/.env` already has `PIXELPAY_MODE=sandbox`. Then either:

**A. Deploy (simplest, recommended pre-launch):**
```
cd xpizza-functions
npm run deploy            # deploys functions with PIXELPAY_MODE=sandbox
```
Harness "Functions base URL" stays the default cloudfunctions.net URL.
(Note: this deploys the in-progress feature-branch functions to the project; in
sandbox mode they can't move real money. Scheduled sweep/reconcile will start running
— harmless, they only touch pending online orders.)

**B. Local emulator (no deploy):**
```
cd xpizza-functions
npm run serve             # functions emulator (Node only, no Java)
```
Then set the harness "Functions base URL" to
`http://localhost:5001/xpizza-delivery/us-central1`.
Caveat: the emulator talks to the REAL RTDB (no DB emulator), so you need
`firebase login` and the test order will appear in the live database.

## 2. Serve + open the harness
```
cd payments-probe
python3 -m http.server 8000
```
Open http://localhost:8000/sandbox-test.html (serve over http, NOT file://, so the
3DS iframe + SDK work).

## 3. Run a payment
1. Paste **ORDER_SECRET** (from `xpizza-orders/index.html` line ~1230, or functions `.env` MAKE_SECRET).
2. Pick a test card preset, click **Pagar**.
3. Watch the step log: chargeOnlineOrder → auth (a 3DS card pops a bank-challenge
   iframe) → confirmOnlinePayment → final status.
4. **Success** → `CONFIRMED`; the test order materializes — check it shows in the
   dispatch board / KDS, then **cancel it** (it's a real test order in RTDB).

## Test cards (sandbox)
| Card | CVV | Outcome (with amount=1) |
|------|-----|--------------------------|
| 4111 1111 1111 1111 | 300 | success, no 3DS challenge |
| 4000 0000 0000 1000 | 300 | 3DS challenge → success |
| 4000 0000 0000 1018 | 300 | 3DS failed auth |
| 4000 0000 0000 1091 | 300 | 3DS step-up success |
| 4000 0000 0000 1075 | 300 | 3DS lookup timeout |
| 5555 5555 5555 4444 | 999 | Mastercard 3DS success |
Expiry: any future date (e.g. 12/27). Cardholder: first + last name (PixelPay requires both).

## What to verify
- Success card → log shows CONFIRMED; order appears live in dispatch/KDS with
  `payment_status: confirmed`, `payment_method: online`.
- 3DS card → the in-page challenge iframe appears and completes.
- Failed-auth card → log shows the auth rejected (no order materializes; stays pending).
- After testing, clean up the `PRUEBA SANDBOX` orders from the dispatch board.
