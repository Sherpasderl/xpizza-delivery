'use strict';
/**
 * The generation fence — every branch, driven directly. Run: node catalog/identity-fence.test.js
 *
 * 🔴 WHY THIS FILE EXISTS. The fence was extracted from identity-bootstrap.js's retireOrphanFenced,
 * which already did it correctly, so three other registry writers can match a working implementation
 * instead of interpreting a spec. An extraction is only worth anything if the thing extracted still
 * refuses exactly what it refused before — and if the NEW failure modes the extraction introduces
 * (a baseline that can now be absent, because it is now a parameter) fail closed.
 *
 * The stubs model the REAL shapes: a snapshot is `{exists, data()}` because readPointerSnap refuses
 * anything else, and the pointer document's fields are `version`/`generation`. A stub that modelled
 * neither would pass these cells while the fence refused every real call.
 */
const assert = require('assert');
const { assertPointerUnmoved, baselineOf } = require('./identity-fence');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const RID = 'x_pizza';
const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({}) }) }) }) };
const snapOf = (fields) => ({ exists: true, data: () => fields });
const txOf = (snap) => ({ get: async () => snap });
const CODE = 'identity_reconcile_pointer_moved';
const fence = (captured, snap, code = CODE) => assertPointerUnmoved(txOf(snap), { db, rid: RID, captured, code });

