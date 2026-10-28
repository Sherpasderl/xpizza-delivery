'use strict';
// PLAN-guest-checkout-server S1 + S2 — index.js wiring guard (the inverse-fold invariant). S1 appends ONE block to index.js
// (`/* checkout:begin endpoints */ … /* checkout:end endpoints */`: the requestCheckoutCode / verifyCheckoutCode exports); S2
// INSERTS whole-line named hunks (the capp-guest gate in createOrder + chargeOnlineOrder, the grant secret) and edits no base
// line. tools/checkout-inverse.js removes exactly those hunks and is composed INNERMOST (newest slice first) into every index.js
// fold guard. This guard proves:
//   (i)   unapplyCheckoutIndex(index.js) === BASE:index.js BYTE-FOR-BYTE;
//   (ii)  NON-VACUITY — the live file differs from the base and carries the block (dropping the inverse ⇒ RED);
//   (iii) SENSITIVITY — a missing / duplicated marker or an edit OUTSIDE the block is refused or detected.
// Run: node checkout-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyCheckoutIndex } = require('./tools/checkout-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '8a31e2a3';   // origin/main at the plan's code map
const live = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
const BEGIN = '/* checkout:begin endpoints */\n', END = '/* checkout:end endpoints */\n';

assert.strictEqual(unapplyCheckoutIndex(live), base, `🔴 index.js minus the checkout block is not ${BASE}:index.js — something beyond the block changed`);
ok(`(i) index.js minus the checkout block === ${BASE}:index.js byte-for-byte`);

assert.notStrictEqual(live, base, 'non-vacuity: the live index.js differs from the base');
const hunk = (name) => { const b = `/* checkout:begin ${name} */`, e = `/* checkout:end ${name} */`; return live.slice(live.indexOf(b), live.indexOf(e) + e.length); };
const block = hunk('endpoints');
assert.ok(/exports\.requestCheckoutCode = onRequest\(/.test(block) && /exports\.verifyCheckoutCode = onRequest\(/.test(block), 'both endpoints are exported INSIDE the block');
assert.ok(/cors: ACCOUNT_ORIGINS/.test(block), 'the account CORS list (the capp origin is derived from the manifest)');
assert.ok(live.endsWith(END), 'the endpoints block is the END of index.js');
assert.ok(!/exports\.(requestOtp|verifyOtp)\b/.test(block), 'requestOtp / verifyOtp are never touched by this slice');
ok('(ii) non-vacuity: the endpoints block is present at the end of index.js, exports both endpoints with ACCOUNT_ORIGINS, and touches no existing export');

// S2 placement: each gate hunk sits inside ITS handler, after identity resolution and before the first write it guards
const at = (t) => { const i = live.indexOf(t); assert.ok(i > 0, `premise: ${t.slice(0, 60)}`); return i; };
const cStart = at('createOrderApp.all('), cEnd = live.indexOf('\nexports.', cStart);
const gC = at('/* checkout:begin gate-create */');
assert.ok(cStart < gC && gC < cEnd, 'gate-create is inside createOrder');
assert.ok(at('treat as guest */ }\n  }\n  /* checkout:begin gate-create */') > 0, 'gate-create follows createOrder\'s identity resolution');
assert.ok(gC < live.indexOf('const existing = await db.ref(`orders/${orderId}`).once', cStart), 'gate-create precedes the existence read');
const chStart = at('chargeOnlineApp.all('), chEnd = live.indexOf('\nexports.', chStart);
const order = ['/* checkout:begin gate-charge */', '/* checkout:begin gate-verified */', 'const releaseHoldIfOwned = async', 'acq = await acquireHostedAttempt(',
  '/* checkout:begin gate-bind */', "if (acq.outcome === 'item_unavailable')", '/* checkout:begin gate-grant */', 'if (flow.respond) return res.status(',
  '/* checkout:begin gate-grant-field */'].map((t) => { const i = live.indexOf(t, chStart); assert.ok(i > chStart && i < chEnd, `inside chargeOnlineOrder: ${t}`); return i; });
for (let k = 1; k < order.length; k++) assert.ok(order[k - 1] < order[k], 'chargeOnlineOrder hunk order');
assert.ok(at("customer_uid = null; }   // any error → guest\n  }\n  /* checkout:begin gate-charge */") > 0, 'gate-charge follows chargeOnlineOrder\'s identity resolution');
for (const first of ["db.ref(`recent_order_content/", 'reserveRedemption(']) { const w = live.indexOf(first, chStart); assert.ok(w < 0 || w > order[0], `gate-charge precedes ${first}`); }
assert.ok(/secrets: \[SIGNUP_GRANT_SECRET\]/.test(hunk('grant-secret-bind')) && live.indexOf('/* checkout:begin grant-secret-bind */') > live.indexOf('exports.chargeOnlineOrder = onRequest('), 'the grant secret binds to chargeOnlineOrder only');
assert.strictEqual(live.split('SIGNUP_GRANT_SECRET]').length - 1, 1, 'no other function binds the grant secret');
for (const [name, stmt] of [['gate-create', 'if (cappGuestRefusal) return res.status(400).json({ error: cappGuestRefusal });'],
  ['gate-charge', 'if (cappGuest && cappGuest.refuse) return res.status(400).json({ error: cappGuest.refuse });'],
  ['gate-verified', 'pendingOrderRecord.guest_verified = { phone: cappGuest.guest.phone, phone_hash: cappGuest.guest.phone_hash };'],
  ['gate-bind', "return res.status(400).json({ error: 'guest_ticket_invalid' });"], ['gate-grant', 'if (g.refuse) return res.status(400).json({ error: g.refuse });'],
  ['gate-grant-field', '...(cappGrant ? { signup_grant: cappGrant } : {}),']]) assert.ok(hunk(name).includes(stmt), `🔴 the ${name} hunk lost its effect: ${stmt}`);
ok('(ii-S2) placement: gate-create after createOrder identity + before its existence read; chargeOnlineOrder gate → verified (pre-CAS) → bind (post-CAS, before every outcome) → grant (before any answer); secret bound to chargeOnlineOrder only');

assert.throws(() => unapplyCheckoutIndex(live.replace(BEGIN, '/* checkout:BEGIN */\n')), /missing/, 'a missing begin');
assert.throws(() => unapplyCheckoutIndex(live.replace(END, '/* checkout:END */\n')), /missing/, 'a missing end');
assert.throws(() => unapplyCheckoutIndex(live + BEGIN + END), /more than once/, 'a duplicated block');
assert.throws(() => unapplyCheckoutIndex(live.replace('  /* checkout:begin gate-create */\n', '  x; /* checkout:begin gate-create */\n')), /own lines/, 'a marker sharing a base line');
assert.throws(() => unapplyCheckoutIndex(live.replace('/* checkout:end gate-bind */', '/* checkout:end gate-bindx */')), /missing|unknown/, 'a renamed S2 marker');
assert.notStrictEqual(unapplyCheckoutIndex(live.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'an edit OUTSIDE the hunks is detected');
ok('(iii) sensitivity: missing / duplicated / shared-line / renamed markers refused; an edit outside the hunks is detected');

console.log(`\ncheckout-wiring.guard: OK (${n})`);
