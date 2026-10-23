'use strict';
// WhatsApp gateway health — the pure core with the HTTP STUBBED and every log line captured.
// Run: node whatsapp/instance-health.test.js
const assert = require('assert');
const H = require('./instance-health');
const { resolveWhatsappConfig } = require('../whatsapp');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const TOKEN_A = 'tok-SECRET-aaa', TOKEN_B = 'tok-SECRET-bbb';
const CFG = { r1: { apiBase: 'https://api.ultramsg.com/instance111', token: TOKEN_A }, r2: { apiBase: 'https://api.ultramsg.com/instance222', token: TOKEN_B } };
const resolve = (rid) => CFG[rid] || null;
const body = (state, sub) => ({ status: { accountStatus: { status: state, ...(sub ? { substatus: sub } : {}) } } });

function sink() {
  const lines = [];
  return { lines, error: (m, f) => lines.push({ sev: 'ERROR', m, f }), warn: (m, f) => lines.push({ sev: 'WARNING', m, f }), info: (m, f) => lines.push({ sev: 'INFO', m, f }) };
}
// fetch stub: per-instance behaviour; records every URL + options it was called with
function stubFetch(byInstance) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    const inst = H.instanceOf(url.split('/instance/status')[0]);
    const b = byInstance[inst];
    if (b instanceof Error) throw b;
    if (b && b.httpStatus) return { ok: false, status: b.httpStatus, json: async () => ({}) };
    if (b && b.badJson) return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } };
    return { ok: true, status: 200, json: async () => b };
  };
  f.calls = calls;
  return f;
}
async function run(byInstance, { rids = ['r1'], enabled = true, res = resolve } = {}) {
  const log = sink(); const fetchImpl = stubFetch(byInstance);
  const out = await H.checkInstances({ rids, resolve: res, fetchImpl, enabled, log });
  for (const l of log.lines) for (const t of [TOKEN_A, TOKEN_B]) {
    assert.ok(!l.m.includes(t) && !JSON.stringify(l.f || {}).includes(t), `🔴 a log line carries the token: ${l.m}`);
    assert.ok(!/instance\/status\?/.test(l.m), `🔴 a log line carries the request URL: ${l.m}`);
  }
  return { log, out, fetchImpl };
}
const sevs = (log) => log.lines.map((l) => l.sev);

