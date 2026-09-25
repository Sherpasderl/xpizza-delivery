'use strict';
/**
 * derivePlan — the activation plan read off the candidate and the registry.
 * Run: node catalog/identity-derive.test.js
 *
 * 🔴 EVERY CELL VERIFIES THE PLAN IT DERIVED. A derivation that produced a plan verifyPlan refuses is
 * a derivation bug reported as a plan bug, and the two are found in different places. Running the
 * verifier inside these cells is also the composition the writer will perform, so a disagreement
 * between the two files shows up HERE rather than inside a transaction.
 *
 * 🔴 WHAT THIS FILE CANNOT SAY. derivePlan is pure. Nothing here establishes that the registry it is
 * handed was read inside the transaction, before the first write, or in full — the caller's
 * properties, and the writer's own emulator cells must carry them. Said so the green below is not
 * mistaken for evidence about the flip.
 */
const assert = require('assert');
const { derivePlan } = require('./identity-derive');
const { verifyPlan } = require('./identity-plan');
const { encodeKey, STATUS_LIVE, STATUS_RETIRED } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const idRow = (legacy_key, status) => ({ legacy_key, status: status || STATUS_LIVE });
const mk = ({ ids = {}, keys = {} } = {}) => ({
  ids: new Map(Object.entries(ids)),
  keys: new Map(Object.entries(keys).map(([name, v]) => [encodeKey(name), v])),
});
/* A counting allocator: the cells can tell how many ids were minted, and a mint that should not have
   happened shows up as a name rather than as a silent extra row. */
const allocator = () => { let i = 0; const fn = (key) => { i += 1; fn.calls.push(key); return `NEW-${key}`; }; fn.calls = []; return fn; };

const derive = (opts, reg) => derivePlan({ ids: reg.ids, keys: reg.keys, ...opts });
/* Every cell runs this. A derived plan that the verifier refuses is a bug in THIS file. */
const mustVerify = (plan, reg, why) => {
  const v = verifyPlan(plan, { ids: reg.ids, keys: reg.keys, complete: true });
  assert.strictEqual(v.ok, true, `🔴 the DERIVED plan was refused by verifyPlan (${why}): ${v.code} — ${v.detail}`);
  return v;
};

// ── 1. A RENAME PRESERVES THE ID — THE WHOLE POINT OF D4-P1 ──────────────────────────────────
{
  const reg = mk({ ids: { X: idRow('Margherita') }, keys: { Margherita: { canonical_id: 'X' } } });
  const alloc = allocator();
  const plan = derive({ candidateKeys: new Set(['Margarita']), stamps: { Margarita: 'X' }, allocate: alloc }, reg);

  assert.deepStrictEqual(plan.moves, [{ id: 'X', from: 'Margherita', to: 'Margarita' }],
    `🔴 a rename did not derive a MOVE: ${JSON.stringify(plan)}`);
  assert.deepStrictEqual(plan.mints, [], '🔴 a rename MINTED a second identity — the id was not preserved, which is the whole thing this slice exists to prevent');
  assert.deepStrictEqual(alloc.calls, [], '…and the allocator was never even reached');
  const v = mustVerify(plan, reg, 'a plain rename');
  assert.deepStrictEqual(v.deletions.map((d) => d.name), ['Margherita'], 'the old key row is released, exactly once');
  ok('a renamed object MOVES its existing id and mints nothing — the rename preserves the identity');
}

// ── 2. AN ORDINARY REPUBLISH WRITES NOTHING AT ALL ───────────────────────────────────────────
{
  /* 🔴 THE REGISTRY IS NOT VERSION-SCOPED, so republishing the same objects cannot disturb identity —
     and the correct plan for that is EMPTY. A derivation that re-wrote every row on every publish
     would be correct in outcome and catastrophic in cost, and it would look identical in a cell that
     only checked the end state. */
  const reg = mk({
    ids: { X: idRow('Margherita'), Y: idRow('Napoletana') },
    keys: { Margherita: { canonical_id: 'X' }, Napoletana: { canonical_id: 'Y' } },
  });
  const alloc = allocator();
  const plan = derive({ candidateKeys: new Set(['Margherita', 'Napoletana']), stamps: { Margherita: 'X', Napoletana: 'Y' }, allocate: alloc }, reg);
  assert.deepStrictEqual(plan, { moves: [], mints: [], retires: [] },
    `🔴 an ordinary republish derived writes: ${JSON.stringify(plan)}`);
  assert.deepStrictEqual(alloc.calls, [], 'and allocated nothing');
  mustVerify(plan, reg, 'an empty republish');
  ok('republishing the same objects derives an EMPTY plan — identity is preserved by doing nothing');
}

