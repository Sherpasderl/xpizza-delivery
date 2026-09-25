'use strict';
/**
 * verifyPlan — the SOURCE side of an activation plan. Run: node catalog/identity-plan.test.js
 *
 * 🔴 WHAT EACH CELL HAS TO BE ABLE TO GO RED ON. Every refusal below is reachable from a plan a
 * reasonable planner could emit off stale reads — that is the point of verifying it against the
 * registry the transaction actually read rather than trusting the argument. Cell 6 is the one that
 * carries its own control: it shows judgePlanDestinations PERMITTING each half of a fork, and then
 * verifyPlan refusing the pair. Without that control, "the plan check refuses it" is a claim about
 * verifyPlan; with it, it is evidence about a gap nothing else closes.
 *
 * 🔴 AND WHAT THIS FILE CANNOT SAY. It is a pure predicate: every branch is driven directly, and none
 * of it establishes that the caller reads the registry INSIDE the transaction or BEFORE the first
 * write. A caller that reads late defeats all of it without changing a line. That half belongs to the
 * writer's own cells (rule 17's table) and to the end-to-end cells, not here.
 */
const assert = require('assert');
const { verifyPlan, entriesOf } = require('./identity-plan');
const { judgePlanDestinations } = require('./identity-destination');
const { encodeKey, STATUS_LIVE, STATUS_RETIRED } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const idRow = (legacy_key, status) => ({ legacy_key, status: status || STATUS_LIVE });
/* The index the transaction hands the verifier: ids keyed by document id, keys keyed ENCODED — the
   same spelling keysColOf uses, so a test that encoded them differently would be testing a registry
   that does not exist. */
const index = ({ ids = {}, keys = {} } = {}) => ({
  ids: new Map(Object.entries(ids)),
  keys: new Map(Object.entries(keys).map(([name, v]) => [encodeKey(name), v])),
  encode: encodeKey,
});
const PLAN = (p) => ({ moves: [], mints: [], retires: [], ...p });

// ── 1. A CONSISTENT PLAN PERMITS, AND NAMES THE DELETIONS IT IMPLIES ─────────────────────────
{
  const reg = index({
    ids: { X: idRow('Margherita'), Y: idRow('Napoletana') },
    keys: { Margherita: { canonical_id: 'X' }, Napoletana: { canonical_id: 'Y' } },
  });
  const v = verifyPlan(PLAN({
    moves: [{ id: 'X', from: 'Margherita', to: 'Margarita' }],
    mints: [{ id: 'Z', name: 'Diavola' }],
    retires: [{ id: 'Y', name: 'Napoletana' }],
  }), reg);

  assert.strictEqual(v.ok, true, `🔴 a plan consistent with the registry was refused: ${v.code} — ${v.detail}`);
  assert.strictEqual(v.code, 'plan_verified', `expected plan_verified, got ${v.code}`);

  /* 🔴 THE DELETION LIST IS THE POINT, NOT A BYPRODUCT. The writer deletes what this says and nothing
     else; a verifier that permitted the plan but reported the wrong rows to delete would be worse
     than one that refused. Margherita is released by the move, Napoletana by the retire; Diavola is a
     mint and releases nothing. */
  const names = v.deletions.map((d) => d.name).sort();
  assert.deepStrictEqual(names, ['Margherita', 'Napoletana'],
    `🔴 the deletion list is wrong: ${JSON.stringify(v.deletions)}`);
  for (const d of v.deletions) {
    assert.strictEqual(d.encoded, encodeKey(d.name),
      '🔴 a deletion names a document path the registry does not use — the writer would delete nothing, silently');
  }
  assert.deepStrictEqual(v.deletions.find((d) => d.name === 'Margherita').id, 'X',
    'each deletion carries the id whose row it is, so the writer can re-check at the point of deletion');
  ok('a plan consistent with the registry is permitted, and reports exactly the key rows it releases, encoded');
}

