'use strict';
/**
 * PLATFORM F1 (PLAN-F1 r2 §3) — offline structural guard for the multi-location rules. Wired into `npm test` AND `npm run check:rules`.
 * /brands: explicit server-only deny, no truthy grant beneath. /public: closed except /public/brands (read-only; no .write grant
 * anywhere under /public). Identity: zone circle-only with $other denied; brand_id preserved by .validate and a branded identity
 * not deletable by .write. Orders: the $order_id .validate keeps the wrapped delivered_by_driver_uid clause AND carries both
 * restaurant_id and brand_id immutability. No root grant cascades over any of it.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CANON = path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json');
const rules = JSON.parse(fs.readFileSync(CANON, 'utf8')).rules;

const noGrant = (node, label, readAllowedAt = []) => (function walk(n, segs) {
  if (n === null || typeof n !== 'object') return;
  for (const [k, v] of Object.entries(n)) {
    const at = segs.join('/');
    if (k === '.write') assert.strictEqual(v, false, `FAIL: .write grant under ${label}/${at || '(node)'}`);
    else if (k === '.read') assert.ok(v === false || readAllowedAt.includes(at), `FAIL: unexpected .read grant under ${label}/${at || '(node)'}`);
    else if (k !== '.validate') walk(v, segs.concat(k));
  }
})(node, []);

assert.ok(rules.brands, 'FAIL: /brands rule missing (the deny must be explicit, not left to the default)');
assert.strictEqual(rules.brands['.read'], false, 'FAIL: /brands .read must be false');
assert.strictEqual(rules.brands['.write'], false, 'FAIL: /brands .write must be false');
noGrant(rules.brands, 'brands');
assert.ok(rules.public && rules.public.brands, 'FAIL: /public/brands rule missing');
assert.strictEqual(rules.public['.read'], false, 'FAIL: /public .read must be false (only /public/brands is public)');
assert.strictEqual(rules.public['.write'], false, 'FAIL: /public .write must be false');
assert.strictEqual(rules.public.brands['.read'], true, 'FAIL: /public/brands must be publicly readable');
noGrant(rules.public, 'public', ['brands']);
assert.ok(!rules['.read'] && !rules['.write'], 'FAIL: a root grant would cascade over /brands and /public');
// PLAN-portal-membership r3 §6.1 — the membership nodes are explicit server-only denies (Admin SDK only), no grant beneath.
for (const node of ['brand_members', 'member_of', 'member_invites']) {
  assert.ok(rules[node], `FAIL: /${node} rule missing (the deny must be explicit, not left to the default)`);
  assert.strictEqual(rules[node]['.read'], false, `FAIL: /${node} .read must be false`);
  assert.strictEqual(rules[node]['.write'], false, `FAIL: /${node} .write must be false`);
  noGrant(rules[node], node);
}

const id = rules.restaurants.$restaurant_id.identity;
assert.strictEqual(id.zone.type['.validate'], "newData.val() === 'circle'", 'FAIL: zone must be circle-only');
assert.strictEqual(id.zone.$other['.validate'], false, 'FAIL: zone must deny extra keys');
assert.ok(id['.write'].includes("(newData.exists() || !data.child('brand_id').exists())"), 'FAIL: identity .write must forbid deleting a branded identity');
assert.ok(id['.validate'].includes("newData.child('brand_id').val() === data.child('brand_id').val()"), 'FAIL: identity .validate must preserve brand_id (no client create / change / remove)');

const ov = rules.orders.$order_id['.validate'];
for (const f of ['restaurant_id', 'brand_id'])
  assert.ok(ov.includes(`(!data.child('${f}').exists() || newData.child('${f}').val() === data.child('${f}').val())`), `FAIL: orders.$order_id .validate lacks the ${f} immutability clause`);
assert.ok(ov.startsWith("((root.child('dispatchers').child(auth.uid).exists() && auth.token.customer !== true) || !data.child('delivered_by_driver_uid').exists()"),
  'FAIL: the pre-existing delivered_by_driver_uid clause must be kept (wrapped), not replaced');

console.log('brands-rules.guard: OK (/brands + /brand_members + /member_of + /member_invites server-only; /public closed except read-only /public/brands; zone circle-only; identity brand_id preserved + branded identity undeletable; order restaurant_id/brand_id immutable; no root cascade)');
