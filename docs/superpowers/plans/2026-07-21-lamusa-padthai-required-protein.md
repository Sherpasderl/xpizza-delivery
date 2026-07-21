# La Musa Pad Thai — Required Protein Choice · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pad Thai require a protein choice (Sin Proteína / Pollo / Camarones) in a launcher modal, where each protein is its own menu id so mixed proteins land as separate cart lines.

**Architecture:** Protein = distinct La Musa menu ids (`noodle_01_sin/pollo/camaron`, priced 307/342/414) that ride the form's existing id-keyed cart (grid/cart/totals/`buildOrder` all key on `p.id`). The `noodle_01` card becomes a launcher that opens a **staged** required-choice modal; on Add it commits `chg(variantId,1)` + `pizzaExtras[variantId]` and closes. Server prices by id — no extras channel, no qty-scaling, no required-choice enforcement.

**Tech Stack:** Vanilla inline JS in `la-musa-orders/index.html`; Node `assert` unit tests for `xpizza-functions/menu-pricing.js` (run via `node <file>.test.js`).

**Spec:** `docs/superpowers/specs/2026-07-21-lamusa-padthai-required-protein-design.md`

**Money-gate:** Tasks 1–2 (server prices + parity) are the price-affecting diff → advisor runs codex-on-diff before Task 6/deploy.

