'use strict';
// PLAN-guest-checkout-server S1 + S2 — index.js wiring guard (the inverse-fold invariant). S1 appends ONE block to index.js
// (`/* checkout:begin endpoints */ … /* checkout:end endpoints */`: the requestCheckoutCode / verifyCheckoutCode exports); S2
// INSERTS whole-line named hunks (the capp-guest gate in createOrder + chargeOnlineOrder, the grant secret) and edits no base
// line. tools/checkout-inverse.js removes exactly those hunks and is composed INNERMOST (newest slice first) into every index.js
// fold guard. This guard proves:
//   (i)   unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(index.js)) === BASE:index.js BYTE-FOR-BYTE;
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
const live = require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/_asm-next2-layers').stripLayers('index.js', require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/dpao-module-inverse').unapplyDpaoModule('index.js', require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule('index.js', require('./tools/zones-module-inverse').unapplyZonesModule('index.js', require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', require('./tools/d4-intake-inverse').unapplyD4Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/d3live-module-inverse').unapplyD3liveModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))))))), ['p5a', 'alertsan', 'hostedrace'])   /* DRYRUN: 3a's sd(sb) is already in this chain */)   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ ;
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
const BEGIN = '/* checkout:begin endpoints */\n', END = '/* checkout:end endpoints */\n';
// R-WIRE (assembly restack onto f75e5cf9): this slice is the NEWEST, so its inverse runs FIRST (innermost); the tip's slices that
// landed after this guard's parent (8a31e2a3) are then stripped in the assembly's inner→outer order. mem512's formSignal hunk is
// MAIN-SHIPPED IN 8a31e2a3 (its own note), so for THIS parent it is re-applied after the full mem512 inverse — byte-exact either way.
const TIP_LAYERS = ['intl', 'mem512',   // DRYRUN R-WIRE (2e): intl-core 308e28b0 (merged newest) added
  'pausa', 's4hours', 'formbake', 'area', 's2app', 's2tip', 's5r', 's3c', 's3b', 's3a', 'driver-ledger'];
const M512 = require('./tools/mem512-inverse');
const FS5 = M512.HUNKS.find((h) => h.fn === 'formSignal');
const once = (src, from, to, label) => { const k = src.split(from).length - 1; if (k !== 1) throw new Error(`checkout-wiring: ${label} occurs ${k} times (expected exactly 1)`); return src.replace(from, () => to); };
const toBase = (src) => {
  let out = unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(src)))));
  for (const t of TIP_LAYERS) { const m = require(`./tools/${t}-inverse`); out = m[Object.keys(m).find((k) => /^unapply\w*Index$/.test(k))](out); if (t === 'mem512') out = once(out, FS5.was, FS5.now, 'the 8a31e2a3 formSignal line'); }
  return out;
};

assert.strictEqual(toBase(live), base, `🔴 index.js minus the checkout block (then the tip's newer layers) is not ${BASE}:index.js — something beyond the block changed`);
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
// gate-method (Codex r1 P2-4): after validation, IMMEDIATELY before the generic online-only refusal it pre-empts for capp guests
{ const gm = live.indexOf('/* checkout:begin gate-method */', chStart);
  assert.ok(gm > live.indexOf('validateOrderPayload(body, restaurantId, pricingTables);', chStart) && gm < chEnd, 'gate-method inside chargeOnlineOrder, after validation');
  assert.ok(live.slice(live.indexOf('/* checkout:end gate-method */', gm)).startsWith('/* checkout:end gate-method */\n  // This endpoint is ONLY for online card payments. cash/card_delivery use createOrder.\n  if (fields.payment_method !== \'online\') {'), 'gate-method sits right above the online-only check');
  assert.ok(gm < live.indexOf('/* checkout:begin gate-charge */', chStart), 'gate-method precedes the gate'); }
const order = ['/* checkout:begin gate-charge */', '/* checkout:begin gate-verified */', 'const releaseHoldIfOwned = async', 'acq = await acquireHostedAttempt(',
  '/* checkout:begin gate-bind */', "if (acq.outcome === 'item_unavailable')", '/* checkout:begin gate-grant */', 'if (flow.respond) return res.status(',
  '/* checkout:begin gate-grant-field */'].map((t) => { const i = live.indexOf(t, chStart); assert.ok(i > chStart && i < chEnd, `inside chargeOnlineOrder: ${t}`); return i; });
