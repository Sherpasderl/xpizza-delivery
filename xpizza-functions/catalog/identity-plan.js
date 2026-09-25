'use strict';
/* verifyPlan — the SOURCE side of an activation plan, which §68 does not cover.
 *
 * 🔴 WHAT §68 CHECKS AND WHAT IT DOES NOT. Its re-verify list is the candidate, the current
 * generation, the source revision, the reservations and the activation record — the plan's
 * ELIGIBILITY. The destination-claimant guard covers its DESTINATIONS. Nothing verifies its SOURCE:
 * `from` on a move, and the current claim of any landing id, are planner CLAIMS, and §68's own stated
 * principle — "a trusted-looking plan argument is insufficient" — applies to them exactly as to the
 * rest. Recorded as spec v7.5; this is the code half of that amendment.
 *
 * 🔴 WHY A WRONG `from` IS WORSE THAN A STALE ROW. It does two things. ids/{X} is re-pointed while
 * keys/{whatever X actually claimed} still names X — the `destination_key_row_disagrees` state §4
 * refuses elsewhere. AND keys/{from} is deleted although it may have named a DIFFERENT live id Y,
 * leaving Y live with no reverse row: the missing-reverse-row orphan identity-sweep.js exists to
 * repair. A wrong source manufactures the state the integrity job was built for.
 *
 * 🔴 AND THE GUARD CANNOT SEE THE PLAN'S OTHER ENTRIES. judgePlanDestinations judges each destination
 * INDEPENDENTLY against the registry, and the plan's other entries are not in the registry yet. So
 * two entries landing on one name are each permitted as "unclaimed", and one id landing on two names
 * likewise. Neither is a defect in the guard — every answer is true of what it was shown — and
 * neither is visible at destination scale. It is refused at PLAN scale, before any destination is
 * judged.
 *
 * PURE. It is handed an index of the registry the caller has already read, so every branch is
 * drivable without a database, and the reads stay where the transaction is.
 */
const { STATUS_LIVE, encodeKey, validIdShape } = require('./identity-registry');

const REFUSE = (code, detail) => ({ ok: false, code, detail });
const PERMIT = { ok: true, code: 'plan_verified', detail: '' };

/* READABILITY, not validity: whether entriesOf can see an id at all. Shape is judged separately and
   with its own refusal, so "the field is missing" and "the field is malformed" stay distinguishable. */
const isId = (v) => typeof v === 'string' && v.length > 0;
const isName = (v) => typeof v === 'string' && v.length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

/* Every (id, destination-name) this plan lands, and every (id, name) it releases. One shape for
   moves, mints and retires so the consistency checks below do not have three spellings. */
function entriesOf(plan) {
  const lands = [];
  const releases = [];
  for (const m of arr(plan && plan.moves)) {
    if (!isId(m && m.id) || !isName(m && m.to) || !isName(m && m.from)) continue;
    lands.push({ id: m.id, name: m.to, via: 'move' });
    releases.push({ id: m.id, name: m.from, via: 'move' });
  }
  for (const m of arr(plan && plan.mints)) {
    if (!isId(m && m.id) || !isName(m && m.name)) continue;
    lands.push({ id: m.id, name: m.name, via: 'mint' });
  }
  for (const r of arr(plan && plan.retires)) {
    if (!isId(r && r.id) || !isName(r && r.name)) continue;
    releases.push({ id: r.id, name: r.name, via: 'retire' });
  }
  return { lands, releases };
}

/* `ids`     : Map(documentId -> {legacy_key, status}) — ALL rows, live AND retired (see the read-cost
               note in catalog-publish.js: the absence of a status filter is load-bearing here).
   `keys`    : Map(encodedName -> {canonical_id})
   `complete`: the caller's explicit assertion that those two are the WHOLE registry for this kind.

   🔴 `encodeKey` IS IMPORTED, NOT INJECTED, AND THAT IS A REMOVED FAILURE MODE. It used to be an
   `encode` parameter. Refusal 5 does `keys.get(encode(name))` and then `if (!row) continue` — so an
   encode that disagreed with the one that WROTE those rows would make every lookup miss, every
   deletion skip its check, and REFUSAL 5 GO VACUOUS WHILE ALL ITS CELLS PASSED, because the cells
   supply a consistent encode. There was never a layering reason for the injection: this file already
   imports STATUS_LIVE from the module that defines encodeKey. Purity is untouched — encodeKey is
   deterministic — and a parameter that can be silently wrong is better deleted than documented. */
