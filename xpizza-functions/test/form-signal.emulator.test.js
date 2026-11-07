'use strict';
// PLAN 3 — formSignal through the REAL HTTP wrapper on the RTDB + Firestore emulators (r3, Codex r2 #6 / #4 / NEW P2).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:form-signal
//
// The REAL exported `app.formSignal` (its v2 `cors` wrapper included) is mounted in express the way
// client-version.emulator.test.js mounts reportClientVersion — with the parsers configured as the Functions Framework
// configures them: JSON, `text/*` as a STRING, and rawBody kept. The Framework itself is not a dependency here, so this
// reproduces its parser configuration rather than importing it; the handler decides identically on a string or an object
// body (form-signal.test.js §5), and the real platform is proven by the post-deploy check (plan, "Delivery").
// Cells:
//   beacon     a real fetch POST, text/plain;charset=UTF-8, a real order-site Origin, no custom headers, no preflight:
//              204, Access-Control-Allow-Origin echoed, the counters on the emulator RTDB
//   origin     an evil Origin gets no allow-origin header (CORS governs who may READ the response; a simple POST still
//              arrives — these counts are untrusted observations by design, bounded by the limiter)
//   shape      the same body as application/json (not the beacon shape) → 204, no counter write
//   concurrency 20 parallel beacons → _count exactly 20 (ServerValue.increment on the real database)
//   composed   the bodies the FORMS sent for a 10-line refusal (test/fixtures/form-signal-large-cart.json, asserted equal to
//              the forms' capture by form-signal-client.test.mjs) → one _count + one per unique reason, per brand
//   sweep      day keys past 90 days and expired limiter windows removed; recent ones kept
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'fs-secret';

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const FS = require('../form-signal');
const { hnDateISO } = require('../lib/hn-date');
const LARGE = require('./fixtures/form-signal-large-cart.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('form-signal(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const LAMUSA = 'https://orders.lamusa.hn', XPIZZA = 'https://orders.xpizza.hn', EVIL = 'https://evil.example';
const keep = (req, _res, buf) => { req.rawBody = buf; };
function server() {
  const w = express();
  w.use(express.json({ verify: keep }));
  w.use(express.text({ type: 'text/*', verify: keep }));
  w.use(express.raw({ type: () => true, verify: keep }));
  w.use(app.formSignal);
  return new Promise((resolve) => { const s = http.createServer(w).listen(0, '127.0.0.1', () => resolve(s)); });
}
async function beacon(s, body, { origin = LAMUSA, ct = 'text/plain;charset=UTF-8', xff = '198.51.100.20' } = {}) {
  const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': ct, Origin: origin, 'X-Forwarded-For': xff }, body });
  const text = await r.text();
  return { status: r.status, allowOrigin: r.headers.get('access-control-allow-origin'), text };
}
const val = async (p) => (await rtdb.ref(p).get()).val();
const B = (o = {}) => JSON.stringify({ rid: 'la_musa', event: 'send', reasons: ['repriced'], ...o });

(async () => {
  await rtdb.ref().set(null);
  const s = await server();
  const D = hnDateISO(Date.now());
  try {
    // ═══ beacon: the real wrapper, the beacon's exact shape ═══
    let r = await beacon(s, B({ reasons: ['repriced', 'repriced'] }));
    assert.strictEqual(r.status, 204, r.text); assert.strictEqual(r.text, '', 'empty body');
    assert.strictEqual(r.allowOrigin, LAMUSA, 'the order-site origin is echoed');
    assert.deepStrictEqual(await val(`form_signals/${D}/la_musa/send`), { _count: 1, repriced: 1 });
    ok('beacon: text/plain;charset=UTF-8 POST from orders.lamusa.hn through the REAL export → 204, allow-origin echoed, _count 1 / repriced 1 on the emulator');

    // ═══ origin ═══
    r = await beacon(s, B({ rid: 'x_pizza' }), { origin: EVIL });
    assert.strictEqual(r.allowOrigin, null, 'an evil origin gets no allow-origin header');
    r = await beacon(s, B({ rid: 'x_pizza' }), { origin: XPIZZA });
    assert.strictEqual(r.allowOrigin, XPIZZA);
    ok('origin: an evil origin is not echoed (the response is unreadable to it); orders.xpizza.hn is');

    // ═══ shape: not the beacon's content type → no counter write ═══
    const before = JSON.stringify(await val('form_signals'));
    r = await beacon(s, B(), { ct: 'application/json' });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(JSON.stringify(await val('form_signals')), before, 'application/json → no counter write');
    ok('shape: the same body as application/json → 204 and no counter write');

    // ═══ concurrency: 20 parallel beacons → exactly 20 ═══
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => beacon(s, B({ event: 'build', reasons: ['option', 'choice'] }), { xff: `203.0.113.${i + 1}` })));
    assert.ok(rs.every((x) => x.status === 204), JSON.stringify(rs.map((x) => x.status)));
    assert.deepStrictEqual(await val(`form_signals/${D}/la_musa/build`), { _count: 20, option: 20, choice: 20 }, '🔴 a lost increment');
    ok('concurrency: 20 parallel beacons through the wrapper → _count 20, option 20, choice 20 exactly (atomic increments on the real database)');

    // ═══ composed: the forms' own large-cart bodies ═══
    for (const [rid, body] of Object.entries(LARGE)) {
      const was = (await val(`form_signals/${D}/${rid}/send`)) || {};
      r = await beacon(s, body, { origin: rid === 'la_musa' ? LAMUSA : XPIZZA, xff: `192.0.2.${rid.length}` });
      assert.strictEqual(r.status, 204);
      const now = await val(`form_signals/${D}/${rid}/send`);
      assert.deepStrictEqual([now._count - (was._count || 0), now.repriced - (was.repriced || 0), now.unavailable - (was.unavailable || 0)], [1, 1, 1], `${rid}: one refusal, one increment per unique reason`);
    }
    ok('composed: the bodies both forms sent for a 10-line refusal → one _count and one each of repriced / unavailable, per brand');

    // ═══ sweep ═══
    await rtdb.ref().update({
      [`form_signals/${hnDateISO(Date.now() - 91 * 864e5)}/la_musa/send/_count`]: 3,
      [`form_signals/${hnDateISO(Date.now() - 89 * 864e5)}/la_musa/send/_count`]: 2,
      'form_signal_limits/old': { count: 1, window_start: Date.now() - 11 * 60 * 1000 },
      'form_signal_limits/new': { count: 1, window_start: Date.now() },
    });
    const out = await FS.sweepFormSignals({ db: rtdb });
    assert.ok(out.days >= 1 && out.limits >= 1, JSON.stringify(out));
    assert.strictEqual(await val(`form_signals/${hnDateISO(Date.now() - 91 * 864e5)}`), null, 'a day past 90 days is removed');
    assert.ok(await val(`form_signals/${hnDateISO(Date.now() - 89 * 864e5)}`), 'a day inside the retention is kept');
    assert.ok(await val(`form_signals/${D}`), 'today is kept');
    assert.strictEqual(await val('form_signal_limits/old'), null); assert.ok(await val('form_signal_limits/new'));
    ok(`sweep: day keys past 90 days and expired limiter windows removed; recent ones kept (${JSON.stringify(out)})`);
  } finally { s.close(); }
  FINISHED = true;
  console.log(`\nform-signal(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('form-signal(emulator): FAILED', e); process.exit(1); });
