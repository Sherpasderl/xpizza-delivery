'use strict';
/**
 * The destination-claimant guard — every branch, driven directly.
 * Run: node catalog/destination-claimant.test.js
 *
 * 🔴 WHY THIS FILE IS THE WHOLE OF THE EVIDENCE TODAY. The guard is DEFERRED TO SLICE E by design
 * (see identity-destination.js): it protects the atomic writer, and the atomic writer does not exist
 * yet — nothing in the flip transaction mints, moves or retires anything as of Slice D. Wiring the
 * predicate to a plan that is empty on every path that exists would produce cells that pass while
 * measuring nothing, which is the failure this programme keeps finding. A pure predicate with unit
 * cells is the opposite: every branch below is reached by the assertion named on it, and when E wires
 * the guard these cells keep holding the predicate still while the end-to-end cells prove the reads
 * are transactional — the half a unit test cannot speak to.
 *
 * Cell 5 is §4's own acceptance scenario, run in both directions: the pre-P1 orphan blocks the move,
 * and after reconciliation retires it the SAME move succeeds. A refusal that never lifts is
 * indistinguishable from a broken path.
 */
const assert = require('assert');
const { destinationVerdict, judgePlanDestinations, planDestinations, releasedFrom } = require('./identity-destination');
const { STATUS_LIVE, STATUS_RETIRED } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const live = (id, name) => ({ id, legacy_key: name, status: STATUS_LIVE });
const row = (id) => ({ canonical_id: id });
const NO_PLAN = { moves: [], mints: [], retires: [] };

// ── 1. A FREE NAME IS FREE — and the two ways of being free are not the same answer ──────────
{
  const free = destinationVerdict({ name: 'Margherita', landingId: 'X', keyRow: null, liveClaimants: [], plan: NO_PLAN });
  assert.strictEqual(free.ok, true, '🔴 a name with no key row and no live claimant was refused');
  assert.strictEqual(free.code, 'unclaimed',
    `🔴 a free name was permitted for the WRONG reason (${free.code}) — 'nobody holds this' and 'we already hold this' are different facts about the registry, and a caller may skip the write for one`);

  /* The landing id already holding the name is a NO-OP re-write, not a conflict with itself. It gets
     its own code rather than sharing `unclaimed`, because "nobody holds this" and "we already hold
     this" are different facts about the registry and a caller may want to skip the write for one. */
  const ours = destinationVerdict({ name: 'Margherita', landingId: 'X', keyRow: row('X'), liveClaimants: [live('X', 'Margherita')], plan: NO_PLAN });
  assert.strictEqual(ours.ok, true, '🔴 an id was refused permission to land on the name it already holds');
  assert.strictEqual(ours.code, 'already_ours', `expected already_ours, got ${ours.code}`);
  ok('an unclaimed name permits, and an id landing on the name it already holds permits as a no-op');
}

// ── 2. 🔴 A LIVE CLAIMANT THIS PLAN DOES NOT TOUCH REFUSES — the migration-boundary fork ─────
/* The orphan case. X live-claims the name, this plan neither moves it off nor retires it, and landing
   would leave X and the lander both live-claiming one name. That is the fork inv #2/#4 says no path
   may produce, and the only correct answer is to refuse the WHOLE activation. */
{
  const v = destinationVerdict({
    name: 'Margherita', landingId: 'Y', keyRow: row('X'),
    liveClaimants: [live('X', 'Margherita')],
    plan: { moves: [{ id: 'Y', from: 'Margarita', to: 'Margherita' }], mints: [], retires: [] },
  });
  assert.strictEqual(v.ok, false, '🔴 a move landed on a name a live id still claims — two live ids now claim one name');
  assert.strictEqual(v.code, 'destination_claimed', `expected destination_claimed, got ${v.code}`);
  assert.strictEqual(v.claimant, 'X', 'and the refusal names WHO holds it, because that is what has to be reconciled');
  assert.ok(/live-claims it/.test(v.detail), 'the detail says the name is held, not merely that something failed');
  ok('a live claimant the plan does not touch REFUSES — the pre-P1 orphan is not written over');
}

