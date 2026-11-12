'use strict';
// S2b (PLAN-structure-S2b-r3 §4) — the LABEL of an affected extra (a minted reuse, a rename) and its "label required" marker. They ride
// the S1d labels carrier — the table readVersionDocs builds beside the price docs, which the reader, the pricing tables, the last-good
// handoff, the snapshot and both mirror payloads already carry — under a namespace no dish key can take: `x:<key>` → the label,
// `x?:<key>` → '1' (required). Both are written from the version's OWN frozen_extra_keys (authoritative server metadata, never «key ≠
// derived»); a version with no affected extra adds nothing, so its tables are today's bytes. Refusal (resolveLines, every intake, every
// brand): a cart / reward extra whose key is REQUIRED (marked) and has no label → labels_unavailable. Pure.
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const LABEL = (k) => `x:${k}`;
const REQUIRED = (k) => `x?:${k}`;

// readVersionDocs: the entries for the version's affected extras (null when there are none)
function extraLabelEntries(extrasSnap, frozenExtraKeys) {
  if (!isObj(frozenExtraKeys) || !Object.keys(frozenExtraKeys).length) return null;
  const out = {};
  const byKey = new Map(((extrasSnap && extrasSnap.docs) || []).map((d) => { const v = (d && typeof d.data === 'function' ? d.data() : null) || {}; return [v.key, v]; }));
  for (const k of Object.keys(frozenExtraKeys)) {
    const v = byKey.get(k); if (!v) continue;   // an inert entry (its extra is gone) labels nothing
    out[REQUIRED(k)] = '1';
    const name = isObj(v.display) && typeof v.display.name === 'string' && v.display.name ? v.display.name : null;
    if (name) out[LABEL(k)] = name;
  }
  return Object.keys(out).length ? out : null;
}

const extraLabelOf = (labels, key) => (isObj(labels) && typeof labels[LABEL(key)] === 'string' ? labels[LABEL(key)] : null);
// «affected» comes ONLY from the authoritative marker the version's frozen_extra_keys wrote (Codex S2b r1 P1-1) — never from a key's shape
const extraLabelRequired = (labels, key) => typeof key === 'string' && isObj(labels) && labels[REQUIRED(key)] === '1';

// resolveLines: every cart extra (by pricing's own resolver) and every reward extra id the calculator would read
function extraLabelRefusal(rid, body, tables) {
  const MP = require('../menu-pricing');
  const labels = MP.labelsOfTables(tables);
  const xt = isObj(tables) && isObj(tables.extras) ? tables.extras : {};
  const km = MP.keyModeOfTables(tables);
  const items = isObj(body) && Array.isArray(body.items) ? body.items : [];
  const gap = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(xt, k) && extraLabelRequired(labels, k) && !extraLabelOf(labels, k);
  for (let i = 0; i < items.length; i++) {
    const exs = isObj(items[i]) && Array.isArray(items[i].extras) ? items[i].extras : [];
    for (let j = 0; j < exs.length; j++) if (isObj(exs[j]) && gap(MP.extraPricingKey(exs[j], rid, km))) return { ok: false, code: 'labels_unavailable', at: 'extras', index: i, extra: j };
  }
  const r = isObj(body) && isObj(body.redeem) ? body.redeem : {};
  const ids = Array.isArray(r.items) ? r.items.map((it) => (isObj(it) ? it.id : undefined)) : [];
  if (ids.some(gap)) return { ok: false, code: 'labels_unavailable', at: 'redeem' };
  return null;
}

module.exports = { extraLabelEntries, extraLabelOf, extraLabelRequired, extraLabelRefusal, LABEL, REQUIRED };
