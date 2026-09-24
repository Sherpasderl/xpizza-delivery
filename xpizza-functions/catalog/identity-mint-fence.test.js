'use strict';
/**
 * The mint fence, at the batch boundary. Run: node catalog/identity-mint-fence.test.js
 *
 * 🔴 WHY THIS FILE EXISTS. ensureIdentity runs ONE TRANSACTION PER KEY, so fencing it means dozens of
 * chances to refuse inside a single publish. What a MID-BATCH refusal does is a decision, not a
 * consequence, and it should be asserted rather than inferred from the shape of the code: keys 1..N
 * registered, key N+1 refuses because the pointer moved, keys N+2.. never attempted, and the
 * publish's existing best-effort handler absorbs it. The remaining keys belong to a SUPERSEDED
 * version and the newer publish registers its own — which is exactly what that handler already
 * promises for a timeout.
 */
const assert = require('assert');
const { makeDb } = require('./firestore-fake');
const { activePointerRef } = require('./catalog-firestore');
const { ensureIdentitiesForKeys } = require('./identity-backfill');
const { lookupByLegacyKeys } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'la_musa';                       // the id-keyed brand, so nothing here depends on name keys
const keysOf = (c) => Array.from({ length: c }, (_, i) => `dish_${String(i).padStart(2, '0')}`);

/* A db that moves the pointer partway through a batch: the flip that supersedes us, landing between
   one key's transaction and the next. Wrapping runTransaction is how the tree already simulates
   concurrency (identity-grace drives contention the same way). */
function dbThatMovesPointerAfter(moveAfter, to) {
  const db = makeDb();
  let started = 0;
  const realRunTransaction = db.runTransaction.bind(db);
  db.runTransaction = async (fn) => {
    started += 1;
    if (started === moveAfter + 1) await activePointerRef(db, RID).set(to);
    return realRunTransaction(fn);
  };
  return db;
}

