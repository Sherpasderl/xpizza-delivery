'use strict';
// S2-4/5 (D4c-grill/item-s1/S2-DESIGN.md §1.1; advisor rulings 2 + 3 + G4/G5; Codex r1 P1-1/P2-9) — getEditableCatalog states the
// text-edit switch (always), serves THIS restaurant's normalized reserved names while it is on (absent in the declared degraded
// mode, the read still answering), and lists the saved-but-unpublished text edits per product — only on a publishable draft,
// never for an option row — while pendingOther keeps its meaning. The REAL handler over the real built sources.
// Run: node catalog/s2-portal-reads.test.js
const assert = require('assert');
const SWITCH = { enabled: false };
require.cache[require.resolve('./item-text-edit')] = { id: require.resolve('./item-text-edit'), filename: require.resolve('./item-text-edit'), loaded: true,
  exports: { textEditCapabilities: () => { if (SWITCH.throws) throw new Error('switch unreadable'); return { enabled: SWITCH.enabled }; } } };
const { getEditableCatalogCore } = require('./portal-reads');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { rederiveOptionNames } = require('./add-product');
const { emptyReserved, unionReserved, reservedKeySet } = require('./reserved-keys');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2-portal-reads: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (o) => JSON.parse(JSON.stringify(o));
const itemOf = (s, key) => s.items.find((i) => i.key === key);
const TS = { seconds: 1788754374, nanoseconds: 634000000 };
const asOwner = async () => ({ ok: true, uid: 'uidOwner001', role: 'owner', actor: 'o@m.hn' });
const gReq = (rid) => ({ method: 'GET', query: { restaurantId: rid }, get: () => 'Bearer tok' });
const builtOf = (rid, src) => { const i = sourceToBuildInputs(src); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, keyMode: i.keyMode, frozenKeys: i.frozenKeys }); return { built: { ...b, extras: i.extras }, versionId: 'v-live', extraRecords: b.extras }; };
const read = async (rid, draft, { reserved = undefined, reservedThrows = false } = {}) => {
  const calls = { reserved: 0 };
  const r = await getEditableCatalogCore({
    db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => 'v-live',
    _sourceRefOf: () => ({ get: async () => ({ exists: true, data: () => clone(draft), updateTime: TS }) }),
    readActiveBuilt: async () => builtOf(rid, buildSourceFromCode(rid)),
    readReservedKeys: async () => { calls.reserved += 1; if (reservedThrows) throw new Error('UNAVAILABLE'); return reservedKeySet(reserved); },
  }, gReq(rid));
  return { r, calls };
};
const reservedDoc = (keys) => unionReserved(emptyReserved(), { dish: keys, extra: [] }, 'v-x').doc;

