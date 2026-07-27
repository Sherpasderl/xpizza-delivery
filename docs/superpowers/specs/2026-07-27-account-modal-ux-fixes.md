# HANDOFF → order-form executor — Account modal: 4 UX fixes

**Branch:** `feat/account-modal-ux-fixes` (off live `main` `fd99e1b`). **Both** `la-musa-orders/account.js` + `xpizza-orders/account.js` — **byte-identical past the ~17-line CONFIG block**, and every anchor below is at the SAME line in both files. Apply each edit to both; keep them identical past CONFIG (verify: `diff <(tail -n +18 xpizza-orders/account.js) <(tail -n +18 la-musa-orders/account.js)` → empty).

Owner-reported, all root-caused from source. No money-path change anywhere here — this is account-modal presentation/UX only. Mockup (Option A order card + roomy buttons): https://claude.ai/code/artifact/17f5ba5f-3f8b-49a3-9062-dc8ca61ecb92

---

## Fix #1 — Switching a saved address should NOT eject you from the sheet
**Where:** `selectSavedAddress()` — declared **`:1705`**, its `closeSheet();` is **`:1713`**.
**Why:** tapping an alternate address in the account pane's "Mis direcciones" applies it (list re-renders with the new default, `refreshDeliveryUI` updates the order's "Entregar a" card underneath) but then calls `closeSheet()` — so the user is dumped to checkout and must re-open to reach "Mis pedidos."
**Edit:** replace the `closeSheet();` line inside `selectSavedAddress` with a confirmation toast; keep everything else (`renderAddressesSection()`, `refreshDeliveryUI`, `placeAccountPin`, `saveAddress`):
```js
    toast('Dirección actualizada');   // was closeSheet() — stay in the sheet so the user can go to Mis pedidos; the order's Entregar-a card already updated via refreshDeliveryUI
```
`toast(msg)` is defined at `:467` (z-index 1100, above the sheet). **Do NOT touch `pickAddrFromPicker` / `selectSavedAddressForOrder`** — the Cambiar picker (entered from checkout) SHOULD keep closing back to the order; this fix is the account-pane list only.

---

