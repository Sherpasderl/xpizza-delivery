'use strict';
// D4 S0 (PLAN-sdk-d4-r4 S0) — the REAL PixelPay adapter impl behind the existing makeAdapter wrapper. Every cell talks to a
// LOOPBACK HTTP server (the egress guard holds) and asserts the request ON THE WIRE. The mapping is evidence-first: an outcome
// other than `unknown` / `inconclusive` comes only from the spec'd success shape or from a recorded sandbox fixture.
// Run: node payments/sdk/pixelpay-adapter.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeAdapter } = require('./psp-adapter');
const A = () => require('./pixelpay-adapter');

const SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const SENTINEL = { token: 'tok_SENTINEL_9f3e', pan: '4111111111111111', cvv: 'cvv-777', name: 'Sentinela Nombre', email: 'sentinela.correo@gmail.com', ticket: 'ct_sentinel0000000000000000000000' };

// a loopback PixelPay: records every request; `reply(req)` returns { status, body } or { stall: true } (headers, then silence)
function server(reply) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch (_) { body = raw; }
      const rec = { method: req.method, url: req.url, headers: req.headers, body };
      seen.push(rec);
      const r = reply(rec) || { status: 500, body: {} };
      if (r.destroy) { req.socket.destroy(); return; }
      res.writeHead(r.status || 200, { 'content-type': 'application/json' });
      if (r.stall) { res.write('{"success":'); return; }   // headers + a partial body, then nothing
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) })));
}
const cfgOf = (url, over = {}) => ({ mode: 'sandbox', namespace: 'sandbox', endpoint: url, app_url: 'https://pixelpay.dev', key_id: '1234567890', auth_hash: '36cdf8271723276cb6f94904f8bde4b6', secret: SECRET, merchant_email: 'sandbox@pixel.hn', gw_token: null, ...over });
const AUTH_IN = { token: SENTINEL.token, amount_cents: 150, op_id: 'o:L1:auth:1', ref: 'sdkabcdefghijklmnopqrstuvwxyz', authentication_identifier: null, payer: { name: SENTINEL.name, email: SENTINEL.email } };
const approvedBody = (amount = '1.50') => ({ success: true, message: 'ok', data: { payment_uuid: 'P-uuid-1', transaction_approved_amount: amount, response_approved: true } });

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${e && e.message}`); } };

(async () => {
  await cell('SDK-D4-PP-CONFIG', async (L) => {
    const { parseConfig } = A();
    const good = cfgOf('https://pixelpay.dev');
    assert.ok(parseConfig(JSON.stringify(good)), `${L}: a complete config parses`);
    assert.strictEqual(parseConfig(JSON.stringify({ mode: 'off' })), null, `${L}: the placeholder {"mode":"off"} is unconfigured`);
    assert.strictEqual(parseConfig(JSON.stringify({ ...good, mode: 'off' })), null, `${L}: mode off is unconfigured`);
    assert.strictEqual(parseConfig('not json'), null, `${L}: malformed JSON is unconfigured`);
    assert.strictEqual(parseConfig(''), null, `${L}: empty is unconfigured`);
    assert.strictEqual(parseConfig(JSON.stringify({ ...good, extra: 1 })), null, `${L}: an unknown key is refused`);
    const { namespace: _n, ...noNs } = good;
    assert.strictEqual(parseConfig(JSON.stringify(noNs)), null, `${L}: namespace is required`);
    assert.strictEqual(parseConfig(JSON.stringify({ ...good, endpoint: 'http://pixelpay.dev' })), null, `${L}: a non-https endpoint is refused`);
    assert.strictEqual(parseConfig(JSON.stringify({ ...good, namespace: 'other' })), null, `${L}: namespace ∈ prod|staging|sandbox`);
    assert.strictEqual(parseConfig(JSON.stringify({ ...good, secret: '' })), null, `${L}: an empty secret is refused`);
  });

  await cell('SDK-D4-PP-WIRE', async (L) => {
    const srv = await server((r) => (r.url.endsWith('/auth') ? { status: 200, body: approvedBody() } : r.url.endsWith('/capture') ? { status: 200, body: { success: true, data: { payment_uuid: 'P-uuid-1', transaction_approved_amount: '1.50' } } } : r.url.endsWith('/void') ? { status: 200, body: { success: true, data: { payment_uuid: 'P-uuid-1' } } } : { status: 200, body: { success: true, data: {} } }));
    try {
      const { makePixelPayImpl } = A();
      const sb = makeAdapter(makePixelPayImpl(cfgOf(srv.url, { gw_token: 'gw-1' }), { log: { info: () => {} } }));
      await sb.pspAuthorize({ ...AUTH_IN, authentication_identifier: 'auth-id-1' });
      await sb.pspCapture({ uuid: 'P-uuid-1', amount_cents: 150, op_id: 'o:L1:capture:2' });
      await sb.pspVoid({ uuid: 'P-uuid-1', op_id: 'o:L1:void:3', ref: AUTH_IN.ref });
      await sb.pspStatus({ uuid: 'P-uuid-1' });
      const [au, ca, vo, st] = srv.seen;
      assert.deepStrictEqual([au.url, ca.url, vo.url, st.url], ['/api/v2/transaction/auth', '/api/v2/transaction/capture', '/api/v2/transaction/void', '/api/v2/transaction/status'], `${L}: the four paths`);
      for (const r of srv.seen) {
        assert.strictEqual(r.method, 'POST', `${L}: POST`);
        assert.strictEqual(r.headers['x-auth-key'], '1234567890', `${L}: x-auth-key`);
        assert.strictEqual(r.headers['x-auth-hash'], '36cdf8271723276cb6f94904f8bde4b6', `${L}: x-auth-hash verbatim from the config`);
        assert.strictEqual(r.headers['x-gw-access-token'], 'gw-1', `${L}: the gateway header when configured`);
        assert.strictEqual(r.body.env, 'sandbox', `${L}: sandbox env on EVERY call (${r.url})`);
      }
      assert.deepStrictEqual(Object.keys(au.body).sort(), ['authentication_identifier', 'card_token', 'customer_email', 'customer_name', 'env', 'order_amount', 'order_currency', 'order_id'], `${L}: the auth body keys exactly`);
      assert.strictEqual(au.body.order_amount, '1.50', `${L}: the auth amount is a 2-decimal string`);
      assert.strictEqual(au.body.order_id, AUTH_IN.ref, `${L}: order_id = the stored pp_ref`);
      assert.strictEqual(au.body.order_currency, 'HNL', `${L}: currency`);
      assert.strictEqual(au.body.customer_name, SENTINEL.name, `${L}: customer_name / customer_email on the wire`);
      assert.strictEqual(au.body.customer_email, SENTINEL.email, `${L}: customer_name / customer_email on the wire`);
      assert.strictEqual(au.body.authentication_identifier, 'auth-id-1', `${L}: the identifier forwarded`);
      assert.deepStrictEqual(Object.keys(ca.body).sort(), ['env', 'payment_uuid', 'transaction_approved_amount'], `${L}: the capture body keys`);
      assert.strictEqual(ca.body.transaction_approved_amount, '1.50', `${L}: capture amount is a 2-decimal string`);
      assert.deepStrictEqual(Object.keys(vo.body).sort(), ['env', 'payment_uuid', 'void_reason'], `${L}: the SANDBOX void is unsigned`);
      assert.ok(!vo.headers['x-auth-user'], `${L}: no x-auth-user in sandbox`);
      assert.ok(vo.body.void_reason.length >= 8, `${L}: void_reason ≥ 8 chars`);
      assert.deepStrictEqual(Object.keys(st.body).sort(), ['env', 'payment_uuid'], `${L}: the status body`);
      // a null identifier is omitted
      await sb.pspAuthorize({ ...AUTH_IN, ref: 'sdkzzzzzzzzzzzzzzzzzzzzzzzzzz' });
      assert.ok(!('authentication_identifier' in srv.seen[4].body), `${L}: a null identifier is omitted`);
    } finally { await srv.close(); }
    const pr = await server((r) => ({ status: 200, body: r.url.endsWith('/void') ? { success: true, data: { payment_uuid: 'P-uuid-1' } } : approvedBody() }));
    try {
      const { makePixelPayImpl } = A();
      const prod = makeAdapter(makePixelPayImpl(cfgOf(pr.url, { mode: 'production', namespace: 'prod', merchant_email: 'Owner@Example.HN', gw_token: null }), { log: { info: () => {} } }));
      await prod.pspAuthorize(AUTH_IN);
      await prod.pspVoid({ uuid: 'P-uuid-1', op_id: 'o:L1:void:3', ref: AUTH_IN.ref });
      const [au, vo] = pr.seen;
      assert.ok(!('env' in au.body) && !('env' in vo.body), `${L}: production omits env`);
      assert.ok(!au.headers['x-gw-access-token'], `${L}: no gateway header when not configured`);
      assert.deepStrictEqual(Object.keys(vo.body).sort(), ['payment_uuid', 'void_reason', 'void_signature'], `${L}: the production void is signed`);
      assert.strictEqual(vo.headers['x-auth-user'], crypto.createHash('sha512').update('owner@example.hn').digest('hex'), `${L}: x-auth-user = SHA-512(trimmed lower-cased email)`);
    } finally { await pr.close(); }
  });

  await cell('SDK-D4-PP-SIGNATURES', async (L) => {
    const srv = await server((r) => ({ status: 200, body: r.url.endsWith('/void') ? { success: true, data: { payment_uuid: 'P-uuid-1' } } : approvedBody() }));
    try {
      const { makePixelPayImpl } = A();
      const cfg = cfgOf(srv.url, { mode: 'production', namespace: 'prod', app_url: 'https://pixelpay.dev', merchant_email: 'Owner@Example.HN' });
      const ad = makeAdapter(makePixelPayImpl(cfg, { log: { info: () => {} } }));
      await ad.pspAuthorize({ ...AUTH_IN, ref: 'ORDER-8888' });
      const kat = srv.seen[0].headers['x-client-signature'];
      assert.ok(kat.startsWith('688084a6') && kat.endsWith('e852ee2a'), `${L}: the doc known-answer ORDER-8888 → 688084a6…e852ee2a (got ${kat.slice(0, 8)}…)`);
      await ad.pspCapture({ uuid: 'P-uuid-1', amount_cents: 150, op_id: 'o:L1:capture:2' });
      const hm = (f) => crypto.createHmac('sha3-512', SECRET).update(f.join('|')).digest('hex');
      assert.strictEqual(srv.seen[1].headers['x-client-signature'], hm(['1234567890', '1.50', 'P-uuid-1', 'https://pixelpay.dev']), `${L}: capture signature over key|amount|uuid|app_url`);
      await ad.pspStatus({ uuid: 'P-uuid-1' });
      assert.strictEqual(srv.seen[2].headers['x-client-signature'], hm(['1234567890', 'P-uuid-1', 'https://pixelpay.dev']), `${L}: status signature over key|uuid|app_url`);
      await ad.pspVoid({ uuid: 'P-uuid-1', op_id: 'o:L1:void:3', ref: AUTH_IN.ref });
      const want = crypto.createHash('sha512').update(['Owner@Example.HN', AUTH_IN.ref, SECRET].join('|')).digest('hex');
      assert.strictEqual(srv.seen[3].body.void_signature, want, `${L}: the RAW email: void signature = SHA-512(raw email|pp_ref|secret), void signature over pp_ref`);
    } finally { await srv.close(); }
  });

  await cell('SDK-D4-PP-AUTH-MAP', async (L) => {
    const cases = [
      [{ status: 200, body: approvedBody() }, 'approved'],
      [{ status: 200, body: { ...approvedBody(), data: { ...approvedBody().data, response_approved: false } } }, 'unknown'],
      [{ status: 200, body: { success: false, data: approvedBody().data } }, 'unknown'],
      [{ status: 200, body: { success: true, data: { transaction_approved_amount: '1.50' } } }, 'unknown'],
      [{ status: 400, body: { success: false, message: 'bad' } }, 'unknown'],
      [{ status: 401, body: {} }, 'unknown'],
      [{ status: 403, body: '<html>Just a moment...</html>' }, 'unknown'],
      [{ status: 404, body: {} }, 'unknown'],
      [{ status: 408, body: {} }, 'unknown'],
      [{ status: 412, body: {} }, 'unknown'],
      [{ status: 418, body: {} }, 'unknown'],
      [{ status: 422, body: { success: false, errors: {} } }, 'unknown'],
      [{ status: 500, body: {} }, 'unknown'],
      [{ status: 502, body: 'gateway' }, 'unknown'],
      [{ status: 200, body: 'not json' }, 'unknown'],
    ];
    for (const [reply, want] of cases) {
      const srv = await server(() => reply);
      try {
        const out = await makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { log: { info: () => {} } })).pspAuthorize(AUTH_IN);
        assert.strictEqual(out.outcome, want, `${L}: HTTP ${reply.status} ${JSON.stringify(reply.body).slice(0, 60)} ⇒ ${want} (got ${out.outcome}); 400 ⇒ unknown`);
        if (want === 'approved') assert.ok(out.uuid === 'P-uuid-1' && out.amount_cents === 150, `${L}: the approval carries the uuid and the cents`);
      } finally { await srv.close(); }
    }
  });

  await cell('SDK-D4-PP-AMOUNT-MISMATCH', async (L) => {
    for (const amt of ['1.49', 1.49, '1', 1, '01.50', '1.500', 1.505, '1,50', -1.5, null]) {
      const srv = await server(() => ({ status: 200, body: approvedBody(amt) }));
      try {
        const out = await makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { log: { info: () => {} } })).pspAuthorize(AUTH_IN);
        assert.strictEqual(out.outcome, 'unknown', `${L}: an approved amount ${JSON.stringify(amt)} that is not exactly 150 cents (≤ 2 decimals) ⇒ unknown`);
      } finally { await srv.close(); }
    }
  });

  await cell('SDK-D4-PP-202-NEGATIVE', async (L) => {
    const bodies = [{ success: true, data: { transaction_type: 'payload', payload: 'x' } }, { success: true, data: { transaction_type: 'router', payload: 'x' } }, { success: true, data: { transaction_type: 'songbird' } }, { success: true, data: { transaction_type: 'mystery' } }, {}];
    for (const b of bodies) {
      const srv = await server(() => ({ status: 202, body: b }));
      try {
        const out = await makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { log: { info: () => {} } })).pspAuthorize(AUTH_IN);
        assert.strictEqual(out.outcome, 'unknown', `${L}: a payload 202 is unknown unless it matches a RECORDED challenge envelope (${JSON.stringify(b).slice(0, 50)})`);
      } finally { await srv.close(); }
    }
    for (const b of [{ success: true, message: 'declined?' }, { success: false }, { message: 'x' }]) {
      const srv = await server(() => ({ status: 402, body: b }));
      try {
        const out = await makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { log: { info: () => {} } })).pspAuthorize(AUTH_IN);
        assert.strictEqual(out.outcome, 'unknown', `${L}: a 402 not matching a RECORDED decline envelope is unknown (${JSON.stringify(b)})`);
      } finally { await srv.close(); }
    }
  });

  await cell('SDK-D4-PP-CAPTURE-VOID-STATUS-MAP', async (L) => {
    const run = async (reply, fn) => { const srv = await server(() => reply); try { return await fn(makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { log: { info: () => {} } }))); } finally { await srv.close(); } };
    assert.strictEqual((await run({ status: 200, body: { success: true, data: { payment_uuid: 'P-uuid-1', transaction_approved_amount: '1.50' } } }, (a) => a.pspCapture({ uuid: 'P-uuid-1', amount_cents: 150, op_id: 'o' }))).outcome, 'captured', `${L}: a bound capture ⇒ captured`);
    assert.strictEqual((await run({ status: 200, body: { success: true, data: { payment_uuid: 'P-other', transaction_approved_amount: '1.50' } } }, (a) => a.pspCapture({ uuid: 'P-uuid-1', amount_cents: 150, op_id: 'o' }))).outcome, 'unknown', `${L}: a capture for another uuid ⇒ unknown`);
    assert.strictEqual((await run({ status: 402, body: { success: false } }, (a) => a.pspCapture({ uuid: 'P-uuid-1', amount_cents: 150, op_id: 'o' }))).outcome, 'unknown', `${L}: an unrecorded capture refusal ⇒ unknown`);
    assert.strictEqual((await run({ status: 200, body: { success: true, data: { payment_uuid: 'P-uuid-1' } } }, (a) => a.pspVoid({ uuid: 'P-uuid-1', op_id: 'o', ref: AUTH_IN.ref }))).outcome, 'voided', `${L}: a bound void ⇒ voided`);
    assert.strictEqual((await run({ status: 412, body: { success: false } }, (a) => a.pspVoid({ uuid: 'P-uuid-1', op_id: 'o', ref: AUTH_IN.ref }))).outcome, 'unknown', `${L}: an unrecorded void refusal ⇒ unknown`);
    const nr = await (async () => { const srv = await server(() => ({ status: 200, body: { success: true, data: { payment_uuid: 'P-uuid-1' } } })); try { return await makeAdapter(A().makePixelPayImpl(cfgOf(srv.url, { mode: 'production', namespace: 'prod' }), { log: { info: () => {} } })).pspVoid({ uuid: 'P-uuid-1', op_id: 'o' }); } finally { await srv.close(); } })();
    assert.strictEqual(nr.outcome, 'unknown', `${L}: a production void with no pp_ref ⇒ unknown, never a guessed signature`);
    const st = await run({ status: 200, body: { success: true, message: 'Información obtenida con exito', data: { status: 'authorized', attemps: 1, history: {} } } }, (a) => a.pspStatus({ uuid: 'P-uuid-1' }));
    assert.deepStrictEqual([st.state, st.uuid, st.amount_cents], ['authorized', 'P-uuid-1', undefined], `${L}: a recorded status word ⇒ that state, bound to the requested uuid, with NO amount`);
    const st2 = await run({ status: 200, body: { success: true, data: { status: 'refunded' } } }, (a) => a.pspStatus({ uuid: 'P-uuid-1' }));
    assert.strictEqual(st2.state, 'inconclusive', `${L}: an UNRECORDED status word ⇒ inconclusive`);
    const st3 = await run({ status: 412, body: { success: false, message: 'Error al encontrar el cobro' } }, (a) => a.pspStatus({ uuid: 'P-uuid-1' }));
    assert.strictEqual(st3.state, 'inconclusive', `${L}: 412 «not found» is never evidence (of a void or anything)`);
  });

  await cell('SDK-D4-PP-DEADLINE', async (L) => {
    assert.strictEqual(A().DEADLINE_MS, 15000, `${L}: the production deadline is 15 s`);
    const srv = await server(() => ({ stall: true }));
    try {
      const t = Date.now();
      const guard = new Promise((r) => setTimeout(() => r({ outcome: 'HUNG' }), 3000));   // a hang fails HERE, never at the runner's alarm
      const out = await Promise.race([makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { deadlineMs: 300, log: { info: () => {} } })).pspAuthorize(AUTH_IN), guard]);
      assert.strictEqual(out.outcome, 'unknown', `${L}: headers then a stalled body ⇒ unknown — the deadline covers the BODY read (got ${out.outcome})`);
      assert.ok(Date.now() - t < 3000, `${L}: the deadline covers the BODY read (returned after ${Date.now() - t} ms)`);
    } finally { await srv.close(); }
  });

  await cell('SDK-D4-PP-NO-RESEND', async (L) => {
    const srv = await server(() => ({ destroy: true }));
    try {
      const out = await makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { log: { info: () => {} } })).pspAuthorize(AUTH_IN);
      assert.strictEqual(out.outcome, 'unknown', `${L}: a lost response ⇒ unknown`);
      assert.strictEqual(srv.seen.length, 1, `${L}: exactly ONE auth request on the wire (got ${srv.seen.length})`);
    } finally { await srv.close(); }
  });

  await cell('SDK-D4-PP-WRAPPER-FORWARDS', async (L) => {
    const got = [];
    const ad = makeAdapter({ pspAuthorize: async (a) => { got.push(a); return { outcome: 'definitive_decline' }; }, pspVoid: async (a) => { got.push(a); return { outcome: 'refused' }; } });
    await ad.pspAuthorize({ ...AUTH_IN, authentication_identifier: 'aid' });
    await ad.pspVoid({ uuid: 'P-uuid-1', op_id: 'o', ref: AUTH_IN.ref });
    assert.deepStrictEqual(got[0].payer, AUTH_IN.payer, `${L}: the wrapper forwards payer`);
    assert.strictEqual(got[0].authentication_identifier, 'aid', `${L}: the wrapper forwards authentication_identifier`);
    assert.strictEqual(got[1].ref, AUTH_IN.ref, `${L}: the wrapper forwards the void ref`);
    await assert.rejects(() => ad.pspAuthorize({ ...AUTH_IN, payer: { name: '', email: null } }), /payer/, `${L}: a payer without a name is refused`);
    await assert.rejects(() => ad.pspAuthorize({ ...AUTH_IN, authentication_identifier: 5 }), /authentication_identifier/, `${L}: a non-string identifier is refused`);
  });

  await cell('SDK-D4-PP-DARK', async (L) => {
    const deps = () => { delete require.cache[require.resolve('./deps')]; return require('./deps'); };
    const before = process.env.SDK_PP_CONFIG;
    try {
      for (const v of [undefined, '', '{"mode":"off"}', 'garbage', JSON.stringify({ ...cfgOf('https://pixelpay.dev'), mode: 'off' })]) {
        if (v === undefined) delete process.env.SDK_PP_CONFIG; else process.env.SDK_PP_CONFIG = v;
        const d = deps().productionDeps({});
        assert.strictEqual(d.ppNamespace, 'unconfigured', `${L}: ${JSON.stringify(v)} ⇒ unconfigured`);
        const out = await d.psp.pspAuthorize(AUTH_IN);
        assert.strictEqual(out.outcome, 'unknown', `${L}: an unconfigured adapter only ever answers unknown`);
      }
      process.env.SDK_PP_CONFIG = JSON.stringify(cfgOf('https://pixelpay.dev', { namespace: 'staging' }));
      assert.strictEqual(deps().productionDeps({}).ppNamespace, 'staging', `${L}: a parsed config exposes its namespace`);
    } finally { if (before === undefined) delete process.env.SDK_PP_CONFIG; else process.env.SDK_PP_CONFIG = before; }
  });

  await cell('SDK-D4-PP-SECRETS-ONLY', async (L) => {
    const src = fs.readFileSync(path.join(__dirname, 'pixelpay-adapter.js'), 'utf8');
    assert.ok(!/process\.env/.test(src), `${L}: the adapter never reads process.env`);
    assert.ok(!/pixelpay-config/.test(src) && !/pixelpay-client/.test(src), `${L}: the adapter never touches the hosted checkout's config / client`);
    const sec = fs.readFileSync(path.join(__dirname, 'secrets.js'), 'utf8');
    assert.ok(/defineSecret\('SDK_PP_CONFIG'\)/.test(sec), `${L}: the config is ONE defineSecret`);
    assert.ok(!/defineString|defineInt|defineBoolean/.test(sec + fs.readFileSync(path.join(__dirname, 'deps.js'), 'utf8')), `${L}: no non-secret params`);
  });

  await cell('SDK-D4-PP-HOSTED-UNTOUCHED', async (L) => {
    const d = execFileSync('git', ['diff', '--stat', '53edc481', '--', 'pixelpay-config.js', 'pixelpay-client.js', 'pixelpay.js', 'pixelpay-hosted.js'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
    assert.strictEqual(d.trim(), '', `${L}: the hosted checkout's modules are byte-equal to base`);
  });

  await cell('SDK-D4-PP-NO-LEAK', async (L) => {
    const logged = [];
    const cap = (...a) => logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const replies = [{ status: 200, body: approvedBody() }, { status: 200, body: 'garbage' }, { stall: true }, { destroy: true }, { status: 402, body: { success: false, data: { card: SENTINEL.pan, cvv: SENTINEL.cvv } } }];
    for (const reply of replies) {
      const srv = await server(() => reply);
      Object.assign(console, { log: cap, info: cap, warn: cap, error: cap });
      try { await makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { deadlineMs: 300 })).pspAuthorize(AUTH_IN); }
      finally { Object.assign(console, orig); await srv.close(); }
    }
    const all = logged.join('\n');
    for (const [k, v] of Object.entries(SENTINEL)) assert.ok(!all.includes(v), `${L}: the sentinel ${k} never appears in a log`);
    assert.ok(!all.includes(SECRET), `${L}: the secret never appears in a log`);
    for (const line of logged) {
      const m = line.match(/^sdkpp (\{.*\})$/);
      assert.ok(m, `${L}: every adapter log line is the allowlisted diagnostic («${line.slice(0, 60)}»)`);
      assert.deepStrictEqual(Object.keys(JSON.parse(m[1])).sort(), ['call', 'code', 'http_status', 'op_id', 'outcome'], `${L}: the diagnostic keys exactly`);
    }
    assert.ok(logged.length === replies.length, `${L}: one diagnostic per call (got ${logged.length})`);
  });

  await cell('SDK-D4-PP-AMOUNT-NUMERIC', async (L) => {
    // the recorded sandbox envelopes carry transaction_approved_amount as a NUMBER (fixtures/pixelpay/auth-approved.json)
    for (const [amt, cents] of [[1.5, 150], ['1.50', 150], ['1.5', 150], [1, 100], [0.07, 7], [1234.56, 123456], [0.1 + 0.2, null]]) {
      const P = A().parseLempiras(amt);
      assert.strictEqual(P, cents, `${L}: ${JSON.stringify(amt)} ⇒ ${cents} cents, integer, no float drift (got ${P})`);
    }
    for (const bad of [1.505, '1.505', '01.50', '1,50', -1, NaN, Infinity, '', ' 1.50', 4111111111111111, 1e7]) assert.strictEqual(A().parseLempiras(bad), null, `${L}: ${JSON.stringify(bad)} is refused`);
    const srv = await server(() => ({ status: 200, body: approvedBody(1.5) }));
    try {
      const out = await makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { log: { info: () => {} } })).pspAuthorize(AUTH_IN);
      assert.deepStrictEqual([out.outcome, out.amount_cents], ['approved', 150], `${L}: a NUMERIC approved amount equal to the request ⇒ approved`);
    } finally { await srv.close(); }
  });

  await cell('SDK-D4-PP-PROD-VOID-WRITER', async (L) => {
    // Codex r1 P1-1 through the REAL writers: coordinator (place, then cancel the same day) → wrapper → the production-mode impl
    const { makeHonestDb } = require('../../_honest-rtdb-model');
    const C = require('./coordinator');
    const srv = await server((r) => (r.url.endsWith('/auth') ? { status: 200, body: { success: true, data: { payment_uuid: 'P-prod-1', transaction_approved_amount: 1, response_approved: true } }   /* L 1.00 = 100 cents, a NUMBER as the sandbox sends it */ } : { status: 200, body: { success: true, data: { payment_uuid: 'P-prod-1' } } }));
    try {
      let t = 1_000_000;
      const OID = 'tb_prod_void';
      const db = makeHonestDb({ orders: { [OID]: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: 'tb_rest', customer_name: 'Ana Pérez', pay_deadline_at: t + 900000 } } }, { now: () => t });
      const cfg = cfgOf(srv.url, { mode: 'production', namespace: 'prod', merchant_email: 'Owner@Example.HN' });
      const deps = { db, clock: () => t, psp: makeAdapter(A().makePixelPayImpl(cfg, { log: { info: () => {} } })), ppNamespace: 'prod', voidEligible: () => false, cancelVoidEligible: () => true, releaseResources: async () => {}, goLive: async () => {} };
      const p = await C.placeOriginal(deps, { orderId: OID, attempt_id: 'att_prod_void_00001', token: 'T-prod', amount_cents: 100 });
      assert.strictEqual(p.outcome, 'placed', `${L}: premise — placed (got ${JSON.stringify(p)})`);
      await C.cancelSdkOrder(deps, { orderId: OID });
      const voids = srv.seen.filter((r) => r.url.endsWith('/void'));
      const ref = db.getAt(`payment_sdk/${OID}/legs/L1/pp_ref`);
      assert.strictEqual(voids.length, 1, `${L}: ONE production void reaches the wire (got ${voids.length})`);
      assert.strictEqual(voids[0].body.void_signature, crypto.createHash('sha512').update(['Owner@Example.HN', ref, SECRET].join('|')).digest('hex'), `${L}: signed over the leg's stored pp_ref`);
      assert.strictEqual(db.getAt(`payment_sdk/${OID}/legs/L1/state`), 'voided', `${L}: the hold is voided, the record not locked`);
    } finally { await srv.close(); }
  });

  await cell('SDK-D4-PP-REDACT-SCHEMA', async (L) => {
    // Codex r1 P1-2: an ALLOWLIST schema — only listed fields survive, each type / format checked; messages only from a catalogue
    const { redact } = require('./fixtures/redact-pixelpay');
    const planted = { success: true, message: `Pago de ${SENTINEL.name} con tarjeta ${SENTINEL.pan}`, data: {
      transaction_type: 'auth', transaction_approved_amount: 4111111111111111, transaction_amount: 1, response_code: '300', response_approved: true,
      response_reason: `Titular ${SENTINEL.name}`, payment_uuid: SENTINEL.token, payment_hash: 'abcdef', attemps: 4111111111111111, status: 'Sentinela Nombre',
      card_holder: SENTINEL.name, card_cvv: 777, history: { d: [{ label: SENTINEL.name }] }, extra_field: 'x' } };
    const out = redact(planted);
    const all = JSON.stringify(out);
    for (const [k, v] of Object.entries(SENTINEL)) assert.ok(!all.includes(v), `${L}: the planted ${k} never survives (${all.slice(0, 200)})`);
    assert.ok(!all.includes('4111111111111111') && !all.includes('777') && !all.includes('"300"'), `${L}: PAN / CVV / code-shaped numbers in ANY field never survive`);
    assert.strictEqual(out.message, '<message>', `${L}: a message outside the catalogue is replaced`);
    assert.strictEqual(out.data.transaction_type, 'auth', `${L}: an allowlisted enum value is kept`);
    assert.strictEqual(out.data.transaction_amount, 1, `${L}: an in-range amount is kept`);
    assert.strictEqual(out.data.payment_uuid, '<payment_uuid>', `${L}: identifiers are always placeholders`);
    const ok = redact({ success: true, message: 'Transacción anulada exitosamente', data: { transaction_type: 'void', response_code: '00', response_reason: 'Transacción completada exitosamente' } });
    assert.deepStrictEqual([ok.message, ok.data.response_code, ok.data.response_reason], ['Transacción anulada exitosamente', '00', 'Transacción completada exitosamente'], `${L}: catalogue messages and a 2-digit code are kept`);
  });

  // RED until the sandbox evidence exists (STOP 11-11: Cloudflare challenged the sandbox transaction API) — never satisfied by
  // a hand-written fixture
  await cell('SDK-D4-PP-FIXTURES', async (L) => {
    const dir = path.join(__dirname, 'fixtures', 'pixelpay');
    const need = ['auth-approved', 'auth-declined', 'auth-challenge', 'capture', 'void', 'status-authorized', 'status-captured', 'status-voided'];
    const have = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
    const missing = need.filter((n) => !have.includes(n));
    assert.deepStrictEqual(missing, [], `${L}: recorded, redacted sandbox evidence is required for the mapping (missing: ${missing.join(', ')})`);
    // every recorded envelope replayed through the REAL impl (the loopback server answers with the fixture's status + body)
    const F = (n) => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
    const replay = async (n, fn) => { const fx = F(n); const srv = await server(() => ({ status: fx.http_status, body: fx.response })); try { return await fn(makeAdapter(A().makePixelPayImpl(cfgOf(srv.url), { log: { info: () => {} } }))); } finally { await srv.close(); } };
    const U = '<payment_uuid>';   // the redacted uuid placeholder stands in for the provider's uuid
    const a1 = await replay('auth-approved', (a) => a.pspAuthorize({ ...AUTH_IN, amount_cents: 100 }));
    assert.deepStrictEqual([a1.outcome, a1.amount_cents], ['approved', 100], `${L}: auth-approved ⇒ approved (L 1.00 as a NUMBER)`);
    assert.deepStrictEqual(await replay('auth-declined', (a) => a.pspAuthorize({ ...AUTH_IN, amount_cents: 200 })), { outcome: 'definitive_decline', uuid: undefined, amount_cents: undefined, code: '05' }, `${L}: auth-declined ⇒ definitive_decline, code 05`);
    const ch = await replay('auth-challenge', (a) => a.pspAuthorize({ ...AUTH_IN, amount_cents: 100 }));
    assert.deepStrictEqual([ch.outcome, ch.uuid], ['requires_action', U], `${L}: auth-challenge (the server token path) ⇒ requires_action, with its uuid`);
    assert.strictEqual((await replay('capture', (a) => a.pspCapture({ uuid: U, amount_cents: 100, op_id: 'o' }))).outcome, 'captured', `${L}: capture ⇒ captured`);
    assert.strictEqual((await replay('capture-over-auth', (a) => a.pspCapture({ uuid: U, amount_cents: 200, op_id: 'o' }))).outcome, 'declined', `${L}: capture over the authorized amount ⇒ declined`);
    assert.strictEqual((await replay('void', (a) => a.pspVoid({ uuid: U, op_id: 'o', ref: AUTH_IN.ref }))).outcome, 'voided', `${L}: void ⇒ voided`);
    assert.strictEqual((await replay('status-authorized', (a) => a.pspStatus({ uuid: U }))).state, 'authorized', `${L}: status-authorized ⇒ authorized`);
    assert.strictEqual((await replay('status-captured', (a) => a.pspStatus({ uuid: U }))).state, 'captured', `${L}: status «paid» ⇒ captured`);
    assert.strictEqual((await replay('status-voided', (a) => a.pspStatus({ uuid: U }))).state, 'inconclusive', `${L}: the 412 after a void ⇒ inconclusive (never void evidence)`);
    assert.strictEqual((await replay('auth-duplicate-ref', (a) => a.pspAuthorize({ ...AUTH_IN, amount_cents: 100 }))).outcome, 'approved', `${L}: PixelPay ACCEPTS a duplicate reference (we never rely on its dedupe)`);
    // the owner's status re-run: «not found» is 412 everywhere — never evidence of anything
    for (const n of ['status-unknown-uuid', 'status-challenged-uuid']) assert.strictEqual((await replay(n, (a) => a.pspStatus({ uuid: U }))).state, 'inconclusive', `${L}: ${n} (412) ⇒ inconclusive`);
    for (const n of ['status-by-order-id', 'status-challenged-by-order-id']) assert.strictEqual(F(n).http_status, 412, `${L}: ${n} — status BY order_id does not work (412 even for a fresh approval): lost-auth recovery stays manual`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\npixelpay-adapter: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
