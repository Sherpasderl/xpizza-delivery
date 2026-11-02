'use strict';
// CONVERGENCE §1 (Codex run 5 P1) — the ONE RTDB-safe encoding of the v1 fields, shared by the generator (write + compare), the reader
// and the drift check. RTDB does not store a null leaf, an empty object or an empty ARRAY — the child simply disappears — so the two
// schema values that can be "empty" are OMITTED on the wire and RESTORED on the way back:
//   rewards: null           ⇔  no `rewards` child
//   redemption.exclude: []  ⇔  no `exclude` child (points redemption only)
// RTDB applies encodeFields' omission itself on write; decodeFields is applied to EVERY stored node before validation or comparison
// (the reader, the generator's unchanged/conflict check, drift). decode(encode(f)) === f for every valid f (asserted).
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function encodeFields(f) {
  const out = clone(f);
  if (out.rewards === null) delete out.rewards;
  else if (out.rewards && out.rewards.redemption && Array.isArray(out.rewards.redemption.exclude) && out.rewards.redemption.exclude.length === 0) delete out.rewards.redemption.exclude;
  return out;
}
function decodeFields(raw) {
  if (!isObj(raw)) return raw;
  const out = clone(raw);
  if (!('rewards' in out)) out.rewards = null;
  else if (isObj(out.rewards) && isObj(out.rewards.redemption) && out.rewards.redemption.kind === 'points' && !('exclude' in out.rewards.redemption)) out.rewards.redemption.exclude = [];
  return out;
}

module.exports = { encodeFields, decodeFields };