## Fix #2 — "Mis pedidos" items: per-item list (Option A, owner-locked)
**Where:** `renderOrdersPane()` **`:597`**; the row build uses `const line = String(e.items_text || '').slice(0, 80);` and renders `<div class="acct-ordline">${escapeHtml(line)}</div>`. Card CSS block is `:152–163` (the `.acct-ordline` rule is `:161`).
**Why:** `items_text` is `2x Sichuan Spicy Wonton (L223) [+ 2x Arroz Chino] | 4x Pork Belly Buns (L248)` — the ` | ` joins wrap into an unreadable run-on.
**Option A (locked):** split on ` | `, render each item as **qty accent + name + extras sub-line**. **No per-line prices** (the stored `items[]` carries no prices by the P3 XSS/trust decision, and the `(L###)` in `items_text` is a UNIT price that wouldn't sum — so prices live ONLY in the order total). Total stays `e.total`.

**A. Add a pure parser** (near `renderOrdersPane`, module scope):
```js
// Parse the display items_text ("2x Name (L###) [+ extras] | …") into per-item parts for the list view.
// Pure string work on the already-sanitized items_text; prices are intentionally dropped (Option A).
function parseOrderItems(txt) {
  return String(txt || '').split(' | ').map((seg) => {
    seg = seg.trim(); if (!seg) return null;
    let m = seg.match(/^(\d+)x\s+([\s\S]+?)\s*\(L[\d.,]+\)\s*(?:\[\+\s*([\s\S]+?)\])?\s*$/);   // "Nx Name (L###)[ [+ extras]]"
    if (m) return { qty: m[1], name: m[2].trim(), extras: (m[3] || '').replace(/(\d+)x\s/g, '$1× ').trim() };
    m = seg.match(/^(\d+)x\s+([\s\S]+)$/);                                                       // no price → still split "Nx Name"
    if (m) return { qty: m[1], name: m[2].trim(), extras: '' };
    return { qty: '', name: seg, extras: '' };                                                   // unrecognized → show raw (defensive, never throws)
  }).filter(Boolean);
}
```
**B. In the `rowsHtml` map, replace** the `const line = …slice(0,80)` + `<div class="acct-ordline">…</div>` with:
```js
      const parsed = parseOrderItems(e.items_text);
      const itemsHtml = parsed.slice(0, 6).map((it) =>
        `<div class="acct-oitem"><span class="acct-oqty">${escapeHtml(it.qty)}${it.qty ? '×' : ''}</span><span class="acct-oname">${escapeHtml(it.name)}${it.extras ? `<span class="acct-oextra">+ ${escapeHtml(it.extras)}</span>` : ''}</span></div>`
      ).join('');
      const moreHtml = parsed.length > 6 ? `<div class="acct-omore">+${parsed.length - 6} más</div>` : '';
```
…and in the returned card template swap `<div class="acct-ordline">${escapeHtml(line)}</div>` for `<div class="acct-oitems">${itemsHtml}${moreHtml}</div>`. **Escape every field** (as above) — never render raw `items_text`/`items[]`.
**C. CSS** — replace the `.acct-ordline{…}` rule (`:161`) with (qty uses `${CONFIG.accent}` → La Musa red / X. Pizza gold, per-brand automatically):
```css
.acct-oitems{display:flex;flex-direction:column;gap:7px;margin:2px 0 8px}
.acct-oitem{display:flex;gap:9px;align-items:baseline}
.acct-oqty{flex:none;min-width:24px;font-size:13.5px;font-weight:800;color:${CONFIG.accent};font-variant-numeric:tabular-nums}
.acct-oname{font-size:14.5px;font-weight:600;color:#17130F;line-height:1.32}
.acct-oextra{display:block;font-size:12.5px;font-weight:500;color:#6B5E52;margin-top:1px}
.acct-omore{font-size:12.5px;font-weight:600;color:#8C7B6E;margin:1px 0 6px}
```

---

## Fix #3 — Smooth the pane transition (user detail → Mis pedidos "jumps out")
**Where:** `showPane()` **`:257`** (instant `display` swap; only the incoming pane gets the 0.2s `acct-pane-in` fade). Sheet = `document.querySelector('#acct-overlay .acct-sheet')` (`.acct-sheet`, `overflow:hidden`, content-driven height, stylesheet `transition:transform .3s`). The jump = sheet height changes abruptly between panes, plus `renderOrdersPane`'s `Cargando…`→list is a second reflow.
**Approach — animate the sheet's height across content changes** (robust + defensive; degrades to instant under reduced-motion / errors):

**A. Add a helper** (module scope, near `showPane`):
```js
// Smoothly animate the sheet's height across a content mutation (pane swap / list fill). Defensive:
// instant if closed, reduced-motion, unmeasurable, or on any error — the mutation always applies.
function animateSheetHeight(mutate) {
  const sheet = document.querySelector('#acct-overlay .acct-sheet');
  if (!sheet || prefersReducedMotion() || !sheet.closest('.acct-overlay.acct-open')) { mutate(); return; }
  let startH = 0; try { startH = sheet.offsetHeight; } catch (_) {}
  mutate();
  let endH = 0; try { endH = sheet.offsetHeight; } catch (_) {}
  if (!startH || !endH || startH === endH) return;
  try {
    sheet.style.height = startH + 'px';
    void sheet.offsetHeight;                                   // commit the start height
    sheet.style.transition = 'transform .3s cubic-bezier(.2,.7,.2,1), height .28s cubic-bezier(.2,.7,.2,1)';  // compose — keep the open/close transform slide working
    sheet.style.height = endH + 'px';
    const cleanup = () => { sheet.style.height = ''; sheet.style.transition = ''; sheet.removeEventListener('transitionend', onEnd); };  // clear inline → restore the stylesheet transform-only transition + content-driven height
    const onEnd = (e) => { if (e && e.target === sheet && e.propertyName === 'height') cleanup(); };
    sheet.addEventListener('transitionend', onEnd);
    setTimeout(cleanup, 400);                                  // fallback if transitionend doesn't fire
  } catch (_) { try { sheet.style.height = ''; sheet.style.transition = ''; } catch (__) {} }
}
```
**B. Wrap the pane swap in `showPane`:**
```js
  function showPane(name) {
    animateSheetHeight(() => {
      document.querySelectorAll('#acct-overlay .acct-pane').forEach((p) => p.classList.remove('acct-on'));
      const p = $('acct-pane-' + name); if (p) p.classList.add('acct-on');
      const back = $('acct-back'); if (back) back.style.visibility = (name === 'otp') ? 'visible' : 'hidden';
    });
  }
```
**C. Wrap the `renderOrdersPane` content fills** (the `Cargando…`→list second reflow) — wrap each final `pane.innerHTML = …` assignment (the list-rows fill AND the empty-state fill) in `animateSheetHeight(() => { pane.innerHTML = …; /* + the [data-ord] onclick binding stays inside */ })`. The initial `Cargando…` set stays as-is (it's set just before `showPane('orders')`, which already animates). Keep the `[data-ord]` reorder-button binding running after the list fill.
**D. Reduce the shrink** — give the loading state a min-height so account→loading doesn't collapse hard: on the `Cargando…` paragraph add `style="text-align:left;min-height:120px"`.

**Risk note for the gate:** `showPane` drives EVERY pane (phone/otp/account/orders/addrpicker/newaddr). The helper only animates when the sheet is already `.acct-open` and heights differ, so it never fights the open/close slide (that path has no `.acct-open` yet at `showPane` time). Still, this is the highest-blast-radius edit — **on-device sweep ALL pane transitions** (login OTP flow, account, addresses, Cambiar picker, new-address, Mis pedidos) + reduced-motion.

---

## Fix #4 — Reorder-prompt buttons feel vertically tight (owner-approved: 52px)
**Where:** `.acct-cfm-btn` in the injected `#acct-confirm-styles` block — **`:853`**: `.acct-cfm-btn{flex:1;height:46px;border:none;border-radius:12px;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer}`.
**Edit:** bump height + add true flex centering (min-height so text never clips):
```css
.acct-cfm-btn{flex:1;min-height:52px;display:flex;align-items:center;justify-content:center;padding:0 14px;border:none;border-radius:12px;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer}
```
Applies to all confirm dialogs (reorder prompt + `acctConfirm` delete/borrar) — consistent, intended.

---

## Non-negotiables
- **Both forms, identical past CONFIG.** Same edits, same anchors. Diff-check before pushing.
- **No money-path / submit / pricing change.** This is account-modal presentation only.
- **No cheap emoji** (chrome rule). Reuse existing functions (`toast`, `escapeHtml`, `prefersReducedMotion`).
- Escape every rendered field; never render raw `items_text`/`items[]`.
- `node --check` both `account.js`; load both forms in agent-browser for the QA below.

## QA (both forms)
1. **#1:** account sheet → tap a non-default saved address → address switches, "Dirección actualizada" toast, **sheet stays open** → tap "Mis pedidos" without re-opening. Confirm the order's "Entregar a" card updated when you later close.
2. **#2:** Mis pedidos shows each item on its own line (qty accent + name + extras sub-line), no per-line prices, order total intact; an order with >6 lines shows "+N más"; a malformed/price-less entry still renders (no throw).
3. **#3:** user-detail → Mis pedidos transition animates height smoothly (no hard jump / no shrink-to-Cargando flash); sweep every other pane transition + reduced-motion (instant, no glitch).
4. **#4:** reorder prompt buttons are visibly roomier (52px), text centered.

## Handoff back
Advisor is NOT editing these files — you are sole editor on `feat/account-modal-ux-fixes`. Push, report the SHA + the 4 QA results (agent-browser screenshots welcome, esp. #2 and #3). Advisor runs codex-on-diff (heavy on #3's showPane blast-radius + both-forms parity + no money-path touch) → owner deploys via **`git push origin main`** (both forms git-CD; no manual Netlify CLI).
