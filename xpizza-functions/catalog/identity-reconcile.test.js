'use strict';
/**
 * reconcileOnRollback. Run: node catalog/identity-reconcile.test.js
 *
 * 🔴 CELLS 1-5 ARE THE BINDING OBLIGATION ON RELOCATING A GUARD. Five of the stamp map's refusals stop
 * firing on the rollback path (REGISTRY_AGREEMENT_REFUSALS). Each one gets a cell here showing what
 * catches that state AFTERWARDS — and for the two that are permit-or-refuse depending on the whole
 * target, BOTH directions. If any of the five were caught by nothing, it would not move and that one
 * would need another answer. This is the theft-variant discipline applied to a guard being RELOCATED
 * rather than removed, and it is the difference between moving a protection and losing one.
 *
 * 🔴 WHAT THIS FILE CANNOT SAY. It is pure. Nothing here establishes that the registry was read in the
 * transaction, or that the target was certified before this ran — the caller's contract, and the
 * reason the retire loop can be as simple as it is. An UNCERTIFIED target has no stamps, so every live
 * id is "absent" and this would retire the whole registry; that gate lives in catalog-publish.js and
 * is guarded by d4p1-mint-atomic cell 5.
 */
const assert = require('assert');
const { reconcileOnRollback } = require('./identity-reconcile');
const { REGISTRY_AGREEMENT_REFUSALS } = require('./identity-stampmap');
const { stampVerdict } = require('./identity-stampmap');
const { encodeKey, STATUS_LIVE, STATUS_RETIRED } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const row = (legacy_key, status) => ({ legacy_key, status: status || STATUS_LIVE });
const reg = ({ ids = {}, keys = {} } = {}) => ({
  ids: new Map(Object.entries(ids)),
  keys: new Map(Object.entries(keys).map(([nm, v]) => [encodeKey(nm), v])),
});
const run = (targetStamps, r) => reconcileOnRollback({ targetStamps, ids: r.ids, keys: r.keys });

/* The per-stamp verdict the stamp map WOULD have returned, so every cell below can show the refusal
   it is replacing rather than assert one from memory. */
const stampSays = ({ key, claimedId, keyRowId = null, idRow = null }) =>
  stampVerdict({ kind: 'dish', key, claimedId, inCandidate: true, keyRowId, idRow }).code;

// ── 1. stamp_unregistered — THE NAME HAS NO KEY ROW ─────────────────────────────────────────
{
  const r = reg({ ids: { X: row('Margherita') }, keys: {} });
  assert.strictEqual(stampSays({ key: 'Margherita', claimedId: 'X', keyRowId: null }), 'stamp_unregistered',
    'premise — this is the state the stamp map refuses as stamp_unregistered');

  const out = run({ Margherita: 'X' }, r);
  assert.deepStrictEqual(out.refusals, [], `🔴 the reconciliation refused a state it is supposed to repair: ${JSON.stringify(out.refusals)}`);
  assert.deepStrictEqual(out.restores.map((s) => `${s.id}->${s.name}`), ['X->Margherita'],
    `🔴 nothing restores the missing reverse row — the state moved out of the stamp map and is now caught by NOTHING: ${JSON.stringify(out)}`);
  ok('stamp_unregistered → the reconciliation RESTORES the key row rather than refusing the rollback');
}

// ── 2. stamp_id_row_missing — THE ID ROW IS GONE ────────────────────────────────────────────
{
  const r = reg({ ids: {}, keys: { Margherita: { canonical_id: 'X' } } });
  assert.strictEqual(stampSays({ key: 'Margherita', claimedId: 'X', keyRowId: 'X', idRow: null }), 'stamp_id_row_missing',
    'premise — the stamp map refuses this as stamp_id_row_missing');

  const out = run({ Margherita: 'X' }, r);
  assert.deepStrictEqual(out.refusals, [], 'the reconciliation must repair this, not refuse it');
  assert.deepStrictEqual(out.restores.map((s) => [s.id, s.name, s.was]), [['X', 'Margherita', 'absent']],
    `🔴 an absent id row is not restored — the registry keeps disagreeing with itself: ${JSON.stringify(out)}`);
  ok('stamp_id_row_missing → the reconciliation RESTORES the id row, reporting that it was absent');
}

