'use strict';
// PLAN 4 (bake from published) r3 §8.2 — the additive, edit-preserving migration, on the fake Firestore with the REAL seed
// sources and the REAL reviewed data file.
// Run: node tools/migrate-menu-structure.test.js
const assert = require('assert');
const fs = require('fs');
const { makeDb } = require('../catalog/firestore-fake');
const { sourceRefOf, readSource, canonicalize } = require('../catalog/source-store');
const { buildSourceFromCode } = require('./seed-source-store');
const { planMigration, migrateRestaurant, migrateMenuStructure, MAX_TRIES } = require('./migrate-menu-structure');
const GEN = require('./migrations/gen-menu-structure-2026-10-26');
const DATA = require('./migrations/2026-10-26-menu-structure.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('migrate-menu-structure: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (v) => JSON.parse(JSON.stringify(v));
const RIDS = ['la_musa', 'x_pizza'];
// A PRODUCTION store BEFORE the migration: the seed WITHOUT the fields the reviewed rows author (since the GATED commit the
// in-repo seed carries them — G1 — but the live drafts this migration targets do not).
function preMigration(rid, s) {
  const r = DATA.restaurants[rid] || {};
  for (const f of Object.keys(r.structure || {})) delete s.structure[f];
  for (const [coll, list] of [['items', s.items], ['extras', s.extras]]) {
    for (const [key, row] of Object.entries(r[coll] || {})) { const rec = list.find((x) => x.key === key); for (const f of Object.keys(row.display)) delete rec.display[f]; }
  }
  return s;
}
async function seeded(mut = {}) {
  const db = makeDb();
  for (const rid of RIDS) {
    const s = preMigration(rid, buildSourceFromCode(rid));
    if (mut[rid]) mut[rid](s);
    await sourceRefOf(db, rid).set(s);
  }
  return db;
}
const docOf = async (db, rid) => (await sourceRefOf(db, rid).get()).data();
const itemBy = (s, pred) => s.items.find(pred);

(async () => {
  // ── 1. the data file is exactly what the committed generator produces from the pinned forms ──
  {
    assert.strictEqual(fs.readFileSync(GEN.OUT, 'utf8'), GEN.generate(), '🔴 the reviewed data file differs from its generator — regenerate with --write and review');
    assert.strictEqual(GEN.PIN, '486f71aa');
    const lm = DATA.restaurants.la_musa; const xp = DATA.restaurants.x_pizza;
    assert.deepStrictEqual(lm.structure.badge_priority, ['signature_special', 'chefs_pick', 'must_try', 'crowd_favourite', 'most_ordered', 'price_pending']);
    assert.strictEqual(xp.items.Nutella.display.extras_policy, 'none');
    assert.strictEqual(xp.items.Mushroom.display.reward_icon, 'mushroom');
    assert.deepStrictEqual(Object.keys(lm.extras).sort(), ['papas_fritas', 'rice_chinese', 'rice_white']);
    assert.ok(Object.values(lm.extras).every((e) => e.display.reward_icon === 'rice'));
    assert.ok(!Object.keys(lm.items).some((k) => k.startsWith('beer_')), 'alcohol is not offered, so carries no icon');
    ok(`data file = generator(${GEN.PIN}): la_musa badge_priority + ${Object.keys(lm.items).length} dish icons + 3 acompañamiento icons; x_pizza ${Object.keys(xp.items).length} rows incl. Nutella extras_policy none`);
  }

  // ── 2. a clean run ADDS exactly the absent fields, validates, writes once; prices and everything else unchanged ──
  {
    const db = await seeded();
    const before = { la_musa: await docOf(db, 'la_musa'), x_pizza: await docOf(db, 'x_pizza') };
    const reports = await migrateMenuStructure(db, DATA, { write: true });
    for (const r of reports) {
      assert.strictEqual(r.written, true, `${r.rid} written`);
      assert.deepStrictEqual(r.preserved, []); assert.deepStrictEqual(r.missing, []);
      const after = await docOf(db, r.rid);
      await readSource(db, r.rid);   // validates (throws on a malformed result)
      assert.deepStrictEqual(after.items.map((i) => [i.key, i.price]), before[r.rid].items.map((i) => [i.key, i.price]), 'prices unmoved');
      assert.deepStrictEqual(after.extras.map((e) => [e.key, e.price]), before[r.rid].extras.map((e) => [e.key, e.price]));
      // strip exactly what was added and the rest is byte-equal (canonical)
      const stripped = clone(after);
      for (const p of r.added) {
        const m = /^(structure)\.(\w+)$/.exec(p) || /^(item|extra)\[(.+)\]\.display\.(\w+)$/.exec(p);
        if (m[1] === 'structure') delete stripped.structure[m[2]];
        else delete stripped[m[1] === 'item' ? 'items' : 'extras'].find((x) => x.key === m[2]).display[m[3]];
      }
      assert.deepStrictEqual(canonicalize(stripped), canonicalize(before[r.rid]), `${r.rid}: nothing but the added fields changed`);
    }
    const xp = await docOf(db, 'x_pizza'); const lm = await docOf(db, 'la_musa');
    assert.strictEqual(itemBy(xp, (i) => i.key === 'Nutella').display.extras_policy, 'none');
    assert.strictEqual(itemBy(xp, (i) => i.key === 'Mushroom').display.reward_icon, 'mushroom');
    assert.deepStrictEqual(lm.structure.badge_priority, DATA.restaurants.la_musa.structure.badge_priority);
    assert.strictEqual(lm.extras.find((e) => e.key === 'rice_white').display.reward_icon, 'rice');
    const counts = Object.fromEntries(reports.map((r) => [r.rid, r.added.length]));
    ok(`clean run: only absent fields added (${JSON.stringify(counts)}), the result validates, prices/extras unmoved and every other byte equal`);

    // ── 3. a second run is a no-op: nothing to add, nothing written, the revision unmoved ──
    const rev = (await sourceRefOf(db, 'la_musa').get()).updateTime;
    const again = await migrateMenuStructure(db, DATA, { write: true });
    assert.ok(again.every((r) => r.added.length === 0 && r.written === false && r.preserved.length === 0));
    assert.deepStrictEqual((await sourceRefOf(db, 'la_musa').get()).updateTime, rev, 'no write');
    ok('second run: a no-op (0 to add, no write, revision unmoved)');
  }

  // ── 4. a merchant-edited value SURVIVES and is reported; a row whose dish is gone is reported, never invented ──
  {
    const db = await seeded({
      x_pizza: (s) => { itemBy(s, (i) => i.key === 'Mushroom').display.reward_icon = 'leaf'; },
      la_musa: (s) => { s.structure.badge_priority = ['must_try']; },
    });
    const data = clone(DATA); data.restaurants.x_pizza.items['Ghost Pie'] = { display: { reward_icon: 'slice' } };
    const reports = await migrateMenuStructure(db, data, { write: true });
    const xr = reports.find((r) => r.rid === 'x_pizza'); const lr = reports.find((r) => r.rid === 'la_musa');
    assert.deepStrictEqual(xr.preserved, [{ path: 'item[Mushroom].display.reward_icon', have: 'leaf', want: 'mushroom' }]);
    assert.deepStrictEqual(xr.missing, ['item[Ghost Pie].display.reward_icon']);
    assert.deepStrictEqual(lr.preserved.map((p) => p.path), ['structure.badge_priority']);
    assert.strictEqual(itemBy(await docOf(db, 'x_pizza'), (i) => i.key === 'Mushroom').display.reward_icon, 'leaf', 'the merchant value is kept');
    assert.deepStrictEqual((await docOf(db, 'la_musa')).structure.badge_priority, ['must_try']);
    assert.ok(!(await docOf(db, 'x_pizza')).items.some((i) => i.key === 'Ghost Pie'));
    assert.ok(xr.written && lr.written, 'the other absent fields are still added');
    ok('merchant edits survive (reward_icon "leaf", a custom badge_priority) and are reported; a row for a dish not in the draft is reported and skipped');
  }

  // ── 5. a merchant save BETWEEN the plan and the write: refused, re-read, re-planned — their edit survives ──
  {
    const db = await seeded();
    let saves = 0; const realTx = db.runTransaction;
    const racing = (times) => async (fn) => {
      if (saves < times) {
        saves += 1;
        const s = await docOf(db, 'x_pizza'); itemBy(s, (i) => i.key === 'Spinach').display.desc = `merchant edit ${saves}`;
        await sourceRefOf(db, 'x_pizza').set(s);          // the merchant's save lands first
      }
      return realTx(fn);
    };
    db.runTransaction = racing(1);
    const logs = [];
    const r = await migrateRestaurant(db, 'x_pizza', DATA.restaurants.x_pizza, { write: true, log: (l) => logs.push(l) });
    assert.strictEqual(r.written, true); assert.strictEqual(r.attempt, 2, 'one refusal, then a re-plan');
    assert.ok(logs.some((l) => /migrate_menu_structure_moved/.test(l)));
    const doc = await docOf(db, 'x_pizza');
    assert.strictEqual(itemBy(doc, (i) => i.key === 'Spinach').display.desc, 'merchant edit 1', 'the merchant edit is not replaced');
    assert.strictEqual(itemBy(doc, (i) => i.key === 'Nutella').display.extras_policy, 'none', 'and the migration landed on top of it');

    // a draft that keeps moving: refused every time, nothing of the migration written
    const db2 = await seeded(); saves = 0;
    const realTx2 = db2.runTransaction;
    db2.runTransaction = async (fn) => {
      saves += 1;
      const s = await docOf(db2, 'x_pizza'); itemBy(s, (i) => i.key === 'Spinach').display.desc = `edit ${saves}`;
      await sourceRefOf(db2, 'x_pizza').set(s);
      return realTx2(fn);
    };
    await assert.rejects(migrateRestaurant(db2, 'x_pizza', DATA.restaurants.x_pizza, { write: true }), /migrate_menu_structure_moved/);
    assert.strictEqual(saves, MAX_TRIES);
    const doc2 = await docOf(db2, 'x_pizza');
    assert.strictEqual(itemBy(doc2, (i) => i.key === 'Nutella').display.extras_policy, undefined, 'a stale plan writes NOTHING');
    assert.strictEqual(itemBy(doc2, (i) => i.key === 'Spinach').display.desc, `edit ${MAX_TRIES}`);
    ok(`stale revision: a save between plan and write refuses the write, the CLI re-plans and keeps the edit; a draft that keeps moving refuses ${MAX_TRIES}× and writes nothing`);
  }

  // ── 6. an INVALID result refuses before any write; 7. a dry run writes nothing ──
  {
    const db = await seeded();
    const bad = clone(DATA); bad.restaurants.x_pizza.items.Mushroom.display.reward_icon = 'pizza';
    const rev = (await sourceRefOf(db, 'x_pizza').get()).updateTime;
    await assert.rejects(migrateRestaurant(db, 'x_pizza', bad.restaurants.x_pizza, { write: true }), /reward_icon/);
    assert.deepStrictEqual((await sourceRefOf(db, 'x_pizza').get()).updateTime, rev, 'refused → no write');
    const bad2 = clone(DATA); bad2.restaurants.la_musa.structure.badge_priority = ['ghost'];
    assert.throws(() => planMigration('la_musa', preMigration('la_musa', buildSourceFromCode('la_musa')), bad2.restaurants.la_musa), /badge_priority names ghost/);
    ok('invalid result (an off-set icon, a priority naming no badge) refuses at validateSource; nothing written');

    const dry = await migrateMenuStructure(db, DATA, { write: false });
    assert.ok(dry.every((r) => r.added.length > 0 && r.written === false));
    assert.deepStrictEqual((await sourceRefOf(db, 'x_pizza').get()).updateTime, rev, 'dry run → no write');
    assert.strictEqual(itemBy(await docOf(db, 'x_pizza'), (i) => i.key === 'Nutella').display.extras_policy, undefined);
    ok('dry run (the default): reports what it would add, writes nothing');
  }

  // ── 8. it never publishes and never touches anything but meta/source ──
  {
    const src = fs.readFileSync(require.resolve('./migrate-menu-structure'), 'utf8');
    assert.ok(!/publishVersion|active_version|seedSourceStore/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no publish, no pointer, no whole-source seed');
    assert.ok(/process\.argv\.includes\('--write'\)/.test(src) && !/--apply/.test(src), 'the write is opt-in, the default is a dry run');
    ok('scope: no publish, no active_version, no seedSourceStore; --write opt-in, dry run by default');
  }

  FINISHED = true;
  console.log(`\nmigrate-menu-structure: OK (${n})`);
})().catch((e) => { console.error('migrate-menu-structure: FAILED', e); process.exit(1); });