// ── 3. RELEASED BY THIS SAME PLAN — both ways a plan can release a name ──────────────────────
/* "Released" is derived from the plan, never handed in: a move releases the name it moves AWAY from,
   and a retirement releases the name it retires. Both are tested, because an implementation that
   honoured only one would pass a suite that only tried the other. */
{
  const byMove = destinationVerdict({
    name: 'Margherita', landingId: 'Y', keyRow: row('X'), liveClaimants: [live('X', 'Margherita')],
    plan: { moves: [{ id: 'X', from: 'Margherita', to: 'Napoletana' }, { id: 'Y', from: 'Margarita', to: 'Margherita' }], mints: [], retires: [] },
  });
  assert.strictEqual(byMove.ok, true, `🔴 a swap was refused even though the holder moves off in the same plan: ${byMove.code}`);
  assert.strictEqual(byMove.code, 'claimant_released', `expected claimant_released, got ${byMove.code}`);

  const byRetire = destinationVerdict({
    name: 'Margherita', landingId: 'Y', keyRow: row('X'), liveClaimants: [live('X', 'Margherita')],
    plan: { moves: [{ id: 'Y', from: 'Margarita', to: 'Margherita' }], mints: [], retires: [{ id: 'X', name: 'Margherita' }] },
  });
  assert.strictEqual(byRetire.ok, true, `🔴 landing was refused even though the holder is retired by the same plan: ${byRetire.code}`);

  /* SENSITIVITY — the release must be FROM THIS NAME. A plan that retires X from some OTHER name, or
     moves it off some other name, releases nothing here. Without this, "is X mentioned anywhere in the
     plan" would pass every cell above while permitting exactly the fork the guard exists to stop. */
  const elsewhere = destinationVerdict({
    name: 'Margherita', landingId: 'Y', keyRow: row('X'), liveClaimants: [live('X', 'Margherita')],
    plan: { moves: [{ id: 'X', from: 'Something Else', to: 'Napoletana' }], mints: [], retires: [{ id: 'X', name: 'Something Else' }] },
  });
  assert.strictEqual(elsewhere.ok, false,
    '🔴 a release recorded against a DIFFERENT name counted as releasing this one — "mentioned in the plan" is not "released from this name"');
  assert.strictEqual(elsewhere.code, 'destination_claimed', `expected destination_claimed, got ${elsewhere.code}`);
  ok('a claimant moved off or retired BY THIS PLAN permits; one released from some other name does not');
}

// ── 4. 🔵 MINE — A PRE-EXISTING FORK REFUSES, even when the plan releases every claimant ─────
/* Two live ids already claiming one name is corruption that predates this plan. §4 read literally
   would permit landing here, since every claimant is released; an activation is not the place to
   launder a fork. Its own code, so it can never be read as the ordinary orphan-in-the-way case, and
   so that a reader seeing it knows reconciliation is what clears it. */
{
  const v = destinationVerdict({
    name: 'Margherita', landingId: 'Z', keyRow: row('X'),
    liveClaimants: [live('X', 'Margherita'), live('Y', 'Margherita')],
    plan: { moves: [{ id: 'X', from: 'Margherita', to: 'A' }, { id: 'Y', from: 'Margherita', to: 'B' }, { id: 'Z', from: 'C', to: 'Margherita' }], mints: [], retires: [] },
  });
  assert.strictEqual(v.ok, false, '🔴 an activation landed on a name TWO live ids already claim — a pre-existing fork was written over');
  assert.strictEqual(v.code, 'destination_forked',
    `🔴 a pre-existing fork was refused under the wrong code (${v.code}) — the code is how a reader knows reconciliation clears it rather than a plan change`);
  assert.deepStrictEqual(v.live_claimants.slice().sort(), ['X', 'Y'], 'and it names both holders, which is what reconciliation needs');
  assert.notStrictEqual(v.code, 'destination_claimed',
    `🔴 a pre-existing fork was reported as the ordinary single-claimant case (${v.code}) — reconciliation is what clears a fork, and the two need different answers`);

  /* 🔴 THE CASE THIS CELL SIDESTEPPED, AND THE BUG IT HID. Above, the lander is a THIRD id, Z. Choose
     the lander from AMONG the claimants instead and the original implementation permitted: it excluded
     the landing id before counting, so X and Y both claiming A with X landing read as "one other
     claimant, released by the plan". The rule I argued for and the advisor approved — more than one
     live claimant refuses, whoever is landing — was not the rule the code implemented, and the cell
     chose the variant that cannot tell the difference. */
  const landerIsAClaimant = destinationVerdict({
    name: 'Margherita', landingId: 'X', keyRow: row('X'),
    liveClaimants: [live('X', 'Margherita'), live('Y', 'Margherita')],
    plan: { moves: [], mints: [], retires: [{ id: 'Y', name: 'Margherita' }] },
  });
  assert.strictEqual(landerIsAClaimant.ok, false,
    '🔴 a name TWO live ids already claim was landed on because one of them was the lander — the fork is the fork whoever is writing');
  assert.strictEqual(landerIsAClaimant.code, 'destination_forked',
    `🔴 a fork with the lander among the claimants was not reported as a fork (${landerIsAClaimant.code}) — excluding the lander before counting is what made it invisible`);
  assert.deepStrictEqual(landerIsAClaimant.live_claimants.slice().sort(), ['X', 'Y'], 'and BOTH are named, the lander included');
  ok('a name with TWO live claimants refuses with its own code even when the plan releases both — and whether or not the lander is one of them');
}

