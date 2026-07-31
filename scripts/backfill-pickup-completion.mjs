// One-off: mark already-collected PICKUP orders (stuck non-terminal) as status='completed'.
// STRICTLY pickup + non-terminal → physically cannot touch a delivery order. Dry-run by default.
// Each applied write fires earnRewardsOnCompletion (retroactive earn/consume, idempotent via earn_${id}).
const TERMINAL = new Set(['completed', 'delivered', 'cancelled']);

export function selectBackfillCandidates(orders) {
  return Object.values(orders || {}).filter(
    (o) => o && o.order_type === 'pickup' && !TERMINAL.has(o.status)
  );
}

// Runner runs only when invoked directly (not on import → tests stay pure).
if (import.meta.url === `file://${process.argv[1]}`) {
  const admin = await import('firebase-admin');
  const apply = process.argv.includes('--apply');   // default = DRY RUN
  admin.default.initializeApp();
  const db = admin.default.database();
  const snap = await db.ref('orders').get();
  const candidates = selectBackfillCandidates(snap.val());
  console.log(`Pickup backfill: ${candidates.length} candidate(s) [${apply ? 'APPLY' : 'DRY RUN'}]:`);
  for (const o of candidates) console.log(`  ${o.order_id}  (${o.status} -> completed)  [fires retroactive earn/consume]`);
  if (!apply) { console.log('DRY RUN - no writes. Re-run with --apply after reviewing the list.'); process.exit(0); }
  for (const o of candidates) { await db.ref(`orders/${o.order_id}/status`).set('completed'); console.log(`  wrote ${o.order_id} -> completed`); }
  console.log(`Done: ${candidates.length} written.`);
  process.exit(0);
}