// ── 2. MOVE: THE `from` IS A CLAIM ABOUT THE REGISTRY, AND IT IS CHECKED ─────────────────────
{
  const reg = index({
    ids: { X: idRow('Romana'), Y: idRow('Margherita') },
    keys: { Romana: { canonical_id: 'X' }, Margherita: { canonical_id: 'Y' } },
  });

  /* 🔴 THE ISOLATING CASE RUNS FIRST, AND THAT ORDER IS LOAD-BEARING. The realistic fixture below is
     ALSO refused by the deletion check — keys/Margherita names Y, not X — so if it ran first, a
     mutant that removed refusal 2 would die on refusal 5's assertion and be filed as evidence that
     the source check holds. Here keys/Margherita does not exist: nothing to delete, no disagreement
     to find, and refusal 2 is the only thing between this plan and a re-pointed id. */
  const soleGuard = verifyPlan(PLAN({ moves: [{ id: 'X', from: 'Margherita', to: 'Marinara' }] }),
    index({ ids: { X: idRow('Romana'), Y: idRow('Margherita') }, keys: { Romana: { canonical_id: 'X' } } }));
  assert.strictEqual(soleGuard.code, 'plan_move_source_disagrees',
    `🔴 with no key row on the claimed \`from\`, NOTHING refused the move — refusal 2 is the only guard on this plan and it did not fire: ${soleGuard.code}`);

  /* The whole hazard in one plan: X actually claims Romana, and the planner thinks it claims
     Margherita — which Y holds. Writing it re-points X while keys/Romana still names X, AND deletes
     keys/Margherita, stripping the live id Y of its reverse row. */
  const wrong = verifyPlan(PLAN({ moves: [{ id: 'X', from: 'Margherita', to: 'Marinara' }] }), reg);
  assert.strictEqual(wrong.ok, false, '🔴 a move whose `from` is not what the id claims was PERMITTED');
  assert.strictEqual(wrong.code, 'plan_move_source_disagrees', `expected plan_move_source_disagrees, got ${wrong.code}`);
  /* 🔴 A COMPARISON IS TWO CLAIMS. A refusal that names only the plan's side sends the reader to fix
     the planner when the registry may be what moved. Both sides, in the detail. */
  assert.ok(wrong.detail.includes('Margherita') && wrong.detail.includes('Romana'),
    `🔴 the refusal names only one side of the disagreement: ${wrong.detail}`);

  const absent = verifyPlan(PLAN({ moves: [{ id: 'GHOST', from: 'Romana', to: 'Marinara' }] }), reg);
  assert.strictEqual(absent.code, 'plan_move_id_absent',
    `🔴 a move of an id the registry has never heard of was not refused as absent: ${absent.code}`);

  /* A retired id is a RESERVATION. Relocating one revives it as a side effect of a rename. */
  const retiredReg = index({ ids: { R: idRow('Romana', STATUS_RETIRED) }, keys: {} });
  const revive = verifyPlan(PLAN({ moves: [{ id: 'R', from: 'Romana', to: 'Marinara' }] }), retiredReg);
  assert.strictEqual(revive.code, 'plan_move_id_not_live',
    `🔴 a move relocated a RETIRED id, reviving a reservation: ${revive.code}`);
  ok('a move is refused when its `from` is not what the id claims, when the id is absent, and when the id is retired');
}

// ── 3. MINT: THE ID MUST NOT EXIST — LIVE **OR RETIRED** ─────────────────────────────────────
{
  /* 🔴 THIS CELL IS THE ARMING FOR catalog-publish.js's READ-COST NOTE. The registry read that feeds
     `ids` carries NO status filter, and that absence is load-bearing: add
     `.where('status','==',STATUS_LIVE)` and a retired id reads as absent, this refusal disappears, and
     a mint recycles a reservation. The mutant that adds the filter must land here. */
  const retiredOnly = index({ ids: { X: idRow('Napoletana', STATUS_RETIRED) }, keys: {} });
  const recycle = verifyPlan(PLAN({ mints: [{ id: 'X', name: 'Diavola' }] }), retiredOnly);
  assert.strictEqual(recycle.ok, false,
    '🔴 a MINT onto a RETIRED id was permitted — the reservation was recycled, and this is exactly what a live-only registry read would do');
  assert.strictEqual(recycle.code, 'plan_mint_id_exists', `expected plan_mint_id_exists, got ${recycle.code}`);
  assert.ok(recycle.detail.includes(STATUS_RETIRED),
    `🔴 the refusal does not say the id was RETIRED, which is the whole distinction: ${recycle.detail}`);

  /* The sensitivity control for the sentence above: with that id simply not in the registry, the same
     mint is permitted. So the refusal is caused by the retired row, not by the mint being a mint. */
  const clean = verifyPlan(PLAN({ mints: [{ id: 'X', name: 'Diavola' }] }), index({ ids: {}, keys: {} }));
  assert.strictEqual(clean.ok, true, `🔴 a mint onto a genuinely free id was refused: ${clean.code} — ${clean.detail}`);

  const liveReg = index({ ids: { X: idRow('Napoletana') }, keys: { Napoletana: { canonical_id: 'X' } } });
  const overLive = verifyPlan(PLAN({ mints: [{ id: 'X', name: 'Diavola' }] }), liveReg);
  assert.strictEqual(overLive.code, 'plan_mint_id_exists',
    `🔴 a mint onto a LIVE id was permitted: ${overLive.code}`);
  ok('a mint onto an existing id is refused whether that id is live or RETIRED, and a mint onto a free id is permitted');
}

