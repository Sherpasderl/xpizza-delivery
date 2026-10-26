'use strict';
// ORCHESTRATION O1b T7 (PLAN-orch-o1b r3, Codex r2 P2) — the ONE per-brand `projection_stale` alert: upserted on a publish failure
// (LAST reason / at, first_at kept, count), cleared by ANY successful publish — publishBrandProjection on ok / superseded, and the
// admin CLI `publish --apply` on its published AND its unchanged (no-op) path. A dry run or a refused plan never clears.
// Run: node brands/projection-alert.test.js
const assert = require('assert');
const { fakeRtdb } = require('../test/_fake-rtdb');
const B = require('./brand-store');
const { runBrandsAdmin } = require('./brands-admin-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('projection-alert: FAILED — exited without completing'); process.exitCode = 1; } });

const branch = (over = {}) => ({ name: 'Third', hub_lat: 15.5, hub_lng: -88, phone: '+50431234567', whatsapp_instance: 'i', whatsapp_enabled: true, delivery_radius_km: 7,
  hours: { mon: { open: false } }, active: true, version: 1, brand_id: 'tb_brand', location_name: 'Centro', zone: { type: 'circle', radius_km: 7 }, prep_default_min: 25, ...over });
const TB = { name: 'Third', active: true, locations: { tb_centro: 'member' }, activation: { state: 'on', since: 2 } };
const seed = () => ({ restaurants: { tb_centro: { identity: branch() } }, brands: { tb_brand: TB } });
const A = 'projection_stale_tb_brand';
const alert = (db) => (db.data.dispatcher_alerts || {})[A] || null;
const cli = async (db, apply) => { const lines = []; const code = await runBrandsAdmin({ rtdb: db, op: 'publish', id: 'tb_brand', apply, nowMs: 5000, log: (l) => lines.push(l) }); return { code, out: lines.join('\n') }; };

(async () => {
  // ── upsert: ONE record per brand; last reason / at; first_at kept; count ──
  {
    const db = fakeRtdb(seed());
    await B.raiseProjectionStale(db, 'tb_brand', { rid: 'tb_centro', reason: 'timeout', at: 100 });
    assert.deepStrictEqual(alert(db), { type: 'projection_stale', brand_id: 'tb_brand', rid: 'tb_centro', reason: 'timeout', first_at: 100, at: 100, count: 1 }, 'ALERT-FRESH');
    await B.raiseProjectionStale(db, 'tb_brand', { rid: 'tb_centro', reason: 'refused', at: 200 });
    assert.deepStrictEqual(alert(db), { type: 'projection_stale', brand_id: 'tb_brand', rid: 'tb_centro', reason: 'refused', first_at: 100, at: 200, count: 2 }, 'ALERT-UPSERT one record, last reason / at, count 2');
    ok('raiseProjectionStale: one record per brand — fresh, then last reason / at with first_at kept and count + 1');
  }
  // ── any successful publish clears; a failure after a clear creates a FRESH record ──
  {
    const db = fakeRtdb(seed());
    await B.raiseProjectionStale(db, 'tb_brand', { rid: 'tb_centro', reason: 'timeout', at: 100 });
    const r = await B.publishBrandProjection(db, 'tb_brand', { now: 300 });
    assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.strictEqual(alert(db), null, 'CLEAR-ON-PUBLISH');
    await B.raiseProjectionStale(db, 'tb_brand', { rid: 'tb_centro', reason: 'exception', at: 400 });
    assert.deepStrictEqual(alert(db), { type: 'projection_stale', brand_id: 'tb_brand', rid: 'tb_centro', reason: 'exception', first_at: 400, at: 400, count: 1 }, 'ALERT-FRESH-AFTER-CLEAR');
    // superseded (a newer source already published) also clears — and the unchanged second publish is a success too
    const r2 = await B.publishBrandProjection(db, 'tb_brand', { now: 500 });
    assert.ok(r2.ok, JSON.stringify(r2)); assert.strictEqual(alert(db), null, 'CLEAR-ON-SUPERSEDED / UNCHANGED');
    ok('publishBrandProjection clears the alert on success (incl. superseded / unchanged); a later failure creates a fresh record');
  }
  // ── the CLI: published and NO-OP paths clear; dry run and refusal never ──
  {
    const db = fakeRtdb(seed());
    assert.strictEqual((await cli(db, true)).code, 0);   // first publish
    await B.raiseProjectionStale(db, 'tb_brand', { rid: 'tb_centro', reason: 'timeout', at: 600 });   // timeout → late success → re-raise
    const dry = await cli(db, false);
    assert.strictEqual(dry.code, 0); assert.ok(alert(db), 'CLI-DRY-KEEPS');
    const noop = await cli(db, true);
    assert.strictEqual(noop.code, 0, noop.out); assert.match(noop.out, /unchanged — nothing written; projection_stale alert cleared/); assert.strictEqual(alert(db), null, 'CLI-NOOP-CLEARS');
    const quiet = await cli(db, true); assert.doesNotMatch(quiet.out, /alert cleared/, 'no alert → nothing said, nothing written');
    const bad = fakeRtdb({ ...seed(), restaurants: { tb_centro: { identity: branch({ zone: 'x' }) } } });
    await B.raiseProjectionStale(bad, 'tb_brand', { rid: 'tb_centro', reason: 'refused', at: 1 });
    assert.strictEqual((await cli(bad, true)).code, 1); assert.ok(alert(bad), 'CLI-REFUSED-KEEPS');
    ok('CLI publish --apply clears on the no-op path (the documented recovery); a dry run and a refused plan keep the alert');
  }
  // ── Codex build r1 #2: an OLDER publisher never erases a NEWER alert (the exact interleaving) ──
  {
    const newer = { type: 'projection_stale', brand_id: 'tb_brand', rid: 'tb_centro', reason: 'refused', first_at: 700, at: 700, count: 1 };
    // (a) no alert when A starts; B's failed publish raises one WHILE A publishes; A completes → B's alert stays
    let db = fakeRtdb(seed());
    db.beforeTxn = () => { db.data.dispatcher_alerts = { [A]: newer }; };   // fires at A's projection write — after A read the identities
    let r = await B.publishBrandProjection(db, 'tb_brand', { now: 800 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(alert(db), newer, 'CLEAR-CONDITIONAL-NEW a newer alert raised during the publish survives');
    // (b) an alert existed when A started and is RE-RAISED during A's publish → kept (A covered only the older one)
    db = fakeRtdb(seed());
    await B.raiseProjectionStale(db, 'tb_brand', { rid: 'tb_centro', reason: 'timeout', at: 600 });
    db.beforeTxn = () => { db.data.dispatcher_alerts[A] = { ...db.data.dispatcher_alerts[A], reason: 'refused', at: 700, count: 2 }; };
    r = await B.publishBrandProjection(db, 'tb_brand', { now: 800 });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([alert(db).count, alert(db).reason], [2, 'refused'], 'CLEAR-CONDITIONAL-RERAISED a re-raised alert survives');
    // (c) the same through the CLI publish
    db = fakeRtdb(seed());
    db.beforeTxn = () => { db.data.dispatcher_alerts = { [A]: newer }; };
    const c = await cli(db, true);
    assert.strictEqual(c.code, 0, c.out); assert.deepStrictEqual(alert(db), newer, 'CLEAR-CONDITIONAL-CLI');
    ok('an older publisher never erases a newer alert: raised or re-raised during its publish → kept (portal path and CLI)');
  }

  FINISHED = true;
  console.log(`\nprojection-alert: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
