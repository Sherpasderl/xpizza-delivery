# X. Pizza 18" (NY) Pizzas Pickup-Only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 18-inch NY pizzas (`cat:'ny'`) on the X. Pizza order form orderable for pickup only — a "Solo Pickup" badge, a gate blocking Delivery + 18", and a submit-time guard.

**Architecture:** Client-side only, single file `xpizza-orders/index.html` (inline JS). A tiny data-driven config (`PICKUP_ONLY_CATS=['ny']`) + two helpers drive a badge (render), a gate element (toggled by `refreshPickupGate()` from `chg` and `setOrderType`), and a guard in `processPayment()`. No money, no server, no functions.

**Tech Stack:** Vanilla inline JS/HTML/CSS. **No test harness for this form** → each task is an exact edit + manual browser verification (open `xpizza-orders/index.html`).

**Spec:** `docs/superpowers/specs/2026-07-23-xpizza-18inch-pickup-only-design.md`

**Copy (exact, no emoji):** badge `Solo Pickup` · gate title `Las NY Pizzas 18" solo están disponibles para pickup` · body `Tu carrito tiene una NY Pizza de 18". Para pedir a domicilio, quitala; o cambiá el pedido a Pickup.` · actions `Quitar NY Pizzas 18" del carrito` / `Cambiar a Pickup` · submit `Las NY Pizzas 18" solo están disponibles para pickup.` · pickup note `Pedido para recoger en tienda — incluye NY Pizza de 18".`

**Rule:** no cheap emoji anywhere in the new chrome ([[no-cheap-emoji-in-form-chrome]]).

---

### Task 1: Config + helpers

**Files:** Modify `xpizza-orders/index.html` (near the `qty` init, ~1483)

- [ ] **Step 1: Add the config + helpers.** Immediately after the line `MENU.forEach(p => qty[p.id] = 0);` (~1484), insert:

```js
// 18" NY pizzas are pickup-only. Data-driven: add a category here to make it pickup-only.
const PICKUP_ONLY_CATS = ['ny'];
const isPickupOnlyItem = (p) => PICKUP_ONLY_CATS.includes(p.cat);
const cartHasPickupOnly = () => MENU.some(p => qty[p.id] > 0 && isPickupOnlyItem(p));
```

- [ ] **Step 2: Manual sanity.** Open the form; in the browser console run `cartHasPickupOnly()` → `false` (empty cart), and `isPickupOnlyItem({cat:'ny'})` → `true`, `isPickupOnlyItem({cat:'individual'})` → `false`.

- [ ] **Step 3: Commit**

```bash
git add xpizza-orders/index.html
git commit -m "feat(xpizza): PICKUP_ONLY_CATS config + helpers for 18\" NY pizzas"
```

---

### Task 2: "Solo Pickup" badges (tab + cards)

**Files:** Modify `xpizza-orders/index.html` (CSS block; tab HTML ~1037; `renderMenu` card template ~1557)

- [ ] **Step 1: Add badge CSS.** In the `<style>` block (e.g. near the other small-label styles), add:

```css
.tab-pickup{font-size:10px;font-weight:700;letter-spacing:.03em;color:var(--gold-dk);background:var(--gold-lt);padding:2px 6px;border-radius:5px;margin-left:6px;vertical-align:middle}
.pickup-badge{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.03em;color:var(--gold-dk);background:var(--gold-lt);padding:3px 7px;border-radius:6px;margin-top:5px}
```

- [ ] **Step 2: Badge on the NY tab.** Change the NY tab button (~1037):

from
```html
    <button class="cat-tab" onclick="switchCat('ny',this)">NY Slice · 18"</button>
```
to
```html
    <button class="cat-tab" onclick="switchCat('ny',this)">NY Slice · 18" <span class="tab-pickup">Solo Pickup</span></button>
```

- [ ] **Step 3: Badge on each NY card.** In `renderMenu()`'s `card` template (~1557), the card body currently reads:

```js
      <div class="pizza-card-body">
        <div class="pizza-card-name">${p.name}</div>
        <div class="pizza-card-desc">${p.desc||''}</div>
```
Insert the badge line right after the name:
```js
      <div class="pizza-card-body">
        <div class="pizza-card-name">${p.name}</div>
        ${isPickupOnlyItem(p) ? '<span class="pickup-badge">Solo Pickup</span>' : ''}
        <div class="pizza-card-desc">${p.desc||''}</div>
```

- [ ] **Step 4: Manual verify.** Open the form: the **NY Slice · 18"** tab shows a "Solo Pickup" chip; every card under it shows a "Solo Pickup" badge; the **12 Inch Pies** tab and its cards show **no** badge. No emoji anywhere on the badge.

- [ ] **Step 5: Commit**

```bash
git add xpizza-orders/index.html
git commit -m "feat(xpizza): Solo Pickup badge on NY 18\" tab + cards (no emoji)"
```

---

### Task 3: The gate element + refresh/remove functions

**Files:** Modify `xpizza-orders/index.html` (CSS; HTML after the delivery-toggle ~1106; new JS functions, e.g. after `setOrderType`)

