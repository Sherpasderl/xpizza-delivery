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
require('./_emulator-required')('firestore');   // refuse if the emulator host vars are unset (would hit real infrastructure, or a foreign emulator)

const assert = require('assert');
const admin = require('firebase-admin');
const { buildPublishCandidate } = require('../tools/publish-version');
const { sourceRefOf, canonicalize, sourceToBuildInputs } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { buildSourceFromCode } = require('../tools/seed-source-store');

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
/* 🔴 EVERY VERSION STATES THE BASELINE IT WAS BUILT AGAINST (D-2 gate fix). writeVersion no longer
   accepts an absent baseline: a version with no activation record cannot be proven to have been live,
   and retention is not proof. These fixtures read the live pair rather than inventing one, because a
   baseline chosen to satisfy the check is a fixture asserting against a world that does not exist. */
const baselineOf = (d, r) => require('../catalog/catalog-firestore').getActivePointer(d, r);

const vrefOf = (rid, v) => db.collection('restaurants').doc(rid).collection('versions').doc(v);
const pointerOf = (rid) => db.collection('restaurants').doc(rid).collection('meta').doc('active_version');

/* The WHOLE version: its record and every document under it, as plain data. */
/* The WHOLE stored source, as plain data — the counterpart to snapshotVersion. Bootstrap writes BOTH
   in one transaction, so both need the same before/after treatment or half the write is unevidenced. */
async function snapshotSource(rid) {
  const snap = await sourceRefOf(db, rid).get();
  return JSON.parse(JSON.stringify(snap.data()));
}

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

/* 🔴 BUILD THE CANDIDATE FROM THE STORED SOURCE, as production does. buildPublishCandidate derives
   from the CODE catalog, which carries no identity stamps — so once bootstrap has certified a version,
   a code-derived candidate is short of every id and the partition law refuses it. That is the suite
   being unrepresentative, not the law being wrong: real publishes come from the source via
   sourceToBuildInputs, which emits `display` verbatim and therefore carries the stamps. */
async function candidateFromSource(rid) {
  const src = (await sourceRefOf(db, rid).get()).data();
  const inputs = sourceToBuildInputs(src);
  const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable });
  return { items: built.items, structure: built.structure, extras: inputs.extras,
    extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
}

async function seed(rid, sha) {
  /* The source is seeded too: bootstrap now enriches it in the same transaction as the version
     stamping, and it refuses outright if the stored draft does not contain what the active version
     serves. A suite that published without a source would be testing a state the cutover cannot be in. */
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: sha });
  const res = await publishVersion(db, rid, input, { expected: { activeVersionId: null } });
  /* 🔴 THE BASELINE IS A PRE-P1 VERSION, SO IT CARRIES NO ACTIVATION RECORD. Slice D writes a
     pending record on every version it publishes, and bootstrap refuses — correctly — to touch a
     version that already has one: a record present means a P1 activation wrote it, and overwriting it
     could manufacture activation authority for a candidate that was abandoned. At the real cutover
     the live version predates all of that and has no record. Publishing one here and then stripping
     the record is how this fixture models that, rather than weakening a guard whose reasoning holds.
     🔴 SEPARATELY REPORTED: after D ships, a publish that lands BEFORE bootstrap runs leaves a version
     with a record and no stamps, which bootstrap then refuses — a real cutover-ordering hazard that
     belongs in the runbook, not in a fixture. */
  await db.collection('restaurants').doc(rid).collection('versions').doc(res.versionId)
    .update({ identity_activation: admin.firestore.FieldValue.delete() });
  await backfillIdentities(db, rid, catalogSnapshot(rid));
  return res;
}

/* 🔴 MODEL A PRE-P1 VERSION. Slice D writes a pending activation record on every version it
   publishes; bootstrap refuses — correctly — to touch a version that already carries one, because a
   record present means a P1 activation wrote it and overwriting could manufacture authority for a
   candidate that was abandoned. At the real cutover the live version predates all of that. Any cell
   here that publishes a baseline and then bootstraps it must therefore strip the record, or it is
   testing a sequence the cutover cannot be in. */
/* 🔴 MAKE A VERSION PRE-P1 SHAPED — WHICH IS WHAT THIS HELPER'S NAME ALWAYS CLAIMED AND ONLY HALF DID.
   It used to delete the activation record and nothing else, because that WAS the whole difference: a
   published version carried no stamps and no `identity_certified`, since nothing supplied writeVersion
   a stamp map. Slice D gave the map a producer, so a publish now certifies — and a helper that removed
   one of the three markers would leave cells reasoning about a version that is pre-P1 in name only.
   Constructing the legacy shape EXPLICITLY is also more honest than the old route, which obtained it as
   a side effect of the very gap Slice D closed: these cells are about bootstrap meeting a pre-cutover
   version, and this now says that in one place instead of depending on publish staying broken. */
const asPreP1 = async (rid, versionId) => {
  const vref = db.collection('restaurants').doc(rid).collection('versions').doc(versionId);
  const strip = async (col) => {
    const snap = await vref.collection(col).get();
    await Promise.all((snap.docs || []).map((d) => {
      const display = (d.data() || {}).display;
      if (!display || display.identity_id === undefined) return null;
      const { identity_id, ...rest } = display;   // eslint-disable-line no-unused-vars
      return d.ref.update({ display: rest });
    }).filter(Boolean));
  };
  await Promise.all([strip('menu_items'), strip('extras')]);
  await vref.update({
    identity_activation: admin.firestore.FieldValue.delete(),
    identity_certified: admin.firestore.FieldValue.delete(),
  });
};

