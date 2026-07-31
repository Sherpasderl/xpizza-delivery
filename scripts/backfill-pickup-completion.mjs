// One-off: mark already-collected PICKUP orders (stuck in a live kitchen state) as status='completed'.
//
// SAFETY (money-adjacent — each write fires earnRewardsOnCompletion → earn/consume):
//   - Strictly order_type==='pickup' → PHYSICALLY cannot touch a delivery order.
//   - ALLOWLIST of live kitchen states {new, preparing, ready} — NOT a denylist. This EXCLUDES:
//       terminal (completed/delivered/cancelled — already done),
//       pending_payment (NOT paid → must never be marked completed / earn),
//       scheduled / releasing (held, not collected).
//   - Dry-run by default; --apply required. Review the dry-run list (confirm each was actually
//     collected) before applying. Retroactive earn/consume is idempotent (earn_${id} + state machine).
const LIVE_KITCHEN = new Set(['new', 'preparing', 'ready']);

export function selectBackfillCandidates(orders) {
  return Object.values(orders || {}).filter(
    (o) => o && o.order_type === 'pickup' && LIVE_KITCHEN.has(o.status)
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
