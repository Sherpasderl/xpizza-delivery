'use strict';
// S2b (PLAN-structure-S2b-r3 §3) — frozen_extra_keys: the server-owned record of every extra whose key no longer derives from its display
// (a reused retired name under a fresh key; a renamed extra). Keyed by the extra's KEY → { display_id, minted?, reuses?, field? }. An entry is
// ACTIVE only while an extra with that display id carries exactly that key (inert otherwise, judged by nothing — the items' rule). Real sources.
// Run: node catalog/frozen-extra-keys.test.js
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const FX = require('./frozen-extra-keys');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));

cell('FX-SHAPE: a plain object of key → { display_id (string), minted?: true, reuses?: string, field?: "name" } — anything else is a problem', () => {
  assert.strictEqual(FX.frozenExtraKeysProblem({ i_abcdefghijkm: { display_id: 'e9', minted: true, reuses: 'Salsa' } }), null);
  assert.strictEqual(FX.frozenExtraKeysProblem({ Salsa: { display_id: 'e1', field: 'name' } }), null);
  for (const bad of [null, [], { x: 'e1' }, { x: {} }, { x: { display_id: 1 } }, { x: { display_id: 'e1', minted: 'yes' } }, { x: { display_id: 'e1', field: 'desc' } }, { x: { display_id: 'e1', other: 1 } }]) {
    assert.ok(FX.frozenExtraKeysProblem(bad), `refused: ${JSON.stringify(bad)}`);
  }
});
cell('FX-ACTIVE: display id → key, only where an extra with that display id carries exactly that key (inert entries skipped)', () => {
  const s = clone(buildSourceFromCode('x_pizza')); const x = s.extras[0];
  s.frozen_extra_keys = { [x.key]: { display_id: String(x.display.id), field: 'name' }, ghost_key: { display_id: 'e999', field: 'name' }, [s.extras[1].key]: { display_id: 'e998', field: 'name' } };
  assert.deepStrictEqual([...FX.activeFrozenExtraKeys(s)], [[String(x.display.id), x.key]]);
});
cell('FX-SERVER-OWNED: a draft may echo the stored map exactly or omit it (kept); an added / altered / dropped entry is refused', () => {
  const stored = { frozen_extra_keys: { K: { display_id: 'e1', field: 'name' } } };
  assert.deepStrictEqual(FX.serverOwnedFrozenExtraKeys({}, stored), { ok: true, frozen_extra_keys: stored.frozen_extra_keys });
  assert.deepStrictEqual(FX.serverOwnedFrozenExtraKeys(clone(stored), stored), { ok: true, frozen_extra_keys: stored.frozen_extra_keys });
  for (const d of [{ frozen_extra_keys: { K: { display_id: 'e2', field: 'name' } } }, { frozen_extra_keys: { K: stored.frozen_extra_keys.K, J: { display_id: 'e3', field: 'name' } } }, { frozen_extra_keys: {} }]) {
    assert.deepStrictEqual(FX.serverOwnedFrozenExtraKeys(d, stored).ok, false, JSON.stringify(d));
  }
  assert.deepStrictEqual(FX.serverOwnedFrozenExtraKeys({ frozen_extra_keys: { J: { display_id: 'e3', field: 'name' } } }, {}).ok, false, 'a client-added map with nothing stored');
});
for (const rid of ['x_pizza', 'la_musa']) {
  cell(`FX-RECORD ${rid}: a renamed EXISTING extra (same key + display id as live) is recorded { display_id, field: 'name' } — both key modes; stored entries kept; an unchanged name records nothing`, () => {
    const live = buildSourceFromCode(rid); const draft = clone(live); const x = draft.extras[0];
    x.display.name = 'Nombre Nuevo S2b';
    const r = FX.recordExtraRenames({ draft, live, stored: { frozen_extra_keys: { keep_me: { display_id: 'eX', field: 'name' } } } });
    assert.deepStrictEqual(r, { ok: true, frozen_extra_keys: { keep_me: { display_id: 'eX', field: 'name' }, [x.key]: { display_id: String(x.display.id), field: 'name' } } });
    assert.deepStrictEqual(FX.recordExtraRenames({ draft: clone(live), live, stored: {} }), { ok: true, frozen_extra_keys: undefined });
  });
}
cell('FX-RECORD-CONFLICT: an entry already held by that key for a DIFFERENT display id is refused (never overwritten)', () => {
  const live = buildSourceFromCode('la_musa'); const draft = clone(live); const x = draft.extras[0]; x.display.name = 'Otro';
  assert.deepStrictEqual(FX.recordExtraRenames({ draft, live, stored: { frozen_extra_keys: { [x.key]: { display_id: 'other', field: 'name' } } } }), { ok: false, error: 'extra_rename_conflict', key: x.key });
});

if (fails.length) { console.error(`frozen-extra-keys FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
console.log(`frozen-extra-keys: OK (${n})`);