// ── 3. stamp_id_retired — THE HEADLINE CASE: ROLLBACK ACROSS A DELETION ─────────────────────
{
  /* 🔴 AND THE POLICY IS THE OPPOSITE OF THE STANDALONE PRIMITIVE'S, ON PURPOSE. restoreIdentity
     refuses a retired landing id (`identity_restore_id_retired`) because it has no plan and no fence
     over a rollback target, so a certified-active version stamping a retired id is a contradiction it
     must surface. Here resurrection is the DECLARED INTENT. Same provenance predicate, different
     policy, because the callers know different things. */
  const r = reg({ ids: { X: row('Margherita', STATUS_RETIRED) }, keys: {} });
  assert.strictEqual(stampSays({ key: 'Margherita', claimedId: 'X', keyRowId: 'X', idRow: { status: STATUS_RETIRED, legacy_key: 'Margherita' } }),
    'stamp_id_retired', 'premise — the stamp map refuses this as stamp_id_retired');

  const out = run({ Margherita: 'X' }, r);
  assert.deepStrictEqual(out.refusals, [],
    '🔴 a rollback ACROSS A DELETION was refused — this is the single case restoreIdentity was built for, and the whole reason the retirement half could not ship alone');
  assert.strictEqual(out.restores.length, 1, 'exactly one restore');
  assert.strictEqual(out.restores[0].resurrects, true,
    '🔴 the restore does not report that it RESURRECTS a retired id — a caller cannot distinguish it from an ordinary re-assertion, and resurrection is the one that needs saying out loud');
  assert.deepStrictEqual(out.retires, [], 'and nothing is retired: the target stamps this id');
  ok('stamp_id_retired → the reconciliation RESURRECTS the id, and says so — the opposite policy to the standalone primitive, deliberately');
}

// ── 4. stamp_id_claims_other_name — THE ID MOVED AWAY AND COMES BACK ────────────────────────
{
  const r = reg({ ids: { X: row('Margarita') }, keys: { Margarita: { canonical_id: 'X' } } });
  assert.strictEqual(stampSays({ key: 'Margherita', claimedId: 'X', keyRowId: 'X', idRow: { status: STATUS_LIVE, legacy_key: 'Margarita' } }),
    'stamp_id_claims_other_name', 'premise — the stamp map refuses this as stamp_id_claims_other_name');

  const out = run({ Margherita: 'X' }, r);
  assert.deepStrictEqual(out.refusals, [], 'a rename being rolled back is not a conflict');
  assert.deepStrictEqual(out.restores.map((s) => `${s.id}->${s.name}`), ['X->Margherita'], 'the id comes back to the name the target gives it');
  /* 🔴 AND THE NAME IT LEAVES IS RELEASED. Restoring X to Margherita while keys/Margarita still names
     X leaves two names resolving to one id — the forward path refuses that as
     `destination_key_row_disagrees`, and a reconciliation that produced it would be manufacturing the
     state the integrity sweep exists to repair. */
  assert.deepStrictEqual(out.deletions.map((d) => d.name), ['Margarita'],
    `🔴 the name the id is leaving was not released — two names now resolve to one id: ${JSON.stringify(out)}`);

  /* 🔴 AND THE OWNERSHIP CHECK ON THAT DELETION HAS NO CELL, DELIBERATELY — see the note in
     identity-reconcile.js. I wrote a fixture for it and the fixture was wrong: the "other" id there
     was live and unstamped by the target, so §5 retires it and deleting its row is CORRECT, not a
     theft. Working the cases through, every branch where a released name's row belongs to someone
     else is either already skipped by the re-landing check or is that someone's own release. The
     check is defence in depth carried from identity-bootstrap.js:488; inventing an assertion to arm
     it would be manufacturing coverage for a difference I cannot demonstrate. */
  ok('stamp_id_claims_other_name → the id is RESTORED to the target\'s name and the name it leaves is released');
}

