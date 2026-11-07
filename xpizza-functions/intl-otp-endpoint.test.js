'use strict';
// INTL PHONE codex r1 #2 — drives the REAL requestOtp endpoint (index.js export, in-process) on a COLD flag cache, against a stub RTDB
// where every config read NEVER resolves. If requestOtp awaited the phone_wire_strict flag (or any other read) before its first rate
// reservation, it would hang there. Asserts: HN reaches the `otp_ip/` reservation with ZERO reads (no flag evaluation at all); a
// non-HN number is still answered (uniformly) — its flag read is never awaited, its login-list read is bounded by the 500 ms timeout.
// Run: node intl-otp-endpoint.test.js
process.env.OTP_SALT = 'tb_fixed_salt_for_phone_differential_00000000';
process.env.ULTRAMSG_INSTANCE_ID = 'instance900001';   // synthetic: the default sender resolves, so the per-sender login-list read is exercised
process.env.ULTRAMSG_TOKEN = 'tb_token_never_used';
for (const k of ['FUNCTION_TARGET', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST']) delete process.env[k];
const assert = require('assert');
const WATCHDOG = setTimeout(() => { console.error(`intl-otp-endpoint: FAILED — watchdog (20 s); stub calls so far: ${JSON.stringify(log)}`); process.exit(1); }, 20000);   // NOT unref'd: a request stuck on a hanging read must FAIL, not let the loop drain to exit 0

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const log = [];
const STOP = Object.assign(new Error('TB_STOP_AT_FIRST_RESERVATION'), { tb: true });
const stubDb = {
  ref: (p = '') => ({
    once: () => { log.push(['once', p]); return new Promise(() => {}); },   // every read hangs forever
    transaction: async () => { log.push(['transaction', p]); throw STOP; },     // the first reservation stops the request
    set: async () => { log.push(['set', p]); }, update: async () => { log.push(['update', p]); },
  }),
};
const dbMod = require('firebase-admin/database');
dbMod.getDatabase = () => stubDb;   // BEFORE index.js destructures it
const idx = require('./index.js');
assert.strictEqual(typeof idx.requestOtp, 'function', 'premise: the real requestOtp export');

function call(body) {
  return new Promise((resolve) => {
    const headers = {};
    const res = Object.assign(new (require('events').EventEmitter)(), {   // the v2 onRequest wrapper waits on res 'finish'
      statusCode: 200, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, getHeader: (k) => headers[k.toLowerCase()], removeHeader: () => {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); this.emit('finish'); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); this.emit('finish'); return this; },
      end(b) { resolve({ status: this.statusCode, body: b }); this.emit('finish'); return this; },
    });
    const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body, ip: '203.0.113.7', get: () => undefined, header: () => undefined, url: '/', originalUrl: '/' };
    Promise.resolve().then(() => idx.requestOtp(req, res)).catch((e) => { process.stderr.write('TB requestOtp threw: ' + (e && e.stack || e) + '\n'); });
  });
}
const quiet = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = (...a) => { if (process.env.TB_DEBUG) process.stderr.write(a.map(String).join(' ') + '\n'); }; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

(async () => {
  // ── HN, cold cache: no read at all before the first reservation ──
  require('./phone/flag')._resetForTest(); require('./phone/login-gate')._resetForTest(); log.length = 0;
  const t0 = Date.now();
  await quiet(() => call({ phone: '9795-0000', restaurant_id: 'x_pizza' }));
  const ms = Date.now() - t0;
  assert.deepStrictEqual(log.map((x) => x[0]), ['transaction'], `OTP-ENDPOINT-HN-ZERO-READS ${JSON.stringify(log)}`);
  assert.ok(log[0][1].startsWith('otp_ip/'), 'OTP-ENDPOINT-HN-REACHES-THE-IP-RESERVATION');
  assert.ok(ms < 400, `OTP-ENDPOINT-HN-NO-AWAITED-READ (${ms} ms; an awaited hanging read would block)`);
  ok(`real requestOtp, HN, cold cache, every read hanging: reaches the otp_ip reservation with ZERO reads in ${ms} ms (no flag evaluated)`);

  // ── non-HN, cold cache: the flag is read in the BACKGROUND (never awaited); the login list is bounded → uniform refusal ──
  require('./phone/flag')._resetForTest(); require('./phone/login-gate')._resetForTest(); log.length = 0;
  const t1 = Date.now();
  const r = await quiet(() => call({ phone: '+1 219 795 0000', restaurant_id: 'x_pizza' }));
  const ms1 = Date.now() - t1;
  assert.deepStrictEqual(r, { status: 200, body: { ok: true, cooldown: 30 } }, 'OTP-ENDPOINT-NON-HN-UNIFORM-REFUSAL');
  assert.ok(!log.some((x) => x[0] === 'transaction'), 'OTP-ENDPOINT-NON-HN-REFUSED-BEFORE-ANY-RESERVATION');
  const reads = log.filter((x) => x[0] === 'once').map((x) => x[1]);
  assert.ok(reads.includes('config/phone_wire_strict'), 'premise: the flag refresh was started (in the background)');
  assert.ok(reads.includes('config/phone_login/instance900001'), 'premise: the per-sender login list of the resolved instance was read');
  assert.ok(ms1 >= 450, `premise: the refusal waited for the bounded login-list read (${ms1} ms), not for the flag`);
  assert.ok(ms1 < 1500, `OTP-ENDPOINT-NON-HN-BOUNDED (${ms1} ms: only the 500 ms login-list timeout, never the hanging flag read)`);
  ok(`real requestOtp, +1, cold cache, every read hanging: the flag refresh runs in the background (never awaited), the login list times out → the uniform refusal in ${ms1} ms, before any reservation`);

  console.log(`intl-otp-endpoint: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('intl-otp-endpoint: FAILED —', e && e.stack || e); process.exit(1); });
