# X. Pizza Last Mile Delivery Platform

The shared delivery platform behind X. Pizza (and, per the La Musa integration, a second
restaurant). One Firebase project: RTDB write model, cloud-function order intake, and a
set of role-specific web apps (order form, dispatcher console, KDS, driver app, tracker).

## Language

**Restaurant**:
A vendor whose orders flow through the platform — currently X. Pizza, soon La Musa
Gastropub. Each Restaurant has its own hub location, hours, menu (with its own
server-side prices + per-item tax rates), and WhatsApp line. It does NOT have its own
payment merchant — the Merchant is shared (see Merchant). Identified everywhere by a
`restaurant_id` string (`x_pizza`, `la_musa`).
_Avoid_: tenant, brand, store, location (each means something narrower or vaguer).

**restaurant_id**:
The canonical Restaurant identifier carried on every Order and used to route it to the
correct hub, KDS, and WhatsApp line. Lowercase snake_case. Note: it does NOT select a
payment merchant — there is only one (see Merchant).

**Merchant**:
The legal payment entity — **Sherpa S. de R.L.** — that owns both Restaurants. One RTN,
one bank account, one PixelPay account. Both X. Pizza and La Musa Orders charge through
this single Merchant; the [[Restaurant]] is a layer *below* the Merchant. Per-Restaurant
P&L is therefore a reporting concern (filter by `restaurant_id`), not a payment-rail one.
_Avoid_: account, business (ambiguous between Merchant and Restaurant).

**Hub**:
The physical pickup location of a Restaurant (lat/lng + geofence radius). Drivers are
dispatched *from* the Hub of the Order's Restaurant. Distinct from the customer's
delivery address.
_Avoid_: store, restaurant location, origin.

**Order-creation path**:
A server-side route that writes an Order into RTDB. There are three, NOT one — and all
three must stamp and validate `restaurant_id`:
  1. **createOrder** — cash / non-online orders; writes `/orders`, `/tasks`, `/order_tracking` in one atomic update.
  2. **chargeOnlineOrder** — writes the hidden `pending_payment` Order before the card is charged.
  3. **confirmOnlinePayment → materialize** — promotes a paid Order to live (`status: new`) and creates its tasks + tracking token.
_Note_: the *order form* performs **zero** client-side RTDB writes — all customer orders
go through the three server-side paths above. The one exception is `createOrderWithTasks()`,
a dispatcher-only SDK helper that writes an Order directly from the browser (manual entry /
test harness); it bypasses server pricing/tax/idempotency and so must still stamp
`restaurant_id` + hub snapshot and stay dispatcher-gated. "Direct-write model" in older docs
refers to the order form's modal UX (build-and-submit vs. staged commit), NOT a client→RTDB write.

**Materialize**:
The act of turning a paid-but-hidden `pending_payment` Order into a live Order visible to
KDS/dispatcher/driver, creating its delivery tasks and public tracking token.

**Config plane**:
The `/restaurants/{id}/identity` subtree — each Restaurant's non-secret identity (name, hub
coords, phone, WhatsApp instance, hours, active, version), client-readable by authenticated apps
and dispatcher-writable. It lives under the `/restaurants/{id}` node, whose sibling
`/restaurants/{id}/factura_config` (fiscal: CAI/sequence) is **not** part of the config plane and
stays Admin-SDK-only. Apps read identity from here, not from in-code constants.

**Factura**:
The SAR-authorized fiscal sales document Honduras law requires for **every** Sale (one per
Order — see [[Sale]]). Physical printed, paper-based (not electronic/FEL), drawn from a
SAR-authorized sequential number [[Range]] under a [[CAI]]. Issued (allocated) when an
Order becomes a real Sale, never recycled — a Sale that is cancelled after issuance is
[[Voided]], not un-numbered.
_Avoid_: invoice, receipt, recibo (the customer-facing order confirmation is not a Factura).

**Sale**:
The fiscal event a [[Factura]] documents — an Order that has become a real, consummated
transaction. A cash/`card_delivery` Order reaches Sale state at creation; an `online` Order
only once its card capture is confirmed (at [[Materialize]]), NOT while it is a hidden
`pending_payment`. This is why allocation fires when an Order enters Sale state, never at
pending_payment. An Order **cancelled before its Factura number is issued** is treated as
never-consummated — no Factura is owed (cash/card_delivery took no money, a paid online Order
is refunded); only an **already-issued** number must be [[Voided]] (a consumed SAR number
cannot be un-issued).

**CAI**:
The SAR "Código de Autorización de Impresión" — the authorization under which a [[Range]]
of factura numbers may be issued, with an expiry date (`fecha_limite`). Issued **per
establecimiento / punto de emisión**, so each [[Restaurant]] has its OWN CAI + Range +
sequence counter (X. Pizza's is distinct from La Musa's, which is owned by a separate
external POS — two systems must never share one Range). The [[Merchant]]'s legal identity
(`legal_name`, `rtn`) is shared across all CAIs; the address/phone shown on the factura are
per-establecimiento. Held in `/restaurants/{id}/factura_config`.

