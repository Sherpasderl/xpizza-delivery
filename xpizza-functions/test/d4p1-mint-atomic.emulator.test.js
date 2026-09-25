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
const { sourceToBuildInputs } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf } = require('../catalog/source-store');
const { bootstrapIdentityStamps, readActiveVersion } = require('../catalog/identity-bootstrap');
const { idsColOf, keysColOf, encodeKey, STATUS_LIVE } = require('../catalog/identity-registry');

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

const publish = async (expectedActive, tag) => {
  const input = { ...(await candidateFromSource()), source_sha: tag };
  const r = await publishVersion(db, RID, input, { expected: { activeVersionId: expectedActive } });
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
    await assert.rejects(
      () => publish('v-does-not-exist', `mint-doomed-${STAMP}`),
      /flip_cas_stale|publish|expected/i,
      'premise — the activation really was refused',
    );

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

  // ── 4. 🔴 la_musa: AN UNCERTIFIED PUBLISH STILL REGISTERS ITS IDENTITIES ────────────────────
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

  FINISHED = true;
  console.log(`d4p1-mint-atomic(emulator): OK (${n})`);
})().catch((e) => { console.error('D4P1 MINT ATOMIC (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
