'use strict';
// «PAUSA» (PLAN-driver-pausa-server r1.1) — the test-only INVERSE of this slice's index.js footprint (the hunk pattern, as
// tools/unassign-inverse.js): the STATUS_PRIORITY note, the on_break skip in pickEligibleDriver, the on_break refusal in
// reassertAssignable, and the break_since clears in startDriverShift / endDriverShift. Proof: unapplyPausaIndex(index.js) ===
// acf32fc8:index.js byte-for-byte (pausa-wiring.guard.test.js). Applied INNERMOST (first) in every index.js fold consumer — this
// slice is newest. Each hunk must occur EXACTLY once, else this throws. GENERATED from the acf32fc8 → candidate diff.
const INDEX_HUNKS = [
 [
  "    [`drivers/${uid}/current_shift_id`]: shiftId,\n    [`drivers/${uid}/break_since`]: null,   // Pausa: a new shift never starts paused (svc-assigner clear-only grant)\n",
  "    [`drivers/${uid}/current_shift_id`]: shiftId,\n"
 ],
 [
  "    [`drivers/${uid}/shift_ended_at`]: ServerValue.TIMESTAMP,\n    [`drivers/${uid}/break_since`]: null,   // Pausa: clocking off ends the pause\n",
  "    [`drivers/${uid}/shift_ended_at`]: ServerValue.TIMESTAMP,\n"
 ],
 [
  " *   - en_route_delivery: out delivering — last resort for stacking\n *   - on_break: NEVER offered (Pausa — skipped in pickEligibleDriver, refused in reassertAssignable)\n *   - unknown: deprioritize via the ?? 99 fallback\n",
  " *   - en_route_delivery: out delivering — last resort for stacking\n *   - on_break / unknown: deprioritize via the ?? 99 fallback\n"
 ],
 [
  "    if (d.status === 'off_shift') continue;\n    if (d.status === 'on_break') continue;   // Pausa: a paused driver is never offered an order\n",
  "    if (d.status === 'off_shift') continue;\n"
 ],
 [
  "  if (d.status === 'off_shift') return { ok: false, reason: 'off_shift' };\n  if (d.status === 'on_break') return { ok: false, reason: 'on_break' };   // Pausa: refused right before the write\n",
  "  if (d.status === 'off_shift') return { ok: false, reason: 'off_shift' };\n"
 ]
];

function apply(src, hunks, label) {
  let out = src;
  for (const [cand, base] of hunks) {
    const n = out.split(cand).length - 1;
    if (n !== 1) throw new Error(`${label}: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(cand.slice(0, 120))}`);
    out = out.replace(cand, () => base);
  }
  return out;
}
const unapplyPausaIndex = (indexSrc) => apply(indexSrc, INDEX_HUNKS, 'pausa-inverse index.js');

module.exports = { unapplyPausaIndex, INDEX_HUNKS };