// ── 5. 🔴 §4'S ACCEPTANCE SCENARIO, IN BOTH DIRECTIONS ───────────────────────────────────────
/* The exact worktree state §4 names: pre-P1, A/X was renamed to B/Y and X was left live-claiming A
   (catalog-publish.js:373 never retired it). A P1 rename now carries Y from B back to A.
   Before reconciliation it REFUSES; after reconciliation has retired X it SUCCEEDS. The second half is
   what makes the first half evidence rather than a wall — a guard that refuses forever is
   indistinguishable from a broken path, and the whole point of reconciling deliberately (§3.0) is that
   the activation then goes through. */
{
  const plan = { moves: [{ id: 'Y', from: 'B', to: 'A' }], mints: [], retires: [] };

  const before = destinationVerdict({ name: 'A', landingId: 'Y', keyRow: row('X'), liveClaimants: [live('X', 'A')], plan });
  assert.strictEqual(before.ok, false, '🔴 the Y→A move was permitted while the pre-P1 orphan X still live-claimed A');
  assert.strictEqual(before.code, 'destination_claimed', `expected destination_claimed, got ${before.code}`);

  // …reconciliation retires X deliberately and logged (§3.0): its key row goes, its claim goes.
  const after = destinationVerdict({ name: 'A', landingId: 'Y', keyRow: null, liveClaimants: [], plan });
  assert.strictEqual(after.ok, true, `🔴 the same move still refuses after the orphan was reconciled — the guard never lifts: ${after.code}`);
  assert.strictEqual(after.code, 'unclaimed', `expected unclaimed, got ${after.code}`);
  ok('§4 acceptance: the pre-P1 orphan blocks the Y→A move, and the SAME move succeeds once reconciliation retires it');
}

// ── 6. 🔵 MINE — A KEY ROW NAMING A NON-CLAIMANT REFUSES ─────────────────────────────────────
/* The registry disagreeing with itself: the forward row says Z holds the name, and no live id claims
   it. A half-done retirement, or a claim that moved after the row was written. assertKeyRowAgrees and
   the sweep both refuse exactly this rather than repair it, and landing here would replace the
   evidence with a row that looks healthy. */
{
  const v = destinationVerdict({ name: 'Margherita', landingId: 'Y', keyRow: row('Z'), liveClaimants: [], plan: NO_PLAN });
  assert.strictEqual(v.ok, false, '🔴 an activation landed on a name whose key row names an id that does not claim it — the evidence of a broken registry was overwritten');
  assert.strictEqual(v.code, 'destination_key_row_disagrees', `expected destination_key_row_disagrees, got ${v.code}`);
  assert.strictEqual(v.key_row_id, 'Z', 'and it names the id the row points at');

  /* SENSITIVITY — the landing id itself is exempt. Writing the mapping that is already stored cannot
     fork anything, and refusing it would make a retry of a half-written activation impossible. */
  const ownRow = destinationVerdict({ name: 'Margherita', landingId: 'Z', keyRow: row('Z'), liveClaimants: [], plan: NO_PLAN });
  assert.strictEqual(ownRow.ok, true, '🔴 an id was refused permission to re-write the key row it already owns');
  ok('a key row naming an id that does not live-claim the name refuses; the landing id re-writing its own row does not');
}

