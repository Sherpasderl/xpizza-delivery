// Portal 1D · D1 — KEEP THE CATALOG ID OUT OF THE BROWSER'S WORKING RECORDS.
//
// 🔴 WHY THE SERVED MENU CARRIES AN ID THAT THE BROWSER MUST THROW AWAY. The cart does not hold
// references to menu records — it holds the RECORDS, whole (form-cart.js captures the dish and its
// options as they were when the customer added them, which is what makes an in-cart line survive a
// live menu change without being silently re-priced). It then serializes those records into the order.
// So anything the served menu carries, the cart carries, and the order carries after it.
//
// In D1 the id is shadow: minted, registered, overlaid onto the served menu, and read by NOTHING that
// decides anything. An id that reached the cart would reach the order payload, the redemption
// canonical and the quote fingerprint — and a field inside a fingerprint is not shadow, it is load
// bearing. A customer whose form fetched a menu before the backfill and a customer whose form fetched
// after would then produce different fingerprints for the same cart.
//
// The id enters the cart deliberately at D2, along with the code that knows what to do with it. Until
// then it is stripped at the boundary where served records become browser records — which is the ONE
// place that covers every later consumer, rather than at each of them.
(function () {
  'use strict';

  var IDENTITY_FIELDS = ['dish_id', 'extra_id'];

  /* Returns a NEW array of NEW records with the identity fields removed. Copies rather than deletes in
     place because the caller's array may be the served body, and a served body that has been mutated
     is a body whose etag no longer describes it. */
  function stripIdentity(records) {
    if (!Array.isArray(records)) return records;
    return records.map(function (rec) {
      if (!rec || typeof rec !== 'object') return rec;
      var hit = false;
      for (var i = 0; i < IDENTITY_FIELDS.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(rec, IDENTITY_FIELDS[i])) { hit = true; break; }
      }
      if (!hit) return rec;                       // untouched when there is nothing to strip
      var out = {};
      for (var k in rec) {
        if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
        if (IDENTITY_FIELDS.indexOf(k) !== -1) continue;
        out[k] = rec[k];
      }
      return out;
    });
  }

  // Published to BOTH worlds: the same bytes load as a Node module under `node --test` and as a
  // classic browser script inside the form. No ESM syntax — see form-cart.js for the same discipline.
  if (typeof module !== 'undefined' && module.exports) module.exports = { stripIdentity: stripIdentity, IDENTITY_FIELDS: IDENTITY_FIELDS };
  if (typeof window !== 'undefined') { window.stripIdentity = stripIdentity; }
})();
