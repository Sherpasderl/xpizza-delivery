# Proposal B1 — Server: La Musa extras pricing (amends A1)

_Executor → Auditor + Codex. Closes the extras gap found against the real in-tree form
(`la-musa-orders/index.html`, committed `fe33d1b`): A1's `la_musa` table prices the 40 MENU items
but **no extras**, so any La Musa order with an add-on rejects today. **X. Pizza byte-identical is
the centerpiece.** La Musa stays `active:false`. Strict propose-first — no code until APPROVED._

---

## Goal
Make a La Musa order with add-ons price correctly, server-side, against the form's exact extras
contract — with X. Pizza's extras output **byte-identical**. Server-priced, id-keyed, qty-aware,
anti-tamper. This is a small amendment to A1 (`menu-pricing.js` + `computeServerTotal`).

## The contract to mirror (verified in `buildOrder`, `la-musa-orders/index.html:2557-2566`)
Each item emits `extras: [{ id, name, price, qty }]`, and:
```js
// Extras are standalone — sum independently of item qty.
const extrasTotal = extrasArr.reduce((s,e) => s + e.price * e.qty, 0);
subtotal: p.price * qty[p.id] + extrasTotal
```
→ extras are **id-keyed**, **qty-aware**, and **item-qty-independent** (added per their own qty,
NOT multiplied by the dish qty).

## Changes

**(1) `menu-pricing.js` — add the La Musa extras table.** `EXTRAS_BY_RESTAURANT.la_musa` goes from
`{}` to the 14 add-ons, **id-keyed**, transcribed verbatim from the form's `EXTRAS` (`:1671-1685`):
```js
const LA_MUSA_EXTRAS = {
  // Acompañamientos
  rice_white: 50, rice_chinese: 85, papas_fritas: 75,
  // Salsas
  sauce_chili_oil: 30, sauce_aioli: 30, sauce_chipotle: 30, sauce_dumpling: 30,
  sauce_wonton: 30, sauce_pad_thai: 30, sauce_spicy_mayo: 30, sauce_tuna_tartar: 30,
  // Proteínas
  protein_chicken: 65, protein_beef: 155, protein_shrimp: 135,
};
const EXTRAS_BY_RESTAURANT = { x_pizza: EXTRA_PRICES, la_musa: LA_MUSA_EXTRAS };
```
`EXTRA_PRICES` (x_pizza, name-keyed) is **unchanged**.

**(2) `computeServerTotal` — branch the extras loop on the existing `byId` flag.** The x_pizza
`else` branch **body** preserves the original name-keyed / count-once logic **verbatim** (the
enclosing `if (byId)…else` wrapper is the only structural change — x_pizza output stays
byte-identical); la_musa keys by `ex.id`, is qty-aware and standalone, with the #4/#5 guards:
```js
for (const it of items) {
  // ... item id/qty checks unchanged; `key` = item id (la_musa) / name (x_pizza) ...

  // (#4) la_musa: a non-array `extras` is malformed = tampered (the form always emits an array).
  //      x_pizza stays on the silent-coerce path below — the SHARED line is untouched.
  if (byId && it.extras != null && !Array.isArray(it.extras)) {
    return { total: NaN, error: `invalid extras for ${key}` };
  }
  const extras = Array.isArray(it.extras) ? it.extras : [];   // shared — x_pizza byte-identical
  const seenExtraIds = byId ? new Set() : null;               // (#5) la_musa dup guard, per item

  for (const ex of extras) {
    if (byId) {  // la_musa — id-keyed, qty-aware, standalone
      const eid = ex && ex.id;
      if (!eid || !Object.prototype.hasOwnProperty.call(extraPrices, eid)) {
        return { total: NaN, error: `unknown extra: ${String(eid).slice(0, 40)}` };
      }
      if (seenExtraIds.has(eid)) {                            // (#5) duplicate id = tampered
        return { total: NaN, error: `duplicate extra ${eid}` };
      }
      seenExtraIds.add(eid);
      const eqty = Number(ex && ex.qty);
      if (!Number.isInteger(eqty) || eqty < 1 || eqty > 50) {
        return { total: NaN, error: `invalid quantity for extra ${eid}` };
      }
      total += extraPrices[eid] * eqty;   // server table only — client ex.price IGNORED
    } else {     // x_pizza — branch BODY is the original logic, character-for-character
      const ename = ex && ex.name;
      if (!ename || !Object.prototype.hasOwnProperty.call(extraPrices, ename)) {
        return { total: NaN, error: `unknown extra: ${String(ename).slice(0, 40)}` };
      }
      total += extraPrices[ename];
    }
  }
}
```