// ── 3. A GENUINELY NEW OBJECT MINTS, AND ONLY WHERE NOTHING CLAIMS THE NAME ──────────────────
{
  const alloc = allocator();
  const fresh = mk({ ids: {}, keys: {} });
  const plan = derive({ candidateKeys: new Set(['Diavola']), allocate: alloc }, fresh);
  assert.deepStrictEqual(plan.mints, [{ id: 'NEW-Diavola', name: 'Diavola' }], `🔴 a new object did not mint: ${JSON.stringify(plan)}`);
  assert.deepStrictEqual(alloc.calls, ['Diavola'], 'the allocator was asked once, for that key');
  mustVerify(plan, fresh, 'a fresh mint');

  /* 🔴 UNSTAMPED DOES NOT MEAN UNIDENTIFIED — THE DUPLICATE-ID BUG, AT THE DERIVATION. An object can
     arrive with no stamp (pre-P1, or a candidate written before stamping) while the registry already
     holds its identity. Minting there hands one object a SECOND live id, which is the split identity
     ensureIdentity closed at the writer; orders written either side of it disagree permanently. */
  const held = mk({ ids: { OLD: idRow('Diavola') }, keys: { Diavola: { canonical_id: 'OLD' } } });
  const alloc2 = allocator();
  const plan2 = derive({ candidateKeys: new Set(['Diavola']), stamps: {}, allocate: alloc2 }, held);
  assert.deepStrictEqual(plan2.mints, [],
    '🔴 an UNSTAMPED object whose name a live id already claims was MINTED a second identity');
  assert.deepStrictEqual(alloc2.calls, [], '…and the allocator was not even consulted');
  assert.deepStrictEqual(plan2, { moves: [], mints: [], retires: [] }, 'the right plan is to do nothing');
  ok('a new object mints once, and an UNSTAMPED object whose name a live id already claims mints nothing');
}

// ── 4. THE DELETION CLAIM RETIRES, AND RETIRING IS NOT DOUBLE-COUNTED ────────────────────────
{
  const reg = mk({
    ids: { X: idRow('Margherita'), GONE: idRow('Romana'), ALREADY: idRow('Marinara', STATUS_RETIRED) },
    keys: { Margherita: { canonical_id: 'X' }, Romana: { canonical_id: 'GONE' } },
  });
  const alloc = allocator();
  const plan = derive({
    candidateKeys: new Set(['Margherita']), stamps: { Margherita: 'X' },
    retireIds: ['GONE', 'ALREADY', 'NEVER-EXISTED', '', null], allocate: alloc,
  }, reg);

  assert.deepStrictEqual(plan.retires, [{ id: 'GONE', name: 'Romana' }],
    `🔴 the retire list is wrong — an already-retired id, an absent one, or a malformed entry was retired: ${JSON.stringify(plan.retires)}`);
  const v = mustVerify(plan, reg, 'a deletion claim');
  assert.deepStrictEqual(v.deletions.map((d) => d.name), ['Romana'], 'and its reverse row is released');

  /* 🔴 AN ID THIS PLAN IS ENDING MUST NOT ALSO BE MOVED. verifyPlan refuses that combination, so a
     derivation that produced it would surface as a plan refusal — the right outcome reported in the
     wrong place, with a message pointing a reader at the verifier instead of at this file. */
  const both = mk({ ids: { Z: idRow('Old') }, keys: { Old: { canonical_id: 'Z' } } });
  const p2 = derive({ candidateKeys: new Set(['New']), stamps: { New: 'Z' }, retireIds: ['Z'], allocate: allocator() }, both);
  assert.deepStrictEqual(p2.moves, [], '🔴 an id being RETIRED was also MOVED — the plan both ends and continues one identity');
  assert.deepStrictEqual(p2.retires, [{ id: 'Z', name: 'Old' }], 'it is retired, once');
  ok('the claim retires live ids only — never an already-retired, absent or malformed one — and an id being retired is never also moved');
}