// ── 7. 🔴 A TRUNCATED CLAIMANT SCAN REFUSES — and it is checked BEFORE anything is concluded ─
/* §4: an overflow must ABORT the activation, never truncate claimant discovery, because a truncated
   scan misses the very orphan the guard exists to catch. The ORDER is the property: every branch below
   reads a short set as good news, so truncation must be decided before the set is consulted at all.
   The cell proves the order by truncating a set that would otherwise permit — an implementation that
   checked truncation last would return `unclaimed` here and look correct on any input that refuses for
   another reason anyway. */
{
  const v = destinationVerdict({ name: 'Margherita', landingId: 'Y', keyRow: null, liveClaimants: [], truncated: true, plan: NO_PLAN });
  assert.strictEqual(v.ok, false, '🔴 an activation landed on a name whose claimant scan was TRUNCATED — the orphan may simply not have been read');
  assert.strictEqual(v.code, 'destination_claimants_truncated', `expected destination_claimants_truncated, got ${v.code}`);
  assert.ok(/incomplete/.test(v.detail), 'and it says the set is incomplete rather than that the name is taken');
  ok('a truncated claimant scan refuses, and it is decided BEFORE an empty set can be read as a free name');
}

// ── 8. THE CLAIMANT SET'S OWN CONTRACT IS ENFORCED, NOT ASSUMED ──────────────────────────────
/* The caller queries `status == live` AND `legacy_key == name`. Being handed anything else means the
   query was not the one the guard needs — and silently filtering would make this predicate agree with
   a wrong query, which is the failure mode that matters: a guard that quietly tolerates bad input is
   a guard whose caller can be changed without anyone noticing. Both halves refuse by name. */
{
  const retired = destinationVerdict({
    name: 'Margherita', landingId: 'Y', keyRow: null,
    liveClaimants: [{ id: 'X', legacy_key: 'Margherita', status: STATUS_RETIRED }], plan: NO_PLAN,
  });
  /* 🔴 THE CODE IS THE ASSERTION THAT MATTERS, AND ITS MESSAGE HAS TO SAY SO. Dropping the live
     check does not make this permit — the retired row is then counted as an ordinary claimant and the
     verdict refuses as `destination_claimed`. So the ok/false assertion passes under the mutant and
     only the CODE distinguishes them; a message reading "expected X, got Y" would record the kill
     against a string that says nothing about what broke. */
  assert.strictEqual(retired.ok, false, '🔴 a RETIRED row in the claimant set was permitted outright');
  assert.strictEqual(retired.code, 'destination_claimants_not_live',
    `🔴 a RETIRED row was read as an ordinary live claimant (refused as ${retired.code}) — the caller queried the wrong thing and the guard agreed with it`);

  const offName = destinationVerdict({
    name: 'Margherita', landingId: 'Y', keyRow: null,
    liveClaimants: [live('X', 'Napoletana')], plan: NO_PLAN,
  });
  assert.strictEqual(offName.ok, false, '🔴 a claimant of a DIFFERENT name was permitted outright');
  assert.strictEqual(offName.code, 'destination_claimants_off_name',
    `🔴 a claimant of a DIFFERENT name was accepted as deciding whether this name is free (refused as ${offName.code}) — the set the guard trusts is no longer the set it needs`);
  ok('a claimant set carrying a retired row, or a row claiming another name, refuses by name rather than being filtered');
}

