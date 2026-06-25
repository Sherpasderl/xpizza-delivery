# X Pizza Delivery Platform — Factura Integration Handoff Brief
**For: `/grill me` review session in Claude Code**
**Date:** 2026-06-25
**Author:** Xavier Lacayo / Claude (Sonnet 4.6)
**Status:** Scaffolding complete. CAI authorization pending. Order form patch pending.

---

## 1. Context

X Pizza is a pizza delivery operation in San Pedro Sula, Honduras, owned by Sherpa S. de R.L. The delivery platform is a Firebase RTDB + Cloud Functions backend with static HTML/JS PWA frontends deployed on Netlify. The factura system is being integrated into the existing Last Mile Delivery stack.

**Legal entity:** Sherpa S. de R.L.
**SAR registration:** Company is independently registered for delivery operations — NOT covered by the host store's CAI.
**Regulatory requirement:** Honduras law requires a factura for every sale. Customer RTN is optional (only when buyer needs a tax deduction). The factura itself is not optional.
**Factura type:** Physical printed, SAR-authorized sequential range (CAI-based), paper-based (not FEL/electronic).

---

## 2. Locked Decisions

All five were explicitly confirmed by Xavier in prior sessions. Do not re-litigate.

| ID | Decision | Detail |
|----|----------|--------|
| D1 | Generation at order creation | `allocateFacturaNumber` called inside `createOrder` after order record is written. Cancellation after allocation requires a void, not sequence recycling. |
| D2 | Forma de Pago | `EFECTIVO` for cash-on-delivery; `TARJETA` for PixelPay card payments. Determined at order creation, never patched later. |
| D3 | CLIENTE field logic | No RTN requested → `customer_name` from order form goes to CLIENTE. RTN requested → `razón_social` (separate field on order form) replaces CLIENTE; `rtn_cliente` populated. |
| D4 | Two physical copies | Copy 1: travels with driver to customer. Copy 2: stays at restaurant for SAR records. |
| D5 | Itemized line list | Each item prints as: CANT / DESCRIPCION / DESC% / PRECIO. No consolidated totals-only format. |
| — | Mesa/Mesero replacement | These POS fields don't apply to delivery. Replaced with `PEDIDO: [order_id]`. |
| — | Per-item tax rate | `tax_rate` field per menu item. X. Pizza: all items 15% (no alcohol). La Musa: food 15%, alcohol 18%. ISV must print as two separate lines (IMPORTE GRAVADO 15% and IMPORTE GRAVADO 18%) even when one is zero. |
| — | Void flow | Cancelled orders after factura allocation → `void: true` on the factura record. Sequence number is NOT recycled. SAR requires voided numbers stay in audit trail. |

---

## 3. Hardware

| Device | Spec | Notes |
|--------|------|-------|
| Host computer | Microsoft Surface Pro 7+ | Runs KDS webapp + print agent. Windows 10 Home. 1x USB-A 3.1, 1x USB-C. |
| Printer | Epson TM-T20IV-SP | USB connection (not serial, not ethernet). 80mm paper width. ESC/POS compatible. Vendor ID: 0x04B8. Product ID: 0x0202 (verify with Zadig — SP variant may differ). |

**Windows-specific one-time setup required before agent can run:**
1. **Zadig** — replaces Epson's USB driver with WinUSB so `libusb` can address the device directly. After Zadig, Epson's own driver no longer owns the device. Do not install Epson's Windows driver alongside this.
2. **Visual Studio Build Tools 2022** (Desktop development with C++ workload) — required to compile the native `usb` npm module.
3. **NSSM** — wraps Node.js print agent as a Windows service with auto-start on boot.
4. **Surface sleep must be disabled** while on KDS duty (`powercfg /hibernate off`, Sleep: Never when plugged in). Agent is a live RTDB watcher — suspension kills print jobs silently.

---

## 4. Architecture

### 4.1 Data Flow

```
Customer order form
  └─ "Necesito factura con RTN" checkbox [NOT YET BUILT]
       ├─ Unchecked: {customer_name} → CLIENTE on factura
       └─ Checked:   {razón_social, rtn_cliente} → CLIENTE/RTN on factura

createOrder (Cloud Function)
  └─ allocateFacturaNumber(restaurantId, order)
       ├─ Reads /restaurants/{id}/factura_config (static config + CAI data)
       ├─ RTDB transaction on current_sequence (atomic increment)
       ├─ Formats factura_number: prefix-XXXXXXXX (zero-padded to 8 digits)
       └─ Writes /facturas/{restaurantId}/{orderId} with printed: false

Print agent (Surface Pro, always-on Node.js service)
  ├─ Watches /facturas/{restaurantId} via child_added + child_changed
  ├─ child_added: prints any record with printed === false && void === false
  ├─ child_changed: reprint trigger — KDS sets printed: false, agent picks it up
  ├─ Calls renderFactura(record, copies=2) → ESC/POS Buffer
  ├─ Sends raw bytes to printer via libusb bulk-out transfer
  └─ On success: sets printed: true, printed_at timestamp
     On failure: writes print_error field, leaves printed: false for retry
```

