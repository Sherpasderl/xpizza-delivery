# X. Pizza — 18" (NY) pizzas are pickup-only (design)

_Date: 2026-07-23 · Branch: `feature/xpizza-18inch-pickup-only` (off `origin/main` 2902382) · Restaurant: **X. Pizza only** (`xpizza-orders/index.html`)_

## Goal

On the X. Pizza order form, the **18-inch NY pizzas can only be ordered for pickup**, never delivery. Set the expectation while browsing (a "Solo Pickup" badge), block the invalid combination clearly (a gate when Delivery is selected with an 18" in the cart), and guarantee it at submit. **Client-side UX only** — no money, no server change. Keep it clean of emoji per the standing form-chrome rule ([[no-cheap-emoji-in-form-chrome]]).

## What "18-inch pizzas" means (verified)

The form has two menu category tabs (`renderMenu`, tabs at HTML ~1036-1037):
- `individual` → "12 Inch Pies" (17 items) — unaffected, delivers normally.
- **`ny` → "NY Slice · 18\""** (6 items: Carnivora / Margherita / Cacio e Pepe / Mushroom / Jamón-o-Pepperoni / Crispy Bacon NY, ids 18–23) — **these are the 18-inch pizzas → pickup-only.**

So "18" = the `ny` category. The rule is data-driven so a future pickup-only category is a one-line add.

## Approach (locked): Approach B — badge + gate + submit safety net

The customer builds the cart in Paso 1 (menu), then chooses Delivery/Pickup in Paso 2 (`setOrderType`, defaults to **Delivery**). The invalid state is: **cart contains a pickup-only item AND `orderType==='delivery'`.** We surface it three ways.

### Components

1. **Config + helpers** (near the `MENU`/`qty` block, ~1483):
   ```js
   const PICKUP_ONLY_CATS = ['ny'];   // 18" NY pizzas; add a category here to make it pickup-only
   const isPickupOnlyItem = (p) => PICKUP_ONLY_CATS.includes(p.cat);
   const cartHasPickupOnly = () => MENU.some(p => qty[p.id] > 0 && isPickupOnlyItem(p));
   ```

2. **Badges (expectation)** — text-only "Solo Pickup" pill, **no emoji**:
   - **Category tab**: append a small `Solo Pickup` chip to the "NY Slice · 18\"" tab (HTML ~1037).
   - **Per card**: in `renderMenu()` (~1557), when `isPickupOnlyItem(p)`, render a `Solo Pickup` badge in the card body. 12" cards render unchanged.

3. **Gate (block)** — a hidden alert placed **adjacent to the Delivery/Pickup toggle** (Paso 2, ~1104). Shown iff the invalid state holds. A single `refreshPickupGate()` toggles it:
   ```js
   function refreshPickupGate(){
     const show = cartHasPickupOnly() && orderType === 'delivery';
     pickupGateEl.style.display = show ? 'block' : 'none';
   }
   ```
   Called from **`chg()`** (~1593, after any cart change — so adding an 18" while Delivery is selected surfaces it immediately) and from **`setOrderType()`** (~3102, after switching). Two actions:
   - **"Quitar NY Pizzas 18\" del carrito"** → `removePickupOnlyFromCart()`: `MENU.forEach(p => { if (isPickupOnlyItem(p) && qty[p.id]>0) chg(p.id, -qty[p.id]); })` (reuses `chg` so all card UI / totals / cart sync stay correct), then `refreshPickupGate()`. Order stays Delivery.
   - **"Cambiar a Pickup"** → `setOrderType('pickup')` (existing fn; it already flips the toggle UI and calls `refreshPickupGate`).

4. **Submit safety net (guarantee)** — in the pre-submit validation (~1912, alongside the existing has-items / min-order / name-phone checks), add the first-class block:
   ```js
   if (orderType === 'delivery' && cartHasPickupOnly()) {
     refreshPickupGate();
     pickupGateEl.scrollIntoView({behavior:'smooth', block:'center'});
     err.style.display='block';
     err.textContent='Las NY Pizzas 18" solo están disponibles para pickup.';
     return;   // abort submit
   }
   ```
   This catches any stale/edge state (e.g., the gate scrolled off screen) so a Delivery order with an 18" can never be placed.

5. **(Optional) pickup confirmation note** — when `orderType==='pickup' && cartHasPickupOnly()`, a subtle green note near the toggle: "Pedido para recoger en tienda — incluye NY Pizza de 18\"." Nice-to-have; text-only.

## Copy (exact, Spanish, no emoji)

- Tab chip / card badge: **`Solo Pickup`**
- Gate title: **`Las NY Pizzas 18" solo están disponibles para pickup`**
- Gate body: **`Tu carrito tiene una NY Pizza de 18". Para pedir a domicilio, quitala; o cambiá el pedido a Pickup.`**
- Action 1: **`Quitar NY Pizzas 18" del carrito`**
- Action 2: **`Cambiar a Pickup`**
- Submit block: **`Las NY Pizzas 18" solo están disponibles para pickup.`**
- (Optional) pickup note: **`Pedido para recoger en tienda — incluye NY Pizza de 18".`**

## Data flow

add 18" (`chg`) → `refreshPickupGate()` → gate shows (Delivery default) · badge already visible on the card → customer taps **Cambiar a Pickup** (`setOrderType('pickup')` → gate hides, order valid) OR **Quitar…** (`chg(-qty)` → cart clean, stays Delivery) → submit re-checks (`orderType==='delivery' && cartHasPickupOnly()`) as the final guard.

## Error handling / edge cases

- **Default Delivery + add 18"** → gate appears immediately (via `chg`).
- **Switch to Delivery with 18" in cart** → gate appears (via `setOrderType`).
- **Remove the last 18"** → gate clears; order stays Delivery.
- **Stale/off-screen gate** → submit safety net blocks + scrolls to it.
- **12"-only cart** → no badge, no gate, Delivery works exactly as today.
- **Back-compat** → all new behavior is gated behind `isPickupOnlyItem`/`cartHasPickupOnly`; the `individual` category and every other flow are byte-identical.

## Not doing server-side enforcement (and why)

This is an **operational rule, not a money or security control** — the server reprices the total correctly regardless, and a bypass would only mis-route fulfillment (the shop can catch a delivery order carrying an 18"). So the primary enforcement is the client (badge + gate + submit block). A server-side reject (create-order checking `order_type==='delivery'` against a server list of NY items) is **optional future hardening**, out of scope here; noted so it can be added if abuse ever appears.

## Testing

- **Pure helpers (if extracted):** `isPickupOnlyItem` (ny→true, individual→false); `cartHasPickupOnly` (true iff an ny item has qty>0).
- **Manual:** badge on the NY tab + each NY card, none on 12"; add NY on default Delivery → gate shows; "Cambiar a Pickup" → gate clears + (optional) pickup note; "Quitar NY Pizzas 18\" del carrito" → NY gone, stays Delivery; switch Delivery↔Pickup with NY in cart → gate toggles correctly; attempt submit with Delivery + NY → blocked with the message + scroll to gate; 12"-only Delivery order → unaffected end-to-end.

## Gate & rollout

- **Advisor gate:** source-verify + self-review. **No codex money-gate** — client-side UX only, no money/state/pricing/security surface (same bar as the La Musa copy/cosmetic fixes).
- **Deploy:** form-only → FF-merge to `main` → git-CD redeploys `orders.xpizza.hn`. No functions deploy.
- **Ownership:** executor builds on this branch; advisor gates; **Xavier deploys** (or advisor FF-merges under his go, as with the recent form fixes).

## Out of scope

- Server-side enforcement (optional hardening, noted above).
- Any category other than `ny`.
- The pre-existing per-item dish emoji on menu cards (not chrome; unchanged).
- La Musa form (X. Pizza only; La Musa has no 18" NY category).