function verifyPlan(plan, { ids, keys, complete } = {}) {
  if (!plan || typeof plan !== 'object') return REFUSE('plan_malformed', `a plan must be an object; got ${JSON.stringify(plan)}`);
  if (!(ids instanceof Map) || !(keys instanceof Map)) {
    return REFUSE('plan_registry_unread', 'the verifier needs the registry index the transaction read; an unread registry is not an empty one');
  }
  /* 🔴 AND A PARTIALLY-READ REGISTRY IS NOT A COMPLETE ONE — the other half of the same sentence.
     Refusal 3 concludes "this id does not exist" from its ABSENCE in `ids`, which is sound only if
     `ids` is the whole registry for this kind. destinationVerdict already refuses on `truncated`
     before concluding anything, for exactly this reason.
     Whether a whole-collection transactional read can come back partial IS NOT ESTABLISHED (see
     catalog-publish.js) — which is the argument FOR requiring the assertion, not against it. The
     caller is the only party that can know, so it must say so explicitly, and the default is refusal
     rather than assumed completeness. If that read ever does truncate, exactly one place has to
     answer for it. */
  if (complete !== true) {
    return REFUSE('plan_registry_incomplete', 'the caller must assert that the registry index is COMPLETE for this kind; refusal 3 reads an id\'s ABSENCE as proof it does not exist, and absence from a partial read proves nothing');
  }

  /* 🔴 MALFORMED ENTRIES ARE REFUSED, NOT SKIPPED. entriesOf drops anything without the fields it
     needs; if it dropped something, the plan contains an entry nobody can judge, and judging the rest
     would report a verified plan while an unjudged operation rides along. */
  const declared = arr(plan.moves).length + arr(plan.mints).length + arr(plan.retires).length;
  const { lands, releases } = entriesOf(plan);
  const recognised = arr(plan.moves).length * 2 + arr(plan.mints).length + arr(plan.retires).length;
  if (lands.length + releases.length !== recognised) {
    return REFUSE('plan_entry_malformed', `${declared} declared operations, ${lands.length + releases.length} of ${recognised} parts readable; an entry this cannot read is one it cannot judge`);
  }

  /* ── EVERY ID THE PLAN NAMES MUST BE A SERVER-ISSUED SHAPE ──────────────────────────────────
     🔴 THIS IS THE ONE PROPERTY THE ALLOCATOR MUST NOT BE TRUSTED FOR. `allocate` is injected into
     derivePlan, which is defensible because a wrong allocator is CAUGHT — but the MINT rule only asks
     whether an id already EXISTS, and a malformed id exists nowhere, so every malformed id minted
     cleanly. Shape is precisely what the allocator controls, which makes it exactly the half the
     "it is caught" argument has to cover and did not.
     restoreIdentity has refused this since E-3 (`identity-restore.js:54`, "a restore never coins
     one") using the SAME `validIdShape` from the SAME module this file already imports STATUS_LIVE
     from. Two paths disagreeing about what an id is, with the stricter one being the path that cannot
     mint, is the wrong way round.
     🔴 SHAPE, NOT ALPHABET — and that distinction is load-bearing. x_pizza mints from a fixed
     alphabet but la_musa GRANDFATHERS its slug: `dimsum_01` is a valid canonical id. An alphabet
     check here would refuse every la_musa activation. validIdShape is written for exactly that and is
     used unchanged rather than re-implemented.
     🔴 PROTECTIVE ON MINTS; REDUNDANT-BUT-HARMLESS ON MOVES AND RETIRES — and the first version of
     this note got that wrong, so it is stated precisely. On a MINT the id is about to become a
     document path and has never been one, so validating the allocator's output is the entire point.
     On a MOVE or a RETIRE, `ids.get(id)` has already returned a row — so that id IS a key in the
     registry map and therefore IS a legal document path, and shape is true by construction. Where it
     is genuinely absent, `plan_move_id_absent` / `plan_retire_id_absent` already answer. The check is
     kept there as cheap defence in depth, NOT because it is load-bearing, so nobody reasons from it
     as though it were.
     🔴 THE ONE BEHAVIOURAL DIFFERENCE, AND ITS RISK, RECORDED. validIdShape caps length at 200
     (identity-registry.js:250) while Firestore permits longer document ids. So an EXISTING id longer
     than 200 characters would be unmovable and unretireable — a narrow lockout on data already in the
     registry, which is the failure class §3.1 names (writeVersion's unfed `stamps`). Judged
     unreachable in this system: minted tokens are ten characters and a grandfathered slug is a dish
     name. Recorded rather than resolved, because "unreachable" is what the last several refusals were
     each about. */
  for (const e of [...lands, ...releases]) {
    if (!validIdShape(e.id)) {
      return REFUSE('plan_id_shape_invalid', `${JSON.stringify(e.id)} (${e.via}, ${e.name}) is not a server-issued id shape; a plan never coins one, and a malformed id exists nowhere so the MINT rule alone would let it through`);
    }
  }

  /* ── REFUSAL 6: THE PLAN MUST BE INTERNALLY CONSISTENT, JUDGED BEFORE ANY DESTINATION ────────── */
  const byName = new Map();
  for (const l of lands) {
    if (byName.has(l.name)) {
      return REFUSE('plan_two_ids_one_name', `${l.name}: ${byName.get(l.name)} and ${l.id} both land on it; each would be permitted alone because the other is not in the registry yet, and together they are a fork`);
    }
    byName.set(l.name, l.id);
  }
  const byId = new Map();
  for (const l of lands) {
    if (byId.has(l.id)) {
      return REFUSE('plan_one_id_two_names', `${l.id}: lands on both ${byId.get(l.id)} and ${l.name}; it can claim only one, and the other key row would name an id that does not claim it`);
    }
    byId.set(l.id, l.name);
  }
  for (const r of releases) {
    if (r.via === 'retire' && byId.has(r.id)) {
      return REFUSE('plan_id_moved_and_retired', `${r.id}: retired from ${r.name} and also landed on ${byId.get(r.id)}; a plan cannot both end and continue one identity`);
    }
  }

  /* ── REFUSALS 2/3/4: THE SOURCE SIDE, against the registry the caller read ───────────────────── */
  for (const m of arr(plan.moves)) {
    const row = ids.get(m.id);
    if (!row) return REFUSE('plan_move_id_absent', `${m.id}: the plan moves it from ${JSON.stringify(m.from)}, and the registry has no such id`);
    if (row.status !== STATUS_LIVE) return REFUSE('plan_move_id_not_live', `${m.id}: the plan moves it, and it is ${JSON.stringify(row.status)}; a retired id is a reservation, not something to relocate`);
    if (row.legacy_key !== m.from) {
      return REFUSE('plan_move_source_disagrees', `${m.id}: the plan moves it from ${JSON.stringify(m.from)} but it actually claims ${JSON.stringify(row.legacy_key)}. Writing this would re-point the id while keys/${row.legacy_key} still names it, and would delete keys/${m.from} which may name a DIFFERENT live id`);
    }
  }
  for (const m of arr(plan.mints)) {
    /* 🔴 LIVE OR RETIRED. A retired id read as absent is a recycled reservation — which is why the
       registry read this verifies against carries no status filter. */
    const row = ids.get(m.id);
    if (row) {
      return REFUSE('plan_mint_id_exists', `${m.id}: the plan MINTS it and it already exists (${JSON.stringify(row.status)}, claiming ${JSON.stringify(row.legacy_key)}); a mint onto an existing id is not a mint, and onto a retired one it recycles a reservation`);
    }
  }
  for (const r of arr(plan.retires)) {
    const row = ids.get(r.id);
    if (!row) return REFUSE('plan_retire_id_absent', `${r.id}: the plan retires it from ${JSON.stringify(r.name)}, and the registry has no such id`);
    if (row.legacy_key !== r.name) {
      return REFUSE('plan_retire_source_disagrees', `${r.id}: the plan retires it from ${JSON.stringify(r.name)} but it claims ${JSON.stringify(row.legacy_key)}; retiring it would delete a key row it does not own`);
    }
  }

  /* ── REFUSAL 5: EVERY DELETION IS CONDITIONED ON THE ROW NAMING THE ID ───────────────────────── */
  /* 🔴 STRICTER THAN identity-bootstrap.js:488, DELIBERATELY. That site SKIPS the delete when the row
     names another id, and is right to: reconciliation is a repair job walking residue it did not
     create, and it must make progress. An activation is not. Reaching here means refusal 4 already
     confirmed ids/{id} claims this name while keys/{name} names someone else — the registry
     disagreeing with itself, which `assertKeyRowAgrees` and the sweep's `conflict` both refuse. The
     activation stops and the disagreement stays visible. Recorded as 🔵 MINE in v7.5, same as the two
     destination-side deviations. */
  const deletions = [];
  for (const r of releases) {
    const encoded = encodeKey(r.name);
    const row = keys.get(encoded);
    /* 🔴 NO REVERSE ROW: DELIBERATELY NOT REFUSED, AND SAID SO. Reaching here means refusal 4 already
       confirmed ids/{id} claims this name, and yet keys/{name} has no row — the missing-reverse-row
       orphan, which is the integrity sweep's territory and which the sweep repairs by WRITING the row
       rather than by refusing anything. Continuing is the decision: nothing to delete is nothing to
       delete, and refusing would lock publishing out of this restaurant until the hourly sweep ran,
       over residue the sweep is explicitly allowed to leave. The activation does not repair it either
       — that is not an activation's job, and a quiet repair inside a publish is the laundering this
       programme refuses everywhere else.
       Named because a silence that was decided and a silence that was overlooked read identically six
       months from now, and everything else in this file argues its decisions. */
    if (!row) continue;
    if (row.canonical_id !== r.id) {
      return REFUSE('plan_delete_row_names_other_id', `${r.name}: this plan would delete its key row while that row names ${JSON.stringify(row.canonical_id)}, not ${r.id}. Deleting it leaves that id live with no reverse row — the orphan the integrity sweep exists to repair`);
    }
    if (byName.has(r.name)) continue;                     // re-landed by this same plan; not a deletion
    deletions.push({ name: r.name, encoded, id: r.id });
  }

  return { ...PERMIT, lands, releases, deletions };
}

module.exports = { verifyPlan, entriesOf };
