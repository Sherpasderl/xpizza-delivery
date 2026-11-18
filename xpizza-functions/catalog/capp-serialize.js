// Customer app S1 (PLAN-capp-S1.FINAL §3) — the cart → the order body's `items` + `items_text`. Pure, UMD, brand-agnostic (no
// restaurant id or name in this file — guarded). NO server change: the body fits today's pricing for every restaurant.
//
//   items[]    ONE line PER INSTANCE, qty 1: { id, name, dish_id, qty: 1, price, subtotal, extras: [{ id, name, extra_id, qty: 1,
//              instance: 0 }], extrasTotal }. BOTH legacy keys (id AND name) are sent, so the server's own rule picks
//              (menu-pricing.js itemPricingKey / extraPricingKey). Unique toggle extras per line satisfy both server extra rules.
//              subtotal = price + Σ that instance's extras (F1: the line total INCLUDING extras).
//   items_text ONE row PER CONFIGURATION GROUP, groups joined by ' | ' (the KDS / rail / handheld / dispatch split):
//              `${n}x ${name} (L${price})` + ` [${extra names joined by ' + '}]` when configured. No ',', '|', '+', '[' or ']'
//              inside a bracket (the driver splits on ',', dispatch on '|', extras join on '+' — «B + A» would read as two extras
//              and collide with a real «B»+«A» configuration's text and content key) — such an extra label is refused.
//   S3 (D4c-grill/item-s1/S3-DESIGN.md D1): a dish with an item_key (the served map) adds it, appended LAST; its name is kept, and its
//              id ONLY when the id IS the key (a minted / name-keyed dish sends no disagreeing id). No map ⇒ today's exact line.
//   DETERMINISTIC: lines in first-add order, instances by index, extras sorted by key → re-serializing an unchanged cart is
//   byte-identical (charge-input / payment fingerprints, quote tokens). LIMIT: items_text ≤ 1,500 characters, the server's own
//   cap (index.js sanitizeText 1500) — over it the serializer refuses, so the server never truncates this text.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappSerialize = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ITEMS_TEXT_LIMIT = 1500;
  const UNSAFE_LABEL = /[,|+[\]]/;   // the reader / grammar delimiters: ',' (driver) '|' (groups) '+' (extras) '[' ']' (brackets)
  const err = (code, detail) => { const e = new Error(detail ? `${code}: ${detail}` : code); e.code = code; return e; };
  const sigOf = (inst) => Object.keys(inst || {}).sort().join(',');

  function serialize(cart, menu) {
    const items = []; const rows = []; let subtotalCents = 0;
    for (const l of cart.lines()) {
      const d = menu.dish(l.key);
      if (!d || d.launcher) throw err(d ? 'choice_required' : 'unknown_dish', String(l.key));
      const allowed = new Map(menu.extrasFor(d.key).map((e) => [e.key, e]));
      const groups = new Map();
      l.ex.forEach((inst) => {
        const keys = Object.keys(inst || {}).sort();
        const extras = keys.map((k) => {
          const e = allowed.get(k);
          if (!e) throw err('extra_not_offered', `${k} on ${d.key}`);
          if (!e.supported || inst[k] !== 1) throw err('unsupported_extra_quantity', k);
          if (UNSAFE_LABEL.test(e.name)) throw err('unsafe_extra_label', e.name);
          return e;
        });
        const extrasTotal = extras.reduce((s, e) => s + e.price, 0);
        const line = { id: d.id, name: d.name, dish_id: d.dish_id, qty: 1, price: d.price, subtotal: d.price + extrasTotal,
          extras: extras.map((e) => ({ id: e.id, name: e.name, extra_id: e.extra_id, qty: 1, instance: 0, ...(e.extra_key ? { extra_key: e.extra_key } : {}) })), extrasTotal };   // S2b §5: the served key, appended last (absent without the map)
        if (d.item_key) { if (String(d.id) !== d.item_key) delete line.id; line.item_key = d.item_key; }   // S3 D1
        items.push(line);
        subtotalCents += (d.price + extrasTotal) * 100;
        const s = sigOf(inst);
        if (!groups.has(s)) groups.set(s, { n: 0, names: extras.map((e) => e.name) });
        groups.get(s).n += 1;
      });
      for (const g of groups.values()) rows.push(`${g.n}x ${d.name} (L${d.price})${g.names.length ? ` [${g.names.join(' + ')}]` : ''}`);
    }
    if (!items.length) throw err('empty_cart');
    const itemsText = rows.join(' | ');
    if (itemsText.length > ITEMS_TEXT_LIMIT) throw err('cart_text_too_long', String(itemsText.length));
    return { items, items_text: itemsText, subtotal_cents: subtotalCents };
  }

  // the ISSUED request is authoritative on resume: stored as its serialized JSON STRING (immutable), resent byte-for-byte — an
  // edited cart is a NEW order; nothing can mutate what was issued
  function issuedSnapshot(body) { return Object.freeze({ v: 1, json: JSON.stringify(body) }); }
  function resendBody(snapshot) {
    if (!snapshot || snapshot.v !== 1 || typeof snapshot.json !== 'string') throw err('bad_issued_snapshot');
    return JSON.parse(snapshot.json);
  }

  return { serialize, issuedSnapshot, resendBody, ITEMS_TEXT_LIMIT };
});
