'use strict';
// ORCHESTRATION O1a — Codex r3 #1(d): `branches-admin check <brand>`, a READ-ONLY consistency report over one brand's lifecycle data
// (brand listing ↔ draft / identity ↔ rid / name reservations ↔ op-id mappings ↔ the lifecycle lock). Run: node branches/branch-check.test.js
const assert = require('assert');
const { checkBrand } = require('./branch-check');
const S = require('./branch-store');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = 1_800_000_000_000;
const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const input = (b, name) => ({ brand_id: b, location_name: name, phone: '+50499990000', hours: H7, prep_default_min: 20 });
const codes = (r) => r.findings.map((f) => `${f.code}${f.rid ? `:${f.rid}` : ''}`).sort();

(async () => {
  // a consistent brand: a listed first draft + a sibling draft; the check writes NOTHING
  const db = fakeRtdb({ platform_config: { service_bounds: { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 } } });
  const r1 = await S.createBrandWithDraft(db, { brandId: 'tb_k', brandName: 'K', input: input('tb_k', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
  const r2 = await S.createDraft(db, { input: input('tb_k', 'Norte'), opId: 'o2', callerUid: 'own', now: NOW });
  const w0 = db.writes.length;
  assert.deepStrictEqual(await checkBrand(db, 'tb_k'), { brand: 'tb_k', findings: [], lock: null }, 'CHECK-CLEAN a consistent brand has no findings');
  assert.strictEqual(db.writes.length, w0, 'CHECK-READONLY the check writes nothing');
  ok('a consistent brand (listed first draft + sibling draft) → no findings; read-only');

  // every class of inconsistency is reported, by rid
  const bad = fakeRtdb(JSON.parse(JSON.stringify(db.root)));
  delete bad.root.restaurants[r1.rid];                                            // listed staged rid with neither draft nor identity
  bad.root.restaurants.tb_k_x = { draft: { ...input('tb_k', 'X'), op_id: 'ox' } };   // draft without reservation / mapping
  bad.root.restaurants.tb_k_i = { identity: { brand_id: 'tb_k', location_name: 'I' } };   // identity of the brand, not listed
  bad.root.rid_reservations.tb_k_gone = { op_id: 'og', brand_id: 'tb_k' };           // reservation with no draft / identity
  bad.root.branch_op_ids.tb_k.og = { payload_hash: 'h', rid: 'tb_k_gone' };          // mapping to a rid with no draft / identity
  bad.root.brand_branch_names.tb_k.huerfana = { op_id: 'nobody' };                    // name reservation with no mapping
  const r = await checkBrand(bad, 'tb_k');
  assert.deepStrictEqual(codes(r), [`draft_without_mapping:tb_k_x`, `draft_without_reservation:tb_k_x`, `identity_not_listed:tb_k_i`, `listed_without_branch:${r1.rid}`,
    `orphan_mapping:${r1.rid}`, `orphan_mapping:tb_k_gone`, `orphan_name`, `orphan_reservation:${r1.rid}`, `orphan_reservation:tb_k_gone`].sort(), 'CHECK-FINDS every class is reported');
  ok('every class of inconsistency is reported: listed without branch, draft without reservation / mapping, identity not listed, orphan reservation / mapping / name');

  // a draft whose brand is gone; a lock is shown (its findings may be its unfinished work)
  const gone = fakeRtdb(JSON.parse(JSON.stringify(db.root)));
  delete gone.root.brands.tb_k;
  gone.root.brand_ops = { tb_k: { kind: 'delete_draft', op_id: 'd1', brand_id: 'tb_k', inputs: { rid: r2.rid }, lease: { call_id: 'd1', until: NOW - 1 }, step: 'brand_removed' } };
  const g = await checkBrand(gone, 'tb_k', { now: NOW });
  assert.ok(codes(g).includes(`draft_without_brand:${r1.rid}`) && codes(g).includes(`draft_without_brand:${r2.rid}`), 'CHECK-FINDS a draft whose brand is gone');
  assert.deepStrictEqual(g.lock, { kind: 'delete_draft', step: 'brand_removed', rid: r2.rid, interrupted: true }, 'CHECK-LOCK the lifecycle lock is shown');
  ok('a draft whose brand is gone is reported; the lifecycle lock is shown (its findings may be its unfinished work)');

  console.log(`\nbranch-check: OK (${n})`);
})().catch((e) => { console.error('branch-check FAILED:', e); process.exit(1); });
