'use strict';
// R3-FIX D12 — the core of the OWNER's display-name CLI (tools/identity-display-name.js): plan, apply, read back. Pure over
// an injected RTDB handle so it is unit-testable; the CLI only adds the project guard and the argv.
//
// restaurants/{rid}/identity/display_name is the brand as customers see it ("X. Pizza", whose config `name` is "X Pizza").
// It is OPTIONAL: absent, the pickup line uses `name`. The plan:
//   • refuses a value the reader would ignore (blank, padded, or longer than BRAND_MAX) — what is written is what is shown;
//   • refuses a restaurant with no routable identity (no `name`): it never creates a partial identity node;
//   • writes ONE path and reads it back.
const { brandText, BRAND_MAX, pickupLabel } = require('../pickup-label');

const pathOf = (rid) => `restaurants/${rid}/identity/display_name`;
const RID = /^[a-z0-9_]{1,40}$/;

async function readIdentityNames(rtdb, rid) {
  const base = `restaurants/${rid}/identity`;
  const [name, display] = await Promise.all([rtdb.ref(`${base}/name`).once('value'), rtdb.ref(pathOf(rid)).once('value')]);
  return { name: name.val(), display_name: display.val() };
}

// → { ok, error } | { ok, row: { path, from, to }, label: { before, after } }
function planDisplayName({ op, rid, value, current }) {
  if (typeof rid !== 'string' || !RID.test(rid)) return { ok: false, error: `not a restaurant id: ${JSON.stringify(rid)}` };
  if (op !== 'set' && op !== 'delete') return { ok: false, error: `unknown op ${op}` };
  if (!current || typeof current.name !== 'string' || !current.name.trim()) return { ok: false, error: `${rid} has no identity name — refusing to write into a non-routable identity` };
  let to = null;
  if (op === 'set') {
    if (typeof value !== 'string' || brandText(value) !== value) return { ok: false, error: `display name must be 1–${BRAND_MAX} characters with no leading/trailing spaces (got ${JSON.stringify(value)})` };
    to = value;
  }
  const from = current.display_name === undefined ? null : current.display_name;
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

module.exports = { readIdentityNames, planDisplayName, applyDisplayName, pathOf };
