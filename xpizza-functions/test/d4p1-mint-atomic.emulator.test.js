'use strict';
require('./_emulator-required')('firestore');
/**
 * P1a's ONLY live operation: a CERTIFIED publish introducing a key the registry has never seen mints
 * its identity INSIDE the activation transaction. Run: npm run test:d4p1-mint-atomic
 *
 * 🔴 WHY THIS SUITE HAD TO BE WRITTEN BEFORE THE WRITER COULD SHIP. Adding a new dish is the most
 * ordinary merchant action there is after editing one, and it had NO end-to-end coverage anywhere in
 * this estate. Every existing emulator suite establishes its baseline through bootstrapIdentityStamps
 * or backfillIdentities first, so every candidate key is already registered and the mint path never
 * fires. Measured, not assumed: a diagnostic that derived and printed the plan on every activation of
 * d4p1-claim, edit-e2e, catalog-versioned, d4p1-save-publish and d4p1-activation emitted ZERO mints.
 * Wiring the writer on that evidence would have shipped a guard that passes its cells and never runs —
 * which is exactly why the destination guard was deferred in Slice D.
 *
 * 🔴 EMULATOR, NOT THE FAKE, AND THE REASON IS CELL 2. The identity double applies writes immediately
 * and models neither isolation nor rollback, so "the pointer and the identity moved together or not at
 * all" is UNASSERTABLE there — and that atomicity is the whole claim. Only a real transaction can be
 * aborted and observed to have written nothing.
 */
const assert = require('assert');
const admin = require('firebase-admin');
const { publishVersion } = require('../catalog/catalog-publish');
const { sourceToBuildInputs, encodeUpdateTime } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf } = require('../catalog/source-store');
const { bootstrapIdentityStamps, readActiveVersion } = require('../catalog/identity-bootstrap');
const { idsColOf, keysColOf, encodeKey, STATUS_LIVE } = require('../catalog/identity-registry');
/* versionsColOf is module-private to catalog-publish; the path is stable and spelled out here rather
   than exported for a test, which would widen a production module's surface for a fixture. */
const versionsColOf = (d, r) => d.collection('restaurants').doc(r).collection('versions');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4p1-mint-atomic: FAILED — exited without completing'); process.exitCode = 1; } });

if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza' });
const db = admin.firestore();
const RID = 'x_pizza';

const keyRowOf = async (kind, name) => {
  const s = await keysColOf(db, RID, kind).doc(encodeKey(name)).get();
  return s.exists ? (s.data() || {}) : null;
};
const idRowOf = async (kind, id) => {
  const s = await idsColOf(db, RID, kind).doc(id).get();
  return s.exists ? (s.data() || {}) : null;
};

/* Dish names the registry has never seen. Unique per run, so a re-run cannot pass on the previous
   run's rows — which would be the cell certifying its own leftovers. */
const STAMP = Date.now();
const NEW_DISH = `Zz Atomic Mint ${STAMP}`;
const DOOMED_DISH = `Zz Doomed Mint ${STAMP}`;

/* 🔴 BUILT FROM THE SOURCE, NOT FROM CODE. bootstrapIdentityStamps ENRICHES the source with the ids
   it stamped, and the partition law requires the candidate to carry every active id (C ∪ D = A). A
   candidate rebuilt from code carries none of them and the publish refuses
   `identity_partition_unaccounted` — a fixture failing for its own reasons, which looks exactly like
   the code failing. This is the same shape d4p1-claim-flip uses, for the same reason. */
