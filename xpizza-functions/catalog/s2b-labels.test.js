'use strict';
// S2b (PLAN-structure-S2b-r3 §4) — an affected extra's LABEL and its "label required" marker ride the S1d labels carrier (catalog-firestore
// readVersionDocs → the reader → the pricing tables → last-good / snapshot / mirror) under `x:<key>` / `x?:<key>`, written from the
// version's OWN frozen_extra_keys — never from «key ≠ derived». No affected extra → nothing added (today's bytes). A required label that
// is missing, or a minted key with no label, is refused by resolveLines (every intake, every brand) as labels_unavailable (503, retryable),
// before any money step; factura describes an affected extra by its label. Real publish on the Firestore fake. Run: node catalog/s2b-labels.test.js
const assert = require('assert');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { createCatalogReader } = require('./catalog');
const { createPricingResolver } = require('./pricing-tables');
const CF = require('./catalog-firestore');
const MP = require('../menu-pricing');
const RL = require('./resolve-lines');
const { encodeMirrorTables, decodeMirror } = require('./mirror-keys');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2b-labels: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (o) => JSON.parse(JSON.stringify(o));
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
const MK = 'i_aaaaaaaaaabr';
function recorded(rid) {
  const s = clone(buildSourceFromCode(rid));
  const r = s.extras[0]; r.display.name = 'Renombrado S2b';
  const m = s.extras[1]; const old = m.key;
  if (rid === 'la_musa') m.display.id = MK;
  if (Array.isArray(s.structure.extra_order)) s.structure.extra_order = s.structure.extra_order.map((k) => (k === old ? MK : k));
  for (const f of ['extras_by_category', 'extras_by_item']) if (s.structure[f]) for (const v of Object.values(s.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(old); if (i >= 0) v[i] = MK; }
  if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.map((k) => (k === old ? MK : k));
  m.key = MK; m.display.name = 'Reusado S2b';
  s.frozen_extra_keys = { [r.key]: { display_id: String(r.display.id), field: 'name' }, [MK]: { display_id: String(m.display.id), minted: true, reuses: old } };
  return { s, renamedKey: r.key };
}
const inputOf = (rid, src) => { const { inputs, built } = buildSourceCandidate(rid, src);
  return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'lb', ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }), ...(built.frozen_extra_keys == null ? {} : { frozen_extra_keys: built.frozen_extra_keys }) }; };
