'use strict';
// 1D add-product B (rev 6, UNIFORM) — the group index, its baked fallback, the gate snapshot's groups, and the two
// platform switches. Run: node catalog/group-index.test.js
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const { groupIndexFrom, bareLauncherKeys } = require('./group-index');
const { canonicalize, sourceToBuildInputs } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { createGateReader, staticGroupsFallback } = require('./menu-gates');
const { deriveFallbackGroups, RENDER_FALLBACK_GROUPS } = require('../tools/generate-renderer-contract');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));
const built = (rid, src = canonicalize(buildSourceFromCode(rid))) => {
  const i = sourceToBuildInputs(src);
  return buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras });
};

(async () => {
  {
    const lm = groupIndexFrom(built('la_musa'));
    assert.strictEqual(lm.ok, true);
    assert.deepStrictEqual([...lm.launchers], ['noodle_01'], 'the Pad Thai launcher, by PRICING key');
    assert.deepStrictEqual([...lm.parentOf].sort(), [['noodle_01_camaron', 'noodle_01'], ['noodle_01_pollo', 'noodle_01'], ['noodle_01_sin', 'noodle_01']]);
    const xp = groupIndexFrom(built('x_pizza'));
    assert.deepStrictEqual([xp.ok, xp.launchers.size, xp.parentOf.size], [true, 0, 0], 'no groups → an empty, READABLE index');
    assert.deepStrictEqual(bareLauncherKeys(['noodle_01_pollo', 'noodle_01', 'noodle_01', 'dimsum_01'], lm), ['noodle_01'], 'bare launcher lines, deduplicated');
    ok('the real catalogs: la_musa’s Pad Thai is one launcher with three variant parents (by pricing key); x_pizza has none');
  }
  {
    const b = built('la_musa');
    const withVi = (vi) => { const c = clone(b); if (vi === undefined) delete c.structure.variant_items; else c.structure.variant_items = vi; return c; };
    assert.deepStrictEqual(groupIndexFrom(withVi(undefined)).ok, true, 'ABSENT = no groups');
    for (const bad of [null, 'x', 7, []]) assert.strictEqual(groupIndexFrom(withVi(bad)).ok, false, `present but ${JSON.stringify(bad)} → unreadable`);
    assert.strictEqual(groupIndexFrom(withVi({ ghost: { label: 'L', variantIds: ['noodle_01_pollo'] } })).ok, false, 'a launcher id that resolves to no item');
    assert.strictEqual(groupIndexFrom(withVi({ noodle_01: { label: 'L', variantIds: ['nope'] } })).ok, false, 'a variant id that resolves to no item');
    assert.strictEqual(groupIndexFrom(withVi({ dimsum_01: { label: 'L', variantIds: ['noodle_01_pollo'] } })).ok, false, 'a variant listed by one launcher but pointing at another');
    assert.strictEqual(groupIndexFrom(withVi({ noodle_01: { label: 'L' } })).ok, false, 'no variantIds');
    assert.strictEqual(groupIndexFrom({ items: null, structure: {} }).ok, false);
    assert.strictEqual(groupIndexFrom(null).ok, false);
    ok('fail-closed: absent = no groups; a present map that cannot be read as written is UNREADABLE (never "no launchers")');
  }
  {
    assert.strictEqual(readFileSync(join(__dirname, 'fallback-groups.generated.js'), 'utf8'), RENDER_FALLBACK_GROUPS(deriveFallbackGroups()),
      '🔴 the baked fallback groups do not match the code catalogs — regenerate with tools/generate-renderer-contract.js');
    const lm = staticGroupsFallback('la_musa');
    assert.deepStrictEqual([[...lm.launchers], lm.parentOf.get('noodle_01_sin')], [['noodle_01'], 'noodle_01']);
    assert.deepStrictEqual([staticGroupsFallback('x_pizza').launchers.size, staticGroupsFallback('nobody').launchers.size], [0, 0]);
    ok('the baked fallback groups are byte-identical to a fresh derivation from the code catalogs; an unknown brand has none');
  }
  {
    const lmBuilt = built('la_musa');
    const reader = (getMenu) => createGateReader({ getMenu, getVersionId: async () => 'v1', deadlineMs: 200 });
    const healthy = await reader(async () => lmBuilt).intakeGatesFor('la_musa');
    // (`fallback` is the pre-existing "weekend gate unauthored" flag — true for la_musa, which authors no weekend
    //  categories — so the paths are told apart by what they return, not by it.)
    assert.deepStrictEqual([...healthy.groups.launchers], ['noodle_01'], 'healthy: the groups of the SAME snapshot as `known`');
    assert.strictEqual(healthy.known.size, lmBuilt.items.length, 'healthy: `known` is this snapshot’s items');
    assert.ok(healthy.known.has('noodle_01') && healthy.known.has('noodle_01_pollo'));
    const failed = await reader(async () => { throw new Error('read down'); }).intakeGatesFor('la_musa');
    assert.deepStrictEqual([...failed.groups.launchers], ['noodle_01'], '🔴 read failure: the baked code groups — a code launcher is still bare');
    assert.deepStrictEqual([...failed.known].sort(), [...require('./menu-gates').staticKnownFallback('la_musa')].sort(), 'read failure: `known` is the code dishes');
    const broken = clone(lmBuilt); broken.structure.variant_items = { noodle_01: { label: 'P', variantIds: ['missing'] } };
    const unread = await reader(async () => broken).intakeGatesFor('la_musa');
    assert.strictEqual(unread.groups, null, '🔴 an unreadable map is reported as UNCLASSIFIABLE (null), never as no launchers');
    assert.deepStrictEqual([unread.fallback, unread.known.size, [...unread.weekend]], [healthy.fallback, healthy.known.size, [...healthy.weekend]],
      'and every OTHER gate is untouched — the dormant slice changes nothing until the render capability turns the rules on');
    ok('the gate snapshot: groups from the same version as `known`; the read-failure fallback carries the baked code groups; an unreadable map is null and changes no other gate');
  }
  {
    const pg = require('./platform-groups');
    assert.deepStrictEqual(pg.groupCapabilities(), { render: false, authoring: false }, 'PB-1 ships DORMANT: neither switch is on');
    for (const bad of [{}, { render: 'yes' }, null, { render: 1 }]) {
      assert.throws(() => pg.parseRender(bad), /platform_groups_malformed/, `a malformed render artifact (${JSON.stringify(bad)}) is refused, never read as on`);
    }
    assert.deepStrictEqual([pg.parseRender({ render: true }), pg.parseRender({ render: false })], [true, false], 'a well-formed artifact is read as written');
    const src = readFileSync(join(__dirname, 'platform-groups.js'), 'utf8');
    assert.ok(!/restaurant|rid\b|x_pizza|la_musa/i.test(src.replace(/\/\/.*$/gm, '')), 'no brand anywhere in the switch module');
    ok('the two PLATFORM switches: both off in PB-1; a malformed render artifact throws; no brand appears in the module');
  }
  console.log(`\ngroup-index: OK (${n})`);
})().catch((e) => { console.error('group-index FAILED:', e); process.exit(1); });
