# Proposal B2 (Rev 2) — La Musa order form: hosted-checkout wiring + parity (+ a small server slice)

_Executor → Auditor + Codex. Rev 2 folds the gate findings: there is **no separate PixelPay
instance** (global creds, one account — Finding A), but online needs a **server return-URL slice**
(Finding B) plus C–J. Restructured into three gated steps. The **only X. Pizza-touching change** is
B2-server's return URL (full golden + Codex gate); everything else is scoped to
`la-musa-orders/index.html`. La Musa stays `active:false`. Strict propose-first._

---

## Correction (Finding A): no "separate La Musa PixelPay instance"
PixelPay creds are **global `process.env`** (`pixelpay-config.js:48 resolvePixelPayConfig()` — no
`restaurant_id`; `pixelpay-hosted.js:45`). `chargeOnlineOrder` stamps `restaurant_id` but selects
merchant creds by **neither** — it issues the hosted checkout on the **single Sherpa account for any
restaurant** (the locked plan: one account, both restaurants; per-restaurant is **reporting-only**
`restaurant_id` tagging). So La Musa online is **not** blocked on a missing instance — it charges on
the one account once `active:true`. (Per-restaurant accounting is an optional future decision only.)

## Real online prerequisites
1. **B2-server return-URL fix** (below), 2. the **`…daFJXU` referrer allowlist** for the La Musa
origin, 3. the **La Musa Netlify site**. **Cash has zero server prerequisites** (`createOrder` is
restaurant-agnostic + active-gated). → B2a is **not cash-first-only**; online is wireable, gated only
on this small server slice + the origin existing.

---

## Three gated steps

### B2-server — restaurant-aware hosted-checkout return URL (Finding B) — *X. Pizza-touching, golden+Codex gated*
`siteBase` is a **single global** (`index.js:820`: `process.env.PIXELPAY_RETURN_URL ||
'https://xpizzaorders.netlify.app'`), used for `completeUrl`/`cancelUrl` (`:821-822`). A la_musa
online order would redirect the customer **back to the X. Pizza site**, which can't read the La Musa
`localStorage` stash → wrong origin, broken return/retry.
- **Fix:** after `resolveRestaurantId` (A3), select the return base **per restaurant** — `la_musa`
  → `PIXELPAY_RETURN_URL_LA_MUSA`; **`x_pizza` → the existing global default, byte-identical.**
- **FAIL-CLOSED (binding, gate constraint 1 / ADR-0002):** if `PIXELPAY_RETURN_URL_LA_MUSA` is
  **unset**, a la_musa online order **must reject** (not fall back to the X. Pizza origin — that
  would silently mis-route the customer to the wrong site). The golden **asserts missing-env →
  reject**. x_pizza is unaffected (its default is intrinsic, not env-dependent).
- Gated exactly like A1–A3 (golden + Codex); x_pizza return URL provably unchanged.
- **Optionally fold Finding I here** (make the `:813` email fallback `pedidos@xpizza.hn`
  restaurant-aware) — or keep it form-side (see B2b). Recommend keeping I **form-side** to keep
  B2-server minimal (return URL only).

### B2a — form: payment re-architecture + wiring + cambio
Front-end only (`la-musa-orders/index.html`). Mirrors the live X. Pizza form.
- **Endpoints + auth:** `CREATEORDER_URL`, `CHARGEORDER_URL`, **and `PAYMENTSTATUS_URL`** (the poll
  endpoint — the X. Pizza form has it at `:1239`; **Finding C**). Same Cloud Functions as X. Pizza
  (Phase 1 routes by `restaurant_id`). Bearer `ORDER_SECRET` (public-by-design). Replaces the
  `TODO_LM_*` block.
- **Cash/pickup** → POST `createOrder` (Bearer, idempotent retry on `order_id`). Replaces
  `submitOrder`→Make.com.
- **Online** → POST `chargeOnlineOrder` → server returns **`{ checkout_url, order_id, poll_token }`**
  (Finding D — **not** "SDK config"; there is **no browser SDK** in the hosted flow); handle
  `202`/in-progress retry; stash `{order, poll_token}` in `localStorage`; redirect to `checkout_url`
  (card+3DS **off-site**); `handlePaymentReturn` polls `PAYMENTSTATUS_URL`. Replaces `processPixelPay`.