### 4.2 RTDB Schema

```
/restaurants/x_pizza/factura_config
  is_temp:          boolean   # true during testing — stamps FACTURA DE PRUEBA
  stamp_preview:    string    # "FACTURA DE PRUEBA"
  cai_code:         string    # Full SAR CAI alphanumeric code
  establecimiento:  string    # e.g. "000"
  punto:            string    # e.g. "001"
  tipo:             string    # e.g. "01"
  prefix:           string    # Derived: "000-001-01"
  range_start:      number    # First authorized sequence number
  range_end:        number    # Last authorized sequence number
  current_sequence: number    # Current pointer — ONLY written by RTDB transaction
  fecha_limite:     string    # SAR expiry date "DD/MM/YYYY"
  restaurant_name:  string    # "X PIZZA"
  legal_name:       string    # "SHERPA S. DE R.L."
  rtn:              string    # Sherpa RTN (14-digit Honduras tax ID)
  address_1:        string
  address_2:        string
  email:            string
  phone:            string

/facturas/{restaurantId}/{orderId}
  factura_number:   string    # "000-001-01-00000001"
  restaurant_id:    string
  order_id:         string
  is_temp:          boolean   # Snapshot of config.is_temp at time of issuance
  created_at:       ISO8601
  fecha:            string    # "DD/MM/YYYY" Honduras local time
  hora:             string    # "HH:MM:SS" Honduras local time
  cai_code:         string    # Immutable snapshot — audit record
  prefix:           string
  range_start:      number
  range_end:        number
  fecha_limite:     string
  restaurant_name:  string    # Snapshot
  legal_name:       string
  rtn_emisor:       string
  address_1:        string
  address_2:        string
  email:            string
  phone:            string
  cliente:          string    # razón_social OR customer_name
  rtn_cliente:      string    # Empty string if no RTN requested
  forma_de_pago:    string    # "EFECTIVO" | "TARJETA"
  payment_total:    number
  items:            array     # [{qty, description, unit_price, line_total, tax_rate, discount_pct}]
  subtotal:         number    # Pre-ISV total
  isv_15:           number    # ISV computed for 15% items
  isv_18:           number    # ISV computed for 18% items
  isv_total:        number    # Sum of both
  total:            number
  pedido:           string    # order_id — replaces Mesa/Mesero fields
  driver_name:      string    # May be empty at creation; populated later if needed
  printed:          boolean   # false = queued for print; true = done
  printed_at:       ISO8601
  print_error:      string    # Set on failure; cleared on retry success
  reprint_count:    number
  void:             boolean
  void_reason:      string
  voided_at:        ISO8601
```

### 4.3 ISV Calculation

ISV in Honduras is **tax-inclusive** — it is already embedded in the displayed price. The calculation is:

```
ISV contribution for item = line_total - (line_total / (1 + rate/100))
IMPORTE GRAVADO (base)    = line_total / (1 + rate/100)
```

For 15% ISV: ISV = line_total × (15/115)
For 18% ISV: ISV = line_total × (18/118)

The renderer uses `computeGravado()` and ISV values pre-computed in the factura record. Both lines print even when one is zero (SAR format requirement).

### 4.4 Factura Number Format

```
000-001-01-00000001
│   │   │  └─ 8-digit zero-padded sequence
│   │   └─ tipo (document type)
│   └─ punto de emisión
└─ establecimiento
```

Derived from `config.prefix` + padded `current_sequence`. Prefix stored in RTDB config — single source of truth.

### 4.5 Print Agent Architecture Decision

Raw ESC/POS via USB (`usb` npm + Zadig WinUSB), **not** Epson Windows driver + `node-printer`. Rationale: ESC/POS gives character-level control over layout, double-width for totals, and cut commands. The Windows print queue GDI layer is unpredictable for thermal receipt character positioning. This is the correct call for this stack — do not switch to Option B without a strong reason.

---

## 5. Files Produced

All scaffolding files are in the outputs folder. Final deployment destinations noted below.