**Prices:** base 307 · Pollo +35 = 342 · Camarones +107 = 414 (= today's Pad Thai price).

---

### Task 1: Server pricing table + unit tests

**Files:**
- Modify: `xpizza-functions/menu-pricing.js` (`LA_MUSA_MENU`, ~line 38-58)
- Test: `xpizza-functions/menu-pricing.test.js`

- [ ] **Step 1: Write failing tests** — append to `menu-pricing.test.js` (before the final summary `console.log`):

```js
// ── La Musa Pad Thai protein variants (distinct ids, base 307 / +35 / +107) ──
assert.deepStrictEqual(computeServerTotal([{ id: 'noodle_01_sin', qty: 1 }], 'la_musa'), { total: 307, error: null }); ok('la_musa Pad Thai Sin Proteína = 307');
assert.deepStrictEqual(computeServerTotal([{ id: 'noodle_01_pollo', qty: 1 }], 'la_musa'), { total: 342, error: null }); ok('la_musa Pad Thai Pollo = 342');
assert.deepStrictEqual(computeServerTotal([{ id: 'noodle_01_camaron', qty: 1 }], 'la_musa'), { total: 414, error: null }); ok('la_musa Pad Thai Camarones = 414');
assert.deepStrictEqual(computeServerTotal([{ id: 'noodle_01_pollo', qty: 1 }, { id: 'noodle_01_camaron', qty: 1 }], 'la_musa'), { total: 342 + 414, error: null }); ok('la_musa mixed protein lines sum');
assert.deepStrictEqual(computeServerTotal([{ id: 'noodle_01_camaron', qty: 2 }], 'la_musa'), { total: 828, error: null }); ok('la_musa same protein qty 2 = 828');
assert.equal(computeServerTotal([{ id: 'noodle_01_bogus', qty: 1 }], 'la_musa').error !== null, true); ok('la_musa unknown variant id rejected');
```

- [ ] **Step 2: Run — verify it FAILS**

Run: `cd xpizza-functions && node menu-pricing.test.js`
Expected: FAIL (`unknown menu item: noodle_01_sin` — ids not in table yet).

- [ ] **Step 3: Add the variant ids to `LA_MUSA_MENU`** — reprice `noodle_01` and add three variants. In `menu-pricing.js`, inside the `LA_MUSA_MENU` object, change the Pad Thai entry `noodle_01: 414,` to:

```js
  noodle_01: 307,            // Pad Thai — launcher base (kept for form↔server parity; never ordered directly)
  noodle_01_sin: 307,        // Pad Thai - Sin Proteína
  noodle_01_pollo: 342,      // Pad Thai - Pollo (+35)
  noodle_01_camaron: 414,    // Pad Thai - Camarones (+107)
```

- [ ] **Step 4: Run — verify it PASSES**

Run: `cd xpizza-functions && node menu-pricing.test.js`
Expected: PASS (all prior + 6 new cases). _Do NOT run `menu-parity.test.js` yet — it will fail until the form MENU gains the same ids in Task 2._

- [ ] **Step 5: Commit**

```bash
git add xpizza-functions/menu-pricing.js xpizza-functions/menu-pricing.test.js
git commit -m "feat(lamusa): server prices for Pad Thai protein variants (307/342/414)"
```

---

### Task 2: Form MENU variant data + config + helpers + parity count

**Files:**
- Modify: `la-musa-orders/index.html` (`MENU` array ~1579-1624; `LA_MUSA_MODIFIERS` block ~1761-1846; grid filter @2064)
- Modify: `xpizza-functions/menu-parity.test.js` (expected MENU count)

- [ ] **Step 1: Reprice the launcher + add 3 variant entries** — in `MENU`, replace the Pad Thai entry (`{ id:"noodle_01", ... price:414, ... }`, ~line 1602) with the launcher (repriced) followed by three hidden variant entries:

```js
    { id:"noodle_01", cat:"noodles", name:"Pad Thai", price:307, desc:"Fideos wok, tamarindo, maní, brotes, huevo", tags:["most_ordered"], color:"#8A7B6B", emoji:"🍜" },
    { id:"noodle_01_sin",     cat:"noodles", name:"Pad Thai - Sin Proteína", price:307, color:"#8A7B6B", emoji:"🍜", variantOf:"noodle_01", choice:"Sin Proteína" },
    { id:"noodle_01_pollo",   cat:"noodles", name:"Pad Thai - Pollo",        price:342, color:"#8A7B6B", emoji:"🍜", variantOf:"noodle_01", choice:"Pollo" },
    { id:"noodle_01_camaron", cat:"noodles", name:"Pad Thai - Camarones",    price:414, color:"#8A7B6B", emoji:"🍜", variantOf:"noodle_01", choice:"Camarones" },
```

- [ ] **Step 2: Add the `VARIANT_ITEMS` config + helpers** — in the `LA_MUSA_MODIFIERS` block (near `EXTRAS_BY_ITEM`, ~line 1816), add:

```js
// Launcher item id → its required single-select protein variants (each a real MENU id → its own
// cart line). To add another dish later: add its variant entries to MENU + LA_MUSA_MENU (server),
// then ONE entry here. No new code.
const VARIANT_ITEMS = {
  noodle_01: { label: "Proteína", basePrice: 307,
               variantIds: ["noodle_01_sin","noodle_01_pollo","noodle_01_camaron"] },
};
function itemIsLauncher(p) { return !!(p && VARIANT_ITEMS[p.id]); }
function itemIsVariant(p)  { return !!(p && p.variantOf); }
```

- [ ] **Step 3: Hide variants from the menu grid** — the category filter (~line 2064):

Change `const items = MENU.filter(p => p.cat === c.id);`
to `const items = MENU.filter(p => p.cat === c.id && !p.variantOf);`

- [ ] **Step 4: Update the parity expected count** — in `menu-parity.test.js`, the MENU assertion currently expects **40**; it's now **43** (40 + 3 variants). Change:

`assertExactParity('MENU', formMenu, MENU_BY_RESTAURANT.la_musa, 40);`
to `assertExactParity('MENU', formMenu, MENU_BY_RESTAURANT.la_musa, 43);`

- [ ] **Step 5: Run parity — verify PASS**

Run: `cd xpizza-functions && node menu-parity.test.js`
Expected: PASS — `form MENU (43) === server la_musa menu`. (Confirms form + server ids and prices match exactly, including the repriced `noodle_01`.) If it fails on a price mismatch, the two `noodle_01` prices disagree (both must be 307).

- [ ] **Step 6: Commit**

```bash
git add la-musa-orders/index.html xpizza-functions/menu-parity.test.js
git commit -m "feat(lamusa): Pad Thai variant menu entries + VARIANT_ITEMS config + grid hide"
```

---

### Task 3: Launcher card (opens modal, keeps "+" in the stepper's place)

**Files:**
- Modify: `la-musa-orders/index.html` — `renderMenu()` `card` template (~2001-2035)

- [ ] **Step 1: Branch the card template for launcher items.** In the `card = p => (...)` template, the qty-overlay (`<div class="qty-overlay">…`) and the footer price need a launcher variant. Wrap the overlay: for `itemIsLauncher(p)`, render a single add button that opens the modal (no stepper/badge); otherwise the existing overlay. Replace the `<div class="qty-overlay" …>…</div>` block with:

```js
        (itemIsLauncher(p)
          ? '<div class="qty-overlay" onclick="event.stopPropagation()">' +
              '<button class="qty-add-btn" aria-label="Personalizar" onclick="openDetailModal(\'' + p.id + '\')">+</button>' +
            '</div>'
          : '<div class="qty-overlay" onclick="event.stopPropagation()">' +
              '<div class="qty-controls" id="qty-controls-' + p.id + '">' +
                '<button class="qty-ctrl-btn" onclick="chg(\'' + p.id + '\',-1)" id="minus-' + p.id + '">−</button>' +
                '<span class="qty-ctrl-num" id="qty-' + p.id + '">0</span>' +
                '<button class="qty-ctrl-btn" onclick="chg(\'' + p.id + '\',1)">+</button>' +
              '</div>' +
              '<div class="qty-badge" id="qty-badge-' + p.id + '" style="display:none" onclick="toggleControls(\'' + p.id + '\')">' +
                '<span id="qty-badge-num-' + p.id + '">1</span>' +
              '</div>' +
              '<button class="qty-add-btn" id="qty-add-' + p.id + '" onclick="chg(\'' + p.id + '\',1)">+</button>' +
            '</div>') +
```

- [ ] **Step 2: Launcher footer price shows "desde".** In the same template, the footer price span currently: `(p.price > 0 ? 'L ' + p.price : '—')`. Change to:

```js
(itemIsLauncher(p) ? 'desde L ' + p.price : (p.price > 0 ? 'L ' + p.price : '—'))
```

- [ ] **Step 3: Manual verify.** Serve the form (open `la-musa-orders/index.html` in a browser). In "Noodles": exactly ONE Pad Thai card shows (no `Pad Thai - …` cards); its footer reads "desde L 307"; tapping "+" opens the detail modal and does NOT increment an inline counter.

- [ ] **Step 4: Commit**

```bash
git add la-musa-orders/index.html
git commit -m "feat(lamusa): Pad Thai card is a launcher (+ opens modal, variants hidden from grid)"
```

---

### Task 4: Launcher modal — staged required protein + optional extras

**Files:**
- Modify: `la-musa-orders/index.html` — staging state (~3191), `openDetailModal` (~3195), `renderDetailModal` (~3346), plus new functions + CSS.

- [ ] **Step 1: Add staging state** — next to `let currentDetailPizzaId = null;` (~3191):

```js
// Launcher (required-variant) modal staging — used ONLY when the open item is a launcher.
// The target cart id isn't known until a protein is chosen, and we commit + close on Add,
// so the launcher path stages locally (the pure-XP modal keeps writing straight to the cart).
let stagedVariantId = null;   // chosen variant menu id, or null
let stagedExtras = {};        // { extraId: qty } staged for the chosen line
```

- [ ] **Step 2: Reset staging on launcher open** — in `openDetailModal(pizzaId)`, right after `currentDetailPizzaId = pizzaId;`:

```js
  const _p = MENU.find(x => x.id === pizzaId);
  if (itemIsLauncher(_p)) { stagedVariantId = null; stagedExtras = {}; }
```

- [ ] **Step 3: Branch `renderDetailModal` to the launcher renderer** — at the top of `renderDetailModal()`, right after the `if (!pizza) return;` and the `detail-header-title` line, insert:

```js
  if (itemIsLauncher(pizza)) { renderLauncherModal(pizza); return; }
```

- [ ] **Step 4: Add `renderLauncherModal` + `selectVariant` + `chgStagedExtra`** — add these functions (e.g. immediately after `renderDetailModal`):

```js
function renderLauncherModal(pizza) {
  const cfg = VARIANT_ITEMS[pizza.id];
  const photoColor = pizza.color || '#C8321A';
  const heroImg = HAS_PHOTO.has(pizza.id)
    ? `<img class="detail-photo-img" loading="eager" decoding="async" alt="" src="images/${pizza.id}-hero.webp" onerror="this.remove()">` : '';
  const emojiHtml = HAS_PHOTO.has(pizza.id) ? '' : `<span class="detail-photo-label">${pizza.emoji || '🍜'}</span>`;
  let html = `<div class="detail-photo" style="background:${photoColor}">${emojiHtml}${heroImg}</div>`;
  html += `<div class="detail-body">
    <div class="detail-name">${escapeHtml(pizza.name)}</div>
    ${pizza.desc ? `<div class="detail-desc">${escapeHtml(pizza.desc)}</div>` : ''}
    <div class="detail-price">desde L ${cfg.basePrice}</div>
  </div>`;

  // Required single-select protein group
  html += `<div class="detail-cat-label">${escapeHtml(cfg.label)} <span class="detail-req">· Requerido</span></div>`;
  html += `<div class="detail-extras-list">`;
  cfg.variantIds.forEach(vid => {
    const v = MENU.find(p => p.id === vid); if (!v) return;
    const delta = v.price - cfg.basePrice;
    const priceLabel = delta > 0 ? `+L ${delta}` : `L ${v.price}`;
    const sel = stagedVariantId === vid;
    html += `<div class="detail-variant-row${sel ? ' sel' : ''}" onclick="selectVariant('${vid}')">
      <div><span class="detail-extras-name">${escapeHtml(v.choice)}</span>
      <span class="detail-extras-price">${priceLabel}</span></div>
      <span class="detail-variant-radio"></span>
    </div>`;
  });
  html += `</div>`;

  // Optional extras (staged, always visible)
  extrasCatsForItem(pizza).forEach(cat => {
    const inCat = EXTRAS.filter(e => e.cat === cat); if (!inCat.length) return;
    html += `<div class="detail-cat-label">${escapeHtml(cat)}</div><div class="detail-extras-list">`;
    inCat.forEach(e => {
      const q = stagedExtras[e.id] || 0;
      html += `<div class="detail-extras-row${q > 0 ? ' has-qty' : ''}">
        <div><span class="detail-extras-name">${escapeHtml(e.name)}</span>
        <span class="detail-extras-price">+L ${e.price}</span></div>
        <div class="detail-extras-stepper-wrap">${
          q === 0
            ? `<button class="qty-add-btn detail-extras-add-btn" onclick="chgStagedExtra('${e.id}',1)">+</button>`
            : `<div class="qty-controls visible detail-extras-pill"><button class="qty-ctrl-btn" onclick="chgStagedExtra('${e.id}',-1)">−</button><span class="qty-ctrl-num">${q}</span><button class="qty-ctrl-btn" onclick="chgStagedExtra('${e.id}',1)">+</button></div>`
        }</div></div>`;
    });
    html += `</div>`;
  });

  html += `<div style="height:24px"></div>`;
  document.getElementById('detail-scroll').innerHTML = html;
  document.getElementById('detail-scroll').scrollTop = 0;
  updateDetailCta();
}
function selectVariant(vid) { stagedVariantId = vid; updateDetailModal(); }
function chgStagedExtra(eid, d) {
  stagedExtras[eid] = Math.max(0, (stagedExtras[eid] || 0) + d);
  if (!stagedExtras[eid]) delete stagedExtras[eid];
  updateDetailModal();
}
```

- [ ] **Step 5: Add CSS for the variant rows** — near the `.detail-extras-row` rules, add (use the form's musa-red literals):

```css
.detail-req{color:#B61218;font-weight:700;font-size:.85em}
.detail-variant-row{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border:1.5px solid #ece2e2;border-radius:12px;margin-bottom:8px;cursor:pointer}
.detail-variant-row.sel{border-color:#B61218;background:#F4DDDD}
.detail-variant-radio{width:20px;height:20px;border-radius:50%;border:2px solid #b9adae;flex:none}
.detail-variant-row.sel .detail-variant-radio{border-color:#B61218;box-shadow:inset 0 0 0 5px #B61218}
```

- [ ] **Step 6: Manual verify.** Tap "+" on Pad Thai → modal shows "Proteína · Requerido" with three tappable rows (Sin Proteína L307 / Pollo +L35 / Camarones +L107) and, below, the optional Acompañamientos/Salsas steppers. Tapping a protein highlights it (filled dot); tapping optional-extra "+" increments its stepper. No inline cart quantity for Pad Thai appears yet.

- [ ] **Step 7: Commit**

```bash
git add la-musa-orders/index.html
git commit -m "feat(lamusa): launcher modal — staged required protein + optional extras"
```

---

### Task 5: Launcher CTA + commit-and-close

**Files:**
- Modify: `la-musa-orders/index.html` — `updateDetailCta` (~3455) and `detailCtaTap` (~3506)

- [ ] **Step 1: Launcher branch in `updateDetailCta`** — right after the guard block (`const pizza = MENU.find(...); if (!pizza) return;`, ~3467, BEFORE `const pizzaQty = ...`), insert:

```js
  if (itemIsLauncher(pizza)) {
    cta.style.opacity = '1'; cta.style.pointerEvents = 'auto';
    if (!stagedVariantId) {
      cta.className = 'detail-cta';
      cta.style.opacity = '.5'; cta.style.pointerEvents = 'none';
      cta.innerHTML = '<span>Elegí una proteína</span>';
      return;
    }
    const v = MENU.find(p => p.id === stagedVariantId);
    const extrasSum = Object.keys(stagedExtras).reduce((s, eid) => {
      const e = EXTRAS.find(x => x.id === eid); return s + (e ? e.price * stagedExtras[eid] : 0);
    }, 0);
    const total = (v ? v.price : 0) + extrasSum;
    cta.className = 'detail-cta';
    cta.innerHTML = `<span>Agregar al carrito</span>
      <span class="detail-cta-divider">·</span>
      <span>L ${total}</span>`;
    return;
  }
```

- [ ] **Step 2: Launcher branch in `detailCtaTap`** — at the very top of `detailCtaTap()` (after `const pizzaId = currentDetailPizzaId; if (pizzaId === null) return;`), insert:

```js
  const _pizza = MENU.find(p => p.id === pizzaId);
  if (itemIsLauncher(_pizza)) {
    if (!stagedVariantId) return;                        // required — no-op until chosen
    if (Object.keys(stagedExtras).length) pizzaExtras[stagedVariantId] = { ...stagedExtras };
    chg(stagedVariantId, 1);                             // increments qty + syncs cart/total (null-safe for hidden variant card)
    closeDetailModal();
    return;
  }
```

- [ ] **Step 3: Manual verify.** Tap "+" on Pad Thai → the CTA reads "Elegí una proteína" and is disabled. Pick Pollo → CTA becomes "Agregar al carrito · L 342"; add a sauce → total rises by the sauce price. Tap it → the modal CLOSES and the cart shows a "Pad Thai - Pollo" line. Re-open Pad Thai, pick Camarones, Add → a SECOND separate line "Pad Thai - Camarones". Re-open, pick Pollo, Add → the Pollo line becomes ×2 (not a third line). Cart total matches 342+342+414. Remove/decrement works via the cart's own steppers.

- [ ] **Step 4: Commit**

```bash
git add la-musa-orders/index.html
git commit -m "feat(lamusa): launcher CTA + commit-and-close → separate variant cart lines"
```

---

### Task 6: Full-suite verification + order payload/KDS check

**Files:** none (verification only)

- [ ] **Step 1: Run the functions test suite** (confirms nothing else regressed):

Run: `cd xpizza-functions && npm test`
Expected: PASS — including `menu-pricing.test.js` and `menu-parity.test.js`.

- [ ] **Step 2: Verify the order payload + KDS text.** In the browser, build a cart with Pad Thai - Pollo ×1 and Pad Thai - Camarones ×1, proceed to the point where `buildOrder()` runs (or `console.log(currentOrder)` in devtools). Confirm: two line items with `id:"noodle_01_pollo"`/`"noodle_01_camaron"`, `name:"Pad Thai - Pollo"`/`"…Camarones"`, correct `price`/`subtotal`; and `items_text` contains two lines `1x Pad Thai - Pollo …` / `1x Pad Thai - Camarones …`. (The KDS reads `items_text` → prints them as two separate lines, protein in the name; no KDS change.)

- [ ] **Step 3: Regression spot-check.** Add a NON-launcher item (e.g. a rice dish or a beverage) — its card still shows the inline stepper, adds directly, and its modal (if any) behaves exactly as before. Confirm the grid shows no `Pad Thai - …` cards.

- [ ] **Step 4: Commit** (if any doc/notes updated; otherwise skip).

---

### Task 7: Gate + deploy handoff

- [ ] **Step 1: Advisor money-gate.** Deliver the diff of Tasks 1–2 (server `menu-pricing.js` prices + `menu-parity.test.js` count + form MENU variant prices) for **codex-on-diff**. This is the price-affecting surface. Resolve to APPROVED before deploy.
- [ ] **Step 2: Deploy (Xavier).** Functions deploy for `menu-pricing.js` per the standing discipline (complete 25-key `.env`, reconcile `database.rules.json` ← `xpizza-reference`, zero-prune, from current `origin/main`). Form `la-musa-orders/index.html` deploys via git-CD/Netlify on merge to `main`.
- [ ] **Step 3: Post-deploy source-verify.** Place a test order with each protein; confirm server total matches (307/342/414), the KDS shows separate named lines, and mixed proteins remain separate cart lines.

---

## Self-review

- **Spec coverage:** variant ids + prices (T1/T2) ✓; grid hide (T2) ✓; launcher card w/ "+" (T3) ✓; required staged modal + optional extras (T4) ✓; gated CTA + commit-and-close + separate lines + same-protein-stacks (T5) ✓; KDS unchanged / items_text (T6) ✓; parity count 40→43 (T2) ✓; money-gate + deploy discipline (T7) ✓; generic `VARIANT_ITEMS` (T2) ✓.
- **Placeholder scan:** none — every code step carries full code.
- **Type/name consistency:** `VARIANT_ITEMS`, `itemIsLauncher`, `itemIsVariant`, `stagedVariantId`, `stagedExtras`, `renderLauncherModal`, `selectVariant`, `chgStagedExtra` used consistently across T2/T3/T4/T5. Reuses verified existing symbols: `chg`, `qty`, `pizzaExtras`, `EXTRAS`, `extrasCatsForItem`, `escapeHtml`, `HAS_PHOTO`, `updateDetailModal`, `updateDetailCta`, `closeDetailModal`, `computeServerTotal`, `MENU_BY_RESTAURANT`.
- **Ordering note:** `menu-parity.test.js` is green only after BOTH Task 1 (server) and Task 2 (form) — run it at Task 2 Step 5, not after Task 1.
- **Known limitation (spec-accepted):** extras on a variant are one shared config per variant id — re-adding the same protein with different extras overwrites that variant's extras (last wins); mixing is out of scope.
```
