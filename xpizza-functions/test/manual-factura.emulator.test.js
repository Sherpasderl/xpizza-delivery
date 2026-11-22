'use strict';
// MANUAL FACTURA (PLAN-manual-factura r3 §12) — on the RTDB emulator, the REAL writers, REAL concurrency:
//   MFE-CONCURRENT  the app allocator (allocateFacturaNumber: a child-seq transaction) and manual issues (a parent factura_config
//                   transaction) run AT THE SAME TIME ⇒ every número distinct, the counter equals the count, nothing lost
//   MFE-IDEMP       the same opId issued concurrently twice ⇒ ONE número
//   MFE-REUSE       the same opId with a changed payload ⇒ refused, nothing written
//   MFE-CONFIG      is_temp / expired / range exhausted ⇒ refused, nothing written
//   MFE-RENEWAL     a config renewal concurrent with issues ⇒ every issued record carries the CAI it validated against (never a mix)
//   MFE-COPY-VOID   the copy = the snapshot; void is monotonic and propagates; a re-issue of the same opId never un-voids
//   MFE-SEED        seed_factura_config (create-only) refuses an existing factura_config, byte-identical
// Run: npm run test:manual-factura
require('./_emulator-required')('database');
const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${process.env.GCLOUD_PROJECT}` });
const db = admin.database();
const MF = require('../factura/manual-core');
const { priceBreakdown } = require('../factura/money');
const { allocateFacturaNumber } = require('../factura/factura-helpers');
const { seedCreateOnly } = require('../../xpizza-factura/seed_factura_config');
let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('manual-factura(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const RID = 'x_pizza', NOW = Date.UTC(2026, 10, 23, 15, 0, 0);
const CFG = (o = {}) => ({ restaurant_name: 'X PIZZA', legal_name: 'SHERPA S. DE R.L.', rtn: '05019024114145', address_1: 'BLVD', address_2: 'SPS', email: 'a@b.hn', phone: '9999',
  cai_code: 'REAL-CAI-123', prefix: '000-001-01', range_start: 1, range_end: 8000, fecha_limite: '2027-06-30', is_temp: false, seq: { last_reserved: 41, pending: { _: 0 } }, ...o });
const PAY = (total = 11500, o = {}) => { const b = priceBreakdown(total); return { concept: '', customer_name: '', rtn: '', base_cents: b.subtotal_cents, isv_cents: b.isv_cents, total_cents: total, ...o }; };
const cfgRef = () => db.ref(`restaurants/${RID}/factura_config`);
const get = async (p) => (await db.ref(p).once('value')).val();
const reset = async (cfg = CFG()) => { await db.ref().remove(); await cfgRef().set(cfg); };
const issue = (opId, payload = PAY()) => MF.issueManual(db, { rid: RID, opId, payload, issuedBy: 'owner', now: NOW });
const appOrder = (oid) => ({ orderId: oid, items: [{ qty: 1, description: 'Pizza', line_gross_cents: 11500 }], subtotal_cents: 10000, tax_cents: 1500, total_cents: 11500, customer_name: 'T', payment_method: 'cash' });

(async () => {
  const url = db.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: ${url}`);
  {
    await reset();
    for (let i = 0; i < 6; i++) await db.ref(`orders/ORD${i}`).set({ orderId: `ORD${i}`, status: 'preparing' });
    const jobs = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(allocateFacturaNumber(db, { restaurantId: RID, orderId: `ORD${i}`, order: appOrder(`ORD${i}`), now: NOW }).then((r) => ['app', r.reserved]));
      jobs.push(issue(`op_concurrent_${i}`).then((r) => ['manual', r.numero]));
    }
    const got = await Promise.all(jobs);
    const nums = got.map(([, x]) => x);
    assert.ok(nums.every(Number.isSafeInteger), `MFE-CONCURRENT premise: every issuance succeeded (${JSON.stringify(got)})`);
    assert.strictEqual(new Set(nums).size, 12, `🔴 MFE-CONCURRENT: 12 issuances ⇒ 12 DISTINCT números (${nums.sort((a, b) => a - b).join(',')})`);
    assert.strictEqual((await get(`restaurants/${RID}/factura_config/seq/last_reserved`)), 41 + 12, '🔴 MFE-CONCURRENT: the one counter advanced by exactly 12');
    ok('MFE-CONCURRENT: 6 app allocations + 6 manual issues at once ⇒ 12 distinct números, one counter');
  }
  {
    await reset();
    const [a, b] = await Promise.all([issue('op_same_00001'), issue('op_same_00001')]);
    assert.deepStrictEqual([a.numero, b.numero, await get(`restaurants/${RID}/factura_config/seq/last_reserved`)], [42, 42, 42], '🔴 MFE-IDEMP: the same opId concurrently ⇒ ONE número');
    const before = JSON.stringify(await get(`restaurants/${RID}/factura_config`));
    const r = await issue('op_same_00001', PAY(23000));
    assert.deepStrictEqual([r.ok, r.code, JSON.stringify(await get(`restaurants/${RID}/factura_config`))], [false, 'op_reused', before], '🔴 MFE-REUSE: a changed payload ⇒ refused, nothing written');
    ok('MFE-IDEMP / MFE-REUSE: one número per opId; a changed payload is refused');
  }
  {
    for (const [cfg, code] of [[CFG({ is_temp: true }), 'config_temp'], [CFG({ fecha_limite: '2026-11-22' }), 'config_expired'], [CFG({ seq: { last_reserved: 8000, pending: { _: 0 } } }), 'range_exhausted']]) {
      await reset(cfg); const before = JSON.stringify(await get('/'));
      const r = await issue('op_cfg_000001');
      assert.deepStrictEqual([r.ok, r.code, JSON.stringify(await get('/'))], [false, code, before], `🔴 MFE-CONFIG: ${code} ⇒ refused, nothing written`);
    }
    ok('MFE-CONFIG: temp / expired / range exhausted ⇒ refused, nothing written');
  }
  {
    await reset();
    const renew = cfgRef().update({ cai_code: 'RENEWED-CAI', prefix: '000-002-01' });
    const rs = await Promise.all([issue('op_ren_000001'), renew.then(() => null), issue('op_ren_000002'), issue('op_ren_000003')]);
    const manual = await get(`restaurants/${RID}/factura_config/manual`);
    for (const [op, m] of Object.entries(manual)) {
      const r = m.record;
      const pair = [r.cai_code, r.factura_number.slice(0, 10)];
      assert.ok((pair[0] === 'REAL-CAI-123' && pair[1] === '000-001-01') || (pair[0] === 'RENEWED-CAI' && pair[1] === '000-002-01'), `🔴 MFE-RENEWAL: ${op} carries ONE consistent config (${pair})`);
    }
    assert.ok(rs.filter(Boolean).every((r) => r.ok), 'MFE-RENEWAL premise: the issues succeeded');
    ok('MFE-RENEWAL: a renewal concurrent with issues ⇒ each record carries exactly the config it validated against');
  }
  {
    await reset();
    const a = await issue('op_void_000001');
    const auth = await get(`restaurants/${RID}/factura_config/manual/op_void_000001`);
    assert.deepStrictEqual(await get(`facturas/${RID}/manual_op_void_000001`), { ...auth.record, void: false }, '🔴 MFE-COPY-VOID: the copy IS the snapshot');
    await db.ref(`facturas/${RID}/manual_op_void_000001`).update({ printed: true });
    await Promise.all([MF.voidManual(db, { rid: RID, opId: 'op_void_000001', reason: 'error', voidedBy: 'owner', now: NOW + 1 }), MF.voidManual(db, { rid: RID, opId: 'op_void_000001', reason: 'otro', voidedBy: 'x', now: NOW + 2 })]);
    const v = await get(`restaurants/${RID}/factura_config/manual/op_void_000001`); const cp = await get(`facturas/${RID}/manual_op_void_000001`);
    assert.deepStrictEqual([v.state, cp.void, cp.printed], ['voided', true, true], '🔴 MFE-COPY-VOID: voided once; the copy follows and keeps printed');
    const re = await issue('op_void_000001');
    assert.deepStrictEqual([re.numero, re.state, (await get(`restaurants/${RID}/factura_config/manual/op_void_000001/state`))], [a.numero, 'voided', 'voided'], '🔴 MFE-COPY-VOID: a re-issue never un-voids');
    ok('MFE-COPY-VOID: copy = snapshot; concurrent voids ⇒ voided once, the copy follows; a re-issue never un-voids');
  }
  {
    await reset(); await issue('op_seed_000001');
    const before = JSON.stringify(await get(`restaurants/${RID}/factura_config`));
    const r = await seedCreateOnly(db, RID);
    assert.deepStrictEqual([r.created, JSON.stringify(await get(`restaurants/${RID}/factura_config`))], [false, before], '🔴 MFE-SEED: the seed refuses an existing config (manual records + the counter survive)');
    ok('MFE-SEED: seed_factura_config refuses an existing factura_config, byte-identical');
  }
  FINISHED = true;
  console.log(`manual-factura(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
