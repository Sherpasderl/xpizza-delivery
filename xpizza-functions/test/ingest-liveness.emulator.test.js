'use strict';
/**
 * OWNER-RUN emulator test — ingestDriverLocation LIVENESS RECEIPT (Driver Tracking · BRIEF E · Surface 1).
 *
 *   firebase emulators:exec --only database --project demo-xpizza \
 *     "node test/ingest-liveness.emulator.test.js"
 *
 * Encodes the brief's live-verify acceptance offline: a stale-ts POST from an on-shift driver (every point
 * dropped by the freshness filters → accepted:0) must ADVANCE last_ping and leave last_location_ts / lat /
 * lng / status UNCHANGED. Plus: the receipt sits BELOW the full auth chain — off-shift → 403 and a bad token
 * → 401, neither writing last_ping (forge-proof, can't be spammed past the gate).
 *
 * ingestDriverLocation is a bare onRequest handler; POST via an ephemeral server behind express.json()
 * (onRequest handlers invoked directly don't auto-parse the body).
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const { hashToken } = require('../driver-ingest');
const db = getDatabase();

function post(handler, { token, body }) {
  return new Promise((resolve, reject) => {
    const wrapped = express(); wrapped.use(express.json()); wrapped.use(handler);
    const server = http.createServer(wrapped).listen(0, async () => {
      try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token != null ? { 'x-driver-token': token } : {}) },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        server.close(() => resolve({ status: res.status, json, text }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}

const UID = 'driverE', SHIFT = 'shift-1', RAW = 'raw-token-abc-123';
const driver = async () => (await db.ref(`drivers/${UID}`).once('value')).val();
async function seed({ lastLocationTs }) {
  await db.ref('/').set(null);
  const now = Date.now();
  await db.ref(`driver_tokens/${hashToken(RAW)}`).set({
    uid: UID, shift_id: SHIFT, device_id: 'dev1', issued_at: now - 1000, expires_at: now + 3600_000, revoked_at: null,
  });
  await db.ref(`drivers/${UID}`).set({
    active: true, status: 'available', current_shift_id: SHIFT,
    last_location_ts: lastLocationTs, last_ping: now - 600_000, lat: 15.5, lng: -88.0, name: 'Test E',
  });
}

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // ── 1. stale-ts POST (on-shift) → accepted:0 + last_ping ADVANCED + last_location_ts/lat/lng/status UNCHANGED ──
  {
    const lastLocTs = Date.now() - 120_000;   // last fix 2 min ago
    await seed({ lastLocationTs: lastLocTs });
    const before = await driver();
    // verbatim heartbeat re-post: ts == last_location_ts → dropped by the `p.ts <= lastLocationTs` filter
    const r = await post(app.ingestDriverLocation, { token: RAW, body: { locations: [{ ts: lastLocTs, lat: 15.5, lng: -88.0 }] } });
    assert.strictEqual(r.status, 200, `expected 200 (got ${r.status}: ${r.text})`);
    assert.strictEqual(r.json.accepted, 0, 'accepted:0');
    assert.strictEqual(r.json.liveness, true, 'liveness:true');
    const after = await driver();
    assert.ok(after.last_ping > before.last_ping, `last_ping ADVANCED (${before.last_ping} → ${after.last_ping})`);
    assert.strictEqual(after.last_location_ts, before.last_location_ts, 'last_location_ts UNCHANGED (position age honest)');
    assert.strictEqual(after.lat, before.lat, 'lat unchanged');
    assert.strictEqual(after.lng, before.lng, 'lng unchanged');
    assert.strictEqual(after.status, before.status, 'status unchanged');
    ok('stale-ts POST (on-shift) → accepted:0, liveness:true, last_ping ADVANCED, last_location_ts/lat/lng/status UNCHANGED');
  }

  // ── 2. off-shift → 403, NO liveness write (auth gate sits ABOVE the branch) ──
  {
    const lastLocTs = Date.now() - 120_000;
    await seed({ lastLocationTs: lastLocTs });
    await db.ref(`drivers/${UID}/status`).set('off_shift');
    const before = await driver();
    const r = await post(app.ingestDriverLocation, { token: RAW, body: { locations: [{ ts: lastLocTs, lat: 15.5, lng: -88.0 }] } });
    assert.strictEqual(r.status, 403, `off-shift → 403 (got ${r.status}: ${r.text})`);
    assert.strictEqual((await driver()).last_ping, before.last_ping, 'off-shift → last_ping NOT advanced');
    ok('off-shift driver → 403, no liveness write (receipt sits below the active/off_shift gate)');
  }

  // ── 3. invalid token → 401, NO write (forge-proof) ──
  {
    const lastLocTs = Date.now() - 120_000;
    await seed({ lastLocationTs: lastLocTs });
    const before = await driver();
    const r = await post(app.ingestDriverLocation, { token: 'bogus-token', body: { locations: [{ ts: lastLocTs }] } });
    assert.strictEqual(r.status, 401, `bad token → 401 (got ${r.status}: ${r.text})`);
    assert.strictEqual((await driver()).last_ping, before.last_ping, 'bad token → no liveness write');
    ok('invalid token → 401, no liveness write (forge-proof — below the token→uid gate)');
  }

  console.log(`\nAll ${pass} ingest-liveness emulator assertions passed.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
