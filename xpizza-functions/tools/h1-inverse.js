'use strict';
// H1a (PLAN-H1a r2 T8 + amendment A-R1) — the slice's index.js INVERSE. H1a adds ONE delimited block at the END of index.js:
//   "\n/* h1:begin */ … /* h1:end */\n"
// plus SEVEN one-line hunks inside existing functions (A-R1: heldByReject in autoAssignOnOrderCreate, the sweepPendingOrders
// offer pass + its fresh re-check, monitorAssignmentTimeout's takeover branch; safeRejectRepair after sweepStuckOrders' loop;
// codex r1 P1-2: holdAfterClaim before autoAssign's and the timeout reassign's finalize).
// unapplyH1Index swaps each hunk back (each must occur exactly once) and removes the block (exactly once, both delimiters,
// begin before end), returning the index.js that existed before H1a, byte-for-byte. It is the NEWEST layer, so every index.js-reversing wiring guard applies it FIRST
// (innermost), before S1a's inverse. h1-wiring.guard.test.js proves the result equals the base and that the block is the ONLY
// change; a byte inside, a missing delimiter, a second block and a byte outside are each caught.
const BEGIN = '/* h1:begin */';
const END = '/* h1:end */';

const INDEX_HUNKS = Object.freeze([
 {
  "was": "    if (pickup.status === 'cancelled') {\n",
  "now": "    if (merchantHooks.heldByReject(orderNow)) { console.log(`autoAssign: ${orderId} held (handheld reject / cancel claim), skipping`); return; } if (pickup.status === 'cancelled') {   // h1 A-R1\n"
 },
 {
  "was": "      if (!sweepDecision(order, tasks, now, opts).sweep) continue;\n",
  "now": "      if (!sweepDecision(order, tasks, now, opts).sweep || merchantHooks.heldByReject(order)) continue;   // h1 A-R1\n"
 },
 {
  "was": "        const stillSweepable = !!orderNow && AUTO_ASSIGNABLE_STATUSES.has(orderNow.status);\n",
  "now": "        const stillSweepable = !!orderNow && AUTO_ASSIGNABLE_STATUSES.has(orderNow.status) && !merchantHooks.heldByReject(orderNow);   // h1 A-R1\n"
 },
 {
  "was": "    if (attempts >= MAX_ATTEMPTS_BEFORE_TAKEOVER) {\n",
  "now": "    if (attempts >= MAX_ATTEMPTS_BEFORE_TAKEOVER || merchantHooks.heldByReject(orderForTimeout)) {   // h1 A-R1: a held order → takeover, never a reassign\n"
 },
 {
  "was": "      }\n    }\n  }\n);\n",
  "now": "      }\n    } await merchantHooks.safeRejectRepair(db, orders, now);   // h1 A-R1 — never throws; after the existing loop, same snapshot\n  }\n);\n"
 },
 {
  "was": "    const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);\n",
  "now": "    if (await merchantHooks.holdAfterClaim(db, orderId, (o) => !AUTO_ASSIGNABLE_STATUSES.has(o.status))) { console.log(`autoAssign: ${orderId} held or gone after the claim, rolling back`); await claim.rollback(); return; } const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);   // h1 A-R1\n"
 },
 {
  "was": "    const reassignUpdates = buildAssignmentUpdates(orderId, nextDriver.driverId, attempts + 1, true);\n",
  "now": "    const hold = await merchantHooks.holdAfterClaim(db, orderId, (o) => o.status === 'cancelled'); if (hold === 'gone') { await claim.rollback(); return; } if (hold === 'held') { if (await merchantHooks.releaseHeld(db, orderId, nextDriver.driverId)) await db.ref('dispatcher_alerts').push({ type: 'no_response_takeover', order_id: orderId, customer_name: orderForTimeout.recipient_name || 'Cliente', total: orderForTimeout.total || null, attempts, created_at: ServerValue.TIMESTAMP }); return; } const reassignUpdates = buildAssignmentUpdates(orderId, nextDriver.driverId, attempts + 1, true);   // h1 A-R1\n"
 }
]);

function unapplyH1Hunks(src) {
  let out = src;
  for (const h of INDEX_HUNKS) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`h1-inverse: an A-R1 index.js hunk occurs ${n} times (expected exactly 1): ${h.now.trim().slice(0, 70)}`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}

function unapplyH1Index(src) {
  src = unapplyH1Hunks(src);
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b < 0 || e < 0) throw new Error(`h1 block not found exactly once (begin ${b >= 0}, end ${e >= 0})`);
  if (src.indexOf(BEGIN, b + 1) >= 0 || src.indexOf(END, e + 1) >= 0) throw new Error('h1 block not found exactly once (a second delimiter)');
  if (e < b) throw new Error('h1 block delimiters out of order');
  const start = b - 1;                                   // the blank-line separator before the block
  if (src[start] !== '\n') throw new Error('h1 block is not preceded by its blank-line separator');
  const stop = e + END.length;
  if (src[stop] !== '\n') throw new Error('h1 block is not followed by its trailing newline');
  return src.slice(0, start) + src.slice(stop + 1);
}

module.exports = { BEGIN, END, INDEX_HUNKS, unapplyH1Hunks, unapplyH1Index };
