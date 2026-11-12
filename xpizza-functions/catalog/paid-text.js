'use strict';
// S2b (PLAN-structure-S2b-r3 §2.6, Codex r2 P1-3) — the PAID kitchen text. The kitchen parses the client's items_text as is, so an
// accepted extra_key with a stale human name could charge extra A while the ticket says B. When a resolved line carries an AFFECTED
// extra (its pricing key is label-required: a minted reuse or a rename, catalog/extra-labels.js), the server derives the order's text
// with its OWN byte copy of the capp serializer (./capp-serialize, synced from customer-app/) — the client's lines, regrouped exactly as
// the capp's cart holds them (one line per dish, contiguous), with every affected extra named by its server LABEL — and a client text
// that differs is refused items_text_mismatch (409). Called by resolveLines (every intake, before any fingerprint, reservation, charge or
// write) when the body carries an items_text (the order intakes; a quote without one is not judged). No affected extra → null without
// deriving anything: today's path. Pure.
const MP = require('../menu-pricing');
const { serialize } = require('./capp-serialize');
const { extraLabelOf, extraLabelRequired } = require('./extra-labels');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const MISMATCH = Object.freeze({ ok: false, code: 'items_text_mismatch' });   // resolutionRefusal → 409
// the capp's own cart keys (customer-app/capp-menu.js keyOf / extraKeyOf), read from the fields it sends
const dishKeyOf = (l) => (l.dish_id != null && l.dish_id !== '' ? String(l.dish_id) : l.id != null ? String(l.id) : String(l.item_key));
const extraKeyOf = (e) => (e.extra_id != null && e.extra_id !== '' ? String(e.extra_id) : String(e.id));

function paidTextRefusal(rid, body, tables) {
  if (!isObj(body) || !Object.prototype.hasOwnProperty.call(body, 'items_text')) return null;
  const items = Array.isArray(body.items) ? body.items : [];
  const labels = MP.labelsOfTables(tables); const km = MP.keyModeOfTables(tables);
  const affected = (e) => isObj(e) && extraLabelRequired(labels, MP.extraPricingKey(e, rid, km));
  if (!items.some((l) => isObj(l) && Array.isArray(l.extras) && l.extras.some(affected))) return null;
  // the cart the capp serialized: one line per dish key (contiguous), each instance its extras' cart keys
  const runs = [];
  for (const l of items) {
    if (!isObj(l)) return MISMATCH;
    const k = dishKeyOf(l); const last = runs[runs.length - 1];
    if (last && last.key === k) last.items.push(l); else runs.push({ key: k, items: [l] });
  }
  if (new Set(runs.map((r) => r.key)).size !== runs.length) return MISMATCH;   // the capp never splits one dish's line
  const byKey = new Map(runs.map((r) => [r.key, r]));
  const cart = { lines: () => runs.map((r) => ({ key: r.key, ex: r.items.map((l) => Object.fromEntries((Array.isArray(l.extras) ? l.extras : []).map((e) => [extraKeyOf(e), isObj(e) ? e.qty : undefined]))) })) };
  const menu = {
    dish: (k) => { const r = byKey.get(k); const l = r && r.items[0]; return l ? { key: k, id: l.id, name: l.name, dish_id: l.dish_id, price: l.price, item_key: l.item_key } : null; },
    extrasFor: (k) => {
      const seen = new Map();
      for (const l of byKey.get(k).items) for (const e of (Array.isArray(l.extras) ? l.extras : [])) {
        if (!isObj(e)) continue;
        const pk = MP.extraPricingKey(e, rid, km);
        seen.set(extraKeyOf(e), { key: extraKeyOf(e), id: e.id, extra_id: e.extra_id, extra_key: e.extra_key, price: e.price, supported: true,
          name: extraLabelRequired(labels, pk) ? extraLabelOf(labels, pk) : String(e.name || '') });
      }
      return [...seen.values()];
    },
  };
  let derived;
  try { derived = serialize(cart, menu).items_text; } catch (_) { return MISMATCH; }
  return body.items_text === derived ? null : MISMATCH;
}

// prepareRedemption's FREE kitchen line: a redeemed affected extra is named by its server label (null → today's name)
function freeLineLabel(tables, itemId) { const labels = MP.labelsOfTables(tables); return extraLabelRequired(labels, itemId) ? extraLabelOf(labels, itemId) : null; }

module.exports = { paidTextRefusal, freeLineLabel };
