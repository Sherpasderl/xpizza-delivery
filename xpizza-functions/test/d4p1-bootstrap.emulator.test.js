'use strict';
// Portal 1D · D4-P1 Slice B — THE BOOTSTRAP STAMPING PASS, AGAINST A REAL REGISTRY.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:d4p1-bootstrap
//
// 🔴 THE CENTREPIECE IS THE WHOLE-VERSION GOLDEN (cell 2). Bootstrap performs the ONLY UPDATE to a
// version document anywhere in the system — versions are otherwise create-not-exists, and that is the
// immutable history plane the two-plane design rests on. An allowlist check ("did it write only the
// fields I expected?") proves nothing about the fields I did not think to list, which is precisely how
// a served field escaped the content hash once already. So the version is captured WHOLE before and
// after, and the DIFF must be exactly the additive identity set — every other byte of every document,
// content_hash and menu_hash and extras_hash and seq and structure included, unchanged.
const assert = require('assert');
const admin = require('firebase-admin');
const { buildPublishCandidate } = require('../tools/publish-version');

admin.initializeApp({ projectId: 'demo-xpizza' });
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4p1-bootstrap(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const { publishVersion, writeVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { bootstrapIdentityStamps, reconcileLegacyOrphans, readActiveVersion } = require('../catalog/identity-bootstrap');
const { ensureIdentity, retireIdentity, idsColOf, STATUS_LIVE } = require('../catalog/identity-registry');

const vrefOf = (rid, v) => db.collection('restaurants').doc(rid).collection('versions').doc(v);
const pointerOf = (rid) => db.collection('restaurants').doc(rid).collection('meta').doc('active_version');

/* The WHOLE version: its record and every document under it, as plain data. */
async function snapshotVersion(rid, versionId) {
  const vref = vrefOf(rid, versionId);
  const [rec, items, extras, meta] = await Promise.all([
    vref.get(), vref.collection('menu_items').get(), vref.collection('extras').get(), vref.collection('meta').get(),
  ]);
  const col = (s) => Object.fromEntries(s.docs.map((d) => [d.id, d.data()]));
  return JSON.parse(JSON.stringify({ record: rec.data(), menu_items: col(items), extras: col(extras), meta: col(meta) }));
}
/* Every path whose value differs, so the assertion can be "exactly these and nothing else". */
function diffPaths(a, b, path = '', out = []) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = path ? `${path}.${k}` : k;
    const va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
    const bothObj = va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va) && !Array.isArray(vb);
    if (bothObj) diffPaths(va, vb, p, out);
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push(p);
  }
  return out;
}

async function seed(rid, sha) {
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: sha });
  const res = await publishVersion(db, rid, input, { expected: { activeVersionId: null } });
  await backfillIdentities(db, rid, catalogSnapshot(rid));
  return res;
}