(async () => {

// ── 1. AN UNMOVED POINTER PASSES, AND RETURNS THE LIVE PAIR ───────────────────────────────────
{
  const live = await fence({ versionId: 'v-7', generation: 3 }, snapOf({ version: 'v-7', generation: 3 }));
  assert.strictEqual(live.version, 'v-7', 'the caller gets the pair it fenced against');
  assert.strictEqual(live.generation, 3);
  ok('an unmoved pointer passes and returns the live pair');
}

// ── 2. 🔴 THE REFUSAL TEXT IS UNCHANGED BY THE EXTRACTION ─────────────────────────────────────
/* The existing emulator cell matches on the code, but an operator reads the whole line. Extraction
   that quietly reworded it would pass that cell and degrade the thing a person actually uses. */
{
  await assert.rejects(() => fence({ versionId: 'v-7', generation: 3 }, snapOf({ version: 'v-9', generation: 4 })),
    (e) => {
      assert.strictEqual(e.message, `identity_reconcile_pointer_moved: ${RID} — judged against v-7@3, now ${JSON.stringify('v-9')}@4`,
        '🔴 the extraction changed the refusal an operator reads');
      return true;
    });
  ok('a moved pointer refuses with the ORIGINAL text, byte for byte');
}

// ── 3. 🔴 BOTH HALVES OF THE PAIR ARE COMPARED ────────────────────────────────────────────────
/* They are carried as a pair because two reads can tear. Comparing one re-opens the gap the pair
   exists to close — and each half moving alone is a real scenario: a re-publish of the same version
   bumps the generation, a flip to a new version at the same generation is a rollback. */
{
  await assert.rejects(() => fence({ versionId: 'v-7', generation: 3 }, snapOf({ version: 'v-7', generation: 4 })),
    /judged against v-7@3, now "v-7"@4/, '🔴 the GENERATION moved and the fence did not notice');
  await assert.rejects(() => fence({ versionId: 'v-7', generation: 3 }, snapOf({ version: 'v-8', generation: 3 })),
    /judged against v-7@3, now "v-8"@3/, '🔴 the VERSION moved and the fence did not notice');
  ok('either half moving alone refuses — version and generation are both compared');
}

// ── 4. 🔴 A MISSING BASELINE IS AN ERROR AT THE FIRST CALL, NOT A SILENT PASS ─────────────────
/* This is the failure mode the ruling was written around. writeVersion accepted a `stamps` map that
   nothing supplied; it hid a production lockout for four slices while every cell stayed green. An
   optional baseline here would do the same: every call passes, the fence protects nothing. */
{
  for (const bad of [undefined, null, 'v-7', 42]) {   // not an object at all: nobody captured anything
    await assert.rejects(() => fence(bad, snapOf({ version: 'v-7', generation: 3 })),
      /no captured \{version, generation\} at all/,
      `🔴 the fence ran with no captured pair (${JSON.stringify(bad)}) — it would pass every call and protect nothing`);
  }
  ok('no baseline at all → refused at the first call, in the caller\'s own error namespace');
}

// ── 5. 🔴 HALF A PAIR IS NOT A BASELINE ───────────────────────────────────────────────────────
/* The likeliest real shape of the bug: a caller reshapes the pair in transit and drops one half, or
   passes a pre-P1 pointer whose version is null. Both must refuse rather than compare against
   nothing — a generation of 0 is what every pre-cutover claim compares equal to. */
{
  const halves = [
    [{ versionId: 'v-7' }, 'generation missing'],
    [{ generation: 3 }, 'version missing'],
    [{ versionId: null, generation: 3 }, 'null version but a non-zero generation — a torn pair'],
    [{ versionId: 'v-7', generation: null }, 'generation null'],
    [{ versionId: 'v-7', generation: '3' }, 'generation as a string'],
    [{ versionId: 'v-7', generation: 1.5 }, 'generation not an integer'],
    [{ version: 42, generation: 1 }, 'version present but not a name — corruption, not a baseline'],
    [{ version: {}, generation: 1 }, 'version present as an object'],
    [{ versionId: 'v-7', generation: -1 }, 'negative generation'],
    [{ versionId: '', generation: 3 }, 'empty version'],
  ];
  for (const [captured, why] of halves) {
    await assert.rejects(() => fence(captured, snapOf({ version: 'v-7', generation: 3 })),
      /_no_baseline/, `🔴 a half-formed baseline was accepted (${why}) — it would fence against nothing`);
  }
  ok(`${halves.length} half-formed baselines each refuse rather than comparing against nothing`);
}

// ── 6. BOTH FIELD SPELLINGS OF THE PAIR ARE ACCEPTED ──────────────────────────────────────────
/* The tree carries both: identity-bootstrap's `active` names it `versionId`, readPointerSnap returns
   `version`. Accepting either keeps callers from reshaping a pair in transit, which is how a pair
   stops being a pair — but it must be the same value, not a second source of truth. */
{
  const a = await fence({ versionId: 'v-7', generation: 3 }, snapOf({ version: 'v-7', generation: 3 }));
  const b = await fence({ version: 'v-7', generation: 3 }, snapOf({ version: 'v-7', generation: 3 }));
  assert.deepStrictEqual(a, b, 'both spellings name the same baseline');
  await assert.rejects(() => fence({ version: 'v-8', generation: 3 }, snapOf({ version: 'v-7', generation: 3 })),
    /judged against v-8@3/, 'and the `version` spelling is really compared, not ignored');
  ok('`versionId` and `version` are the same pair under two names already in the tree');
}

// ── 7. 🔴 THE FENCE MUST READ INSIDE THE TRANSACTION ──────────────────────────────────────────
/* A read outside the transaction checks a value that can change before the write lands — the fence
   would report on a pointer that was current at some earlier instant, which is the very gap it
   exists to close. */
{
  for (const bad of [undefined, null, {}, { get: 'not a function' }]) {
    await assert.rejects(() => assertPointerUnmoved(bad, { db, rid: RID, captured: { versionId: 'v-7', generation: 3 }, code: CODE }),
      /_not_a_transaction/, `🔴 the fence accepted a non-transaction (${JSON.stringify(bad)}) — it would check a value that can still change`);
  }
  ok('a non-transaction refuses — the re-read must happen where the write happens');
}

// ── 8. 🔴 EVERY CALL SITE NAMES ITS OWN REFUSAL ───────────────────────────────────────────────
/* Four writers will share this. One shared error string would tell an operator that A fence refused
   and not WHICH, across writers with very different consequences — an hourly sweep aborting is not a
   publish failing. */
{
  await assert.rejects(() => fence({ versionId: 'v-7', generation: 3 }, snapOf({ version: 'v-9', generation: 4 }), 'identity_sweep_pointer_moved'),
    /^Error: identity_sweep_pointer_moved: /, 'the caller\'s code prefixes the refusal — a shared string would tell an operator that A fence refused, not which');
  for (const bad of [undefined, '', null, 7]) {
    await assert.rejects(() => assertPointerUnmoved(txOf(snapOf({ version: 'v-7', generation: 3 })), { db, rid: RID, captured: { versionId: 'v-7', generation: 3 }, code: bad }),
      /identity_fence_no_code/, '🔴 a call site without its own refusal code was allowed');
  }
  ok('each call site supplies its own refusal code, and an unnamed one is refused');
}

// ── 9. 🔴 A CORRUPT POINTER SURFACES AS CORRUPTION, NOT AS A MOVE ─────────────────────────────
/* readPointerSnap is the single interpretation site and refuses a present-but-unusable version or
   generation. Those must not be flattened into "the pointer moved", which would send an operator to
   look for a concurrent publish that never happened. */
{
  await assert.rejects(() => fence({ versionId: 'v-7', generation: 3 }, snapOf({ version: 42, generation: 3 })),
    /active_version_malformed/, '🔴 a corrupt version was reported as a move');
  await assert.rejects(() => fence({ versionId: 'v-7', generation: 3 }, snapOf({ version: 'v-7', generation: 'x' })),
    /active_pointer_malformed/, '🔴 a corrupt generation was reported as a move');
  ok('a corrupt pointer refuses AS corruption — not flattened into "it moved"');
}

// ── 10. 🔴 AN ABSENT POINTER IS A MOVE FROM A NAMED BASELINE, NOT A PASS ──────────────────────
/* Deleting the document is the documented recovery for a versionless pointer. A caller that captured
   a real version must not sail through afterwards. */
{
  await assert.rejects(() => fence({ versionId: 'v-7', generation: 3 }, { exists: false, data: () => ({}) }),
    /judged against v-7@3, now null@0/, '🔴 the pointer was DELETED and the fence passed');
  ok('an absent pointer refuses against a named baseline, naming null@0');
}

// ── 11. BRAND-AGNOSTIC — no rid branch anywhere in the fence ──────────────────────────────────
/* v7.1 is explicit that the fence is scoped, never the brand. The D5 work exists partly to delete
   `rid === 'x_pizza'` ternaries; adding one here would put it back. */
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'identity-fence.js'), 'utf8');
  assert.ok(!/x_pizza|la_musa/.test(src), '🔴 the fence names a brand — it must be scoped by fence, never by brand');
  for (const rid of ['x_pizza', 'la_musa', 'some_new_brand']) {
    await assert.rejects(() => assertPointerUnmoved(txOf(snapOf({ version: 'v-9', generation: 4 })), { db, rid, captured: { versionId: 'v-7', generation: 3 }, code: CODE }),
      new RegExp(`^Error: ${CODE}: ${rid} — `), `every brand refuses identically (${rid})`);
  }
  ok('the fence is brand-agnostic: no brand literal, and three brands refuse identically');
}