// ── 4. RETIRE: THE ID MUST CURRENTLY CLAIM THE NAME IT IS RETIRED FROM ───────────────────────
{
  const reg = index({
    ids: { X: idRow('Romana'), Y: idRow('Margherita') },
    keys: { Romana: { canonical_id: 'X' }, Margherita: { canonical_id: 'Y' } },
  });
  /* The isolation cell 2 needed, and in the same order and for the same reason: below, keys/Margherita
     names Y, so refusal 5 would catch that plan too. With no key row on the claimed name, refusal 4 is
     the only guard. */
  const soleGuard = verifyPlan(PLAN({ retires: [{ id: 'X', name: 'Margherita' }] }),
    index({ ids: { X: idRow('Romana'), Y: idRow('Margherita') }, keys: { Romana: { canonical_id: 'X' } } }));
  assert.strictEqual(soleGuard.code, 'plan_retire_source_disagrees',
    `🔴 with no key row on the claimed name, NOTHING refused the retire — refusal 4 is the only guard on this plan and it did not fire: ${soleGuard.code}`);

  const wrongName = verifyPlan(PLAN({ retires: [{ id: 'X', name: 'Margherita' }] }), reg);
  assert.strictEqual(wrongName.ok, false,
    '🔴 an id was retired from a name it does not claim — which deletes a key row belonging to a live id');
  assert.strictEqual(wrongName.code, 'plan_retire_source_disagrees', `expected plan_retire_source_disagrees, got ${wrongName.code}`);
  assert.ok(wrongName.detail.includes('Margherita') && wrongName.detail.includes('Romana'),
    `🔴 both sides of the disagreement must be named: ${wrongName.detail}`);

  const absent = verifyPlan(PLAN({ retires: [{ id: 'GHOST', name: 'Romana' }] }), reg);
  assert.strictEqual(absent.code, 'plan_retire_id_absent', `expected plan_retire_id_absent, got ${absent.code}`);
  ok('a retire is refused when the id does not claim that name, and when the id is not in the registry at all');
}

