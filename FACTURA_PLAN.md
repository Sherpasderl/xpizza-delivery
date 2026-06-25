# Plan: Factura (SAR fiscal document) integration for X. Pizza
_Locked via grill-with-docs — by Claude + Xavier. Terms per CONTEXT.md. Supersedes the pre-PixelPay `FACTURA_INTEGRATION_HANDOFF.md` where they conflict. Revised after Codex Round 1._

## Goal

Issue a SAR-authorized [[Factura]] for **every** X. Pizza [[Sale]] — cash, card-at-delivery,
and online (PixelPay) — print it on the Hub's Epson thermal printer in the exact format SAR
already accepts from this [[Merchant]] (Sherpa S. de R.L.). Allocation is **non-blocking**
for the customer-facing order; the guarantee is that **no Sale is ever left permanently
without a factura** (queued + reconciled, never silently dropped). Separately, the sequence
counter is **integrity-fail-closed**: it never issues an out-of-range or expired number.
Build and validate end-to-end in a `FACTURA DE PRUEBA` temp phase, then go live by swapping
in X. Pizza's real CAI with zero code changes.

## Approach

1. **Fiscal config + emisor identity (RTDB).**
   - Per-Restaurant fiscal block at `/restaurants/x_pizza/factura_config`: `cai_code`,
     `establecimiento`, `punto`, `tipo`, `prefix`, `range_start`, `range_end`,
     `fecha_limite` (stored **ISO `YYYY-MM-DD`** for comparison; rendered `DD/MM/YYYY`),
     `is_temp`, `stamp_preview`, and the **reservation ledger**
     `seq = { last_reserved: <number>, pending: { <orderId>: <reservedNumber> } }` (written
     ONLY by the reservation transaction — the single authority on number consumption).
     Seeded placeholder, `is_temp: true`, `seq = { last_reserved: range_start - 1,
     pending: {} }` (so the first reserved number is `range_start`). There is no separate
     `current_sequence` — `last_reserved` is the one monotonic counter.
   - Merchant-level emisor identity (shared, single authored copy): `legal_name` =
     `SHERPA S. DE R.L.`, `rtn` = `05019024114145`.
   - Per-establecimiento identity (X. Pizza): `restaurant_name` = `X PIZZA`, `address_1/2`
     = `Blvd. Los Próceres, 1ra Calle, 20 Ave. N.O., San Pedro Sula, Cortés, Honduras`,
     `phone` = `(504) 9373-6607 / 9251-0352`, `email` = `sherpasderl@gmail.com`.
   - `seed_factura_config.js` self-aborts if `seq.last_reserved >= range_start` (never
     clobbers a live counter).

2. **Store a server-priced structured `items[]` on every order** (required — the allocator
   is a DB trigger that sees only the persisted order, not the request body). In
   `createOrder`, `chargeOnlineOrder`, and the dispatcher direct-create path, persist
   `items[]` where each menu item AND each extra is its own line:
   `{ qty, description, line_gross_cents, base_cents, tax_rate }`. `base_cents` =
   tax-exclusive base (`round(line_gross / 1.15)`); the rounding residual is absorbed into
   the **last line** so that `sum(items[].base_cents) === subtotal_cents` exactly and
   `sum(line_gross_cents) === total_cents`. Also stamp `factura_status` (see §4).

