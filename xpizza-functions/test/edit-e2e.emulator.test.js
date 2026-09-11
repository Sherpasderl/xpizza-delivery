'use strict';
// Portal 2b-1 Task 6 — THE DOGFOOD. The whole write path, end to end, against a REAL (emulated)
// Firestore: seed → edit → diff → publish → verify → rollback, on both brands, with no UI.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:edit-e2e
//
// The plan called for in-memory stubs. This uses the emulator instead, and the reason is the Task 3
// lesson: a stub that is slightly wrong is worse than no stub at all — a live snapshot getter where
// Firestore freezes one hid a real bug behind a green test. The two properties this phase most needs to
// be TRUE rather than modelled are exactly the ones a stub decides for itself:
//
//   • the updateTime CAS. Firestore evaluates `lastUpdateTime` server-side at commit. A stub asserts
//     that it does; only the emulator shows that it does.
//   • publishVersion's verify-before-flip, its lease, and the atomic pointer flip — real transactions.
//
// Everything here drives the SAME handler cores index.js calls, so a green run means the pipeline works,
// not that the harness agrees with itself.
const assert = require('assert');
const admin = require('firebase-admin');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'e2e-secret-least-32-characters-long!!';

const { editCatalogCore, encodeUpdateTime } = require('../catalog/edit-catalog-handler');
const { Timestamp } = require('firebase-admin/firestore');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { publishVersion, rollbackVersion, previewVersion } = require('../catalog/catalog-publish');
const { getActiveVersionId, readVersionDocs } = require('../catalog/catalog-firestore');
const { buildTablesFromDocs } = require('../catalog/catalog-transform');
const { assertStoreMatchesActive, assertStoreCodeParity } = require('../catalog/publish-parity');
const { sourceRefOf, sourceToBuildInputs, canonicalize } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { EXTRAS_BY_RESTAURANT } = require('../menu-pricing');

admin.initializeApp({ projectId: 'demo-xpizza' });   // FIRESTORE_EMULATOR_HOST set by emulators:exec
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// The auth helper has its own suite (with RTDB stubs); this run is Firestore-only, so the tier is
// injected here. What the e2e proves is that the tier REACHES the fiscal gate against real state.
const asRole = (role) => async () => ({ ok: true, uid: `u_${role}`, role, actor: `${role}@sherpa.hn` });
const staff = asRole('owner');

// The same live-version read index.js wires in.
async function readActiveBuilt(rid) {
  const versionId = await getActiveVersionId(db, rid);
  if (versionId == null) throw new Error(`no_active_version: ${rid}`);
  const [preview, docs] = await Promise.all([previewVersion(db, rid, versionId), readVersionDocs(db, rid, versionId)]);
  const { extras } = buildTablesFromDocs(docs.itemDocs, docs.extraDocs);
  return { built: { items: preview.items, structure: preview.structure, extras }, versionId };
}
async function readDraft(rid) {
  const snap = await sourceRefOf(db, rid).get();
  if (!snap.exists) return { source: null, updateTime: null };
  return { source: snap.data(), updateTime: encodeUpdateTime(snap.updateTime) };
}
const toPrecondition = (v) => { const [s2, ns] = String(v).split('.'); return new Timestamp(Number(s2), Number(ns)); };
const deps = { db, authorize: staff, readActiveBuilt, readDraft, publishVersion, toPrecondition };
const storeBuiltOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
// The EXTRAS DISPLAY RECORDS, kept apart from `extras` (the numeric table the parity gate compares).
// 1A Task 5: a published version has to name its options, and storeBuiltOf overwrites them.
const storeExtraRecordsOf = (src, rid) => { const i = sourceToBuildInputs(src); return buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }).extras; };