(async () => {
  const rid = 'x_pizza';
  await seed(rid, 'd4p1-bootstrap');
  const active = await readActiveVersion(db, rid);
  assert.ok(active.dishes.length > 0 && active.extras.length > 0, 'premise — a real live version with dishes and extras');
  assert.strictEqual(active.record.identity_certified, undefined, 'premise — it starts UNcertified (pre-P1 shape)');

  const before = await snapshotVersion(rid, active.versionId);

  // ── 1. EVERY LIVE OBJECT IS STAMPED WITH THE ID THE REGISTRY ALREADY HOLDS ──────────────────
  const r = await bootstrapIdentityStamps(db, rid);
  assert.strictEqual(r.stamped, true, `bootstrap ran: ${JSON.stringify(r)}`);
  assert.strictEqual(r.dishes, active.dishes.length, 'every dish accounted for');
  assert.strictEqual(r.extras, active.extras.length, 'every EXTRA too — the sibling of the pair');
  const after = await snapshotVersion(rid, active.versionId);
  for (const [col, kind] of [['menu_items', 'dish'], ['extras', 'extra']]) {
    for (const [docId, doc] of Object.entries(after[col])) {
      const id = doc.display && doc.display.identity_id;
      assert.ok(id, `🔴 ${col}/${docId} was not stamped`);
      const idRow = await idsColOf(db, rid, kind).doc(id).get();
      assert.strictEqual((idRow.data() || {}).legacy_key, doc.key,
        `🔴 ${col}/${docId}: the stamp is not the registry's id for this object's own key`);
    }
  }
  assert.strictEqual(after.record.identity_certified, true, 'the version is marked certified');
  assert.deepStrictEqual(
    { status: after.record.identity_activation.status, base: after.record.identity_activation.base_generation },
    { status: 'activated', base: active.generation },
    'and carries an activation record proving it was LIVE, at the captured generation');
  ok(`${r.dishes} dishes + ${r.extras} extras stamped from the registry; version certified and marked activated`);

  // ── 2. 🔴 THE WHOLE-VERSION GOLDEN — THE ONLY UPDATE, AND IT IS PURELY ADDITIVE ─────────────
  {
    const expected = new Set();
    for (const docId of Object.keys(before.menu_items)) expected.add(`menu_items.${docId}.display.identity_id`);
    for (const docId of Object.keys(before.extras)) expected.add(`extras.${docId}.display.identity_id`);
    expected.add('record.identity_certified');
    expected.add('record.identity_activation');
    const actual = diffPaths(before, after).sort();
    assert.deepStrictEqual(actual, [...expected].sort(),
      `🔴 bootstrap changed something outside the identity set — this is the one write that may touch an immutable version, and it must be provably narrow`);
    // Named explicitly as well, because these are the values a silent change would corrupt.
    for (const f of ['content_hash', 'menu_hash', 'extras_hash', 'seq', 'version', 'schema_version', 'item_count', 'extra_count', 'source_sha']) {
      assert.deepStrictEqual(after.record[f], before.record[f], `🔴 record.${f} moved`);
    }
    assert.deepStrictEqual(after.meta, before.meta, '🔴 the structure document moved');
    for (const docId of Object.keys(before.menu_items)) {
      const b = before.menu_items[docId], a = { ...after.menu_items[docId] };
      a.display = { ...a.display }; delete a.display.identity_id;
      assert.deepStrictEqual(a, b, `🔴 menu_items/${docId} changed beyond its stamp`);
    }
    ok(`the version is byte-identical apart from ${actual.length} additive identity fields — content/menu/extras hashes, seq and structure all unmoved`);
  }

  // ── 3. IDEMPOTENT — A RE-RUN IS A NO-OP, NOT A REWRITE ─────────────────────────────────────
  {
    const again = await bootstrapIdentityStamps(db, rid);
    assert.strictEqual(again.already, true, '🔴 a re-run re-stamped a certified version');
    assert.strictEqual(again.stamped, false, '…and reported no write');
    assert.deepStrictEqual(await snapshotVersion(rid, active.versionId), after, '🔴 the re-run changed the version');
    ok('a re-run over a certified version is a true no-op — the whole version is unchanged');
  }

  // ── 4. IT MINTS NOTHING: AN UNREGISTERED OBJECT REFUSES ────────────────────────────────────
  {
    const rid2 = 'la_musa';
    const { input } = buildPublishCandidate(rid2, { activeVersionId: null }, { source_sha: 'no-backfill' });
    await publishVersion(db, rid2, input, { expected: { activeVersionId: null } });
    /* 🔴 PUBLISHING ALREADY REGISTERS. The pre-P1 post-flip writer (catalog-publish.js:378) mints an
       identity for every live key after the flip, so "publish and skip the backfill" does NOT produce
       an unregistered object — my first version of this cell asserted a rejection that could never
       happen and passed nothing. The state has to be staged directly: take one object's registry rows
       away and leave the version serving it. (This gets easier to reach, not harder, once Slice E
       removes that post-flip writer for P1.) */
    const v2 = await readActiveVersion(db, rid2);
    const missing = v2.dishes[0].data.key;
    const encKey = Buffer.from(String(missing), 'utf8').toString('base64url');
    const idCol = db.collection('restaurants').doc(rid2).collection('identity').doc('dish');
    const kr = await idCol.collection('keys').doc(encKey).get();
    assert.ok(kr.exists, 'premise — the publish DID register it, which is why the staging is needed');
    await idCol.collection('ids').doc(kr.data().canonical_id).delete();
    await idCol.collection('keys').doc(encKey).delete();

    await assert.rejects(() => bootstrapIdentityStamps(db, rid2), /identity_bootstrap_unregistered/,
      '🔴 bootstrap minted for an object the registry does not know — it must refuse and send a human to the D1 backfill');
    const v = await readActiveVersion(db, rid2);
    assert.strictEqual(v.record.identity_certified, undefined, '…and certified nothing on the way out');
    ok(`${rid2}: an unregistered object refuses by name and stamps nothing`);
  }

  // ── 5. 🔴 A SURVIVING KEY ROW IS NOT PROOF THE ID IS LIVE ──────────────────────────────────
  /* lookupByLegacyKeys trusts the reverse row without reading the id behind it. If bootstrap trusted
     it too, a RETIRED id whose key row happened to survive would be stamped onto a live object and
     become its certified identity — the reservation broken at the moment of certification. */
  {
    const rid3 = 'la_musa';
    await backfillIdentities(db, rid3, catalogSnapshot(rid3));
    const v = await readActiveVersion(db, rid3);
    const victim = v.dishes[0];
    const key = victim.data.key;
    const keyRow = await db.collection('restaurants').doc(rid3).collection('identity').doc('dish')
      .collection('keys').doc(Buffer.from(String(key), 'utf8').toString('base64url')).get();
    const id = (keyRow.data() || {}).canonical_id;
    assert.ok(id, 'premise — the object is registered');
    // Retire the id but PUT THE KEY ROW BACK: exactly the stale-reverse-row shape.
    await retireIdentity(db, { rid: rid3, kind: 'dish', canonicalId: id });
    await db.collection('restaurants').doc(rid3).collection('identity').doc('dish')
      .collection('keys').doc(Buffer.from(String(key), 'utf8').toString('base64url')).set({ canonical_id: id, kind: 'dish' });

    await assert.rejects(() => bootstrapIdentityStamps(db, rid3), /identity_bootstrap_id_not_live/,
      '🔴 a RETIRED id behind a surviving key row was accepted as certification');
    ok(`${rid3}: a retired id behind a stale reverse row refuses — the key row alone is not proof of liveness`);
  }

  // ── 6. THE FENCE: THE POINTER MOVING UNDER THE PASS REFUSES ────────────────────────────────
  {
    const rid4 = 'x_pizza';
    // A second version exists and the pointer is swung to it after the pass has read the first.
    const { input } = buildPublishCandidate(rid4, { activeVersionId: active.versionId }, { source_sha: 'second' });
    const second = await publishVersion(db, rid4, input, { expected: { activeVersionId: active.versionId } });
    const secondId = second.versionId || second.version;
    // The new version is uncertified, so a pass CAN run on it — but move the pointer mid-flight.
    const orig = db.runTransaction.bind(db);
    let raced = false;
    const racing = {
      collection: (c) => db.collection(c),
      runTransaction: async (fn, o) => {
        if (!raced) { raced = true; await pointerOf(rid4).set({ version: active.versionId, at: new Date() }); }
        return orig(fn, o);
      },
    };
    await assert.rejects(() => bootstrapIdentityStamps(racing, rid4), /identity_bootstrap_pointer_moved/,
      '🔴 the pass stamped a version that stopped being live while it worked');
    assert.ok(raced, 'premise — the pointer really moved between the read and the write');
    const stranded = await vrefOf(rid4, secondId).get();
    assert.strictEqual((stranded.data() || {}).identity_certified, undefined, '…and certified nothing');
    // put the pointer back for the cells below
    await pointerOf(rid4).set({ version: secondId, at: new Date() });
    ok(`${rid4}: a pointer that moves under the pass refuses and writes nothing`);
  }

  // ── 7. BOOTSTRAP MATERIALIZES AN ACTIVATION RECORD ONLY ONTO THE POINTER-NAMED VERSION ─────
  /* v7's fail-closed rule. Retention is not proof of activation — writeVersion creates the version
     record BEFORE the flip, so a retained version may never have been live, and treating retention as
     proof would make a never-lived price set rollback-eligible. The pointer is the only evidence.
     🔴 THE PROPERTY IS ABOUT WHAT BOOTSTRAP ADDS, NOT ABOUT WHAT EXISTS. A version that WAS the
     pointer-named one when an earlier pass ran keeps its record, and must — that record is exactly
     what makes it a legitimate rollback target. My first version of this cell asserted that no
     retained version may carry a record at all, and failed against a version that had honestly earned
     one. So: take the set of versions carrying a record BEFORE this run and after, and require the
     only addition to be the version the pointer names. */
  {
    const rid5 = 'x_pizza';
    const cur = await readActiveVersion(db, rid5);
    const withRecord = async () => {
      const all = await db.collection('restaurants').doc(rid5).collection('versions').get();
      return all.docs.filter((d) => (d.data() || {}).identity_activation !== undefined).map((d) => d.id).sort();
    };
    const recordsBefore = await withRecord();
    assert.ok(!recordsBefore.includes(cur.versionId), 'premise — the live version has no record yet (its bootstrap was refused by the fence above)');

    const r7 = await bootstrapIdentityStamps(db, rid5);
    assert.strictEqual(r7.stamped, true, `the pointer-named version is stamped: ${JSON.stringify(r7)}`);

    const recordsAfter = await withRecord();
    const added = recordsAfter.filter((v) => !recordsBefore.includes(v));
    assert.deepStrictEqual(added, [cur.versionId],
      `🔴 bootstrap materialized an activation record onto ${JSON.stringify(added)} — only the pointer-named version may get one, or retention becomes proof of activation`);

    /* 🔴 AND THE SCENARIO THE RULE EXISTS FOR, STAGED EXACTLY. writeVersion creates the version
       record BEFORE the flip (:310), so a crash or a failed CAS leaves a COMPLETE, RETAINED, never
       activated version — v7's example is a pre-P1 price-only candidate whose flip failed. Retention
       enumerates it like any other. It must come out of bootstrap with no record and therefore no
       rollback eligibility; a run that gave it one would let a rollback activate prices that were
       never live. Created here by calling writeVersion and NOT flipping, which is what the failure
       actually looks like. */
    const { input: orphanInput } = buildPublishCandidate(rid5, { activeVersionId: cur.versionId }, { source_sha: 'never-activated' });
    const neverLive = await writeVersion(db, rid5, orphanInput, admin.firestore.Timestamp.now());
    const neverLiveId = neverLive.versionId || neverLive.version || neverLive;
    const ptr = await pointerOf(rid5).get();
    assert.notStrictEqual((ptr.data() || {}).version, neverLiveId, 'premise — the pointer never named it');

    const r7b = await bootstrapIdentityStamps(db, rid5);
    assert.strictEqual(r7b.already, true, 'the live version is already certified, so this run is a no-op');
    const orphanRec = await vrefOf(rid5, neverLiveId).get();
    assert.strictEqual((orphanRec.data() || {}).identity_activation, undefined,
      '🔴 A NEVER-ACTIVATED VERSION WAS MARKED ACTIVATED — retention would have become proof of activation, and a rollback could activate prices that were never live');
    assert.strictEqual((orphanRec.data() || {}).identity_certified, undefined, '…and it was not certified either');
    const total = (await db.collection('restaurants').doc(rid5).collection('versions').get()).docs.length;
    ok(`bootstrap records exactly the pointer-named version; a retained NEVER-ACTIVATED version stays unprovable (${total} versions, ${(await withRecord()).length} with records)`);
  }

  // ── 8. LEGACY-ORPHAN RECONCILIATION IS DELIBERATE, LOGGED, AND REFUSES A BLIND SWEEP ───────
  {
    const rid6 = 'x_pizza';
    const cur = await readActiveVersion(db, rid6);
    const served = { dish: cur.dishes.map((d) => d.data.key), extra: cur.extras.map((e) => e.data.key) };
    const orphan = await ensureIdentity(db, { rid: rid6, kind: 'dish', legacyKey: 'Churn Residue' });

    const warns = []; const realWarn = console.warn;
    console.warn = (...a) => { if (String(a[0]) === 'identity_bootstrap_orphan') warns.push(a); else realWarn(...a); };
    let rep;
    try { rep = await reconcileLegacyOrphans(db, rid6, { servedKeys: served }); } finally { console.warn = realWarn; }

    assert.strictEqual(rep.retired, 1, `🔴 exactly the one unserved claimant retires (got ${rep.retired})`);
    assert.strictEqual(warns.length, 1, '🔴 a retirement that is not logged is indistinguishable from a bug');
    const row = await idsColOf(db, rid6, 'dish').doc(orphan.canonical_id).get();
    assert.notStrictEqual((row.data() || {}).status, STATUS_LIVE, 'the orphan is retired');
    for (const k of served.dish) {
      const still = (await idsColOf(db, rid6, 'dish').where('legacy_key', '==', k).where('status', '==', STATUS_LIVE).get()).docs;
      assert.strictEqual(still.length, 1, `🔴 a SERVED object's id was retired (${k}) — the pass would erase the live menu's identity`);
    }
    // 🔴 An empty served set must refuse rather than treat every live id as an orphan.
    await assert.rejects(() => reconcileLegacyOrphans(db, rid6, { servedKeys: { dish: [], extra: [] } }),
      /identity_reconcile_no_served_set/,
      '🔴 an empty served set retired the whole registry instead of refusing');
    ok(`${rid6}: the unserved orphan retires (logged), every served id survives, and an empty served set REFUSES`);
  }

  // ── 9. THE GENERATION FENCE BITES INDEPENDENTLY OF THE POINTER ─────────────────────────────
  /* Cell 6 moves the pointer to a DIFFERENT version, which any version check would catch. This is the
     other half: the pointer still names the SAME version, but the activation generation has advanced
     underneath — which is exactly what a rollback or a re-activation of that version does. Without
     comparing the generation separately, a stale pass would write its stamps over an activation it
     never saw, and these are not the same failure.
     🔴 ON A FRESHLY PUBLISHED x_pizza VERSION, deliberately. My first attempt used la_musa and never
     reached the transaction at all: cell 5 retires a la_musa id, so the pass refused at the liveness
     check and the cell "passed" its rejection for entirely the wrong reason. A fence cell has to get
     as far as the fence. */
  {
    const rid9 = 'x_pizza';
    const cur9 = await readActiveVersion(db, rid9);
    const { input: in9 } = buildPublishCandidate(rid9, { activeVersionId: cur9.versionId }, { source_sha: 'gen-fence' });
    const pub9 = await publishVersion(db, rid9, in9, { expected: { activeVersionId: cur9.versionId } });
    const v9id = pub9.versionId || pub9.version;
    const p9 = pointerOf(rid9);
    await p9.set({ version: v9id, at: new Date(), generation: 3 });

    const read = await readActiveVersion(db, rid9);
    assert.strictEqual(read.versionId, v9id, 'premise — the fresh version is live');
    assert.strictEqual(read.generation, 3, 'premise — the pass captures generation 3');
    assert.strictEqual(read.record.identity_certified, undefined, 'premise — it is uncertified, so the pass will reach its transaction');

    const orig = db.runTransaction.bind(db);
    let bumped = false;
    const racing = {
      collection: (c) => db.collection(c),
      runTransaction: async (fn, o) => {
        // SAME version, NEWER generation — the shape a rollback or re-activation leaves behind.
        if (!bumped) { bumped = true; await p9.set({ version: v9id, at: new Date(), generation: 4 }); }
        return orig(fn, o);
      },
    };
    await assert.rejects(() => bootstrapIdentityStamps(racing, rid9), /identity_bootstrap_generation_moved/,
      '🔴 the generation advanced under the pass and it stamped anyway — the pointer alone does not fence a re-activation of the SAME version');
    assert.ok(bumped, 'premise — the generation really moved mid-flight, and the pass reached its transaction');
    const after9 = await vrefOf(rid9, v9id).get();
    assert.strictEqual((after9.data() || {}).identity_certified, undefined, '…and it certified nothing');

    // SENSITIVITY: with the generation left alone, the very same pass on the very same version stamps.
    await p9.set({ version: v9id, at: new Date(), generation: 4 });
    const okRun = await bootstrapIdentityStamps(db, rid9);
    assert.strictEqual(okRun.stamped, true, 'non-vacuity: an unmoved generation stamps normally');
    assert.strictEqual(okRun.generation, 4, '…at the generation it captured');
    /* 🔴 AND THE RECORD MUST CARRY THAT GENERATION, NOT A PLACEHOLDER. base_generation is what binds
       this activation to the generation it was decided at; every other cell in this file runs at
       generation 0, where a hardcoded 0 is indistinguishable from the captured value. This is the one
       place the difference is observable. */
    const rec9 = await vrefOf(rid9, v9id).get();
    assert.strictEqual((rec9.data() || {}).identity_activation.base_generation, 4,
      '🔴 the activation record was written with a generation it did not capture — the fence it anchors means nothing');
    ok(`${rid9}: the same version at a NEWER generation refuses; unmoved, the same pass stamps — the generation is fenced separately from the pointer`);
  }

  FINISHED = true;
  console.log(`d4p1-bootstrap(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 BOOTSTRAP (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
