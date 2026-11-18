'use strict';
// offer-audience BUILD T10 (PLAN-5f-offer-audience r4.1 §5, r2 §2 backfill, rule 23 dry-run first) — the OWNER's marker backfill: every
// delivered / completed order (paged by key, ≤ pageSize per read) marks its brand with the codes of its identity (the frozen codes, a card
// guest's verified phone, else the member's CURRENT verified identity) at the order's OWN fulfilment month — never «now», never below the
// 24-month cutoff. Set-only + monotonic (the writer's own mark) ⇒ re-runs are no-ops and it commutes with the live writer. Counts only.
// Orders by the REAL chain (test/_audience-seed.js); the CLI driven into its require-project refusals (no data I/O).
// Run: node tools/audience-backfill.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('../test/_audience-seed');
const { HOUR, T0, quiet, profile, aworld, placeOrder, status, codes, KEY } = S;
const OTP = require('../otp-lib');
const ABF = require('./audience-backfill-core');
const OW = require('../marketing/offer-wire');
const BO = require('../marketing/brand-of');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { OW._resetCaches(); BO._reset(); try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ audience-backfill: exited without completing\n'); process.exitCode = 1; } });
const P2 = '+504 9999-1111', P3 = '+504 7777-2222';
// a LEGACY fulfilled order: placed by the real chain, its codes gone (pre-audience orders never had them), delivered with no writer
// (the writer was not deployed then) — exactly what the backfill exists for
async function legacy(w, uid, deliveredAt, { guestPhone = null } = {}) {
  const o = await placeOrder(w, uid, { guestPhone });
  await w.db.ref().update({ [`orders/${o}/audience_ids`]: null, [`orders/${o}/status`]: 'delivered', [`orders/${o}/delivered_at`]: deliveredAt });
  for (const k of Object.keys(w.fake.get('audience_ids_by_day') || {})) if (k.endsWith(`_${o}`)) w.fake.put(`audience_ids_by_day/${k}`, null);
  return o;
}
const hm = (y, mo) => Date.UTC(y, mo - 1, 10, 18);

(async () => {
  await cell('BF-DRY: a dry run counts and writes NOTHING', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    await legacy(w, 'u1', hm(2026, 3));
    const before = JSON.stringify(w.fake.get(''));
    const r = await ABF.runBackfill(w.db, { key: KEY, nowMs: T0, apply: false, log: quiet });
    assert.strictEqual(JSON.stringify(w.fake.get('')), before, `🔴 ${L}: nothing written`);
    assert.deepStrictEqual([r.fulfilled, r.marked], [1, 1], `${L}: counts (${JSON.stringify(r)})`);
  });
  await cell('BF-APPLY: members (current profile) + card guests (verified phone) marked at the order\'s OWN month; open / cancelled skipped', async (L) => {
    const w = await aworld(); profile(w, 'u1'); profile(w, 'u2', P2);
    await legacy(w, 'u1', hm(2026, 3)); await legacy(w, null, hm(2026, 5), { guestPhone: P3 }); await legacy(w, 'u2', hm(2025, 8));
    const open = await placeOrder(w, 'u1'); const cancelled = await placeOrder(w, 'u2'); await w.db.ref(`orders/${cancelled}/status`).set('cancelled');
    const r = await ABF.runBackfill(w.db, { key: KEY, nowMs: T0, apply: true, log: quiet });
    assert.deepStrictEqual([w.fake.get(`customer_seen/tb/${codes('x').p}`), w.fake.get(`customer_seen/tb/${codes('x', P3).p}`), w.fake.get(`customer_seen/tb/${codes('x', P2).p}`)],
      [{ m: '2026-03' }, { m: '2026-05' }, { m: '2025-08' }], `🔴 ${L}: each at its own fulfilment month (never «now» = 2026-11)`);
    assert.ok(w.fake.get(`customer_seen_m/tb/2026-03_${codes('x').p}`), `${L}: the month index (expiry) is written too`);
    assert.deepStrictEqual([r.fulfilled, r.marked], [3, 3], `${L}: counts (${JSON.stringify(r)})`);
    void open;
  });
  await cell('BF-WINDOW: an order fulfilled before the 24-month cutoff is NEVER marked (never creates an already-expired marker)', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    await legacy(w, 'u1', hm(2024, 10));   // cutoff at Nov 2026 = 2024-11
    const r = await ABF.runBackfill(w.db, { key: KEY, nowMs: T0, apply: true, log: quiet });
    assert.deepStrictEqual([w.fake.get('customer_seen'), r.skipped.pre_cutoff], [null, 1], `🔴 ${L}`);
  });
  await cell('BF-IDEMPOTENT: a re-run renews nothing and commutes with the live writer (a newer live mark is never moved back)', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    await legacy(w, 'u1', hm(2026, 3));
    const live = await placeOrder(w, 'u1'); await status(w, live, 'delivered', T0 + HOUR);   // the live writer: 2026-11
    await ABF.runBackfill(w.db, { key: KEY, nowMs: T0 + 2 * HOUR, apply: true, log: quiet });
    const snap = JSON.stringify([w.fake.get('customer_seen'), w.fake.get('customer_seen_m')]);
    await ABF.runBackfill(w.db, { key: KEY, nowMs: T0 + 3 * HOUR, apply: true, log: quiet });
    assert.strictEqual(JSON.stringify([w.fake.get('customer_seen'), w.fake.get('customer_seen_m')]), snap, `🔴 ${L}: a re-run is a no-op`);
    assert.deepStrictEqual([w.fake.get(`customer_seen/tb/${codes().p}`), w.fake.get(`customer_seen_m/tb/2026-03_${codes().p}`)], [{ m: '2026-11' }, null], `🔴 ${L}: the live mark stays; no stale index entry`);
  });
  await cell('BF-PAGES: orders are read in pages of ≤ pageSize by key; every page is scanned', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    for (let i = 0; i < 5; i += 1) await legacy(w, 'u1', hm(2026, 3));
    const reads = []; const db = { ref: (p) => { const r = w.db.ref(p); if (p !== 'orders') return r; return { ...r, orderByKey: () => { const q = r.orderByKey(); const wrap = (x) => ({ ...x, startAfter: (k) => wrap(x.startAfter(k)), limitToFirst: (nn) => { reads.push(nn); return wrap(x.limitToFirst(nn)); } }); return wrap(q); } }; } };
    const r = await ABF.runBackfill(db, { key: KEY, nowMs: T0, apply: false, pageSize: 2, log: quiet });
    assert.strictEqual(r.fulfilled, 5, `🔴 ${L}: all 5 seen (${JSON.stringify(r)})`);
    assert.ok(reads.length >= 3 && reads.every((x) => x === 2), `🔴 ${L}: bounded pages (${reads})`);
  });
  await cell('BF-NOKEY: no key / a short key ⇒ refused before any read', async (L) => {
    const w = await aworld();
    for (const key of ['', 'short', undefined]) await assert.rejects(ABF.runBackfill(w.db, { key, nowMs: T0, apply: true, log: quiet }), /AUDIENCE_KEY_V1/, `${L}: ${key}`);
  });
  await cell('BF-NOPII: the output is names / counts only', async (L) => {
    const w = await aworld(); profile(w, 'u1'); await legacy(w, 'u1', hm(2026, 3));
    const lines = []; const log = { warn: (...a) => lines.push(a.join(' ')), log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    await ABF.runBackfill(w.db, { key: KEY, nowMs: T0, apply: true, log });
    const all = lines.join('\n'); assert.ok(lines.length >= 1, 'premise');
    for (const bad of ['u1', '8888', OTP.phoneHash(S.PHONE), codes().p, KEY]) assert.ok(!all.includes(bad), `🔴 ${L}: ${bad}`);
  });
  await cell('BF-CLI: the CLI refuses (dry run or --apply) without a stated --project — nothing read', async (L) => {
    const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/creds.json', AUDIENCE_KEY_V1: KEY };
    delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.NODE_OPTIONS;
    const cli = path.join(__dirname, 'audience-backfill.js');
    const r = spawnSync(process.execPath, [cli], { env, encoding: 'utf8', timeout: 20000 });
    assert.notStrictEqual(r.status, 0, `${L}: refuses without --project`);
    assert.ok(!/audience-backfill (APPLY|DRY RUN)/.test(r.stdout), `${L}: reads nothing`);
    const expected = require('./require-project').expectedProject();
    for (const v of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
      const r2 = spawnSync(process.execPath, [cli, '--apply'], { env: { ...env, [v]: expected }, encoding: 'utf8', timeout: 20000 });
      assert.notStrictEqual(r2.status, 0, `${L}: ${v} without --project is refused`);
      assert.match(r2.stderr, /explicit flag/, L);
    }
  });
  FINISHED = true;
  if (fails.length) { console.log(`audience-backfill: ${fails.length} FAILED`); process.exit(1); }
  console.log(`audience-backfill: OK (${n})`);
})();