- [ ] **Step 1: Add gate + note CSS.** In the `<style>` block add:

```css
.pickup-gate{margin:12px 16px 0;border:1px solid #E7B4A8;background:#FBEAE6;border-radius:12px;padding:13px 14px}
.pickup-gate-title{font-family:var(--sans);font-size:13.5px;font-weight:700;color:#8f2413;line-height:1.4}
.pickup-gate-body{font-family:var(--sans);font-size:12.5px;color:#7a4034;line-height:1.5;margin:6px 0 11px}
.pickup-gate-actions{display:flex;gap:8px;flex-wrap:wrap}
.pickup-gate-btn{border:0;border-radius:9px;padding:9px 12px;font-family:var(--sans);font-size:12.5px;font-weight:700;cursor:pointer}
.pickup-gate-btn.primary{background:var(--red);color:#fff}
.pickup-gate-btn.ghost{background:#fff;color:var(--charcoal);border:1px solid var(--border)}
.pickup-note{margin:12px 16px 0;border:1px solid #BFE0CC;background:var(--green-bg);border-radius:12px;padding:11px 14px;font-family:var(--sans);font-size:12.5px;color:#1f5734}
```

- [ ] **Step 2: Add the gate HTML** right after the delivery-toggle block. The current HTML (~1103-1106) is:

```html
    <div class="delivery-toggle">
      <button class="delivery-toggle-btn active" id="btn-delivery" onclick="setOrderType('delivery')">Delivery</button>
      <button class="delivery-toggle-btn" id="btn-pickup" onclick="setOrderType('pickup')">Pickup</button>
    </div>
```
Insert immediately after that closing `</div>`:
```html
    <div class="pickup-gate" id="pickup-gate" style="display:none">
      <div class="pickup-gate-title">Las NY Pizzas 18" solo están disponibles para pickup</div>
      <div class="pickup-gate-body">Tu carrito tiene una NY Pizza de 18". Para pedir a domicilio, quitala; o cambiá el pedido a Pickup.</div>
      <div class="pickup-gate-actions">
        <button type="button" class="pickup-gate-btn primary" onclick="removePickupOnlyFromCart()">Quitar NY Pizzas 18" del carrito</button>
        <button type="button" class="pickup-gate-btn ghost" onclick="setOrderType('pickup')">Cambiar a Pickup</button>
      </div>
    </div>
    <div class="pickup-note" id="pickup-note" style="display:none">Pedido para recoger en tienda — incluye NY Pizza de 18".</div>
```

- [ ] **Step 3: Add the two functions.** Add just after the `setOrderType` function (after its closing `}` ~3153):

```js
// Show the gate iff an 18" NY pizza is in the cart AND the order is Delivery; show the
// pickup confirmation note when it's Pickup with an 18". Called from chg() and setOrderType().
function refreshPickupGate(){
  const gate = document.getElementById('pickup-gate');
  const note = document.getElementById('pickup-note');
  const conflict = cartHasPickupOnly() && orderType === 'delivery';
  if (gate) gate.style.display = conflict ? 'block' : 'none';
  if (note) note.style.display = (orderType === 'pickup' && cartHasPickupOnly()) ? 'block' : 'none';
}
// Remove every pickup-only item from the cart (reuses chg so card UI / totals / cart pill stay correct).
function removePickupOnlyFromCart(){
  MENU.forEach(p => { if (isPickupOnlyItem(p) && qty[p.id] > 0) chg(p.id, -qty[p.id]); });
  refreshPickupGate();
}
```

- [ ] **Step 4: Manual verify (partial).** In the console, with a NY item added (`chg(18,1)`), run `refreshPickupGate()` → the gate `#pickup-gate` becomes visible (orderType is 'delivery' by default). `removePickupOnlyFromCart()` → gate hides and the NY qty returns to 0. (Full wiring is Task 4.)

- [ ] **Step 5: Commit**

```bash
git add xpizza-orders/index.html
git commit -m "feat(xpizza): pickup gate element + refreshPickupGate/removePickupOnlyFromCart"
```

---

### Task 4: Wire the gate into cart + order-type changes

**Files:** Modify `xpizza-orders/index.html` (`chg` end ~1653; `setOrderType` end ~3151)

- [ ] **Step 1: Call from `chg()`.** At the end of `chg(id,d)`, the last two statements are:

```js
  updateTotal();
  updateCart();
}
```
Change to:
```js
  updateTotal();
  updateCart();
  refreshPickupGate();
}
```

- [ ] **Step 2: Call from `setOrderType()`.** Its final statements (~3151) are:

```js
  // Keep the Checkout time selector's label ("entrega"/"recogida") + state in sync with the mode.
  refreshTimeSelector();
}
```
Change to:
```js
  // Keep the Checkout time selector's label ("entrega"/"recogida") + state in sync with the mode.
  refreshTimeSelector();
  refreshPickupGate();
}
```

