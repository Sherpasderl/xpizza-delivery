'use strict';
// S2-core (PLAN-structure-S2core-r3 §4; T16) — caps and byte budgets, judged BEFORE any write, behind the extrasCatalog switch:
//   structure_caps   > 20 groups · > 30 extras in a group · > 600 extras · > 60 ops in one draft (vs the live version)
//   structure_bytes  source doc > 512 KiB · eligibility doc > 512 KiB · served public-menu body > 768 KiB
// A restaurant AT the caps (test/_s2core-scale.js: the real writer + allocator) passes, with its sizes and times recorded; over a budget
// the REAL editCatalogCore refuses and writes nothing (m18: a byte check after the write). Run: node catalog/structure-budget.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const STRUCT = { extrasCatalog: true };
{ const p = require.resolve('./platform-extras'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { extrasCapabilities: () => ({ authoring: true }) } }; }   // S1's per-dish checklist ON (the over-budget draft unticks extras)
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: STRUCT.extrasCatalog, choiceEdit: false, sections: false }) } }; }
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { scaledSource, allocate } = require('../test/_s2core-scale');
const XT = require('./exposure-transitions');
const SB = require('./structure-budget');
const { editCatalogCore } = require('./edit-catalog-handler');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const records = (rid, src) => { const b = buildSourceCandidate(rid, src).built; return { items: b.items, extras: b.extras, structure: b.structure }; };
// judged against ITSELF as the live version (no ops), unless a cell says otherwise
const judge = (rid, src, active = src) => SB.enforce({ rid, source: src, draft: records(rid, src), active: records(rid, active), extrasCatalog: STRUCT.extrasCatalog });
const refused = (fn, code, field) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, `refused with ${e.code}: ${e.message}`); if (field) assert.strictEqual(e.field, field, `field ${e.field}`); return; } assert.fail(`not refused (${code} ${field || ''})`); };
const SCALE = { x_pizza: scaledSource('x_pizza'), la_musa: scaledSource('la_musa') };

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    await cell(`BUDGET-AT-CAPS ${rid}: 300 dishes × 600 extras × 20 groups pass every cap and budget (sizes + time recorded)`, (L) => {
      const s = SCALE[rid];
      const t = process.hrtime.bigint(); const m = judge(rid, s); const ms = Number(process.hrtime.bigint() - t) / 1e6;
      assert.ok(m && m.sourceBytes > 100 * 1024, `${L}: premise — a large source was measured (${m && m.sourceBytes})`);
      console.log(`      ${rid} at caps: source ${(m.sourceBytes / 1024).toFixed(1)} KiB · eligibility ${(m.eligibilityBytes / 1024).toFixed(1)} KiB · served ${(m.servedBytes / 1024).toFixed(1)} KiB · judged in ${ms.toFixed(0)} ms`);
    });
  }
  await cell('SERVED-COMPLETE (Codex build r1 P2-8): the served measure includes the public eligibility and item_keys, above the bare body', (L) => {
    const s = SCALE.x_pizza; const d = records('x_pizza', s);
    const elig = require('./extras-eligibility-store').buildEligibilityDoc(d);
    const bare = Buffer.byteLength(JSON.stringify(require('./public-menu').composeServedMenu('x_pizza', d)));
    const m = judge('x_pizza', s);
    // the measured CORE (the bound minus its fixed allowances) is exactly the endpoint's composition WITH the public eligibility and item_keys
    // the endpoint's own sequence (catalog/public-menu.js buildPublicMenu): compose, then attach the version's public eligibility and avail_identity
    const body = require('./public-menu').composeServedMenu('x_pizza', { ...d, keyMode: s.key_mode });
    body.extras_eligibility = { version: elig.version, deny: elig.public_deny };
    body.avail_identity = { field: require('../menu-pricing').availIdentityField('x_pizza', s.key_mode) };
    assert.ok(Object.keys(elig.public_deny).length, `${L}: premise — the deny lists are not empty`);
    const core = Buffer.byteLength(JSON.stringify(require('./identity-overlay').withServedItemKeys('x_pizza', body, null)));
    const parts = SB.servedParts({ rid: 'x_pizza', draft: d, elig, keyMode: s.key_mode });
    assert.strictEqual(parts.core, core, `${L}: the bound's core is the complete composition`);
    assert.strictEqual(m.servedBytes, parts.core + parts.photos + parts.identity + parts.header, `${L}: the bound is its measured parts`);
    const legacy = require('./public-photos').buildPhotos({ items: d.items }, require('./public-photos').assetBaseFor('x_pizza', require('../platform-manifest').PLATFORM.sites) || '');
    assert.ok(parts.photos >= Buffer.byteLength(JSON.stringify(legacy)), `${L}: the photos part covers the served legacy photos`);
    assert.ok(parts.identity >= (body.dishes.length + body.extras.length) * 13, `${L}: the identity part counts every record`);
    assert.ok(core > bare + Buffer.byteLength(JSON.stringify(elig.public_deny)) / 2, `${L}: ${core} is well above the bare body ${bare}`);
    console.log(`      x_pizza at caps: bare body ${(bare / 1024).toFixed(1)} KiB → complete upper bound ${(m.servedBytes / 1024).toFixed(1)} KiB (limit 768)`);
  });
  await cell('SERVED-BOUNDARY: a served bound exactly AT the limit passes; one byte over is structure_bytes (served)', (L) => {
    const s = SCALE.la_musa; const d = records('la_musa', s);
    const b = SB.servedUpperBound({ rid: 'la_musa', draft: d, elig: require('./extras-eligibility-store').buildEligibilityDoc(d), keyMode: s.key_mode });
    const at = (limit) => SB.enforce({ rid: 'la_musa', source: s, draft: d, active: d, extrasCatalog: true, limits: { ...SB.LIMITS, servedBytes: limit } });
    assert.strictEqual(at(b).servedBytes, b, `${L}: at the limit`);
    refused(() => at(b - 1), 'structure_bytes', 'served');
  });
  // Codex build r2 #8: the decorations are MEASURED, not allowed for — a valid 300-dish menu with long relative photo paths (each served
  // twice in the photos map and once on its dish record) is over 768 KiB served although its source is under 512 KiB
  const longPhotos = () => { const s = clone(SCALE.la_musa); const img = Array.from({ length: 10 }, () => 'p'.repeat(90)).join('/') + '.webp'; for (const it of s.items) it.display.img = img; return s; };
  await cell('SERVED-PHOTOS-MEASURED la_musa: long photo paths push the served response past 768 KiB — structure_bytes (served), the source is fine', (L) => {
    const s = longPhotos();
    assert.ok(Buffer.byteLength(JSON.stringify(s)) < SB.LIMITS.sourceBytes, `${L}: premise — the source is under its budget`);
    refused(() => judge('la_musa', s), 'structure_bytes', 'served');
  });
  await cell('SERVED-PHOTOS-PUBLISH la_musa: the REAL owner publish refuses that menu (a price edit on it) and publishes nothing', async (L) => {
    const rid = 'la_musa'; const live = longPhotos();
    const draft = clone(live); draft.items[0].price += 1; draft.items[0].display.price = draft.items[0].price;
    const L0 = buildSourceCandidate(rid, live); const D0 = buildSourceCandidate(rid, draft);
    const liveDiff = { ...L0.built, extras: L0.inputs.extras }; const draftDiff = { ...D0.built, extras: D0.inputs.extras };
    const diff = require('./review-diff').reviewDiff({ live: liveDiff, liveExtraRecords: L0.built.extras, draftBuilt: draftDiff, draftExtraRecords: D0.built.extras, extrasCatalog: true });
    const T1 = '2026-11-11T11:00:00.000000Z';
    const { issueEditToken, sha256 } = require('./catalog-edit');
    const token = issueEditToken({ rid, baseActiveVersionId: 'v1', sourceUpdateTime: T1, sourceHash: sha256(draft), diff });
    const publishes = [];
    const r = await require('./publish-edited-handler').publishEditedCore({ db: {}, authorize: async () => ({ ok: true, uid: 'u', role: 'owner', actor: 'o@x.hn' }),
      readActiveBuilt: async () => ({ built: liveDiff, versionId: 'v1', extraRecords: L0.built.extras }), readDraft: async () => ({ source: draft, updateTime: T1 }),
      publishVersion: async (...a) => { publishes.push(a); return { versionId: 'v2', item_count: 0, extra_count: 0 }; } },
    { restaurantId: rid, token, acknowledgedChanges: diff.largeChangeSet }, {});
    assert.deepStrictEqual([r.status, r.body.error, r.body.field, publishes.length], [400, 'structure_bytes', 'served', 0], `${L}: ${JSON.stringify(r.body).slice(0, 200)}`);
  });
  await cell('SERVED-VERSION-PHOTOS la_musa: every published-photo entry of the draft is counted at the longest bucket URL', (L) => {
    const s = clone(SCALE.la_musa); const d = records('la_musa', s);
    const elig = require('./extras-eligibility-store').buildEligibilityDoc(d);
    const without = SB.servedUpperBound({ rid: 'la_musa', draft: d, elig, keyMode: s.key_mode });
    const photos = Object.fromEntries(s.items.slice(0, 50).map((it, i) => [it.key, { state: 'pid', pid: i.toString(16).padStart(32, '0') }]));
    const withP = SB.servedUpperBound({ rid: 'la_musa', draft: d, elig, keyMode: s.key_mode, photos });
    const one = Buffer.byteLength(JSON.stringify({ x: { card: SB.publicUrlBound('la_musa', '0'.repeat(32), 'card'), hero: SB.publicUrlBound('la_musa', '0'.repeat(32), 'hero') } }));
    assert.ok(withP - without >= 50 * (one - 10), `${L}: ${withP - without} ≥ 50 entries × ${one - 10}`);
  });
  // Codex build r3 #8: the item_keys map is the ENDPOINT's — servedKeyMap(menu), keyed by display id to the pricing key — so a menu whose
  // frozen (long) keys were renamed to short labels serves those long keys; the bound measures them
  await cell('SERVED-FROZEN-KEYS x_pizza: renamed frozen long keys are measured as served (servedKeyMap), not as their short labels', (L) => {
    const s = clone(SCALE.x_pizza); s.frozen_keys = s.frozen_keys || {};
    let n0 = 0;
    for (const it of s.items) {
      if (it.display.variantOf != null || n0 >= 276) continue;
      const longKey = `${it.key} ${'x'.repeat(200)}`.slice(0, 220);
      s.structure.item_order = s.structure.item_order.map((k) => (k === it.key ? longKey : k));
      it.key = longKey; s.frozen_keys[String(it.display.id)] = longKey; it.display.name = `P${n0}`; n0 += 1;
    }
    const d = records('x_pizza', s);
    assert.ok(d.items.filter((i) => i.key.length > 200).length >= 276, `${L}: premise — the built records keep the long frozen keys`);
    const elig = require('./extras-eligibility-store').buildEligibilityDoc(d);
    const IO = require('./identity-overlay');
    const body = require('./public-menu').composeServedMenu('x_pizza', { ...d, keyMode: s.key_mode });
    body.extras_eligibility = { version: elig.version, deny: elig.public_deny };
    body.avail_identity = { field: require('../menu-pricing').availIdentityField('x_pizza', s.key_mode) };
    const served = IO.withServedItemKeys('x_pizza', body, IO.servedKeyMap({ items: d.items }));   // the endpoint's own call (public-menu.js)
    const parts = SB.servedParts({ rid: 'x_pizza', draft: d, elig, keyMode: s.key_mode });
    assert.strictEqual(parts.core, Buffer.byteLength(JSON.stringify(served)), `${L}: the core is the served body with the endpoint's key map`);
    const longIds = Object.values(served.item_keys).filter((k) => k.length > 200).length;
    assert.ok(longIds >= 276, `${L}: premise — the served item_keys carry the long keys (${longIds})`);
  });
  await cell('CAPS-GROUPS: a 21st group is structure_caps (extra_categories)', () => {
    const s = allocate(XT.apply(SCALE.la_musa, { op: 'group.create', group: 'Grupo 20', extras: [{ ref: 'tmp:grp20-ex0-xx', name: 'Uno', price: 10 }], attach: { mode: 'none' } }).source);
    refused(() => judge('la_musa', s), 'structure_caps', 'extra_categories');
  });
  await cell('CAPS-PER-GROUP: a 31st extra in a group is structure_caps (extras)', () => {
    const s = allocate(XT.apply(SCALE.la_musa, { op: 'extra.add', group: SCALE.la_musa.structure.extra_categories[0], ref: 'tmp:extra-31-xx', name: 'Extra Treinta Y Uno', price: 10 }).source);
    refused(() => judge('la_musa', s), 'structure_caps', 'extras');
  });
  await cell('CAPS-OPS: 60 ops in one draft pass; a 61st is structure_caps (ops)', () => {
    const base = buildSourceFromCode('x_pizza');
    let s = base;
    for (let i = 0; i < 60; i++) s = XT.apply(s, { op: 'extra.add', group: base.structure.extra_categories[i % 3], ref: `tmp:ops-${i}-xxxxx`, name: `Op Extra ${i}`, price: 20 }).source;
    s = allocate(s);
    judge('x_pizza', s, base);
    refused(() => judge('x_pizza', XT.apply(s, { op: 'group.order', order: [...s.structure.extra_categories].reverse() }).source, base), 'structure_caps', 'ops');
  });
  await cell('DERIVED-CLAIM-EXACT (T21): after attach / detach / create the built maps ARE the projection; a stray map edit is structure_unexplained', (L) => {
    let s = buildSourceFromCode('la_musa');
    s = XT.apply(s, { op: 'attach.item', item: 'dimsum_01', group: 'Proteínas' }).source;
    s = XT.apply(s, { op: 'detach.item', item: 'rice_03', group: 'Proteínas' }).source;
    s = allocate(XT.apply(s, { op: 'group.create', group: 'Grupo Nuevo', extras: [{ ref: 'tmp:grp-new-ex0-x', name: 'Uno Nuevo', price: 10 }], attach: { mode: 'items', items: ['dimsum_02'] } }).source);
    const base = buildSourceFromCode('la_musa');
    judge('la_musa', s, base);
    const d = records('la_musa', s);
    assert.ok(Object.keys(d.structure.extras_by_item || {}).length, `${L}: premise — per-dish entries were derived`);
    for (const [f, mutate] of [['extras_by_item', (st) => { st.extras_by_item = { ...st.extras_by_item, dimsum_03: ['Proteínas'] }; }], ['extras_by_category', (st) => { st.extras_by_category = { ...st.extras_by_category, dim_sum: ['Salsas'] }; }]]) {
      const stray = clone(d); mutate(stray.structure);
      refused(() => SB.enforce({ rid: 'la_musa', source: s, draft: stray, active: records('la_musa', base), extrasCatalog: true }), 'structure_unexplained', f);
    }
  });
  await cell('BYTES-REFUSE-OVER la_musa: every dish unticking all but one extra pushes the source past 512 KiB — structure_bytes (source)', () => {
    const s = clone(SCALE.la_musa); const keys = s.extras.map((e) => e.key);
    for (const it of s.items) if (it.display.variantOf == null) s.structure.exposure.item_overrides[it.key] = { deny_extras: keys.slice(1) };
    refused(() => judge('la_musa', s), 'structure_bytes', 'source');
  });
  await cell('BUDGET-SWITCH-OFF: with extrasCatalog OFF nothing is judged (today\'s save, byte for byte)', (L) => {
    STRUCT.extrasCatalog = false;
    try { assert.strictEqual(judge('la_musa', clone(SCALE.la_musa)), null, `${L}: nothing measured`); } finally { STRUCT.extrasCatalog = true; }
  });
  await cell('BYTES-BEFORE-WRITE (m18): the REAL save refuses an over-budget draft and writes nothing', async (L) => {
    const rid = 'la_musa'; const live = clone(SCALE.la_musa);
    const draft = clone(live); const keys = draft.extras.map((e) => e.key);
    for (const it of draft.items) if (it.display.variantOf == null) draft.structure.exposure.item_overrides[it.key] = { deny_extras: keys.slice(1) };
    const writes = [];
    const T0 = '2026-11-11T10:00:00.000000Z';
    const doc = (path) => ({
      get: async () => (path === `restaurants/${rid}/meta/source` ? { exists: true, data: () => clone(live), updateTime: T0 } : path === `restaurants/${rid}/meta/active_version` ? { exists: true, data: () => ({ version: 'v1' }) } : { exists: false, data: () => ({}) }),
      set: async (d) => { writes.push(path); return { writeTime: T0 }; }, update: async (d) => { writes.push(path); return { writeTime: T0 }; }, create: async () => { writes.push(path); return { writeTime: T0 }; },
    });
    const db = { collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }) }) }), batch: () => ({ update: () => writes.push('batch'), create: () => writes.push('batch'), set: () => writes.push('batch'), commit: async () => {} }) };
    const L0 = buildSourceCandidate(rid, live);
    const readActiveBuilt = async () => ({ built: { ...L0.built, extras: L0.inputs.extras }, versionId: 'v1', extraRecords: L0.built.extras });
    const r = await editCatalogCore({ db, authorize: async () => ({ ok: true, uid: 'u', role: 'owner', actor: 'o@x.hn' }), readActiveBuilt }, { restaurantId: rid, source: draft, baseSourceUpdateTime: T0 }, {});
    assert.deepStrictEqual([r.status, r.body.error, r.body.field], [400, 'structure_bytes', 'source'], `${L}: refused (${JSON.stringify(r.body).slice(0, 200)})`);
    assert.deepStrictEqual(writes, [], `${L}: nothing written`);
  });
  await cell('BYTES-BEFORE-PUBLISH: the REAL owner publish refuses an over-budget draft (valid token) and publishes nothing', async (L) => {
    const rid = 'la_musa'; const live = clone(SCALE.la_musa);
    const draft = clone(live); const keys = draft.extras.map((e) => e.key);
    for (const it of draft.items) if (it.display.variantOf == null) draft.structure.exposure.item_overrides[it.key] = { deny_extras: keys.slice(1) };
    const L0 = buildSourceCandidate(rid, live); const D0 = buildSourceCandidate(rid, draft);
    const liveDiff = { ...L0.built, extras: L0.inputs.extras }; const draftDiff = { ...D0.built, extras: D0.inputs.extras };
    const diff = require('./review-diff').reviewDiff({ live: liveDiff, liveExtraRecords: L0.built.extras, draftBuilt: draftDiff, draftExtraRecords: D0.built.extras, extrasCatalog: true });
    const T1 = '2026-11-11T11:00:00.000000Z';
    const { issueEditToken, sha256 } = require('./catalog-edit');
    const token = issueEditToken({ rid, baseActiveVersionId: 'v1', sourceUpdateTime: T1, sourceHash: sha256(draft), diff });
    const publishes = [];
    const r = await require('./publish-edited-handler').publishEditedCore({ db: {}, authorize: async () => ({ ok: true, uid: 'u', role: 'owner', actor: 'o@x.hn' }),
      readActiveBuilt: async () => ({ built: liveDiff, versionId: 'v1', extraRecords: L0.built.extras }), readDraft: async () => ({ source: draft, updateTime: T1 }),
      publishVersion: async (...a) => { publishes.push(a); return { versionId: 'v2', item_count: 0, extra_count: 0 }; } },
    { restaurantId: rid, token, acknowledgedChanges: diff.largeChangeSet }, {});
    assert.deepStrictEqual([r.status, r.body.error, r.body.field], [400, 'structure_bytes', 'source'], `${L}: refused (${JSON.stringify(r.body).slice(0, 200)})`);
    assert.strictEqual(publishes.length, 0, `${L}: nothing published`);
  });
  if (fails.length) { console.log(`structure-budget FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`structure-budget: OK (${n})`);
})();
