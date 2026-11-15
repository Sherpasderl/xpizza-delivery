'use strict';
// S2-core (PLAN-structure-S2core-r3 §2.2, Codex #10; the #9 delta approved by the advisor 11-11) — the PUBLIC MENU serves both exposure
// maps PRESENT, `{}` when empty, whenever the version has an exposure: the forms' live refresh REPLACES a present map but keeps the old
// one when the field is absent, so a group detached from a brand's last dish is cleared on an already-open form. Endpoint-only: the
// generator's (and so every baked bundle's) output is untouched. Today's delta: x_pizza `extras_by_item` absent → {}; la_musa none.
// Everything from the REAL publisher and buildPublicMenu. Run: node catalog/s2core-public-maps.test.js
const assert = require('assert');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildPublicMenu, composeServedMenu } = require('./public-menu');
const { getRestaurantMenu } = require('./catalog-menu');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const known = new Set(['x_pizza', 'la_musa']);
async function seeded(rid) {
  const db = makeDb();
  const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 's2core' });
  await publishVersion(db, rid, input, { expected });
  return db;
}
(async () => {
  await cell('PM-EMPTY-MAP-PRESENT x_pizza: extras_by_item is served as {} (was absent); extras_by_category unchanged', async (L) => {
    const db = await seeded('x_pizza');
    const out = await buildPublicMenu(db, 'x_pizza', { known, isActive: async () => true });
    const menu = await getRestaurantMenu(db, 'x_pizza');
    assert.deepStrictEqual(out.body.extras_by_item, {}, `${L}: present and empty`);
    assert.deepStrictEqual(out.body.extras_by_category, menu.structure.extras_by_category, `${L}: the category map is today's`);
    assert.strictEqual('extras_by_item' in composeServedMenu('x_pizza', menu), false, `${L}: the generator / bake body is untouched (endpoint-only)`);
  });
  await cell('PM-NO-DELTA la_musa: both maps served exactly as today', async (L) => {
    const db = await seeded('la_musa');
    const out = await buildPublicMenu(db, 'la_musa', { known, isActive: async () => true });
    const menu = await getRestaurantMenu(db, 'la_musa');
    assert.deepStrictEqual([out.body.extras_by_category, out.body.extras_by_item], [menu.structure.extras_by_category, menu.structure.extras_by_item], L);
  });
  if (fails.length) { console.log(`s2core-public-maps FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`s2core-public-maps: OK (${n})`);
})();