(async () => {
  for (const [rid, key, fiscal] of [['la_musa', 'dimsum_01', false], ['x_pizza', 'Margherita', true]]) {
    // ── SEED: the 2a starting state — the store, and v1 published from it ──────────────────────
    const seeded = buildSourceFromCode(rid);
    await sourceRefOf(db, rid).set(canonicalize(seeded));
    const built0 = storeBuiltOf(seeded, rid);
    const v1 = await publishVersion(db, rid, { items: built0.items, structure: built0.structure, extras: built0.extras, extraRecords: storeExtraRecordsOf(seeded, rid), source_sha: 'e2e-seed' }, {});
    assert.strictEqual(await getActiveVersionId(db, rid), v1.versionId, `${rid}: v1 is live`);
    // the 2a invariant holds at the starting state, on real data
    assertStoreCodeParity(rid, storeBuiltOf(seeded, rid), { ...buildCatalogV2(rid), extras: EXTRAS_BY_RESTAURANT[rid] || {} });

    const before = (await readDraft(rid)).updateTime;
    const oldPrice = seeded.items.find((i) => i.key === key).price;

    // ── EDIT: a real merchant edit — one price, over the sanity threshold so the ack is exercised ─
    const edited = JSON.parse(JSON.stringify(seeded));
    const it = edited.items.find((i) => i.key === key);
    it.price = oldPrice * 3; it.display.price = it.price;

    const e = await editCatalogCore(deps, { restaurantId: rid, source: edited, baseSourceUpdateTime: before }, {});
    assert.strictEqual(e.status, 200, `${rid}: edit accepted (${JSON.stringify(e.body).slice(0, 160)})`);
    assert.strictEqual(e.body.diff.changed.filter((c) => c.field === 'price').length, 1, `${rid}: the diff shows exactly the one price changed`);
    assert.strictEqual(e.body.diff.largeChangeSet.length, 1, `${rid}: and flags it as a large change (3x)`);
    assert.notStrictEqual(e.body.updateTime, before, `${rid}: the draft really moved`);
    ok(`${rid}: edit → the draft is saved and the server returns the one-change diff + a token`);

    // THE CAS, against real Firestore. This is the assertion that most needed the emulator: the stub
    // could only show that the handler PASSES a precondition, never that Firestore enforces one — and
    // the lossless encoding this required is a bug the stub actively hid, because it compared strings.
    const stalePrice = JSON.parse(JSON.stringify(seeded));
    const si = stalePrice.items.find((i) => i.key === key);
    si.price = oldPrice + 7; si.display.price = si.price;
    const lost = await editCatalogCore(deps, { restaurantId: rid, source: stalePrice, baseSourceUpdateTime: before }, {});
    assert.strictEqual(lost.status, 409, `${rid}: a second editor working from the OLD updateTime is refused`);
    assert.strictEqual(lost.body.error, 'stale_edit', `${rid}: as stale_edit`);
    const stillThere = (await readDraft(rid)).source;
    assert.strictEqual(stillThere.items.find((i) => i.key === key).price, oldPrice * 3,
      `${rid}: and the FIRST editor's draft is intact — the losing write clobbered nothing`);

    // the store now DIVERGES from code — and that is allowed here, unlike at the cutover
    assert.throws(() => assertStoreCodeParity(rid, storeBuiltOf(edited, rid), { ...buildCatalogV2(rid), extras: EXTRAS_BY_RESTAURANT[rid] || {} }), /parity_mismatch/,
      `${rid}: the store has intentionally diverged from code`);

    // ── THE GATES, against real state ─────────────────────────────────────────────────────────
    const ack = e.body.diff.largeChangeSet.map((l) => ({ key: l.key, surface: l.surface }));
    const noAck = await publishEditedCore(deps, { restaurantId: rid, token: e.body.token, fiscalAck: true }, {});
    assert.strictEqual(noAck.body.error, 'large_change_unconfirmed', `${rid}: a flagged change cannot publish unacknowledged`);
    assert.strictEqual(await getActiveVersionId(db, rid), v1.versionId, `${rid}: and the pointer did not move`);

    if (fiscal) {
      const noFiscal = await publishEditedCore(deps, { restaurantId: rid, token: e.body.token, acknowledgedChanges: ack }, {});
      assert.strictEqual(noFiscal.body.error, 'fiscal_ack_required', 'x_pizza: an owner without the acknowledgement cannot publish');
      assert.strictEqual(await getActiveVersionId(db, rid), v1.versionId, 'and the pointer did not move');
      // ...and the acknowledgement must come from an OWNER. A dispatcher sending fiscalAck:true is
      // manufacturing a signature nobody gave, on a document the SAR holds a person accountable for.
      for (const role of ['dispatcher', 'staff']) {
        const asOther = { ...deps, authorize: asRole(role) };
        const r = await publishEditedCore(asOther, { restaurantId: rid, token: e.body.token, acknowledgedChanges: ack, fiscalAck: true }, {});
        assert.strictEqual(r.body.error, 'not_owner', `x_pizza: a ${role} cannot manufacture an owner fiscal acknowledgement`);
        assert.strictEqual(await getActiveVersionId(db, rid), v1.versionId, `x_pizza: and a ${role} moved no pointer`);
      }
    } else {
      // la_musa owes no platform factura, so no tier is gated on it — an ordinary dispatcher publishes.
      const probe = await publishEditedCore({ ...deps, authorize: asRole('dispatcher') }, { restaurantId: rid, token: e.body.token, acknowledgedChanges: ack }, {});
      assert.strictEqual(probe.status, 200, 'la_musa: a dispatcher publishes without any owner tier or fiscal ack');
      assert.notStrictEqual(await getActiveVersionId(db, rid), v1.versionId, 'la_musa: and it really published');
      await rollbackVersion(db, rid, v1.versionId, {});   // back to v1 so the rest of the walk is unchanged
      assert.strictEqual(await getActiveVersionId(db, rid), v1.versionId, 'la_musa: restored for the remainder of the walk');
    }

    // Re-saving the SAME content does not invalidate the token, and that is correct rather than lax:
    // Firestore treats an identical update as a no-op and leaves updateTime alone, so the reviewed state
    // genuinely has not changed. (Worth pinning — it is real Firestore behaviour no stub would have
    // reproduced, and it is the difference between a token that expires on state and one that expires
    // on activity.)
    const resave = await editCatalogCore(deps, { restaurantId: rid, source: edited, baseSourceUpdateTime: e.body.updateTime }, {});
    assert.strictEqual(resave.status, 200, `${rid}: an identical re-save succeeds`);
    assert.strictEqual(resave.body.updateTime, e.body.updateTime, `${rid}: and does not move updateTime — Firestore skips a no-op write`);

    // A REAL second edit does invalidate it: the draft the first token was minted against no longer
    // exists, so the change that was reviewed is not the change that would land.
    const second = JSON.parse(JSON.stringify(edited));
    const it2 = second.items.find((i) => i.key === key);
    it2.price = oldPrice * 4; it2.display.price = it2.price;
    const stale = await editCatalogCore(deps, { restaurantId: rid, source: second, baseSourceUpdateTime: resave.body.updateTime }, {});
    assert.strictEqual(stale.status, 200, `${rid}: the second edit saves`);
    assert.notStrictEqual(stale.body.updateTime, e.body.updateTime, `${rid}: and DOES move updateTime (the content changed)`);
    const replayed = await publishEditedCore(deps, { restaurantId: rid, token: e.body.token, acknowledgedChanges: ack, fiscalAck: true }, {});
    assert.strictEqual(replayed.body.error, 'edit_superseded', `${rid}: the FIRST token is dead once the draft really changes`);
    assert.strictEqual(await getActiveVersionId(db, rid), v1.versionId, `${rid}: and still nothing published`);
    ok(`${rid}: the gates hold against real state — unacknowledged, ${fiscal ? 'un-fiscal-acked, ' : ''}and superseded publishes all refused, pointer unmoved`);

    // ── PUBLISH: the current token, acknowledged (and fiscally acknowledged for x_pizza) ────────
    const ack2 = stale.body.diff.largeChangeSet.map((l) => ({ key: l.key, surface: l.surface }));
    const p = await publishEditedCore(deps, { restaurantId: rid, token: stale.body.token, acknowledgedChanges: ack2, ...(fiscal ? { fiscalAck: true } : {}) }, {});
    assert.strictEqual(p.status, 200, `${rid}: publish accepted (${JSON.stringify(p.body).slice(0, 200)})`);
    const v2 = p.body.versionId;
    assert.notStrictEqual(v2, v1.versionId, `${rid}: a NEW version`);
    assert.strictEqual(await getActiveVersionId(db, rid), v2, `${rid}: and the pointer flipped to it`);

    // the edited price is what a reader now serves — the actual point of the whole phase
    const servedDocs = await readVersionDocs(db, rid, v2);
    assert.strictEqual(buildTablesFromDocs(servedDocs.itemDocs, servedDocs.extraDocs).menu[key], oldPrice * 4,
      `${rid}: the LIVE catalog now serves the edited price`);
    ok(`${rid}: publish → a new version is live and serves the edited price (no code yardstick involved)`);

    // ── VERIFY: the post-2b invariant, on real data ────────────────────────────────────────────
    const active = await readActiveBuilt(rid);
    assert.strictEqual(assertStoreMatchesActive(rid, storeBuiltOf((await readDraft(rid)).source, rid), active.built), true,
      `${rid}: --vs-active passes: the store matches what is published`);
    // and the token is single-use by construction: the pointer moved, so it can never match again
    const reused = await publishEditedCore(deps, { restaurantId: rid, token: stale.body.token, acknowledgedChanges: ack2, ...(fiscal ? { fiscalAck: true } : {}) }, {});
    assert.strictEqual(reused.body.error, 'edit_superseded', `${rid}: the token cannot be replayed after a successful publish`);
    ok(`${rid}: verify → store == active, and the spent token cannot be replayed (the pointer moved)`);

    // ── ROLLBACK: the escape hatch, exercised rather than assumed ──────────────────────────────
    await rollbackVersion(db, rid, v1.versionId, {});
    assert.strictEqual(await getActiveVersionId(db, rid), v1.versionId, `${rid}: rolled back to v1`);
    const rolledDocs = await readVersionDocs(db, rid, v1.versionId);
    assert.strictEqual(buildTablesFromDocs(rolledDocs.itemDocs, rolledDocs.extraDocs).menu[key], oldPrice,
      `${rid}: and the ORIGINAL price is live again`);
    // after a rollback the store no longer matches the active version — which is exactly the state
    // --vs-active exists to surface, and an operator needs to see it rather than a clean bill of health
    const rolledActive = await readActiveBuilt(rid);
    const draftNow = storeBuiltOf((await readDraft(rid)).source, rid);
    assert.throws(() => assertStoreMatchesActive(rid, draftNow, rolledActive.built),
      /store_vs_active_mismatch/, `${rid}: and --vs-active now REPORTS the divergence (the draft is ahead of live)`);
    ok(`${rid}: rollback → the original price is live again, and --vs-active reports the draft being ahead`);
  }

  console.log(`edit-e2e: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('edit-e2e FAILED:', e && e.stack || e); process.exit(1); });
