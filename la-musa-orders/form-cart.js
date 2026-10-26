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
// 🔴 PLAN 5 (owner-approved, DECISIONS 2026-10-26) — A NEW PRICE MAY BE ADOPTED, BUT ONLY DISCLOSED. When
// every blocked line is nothing but a dish whose price changed, the form may adopt the live prices
// (adoptPrices) — and only at a moment that renders the price-change notice, which the form confirms on
// screen before the adoption stands; any failure rolls it back. Never at the send, never in the
// background. The disclosure is the `disclosed` map below; the forms rebuild the notice from it on
// every render, so no re-render can erase a disclosure while its line exists. Every other conflict
// (options, availability, choice, resume, reward) keeps today's block — priceNoticeChanges() decides.
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

  // PLAN 5 — dish key → { name, from, to } (UNIT prices) for every price the customer has been SHOWN changing.
  // Written only by adoptPrices(); removed with its line; cleared with the cart. Dish keys only — option
  // reprices are never adopted (they keep today's block).
  const disclosed = new Map();

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
    if (qty <= 0) { lines.delete(key); disclosed.delete(key); return; }
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
  // What was AGREED about an option — its pricing key and its price. The pricing key is derived here,
  // once, by the adapter (name for x_pizza, id for la_musa), so a caller cannot accidentally substitute
  // the cart key for it: those two differ on x_pizza, which is exactly the substitution that made a
  // renamed option invisible to the order signature.
  const extraAgreed = (key) => (chosenExtras.has(key)
    ? { key, pricingKey: chosenExtras.get(key).pricingKey, price: chosenExtras.get(key).price }
    : null);

  function classifyExtra(key, live) {
    const added = chosenExtras.get(key);
    // 🔴 NO CAPTURE IS NOT "NOTHING TO COMPARE", IT IS THE WORST CASE. This returned null, and null
    // meant resolved: an option the form had selected but never captured produced no conflict, no
    // record, and therefore no entry in the serialized order — the silent drop, one level below the
    // dish. It is reachable exactly the way the dish version was: a control left on screen across a
    // live upgrade is tapped, the write succeeds, the capture cannot (the option is not in the live
    // list to capture FROM). Having no record of what the customer agreed to pay is precisely when a
    // line must stop, not when it may pass.
    if (!added) return 'uncaptured';
    if (!live) return 'removed';
    if (adapter.extraPricingKey(live) !== added.pricingKey) return 'renamed';
    if (live.price !== added.price) return 'repriced';
    /* 🔴 THE SAME FOURTH STATE AS THE DISH, ONE LEVEL DOWN. Adding `unavailable` to the dish check and
       not here left the identical hole for OPTIONS: an extra 86'd after it is on a line is still in the
       list, same name, same price, so all four checks above said resolved and it went to the charge.
       The server's availability gate iterates TOP-LEVEL ITEMS only, so unlike the dish case there is no
       backstop underneath this one — an 86'd extra is charged and then cannot be made. Fixing the dish
       and leaving the option is exactly the containment-in-one-direction failure this file already
       carries a note about; it is fixed in both directions this time. */
    if (unavailable(live)) return 'unavailable';
    return null;
  }

  // 🔴 AN UNRESOLVED LINE MUST STILL BE REMOVABLE. The customer's only way out of a line whose dish left
  // the menu is to take it out — and the form's decrement path has no live record to hand back, because
  // there isn't one. So quantity can be adjusted BY KEY, against a line that already exists. It can
  // never CREATE one: a line with no captured record is the drop-shaped hole this module closes.
  function setQtyByKey(key, n) {
    if (!lines.has(key)) return false;
    const qty = Number(n) || 0;
    if (qty <= 0) { lines.delete(key); disclosed.delete(key); return true; }
    const line = lines.get(key);
    lines.set(key, { key, qty, added: line.added });
    return true;
  }

  const qtyOf = (key) => (lines.has(key) ? lines.get(key).qty : 0);
  const has = (key) => lines.has(key);
  const keys = () => [...lines.keys()];
  const clear = () => { lines.clear(); disclosed.clear(); };
  // A WHOLE NEW CART: the lines AND the captured-options ledger. clear() keeps the ledger on purpose (a line removed and
  // re-added keeps the option price the customer already agreed to); a cart the customer explicitly DISCARDS ("Empezar de
  // nuevo") must not carry the discarded cart's captured option prices into the fresh one.
  const reset = () => { lines.clear(); chosenExtras.clear(); disclosed.clear(); };

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
  //   unavailable  the record exists, unchanged, and the kitchen has 86'd it since it was added.
  //             🔴 THE FOURTH STATE, ADDED IN 1B TASK 9, AND IT EXISTED ONLY IN THE GAP BETWEEN TWO
  //             TASKS THAT BOTH PASSED. Availability blocks ADDING a dish (Task 7) and the cart blocks
  //             removed/renamed/repriced lines (Task 4) — and neither ever asked what happens to a line
  //             ALREADY in the cart when the kitchen runs out. It is still on the menu, same name, same
  //             price, so all three checks above returned resolved and the order went to the charge with
  //             a dish nobody can cook. The server's availability gate rejects it, so this was never a
  //             money defect — but letting a customer complete a checkout the server will refuse is the
  //             same "money-safe is not honest" line drawn for a broken apply, and the customer learns
  //             about it later and with less to act on.
  let unavailable = () => false;
  function classify(line, live) {
    if (!live) return 'removed';
    if (adapter.pricingKey(live) !== line.added.pricingKey) return 'renamed';
    if (live.price !== line.added.price) return 'repriced';
    if (unavailable(live)) return 'unavailable';
    return null;
  }

  // Resolve every line against a menu. `findRecord(key)` is the caller's lookup — the form's MENU,
  // whatever shape it is in.
  //
  // The LIVE record is what a resolved line serializes from, so a resolved line is always current.
  // An unresolved line serializes from what it was ADDED as, because that is the only thing that is
  // true about it — and it blocks submit, so it never reaches a charge.
  /* `isUnavailable` is OPTIONAL and defaults to "everything is available". This module knows nothing
     about the availability feed and should not: it is handed a predicate the way it is handed the two
     lookups. Defaulting to false keeps every existing caller and test meaning exactly what it meant —
     a default that silently blocked would have been a far worse way to find out who had not been
     updated. */
  function resolve(findRecord, findExtra, isUnavailable) {
    const lookupExtra = findExtra || (() => null);
    unavailable = typeof isUnavailable === 'function' ? isUnavailable : () => false;
    return keys().map((key) => {
      const line = lines.get(key);
      const live = findRecord(key) || null;
      const unresolved = classify(line, live);
      // An option is resolved against the live menu the same way, and reported ON the line that carries
      // it — a customer told "an option changed" with no line attached cannot act on it.
      const extras = adapter.extraKeysFor(key).map((ek) => {
        const liveExtra = lookupExtra(ek) || null;
        const problem = classifyExtra(ek, liveExtra);
        // An uncaptured option has no captured record by definition, so fall through to the live one
        // if there is one — it is still blocked either way, but it can at least be NAMED on screen.
        const captured = extraAddedRecord(ek);
        return { key: ek, unresolved: problem, record: problem ? (captured || liveExtra) : (liveExtra || captured), live: liveExtra };
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

  // ── PLAN 5: DISCLOSED ADOPTION ────────────────────────────────────────────────────────────────────
  // ELIGIBILITY, computed on the WHOLE cart before anything is mutated. `resolved` is the form's EFFECTIVE
  // lines (resolve() plus the form's own launcher marking, so a 'choice' line is seen). Eligible only when
  // there is at least one blocked line, EVERY blocked line is a dish whose only problem is its price, no
  // line anywhere carries an option conflict, the dish is not unavailable by an INDEPENDENT check (classify
  // returns 'repriced' before it ever asks about availability), it is not a launcher, and the form reports
  // no resume/reward context. Anything else → null, and the caller's path is today's, untouched.
  function priceNoticeChanges(resolved, ctx) {
    const c = ctx || {};
    if (c.blockedByContext) return null;
    if (!Array.isArray(resolved)) return null;
    const isUnavailable = typeof c.isUnavailable === 'function' ? c.isUnavailable : () => false;
    const isLauncher = typeof c.isLauncher === 'function' ? c.isLauncher : () => false;
    const blocked = resolved.filter((l) => l && l.blocked);
    if (!blocked.length) return null;
    if (resolved.some((l) => l && Array.isArray(l.extras) && l.extras.some((x) => x && x.unresolved))) return null;
    for (const l of blocked) {
      if (l.unresolved !== 'repriced' || !l.live || !l.added) return null;
      if (!Number.isFinite(l.live.price) || !Number.isFinite(l.added.price)) return null;
      if (isUnavailable(l.live) || isLauncher(l)) return null;
    }
    return blocked.map((l) => ({ key: l.key, name: l.live.name, from: l.added.price, to: l.live.price, live: l.live }));
  }

  // ADOPTION, all or nothing, reversible. Adopts each change through accept() and records its disclosure.
  // Returns a rollback() that restores the lines AND the disclosures exactly as they were, or null when
  // nothing was adopted (any failure part-way restores before returning). The caller confirms the notice
  // rendered and calls rollback() if it did not.
  function adoptPrices(changes) {
    if (!Array.isArray(changes) || !changes.length) return null;
    const prevLines = new Map(lines);
    const prevDisclosed = new Map(disclosed);
    const restore = () => {
      lines.clear(); prevLines.forEach((v, k) => lines.set(k, v));
      disclosed.clear(); prevDisclosed.forEach((v, k) => disclosed.set(k, v));
    };
    try {
      for (const ch of changes) {
        if (!ch || typeof ch.key !== 'string' || !Number.isFinite(ch.from) || !Number.isFinite(ch.to) || !accept(ch.key, ch.live)) { restore(); return null; }
        disclosed.set(ch.key, { name: String(ch.name == null ? '' : ch.name), from: ch.from, to: ch.to });
      }
    } catch (e) { restore(); return null; }
    return restore;
  }

  // The order is complete: what was disclosed for it has nothing more to say (the lines themselves are the form's to reset).
  const clearDisclosed = () => disclosed.clear();

  const disclosedList = () => [...disclosed.entries()].map(([key, e]) => ({ key, name: e.name, from: e.from, to: e.to }));

  // 🔴 THE CART MUST SURVIVE LEAVING THE PAGE. Online payment sends the customer to a hosted checkout
  // and back onto a FRESH page, where the form restores its state from localStorage. Restoring qty
  // without the cart re-creates the very split this module closes — the quantities come back and the
  // lines do not — so the captured records travel with them. Plain JSON: no Maps, no undefined.
  function snapshot() {
    return {
      v: 1,
      lines: keys().map((k) => { const l = lines.get(k); return { key: k, qty: l.qty, added: l.added }; }),
      extras: [...chosenExtras.values()],
      // PLAN 5: present ONLY when something was disclosed, so every snapshot without one is byte-identical to before.
      ...(disclosed.size ? { disclosed: disclosedList() } : {}),
    };
  }

  // Rebuild from a snapshot. Deliberately strict rather than forgiving: this is the ONLY way a captured
  // agreed price survives the trip to a hosted checkout and back, so a stash that cannot be read whole
  // is refused whole and the caller restores nothing at all. (There is no rebuild-from-the-live-menu
  // fallback — that would capture today's price AS the agreed one; see cartRestore() in both forms.)
  function hydrate(snap) {
    if (!snap || typeof snap !== 'object' || !Array.isArray(snap.lines) || !Array.isArray(snap.extras)) return false;
    const okLine = (l) => l && typeof l === 'object' && typeof l.key === 'string' && Number(l.qty) > 0
      && l.added && typeof l.added === 'object' && l.added.record;
    const okExtra = (e) => e && typeof e === 'object' && typeof e.key === 'string' && e.record;
    if (!snap.lines.every(okLine) || !snap.extras.every(okExtra)) return false;
    // 🔴 EVERY ELEMENT BEING WELL-FORMED IS NOT THE SAME AS THE SET BEING WELL-FORMED, and the gap is
    // not cosmetic. These maps are keyed, so two entries sharing a key is not a duplicate — it is a
    // SILENT OVERWRITE: the second Map.set erases the first. A snapshot carrying the same line twice at
    // two different agreed prices therefore hydrated cleanly with whichever came last, and if that was
    // today's price the reprice disagreed with nothing and the cart reached a charge endpoint.
    // Uniqueness is an invariant OF THE SET, so it has to be checked on the set — element-wise validation
    // cannot see it however strict each element's check is.
    const unique = (arr) => new Set(arr.map((x) => x.key)).size === arr.length;
    if (!unique(snap.lines) || !unique(snap.extras)) return false;
    lines.clear(); chosenExtras.clear();
    snap.lines.forEach((l) => lines.set(l.key, { key: l.key, qty: Number(l.qty), added: l.added }));
    snap.extras.forEach((e) => chosenExtras.set(e.key, e));
    // PLAN 5: a disclosure survives a restore only while it still describes the captured line (same key, and
    // the captured price IS the disclosed new price). Anything else is dropped — it can never block a restore.
    disclosed.clear();
    if (Array.isArray(snap.disclosed)) {
      for (const d of snap.disclosed) {
        if (!d || typeof d !== 'object' || typeof d.key !== 'string' || typeof d.name !== 'string') continue;
        if (!Number.isFinite(d.from) || !Number.isFinite(d.to) || !lines.has(d.key)) continue;
        if (lines.get(d.key).added.price !== d.to) continue;
        disclosed.set(d.key, { name: d.name, from: d.from, to: d.to });
      }
    }
    return true;
  }

  const remove = (key) => { disclosed.delete(key); return lines.delete(key); };

  return {
    setQty, setQtyByKey, qtyOf, has, keys, clear, reset, remove,
    noteExtra, extraAddedRecord, extraAgreed, classifyExtra, acceptExtra,
    resolve, accept, classify, snapshot, hydrate,
    priceNoticeChanges, adoptPrices, disclosed: disclosedList, clearDisclosed,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createCart };
if (typeof window !== 'undefined') window.createCart = createCart;
