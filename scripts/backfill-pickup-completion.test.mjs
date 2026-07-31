import { strict as assert } from 'node:assert';
import { selectBackfillCandidates } from './backfill-pickup-completion.mjs';

const orders = {
  a: { order_id: 'a', order_type: 'pickup',   status: 'ready' },      // ✓ candidate
  b: { order_id: 'b', order_type: 'pickup',   status: 'completed' },  // ✗ already terminal
  c: { order_id: 'c', order_type: 'pickup',   status: 'cancelled' },  // ✗ terminal
  d: { order_id: 'd', order_type: 'delivery', status: 'ready' },      // ✗ NOT pickup (never touch delivery)
  e: { order_id: 'e', order_type: 'pickup',   status: 'preparing' },  // ✓ candidate
};
const ids = selectBackfillCandidates(orders).map(o => o.order_id).sort();
assert.deepEqual(ids, ['a', 'e']);
console.log('ok: selectBackfillCandidates picks only non-terminal pickups, never delivery');
