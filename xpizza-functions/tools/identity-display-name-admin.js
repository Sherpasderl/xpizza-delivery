'use strict';
// R3-FIX D12 — the core of the OWNER's display-name CLI (tools/identity-display-name.js): plan, apply, read back. Pure over
// an injected RTDB handle so it is unit-testable; the CLI only adds the project guard and the argv.
//
// restaurants/{rid}/identity/display_name is the brand as customers see it ("X. Pizza", whose config `name` is "X Pizza").
// It is OPTIONAL: absent, the pickup line uses `name`. The plan:
//   • refuses a value the reader would ignore (blank, padded, longer than BRAND_MAX, or carrying control / private-use characters)
//     — what is written is what is shown;
//   • refuses a restaurant whose identity is not ROUTING-VALID (restaurant-config's isRoutingValid — the exact shape intake
//     requires): it never writes into, or creates, a partial identity node;
//   • writes ONE path and reads it back.
// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §F) — the migration is ABSENT-FILL ONLY: `set` / `set-mark` write only
// when the field is absent; an equal value is a no-op (nothing written); a DIFFERENT existing value is PRESERVED and the plan
// refuses with `conflict: true` (the CLI exits 1 — the release gate blocks until the owner decides; `delete` is the explicit
// way back to the config name). `set-mark` writes identity/display_mark: the 1–2 character dispatch chip mark (rules: a string
// of 1–2 characters), the same contract as `set`.
const { brandText, BRAND_MAX, pickupLabel } = require('../pickup-label');
const { isRoutingValid } = require('../restaurant-config');

const pathOf = (rid) => `restaurants/${rid}/identity/display_name`;
const markPathOf = (rid) => `restaurants/${rid}/identity/display_mark`;
const MARK_MAX = 2;
const RID = /^[a-z0-9_]{1,40}$/;

// the whole identity node (small: names, hub, hours, flags) — the plan judges its routing-valid shape
async function readIdentity(rtdb, rid) {
  return (await rtdb.ref(`restaurants/${rid}/identity`).once('value')).val();
}

// absent-fill: an equal value is a no-op, a different existing value is preserved and refused (conflict)
const absentFill = (field, rid, from, to) => {
  if (from === null) return null;
  if (from === to) return { noop: true };
  return { ok: false, conflict: true, error: `${rid}'s ${field} is already ${JSON.stringify(from)} (≠ ${JSON.stringify(to)}) — PRESERVED; absent-fill only, the owner decides (delete first to replace it)` };
};

// → { ok, error[, conflict] } | { ok, row: { path, from, to }, label: { before, after }[, noop] }
function planDisplayName({ op, rid, value, current }) {
  if (typeof rid !== 'string' || !RID.test(rid)) return { ok: false, error: `not a restaurant id: ${JSON.stringify(rid)}` };
  if (op === 'set-mark') return planDisplayMark({ rid, value, current });
  if (op !== 'set' && op !== 'delete') return { ok: false, error: `unknown op ${op}` };
  if (!isRoutingValid(current)) return { ok: false, error: `${rid}'s identity is not routing-valid (missing or malformed) — refusing to write into it` };
  let to = null;
  if (op === 'set') {
    if (typeof value !== 'string' || brandText(value) !== value) return { ok: false, error: `display name must be 1–${BRAND_MAX} characters with no leading/trailing spaces (got ${JSON.stringify(value)})` };
    to = value;
  }
  const from = current.display_name === undefined ? null : current.display_name;   // null when absent
  const fill = op === 'set' ? absentFill('display_name', rid, from, to) : null;
  if (fill && fill.conflict) return fill;
  return {
    ok: true,
    row: { path: pathOf(rid), from, to },
    label: { before: pickupLabel(from, current.name), after: pickupLabel(to, current.name) },
    ...(fill ? fill : {}),
  };
}

// → an error string, or null for a valid mark (pure: the CLI also checks it BEFORE any database client exists)
function markValueError(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MARK_MAX || brandText(value) !== value) {
    return `display mark must be 1–${MARK_MAX} characters with no spaces or control characters (got ${JSON.stringify(value)})`;
  }
  return null;
}

// set-mark: identity/display_mark, 1–MARK_MAX characters (no padding / control / private-use characters), absent-fill only
function planDisplayMark({ rid, value, current }) {
  if (!isRoutingValid(current)) return { ok: false, error: `${rid}'s identity is not routing-valid (missing or malformed) — refusing to write into it` };
  const bad = markValueError(value);
  if (bad) return { ok: false, error: bad };
  const from = current.display_mark === undefined ? null : current.display_mark;
  const fill = absentFill('display_mark', rid, from, value);
  if (fill && fill.conflict) return fill;
  return { ok: true, row: { path: markPathOf(rid), from, to: value }, ...(fill ? fill : {}) };
}

// set / set-mark: absent-fill enforced AT COMMIT (codex build r1 P2) — an IDENTITY transaction fills only an absent value; an equal
// value is a no-op; a different value (even one written after the plan was made) is PRESERVED and reported as a conflict.
// delete stays the explicit replace path. ORCHESTRATION O1a (advisor ruling): every write that CHANGES the identity bumps
// `version` by exactly 1 in the SAME transaction (a no-op / conflict writes nothing); an identity without a numeric version at
// commit is refused (`unversioned`). Null-first safe: the cached-null pass answers null, never creates an identity. Read back.
async function applyDisplayName(rtdb, plan) {
  const { path, to } = plan.row;
  const field = path.slice(path.lastIndexOf('/') + 1);
  let unversioned = false;
  await rtdb.ref(path.slice(0, path.lastIndexOf('/'))).transaction((cur) => {
    unversioned = false;
    if (cur === null) return null;
    const has = cur[field] !== undefined && cur[field] !== null;
    if (to === null ? !has : has) return undefined;   // nothing to delete / absent-fill refuses a present value
    if (!Number.isFinite(cur.version)) { unversioned = true; return undefined; }
    const next = { ...cur, version: cur.version + 1 };
    if (to === null) delete next[field]; else next[field] = to;
    return next;
  });
  const back = (await rtdb.ref(path).once('value')).val();
  if (unversioned) return { ok: false, error: 'unversioned', back };
  if (to === null) return { ok: back === null, back };
  if (back === to) return { ok: true, back };
  return { ok: false, conflict: back != null, back };
}

module.exports = { readIdentity, planDisplayName, planDisplayMark, markValueError, applyDisplayName, pathOf, markPathOf, MARK_MAX };