// ── 5. A STAMP POINTING AT AN UNUSABLE ID IS LEFT FOR THE VERIFIER, NOT PAPERED OVER ─────────
{
  /* 🔴 THE TEMPTING BUG IS TO MINT HERE. The candidate says "I am X" and X is retired or absent. A
     mint would hand the object a second identity while its stamp still names the first — and the
     stamp map's own verification (stamp_id_retired / stamp_id_row_missing) has ALREADY refused this
     activation before the derivation runs. Minting would make that refusal reachable-but-bypassed:
     the guard still fires, but a path exists that would have been wrong if it had not. */
  for (const [label, ids] of [
    ['retired', { X: idRow('Margherita', STATUS_RETIRED) }],
    ['absent', {}],
  ]) {
    const reg = mk({ ids, keys: {} });
    const alloc = allocator();
    const plan = derive({ candidateKeys: new Set(['Margherita']), stamps: { Margherita: 'X' }, allocate: alloc }, reg);
    assert.deepStrictEqual(plan.mints, [], `🔴 a stamp pointing at an ${label} id was resolved by MINTING a second identity`);
    assert.deepStrictEqual(plan.moves, [], `…and it was not moved either (${label})`);
    assert.deepStrictEqual(alloc.calls, [], `…and the allocator was never reached (${label})`);
  }
  ok('a stamp naming a RETIRED or ABSENT id derives nothing — the stamp-map verification refuses that activation, and the derivation does not route around it');
}

// ── 6. A TWO-OBJECT NAME SWAP DERIVES TWO MOVES AND NO DELETIONS ─────────────────────────────
{
  /* The case blind deletion gets wrong: each move releases a name the OTHER move lands on, so a
     derivation that reported both as deletions would have the writer delete two rows it is about to
     re-create, and survive only if the writes happen to be ordered well. */
  const reg = mk({
    ids: { X: idRow('A'), Y: idRow('B') },
    keys: { A: { canonical_id: 'X' }, B: { canonical_id: 'Y' } },
  });
  const plan = derive({ candidateKeys: new Set(['A', 'B']), stamps: { B: 'X', A: 'Y' }, allocate: allocator() }, reg);
  assert.strictEqual(plan.moves.length, 2, `🔴 a swap did not derive two moves: ${JSON.stringify(plan)}`);
  assert.deepStrictEqual(plan.mints, [], 'and minted nothing — both identities already exist');
  const v = mustVerify(plan, reg, 'a two-object swap');
  assert.deepStrictEqual(v.deletions, [], `🔴 a swap derived deletions; both names are re-landed by this same plan: ${JSON.stringify(v.deletions)}`);
  ok('a two-object name swap derives two moves, mints nothing, and deletes nothing');
}

// ── 7. THE INPUTS IT REFUSES TO GUESS AT ─────────────────────────────────────────────────────
{
  const reg = mk({ ids: { X: idRow('A') }, keys: { A: { canonical_id: 'X' } } });
  assert.throws(() => derivePlan({ candidateKeys: new Set(['A']), ids: {}, keys: reg.keys, allocate: allocator() }),
    /identity_derive_registry_unread/, '🔴 a plain object was accepted as the registry index — an unread registry is not an empty one');
  assert.throws(() => derivePlan({ candidateKeys: new Set(['A']), ids: reg.ids, keys: reg.keys }),
    /identity_derive_no_allocator/, '🔴 it derived a plan with no allocator — a mint would have produced an undefined id');

  /* 🔴 THE ALLOCATOR IS INJECTED, AND UNLIKE `encode` ITS FAILURE IS CAUGHT. There is no correct
     allocator to import — it is nondeterministic and brand-dependent — so it must come from the
     caller. What makes that acceptable is that a bad one does not pass silently: an id that already
     exists, live or retired, is refused by verifyPlan's MINT rule. Asserted, not argued. */
  const fresh = mk({ ids: { TAKEN: idRow('Somewhere') }, keys: {} });
  const bad = derivePlan({ candidateKeys: new Set(['Diavola']), ids: fresh.ids, keys: fresh.keys, allocate: () => 'TAKEN' });
  assert.deepStrictEqual(bad.mints, [{ id: 'TAKEN', name: 'Diavola' }], 'premise: the bad allocator really did return a taken id');
  const v = verifyPlan(bad, { ids: fresh.ids, keys: fresh.keys, complete: true });
  assert.strictEqual(v.code, 'plan_mint_id_exists',
    `🔴 an allocator that returned an EXISTING id was not caught by the verifier — then the injection really is the hazard \`encode\` was: ${v.code}`);
  ok('an unread registry and a missing allocator are refused, and an allocator returning a TAKEN id is caught by the verifier rather than silently accepted');
}

