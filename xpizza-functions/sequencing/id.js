'use strict';
// BUILD-stacked-seq-server r5 §1 / T2 — the canonical stack id. ONE record per (driver, unordered pair): the pair is sorted, and
// the tuple is JSON-array encoded before hashing, so `_` (or any character) inside an id can never make two tuples collide.
const crypto = require('crypto');

function stackIdFor(uid, oidA, oidB) {
  for (const [k, v] of [['uid', uid], ['oidA', oidA], ['oidB', oidB]]) {
    if (typeof v !== 'string' || v === '') throw new Error(`stackIdFor: ${k} must be a non-empty string`);
  }
  if (oidA === oidB) throw new Error('stackIdFor: the pair must be two distinct orders');
  const pair = oidA < oidB ? [oidA, oidB] : [oidB, oidA];
  const stack_id = 'stk_' + crypto.createHash('sha256').update(JSON.stringify([uid, pair[0], pair[1]])).digest('hex').slice(0, 32);
  return { stack_id, pair };
}

module.exports = { stackIdFor };
