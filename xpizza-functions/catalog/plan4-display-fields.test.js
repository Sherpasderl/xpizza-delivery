'use strict';
// PLAN 4 (bake from published) r3 §8.1 — the two new catalog display facts, registered everywhere a body is checked:
//   structure.badge_priority — the ORDER badges are chosen in (badge keys this document declares, once each)
//   dish display.reward_icon — the reward-picker icon (OWNER RULING (a)), from the CLOSED set the shipped sprite draws
// Through the REAL pieces: the seed's real source → validateSource → buildSourceCandidate → publishVersion → buildPublicMenu
// (assertWholeBody). Money is untouched: neither field reaches a price, and the published version's pricing is equal with
// and without them.
// Run: node catalog/plan4-display-fields.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { REWARD_ICONS } = require('./reward-icons');
const { validateSource, KNOWN_STRUCTURE_FIELDS } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublicMenu, assertWholeBody, REPRESENTATION_VERSION, BODY_CONTRACT } = require('./public-menu');
const { readLiteral, formSource } = require('./form-menu-source');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('plan4-display-fields: FAILED — exited without completing'); process.exitCode = 1; } });
const REPO = path.join(__dirname, '..', '..');
const clone = (v) => JSON.parse(JSON.stringify(v));
const refuses = (fn, re, label) => assert.throws(fn, (e) => re.test(String(e && e.message)), label);

