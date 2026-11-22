'use strict';
// MANUAL FACTURA (PLAN-manual-factura r3 §12) — on the RTDB emulator, the REAL writers, REAL concurrency:
//   MFE-CONCURRENT  the app allocator (allocateFacturaNumber: a child-seq transaction) and manual issues (a parent factura_config
//                   transaction) run AT THE SAME TIME ⇒ every número distinct, the counter equals the count, nothing lost
//   MFE-IDEMP       the same opId issued concurrently twice ⇒ ONE número
//   MFE-REUSE       the same opId with a changed payload ⇒ refused, nothing written
//   MFE-CONFIG      is_temp / expired / range exhausted ⇒ refused, nothing written
//   MFE-RENEWAL     (Codex #252-9) the issuing client OBSERVES the old config (offline, cached); an INDEPENDENT client renews it before the
//                   commit reaches the server ⇒ the transaction is revalidated: the record carries the RENEWED CAI + prefix, never the stale pair
//   MFE-PARTIAL     a same-client update() concurrent with issues (a partial local cache) ⇒ no false refusal; each record one consistent config
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
      jobs.push(allocateFacturaNumber(db, { restaurantId: RID, orderId: `ORD${i}`, order: appOrder(`ORD${i}`), now: NOW }).then((r) => ['app', r.ok ? r.reserved : `refused:${r.reason || r.skipped}`]));
      jobs.push(issue(`mf_c00000000000000${i}`).then((r) => ['manual', r.ok ? r.numero : `refused:${r.code}`]));
    }
    const got = await Promise.all(jobs);
    const nums = got.map(([, x]) => x);
    assert.ok(nums.every(Number.isSafeInteger), `🔴 MFE-CONCURRENT: every issuance succeeded — an in-flight manual issue must not blind the app allocator (${JSON.stringify(got)})`);
    assert.strictEqual(new Set(nums).size, 12, `🔴 MFE-CONCURRENT: 12 issuances ⇒ 12 DISTINCT números (${nums.sort((a, b) => a - b).join(',')})`);
    assert.strictEqual((await get(`restaurants/${RID}/factura_config/seq/last_reserved`)), 41 + 12, '🔴 MFE-CONCURRENT: the one counter advanced by exactly 12');
    ok('MFE-CONCURRENT: 6 app allocations + 6 manual issues at once ⇒ 12 distinct números, one counter');
  }
  {
    await reset();
    const [a, b] = await Promise.all([issue('mf_5000000000000001'), issue('mf_5000000000000001')]);
    assert.deepStrictEqual([a.numero, b.numero, await get(`restaurants/${RID}/factura_config/seq/last_reserved`)], [42, 42, 42], '🔴 MFE-IDEMP: the same opId concurrently ⇒ ONE número');
    const before = JSON.stringify(await get(`restaurants/${RID}/factura_config`));
    const r = await issue('mf_5000000000000001', PAY(23000));
    assert.deepStrictEqual([r.ok, r.code, JSON.stringify(await get(`restaurants/${RID}/factura_config`))], [false, 'op_reused', before], '🔴 MFE-REUSE: a changed payload ⇒ refused, nothing written');
    ok('MFE-IDEMP / MFE-REUSE: one número per opId; a changed payload is refused');
  }
  {
    for (const [cfg, code] of [[CFG({ is_temp: true }), 'config_temp'], [CFG({ fecha_limite: '2026-11-22' }), 'config_expired'], [CFG({ seq: { last_reserved: 8000, pending: { _: 0 } } }), 'range_exhausted']]) {
      await reset(cfg); const before = JSON.stringify(await get('/'));
      const r = await issue('mf_cf00000000000001');
      assert.deepStrictEqual([r.ok, r.code, JSON.stringify(await get('/'))], [false, code, before], `🔴 MFE-CONFIG: ${code} ⇒ refused, nothing written`);
    }
    ok('MFE-CONFIG: temp / expired / range exhausted ⇒ refused, nothing written');
  }
  {
    await reset();   // MFE-PARTIAL: a same-client update() leaves a PARTIAL local factura_config (cai_code + prefix only)
    const renew = cfgRef().update({ cai_code: 'RENEWED-CAI', prefix: '000-002-01' });
    const rs = await Promise.all([issue('mf_a000000000000001'), renew.then(() => null), issue('mf_a000000000000002'), issue('mf_a000000000000003')]);
    assert.ok(rs.filter(Boolean).every((r) => r.ok), `🔴 MFE-PARTIAL: a partial local cache never refuses a valid config — refusals are confirmed by the server (${JSON.stringify(rs)})`);
    for (const [op, m] of Object.entries(await get(`restaurants/${RID}/factura_config/manual`))) {
      const pair = [m.record.cai_code, m.record.factura_number.slice(0, 10)];
      assert.ok((pair[0] === 'REAL-CAI-123' && pair[1] === '000-001-01') || (pair[0] === 'RENEWED-CAI' && pair[1] === '000-002-01'), `🔴 MFE-PARTIAL: ${op} carries ONE consistent config (${pair})`);
    }
    ok('MFE-PARTIAL: issues concurrent with a same-client update() all succeed, each with one consistent config');
  }
  {
    await reset();
    const other = admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${process.env.GCLOUD_PROJECT}` }, 'renewer').database();
    const keep = cfgRef().on('value', () => {});   // keep the issuing client's cache of the OLD config warm
    await cfgRef().once('value');
    db.goOffline();
    const seen = [];
    const realTx = Object.getPrototypeOf(cfgRef()).transaction;
    Object.getPrototypeOf(cfgRef()).transaction = function (fn, ...rest) { return realTx.call(this, (v) => { if (v && v.cai_code) seen.push(v.cai_code); return fn(v); }, ...rest); };
    const pending = issue('mf_e000000000000001');   // observes the cached OLD config while offline
    await new Promise((r) => setTimeout(r, 200));
    await other.ref(`restaurants/${RID}/factura_config`).update({ cai_code: 'RENEWED-CAI', prefix: '000-002-01' });   // the independent renewal lands first
    db.goOnline();
    const r = await pending;
    Object.getPrototypeOf(cfgRef()).transaction = realTx; cfgRef().off('value', keep);
    assert.ok(seen.includes('REAL-CAI-123'), `MFE-RENEWAL premise: the issue observed the OLD config before the renewal (${seen})`);
    const rec = (await get(`restaurants/${RID}/factura_config/manual/mf_e000000000000001`)).record;
    assert.deepStrictEqual([r.ok, rec.cai_code, rec.factura_number.slice(0, 10)], [true, 'RENEWED-CAI', '000-002-01'], `🔴 MFE-RENEWAL: revalidated at commit — the record carries the RENEWED config, never the stale pair (${JSON.stringify([r.code, rec.cai_code, rec.factura_number])})`);
    ok('MFE-RENEWAL: an independent renewal between observation and commit ⇒ the issue is revalidated (renewed CAI + prefix)');
  }
  {
    await reset();
    const a = await issue('mf_d000000000000001');
    const auth = await get(`restaurants/${RID}/factura_config/manual/mf_d000000000000001`);
    assert.deepStrictEqual(await get(`facturas/${RID}/manual_mf_d000000000000001`), { ...auth.record, void: false }, '🔴 MFE-COPY-VOID: the copy IS the snapshot');
    await db.ref(`facturas/${RID}/manual_mf_d000000000000001`).update({ printed: true });
    await Promise.all([MF.voidManual(db, { rid: RID, opId: 'mf_d000000000000001', reason: 'error', voidedBy: 'owner', now: NOW + 1 }), MF.voidManual(db, { rid: RID, opId: 'mf_d000000000000001', reason: 'otro', voidedBy: 'x', now: NOW + 2 })]);
    const v = await get(`restaurants/${RID}/factura_config/manual/mf_d000000000000001`); const cp = await get(`facturas/${RID}/manual_mf_d000000000000001`);
    assert.deepStrictEqual([v.state, cp.void, cp.printed], ['voided', true, true], '🔴 MFE-COPY-VOID: voided once; the copy follows and keeps printed');
    const re = await issue('mf_d000000000000001');
    assert.deepStrictEqual([re.numero, re.state, (await get(`restaurants/${RID}/factura_config/manual/mf_d000000000000001/state`))], [a.numero, 'voided', 'voided'], '🔴 MFE-COPY-VOID: a re-issue never un-voids');
    ok('MFE-COPY-VOID: copy = snapshot; concurrent voids ⇒ voided once, the copy follows; a re-issue never un-voids');
  }
  {
    await reset(); await issue('mf_5eed000000000001');
    const before = JSON.stringify(await get(`restaurants/${RID}/factura_config`));
    const r = await seedCreateOnly(db, RID);
    assert.deepStrictEqual([r.created, JSON.stringify(await get(`restaurants/${RID}/factura_config`))], [false, before], '🔴 MFE-SEED: the seed refuses an existing config (manual records + the counter survive)');
    ok('MFE-SEED: seed_factura_config refuses an existing factura_config, byte-identical');
  }
  FINISHED = true;
  console.log(`manual-factura(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
