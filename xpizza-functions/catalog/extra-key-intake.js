'use strict';
// S2b (PLAN-structure-S2b-r3 §2.1) — the cart extra's `extra_key` (the customer app's field; sent only while the served menu carries
// extra_keys), judged BEFORE any money step by resolveLines (its first check, so an un-keyed legacy cart cannot skip it). A present
// extra_key must be a non-empty string (invalid_line), an ACTIVE extra key of the served tables (menu_changed — a removed extra, like a
// removed dish), and must not contradict a legacy field that is itself ANOTHER active extra's key (invalid_line). It never falls back to
// the legacy field. Once accepted, pricing's own resolver (menu-pricing extraPricingKey) reads it for EVERY consumer. Pure.
const { keyModeOfTables } = require('../menu-pricing');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

function extraKeyRefusal(rid, body, tables) {
  const items = isObj(body) && Array.isArray(body.items) ? body.items : [];
  const xt = isObj(tables) && isObj(tables.extras) ? tables.extras : {};
  const mode = require('../menu-pricing').effectiveKeyMode(rid, keyModeOfTables(tables));   // the legacy field pricing would read
  for (let i = 0; i < items.length; i++) {
    const exs = isObj(items[i]) && Array.isArray(items[i].extras) ? items[i].extras : [];
    for (let j = 0; j < exs.length; j++) {
      const e = exs[j];
      if (!isObj(e) || !own(e, 'extra_key') || e.extra_key === undefined) continue;
      const k = e.extra_key;
      if (typeof k !== 'string' || !k) return { ok: false, code: 'invalid_line', at: 'extras', index: i, extra: j };
      if (!own(xt, k)) return { ok: false, code: 'menu_changed', at: 'extras', index: i, extra: j };
      const legacy = mode === 'id' ? e.id : e.name;
      if (typeof legacy === 'string' && legacy && legacy !== k && own(xt, legacy)) return { ok: false, code: 'invalid_line', at: 'extras', index: i, extra: j };
    }
  }
  return null;
}

module.exports = { extraKeyRefusal };