| File | Deploy to | Purpose |
|------|-----------|---------|
| `seed_factura_config.js` | Run once from `xpizza-functions/` | Seeds RTDB `/restaurants/x_pizza/factura_config` with temp CAI values. Self-aborts if `current_sequence > 0` to prevent clobbering a live counter. |
| `factura_helpers.js` | `xpizza-functions/` (require or inline into `index.js`) | `allocateFacturaNumber()` and `voidFactura()`. Handles RTDB transaction, builds factura record, writes to `/facturas/`. |
| `factura_renderer.js` | Print agent directory on Surface | Pure ESC/POS renderer. No I/O. Input: facturaRecord. Output: Buffer. Run `node factura_renderer.js` to pipe test bytes to stdout. |
| `print_agent.js` | Print agent directory on Surface | RTDB watcher + USB print driver. Node.js process managed by NSSM as a Windows service. |
| `package.json` | Print agent directory on Surface | Dependencies: `firebase-admin`, `usb`, `dotenv`. |

**Not yet built:**
- Order form RTN fields patch (`xpizza-orders/index.html`) — needs the live file to write a targeted `str_replace` patch
- KDS "Reimprimir" button — sets `printed: false` on the factura record; agent picks it up automatically
- `createOrder` integration — call to `allocateFacturaNumber` must be inserted into the existing `createOrder` Cloud Function after the order record write
- Void integration — `voidFactura()` must be wired into whatever code path handles order cancellation

---

## 6. Integration Point: createOrder

`allocateFacturaNumber` must be called **after** the order is written to RTDB, inside the existing `createOrder` Cloud Function in `xpizza-functions/index.js`. The integration looks like:

```javascript
// After: await db.ref(`/orders/${orderId}`).set(orderPayload);
// Add:
try {
  await allocateFacturaNumber(restaurantId, {
    orderId,
    items:          orderPayload.items,
    subtotal:       orderPayload.subtotal,
    isv:            orderPayload.isv,
    total:          orderPayload.total,
    payment_method: orderPayload.payment_method,
    customer_name:  orderPayload.customer_name,
    razón_social:   orderPayload.razón_social  || '',
    rtn_cliente:    orderPayload.rtn_cliente   || '',
  });
} catch (facturaErr) {
  // Log but do NOT fail the order — factura failure must not block the order
  console.error('[factura] allocation failed:', facturaErr.message);
}
```

**The try/catch is not optional.** A factura allocation failure must never cause `createOrder` to return an error to the customer. Orders take priority over fiscal documents.

---

## 7. Order Form Fields (Not Yet Built)

Three additions needed to `xpizza-orders/index.html`:

1. **Checkbox**: `"Necesito factura con RTN"` — positioned after the phone number field.
2. **Conditional reveal**: On check, show two fields: `razón_social` (company name) and `rtn_cliente` (14-digit RTN). On uncheck, hide and clear both.
3. **Order payload**: Both fields added to `buildOrder()` output. `razón_social` defaults to `''` when checkbox unchecked.

RTN format validation: Honduras RTNs are 14 digits. Validate client-side with `/^\d{14}$/` before allowing form submission when RTN is provided.

The `str_replace` patch cannot be written without the live `index.html` — the insertion point (the phone field block) must be located by exact string match against the current file.

---

## 8. Temp CAI Behavior

When `factura_config.is_temp === true`:

- The renderer stamps `*** FACTURA DE PRUEBA ***` / `*** NO VALIDA FISCALMENTE ***` in double-height bold at the top of every print.
- All other logic (sequence counter, formatting, ISV, copy count) runs identically to production.
- This allows full end-to-end testing with the real printer before the CAI authorization arrives.

**To go live:** Update RTDB `/restaurants/x_pizza/factura_config` with real values and set `is_temp: false`. Zero code changes required. The seed script will abort if `current_sequence > 0` — update fields individually via Firebase Console or a one-off script.

---

## 9. Known Risks and Open Questions

### 9.1 Risks

**R1 — Sequence gap on order cancellation.** If an order is created (sequence allocated), then cancelled before the factura is printed, the sequence number is burned. SAR allows voided numbers in the authorized range, but they must appear in the audit trail with `void: true`. The void flow is built into `factura_helpers.js`. The question is: does the existing order cancellation path call `voidFactura()`? It does not yet — this integration point is not built.

