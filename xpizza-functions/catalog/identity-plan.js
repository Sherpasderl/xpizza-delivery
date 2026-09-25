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
const { STATUS_LIVE } = require('./identity-registry');

const REFUSE = (code, detail) => ({ ok: false, code, detail });
const PERMIT = { ok: true, code: 'plan_verified', detail: '' };

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

/* `ids` : Map(documentId -> {legacy_key, status})  — ALL rows, live AND retired (see the read-cost
           note in catalog-publish.js: the absence of a status filter is load-bearing here).
   `keys`: Map(encodedName -> {canonical_id})
   `encode`: the same encodeKey the registry uses, injected so this stays pure. */
function verifyPlan(plan, { ids, keys, encode } = {}) {
  if (!plan || typeof plan !== 'object') return REFUSE('plan_malformed', `a plan must be an object; got ${JSON.stringify(plan)}`);
  if (!(ids instanceof Map) || !(keys instanceof Map) || typeof encode !== 'function') {
    return REFUSE('plan_registry_unread', 'the verifier needs the registry index the transaction read; an unread registry is not an empty one');
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
    const encoded = encode(r.name);
    const row = keys.get(encoded);
    if (!row) continue;                                   // nothing to delete
    if (row.canonical_id !== r.id) {
      return REFUSE('plan_delete_row_names_other_id', `${r.name}: this plan would delete its key row while that row names ${JSON.stringify(row.canonical_id)}, not ${r.id}. Deleting it leaves that id live with no reverse row — the orphan the integrity sweep exists to repair`);
    }
    if (byName.has(r.name)) continue;                     // re-landed by this same plan; not a deletion
    deletions.push({ name: r.name, encoded, id: r.id });
  }

  return { ...PERMIT, lands, releases, deletions };
}

module.exports = { verifyPlan, entriesOf };
