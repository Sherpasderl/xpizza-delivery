'use strict';
// §7 decline buckets (PLAN-sdk-d4-r5). ONE table op.result.code → 'retryable' | 'wrong_data', INITIALLY EMPTY: no BAC code is
// invented; an entry is added only from persisted evidence, each reviewed. The client never receives a raw code.
const TABLE = Object.freeze({});
function bucketOf(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.kind === 'token_expired_confirmed') return 'token_expired';
  if (result.kind === 'requires_action') return 'hard';   // Q3 (OWNER 11-10): a challenged token charge is declined
  if (result.kind !== 'definitive_decline') return null;
  const b = Object.prototype.hasOwnProperty.call(TABLE, result.code) ? TABLE[result.code] : null;
  return b === 'retryable' || b === 'wrong_data' ? b : 'hard';
}
module.exports = { TABLE, bucketOf };
