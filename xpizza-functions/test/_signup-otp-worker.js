'use strict';
// signup phase 1 — the verifyOtp / requestOtp DIFFERENTIAL worker (driven by signup-http.emulator.test.js, one process per run).
//   node test/_signup-otp-worker.js <base|current> <google:on|off>
// Loads index.js — `current` = the working tree; `base` = the slice base (tools/signup-inverse BASE), compiled IN MEMORY at
// index.js's own path so every relative require resolves to the same modules — with DETERMINISTIC dependencies (a fixed
// clock, fixed codes and uids, a recording WhatsApp, a deterministic token), runs the no-ticket scenario through the REAL
// handlers, and prints {responses, db} as JSON. Only the database is touched; the parent compares the two runs.
require('./_emulator-required')('database', 'firestore');

const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const http = require('http');

const MODE = process.argv[2]; const GOOGLE = process.argv[3] === 'google:on';
if (!['base', 'current'].includes(MODE)) { console.error('usage: _signup-otp-worker.js <base|current> <google:on|off>'); process.exit(2); }
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.OTP_SALT = 'w'.repeat(40);
for (const k of Object.keys(process.env)) if (k.startsWith('GOOGLE_OAUTH_AUDIENCES__')) delete process.env[k];
if (GOOGLE) { process.env.GOOGLE_OAUTH_AUDIENCES__X_PIZZA = 'client-x.apps.googleusercontent.com'; process.env.GOOGLE_OAUTH_AUDIENCES__LA_MUSA = 'client-l.apps.googleusercontent.com'; }

// ── deterministic dependencies ──
let CLOCK = 1_800_000_000_000;
Date.now = () => CLOCK;
let CODE = 0; crypto.randomInt = () => (CODE = (CODE + 137731) % 1000000);
let RB = 0; const realRandomBytes = crypto.randomBytes;
crypto.randomBytes = (nb, cb) => { if (nb !== 12 || cb) return realRandomBytes(nb, cb); RB += 1; return Buffer.alloc(12, RB); };   // the u_<hex> uid
const SENT = [];
{
  const p = require.resolve('../whatsapp'); const real = require(p);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, tplOtp: ({ code }) => `CODE:${code}`, isEnabledForRestaurant: async () => false, sendMessage: async (to, body) => { SENT.push(body); return { ok: true }; } } };
}
{
  const p = require.resolve('firebase-admin/auth'); const real = require(p);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, getAuth: () => ({ createCustomToken: async (uid, claims) => `tok:${uid}:${JSON.stringify(claims)}`, verifyIdToken: async () => { throw new Error('unused'); } }) } };
}

const FN = path.join(__dirname, '..');
let app;
if (MODE === 'current') app = require('../index.js');
else {
  const { BASE } = require('../tools/signup-inverse');
  const src = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: FN, encoding: 'utf8', maxBuffer: 1 << 28 });
  const file = path.join(FN, 'index.js');
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(FN);
  // BASE-PINNED twins: a module whose CURRENT exports no longer carry what the base index.js reads AT LOAD resolves to its own
  // BASE copy (compiled in place). The brand-agnostic server removed assign-hub's X_PIZZA_HUB (base index.js:5582 reads .lat).
  const PINNED = { './assign-hub': 'assign-hub.js' };
  const twins = {};
  const twin = (rel) => {
    if (twins[rel]) return twins[rel].exports;
    const f = path.join(FN, rel); const t = new Module(f, module); t.filename = f; t.paths = Module._nodeModulePaths(path.dirname(f));
    twins[rel] = t; t._compile(execFileSync('git', ['show', `${BASE}:xpizza-functions/${rel}`], { cwd: FN, encoding: 'utf8' }), f);
    return t.exports;
  };
  const real = m.require.bind(m);
  m.require = (id) => (PINNED[id] ? twin(PINNED[id]) : real(id));
  m._compile(src, file);
  app = m.exports;
}
const admin = require('firebase-admin');
const db = admin.database();

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const t = await r.text(); s.close(() => resolve({ status: r.status, body: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const lastCode = () => { const m = /CODE:(\d{6})/.exec(SENT[SENT.length - 1] || ''); return m && m[1]; };

(async () => {
  await db.ref('/').set(null);
  const out = [];
  const step = async (label, handler, body) => { const r = await post(handler, body); out.push({ label, ...r }); CLOCK += 61_000; return r; };
  // 1 a NEW customer (x_pizza): request + verify
  await step('request new', app.requestOtp, { phone: '50499990001', restaurant_id: 'x_pizza' });
  await step('verify new', app.verifyOtp, { phone: '50499990001', code: lastCode() });
  // 2 a RETURNING customer, the other brand
  await step('request returning', app.requestOtp, { phone: '50499990001', restaurant_id: 'la_musa' });
  await step('verify returning', app.verifyOtp, { phone: '50499990001', code: lastCode() });
  // 3 a wrong code, then the right one; 4 a replay of a consumed code
  await step('request 2', app.requestOtp, { phone: '50499990002', restaurant_id: 'la_musa' });
  const c2 = lastCode();
  await step('verify wrong', app.verifyOtp, { phone: '50499990002', code: c2 === '000000' ? '111111' : '000000' });
  await step('verify right', app.verifyOtp, { phone: '50499990002', code: c2 });
  await step('verify replay', app.verifyOtp, { phone: '50499990002', code: c2 });
  // 5 malformed bodies; 6 an unknown restaurant at request
  await step('verify malformed', app.verifyOtp, { phone: 'x', code: '12' });
  await step('request unknown rid', app.requestOtp, { phone: '50499990003', restaurant_id: 'nope_rid' });
  const dump = (await db.ref('/').once('value')).val();
  process.stdout.write('\n@@RESULT@@' + JSON.stringify({ responses: out, sent: SENT, db: dump }) + '\n');
  process.exit(0);
})().catch((e) => { console.error('signup-otp-worker FAILED:', e && e.stack || e); process.exit(1); });
