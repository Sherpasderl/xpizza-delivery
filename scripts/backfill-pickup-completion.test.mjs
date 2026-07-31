import { strict as assert } from 'node:assert';
import { selectBackfillCandidates } from './backfill-pickup-completion.mjs';

const orders = {
  a: { order_id: 'a', order_type: 'pickup',   status: 'ready' },            // ✓ candidate (live kitchen)
  b: { order_id: 'b', order_type: 'pickup',   status: 'completed' },        // ✗ already terminal
  c: { order_id: 'c', order_type: 'pickup',   status: 'cancelled' },        // ✗ terminal
  d: { order_id: 'd', order_type: 'delivery', status: 'ready' },            // ✗ NOT pickup (never touch delivery)
  e: { order_id: 'e', order_type: 'pickup',   status: 'preparing' },        // ✓ candidate (live kitchen)
  f: { order_id: 'f', order_type: 'pickup',   status: 'new' },              // ✓ candidate (live kitchen)
  g: { order_id: 'g', order_type: 'pickup',   status: 'pending_payment' },  // ✗ UNPAID — must never earn
  h: { order_id: 'h', order_type: 'pickup',   status: 'scheduled' },        // ✗ held, not collected
  i: { order_id: 'i', order_type: 'pickup',   status: 'releasing' },        // ✗ held, not collected
};
const ids = selectBackfillCandidates(orders).map(o => o.order_id).sort();
assert.deepEqual(ids, ['a', 'e', 'f']);
console.log('ok: selectBackfillCandidates = live-kitchen pickups only (excludes terminal, unpaid, held, delivery)');
