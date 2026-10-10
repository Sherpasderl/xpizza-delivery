'use strict';
// 1D add-product PHASE A §7 — "a price-only edit or publish behaves exactly as today": REAL-HANDLER GOLDENS, before vs
// after (part of `npm run test:add-product`). Status + normalized body + every Firestore call (method + path, through
// transactions and batches), for today's inputs on both brands and every tier.
//   AP_GOLDEN_CAPTURE=1 in a checkout of the BASE (37dcf43) writes test/add-product-base.golden.json; the candidate
//   compares against it. The SAME file runs on both: the base cores simply ignore the add-product dependencies.
// PERMITTED DIFFERENCES (plan §0.6, declared, and the ONLY ones accepted):
//   • editCatalog's body gains `source` (the canonical saved draft); its active-catalog reads move BEFORE the write
//     (compared as a multiset, so a reorder of the same reads is no difference);
//   • publishEdited additionally reads the active pointer + version after the flip (the KDS manifest sync);
//   • getEditableCatalog's body gains `renderedCategories` + `restaurantName`, and it reads the active version (the
//     draft assessment); an invalid stored draft's 503 gains `draft_unpublishable` + `sourceUpdateTime`.
//   Anything else — a status, a body field, a write, a missing or extra read of another kind — fails.
require('./_emulator-required')('firestore', 'database');

const assert = require('assert');
const path = require('path');
const fsys = require('fs');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'add-product-golden-'.padEnd(48, 'x');
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const realDb = admin.firestore();
const rtdb = admin.database();
const CAPTURE = process.env.AP_GOLDEN_CAPTURE === '1';
const GOLDEN = path.join(__dirname, 'add-product-base.golden.json');

const tryReq = (m) => { try { return require(m); } catch (_) { return null; } };
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { getEditableCatalogCore } = require('../catalog/portal-reads');
const { publishVersion, previewVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize, encodeUpdateTime } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { getActivePointer, getActiveVersionId } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const io = tryReq('../catalog/add-product-io');   // absent on the base — the base cores do not take it

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('add-product-golden: FAILED — exited without completing'); process.exitCode = 1; } });

// ── a RECORDING Firestore: every get / write with its path, through refs, queries, transactions and batches ──
let REC = null;
const rec = (op, p) => { if (REC) REC.push(`${op} ${p}`); };
const pathOf = (x) => (x && typeof x.path === 'string' ? x.path : (x && x._queryOptions ? `query:${x._queryOptions.parentPath ? x._queryOptions.parentPath.relativeName : ''}/${x._queryOptions.collectionId}` : '?'));
function recorded(target, kind) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target;
  return new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t);
      if (typeof v !== 'function') return v;
      return (...args) => {
        const unwrap = (a) => (a && a.__real ? a.__real : a);
        const real = args.map(unwrap);
        if (prop === 'get' && kind !== 'tx' && kind !== 'batch') rec('get', pathOf(t));
        if (['set', 'update', 'create', 'delete'].includes(prop) && kind !== 'tx' && kind !== 'batch') rec(prop, pathOf(t));
        if (kind === 'tx' && ['get', 'set', 'update', 'create', 'delete'].includes(prop)) rec(`tx.${prop}`, pathOf(real[0]));
        if (kind === 'batch' && ['set', 'update', 'create', 'delete'].includes(prop)) rec(`batch.${prop}`, pathOf(real[0]));
        if (kind === 'batch' && prop === 'commit') rec('batch.commit', '');
        if (prop === 'runTransaction') {
          rec('runTransaction', '');
          const fn = real[0];
          return v.call(t, (tx) => fn(recorded(tx, 'tx')), ...real.slice(1));
        }
        const out = v.apply(t, real);
        if (out && typeof out.then === 'function') return out;
        if (prop === 'batch') return recorded(out, 'batch');
        if (out && (typeof out.path === 'string' || out._queryOptions)) { const p = recorded(out, 'ref'); return p; }
        return out;
      };
    },
  });
}
const db = recorded(realDb, 'db');

