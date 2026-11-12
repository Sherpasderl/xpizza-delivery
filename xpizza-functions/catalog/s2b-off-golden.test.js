'use strict';
// S2b switch-OFF proof (PLAN-structure-S2b-r3 §8) — with MINT_OPAQUE_EXTRAS OFF (as shipped) and no affected extra, every payload the
// slice touches is BYTE-IDENTICAL to the base (S3 e97f70f2): both brands, the REAL writers and readers, compared against a golden
// CAPTURED by running these same scenarios on the base handlers (`node catalog/s2b-off-golden.test.js --capture <base xpizza-functions>`):
//   PUBLISH  the version metadata + docs, the snapshot, the pointer and the reserved keys (the whole store) + both mirror payloads
//   ROLLBACK a second (price-edited) version published, then rolled back: the store + the mirror payload
//   SERVED   the public-menu body, representation version and the etag formula over them (the identity overlay on)
//   TABLES   the pricing tables (the last-good / snapshot carrier) and the encoded mirror tables
//   CAPP     the customer app's request body (the real adaptMenu → createCart → serialize) and its items_text
//   INTAKE   resolveLines (with any items_text: no derivation without an affected extra), the server total, the quote fingerprint
//   FACTURA  pricedLineItems; REORDER normalizeReorderItemsWithPrices
//   SAVE     the source doc a price edit writes; the refusal of a new dish named like a minted key (`i_abcdefghijkl`)
//   RESET    the source doc a reset to live writes
// Run: node catalog/s2b-off-golden.test.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const capIdx = process.argv.indexOf('--capture');
const FN = capIdx > 0 ? path.resolve(process.argv[capIdx + 1]) : path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 's2b-off.golden.json');
const R = (rel) => require(path.join(FN, rel));
const APP = (rel) => require(path.join(FN, '..', 'customer-app', rel));
const { makeDb } = R('catalog/firestore-fake');
const { publishVersion, rollbackVersion, previewVersion } = R('catalog/catalog-publish');
const { buildSourceCandidate } = R('catalog/candidate-validate');
const { buildPublicMenu } = R('catalog/public-menu');
const { buildSourceFromCode } = R('tools/seed-source-store');
const { createCatalogReader } = R('catalog/catalog');
const { createPricingResolver } = R('catalog/pricing-tables');
const CF = R('catalog/catalog-firestore');
const { resolveLines } = R('catalog/resolve-lines');
const { computeServerTotal } = R('menu-pricing');
const { encodeMirrorTables } = R('catalog/mirror-keys');
const { normalizeCartForFingerprint, cartFingerprint } = R('quote-token');
const { pricedLineItems } = R('factura/pricing');
const { normalizeReorderItemsWithPrices } = R('reorder-normalize');
const { editCatalogCore } = R('catalog/edit-catalog-handler');
const { resetDraftToLiveCore } = R('catalog/reset-draft');
const { sourceRefOf, encodeUpdateTime } = R('catalog/source-store');
const { adaptMenu } = APP('capp-menu.js');
const { createCart } = APP('capp-cart.js');
const { serialize } = APP('capp-serialize.js');

const clone = (o) => JSON.parse(JSON.stringify(o));
const quiet = async (f) => { const l = console.log, w = console.warn, e = console.error; console.log = console.warn = console.error = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; console.error = e; } };
// canonical JSON: sorted keys, Timestamps as millis, Maps / Sets as sorted entries
const canon = (v) => {
  if (v && typeof v.toMillis === 'function') return { $ts: v.toMillis() };
  if (v instanceof Map) return { $map: [...v.entries()].map(([k, x]) => [k, canon(x)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) };
  if (v instanceof Set) return { $set: [...v].map(canon).sort() };
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o; }
  return v;
};
const dump = (db) => canon(Object.fromEntries([...db._raw.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, d]) => [p, { data: d.data, updateTime: d.updateTime }])));
const inputOf = (rid, src, sha) => { const { inputs, built } = buildSourceCandidate(rid, src);
  return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: sha, ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) }; };
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });

async function scenarios(rid) {
  const out = {};
  const seed = buildSourceFromCode(rid);
  const db = makeDb(); const mirrors = [];
  const mirror = (r, payload) => { mirrors.push(canon(clone(payload))); };
  const v1 = (await quiet(() => publishVersion(db, rid, inputOf(rid, seed, 'off1'), { mirror, expected: { activeVersionId: null } }))).versionId;
  out.PUBLISH = { store: dump(db), mirrors: mirrors.splice(0) };
  const m = await quiet(() => buildPublicMenu(db, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true }));
  // the etag hashes the body, whose identity overlay carries the registry's random ids: compared as the FORMULA (an equal body ⇒ an equal etag)
  const etagOfBody = m.etag === `"${require('crypto').createHash('sha256').update(`${rid} ${m.representation_version} ${R('catalog/canonical-json').canonicalJson(m.body)}`).digest('hex')}"`;
  out.SERVED = { body: canon(m.body), representation_version: m.representation_version, etag_is_sha256_of_rid_representation_body: etagOfBody };
  const reader = createCatalogReader({ getRestaurantDocs: (r) => CF.getRestaurantDocs(db, r) });
  const tables = await quiet(() => createPricingResolver({ reader, alarm: () => {} }).getPricingTables(rid));
  out.TABLES = { tables: canon(tables), mirror: canon(encodeMirrorTables(tables.menu, tables.extras, tables.labels || null)) };
  // the customer app's cart: a dish with one extra ×2, the same dish with another ×1, a plain dish
  const menu = adaptMenu({ rid: m.rid, representation_version: m.representation_version, menu: clone(m.body) });
  const d = menu.dishes.find((x) => !x.launcher && menu.extrasFor(x.key).length >= 2); const [e1, e2] = menu.extrasFor(d.key);
  const p = menu.dishes.find((x) => !x.launcher && x.key !== d.key);
  const cart = createCart(menu); cart.add(d.key, [e1.key], 2); cart.add(d.key, [e2.key], 1); cart.inc(p.key);   // one extra per configuration: the serializer orders a line's extras by the registry's (random) extra id
  const body = serialize(cart, menu);
  out.CAPP = canon(body);
  const judged = clone(body); judged.items_text = 'cualquier texto';
  const rl = resolveLines(rid, judged, tables);
  const total = computeServerTotal(clone(body.items), rid, tables);
  const norm = normalizeCartForFingerprint(clone(body.items), rid, tables.keyMode);
  out.INTAKE = { resolve: canon(rl), total: canon(total), fingerprint: norm ? cartFingerprint(norm, null) : null };
  out.FACTURA = canon(pricedLineItems(clone(body.items), tables.menu, tables.extras, tables.labels || null, tables.versionId));
  out.REORDER = canon(normalizeReorderItemsWithPrices(clone(body.items), rid, tables));
  // a second (price-edited) version, then rolled back to the first
  const edited = clone(seed); edited.items[0].price += 10; edited.items[0].display.price = edited.items[0].price;
  const v2 = (await quiet(() => publishVersion(db, rid, inputOf(rid, edited, 'off2'), { mirror, expected: { activeVersionId: v1 } }))).versionId;
  await quiet(() => rollbackVersion(db, rid, v1, { mirror, expected: { activeVersionId: v2 } }));
  out.ROLLBACK = { store: dump(db), mirrors: mirrors.splice(0) };
  // reset the (edited) draft to live
  { const ref = sourceRefOf(db, rid); await ref.set(edited); const snap = await ref.get();
    const r = await quiet(() => resetDraftToLiveCore({ db, authorize: owner, readActiveVersionId: async () => v1, previewVersion, toPrecondition: () => snap.updateTime },
      { restaurantId: rid, expectedRevision: encodeUpdateTime(snap.updateTime) }, {}));
    out.RESET = { status: r.status, source: canon((await ref.get()).data()) }; }
  // the save: a price edit's written source doc; a new dish named like a minted key is refused as today
  const T0 = '2026-10-24T10:00:00.000000Z'; const T1 = '2026-10-24T11:00:00.000000Z';
  const saveDb = () => { const state = { source: { data: clone(seed), updateTime: T0 } };
    const doc = (pth) => ({ get: async () => { if (pth === `restaurants/${rid}/meta/source`) { const f = clone(state.source.data); return { exists: true, data: () => f, updateTime: state.source.updateTime }; }
      if (pth === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: 'v-off', generation: 0 }) }; return { exists: false, data: () => ({}) }; },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => { if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } state.source = { data, updateTime: T1 }; return { writeTime: T1 }; } });
    return { state, collection: (c) => ({ doc: (dd) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${dd}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) }; };
  const liveRead = async () => { const { inputs, built } = buildSourceCandidate(rid, seed); return { built: { ...built, extras: inputs.extras }, versionId: 'v-off', extraRecords: built.extras }; };
  const strip = (b) => { const c = clone(b); delete c.token; delete c.updateTime; return canon(c); };
  { const sdb = saveDb(); const r = await quiet(() => editCatalogCore({ db: sdb, authorize: owner, readActiveBuilt: liveRead }, { restaurantId: rid, source: edited, baseSourceUpdateTime: T0 }, {}));
    out.SAVE = { status: r.status, body: strip(r.body), stored: canon(sdb.state.source.data) }; }
  { const named = clone(seed); const t = clone(named.items[named.items.length - 1]); t.display.name = 'i_abcdefghijkl'; delete t.display.identity_id;
    if (rid === 'la_musa') { t.display.id = 'zz_off_new'; t.key = 'zz_off_new'; } else { t.key = 'i_abcdefghijkl'; t.display.id = Math.max(...named.items.map((y) => Number(y.display.id) || 0)) + 1; }
    named.items.push(t); named.structure.item_order.push(t.key);
    const sdb = saveDb(); const r = await quiet(() => editCatalogCore({ db: sdb, authorize: owner, readActiveBuilt: liveRead }, { restaurantId: rid, source: named, baseSourceUpdateTime: T0 }, {}));
    out.SAVE_OPAQUE_NAME = { status: r.status, body: strip(r.body) }; }
  return normalize(out);
}
// the run-to-run noise, named — never a content byte: the registry's random identity ids (→ their kind + legacy key, from the registry
// docs themselves), the identity-evidence digests over them (→ vid#n), the version ids' content-hash suffix order (→ v#1, v#2 by first appearance) and wall-clock ISO stamps
function normalize(out) {
  let text = JSON.stringify(out);
  const ids = new Map();
  for (const st of [out.PUBLISH.store, out.ROLLBACK.store]) for (const [p, d] of Object.entries(st)) {
    const m = /^restaurants\/[^/]+\/identity\/([^/]+)\/ids\/([^/]+)$/.exec(p);
    if (m && d.data && typeof d.data.legacy_key === 'string') ids.set(m[2], `ID<${m[1]}:${d.data.legacy_key}>`);
  }
  for (const [id, name] of [...ids.entries()].sort((a, b) => b[0].length - a[0].length)) text = text.split(id).join(name);
  const vs = []; text = text.replace(/v-\d{13}-[0-9a-f]{12}/g, (v) => { let i = vs.indexOf(v); if (i < 0) { vs.push(v); i = vs.length - 1; } return `v#${i + 1}`; });
  text = text.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<iso>');
  const vids = []; text = text.replace(/"vid":"([A-Za-z0-9_-]{43})"/g, (_, v) => { let i = vids.indexOf(v); if (i < 0) { vids.push(v); i = vids.length - 1; } return `"vid":"vid#${i + 1}"`; });   // the evidence digest over those random ids
  return canon(JSON.parse(text));   // re-sorted: the renamed keys' order no longer follows the random ids
}

(async () => {
  const now = {};
  for (const rid of ['x_pizza', 'la_musa']) now[rid] = await scenarios(rid);
  const text = JSON.stringify(now, null, 1) + '\n';
  if (capIdx > 0) { fs.writeFileSync(GOLDEN, text); console.log(`s2b-off-golden: CAPTURED from ${FN} → ${path.relative(process.cwd(), GOLDEN)} (${text.length} bytes)`); return; }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  let n = 0;
  for (const rid of Object.keys(golden)) for (const k of Object.keys(golden[rid])) {
    assert.deepStrictEqual(now[rid][k], golden[rid][k], `🔴 S2B-OFF ${rid} ${k}: differs from the base (e97f70f2) bytes`);
    console.log(`  ✓ ${++n} ${rid} ${k} byte-identical to the base`);
  }
  assert.deepStrictEqual(Object.keys(now).map((r) => Object.keys(now[r]).sort()), Object.keys(golden).map((r) => Object.keys(golden[r]).sort()), 'the same scenarios as the golden');
  console.log(`s2b-off-golden: OK (${n})`);
})().catch((e) => { console.error('s2b-off-golden FAILED:', e && e.message); process.exit(1); });