**Range**:
The contiguous block of authorized sequence numbers (`range_start`..`range_end`) a [[CAI]]
permits. A single monotonic high-water counter `seq.last_reserved` is advanced by an atomic
RTDB transaction that, in the same transaction, records `seq.pending[orderId]` — so a
reserved number is tied to its Order atomically and two allocators can never take the same
number. Each reserved number is **permanently consumed** (never reused — a gap is audited as
void/abandoned, never backfilled). Exhaustion (`last_reserved` at `range_end`) or passing
`fecha_limite` means no more facturas may be issued under that CAI (fail-closed).

**Forma de Pago**:
The factura's payment-method line. Derived from the Order's `payment_method`:
`cash` → `EFECTIVO`; `card_delivery` and `online` → `TARJETA`. Fixed at issuance, never
patched later.

**Cash tendered / Cambio**:
For `cash` Orders only, `cash_tendered` is the bill amount the customer says they will pay
the [[Driver]] with, captured on the order form (validated `>= total`, server-rechecked).
`Cambio` (change) = `cash_tendered - total`, printed on the [[Factura]]. Its operational
purpose: X. Pizza is the single cash source, so Drivers are handed exactly each customer's
change and need no end-of-shift cash reconciliation. Card/online Orders print `Cambio` 0.

**Factura status**:
The per-Order lifecycle of its [[Factura]]: `not_due` (default at order write — not yet a
[[Sale]], e.g. an online `pending_payment` cart; never reconciled), `pending` (is a Sale,
issuance in progress/queued), `issued` (number reserved + full record written — the ONLY
state treated as idempotent success), `failed` (allocation errored; reconciler retries),
`cancelled` (Order cancelled before a number was issued — **no Factura owed**, handled as a
plain cancellation), `void` (issued then cancelled — the reserved number is voided, see
[[Void (factura)]]). Makes "which Sales lack a Factura" a queryable state, not a log line.
A reconciler advances `pending`/`failed` (filtered to Sale state, never `not_due`/`cancelled`);
exhaustion/expiry fails closed and alerts rather than issuing an invalid number.

**ISV**:
Honduras "Impuesto Sobre Ventas" (sales tax), tax-**inclusive** — already embedded in the
displayed menu price. The platform breaks it out of the total (`tax_cents`, a single 15%
rate). Multi-rate (food 15% / alcohol 18%) is **not** a platform concern: the only multi-rate
Restaurant, La Musa, issues its facturas through its own Soft Restaurant POS (staff-entered)
and does NOT use the platform [[Factura]] pipeline — see ORDER_FORM_FEATURES.md §5.

**Void (factura)**:
Marking an issued [[Factura]] `void: true` when its [[Sale]] is cancelled. The SAR sequence
number is retained in the audit trail — never recycled or reused. Distinct from a PixelPay
payment void/refund, which moves money; a factura void is a fiscal-record state only.

**Unified dispatcher**:
One dispatcher console showing both Restaurants' Orders in a single subscription,
distinguished by a Restaurant column/badge — as opposed to one console per Restaurant.

**Driver**:
A courier who delivers Orders. Identified by Firebase Auth UID; record at `/drivers/{uid}`.
One Driver fleet serves every [[Restaurant]] (not partitioned per Restaurant).
_Avoid_: rider, courier — use Driver consistently.

**Shift**:
A Driver's on-duty period, opened by `startShift` (`active: true`, `status: available`)
and closed by `endShift`. A Driver is only assignable Orders while on Shift. Distinct from
being [[Reachable]].

**Reachable**:
The actual gate on whether dispatch assigns a Driver an Order: on [[Shift]] **and** holding
a valid push token. Push-reachability — NOT GPS freshness — decides assignability; a Driver
with stale or absent GPS is still assignable (sorted as if at the [[Hub]]). Renders green on
dispatch when Reachable, grey when not.
_Avoid_: online, available ("available" is one narrower `status` value).

**Native driver app**:
The Capacitor-wrapped build of the Driver app (package `hn.sherpa.driver`), as opposed to
the browser PWA. It exists to win two things the web platform cannot: continuous
**background location** and reliable **native push** (FCM). Inside it, browser Web Push is
dead and WebView network requests are throttled when backgrounded — so both push and the
location write must travel native paths, not WebView JavaScript.

**Location ingest**:
The native-to-server path carrying a Driver's background location off the device without
WebView JavaScript: a native HTTP uploader → the `ingestDriverLocation` Cloud Function →
a write to `/drivers/{uid}`. Replaces the PWA's direct client RTDB write, which freezes
when the app is backgrounded. The ingest function is also where the geofence state machine
runs server-side for [[Native driver app]] drivers.