// ── 9. MALFORMED INPUT FAILS CLOSED — an absent set is not an empty one ──────────────────────
{
  for (const [label, args] of [
    /* 🔴 THESE THREE SUPPLY A VALID CLAIMANT SET ON PURPOSE, so only the property under test can refuse.
       They used to omit it — and once an OMITTED set became a refusal (the default that disarmed its own
       guard, fixed above), the ARRAY check caught these cases with the SAME `destination_input_malformed`
       code, so a mutant that removed the NAME check SURVIVED: the cell still passed for the wrong reason.
       Caught by sweeping d4p1dc before handing back — baseline 15/15, mine 14/15. Each refusal is
       isolated so its own mutant stays killable, which is the same discipline as running an isolating
       case first. */
    ['no name', { name: '', landingId: 'Y', liveClaimants: [] }],
    ['a non-string name', { name: 42, landingId: 'Y', liveClaimants: [] }],
    ['no landing id', { name: 'Margherita', landingId: '', liveClaimants: [] }],
    /* 🔴 THE CASE THIS CELL'S OWN LABEL CLAIMED AND THE TABLE DID NOT CONTAIN. The label says "an absent
       claimant set is never read as an empty one"; every case below tests a MALFORMED set, and none tested
       an OMITTED one. It was PERMITTED — `destinationVerdict({name:'A', landingId:'XXXXXXXXXX'})` returned
       ok with code `unclaimed` — because the parameter defaulted to `[]` and the array check saw an array.
       The guard was written correctly and its DEFAULT disarmed it; the cell claimed the property anyway.
       Found by an independent gate. Tenth instance in this programme of a cell whose green did not cover
       what its label said. */
    ['an OMITTED claimant set', { name: 'Margherita', landingId: 'Y' }],
    ['an explicitly undefined claimant set', { name: 'Margherita', landingId: 'Y', liveClaimants: undefined }],
    ['a claimant set that is not an array', { name: 'Margherita', landingId: 'Y', liveClaimants: null }],
    ['a claimant set that is an object', { name: 'Margherita', landingId: 'Y', liveClaimants: { 0: live('X', 'Margherita') } }],
  ]) {
    const v = destinationVerdict({ ...args, plan: NO_PLAN });
    assert.strictEqual(v.ok, false, `🔴 ${label} was permitted`);
    assert.strictEqual(v.code, 'destination_input_malformed', `${label}: expected destination_input_malformed, got ${v.code}`);
  }
  /* …and called with nothing at all, rather than throwing a TypeError a caller would read as a crash.
     🔴 THIS ONE PROVES LESS THAN IT LOOKS: with no arguments the MISSING NAME refuses first, so it says
     nothing about the claimant set. It is kept as a no-crash check and no longer counted as evidence
     about absence — the OMITTED case above is what carries that. */
  assert.strictEqual(destinationVerdict().ok, false, '🔴 a call with no arguments did not fail closed');

  /* 🔴 AND THE PERMITTING CONTROL, because a predicate that refused every claimant set would satisfy all
     of the above: a set the caller genuinely READ and found empty must still permit. That distinction —
     read-and-empty versus never-read — is the entire property. */
  const readAndEmpty = destinationVerdict({ name: 'Margherita', landingId: 'YYYYYYYYYY', liveClaimants: [], plan: NO_PLAN });
  assert.strictEqual(readAndEmpty.ok, true,
    `🔴 a claimant set that was READ and found EMPTY was refused (${readAndEmpty.code}) — then the guard refuses every first mint rather than distinguishing unread from empty`);
  ok('seven malformed shapes — including an OMITTED and an explicitly-undefined claimant set — fail CLOSED, while a set genuinely read and found empty still permits');
}