(async () => {
  const XP = buildSourceFromCode('x_pizza'); const LM = buildSourceFromCode('la_musa');
  const ID = String(itemOf(XP, 'Carnivora').display.id);

  // ── switch OFF: today's body + textEditEnabled:false only; the reserved set is never read ──
  {
    SWITCH.enabled = false;
    const { r, calls } = await read('x_pizza', XP, { reserved: reservedDoc(['Plato Viejo']) });
    assert.strictEqual(r.status, 200, `premise (${JSON.stringify(r.body).slice(0, 160)})`);
    assert.strictEqual(r.body.textEditEnabled, false, 'S2R-OFF textEditEnabled:false, always present');
    assert.ok(!('reservedNames' in r.body) && !('pendingTexts' in r.body), 'S2R-OFF no reservedNames, no pendingTexts');
    assert.strictEqual(calls.reserved, 0, 'S2R-OFF the reserved set is not read');
    ok('switch OFF: textEditEnabled:false is the one additive field; nothing else is read or served');
  }
  // ── the switch cannot be read → fail CLOSED (textEditEnabled:false; nothing served) ──
  {
    SWITCH.enabled = true; SWITCH.throws = true;
    const { r, calls } = await read('x_pizza', XP, { reserved: reservedDoc(['Plato Viejo']) });
    SWITCH.throws = false;
    assert.strictEqual(r.body.textEditEnabled, false, 'S2R-THROW an unreadable switch reads as OFF (fail-closed)');
    assert.ok(!('reservedNames' in r.body) && calls.reserved === 0, 'S2R-THROW and nothing ON-only is read or served');
    ok('an unreadable switch fails closed: textEditEnabled:false');
  }
  SWITCH.enabled = true;
  // ── switch ON: the normalized reserved names (reserved doc ∪ frozen values) ──
  {
    const draft = { ...clone(XP), frozen_keys: { 424242: 'Clave Congelada' } };
    const { r, calls } = await read('x_pizza', draft, { reserved: reservedDoc(['Plato Viejo', '  PLATÓ   viejo ', 'Carnívora']) });
    assert.strictEqual(r.body.textEditEnabled, true, 'S2R-ON textEditEnabled:true');
    assert.deepStrictEqual(r.body.reservedNames, ['carnivora', 'clave congelada', 'plato viejo'], 'S2R-RESERVED normalized, unique, sorted: the reserved doc ∪ the draft\'s frozen values');
    assert.strictEqual(calls.reserved, 1, 'S2R-RESERVED one read');
    const bad = await read('x_pizza', XP, { reservedThrows: true });
    assert.strictEqual(bad.r.status, 200, 'S2R-DEGRADED the read still answers');
    assert.ok(!('reservedNames' in bad.r.body), 'S2R-DEGRADED reservedNames absent when the set cannot be read (C5 on «Guardar»)');
    ok('switch ON: normalized reserved names; an unreadable set leaves the field absent and the read answering');
  }
  // ── pendingTexts: per product, against live; never an option row; pendingOther keeps its meaning ──
  {
    const x = clone(XP); x.frozen_keys = { [ID]: 'Carnivora' }; itemOf(x, 'Carnivora').display.name = 'Carnívora Suprema'; itemOf(x, 'Carnivora').display.desc = 'Nueva';
    const { r } = await read('x_pizza', x);
    assert.ok(!r.body.draft_unpublishable, `premise: publishable (${JSON.stringify(r.body.draft_unpublishable)})`);
    assert.deepStrictEqual(r.body.pendingTexts, [{ key: 'Carnivora', fields: ['name', 'desc'] }], 'S2R-PENDING a renamed + redescribed product');
    assert.strictEqual(r.body.pendingOther, true, 'S2R-PENDING-OTHER a pending text edit still sets pendingOther (the old portal locks section renames)');
    const l = rederiveOptionNames((() => { const s = clone(LM); itemOf(s, 'noodle_01').display.name = 'Pad Thai Nuevo'; return s; })());
    const lr = await read('la_musa', l);
    assert.deepStrictEqual(lr.r.body.pendingTexts, [{ key: 'noodle_01', fields: ['name'] }], 'S2R-PENDING-GROUP the launcher only — never its option rows');
    const none = await read('x_pizza', XP);
    assert.ok(!('pendingTexts' in none.r.body), 'S2R-PENDING-NONE absent when nothing is pending');
    ok('pendingTexts: one entry per edited product (launcher only), fields in order; pendingOther unchanged');
  }
  // ── only when the draft is publishable ──
  {
    const x = clone(XP); itemOf(x, 'Carnivora').display.name = 'Carnívora Suprema';   // no frozen record → the assessment refuses
    const { r } = await read('x_pizza', x);
    assert.ok(r.body.draft_unpublishable, 'premise: unpublishable');
    assert.ok(!('pendingTexts' in r.body), 'S2R-UNPUBLISHABLE no pendingTexts on an unpublishable draft');
    ok('pendingTexts is served only for a publishable draft');
  }
  FINISHED = true;
  console.log(`\ns2-portal-reads: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
