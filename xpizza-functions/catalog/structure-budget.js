'use strict';
// S2-core (PLAN-structure-S2core-r3 §4; owner Q4 caps) — the Extras page's caps and byte budgets, judged on the save and on the publish
// BEFORE any write, and only behind the extrasCatalog switch (OFF: nothing is measured — today's save, byte for byte).
//   structure_caps   ≤ 20 groups · ≤ 30 extras in a group · ≤ 600 extras · ≤ 60 ops in one draft against the live version
//   structure_bytes  source doc ≤ 512 KiB · eligibility doc ≤ 512 KiB · served public-menu body ≤ 768 KiB
// An OP is one authored Extras-page change: an extra added or removed, the group order / set changed (one), or one group entering or
// leaving a category's list (category_allow) or a dish's add / deny. An unticked extra (S1 deny_extras) and a price are today's edits,
// not ops. The documents are measured as they would be written: the source as stored, the eligibility doc the publisher writes
// (extras-eligibility-store), the body the public menu serves (public-menu composeServedMenu).
const { AddProductError } = require('./add-product');

const LIMITS = Object.freeze({ groups: 20, perGroup: 30, extras: 600, ops: 60, sourceBytes: 512 * 1024, eligibilityBytes: 512 * 1024, servedBytes: 768 * 1024 });
const refuse = (code, field, detail) => { throw new AddProductError(code, detail, { field }); };
const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const list = (v) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);
const symDiff = (a, b) => { const A = new Set(a), B = new Set(b); return [...A].filter((x) => !B.has(x)).length + [...B].filter((x) => !A.has(x)).length; };

function opsOf(draft, active) {
  const dk = new Set((draft.extras || []).map((e) => e.key)); const ak = new Set((active.extras || []).map((e) => e.key));
  let ops = symDiff([...dk], [...ak]);
  const ds = draft.structure || {}, as = active.structure || {};
  if (JSON.stringify(list(ds.extra_categories)) !== JSON.stringify(list(as.extra_categories))) ops += 1;
  const dx = ds.exposure || {}, ax = as.exposure || {};
  const dca = dx.category_allow || {}, aca = ax.category_allow || {};
  for (const c of new Set([...Object.keys(dca), ...Object.keys(aca)])) ops += symDiff(list(dca[c]), list(aca[c]));
  const dov = dx.item_overrides || {}, aov = ax.item_overrides || {};
  for (const k of new Set([...Object.keys(dov), ...Object.keys(aov)])) {
    for (const f of ['add', 'deny']) ops += symDiff(list((dov[k] || {})[f]), list((aov[k] || {})[f]));
  }
  return ops;
}

// rid, source (the draft as it will be stored), draft / active: the built RECORDS { items, extras, structure }. Returns the measurements
// (null when the switch is off); throws AddProductError structure_caps / structure_bytes { field }.
function enforce({ rid, source, draft, active, extrasCatalog }) {
  if (!extrasCatalog) return null;
  const st = draft.structure || {};
  const groups = list(st.extra_categories);
  if (groups.length > LIMITS.groups) refuse('structure_caps', 'extra_categories', `at most ${LIMITS.groups} extras groups (${groups.length})`);
  const per = new Map();
  for (const e of draft.extras || []) { const g = e && e.display && e.display.cat; per.set(g, (per.get(g) || 0) + 1); }
  for (const [g, c] of per) if (c > LIMITS.perGroup) refuse('structure_caps', 'extras', `at most ${LIMITS.perGroup} options in the group «${g}» (${c})`);
  if ((draft.extras || []).length > LIMITS.extras) refuse('structure_caps', 'extras', `at most ${LIMITS.extras} options (${draft.extras.length})`);
  const ops = opsOf(draft, active);
  if (ops > LIMITS.ops) refuse('structure_caps', 'ops', `at most ${LIMITS.ops} Extras changes in one publish (${ops}) — publish part of them first`);
  const sourceBytes = bytes(source);
  if (sourceBytes > LIMITS.sourceBytes) refuse('structure_bytes', 'source', `the menu would be ${Math.ceil(sourceBytes / 1024)} KiB (at most ${LIMITS.sourceBytes / 1024})`);
  const eligibilityBytes = bytes(require('./extras-eligibility-store').buildEligibilityDoc({ items: draft.items, extras: draft.extras, structure: st }));
  if (eligibilityBytes > LIMITS.eligibilityBytes) refuse('structure_bytes', 'eligibility', `the extras rules would be ${Math.ceil(eligibilityBytes / 1024)} KiB (at most ${LIMITS.eligibilityBytes / 1024})`);
  const servedBytes = bytes(require('./public-menu').composeServedMenu(rid, { items: draft.items, structure: st, extras: draft.extras }));
  if (servedBytes > LIMITS.servedBytes) refuse('structure_bytes', 'served', `the served menu would be ${Math.ceil(servedBytes / 1024)} KiB (at most ${LIMITS.servedBytes / 1024})`);
  return { ops, sourceBytes, eligibilityBytes, servedBytes };
}

module.exports = { enforce, opsOf, LIMITS };