// ── 10. THE READ LIST IS DERIVED FROM THE PLAN — destinations only, releases are not destinations ──
/* A destination is a name the activation WRITES: a move's `to`, a mint's `name`. A move's `from` and a
   retire's `name` are being released, not claimed, and reading them as destinations would have the
   guard refuse every swap against itself. Exported so the caller reads exactly this set before it
   writes — a read list computed by hand somewhere else is how a destination goes unchecked. */
{
  const plan = {
    moves: [{ id: 'X', from: 'A', to: 'B' }, { id: 'Y', from: 'B', to: 'A' }],
    mints: [{ id: 'N', name: 'Brand New' }],
    retires: [{ id: 'R', name: 'Gone' }],
  };
  assert.deepStrictEqual(planDestinations(plan), [
    { name: 'B', landingId: 'X', via: 'move' },
    { name: 'A', landingId: 'Y', via: 'move' },
    { name: 'Brand New', landingId: 'N', via: 'mint' },
  ], '🔴 the destination list is not exactly the names this plan writes');

  assert.deepStrictEqual([...releasedFrom(plan, 'A')], ['X'], 'A is released by X moving off it');
  assert.deepStrictEqual([...releasedFrom(plan, 'Gone')], ['R'], 'a retired name is released by its retirement');
  assert.deepStrictEqual([...releasedFrom(plan, 'Brand New')], [], 'a mint destination releases nothing');
  /* A "move" whose from and to are the same name releases NOTHING — it is not going anywhere. Without
     this, a no-op move would look like a release and could clear the way for another id to land. */
  assert.deepStrictEqual([...releasedFrom({ moves: [{ id: 'S', from: 'A', to: 'A' }] }, 'A')], [],
    '🔴 a move from a name to ITSELF counted as releasing that name');
  assert.deepStrictEqual(planDestinations(null), [], 'an absent plan has no destinations');
  ok('planDestinations is exactly what the plan writes, releasedFrom is exactly what it frees, and a self-move frees nothing');
}

