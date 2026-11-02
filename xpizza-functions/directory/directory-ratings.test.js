'use strict';
// S-B step 4 (advisor ruling 2026-11-02 — DIRECTORY only, 'directory-1' → 'directory-2', capp-only) — the per-store `ratings` entry field.
//   1. ratingsOf: public_stats/{rid} re-allowlisted field by field (counts only; dish_stats / unknown / below-threshold never surface);
//   2. buildDirectory: the field per listed store; a stats read FAILURE ⇒ ratings null + degraded 'ratings', NEVER partial (an aggregate
//      outage drops the badge, it never de-validates the directory / its ETag); the version is 'directory-2';
//   3. OLD CLIENTS IGNORE IT (the ruling's condition): the CURRENT capp adapters — capp-directory.js, capp-eligibility.js,
//      capp-shell.js configFor and capp-home.js storeOf, loaded from the capp's APPROVED tip blob (CAPP_TIP) — produce IDENTICAL output
//      for the directory-1 body and the directory-2 body (+ ratings).
// Run: node directory/directory-ratings.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const D = require('./directory');

const CAPP_TIP = '12e38394';   // the capp's approved tip (native shell D-4a); capp-shell / capp-directory are byte-identical at 32d31ff2
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 directory-ratings: FAILED — exited without completing\n'); process.exitCode = 1; } });

(async () => {
  // ── 1. ratingsOf ──
  {
    assert.deepStrictEqual(D.ratingsOf({ v: 1, rating_avg: 4.7, rating_count: 12, rating_count_30d: 3, pct_liked: 91, repeatCustomers: 30, new_until: 5, first_served_at: 1,
      dish_stats: { d1: { up: 30, down: 1, votes: 31 } }, forged: 'x' }), { rating_avg: 4.7, rating_count: 12, pct_liked: 91, repeat_customers: 30, new_until: 5 });
    for (const [why, doc] of [['nothing', null], ['empty', {}], ['below the rating threshold', { rating_avg: 5, rating_count: 9 }], ['an out-of-range avg', { rating_avg: 7, rating_count: 20 }],
      ['repeat below 25', { repeatCustomers: 24 }], ['a bad pct', { pct_liked: 140 }], ['only dish_stats', { dish_stats: { d: {} } }]])
      assert.strictEqual(D.ratingsOf(doc), null, `🔴 ${why} ⇒ null`);
  }
  ok('ratingsOf: the published counts re-allowlisted (rating_avg + rating_count ≥ 10, pct_liked, repeat_customers ≥ 25, new_until); dish_stats / first_served_at / rating_count_30d / unknown / out-of-range never surface');

  // ── 2. buildDirectory ──
  const identity = { display_name: 'Pizzería', location_name: 'Centro', address_line: 'Calle 1', hub_lat: 15.5, hub_lng: -88 };
  const deps = (readStats) => ({ readRegistry: async () => ({ ok: true, ids: ['x_pizza', 'la_musa'] }), readPlatform: async () => null,
    activity: async () => ({ active: true, source: 'fresh', identity }), loadSchedule: async () => ({ valid: false, source: 'fresh' }),
    readPresentation: async () => ({}), pricingView: async () => ({ fee: { state: 'none' }, promo: null, coverage_km: 5 }), ...(readStats ? { readStats } : {}) });
  const STATS = { x_pizza: { v: 1, rating_avg: 4.6, rating_count: 15, pct_liked: 88 }, la_musa: { v: 1, new_until: 99 } };
  const r = await D.buildDirectory(deps(async (rid) => STATS[rid]));
  assert.strictEqual(r.body.representation_version, 'directory-2');
  assert.deepStrictEqual(r.body.restaurants.map((e) => e.ratings), [{ rating_avg: 4.6, rating_count: 15, pct_liked: 88 }, { new_until: 99 }]);
  assert.ok(r.body.restaurants.every((e) => Object.keys(e).join() === D.ENTRY_FIELDS.join()), 'ONE schema: every allowlisted key, in order');
  const f = await D.buildDirectory(deps(async (rid) => { if (rid === 'la_musa') throw new Error('stats down'); return STATS[rid]; }));
  assert.strictEqual(f.body.complete, true, '🔴 a stats outage NEVER makes the directory partial');
  assert.strictEqual(f.body.restaurants[1].ratings, null); assert.ok(f.body.restaurants[1].degraded.includes('ratings'), 'degraded, named');
  assert.ok(!f.body.restaurants[0].degraded.includes('ratings'));
  ok('buildDirectory: per-store ratings from public_stats; a stats read failure ⇒ ratings null + degraded "ratings", the body stays COMPLETE; directory-2; one schema');

  // ── 3. OLD CLIENTS IGNORE IT — the approved capp adapters, from their blob ──
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capp-tip-'));
    for (const f2 of ['capp-directory.js', 'capp-eligibility.js', 'capp-shell.js', 'capp-home.js', 'capp-schedule.js'])
      fs.writeFileSync(path.join(dir, f2), execFileSync('git', ['show', `${CAPP_TIP}:customer-app/${f2}`], { cwd: __dirname, encoding: 'utf8' }));
    const CD = require(path.join(dir, 'capp-directory.js')), CE = require(path.join(dir, 'capp-eligibility.js')), CS = require(path.join(dir, 'capp-shell.js')), CH = require(path.join(dir, 'capp-home.js'));
    const newBody = r.body;
    const oldBody = { ...newBody, representation_version: 'directory-1', restaurants: newBody.restaurants.map((e) => { const { ratings, ...rest } = e; return rest; }) };
    assert.ok(!('ratings' in oldBody.restaurants[0]) && 'ratings' in newBody.restaurants[0], 'premise: the two envelopes differ exactly by the field + the version');
    const run = async (body) => {
      const store = new Map(); const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
      const elig = CE.createEligibility({ now: () => 1000 });
      const d = CD.createDirectory({ now: () => 1000, storage, eligibility: elig, fetchDirectory: async () => ({ status: 200, body, etag: '"e"' }) });
      d.boot(); const v = await d.revalidate();
      const rt = { endpoints: { x: 1 }, intakeKey: 'k' };
      return { phase: v.phase, partial: v.partial, verified: v.verified, platform: v.platform, presentation: v.presentation,
        rows: v.rows.map((row) => { const cfg = CS.configFor(row.entry, rt); const s = CH.storeOf({ rid: row.rid, entry: row.entry, cfg, gone: row.gone }); return { rid: row.rid, gone: row.gone, state: d.state(row.rid), cfg, store: JSON.parse(JSON.stringify(s)) }; }) };
    };
    const a = await run(oldBody), b = await run(newBody);
    assert.strictEqual(a.rows.length, 2, 'premise: both stores listed');
    assert.deepStrictEqual(b, a, '🔴 the approved capp adapters produce IDENTICAL output for directory-1 and directory-2 (+ ratings)');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ok(`old clients ignore it: the APPROVED capp adapters (${CAPP_TIP} — capp-directory / capp-eligibility / capp-shell configFor / capp-home storeOf) produce IDENTICAL output for the directory-1 and directory-2 envelopes`);

  FINISHED = true;
  console.log(`directory-ratings: OK (${n})`);
})().catch((e) => { process.stderr.write(`directory-ratings: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
