'use strict';
// PLAN-manual-factura r3 §1–§5 + §8 (owner deadline 11-21: the CLI path ships first; the portal calls the same core later).
// Through the REAL core on the honest RTDB model:
//   MF-ISSUE       ONE transaction on restaurants/{rid}/factura_config: next número = seq.last_reserved + 1, the FULL rendered
//                  snapshot + state 'issued' under manual/{opId}; seq.pending untouched; the print copy = the snapshot
//   MF-IDEMP       the same opId + the same payload ⇒ the SAME número, nothing new consumed
//   MF-REUSE       the same opId + a CHANGED payload ⇒ rejected, nothing written
//   MF-CONFIG      is_temp / a missing or past fecha_limite / next outside [range_start, range_end] / no config ⇒ refused, nothing written
//   MF-AMOUNTS     safe-integer cents, total > 0, components ≥ 0, the canonical 15% split (factura/money.priceBreakdown); units are cents
//   MF-BUYER       RTN '' or exactly 14 digits (else rejected); RTN needs a name; blank ⇒ «Consumidor Final»; concept ≤ 28, defaulted
//   MF-SNAPSHOT    a config renewal AFTER issuance leaves the issued record AND a re-derived copy byte-identical (snapshot-derived)
//   MF-COPY        repairCopy: creates a missing copy from the snapshot; never overwrites a copy (printed stays printed)
//   MF-VOID        void is monotonic (issued → voided, never back) and propagates void:true to the copy (false→true only)
//   MF-AUTHORITY   usesPlatformFactura(rid) is required (a non-platform restaurant ⇒ refused)
//   MF-REF         (owner Q4 11-21) a short reference «M-» + 8 hex chars derived from the opId is stored in the snapshot and printed on the
//                  PEDIDO line; a collision with an existing manual record (checked inside the issuing transaction) extends it; status
//                  accepts the short ref as well as the opId
//   MF-OPID        (Codex #252-3) an opId is exactly mf_ + 16 lowercase hex; a short ref can never be an opId and vice versa; status /
//                  void resolve the key ONCE (resolveOp) and act on that op
//   MF-FISCAL      (Codex #252-6) blank / whitespace issuer RTN, legal name, CAI, prefix and an impossible fecha_limite ⇒ refused in the transaction
//   MF-STATUS      (Codex #252-7/8) status runs the idempotent repairCopy; the print class is allowlisted (printed / not_printed /
//                  printed_ack_failed), never raw error text; void reports success only once the copy shows voided
//   MF-KEY         (owner ruling 11-21) the copy key manual~{opId} is outside the deployed order-id charset ⇒ no app order can produce it
//   MF-APP-SEQ     the app allocator (the REAL allocateFacturaNumber, child seq) and a manual issue interleave ⇒ distinct números
// Run: node factura/manual-core.test.js
const assert = require('assert');
const MF = require('./manual-core');
const { priceBreakdown } = require('./money');
const { allocateFacturaNumber } = require('./factura-helpers');
const { makeHonestDb: makeDb } = require('../_honest-rtdb-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'x_pizza';
const NOW = Date.UTC(2026, 10, 23, 15, 0, 0);   // Monday 23/11/2026 09:00 HN
const CFG = (o = {}) => ({ restaurant_name: 'X PIZZA', legal_name: 'SHERPA S. DE R.L.', rtn: '05019024114145', address_1: 'BLVD', address_2: 'SPS', email: 'a@b.hn', phone: '9999',
  cai_code: 'REAL-CAI-123', prefix: '000-001-01', range_start: 1, range_end: 8000, fecha_limite: '2027-06-30', is_temp: false, seq: { last_reserved: 41, pending: { ORD9: 40 } }, ...o });
const PAY = (o = {}) => { const b = priceBreakdown(11500); return { concept: 'Elaboración de Pizzas', customer_name: '', rtn: '', base_cents: b.subtotal_cents, isv_cents: b.isv_cents, total_cents: 11500, ...o }; };
const world = (cfg = CFG()) => makeDb({ restaurants: { [RID]: { factura_config: cfg } } });
const issue = (db, over = {}) => MF.issueManual(db, { rid: RID, opId: 'mf_aaaaaaaaaaaaaaaa', payload: PAY(), issuedBy: 'owner-uid', now: NOW, ...over });
const snap = (db) => JSON.parse(JSON.stringify(db.root));
const cfgOf = (db) => db.getAt(`restaurants/${RID}/factura_config`);

(async () => {
  {
    const db = world();
    const r = await issue(db);
    assert.deepStrictEqual([r.ok, r.numero, r.factura_number], [true, 42, '000-001-01-00000042'], `🔴 MF-ISSUE: the next número (${JSON.stringify(r)})`);
    const c = cfgOf(db);
    assert.deepStrictEqual([c.seq.last_reserved, c.seq.pending], [42, { ORD9: 40 }], '🔴 MF-ISSUE: seq.last_reserved incremented; seq.pending untouched (the manual path never uses it)');
    const m = c.manual.mf_aaaaaaaaaaaaaaaa;
    assert.deepStrictEqual([m.state, m.numero, m.source, m.issued_by, m.issued_at, m.record.factura_number, m.record.cai_code, m.record.total_cents], ['issued', 42, 'manual', 'owner-uid', NOW, '000-001-01-00000042', 'REAL-CAI-123', 11500], '🔴 MF-ISSUE: the full rendered snapshot + state under manual/{opId}');
    assert.deepStrictEqual(db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa`), { ...m.record, void: false }, '🔴 MF-ISSUE: the print copy IS the snapshot');
    assert.strictEqual(db.getAt('orders'), null, 'MF-ISSUE: the manual path never writes /orders');
    ok('MF-ISSUE: one transaction ⇒ the next número + the full snapshot; seq.pending untouched; the copy = the snapshot; no /orders');
    const before = snap(db);
    const again = await issue(db);
    assert.deepStrictEqual([again.ok, again.idempotent, again.numero], [true, true, 42], '🔴 MF-IDEMP: the same opId + payload ⇒ the same número');
    assert.deepStrictEqual(snap(db), before, '🔴 MF-IDEMP: nothing new consumed or written');
    ok('MF-IDEMP: a retry with the same opId returns the same número, writes nothing');
    const reuse = await issue(db, { payload: PAY({ customer_name: 'Otro', rtn: '08011999123456' }) });
    assert.deepStrictEqual([reuse.ok, reuse.code, snap(db)], [false, 'op_reused', before], '🔴 MF-REUSE: the same opId with a changed payload ⇒ rejected, nothing written');
    ok('MF-REUSE: an opId reused with changed data is rejected');
  }
  {
    const cases = [
      ['config_temp', CFG({ is_temp: true })], ['config_no_expiry', CFG({ fecha_limite: undefined })], ['config_no_expiry', CFG({ fecha_limite: '31/12/2027' })],
      ['config_expired', CFG({ fecha_limite: '2026-11-22' })], ['range_exhausted', CFG({ seq: { last_reserved: 8000 } })], ['range_invalid', CFG({ range_start: 100, seq: { last_reserved: 41 } })],
      ['config_invalid', CFG({ cai_code: '' })], ['config_invalid', CFG({ seq: undefined })],
    ];
    const fiscal = [['config_invalid', CFG({ rtn: '' })], ['config_invalid', CFG({ legal_name: '   ' })], ['config_invalid', CFG({ cai_code: '  ' })], ['config_invalid', CFG({ prefix: ' ' })],
      ['config_no_expiry', CFG({ fecha_limite: '2027-02-30' })], ['config_no_expiry', CFG({ fecha_limite: '2027-13-01' })]];
    const FISCAL = new Set(fiscal.map(([, c]) => c)); cases.push(...fiscal);
    for (const [code, cfg] of cases) {
      const db = world(cfg); const before = snap(db);
      const r = await issue(db);
      const cell = FISCAL.has(cfg) ? 'MF-FISCAL' : 'MF-CONFIG';
      assert.deepStrictEqual([r.ok, r.code, snap(db)], [false, code, before], `🔴 ${cell}: ${code} ⇒ refused, nothing written (${JSON.stringify(r)})`);
    }
    const none = makeDb({}); const r0 = await issue(none);
    assert.deepStrictEqual([r0.ok, r0.code, snap(none)], [false, 'config_missing', {}], '🔴 MF-CONFIG: no factura_config ⇒ refused, nothing created');
    const today = await issue(world(CFG({ fecha_limite: '2026-11-23' })));
    assert.strictEqual(today.ok, true, 'MF-CONFIG: the expiry day itself is still valid (Honduras-local)');
    ok('MF-CONFIG: temp / no or malformed expiry / expired / out of range / incomplete / missing config ⇒ refused, nothing written');
  }
  {
    const bad = [{ total_cents: 0, base_cents: 0, isv_cents: 0 }, { total_cents: -11500, base_cents: -10000, isv_cents: -1500 }, { total_cents: 11500.5 },
      { isv_cents: 1501, base_cents: 9999 }, { base_cents: 10001 }, { total_cents: '11500' }, { total_cents: 1150000 }, { total_cents: Number.MAX_SAFE_INTEGER + 2 }];
    for (const over of bad) {
      const db = world(); const before = snap(db);
      const r = await issue(db, { payload: PAY(over) });
      assert.deepStrictEqual([r.ok, r.code, snap(db)], [false, 'bad_amount', before], `🔴 MF-AMOUNTS: ${JSON.stringify(over)} ⇒ refused`);
    }
    const tiny = priceBreakdown(5);
    assert.strictEqual((await issue(world(), { payload: PAY({ total_cents: 5, base_cents: tiny.subtotal_cents, isv_cents: tiny.isv_cents }) })).ok, true, 'MF-AMOUNTS: a tiny total keeps the canonical rounding');
    ok('MF-AMOUNTS: zero / negative / fractional / string / non-15% / units-confused (cents ×100) ⇒ refused; canonical split accepted');
  }
  {
    for (const [over, code] of [[{ rtn: '0801199912345' }, 'bad_rtn'], [{ rtn: '0801-1999-123456' }, 'bad_rtn'], [{ rtn: '08011999123456', customer_name: '' }, 'name_required_with_rtn'],
      [{ concept: 'x'.repeat(29) }, 'bad_concept'], [{ customer_name: 'x'.repeat(81) }, 'bad_name']]) {
      const r = await issue(world(), { payload: PAY(over) });
      assert.deepStrictEqual([r.ok, r.code], [false, code], `🔴 MF-BUYER: ${JSON.stringify(over).slice(0, 50)} ⇒ ${code}`);
    }
    const anon = world(); await issue(anon, { payload: PAY({ concept: '' }) });
    const ra = cfgOf(anon).manual.mf_aaaaaaaaaaaaaaaa.record;
    assert.deepStrictEqual([ra.cliente, ra.rtn_cliente, ra.items[0].description, ra.forma_de_pago_label], ['Consumidor Final', '', 'Elaboración de Pizzas', 'EFECTIVO'], '🔴 MF-BUYER: blank ⇒ Consumidor Final, default concept, cash');
    const named = world(); await issue(named, { payload: PAY({ customer_name: 'Acme S.A.', rtn: '08011999123456' }) });
    const rn = cfgOf(named).manual.mf_aaaaaaaaaaaaaaaa.record;
    assert.deepStrictEqual([rn.cliente, rn.rtn_cliente], ['Acme S.A.', '08011999123456'], '🔴 MF-BUYER: a named buyer with RTN prints both');
    ok('MF-BUYER: RTN 14 digits or rejected; RTN needs a name; blank ⇒ Consumidor Final; concept ≤ 28 + default; payment cash');
  }
  {
    const db = world(); await issue(db);
    const rec = JSON.stringify(cfgOf(db).manual.mf_aaaaaaaaaaaaaaaa);
    await db.ref(`restaurants/${RID}/factura_config`).update({ cai_code: 'NEW-CAI', prefix: '000-002-01', range_start: 1, range_end: 50, fecha_limite: '2028-01-01', legal_name: 'OTRA' });
    await db.ref(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa`).remove();
    const rc = await MF.repairCopy(db, { rid: RID, opId: 'mf_aaaaaaaaaaaaaaaa' });
    assert.strictEqual(JSON.stringify(cfgOf(db).manual.mf_aaaaaaaaaaaaaaaa), rec, '🔴 MF-SNAPSHOT: the issued record is untouched by a renewal');
    assert.deepStrictEqual([rc.created, db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa/cai_code`), db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa/legal_name`)], [true, 'REAL-CAI-123', 'SHERPA S. DE R.L.'], '🔴 MF-SNAPSHOT: a re-derived copy comes from the SNAPSHOT, never the renewed config');
    ok('MF-SNAPSHOT: a config renewal after issuance never alters the issued document or its re-derived copy');
    // MF-COPY: an existing (printed) copy is never overwritten
    await db.ref(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa`).update({ printed: true, printed_at: 5 });
    const printed = JSON.stringify(db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa`));
    const r2 = await MF.repairCopy(db, { rid: RID, opId: 'mf_aaaaaaaaaaaaaaaa' });
    assert.deepStrictEqual([r2.created, JSON.stringify(db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa`))], [false, printed], '🔴 MF-COPY: an existing copy is never overwritten (printed stays printed)');
    ok('MF-COPY: repairCopy creates a missing copy from the snapshot; an existing one is never overwritten');
    // MF-VOID
    const v = await MF.voidManual(db, { rid: RID, opId: 'mf_aaaaaaaaaaaaaaaa', reason: 'error de monto', voidedBy: 'owner-uid', now: NOW + 9 });
    const m = cfgOf(db).manual.mf_aaaaaaaaaaaaaaaa; const cp = db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa`);
    assert.deepStrictEqual([v.ok, m.state, m.voided_by, m.voided_at, cp.void, cp.printed, cp.printed_at], [true, 'voided', 'owner-uid', NOW + 9, true, true, 5], '🔴 MF-VOID: voided at the authority; the copy gets void:true and keeps its print fields');
    const again = await MF.voidManual(db, { rid: RID, opId: 'mf_aaaaaaaaaaaaaaaa', reason: 'x', voidedBy: 'other', now: NOW + 99 });
    assert.deepStrictEqual([again.ok, again.idempotent, cfgOf(db).manual.mf_aaaaaaaaaaaaaaaa.voided_by], [true, true, 'owner-uid'], '🔴 MF-VOID: a second void is a no-op (the first voider stands)');
    // a stale re-issue of the same opId never un-voids
    const re = await issue(db);
    assert.deepStrictEqual([re.ok, re.idempotent, re.state, cfgOf(db).manual.mf_aaaaaaaaaaaaaaaa.state, db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa/void`)], [true, true, 'voided', 'voided', true], '🔴 MF-VOID: monotonic — a retry of the issue never brings it back');
    await db.ref(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa/void`).set(false);   // a drifted copy
    await MF.repairCopy(db, { rid: RID, opId: 'mf_aaaaaaaaaaaaaaaa' });
    assert.strictEqual(db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa/void`), true, '🔴 MF-VOID: repairCopy re-propagates the authority\'s void');
    const missing = await MF.voidManual(db, { rid: RID, opId: 'mf_0000000000000001', reason: 'x', voidedBy: 'o', now: NOW });
    assert.deepStrictEqual([missing.ok, missing.code], [false, 'not_found'], 'MF-VOID: an unknown opId ⇒ not_found');
    ok('MF-VOID: monotonic issued → voided; the copy follows (false→true only, print fields kept); never un-voided');
  }
  {
    const db = makeDb({ restaurants: { la_musa: { factura_config: CFG() } } });
    const r = await MF.issueManual(db, { rid: 'la_musa', opId: 'mf_aaaaaaaaaaaaaaaa', payload: PAY(), issuedBy: 'o', now: NOW });
    assert.deepStrictEqual([r.ok, r.code, db.getAt('restaurants/la_musa/factura_config/seq/last_reserved')], [false, 'not_platform_factura', 41], '🔴 MF-AUTHORITY: a restaurant outside the fiscal authority ⇒ refused');
    for (const bad of ['', 'op/1', 'x'.repeat(65), 'ab']) assert.strictEqual((await issue(world(), { opId: bad })).code, 'bad_op_id', `MF-AUTHORITY: opId ${JSON.stringify(bad)} ⇒ refused`);
    for (const bad of ['op_aaaaaaaa', 'M-ABCDEF12', 'mf_AAAAAAAAAAAAAAAA', 'mf_aaaaaaaaaaaaaaa', 'mf_aaaaaaaaaaaaaaaaa']) assert.strictEqual((await issue(world(), { opId: bad })).code, 'bad_op_id', `🔴 MF-OPID: ${bad} is not an opId`);
    ok('MF-AUTHORITY: usesPlatformFactura(rid) required; a malformed opId is refused');
  }
  {
    const db = world(); const r = await issue(db);
    const m = cfgOf(db).manual.mf_aaaaaaaaaaaaaaaa; const ref8 = MF.shortRefOf('mf_aaaaaaaaaaaaaaaa', 8);
    assert.ok(/^M-[0-9A-F]{8}$/.test(ref8), `MF-REF premise: the format (${ref8})`);
    assert.deepStrictEqual([r.short_ref, m.short_ref, m.record.pedido, db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa/pedido`)], [ref8, ref8, ref8, ref8], '🔴 MF-REF: the short ref is stored and printed on the PEDIDO line (the copy too)');
    const st = await MF.statusManual(db, { rid: RID, key: ref8 });
    assert.deepStrictEqual([st.found, st.numero, st.short_ref], [true, 42, ref8], '🔴 MF-REF: status accepts the short ref');
    // a collision: an existing record already holds this opId's 8-char ref ⇒ the new one extends, and stays unique
    const clash = world(CFG({ manual: { mf_0000000000000002: { short_ref: MF.shortRefOf('mf_bbbbbbbbbbbbbbbb', 8), numero: 7, state: 'issued' } } }));
    const r2 = await issue(clash, { opId: 'mf_bbbbbbbbbbbbbbbb' });
    assert.deepStrictEqual([r2.ok, r2.short_ref, cfgOf(clash).manual.mf_bbbbbbbbbbbbbbbb.record.pedido], [true, MF.shortRefOf('mf_bbbbbbbbbbbbbbbb', 10), MF.shortRefOf('mf_bbbbbbbbbbbbbbbb', 10)], '🔴 MF-REF: a colliding ref is extended inside the transaction');
    ok('MF-REF: «M-» + 8 hex from the opId on the PEDIDO line; extended on a collision; status accepts it');
  }
  {
    // MF-OPID: the two key spaces are disjoint; resolveOp maps either to the ONE op
    for (let i = 0; i < 200; i++) {
      const op = `mf_${require('crypto').randomBytes(8).toString('hex')}`;
      for (const k of [8, 10, 64]) assert.ok(!MF.OP_ID_RE.test(MF.shortRefOf(op, k)) && !MF.SHORT_REF_RE.test(op), `🔴 MF-OPID: ${op} / its ref never cross namespaces`);
    }
    const db = world(); await issue(db); const ref = MF.shortRefOf('mf_aaaaaaaaaaaaaaaa', 8);
    assert.deepStrictEqual([await MF.resolveOp(db, { rid: RID, key: ref }), await MF.resolveOp(db, { rid: RID, key: 'mf_aaaaaaaaaaaaaaaa' }), await MF.resolveOp(db, { rid: RID, key: 'M-00000000' }), await MF.resolveOp(db, { rid: RID, key: 'op_x' })],
      ['mf_aaaaaaaaaaaaaaaa', 'mf_aaaaaaaaaaaaaaaa', null, null], '🔴 MF-OPID: resolveOp maps a short ref or an opId to the one op (unknown / malformed ⇒ null)');
    ok('MF-OPID: opId = mf_ + 16 hex, disjoint from M- refs; resolveOp resolves either once');
  }
  {
    // MF-STATUS: status repairs; the print class is allowlisted; void confirms the copy
    const db = world(); await issue(db);
    const CP = `facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa`;
    await db.ref(CP).remove();
    const s0 = await MF.statusManual(db, { rid: RID, key: 'mf_aaaaaaaaaaaaaaaa' });
    assert.deepStrictEqual([s0.found, s0.copy, s0.print, db.getAt(CP) !== null], [true, true, 'not_printed', true], `🔴 MF-STATUS: status runs repairCopy — a missing copy is recreated (${JSON.stringify(s0)})`);
    await db.ref(CP).update({ print_error: 'printed_ack_failed: socket hang up at 10.0.0.5' });
    const s1 = await MF.statusManual(db, { rid: RID, key: MF.shortRefOf('mf_aaaaaaaaaaaaaaaa', 8) });
    assert.deepStrictEqual([s1.print, JSON.stringify(s1).includes('socket')], ['printed_ack_failed', false], '🔴 MF-STATUS: paper printed but the ack failed ⇒ printed_ack_failed, no raw error text');
    await db.ref(CP).update({ printed: true, print_error: null });
    assert.strictEqual((await MF.statusManual(db, { rid: RID, key: 'mf_aaaaaaaaaaaaaaaa' })).print, 'printed', '🔴 MF-STATUS: printed');
    assert.deepStrictEqual(Object.keys(s1).sort(), ['copy', 'copy_void', 'factura_number', 'found', 'issued_at', 'numero', 'op_id', 'print', 'short_ref', 'state', 'total_cents', 'voided_at'], '🔴 MF-STATUS: an allowlisted shape');
    // void: success only once the copy shows voided
    let drift = false; let dbv;
    dbv = makeDb({ restaurants: { [RID]: { factura_config: CFG() } } }, { beforeRead: async (p) => { if (drift && p === CP) { drift = false; await dbv.ref(`${CP}/void`).set(false); } } });
    await issue(dbv); drift = true;   // the copy drifts back right before void's confirm read
    const v = await MF.voidManual(dbv, { rid: RID, opId: 'mf_aaaaaaaaaaaaaaaa', reason: 'error', voidedBy: 'o', now: NOW + 1 });
    assert.deepStrictEqual([v.ok, v.code], [false, 'copy_not_voided'], `🔴 MF-STATUS: the copy does not show voided ⇒ void does NOT report success (${JSON.stringify(v)})`);
    const v2 = await MF.voidManual(dbv, { rid: RID, opId: 'mf_aaaaaaaaaaaaaaaa', reason: 'error', voidedBy: 'o', now: NOW + 2 });
    assert.deepStrictEqual([v2.ok, v2.idempotent, dbv.getAt(`${CP}/void`)], [true, true, true], '🔴 MF-STATUS: a re-run repairs the copy and then reports success');
    ok('MF-STATUS: status repairs + allowlisted print class (no raw text); void succeeds only once the copy shows voided');
  }
  {
    // MF-KEY (owner ruling 11-21, namespace by construction): the print-copy key can never be an app order's factura key
    const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    const fnSrc = SRC.slice(SRC.indexOf('function validateOrderPayload('));
    const m = /body\.order_id != null && !\/(\^\[[^\]]+\]\{1,64\}\$)\/\.test/.exec(fnSrc);
    assert.ok(m, 'MF-KEY premise: the deployed order_id charset is read from validateOrderPayload');
    const ORDER_ID = new RegExp(m[1]);
    assert.ok(ORDER_ID.test('ORD_1-a') && !ORDER_ID.test('a~b'), `MF-KEY premise: the charset parsed (${m[1]})`);
    for (let i = 0; i < 100; i++) {
      const key = `${MF.COPY_PREFIX}mf_${require('crypto').randomBytes(8).toString('hex')}`;
      assert.ok(!ORDER_ID.test(key), `🔴 MF-KEY: the copy key ${key} is outside the server order-id charset (no app order can produce it)`);
      assert.ok(!/[.$#[\]/\u0000-\u001f\u007f]/.test(key), `🔴 MF-KEY: ${key} is an RTDB-legal key`);
    }
    const db = world(); await issue(db);
    assert.ok(db.getAt(`facturas/${RID}/${MF.COPY_PREFIX}mf_aaaaaaaaaaaaaaaa`) !== null, 'MF-KEY: the copy lands under the prefix');
    ok('MF-KEY: the copy key (manual~…) is outside the deployed order-id charset and RTDB-legal');
  }
  {
    // MF-APP-SEQ: the REAL app allocator reserves on the child seq; a manual issue interleaves inside it ⇒ distinct números
    let db; let fired = false;
    db = makeDb({ restaurants: { [RID]: { factura_config: CFG() } }, orders: { ORDA: { orderId: 'ORDA', status: 'preparing' } } }, {
      beforeTx: async (p) => { if (fired || p !== `restaurants/${RID}/factura_config/seq`) return; fired = true; await issue(db); },
    });
    const order = { orderId: 'ORDA', items: [{ qty: 1, description: 'Pizza', line_gross_cents: 11500 }], subtotal_cents: 10000, tax_cents: 1500, total_cents: 11500, customer_name: 'T', payment_method: 'cash' };
    const app = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORDA', order, now: NOW });
    assert.ok(fired, 'MF-APP-SEQ premise: the manual issue ran inside the app allocation');
    const manual = cfgOf(db).manual.mf_aaaaaaaaaaaaaaaa.numero;
    assert.deepStrictEqual([manual, app.reserved, cfgOf(db).seq.last_reserved], [42, 43, 43], `🔴 MF-APP-SEQ: distinct números (manual ${manual}, app ${app.reserved})`);
    ok('MF-APP-SEQ: an app allocation and a manual issue interleave ⇒ distinct números, one counter');
  }
  console.log(`manual-core: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
