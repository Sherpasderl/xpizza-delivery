'use strict';
/**
 * The stamp map and its re-verification — every branch, driven directly.
 * Run: node catalog/stamp-map.test.js
 *
 * 🔴 WHAT THE END-TO-END CELLS CANNOT REACH. d4p1-stamp-write drives the real writer against a real
 * registry, which is the only thing that proves the reads happen at all — but a real registry is hard
 * to hold in the states that matter here: a key row whose id row is missing, an id that is live but
 * claims a different name, a live pointer that cannot be read. Those are the registry disagreeing with
 * itself, and constructing them through the registry's own API means fighting the guards that exist to
 * prevent them. So the predicate is pure and this drives every branch of it directly.
 *
 * The division is deliberate and is the one that has worked all through this slice: unit cells hold the
 * decision still, emulator cells prove the decision is actually consulted with real data.
 */
const assert = require('assert');
const { deriveStampMap, stampVerdict, fenceVerdict, judgeStampMap } = require('./identity-stampmap');
const { STATUS_LIVE, STATUS_RETIRED } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const liveRow = (key) => ({ status: STATUS_LIVE, legacy_key: key });
const good = (over = {}) => ({ kind: 'dish', key: 'Margherita', claimedId: 'X', inCandidate: true, keyRowId: 'X', idRow: liveRow('Margherita'), ...over });

// ── 1. THE HAPPY PATH, AND IT IS NOT VACUOUS ────────────────────────────────────────────────
{
  const v = stampVerdict(good());
  assert.strictEqual(v.ok, true, `🔴 a stamp the registry confirms was refused: ${v.code} ${v.detail}`);
  assert.strictEqual(v.code, 'verified', `expected verified, got ${v.code}`);
  ok('a stamp the registry confirms, on an object this candidate contains, is permitted');
}

// ── 2. 🔴 THE SWAP — THE CHECK THE PARTITION LAW STRUCTURALLY CANNOT MAKE ───────────────────
/* Two live objects exchange ids. C ⊆ A still holds exactly — same set, different owners — so the
   partition law sees nothing. Only asking the registry per NAME can tell that this id is not this
   object's. Without it a merchant-controlled `display` field becomes server certification for the
   wrong object, frozen into a create-only version. */
{
  const v = stampVerdict(good({ claimedId: 'Y', keyRowId: 'X', idRow: liveRow('Margherita') }));
  assert.strictEqual(v.ok, false, '🔴 a draft claiming ANOTHER live object\'s id was certified — the partition law cannot see this, and nothing else was looking');
  assert.strictEqual(v.code, 'stamp_registry_disagrees', `expected stamp_registry_disagrees, got ${v.code}`);
  assert.strictEqual(v.claimed, 'Y', 'the refusal names what the draft claimed');
  assert.strictEqual(v.registry, 'X', '…and what the registry actually holds, because that is the pair a human has to reconcile');
  ok('an id that belongs to a DIFFERENT name is refused — the swap the set-membership law is blind to');
}

// ── 3. A NAME THE REGISTRY HAS NEVER ISSUED AN ID FOR ───────────────────────────────────────
{
  /* 🔴 THE CODE IS THE ASSERTION THAT MATTERS HERE, so its message carries the property. Without the
     unregistered branch this still refuses — the next comparison is `null !== claimedId` — but as
     `stamp_registry_disagrees`, which tells a reader the registry holds some OTHER id for this name
     when in fact it holds none. A refusal that misdescribes the fault sends whoever reads the log
     looking for a conflict that does not exist. */
  const v = stampVerdict(good({ keyRowId: null }));
  assert.strictEqual(v.ok, false, '🔴 an id the server never issued was permitted outright');
  assert.strictEqual(v.code, 'stamp_unregistered',
    `🔴 an id the server never issued was accepted as certification, or misreported: refused as ${v.code}, which claims the registry holds a different id when it holds none`);
  ok('a name with no registry mapping refuses — the server never issued the id the draft carries');
}

// ── 4. 🔴 THE FORWARD ROW IS A POINTER, SO THE REVERSE ROW IS READ TOO ──────────────────────
/* bootstrap's assertKeyRowAgrees settled this division and it applies verbatim here: a key row can
   point at an id that is gone, retired, or has since been re-keyed, and from the forward side all
   three look perfectly healthy. Certifying any of them into an immutable version is uncorrectable. */
{
  const missing = stampVerdict(good({ idRow: null }));
  assert.strictEqual(missing.ok, false, '🔴 a key row pointing at an id row that does not exist was accepted');
  assert.strictEqual(missing.code, 'stamp_id_row_missing', `expected stamp_id_row_missing, got ${missing.code}`);

  const retired = stampVerdict(good({ idRow: { status: STATUS_RETIRED, legacy_key: 'Margherita' } }));
  assert.strictEqual(retired.ok, false, '🔴 a RETIRED id was certified into an immutable version — it can never be corrected there');
  assert.strictEqual(retired.code, 'stamp_id_retired', `expected stamp_id_retired, got ${retired.code}`);

  const elsewhere = stampVerdict(good({ idRow: liveRow('Napoletana') }));
  assert.strictEqual(elsewhere.ok, false, '🔴 an id whose own row claims a DIFFERENT name was certified for this one');
  assert.strictEqual(elsewhere.code, 'stamp_id_claims_other_name', `expected stamp_id_claims_other_name, got ${elsewhere.code}`);
  ok('a key row pointing at a missing, retired, or re-keyed id refuses by name — the forward row alone is never proof');
}

