'use strict';

// order-dedup — pure content-key + re-tap decision (Layer 2 content-aware phone rate limit).
// Run: node order-dedup.test.js
const assert = require('assert');
const { orderContentKey, isContentRetap } = require('./order-dedup');

const base = { phone: '+504 3367-2490', itemsText: '1x Pad Thai - Camarones (L414)', orderType: 'delivery', scheduledFor: null };
const k = orderContentKey(base);
assert.equal(k, orderContentKey({ ...base, phone: '33672490' }), 'phone normalized (digits only) → same key');
assert.equal(k, orderContentKey({ ...base, phone: '504-3367-2490' }), 'phone punctuation ignored → same key');
assert.notEqual(k, orderContentKey({ ...base, itemsText: '2x Pad Thai - Camarones (L828)' }), 'different cart → different key');
assert.notEqual(k, orderContentKey({ ...base, orderType: 'pickup' }), 'different type → different key');
assert.notEqual(k, orderContentKey({ ...base, scheduledFor: 1787000000000 }), 'scheduled vs ASAP → different key');
assert.equal(orderContentKey({ ...base, scheduledFor: null }), orderContentKey({ ...base, scheduledFor: undefined }), 'null/undefined slot both = ASAP');
assert.equal(typeof k, 'string');
assert.ok(/^[0-9a-f]+$/.test(k), 'rtdb-safe hex key (no . $ # [ ] /)');
assert.equal(orderContentKey({}), orderContentKey({ phone: '', itemsText: '', orderType: '', scheduledFor: null }), 'empty inputs stable');

// re-tap decision
assert.equal(isContentRetap(null, 1000, 120000), false, 'no record → count');
assert.equal(isContentRetap(undefined, 1000, 120000), false, 'undefined record → count');
assert.equal(isContentRetap({ at: 1000 }, 1000 + 119000, 120000), true, 'within window → re-tap (skip)');
assert.equal(isContentRetap({ at: 1000 }, 1000 + 120000, 120000), false, 'at window edge → count (exclusive)');
assert.equal(isContentRetap({ at: 1000 }, 1000 + 121000, 120000), false, 'after window → count');
assert.equal(isContentRetap({ at: 'x' }, 2000, 120000), false, 'non-finite at → count');
assert.equal(isContentRetap({}, 2000, 120000), false, 'missing at → count');

console.log('order-dedup: OK');
