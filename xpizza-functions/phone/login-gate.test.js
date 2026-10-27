'use strict';
// INTL PHONE S-core step 4 (plan §5; advisor rulings 2026-10-27: senderId = the UltraMsg INSTANCE ID resolved exactly as requestOtp
// sends) — phone/login-gate.js. Run: node phone/login-gate.test.js
const assert = require('assert');
const G = require('./login-gate');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const T = Date.UTC(2026, 9, 27, 18, 0, 0);
const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };

(async () => {
  // ── 1. the sender instance — from the SAME resolver that sends ──
  const resolve = (rid) => (rid === 'tb_brand_b' ? { apiBase: 'https://api.ultramsg.com/instance222' } : rid === 'tb_nocreds' ? null : { apiBase: 'https://api.ultramsg.com/instance111' });
  assert.strictEqual(G.senderInstanceId('tb_brand_a', resolve), 'instance111', 'GATE-INSTANCE-DEFAULT');
  assert.strictEqual(G.senderInstanceId('tb_brand_b', resolve), 'instance222', 'GATE-INSTANCE-OWN');
  for (const r of [() => null, () => ({ apiBase: null }), () => ({ apiBase: 'https://api.ultramsg.com/undefined' }), () => ({ apiBase: 'https://api.ultramsg.com/a.b' }), () => ({ apiBase: 'https://api.ultramsg.com/' })])
    assert.strictEqual(G.senderInstanceId('x', r), null, 'GATE-INSTANCE-UNRESOLVED-NULL');
  assert.strictEqual(G.senderInstanceId('x'), G.senderInstanceId('x', require('../whatsapp').resolveWhatsappConfig), 'GATE-INSTANCE-DEFAULTS-TO-THE-SENDER');
  ok('senderInstanceId = the last apiBase segment of resolveWhatsappConfig (the sender); no creds / malformed → null');

  // ── 2. the login country: strict = parseSubmitted; OFF = today's normalizePhone digits ──
  assert.strictEqual(G.loginCountryOf('9795-0000', false), '504', 'GATE-CC-OFF-HN');
  assert.strictEqual(G.loginCountryOf('+97950000', false), '504', 'GATE-CC-OFF-PLUS8-IS-HN (as today)');
  assert.strictEqual(G.loginCountryOf('+97950000', true), null, 'GATE-CC-STRICT-PLUS8-NULL');
  assert.strictEqual(G.loginCountryOf('+1 219 795 0000', false), '1', 'GATE-CC-OFF-US');
  assert.strictEqual(G.loginCountryOf('+44 7911 123456', false), null, 'GATE-CC-OFF-UNSUPPORTED-NULL');
  assert.strictEqual(G.loginCountryOf('+504 9795-000', true), null, 'GATE-CC-STRICT-PARTIAL-NULL');
  ok('loginCountryOf: OFF reads the unchanged normalizePhone digits (+8 stays HN); strict = parseSubmitted; unsupported → null');

  // ── 3. allowed countries per instance: config/phone_login/{id}; '504' always; malformed → ['504'] ──
  const dbOf = (tree) => { const reads = []; return { reads, ref: (p) => ({ once: async () => { reads.push(p); const v = p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), tree); return { val: () => (v === undefined ? null : v) }; } }) }; };
  const CFG = { config: { phone_login: { instance111: ['504', '1'], instance222: ['1'], bad1: 'x', bad2: ['504', 1, '+1', '44'], bad3: {} } } };
  for (const [id, want] of [['instance111', ['504', '1']], ['instance222', ['504', '1']], ['bad1', ['504']], ['bad2', ['504']], ['bad3', ['504']], ['absent', ['504']], [null, ['504']]]) {
    G._resetForTest();
    assert.deepStrictEqual(await G.allowedCountries(dbOf(CFG), id, T), want, `GATE-ALLOWED ${id}`);
  }
  G._resetForTest(); const db = dbOf(CFG);
  await G.allowedCountries(db, 'instance111', T); await G.allowedCountries(db, 'instance111', T + 29999);
  assert.deepStrictEqual(db.reads, ['config/phone_login/instance111'], 'GATE-CACHED-PER-INSTANCE');
  G._resetForTest();
  assert.deepStrictEqual(await quiet(() => G.allowedCountries({ ref: () => ({ once: async () => { throw new Error('down'); } }) }, 'instance111', T)), ['504'], 'GATE-READ-ERROR-504');
  G._resetForTest();
  assert.deepStrictEqual(await G.allowedCountries({ ref: () => ({ once: () => new Promise(() => {}) }) }, 'instance111', T), ['504'], 'GATE-TIMEOUT-504');
  ok("allowedCountries: the owner's list ∪ '504'; any malformed entry / non-supported CC → ['504']; cached 30 s per instance; error / timeout → ['504']");

  // ── 4. the decision ──
  const ask = (phone, restaurantId, strict) => { G._resetForTest(); return G.otpLoginAllowed({ db: dbOf(CFG), phone, restaurantId, strict, now: T, resolve }); };
  assert.strictEqual(await ask('9795-0000', 'tb_brand_a', false), true, 'GATE-HN-ALWAYS');
  assert.strictEqual(await ask('9795-0000', 'tb_nocreds', false), true, 'GATE-HN-EVEN-UNRESOLVED-SENDER');
  assert.strictEqual(await ask('+1 219 795 0000', 'tb_brand_a', false), true, 'GATE-US-ENABLED-ON-111');
  assert.strictEqual(await ask('+52 55 1234 5678', 'tb_brand_a', false), false, 'GATE-MX-NOT-ENABLED');
  assert.strictEqual(await ask('+1 219 795 0000', 'tb_nocreds', false), false, 'GATE-US-UNRESOLVED-SENDER-REFUSED');
  assert.strictEqual(await ask('+44 7911 123456', 'tb_brand_a', false), false, 'GATE-UNSUPPORTED-REFUSED');
  assert.strictEqual(await ask('+97950000', 'tb_brand_a', true), false, 'GATE-STRICT-PLUS8-REFUSED');
  assert.strictEqual(await ask('+97950000', 'tb_brand_a', false), true, 'GATE-OFF-PLUS8-AS-TODAY');
  ok("otpLoginAllowed: HN always; another country only if THAT sender's list has it; unsupported / unparseable / no sender → refused");

  console.log(`login-gate: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('login-gate: FAILED —', e && e.stack || e); process.exit(1); });
