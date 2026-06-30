# Proposal D — Restaurant display-name slice (WhatsApp bodies + tracker branding)

_Executor → Auditor + Codex. The last HARD pre-launch code item: a per-restaurant **brand/display
name** for customer-facing copy, unifying the two deferred branding gaps (WhatsApp template bodies +
C4 tracker). Code-map design (NOT `identity.name`, which is "X Pizza" ≠ the brand "X. Pizza" —
`seed_identity.js:25`). HARD gate on `la_musa.whatsapp_enabled:true`. Strict propose-first._

---

## Design decision — code-map (recommended) vs config field
A small **code-level brand map** — `x_pizza → "X. Pizza"`, `la_musa → "La Musa"` — like
`menu-pricing.js`'s per-restaurant tables. Rationale (agreed with the gate's steer):
- Pure **presentation copy**, not routing-critical (hub/active/radius) → doesn't need the config
  plane's fail-closed/snapshot machinery.
- Avoids touching the seed + `.validate` rules + a prod re-seed (fewer live-path surfaces).
- `x_pizza → "X. Pizza"` **pins byte-identity** — the literal stays character-identical.

## Part D1 — WhatsApp template bodies (SERVER, fully byte-identical, the HARD gate)
- Add `BRAND_BY_RESTAURANT = { x_pizza: 'X. Pizza', la_musa: 'La Musa' }` + `brandFor(restaurantId)`
  (defaults `'X. Pizza'`) to `whatsapp.js`.
- Replace the **3 brand literals** with `${brandFor(restaurantId)}`: `tplOrderReceived` (`:196`),
  `tplPickupReceived` (`:221`), `tplDelivered` (`:262`). **`tplDelivered` gains a `restaurantId`
  input** (the other two already have it from C2); its caller (`sendOrderStatusNotifications`)
  passes the already-computed `restaurantId`.
- **x_pizza byte-identical:** `brandFor('x_pizza') === 'X. Pizza'` → every rendered body is
  character-identical to today.

## Part D2 — Tracker branding (SERVER stamp + CLIENT, requires one additive field)
The public tracker reads **only** `/order_tracking/{token}` (no auth → can't read `/orders`), and
that record has **no `restaurant_id`** today. So per-restaurant tracker branding **requires**:
- **(server) Stamp `restaurant_id` on the `order_tracking` record** — `create-order-build.js:103`
  and `materialize.js` (the #7-deferred tracking-stamp). **This is ADDITIVE** (a new key with the
  correct value `restaurant_id:'x_pizza'` for X. Pizza); **no existing field changes**. It is the
  **one departure from strict byte-identity** in this slice — the create-order-build / materialize
  goldens update to expect the additive field. Flagged explicitly for the gate: there is **no other
  way** to brand a public, `/orders`-unreadable tracker page per restaurant.
- **(client) `xpizza-track/index.html`** renders brand (title, `.brand-name`, `--brand*` colors)
  from `order_tracking.restaurant_id` via a parallel client brand map (`x_pizza` → current X. Pizza
  branding **visually identical**; `la_musa` → La Musa name/palette). x_pizza unchanged.

## Byte-identity summary
- **D1 (WhatsApp):** fully byte-identical (brand literal preserved for x_pizza).
- **D2 (tracker):** x_pizza WhatsApp/order paths untouched; the **only** change to x_pizza data is the
  **additive `order_tracking.restaurant_id:'x_pizza'`** (no existing field altered) — gated as an
  explicit additive exception. The tracker renders x_pizza visually identical.

## Testing
- `whatsapp.js` brand golden: `brandFor('x_pizza') === 'X. Pizza'`, `brandFor('la_musa') === 'La Musa'`,
  default → `'X. Pizza'`; the 3 templates render the x_pizza brand byte-identical and the la_musa brand.
- `create-order-build` / `materialize-snapshot` goldens updated for the additive
  `order_tracking.restaurant_id` (x_pizza value `'x_pizza'`, la_musa `'la_musa'`).

## Flagged (secondary, NOT display-name — for the gate to scope)
- **Food-noun copy:** `tplDriverAssigned` ("¡Tu **pizza** está lista! 🍕") and similar use "pizza"
  as a food noun — wrong for La Musa. This is la_musa-appropriate **template copy**, distinct from
  the brand-NAME primitive. Recommend a **follow-up copy slice** (not D); D keeps the templates
  byte-identical for x_pizza apart from the brand swap.
- **la_musa tracker assets:** the La Musa palette/logo for the tracker (its own brand colors) — needs
  La Musa brand assets; placeholder until provided.

## Decomposition
**D1** (WhatsApp brand map — HARD gate, fully byte-identical) → **D2** (order_tracking stamp + tracker
branding — the additive-field exception + the client work). D1 can land/deploy independently; D2's
server half batches into the deploy.

## Out of scope
C3 dispatcher; the food-noun copy slice; `active:true`; ops/config launch gates.