const toPrecondition = (v) => {
  if (typeof v !== 'string') return v;
  const [sec, nanos] = v.split('.');
  if (!/^\d+$/.test(sec || '') || !/^\d+$/.test(nanos || '')) return v;
  return new admin.firestore.Timestamp(Number(sec), Number(nanos));
};
const as = (role) => async () => ({ ok: true, uid: `u_${role}`, role, actor: `${role}@x.hn` });
const addProduct = io ? io.addProductIo({ fs: db, rtdb }) : undefined;
const readActiveBuilt = (rid) => async () => {
  const versionId = await getActiveVersionId(db, rid);
  const p = await previewVersion(db, rid, versionId);
  const extras = {}; for (const e of p.extras) extras[e.key] = e.price;
  return { built: { items: p.items, structure: p.structure, extras }, versionId, extraRecords: p.extras };
};
const readDraft = (rid) => async () => { const s = await sourceRefOf(db, rid).get(); return { source: s.data(), updateTime: encodeUpdateTime(s.updateTime) }; };
const rev = async (rid) => encodeUpdateTime((await sourceRefOf(realDb, rid).get()).updateTime);
const draftOf = async (rid) => (await sourceRefOf(realDb, rid).get()).data();
const save = (rid, source, role, base) => editCatalogCore({ db, authorize: as(role), readActiveBuilt: readActiveBuilt(rid), toPrecondition, addProduct },
  { restaurantId: rid, source, baseSourceUpdateTime: base }, {});
const publish = (rid, token, role, { ack = [], fiscalAck = true } = {}) => publishEditedCore({ db, authorize: as(role), readActiveBuilt: readActiveBuilt(rid), readDraft: readDraft(rid),
  publishVersion, mirror: makeRtdbMirror(rtdb), sourceSha: 'golden', addProduct }, { restaurantId: rid, token, acknowledgedChanges: ack, fiscalAck }, {});
const editable = (rid) => getEditableCatalogCore({ db: rtdb, fsdb: db, authorize: as('owner'), readActiveVersionId: (f, r) => getActiveVersionId(f, r), readActiveBuilt: readActiveBuilt(rid) },
  { method: 'GET', query: { restaurantId: rid } });
const priced = (src, delta) => { const s = JSON.parse(JSON.stringify(src)); s.items[0].price += delta; s.items[0].display.price = s.items[0].price; return s; };

