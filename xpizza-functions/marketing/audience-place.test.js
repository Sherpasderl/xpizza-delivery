'use strict';
// offer-audience BUILD T7 (PLAN-5f-offer-audience r4.1 §2 placement row, §5 deadline index) — the handlers' audience glue:
//   · memberOf: the quote's verified member — DW's uid when the envío already verified one, else the X-Firebase-ID-Token verified HERE
//     (customer claim, tombstone → attributionUid, as delivery-wire / createOrder do); anything else ⇒ null (a guest). Lazy: only an
//     audience-exposed quote calls it.
//   · stampCash: the signed codes frozen on the cash order AND the day index in the SAME multi-path update.
//   · stampCard: the day index FIRST, then the codes on the pending record (its CAS write is one path): an index entry whose order holds no
//     codes is harmless (the deadline sweep deletes the absent field + the entry); codes without an index entry could outlive the deadline.
// Run: node marketing/audience-place.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const { attributionUid } = require('../create-order-build');
const AC = require('./audience-core');
const AP = require('./audience-place');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ audience-place: exited without completing\n'); process.exitCode = 1; } });

const IDS = AC.idsOf({ key: 'k'.repeat(48), brandId: 'tb', phoneHash: 'f'.repeat(64) });
const NOW = Date.UTC(2026, 10, 17, 3, 0);   // 16 Nov 21:00 HN
const req = (tok) => ({ get: (h) => (h === 'x-firebase-id-token' ? tok : undefined) });
const auth = (claims) => ({ verifyIdToken: async (t) => { if (!claims[t]) throw new Error('bad'); return claims[t]; } });

(async () => {
  await cell('AP-MEMBER: DW\'s verified uid first; else the header token (customer claim, not tombstoned); else null — never a client uid', async (L) => {
    const fake = createFakeDb({ deleted_uids: { gone: true } });
    const getAuth = () => auth({ tA: { uid: 'uA', customer: true }, tGone: { uid: 'gone', customer: true }, tStaff: { uid: 'uS' } });
    const m = (r, known) => AP.memberOf(r, fake, { knownUid: known, getAuth, attributionUid })();
    assert.strictEqual(await m(req('tX'), 'uDW'), 'uDW', `${L}: DW's uid`);
    assert.strictEqual(await m(req('tA'), null), 'uA', `🔴 ${L}: the header token`);
    assert.strictEqual(await m(req('tGone'), null), null, `🔴 ${L}: tombstoned`);
    assert.strictEqual(await m(req('tStaff'), null), null, `${L}: not a customer`);
    assert.strictEqual(await m(req('nope'), null), null, `${L}: bad token`);
    assert.strictEqual(await m(req(undefined), null), null, `${L}: no token`);
  });
  await cell('AP-LAZY: memberOf does no I/O until called (a non-exposed quote costs +0)', async (L) => {
    let calls = 0; const getAuth = () => { calls += 1; return auth({}); };
    AP.memberOf(req('tA'), createFakeDb(), { knownUid: null, getAuth, attributionUid });
    assert.strictEqual(calls, 0, L);
  });
  await cell('AP-CASH: the codes on the order and the HN day index in ONE multi-path update; no codes ⇒ the update untouched', async (L) => {
    const u = { 'orders/o1': { status: 'new' } };
    AP.stampCash(u, 'o1', { audience_ids: IDS }, NOW);
    assert.deepStrictEqual(u, { 'orders/o1': { status: 'new', audience_ids: IDS }, 'audience_ids_by_day/2026-11-16/o1': true }, `🔴 ${L}`);
    const v = { 'orders/o2': { status: 'new' } }; const before = JSON.stringify(v);
    for (const dq of [null, {}, { audience_ids: null }, { audience_ids: { p: 'x', kv: 'v1' } }]) { AP.stampCash(v, 'o2', dq, NOW); assert.strictEqual(JSON.stringify(v), before, `${L}: ${JSON.stringify(dq)}`); }
  });
  await cell('AP-CARD: the day index is written FIRST, then the codes join the pending record (its own CAS write)', async (L) => {
    const fake = createFakeDb(); const order = []; const db = { ref: (p) => { const r = fake.ref(p); return { ...r, set: async (v) => { order.push(p); return r.set(v); } }; } };
    const rec = { status: 'pending_payment' };
    await AP.stampCard(db, rec, 'o3', { audience_ids: IDS }, NOW);
    assert.deepStrictEqual([fake.get('audience_ids_by_day/2026-11-16/o3'), rec.audience_ids, order], [true, IDS, ['audience_ids_by_day/2026-11-16/o3']], `🔴 ${L}`);
    const r2 = { status: 'pending_payment' }; await AP.stampCard(db, r2, 'o4', {}, NOW);
    assert.deepStrictEqual([r2, fake.get('audience_ids_by_day/2026-11-16/o4')], [{ status: 'pending_payment' }, null], `${L}: no codes ⇒ nothing`);
  });
  await cell('AP-DAY: the index day is the ORDER\'s created_at (what the writer and the sweep read back), never a second clock', async (L) => {
    const created = Date.UTC(2026, 10, 17, 5, 59, 59, 999);   // 16 Nov 23:59:59.999 HN
    const later = created + 2;                                // 17 Nov in HN — a second clock read would pick the wrong day
    const u = { 'orders/o5': { status: 'new', created_at: created } };
    AP.stampCash(u, 'o5', { audience_ids: IDS }, later);
    assert.strictEqual(u['audience_ids_by_day/2026-11-16/o5'], true, `🔴 ${L}: cash (${JSON.stringify(Object.keys(u))})`);
    const fake = createFakeDb(); const rec = { status: 'pending_payment', created_at: created };
    await AP.stampCard({ ref: (p) => fake.ref(p) }, rec, 'o6', { audience_ids: IDS }, later);
    assert.strictEqual(fake.get('audience_ids_by_day/2026-11-16/o6'), true, `🔴 ${L}: card`);
  });
  FINISHED = true;
  if (fails.length) { console.log(`audience-place: ${fails.length} FAILED`); process.exit(1); }
  console.log(`audience-place: OK (${n})`);
})();