// ── 5. DELETION IS CONDITIONED ON THE ROW NAMING THE ID, AND A SWAP DELETES NOTHING ──────────
{
  /* The ids side and the keys side disagree: X claims Romana, but keys/Romana names Z. Retiring X
     from Romana would delete a row that belongs to Z, leaving Z live with no reverse row — the
     missing-reverse-row orphan identity-sweep.js exists to repair. */
  const disagree = index({
    ids: { X: idRow('Romana'), Z: idRow('Romana') },
    keys: { Romana: { canonical_id: 'Z' } },
  });
  const v = verifyPlan(PLAN({ retires: [{ id: 'X', name: 'Romana' }] }), disagree);
  assert.strictEqual(v.ok, false, '🔴 a plan would have deleted a key row naming a DIFFERENT id');
  assert.strictEqual(v.code, 'plan_delete_row_names_other_id', `expected plan_delete_row_names_other_id, got ${v.code}`);

  /* An ABSENT row is not a disagreement — there is simply nothing to delete, and refusing would stall
     activations over residue the sweep is allowed to leave. It must not appear as a deletion either:
     a deletion of a row that is not there is a write the writer should not issue. */
  const noRow = verifyPlan(PLAN({ retires: [{ id: 'X', name: 'Romana' }] }),
    index({ ids: { X: idRow('Romana') }, keys: {} }));
  assert.strictEqual(noRow.ok, true, `🔴 a retire whose key row is simply absent was refused: ${noRow.code} — ${noRow.detail}`);
  assert.deepStrictEqual(noRow.deletions, [], '🔴 an absent row was reported as a deletion');

  /* 🔴 A SWAP RELEASES BOTH NAMES AND DELETES NEITHER. Treating every release as a deletion would
     delete keys/A and keys/B and then re-create them — correct only if the writer happens to order
     its writes that way, and catastrophic if it does not. The names are re-landed by this same plan,
     so they are not deletions at all. */
  const swap = verifyPlan(PLAN({
    moves: [{ id: 'X', from: 'A', to: 'B' }, { id: 'Y', from: 'B', to: 'A' }],
  }), index({
    ids: { X: idRow('A'), Y: idRow('B') },
    keys: { A: { canonical_id: 'X' }, B: { canonical_id: 'Y' } },
  }));
  assert.strictEqual(swap.ok, true, `🔴 a two-id name swap was refused: ${swap.code} — ${swap.detail}`);
  assert.deepStrictEqual(swap.deletions, [],
    `🔴 a swap reported deletions; those rows are re-landed by this same plan: ${JSON.stringify(swap.deletions)}`);
  ok('a deletion is refused when the row names another id, absent rows are neither refused nor deleted, and a swap deletes nothing');
}

// ── 6. PLAN SCALE: THE FORKS THE DESTINATION GUARD CANNOT SEE, WITH ITS VERDICT AS CONTROL ───
{
  const empty = index({ ids: {}, keys: {} });
  const fork = PLAN({ mints: [{ id: 'P', name: 'Diavola' }, { id: 'Q', name: 'Diavola' }] });

  /* 🔴 THE CONTROL. judgePlanDestinations judges each destination INDEPENDENTLY against the registry,
     and neither P nor Q is in the registry yet, so it permits BOTH. That is not a defect in the guard
     — every answer it gives is true of what it was shown — and it is why this check has to exist at
     plan scale. Without this half, "verifyPlan refuses a fork" is a claim about verifyPlan; with it,
     it is evidence about a gap nothing else closes. */
  const judged = judgePlanDestinations(fork, { claimants: { Diavola: [] }, keyRows: { Diavola: null } });
  assert.strictEqual(judged.length, 2, 'both mints are destinations');
  for (const j of judged) {
    assert.strictEqual(j.verdict.ok, true,
      `🔴 the destination guard refused one half of the fork (${j.verdict.code}) — if it can see this, cell 6's premise is wrong and this file needs rewriting, not the guard`);
  }

  const two = verifyPlan(fork, empty);
  assert.strictEqual(two.ok, false, '🔴 two ids landing on ONE name were permitted — the fork §2 inv #2/#4 forbids');
  assert.strictEqual(two.code, 'plan_two_ids_one_name', `expected plan_two_ids_one_name, got ${two.code}`);
  assert.ok(two.detail.includes('P') && two.detail.includes('Q'),
    `🔴 the refusal must name BOTH claimants, or the reader cannot tell which entry to drop: ${two.detail}`);

  /* The mirror: one id landing on two names. keys/{the other name} would name an id that does not
     claim it — the same registry self-disagreement, arrived at from the other side. */
  const bothNames = verifyPlan(PLAN({ mints: [{ id: 'P', name: 'Diavola' }, { id: 'P', name: 'Romana' }] }), empty);
  assert.strictEqual(bothNames.code, 'plan_one_id_two_names', `expected plan_one_id_two_names, got ${bothNames.code}`);

  /* And the third: an id both continued and ended by one plan. */
  const reg = index({ ids: { X: idRow('A') }, keys: { A: { canonical_id: 'X' } } });
  const both = verifyPlan(PLAN({
    moves: [{ id: 'X', from: 'A', to: 'B' }],
    retires: [{ id: 'X', name: 'A' }],
  }), reg);
  assert.strictEqual(both.code, 'plan_id_moved_and_retired', `expected plan_id_moved_and_retired, got ${both.code}`);

  /* 🔴 SENSITIVITY: A CROWDED PLAN THAT IS NOT A FORK STILL PASSES. Three mints onto three distinct
     names is the ordinary case, and a consistency check that refused it would be refusing plans for
     being large. */
  const fine = verifyPlan(PLAN({ mints: [{ id: 'P', name: 'A' }, { id: 'Q', name: 'B' }, { id: 'R', name: 'C' }] }), empty);
  assert.strictEqual(fine.ok, true, `🔴 a plan with three distinct mints was refused: ${fine.code} — ${fine.detail}`);
  ok('plan-scale forks are refused — two ids on one name, one id on two names, one id moved and retired — and the destination guard permits the first of those');
}