// ── 11. 🔴 ONE SCAN, ONE ABORT — and an unread KEY ROW is still not an absent one ───────────
/* v7.1 replaced v7's per-name claimant reads with ONE transactional query per KIND, so the two inputs
   are asymmetric and the cell has to hold both halves:
     the CLAIMANT map is complete unless the scan truncated — a name missing from it genuinely has no
     live claimant, and refusing there would refuse every clean mint;
     the KEY ROWS are per-destination document reads, which can be forgotten — so a destination with no
     row entry REFUSES, because an omission must not be indistinguishable from a free name.
   And truncation is ONE flag: when it is set, EVERY destination carries the refusal, which is the
   "one explicit bounded abort rather than N places to truncate silently" v7.1 asks for. */
{
  const plan = { moves: [{ id: 'Y', from: 'B', to: 'A' }], mints: [{ id: 'N', name: 'Brand New' }], retires: [] };

  const judged = judgePlanDestinations(plan, { claimants: { A: [live('X', 'A')] }, keyRows: { A: row('X'), 'Brand New': null } });
  assert.strictEqual(judged.length, 2, 'every destination is judged');
  assert.strictEqual(judged.find((j) => j.name === 'A').verdict.code, 'destination_claimed',
    'the destination with a claimant in the scan is judged against it');
  /* 🔴 THE HALF THAT WOULD BE EASY TO GET BACKWARDS. "Brand New" is absent from the claimant map, and
     under the ONE-scan model that means nobody claims it — a fresh mint must go through. Reading the
     absence as "unread" would refuse every mint the guard is supposed to allow. */
  assert.strictEqual(judged.find((j) => j.name === 'Brand New').verdict.ok, true,
    '🔴 a name absent from a COMPLETE claimant scan was refused — under one-query-per-kind, absent means unclaimed, and refusing it blocks every fresh mint');

  // …but its KEY ROW is a per-destination read, and forgetting that one refuses.
  const noRow = judgePlanDestinations(plan, { claimants: { A: [] }, keyRows: { A: null } });
  const unread = noRow.find((j) => j.name === 'Brand New');
  assert.strictEqual(unread.verdict.ok, false, '🔴 a destination whose key row was never read was treated as one whose row is absent');
  assert.strictEqual(unread.verdict.code, 'destination_key_row_unread',
    `🔴 an unread key row refused under the wrong code (${unread.verdict.code}) — the code is what tells a caller to go READ it rather than to reconcile something`);

  /* 🔴 PRESENT WITH AN UNDEFINED VALUE IS NOT A READ, and membership alone could not tell. The first
     implementation tested `has(name)` only, so `{A: undefined}` counted as read and then fell through
     to `|| null` — which is the shape that MEANS "read it, there is no row". That collapses the exact
     two states this function exists to keep apart, and it arrives by an ordinary mistake:
     `rows[name] = snap.exists ? snap.data() : undefined`. Both spellings are asserted, object and Map,
     because a caller may hand either. */
  for (const [label, reads] of [
    ['an object entry with an undefined value', { claimants: {}, keyRows: { A: undefined, 'Brand New': null } }],
    ['a Map entry with an undefined value', { claimants: new Map(), keyRows: new Map([['A', undefined], ['Brand New', null]]) }],
  ]) {
    const j = judgePlanDestinations({ moves: [{ id: 'Y', from: 'B', to: 'A' }], mints: [], retires: [] }, reads);
    const a = j.find((x) => x.name === 'A');
    assert.strictEqual(a.verdict.ok, false,
      `🔴 ${label} was treated as a READ key row that is absent — an unread destination became a free one, which is the guard defeated by an omission`);
    assert.strictEqual(a.verdict.code, 'destination_key_row_unread',
      `🔴 ${label} refused under ${a.verdict.code} rather than as unread`);
  }
  /* SENSITIVITY: an explicit null is still a real read and still permits, or the distinction above
     would be satisfied by refusing everything. */
  const explicitNull = judgePlanDestinations({ moves: [], mints: [{ id: 'N', name: 'A' }], retires: [] },
    { claimants: {}, keyRows: { A: null } });
  assert.strictEqual(explicitNull[0].verdict.ok, true,
    '🔴 SENSITIVITY: an explicit null key row was refused — null is the answer "I read it and there is none", and refusing it blocks every fresh mint');

  /* ONE ABORT: a truncated scan refuses EVERY destination, including ones that would otherwise be
     clean. A per-name flag would put the decision back in N places, which is what v7.1 removed. */
  const short = judgePlanDestinations(plan, { claimants: {}, keyRows: { A: null, 'Brand New': null }, truncated: true });
  assert.deepStrictEqual(short.map((j) => j.verdict.code), ['destination_claimants_truncated', 'destination_claimants_truncated'],
    '🔴 a truncated scan permitted some destination anyway — the abort has to cover the whole activation, not the names that happened to look clean');

  // Every destination is reported, so a caller can refuse naming ALL the blocked names at once.
  const twoBlocked = judgePlanDestinations(
    { moves: [{ id: 'Y', from: 'B', to: 'A' }, { id: 'Z', from: 'C', to: 'D' }], mints: [], retires: [] },
    { claimants: { A: [live('X', 'A')], D: [live('W', 'D')] }, keyRows: { A: null, D: null } },
  );
  assert.deepStrictEqual(twoBlocked.map((j) => j.verdict.code), ['destination_claimed', 'destination_claimed'],
    'both blocked destinations are reported, not just the first');
  ok('one scan and one abort: an absent claimant means unclaimed, an unread KEY ROW refuses, and a truncated scan refuses every destination');
}

// ── 12. PURE, AND IT DOES NOT MUTATE WHAT IT IS ASKED TO JUDGE ───────────────────────────────
{
  const plan = { moves: [{ id: 'X', from: 'Margherita', to: 'Napoletana' }], mints: [], retires: [] };
  const claimants = [live('X', 'Margherita')];
  const keyRow = row('X');
  const input = { name: 'Margherita', landingId: 'Y', keyRow, liveClaimants: claimants, plan };
  const frozen = JSON.parse(JSON.stringify(input));

  const a = destinationVerdict(input);
  const b = destinationVerdict(input);
  assert.deepStrictEqual(a, b, 'the same inputs give the same verdict');
  assert.deepStrictEqual(input, frozen, '🔴 the predicate MUTATED the inputs it was asked to judge');
  ok('the verdict is a pure function of its arguments, and it mutates none of them');
}

console.log(`destination-claimant: OK (${n})`);
