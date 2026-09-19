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
const { readActiveVersion: _ravUnused } = require('../catalog/identity-bootstrap');

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

  // ── 8. ORPHAN RECONCILIATION: SERVER-DERIVED PREDICATE, FENCED, ALL-OR-NOTHING ─────────────
  {
    const rid6 = 'x_pizza';
    const cur = await readActiveVersion(db, rid6);
    const orphan = await ensureIdentity(db, { rid: rid6, kind: 'dish', legacyKey: 'Churn Residue' });

    const warns = []; const realWarn = console.warn;
    console.warn = (...a) => { if (String(a[0]) === 'identity_bootstrap_orphan') warns.push(a); else realWarn(...a); };
    let rep;
    try { rep = await reconcileLegacyOrphans(db, rid6); } finally { console.warn = realWarn; }

    assert.strictEqual(rep.retired, 1, `🔴 exactly the one unserved claimant retires (got ${rep.retired})`);
    assert.strictEqual(warns.length, 1, '🔴 a retirement that is not logged is indistinguishable from a bug');
    const row = await idsColOf(db, rid6, 'dish').doc(orphan.canonical_id).get();
    assert.notStrictEqual((row.data() || {}).status, STATUS_LIVE, 'the orphan is retired');
    for (const d of cur.dishes) {
      const k = d.data.key;
      const still = (await idsColOf(db, rid6, 'dish').where('legacy_key', '==', k).where('status', '==', STATUS_LIVE).get()).docs;
      assert.strictEqual(still.length, 1, `🔴 a SERVED object's id was retired (${k}) — the pass would erase the live menu's identity`);
    }
    ok(`${rid6}: the unserved orphan retires (logged) and every served id survives — both sets derived from the version itself`);
  }

  // ── 8b. 🔴 A CERTIFIED OBJECT'S ID IS OFF-LIMITS EVEN WHEN ITS REGISTRY NAME DIFFERS ───────
  /* The predicate is "not served AND not in the active certified set", and the second half is not
     decoration. Mid-migration the registry's legacy_key for an object can differ from the name the
     version serves — that IS the state this pass exists for. Testing name membership alone retired an
     id that a live, certified object was carrying: the running menu's own identity, deleted. */
  {
    const rid8 = 'x_pizza';
    const cur = await readActiveVersion(db, rid8);
    assert.strictEqual(cur.record.identity_certified, true, 'premise — the live version is certified, so it has a certified set');
    const victim = cur.dishes[0];
    const stampedId = victim.data.display.identity_id;
    assert.ok(stampedId, 'premise — the object carries a stamp');

    // Re-key the registry row so its legacy_key no longer matches the served name, leaving the id
    // still LIVE and still the one the version has certified.
    const idRef = idsColOf(db, rid8, 'dish').doc(stampedId);
    const before8 = (await idRef.get()).data();
    await idRef.set({ ...before8, legacy_key: 'Renamed Under Migration' });

    const rep8 = await reconcileLegacyOrphans(db, rid8);
    const after8 = (await idRef.get()).data();
    assert.strictEqual(after8.status, STATUS_LIVE,
      '🔴 AN ID CARRIED BY A LIVE CERTIFIED OBJECT WAS RETIRED because its registry name differed from the served name — the running menu lost its identity');
    assert.ok(rep8.retired === 0, `🔴 nothing should have been retired here (got ${rep8.retired})`);
    await idRef.set(before8);   // restore for the cells below
    ok(`${rid8}: an id in the active CERTIFIED set survives even when its registry name no longer matches the served one`);
  }

  // ── 8c. 🔴 THE POINTER MOVING BETWEEN JUDGEMENT AND RETIREMENT REFUSES ─────────────────────
  {
    const rid8c = 'x_pizza';
    const cur = await readActiveVersion(db, rid8c);
    const doomed = await ensureIdentity(db, { rid: rid8c, kind: 'dish', legacyKey: 'Residue Two' });
    const orig = db.runTransaction.bind(db);
    let moved = false;
    const racing = {
      collection: (c) => db.collection(c),
      runTransaction: async (fn, o) => {
        // The decision was made from a snapshot of the whole version; move the pointer before it acts.
        if (!moved) { moved = true; await pointerOf(rid8c).set({ version: 'v-somewhere-else', at: new Date(), generation: cur.generation }); }
        return orig(fn, o);
      },
    };
    await assert.rejects(() => reconcileLegacyOrphans(racing, rid8c), /identity_reconcile_pointer_moved/,
      '🔴 a retirement committed against an activation it was not judged under');
    assert.ok(moved, 'premise — the pointer really moved mid-flight');
    const still = await idsColOf(db, rid8c, 'dish').doc(doomed.canonical_id).get();
    assert.strictEqual((still.data() || {}).status, STATUS_LIVE, '🔴 …and it retired anyway');
    await pointerOf(rid8c).set({ version: cur.versionId, at: new Date(), generation: cur.generation });
    ok(`${rid8c}: the pointer moving between judgement and retirement refuses, and nothing is retired`);
  }

  // ── 8d. 🔴 EVERY KIND IS VALIDATED BEFORE ANY RETIREMENT COMMITS ───────────────────────────
  /* The emptiness check used to run per kind inside the loop, so dish retirements committed and THEN
     an empty extras set threw — a half-done reconciliation, which is the worst outcome available. */
  {
    const rid8d = 'la_musa';
    const v = await readActiveVersion(db, rid8d);
    const extrasCol = vrefOf(rid8d, v.versionId).collection('extras');
    const extrasDocs = (await extrasCol.get()).docs;
    assert.ok(extrasDocs.length > 0 && v.dishes.length > 0, 'premise — this version has both kinds');
    const saved = extrasDocs.map((d) => ({ id: d.id, data: d.data() }));
    const liveBefore = (await idsColOf(db, rid8d, 'dish').where('status', '==', STATUS_LIVE).get()).docs.length;

    for (const d of saved) await extrasCol.doc(d.id).delete();       // the version now serves NO extras
    await assert.rejects(() => reconcileLegacyOrphans(db, rid8d), /identity_reconcile_no_served_set/,
      '🔴 an empty served set for one kind was accepted');
    const liveAfter = (await idsColOf(db, rid8d, 'dish').where('status', '==', STATUS_LIVE).get()).docs.length;
    assert.strictEqual(liveAfter, liveBefore,
      `🔴 DISH retirements committed before the EXTRAS set was found empty (${liveBefore} → ${liveAfter}) — a half-done reconciliation`);
    for (const d of saved) await extrasCol.doc(d.id).set(d.data);     // restore
    ok(`${rid8d}: an empty set for ANY kind refuses before a single retirement commits (${liveBefore} live dish ids untouched)`);
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

  /* A fresh, registered, UNCERTIFIED pointer-named version — the state each of the cells below needs
     in order to reach the stamping transaction at all. (Cell 9's predecessor taught that lesson: a
     guard cell that refuses earlier for an unrelated reason proves nothing about the guard.) */
  async function freshUncertifiedVersion(rid) {
    const cur = await readActiveVersion(db, rid);
    const { input } = buildPublishCandidate(rid, { activeVersionId: cur.versionId }, { source_sha: `fresh-${Date.now()}` });
    const pub = await publishVersion(db, rid, input, { expected: { activeVersionId: cur.versionId } });
    const v = await readActiveVersion(db, rid);
    assert.strictEqual(v.record.identity_certified, undefined, 'premise — the fresh version is uncertified');
    return v;
  }

  // ── 13. 🔴 A SECOND LIVE ID CLAIMING A SERVED NAME REFUSES — EXACTLY ONE, OR NONE AT ALL ───
  /* The key row names ONE id and is structurally blind to a second live id claiming the same name, so
     trusting it certified a fork: keys/A→X with both X and Y live-claiming A went through clean.
     §3.0's rule is "each live object → exactly one live id; a conflict refuses". */
  {
    const rid13 = 'x_pizza';
    const v = await freshUncertifiedVersion(rid13);
    const victim = v.dishes[0];
    const name = victim.data.key;
    const before = await snapshotVersion(rid13, v.versionId);
    await idsColOf(db, rid13, 'dish').doc('SECONDLIVE1').set({ legacy_key: name, status: STATUS_LIVE, kind: 'dish', created_at: 'x' });

    await assert.rejects(() => bootstrapIdentityStamps(db, rid13), /identity_bootstrap_ambiguous/,
      '🔴 a name claimed by TWO live ids was certified — bootstrap froze a fork into the version');
    assert.deepStrictEqual(await snapshotVersion(rid13, v.versionId), before,
      '🔴 …and it must leave the whole version untouched, not stamp the objects it managed to resolve first');
    await idsColOf(db, rid13, 'dish').doc('SECONDLIVE1').delete();
    ok(`${rid13}: a second LIVE claimant of a served name refuses by name and stamps nothing`);
  }

  // ── 14. 🔴 AN EXISTING ACTIVATION RECORD IS NEVER UPGRADED ─────────────────────────────────
  /* A legacy pre-P1 live version carries no record at all, so a record already present means a P1
     activation wrote it — pending, or abandoned. Overwriting it with `activated` would let legacy
     migration manufacture activation authority for a candidate that was explicitly abandoned. There
     is no safe way to guess which may be overwritten, so none may be. */
  {
    const rid14 = 'x_pizza';
    for (const status of ['pending', 'abandoned']) {
      const v = await freshUncertifiedVersion(rid14);
      await vrefOf(rid14, v.versionId).update({ identity_activation: { status, base_generation: 0, attempt: 'prior' } });
      const before = await snapshotVersion(rid14, v.versionId);

      await assert.rejects(() => bootstrapIdentityStamps(db, rid14), /identity_bootstrap_activation_present/,
        `🔴 bootstrap upgraded an existing ${status} record to activated — legacy migration must never manufacture activation authority`);
      assert.deepStrictEqual(await snapshotVersion(rid14, v.versionId), before,
        `🔴 …and the whole version must be unchanged after refusing a ${status} record`);
    }
    ok(`${rid14}: an existing pending OR abandoned activation record refuses, and the version is untouched in both`);
  }

  // ── 15. 🔴 AN ID RETIRED BETWEEN THE RESOLVE AND THE TRANSACTION REFUSES ───────────────────
  /* Liveness used to be checked only OUTSIDE the transaction, which left open the exact window the
     check exists to close: an id retired in between was still written as a certified identity. The
     authoritative check is the one that runs at the instant of the write. */
  {
    const rid15 = 'x_pizza';
    const v = await freshUncertifiedVersion(rid15);
    const before = await snapshotVersion(rid15, v.versionId);
    const name = v.dishes[0].data.key;
    const enc = Buffer.from(String(name), 'utf8').toString('base64url');
    const keyRow = await db.collection('restaurants').doc(rid15).collection('identity').doc('dish').collection('keys').doc(enc).get();
    const id = (keyRow.data() || {}).canonical_id;
    assert.ok(id, 'premise — the object resolves before the race');

    const orig = db.runTransaction.bind(db);
    let retired = false;
    const racing = {
      collection: (c) => db.collection(c),
      runTransaction: async (fn, o) => {
        // Resolve has happened; the stamping transaction has not. Retire the id in that window.
        if (!retired) { retired = true; await retireIdentity(db, { rid: rid15, kind: 'dish', canonicalId: id }); }
        return orig(fn, o);
      },
    };
    await assert.rejects(() => bootstrapIdentityStamps(racing, rid15), /identity_bootstrap_id_not_live|identity_bootstrap_ambiguous/,
      '🔴 an id retired after the resolve was still stamped as a certified identity');
    assert.ok(retired, 'premise — the retirement really landed inside the window');
    assert.deepStrictEqual(await snapshotVersion(rid15, v.versionId), before, '🔴 …and nothing was stamped');
    ok(`${rid15}: an id retired between the resolve and the write refuses — liveness is decided at the instant of the write`);
  }

  // ── 16. 🔴 ONE LIVE CLAIMANT, BUT NOT THE ONE THE REVERSE ROW NAMES ───────────────────────
  /* Cell 13 stages TWO live claimants, so the count check refuses first and the disagreement branch
     never runs — which is exactly why that branch survived its mutant. This is the state that
     isolates it: the reverse row still points at X, X no longer claims the name, and a DIFFERENT live
     id Y does. Trusting the key row would certify X — an id that does not claim this object at all —
     and the registry, not the reverse row, is the authority on who claims a name. */
  {
    const rid16 = 'x_pizza';
    const v = await freshUncertifiedVersion(rid16);
    const before = await snapshotVersion(rid16, v.versionId);
    const name = v.dishes[0].data.key;
    const enc = Buffer.from(String(name), 'utf8').toString('base64url');
    const keysCol = db.collection('restaurants').doc(rid16).collection('identity').doc('dish').collection('keys');
    const staleId = (await keysCol.doc(enc).get()).data().canonical_id;

    // X stops claiming the name (re-keyed elsewhere, still live); Y starts claiming it; keys/name→X stays.
    const xRef = idsColOf(db, rid16, 'dish').doc(staleId);
    const xBefore = (await xRef.get()).data();
    await xRef.set({ ...xBefore, legacy_key: 'Moved Elsewhere' });
    await idsColOf(db, rid16, 'dish').doc('OTHERLIVE1').set({ legacy_key: name, status: STATUS_LIVE, kind: 'dish', created_at: 'x' });

    const claimants = (await idsColOf(db, rid16, 'dish').where('legacy_key', '==', name).where('status', '==', STATUS_LIVE).get()).docs;
    assert.strictEqual(claimants.length, 1, 'premise — exactly ONE live claimant, so the count check cannot be what refuses');
    assert.notStrictEqual(claimants[0].id, staleId, 'premise — and it is not the id the reverse row names');

    await assert.rejects(() => bootstrapIdentityStamps(db, rid16), /identity_bootstrap_ambiguous/,
      '🔴 the reverse row outranked the registry — bootstrap certified an id that does not claim this object');
    assert.deepStrictEqual(await snapshotVersion(rid16, v.versionId), before, '🔴 …and it stamped nothing');

    await xRef.set(xBefore);
    await idsColOf(db, rid16, 'dish').doc('OTHERLIVE1').delete();
    ok(`${rid16}: a sole live claimant that DISAGREES with the reverse row refuses — the registry outranks the key row`);
  }

  FINISHED = true;
  console.log(`d4p1-bootstrap(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 BOOTSTRAP (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
