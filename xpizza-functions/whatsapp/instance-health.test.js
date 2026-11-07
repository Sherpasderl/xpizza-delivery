'use strict';
// WhatsApp gateway health — the core and one full scheduled run, with the HTTP and config read STUBBED and every log line captured.
// Run: node whatsapp/instance-health.test.js
const assert = require('assert');
const H = require('./instance-health');
const { resolveWhatsappConfig } = require('../whatsapp');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// A hung await with no live timer lets node EXIT 0 mid-test (a stalled config read would then "pass") — completion is asserted.
const CELLS = 16; let done = false;
process.on('exit', (code) => { if (code === 0 && (!done || n !== CELLS)) { console.error(`🔴 instance-health did not complete (${n}/${CELLS} cells)`); process.exitCode = 1; } });
const TOKEN_A = 'tok-SECRET-aaa', TOKEN_B = 'tok-SECRET-bbb';
const URL_A = `https://api.ultramsg.com/instance111/instance/status?token=${TOKEN_A}`;
const CFG = { r1: { apiBase: 'https://api.ultramsg.com/instance111', token: TOKEN_A }, r2: { apiBase: 'https://api.ultramsg.com/instance222', token: TOKEN_B } };
const resolve = (rid) => CFG[rid] || null;
const body = (state, sub) => ({ status: { accountStatus: { status: state, ...(sub !== undefined ? { substatus: sub } : {}) } } });
const never = () => new Promise(() => {});

function sink() {
  const lines = [];
  return { lines, error: (m, f) => lines.push({ sev: 'ERROR', m, f }), warn: (m, f) => lines.push({ sev: 'WARNING', m, f }), info: (m, f) => lines.push({ sev: 'INFO', m, f }) };
}
// nothing secret-shaped in ANY captured line or its structured fields
function assertClean(log) {
  for (const l of log.lines) {
    const all = `${l.m} ${JSON.stringify(l.f || {})}`;
    for (const bad of [TOKEN_A, TOKEN_B, 'token=', 'https://', 'instance/status', 'SECRET']) assert.ok(!all.includes(bad), `🔴 a log line carries "${bad}": ${all}`);
  }
}
// fetch stub: per-instance behaviour; records every URL + options it was called with
function stubFetch(byInstance) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    const b = byInstance[H.instanceOf(url.split('/instance/status')[0])];
    if (b instanceof Error) throw b;
    if (b && b.hang) return never();
    if (b && b.httpStatus) return { ok: b.httpStatus >= 200 && b.httpStatus < 300, status: b.httpStatus, json: async () => ({}) };
    if (b && b.badJson) return { ok: true, status: 200, json: async () => { throw new SyntaxError(`Unexpected token in ${URL_A}`); } };
    if (b && b.hangBody) return { ok: true, status: 200, json: never };
    return { ok: true, status: 200, json: async () => b };
  };
  f.calls = calls;
  return f;
}
async function run(byInstance, { rids = ['r1'], enabled = true, res = resolve, timeoutMs } = {}) {
  const log = sink(); const fetchImpl = stubFetch(byInstance);
  const out = await H.checkInstances({ rids, resolve: res, fetchImpl, enabled, log, ...(timeoutMs ? { timeoutMs } : {}) });
  assertClean(log);
  return { log, out, fetchImpl };
}
const sevs = (log) => log.lines.map((l) => l.sev);