(async () => {

// ── 1. PREMISE: WITH THE POINTER STILL, A WHOLE BATCH REGISTERS ───────────────────────────────
/* Without this the refusal cells below are satisfied by a fence that refuses everything. */
{
  const db = makeDb();
  const captured = { version: 'v-1', generation: 1 };
  await activePointerRef(db, RID).set(captured);
  const keys = keysOf(6);
  /* Wrapped so that a batch which REFUSES fails here as an assertion naming why, rather than as an
     escaped error. A harness that reads a nonzero exit as "the suite noticed" would otherwise score
     this property as guarded by a stack trace. */
  let report;
  try { report = await ensureIdentitiesForKeys(db, RID, { dish: keys, extra: [] }, { captured }); }
  catch (e) { assert.fail(`🔴 an unmoved pointer refused the whole batch — the captured pair is not reaching the writer: ${e.message}`); }
  assert.strictEqual(report.dish.total, 6, 'every key was attempted');
  assert.strictEqual(report.dish.created, 6, 'and every one minted');
  const found = await lookupByLegacyKeys(db, { rid: RID, kind: 'dish', legacyKeys: keys });
  assert.strictEqual([...found.values()].filter(Boolean).length, 6, 'all six are resolvable afterwards');
  ok('an unmoved pointer registers the whole batch — the fence is not refusing everything');
}

// ── 2. 🔴 A MID-BATCH REFUSAL STOPS THE BATCH AND KEEPS WHAT IT ALREADY DID ───────────────────
{
  const captured = { version: 'v-1', generation: 1 };
  const db = dbThatMovesPointerAfter(3, { version: 'v-2', generation: 2 });
  await activePointerRef(db, RID).set(captured);
  const keys = keysOf(8);

  await assert.rejects(
    () => ensureIdentitiesForKeys(db, RID, { dish: keys, extra: [] }, { captured }),
    /identity_mint_pointer_moved: la_musa — judged against v-1@1, now "v-2"@2/,
    '🔴 a mint landed against a version that was superseded mid-batch');

  /* What already landed STAYS. Those keys belong to the version that was live when they were
     written, and unwinding them would retire identities the overlay is already serving. */
  const found = await lookupByLegacyKeys(db, { rid: RID, kind: 'dish', legacyKeys: keys });
  const registered = [...found.values()].filter(Boolean).length;
  assert.strictEqual(registered, 3, `🔴 the keys written BEFORE the pointer moved were lost (${registered} of the first 3 survive)`);
  ok('keys written before the move survive; the key that raced refuses; the rest are never attempted');
}

// ── 3. 🔴 IT PROPAGATES RATHER THAN RETURNING A REPORT ────────────────────────────────────────
/* The abandonment path returns `{stopped: true}` — a clean stop that says nothing. A fence refusal
   must reach the publish's catch, because that is where the three outcomes are told apart
   (superseded / timeout / broken). A silent clean stop would lose exactly the signal that
   distinction exists for. */
{
  const captured = { version: 'v-1', generation: 1 };
  const db = dbThatMovesPointerAfter(1, { version: 'v-2', generation: 2 });
  await activePointerRef(db, RID).set(captured);
  let threw = null, returned = null;
  try { returned = await ensureIdentitiesForKeys(db, RID, { dish: keysOf(4), extra: [] }, { captured }); }
  catch (e) { threw = e; }
  assert.ok(threw, '🔴 a fence refusal returned a report instead of propagating — the publish log can no longer tell superseded from timed-out');
  assert.strictEqual(returned, null, 'and nothing was returned');
  assert.match(threw.message, /_pointer_moved:/, 'the message carries the marker the publish log switches on');
  ok('a fence refusal PROPAGATES, so the publish handler can name it superseded rather than failed');
}

// ── 4. 🔴 THE PUBLISH LOG TELLS THE THREE OUTCOMES APART ──────────────────────────────────────
/* Same class as the pinned refusal line: the operator reads the sentence. A benign race, a slow
   registry and a broken one had one name between them. */
{
  const pub = require('fs').readFileSync(require('path').join(__dirname, 'catalog-publish.js'), 'utf8');
  for (const [needle, why] of [
    ['identity_preserve_superseded', 'a fence refusal is named as superseded — benign and self-correcting'],
    ['identity_preserve_timeout', 'a deadline hit keeps its own name — the registry is slow'],
    ['identity_preserve_failed', 'anything else stays the generic failure'],
  ]) {
    assert.ok(pub.includes(needle), `🔴 ${why} — missing ${needle}`);
  }
  /* …and the switch is on the refusal MARKER, not on the specific code, so the other fenced writers
     (sweep, retire) land in the same bucket without anyone remembering to add them. */
  assert.match(pub, /_pointer_moved:\/\.test\(msg\)/, '🔴 the log switches on a specific code rather than the shared marker — a new fenced writer would report as broken');
  ok('the publish names superseded, timed-out and broken separately, keyed on the shared fence marker');
}

// ── 5. 🔴 A REFUSAL DOES NOT FAIL THE MERCHANT'S PUBLISH ──────────────────────────────────────
/* The whole decision rests on this: the flip has already landed when this writer runs, and its
   errors are caught. If that ever stops being true, a benign race starts failing publishes. */
{
  const pub = require('fs').readFileSync(require('path').join(__dirname, 'catalog-publish.js'), 'utf8');
  const body = pub.slice(pub.indexOf('async function publishVersion'), pub.indexOf('async function rollbackVersion'));
  assert.ok(body.indexOf('await flipPointer(') < body.indexOf('ensureIdentitiesForKeys('),
    '🔴 the registry writer now runs BEFORE the flip — a refusal would abort a publish that had not yet cut over');
  const hook = body.slice(body.indexOf('ensureIdentitiesForKeys('));
  assert.match(hook.slice(0, 900), /catch \(e\) \{/, '🔴 the registry writer is no longer wrapped in a catch — a fence refusal would fail the publish');
  assert.ok(!/throw\s+e\s*;/.test(hook.slice(0, 900)), '🔴 the handler rethrows — a benign supersession would surface as a failed save');
  ok('the writer still runs AFTER the flip and inside a catch — a refusal cannot fail a merchant\'s publish');
}

// ── 6. 🔴 THE PUBLISH ACTUALLY HANDS ITS WRITER THE PAIR THE FLIP RETURNED ────────────────────
/* Every cell above drives ensureIdentitiesForKeys directly, so all of them pass even if
   publishVersion never captures the flip's return and hands its writer `null`. The writer would then
   refuse every key with no_baseline — and because the publish swallows that by design, the publish
   still SUCCEEDS while registering nothing. Green cells, a silent regression, and the exact shape of
   the unfed-parameter defect this whole increment exists to avoid repeating. */
{
  const { publishVersion } = require('./catalog-publish');
  const { buildPublishCandidate } = require('../tools/publish-version');
  const db = makeDb();
  const { input, expected } = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'e2d' });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(String(a[0]));
  try { await publishVersion(db, RID, input, { expected }); } finally { console.warn = realWarn; }

  /* Counted from the REGISTRY, against the number of objects the candidate published. An earlier
     version of this cell looked up `Object.keys(input.items)` — which are ARRAY INDICES, not legacy
     keys — and reported 0 of 44 registered. The code was fine; the cell was asking the wrong
     question, and it would have been reported as a defect had I not checked the registry directly. */
  const rowsOf = async (kind) => (await db.collection('restaurants').doc(RID)
    .collection('identity').doc(kind).collection('keys').get()).docs.length;
  const wantDish = (input.items || []).length;
  const wantExtra = Object.keys(input.extras || {}).length;   // extras is a PRICE MAP keyed by legacy key, not an array
  assert.ok(wantDish > 0 && wantExtra > 0, `premise — the candidate carries objects to register (${wantDish} dishes, ${wantExtra} extras)`);
  const gotDish = await rowsOf('dish');
  const gotExtra = await rowsOf('extra');
  assert.strictEqual(gotDish, wantDish,
    `🔴 a publish registered ${gotDish} of ${wantDish} dish keys — its writer was handed no baseline and refused every one, SILENTLY, because the publish swallows it`);
  assert.strictEqual(gotExtra, wantExtra,
    `🔴 a publish registered ${gotExtra} of ${wantExtra} extra keys — the same silent refusal on the sibling kind`);
  const registered = gotDish + gotExtra;
  assert.ok(!warnings.some((w) => /identity_preserve/.test(w)),
    `🔴 the publish logged a preserve failure on the happy path: ${warnings.filter((w) => /identity_preserve/.test(w))[0]}`);
  ok(`a real publish hands its writer the flip's pair — all ${registered} keys registered, nothing swallowed`);
}

console.log(`\n${n} cells passed`);
})().catch((e) => { console.error(e); process.exit(1); });
