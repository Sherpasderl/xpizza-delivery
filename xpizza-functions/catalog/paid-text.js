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
// the capp's own extra cart key (customer-app/capp-menu.js extraKeyOf) — present on every line extra the app sends
const extraKeyOf = (e) => (e.extra_id != null && e.extra_id !== '' ? String(e.extra_id) : e.id != null && e.id !== '' ? String(e.id) : null);

// Codex S2b r1 P1-3: built from the RESOLVED identities (resolveLines' stamps: itemPricingKey / extraPricingKey), the SERVER price and the
// quantities. A body the app's serializer cannot represent faithfully — a line quantity other than 1 (the app sends one line per
// instance), an extra quantity other than 1, an extra the app could not have keyed (no extra_id / id), one app key for two server
// identities (or the reverse), a dish split across non-adjacent lines, a key the tables do not price — is refused, never approximated.
function paidTextRefusal(rid, body, tables) {
  if (!isObj(body) || !Object.prototype.hasOwnProperty.call(body, 'items_text')) return null;
  const items = Array.isArray(body.items) ? body.items : [];
  const labels = MP.labelsOfTables(tables); const km = MP.keyModeOfTables(tables);
  const menuPrices = isObj(tables && tables.menu) ? tables.menu : {};
  const affected = (e) => isObj(e) && extraLabelRequired(labels, MP.extraPricingKey(e, rid, km));
  if (!items.some((l) => isObj(l) && Array.isArray(l.extras) && l.extras.some(affected))) return null;
  const runs = [];
  for (const l of items) {
    if (!isObj(l) || Number(l.qty) !== 1) return MISMATCH;
    const k = MP.itemPricingKey(l, rid, km);
    if (typeof k !== 'string' || !k || typeof menuPrices[k] !== 'number') return MISMATCH;
    const last = runs[runs.length - 1];
    if (last && last.key === k) last.items.push(l); else runs.push({ key: k, items: [l] });
  }
  if (new Set(runs.map((r) => r.key)).size !== runs.length) return MISMATCH;   // the capp never splits one dish's line
  const runOf = new Map();
  for (const r of runs) {
    const byApp = new Map(); const byServer = new Map();
    const inst = [];
    for (const l of r.items) {
      const ex = {};
      for (const e of (Array.isArray(l.extras) ? l.extras : [])) {
        if (!isObj(e) || Number(e.qty) !== 1) return MISMATCH;
        const ck = extraKeyOf(e); const pk = MP.extraPricingKey(e, rid, km);
        if (ck === null || typeof pk !== 'string' || !pk) return MISMATCH;
        if ((byApp.has(ck) && byApp.get(ck).pk !== pk) || (byServer.has(pk) && byServer.get(pk) !== ck) || Object.prototype.hasOwnProperty.call(ex, ck)) return MISMATCH;
        byApp.set(ck, { pk, e }); byServer.set(pk, ck); ex[ck] = 1;
      }
      inst.push(ex);
    }
    runOf.set(r.key, { r, byApp, inst });
  }
  const cart = { lines: () => runs.map((r) => ({ key: r.key, ex: runOf.get(r.key).inst })) };
  const menu = {
    dish: (k) => { const x = runOf.get(k); const l = x && x.r.items[0]; return l ? { key: k, id: l.id, name: l.name, dish_id: l.dish_id, price: menuPrices[k], item_key: l.item_key } : null; },
    extrasFor: (k) => [...runOf.get(k).byApp.entries()].map(([ck, { pk, e }]) => ({ key: ck, id: e.id, extra_id: e.extra_id, extra_key: e.extra_key, price: e.price, supported: true,
      name: extraLabelRequired(labels, pk) ? extraLabelOf(labels, pk) : String(e.name || '') })),
  };
  let derived;
  try { derived = serialize(cart, menu).items_text; } catch (_) { return MISMATCH; }
  return body.items_text === derived ? null : MISMATCH;
}

// prepareRedemption's FREE kitchen line: a redeemed affected extra is named by its server label (null → today's name)
function freeLineLabel(tables, itemId) { const labels = MP.labelsOfTables(tables); return extraLabelRequired(labels, itemId) ? extraLabelOf(labels, itemId) : null; }

module.exports = { paidTextRefusal, freeLineLabel };