async function candidateFromSource() {
  const src = (await sourceRefOf(db, RID).get()).data();
  const inputs = sourceToBuildInputs(src);
  const built = buildCatalogV2(RID, { formData: inputs.formData, priceTable: inputs.priceTable });
  return { items: built.items, structure: built.structure, extras: inputs.extras,
    extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
}

/* 🔴 draftRevision IS PASSED, BECAUSE THE PORTAL PASSES IT. publish-edited-handler.js sends
   `{ activeVersionId, draftRevision: sourceUpdateTime }`, and a mint now REFUSES without one — it
   must write the minted id back into the source, and writing the source without a CAS would clobber
   a merchant mid-edit. A helper that omitted it would be testing a shape the portal never sends, and
   would have hidden that refusal behind a fixture. */
const publish = async (expectedActive, tag) => {
  const snap = await sourceRefOf(db, RID).get();
  const input = { ...(await candidateFromSource()), source_sha: tag };
  const r = await publishVersion(db, RID, input,
    { expected: { activeVersionId: expectedActive, draftRevision: encodeUpdateTime(snap.updateTime) } });
  return r.versionId || r.version_id || r;
};

/* 🔴 THE NEW DISH GOES INTO THE SOURCE, WHICH IS WHAT A MERCHANT ACTUALLY DOES. Adding it to the
   built candidate instead would test a shape the portal cannot produce, and would skip the
   source→build path where a new object's ABSENCE of an identity_id is established. */
async function addDishToSource(name) {
  const src = (await sourceRefOf(db, RID).get()).data();
  const first = (src.items || [])[0];
  assert.ok(first, 'premise — the source has an item to model the new one on');
  /* 🔴 ITS OWN UI id. Cloning the first row wholesale carries that row's `id`, and the source
     validator refuses "duplicate UI id … ids collide as DOM strings" — a fixture failing for its own
     reasons. The UI id is the portal's DOM key and is unrelated to the canonical id this suite is
     about; it just has to be unique. */
  const used = new Set((src.items || []).map((o) => String((o && o.display && o.display.id))));
  let uiId = 9000;
  while (used.has(String(uiId))) uiId += 1;
  const row = { ...first, key: name, name,
    display: { ...(first.display || {}), id: uiId, name } };
  delete row.display.identity_id;
  await sourceRefOf(db, RID).update({
    items: (src.items || []).concat([row]),
    structure: { ...src.structure, item_order: (src.structure.item_order || []).concat([name]) },
  });
}

(async () => {
  await sourceRefOf(db, RID).set(buildSourceFromCode(RID));
  /* 🔴 PUBLISH, THEN BOOTSTRAP, THEN PUBLISH AGAIN. bootstrapIdentityStamps refuses without an active
     pointer (`identity_bootstrap_no_pointer`) — it stamps the version the pointer names — so the
     first publish exists to give it one. That first publish is UNCERTIFIED, which is also what makes
     the assertion below meaningful: certification is a property this setup establishes, not one the
     suite assumes. */
  const seedVersion = await publish(null, 'mint-seed');
  await bootstrapIdentityStamps(db, RID);
  const base = await publish(seedVersion, 'mint-base');
  const afterBase = await getActivePointer(db, RID);
  assert.strictEqual(afterBase.version, base, 'premise — the baseline publish is live');

  // ── 1. THE MINT HAPPENS, IN THE ACTIVATION, AND BOTH PLANES AGREE ───────────────────────────
  {
    assert.strictEqual(await keyRowOf('dish', NEW_DISH), null,
      'premise — the registry has NEVER heard of this name, or this suite is not exercising the mint path at all');

    await addDishToSource(NEW_DISH);
    const v = await publish(base, `mint-new-${STAMP}`);
    const after = await getActivePointer(db, RID);
    assert.strictEqual(after.version, v, 'premise — the publish carrying the new dish is live');

    const keyRow = await keyRowOf('dish', NEW_DISH);
    assert.ok(keyRow, `🔴 THE NEW OBJECT HAS NO IDENTITY. A published object with no registry entry is one the overlay silently cannot resolve — indistinguishable from "not backfilled yet", which is the failure this slice exists to remove.`);
    const mintedId = keyRow.canonical_id;
    assert.ok(mintedId, '🔴 the reverse row exists but names no id');

    const idRow = await idRowOf('dish', mintedId);
    assert.ok(idRow, '🔴 the forward row is missing — the registry disagrees with itself, which is the state the integrity sweep refuses rather than repairs');
    assert.strictEqual(idRow.legacy_key, NEW_DISH, '🔴 the id row claims a different name than the key row maps to it');
    assert.strictEqual(idRow.status, STATUS_LIVE, '🔴 a freshly minted identity is not live');
    ok(`a certified publish introducing an unseen key MINTS its identity and both planes agree (${mintedId} ↔ ${NEW_DISH})`);
  }

  // ── 2. 🔴 AN ABORTED FLIP WRITES NO IDENTITY — THIS IS WHAT PROVES *WHICH* WRITER DID IT ────
  {
    /* The distinguishing assertion of the whole slice. A post-flip pass registers AFTER the pointer
       moves, so it cannot satisfy this: the flip aborting would leave its writes either absent (if it
       never ran) or present (if it ran anyway) with no relationship to the pointer. An in-transaction
       writer must leave NOTHING, because the transaction that would have written it did not commit. */
    const DOOMED = DOOMED_DISH;
    const before = await getActivePointer(db, RID);
    assert.strictEqual(await keyRowOf('dish', DOOMED), null, 'premise — unseen name');
    await addDishToSource(DOOMED);

    /* A stale CAS is a real abort with a real cause, rather than a fault injected into the writer:
       injecting into the writer would prove the writer rolls back its own injected failure. */
    /* 🔴 CAPTURED RATHER THAN assert.rejects'd, SO THE REAL ERROR IS PRINTED. With a regex, a publish
       that failed for a DIFFERENT reason reported only "premise — the activation really was refused",
       which says nothing about what went wrong. Two mutants — stamping the version without enriching
       the source, and the reverse — both surface here as a PARTITION refusal on this next publish,
       and with a regex that fact was invisible. An opaque premise is a poor diagnostic in exactly the
       way an exhaustive assertion is. */
    let doomed = null;
    try { await publish('v-does-not-exist', `mint-doomed-${STAMP}`); }
    catch (e) { doomed = (e && e.message) || String(e); }
    assert.ok(doomed, '🔴 premise — a publish against a non-existent active version was ACCEPTED');
    assert.ok(/flip_cas_stale|expected/i.test(doomed),
      `🔴 the publish failed, but NOT on the stale CAS this cell stages. If this is identity_partition_unaccounted the version was stamped without the source being enriched; if it is identity_partition_carried_unknown the source was enriched without the version being stamped — either way a mint reached only one plane and the NEXT publish is refused: ${doomed}`);

    const after = await getActivePointer(db, RID);
    assert.strictEqual(after.version, before.version, 'premise — the pointer did not move');
    assert.strictEqual(await keyRowOf('dish', DOOMED), null,
      '🔴 AN ABORTED ACTIVATION LEFT AN IDENTITY BEHIND. Either the mint is not inside the flip transaction, or the transaction is not atomic — and a registry row for an object no version serves is the orphan the integrity sweep exists to repair.');
    ok('an ABORTED activation writes no identity at all — the pointer and the identity move together or not at all');
  }

  // ── 3. 🔴 EXACTLY ONE WRITER RAN: THE POST-FLIP PASS MUST NOT ALSO FIRE FOR A CERTIFIED PUBLISH ─
  {
    /* "The in-tx writer ran" is not enough. Two writers on one publish is the duplicate-owner defect
       arriving through a condition instead of through code, and the post-flip pass is conditioned on
       `!certifiedActivation`. If both ran, the second would re-register keys the first already owns —
       silently today, and a source of exactly the stamp/registry disagreements that refuse a later
       activation. Observed through the log line each writer emits. */
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };
    try {
      const cur = await getActivePointer(db, RID);
      await addDishToSource(`Zz Once ${STAMP}`);
      await publish(cur.version, `mint-once-${STAMP}`);
    } finally { console.log = realLog; }

    assert.ok(logs.some((l) => l.includes('identity_activation_writes')),
      '🔴 the in-transaction writer did not report any writes for a publish introducing a new key — the mint path is not live');
    /* 🔴 THIS ASSERTION USED TO WATCH THE WRONG THING, AND THE SWEEP SAID SO. It matched
       `identity_preserve_(failed|timeout|superseded)` — logs the post-flip pass emits only on ERROR.
       A pass that ran SUCCESSFULLY printed nothing, so the assertion could never fire, and two mutants
       that ran BOTH writers survived. The pass now reports itself on the happy path
       (`identity_postflip_pass`), which is the only way "and the other one did not" is observable. */
    assert.ok(!logs.some((l) => l.includes('identity_postflip_pass')),
      '🔴 the POST-FLIP pass also ran for a CERTIFIED publish — two identity writers owned one publish, which is the duplicate-owner defect arriving through a condition rather than through code');
    ok('a certified publish runs the in-transaction writer and NOT the post-flip pass — exactly one identity writer per publish');
  }

  // ── 4. 🔴 PUBLISH TWICE — THE LOCKOUT APPEARS ON THE **SECOND** PUBLISH, NOT THE FIRST ─────
  {
    /* 🔴 EVERY OTHER CELL HERE WOULD PASS WHILE THE MERCHANT IS ONE PUBLISH FROM BEING STUCK. A mint
       now stamps `display.identity_id` into its version, which puts that id into A — the ACTIVE
       version's certified set that validatePartition checks against (identity-partition.js:121).
       If the SOURCE is not enriched with the same id, the next draft does not carry it, so on the
       next publish the id is in A, absent from C, absent from D → `identity_partition_unaccounted`,
       REFUSED. The merchant adds a dish, publishes, and is locked out on the publish AFTER.
       That is §3.1's documented lockout — "one publish after cutover, then locked out of their own
       menu, with no way back" — arriving from the opposite direction, out of the fix for the
       version-stamp gap. Both halves ship together or neither does, and only a SECOND publish can
       tell. */
    const DISH2 = `Zz Second Publish ${STAMP}`;
    await addDishToSource(DISH2);
    const cur = await getActivePointer(db, RID);
    const first = await publish(cur.version, `twice-a-${STAMP}`);

    const mintedId = (await keyRowOf('dish', DISH2) || {}).canonical_id;
    assert.ok(mintedId, 'premise — the first publish minted an identity for the new dish');

    /* 🔴 BOTH PLANES CARRY IT, and each is asserted separately because they fail independently: the
       version stamp is what closes the two-plane history hole, the source enrichment is what keeps
       the next publish possible, and a fix that did one would look complete from the other's side. */
    const vItems = await versionsColOf(db, RID).doc(first).collection('menu_items').get();
    const inVersion = vItems.docs.map((d) => d.data()).find((d) => d.key === DISH2);
    assert.strictEqual(((inVersion || {}).display || {}).identity_id, mintedId,
      '🔴 the VERSION that introduced this object does not carry the id it was minted — §3.1 two-plane history is incomplete for it, and a rollback to this version could never restore it');

    const srcAfter = (await sourceRefOf(db, RID).get()).data();
    const inSource = (srcAfter.items || []).find((o) => o.key === DISH2);
    assert.strictEqual(((inSource || {}).display || {}).identity_id, mintedId,
      '🔴 the SOURCE was not enriched with the minted id — the next draft will not carry it, and the publish below is about to be refused identity_partition_unaccounted');

    /* THE ASSERTION THAT ONLY A SECOND PUBLISH CAN MAKE. */
    let refused = null;
    try {
      await addDishToSource(`Zz Third ${STAMP}`);
      await publish(first, `twice-b-${STAMP}`);
    } catch (e) { refused = (e && e.message) || String(e); }
    assert.strictEqual(refused, null,
      `🔴 THE PUBLISH AFTER A MINT WAS REFUSED — the merchant added a dish, published, and is now locked out of their own menu. If this says identity_partition_unaccounted, the version was stamped and the source was not: ${refused}`);
    /* 🔴 AND A MINTING PUBLISH WITHOUT A DRAFT CAS IS REFUSED, NOT ENRICHED BLINDLY. Recording the
       minted id means WRITING the source, and writing it without a revision to compare against would
       clobber a merchant mid-edit — bootstrap:356 names that hazard for the same write. The portal
       always sends a draftRevision (publish-edited-handler.js), so this is fail-closed rather than a
       path anyone takes; it exists because "the caller always passes it" is the assumption that gets
       broken by the next caller. */
    await addDishToSource(`Zz NoCas ${STAMP}`);
    const live = await getActivePointer(db, RID);
    let noCas = null;
    try {
      const input = { ...(await candidateFromSource()), source_sha: `nocas-${STAMP}` };
      await publishVersion(db, RID, input, { expected: { activeVersionId: live.version } });   // no draftRevision
    } catch (e) { noCas = (e && e.message) || String(e); }
    assert.ok(noCas && /flip_mint_needs_draft_cas/.test(noCas),
      `🔴 a publish that MINTS without a draftRevision was allowed to write the source — a merchant mid-edit would have their work clobbered by a publish that only meant to record an id: ${noCas}`);
    assert.strictEqual((await getActivePointer(db, RID)).version, live.version,
      '🔴 the refused publish moved the pointer anyway');
    ok('publishing TWICE after a mint succeeds — version AND source both carry the id — and a minting publish with no draft CAS is refused rather than clobbering the draft');
  }

  // ── 5. 🔴 la_musa: AN UNCERTIFIED PUBLISH STILL REGISTERS ITS IDENTITIES ────────────────────
  {
    /* THE CELL THAT WOULD HAVE CAUGHT THE DELETION WE NEARLY MADE. §4 reads as "remove the post-flip
       writer", and removing it OUTRIGHT was the plan until this was measured: la_musa is never
       certified (`certifiedCandidate:false` on every la_musa publish), so the in-transaction writer's
       block is never entered for it, and the post-flip pass is the ONLY thing registering its
       identities. Deleting it is dropping la_musa maintenance, which §0 forbids by name.
       🔴 AND BRAND IS THE WRONG AXIS, which is why the condition is CERTIFICATION and not rid:
       x_pizza is not uniformly certified either. A brand-gated removal would have left the same gap
       inside x_pizza while looking handled. This cell pins the uncertified path for the brand where
       it is permanent; cell 3 pins the certified path for the brand where it is not.
       🔴 AND THIS SUITE'S OWN SETUP IS THE FIRST WITNESS, which the sweep found before this cell did.
       Removing the pass outright makes the UNCERTIFIED seed publish at the top of this file register
       nothing, so bootstrapIdentityStamps then refuses `identity_bootstrap_unregistered: x_pizza/dish/
       Margherita — bootstrap mints nothing; run the D1 backfill first`. x_pizza cannot even reach a
       certified baseline without that pass. The mutant records both, so credit sits where it falls. */
    const MUSA = 'la_musa';
    const musaSrc = sourceRefOf(db, MUSA);
    await musaSrc.set(buildSourceFromCode(MUSA));

    const musaCandidate = async () => {
      const src = (await musaSrc.get()).data();
      const inputs = sourceToBuildInputs(src);
      const built = buildCatalogV2(MUSA, { formData: inputs.formData, priceTable: inputs.priceTable });
      return { items: built.items, structure: built.structure, extras: inputs.extras,
        extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
    };

    const before = await getActivePointer(db, MUSA);
    const r = await publishVersion(db, MUSA, { ...(await musaCandidate()), source_sha: `musa-${STAMP}` },
      { expected: { activeVersionId: before.version } });
    assert.ok(r && (r.versionId || r.version_id), 'premise — the la_musa publish succeeded');

    const rec = await readActiveVersion(db, MUSA);
    assert.notStrictEqual(rec.record.identity_certified, true,
      '🔴 la_musa is CERTIFIED — then the in-transaction writer owns it after all, this cell is testing the wrong path, and the conditional removal needs re-deriving from scratch');

    /* The identities must exist regardless — registered by the post-flip pass, which still runs
       because this publish is uncertified. A dish la_musa actually serves, keyed as the money path
       keys it. */
    const src = (await musaSrc.get()).data();
    const someKey = (src.items || [])[0] && (src.items || [])[0].key;
    assert.ok(someKey, 'premise — la_musa serves at least one dish');
    const row = await (async () => {
      const snap = await keysColOf(db, MUSA, 'dish').doc(encodeKey(someKey)).get();
      return snap.exists ? (snap.data() || {}) : null;
    })();
    assert.ok(row && row.canonical_id,
      `🔴 la_musa's identities WERE NOT REGISTERED. The post-flip pass is the only writer for an uncertified publish, and removing it unconditionally drops la_musa maintenance — §0: "gate P1 BEHAVIOR, don't drop la_musa maintenance". Key: ${someKey}`);
    ok('an UNCERTIFIED la_musa publish still registers its identities through the post-flip pass — the conditional removal keeps exactly one writer per publish, for both brands');
  }

  // ── 6. 🔴 A ROLLBACK TO AN UNCERTIFIED TARGET PERFORMS **ZERO** REGISTRY WRITES ─────────────
  {
    /* 🔴 THIS GUARD IS BUILT BEFORE THE THING IT GUARDS, DELIBERATELY. reconcileOnRollback does not
       exist yet. When it does, §5's fourth case — "Y retired if absent from the target" — run against
       a target with NO STAMPS would find EVERY live id absent and derive a retirement for THE ENTIRE
       REGISTRY. Reachable from an ordinary merchant rollback to any pre-cutover version, the moment
       retires ship. Every other build order leaves that path reachable for a window.

       🔴 AN UNCERTIFIED TARGET IS NOT A TARGET WITH NO IDENTITIES — IT IS ONE WHOSE IDENTITIES ARE
       UNKNOWABLE. Same principle this slice has now used four times, one level up: an unread registry
       is not an empty one; a partially-read registry is not a complete one. Absence of evidence read
       as evidence of absence, with a delete attached.

       🔴 AND DOING NOTHING IS THE BEHAVIOUR WE WANT, not merely the safe one. Leave the registry
       alone and a rollback to v3 then a certified re-publish at v6 KEEPS every original identity
       across the excursion — the uncertified version resolves by name (§5), the rows sit unused, and
       the next certified publish reads them. Retire on the way back and v6 mints fresh ids for every
       dish: identity continuity destroyed by a rollback, caused by the slice that exists to protect
       it.

       THE FIXTURE MAKES THE DERIVATION WANT TO WRITE. A registry missing one reverse row — the
       orphan the integrity sweep repairs, a state this codebase already models — means a derivation
       allowed to run against this target WOULD mint for that key. So "zero writes" is a claim about
       the GATE, not about there being nothing to do. */
    /* 🔴 la_musa, BECAUSE ITS TARGETS ARE GENUINELY UNCERTIFIED AND NOTHING HAD TO BE FABRICATED.
       My first attempt used x_pizza's pre-bootstrap seed version — and it FAILED its own premise:
       bootstrapIdentityStamps stamps whatever version the pointer names, so it had retroactively
       CERTIFIED that seed. A fixture that had to force `identity_certified: false` onto a version doc
       would have been testing a state the system does not produce. la_musa is never certified because
       nothing stamps it, which is the production case this guard is for. */
    const MUSA = 'la_musa';
    const musaSrc = sourceRefOf(db, MUSA);
    const musaCandidate = async () => {
      const src = (await musaSrc.get()).data();
      const inputs = sourceToBuildInputs(src);
      const built = buildCatalogV2(MUSA, { formData: inputs.formData, priceTable: inputs.priceTable });
      return { items: built.items, structure: built.structure, extras: inputs.extras,
        extraRecords: (src.extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
    };
    const musaPublish = async (expectedActive, tag) => {
      const r = await publishVersion(db, MUSA, { ...(await musaCandidate()), source_sha: tag },
        { expected: { activeVersionId: expectedActive } });
      return r.versionId || r.version_id || r;
    };

    const start = await getActivePointer(db, MUSA);
    const target = start.version;                       // cell 4 published this; uncertified
    assert.ok(target, 'premise — cell 4 left a la_musa version live to roll back TO');
    const targetRec = await versionsColOf(db, MUSA).doc(target).get();
    assert.notStrictEqual((targetRec.data() || {}).identity_certified, true,
      '🔴 the rollback target is CERTIFIED — this cell is not exercising the uncertified path at all');

    const moved = await musaPublish(target, `musa-roll-${STAMP}`);
    assert.notStrictEqual(moved, target, 'premise — there is a real later version to roll back FROM');

    /* 🔴 REMOVE BOTH ROWS FOR ONE DISH, AND THE "BOTH" IS WHAT ISOLATES THE GATE. Removing only the
       reverse row made a permitted derivation try to mint la_musa's slug — which is its id — and die
       on `flip_identity_mint_exhausted` instead of writing. That refusal is correct, but it is the
       grandfathered-slug guard catching the mutant, not this cell's gate: the mutant would have been
       credited to the wrong mechanism. With BOTH rows gone the slug is genuinely free, the mint
       SUCCEEDS, and the only thing standing between this rollback and a registry write is the
       certification gate. That state is also the honest one — a dish with neither row is simply one
       nothing has backfilled, which is every dish before D1 ran. */
    const musaSrcData = (await musaSrc.get()).data();
    const victimKey = (musaSrcData.items || [])[0].key;
    const victimKeyRef = keysColOf(db, MUSA, 'dish').doc(encodeKey(victimKey));
    const victimKeySnap = await victimKeyRef.get();
    assert.ok(victimKeySnap.exists, 'premise — the key row exists before we remove it');
    const victimId = (victimKeySnap.data() || {}).canonical_id;
    assert.ok(victimId, 'premise — and it names an id');
    await victimKeyRef.delete();
    await idsColOf(db, MUSA, 'dish').doc(victimId).delete();

    const snapshotRegistry = async () => {
      const out = {};
      for (const kind of ['dish', 'extra']) {
        for (const d of (await idsColOf(db, MUSA, kind).get()).docs) out[`ids/${kind}/${d.id}`] = JSON.stringify(d.data());
        for (const d of (await keysColOf(db, MUSA, kind).get()).docs) out[`keys/${kind}/${d.id}`] = JSON.stringify(d.data());
      }
      return out;
    };
    const before = await snapshotRegistry();
    assert.ok(Object.keys(before).length > 10,
      `non-vacuity: the registry must really hold rows, or "unchanged" is trivially true (${Object.keys(before).length})`);

    const { rollbackVersion } = require('../catalog/catalog-publish');
    await rollbackVersion(db, MUSA, target, { expected: { activeVersionId: moved } });
    assert.strictEqual((await getActivePointer(db, MUSA)).version, target,
      'premise — the rollback actually landed on the uncertified target');

    const after = await snapshotRegistry();
    assert.deepStrictEqual(after, before,
      `🔴 A ROLLBACK TO AN UNCERTIFIED TARGET WROTE TO THE REGISTRY. Its identities are UNKNOWABLE, not absent — and the write this grows into is a retirement of EVERY live id, derived from a target that simply has no stamps to compare against. Added: ${JSON.stringify(Object.keys(after).filter((k) => !(k in before)))}; removed: ${JSON.stringify(Object.keys(before).filter((k) => !(k in after)))}`);
    assert.strictEqual((await victimKeyRef.get()).exists, false,
      '🔴 the un-backfilled dish was MINTED an identity by a rollback to an uncertified target — a rollback reconciles what the target can prove, and an uncertified target proves nothing');
    ok('a rollback to an UNCERTIFIED target performs ZERO registry writes, even with an un-backfilled dish a permitted derivation would have minted');
  }

  // ── 7. 🔴 A ROLLBACK ACROSS A DELETION SUCCEEDS AND RESURRECTS — THE RELOCATION, END TO END ──
  {
    /* 🔴 THE CASE THAT DECIDES WHETHER MOVING FIVE REFUSALS WAS REAL. Before the relocation this
       exact scenario FAILED — I measured it with a read-only probe: a certified rollback whose target
       carries a stamp the registry can no longer resolve is refused `stamp_unregistered`, by the
       stamp map, before any reconciliation could repair it. Every other suite stayed green through
       the relocation because their registries are coherent, so "green" there is consistent with the
       relocation doing nothing at all.
       The post-deletion STATE is what matters, not how it was reached — so it is set up directly:
       the id retired, its reverse row gone. That is exactly what a retirement leaves behind. */
    const target = await getActivePointer(db, RID);
    assert.ok(target.version, 'premise — a certified version is live to become the rollback target');
    const targetRec = await versionsColOf(db, RID).doc(target.version).get();
    assert.strictEqual((targetRec.data() || {}).identity_certified, true,
      'premise — the TARGET is certified; the uncertified path is cell 5 and must not be what this exercises');

    /* 🔴 THE VICTIM IS A BOOTSTRAP-STAMPED DISH, NOT THE ONE CELL 1 MINTED — and the reason is a
       finding this cell produced. An object MINTED BY THE ATOMIC WRITER gets its identity in the
       REGISTRY but NOT into the version: the version's `display.identity_id` comes from the DRAFT's
       stamps, and a brand-new object has none at draft time. Measured directly — for a freshly minted
       dish the version reads `identity_id: null` while the registry holds `CEXDCRTRQN`.
       A rollback restores from the TARGET's stamps, so an object the target never stamped cannot be
       restored by it — correctly, since the target genuinely does not certify that identity. Using it
       here would have tested the gap rather than the relocation. Reported separately; this cell uses
       a dish whose stamp the target really carries. */
    const srcNow = (await sourceRefOf(db, RID).get()).data();
    const victimKey = (srcNow.items || [])[0].key;
    const keyRow = await keyRowOf('dish', victimKey);
    assert.ok(keyRow && keyRow.canonical_id, 'premise — a bootstrap-stamped dish with an identity');
    const victimId = keyRow.canonical_id;

    const tItems = await versionsColOf(db, RID).doc(target.version).collection('menu_items').get();
    const carried = tItems.docs.map((d) => d.data()).find((d) => d.key === victimKey);
    assert.strictEqual(((carried || {}).display || {}).identity_id, victimId,
      '🔴 premise — the TARGET must actually carry this stamp, or the restore has no provenance to work from and this cell is testing the mint gap instead of the relocation');

    /* Move the pointer forward so there is something to roll back FROM. */
    await addDishToSource(`Zz Forward ${STAMP}`);
    const moved = await publish(target.version, `roll-forward-${STAMP}`);
    assert.notStrictEqual(moved, target.version, 'premise — a later version is live');

    /* THE POST-DELETION STATE: the id retired, the reverse row gone. */
    await idsColOf(db, RID, 'dish').doc(victimId).update({ status: 'retired', retired_at: new Date().toISOString() });
    await keysColOf(db, RID, 'dish').doc(encodeKey(victimKey)).delete();
    assert.strictEqual(await keyRowOf('dish', victimKey), null, 'premise — the name resolves to nothing now');

    const { rollbackVersion } = require('../catalog/catalog-publish');
    let refused = null;
    try {
      await rollbackVersion(db, RID, target.version, { expected: { activeVersionId: moved } });
    } catch (e) { refused = (e && e.message) || String(e); }
    assert.strictEqual(refused, null,
      `🔴 THE ROLLBACK WAS REFUSED. If this is stamp_unregistered / stamp_id_retired / stamp_registry_disagrees / stamp_id_row_missing / stamp_id_claims_other_name, the five refusals did NOT move: the stamp map is still judging a rollback target as if it were a draft, and the reconciliation never runs on the one input it was built for. ${refused}`);

    assert.strictEqual((await getActivePointer(db, RID)).version, target.version, 'the rollback landed');

    /* 🔴 AND THE IDENTITY IS BACK IN BOTH PLANES, WITH ITS HISTORY. Landing is not enough — a rollback
       that moved the pointer and left the object unresolvable would satisfy "not refused" while
       failing the thing restoreIdentity exists for. */
    const after = await keyRowOf('dish', victimKey);
    assert.ok(after, '🔴 the rollback landed but the reverse row was NOT restored — the object it brought back still resolves to nothing by name');
    assert.strictEqual(after.canonical_id, victimId,
      '🔴 the name was restored to a DIFFERENT id — the rollback minted a new identity instead of resurrecting the one the target certifies, which is the split identity this slice exists to prevent');
    const idRow = await idRowOf('dish', victimId);
    assert.strictEqual(idRow.status, STATUS_LIVE, '🔴 the id row is still retired — the reverse row points at a dead identity');
    assert.ok(idRow.retired_at, '…and the row KEEPS its retirement history, so a reader can tell this id went round the loop');
    assert.ok(idRow.restored_at, '…and records when it came back');
    ok('a rollback ACROSS A DELETION succeeds and resurrects the SAME id in both planes — the five relocated refusals really did move');
  }

  // ── 8. 🔴 ROLLBACK, THEN PUBLISH — §5's SOURCE REBASE, WHICH WAS UNBUILT ───────────────────
  {
    /* 🔴 THE PROPERTY CELL 4 WAS MOVED AWAY FROM MEASURING. A rollback moves the pointer to an older
       version while the stored source still carries the ids later publishes minted, so
       validatePartition refuses the NEXT publish with `identity_partition_carried_unknown` — the
       merchant cannot publish at all after any rollback. §5 requires the rollback flip to rebase the
       stored source in the SAME transaction; it was unbuilt, and my mint enrichment took it from
       latent to reachable.
       TWO LOCKOUTS, DISTINGUISHABLE BY NAME: `identity_partition_unaccounted` is a missing version
       stamp (cell 4's mutant), `identity_partition_carried_unknown` is a stale source (this one). */
    /* 🔴 THIS SETUP PUBLISH IS GUARDED, BECAUSE CELL 7 ALREADY ROLLED BACK. Without the rebase, cell
       7's rollback leaves the source carrying ids its target does not certify, and THIS publish is
       the first to meet it — as an uncaught throw in a setup line, which says nothing about the
       property. Attributed here rather than left to surface as noise, the same repair cell 2 needed. */
    const cur = await getActivePointer(db, RID);
    await addDishToSource(`Zz Pre Roll ${STAMP}`);
    let newer = null;
    try { newer = await publish(cur.version, `pre-roll-${STAMP}`); }
    catch (e) {
      assert.fail(`🔴 PUBLISHING AFTER THE PREVIOUS CELL'S ROLLBACK WAS REFUSED — the stale-source lockout, before this cell even stages its own. If this says identity_partition_carried_unknown, a rollback did not rebase the stored source to its target's stamps: ${(e && e.message) || e}`);
    }
    const mintedId = (await keyRowOf('dish', `Zz Pre Roll ${STAMP}`) || {}).canonical_id;
    assert.ok(mintedId, 'premise — the pre-rollback publish minted an id the target will not certify');

    const { rollbackVersion } = require('../catalog/catalog-publish');
    await rollbackVersion(db, RID, cur.version, { expected: { activeVersionId: newer } });
    assert.strictEqual((await getActivePointer(db, RID)).version, cur.version, 'premise — the rollback landed');

    /* 🔴 THE SOURCE NO LONGER CARRIES THE UNCERTIFIED STAMP, and the object keeps its other fields:
       a rebase that replaced the source wholesale would also satisfy the partition law while
       discarding edits the rollback was never asked to undo. */
    const src2 = (await sourceRefOf(db, RID).get()).data();
    const rebasedRow = (src2.items || []).find((o) => o.key === `Zz Pre Roll ${STAMP}`);
    assert.ok(rebasedRow, '🔴 the rollback REMOVED the object from the source — only display.identity_id should move');
    assert.strictEqual((rebasedRow.display || {}).identity_id, undefined,
      '🔴 the source still carries an id the rollback target does not certify — the next publish is about to be refused identity_partition_carried_unknown');

    /* THE ASSERTION THAT ONLY A PUBLISH-AFTER-ROLLBACK CAN MAKE. */
    let refused = null;
    try { await publish(cur.version, `post-roll-${STAMP}`); }
    catch (e) { refused = (e && e.message) || String(e); }
    assert.strictEqual(refused, null,
      `🔴 THE PUBLISH AFTER A ROLLBACK WAS REFUSED — the merchant rolled back and can no longer publish their own menu. If this says identity_partition_carried_unknown, the source was not rebased to the target's stamps: ${refused}`);
    ok('a rollback REBASES the stored source to the target\'s stamps, so the next publish succeeds — §5 satisfied rather than deferred');
  }

  // ── 9. 🔴 A CONCURRENT DRAFT SEES A VISIBLE CAS CONFLICT, NOT A SILENT CLOBBER ─────────────
  {
    /* §5, verbatim: "A concurrent draft sees a CAS conflict and must VISIBLY rebase/discard, never
       silently clobbered or churned on the next publish." This is the only part of the rebase a
       merchant would ever feel, and the part most likely to be built correctly-but-silently.
       A merchant reads the source, starts editing, and an operator rolls back underneath them. Their
       publish must be REFUSED BY NAME against the revision they reviewed — not accepted onto a
       baseline that no longer exists, and not silently overwritten. */
    const beforeEdit = await sourceRefOf(db, RID).get();
    const staleRevision = encodeUpdateTime(beforeEdit.updateTime);   // what the merchant is editing against

    const cur = await getActivePointer(db, RID);
    await addDishToSource(`Zz Concurrent ${STAMP}`);
    const newer = await publish(cur.version, `conc-${STAMP}`);

    const { rollbackVersion } = require('../catalog/catalog-publish');
    await rollbackVersion(db, RID, cur.version, { expected: { activeVersionId: newer } });

    let conflict = null;
    try {
      const input = { ...(await candidateFromSource()), source_sha: `conc-publish-${STAMP}` };
      await publishVersion(db, RID, input,
        { expected: { activeVersionId: cur.version, draftRevision: staleRevision } });
    } catch (e) { conflict = (e && e.message) || String(e); }
    assert.ok(conflict && /flip_cas_draft_stale/.test(conflict),
      `🔴 a draft open ACROSS the rollback was accepted, or refused for some other reason. §5 requires a VISIBLE CAS conflict so the merchant rebases or discards deliberately, rather than publishing onto a baseline that no longer exists: ${conflict}`);
    assert.strictEqual((await getActivePointer(db, RID)).version, cur.version, 'and the refused publish moved nothing');
    /* 🔴 AND THE MIRROR: A ROLLBACK THAT CHANGES NO STAMPS MUST NOT TOUCH THE SOURCE AT ALL. If the
       rebase wrote unconditionally, every rollback would bump the source revision and refuse an
       innocent merchant's draft for no reason — protection turning into churn, which is the second
       half of §5's "never silently clobbered OR CHURNED on the next publish". */
    const quietBase = await getActivePointer(db, RID);
    const quietA = await publish(quietBase.version, `quiet-a-${STAMP}`);
    const quietB = await publish(quietA, `quiet-b-${STAMP}`);
    /* 🔴 ASSERTED ON THE WRITE, NOT ON updateTime — AND THE SWEEP IS WHY. My first version compared
       the source revision before and after, and a mutant writing UNCONDITIONALLY survived it: the
       emulator does not bump updateTime for a write whose content is identical, so the effect I was
       measuring cannot distinguish "did not write" from "wrote the same bytes". The rebase announces
       itself, so the announcement is the observable. */
    const revBefore = encodeUpdateTime((await sourceRefOf(db, RID).get()).updateTime);
    const seen = [];
    const realLog = console.log;
    console.log = (...a) => { seen.push(a.join(' ')); realLog(...a); };
    try { await rollbackVersion(db, RID, quietA, { expected: { activeVersionId: quietB } }); }
    finally { console.log = realLog; }
    assert.ok(!seen.some((l) => l.includes('identity_rollback_source_rebased')),
      '🔴 a rollback that changed NO stamps still wrote the source — every rollback would then invalidate an innocent draft, turning §5\'s protection into churn');
    assert.strictEqual(encodeUpdateTime((await sourceRefOf(db, RID).get()).updateTime), revBefore,
      'and the revision is untouched (weaker than the assertion above: an identical write does not move it)');
    ok('a draft open across a rollback is refused flip_cas_draft_stale BY NAME, and a rollback that changes no stamps does not touch the source at all');
  }

  FINISHED = true;
  console.log(`d4p1-mint-atomic(emulator): OK (${n})`);
})().catch((e) => { console.error('D4P1 MINT ATOMIC (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
