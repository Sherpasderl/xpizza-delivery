# Proposal C2 — WhatsApp per-restaurant instance + tracker link (SERVER + ops)

_Executor → Auditor + Codex. Makes customer WhatsApp notifications restaurant-aware: the UltraMsg
**instance/token** AND the **tracking link** must match the order's restaurant, not X. Pizza's
globals. **X. Pizza byte-identical.** HARD pre-launch gate. La Musa stays dark
(`whatsapp_enabled:false`) until ops provisions its instance. Strict propose-first._

---

## Current state (grounded)
- `whatsapp.js:27-28` — `INSTANCE_ID`/`TOKEN` from a **single global env** (x_pizza's
  `instance170156`); `API_BASE` (`:29`) built from it.
- `whatsapp.js:37` — `TRACKING_BASE` **hardcoded** `https://xpizzatrack.netlify.app`; used by
  `trackingUrl(token)` (`:137-138`), which every template embeds.
- `sendMessage(toPhone, body)` (`:68`) uses those module globals.
- Callers in `index.js` both have the order's restaurant: `createOrder` (`:551`, `restaurantId` in
  scope from A3) and `sendOrderStatusNotifications` (`:2265`, `after.restaurant_id`).

→ A la_musa order would notify from **X. Pizza's WhatsApp number** with an **X. Pizza tracker link**.

## Design
**A pure resolver** `resolveWhatsappConfig(restaurantId, env)` → `{ apiBase, token, trackingBase }`
(or `null` if unconfigured):
- **x_pizza** → existing env `ULTRAMSG_INSTANCE_ID` / `ULTRAMSG_TOKEN`, and the **hardcoded
  `TRACKING_BASE` constant** (`whatsapp.js:37` = `'https://xpizzatrack.netlify.app'`) returned
  **byte-for-byte** — **NOT** `process.env.TRACKING_BASE` (undefined → would break x_pizza links).
  **Byte-identical.**
- **la_musa** → new env `ULTRAMSG_INSTANCE_ID_LA_MUSA` / `ULTRAMSG_TOKEN_LA_MUSA` /
  `TRACKING_BASE_LA_MUSA`; `null` when unset → `sendMessage` skips (the existing missing-creds skip,
  `:69-72`) — **fail-safe**, never sends a la_musa order from X. Pizza's number.

**Threading:**
- `sendMessage(toPhone, body, restaurantId)` resolves config and uses its `apiBase`/`token`. **The
  missing-creds skip (`:69`) must check the RESOLVED config's creds, not the module globals** — for
  x_pizza the resolved creds are the globals, so identical.
- `trackingUrl(token, restaurantId)` (and the templates that call it) use the per-restaurant
  `trackingBase`. Templates gain a `restaurantId` input (thread-through; bodies otherwise unchanged).
- **All THREE `whatsapp.sendMessage` call sites** thread `restaurantId` (the proposal undercounted
  at 2), each from a **genuinely in-scope, correct** source:
  1. `createOrder` (`:551`) → the **validated `restaurantId`** (A3, in scope here). ✓
  2. `sendOrderStatusNotifications` (`:2412`) → **`order?.restaurant_id || 'x_pizza'`** from the
     **loaded order** (`order` at `:2290`), **NOT `after`** — the trigger watches
     `/orders/{orderId}/status`, so `after` (`:2272`) is the **status string**, and
     `after.restaurant_id` is `undefined` → would fail-open to x_pizza for every la_musa
     notification. Compute `restaurantId` right after the order load and use it for
     `isEnabledForRestaurant`, the templates/`trackingUrl`, and `sendMessage`. The existing
     `if (!order)` skip (`:2326`) is preserved — **don't send a notification with no order data**
     (same as today's read-failure behavior: `restaurantId` defaults to `'x_pizza'` →
     `isEnabledForRestaurant` = `isEnabled(db)`, identical, then the `!order` guard skips the send).
  3. `onIncomingWhatsApp` auto-reply (`:2615`) → `'x_pizza'` literal (see Inbound below). ✓
  x_pizza byte-identical at each (legacy/x_pizza order → `'x_pizza'` → existing instance/link/gate).

## Inbound path (the missed 3rd send site — scoped to x_pizza, leak closed)
`onIncomingWhatsApp` (`:2456`) receives messages to **X. Pizza's number** (x_pizza's UltraMsg
instance/webhook) and auto-replies via `sendMessage` (`:2615`); `whatsapp_inbound.js` hardcodes
`ORDER_FORM_URL`/`TRACKING_BASE` (x_pizza, `:18-19`) and `tplStatusCheckFound` builds
`${TRACKING_BASE}/${token}` (`:222`). **Leak:** a customer who placed a **la_musa** order then texts
X. Pizza's number → the STATUS_CHECK classifier looks up their order **by phone with no restaurant
filter** → surfaces the la_musa order in an X.-Pizza-branded reply from X. Pizza's number.
**Minimal fix (byte-identical for x_pizza, closes the leak):** **scope the inbound order lookup to
x_pizza-only** (legacy-normalized: `restaurant_id || 'x_pizza' === 'x_pizza'`) and send the reply via
`'x_pizza'`. Today every order is x_pizza, so x_pizza-scoping the lookup is byte-identical; a la_musa
order texting X. Pizza's number now falls to `tplStatusCheckNotFound` (no leak). **Full la_musa
inbound-awareness is deferred** (own instance + webhook wiring + restaurant-aware `whatsapp_inbound.js`
URLs) — its own slice, and la_musa is dark meanwhile.