(async () => {
  // 1. healthy → silent
  { const { log, out, fetchImpl } = await run({ instance111: body('authenticated', 'connected') });
    assert.deepStrictEqual(log.lines, []); assert.strictEqual(out[0].verdict, 'ok'); assert.strictEqual(fetchImpl.calls.length, 1);
    assert.ok(fetchImpl.calls[0].url.startsWith('https://api.ultramsg.com/instance111/instance/status?token='));
    assert.strictEqual(fetchImpl.calls[0].opts.timeout, H.TIMEOUT_MS); assert.ok(H.TIMEOUT_MS > 0 && H.TIMEOUT_MS <= 10000);
    ok('authenticated → silent (no log line); one GET to {instance}/instance/status with a bounded timeout'); }

  // 2. unlinked → exactly ONE ERROR naming the restaurant + instance, never the token
  for (const [state, sub] of [['qr'], ['disconnected'], ['authenticated', 'disconnected'], ['authenticated', 'logged out'], ['QR'], ['standby', 'Logged Out']]) {
    const { log, out } = await run({ instance111: body(state, sub) });
    assert.deepStrictEqual(sevs(log), ['ERROR'], `${state}/${sub}`);
    assert.match(log.lines[0].m, /^whatsapp-health: DISCONNECTED rid=r1 instance=instance111 status=/);
    assert.deepStrictEqual(log.lines[0].f, { rids: 'r1', instance: 'instance111' });
    assert.strictEqual(out[0].verdict, 'down');
  }
  ok('qr / disconnected, or substatus disconnected / logged out (any case) → exactly one ERROR naming rid + instance');

  // 3. transient states → WARNING, never ERROR
  for (const state of ['initialize', 'loading', 'retrying', 'standby', 'something-new']) {
    const { log, out } = await run({ instance111: body(state, 'connected') });
    assert.deepStrictEqual(sevs(log), ['WARNING'], state); assert.strictEqual(out[0].verdict, 'transient');
  }
  ok('initialize / loading / retrying / standby / an unknown state → one WARNING, never ERROR');

  // 4. the status call itself failing is a WARNING, never "disconnected"
  const failures = {
    timeout: Object.assign(new Error('network timeout at: https://api.ultramsg.com/instance111/instance/status?token=' + TOKEN_A), { name: 'FetchError', type: 'request-timeout' }),
    network: Object.assign(new Error('getaddrinfo ENOTFOUND api.ultramsg.com ' + TOKEN_A), { name: 'FetchError' }),
    http500: { httpStatus: 500 }, http401: { httpStatus: 401 }, badJson: { badJson: true },
    noStatus: {}, nullBody: null, emptyState: body(''), wrongShape: { status: 'authenticated' }, numState: { status: { accountStatus: { status: 7 } } },
  };
  for (const [k, b] of Object.entries(failures)) {
    const { log, out } = await run({ instance111: b });
    assert.deepStrictEqual(sevs(log), ['WARNING'], k);
    assert.ok(!/DISCONNECTED/.test(log.lines[0].m), `${k}: never reported as disconnected`);
    assert.ok(['check_failed', 'unknown'].includes(out[0].verdict), k);
  }
  ok('timeout / network / non-2xx / bad JSON / missing or malformed status → one WARNING, never DISCONNECTED (error text, which can carry the URL, is never logged)');

  // 5. one call per INSTANCE: ids that resolve to the same instance are checked once and named together
  { const shared = (rid) => (rid === 'r2' ? CFG.r2 : CFG.r1);
    const { log, fetchImpl } = await run({ instance111: body('qr'), instance222: body('authenticated') }, { rids: ['r1', 'r3', 'r2', 'r4'], res: shared });
    assert.strictEqual(fetchImpl.calls.length, 2);
    assert.deepStrictEqual(sevs(log), ['ERROR']); assert.match(log.lines[0].m, /rid=r1,r3,r4 instance=instance111 /); }
  ok('4 restaurants on 2 instances → 2 calls; the unlinked instance names every restaurant that shares it');

  // 6. not configured (resolver null / throws / no token) → skipped, no call, no log
  { const res = (rid) => { if (rid === 'boom') throw new Error('x'); if (rid === 'notoken') return { apiBase: 'https://api.ultramsg.com/i9', token: '' }; return rid === 'r1' ? CFG.r1 : null; };
    const { log, fetchImpl } = await run({ instance111: body('authenticated') }, { rids: ['none', 'boom', 'notoken', 'r1'], res });
    assert.strictEqual(fetchImpl.calls.length, 1); assert.deepStrictEqual(log.lines, []); }
  ok('a restaurant without UltraMsg config (null / throwing resolver / no token) is skipped: no call, no log');

  // 7. sends deliberately disabled → an unlinked instance is a WARNING, not an ERROR
  { const { log } = await run({ instance111: body('qr') }, { enabled: false });
    assert.deepStrictEqual(sevs(log), ['WARNING']); assert.match(log.lines[0].m, /DISCONNECTED .*\(whatsapp_enabled=false\)$/); }
  ok('/config/whatsapp_enabled=false → still checked; an unlinked instance logs WARNING instead of ERROR');

  // 8. two instances, one failing, one down → independent verdicts in one run
  { const { log } = await run({ instance111: body('disconnected'), instance222: { httpStatus: 503 } }, { rids: ['r1', 'r2'] });
    assert.deepStrictEqual(sevs(log).sort(), ['ERROR', 'WARNING']); }
  ok('instances are judged independently: one down (ERROR) + one unreachable (WARNING) in the same run');

  // 9. the REAL resolver drives it: brand ids come from data, and a la_musa without creds is skipped
  { const env = { };
    const real = (rid) => resolveWhatsappConfig(rid, env);
    assert.strictEqual(real('la_musa'), null, 'la_musa without its _LA_MUSA creds resolves to null → skipped');
    const fetchImpl = stubFetch({}); const log = sink();
    await H.checkInstances({ rids: ['la_musa'], resolve: real, fetchImpl, log });
    assert.strictEqual(fetchImpl.calls.length, 0); assert.deepStrictEqual(log.lines, []); }
  ok('the real resolveWhatsappConfig: an unconfigured restaurant is skipped with no call and no log');

  // 10. instanceOf never returns the token, the scheme or the host
  assert.strictEqual(H.instanceOf('https://api.ultramsg.com/instance170156'), 'instance170156');
  assert.strictEqual(H.instanceOf('https://api.ultramsg.com/instance170156/'), 'instance170156');
  ok('instanceOf → only the instance id');

  console.log(`instance-health: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
