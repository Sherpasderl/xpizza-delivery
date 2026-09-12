'use strict';
// ── form-cart — THE CART IS ITS OWN STATE (Portal 1B Task 4) ──────────────────────────────────────
//
// 🔴 THE BUG THIS EXISTS TO MAKE IMPOSSIBLE. Both forms serialize the order as
//
//       MENU.filter(p => qty[p.id] > 0).map(...)
//
// — the cart is a FILTER OVER THE DISPLAYED MENU. That is correct exactly as long as the menu never
// changes under the customer, which is the assumption 1B removes. Once a live upgrade can replace
// MENU mid-session, a dish that is no longer in it is not "removed from the cart": it is removed from
// the SUBMISSION, silently, while qty[id] still says 2. The customer sees the total drop, or does not
// notice at all, and receives an order they did not place. The same line does it for options:
// `EXTRAS.find(e => e.id === eid)` returning undefined drops that option from the order and from the
// price, with no error anywhere.
//
// THE FIX IS NOT A GUARD, IT IS AN OWNERSHIP CHANGE. The cart stops being a view of the menu and
// becomes state that carries its own copy of what each line was added as — key, name, price. A menu
// that no longer contains the line cannot erase it, because the menu is no longer where the line
// lives. What a live upgrade CAN do is make a line UNRESOLVED: the backing record is gone, or renamed,
// or repriced. That is surfaced to the customer and blocks submit. It is never resolved silently in
// either direction — not by dropping the line, and not by quietly adopting the new price.
//
// WHEN NOTHING HAS CHANGED, NOTHING CHANGES. A line whose live record matches what it was added as
// serializes exactly as it does today, byte for byte. The new behaviour only exists on a conflict.
//
// UMD-lite (no `export`), canonical here, byte-identical copy in la-musa-orders/ — same discipline as
// avail-key.js and form-live-menu.js, with a drift test.
//
// THE BRANDS DIFFER AND THE ADAPTER HOLDS THE DIFFERENCE: x_pizza keys options per pizza INSTANCE
// ({pid: {0: {eid: q}}}) and is priced server-side by NAME; la_musa keys them per item with a
// quantity ({pid: {eid: q}}) and is priced by ID. Neither shape belongs in here.
function createCart(options) {
  const { adapter } = options || {};
  if (!adapter) throw new Error('createCart: an adapter is required');
  // itemKey/pricingKey identify a DISH; extraKey/extraPricingKey identify an OPTION; extraKeysFor
  // answers "which options does this line currently carry?" — the one question whose answer is shaped
  // differently per brand (x_pizza nests by pizza instance, la_musa by option quantity), so the cart
  // asks it rather than owning it.
  for (const hook of ['itemKey', 'pricingKey', 'extraKey', 'extraPricingKey', 'extraKeysFor']) {
    if (typeof adapter[hook] !== 'function') throw new Error(`createCart: the adapter must provide ${hook}`);
  }

  // key → { key, qty, added }  where `added` is the RECORD AS IT WAS WHEN THE LINE WAS ADDED.
  // Keeping the whole record, not just the price, is what lets a removed line still be named and
  // priced on screen — "1x Carnívora L340, no longer available" rather than "1x something".
  const lines = new Map();

  // 🔴 OPTIONS NEED THE SAME OWNERSHIP, FOR THE SAME REASON. `EXTRAS.find(e => e.id === eid)` returning
  // undefined is the identical bug one level down: the option drops out of the order and out of the
  // price, and the only trace is a total that quietly got smaller. So an option is captured when it is
  // selected, into a ledger shared by every line that uses it — options are per-menu, not per-line.
  // The form still owns WHICH options sit on which line; it owns no record of what they cost.
  const chosenExtras = new Map();

  const snapshotOf = (record) => ({
    key: adapter.itemKey(record),
    pricingKey: adapter.pricingKey(record),
    name: record && record.name,
    price: record && record.price,
    cat: record && record.cat,
    record,
  });

  // Setting a quantity is the only way a line enters the cart, and it is where the record is captured.
  // `record` is whatever the menu held AT THAT MOMENT — the cart's own copy, from then on.
  function setQty(record, n) {
    const key = adapter.itemKey(record);
    const qty = Number(n) || 0;
    if (qty <= 0) { lines.delete(key); return; }
    const existing = lines.get(key);
    lines.set(key, { key, qty, added: existing ? existing.added : snapshotOf(record) });
  }

  // Capture an option at the moment it is selected. Idempotent by key: re-selecting an option the cart
  // already holds must NOT re-capture it at today's price, or a live re-price would be adopted silently
  // by the customer clicking "+" — exactly the behaviour this module refuses for dishes.
  function noteExtra(record) {
    const key = adapter.extraKey(record);
    if (!chosenExtras.has(key)) {
      chosenExtras.set(key, { key, pricingKey: adapter.extraPricingKey(record), name: record && record.name, price: record && record.price, record });
    }
    return key;
  }

  const extraAddedRecord = (key) => (chosenExtras.has(key) ? chosenExtras.get(key).record : null);

  function classifyExtra(key, live) {
    const added = chosenExtras.get(key);
    if (!added) return null;                                        // never captured — nothing to compare
    if (!live) return 'removed';
    if (adapter.extraPricingKey(live) !== added.pricingKey) return 'renamed';
    if (live.price !== added.price) return 'repriced';
    return null;
  }

  // 🔴 AN UNRESOLVED LINE MUST STILL BE REMOVABLE. The customer's only way out of a line whose dish left
  // the menu is to take it out — and the form's decrement path has no live record to hand back, because
  // there isn't one. So quantity can be adjusted BY KEY, against a line that already exists. It can
  // never CREATE one: a line with no captured record is the drop-shaped hole this module closes.
  function setQtyByKey(key, n) {
    if (!lines.has(key)) return false;
    const qty = Number(n) || 0;
    if (qty <= 0) { lines.delete(key); return true; }
    const line = lines.get(key);
    lines.set(key, { key, qty, added: line.added });
    return true;
  }

  const qtyOf = (key) => (lines.has(key) ? lines.get(key).qty : 0);
  const has = (key) => lines.has(key);
  const keys = () => [...lines.keys()];
  const clear = () => lines.clear();

  // 🔴 HOW A LINE BECOMES UNRESOLVED. Three ways, and each is a different question to the customer:
  //
  //   removed   the dish is not on the menu any more. Nothing to re-price against; they must take it
  //             out, and they must be told, because it is the one they chose.
  //   renamed   the record exists but its PRICING key changed. For x_pizza the pricing key IS the
  //             name, so a rename is a different product to the server — submitting it would charge
  //             for something else or fail. Task 5 owns how conservative this is per brand; the
  //             mechanism is here.
  //   repriced  the record exists and costs something different from what the customer agreed to.
  //             Adopting the new price silently is the one behaviour nobody would defend.
  //
  // A line that matches is resolved and serializes exactly as before.
  function classify(line, live) {
    if (!live) return 'removed';
    if (adapter.pricingKey(live) !== line.added.pricingKey) return 'renamed';
    if (live.price !== line.added.price) return 'repriced';
    return null;
  }

  // Resolve every line against a menu. `findRecord(key)` is the caller's lookup — the form's MENU,
  // whatever shape it is in.
  //
  // The LIVE record is what a resolved line serializes from, so a resolved line is always current.
  // An unresolved line serializes from what it was ADDED as, because that is the only thing that is
  // true about it — and it blocks submit, so it never reaches a charge.
  function resolve(findRecord, findExtra) {
    const lookupExtra = findExtra || (() => null);
    return keys().map((key) => {
      const line = lines.get(key);
      const live = findRecord(key) || null;
      const unresolved = classify(line, live);
      // An option is resolved against the live menu the same way, and reported ON the line that carries
      // it — a customer told "an option changed" with no line attached cannot act on it.
      const extras = adapter.extraKeysFor(key).map((ek) => {
        const liveExtra = lookupExtra(ek) || null;
        const problem = classifyExtra(ek, liveExtra);
        return { key: ek, unresolved: problem, record: problem ? extraAddedRecord(ek) : (liveExtra || extraAddedRecord(ek)), live: liveExtra };
      });
      return {
        key,
        qty: line.qty,
        unresolved,
        record: unresolved ? line.added.record : live,
        added: line.added,
        live,
        extras,
        // 🔴 BOTH DIRECTIONS, AND THIS IS THE ONE I EXPECTED TO GET WRONG. A line is blocked if the DISH
        // is unresolved OR if any OPTION on it is. Checking only the dish is the containment-in-one-
        // direction failure this programme keeps producing: the dish is fine, the chorizo vanished, the
        // line looks clean and submits without it.
        blocked: !!unresolved || extras.some((x) => !!x.unresolved),
      };
    });
  }

  // 🔴 NO unresolved()/canSubmit() HELPER HERE, deliberately. Both existed and neither was called: the
  // forms gate on their own cartConflicts(), which filters resolve() by `blocked`. A second statement
  // of the same rule that nothing exercises is a rule that can rot — a mutation sweep confirmed it,
  // surviving a mutant that broke the unused copy while every real gate kept working. One rule, at the
  // point that uses it.

  // Adopt the live record for a line the customer has accepted (Task 6 wires the control). This is
  // the ONLY way a line's captured record changes after it is added, and it is always an explicit act.
  function accept(key, live) {
    const line = lines.get(key);
    if (!line || !live) return false;
    lines.set(key, { key, qty: line.qty, added: snapshotOf(live) });
    return true;
  }

  // The option half of accept(): the customer took the new price for an option, explicitly.
  function acceptExtra(key, live) {
    if (!chosenExtras.has(key) || !live) return false;
    chosenExtras.delete(key);
    noteExtra(live);
    return true;
  }

  const remove = (key) => lines.delete(key);

  return {
    setQty, setQtyByKey, qtyOf, has, keys, clear, remove,
    noteExtra, extraAddedRecord, classifyExtra, acceptExtra,
    resolve, accept, classify,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createCart };
if (typeof window !== 'undefined') window.createCart = createCart;
