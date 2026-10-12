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
const { brandText, BRAND_MAX, pickupLabel } = require('../pickup-label');
const { isRoutingValid } = require('../restaurant-config');

const pathOf = (rid) => `restaurants/${rid}/identity/display_name`;
const RID = /^[a-z0-9_]{1,40}$/;

// the whole identity node (small: names, hub, hours, flags) — the plan judges its routing-valid shape
async function readIdentity(rtdb, rid) {
  return (await rtdb.ref(`restaurants/${rid}/identity`).once('value')).val();
}

// → { ok, error } | { ok, row: { path, from, to }, label: { before, after } }
function planDisplayName({ op, rid, value, current }) {
  if (typeof rid !== 'string' || !RID.test(rid)) return { ok: false, error: `not a restaurant id: ${JSON.stringify(rid)}` };
  if (op !== 'set' && op !== 'delete') return { ok: false, error: `unknown op ${op}` };
  if (!isRoutingValid(current)) return { ok: false, error: `${rid}'s identity is not routing-valid (missing or malformed) — refusing to write into it` };
  let to = null;
  if (op === 'set') {
    if (typeof value !== 'string' || brandText(value) !== value) return { ok: false, error: `display name must be 1–${BRAND_MAX} characters with no leading/trailing spaces (got ${JSON.stringify(value)})` };
    to = value;
  }
  const from = current.display_name === undefined ? null : current.display_name;   // null when absent
  return {
    ok: true,
    row: { path: pathOf(rid), from, to },
    label: { before: pickupLabel(from, current.name), after: pickupLabel(to, current.name) },
  };
}

async function applyDisplayName(rtdb, plan) {
  await rtdb.ref().update({ [plan.row.path]: plan.row.to });
  const back = (await rtdb.ref(plan.row.path).once('value')).val();
  return { ok: back === plan.row.to, back };
}

module.exports = { readIdentity, planDisplayName, applyDisplayName, pathOf };
