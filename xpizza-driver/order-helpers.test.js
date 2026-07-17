// Pure order-helper tests — run: `node order-helpers.test.js` (no framework, repo idiom).
import assert from 'node:assert/strict';
import { displayOrderLabel } from './order-helpers.js';

let passed = 0;
function t(name, fn) { fn(); passed++; }

// ---------- displayOrderLabel(o) — the human-friendly order # (display only; never a key) ----------
// display_number present → '#N'
t('label: display_number 47 → "#47"', () => assert.equal(displayOrderLabel({ display_number: 47, order_id: 'PZX-x' }), '#47'));
t('label: display_number 1 → "#1"', () => assert.equal(displayOrderLabel({ display_number: 1 }), '#1'));
t('label: numeric-string "47" → "#47"', () => assert.equal(displayOrderLabel({ display_number: '47' }), '#47'));
// absent → graceful fallback to order_id (never blank), until Core stamps the number
t('label: no display_number → order_id fallback', () => assert.equal(displayOrderLabel({ order_id: 'PZX-260716-1' }), 'PZX-260716-1'));
t('label: no display_number → orderId (wrapper) fallback', () => assert.equal(displayOrderLabel({ orderId: 'PZX-abc' }), 'PZX-abc'));
// robustness — never throws, never a bogus "#"
t('label: null → ""', () => assert.equal(displayOrderLabel(null), ''));
t('label: undefined → ""', () => assert.equal(displayOrderLabel(undefined), ''));
t('label: {} → ""', () => assert.equal(displayOrderLabel({}), ''));
t('label: display_number 0 (never occurs) → fallback, not "#0"', () => assert.equal(displayOrderLabel({ display_number: 0, order_id: 'PZX-z' }), 'PZX-z'));
t('label: junk display_number → fallback, not "#abc"', () => assert.equal(displayOrderLabel({ display_number: 'abc', order_id: 'PZX-j' }), 'PZX-j'));

console.log(`✓ order-helpers: ${passed} tests passed`);
