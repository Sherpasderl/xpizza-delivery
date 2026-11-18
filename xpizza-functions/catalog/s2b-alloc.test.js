'use strict';
// S2b (PLAN-structure-S2b-r3 §1, §3) — a RETIRED extra name re-added: with the dark switch ON the allocator mints a fresh opaque key
// (the S1c shape, the shared collision set) and records the reuse in the server-owned frozen_extra_keys; the ONE validator (the save's,
// the publish's and the manager request's) accepts such a row ONLY with its matching entry. OFF: name_needs_new_id, exactly today.
// Names are unique across the WHOLE candidate (two fresh rows reusing one retired name never both pass). Real sources; the real
// allocator and validator. Run: node catalog/s2b-alloc.test.js
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { allocateExtras } = require('./extras-allocate');
const { validateNewExtras } = require('./extras-validate');
const { OPAQUE_SYNTAX } = require('./mint-opaque');
const { slugify } = require('./add-product');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const refused = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); return e; } assert.fail(`not refused (${code})`); };
const MODE = { x_pizza: 'name', la_musa: 'id' };
let draws = 0; const mint = { newKey: () => `i_${'abcdefghijkl'.slice(0, 11)}${'mnpqrstuvw'[draws++ % 10]}` };

// a restaurant whose FIRST extra was retired: it is gone from the live menu and its key is reserved (kind 'extra')
function retired(rid) {
  const live = buildSourceFromCode(rid);
  const gone = live.extras[0];
  live.extras = live.extras.slice(1);
  if (Array.isArray(live.structure.extra_order)) live.structure.extra_order = live.structure.extra_order.filter((k) => k !== gone.key);
  for (const f of ['extras_by_category', 'extras_by_item']) if (live.structure[f]) for (const v of Object.values(live.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(gone.key); if (i >= 0) v.splice(i, 1); }
  if (Array.isArray(live.structure.redeem_eligible_extras)) live.structure.redeem_eligible_extras = live.structure.redeem_eligible_extras.filter((k) => k !== gone.key);
  // the key a re-add of that NAME derives (name mode: the tidy name; id mode: its slug) is the reserved one — a seed extra's legacy id is not
  const derived = rid === 'la_musa' ? slugify(gone.display.name) : gone.display.name;
  return { live, gone, derived, reserved: new Map([[derived, ['extra']]]) };
}
const readd = (live, gone, ref = 'tmp:reuse-0001') => { const d = clone(live); d.extras.push({ ref, price: gone.price + 5, display: { name: gone.display.name, cat: gone.display.cat, price: gone.price + 5 } }); return d; };
const alloc = (rid, R, incoming, mintExtras) => allocateExtras({ incoming, activeExtras: R.live.extras, activeItems: R.live.items, keyMode: MODE[rid], reserved: R.reserved, switchOn: true, mintExtras, mint });

for (const rid of ['x_pizza', 'la_musa']) {
  cell(`ALLOC-REUSE-OFF ${rid}: the switch OFF — a retired extra name re-added is name_needs_new_id (today)`, () => {
    const R = retired(rid);
    refused(() => alloc(rid, R, readd(R.live, R.gone), false), 'name_needs_new_id');
  });
  cell(`ALLOC-REUSE-ON ${rid}: the switch ON — a fresh opaque key; ${rid === 'la_musa' ? 'the display id IS the key' : 'the display id is the next e<n>'}; the reuse recorded in frozen_extra_keys`, () => {
    const R = retired(rid);
    const { source } = alloc(rid, R, readd(R.live, R.gone), true);
    const row = source.extras.find((e) => e.display.name === R.gone.display.name);
    assert.ok(row && OPAQUE_SYNTAX.test(row.key), `minted (${row && row.key})`);
    assert.notStrictEqual(row.key, R.derived, 'never the retired key');
    if (rid === 'la_musa') assert.strictEqual(String(row.display.id), row.key); else assert.ok(/^e\d+$/.test(String(row.display.id)), `name mode id ${row.display.id}`);
    assert.deepStrictEqual(source.frozen_extra_keys, { [row.key]: { display_id: String(row.display.id), minted: true, reuses: R.derived } });
  });
  cell(`VALIDATE ${rid}: the publish-side validator accepts the minted row ONLY with its matching entry`, () => {
    const R = retired(rid);
    const { source } = alloc(rid, R, readd(R.live, R.gone), true);
    const args = (src) => ({ extras: src.extras, activeExtras: R.live.extras, activeItems: R.live.items, keyMode: MODE[rid], reserved: R.reserved, frozenExtraKeys: src.frozen_extra_keys, mintExtras: true });
    assert.ok(validateNewExtras(args(source)).length === 1);
    const noEntry = clone(source); delete noEntry.frozen_extra_keys;
    refused(() => validateNewExtras(args(noEntry)), 'client_supplied_key');
    const badId = clone(source); const k = Object.keys(badId.frozen_extra_keys)[0]; badId.frozen_extra_keys[k].display_id = 'e999';
    refused(() => validateNewExtras(args(badId)), 'client_supplied_key');
    refused(() => validateNewExtras({ ...args(source), mintExtras: false }), 'client_supplied_key');
  });
  cell(`NAME-UNIQUE-VALIDATE ${rid}: the publish-side validator (not only the allocator) refuses a candidate with two extras behind one name (switch ON)`, () => {
    const R = retired(rid);
    const { source } = alloc(rid, R, readd(R.live, R.gone), true);
    const twin = clone(source); const other = twin.extras.find((e) => e.key !== Object.keys(twin.frozen_extra_keys)[0]);
    other.display.name = R.gone.display.name;   // an existing extra renamed onto the minted row's name
    refused(() => validateNewExtras({ extras: twin.extras, activeExtras: R.live.extras, activeItems: R.live.items, keyMode: MODE[rid], reserved: R.reserved, frozenExtraKeys: twin.frozen_extra_keys, mintExtras: true }), 'name_taken');
  });
  cell(`NAME-UNIQUE ${rid}: two fresh rows reusing ONE retired name (different prices) are name_taken — never two extras behind one name`, () => {
    const R = retired(rid);
    const twice = readd(readd(R.live, R.gone, 'tmp:reuse-0001'), R.gone, 'tmp:reuse-0002');
    twice.extras[twice.extras.length - 1].price += 7;
    refused(() => alloc(rid, R, twice, true), 'name_taken');
  });
}
cell('NAME-UNIQUE-FRESH: two fresh rows with one never-used name are name_taken (today\'s rule, kept)', () => {
  const live = buildSourceFromCode('la_musa'); const d = clone(live); const g = live.extras[0].display.cat;
  d.extras.push({ ref: 'tmp:fresh-0001', price: 10, display: { name: 'Nuevo S2b', cat: g, price: 10 } }, { ref: 'tmp:fresh-0002', price: 12, display: { name: 'Nuevo S2b', cat: g, price: 12 } });
  refused(() => allocateExtras({ incoming: d, activeExtras: live.extras, activeItems: live.items, keyMode: 'id', switchOn: true, mintExtras: true, mint }), 'name_taken');
});

if (fails.length) { console.error(`s2b-alloc FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
console.log(`s2b-alloc: OK (${n})`);
