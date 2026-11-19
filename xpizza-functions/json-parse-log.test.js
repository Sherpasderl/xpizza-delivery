'use strict';
// fix/privacy-gaps-5f (Codex #133 r1 HIGH 3; rule 20) — a malformed JSON body must never reach Cloud Logging. The JSON parser's error
// message QUOTES the body it failed on (V8: `Unexpected token … "{"phone":"5049…" is not valid JSON`), so the createOrder and
// chargeOnlineOrder parse-error middlewares log a fixed code, never err.message. Real writers: the installed express.json() parser
// produces the error from a malformed body carrying synthetic PII; each middleware is the REAL one, sliced from index.js (its source
// text, evaluated alone — index.js is not loaded). No socket: the parser reads an in-memory request stream. Run: node json-parse-log.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const express = require('express');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function middleware(app) {
  const head = `${app}.use((err, req, res, next) => {`;
  const i = SRC.indexOf(head); assert.ok(i >= 0 && SRC.indexOf(head, i + 1) < 0, `premise: exactly one ${app} error middleware`);
  let j = i + `${app}.use(`.length; let d = 1;
  while (d) { const c = SRC[j]; if (c === '(') d += 1; else if (c === ')') d -= 1; j += 1; }
  return new Function(`return (${SRC.slice(i + `${app}.use(`.length, j - 1)});`)();   // eslint-disable-line no-new-func
}
// each body is malformed RIGHT AT the personal value, so the real parser's message quotes it (the premise below proves the leak)
const BODIES = [
  ['phone', '{"customer_phone":x50499998888}', '504999988'],
  ['email', '{"email":x"ana.lopez@example.hn"}', 'ana.lope'],
  ['name', '{"customer_name":xAna Lopez Mejia}', 'Ana Lopez'],
];
// the real parser's error for that body
function parseError(body) {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { method: 'POST', url: '/', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } });
    express.json()(req, {}, (err) => resolve({ err, req }));
  });
}
async function run(app, [what, body, pii]) {
  const { err, req } = await parseError(body);
  assert.ok(err && err.type === 'entity.parse.failed', 'premise: the real parser rejects the body');
  assert.ok(String(err.message).includes(pii), `premise (the leak): the parser's own message quotes the ${what} (${err.message})`);
  const logs = []; const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(keep)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  const res = { code: null, payload: null, status(c) { this.code = c; return this; }, json(p) { this.payload = p; return this; } };
  let passed = false;
  try { middleware(app)(err, req, res, () => { passed = true; }); } finally { Object.assign(console, keep); }
  assert.ok(!passed && res.code === 400 && res.payload && res.payload.detail === 'Malformed JSON in request body', `${app}: still answers 400 Malformed JSON`);
  assert.ok(logs.length >= 1, `${app}: non-vacuity — the parse failure is still logged`);
  const all = logs.join('\n');
  assert.ok(!all.includes(pii) && !all.includes(err.message), `🔴 PARSE-LOG: ${app} logs the malformed body's ${what}: ${all}`);
  assert.ok(!/\d{4,}/.test(all) && !/@/.test(all), `🔴 PARSE-LOG: ${app} logs a digit run or an address: ${all}`);
  return all;
}
(async () => {
  for (const app of ['createOrderApp', 'chargeOnlineApp']) for (const b of BODIES) await run(app, b);
  ok('createOrder and chargeOnlineOrder: a malformed body with a phone / email / name is answered 400 and logged as a fixed code — no body text');
  // a non-parse error still falls through to next (unchanged behaviour)
  for (const app of ['createOrderApp', 'chargeOnlineApp']) {
    let got = null; middleware(app)(new Error('other'), {}, {}, (e) => { got = e; });
    assert.strictEqual(got && got.message, 'other', `${app}: a non-parse error still goes to next(err)`);
  }
  ok('a non-parse error still falls through to next(err)');
  console.log(`json-parse-log: OK (${n})`);
})().catch((e) => { process.stderr.write(`json-parse-log: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
