'use strict';
// INTL PHONE codex r1 #2 — the createOrder / chargeOnlineOrder wire statements, EXECUTED from index.js's own bytes. Each intake hunk's
// statement (everything after the untouched `validateOrderPayload(...)` call, up to its comment) is compiled inside a SYNCHRONOUS
// `new Function` — an `await` there would be a SyntaxError — and run on a COLD flag cache against an RTDB whose reads never resolve:
// it must return at once with today's lenient result (OFF), start exactly ONE background flag refresh, and, once the cache holds a
// valid census-backed ON, apply the strict contract. (The handlers' other ~7 awaited catalog reads precede this line and are unchanged.)
// Run: node intl-intake-wire-sync.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { HUNKS } = require('./tools/intl-inverse');
const F = require('./phone/flag');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const SEAM = '  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables);';
const intake = HUNKS.filter((h) => h.now.startsWith(SEAM));
assert.strictEqual(intake.length, 2, 'premise: the two intake hunks');

(async () => {
  for (const [i, h] of intake.entries()) {
    assert.ok(real.includes(h.now), `premise: hunk ${i} is in index.js`);
    const stmt = h.now.slice(SEAM.length, h.now.indexOf('//')).trim();
    let fn;
    try { fn = new Function('require', 'db', 'body', 'errors', 'fields', stmt); }   // SYNC function: `await` would not compile
    catch (e) { assert.fail(`INTAKE-WIRE-SYNC hunk ${i}: the statement does not compile synchronously (an await?) — ${e.message}`); }
    const reads = [];
    const db = { ref: (p) => ({ once: () => { reads.push(p); return new Promise(() => {}); } }) };
    const req = (m) => require(m.startsWith('./') ? path.join(__dirname, m) : m);

    // cold cache → OFF at once: today's lenient bytes kept, one background read
    F._resetForTest();
    const body = { customer_phone: '97950000' }, errors = [], fields = { customer_phone: '97950000' };
    const ret = fn(req, db, body, errors, fields);
    assert.strictEqual(ret, undefined, `INTAKE-WIRE-SYNC hunk ${i} returns synchronously`);
    assert.deepStrictEqual([errors, fields.customer_phone], [[], '97950000'], `INTAKE-WIRE-COLD-IS-OFF hunk ${i}`);
    assert.deepStrictEqual(reads, ['config/phone_wire_strict'], `INTAKE-WIRE-ONE-BACKGROUND-READ hunk ${i}`);

    // a warm, valid census-backed ON → the strict contract applies (bare-8 → canonical; partial → the existing error)
    const T = Date.now(), D = 86400e3;
    const on = { enabled: true, enabled_at: T - D, census: { flip_safe: true, generated_at: T - 2 * D, orders_in_window: 50 } };
    F._resetForTest(); await F.phoneWireStrict({ ref: () => ({ once: async () => ({ val: () => on }) }) }, T);
    const f2 = { customer_phone: '97950000' }, e2 = [];
    fn(req, db, { customer_phone: '97950000' }, e2, f2);
    assert.deepStrictEqual([e2, f2.customer_phone], [[], '+50497950000'], `INTAKE-WIRE-WARM-ON-STRICT hunk ${i}`);
    const f3 = { customer_phone: '+5049795000' }, e3 = [];
    fn(req, db, { customer_phone: '+504 9795-000' }, e3, f3);
    assert.deepStrictEqual([e3, f3.customer_phone], [['customer_phone must be 8–15 digits'], ''], `INTAKE-WIRE-WARM-ON-REJECT hunk ${i}`);
  }
  ok('both intake statements (from index.js bytes) compile as SYNC code (no await possible); cold cache → OFF at once, lenient bytes kept, ONE background flag read; warm census-backed ON → strict canonical / the existing error');
  console.log(`intl-intake-wire-sync: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('intl-intake-wire-sync: FAILED —', e && e.stack || e); process.exit(1); });
