'use strict';
// S2-core Codex build r1 (D4c-grill/codex-build-s2core-r1.txt) — every finding through the REAL handlers (test/_s2core-harness.js):
//   P1-1  a new extra the server did not allocate (a client key / id / identity stamp) never saves
//   P1-2  the publish (and the manager request) revalidates every new extra with the SAME validator the save runs
// Run: node catalog/s2core-r1.test.js
const H = require('../test/_s2core-harness');   // FIRST: it installs the switch stubs the handlers read
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const { clone } = H;
const forged = (rid, name, g) => (rid === 'la_musa'
  ? { key: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), price: 30, display: { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), name, cat: g, price: 30 } }
  : { key: name, price: 30, display: { id: 'e99', name, cat: g, price: 30 } });
const groupOf = (rid) => buildSourceFromCode(rid).structure.extra_categories[0];

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    await cell(`R1-P1-1-CLIENT-KEY ${rid}: a client-keyed «Bacon + Cheddar» (no tmp ref) is client_supplied_key and nothing is written`, async (L) => {
      H.SW.extrasCatalog = true;
      const w = H.world(rid); const before = await w.draft();
      const r = await w.save((d) => { d.extras.push(forged(rid, 'Bacon + Cheddar', groupOf(rid))); });
      assert.deepStrictEqual([r.status, r.body.error], [400, 'client_supplied_key'], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.deepStrictEqual(await w.draft(), before, `${L}: nothing written`);
      const safe = await H.world(rid).save((d) => { d.extras.push(forged(rid, 'Bacon Cheddar', groupOf(rid))); });
      assert.deepStrictEqual([safe.status, safe.body.error], [400, 'client_supplied_key'], `${L}: a SAFE client-keyed name too (${JSON.stringify(safe.body).slice(0, 160)})`);
    });
    await cell(`R1-P1-1-TMP-STAMP ${rid}: a fresh tmp-ref extra carrying an identity stamp is client_supplied_key`, async (L) => {
      H.SW.extrasCatalog = true;
      const r = await H.world(rid).save((d) => { d.extras.push({ ref: 'tmp:stamped-0001', price: 20, display: { name: 'Con Sello', cat: groupOf(rid), price: 20, identity_id: 'forged-id-1' } }); });
      assert.deepStrictEqual([r.status, r.body.error], [400, 'client_supplied_key'], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
    });
    await cell(`R1-P1-1-SWITCH-OFF-CLIENT-KEY ${rid}: with the switch OFF a client-keyed extra is still refused (today's extras_changed)`, async (L) => {
      H.SW.extrasCatalog = false;
      try {
        const r = await H.world(rid).save((d) => { d.extras.push(forged(rid, 'Bacon Cheddar', groupOf(rid))); });
        assert.ok(r.status === 400 && ['extras_changed', 'client_supplied_key', 'extras_catalog_not_supported_yet'].includes(r.body.error), `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
      } finally { H.SW.extrasCatalog = true; }
    });

    // P1-2: a draft that never went through THIS save (an older server's, a raced save's) — the publish judges every new extra itself
    for (const [tag, row, code] of [
      ['UNSAFE-NAME', (g) => forged(rid, 'Bacon + Cheddar', g), 'extra_name_unsafe'],
      ['STAMPED', (g) => { const x = forged(rid, 'Nuevo Sellado', g); x.display.identity_id = 'forged-id-2'; return x; }, 'client_supplied_key'],
      ['DISH-NAME', (g) => forged(rid, buildSourceFromCode(rid).items[0].display.name, g), 'name_taken'],
    ]) {
      await cell(`R1-P1-2-PUBLISH-${tag} ${rid}: the owner publish refuses ${code} and publishes nothing`, async (L) => {
        H.SW.extrasCatalog = true;
        const w = H.world(rid); const s = clone(w.live); s.extras.push(row(groupOf(rid)));
        await w.store(s);
        const { token, diff } = await w.tokenFor();
        const p = await w.ownerPublish(token, diff.largeChangeSet);
        assert.deepStrictEqual([p.status, p.body.error, w.publishes.length], [400, code, 0], `${L}: ${JSON.stringify(p.body).slice(0, 200)}`);
      });
    }
  }
  await cell('R1-P1-2-REQUEST-UNSAFE x_pizza: the manager request refuses the same draft (extra_name_unsafe) and records nothing', async (L) => {
    H.SW.extrasCatalog = true;
    const w = H.world('x_pizza'); const s = clone(w.live); s.extras.push(forged('x_pizza', 'Bacon + Cheddar', groupOf('x_pizza')));
    await w.store(s);
    const { token } = await w.tokenFor();
    const r = await w.request(token);
    assert.deepStrictEqual([r.status, r.body.error], [400, 'extra_name_unsafe'], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.strictEqual(await w.slot(), null, `${L}: no request recorded`);
  });
  // P2-6: the manager request runs the publish's current-state judgment before it records anything
  await cell('R1-P2-6-REQUEST-CODEX-REPRO x_pizza: a category attach saved ON, then the switch OFF — the request refuses and records nothing (as the owner publish)', async (L) => {
    const XT = require('./exposure-transitions');
    const live = buildSourceFromCode('x_pizza');
    live.structure.exposure.category_allow.individual = live.structure.exposure.category_allow.individual.filter((g) => g !== 'Carnes');
    for (const i of live.items) if (i.display.cat === 'individual' && i.display.extras_policy !== 'none') live.structure.exposure.item_overrides[i.key] = { add: ['Carnes'] };
    H.SW.extrasCatalog = true;
    const w = H.world('x_pizza', { live });
    const saved = await w.save((d) => { const t = XT.apply(d, { op: 'attach.cat', cat: 'individual', group: 'Carnes' }).source; Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, t); });
    assert.strictEqual(saved.status, 200, `${L}: premise — saved (${JSON.stringify(saved.body).slice(0, 160)})`);
    H.SW.extrasCatalog = false;
    try {
      const r = await w.request(saved.body.token);
      assert.ok(r.status >= 400, `${L}: refused (${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
      assert.strictEqual(await w.slot(), null, `${L}: nothing recorded`);
      const p = await w.ownerPublish(saved.body.token);
      assert.ok(p.status >= 400 && w.publishes.length === 0, `${L}: the owner publish agrees (${p.status})`);
    } finally { H.SW.extrasCatalog = true; }
  });
  await cell('R1-P2-6-REQUEST-TYPED x_pizza: an Extras-page draft whose token binds the switch-OFF diff — the request answers 409 extras_catalog_not_supported_yet', async (L) => {
    const XT = require('./exposure-transitions');
    const w = H.world('x_pizza'); const s = XT.apply(clone(w.live), { op: 'group.order', order: [...w.live.structure.extra_categories].reverse() }).source;
    await w.store(s);
    H.SW.extrasCatalog = false;
    try {
      const { token } = await w.tokenFor();
      const r = await w.request(token);
      assert.deepStrictEqual([r.status, r.body.error], [409, 'extras_catalog_not_supported_yet'], `${L}: ${JSON.stringify(r.body).slice(0, 160)}`);
      assert.strictEqual(await w.slot(), null, `${L}: nothing recorded`);
    } finally { H.SW.extrasCatalog = true; }
  });
  await cell('R1-P2-6-REQUEST-TODAY x_pizza: today\'s price edit still requests (the gate changes nothing for it)', async (L) => {
    H.SW.extrasCatalog = false;
    try {
      const w = H.world('x_pizza');
      const saved = await w.save((d) => { d.items[0].price += 10; d.items[0].display.price = d.items[0].price; });
      const r = await w.request(saved.body.token);
      assert.deepStrictEqual([r.status, r.body.ok], [200, true], `${L}: ${JSON.stringify(r.body).slice(0, 160)}`);
    } finally { H.SW.extrasCatalog = true; }
  });
  // P1-4: under the switch the exposure claim is per transition — a group attach / detach (and its own cleanup), a category attach, the
  // removal closure — and nothing else in category_allow / item_overrides
  for (const [tag, mutate, code] of [
    ['LEGACY-SINGLE-DENY', (d) => { d.structure.exposure.item_overrides.dimsum_01 = { deny: [d.extras.find((e) => e.display.cat === 'Salsas').key] }; }, 'structure_changed'],
    ['DENY-ALL', (d) => { d.structure.exposure.item_overrides.dimsum_01 = { deny: ['*'] }; }, 'structure_changed'],
    ['CATEGORY-DROP', (d) => { d.structure.exposure.category_allow.dim_sum = ['Acompañamientos']; }, 'structure_changed'],
    ['OPTION-OVERRIDE', (d) => { d.structure.exposure.item_overrides.noodle_01_pollo = { deny: ['Salsas'] }; }, 'structure_changed'],
    ['DENY-EXTRAS-ADDED', (d) => { d.structure.exposure.item_overrides.dimsum_01 = { deny_extras: [d.extras.find((e) => e.display.cat === 'Salsas').key] }; }, 'extras_not_supported_yet'],
  ]) {
    await cell(`R1-P1-4-${tag} la_musa: with S1 authoring OFF and the switch ON, «${tag}» is not an Extras-page op — ${code}`, async (L) => {
      H.SW.extrasCatalog = true; H.SW.extrasAuthoring = false;
      const r = await H.world('la_musa').save(mutate);
      assert.deepStrictEqual([r.status, r.body.error], [400, code], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
    });
  }
  await cell('R1-P1-4-ATTACH-CLEANS-UNTICKED la_musa: attaching «Salsas» to a dish holding a stale unticked Salsas extra saves (the op\'s own cleanup), S1 OFF', async (L) => {
    const XT = require('./exposure-transitions');
    const live = buildSourceFromCode('la_musa');
    const k = live.extras.find((e) => e.display.cat === 'Salsas').key;
    live.structure.exposure.item_overrides.dimsum_01 = { deny: ['Salsas'], deny_extras: [k] };   // detached, with a stale tick (legacy data)
    H.SW.extrasCatalog = true; H.SW.extrasAuthoring = false;
    const r = await H.world('la_musa', { live }).save((d) => { const t = XT.apply(d, { op: 'attach.item', item: 'dimsum_01', group: 'Salsas' }).source; Object.keys(d).forEach((x) => delete d[x]); Object.assign(d, t); });
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.strictEqual(r.body.source.structure.exposure.item_overrides.dimsum_01, undefined, `${L}: the override is gone`);
  });
  await cell('R1-P1-4-ATTACH-PLUS-UNRELATED la_musa: an attach with an unrelated legacy deny riding along is refused', async (L) => {
    const XT = require('./exposure-transitions');
    H.SW.extrasCatalog = true; H.SW.extrasAuthoring = false;
    const r = await H.world('la_musa').save((d) => { const t = XT.apply(d, { op: 'attach.item', item: 'dimsum_01', group: 'Proteínas' }).source; t.structure.exposure.item_overrides.dimsum_02 = { deny: ['*'] }; Object.keys(d).forEach((x) => delete d[x]); Object.assign(d, t); });
    assert.deepStrictEqual([r.status, r.body.error], [400, 'structure_changed'], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
  });
  // P1-3: the AUTHORED source is accounted before anything is lost to the build — an unknown leaf, or an authored map that is not exactly
  // what the draft's own groups derive, is structure_unexplained {path}; both switch settings, both brands
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const [tag, mutate, path] of [
      ['TOP-FIELD', (d) => { d.tb_unknown = 1; }, 'tb_unknown'],
      ['ITEM-ROW-FIELD', (d) => { d.items[0].tb_row = 'x'; }, `items.${buildSourceFromCode(rid).items[0].key}.tb_row`],
      ['EXTRA-ROW-FIELD', (d) => { d.extras[0].tb_row = 'x'; }, `extras.${buildSourceFromCode(rid).extras[0].key}.tb_row`],
      ['AUTHORED-MAP', (d) => { d.structure.extras_by_item = { ...(d.structure.extras_by_item || {}), [String(d.items[0].display.id)]: [d.structure.extra_categories[1]] }; }, 'structure.extras_by_item'],
    ]) {
      for (const on of [true, false]) {
        await cell(`R1-P1-3-${tag} ${rid} switch ${on ? 'ON' : 'OFF'}: refused structure_unexplained (${path}), nothing written`, async (L) => {
          H.SW.extrasCatalog = on;
          try {
            const w = H.world(rid); const before = await w.draft();
            const r = await w.save(mutate);
            assert.deepStrictEqual([r.status, r.body.error, r.body.field], [400, 'structure_unexplained', path], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
            assert.deepStrictEqual(await w.draft(), before, `${L}: nothing written`);
          } finally { H.SW.extrasCatalog = true; }
        });
      }
    }
  }
  await cell('R1-P1-3-LA-MUSA-RICE la_musa: Codex\'s probe — the authored extras_by_item.rice_03 changed alone to [Salsas] is refused', async (L) => {
    H.SW.extrasCatalog = true;
    const r = await H.world('la_musa').save((d) => { d.structure.extras_by_item.rice_03 = ['Salsas']; });
    assert.deepStrictEqual([r.status, r.body.error], [400, 'structure_unexplained'], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
  });
  await cell('R1-P1-3-DERIVED-MAP-OK la_musa: an attach whose authored map is rewritten to EXACTLY the derivation saves', async (L) => {
    const XT = require('./exposure-transitions'); const { projectExtrasMaps } = require('./extras-projection'); const { buildSourceCandidate } = require('./candidate-validate');
    H.SW.extrasCatalog = true;
    const r = await H.world('la_musa').save((d) => {
      const t = XT.apply(d, { op: 'attach.item', item: 'dimsum_01', group: 'Proteínas' }).source;
      const b = buildSourceCandidate('la_musa', t).built; t.structure.extras_by_item = projectExtrasMaps({ items: b.items, extras: b.extras, structure: b.structure }).byItem;
      Object.keys(d).forEach((x) => delete d[x]); Object.assign(d, t);
    });
    assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
  });
  // S2 UI plan r3 P-6: the save's 200 body names each newly allocated extra's key by its tmp ref — the portal adopts ONLY through it
  for (const rid of ['x_pizza', 'la_musa']) {
    await cell(`R1-EXTRA-REFS ${rid}: the save answers extraRefs { tmp ref: allocated key }; a save with no new extra has no such field`, async (L) => {
      H.SW.extrasCatalog = true;
      const XT = require('./exposure-transitions');
      const r = await H.world(rid).save((d) => { const t = XT.apply(d, { op: 'group.create', group: 'Grupo Nuevo', extras: [{ ref: 'tmp:refs-one-0001', name: 'Uno Nuevo', price: 10 }, { ref: 'tmp:refs-two-0002', name: 'Dos Nuevo', price: 12 }], attach: { mode: 'none' } }).source; Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, t); });
      assert.strictEqual(r.status, 200, `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
      const keyOf = (name) => r.body.source.extras.find((e) => e.display.name === name).key;
      assert.deepStrictEqual(r.body.extraRefs, { 'tmp:refs-one-0001': keyOf('Uno Nuevo'), 'tmp:refs-two-0002': keyOf('Dos Nuevo') }, L);
      const plain = await H.world(rid).save((d) => { d.items[0].price += 1; d.items[0].display.price = d.items[0].price; });
      assert.ok(plain.status === 200 && !('extraRefs' in plain.body), `${L}: today's save body is unchanged`);
    });
  }
  // r2 #1: a fresh tmp-ref row supplies NO id — refused before the next id is counted (it would otherwise shift the allocation)
  for (const rid of ['x_pizza', 'la_musa']) {
    await cell(`R2-1-FRESH-ID ${rid}: a tmp-ref extra carrying display.id is client_supplied_key, and the allocation is not shifted`, async (L) => {
      H.SW.extrasCatalog = true;
      const r = await H.world(rid).save((d) => { d.extras.push({ ref: 'tmp:fresh-id-0001', price: 20, display: { id: rid === 'la_musa' ? 'sneaky_id' : 'e9000', name: 'Con Id', cat: d.structure.extra_categories[0], price: 20 } }); });
      assert.deepStrictEqual([r.status, r.body.error, r.body.ref], [400, 'client_supplied_key', 'tmp:fresh-id-0001'], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
      if (rid === 'x_pizza') {
        const ok2 = await H.world(rid).save((d) => { d.extras.push({ ref: 'tmp:fresh-ok-0001', price: 20, display: { name: 'Sin Id', cat: d.structure.extra_categories[0], price: 20 } }); });
        const ids = buildSourceFromCode(rid).extras.map((e) => Number(String(e.display.id).slice(1)));
        assert.strictEqual(ok2.body.source.extras.find((e) => e.display.name === 'Sin Id').display.id, `e${Math.max(...ids) + 1}`, `${L}: the next id follows today's ids only`);
      }
    });
  }
  // r2 #3: PRESENCE is a change (an added `x: null` is not absence), and a fresh row's unknown field is accounted before allocation
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const [tag, mutate, path] of [
      ['TOP-NULL', (d) => { d.tb_unknown = null; }, 'tb_unknown'],
      ['ROW-NULL', (d) => { d.items[0].tb_row = null; }, `items.${buildSourceFromCode(rid).items[0].key}.tb_row`],
      ['FRESH-ROW-FIELD', (d) => { d.extras.push({ ref: 'tmp:fresh-row-0001', price: 20, tb_row: 1, display: { name: 'Fila Rara', cat: d.structure.extra_categories[0], price: 20 } }); }, 'extras.tmp:fresh-row-0001.tb_row'],
    ]) {
      await cell(`R2-3-${tag} ${rid}: refused structure_unexplained (${path})`, async (L) => {
        H.SW.extrasCatalog = true;
        const r = await H.world(rid).save(mutate);
        assert.deepStrictEqual([r.status, r.body.error, r.body.field], [400, 'structure_unexplained', path], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
      });
    }
  }
  // r2 #4: the writer's own cleanup is legitimate even when the group is already offered (no membership delta); a partial or unrelated
  // cleanup is still refused (S1 OFF)
  {
    const XT = require('./exposure-transitions');
    const via = (op) => (d) => { const t = XT.apply(d, op).source; Object.keys(d).forEach((x) => delete d[x]); Object.assign(d, t); };
    const salsas = buildSourceFromCode('la_musa').extras.filter((e) => e.display.cat === 'Salsas').map((e) => e.key);
    const liveWith = (ov) => { const l = buildSourceFromCode('la_musa'); l.structure.exposure.item_overrides.dimsum_01 = ov; return l; };
    for (const [tag, ov, op, want] of [
      ['ATTACH-INHERITED-UNTICKED', { deny_extras: [salsas[0]] }, { op: 'attach.item', item: 'dimsum_01', group: 'Salsas' }, [200]],
      ['ATTACH-CAT-LEGACY-SINGLE', { deny: [salsas[0]] }, { op: 'attach.cat', cat: 'dim_sum', group: 'Salsas' }, [200]],
      ['ATTACH-ITEM-LEGACY-SINGLE', { deny: [salsas[0]] }, { op: 'attach.item', item: 'dimsum_01', group: 'Salsas' }, [200]],
    ]) {
      await cell(`R2-4-${tag} la_musa: the writer's cleanup saves (S1 OFF)`, async (L) => {
        H.SW.extrasCatalog = true; H.SW.extrasAuthoring = false;
        const r = await H.world('la_musa', { live: liveWith(ov) }).save(via(op));
        assert.deepStrictEqual([r.status], want, `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
        assert.strictEqual(r.body.source.structure.exposure.item_overrides.dimsum_01, undefined, `${L}: the dish's Salsas entries are all gone`);
      });
    }
    for (const [tag, ov, mutate, code] of [
      ['PARTIAL-UNTICK', { deny_extras: [salsas[0], salsas[1]] }, (d) => { d.structure.exposure.item_overrides.dimsum_01 = { deny_extras: [salsas[1]] }; }, 'extras_not_supported_yet'],
      ['PARTIAL-SINGLE', { deny: [salsas[0], salsas[1]] }, (d) => { d.structure.exposure.item_overrides.dimsum_01 = { deny: [salsas[1]] }; }, 'structure_changed'],
      ['UNOFFERED-CLEAR', { deny: ['Salsas'], deny_extras: [salsas[0]] }, (d) => { d.structure.exposure.item_overrides.dimsum_01 = { deny: ['Salsas'] }; }, 'extras_not_supported_yet'],
    ]) {
      await cell(`R2-4-NOT-${tag} la_musa: an unrelated cleanup is still refused (${code})`, async (L) => {
        H.SW.extrasCatalog = true; H.SW.extrasAuthoring = false;
        const r = await H.world('la_musa', { live: liveWith(ov) }).save(mutate);
        assert.deepStrictEqual([r.status, r.body.error], [400, code], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
      });
    }
  }
  await cell('R1-P1-2-ONE-PREDICATE: the server judges labels with the capp serializer\'s OWN predicate (a byte copy), and every label it accepts serializes', (L) => {
    const fs = require('fs'); const path = require('path');
    const capp = path.join(__dirname, '..', '..', 'customer-app', 'capp-serialize.js');
    const copy = path.join(__dirname, 'capp-serialize.js');
    assert.ok(fs.existsSync(copy) && Buffer.compare(fs.readFileSync(capp), fs.readFileSync(copy)) === 0, `${L}: catalog/capp-serialize.js is a byte copy of the capp's`);
    const XV = require('./extras-validate');
    assert.strictEqual(String(XV.EXTRA_LABEL_UNSAFE), fs.readFileSync(capp, 'utf8').match(/\n {2}const UNSAFE_LABEL = (\/.+?\/);/)[1], `${L}: the validator compiles the capp serializer's own literal`);
    // the REAL writer → allocator → build → served menu → the REAL capp adapter, cart and serializer
    const XT = require('./exposure-transitions'); const { allocateExtras } = require('./extras-allocate');
    const { buildSourceCandidate } = require('./candidate-validate'); const { composeServedMenu } = require('./public-menu');
    const root = path.join(__dirname, '..', '..', 'customer-app');
    const { adaptMenu } = require(path.join(root, 'capp-menu.js')); const { createCart } = require(path.join(root, 'capp-cart.js')); const { serialize } = require(capp);
    for (const name of ['Jalapeño', 'Queso Extra', 'Salsa de la Casa (picante)', 'Pimientos & Cebolla', 'Bacon + Cheddar', 'A, B', 'Pan [tostado]', 'Uno | Dos']) {
      let src = XT.apply(buildSourceFromCode('x_pizza'), { op: 'extra.add', group: 'Carnes', ref: 'tmp:label-cell-1', name, price: 25 }).source;
      try { src = allocateExtras({ incoming: src, activeExtras: buildSourceFromCode('x_pizza').extras, activeItems: src.items, keyMode: 'name', switchOn: true }).source; } catch (e) {
        assert.strictEqual(e.code, 'extra_name_unsafe', `${L}: «${name}» refused for its label`); assert.ok(XV.EXTRA_LABEL_UNSAFE.test(name), `${L}: «${name}» is unsafe by the capp's rule`); continue;
      }
      assert.ok(!XV.EXTRA_LABEL_UNSAFE.test(name), `${L}: «${name}» accepted only when the capp's rule allows it`);
      const b = buildSourceCandidate('x_pizza', src).built;
      const m = adaptMenu({ rid: 'x_pizza', representation_version: 1, menu: composeServedMenu('x_pizza', { items: b.items, structure: b.structure, extras: b.extras }) });
      const d = m.dishes.find((x) => !x.launcher && m.extrasFor(x.key).some((e) => e.name === name));
      assert.ok(d, `${L}: «${name}» is offered by the served menu`);
      const cart = createCart(m); cart.add(d.key, [m.extrasFor(d.key).find((e) => e.name === name).key], 1);
      const out = serialize(cart, m);
      assert.ok(out.items_text.includes(name), `${L}: «${name}» serializes through the real capp (${out.items_text.slice(0, 120)})`);
    }
  });

  if (fails.length) { console.log(`s2core-r1 FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`s2core-r1: OK (${n})`);
})();