// normalization: per-run ids, times and tokens
const norm = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x)
  .replace(/v-\d{10,}-[0-9a-f]{6,}/g, '<v>').replace(/"\d{9,11}\.\d{1,9}"/g, '"<t>"').replace(/\d{9,11}\.\d{1,9}/g, '<t>')
  .replace(/"token":"[^"]+"/g, '"token":"<token>"').replace(/"sourceHash":"[^"]+"/g, '"sourceHash":"<hash>"')
  .replace(/(lease|lock)[-_][A-Za-z0-9-]{8,}/g, '$1-<id>').replace(/\b[0-9a-f]{40}\b/g, '<sha>').replace(/\/[A-Za-z0-9]{20}(?=[\/"\s]|$)/g, '/<auto>').replace(/\b[0-9a-f]{20}\b/g, '<docid>'));
async function scenario(name, fn) {
  REC = [];
  const r = await fn();
  const calls = REC; REC = null;
  return { name, status: r.status, body: norm(r.body), calls: norm(calls).sort() };
}

async function seedBrand(rid) {
  await realDb.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
  await sourceRefOf(realDb, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = require('../tools/publish-version').buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'seed' });
  await publishVersion(realDb, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(realDb, rid, catalogSnapshot(rid), { captured: await getActivePointer(realDb, rid) });
}
const wipe = async () => { for (const c of await realDb.listCollections()) await realDb.recursiveDelete(c); await rtdb.ref().remove(); };

(async () => {
  const out = [];
  for (const rid of ['x_pizza', 'la_musa']) {
    await wipe(); await seedBrand(rid);
    out.push(await scenario(`${rid}: getEditableCatalog (owner)`, () => editable(rid)));
    const s1 = await save(rid, priced(await draftOf(rid), 5), 'owner', await rev(rid));
    out.push({ ...(await scenario(`${rid}: owner price save (replayed for the record)`, async () => save(rid, priced(await draftOf(rid), 1), 'owner', await rev(rid)))) });
    const s2 = await save(rid, priced(await draftOf(rid), 1), 'owner', await rev(rid));
    void s1;
    out.push(await scenario(`${rid}: owner price publish`, () => publish(rid, s2.body.token, 'owner', { ack: s2.body.diff.largeChangeSet })));
    out.push(await scenario(`${rid}: token REPLAY after the publish`, () => publish(rid, s2.body.token, 'owner', { ack: s2.body.diff.largeChangeSet })));
    const s3 = await save(rid, priced(await draftOf(rid), 1), 'staff', await rev(rid));
    out.push(await scenario(`${rid}: staff price publish`, () => publish(rid, s3.body.token, 'staff', { ack: s3.body.diff.largeChangeSet })));
    const s4 = await save(rid, priced(await draftOf(rid), 1), 'owner', await rev(rid));
    out.push(await scenario(`${rid}: owner publish WITHOUT the fiscal ack`, () => publish(rid, s4.body.token, 'owner', { ack: s4.body.diff.largeChangeSet, fiscalAck: false })));
    const big = await save(rid, priced(await draftOf(rid), 5000), 'owner', await rev(rid));
    out.push(await scenario(`${rid}: a large change, unconfirmed`, () => publish(rid, big.body.token, 'owner', { ack: [] })));
    const stale = await rev(rid);
    await save(rid, priced(await draftOf(rid), 1), 'owner', stale);
    out.push(await scenario(`${rid}: a stale save`, async () => save(rid, priced(await draftOf(rid), 1), 'owner', stale)));
    out.push(await scenario(`${rid}: an invalid source (price 0)`, async () => { const s = await draftOf(rid); s.items[0].price = 0; s.items[0].display.price = 0; return save(rid, s, 'owner', await rev(rid)); }));
    out.push(await scenario(`${rid}: dispatcher price save`, async () => save(rid, priced(await draftOf(rid), 1), 'dispatcher', await rev(rid))));
  }
  if (CAPTURE) {
    fsys.writeFileSync(GOLDEN, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`captured ${out.length} scenarios → ${GOLDEN}`);
    FINISHED = true; process.exit(0);
  }
  const golden = JSON.parse(fsys.readFileSync(GOLDEN, 'utf8'));
  assert.deepStrictEqual(out.map((o) => o.name), golden.map((g) => g.name), 'the same scenarios');
  const isKdsSyncRead = (c) => /^get (restaurants\/[^/]+\/meta\/active_version|restaurants\/[^/]+\/versions\/<v>(\/.*)?|query:restaurants\/[^/]+\/versions\/<v>\/[a-z_]+)$/.test(c);
  const declared = { body: new Set(), calls: [] };
  for (let i = 0; i < out.length; i += 1) {
    const c = out[i]; const g = golden[i];
    assert.strictEqual(c.status, g.status, `${c.name}: status`);
    const body = { ...(c.body || {}) };
    if (/price save|stale save|invalid source/.test(c.name) && c.status === 200) delete body.source;
    if (/getEditableCatalog/.test(c.name)) { delete body.renderedCategories; delete body.restaurantName; }
    assert.deepStrictEqual(body, g.body, `${c.name}: body (beyond the declared fields)`);
    // calls: golden ⊆ candidate (as a multiset), and every EXTRA call is a declared read
    const left = [...c.calls];
    for (const x of g.calls) { const j = left.indexOf(x); assert.ok(j > -1, `${c.name}: the candidate no longer makes ${x}`); left.splice(j, 1); }
    // declared: publish's KDS-sync reads; getEditableCatalog's assessment reads; the save path reads the active catalog
    // (and, on a refusal that used to precede every read, the stored draft) BEFORE deciding
    const isSourceRead = (x) => /^get restaurants\/[^/]+\/meta\/source$/.test(x);
    const allowExtra = ((/publish/.test(c.name) && c.status === 200) || /getEditableCatalog|stale save/.test(c.name)) ? left.every(isKdsSyncRead)
      : /invalid source/.test(c.name) ? left.every((x) => isKdsSyncRead(x) || isSourceRead(x)) : left.length === 0;
    assert.ok(allowExtra, `${c.name}: undeclared extra calls ${JSON.stringify(left)}`);
    if (left.length) declared.calls.push(`${c.name}: +${left.length} read(s)`);
  }
  ok(`price-only goldens (${out.length} scenarios, both brands, owner / staff / dispatcher, fiscal ack, large change, stale save, invalid source, token replay, getEditableCatalog): status + body + Firestore calls equal to the 37dcf43 capture except the DECLARED differences (${declared.calls.join('; ') || 'none'})`);
  FINISHED = true;
  console.log(`\nadd-product-golden: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('add-product-golden FAILED:', e && (e.stack || e)); process.exit(1); });
