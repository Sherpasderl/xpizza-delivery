'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-P1 — THE DESTINATION-CLAIMANT GUARD (§4, inv #2/#4), AS A PURE PREDICATE.
//
// 🔴 WHAT IT EXISTS FOR — THE MIGRATION-BOUNDARY FORK. The active certified set does NOT exhaust live
// registry ownership during the migration. A pre-P1 rename minted a new id and left the OLD one live,
// still claiming the old name (`catalog-publish.js:373` never retired it). That orphan is invisible to
// every check that reasons about the active version, because it is not IN the active version — and it
// is exactly what a later move or mint can land on top of, leaving two live ids claiming one name.
// Two live ids for one name is the fork §2 inv #2/#4 says no path may produce.
//
// So for every destination name an activation writes, the guard asks the registry itself: who claims
// this name RIGHT NOW, including claimants nobody in the active version has heard of? Landing is
// permitted only when every live claimant there is released by THIS SAME plan — moved off the name or
// retired by it. Otherwise the whole activation REFUSES. It does not overwrite the orphan and it does
// not quietly retire it: "the sweep quietly retired some ids" is indistinguishable from a bug, and an
// activation is not the place to launder residue. Reconciliation retires it deliberately and logged
// (§3.0), and then the same activation succeeds.
//
// 🔴 WHY IT IS PURE, AND WHAT THAT DOES NOT BUY. The reads this predicate judges — the destination key
// row and the live reverse claimants — MUST happen inside the activation's own transaction and BEFORE
// any write, because a claimant read outside it is a claimant that can appear afterwards. Purity here
// buys that every branch is reachable from a unit test, which is the half that end-to-end cells are
// worst at; it buys nothing about the read being transactional, and a caller that reads late defeats
// the guard without changing a line of this file. See `planDestinations` for the read list.
//
// 🔴 NOT WIRED YET, AND THAT IS THE DESIGN — NOT A DROPPED REQUIREMENT. The guard is a property of
// the WRITE, and the write does not exist yet: as of Slice D nothing inside the flip transaction
// mints, moves or retires anything (`ensureIdentitiesForKeys` still mints post-flip for every live
// key, `catalog-publish.js:764`, which §4 says E removes). Wiring the guard to a plan that is empty on
// every path that exists would be code that looks live, passes its cells and protects nothing — the
// shape the activation record was refused in when it was briefly gated on `certified`. So the
// PREDICATE lands in D, exercised by its own unit cells, and the guard is DEFERRED TO SLICE E, where
// it sits in front of the atomic writer. E's gate refuses that writer if this is not wired ahead of
// it. Anything that reaches this file before E is a caller that does not exist yet.
//
// 🔴 TWO REFUSALS HERE ARE STRICTER THAN §4 READ LITERALLY, marked 🔵 MINE below and flagged to the
// advisor rather than smuggled in: a pre-existing fork (more than one live claimant on one name), and
// a key row naming an id that is not a live claimant. §4 would permit the first when the plan releases
// every claimant. Both are the registry disagreeing with itself, both are refused elsewhere in this
// codebase already (`identity_bootstrap_ambiguous`, `assertKeyRowAgrees`, the sweep's `conflict`), and
// papering over either one inside an activation destroys the evidence of it. Both are APPROVED
// deviations, recorded as an amendment on the spec branch so the next reader does not "fix" this back
// to the letter of v7.
// ---------------------------------------------------------------------------
const { STATUS_LIVE } = require('./identity-registry');

const isName = (v) => typeof v === 'string' && v.length > 0;
const isId = (v) => typeof v === 'string' && v.length > 0;
const asArray = (v) => (Array.isArray(v) ? v : []);

const permit = (code, detail) => ({ ok: true, code, detail: detail || '' });
const refuse = (code, detail, extra) => ({ ok: false, code, detail, ...(extra || {}) });

/* THE DESTINATIONS AN ACTIVATION WRITES, and therefore the exact set of names whose claimants must be
   read before it writes anything. Exported because the caller cannot be trusted to re-derive it: a
   read list computed by hand somewhere else is how a destination goes unchecked, and an unchecked
   destination is the whole hazard. A move's `to` and a mint's `name` are destinations; a move's `from`
   and a retire's `name` are NOT — those are being released, not claimed. */
function planDestinations(plan) {
  const out = [];
  for (const m of asArray(plan && plan.moves)) {
    if (m && isName(m.to) && isId(m.id)) out.push({ name: m.to, landingId: m.id, via: 'move' });
  }
  for (const m of asArray(plan && plan.mints)) {
    if (m && isName(m.name) && isId(m.id)) out.push({ name: m.name, landingId: m.id, via: 'mint' });
  }
  return out;
}

/* WHICH IDS THIS PLAN RELEASES FROM A GIVEN NAME. A move releases the name it moves AWAY from; a
   retirement releases the name it retires. Derived from the plan rather than taken as an argument, so
   a caller cannot hand in a released-set that is more generous than the plan it claims to describe —
   that set is the entire difference between "permitted" and "forked", and computing it twice in two
   places is how the two copies drift. */
function releasedFrom(plan, name) {
  const out = new Set();
  for (const m of asArray(plan && plan.moves)) {
    if (m && isId(m.id) && m.from === name && m.to !== name) out.add(m.id);
  }
  for (const r of asArray(plan && plan.retires)) {
    if (r && isId(r.id) && r.name === name) out.add(r.id);
  }
  return out;
}

/* THE VERDICT FOR ONE DESTINATION.
   `keyRow`         — the destination's `keys/{encode(name)}` document data, or null when absent.
   `liveClaimants`  — every `ids/*` row with `legacy_key == name` AND `status == live`, as
                      [{id, legacy_key, status}], read in the SAME transaction that will write.
   `truncated`      — true when that query hit a cap. §4: an overflow must ABORT the activation, never
                      truncate claimant discovery, because a truncated scan misses the very orphan the
                      guard exists to catch. Modelled here so the refusal is a decision, not an
                      accident of how many rows happened to come back. */