async function tablesOf(rid, src) {
  const db = makeDb(); await quiet(() => publishVersion(db, rid, inputOf(rid, src), { expected: { activeVersionId: null } }));
  const reader = createCatalogReader({ getRestaurantDocs: (r) => CF.getRestaurantDocs(db, r) });
  return quiet(() => createPricingResolver({ reader, alarm: () => {} }).getPricingTables(rid));
}

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const { s, renamedKey } = recorded(rid);
    const T = await tablesOf(rid, s); const L = MP.labelsOfTables(T) || {};
    assert.deepStrictEqual([L[`x:${renamedKey}`], L[`x:${MK}`], L[`x?:${renamedKey}`], L[`x?:${MK}`]], ['Renombrado S2b', 'Reusado S2b', '1', '1'], `S2BLB-CARRIER ${rid}: labels + markers ride the tables`);
    const base = MP.labelsOfTables(await tablesOf(rid, buildSourceFromCode(rid))) || null;
    assert.ok(!base || !Object.keys(base).some((k) => /^x\??:/.test(k)), `S2BLB-OFF ${rid}: no affected extra → nothing added`);
    // the mirror codec round-trips the namespaced keys
    const enc = encodeMirrorTables(T.menu, T.extras, L); const dec = decodeMirror(enc);
    assert.deepStrictEqual([dec.labels[`x:${MK}`], dec.labels[`x?:${renamedKey}`]], ['Reusado S2b', '1'], `S2BLB-MIRROR ${rid}`);
    // labels_unavailable: a required label missing (marker kept) / a minted key with no label at all
    const dish = Object.keys(T.menu).find((k) => !/^i_/.test(k));
    const cart = (ek) => ({ items: [{ ...(rid === 'la_musa' ? { id: dish } : {}), name: dish, qty: 1, extras: [{ ...(rid === 'la_musa' ? { id: ek } : { name: ek }), qty: 1, extra_key: ek }] }] });
    assert.deepStrictEqual(RL.resolveLines(rid, cart(MK), T), { ok: true }, `S2BLB-OK ${rid}: labelled`);
    const noLabel = MP.attachTablesLabels(MP.attachTablesKeyMode({ restaurantId: rid, menu: T.menu, extras: T.extras }, MP.keyModeOfTables(T)), Object.fromEntries(Object.entries(L).filter(([k]) => k !== `x:${renamedKey}`)));
    const r1 = RL.resolveLines(rid, cart(renamedKey), noLabel);
    assert.strictEqual(r1.code, 'labels_unavailable', `S2BLB-GAP-RENAMED ${rid}: a required label missing (${JSON.stringify(r1)})`);
    const bare = MP.attachTablesLabels(MP.attachTablesKeyMode({ restaurantId: rid, menu: T.menu, extras: T.extras }, MP.keyModeOfTables(T)), Object.fromEntries(Object.entries(L).filter(([k]) => !/^x\??:/.test(k))));
    assert.deepStrictEqual(RL.resolveLines(rid, cart(MK), bare), { ok: true }, `S2BLB-NO-METADATA ${rid}: «affected» comes ONLY from the recorded marker — an opaque-looking key with none is not label-required (Codex S2b r1 P1-1)`);
    assert.deepStrictEqual(RL.resolutionRefusal(r1), { status: 503, body: { error: 'labels_unavailable', retryable: true } }, `S2BLB-503 ${rid}`);
    ok(`${rid}: labels + markers ride the tables and the mirror codec; nothing added without an affected extra; a missing required label → labels_unavailable (503); no marker → not required`);
  }
  { // P1-1 (Codex S2b r1): OFF, an ORDINARY extra whose name/key merely looks opaque (i_abcdefghijkl) resolves exactly as today
    const s = clone(buildSourceFromCode('x_pizza')); const e = s.extras[2]; const old = e.key; const K = 'i_abcdefghijkl';
    e.key = K; e.display.name = K;
    if (Array.isArray(s.structure.extra_order)) s.structure.extra_order = s.structure.extra_order.map((k) => (k === old ? K : k));
    for (const f of ['extras_by_category', 'extras_by_item']) if (s.structure[f]) for (const v of Object.values(s.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(old); if (i >= 0) v[i] = K; }
    if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.map((k) => (k === old ? K : k));
    const T = await tablesOf('x_pizza', s);
    const dish = Object.keys(T.menu)[0];
    assert.deepStrictEqual(RL.resolveLines('x_pizza', { items: [{ name: dish, qty: 1, extras: [{ name: K, qty: 1 }] }] }, T), { ok: true }, 'S2BLB-OFF-OPAQUE: an ordinary i_… extra resolves (no labels_unavailable)');
    ok('OFF-OPAQUE: an ordinary extra named like an opaque key resolves as today');
  }
  { // factura (x_pizza only): an affected extra is described by its LABEL; an unaffected one by today's name
    const { pricedLineItems } = require('../factura/pricing');
    const { s, renamedKey } = recorded('x_pizza'); const T = await tablesOf('x_pizza', s); const L = MP.labelsOfTables(T);
    const dish = Object.keys(T.menu).find((k) => !/^i_/.test(k));
    const r = pricedLineItems([{ name: dish, qty: 1, extras: [{ name: renamedKey, extra_key: renamedKey }, { name: 'whatever', extra_key: MK }] }], T.menu, T.extras, L, undefined);
    assert.ok(!r.error, `S2BLB-FACTURA: priced (${r.error})`);
    assert.ok(/\(\+Renombrado S2b, Reusado S2b\)$/.test(r.items[0].description), `S2BLB-FACTURA: described by labels (${r.items[0].description})`);
    ok('factura: affected extras are priced by their key and described by their label');
  }
  FINISHED = true;
  console.log(`s2b-labels: OK (${n})`);
})().catch((e) => { console.error('s2b-labels FAILED:', e && e.message); process.exit(1); });
