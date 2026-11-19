'use strict';
// Extras switch-on, Codex #119 P2 — the LEGACY-FORM reward-picker guard. While the legacy order forms remain, a group that holds an extra
// listed in the brand's structure.redeem_eligible_extras feeds a frozen form's reward picker (la-musa-orders buildRedeemCatalog offers EVERY
// extra of its group), and the server's eligibility never includes a new one: adding a NEW extra to such a group is refused
// (reward_group_add_blocked) at the shared judge — save, owner publish and manager request alike. Removing / repricing its extras stays
// allowed; other groups are untouched. Data-driven (never a restaurant id). Retires with the forms (platform-structure
// LEGACY_FORM_REWARD_PICKERS). Through the REAL handlers (test/_s2core-harness). Run: node catalog/reward-group-guard.test.js
const H = require('../test/_s2core-harness');   // FIRST: it installs the switch stubs the handlers read
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XT = require('./exposure-transitions');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const { clone } = H;
const addTo = (group, ref, name, price) => (d) => { const t = XT.apply(d, { op: 'extra.add', group, ref, name, price }).source; Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, t); };

(async () => {
  H.SW.extrasCatalog = true; H.SW.legacyPickers = true;
  await cell('RG-REPRO: the Codex reproduction — «Yuca frita» L65 added to La Musa\'s Acompañamientos (a reward group) is refused reward_group_add_blocked at SAVE, and a stored such draft at the owner PUBLISH and the manager REQUEST; nothing is written', async (L) => {
    const w = H.world('la_musa'); const before = await w.draft();
    const r = await w.save(addTo('Acompañamientos', 'tmp:yuca-frita-1', 'Yuca frita', 65));
    assert.deepStrictEqual([r.status, r.body.error], [400, 'reward_group_add_blocked'], `🔴 RG-REPRO save: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.deepStrictEqual(await w.draft(), before, `${L}: nothing written`);
    const w2 = H.world('la_musa'); const s = clone(w2.live); addTo('Acompañamientos', 'tmp:yuca-frita-1', 'Yuca frita', 65)(s);
    s.extras = require('./extras-allocate').allocateExtras({ incoming: s, activeExtras: w2.live.extras, activeItems: s.items, keyMode: 'id', switchOn: true }).source.extras;
    await w2.store(s);
    const { token } = await w2.tokenFor();
    const p = await w2.ownerPublish(token);
    assert.deepStrictEqual([p.status, p.body.error, w2.publishes.length], [400, 'reward_group_add_blocked', 0], `🔴 RG-REPRO publish: ${JSON.stringify(p.body).slice(0, 200)}`);
    // the manager REQUEST (La Musa publishes without the owner ⇒ no request path there): the same rule, data-driven, on X. Pizza with one
    // of its groups made a reward group by its own data (redeem_eligible_extras) — never a restaurant id
    const xs = buildSourceFromCode('x_pizza'); const g = xs.structure.extra_categories[0];
    xs.structure.redeem_eligible_extras = [xs.extras.find((e) => e.display && e.display.cat === g).key];
    const w3 = H.world('x_pizza', { live: xs }); const s3 = clone(w3.live); addTo(g, 'tmp:extra-nuevo-9', 'Extra Nuevo', 20)(s3);
    s3.extras = require('./extras-allocate').allocateExtras({ incoming: s3, activeExtras: w3.live.extras, activeItems: s3.items, keyMode: 'name', switchOn: true }).source.extras;
    await w3.store(s3);
    const q = await w3.request((await w3.tokenFor()).token);
    assert.deepStrictEqual([q.status, q.body.error], [400, 'reward_group_add_blocked'], `🔴 RG-REPRO request: ${JSON.stringify(q.body).slice(0, 200)}`);
    assert.strictEqual(await w3.slot(), null, `${L}: no request recorded`);
  });

  await cell('RG-REMOVE-REPRICE: removing an extra of the reward group and repricing another stay allowed (200)', async (L) => {
    const w = H.world('la_musa');
    const r = await w.save((d) => {
      const t = XT.apply(d, { op: 'extra.remove', key: 'rice_chinese' }).source; Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, t);
      const e = d.extras.find((x) => x.key === 'papas_fritas'); e.price += 5; e.display.price = e.price;
    });
    assert.strictEqual(r.status, 200, `🔴 RG-REMOVE-REPRICE: ${JSON.stringify(r.body).slice(0, 200)}`);
  });

  await cell('RG-OTHER-GROUP: adding to a group with no reward-eligible extra (La Musa Salsas; any X. Pizza group) stays allowed (200)', async (L) => {
    const r = await H.world('la_musa').save(addTo('Salsas', 'tmp:salsa-nueva-1', 'Salsa Nueva', 20));
    assert.strictEqual(r.status, 200, `🔴 RG-OTHER-GROUP la_musa: ${JSON.stringify(r.body).slice(0, 200)}`);
    const g = buildSourceFromCode('x_pizza').structure.extra_categories[0];
    const r2 = await H.world('x_pizza').save(addTo(g, 'tmp:extra-nuevo-1', 'Extra Nuevo', 20));
    assert.strictEqual(r2.status, 200, `🔴 RG-OTHER-GROUP x_pizza: ${JSON.stringify(r2.body).slice(0, 200)}`);
  });

  await cell('RG-PICKER-SUBSET: the FROZEN form\'s reward picker offers exactly the extras of its literal group(s); every one is server-eligible, and each such group is a guarded reward group (picker ⊆ eligibility while the guard holds)', async (L) => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'la-musa-orders', 'index.html'), 'utf8');
    const fn = html.slice(html.indexOf('function buildRedeemCatalog'), html.indexOf('\n}\n', html.indexOf('function buildRedeemCatalog')));
    const groups = [...fn.matchAll(/e\.cat!==['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepStrictEqual(groups, ['Acompañamientos'], `premise: the frozen picker's extra group literal(s) (${groups})`);
    const s = buildSourceFromCode('la_musa'); const el = new Set(s.structure.redeem_eligible_extras || []);
    for (const g of groups) {
      const offered = s.extras.filter((e) => e.display && e.display.cat === g).map((e) => e.key);
      assert.ok(offered.length && offered.every((k) => el.has(k)), `🔴 RG-PICKER-SUBSET: the picker offers ${offered} — all must be eligible (${[...el]})`);
    }
  });

  await cell('RG-RETIRE: with LEGACY_FORM_REWARD_PICKERS off (the forms retired) the same addition saves (200)', async (L) => {
    H.SW.legacyPickers = false;
    try {
      const r = await H.world('la_musa').save(addTo('Acompañamientos', 'tmp:yuca-frita-2', 'Yuca frita', 65));
      assert.strictEqual(r.status, 200, `🔴 RG-RETIRE: ${JSON.stringify(r.body).slice(0, 200)}`);
    } finally { H.SW.legacyPickers = true; }
  });

  // ── portal «Agregar extra» R1 (advisor 11-17): the editor read serves the reward groups from the ONE derivation the guard uses
  //    (choice-compare rewardGroupsOf), so the portal hides «Agregar extra» exactly where the save would refuse ──
  await cell('RG-READ-ONE-SOURCE: getEditableCatalog serves rewardGroups = exactly the groups whose NEW extra the save refuses (every served group refused, every other group 200) — La Musa, and X. Pizza with a group made a reward group by its own data', async (L) => {
    const xs = buildSourceFromCode('x_pizza'); const g0 = xs.structure.extra_categories[0];
    xs.structure.redeem_eligible_extras = [xs.extras.find((e) => e.display && e.display.cat === g0).key];
    for (const [rid, opts] of [['la_musa', {}], ['x_pizza', { live: xs }]]) {
      const w = H.world(rid, opts);
      const r = await w.editorRead();
      assert.strictEqual(r.status, 200, `${L} ${rid}: ${JSON.stringify(r.body).slice(0, 160)}`);
      assert.ok(Array.isArray(r.body.rewardGroups) && r.body.rewardGroups.length >= 1, `🔴 RG-READ-ONE-SOURCE ${rid}: rewardGroups served (${JSON.stringify(r.body.rewardGroups)})`);
      const groups = w.live.structure.extra_categories;
      for (const [i, g] of groups.entries()) {
        const s = await H.world(rid, opts).save(addTo(g, `tmp:rg-probe-${i}`, `Extra Probe ${i}`, 20));
        const refused = s.status === 400 && s.body.error === 'reward_group_add_blocked';
        assert.strictEqual(refused, r.body.rewardGroups.includes(g), `🔴 RG-READ-ONE-SOURCE ${rid} «${g}»: served ${r.body.rewardGroups.includes(g)}, save ${s.status} ${s.body.error || ''}`);
      }
    }
  });
  await cell('RG-READ-OFF: the Extras switch OFF, or the legacy pickers retired ⇒ rewardGroups ABSENT (today\'s response; the guard does not apply)', async (L) => {
    try {
      H.SW.extrasCatalog = false;
      assert.ok(!('rewardGroups' in (await H.world('la_musa').editorRead()).body), `🔴 RG-READ-OFF: switch off ⇒ absent`);
      H.SW.extrasCatalog = true; H.SW.legacyPickers = false;
      assert.ok(!('rewardGroups' in (await H.world('la_musa').editorRead()).body), `🔴 RG-READ-OFF: pickers retired ⇒ absent`);
    } finally { H.SW.extrasCatalog = true; H.SW.legacyPickers = true; }
  });
  await cell('RG-READ-FAIL-CLOSED: the guard state cannot be read ⇒ rewardGroups [] (fail-closed empty: «Agregar» shows and the save stays the safety net); the editor still loads', async (L) => {
    const keep = H.SW.legacyPickers;
    try {
      Object.defineProperty(H.SW, 'legacyPickers', { configurable: true, get() { throw new Error('unreadable'); } });
      const r = await H.world('la_musa').editorRead();
      assert.strictEqual(r.status, 200, `${L}: the editor still loads`);
      assert.deepStrictEqual(r.body.rewardGroups, [], `🔴 RG-READ-FAIL-CLOSED: ${JSON.stringify(r.body.rewardGroups)}`);
    } finally { Object.defineProperty(H.SW, 'legacyPickers', { configurable: true, writable: true, enumerable: true, value: keep }); }
  });

  await cell('RG-READ-LIVE-UNREADABLE (Codex #136): the guard is on but the live read REJECTS ⇒ rewardGroups [] (fail-closed empty — never absent, which would read as «guard off»); the editor still loads', async (L) => {
    const r = await H.world('la_musa').editorRead({ liveRead: async () => { throw new Error('live unreadable'); } });
    assert.strictEqual(r.status, 200, `${L}: the editor still loads (${JSON.stringify(r.body).slice(0, 120)})`);
    assert.strictEqual(r.body.extrasCatalog, true, `${L}: premise — the switch is on`);
    assert.deepStrictEqual(r.body.rewardGroups, [], `🔴 RG-READ-LIVE-UNREADABLE: ${JSON.stringify(r.body.rewardGroups)}`);
  });

  if (fails.length) { console.error(`reward-group-guard FAILED: ${fails.join(' | ')}`); process.exit(1); }
  console.log(`\nreward-group-guard: OK (${n})`);
})().catch((e) => { console.error('reward-group-guard FAILED:', e && e.message); process.exit(1); });