// ── 5. A MAP NAMING AN OBJECT THIS CANDIDATE DOES NOT CONTAIN ───────────────────────────────
{
  const v = stampVerdict(good({ inCandidate: false }));
  assert.strictEqual(v.ok, false, '🔴 a map resolved against a DIFFERENT draft was written into this version');
  assert.strictEqual(v.code, 'stamp_not_in_candidate', `expected stamp_not_in_candidate, got ${v.code}`);
  ok('a stamp for an object this candidate does not contain refuses — the map came from another draft');
}

// ── 6. MALFORMED INPUT FAILS CLOSED ─────────────────────────────────────────────────────────
{
  for (const [label, over] of [
    ['no kind', { kind: '' }],
    ['no key', { key: '' }],
    ['no claimed id', { claimedId: '' }],
    ['a non-string id', { claimedId: 7 }],
  ]) {
    const v = stampVerdict(good(over));
    assert.strictEqual(v.ok, false, `🔴 ${label} was permitted`);
    assert.strictEqual(v.code, 'stamp_input_malformed', `${label}: expected stamp_input_malformed, got ${v.code}`);
  }
  assert.strictEqual(stampVerdict().ok, false, '🔴 a call with no arguments did not fail closed');
  ok('four malformed shapes and a bare call all fail CLOSED');
}

// ── 7. THE FENCE — THREE PAIRS, AND EACH DISAGREEMENT HAS ITS OWN NAME ──────────────────────
/* The map is resolved against the pointer the partition law read; the candidate records the pointer
   read under the lease; and the live pointer is what is true at the write. All three must agree, and
   the two ways they can differ are different faults: one means an activation landed while the draft
   was being validated, the other means it landed while the version was being built. */
{
  const at = (version, generation) => ({ version, generation });

  const current = fenceVerdict({ baseline: at('v1', 3), live: at('v1', 3) });
  assert.strictEqual(current.ok, true, `🔴 an unmoved baseline was refused: ${current.code}`);

  const moved = fenceVerdict({ baseline: at('v1', 3), live: at('v1', 4) });
  assert.strictEqual(moved.ok, false, '🔴 a map bound to a baseline that is no longer live was written');
  assert.strictEqual(moved.code, 'stamp_fence_moved', `expected stamp_fence_moved, got ${moved.code}`);
  assert.strictEqual(moved.resolved_against, 'v1@3', 'the refusal names both pairs, because which one moved is the whole diagnosis');
  assert.strictEqual(moved.live, 'v1@4');

  /* 🔴 THE GENERATION ALONE IS ENOUGH. A rollback moves the pointer BACK to a version it has held
     before, so comparing versions would call v1@3 and v1@5 equal — the same blindness `seq` has, one
     layer up. */
  const sameVersion = fenceVerdict({ baseline: at('v1', 3), live: at('v1', 5) });
  assert.strictEqual(sameVersion.ok, false, '🔴 the SAME version at a newer generation was read as unmoved — a rollback-and-forward would slip straight through');

  // The pre-lease window: the law validated against one pair, the candidate was built against another.
  const elsewhere = fenceVerdict({ baseline: at('v2', 4), live: at('v2', 4), resolvedAgainst: at('v1', 3) });
  assert.strictEqual(elsewhere.ok, false, '🔴 a map validated against a menu that had already been replaced was written');
  assert.strictEqual(elsewhere.code, 'stamp_fence_resolved_elsewhere', `expected stamp_fence_resolved_elsewhere, got ${elsewhere.code}`);
  assert.strictEqual(fenceVerdict({ baseline: at('v2', 4), live: at('v2', 4), resolvedAgainst: at('v2', 4) }).ok, true,
    'sensitivity — the same three pairs, all equal, permits');

  assert.strictEqual(fenceVerdict({ baseline: null, live: at('v1', 3) }).code, 'stamp_fence_unbound',
    '🔴 a stamped version with no record of its baseline was permitted');
  assert.strictEqual(fenceVerdict({ baseline: at('v1', 3), live: null }).code, 'stamp_fence_unreadable',
    '🔴 an unreadable live pointer was treated as agreement');
  /* A FIRST publish has no active version: version null at generation 0 is a real pair, not a missing
     one, and it must pass — otherwise nothing can ever be stamped onto an empty restaurant. */
  assert.strictEqual(fenceVerdict({ baseline: at(null, 0), live: at(null, 0) }).ok, true,
    '🔴 a first publish (no active version, generation 0) was refused as unbound');
  ok('the fence: unmoved permits, a moved or elsewhere-resolved pair refuses by its own name, and a first publish still passes');
}