## Enablement gate (gate finding — model B: per-restaurant kill switch)
**Today `whatsapp.isEnabled(db)` (`:113`, gating the sends at `:527`/`:2319`) reads ONLY the global
`config/whatsapp_enabled` flag — never the per-restaurant `identity.whatsapp_enabled`.** Without
this fix, provisioning la_musa creds would turn la_musa sends ON regardless of `identity.whatsapp_enabled`
(global flag defaults ON), and `identity.whatsapp_enabled:false` would be vestigial. Fix with a
**la_musa-scoped** gate — `isEnabledForRestaurant(db, restaurantId)`:
- **x_pizza (and any non-la_musa)** → exactly `await isEnabled(db)` then `true` → **byte-identical**
  (same single global-flag read; NO new config-plane dependency, so no new fail-closed risk for
  X. Pizza WhatsApp).
- **la_musa** → global flag **AND** a defensive read of `restaurants/la_musa/identity/whatsapp_enabled
  === true` (fail-SAFE: any read failure / not-true → skip, since sends are best-effort and must not
  throw). This makes the flag a **real per-restaurant kill switch** (creds + flag both required).
Replace the `isEnabled(db)` call at both send sites with `isEnabledForRestaurant(db, restaurantId)`.

## X. Pizza byte-identical
`resolveWhatsappConfig('x_pizza')` returns the existing env instance/token + the existing
`TRACKING_BASE`, so the API URL, token, and every tracking link are unchanged → identical sends.
The new branch is reachable only for `restaurant_id:'la_musa'`.

## Open questions (for the gate to confirm)
1. **Token model** — UltraMsg instances are each a separate WhatsApp connection with their **own
   instance_id + token**, so la_musa = a new `(instance_id, token)` pair via the `_LA_MUSA` env vars.
   Confirm this is the account model (one account, multiple instances) vs a single-instance constraint.
2. **`TRACKING_BASE_LA_MUSA` value — coupled to C4.** Its value depends on the C4 tracker decision:
   a **separate la_musa tracker site** (→ its own URL) vs **dynamic branding on the shared site**
   (→ same base, rebranded by `restaurant_id`/`restaurant_name`). C2 makes it env-driven; **the value
   is set when C4 decides.** Until then la_musa stays dark, so no link is sent.
3. **Ops provisioning + the honest launch sequence (corrected per model B)** — la_musa sends require
   **all three**: (i) provision the La Musa UltraMsg instance (QR-scan to La Musa's WhatsApp number)
   and set `ULTRAMSG_INSTANCE_ID_LA_MUSA`/`ULTRAMSG_TOKEN_LA_MUSA` (+ `TRACKING_BASE_LA_MUSA` post-C4)
   → **can-send**; (ii) `identity.whatsapp_enabled:true` for la_musa → the **per-restaurant switch**;
   (iii) the global `config/whatsapp_enabled` stays ON. With model B, the creds and the flag are
   **independent** — provisioning creds alone does NOT start la_musa sends (the flag gates them), and
   the flag is a real off-switch. HARD pre-launch.

## Testing
- New `whatsapp-config.test.js` golden: (a) `resolveWhatsappConfig` — x_pizza → existing env
  (byte-compat, asserted against the same vars), la_musa → `_LA_MUSA` env, missing → `null`;
  `trackingUrl` builds the correct per-restaurant link; (b) `isEnabledForRestaurant` — x_pizza
  resolves to exactly the global-flag result (byte-identical, no identity read), la_musa requires
  global flag **AND** identity `whatsapp_enabled:true` (with fail-safe on a failed/absent read). Use
  an injected/stub db so it's a pure unit test.
- (Follow-up, tracked) the emulator-e2e timeout-reassign coverage from C1 — and, if feasible, a
  whatsapp send-config assertion — so call-site wiring is caught automatically.

## Ops / launch gates (not C2 code)
Per model B, all three (independent): provision the la_musa UltraMsg instance + set
`ULTRAMSG_INSTANCE_ID_LA_MUSA`/`ULTRAMSG_TOKEN_LA_MUSA` (+ `TRACKING_BASE_LA_MUSA` post-C4); set
`restaurants/la_musa/identity/whatsapp_enabled:true`; keep global `config/whatsapp_enabled` ON.

## Deferred (tracked launch item — not C2)
**Full la_musa inbound WhatsApp awareness:** a la_musa UltraMsg instance + its own
`onIncomingWhatsApp` webhook wiring + restaurant-aware `whatsapp_inbound.js` (`ORDER_FORM_URL`/
`TRACKING_BASE` per restaurant). C2 only **x_pizza-scopes** the existing inbound (closing the leak);
la_musa customers can't text a la_musa number until that number/instance exists.

## Out of scope
C4 tracker (separate slice — determines `TRACKING_BASE_LA_MUSA`); C3 dispatcher; `active:true`.