**R2 — Driver name is empty at factura creation.** `driver_name` on the factura record will be empty string at order creation time because auto-assignment happens after order creation. The factura is already written by then. If driver name on the printed factura matters operationally, there are two options: (a) accept empty driver name on all facturas (recommended — SAR doesn't require it), or (b) add a Cloud Function trigger on driver assignment that patches the factura record. Option (a) is correct — do not build option (b) without a clear operational requirement.

**R3 — USB Product ID unverified.** The `0x0202` Product ID used in the print agent is the standard TM-T20 series ID. The `-SP` suffix (Serial + Parallel ports variant) may have a different PID. Zadig shows the exact VID/PID when the printer is plugged in. This must be verified before first run and updated in `.env`.

**R4 — `firebase-functions` package version.** The existing Cloud Functions codebase uses an older `firebase-functions` version that does not support `defineSecret`. If `allocateFacturaNumber` ever needs to read a secret (currently it doesn't — all config is in RTDB), this will block. This is a pre-existing known deferred item in the project.

**R5 — Print agent cannot be fully validated without hardware.** ESC/POS paper-width mismatches, character encoding edge cases, and USB transfer behavior only surface on the physical Epson. The renderer is testable offline; the agent's USB path is not.

**R6 — `usb` native module on Windows.** The `usb` npm package compiles native bindings via `node-gyp`. If Visual Studio Build Tools are not installed or are the wrong version, `npm install` will fail. This is a one-time setup issue but has no fallback — the agent cannot run without it.

**R7 — RTDB transaction abort handling.** The `seqRef.transaction()` callback uses `return undefined` to abort on range exhaustion, but the abort detection in the completion callback (`if (!committed)`) fires a throw inside an async callback — which may not propagate correctly depending on Firebase Admin SDK version. This needs a unit test or integration check before going live.

**R8 — `child_added` fires for ALL existing records on agent startup.** On every agent restart, Firebase fires `child_added` for every existing `/facturas/` record, not just new ones. The `if (!record.printed && !record.void)` guard handles this correctly for already-printed records, but if there are legitimately unprinted records (e.g., print job that failed before agent crashed), they will re-fire and attempt reprint. This is the intended behavior — but verify it doesn't cause duplicate prints for records that were mid-print when the agent died.

### 9.2 Open Questions (not yet answered by Xavier)

**Q1** — What is the RTN for Sherpa S. de R.L.? (14-digit Honduras tax ID — needed to populate `rtn` in factura config and print in the header block.)

**Q2** — What are the exact address lines for X. Pizza as they should appear on the factura?

**Q3** — What is the email for factura header?

**Q4** — What is the phone for factura header?

**Q5** — Does Xavier want to display `driver_name` on the factura at all, or accept empty? (Recommendation: accept empty — don't build the patch trigger.)

**Q6** — Is there a `cash_tendered` field on delivery orders for CAMBIO calculation? If not, CAMBIO always prints L0.00 for cash orders, which is incorrect for orders where the customer hands over more than the total.

**Q7** — Does the KDS currently have a cancel-order flow? If yes, it must call `voidFactura()` after the factura scaffolding is live.

---

## 10. CAI Authorization Swap

When the real CAI arrives from SAR, update these fields in RTDB individually (via Firebase Console or one-off script). Do NOT re-run `seed_factura_config.js` if `current_sequence > 0`.

```
/restaurants/x_pizza/factura_config:
  is_temp:         false
  cai_code:        [real CAI alphanumeric from SAR]
  establecimiento: [real value]
  punto:           [real value]
  tipo:            [real value]
  prefix:          [derived: establecimiento-punto-tipo]
  range_start:     [first authorized number]
  range_end:       [last authorized number]
  fecha_limite:    [expiry date "DD/MM/YYYY"]
  rtn:             [Sherpa RTN]
  address_1:       [real address line 1]
  address_2:       [real address line 2]
  email:           [real email]
  phone:           [real phone]
```

`current_sequence` must NOT be reset — it holds the live pointer.

---

## 11. Remaining Build Sequence

In order:

1. **Upload `xpizza-orders/index.html`** → write targeted `str_replace` patch for RTN checkbox + conditional fields + `buildOrder()` payload additions. Validate with `node --check` + esbuild + manual browser test.
2. **Integrate `allocateFacturaNumber` into `createOrder`** in `xpizza-functions/index.js`. Wrap in non-blocking try/catch. Deploy and verify factura record appears in RTDB on test order creation.
3. **Run `seed_factura_config.js`** against production RTDB to seed the temp config node.
4. **Set up print agent on Surface** — install Node.js, Build Tools, Zadig, NSSM. Verify USB PID. `npm install`. First run with `node print_agent.js`. Trigger test order and confirm physical print.
5. **KDS Reimprimir button** — small addition to KDS webapp; sets `printed: false` on a factura record. Agent handles the rest automatically.
6. **Void integration** — wire `voidFactura()` into the order cancellation code path.
7. **CAI swap** — when authorization arrives, update RTDB fields, set `is_temp: false`, verify one real print. Done.
