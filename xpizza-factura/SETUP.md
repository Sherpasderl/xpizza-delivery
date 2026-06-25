# X. Pizza Factura — setup & test-print guide

The factura subsystem. Pure logic is built + unit-tested (`npm test`, 87 tests). This guide
covers the **hardware bring-up** on the Surface Pro and running **test prints**, all in the
`FACTURA DE PRUEBA` temp phase — no live order-flow changes, nothing touching PixelPay.

## 0. What's where

| File | Role |
|------|------|
| `src/*.js` | Pure, tested cores (num-to-words, money, renderer, escpos, allocate, build-record, print-claim, factura-helpers) |
| `seed_factura_config.js` | One-time: seed the TEMP fiscal config into RTDB |
| `print_agent.js` | Always-on watcher on the Surface → prints `/facturas` records |
| `tools/print-sample.js` | First-print bring-up: sample straight to USB (no Firebase) |
| `tools/test-order.js` | Full pipeline: allocate a sample order in RTDB → agent prints it |
| `preview.js` | Render a sample to the terminal (no hardware) — `npm run preview` |

## 1. Surface Pro one-time setup (Windows)

1. **Node.js LTS** (≥ 18) — https://nodejs.org
2. **Visual Studio Build Tools 2022** → "Desktop development with C++" (needed to compile the
   native `usb` module).
3. **Zadig** (https://zadig.akeo.ie) → plug in the Epson, select it, replace its driver with
   **WinUSB**. *Note the exact VID/PID Zadig shows* — the TM-T20IV**-SP** PID may not be
   `0x0202`. Do **not** also install Epson's own Windows driver (only one can own the device).
4. **Disable sleep/hibernate** while on KDS duty: `powercfg /hibernate off`, and set Sleep →
   Never (plugged in). The agent is a live watcher; suspension silently stops printing.

## 2. Install + configure

```bash
cd xpizza-factura
npm install                 # compiles the native usb module (needs Build Tools)
cp .env.example .env        # then edit .env
```
Fill `.env`: `FB_DATABASE_URL`, `GOOGLE_APPLICATION_CREDENTIALS` (path to a Firebase service
account JSON with RTDB access), `USB_VID`/`USB_PID` (from Zadig), `RESTAURANT_ID=x_pizza`.

## 3. Confirm the printer (no Firebase yet)

```bash
npm run print-sample
```
A two-copy `FACTURA DE PRUEBA` should print. If "printer not found" → recheck the Zadig
PID in `.env`. If `device.open` fails → the WinUSB driver isn't bound (re-run Zadig).

## 4. Seed the temp fiscal config (once)

```bash
npm run seed
```
Writes `/restaurants/x_pizza/factura_config` with `is_temp:true` and `seq.last_reserved =
range_start-1`. Self-aborts if a live counter already exists (won't clobber issued numbers).

## 5. End-to-end test print

Terminal A (Surface): `npm run agent`  → "watching /facturas/x_pizza"
Terminal B (anywhere with creds): `npm run test-order`

`test-order` allocates a real sequential factura for a sample order and writes it to
`/facturas`; the agent prints it. Verify: sequential `FACTURA:` number, `PEDIDO`, items with
tax-exclusive `PRECIO` footing to `SUB TOTAL`, ISV 15% line, `TOTAL`, `SON:` words, `CAMBIO`,
the `FACTURA DE PRUEBA` banner, two copies, clean cut. Run it again → the number increments.

## 6. Run the agent as a service (NSSM)

```
nssm install XPizzaFacturaAgent "C:\Program Files\nodejs\node.exe" "C:\path\to\xpizza-factura\print_agent.js"
nssm set XPizzaFacturaAgent AppDirectory "C:\path\to\xpizza-factura"
nssm start XPizzaFacturaAgent
```

## 7. Go-live (when SAR issues X. Pizza's real CAI)

Per `FACTURA_PLAN.md` §11: update the real `cai_code` / establecimiento / punto / tipo /
prefix / range_start / range_end / fecha_limite (ISO), set `is_temp:false`, and set
`seq = { last_reserved: range_start-1, pending: {} }`. Do **not** re-run `seed`. Print one
real factura to confirm. Zero code change.

## Still pending (separate, deferred until the PixelPay/bank decision)

The live auto-fire wiring — the `allocateFacturaOnSale` + cancel DB triggers in
`xpizza-functions/index.js`, the order-form RTN + cash-change fields, and the `/facturas`
deny rules — are intentionally NOT in this directory yet (they touch files the PixelPay
session owns). Until then, `tools/test-order.js` stands in for the trigger.