(async () => {
  // ── 1. the closed reward_icon set is exactly what BOTH forms' sprite can draw (minus its chrome symbols) ──
  {
    const CHROME = ['check', 'gift'];
    for (const dir of ['xpizza-orders', 'la-musa-orders']) {
      const acct = fs.readFileSync(path.join(REPO, dir, 'account.js'), 'utf8');
      const sprite = [...acct.matchAll(/<symbol id="rk-i-([a-z_-]+)"/g)].map((m) => m[1]).sort();
      assert.deepStrictEqual(sprite.filter((s) => !CHROME.includes(s)), [...REWARD_ICONS].sort(), `${dir}: the closed set is the sprite's dish symbols`);
    }
    assert.ok(Object.isFrozen(REWARD_ICONS));
    ok(`reward_icon set: ${REWARD_ICONS.length} row icons = both forms' rk-i sprite minus its chrome (check/gift); frozen`);
  }

  // ── 2. validateSource: badge_priority (la_musa's real seed + today's TAG_PRIORITY) ──
  // PLAN 4 GATED (G1): the seed now carries the reviewed data file's badge_priority; LM is that seed WITHOUT it (the
  // pre-migration shape these cells reason about), and the G1 cell below pins what the seed carries.
  const LM = buildSourceFromCode('la_musa'); const SEED_PRIORITY = LM.structure.badge_priority; delete LM.structure.badge_priority;
  const TAG_PRIORITY = readLiteral(formSource('la_musa'), 'TAG_PRIORITY');
  {
    assert.ok(KNOWN_STRUCTURE_FIELDS.includes('badge_priority'));
    assert.deepStrictEqual(SEED_PRIORITY, require('../tools/migrations/2026-10-26-menu-structure.json').restaurants.la_musa.structure.badge_priority,
      'G1: the seed carries the badge_priority of the ONE reviewed data file');
    assert.deepStrictEqual(SEED_PRIORITY, TAG_PRIORITY, '… which is today\'s order (the seed literal it was generated from)');
    const s = clone(LM); s.structure.badge_priority = TAG_PRIORITY.slice();
    validateSource(s, 'la_musa');
    const bad = (mut, re, label) => { const x = clone(s); mut(x.structure); refuses(() => validateSource(x, 'la_musa'), re, label); };
    bad((st) => { st.badge_priority = [...TAG_PRIORITY, 'ghost']; }, /badge_priority names ghost/, 'an undeclared badge');
    bad((st) => { st.badge_priority = [TAG_PRIORITY[0], TAG_PRIORITY[0]]; }, /duplicate entries/, 'a duplicate entry');
    bad((st) => { st.badge_priority = 'must_try'; }, /must be an array of strings/, 'not an array');
    bad((st) => { st.badge_priority = [7]; }, /must be an array of strings/, 'a non-string entry');
    bad((st) => { st.badge_priority = null; }, /must be an array of strings/, 'present null is not absent');
    bad((st) => { delete st.badges; st.badge_priority = [TAG_PRIORITY[0]]; }, /declares no badge/, 'no declared badges refuses every entry');
    const sub = clone(s); sub.structure.badge_priority = TAG_PRIORITY.slice(0, 2); validateSource(sub, 'la_musa');
    ok(`validateSource: badge_priority = today's TAG_PRIORITY (${TAG_PRIORITY.length}) accepted, a subset accepted; undeclared / duplicate / non-array / non-string / null / no-badges each refused`);
  }

  // ── 3. validateSource: reward_icon on a dish (x_pizza's real seed) ──
  const XP = buildSourceFromCode('x_pizza');
  {
    const s = clone(XP);
    const mush = s.items.find((i) => i.display.name === 'Mushroom');
    assert.ok(mush, 'premise: the Mushroom dish');
    mush.display.reward_icon = 'mushroom';
    validateSource(s, 'x_pizza');
    for (const v of ['gift', 'pizza', '', 7, null]) {
      const x = clone(s); x.items.find((i) => i.display.name === 'Mushroom').display.reward_icon = v;
      refuses(() => validateSource(x, 'x_pizza'), /reward_icon/, `reward_icon ${JSON.stringify(v)}`);
    }
    // an EXTRA the picker offers carries one too (la_musa's acompañamientos), bound to the same set
    const lm = clone(buildSourceFromCode('la_musa'));
    const side = lm.extras.find((e) => e.display.cat === 'Acompañamientos');
    assert.ok(side, 'premise: an acompañamiento');
    side.display.reward_icon = 'rice'; validateSource(lm, 'la_musa');
    side.display.reward_icon = 'check'; refuses(() => validateSource(lm, 'la_musa'), /reward_icon/, 'an extra with a chrome icon');
    ok('validateSource: a dish or extra reward_icon from the closed set is accepted; outside it (incl. the chrome "gift"/"check"), blank, non-string and null each refused');
  }

  // ── 4. the store path CARRIES badge_priority into the built structure; the money is unmoved by both fields ──
  const LM2 = clone(LM); LM2.structure.badge_priority = TAG_PRIORITY.slice();
  const XP2 = clone(XP); XP2.items.find((i) => i.display.name === 'Mushroom').display.reward_icon = 'mushroom';
  {
    const a = buildSourceCandidate('la_musa', LM); const b = buildSourceCandidate('la_musa', LM2);
    assert.deepStrictEqual(b.built.structure.badge_priority, TAG_PRIORITY, 'the store path carries it');
    assert.strictEqual(a.built.structure.badge_priority, undefined, 'absent stays absent');
    assert.deepStrictEqual(b.inputs.priceTable, a.inputs.priceTable); assert.deepStrictEqual(b.inputs.extras, a.inputs.extras);
    assert.deepStrictEqual(b.built.items.map((i) => [i.key, i.price]), a.built.items.map((i) => [i.key, i.price]));
    const c = buildSourceCandidate('x_pizza', XP); const d = buildSourceCandidate('x_pizza', XP2);
    assert.strictEqual(d.built.items.find((i) => i.display.name === 'Mushroom').display.reward_icon, 'mushroom', 'the dish field rides on its display record');
    assert.deepStrictEqual(d.inputs.priceTable, c.inputs.priceTable); assert.deepStrictEqual(d.inputs.extras, c.inputs.extras);
    ok('store path: badge_priority reaches the built structure and reward_icon the built dish; prices and extras identical with and without them');
  }

  // ── 5. served: published → buildPublicMenu → assertWholeBody, marker 1d.3 ──
  const publish = async (rid, source) => {
    const db = makeDb();
    const { inputs, built } = buildSourceCandidate(rid, source);
    await publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'plan4' }, { expected: { activeVersionId: null } });
    return db;
  };
  const deps = { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true };
  {
    assert.strictEqual(REPRESENTATION_VERSION, '1d.3');
    assert.deepStrictEqual(BODY_CONTRACT.badge_priority.type, 'array');
    const lm = await buildPublicMenu(await publish('la_musa', LM2), 'la_musa', deps);
    assert.strictEqual(lm.representation_version, '1d.3');
    assert.deepStrictEqual(lm.body.badge_priority, TAG_PRIORITY, 'carried from the structure');
    const lm0 = await buildPublicMenu(await publish('la_musa', LM), 'la_musa', deps);
    assert.ok(!('badge_priority' in lm0.body), 'a version without one serves none (not required)');
    assert.notStrictEqual(lm.etag, lm0.etag, 'the field is inside the etag');
    const xp = await buildPublicMenu(await publish('x_pizza', XP2), 'x_pizza', deps);
    assert.strictEqual(xp.body.dishes.find((d) => d.name === 'Mushroom').reward_icon, 'mushroom');
    ok('served at 1d.3: la_musa carries badge_priority (absent when unauthored; inside the etag); x_pizza\'s dish carries reward_icon');
  }

  // ── 5b. the reconciler's read (overlayIdentity:false) is the served body minus EXACTLY the identity overlay ──
  {
    for (const [rid, src] of [['x_pizza', XP2], ['la_musa', LM2]]) {
      const db = await publish(rid, src);
      const full = await buildPublicMenu(db, rid, deps);
      const bare = await buildPublicMenu(db, rid, { ...deps, overlayIdentity: false });
      const strip = (b) => { const c = clone(b); for (const k of ['dishes', 'extras']) c[k] = c[k].map((r) => Object.fromEntries(Object.entries(r).filter(([f]) => !['identity_id', 'dish_id', 'extra_id'].includes(f)))); delete c.item_keys; return c; };   // S1d Q5: item_keys is endpoint-only
      assert.deepStrictEqual(bare.body, strip(full.body), `${rid}: the same body, minus only the identity overlay`);
      assert.ok(full.body.dishes.some((d) => d.dish_id !== undefined || d.identity_id !== undefined), `premise: the endpoint's default still overlays (${rid})`);
      assert.ok(bare.body.dishes.every((d) => d.dish_id === undefined && d.identity_id === undefined));
      assert.strictEqual(bare.body.item_keys, undefined, `🔴 S1d Q5: the bake / reconciler body carries NO item_keys (${rid})`);
      assert.ok(full.body.dishes.length && full.body.dishes.every((d) => d.item_key === undefined && typeof full.body.item_keys[String(d.id)] === 'string'), `S1d Q5: the endpoint body maps every dish's display id to its item_key; no record carries it (${rid})`);
    }
    ok('overlayIdentity:false (the reconciler\'s read) = the served body minus exactly the identity overlay; the endpoint default still overlays');
  }

  // ── 6. assertWholeBody refuses a body whose new facts would render nothing ──
  {
    const menu = { structure: { badges: {}, badge_priority: [] }, items: [] };
    const base = () => ({ dishes: [{ id: 1, name: 'A', cat: 'c', price: 1 }], extras: [], categories: [{ id: 'c' }], badges: { a: { cls: 'x', label: 'A' } }, badge_priority: ['a'], avail_identity: { field: require('../menu-pricing').availIdentityField('r') } });   // DRYRUN composition (2e): PLAN-avail-identity's BODY_CONTRACT requires avail_identity — set from the server's ONE rule
    assertWholeBody('r', base(), menu);
    const refused = (mut, re) => { const b = base(); mut(b); refuses(() => assertWholeBody('r', b, menu), re, String(re)); };
    refused((b) => { b.badge_priority = ['a', 'ghost']; }, /badge_priority names 1 key/);
    refused((b) => { b.badge_priority = 'a'; }, /badge_priority is not an array/);
    refused((b) => { delete b.badge_priority; }, /badge_priority is missing although the catalog carries it/);
    refused((b) => { b.dishes[0].reward_icon = 'gift'; }, /dishes record\(s\) carry a reward_icon outside the closed set/);
    refused((b) => { b.extras = [{ id: 'e', name: 'E', cat: 'x', price: 1, reward_icon: 'pizza' }]; }, /extras record\(s\) carry a reward_icon outside the closed set/);
    const ic = base(); ic.dishes[0].reward_icon = 'slice'; assertWholeBody('r', ic, menu);
    ok('assertWholeBody: a priority naming an unserved badge, a non-array priority, a dropped priority and an off-set reward_icon are each refused (public_menu_unavailable)');
  }

  FINISHED = true;
  console.log(`\nplan4-display-fields: OK (${n})`);
})().catch((e) => { console.error('plan4-display-fields: FAILED', e); process.exit(1); });