// ── 7. AN UNREAD REGISTRY IS NOT AN EMPTY ONE, AND AN UNREADABLE ENTRY IS NOT AN ABSENT ONE ──
{
  const plan = PLAN({ mints: [{ id: 'P', name: 'Diavola' }] });
  /* 🔴 THE SAME MISTAKE destination_key_row_unread EXISTS FOR. Defaulting the registry to empty makes
     "the caller forgot to read it" indistinguishable from "there is nothing there" — and empty is the
     state in which every refusal above is vacuously satisfied, so forgetting to read would look like
     a clean plan. */
  for (const bad of [undefined, {}, { ids: new Map(), keys: new Map() }, { ids: {}, keys: {}, encode: encodeKey }]) {
    const v = verifyPlan(plan, bad);
    assert.strictEqual(v.ok, false, `🔴 verifyPlan judged a plan against an unread registry: ${JSON.stringify(bad)}`);
    assert.strictEqual(v.code, 'plan_registry_unread', `expected plan_registry_unread, got ${v.code}`);
  }

  for (const bad of [null, undefined, 'a plan', 7]) {
    assert.strictEqual(verifyPlan(bad, index()).code, 'plan_malformed', `🔴 ${JSON.stringify(bad)} was accepted as a plan`);
  }

  /* 🔴 AN ENTRY THIS CANNOT READ IS ONE IT CANNOT JUDGE. entriesOf skips anything missing the fields
     it needs; if judging simply continued, the verifier would report a verified plan while an
     unjudged operation rode along to the writer. */
  const halfRead = verifyPlan(PLAN({ mints: [{ id: 'P', name: 'Diavola' }, { id: 'Q' }] }), index());
  assert.strictEqual(halfRead.ok, false, '🔴 a plan containing an entry the verifier could not read was PERMITTED');
  assert.strictEqual(halfRead.code, 'plan_entry_malformed', `expected plan_entry_malformed, got ${halfRead.code}`);
  assert.strictEqual(entriesOf(PLAN({ mints: [{ id: 'P', name: 'Diavola' }, { id: 'Q' }] })).lands.length, 1,
    'the premise: entriesOf really did drop the unreadable entry rather than throw');

  const partialMove = verifyPlan(PLAN({ moves: [{ id: 'X', to: 'B' }] }), index({ ids: { X: idRow('A') } }));
  assert.strictEqual(partialMove.code, 'plan_entry_malformed',
    `🔴 a move with no \`from\` was not caught as unreadable (${partialMove.code}) — a missing \`from\` is the exact claim refusal 2 exists to check`);
  ok('an unread registry, a non-object plan, and an entry missing the fields it is judged by are each refused rather than treated as empty');
}

// ── 8. PURE, AND IT DOES NOT MUTATE WHAT IT IS ASKED TO JUDGE ────────────────────────────────
{
  const plan = PLAN({
    moves: [{ id: 'X', from: 'A', to: 'B' }],
    mints: [{ id: 'P', name: 'C' }],
    retires: [{ id: 'Y', name: 'D' }],
  });
  const frozen = JSON.parse(JSON.stringify(plan));
  const ids = { X: idRow('A'), Y: idRow('D') };
  const keys = { A: { canonical_id: 'X' }, D: { canonical_id: 'Y' } };

  const a = verifyPlan(plan, index({ ids, keys }));
  const b = verifyPlan(plan, index({ ids, keys }));
  assert.deepStrictEqual(a, b, 'the same inputs give the same verdict');
  assert.strictEqual(a.ok, true, `${a.code} — ${a.detail}`);
  assert.deepStrictEqual(plan, frozen, '🔴 the verifier MUTATED the plan it was asked to judge');
  ok('the verdict is a pure function of its arguments, and it mutates none of them');
}

console.log(`identity-plan: OK (${n})`);