function destinationVerdict({ name, landingId, keyRow = null, liveClaimants = [], truncated = false, plan = null } = {}) {
  if (!isName(name) || !isId(landingId)) {
    return refuse('destination_input_malformed',
      `a destination needs a name and the id landing on it; got ${JSON.stringify(name)} / ${JSON.stringify(landingId)}`);
  }
  if (!Array.isArray(liveClaimants)) {
    return refuse('destination_input_malformed',
      `${name}: the live claimant set must be an array — an absent one is not an empty one, and reading it as empty is how an orphan goes unseen`);
  }
  /* 🔴 TRUNCATION IS CHECKED BEFORE ANYTHING IS CONCLUDED FROM THE SET, because everything below reads
     a short set as good news: no claimants looks like a free name, and one claimant looks like a
     complete picture. */
  if (truncated === true) {
    return refuse('destination_claimants_truncated',
      `${name}: the live-claimant query hit its cap, so the set is incomplete; an activation may not land on a name whose claimants were only partly discovered`);
  }

  /* The caller's contract is LIVE claimants. Being handed anything else means the query was not the
     one the guard needs, and guessing which rows to keep would make this predicate agree with a wrong
     query. Refused rather than filtered. */
  const notLive = liveClaimants.filter((c) => !c || c.status !== STATUS_LIVE);
  if (notLive.length) {
    return refuse('destination_claimants_not_live',
      `${name}: the claimant set must contain only live rows; got ${JSON.stringify(notLive.map((c) => (c && c.status) || null))}`);
  }
  const offName = liveClaimants.filter((c) => c.legacy_key !== name);
  if (offName.length) {
    return refuse('destination_claimants_off_name',
      `${name}: the claimant set contains rows claiming other names (${JSON.stringify(offName.map((c) => c.legacy_key))}); this set decides whether a name is free and must be the claimants OF THAT NAME`);
  }

  const claimantIds = liveClaimants.map((c) => c.id).filter(isId);
  const rowId = keyRow && isId(keyRow.canonical_id) ? keyRow.canonical_id : null;

  /* 🔵 MINE (stricter than §4 read literally). The forward row naming an id that does not live-claim
     this name is the registry disagreeing with itself — a half-done retirement, or a claim that moved
     after the row was written. `assertKeyRowAgrees` and the sweep both refuse exactly this rather than
     repair it, and landing here would overwrite the evidence with a row that looks healthy. The
     landing id itself is exempt: writing the mapping that is already there cannot fork anything. */
  if (rowId && rowId !== landingId && !claimantIds.includes(rowId)) {
    return refuse('destination_key_row_disagrees',
      `${name}: the key row names ${rowId}, which does not live-claim it; the registry disagrees with itself and an activation must not write over the evidence`,
      { key_row_id: rowId, live_claimants: claimantIds.slice() });
  }

  const others = claimantIds.filter((id) => id !== landingId);

  /* 🔵 MINE (stricter than §4 read literally). Two live ids already claiming one name is the fork
     inv #2/#4 says no path may produce, so it is corruption that predates this plan. §4 read literally
     would permit landing when the plan releases both; this refuses, because an activation is not the
     place to launder a fork — reconciliation retires deliberately and logged (§3.0), and the
     activation succeeds afterwards. Its own code, so it can never be read as the ordinary
     orphan-in-the-way case. */
  if (others.length > 1) {
    return refuse('destination_forked',
      `${name}: ${others.sort().join(', ')} all live-claim it already; that fork predates this activation and must be reconciled deliberately, not written over`,
      { live_claimants: others.slice() });
  }

  if (others.length === 1) {
    const held = others[0];
    const released = releasedFrom(plan, name);
    if (!released.has(held)) {
      return refuse('destination_claimed',
        `${name}: ${held} live-claims it and this plan neither moves it off nor retires it; landing here would leave two live ids claiming one name`,
        { claimant: held });
    }
    return permit('claimant_released',
      `${name}: ${held} live-claims it and is released by this same plan`);
  }

  if (rowId === landingId) return permit('already_ours', `${name}: ${landingId} already holds it; this write is a no-op`);
  return permit('unclaimed', `${name}: no live claimant and no key row`);
}

/* EVERY destination of a plan, judged. Returns one entry per destination in plan order so the caller
   can refuse naming ALL of them rather than whichever happened to be read first — a merchant told
   about one blocked name at a time, who fixes it and hits the next, learns nothing about the shape of
   what is wrong.
   `reads` is name → {keyRow, liveClaimants, truncated}. A destination with NO entry is not treated as
   unclaimed: an unread destination is the one case the guard cannot have an opinion about, and
   defaulting it to "free" would make forgetting to read a name indistinguishable from the name being
   available. */
function judgePlanDestinations(plan, reads) {
  const r = reads instanceof Map ? reads : new Map(Object.entries(reads || {}));
  return planDestinations(plan).map(({ name, landingId, via }) => {
    if (!r.has(name)) {
      return { name, landingId, via,
        verdict: refuse('destination_unread',
          `${name}: this activation writes it but its claimants were never read; a destination nobody read is not a destination nobody claims`) };
    }
    const { keyRow = null, liveClaimants = [], truncated = false } = r.get(name) || {};
    return { name, landingId, via, verdict: destinationVerdict({ name, landingId, keyRow, liveClaimants, truncated, plan }) };
  });
}

module.exports = { destinationVerdict, judgePlanDestinations, planDestinations, releasedFrom };