(async () => {
  const rid = 'x_pizza';
  await seed(rid, 'd4p1-bootstrap');
  const active = await readActiveVersion(db, rid);
  assert.ok(active.dishes.length > 0 && active.extras.length > 0, 'premise — a real live version with dishes and extras');
  assert.strictEqual(active.record.identity_certified, undefined, 'premise — it starts UNcertified (pre-P1 shape)');

  const before = await snapshotVersion(rid, active.versionId);
  const srcBefore = await snapshotSource(rid);

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

  // ── 2b. 🔴 THE WHOLE-SOURCE GOLDEN — THE OTHER HALF OF THE ONE WRITE ──────────────────────
  /* Bootstrap writes the version AND the source in one transaction, so goldening only the version
     leaves half the write unevidenced — and the source half is what a merchant's next edit is built
     from. Same treatment, different instrument: diffPaths compares ARRAYS as whole values (correct for
     the version, whose objects are keyed maps), and the source holds items/extras as arrays, so it
     would only ever report "items changed". Stripping the stamps and comparing the WHOLE object is
     stronger than enumerating paths anyway: it says "identical apart from the stamps" by construction
     rather than by a list I remembered to write. */
  {
    const srcAfter = await snapshotSource(rid);
    const stripStamps = (src) => {
      const out = JSON.parse(JSON.stringify(src));
      for (const rows of [out.items, out.extras]) {
        for (const o of (Array.isArray(rows) ? rows : [])) {
          if (o && o.display) delete o.display.identity_id;
        }
      }
      return out;
    };
    assert.deepStrictEqual(stripStamps(srcAfter), stripStamps(srcBefore),
      '🔴 bootstrap changed the source beyond the stamps — this write lands on the merchant\'s own draft');
    assert.ok(!(srcBefore.items || []).some((o) => o && o.display && o.display.identity_id !== undefined),
      'premise — the source carried no stamps before');

    // …and every matched object actually GOT one, or "identical apart from the stamps" is vacuous.
    let stamped = 0;
    for (const [rows, kind] of [[srcAfter.items, 'items'], [srcAfter.extras, 'extras']]) {
      for (const o of (Array.isArray(rows) ? rows : [])) {
        assert.ok(o.display && o.display.identity_id, `🔴 source ${kind} ${o.key} was not stamped`);
        stamped += 1;
      }
    }
    assert.strictEqual(stamped, (srcAfter.items || []).length + (srcAfter.extras || []).length, 'every object stamped');
    ok(`the SOURCE is identical apart from the stamps, and all ${stamped} objects carry one`);
  }

  // ── 3. IDEMPOTENT — A RE-RUN IS A NO-OP, NOT A REWRITE ─────────────────────────────────────
  {
    /* 🔴 THE BASELINE IS CAPTURED BEFORE THE FIRST RE-RUN. It used to be captured AFTER one, so the
       comparison was read-after-a-re-run against read-after-another-re-run: a first re-run that
       corrupted the source and then settled passed cleanly. The line above it was worse — it compared
       snapshotSource() against snapshotSource(), which is a read against itself and can only ever be
       true. Neither noticed a re-run that rewrote the draft, which is the single thing this cell
       exists to catch. d4p1b-26 is the proof: it corrupts the source on the re-run path with the same
       value every time, so it SURVIVES the old ordering (both post-re-run reads agree) and dies only
       on this one. */
    const srcIdem = await snapshotSource(rid);
    assert.ok((srcIdem.items || []).some((o) => o && o.display && o.display.identity_id),
      'premise — the baseline is the ENRICHED source, captured before any re-run');

    const again = await bootstrapIdentityStamps(db, rid);
    assert.strictEqual(again.already, true, '🔴 a re-run re-stamped a certified version');
    assert.strictEqual(again.stamped, false, '…and reported no write');
    assert.deepStrictEqual(await snapshotVersion(rid, active.versionId), after, '🔴 the re-run changed the version');
    assert.deepStrictEqual(await snapshotSource(rid), srcIdem,
      '🔴 a re-run rewrote the SOURCE — idempotence has to cover both halves of the write, or the merchant\'s draft churns on every pass');

    // …and a SECOND re-run is still a no-op against the same pre-re-run baseline, not merely stable.
    await bootstrapIdentityStamps(db, rid);
    assert.deepStrictEqual(await snapshotVersion(rid, active.versionId), after, '🔴 the second re-run changed the version');
    assert.deepStrictEqual(await snapshotSource(rid), srcIdem, '🔴 the second re-run rewrote the SOURCE');
    ok('a re-run over a certified version is a true no-op — the whole version AND the whole source are unchanged, measured against the source as it stood BEFORE any re-run');
  }

  // ── 4. IT MINTS NOTHING: AN UNREGISTERED OBJECT REFUSES ────────────────────────────────────
  {
    const rid2 = 'la_musa';
    const { input } = buildPublishCandidate(rid2, { activeVersionId: null }, { source_sha: 'no-backfill' });
    const pub2 = await publishVersion(db, rid2, input, { expected: { activeVersionId: null } });
    await asPreP1(rid2, pub2.versionId);
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
    const second = await publishVersion(db, rid4, { ...(await candidateFromSource(rid4)), source_sha: 'second' }, { expected: { activeVersionId: active.versionId } });
    await asPreP1(rid4, second.versionId);
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
    const neverLive = await writeVersion(db, rid5, { ...(await candidateFromSource(rid5)), source_sha: 'never-activated', baseline: await baselineOf(db, rid5) }, admin.firestore.Timestamp.now());
    const neverLiveId = neverLive.versionId || neverLive.version || neverLive;
    const ptr = await pointerOf(rid5).get();
    assert.notStrictEqual((ptr.data() || {}).version, neverLiveId, 'premise — the pointer never named it');

    const r7b = await bootstrapIdentityStamps(db, rid5);
    assert.strictEqual(r7b.already, true, 'the live version is already certified, so this run is a no-op');
    const orphanRec = await vrefOf(rid5, neverLiveId).get();
    /* 🔴 THE ASSERTION MOVED FROM "no record" TO "a PENDING record", and that is a strengthening. It
       used to be absent because writeVersion omitted the record when no baseline was supplied — which
       was itself the D-2 defect: a version with no record at all was creatable, and the flip's
       predicate then treated absent as permitted. writeVersion now requires a baseline, so this
       staged-and-never-flipped version says what it actually is: `pending`. That is strictly more
       informative than silence, and it is the exact state the rollback rule now refuses — a candidate
       that was never activated cannot be rolled back TO. What must never happen is `activated`. */
    const orphanActivation = (orphanRec.data() || {}).identity_activation || {};
    assert.strictEqual(orphanActivation.status, 'pending',
      `🔴 a staged, never-flipped version does not say it is pending (${JSON.stringify(orphanActivation.status)}) — the record is what distinguishes "was live" from "was written"`);
    assert.notStrictEqual(orphanActivation.status, 'activated',
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
    /* 🔴 ON x_pizza, BECAUSE RECONCILE NOW REQUIRES A CERTIFIED VERSION. la_musa's active version is
       left uncertified by the refusal cells above, so running this there refused on the uncertified
       guard instead — a cell that never reaches the check it is named after. */
    const rid8d = 'x_pizza';
    const v = await readActiveVersion(db, rid8d);
    assert.strictEqual(v.record.identity_certified, true, 'premise — a certified version, so the served-set check is reachable');
    const extrasCol = vrefOf(rid8d, v.versionId).collection('extras');
    const extrasDocs = (await extrasCol.get()).docs;
    assert.ok(extrasDocs.length > 0 && v.dishes.length > 0, 'premise — this version has both kinds');
    const saved = extrasDocs.map((d) => ({ id: d.id, data: d.data() }));

    /* 🔴 A DISH ORPHAN THAT WOULD OTHERWISE BE RETIRED. Without one, this cell proved nothing: every
       la_musa dish name is served, so no dish is eligible and the count is unchanged whether the
       ordering is right or wrong. The cell has to contain something the wrong ordering would destroy. */
    const doomed8d = await ensureIdentity(db, { rid: rid8d, kind: 'dish', legacyKey: 'Unserved Before Extras' });
    const eligible = await idsColOf(db, rid8d, 'dish').doc(doomed8d.canonical_id).get();
    assert.strictEqual((eligible.data() || {}).status, STATUS_LIVE, 'premise — the staged dish orphan is live and unserved');

    for (const d of saved) await extrasCol.doc(d.id).delete();       // the version now serves NO extras
    await assert.rejects(() => reconcileLegacyOrphans(db, rid8d), /identity_reconcile_no_served_set/,
      '🔴 an empty served set for one kind was accepted');
    const after8d = await idsColOf(db, rid8d, 'dish').doc(doomed8d.canonical_id).get();
    assert.strictEqual((after8d.data() || {}).status, STATUS_LIVE,
      '🔴 DISH retirements committed before the EXTRAS set was found empty — a half-done reconciliation, and this orphan is the evidence');
    for (const d of saved) await extrasCol.doc(d.id).set(d.data);     // restore
    ok(`${rid8d}: an empty set for ANY kind refuses before a single retirement commits — a staged, eligible dish orphan survives`);
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
    const pub9 = await publishVersion(db, rid9, { ...(await candidateFromSource(rid9)), source_sha: 'gen-fence' }, { expected: { activeVersionId: cur9.versionId } });
    await asPreP1(rid9, pub9.versionId);
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
    /* 🔴 ORDER MATTERS, AND GETTING IT WRONG LOOKS LIKE A BUG IN THE LAW. To reach an uncertified
       baseline from a certified one the publish must first be LAWFUL — a draft carrying exactly the
       active certified ids — and the version it produces is uncertified, because C has no writer that
       stamps a new one. Only THEN may the source stamps be stripped, leaving source and active both
       unstamped: a coherent pre-cutover state for the cells that test bootstrap's own guards.
       Stripping first and publishing a code-derived draft refuses as unaccounted, which is the law
       working correctly against an incoherent setup. */
    const candidate = cur.record.identity_certified === true
      ? { ...(await candidateFromSource(rid)), source_sha: `fresh-${Date.now()}` }
      : { ...buildPublishCandidate(rid, { activeVersionId: cur.versionId }, { source_sha: `fresh-${Date.now()}` }).input };
    const pub = await publishVersion(db, rid, candidate, { expected: { activeVersionId: cur.versionId } });

    /* 🔴 THE OLD ROUTE HERE WAS THE BUG ITSELF. This used to publish and stop, because a lawful publish
       from a certified baseline produced an UNCERTIFIED version — which is precisely the defect Slice D
       closed (bootstrap certifies v1, publish decertifies, and the publish after that is refused as
       unaccounted: a one-publish lockout). The helper's own comment said so and treated it as a
       limitation to work around. So the version is now made pre-P1 shaped EXPLICITLY, by the same
       helper every other legacy fixture uses, instead of being handed that shape by a broken writer.
       These cells are about bootstrap meeting a PRE-CUTOVER version; constructing that state directly
       says what they mean, and it no longer depends on publish staying wrong to stay green. */
    await asPreP1(rid, pub.versionId);

    const src = (await sourceRefOf(db, rid).get()).data();
    const strip = (rows) => (Array.isArray(rows) ? rows : []).map((o) => {
      if (!o || !o.display || o.display.identity_id === undefined) return o;
      const { identity_id, ...rest } = o.display;   // eslint-disable-line no-unused-vars
      return { ...o, display: rest };
    });
    await sourceRefOf(db, rid).update({ items: strip(src.items), extras: strip(src.extras) });

    const v = await readActiveVersion(db, rid);
    assert.strictEqual(v.record.identity_certified, undefined, 'premise — the fresh version is uncertified');
    return v;
  }

  // ── 13. 🔴 A SECOND LIVE ID CLAIMING A SERVED NAME REFUSES — EXACTLY ONE, OR NONE AT ALL ───
  /* The key row names ONE id and is structurally blind to a second live id claiming the same name, so
     trusting it certified a fork: keys/A→X with both X and Y live-claiming A went through clean.
     §3.0's rule is "each live object → exactly one live id; a conflict refuses".
     🔴 THE TWO CLAIMANTS ARE ORDERED DELIBERATELY, and that is the whole point of this staging. The
     first version added a second id beside a RANDOMLY minted one, so whether the count guard or the
     disagreement guard refused depended on how the two ids happened to sort — and with the count guard
     removed the disagreement branch refused instead, on a different message, so the mutant died for
     the wrong reason. Here the reverse row names the claimant that sorts FIRST, so every other guard
     is satisfied and the COUNT is the only thing standing between this state and a certified fork. */
  {
    const rid13 = 'x_pizza';
    const v = await freshUncertifiedVersion(rid13);
    const victim = v.dishes[0];
    const name = victim.data.key;
    const enc = Buffer.from(String(name), 'utf8').toString('base64url');
    const keysCol = db.collection('restaurants').doc(rid13).collection('identity').doc('dish').collection('keys');
    const before = await snapshotVersion(rid13, v.versionId);
    const originalId = (await keysCol.doc(enc).get()).data().canonical_id;
    const origRow = (await idsColOf(db, rid13, 'dish').doc(originalId).get()).data();

    const FIRST = 'AAAAFIRST01', SECOND = 'ZZZZSECOND1';
    await idsColOf(db, rid13, 'dish').doc(originalId).set({ ...origRow, legacy_key: 'Parked For Cell 13' });
    await idsColOf(db, rid13, 'dish').doc(FIRST).set({ legacy_key: name, status: STATUS_LIVE, kind: 'dish', created_at: 'x' });
    await idsColOf(db, rid13, 'dish').doc(SECOND).set({ legacy_key: name, status: STATUS_LIVE, kind: 'dish', created_at: 'x' });
    await keysCol.doc(enc).set({ canonical_id: FIRST, kind: 'dish' });

    const claimants = (await idsColOf(db, rid13, 'dish').where('legacy_key', '==', name).where('status', '==', STATUS_LIVE).get())
      .docs.map((d) => d.id).sort();
    assert.deepStrictEqual(claimants, [FIRST, SECOND], 'premise — exactly these two claim the name');
    assert.strictEqual(claimants[0], FIRST, 'premise — the reverse row names the one that sorts FIRST, so only the COUNT can refuse');

    await assert.rejects(() => bootstrapIdentityStamps(db, rid13), /all claim it live/,
      '🔴 a name claimed by TWO live ids was certified — bootstrap froze a fork into the version');
    assert.deepStrictEqual(await snapshotVersion(rid13, v.versionId), before,
      '🔴 …and it must leave the whole version untouched, not stamp the objects it managed to resolve first');

    await idsColOf(db, rid13, 'dish').doc(FIRST).delete();
    await idsColOf(db, rid13, 'dish').doc(SECOND).delete();
    await idsColOf(db, rid13, 'dish').doc(originalId).set(origRow);
    await keysCol.doc(enc).set({ canonical_id: originalId, kind: 'dish' });
    ok(`${rid13}: two LIVE claimants of a served name refuse on the COUNT — every other guard satisfied, and nothing stamped`);
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
    await assert.rejects(() => bootstrapIdentityStamps(racing, rid15), /identity_bootstrap_id_not_live/,
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

    await assert.rejects(() => bootstrapIdentityStamps(db, rid16), /identity_bootstrap_key_disagrees/,
      '🔴 the reverse row outranked the registry — bootstrap certified an id that does not claim this object');
    assert.deepStrictEqual(await snapshotVersion(rid16, v.versionId), before, '🔴 …and it stamped nothing');

    await xRef.set(xBefore);
    await idsColOf(db, rid16, 'dish').doc('OTHERLIVE1').delete();
    ok(`${rid16}: a sole live claimant that DISAGREES with the reverse row refuses — the registry outranks the key row`);
  }

  // ── 17. 🔴 THE REVERSE ROW REPOINTED BETWEEN THE RESOLVE AND THE WRITE ────────────────────
  /* The id being stamped is read from keys/{name} OUTSIDE the transaction. Nothing re-read that row
     inside it, so the row could be repointed in between and the pass would still stamp the id it had
     resolved — the version certifying X while the registry's reverse row says Y. The live-claimant set
     cannot catch this on its own: X really IS the sole live claimant. What moved is the row naming it,
     so the row is what has to be re-read. */
  {
    const rid17 = 'x_pizza';
    const v = await freshUncertifiedVersion(rid17);
    const before = await snapshotVersion(rid17, v.versionId);
    const name = v.dishes[0].data.key;
    const enc = Buffer.from(String(name), 'utf8').toString('base64url');
    const keysCol = db.collection('restaurants').doc(rid17).collection('identity').doc('dish').collection('keys');
    const resolvedId = (await keysCol.doc(enc).get()).data().canonical_id;

    const orig = db.runTransaction.bind(db);
    let flipped = false;
    const racing = {
      collection: (c) => db.collection(c),
      runTransaction: async (fn, o) => {
        // Resolve has happened; the stamping tx has not. Repoint the reverse row, leaving the
        // original id as the name's sole LIVE claimant so only the row disagrees.
        if (!flipped) { flipped = true; await keysCol.doc(enc).set({ canonical_id: 'REPOINTED1', kind: 'dish' }); }
        return orig(fn, o);
      },
    };
    await assert.rejects(() => bootstrapIdentityStamps(racing, rid17), /identity_bootstrap_key_row_moved/,
      '🔴 the reverse row was repointed after the resolve and the pass stamped the id it had already read — the version and the registry now disagree about this object');
    assert.ok(flipped, 'premise — the row really moved inside the window');
    assert.deepStrictEqual(await snapshotVersion(rid17, v.versionId), before, '🔴 …and it stamped nothing');
    await keysCol.doc(enc).set({ canonical_id: resolvedId, kind: 'dish' });
    ok(`${rid17}: a reverse row repointed between the resolve and the write refuses — both sides are re-read at the instant of the write`);
  }

  // ── 18. 🔴 RECONCILE REFUSES AN UNCERTIFIED VERSION ───────────────────────────────────────
  /* The predicate's certified half is only meaningful once the version HAS a certified set. Run
     against an uncertified version it is empty, and the predicate quietly collapses back to name
     membership alone — the weaker rule this round removed. */
  {
    const rid18 = 'x_pizza';
    const v = await freshUncertifiedVersion(rid18);
    const canary = await ensureIdentity(db, { rid: rid18, kind: 'dish', legacyKey: 'Uncertified Canary' });
    await assert.rejects(() => reconcileLegacyOrphans(db, rid18), /identity_reconcile_uncertified/,
      '🔴 reconcile ran against an uncertified version, where the certified half of the predicate is empty');
    const row = await idsColOf(db, rid18, 'dish').doc(canary.canonical_id).get();
    assert.strictEqual((row.data() || {}).status, STATUS_LIVE, '🔴 …and it retired something on the way out');
    ok(`${rid18}: reconcile refuses an uncertified version and retires nothing`);
  }

  // ── 19. 🔴 AN UNKEYABLE SERVED OBJECT THROWS IN RECONCILE TOO ─────────────────────────────
  /* The stamping pass refuses an unkeyable object; reconcile dropped it with a .filter(Boolean). The
     two stances were not merely inconsistent — the lenient one fails in the direction that costs an
     identity: a served object that yields no key is simply absent from the served set, so the live id
     behind it reads as an orphan and is retired. */
  {
    const rid19 = 'x_pizza';
    const v = await freshUncertifiedVersion(rid19);
    const stampRep = await bootstrapIdentityStamps(db, rid19);
    assert.strictEqual(stampRep.stamped, true, 'premise — a certified version, so reconcile gets past cell 18\'s guard');

    const cur = await readActiveVersion(db, rid19);
    const victim = cur.dishes[0];
    const docRef = vrefOf(rid19, cur.versionId).collection('menu_items').doc(victim.id);
    const saved = (await docRef.get()).data();
    const canary = await ensureIdentity(db, { rid: rid19, kind: 'dish', legacyKey: 'Unkeyable Canary' });

    // A served object the key resolver cannot key at all.
    const { key: _dropped, ...noKey } = saved;
    await docRef.set(noKey);

    await assert.rejects(() => reconcileLegacyOrphans(db, rid19), /identity_reconcile_unkeyable/,
      '🔴 an unkeyable served object was silently dropped from the served set — the id behind it would read as an orphan');
    const row = await idsColOf(db, rid19, 'dish').doc(canary.canonical_id).get();
    assert.strictEqual((row.data() || {}).status, STATUS_LIVE, '🔴 …and it retired before refusing');
    await docRef.set(saved);
    ok(`${rid19}: an unkeyable served object refuses in reconcile, as it already did in the stamping pass, with zero retirements`);
  }

  // ── 20. 🔴 A REVERSE ROW DELETED IN THE WINDOW IS NOT "NO OBJECTION" ──────────────────────
  /* Cell 17 REPOINTS the row, so the missing-row branch never runs there. Deleting it is a different
     state and an easy one to get wrong: with no row there is nothing to disagree with, so a check
     written as "the row must not name someone else" would wave it through and certify an id that
     nothing in the registry names. Absent is a refusal, not a pass. */
  {
    const rid20 = 'x_pizza';
    const v = await freshUncertifiedVersion(rid20);
    const before = await snapshotVersion(rid20, v.versionId);
    const name = v.dishes[0].data.key;
    const enc = Buffer.from(String(name), 'utf8').toString('base64url');
    const keysCol = db.collection('restaurants').doc(rid20).collection('identity').doc('dish').collection('keys');
    const saved = (await keysCol.doc(enc).get()).data();

    const orig = db.runTransaction.bind(db);
    let deleted = false;
    const racing = {
      collection: (c) => db.collection(c),
      runTransaction: async (fn, o) => {
        if (!deleted) { deleted = true; await keysCol.doc(enc).delete(); }
        return orig(fn, o);
      },
    };
    await assert.rejects(() => bootstrapIdentityStamps(racing, rid20), /identity_bootstrap_key_row_missing/,
      '🔴 the reverse row was GONE at the moment of the write and the pass certified the id anyway — nothing in the registry names it');
    assert.ok(deleted, 'premise — the row really was deleted inside the window');
    assert.deepStrictEqual(await snapshotVersion(rid20, v.versionId), before, '🔴 …and it stamped nothing');
    await keysCol.doc(enc).set(saved);
    ok(`${rid20}: a reverse row DELETED between the resolve and the write refuses — absent is a refusal, not silence`);
  }

  // ── 21. 🔴 AN ID RETIRED WITHOUT ITS REVERSE ROW BEING REMOVED ────────────────────────────
  /* Cell 15 retires through retireIdentity, which also DELETES keys/{name} — so the key-row check
     catches that case and the in-tx claimant check is never the guard that refuses. This isolates it:
     the id is marked retired IN PLACE and its reverse row is left exactly as it was, so the row still
     names it, the row still agrees, and the ONLY thing that can notice is the live-claimant query
     inside the transaction. That state is not contrived — anything that retires a row without
     completing its reverse-row cleanup leaves precisely this, and it is the shape where a version
     would otherwise certify a retired id whose paperwork still looks right. */
  {
    const rid21 = 'x_pizza';
    const v = await freshUncertifiedVersion(rid21);
    const before = await snapshotVersion(rid21, v.versionId);
    const name = v.dishes[0].data.key;
    const enc = Buffer.from(String(name), 'utf8').toString('base64url');
    const keysCol = db.collection('restaurants').doc(rid21).collection('identity').doc('dish').collection('keys');
    const id = (await keysCol.doc(enc).get()).data().canonical_id;
    const idRef = idsColOf(db, rid21, 'dish').doc(id);
    const idBefore = (await idRef.get()).data();

    const orig = db.runTransaction.bind(db);
    let retired = false;
    const racing = {
      collection: (c) => db.collection(c),
      runTransaction: async (fn, o) => {
        // Retired in place; the reverse row is deliberately LEFT, so it still names this id.
        if (!retired) { retired = true; await idRef.set({ ...idBefore, status: 'retired', retired_at: 'x' }); }
        return orig(fn, o);
      },
    };
    await assert.rejects(() => bootstrapIdentityStamps(racing, rid21), /identity_bootstrap_id_not_live/,
      '🔴 an id retired in place — reverse row untouched and still agreeing — was stamped as a certified identity; only the in-tx claimant query can see this');
    assert.ok(retired, 'premise — the retirement landed inside the window');
    const rowAfter = await keysCol.doc(enc).get();
    assert.strictEqual((rowAfter.data() || {}).canonical_id, id, 'premise — the reverse row was left intact, so the key-row check could NOT be what refused');
    assert.deepStrictEqual(await snapshotVersion(rid21, v.versionId), before, '🔴 …and it stamped nothing');
    await idRef.set(idBefore);
    ok(`${rid21}: an id retired WITHOUT its reverse row being cleaned up refuses — isolating the in-tx claimant query as the only guard that can see it`);
  }

  // ── 🔴 THE CUTOVER RUNS: bootstrap → publish → publish, EVERY VERSION CERTIFIED ───────────
  /* 🔴 THIS CELL ASSERTED THE OPPOSITE UNTIL SLICE D, AND THE INVERSION IS THE FIX RATHER THAN A
     FLIP-FLOP — the old reasoning is kept below so the history reads as what it is.
     WHAT IT USED TO PIN, verbatim in intent: "C validates the partition but has no writer that stamps
     a NEW version — that is D's activation writer — so the first publish after bootstrap produces an
     UNCERTIFIED version, which empties A while the source still carries its stamps. The next publish
     then refuses as carried_unknown." That was an accurate description of the code, and it was pinned
     as an accepted limitation of a slice that was never meant to deploy alone.
     🔴 IT WAS ALSO A PRODUCTION LOCKOUT, which is what nobody had said out loud. Read it as the
     merchant experiences it: bootstrap certifies v1 and stamps the source; their first publish
     succeeds and quietly decertifies the menu; their SECOND publish is REFUSED, and so is every one
     after it, because the draft carries ids no certified version has. One publish after cutover, then
     locked out of their own menu — and stripping the stamps from the source to escape is refused by
     the same law. A green cell asserted the first half of that and called it a limitation.
     Slice D gave the stamp map a producer, so this now asserts the behaviour the cutover actually
     needs: every publish after bootstrap is certified, and the ids are STABLE across the sequence —
     which is the property that makes rename-stability mean anything later.
     🔴 IT SETS UP ITS OWN STATE rather than depending on where the suite left off. The first version
     of this cell branched on whatever the previous cells happened to leave behind and took the
     "nothing to test" path — a cell that reports a pass for doing nothing is worse than no cell. */
  {
    const ridL = 'x_pizza';
    const before = await readActiveVersion(db, ridL);
    if (before.record.identity_certified !== true) {
      const rep = await bootstrapIdentityStamps(db, ridL);
      assert.ok(rep.stamped || rep.already, `premise — a certified, source-stamped baseline: ${JSON.stringify(rep)}`);
    }
    const cur = await readActiveVersion(db, ridL);
    assert.strictEqual(cur.record.identity_certified, true, 'premise — the active version is certified');
    const srcNow = (await sourceRefOf(db, ridL).get()).data();
    assert.ok((srcNow.items || []).some((o) => o && o.display && o.display.identity_id),
      'premise — and the SOURCE carries stamps, so a draft built from it is lawful against A');

    /* The id map BEFORE any publish, by key. Every publish below must preserve it exactly: a stamped
       version whose ids drift is worse than an unstamped one, because the drift is now certified. */
    const idsByKey = (v) => {
      const m = {};
      for (const o of [...v.dishes, ...v.extras]) m[o.data.key] = o.data.display && o.data.display.identity_id;
      return m;
    };
    const atBootstrap = idsByKey(cur);
    assert.ok(Object.keys(atBootstrap).length > 0 && Object.values(atBootstrap).every(Boolean),
      'premise — bootstrap stamped every object, so there is a full map to hold the publishes against');

    /* THREE lawful publishes in a row — the sequence nothing has ever driven end to end. One publish
       proved nothing before: the lockout only appeared on the SECOND, which is exactly why it survived
       three slices of green cells. */
    let prev = cur.versionId;
    for (const tag of ['cutover-1', 'cutover-2', 'cutover-3']) {
      await publishVersion(db, ridL, { ...(await candidateFromSource(ridL)), source_sha: tag },
        { expected: { activeVersionId: prev } });
      const v = await readActiveVersion(db, ridL);
      assert.notStrictEqual(v.versionId, prev, `${tag}: premise — a new version really was activated`);
      assert.strictEqual(v.record.identity_certified, true,
        `🔴 ${tag} produced an UNCERTIFIED version — A is now empty, the next publish refuses as carried_unknown, and the merchant is locked out of their own menu`);
      assert.deepStrictEqual(idsByKey(v), atBootstrap,
        `🔴 ${tag} changed an object's certified id — the stamps drifted across a publish, and a drifting id that is CERTIFIED is worse than no stamp at all`);
      prev = v.versionId;
    }
    ok('the cutover runs: bootstrap → publish → publish → publish, every version certified and every id stable across all three');
  }

  // ── 🔴 THE CONSTRUCTED PRE-P1 SHAPE IS THE REAL ONE — ASSERTED, NOT ASSUMED ────────────────
  /* Six cells below reach their subject through `asPreP1`, which HAND-BUILDS a pre-cutover version by
     stripping three things off a published one. Before Slice D that shape came for free, because
     publish never certified; now it is constructed, and a constructed fixture whose fidelity is
     asserted nowhere is the class that has bitten this programme three times — most recently a
     reservation seeded with `status` where production writes `state`. So the construction is compared,
     once, against a version that was genuinely published BEFORE bootstrap ever ran.
     🔴 COMPARED ON SHAPE, NOT VALUES, and that is not a weakening. Version id, seq, created_at,
     source_sha and the hashes differ between any two publishes for reasons that have nothing to do
     with identity. What must match is which FIELDS exist — because every way this fixture could lie
     is a field left behind or a field missing, not a different timestamp. */
  {
    const ridE = 'x_pizza';
    const shapeOf = (snap) => {
      const keys = (o) => Object.keys(o || {}).sort();
      const docsShape = (col) => {
        const out = new Set();
        for (const d of Object.values(col || {})) {
          out.add(keys(d).join(','));
          out.add(`display:${keys(d.display).join(',')}`);
        }
        return [...out].sort();
      };
      return { record: keys(snap.record), menu_items: docsShape(snap.menu_items), extras: docsShape(snap.extras) };
    };

    const cur = await readActiveVersion(db, ridE);
    await publishVersion(db, ridE, { ...(await candidateFromSource(ridE)), source_sha: 'fidelity' },
      { expected: { activeVersionId: cur.versionId } });
    const fresh = await readActiveVersion(db, ridE);
    assert.strictEqual(fresh.record.identity_certified, true, 'premise — a genuinely certified, post-bootstrap version to strip');
    const certifiedShape = shapeOf(await snapshotVersion(ridE, fresh.versionId));

    await asPreP1(ridE, fresh.versionId);

    /* 🔴 SENSITIVITY FIRST, AND IT HAS TO LIVE INSIDE THIS CELL. I tried proving this comparison can
       fail by half-breaking asPreP1 and re-running the suite: it DID fail, but at cell 6, which
       reaches the incomplete fixture first — so the run said nothing about whether THIS cell can see
       the difference. A cell whose sensitivity depends on no earlier cell failing first is a cell
       whose sensitivity is unmeasured.
       So the failure is staged here: put ONE marker back, which is exactly what a future incomplete
       asPreP1 would leave, and the comparison below must reject it. */
    await vrefOf(ridE, fresh.versionId).update({ identity_certified: true });
    assert.notDeepStrictEqual(shapeOf(await snapshotVersion(ridE, fresh.versionId)), shapeOf(before),
      '🔴 SENSITIVITY: a version with the discriminator LEFT BEHIND compares equal to a genuine pre-cutover one — this cell cannot see an incomplete asPreP1, which is the only thing it exists to catch');
    await vrefOf(ridE, fresh.versionId).update({ identity_certified: admin.firestore.FieldValue.delete() });

    const constructed = await snapshotVersion(ridE, fresh.versionId);

    /* `before` is the version as it stood BEFORE bootstrap ran in cell 1 — a real pre-cutover
       published version, not a reconstruction. */
    assert.deepStrictEqual(shapeOf(constructed), shapeOf(before),
      '🔴 the hand-built pre-P1 shape is NOT what a genuine pre-bootstrap version looks like — six cells below reason about a state that never existed in production');

    // …and the three markers are named explicitly, so the cell states its property rather than only comparing.
    assert.strictEqual(constructed.record.identity_certified, undefined, 'no discriminator');
    assert.strictEqual(constructed.record.identity_activation, undefined, 'no activation record');
    for (const col of ['menu_items', 'extras']) {
      for (const [id, d] of Object.entries(constructed[col])) {
        assert.strictEqual(d.display && d.display.identity_id, undefined, `🔴 ${col}/${id} kept its stamp`);
      }
    }

    /* 🔴 SENSITIVITY, WITHOUT WHICH THE EQUALITY ABOVE PROVES NOTHING. If shapeOf were too coarse to
       notice a stamp, it would report every version equal to every other and the comparison would pass
       for any fixture at all. The CERTIFIED version it was stripped from must NOT match. */
    assert.notDeepStrictEqual(certifiedShape, shapeOf(before),
      '🔴 SENSITIVITY: a certified version has the same shape as a pre-cutover one — the comparison above cannot tell them apart and asserts nothing');
    ok('the hand-built pre-P1 shape is field-for-field what a genuine pre-bootstrap version has, and a certified one is distinguishable from both');
  }

  // ── 🔴 A PENDING UNPUBLISHED RENAME REFUSES THE WHOLE PASS ───────────────────────────────
  /* The cutover hazard. Unpublished ADDITIONS are harmless — no id, unidentified, they mint. But an
     object RENAMED or REMOVED in the draft and not yet published has no counterpart under its active
     name, so it receives no stamp — and that active id is then neither carried nor declared deleted,
     so every subsequent publish refuses as unaccounted, with no escape before the portal deploy.
     The pass refuses WHOLE rather than stamping the version and leaving the source behind, so that
     "A non-empty ⇔ source stamped" holds as a fact rather than as a usual case. */
  {
    /* 🔴 ON x_pizza, NOT la_musa. An earlier cell retires a la_musa id, so bootstrap there refuses at
       the LIVENESS check before it ever reaches the divergence check — a cell that never reaches the
       guard it is named after. freshUncertifiedVersion gives a clean uncertified baseline with an
       unstamped source, which is the pre-cutover shape this guard exists for. */
    const ridD = 'x_pizza';
    const v = await freshUncertifiedVersion(ridD);
    const srcPre = await snapshotSource(ridD);
    const verPre = await snapshotVersion(ridD, v.versionId);

    // A pending rename: the draft renames one object the active version still serves.
    const renamed = JSON.parse(JSON.stringify(srcPre));
    const victim = renamed.items[0];
    const oldKey = victim.key;
    victim.key = `${oldKey}_renamed_pending`;
    if (victim.display) victim.display.id = victim.key;
    renamed.structure = { ...renamed.structure, item_order: renamed.structure.item_order.map((k) => (k === oldKey ? victim.key : k)) };
    await sourceRefOf(db, ridD).set(renamed);

    await assert.rejects(() => bootstrapIdentityStamps(db, ridD), /identity_bootstrap_draft_divergent/,
      '🔴 bootstrap stamped a version whose objects the draft no longer contains — every later publish would refuse as unaccounted');
    const after = await readActiveVersion(db, ridD);
    assert.strictEqual(after.record.identity_certified, undefined,
      '🔴 …and it certified the version anyway, leaving A non-empty over an unstamped source');
    assert.deepStrictEqual(await snapshotVersion(ridD, v.versionId), verPre, '🔴 the version was touched');
    const srcNow = await snapshotSource(ridD);
    assert.deepStrictEqual(srcNow, renamed, '🔴 the source was touched');
    await sourceRefOf(db, ridD).set(srcPre);   // restore for anything after
    ok(`${ridD}: a pending unpublished rename refuses the WHOLE pass — neither the version nor the source is touched`);
  }

  // ── 🔴 THE SOURCE MOVING UNDER THE PASS REFUSES ──────────────────────────────────────────
  /* The source is read before the transaction and re-read inside it; a merchant saving in that window
     must abort the pass rather than have their draft enriched over. Without the revision check the
     pass would write items/extras computed from the OLD draft straight over the new one. */
  {
    const ridR = 'x_pizza';
    const v = await freshUncertifiedVersion(ridR);
    {
      const srcPre = await snapshotSource(ridR);
      const verPre = await snapshotVersion(ridR, v.versionId);
      const orig = db.runTransaction.bind(db);
      let saved = false;
      const racing = new Proxy(db, {
        get(t, prop) {
          if (prop === 'runTransaction') {
            return async (fn, o) => {
              if (!saved) { saved = true; await sourceRefOf(db, ridR).update({ note_from_merchant: 'saved mid-pass' }); }
              return orig(fn, o);
            };
          }
          const val = t[prop];
          return typeof val === 'function' ? val.bind(t) : val;
        },
      });

      await assert.rejects(() => bootstrapIdentityStamps(racing, ridR), /identity_bootstrap_source_moved/,
        '🔴 the draft moved under the pass and it enriched over it — the merchant\'s save is gone');
      assert.ok(saved, 'premise — the save really landed inside the window');
      assert.deepStrictEqual(await snapshotVersion(ridR, v.versionId), verPre, '🔴 the version was certified anyway');
      /* 🔴 THE WHOLE SOURCE, NOT THE ONE FIELD I INJECTED. Checking note_from_merchant and the absence
         of stamps left every other part of the draft unmeasured: extras, prices and structure could
         have been rewritten by the aborted pass and this cell would still have passed. The expected
         state is exactly computable — the pre-pass source plus the merchant's one field — so compare
         against that whole object and let any other difference fail. */
      const srcNow = await snapshotSource(ridR);
      assert.deepStrictEqual(srcNow, { ...srcPre, note_from_merchant: 'saved mid-pass' },
        '🔴 the aborted pass left the merchant\'s draft something other than exactly their own save — the whole source has to come through, not just the field this cell happened to inject');
      assert.strictEqual(srcNow.note_from_merchant, 'saved mid-pass', '🔴 the merchant\'s mid-pass save was clobbered');
      assert.ok(!(srcNow.items || []).some((o) => o && o.display && o.display.identity_id), '…and nothing was stamped');
      await sourceRefOf(db, ridR).set(srcPre);
      ok(`${ridR}: a draft saved between the pass's read and its transaction aborts it — nothing stamped, the save intact`);
    }
  }

  /* ── 🔴 A POST-D VERSION: ACTIVATED RECORD, NO STAMPS → BOOTSTRAP PROCEEDS AND LEAVES IT ALONE ─
     The mirror of every cell above, which all model a PRE-P1 baseline with no record at all. Once
     Slice D ships, a publish that lands before bootstrap runs leaves exactly this state: a truthful
     `activated` record and no identity. A blanket refusal meant that restaurant could never be
     migrated — the cutover depended on an ordering nothing enforced.
     It is safe because `activated` is trustworthy rather than assumed: the flip writes it in the SAME
     transaction that moves the pointer, and bootstrap writes it only after verifying in-tx that the
     pointer names this version at the captured generation. Neither can mark a version that was never
     live. */
  {
    const ridA = 'la_musa';
    await db.recursiveDelete(db.collection('restaurants').doc(ridA));
    await sourceRefOf(db, ridA).set(canonicalize(buildSourceFromCode(ridA)));
    const { input } = buildPublishCandidate(ridA, { activeVersionId: null }, { source_sha: 'post-d' });
    const pub = await publishVersion(db, ridA, input, { expected: { activeVersionId: null } });
    await backfillIdentities(db, ridA, catalogSnapshot(ridA));

    const vref = db.collection('restaurants').doc(ridA).collection('versions').doc(pub.versionId);
    const before = ((await vref.get()).data() || {}).identity_activation;
    assert.ok(before && before.status === 'activated',
      'premise — a completed publish leaves an ACTIVATED record, which is the post-D state this cell is about');
    assert.ok(!((await vref.get()).data() || {}).identity_certified, 'premise — and it is not yet stamped');

    const res = await bootstrapIdentityStamps(db, ridA);
    assert.ok(res.stamped, '🔴 bootstrap REFUSED a version D had activated — that restaurant could never be migrated');

    const after = ((await vref.get()).data() || {}).identity_activation;
    assert.deepStrictEqual(after, before,
      '🔴 bootstrap REWROTE a real activation\'s record — replacing its own base_generation and attempt with this pass\'s incidental values is manufacturing authority in a quieter form');
    assert.strictEqual(((await vref.get()).data() || {}).identity_certified, true, 'and the identity it exists to add IS added');
    ok('a post-D version (activated, unstamped) is stamped by bootstrap with its activation record left byte-unchanged');
  }

  /* ── 🔴 pending AND abandoned STILL REFUSE — the property the narrowing must not have widened ───
     Promoting a candidate that never committed, or reviving one explicitly abandoned, is the failure
     the original blanket rule existed to prevent. Narrowing it to `activated` must not have bought
     the cutover at the price of that. An unrecognised status refuses too: a status we do not model is
     not one we may overwrite. */
  {
    const ridB = 'la_musa';
    for (const status of ['pending', 'abandoned', 'something_unmodelled']) {
      await db.recursiveDelete(db.collection('restaurants').doc(ridB));
      await sourceRefOf(db, ridB).set(canonicalize(buildSourceFromCode(ridB)));
      const { input } = buildPublishCandidate(ridB, { activeVersionId: null }, { source_sha: `st-${status}` });
      const pub = await publishVersion(db, ridB, input, { expected: { activeVersionId: null } });
      await backfillIdentities(db, ridB, catalogSnapshot(ridB));
      const vref = db.collection('restaurants').doc(ridB).collection('versions').doc(pub.versionId);
      /* Written onto what the REAL writer produced, not hand-built: only the status is forced, so the
         rest of the record is whatever publishVersion actually wrote. */
      await vref.update({ 'identity_activation.status': status });

      await assert.rejects(() => bootstrapIdentityStamps(db, ridB), /identity_bootstrap_activation_present/,
        `🔴 bootstrap accepted a ${status} record — it would manufacture activation authority for a candidate that never committed`);
      assert.ok(!((await vref.get()).data() || {}).identity_certified, `${status}: and it stamped nothing`);
    }
    ok('pending, abandoned and an unrecognised status each still REFUSE — the narrowing bought the cutover without buying that');
  }

  FINISHED = true;
  console.log(`d4p1-bootstrap(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('D4P1 BOOTSTRAP (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