- **REMOVE (Finding E):** `validateCardForm` + the inline card fields (`card-number/expiry/cvv`),
  **the dependent card-formatting code**, `/api/pixelpay-charge`, the Make.com `submitOrder` webhook,
  the `TODO_LM_PIXELPAY_KEY` demo simulate, **and the stale "directamente en este formulario" copy**.
  Raw PAN never touches the browser.
- **`payment_method` (Finding F):** the server **silently blanks** an invalid value (`:277`), not
  rejects → the form must emit only `cash` / `card_delivery` / `online` (confirm `selectPay` values
  at impl).
- **Cambio + `cash_tendered` (Finding G):** add the cash-change panel/chips/`onCashTenderedInput` and
  **emit `cash_tendered`**. Note: **not** a hard server requirement — `createOrder` **defaults to
  exact** if missing (`:496`); it's **required for cambio parity** (driver change), not for the order
  to succeed.
- **Already satisfied:** `restaurant_id:'la_musa'`, `item.id`, `extras:[{id,qty}]` (server prices/
  routes/stamps via A1/A2/A3/B1; ignores client `name`/`price`).

### B2b — form: email + RTN + retry-restore + styling
- **Email:** `tu correo` field + the `input[type=email]` selector fix + a **La Musa fallback when
  blank, sent form-side** (keeps it front-end; the server's `:813` default is `pedidos@xpizza.hn` —
  Finding I). The chargeOnlineOrder payer email uses what the form sends.
- **RTN (Finding H):** `toggleRtn` + `razon_social`/`rtn_cliente`, and **the form enforces 14 digits
  when toggled** (mirror X. Pizza `rtnIsValid()`) — the server **silently drops** an invalid RTN
  (`:291`), it does not reject, so client-side validation is the real guard. Relayed as order data
  for Soft Restaurant POS (not a platform factura).
- **Retry-restore:** `snapshotForm`/`restoreOrderForm` — **load-bearing**: the hosted-checkout
  redirect wipes the in-memory cart/form (the return page and a failed-payment retry both need it).
- **Styling:** `--red` (not the undefined `--brand-red`), `input[type=email]` in the field selector.

---

## Testing (Finding J)
B1's **menu-parity** test already guards form `MENU`/`EXTRAS` ⇔ server tables. The
**emulator-e2e is x_pizza-hardcoded** and online is exercised **helper-level** (not full HTTP), so a
la_musa mode is **not a trivial extension** — build a **true `la_musa` mode**: la_musa item ids +
extras, **seed `la_musa` active**, assert cash `tax_cents:0` + correct pricing/stamp; for online,
drive it via a **hosted-create stub / no-egress seam** or an explicit **helper-level pending** (as
the existing `pending` mode does). This is the pre-deploy handler-level proof, no prod touch.

## Dependencies / out of scope
La Musa Netlify site (explicit `--site`), WhatsApp (UltraMsg La Musa instance),
`createOrderWithTasks` restaurant-awareness, `la_musa.active=true` (launch). X. Pizza form untouched;
server changes beyond B2-server are done (Phase 1 + B1).

**Launch-gate verification (constraint 2, not a B2 change):** the La Musa form loads **two** keyed
APIs — the **Firebase browser key** (`…daFJXU`, RTDB/auth, per [[pixelpay-cloudflare-block]]) **and a
Maps key** (`…D_Y0A`, geolocation). **Both** must have the La Musa origin added to their referrer
allowlist before it goes live — verify which key each call uses against the real form before the
origin is enabled, or calls silently fail.

**Launch-gate flag (surfaced at B2a review):** `PREVIEW_MODE = true` in the form bypasses the client
open/closed schedule — **flip to `false` before launch** (self-documented in the form; the server
`active` flag is the real authority and la_musa is dark regardless, so it's a polish/UX gate, not a
safety one).

## Sub-sequence
**B2-server** (gated, byte-identical) → **B2a** (form payment + wiring + cambio) → **B2b** (form
email/RTN/retry-restore/styling).