// ── 11b. 🔴 THE PRE-P1 PAIR IS A BASELINE; ABSENT IS NOT — AND THE TREE ALREADY SAID SO ───────
/* My first cut refused {version: null, generation: 0}, reasoning that a fence against an unnamed
   version cannot refuse anything. Wrong, and the tree already carried the right rule: writeVersion's
   baseline check requires the KEY while allowing the value to be null, and its comment says it
   outright — "a FIRST publish, nothing active yet. Absent is not." Two validators for one concept had
   drifted apart within one slice, which is the same failure as three comment strippers.
   It CAN refuse: a caller that decided while nothing was published and then finds v-1@1 has been
   superseded by a first publish landing underneath it. Refusing the pair instead would mean no
   unpublished restaurant could ever mint. */
{
  assert.deepStrictEqual(baselineOf({ version: null, generation: 0 }, RID, CODE), { version: null, generation: 0 },
    '🔴 the pre-P1 pair was refused — an unpublished restaurant could never mint');

  // …and it still fences: a first publish landing underneath is caught.
  await assert.rejects(() => fence({ version: null, generation: 0 }, snapOf({ version: 'v-1', generation: 1 })),
    /judged against null@0, now "v-1"@1/, '🔴 a first publish landed under a caller that decided on an empty pointer, and the fence passed');
  // …and an unmoved empty pointer passes.
  const still = await fence({ version: null, generation: 0 }, { exists: false, data: () => ({}) });
  assert.strictEqual(still.version, null, 'nothing published, nothing moved → passes');

  /* 🔴 THE PIN IS EXECUTED, NOT GREPPED — AND THE CLAIM IT MAKES IS NOW TRUE. The first version
     matched a source REGEX and exercised only baselineOf, so a reviewer mutated writeVersion's guard
     to reject EVERY baseline and all thirteen cells still passed. A pin that cannot fail is the exact
     shape this project keeps finding, and this one existed to prevent drift while being unable to
     detect it.
     🔴 AND "THEY AGREE ON EVERY SHAPE" WAS FALSE. Executed side by side, the fence is STRICTER:
     writeVersion ACCEPTS {version: 42}, {version: undefined} and {version: null, generation: 3};
     the fence refuses all three as corruption or a torn pair. That is the right direction for a
     fence — it is deciding whether to WRITE against a baseline, not merely recording one — but the
     claim of parity was wrong, so the assertion is now about the DIRECTION, which is checkable. */
  /* 🔴 THE THREE REFUSALS SAY DIFFERENT THINGS, because they send an operator to different places:
     "nobody captured a pair" is a CALLER bug, "what you captured is not a version" is CORRUPTION in
     what was read, "no version but generation 3" is a TORN pair. A later check happens to catch all
     three inputs, so without this the earlier ones can be deleted and every case still refuses — with
     the wrong sentence. e2c-04 is exactly that mutant, and it SURVIVED twice: once before these
     assertions existed, and again when rewriting the cell above silently removed them. */
  const msgOf = (pair) => { try { baselineOf(pair, RID, CODE); return '(accepted)'; } catch (e) { return e.message; } };
  assert.match(msgOf({ generation: 0 }), /no version key at all/,
    '🔴 an absent baseline is diagnosed as corruption instead of as a caller that never captured one');
  assert.match(msgOf({ version: 42, generation: 1 }), /neither a name nor null/,
    '🔴 a corrupt version is diagnosed as a missing key instead of as corruption');
  assert.match(msgOf({ version: null, generation: 3 }), /claims generation 3/,
    '🔴 a torn pair is not diagnosed as a torn pair');

  const { writeVersion } = require('./catalog-publish');
  const { makeDb } = require('./firestore-fake');
  const writeVersionAccepts = async (baseline) => {
    try {
      await writeVersion(makeDb(), 'la_musa', { items: [], extras: {}, baseline }, new Date().toISOString());
      return true;                                   // got past the baseline guard (it fails later, on content)
    } catch (e) {
      if (/write_version_no_baseline/.test(String(e && e.message))) return false;
      return true;                                   // refused for some OTHER reason — the baseline passed
    }
  };
  const fenceAccepts = (b) => { try { baselineOf(b, RID, CODE); return true; } catch { return false; } };

  /* Executing writeVersion's REAL guard: mutate it and this cell fails, which is what a pin means. */
  assert.strictEqual(await writeVersionAccepts({ version: null, generation: 0 }), true,
    '🔴 writeVersion no longer accepts the pre-P1 pair — the rule the fence was aligned to has changed');
  assert.strictEqual(await writeVersionAccepts({ generation: 0 }), false,
    '🔴 writeVersion no longer refuses an ABSENT version key — the rule the fence was aligned to has changed');
  assert.strictEqual(await writeVersionAccepts(undefined), false,
    '🔴 writeVersion no longer refuses a missing baseline entirely');

  /* The relationship, asserted as a DIRECTION rather than as equality: everything the fence accepts,
     writeVersion accepts too. The converse does not hold, deliberately. */
  /* 🔴 THE DIRECTION HOLDS OVER THE NORMALISED PAIR, NOT OVER THE RAW INPUT, and my first version of
     this claim was overbroad. The fence accepts BOTH spellings of the pair — `versionId` (what
     identity-bootstrap's `active` carries) and `version` (what readPointerSnap returns) — while
     writeVersion tests hasOwnProperty('version') and therefore REJECTS {versionId:'v-1',generation:1}.
     So "everything the fence accepts, writeVersion accepts" is false over raw inputs, and asserting it
     would have forced the fence to reject a spelling the tree actually uses.
     What IS true, and is the property worth having: the fence never PRODUCES a baseline writeVersion
     would reject. baselineOf normalises to {version, generation}, and that normalised pair is what any
     caller would hand on. */
  const shapes = [
    { version: null, generation: 0 }, { version: 'v-1', generation: 0 }, { version: 'v-1', generation: 7 },
    { versionId: 'v-1', generation: 1 }, { versionId: null, generation: 0 },
    { version: 42, generation: 1 }, { version: undefined, generation: 0 }, { version: null, generation: 3 },
    { generation: 0 }, { version: 'v-1' }, { version: 'v-1', generation: -1 }, undefined, null, 'v-1',
  ];
  const stricter = [];
  for (const shape of shapes) {
    let normalised = null;
    try { normalised = baselineOf(shape, RID, CODE); } catch { normalised = null; }
    if (normalised) {
      assert.ok(await writeVersionAccepts(normalised),
        `🔴 the fence PRODUCED a baseline writeVersion refuses (${JSON.stringify(shape)} → ${JSON.stringify(normalised)}) — a caller handing it on would be refused by the version writer`);
    } else if (await writeVersionAccepts(shape)) {
      stricter.push(JSON.stringify(shape));
    }
  }
  assert.deepStrictEqual(stricter.sort(), ['{"generation":0}', '{"version":42,"generation":1}', '{"version":null,"generation":3}'].sort(),
    '🔴 the set of shapes where the fence is STRICTER changed — state the difference rather than claiming a parity that is not true');

  /* …and the spelling that disproved the naive claim, asserted explicitly so it cannot come back. */
  assert.ok(fenceAccepts({ versionId: 'v-1', generation: 1 }), 'the fence accepts the `versionId` spelling the tree uses');
  assert.strictEqual(await writeVersionAccepts({ versionId: 'v-1', generation: 1 }), false,
    'premise — writeVersion rejects that RAW spelling, which is why the direction is over the NORMALISED pair');
  assert.ok(await writeVersionAccepts(baselineOf({ versionId: 'v-1', generation: 1 }, RID, CODE)),
    '🔴 normalising does not make it acceptable — the direction claim has no true form');

  ok(`the pre-P1 pair is a baseline and still fences; absent is not; and the fence is a strict SUBSET of writeVersion's rule (stricter on ${stricter.length} shapes, executed not grepped)`);
}