- [ ] **Step 3: Manual verify (full interaction).** Open the form:
  - Add a NY 18" pizza (default order type is Delivery) → the gate appears near the Delivery/Pickup toggle.
  - Click **Cambiar a Pickup** → gate hides; the green pickup note appears; toggle shows Pickup active.
  - Switch back to **Delivery** (toggle) → gate reappears.
  - Click **Quitar NY Pizzas 18" del carrito** → the NY pizza leaves the cart (qty 0, cart total drops), gate hides, order stays Delivery.
  - Add only a 12" pizza → no gate, Delivery works normally.

- [ ] **Step 4: Commit**

```bash
git add xpizza-orders/index.html
git commit -m "feat(xpizza): wire refreshPickupGate into chg + setOrderType"
```

---

### Task 5: Submit-time safety net

**Files:** Modify `xpizza-orders/index.html` (`processPayment()` ~2224)

> Note: this corrects the spec's approximate "~1912" reference — that site (`goToLocation`) runs *before* the order-type is chosen. The real place-order validation is `processPayment()`, which already has the `orderType==='delivery'` checks and uses the `err3` error element.

- [ ] **Step 1: Add the guard.** In `processPayment()`, find the first delivery check (~2225):

```js
  if(orderType==='delivery' && (!lat || !lng)){
    document.getElementById('err3').style.display='block';
    document.getElementById('err3').textContent='Por favor confirmá tu ubicación en el mapa.';
    return;
  }
```
Insert the pickup-only guard immediately **before** it:
```js
  if(orderType==='delivery' && cartHasPickupOnly()){
    refreshPickupGate();
    const gate=document.getElementById('pickup-gate');
    if(gate) gate.scrollIntoView({behavior:'smooth', block:'center'});
    document.getElementById('err3').style.display='block';
    document.getElementById('err3').textContent='Las NY Pizzas 18" solo están disponibles para pickup.';
    return;
  }
```

- [ ] **Step 2: Manual verify.** With a NY 18" in the cart, force Delivery selected, scroll to payment and press the pay button → submission is blocked, `err3` shows "Las NY Pizzas 18" solo están disponibles para pickup.", and the page scrolls to the gate. Resolve (Cambiar a Pickup) → submission proceeds normally. A 12"-only Delivery order is unaffected.

- [ ] **Step 3: Commit**

```bash
git add xpizza-orders/index.html
git commit -m "feat(xpizza): submit-time guard blocks Delivery + 18\" NY pizza"
```

---

### Task 6: Full manual verification + handoff

**Files:** none (verification only)

- [ ] **Step 1: End-to-end pass** (browser):
  - Badge on NY tab + all 6 NY cards; none on the 17 individual cards; no emoji.
  - Add NY on default Delivery → gate; Cambiar a Pickup → note; Quitar → clean Delivery cart.
  - Delivery + NY at submit → blocked with the message + scroll-to-gate.
  - 12"-only order delivers end-to-end with zero behavior change.
  - Switch Delivery↔Pickup repeatedly with/without a NY in cart → gate/note toggle correctly, no flicker or stuck state.
- [ ] **Step 2: Regression spot-check.** The `individual` (12") category, the delivery-zone/address/payment flow, and order submission for a normal delivery order are all unchanged.
- [ ] **Step 3: Push the branch** (do NOT merge/deploy): `git push -u origin feature/xpizza-18inch-pickup-only`. Report the tip SHA to the advisor.

---

### Task 7: Gate + deploy (advisor + Xavier)

- [ ] **Advisor gate:** source-verify + self-review. **No codex money-gate** (client-side UX only — no money/state/pricing/security).
- [ ] **Deploy (Xavier / advisor under go):** form-only → FF-merge `feature/xpizza-18inch-pickup-only` → `main` → git-CD redeploys `orders.xpizza.hn`. No functions deploy.
- [ ] **Post-deploy verify from source:** curl `orders.xpizza.hn` and confirm the `Solo Pickup` badge + `pickup-gate` markup are live; do one on-device pass of the gate.

---

## Self-review

- **Spec coverage:** config+helpers (T1) ✓; badges tab+cards no-emoji (T2) ✓; gate element + copy + actions (T3) ✓; refreshPickupGate wired to chg+setOrderType (T4) ✓; submit safety net (T5) ✓; optional pickup note (T3) ✓; data-driven PICKUP_ONLY_CATS (T1) ✓; no server enforcement (spec-scoped-out) ✓; manual tests (T6) ✓.
- **Spec correction:** the submit guard lives in `processPayment()` (~2224, `err3`), not `goToLocation` (~1912) — the latter runs before order-type is chosen. Documented in Task 5.
- **Placeholder scan:** none — every step has full code.
- **Name consistency:** `PICKUP_ONLY_CATS`, `isPickupOnlyItem`, `cartHasPickupOnly`, `refreshPickupGate`, `removePickupOnlyFromCart`, `#pickup-gate`, `#pickup-note`, `.pickup-badge`, `.tab-pickup` used consistently across T1–T5. Reuses verified existing symbols: `MENU`, `qty`, `chg`, `orderType`, `setOrderType`, `renderMenu`, `processPayment`, `err3`, `updateTotal`, `updateCart`, `refreshTimeSelector`.
- **No emoji** in any added chrome (badge/gate/note) — per the standing rule.