// ── 8. THE MAP IS DERIVED FROM WHAT THE DRAFT CARRIES — AND IS NULL WHEN IT CARRIES NOTHING ─
/* 🔴 NULL, NOT AN EMPTY MAP. writeVersion reads `!!stamps` as "certified", and `{dish:{},extra:{}}` is
   truthy — so a pre-cutover draft would have produced a version marked CERTIFIED with zero stamps,
   whose active certified set is empty. That is the A = ∅ state the publish lockout is made of: it
   would have moved the bug rather than fixed it. */
{
  assert.strictEqual(deriveStampMap({ items: [{ key: 'a' }, { key: 'b' }] }), null,
    '🔴 a draft carrying NO ids produced a map — a pre-cutover publish would be marked certified with nothing stamped');
  assert.strictEqual(deriveStampMap({}), null, 'an empty draft has no map');
  assert.strictEqual(deriveStampMap(), null, 'and neither does no draft at all');

  const m = deriveStampMap({
    items: [{ key: 'a', display: { identity_id: 'X' } }, { key: 'b' }, { display: { identity_id: 'Z' } }],
    extraRecords: [{ key: 'e1', display: { identity_id: 'E' } }],
  });
  assert.deepStrictEqual(m, { dish: { a: 'X' }, extra: { e1: 'E' } },
    '🔴 the map is not exactly the carried (key → id) pairs');
  assert.ok(!('b' in m.dish), 'an object carrying no id is absent — it is the unidentified bucket, which P1a does not mint');
  ok('the map is exactly the carried key→id pairs, EXTRAS included, and is null when the draft carries none');
}

// ── 9. THE WHOLE MAP — EVERY BAD ENTRY IS NAMED, NOT THE FIRST ──────────────────────────────
/* A merchant (or an operator reading the log) told about one wrong object at a time cannot see the
   shape of what happened: one moved id reads as a typo, five read as a client that has lost the
   mapping. */
{
  const judged = judgeStampMap({
    stamps: { dish: { a: 'BAD1', b: 'X2' }, extra: { e1: 'BAD3' } },
    candidateKeys: { dish: ['a', 'b'], extra: ['e1'] },
    registry: {
      dish: { a: { keyRowId: 'X1', idRow: liveRow('a') }, b: { keyRowId: 'X2', idRow: liveRow('b') } },
      extra: { e1: { keyRowId: 'E1', idRow: liveRow('e1') } },
    },
    baseline: { version: 'v1', generation: 2 }, live: { version: 'v1', generation: 2 },
  });
  assert.strictEqual(judged.empty, false);
  assert.strictEqual(judged.fence.ok, true, 'the fence is judged separately from the entries');
  const bad = judged.stamps.filter((e) => !e.verdict.ok);
  assert.deepStrictEqual(bad.map((e) => `${e.kind}/${e.key}`), ['dish/a', 'extra/e1'],
    '🔴 not every bad entry was reported — a caller can only name the first thing wrong');
  assert.strictEqual(judged.stamps.find((e) => e.key === 'b').verdict.ok, true, 'and the good one is still good');

  /* An EMPTY map is not verified and not fenced: it certifies nothing, so there is nothing to bind.
     That is the pre-cutover path, and making it pay for machinery it does not use is how the
     machinery gets removed. */
  const none = judgeStampMap({ stamps: null, baseline: null, live: null });
  assert.strictEqual(none.empty, true, 'an absent map is empty');
  assert.strictEqual(none.fence.ok, true, '🔴 an unstamped publish was fenced — the pre-cutover path must stay frictionless');
  assert.deepStrictEqual(none.stamps, [], 'and nothing is judged');
  ok('every bad entry is reported with its kind and key; an empty map is neither verified nor fenced');
}

// ── 10. PURE, AND IT MUTATES NOTHING IT IS ASKED TO JUDGE ───────────────────────────────────
{
  const input = { items: [{ key: 'a', display: { identity_id: 'X' } }] };
  const frozen = JSON.parse(JSON.stringify(input));
  deriveStampMap(input);
  assert.deepStrictEqual(input, frozen, '🔴 deriveStampMap MUTATED the draft it was reading');

  const args = good();
  const argsFrozen = JSON.parse(JSON.stringify(args));
  const a = stampVerdict(args); const b = stampVerdict(args);
  assert.deepStrictEqual(a, b, 'the same inputs give the same verdict');
  assert.deepStrictEqual(args, argsFrozen, '🔴 the predicate MUTATED its arguments');
  ok('derivation and verdict are both pure, and neither mutates its input');
}

console.log(`stamp-map: OK (${n})`);
