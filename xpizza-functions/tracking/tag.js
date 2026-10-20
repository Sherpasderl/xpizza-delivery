'use strict';
// TRACKER FIXES — the public owner tag: HMAC-SHA256(secret, uid), 16 hex chars. order_tracking is publicly readable by token, so the
// fence key never exposes the uid. The secret is server-only (MAKE_SECRET in production; injected in tests).
const crypto = require('crypto');
function tagOf(secret, uid) {
  if (!uid) return 'none';
  return crypto.createHmac('sha256', String(secret)).update(String(uid)).digest('hex').slice(0, 16);
}
module.exports = { tagOf };
