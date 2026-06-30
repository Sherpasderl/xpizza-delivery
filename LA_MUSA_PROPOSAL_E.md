# Proposal E — La Musa copy/assets (WhatsApp food-noun + tracker branding)

_Auditor-drafted spec (defaults accepted by Xavier 2026-06-30); executor implements, real diffs go through
the Codex gate. Closes the two branding deferrals carried from Proposal D. **HARD pre-launch gate — both
parts must land before `whatsapp_enabled:true`.** X. Pizza byte-identical throughout; la_musa stays dark
(`active:false` + `whatsapp_enabled:false`) until the launch flip._

---

## Why this is needed
The server surface is live-dark (deployed 2026-06-30). Two customer-facing branding gaps remain that would
make a **la_musa** notification/tracker look like **X. Pizza**:
1. The outbound WhatsApp templates hardcode pizza-flavored copy ("¡Tu pizza está lista! 🍕", the 🍕 item
   prefix) — a la_musa customer would read "tu pizza."
2. The public tracker renders X. Pizza branding; D2 built the per-restaurant override mechanism but with
   **placeholder** la_musa colors.

Both are gated by `whatsapp_enabled:true` / the la_musa launch, so they're safe to land now (dark) but
**must** be done before the flip.

**Out of scope:** the inbound classifier `whatsapp_inbound.js` (`RESTAURANT_NAME='X. Pizza'`, 🍕 replies,
pizza intent keywords) — it is **x_pizza-scoped per C2** (la_musa inbound replies forced to `'x_pizza'`;
full la_musa inbound is a separately-deferred item with its own instance/webhook). Its copy correctly
stays x_pizza. Touching it here would be wrong.

---

## E1 — WhatsApp food-noun copy (SERVER, `whatsapp.js`, byte-identical)

Three food-flavored spots in the **outbound** templates, all of which already receive `restaurantId`
(threaded in C2/D1):
- `:207` `tplOrderReceived` → `` `🍕 ${itemsText || ''}` ``
- `:232` `tplPickupReceived` → `` `🍕 ${itemsText || ''}` ``
- `:249` `tplDriverAssigned` → `` `¡Tu pizza está lista! 🍕` ``

**A bare noun-swap fails** — "pizza" is feminine (`está list**a**`); the la_musa noun "pedido" is masculine
(`está list**o**`). So use **per-restaurant copy maps** (same shape as `brandFor`, with x_pizza values =
the exact current literals so x_pizza is character-identical):

```js
// Per-restaurant customer-facing copy (E1). x_pizza values are the EXACT current literals → byte-identical.
const ITEMS_EMOJI_BY_RESTAURANT = { x_pizza: '🍕', la_musa: '🍜' };
const READY_LINE_BY_RESTAURANT = {
  x_pizza: '¡Tu pizza está lista! 🍕',     // unchanged literal
  la_musa: '¡Tu pedido está listo! 🍜',
};
function itemsEmojiFor(restaurantId) { return ITEMS_EMOJI_BY_RESTAURANT[restaurantId] || '🍕'; }
function readyLineFor(restaurantId)  { return READY_LINE_BY_RESTAURANT[restaurantId] || READY_LINE_BY_RESTAURANT.x_pizza; }
```

Wiring:
- `tplOrderReceived` / `tplPickupReceived`: `` `🍕 ${itemsText...}` `` → `` `${itemsEmojiFor(restaurantId)} ${itemsText...}` ``
- `tplDriverAssigned`: the literal `¡Tu pizza está lista! 🍕` line → `readyLineFor(restaurantId)`
- Defaults (`|| '🍕'` / `|| …x_pizza`) cover x_pizza, legacy/missing, and unknown ids → all render the
  existing literals.

**Decision locked (Xavier 2026-06-30):** la_musa emoji = **🍜**, ready-line noun = **"pedido"** ("¡Tu pedido
está listo! 🍜").

**Byte-identity:** for x_pizza/legacy/undefined, `itemsEmojiFor` → `🍕` and `readyLineFor` → the exact prior
string, so every x_pizza message body is character-identical. Only the `la_musa` branch differs (and it's
dark).

**Golden:** extend `whatsapp-config.test.js` — assert (a) x_pizza bodies unchanged (the 🍕 item prefix +
the "¡Tu pizza está lista! 🍕" line, character-for-character), and (b) la_musa bodies use 🍜 + "¡Tu pedido
está listo! 🍜".

**Deploy:** E1 is a **server** change → needs a (small) `firebase deploy --only functions` before the
`whatsapp_enabled:true` flip. Byte-identical for x_pizza, so low-risk / dark-gated — may ride a later batch.

---

## E2 — Tracker brand palette + wordmark (CLIENT, `xpizza-track/index.html`)

D2 already built `applyRestaurantBrand(restaurant_id)` — la_musa-only override, `try/catch`-bounded, x_pizza/
legacy/absent → no override → static branding byte-identical. E2 just swaps the **placeholder** la_musa
palette for the **real** one, sourced from the la_musa order form (`la-musa-orders/index.html:27,32-34`) so
the order→track experience is visually consistent:

| tracker CSS var | D2 placeholder | **E2 real (from the form's musa-red palette)** |
|---|---|---|
| `--brand` | `#B61218` | `#B61218` (musa-red — already correct) |
| `--brand-dark` | `#7d0c10` | **`#7A0A10`** (`--musa-red-deep`) |
| `--brand-light` | `#f7e7e7` | **`#F4DDDD`** (`--musa-red-soft`) |

- `.brand-name` innerHTML → `La Musa`; `document.title` → `La Musa · Sigue tu pedido` (D2 already sets these).
- **Decision locked (Xavier 2026-06-30):** use the **text wordmark "La Musa"** (no asset-hosting dependency);
  the logo image is optional polish, deferred.
- **x_pizza untouched** — `applyRestaurantBrand` early-returns for non-la_musa, so the static X. Pizza
  palette/title/wordmark are byte-identical.
- **Deploy:** Netlify tracker redeploy (no server, no X. Pizza risk).

---

## Decomposition / gate
- **E1** (server, byte-identical) → gate like D1: `npm test` goldens unchanged + the new la_musa-copy
  assertions + Codex on the real diff.
- **E2** (client tracker) → careful diff vs HEAD + Codex; no x_pizza touch, no server.
- Implement **E1 first** (it's the byte-identical server slice that batches toward the pre-flip deploy),
  then **E2** (independent Netlify redeploy).

## Out of scope
`whatsapp_inbound.js` (x_pizza-scoped; full la_musa inbound deferred) · the logo *image* in the tracker
(text wordmark accepted) · `active:true`/`whatsapp_enabled:true` (the launch flips) · all remaining ops/config.
