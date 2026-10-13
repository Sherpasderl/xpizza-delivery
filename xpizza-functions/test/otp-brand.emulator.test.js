'use strict';
// D12b codex r2 — a LOGIN CODE never waits on branding, through the REAL requestOtp handler (index.js) on the emulator:
//   • D12b's live identity read is stubbed to HANG; the OTP POST still leaves promptly, with neutral copy, and the read is
//     never even called (the OTP's brand is SYNC-ONLY: only an identity already in this instance's cache);
//   • once this instance's restaurant-config cache holds the restaurant's identity (warmed by the real getIdentity), the OTP
//     is branded from it — still without any read.
// node-fetch is captured: the REAL whatsapp.sendMessage runs, and nothing leaves the process.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.OTP_SALT = process.env.OTP_SALT || 'o'.repeat(40);
process.env.ULTRAMSG_INSTANCE_ID = 'instTEST'; process.env.ULTRAMSG_TOKEN = 'tokTEST';

const posts = [];
const fetchPath = require.resolve('node-fetch');
const realFetch = require('node-fetch');
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: Object.assign(async (url, opts) => {
  if (String(url).startsWith('https://api.ultramsg.com/')) {
    posts.push({ at: Date.now(), body: new URLSearchParams(opts.body).get('body') });
    return { ok: true, status: 200, json: async () => ({ sent: 'true', id: 'MSG' }) };
  }
  return realFetch(url, opts);
}, realFetch) };
// D12b's live identity read HANGS (never resolves) and counts its calls
let liveReads = 0;
{
  const p = require.resolve('../pickup-label'); const real = require(p);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, readLiveBrand: () => { liveReads += 1; return new Promise(() => {}); } } };
}

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const { getIdentity, _cache: identityCache } = require('../restaurant-config');
const { IDENTITIES } = require('../seed_identity');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('otp-brand(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

// The stubbed identity read NEVER resolves, so a request that awaited branding would never answer at all: a slow answer
// is not the signal, NO answer is. Each POST therefore races a deadline far above any cold, loaded round-trip (a wall-clock
// "< 1 s" bound flaked on a loaded machine, on main too); the deadline only turns that hang into a clean failure.
const POST_DEADLINE_MS = 15000;
function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), POST_DEADLINE_MS);
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
        const t = await r.text();
        clearTimeout(timer);
        s.close(() => resolve({ status: r.status, text: t }));
      } catch (e) {
        clearTimeout(timer);
        s.closeAllConnections && s.closeAllConnections();
        s.close(() => reject(ac.signal.aborted ? new Error(`🔴 requestOtp did not answer within ${POST_DEADLINE_MS} ms — it is waiting on the HUNG identity read (branding)`) : e));
      }
    });
  });
}

(async () => {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing a non-emulator RTDB');
  await rtdb.ref().remove();
  const OPEN = { open: true, start: '00:00', end: '24:00' };
  const HOURS = { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN };
  await rtdb.ref('restaurants/x_pizza/identity').set({ ...IDENTITIES.x_pizza, whatsapp_instance: 'i', display_name: 'X. Pizza', hours: HOURS, active: true });
  identityCache.clear();

  // ── 1. nothing in hand + a HUNG identity read → the code is sent promptly, neutral, and no read is started ──
  const r1 = await post(app.requestOtp, { phone: '+50499990001', restaurant_id: 'x_pizza' });
  assert.strictEqual(r1.status, 200, r1.text);
  assert.strictEqual(posts.length, 1, 'the OTP was POSTed to UltraMsg');
  assert.match(posts[0].body, /^Tu código es \d{6}\. Vence en 5 minutos\. No lo compartas\.$/, `neutral copy: ${posts[0].body}`);
  assert.strictEqual(liveReads, 0, '🔴 the OTP never STARTS an identity read (a hung read cannot delay it)');
  ok('a HUNG identity read: the real requestOtp answers and POSTs the code with neutral copy, never starting a read');

  // ── 2. this instance already holds the identity (the real getIdentity warmed its cache) → branded, still no read ──
  await getIdentity(rtdb, 'x_pizza');
  const r2 = await post(app.requestOtp, { phone: '+50499990002', restaurant_id: 'x_pizza' });
  assert.strictEqual(r2.status, 200, r2.text);
  assert.strictEqual(posts.length, 2);
  assert.match(posts[1].body, /^Tu código de X\. Pizza es \d{6}\. Vence en 5 minutos\. No lo compartas\.$/, `branded from the identity in hand: ${posts[1].body}`);
  assert.strictEqual(liveReads, 0, 'still no read');
  ok('an identity already in this instance\'s cache brands the OTP ("Tu código de X. Pizza es …") — still without any read');

  // ── 3. codex r3: a STALE cache entry (older than restaurant-config's TTL — e.g. before a rename) does NOT brand it ──
  const { TTL_MS } = require('../restaurant-config');
  const e = identityCache.get('x_pizza');
  identityCache.set('x_pizza', { ...e, identity: { ...e.identity, display_name: 'Old Brand' }, fetched_at: Date.now() - TTL_MS - 1 });
  const r3 = await post(app.requestOtp, { phone: '+50499990003', restaurant_id: 'x_pizza' });
  assert.strictEqual(r3.status, 200, r3.text);
  assert.match(posts[2].body, /^Tu código es \d{6}\. Vence en 5 minutos\. No lo compartas\.$/, `a stale entry → neutral, never "Old Brand": ${posts[2].body}`);
  assert.strictEqual(liveReads, 0, 'zero reads');
  ok('a STALE cache entry (older than the TTL, here naming an old brand) → neutral copy, zero reads');

  FINISHED = true;
  console.log(`\notp-brand(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('otp-brand(emulator) FAILED:', e); process.exit(1); });
