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

  /* 🔴 THE TWO VALIDATORS MUST AGREE. They are not merged here — unifying them touches the publish
     path and belongs in its own increment — so this pins them to each other instead, which is what
     stops the drift recurring silently. */
  const pub = require('fs').readFileSync(require('path').join(__dirname, 'catalog-publish.js'), 'utf8');
  const writeVersionRule = /!Object\.prototype\.hasOwnProperty\.call\(baseline, 'version'\)[\s\S]{0,120}?!Number\.isInteger\(baseline\.generation\) \|\| baseline\.generation < 0/;
  assert.ok(writeVersionRule.test(pub),
    '🔴 writeVersion\'s baseline rule changed shape — the fence was aligned to it and the two would now disagree');
  for (const pair of [{ version: null, generation: 0 }, { version: 'v-1', generation: 2 }]) {
    assert.doesNotThrow(() => baselineOf(pair, RID, CODE), `both validators accept ${JSON.stringify(pair)}`);
  }
  for (const pair of [{ generation: 0 }, { version: 'v-1' }, { version: 'v-1', generation: -1 }]) {
    assert.throws(() => baselineOf(pair, RID, CODE), /_no_baseline/, `both validators reject ${JSON.stringify(pair)}`);
  }

  /* 🔴 THE THREE REFUSALS SAY DIFFERENT THINGS, because they send an operator to different places.
     "Nobody captured a pair" is a CALLER bug — a call site that never took a baseline. "What you
     captured is not a version" is CORRUPTION in what was read. "No version but generation 3" is a
     TORN pair. A later check happens to catch all three inputs, so without this the earlier checks
     can be deleted and every case still refuses — with the wrong sentence. That is precisely the
     mutant that survived here: refusal preserved, diagnosis lost. */
  const msgOf = (pair) => { try { baselineOf(pair, RID, CODE); return '(accepted)'; } catch (e) { return e.message; } };
  assert.match(msgOf({ generation: 0 }), /no version key at all/,
    '🔴 an absent baseline is diagnosed as corruption instead of as a caller that never captured one');
  assert.match(msgOf({ version: 42, generation: 1 }), /neither a name nor null/,
    '🔴 a corrupt version is diagnosed as a missing key instead of as corruption');
  assert.match(msgOf({ version: null, generation: 3 }), /claims generation 3/,
    '🔴 a torn pair is not diagnosed as a torn pair');
  ok('the pre-P1 pair is a baseline and still fences; absent is not; and the fence agrees with writeVersion\'s rule');
}

// ── 12. baselineOf IS PURE AND TOTAL ──────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(baselineOf({ versionId: 'v-1', generation: 0 }, RID, CODE), { version: 'v-1', generation: 0 },
    'generation 0 is a legitimate baseline — it is the pre-P1 value and must be fenceable');
  assert.throws(() => baselineOf({}, RID, CODE), /_no_baseline/);
  ok('baselineOf normalises a usable pair and refuses everything else');
}

console.log(`\n${n} cells passed`);
})().catch((e) => { console.error(e); process.exit(1); });