(async () => {
  // 1. healthy → silent; ONE bounded, non-redirecting request
  { const { log, out, fetchImpl } = await run({ instance111: body('authenticated', 'connected') });
    assert.deepStrictEqual(log.lines, []); assert.strictEqual(out[0].verdict, 'ok'); assert.strictEqual(fetchImpl.calls.length, 1);
    const { url, opts } = fetchImpl.calls[0];
    assert.ok(url.startsWith('https://api.ultramsg.com/instance111/instance/status?token='));
    assert.strictEqual(opts.redirect, 'manual', 'redirects are refused, never followed');
    assert.ok(opts.signal && typeof opts.signal.aborted === 'boolean', 'the request carries the deadline\'s abort signal');
    assert.strictEqual(opts.timeout, H.TIMEOUT_MS); assert.ok(H.TIMEOUT_MS > 0 && H.TIMEOUT_MS <= 10000);
    ok('authenticated → silent; one GET {instance}/instance/status, redirect:manual, abort signal, bounded timeout'); }

  // 2. unlinked → exactly ONE ERROR naming the restaurant + instance, with an ALLOWLISTED label
  for (const [state, sub, label] of [['qr', undefined, 'qr'], ['disconnected', undefined, 'disconnected'], ['authenticated', 'disconnected', 'disconnected'],
    ['authenticated', 'logged out', 'logged_out'], ['QR', undefined, 'qr'], ['standby', 'Logged Out', 'logged_out']]) {
    const { log, out } = await run({ instance111: body(state, sub) });
    assert.deepStrictEqual(sevs(log), ['ERROR'], `${state}/${sub}`);
    assert.strictEqual(log.lines[0].m, `whatsapp-health: DISCONNECTED rid=r1 instance=instance111 status=${label} — re-link the device (QR) in UltraMsg`);
    assert.deepStrictEqual(log.lines[0].f, { rids: 'r1', instance: 'instance111', status: label });
    assert.strictEqual(out[0].verdict, 'down');
  }
  ok('qr / disconnected, or substatus disconnected / logged out (any case) → one ERROR: rid + instance + an allowlisted label');

  // 3. transient states → WARNING with the fixed label "transient", never the upstream word
  for (const state of ['initialize', 'loading', 'retrying', 'standby', 'something-new']) {
    const { log, out } = await run({ instance111: body(state, 'connected') });
    assert.deepStrictEqual(sevs(log), ['WARNING'], state); assert.strictEqual(out[0].verdict, 'transient');
    assert.match(log.lines[0].m, / status=transient$/); assert.ok(!log.lines[0].m.includes(state) || state === 'transient');
  }
  ok('initialize / loading / retrying / standby / an unknown state → one WARNING labelled "transient", never ERROR');

  // 4. P1: an upstream status / substatus that CARRIES the token or URL is never echoed
  for (const b of [body(`qr ${URL_A}`), body(URL_A), body('authenticated', `${TOKEN_A} logged`), body(`SECRET ${TOKEN_A}`, URL_A), body('disconnected', URL_A)]) {
    const { log } = await run({ instance111: b });
    assert.strictEqual(log.lines.length <= 1, true);
  }
  ok('codex r1 P1: status / substatus strings containing the token or the URL never reach a log line (labels only)');

  // 5. the status call itself failing → ONE WARNING with a FIXED reason code, never "disconnected", never the error text
  const cases = {
    timeout: [Object.assign(new Error(`network timeout at: ${URL_A}`), { name: 'FetchError', type: 'request-timeout' }), 'timeout'],
    abort: [Object.assign(new Error(`The operation was aborted ${URL_A}`), { name: 'AbortError' }), 'timeout'],
    network: [Object.assign(new Error(`getaddrinfo ENOTFOUND ${URL_A}`), { name: 'FetchError', type: 'system' }), 'network'],
    http500: [{ httpStatus: 500 }, 'http_500'], http401: [{ httpStatus: 401 }, 'http_401'],
    redirect301: [{ httpStatus: 301 }, 'redirect'], redirect302: [{ httpStatus: 302 }, 'redirect'], redirect307: [{ httpStatus: 307 }, 'redirect'],
    badJson: [{ badJson: true }, 'bad_json'], invalidJson: [Object.assign(new Error(`invalid json response body at ${URL_A}`), { name: 'FetchError', type: 'invalid-json' }), 'bad_json'],
  };
  for (const [k, [b, code]] of Object.entries(cases)) {
    const { log, out } = await run({ instance111: b });
    assert.deepStrictEqual(sevs(log), ['WARNING'], k);
    assert.strictEqual(log.lines[0].m, `whatsapp-health: status check failed rid=r1 instance=instance111 reason=${code}`, k);
    assert.strictEqual(out[0].verdict, 'check_failed'); assert.strictEqual(out[0].reason, code);
  }
  for (const [k, b] of Object.entries({ noStatus: {}, nullBody: null, emptyState: body(''), wrongShape: { status: 'authenticated' }, numState: { status: { accountStatus: { status: 7 } } } })) {
    const { log, out } = await run({ instance111: b });
    assert.deepStrictEqual(sevs(log), ['WARNING'], k); assert.match(log.lines[0].m, / status=unrecognised$/); assert.strictEqual(out[0].verdict, 'unknown');
  }
  ok('timeout / abort / network / http_<code> / redirect (3xx) / bad_json → fixed reason codes; malformed bodies → "unrecognised"; all WARNING');

  // 6. P2: ONE deadline covers the request AND the body read
  for (const [k, b] of [['hung request', { hang: true }], ['hung body', { hangBody: true }]]) {
    const t0 = Date.now();
    const { log, out, fetchImpl } = await run({ instance111: b }, { timeoutMs: 40 });
    const took = Date.now() - t0;
    assert.ok(took < 1000, `${k}: bounded by the deadline (${took} ms)`);
    assert.deepStrictEqual(sevs(log), ['WARNING']); assert.strictEqual(out[0].reason, 'timeout', k);
    assert.strictEqual(fetchImpl.calls[0].opts.signal.aborted, true, `${k}: the request is aborted at the deadline`);
  }
  ok('codex r1 P2: a hung request and a hung body read each end at the ONE deadline (aborted, reason=timeout)');

  // 7. one call per INSTANCE: ids that resolve to the same instance are checked once and named together
  { const shared = (rid) => (rid === 'r2' ? CFG.r2 : CFG.r1);
    const { log, fetchImpl } = await run({ instance111: body('qr'), instance222: body('authenticated') }, { rids: ['r1', 'r3', 'r2', 'r4'], res: shared });
    assert.strictEqual(fetchImpl.calls.length, 2);
    assert.deepStrictEqual(sevs(log), ['ERROR']); assert.match(log.lines[0].m, /rid=r1,r3,r4 instance=instance111 /); }
  ok('4 restaurants on 2 instances → 2 calls; the unlinked instance names every restaurant that shares it');

  // 8. not configured (resolver null / throws / no token) → skipped, no call, no log
  { const res = (rid) => { if (rid === 'boom') throw new Error(URL_A); if (rid === 'notoken') return { apiBase: 'https://api.ultramsg.com/i9', token: '' }; return rid === 'r1' ? CFG.r1 : null; };
    const { log, fetchImpl } = await run({ instance111: body('authenticated') }, { rids: ['none', 'boom', 'notoken', 'r1'], res });
    assert.strictEqual(fetchImpl.calls.length, 1); assert.deepStrictEqual(log.lines, []); }
  ok('a restaurant without UltraMsg config (null / throwing resolver / no token) is skipped: no call, no log');

  // 9. sends deliberately disabled → an unlinked instance is a WARNING, not an ERROR
  { const { log } = await run({ instance111: body('qr') }, { enabled: false });
    assert.deepStrictEqual(sevs(log), ['WARNING']); assert.match(log.lines[0].m, /DISCONNECTED .*\(whatsapp_enabled=false\)$/); }
  ok('/config/whatsapp_enabled=false → still checked; an unlinked instance logs WARNING instead of ERROR');

  // 10. instances are judged independently in one run
  { const { log } = await run({ instance111: body('disconnected'), instance222: { httpStatus: 503 } }, { rids: ['r1', 'r2'] });
    assert.deepStrictEqual(sevs(log).sort(), ['ERROR', 'WARNING']); }
  ok('one instance down (ERROR) + one unreachable (WARNING) in the same run');

  // ── the full scheduled run (runHealth) ──
  const runH = async (over) => {
    const log = sink(); const fetchImpl = over.fetchImpl || stubFetch({ instance111: body('qr') });
    const out = await H.runHealth({ knownRids: async () => ['r1'], readEnabled: async () => true, resolve, fetchImpl, log, ...over });
    assertClean(log); return { log, out, fetchImpl };
  };
  // 11. P2: the whatsapp_enabled read is bounded; on expiry the checks still run, as enabled, with ONE config_timeout WARNING
  { const t0 = Date.now();
    const { log, fetchImpl } = await runH({ readEnabled: never, configTimeoutMs: 40 });
    assert.ok(Date.now() - t0 < 1000, 'never stalls on the config read');
    assert.strictEqual(fetchImpl.calls.length, 1, 'the status call still ran');
    assert.deepStrictEqual(sevs(log), ['WARNING', 'ERROR']);
    assert.strictEqual(log.lines[0].m, 'whatsapp-health: whatsapp_enabled read failed reason=config_timeout (checking as enabled)'); }
  ok('codex r1 P2: a hung whatsapp_enabled read → WARNING config_timeout; the status checks still run, as enabled (ERROR on qr)');

  // 12. P1: a wrapper failure whose message carries the token / URL → fixed codes only
  { const { log } = await runH({ readEnabled: async () => { throw new Error(`db failed ${URL_A}`); } });
    assert.deepStrictEqual(sevs(log), ['WARNING', 'ERROR']); assert.match(log.lines[0].m, /reason=config_error/); }
  { const { log, out } = await runH({ knownRids: async () => { throw new Error(`registry failed ${URL_A} ${TOKEN_B}`); } });
    assert.strictEqual(out, null); assert.deepStrictEqual(log.lines.map((l) => l.m), ['whatsapp-health: run failed reason=run_error']); }
  { const { log } = await runH({ readEnabled: async () => false });
    assert.deepStrictEqual(sevs(log), ['WARNING']); assert.match(log.lines[0].m, /\(whatsapp_enabled=false\)$/); }
  ok('codex r1 P1: a config-read or registry failure carrying the token / URL logs only reason=config_error / run_error; enabled=false flows through');

  // 13. the REAL resolver: a la_musa without its creds is skipped
  { const real = (rid) => resolveWhatsappConfig(rid, {});
    assert.strictEqual(real('la_musa'), null);
    const fetchImpl = stubFetch({}); const log = sink();
    await H.checkInstances({ rids: ['la_musa'], resolve: real, fetchImpl, log });
    assert.strictEqual(fetchImpl.calls.length, 0); assert.deepStrictEqual(log.lines, []); }
  ok('the real resolveWhatsappConfig: an unconfigured restaurant is skipped with no call and no log');

  // 14. helpers
  assert.strictEqual(H.instanceOf('https://api.ultramsg.com/instance170156/'), 'instance170156');
  assert.strictEqual(H.failureCode(new Error(URL_A)), 'network');
  await assert.rejects(H.withDeadline(never, 20), (e) => H.failureCode(e) === 'timeout');
  assert.strictEqual(await H.withDeadline(async () => 7, 20), 7);
  { let sig; await H.withDeadline(async (s) => { sig = s; return 1; }, 30); await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(sig.aborted, false, 'the deadline timer is CLEARED once the work settles (no late abort)'); }
  ok('instanceOf → only the id; failureCode never returns text; withDeadline rejects at the deadline and passes values through');

  // 15. REAL node-fetch against a loopback server: a redirect loop is ONE request (refused), a hung body ends at the deadline
  { const http = require('http'); const fetch = require('node-fetch');
    let hits = 0;
    const srv = http.createServer((req, res) => {
      hits++;
      if (req.url.startsWith('/loop/')) { res.writeHead(302, { Location: req.url }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"status":');   // the body never completes
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const cfg = { loop: { apiBase: `${base}/loop`, token: TOKEN_A }, hang: { apiBase: `${base}/hang`, token: TOKEN_B } };
    try {
      let log = sink();
      let out = await H.checkInstances({ rids: ['loop'], resolve: (r) => cfg[r], fetchImpl: fetch, log, timeoutMs: 200 });
      assertClean(log);
      assert.strictEqual(hits, 1, `a redirect is never followed (${hits} requests)`); assert.strictEqual(out[0].reason, 'redirect');
      log = sink(); const t0 = Date.now();
      out = await H.checkInstances({ rids: ['hang'], resolve: (r) => cfg[r], fetchImpl: fetch, log, timeoutMs: 150 });
      assertClean(log);
      assert.ok(Date.now() - t0 < 2000, 'the hung body ends at the deadline'); assert.strictEqual(out[0].reason, 'timeout');
    } finally { srv.closeAllConnections(); srv.close(); }
  }
  ok('real node-fetch (loopback): a 302 loop is ONE request → reason=redirect; a never-ending body → reason=timeout at the deadline');

  // 16. codex r2: the REAL scheduler wrapper (onSchedule .run) — the db read rejects with the token / URL before AND after the
  //     deadline; EVERY console method, both std streams and unhandled rejections are captured → nothing leaks.
  { const out = []; const saved = {}; const unhandled = [];
    const onUnh = (e) => unhandled.push(String(e && e.message));
    const capture = () => {
      for (const k of ['log', 'info', 'warn', 'error', 'debug']) { saved[k] = console[k]; console[k] = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }
      for (const st of ['stdout', 'stderr']) { saved[st] = process[st].write; process[st].write = (chunk) => { out.push(String(chunk)); return true; }; }
      process.on('unhandledRejection', onUnh);
    };
    const release = () => { for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = saved[k]; for (const st of ['stdout', 'stderr']) process[st].write = saved[st]; process.off('unhandledRejection', onUnh); };
    const leak = `db read failed ${URL_A} ${TOKEN_A}`;
    const dbRejecting = (delayMs) => ({ ref: () => ({ once: () => new Promise((_, rej) => setTimeout(() => rej(new Error(leak)), delayMs)) }) });
    const dbValue = (v) => ({ ref: (p) => { assert.strictEqual(p, 'config/whatsapp_enabled'); return { once: async () => ({ val: () => v }) }; } });
    const wrapper = (db) => H.makeHealthFunction({ registry: () => ({ ready: async () => {}, known: () => new Set() }), getDb: () => db, configTimeoutMs: 40 });
    capture();
    try {
      await wrapper(dbRejecting(0)).run({});                         // rejects BEFORE the deadline → config_error
      await wrapper(dbRejecting(150)).run({});                       // rejects AFTER the 40 ms deadline → config_timeout, then late
      await new Promise((r) => setTimeout(r, 300));                  // let the late rejection land
      await wrapper(dbValue(false)).run({});
      await wrapper(dbValue(null)).run({});
    } finally { release(); }
    const all = out.join('\n');
    for (const bad of [TOKEN_A, 'token=', 'https://', 'instance/status', 'SECRET', 'db read failed']) assert.ok(!all.includes(bad), `🔴 a captured line carries "${bad}":\n${all}`);
    assert.deepStrictEqual(unhandled, [], 'the late rejection is swallowed, never unhandled');
    assert.strictEqual((all.match(/reason=config_error/g) || []).length, 1, all);
    assert.strictEqual((all.match(/reason=config_timeout/g) || []).length, 1, all);
    assert.ok(/"severity":"WARNING"/.test(all), 'the real firebase logger emitted structured WARNINGs');
    assert.strictEqual(await H.readEnabledFlag(dbValue(false)), false); assert.strictEqual(await H.readEnabledFlag(dbValue(null)), true);
    await assert.rejects(H.readEnabledFlag(dbRejecting(0)), (e) => e.message === 'config_error'); }
  ok('codex r2: the REAL scheduler wrapper — a db read rejecting with the token / URL before or after the deadline leaks into NO console / stream line; the late rejection is swallowed');

  done = true;
  console.log(`instance-health: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