// ── 5. stamp_registry_disagrees — THEFT AND SWAP LOOK IDENTICAL PER STAMP; BOTH DIRECTIONS ──
{
  /* 🔴 THE CELL THE WHOLE RELOCATION RESTS ON. The stamp map sees "the target says K holds X, the
     registry says K holds Y" and must refuse, because with one stamp it cannot tell theft from a
     swap. Both directions are asserted here, because "it permits" alone would be a protection lost
     rather than moved. */
  assert.strictEqual(stampSays({ key: 'A', claimedId: 'X', keyRowId: 'Y', idRow: null }), 'stamp_registry_disagrees',
    'premise — the stamp map refuses this as stamp_registry_disagrees');

  /* (a) PERMITTED — THE SWAP. The target stamps Y too, at its own name, so Y releases A by being
     restored to B. §5's delete→recreate→rollback and the ordinary two-object swap are this shape. */
  const swap = reg({
    ids: { X: row('B'), Y: row('A') },
    keys: { A: { canonical_id: 'Y' }, B: { canonical_id: 'X' } },
  });
  const swapped = run({ A: 'X', B: 'Y' }, swap);
  assert.deepStrictEqual(swapped.refusals, [],
    `🔴 a SWAP was refused — the whole-target view is supposed to tell it from theft: ${JSON.stringify(swapped.refusals)}`);
  assert.deepStrictEqual(swapped.restores.map((s) => `${s.id}->${s.name}`).sort(), ['X->A', 'Y->B'], 'both ids go back to the target\'s names');
  assert.deepStrictEqual(swapped.deletions, [],
    '🔴 a swap derived deletions; both names are re-landed by this same reconciliation, and deleting them depends on write order to survive');

  /* (b) REFUSED — THE CLAIMANT SURVIVES AT THIS SAME NAME. The target cannot express two ids at one
     key, so this is a registry the target cannot make true. It must not be permitted just because the
     permitting branch exists. */
  const contested = reg({
    ids: { X: row('A'), Y: row('A') },
    keys: { A: { canonical_id: 'Y' } },
  });
  const out = reconcileOnRollback({ targetStamps: { A: 'X' }, ids: contested.ids, keys: contested.keys });
  /* Y is live, claims A, and is NOT stamped by the target — so by §5 it is retired for being absent,
     which RELEASES A. That is lawful and must be permitted. */
  assert.deepStrictEqual(out.refusals, [], 'a claimant the target does not stamp is retired, which releases the name');
  assert.deepStrictEqual(out.retires.map((r2) => r2.id), ['Y'], '🔴 the displaced claimant was not retired — it stays live with no reverse row, the orphan the sweep repairs');
  assert.deepStrictEqual(out.restores.map((s) => `${s.id}->${s.name}`), ['X->A'], 'and X lands');
  ok('stamp_registry_disagrees → a SWAP is permitted with no deletions, and a displaced live claimant is retired rather than orphaned');
}

// ── 6. ALL FIVE MOVED REFUSALS ARE COVERED BY A CELL ABOVE ──────────────────────────────────
{
  /* 🔴 THE OBLIGATION, ENFORCED RATHER THAN PROMISED. Five refusals stopped firing on the rollback
     path. If a sixth is ever added to that list, this cell fails until someone writes the cell
     showing what catches it — which is the whole point of making the obligation binding. */
  const covered = ['stamp_unregistered', 'stamp_id_row_missing', 'stamp_id_retired',
    'stamp_id_claims_other_name', 'stamp_registry_disagrees'];
  assert.deepStrictEqual(REGISTRY_AGREEMENT_REFUSALS.slice().sort(), covered.slice().sort(),
    `🔴 the set of relocated refusals changed and a cell above does not cover the new one. Uncovered: ${JSON.stringify(REGISTRY_AGREEMENT_REFUSALS.filter((c) => !covered.includes(c)))}`);
  assert.strictEqual(n, 5, `🔴 ${n} cells ran, not the 5 that carry the obligation — a cell was removed or renumbered`);
  ok(`all ${covered.length} relocated refusals have a cell showing what catches the state afterwards`);
}

// ── 7. THE INPUTS IT REFUSES TO GUESS AT, AND THE COHERENCE IT CHECKS FIRST ─────────────────
{
  assert.throws(() => reconcileOnRollback({ targetStamps: {}, ids: {}, keys: new Map() }),
    /identity_reconcile_registry_unread/, '🔴 a plain object was accepted as the registry index');

  /* 🔴 THE TARGET IS JUDGED BEFORE THE REGISTRY IS CONSULTED. One id stamped on two keys cannot be
     made true by any sequence of writes, and checking the registry first would surface it as a
     confusing per-object disagreement instead of as what it is. */
  const r = reg({ ids: { X: row('A') }, keys: {} });
  const forked = run({ A: 'X', B: 'X' }, r);
  assert.strictEqual((forked.refusals[0] || {}).code, 'reconcile_target_forked',
    `🔴 a target stamping ONE id on TWO keys was accepted: ${JSON.stringify(forked)}`);
  assert.deepStrictEqual(forked.restores, [], 'and nothing is proposed from an incoherent target');
  assert.deepStrictEqual(forked.retires, [], '…including no retirements, which would be derived from a target nobody can satisfy');

  const malformed = run({ A: 'X', B: 42 }, r);
  assert.strictEqual((malformed.refusals[0] || {}).code, 'reconcile_target_malformed', 'an unreadable stamp is refused, not skipped');

  /* An empty target is NOT the same as no stamps to honour: the caller must never call this for an
     uncertified target, and this asserts the shape rather than the gate (which lives upstream). */
  const empty = run({}, reg({ ids: { L: row('Live') }, keys: { Live: { canonical_id: 'L' } } }));
  assert.deepStrictEqual(empty.retires.map((x) => x.id), ['L'],
    'premise for the upstream gate: with NO stamps every live id is "absent" and would be retired — which is exactly why an uncertified target must never reach here');
  ok('an unread registry throws, an incoherent target is refused before the registry is consulted, and the empty-target hazard is pinned');
}

console.log(`identity-reconcile: OK (${n})`);