for (let k = 1; k < order.length; k++) assert.ok(order[k - 1] < order[k], 'chargeOnlineOrder hunk order');
assert.ok(at("customer_uid = null; }   // any error → guest\n  }\n  /* checkout:begin gate-charge */") > 0, 'gate-charge follows chargeOnlineOrder\'s identity resolution');
for (const first of ["db.ref(`recent_order_content/", 'reserveRedemption(']) { const w = live.indexOf(first, chStart); assert.ok(w < 0 || w > order[0], `gate-charge precedes ${first}`); }
assert.ok(/secrets: \[SIGNUP_GRANT_SECRET\]/.test(hunk('grant-secret-bind')) && live.indexOf('/* checkout:begin grant-secret-bind */') > live.indexOf('exports.chargeOnlineOrder = onRequest('), 'the grant secret binds to chargeOnlineOrder only');
assert.strictEqual(live.split('SIGNUP_GRANT_SECRET]').length - 1, 2, 'the grant secret binds to exactly chargeOnlineOrder + redeemSignupGrant');
assert.ok(/exports\.redeemSignupGrant = onRequest\(\n  \{[^\n]*secrets: \[OTP_SALT_SECRET, SIGNUP_GRANT_SECRET\] \}/.test(block), 'S3b: redeemSignupGrant (in the endpoints block) binds it (+ OTP_SALT, the guest-server train item; exact list)');
// NOTE-getMyOrders (approved delta): the export resolves dish ids through the SAME expression index.js's live displayLabel path uses
assert.ok(block.includes("require('./my-orders').makeMyOrders({ getDatabase, getAuth, checkRateLimit, resolveContext: async (rid) => contextOfTables(await resolvePricingTables(rid)) }).getMyOrders,"), '🔴 getMyOrders (in the endpoints block) resolves its context via contextOfTables(await resolvePricingTables(rid))');
assert.ok(live.includes('contextOfTables(await resolvePricingTables(order.restaurant_id))'), 'premise: the live displayLabel path uses that expression');
// S-A1 (NOTE-S-A-ratings-v2-build): the rating fulfilment stamp is a trigger on the order STATUS calling the real core; rateOrder's
// dish votes resolve through the SAME one-resolver expression
assert.ok(block.includes("exports.drainRatingRedactions = onSchedule(\n  { schedule: 'every 30 minutes', timeZone: 'America/Tegucigalpa', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB' },") && block.includes('const out = await SE.drainRatingRedactions(getDatabase(), Date.now());'), '🔴 drainRatingRedactions (in the endpoints block) is its own 30-minute schedule calling the real drain');
assert.ok(block.includes("exports.stampRatingFulfilment = onValueWritten(\n  { ref: '/orders/{orderId}/status', region: 'us-central1', retry: true, timeoutSeconds: 60 },") && block.includes("catch (e) { console.error('stampRatingFulfilment', e && e.message); throw e; }") && block.includes("require('./ratings/rating-fulfilment').stampRatingFulfilment(getDatabase(), { orderId: event.params.orderId, status: event.data.after.val(), now: Date.now() })"), '🔴 stampRatingFulfilment (in the endpoints block) is the status trigger calling the real core');
assert.ok(block.includes("require('./ratings/rate-order').configure({ resolveContext: async (rid) => contextOfTables(await resolvePricingTables(rid)) });"), '🔴 rateOrder resolves dish ids through contextOfTables(await resolvePricingTables(rid))');
for (const [name, stmt] of [['gate-create', 'if (cappGuestRefusal) return res.status(400).json({ error: cappGuestRefusal });'],
  ['gate-method', "&& (await require('./checkout-guest-gate').chargeUidOf(req, { getAuth, getDatabase, attributionUid })) === null) {\n    return res.status(400).json({ error: 'guest_cash_not_allowed' });"],
  ['gate-charge', 'if (cappGuest && cappGuest.refuse) return res.status(400).json({ error: cappGuest.refuse });'],
  ['gate-verified', 'pendingOrderRecord.guest_verified = { phone: cappGuest.guest.phone, phone_hash: cappGuest.guest.phone_hash };'],
  ['gate-bind', "return res.status(400).json({ error: 'guest_ticket_invalid' });"], ['gate-grant', 'if (g.refuse) return res.status(400).json({ error: g.refuse });'],
  ['gate-grant-field', '...(cappGrant ? { signup_grant: cappGrant } : {}),']]) assert.ok(hunk(name).includes(stmt), `🔴 the ${name} hunk lost its effect: ${stmt}`);
ok('(ii-S2) placement: gate-create after createOrder identity + before its existence read; chargeOnlineOrder gate → verified (pre-CAS) → bind (post-CAS, before every outcome) → grant (before any answer); gate-method right above the generic online-only refusal; secret bound to chargeOnlineOrder');

assert.throws(() => unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live.replace(BEGIN, '/* checkout:BEGIN */\n')))))), /missing/, 'a missing begin');
assert.throws(() => unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live.replace(END, '/* checkout:END */\n')))))), /missing/, 'a missing end');
assert.throws(() => unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live + BEGIN + END))))), /more than once/, 'a duplicated block');
assert.throws(() => unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live.replace('  /* checkout:begin gate-create */\n', '  x; /* checkout:begin gate-create */\n')))))), /own lines/, 'a marker sharing a base line');
assert.throws(() => unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(live.replace('/* checkout:end gate-bind */', '/* checkout:end gate-bindx */')))))), /missing|unknown/, 'a renamed S2 marker');
assert.notStrictEqual(toBase(live.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'an edit OUTSIDE the hunks is detected');
// S3a placement: each platform hand-off is the FIRST statement after its handler's POST check (before any read / write); the
// forms' path below it is byte-identical (proven by (i)); exactly the bodies carrying `context` leave
for (const [fn, name, next] of [['exports.requestOtp = onRequest(', 's3a-request', 'const { phone, restaurant_id } = req.body || {};'], ['exports.verifyOtp = onRequest(', 's3a-verify', 'const { phone, code } = req.body || {};']]) {
  const f = at(fn), e = live.indexOf('\nexports.', f + 1), h = live.indexOf(`/* checkout:begin ${name} */`, f);
  assert.ok(h > f && h < e, `${name} is inside ${fn}`);
  const before = live.slice(f, h);
  assert.ok(/if \(req\.method !== 'POST'\) return res\.status\(405\)\.json\(\{ ok: false \}\);\n      $/.test(before), `${name} immediately follows the POST check`);
  assert.ok(!/\b(getDatabase|db\.ref|\.transaction\(|sendMessage)\b/.test(before.slice(before.indexOf('async (req, res)'))), `${name}: no I/O above it`);
  assert.ok(live.slice(h).split('\n')[1].includes("if ((req.body || {}).context !== undefined) return SIGNUP_PLATFORM."), `${name}: hands off ONLY a body carrying context`);
  assert.ok(live.indexOf(next, h) === live.indexOf(`/* checkout:end ${name} */`, h) + `/* checkout:end ${name} */`.length + 7, `${name}: the forms' path resumes right after it`);
}
ok('(ii-S3) placement: the s3a hand-offs are the first statement after each handler\'s POST check, no I/O above them, only a `context` body leaves; redeemSignupGrant + chargeOnlineOrder are the only grant-secret bindings');

ok('(iii) sensitivity: missing / duplicated / shared-line / renamed markers refused; an edit outside the hunks is detected');

// (iv) the MODULE line inverses (assembly restack): composed INNERMOST by the guards that byte-pin these modules (area-wiring,
// s2tip-wiring). Exact: each removes ONLY this slice's whole inserted lines — the result is the restack parent's bytes with
// every OTHER slice's lines intact; sensitivity: a byte inside, a duplicate or a missing block throws.
{
  const CI = require('./tools/checkout-charge-inputs-inverse'), PX = require('./tools/checkout-pixelpay-inverse');
  for (const [M, fn, label] of [[CI, CI.unapplyCheckoutChargeInputs, 'checkout_ticket entry'], [PX, PX.unapplyCheckoutPixelpay, 'guestForeign blocks']]) {
    const src = require('./tools/d4-intake-inverse').unapplyD4Module(M.FILE, fs.readFileSync(path.join(__dirname, M.FILE), 'utf8'));   // D4: the newer layer innermost
    const out = fn(src);
    const blocks = M.BLOCKS || [M.LINE];
    assert.strictEqual(src.split('\n').length - out.split('\n').length, blocks.reduce((k, b) => k + b.split('\n').length - 1, 0), `${M.FILE}: exactly the ${label} lines removed`);
    assert.ok(!/checkout_ticket|guestForeign/.test(out), `${M.FILE}: nothing of the slice remains`);
    assert.throws(() => fn(src.replace(blocks[0], blocks[0].replace(/[a-z]/, 'Z'))), /exactly once/, `${M.FILE}: a byte INSIDE a block`);
    assert.throws(() => fn(src + blocks[0]), /exactly once/, `${M.FILE}: a DUPLICATED block`);
    assert.throws(() => fn(out), /exactly once/, `${M.FILE}: a MISSING block`);
  }
  assert.ok(/^  entry_mode: /m.test(CI.unapplyCheckoutChargeInputs(fs.readFileSync(path.join(__dirname, CI.FILE), 'utf8'))) && /^  address_area: /m.test(CI.unapplyCheckoutChargeInputs(fs.readFileSync(path.join(__dirname, CI.FILE), 'utf8'))), 'the neighbours (entry_mode, address_area) stay');
}
ok('(iv) module line inverses: checkout_ticket (charge-inputs) and the guestForeign blocks (pixelpay-hosted-charge) removed exactly; inside / duplicated / missing each throw');

console.log(`\ncheckout-wiring.guard: OK (${n})`);