## Anti-tamper (non-negotiable, la_musa path only — x_pizza untouched)
- **(a) Price from the server id table only** — ignore the client-sent `ex.price`/`ex.name`.
- **(b) Reject unknown extra id** → `unknown extra: <id>`.
- **(c) Bound `ex.qty`** as a positive integer ≤ 50 (mirrors the item `1..50` check) → a tampered
  qty can't inflate the server total. (A1's loop has no extra-qty bound; the qty-aware path adds it.)
- **(d) (#4) Reject a non-array `extras`** (`it.extras != null && !Array.isArray`) → `invalid extras
  for <id>`. Without this, a malformed `extras` silently coerces to "no extras" and underprices.
  x_pizza keeps the silent-coerce on the shared line (byte-identical).
- **(e) (#5) Reject duplicate extra ids per item** (`seen` Set) → `duplicate extra <id>`. Per-entry
  `qty ≤ 50` is otherwise bypassable with N duplicate entries of one id; the form can never emit
  duplicates (`Object.entries(pizzaExtras[id])` has unique keys), so a duplicate is definitionally
  tampered. Implicitly caps the array at ≤14 unique ids.

## Applicability — DEFERRED (documented tradeoff, #8)
The server prices **any known extra id**; it does NOT replicate `EXTRAS_BY_CATEGORY`/`EXTRAS_BY_ITEM`
(e.g. "Proteínas only on rice"). The total is money-correct either way, and mirroring the
applicability maps server-side couples the server to a **UX constraint, not a correctness one**.
**Recorded explicitly:** the server will therefore **accept and pass an impossible modifier
downstream** — into `items_text` and the la_musa KDS ticket (e.g. a protein on a soda). That is a
UX/ops oddity, **not** a money or safety issue. Server-side applicability enforcement is logged as a
**deferred pre-launch product decision** — same shelf as `createOrderWithTasks` gating — so it's a
conscious call before `active:true`, not a silent gap.

## Parity test (B1 deliverable — replaces the snapshot tautology; #6 exact keyset)
New test parses the in-tree `la-musa-orders/index.html` and asserts **exact id-set equality** (not
just ⊆), with equal prices, in **both directions**:
- form `MENU` ids+prices **===** `MENU_BY_RESTAURANT.la_musa` (40), and
- form `EXTRAS` ids+prices **===** `EXTRAS_BY_RESTAURANT.la_musa` (14).
Subset-only would leave **server-only stale ids** as accepted tamper surface (the server prices any
known id); exact equality catches drift in **both** directions. Retires the A1 self-referential
snapshot. (Should already hold: A1 menu = 40 = form.)

## Goldens / gate
- **Main with-extras golden — a REAL form combo (#7):** `protein_chicken` is only exposed on
  `rice_03` (`EXTRAS_BY_ITEM:1726`). So the headline case is `rice_03` ×1 + `protein_chicken` ×2 +
  `sauce_aioli` ×1 → `448 + 65·2 + 30 = 608` (verified).
- **Separate, explicitly-labeled applicability test:** an applicability-**invalid but known** id
  (e.g. a protein on a soda) is still **priced** — this test *documents the deferral decision* (#8).
- **Anti-tamper rejections:** unknown id, qty out of `1..50`, non-array `extras` (#4), duplicate id
  (#5), and client `ex.price` ignored.
- **X. Pizza extras byte-identical:** existing x_pizza extras cases unchanged (name-keyed,
  count-once); `create-order-build` + `combo-validation.guard` goldens unmoved.
- Full `npm test` green.

## X. Pizza byte-identical (centerpiece, #3)
X. Pizza **behavior/output is byte-identical**. The new `if (byId)…else` wrapper is the only
structural change to the loop; the **`else` branch body preserves the original name-keyed /
count-once logic verbatim** (character-for-character). For x_pizza `byId` is false, so the #4
malformed-guard and #5 dup-guard never fire and `seenExtraIds` is `null` (unused); `EXTRA_PRICES`
and the shared `Array.isArray(...) ? : []` coerce line are untouched. No X. Pizza-reachable change.

## Out of scope
- **B2 (form)** — cambio/email/RTN/retry-restore, `cash_tendered` emission, and the **payment
  re-architecture**: the form's `processPixelPay` collects raw PAN in-browser and posts to
  `/api/pixelpay-charge` + a Make.com webhook + a demo simulate (`:2668`, `:2704`) — the OLD
  browser-sale model. B2 must **replace it with the live hosted-checkout `chargeOnlineOrder`
  redirect** (drop Make.com + demo); raw PAN in-browser is a PCI/architecture mismatch vs the
  deployed server. (Recorded here as a B2 design constraint, not a B1 change.)
- Applicability enforcement (deferred above); `la_musa.active=true`; `createOrderWithTasks` gating.
