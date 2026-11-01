// Customer app — the LIVE availability → the store's sold dish keys (PLAN-avail-identity; advisor ruling 2026-11-01: the identity
// rides in the published menu envelope). Pure, UMD, brand-agnostic (no restaurant id or name in this file — guarded).
//
// The restaurant's availability identity is DATA: the envelope's body.avail_identity = { field: 'id' | 'name' } (5f, marker 1d.3),
// kept by CappMenu.adaptMenu as menu.availIdentity — never hard-coded per brand here. Each dish's key is
// availKey(dish[field]) (avail-key.js), and a dish is SOLD when availabilityReducer.decide(the entries under every key it has had,
// 'any_false') says so — the forms' own rule (their ownSoldOut over availKeysFor's per-session key history), with the SAME synced
// modules the forms and the server use. No identity (an old envelope) ⇒ null: FAIL-OPEN, exactly the shell's contract.
//
// createAvailability({ availKey, decide }) → { soldKeys(menu, data) → array of sold dish keys | null }
//   data: the RTDB restaurants/{rid}/item_availability node (an object; anything else reads as empty — the forms' rule)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappAvailability = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIELDS = ['id', 'name'];

  function createAvailability(opts) {
    const o = opts || {};
    const availKey = o.availKey, decide = o.decide;
    if (typeof availKey !== 'function' || typeof decide !== 'function') throw new Error('capp-availability: availKey and decide are required');
    const history = new Map();   // `${rid}\0${dish id}` → every key that dish has had this session (the forms' availKeysFor)
    function keysOf(rid, dish, field) {
      const raw = dish[field];
      if (raw == null || raw === '') return null;
      const hk = `${rid}\0${String(dish.id)}`, seen = history.get(hk) || [];
      const k = availKey(raw);
      if (!seen.includes(k)) seen.push(k);
      history.set(hk, seen);
      return seen;
    }
    function soldKeys(menu, data) {
      const field = menu && menu.availIdentity;
      if (!FIELDS.includes(field) || !Array.isArray(menu.dishes)) return null;
      const node = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      const sold = [];
      for (const d of menu.dishes) {
        const keys = keysOf(menu.rid, d, field);
        if (keys && decide(keys.map((k) => node[k]), 'any_false')) sold.push(d.key);
      }
      return sold;
    }
    return { soldKeys };
  }

  return { createAvailability, FIELDS };
});