3. **`allocateFacturaNumber(restaurantId, order)` — race-safe, crash-atomic, idempotent.**
   - **Phase A (claim):** `transaction()` on `/facturas/{rid}/{orderId}`. The node carries a
     `state` (`claim|reserved|issued|failed`). If `state === 'issued'` → return it
     (idempotent, no new number). A `claim`/`failed`/stale node is **reclaimable** (a
     fail-closed abort never masquerades as an existing factura). Winner writes `state:claim`.
   - **Phase B (reserve number — atomic, monotonic, crash-auditable):** `transaction()` on
     `/restaurants/{rid}/factura_config/seq` (`{ last_reserved, pending:{} }`). In ONE
     transaction: if `pending[orderId]` already exists → return it (idempotent reservation);
     else `reserved = last_reserved + 1`; **integrity-fail-closed** — abort (no reserve) if
     `reserved > range_end` OR today (America/Tegucigalpa) > `fecha_limite`, alert
     immediately; else **set `last_reserved = reserved` AND `pending[orderId] = reserved` in
     the same transaction**. Because `last_reserved` is a monotonic high-water mark advanced
     inside the transaction, two concurrent reservations can never read the same value or
     reserve the same number. **A reserved number is permanently consumed** — never reused,
     even if the order later fails (a gap is audited as void/abandoned, never backfilled).
   - **Build + commit:** write the full factura record (`state:issued`) with the reserved
     number — snapshot emisor identity + CAI/range; money **verbatim** from the order
     (`subtotal` ← `subtotal_cents`, `isv_15` ← `tax_cents`, `isv_18`/exento/exonerado = 0,
     `total` ← `total_cents`); the structured `items[]`; `forma_de_pago` (`EFECTIVO` cash /
     `TARJETA` card_delivery+online), `cambio` (cash only = `cash_tendered_cents −
     total_cents`, else 0), `cliente`/`rtn_cliente` per D3, `pedido`, `is_temp`,
     `fecha`/`hora` (America/Tegucigalpa 12-h), `printed:false`, `void:false`. Then clear
     `seq.pending[orderId]` (the issued record is now the audit home for that number;
     `last_reserved` is **never** moved backward) and flip the order `factura_status:issued`.
   - **Cancelled before issuance ⇒ no factura** (domain-owner rule, R6): a factura documents
     a consummated Sale. If the order is already cancelled when the allocator runs
     (`status:'cancelled'` / `factura_status:'cancelled'`), do **not** reserve or issue a
     number — set `factura_status:'cancelled'` and stop (handled as a plain cancellation; for
     cash/card_delivery no money/goods were exchanged, and a paid online order is refunded by
     `cancelPaidOrder`). **Race guard:** if the allocator had *already* reserved/issued a
     number the instant the cancel landed, it must `void:true` that issued number (a consumed
     SAR number can't be un-issued).
   - **Recovery:** the reconciler (§9) reconciles each `seq.pending[orderId]` to a terminal
     audit record — completing the issued/void record for that reserved number, or recording
     it as an audited abandonment. It never releases a number for reuse and never lowers
     `last_reserved`.

4. **Allocation fires from ONE DB trigger** `allocateFacturaOnSale` on `/orders/{orderId}`
   (`onValueWritten`, mirroring the existing `materializeOnConfirm`):
   - **Eligibility predicate (narrow — Sale-state only, NOT field presence):** `status ===
     'new'` AND (`payment_method !== 'online'` OR `payment_status === 'confirmed'`) AND
     `factura_status ∈ {not_due, pending, failed}` AND `created_at >= FACTURA_LAUNCH_CUTOFF`
     (so pre-launch / legacy orders are never retro-issued). Field presence is checked
     *inside* the handler, not in the predicate — otherwise a fiscal-fields-missing order
     would be excluded and never marked failed.
   - **Then branch inside the handler:** if the required fiscal fields (`total_cents`,
     `subtotal_cents`, `tax_cents`, structured `items[]`) are missing ⇒ set
     `factura_status:failed` + alert (never a silent skip); else ⇒ allocate.
   - This single trigger uniformly covers **all** sale routes — `createOrder` (cash/
     card_delivery), every online materialize path (`confirmAndMaterialize`,
     `resolveManualReconciliation`, `materializeOnConfirm`), and the dispatcher direct-create
     (subject to R5) — so no individual code path needs a hook and `createOrder`'s
     early-idempotent-return is irrelevant.
   - `factura_status` lifecycle: **defaults `not_due`** at order write; trigger sets
     `pending` → `issued`/`failed`. Non-blocking — a failure never affects the customer order.

5. **`voidFactura(orderId)` via a DB trigger** on `/orders/{orderId}/status` → `cancelled`:
   - If a factura was already issued (`state:issued`) → set `void:true` + `void_reason` +
     `voided_at`; reserved number retained, never recycled.
   - If no factura issued yet → set `factura_status:'cancelled'`. No factura is owed (R6).
     The allocation trigger only fires on `status:'new'`, so a cancelled order won't be
     issued one; the allocator's race guard (§3) voids any number that slipped through.
   - Idempotent. Catches all cancel paths (server `cancelPaidOrder`,
     `resolveManualReconciliation`, AND the dispatch-app client-side cash cancel) by
     construction.

6. **`factura_renderer.js` — pure ESC/POS renderer**, replicating the La Musa "Soft
   Restaurant V11" template field-for-field (already SAR-accepted for this Merchant):
   header (brand/legal/RTN/address/email/phone/CAI), `PEDIDO` in place of MESA/MESERO,
   `FACTURA` number, `fecha hora`, `RTN`/`CLIENTE`, per-line `CANT/DESCRIPCION/DESC%/PRECIO`
   (PRECIO = **tax-exclusive base** from `items[].base_cents`, column sums to SUBTOTAL),
   full importe block (`DESC GENERAL`, `DESC. Y REB.`, `IMPORTE EXONERADO/EXENTO`,
   `IMPORTE GRAVADO 15%/18%`, `ISV 15%/18%` — 18%/exento/exonerado = `L0.00` for X. Pizza),
   `SUB TOTAL`/`ISV`/`TOTAL`, **`SON:` amount-in-words** (Spanish `LEMPIRAS NN/100 M.N.`),
   `FORMAS DE PAGO`, `CAMBIO`, `FECHA LIMITE`, `RANGO AUTORIZADO DESDE/HASTA`,
   `NO. CORRE…/REGISTRO SAG` labels, footers (`GRACIAS…`, `ORIGINAL CLIENTE-COPIA OBLIGADO
   TRIBUTARIO`, `PROPINA NO INCLUIDA`). Two copies (D4). `is_temp` → stamp `*** FACTURA DE
   PRUEBA / NO VALIDA FISCALMENTE ***`. Pure — record → ESC/POS Buffer.

7. **`print_agent.js` (Surface Pro, NSSM service).** Watches `/facturas/x_pizza` via
   `child_added`/`child_changed`. Before printing, **acquire a transactional `print_claim`**
   `{owner, claimed_at, expires_at}` on the record — only the claim winner sends bytes
   (prevents double-print from duplicate listeners/agents/restart). Raw ESC/POS over WinUSB
   (`usb` npm + Zadig, VID `0x04B8`, PID Zadig-verified). On success `printed:true` +
   `printed_at` + clear claim; on failure `print_error`, release claim, leave
   `printed:false`. Expired claims are reclaimable.

8. **Order-form patch (`xpizza-orders/index.html`)** — two additions:
   - **RTN block** (checkbox "Necesito factura con RTN" → reveals `razón_social` +
     `rtn_cliente`, validate `/^\d{14}$/`); payload carries both (default `''`).
   - **Cash-change capture** — only when `payment_method = 'cash'`: quick-pick bills
     `≥ total` + "Pago exacto / no necesito cambio" + free numeric fallback; payload carries
     `cash_tendered` (lempiras). Server stores `cash_tendered_cents` (integer centavos),
     **validates `cash_tendered_cents ≥ total_cents`** (never trusts client), computes
     `cambio_cents`. Non-cash → no field, `CAMBIO L0.00`.

9. **Reconciler + alerts** (scheduled, mirrors `refundReconciler`): retry/complete
   `factura_status: pending|failed` **filtered to Sale state** (never `not_due`/cancelled);
   complete orphaned claim stubs; alert on stuck facturas, low remaining range, and
   near-`fecha_limite`.

10. **Security rules + credential model** (`database.rules.json`). Concrete:
    ```json
    "facturas":        { ".read": false, ".write": false },
    "restaurants":     { "$rid": { "factura_config": { ".read": false, ".write": false } } }
    ```
    - **Print agent** uses the **Admin SDK** (service account) → bypasses rules entirely; it
      is the only fiscal writer besides Cloud Functions. No client ever reads/writes
      `/facturas` or `factura_config`.
    - **Dispatcher console** reads facturas for the order it's viewing via an **authed
      callable** (`getFactura`), not a direct RTDB read (rules deny clients).
    - **KDS "Reimprimir"** calls a **dispatcher/KDS-gated callable** (`requestReprint`,
      auth-checked with the same `assertDispatcher`-style gate used by `cancelPaidOrder`)
      that server-side sets `printed:false`. No raw client write to fiscal records.

11. **Go-live (CAI swap).** Set real `cai_code`/`establecimiento`/`punto`/`tipo`/`prefix`/
    `range_start`/`range_end`/`fecha_limite` (ISO), `is_temp:false`, AND **set
    `seq = { last_reserved: range_start - 1, pending: {} }`** (temp test numbers are
    meaningless — the one allowed reset; "never reset" applies only between two *real*
    ranges, and only when `pending` is empty). Verify one real print. Zero code.

## Key decisions & tradeoffs

- **Single DB-trigger allocation** (`allocateFacturaOnSale`) covers every sale route incl.
  online recovery + dispatcher direct-create — see
  [ADR-0003](docs/adr/0003-factura-allocation-lifecycle-and-fail-closed.md). Supersedes
  handoff D1 (online) and §6 (silent failure).
- **Concurrency-safe, crash-auditable allocation:** claim the factura node by transaction
  (`state` gates idempotency), then reserve a number by advancing a single monotonic
  `seq.last_reserved` AND recording `seq.pending[orderId]` in the *same* transaction — so
  concurrent allocators can never reserve the same number, and no number is consumed without
  an audit tie. A reserved number is permanently consumed. **Cancelled before issuance ⇒ no
  factura** (R6: not a consummated Sale); cancelled **after** a number was issued ⇒ that
  number is **voided** (never recycled). A race-issued number into a just-cancelled order is
  voided.
- **Facturas nested `/facturas/{restaurant_id}/{order_id}`** for print-agent locality —
  [ADR-0004](docs/adr/0004-facturas-nested-per-restaurant.md). Deviates from ADR-0001.
- **Money verbatim from the order's cents fields; renderer does no tax math.** Structured
  `items[]` carries tax-exclusive `base_cents` reconciled so the PRECIO column sums exactly
  to `subtotal_cents`; extras are their own lines; residual centavo absorbed into the last
  line. Single bottom ISV summary.
- **One legal identity, per-establecimiento address/CAI/range.** X. Pizza gets its own
  CAI/range, never sharing La Musa's external-POS range.
- **`factura_status` (`not_due|pending|issued|failed|void|cancelled`)** is the queryable
  truth; reconciler + proactive alerts ⇒ "never run out of valid facturas," while
  `not_due` keeps abandoned `pending_payment` carts out of issuance.
- **Cash-change capture** (`cash_tendered_cents`/`cambio_cents`) so drivers carry exact
  change from the single X. Pizza cash source.

## Risks / open questions

- **R1 — Print agent unvalidatable without hardware.** ESC/POS width, encoding (acentos/ñ),
  USB transfer only surface on the physical Epson. Renderer testable offline; PID
  Zadig-verified before first run.
- **R2 — Mid-print crash double-print** mitigated by the `print_claim` transaction; a crash
  after bytes-sent-before-mark still risks one duplicate copy (same number — not a fiscal
  error). Accepted.
- **R3 — Sequence transaction abort propagation** (handoff R7): the fail-closed abort path
  needs a unit/integration test confirming a clean reject, not a hang.
- **R4 — Amount-in-words + date-boundary correctness:** unit-test `SON:` edge values
  (centavos, "UN MIL", gender) and `fecha_limite` boundary days in America/Tegucigalpa.
- **R5 — RESOLVED: dispatcher `createOrderWithTasks` is test-only.** Its sole caller anywhere
  is `xpizza-reference/test-harness.html`; no production console invokes it. Not a real fiscal
  sales channel — the trigger's "missing fiscal fields ⇒ failed + alert" is the safety net if
  it is ever exercised. No server-priced callable needed for launch.
- **R6 — Pre-issuance cancellation = no factura (adopted; counsel to confirm).** Domain-owner
  rule: a factura documents a consummated Sale, so an order cancelled before its number is
  issued gets none (handled as a cancellation); only an already-issued number is voided. Holds
  across payment types — cash/card_delivery take money at delivery (after the factura), and a
  paid online order cancelled is refunded by `cancelPaidOrder`. **Confirm with accountant**
  that pre-issuance cancellation is not a reportable Sale; if it is, revert to issue-and-void.
- **R7 — `firebase-functions` version** lacks `defineSecret` (handoff R4); fine — factura
  config is non-secret RTDB.
- **OQ — placeholder CAI/range values** for the temp seed (any valid-shaped dummy).
- **OQ — `NO. REGISTRO SAG` / exonerada lines** print as empty labels unless SAR assigns
  values (matches sample receipts).

## Out of scope

- Per-item tax rates with real 15%/18% values (La Musa multi-rate) — X. Pizza is 15%-only;
  renderer prints 18% lines as `L0.00` so La Musa needs no renderer change later.
- Broader config-plane / multi-tenant `restaurant_id`-on-orders migration (ADR-0001/0002) —
  factura uses hardcoded `'x_pizza'` until then.
- Migrating La Musa factura issuance onto this platform (stays on Soft Restaurant V11).
- Driver name on factura (accepted empty); tips beyond the footer text.