// ── 12. baselineOf IS PURE AND TOTAL ──────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(baselineOf({ versionId: 'v-1', generation: 0 }, RID, CODE), { version: 'v-1', generation: 0 },
    'generation 0 is a legitimate baseline — it is the pre-P1 value and must be fenceable');
  assert.throws(() => baselineOf({}, RID, CODE), /_no_baseline/);
  ok('baselineOf normalises a usable pair and refuses everything else');
}

// ── 14. 🔴 THE FENCE IS WIRED INTO retireIdentity, not merely available to it ─────────────────
/* Every cell above drives the fence PRIMITIVE. All of them pass if no writer ever calls it — which is
   how a guard ends up perfect and unreachable. retireIdentity is the destructive writer (status
   RETIRED plus a DELETE of the reverse row) and Slice F's rollback has to restore the same
   identities, so a retirement landing against a moved baseline is the tear this exists for.
   It has no production caller today; fencing it now is the cheapest moment, and fail-closed means F
   cannot wire it unfenced by accident. It does NOT swallow: there is no caller to decide that for. */
{
  const { makeDb } = require('./firestore-fake');
  const { ensureIdentity, retireIdentity } = require('./identity-registry');
  const { activePointerRef } = require('./catalog-firestore');
  const RID2 = 'la_musa';

  const mk = async (pointer) => {
    const db = makeDb();
    await activePointerRef(db, RID2).set(pointer);
    const a = await ensureIdentity(db, { rid: RID2, kind: 'dish', legacyKey: 'dimsum_07', captured: pointer });
    return { db, id: a.canonical_id };
  };

  // …it refuses when the pointer moved since the caller decided.
  {
    const { db, id } = await mk({ version: 'v-1', generation: 1 });
    await activePointerRef(db, RID2).set({ version: 'v-2', generation: 2 });
    await assert.rejects(() => retireIdentity(db, { rid: RID2, kind: 'dish', canonicalId: id, captured: { version: 'v-1', generation: 1 } }),
      /identity_retire_pointer_moved: la_musa — judged against v-1@1, now "v-2"@2/,
      '🔴 a retirement landed against a superseded baseline — Slice F could not restore what it retired');
    const after = await db.collection('restaurants').doc(RID2).collection('identity').doc('dish').collection('ids').doc(id).get();
    assert.strictEqual((after.data() || {}).status, 'live', 'and nothing was retired');
  }

  // …it refuses with NO captured pair at all, rather than defaulting to something.
  {
    const { db, id } = await mk({ version: 'v-1', generation: 1 });
    await assert.rejects(() => retireIdentity(db, { rid: RID2, kind: 'dish', canonicalId: id }),
      /identity_retire_pointer_moved_no_baseline/,
      '🔴 retireIdentity ran with no baseline — the fence would pass every call and protect nothing');
  }

  // …and it still retires when the pointer has not moved, so the fence is not a blanket refusal.
  {
    const { db, id } = await mk({ version: 'v-1', generation: 1 });
    const r = await retireIdentity(db, { rid: RID2, kind: 'dish', canonicalId: id, captured: { version: 'v-1', generation: 1 } });
    assert.strictEqual(r.retired, true, '🔴 an unmoved pointer refused a legitimate retirement');
    assert.strictEqual(r.legacy_key, 'dimsum_07', 'and it reports what it retired');
  }

  /* 🔴 THE REFUSAL CARRIES THE SHARED MARKER, so the publish-side log switch routes it as SUPERSEDED
     rather than as something broken, without anyone remembering to add this writer to that switch. */
  assert.match('identity_retire_pointer_moved: x — judged', /_pointer_moved:/, 'the code carries the shared fence marker');
  ok('retireIdentity is fenced: a moved pointer refuses, a missing baseline refuses, an unmoved one still retires');
}

console.log(`\n${n} cells passed`);
})().catch((e) => { console.error(e); process.exit(1); });
