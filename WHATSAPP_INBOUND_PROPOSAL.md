# Per-restaurant inbound WhatsApp auto-reply (PLAN)

_Executor build for the auditor + Codex gate. Touches LIVE X. Pizza inbound — the x_pizza path is
byte-identical to today EXCEPT one intended URL change. Approach approved by the auditor relay._

## Goal
When a customer texts a restaurant's WhatsApp number, the auto-reply points them to **that restaurant's**
order form: X. Pizza → `orders.xpizza.hn` (migrated from `xpizzaorders.netlify.app`), La Musa →
`orders.lamusa.hn`. Currently `onIncomingWhatsApp` + `whatsapp_inbound.js` are hardcoded to X. Pizza.

## The 4 conditions (from the relay) — all addressed
1. **la_musa hours** — read **`identity.hours` live** (single source, no hardcoded duplication → no drift).
   `hoursFromIdentity()` converts the config shape (`{mon:{open,start,end}}`) to the inbound day-index
   shape. And the underlying hours were corrected (see below): **only Monday closed** now.
2. **PixelPay return URL** — **decoupled + untouched**. `pixelpay-return-url.js` (fallback) unchanged;
   the `PIXELPAY_RETURN_URL` env migration is a separate operator `gcloud` step, gated on confirming
   `orders.xpizza.hn` serves the identical `handlePaymentReturn`. NOT part of this deploy.
3. **Function count** — live = **31** (`logOrderLifecycle` already deployed); this change adds **no new
   export** → **31→31, zero-prune**. Source completeness re-checked at deploy.
4. **`ORDER_FORM_URL` → `orders.xpizza.hn`** — the one intended X. Pizza diff. Both domains verified live (HTTP 200).

## Design
- **`whatsapp_inbound.js`** — `CONFIG_BY_RESTAURANT` map (`orderFormUrl`, `trackingBase`, `restaurantName`,
  `ackEmoji`), mirroring `BRAND_BY_RESTAURANT`. `resolveInboundRestaurant(raw)` fail-safes absent / empty /
  unknown / non-string → `x_pizza`. `configFor(rid)`. `hoursFromIdentity(identityHours)`. All 5 templates
  now take `cfg`. `getHoursStatus(refDate, hoursMap = HOURS)` — the default preserves x_pizza byte-identity.
- **`onIncomingWhatsApp`** — resolves `restaurantId` from `?restaurant=` (default x_pizza), then threads it:
  `isEnabledForRestaurant(db, rid)` (x_pizza ≡ `isEnabled(db)`), identity-hours read for non-x_pizza,
  status-lookup re-scoped off the hardcoded `x_pizza` to `restaurantId`, templates get `cfg`,
  `sendMessage(..., restaurantId)` routes via the restaurant's UltraMsg instance.

## X. Pizza byte-identity (golden-proven)
`whatsapp-inbound.test.js` (30 cases) asserts each x_pizza template equals the exact current text **except**
the order-form URL; the resolver fail-safes to x_pizza (incl. non-string injection); `getHoursStatus()` with
no map falls back to the x_pizza HOURS. `npm test` green; the wider suite (whatsapp-config 32, etc.) green.

## Hours correction (done, alongside — user request "only Monday closed")
- `identity.hours.tue` → `{open:true, start:"17:00", end:"20:45"}` (prod config, applied + verified).
- `la-musa-orders/index.html` HOURS `2:` (Tuesday) → open 17:00-20:45 (order-form gate; **needs a Netlify
  deploy of `la-musa-orders/` to go live**).

## Files
`whatsapp_inbound.js` (+70/−38), `index.js` (+50, onIncomingWhatsApp only), `package.json` (+test),
`whatsapp-inbound.test.js` (new, 30 cases), `la-musa-orders/index.html` (+Tuesday hours, separate Netlify deploy).

## Deploy + wiring (post-gate)
- **31→31 functions deploy** (zero-prune; name-set add-set empty, prune-set-of-existing empty).
- **Operator wires** the la_musa UltraMsg instance webhook →
  `…/onIncomingWhatsApp?secret=<WHATSAPP_WEBHOOK_SECRET>&restaurant=la_musa` (same shared secret; already
  on all services). X. Pizza's webhook is untouched.
- Separate: Netlify deploy of `la-musa-orders/` (Tuesday hours); the PixelPay env migration (op step #2).

## Residual risks / notes
- Classifier keywords are pizza-centric; a la_musa-specific term (e.g. "dim sum") → UNHANDLED, which still
  returns the order-form link. Acceptable for Phase 1 (all buckets point to the form).
- Identity-hours read miss → generic closed reply (still gives the link). No hardcoded la_musa fallback (by
  design — single source).
- The order form uses its OWN hardcoded HOURS (separate from identity); the auto-reply now reads identity, so
  auto-reply ↔ identity can't drift, but order-form ↔ identity can (pre-existing; both corrected here).
