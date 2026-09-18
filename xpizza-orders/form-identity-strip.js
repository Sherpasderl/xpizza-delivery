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

  /* ── 1D D2 — THE DEEP LEGACY PROJECTION FOR SIGNATURE BOUNDARIES ─────────────────────────────
     D2 lets the id into the cart, which is what D1 kept it out of. The reason that is safe is this
     function, and the reason it is a SECOND function rather than a reuse of stripIdentity is the trap
     that follows.

     Three client signatures hash the RAW emitted items: confirmQuoteCartSig (attaches the quote
     token), redeemSig (gates SENDING a reward order), and serverQuoteCartKey (displayed-total
     freshness, at both its producer and consumer sites). If the id appears in what they hash, all
     three shift: the token fails to attach, a valid reward order is blocked from sending, and an
     equivalent cached total is thrown away. So each of them hashes THIS projection instead of the
     items themselves, and the emitted body keeps its ids.

     🔴 DEEP, AND stripIdentity IS NOT. stripIdentity removes dish_id from a record; it does not touch
     a nested extras[] entry, because in D1 the records it strips have no nested extras. A cart LINE
     does — every option on the line — and a nested extra_id shifts these signatures exactly as a
     dish_id does. Reusing the shallow function here would look correct, pass a dish-only test, and
     leave the extras half of the hazard live: the same one-direction miss this programme keeps
     producing. Hence a separate function, and hence the nested-extra case in its tests.

     🔴 KEY ORDER IS PRESERVED, WHICH IS THE POINT. These signatures are JSON.stringify output, so key
     ORDER is part of the value. Copying in iteration order and skipping only the identity keys yields
     an object byte-identical to the one a pre-D2 client emitted — which is what makes "id present vs
     absent" a no-op rather than merely "same fields, different string".

     NON-MUTATING: the array it is handed is the one being sent in the request body. */
  function legacyCartForSig(items) {
    if (!Array.isArray(items)) return items;
    return items.map(function (line) {
      if (!line || typeof line !== 'object') return line;
      var out = {};
      for (var k in line) {
        if (!Object.prototype.hasOwnProperty.call(line, k)) continue;
        if (k === 'dish_id') continue;
        if (k === 'extras' && Array.isArray(line.extras)) {
          out.extras = line.extras.map(function (ex) {
            if (!ex || typeof ex !== 'object') return ex;
            var e = {};
            for (var j in ex) {
              if (!Object.prototype.hasOwnProperty.call(ex, j)) continue;
              if (j === 'extra_id') continue;
              e[j] = ex[j];
            }
            return e;
          });
          continue;
        }
        out[k] = line[k];
      }
      return out;
    });
  }

  // Published to BOTH worlds: the same bytes load as a Node module under `node --test` and as a
  // classic browser script inside the form. No ESM syntax — see form-cart.js for the same discipline.
  if (typeof module !== 'undefined' && module.exports) module.exports = { stripIdentity: stripIdentity, legacyCartForSig: legacyCartForSig, IDENTITY_FIELDS: IDENTITY_FIELDS };
  if (typeof window !== 'undefined') { window.stripIdentity = stripIdentity; window.legacyCartForSig = legacyCartForSig; }
})();