// ── 8. DELETE AND RE-CREATE UNDER THE SAME NAME, IN ONE PUBLISH ──────────────────────────────
{
  /* 🔴 THE SWEEP FOUND THIS, AND IT WAS A SILENT WRONG ANSWER. The merchant deletes an object and
     creates a new one with the same name in the same publish. The key row still names the OUTGOING
     id, which this plan retires — and a derivation that skipped on the ROW ALONE left the new object
     with no identity at all: no mint, no move, nothing, and the served overlay cannot resolve it.
     Indistinguishable from "not backfilled yet", which is the failure this whole slice exists to
     remove. The name is released by this very plan, so the new object mints. */
  const reg = mk({ ids: { OLD: idRow('Margherita') }, keys: { Margherita: { canonical_id: 'OLD' } } });
  const alloc = allocator();
  const plan = derive({ candidateKeys: new Set(['Margherita']), stamps: {}, retireIds: ['OLD'], allocate: alloc }, reg);

  assert.deepStrictEqual(plan.retires, [{ id: 'OLD', name: 'Margherita' }], 'the outgoing id is retired');
  assert.deepStrictEqual(plan.mints, [{ id: 'NEW-Margherita', name: 'Margherita' }],
    `🔴 an object re-created under a name this plan RETIRES got no identity at all: ${JSON.stringify(plan)}`);
  assert.deepStrictEqual(alloc.calls, ['Margherita'], 'the allocator was asked exactly once');
  mustVerify(plan, reg, 'delete and re-create under one name');

  /* The sensitivity control: with the claim REMOVED, the same candidate mints nothing, because the
     live claimant still holds the name. So the mint above is caused by the retirement, not by the
     object being unstamped. */
  const noClaim = derive({ candidateKeys: new Set(['Margherita']), stamps: {}, allocate: allocator() }, reg);
  assert.deepStrictEqual(noClaim.mints, [], '🔴 without the retirement it still minted — the mint is not caused by the name being released');
  ok('an object re-created under a name this same plan retires gets a fresh id, and mints nothing when that name is not being released');
}

// ── 9. A RENAME WITH NO REVERSE ROW — WHERE THE STAMP BRANCH IS THE ONLY GUARD ───────────────
{
  /* 🔴 ISOLATION. In cell 2 the stamp branch and the key-row branch BOTH decline to mint, so neither
     cell could tell which one was holding — the sweep proved it by leaving a mutant on the stamp
     branch alive. Here keys/{name} is missing (the missing-reverse-row orphan the integrity sweep
     repairs), so the key-row branch has nothing to say and the stamp branch is the only thing between
     this object and a second identity. */
  const reg = mk({ ids: { X: idRow('Margherita') }, keys: {} });
  const alloc = allocator();
  const plan = derive({ candidateKeys: new Set(['Margherita']), stamps: { Margherita: 'X' }, allocate: alloc }, reg);
  assert.deepStrictEqual(plan.mints, [],
    '🔴 with no reverse row, an object ALREADY holding this identity was minted a second one — the stamp branch is the only guard here and it did not hold');
  assert.deepStrictEqual(plan, { moves: [], mints: [], retires: [] }, 'and nothing else was derived; repairing the row is the sweep\'s job, not an activation\'s');
  assert.deepStrictEqual(alloc.calls, [], 'the allocator was never reached');
  ok('with the reverse row MISSING, a stamped object still mints nothing — the stamp branch isolated from the key-row branch');
}

console.log(`identity-derive: OK (${n})`);
