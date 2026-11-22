'use strict';
// The OWNER CLI for manual facturas (tools/manual-factura.js; PLAN-manual-factura r3, owner deadline 11-21). Through the REAL core on the
// honest RTDB model; the CLI's own process for the project pin.
//   MFC-AMOUNT    --total in lempiras → integer cents exactly (no float drift); base/ISV derived by the canonical 15% split
//   MFC-PREVIEW   the default (no --apply) reads the config, prints the renderer-faithful preview with the restaurant's own name and
//                 the número it WILL take, and writes NOTHING
//   MFC-APPLY     --apply issues through the core; --op <opId> re-run ⇒ the SAME número (idempotent)
//   MFC-REFUSE    a config the core would refuse (temp / expired / range) ⇒ the preview says so; --apply writes nothing
//   MFC-VOID      void without --apply shows the state and writes nothing; --apply voids (monotonic) and the copy follows
//   MFC-PIN       the CLI refuses a missing / wrong --project before touching anything (exit 2); --rid is required (exit 1)
// Run: node tools/manual-factura.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const CLI = require('./manual-factura');
const { makeHonestDb: makeDb } = require('../_honest-rtdb-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'x_pizza', NOW = Date.UTC(2026, 10, 23, 15, 0, 0);
const CFG = (o = {}) => ({ restaurant_name: 'X PIZZA', legal_name: 'SHERPA S. DE R.L.', rtn: '05019024114145', address_1: 'BLVD', address_2: 'SPS', email: 'a@b.hn', phone: '9999',
  cai_code: 'REAL-CAI-123', prefix: '000-001-01', range_start: 1, range_end: 8000, fecha_limite: '2027-06-30', is_temp: false, seq: { last_reserved: 41, pending: {} }, ...o });
const world = (cfg = CFG()) => makeDb({ restaurants: { [RID]: { factura_config: cfg } } });
const snap = (db) => JSON.parse(JSON.stringify(db.root));
const ISSUE = { rid: RID, concept: '', total: '115', name: '', rtn: '', by: 'owner', now: NOW };

(async () => {
  {
    for (const [s, c] of [['115', 11500], ['115.5', 11550], ['115.50', 11550], ['0.05', 5], ['1150.99', 115099]]) assert.strictEqual(CLI.parseTotalCents(s), c, `🔴 MFC-AMOUNT: ${s} ⇒ ${c} cents`);
    for (const s of ['', '0', '0.00', '-1', '1,150', 'abc', '115.555', '1e3', ' 115', '115.']) assert.strictEqual(CLI.parseTotalCents(s), null, `🔴 MFC-AMOUNT: ${JSON.stringify(s)} ⇒ refused`);
    const p = CLI.derivePayload({ concept: '', total: '115', name: '', rtn: '' });
    assert.deepStrictEqual([p.total_cents, p.isv_cents, p.base_cents], [11500, 1500, 10000], '🔴 MFC-AMOUNT: the canonical 15% split');
    ok('MFC-AMOUNT: lempiras → exact cents; base/ISV from the canonical split; malformed totals refused');
  }
  {
    const db = world(); const before = snap(db);
    const r = await CLI.preview(db, ISSUE);
    assert.deepStrictEqual([r.ok, r.numero, r.factura_number], [true, 42, '000-001-01-00000042'], `🔴 MFC-PREVIEW: the número it WILL take (${JSON.stringify(r).slice(0, 120)})`);
    assert.ok(r.text.includes('X PIZZA') && r.text.includes('000-001-01-00000042') && r.text.includes('115.00'), '🔴 MFC-PREVIEW: the renderer-faithful preview shows the restaurant\'s own name, the número and the total');
    assert.deepStrictEqual(snap(db), before, '🔴 MFC-PREVIEW: writes NOTHING');
    ok('MFC-PREVIEW: the default is a preview (restaurant name from its config, the número it will take); nothing written');
  }
  {
    const db = world();
    const a = await CLI.apply(db, { ...ISSUE, op: 'mf_0123456789abcdef' });
    assert.deepStrictEqual([a.ok, a.numero, a.op_id], [true, 42, 'mf_0123456789abcdef'], `🔴 MFC-APPLY: issued (${JSON.stringify(a)})`);
    assert.ok(/^M-[0-9A-F]{8,}$/.test(a.short_ref), `🔴 MFC-APPLY: the short ref comes back with the número (${a.short_ref})`);
    assert.strictEqual((await CLI.status(db, { rid: RID, op: a.short_ref })).numero, 42, '🔴 MFC-APPLY: status by the short ref');
    const b = await CLI.apply(db, { ...ISSUE, op: 'mf_0123456789abcdef' });
    assert.deepStrictEqual([b.ok, b.numero, b.idempotent, db.getAt(`restaurants/${RID}/factura_config/seq/last_reserved`)], [true, 42, true, 42], '🔴 MFC-APPLY: --op re-run ⇒ the same número');
    const fresh = await CLI.apply(db, ISSUE);
    assert.ok(fresh.ok && fresh.numero === 43 && /^mf_[0-9a-f]{16}$/.test(fresh.op_id), `MFC-APPLY: without --op a fresh opId (${fresh.op_id})`);
    ok('MFC-APPLY: --apply issues through the core; --op re-run is idempotent; a fresh opId otherwise');
  }
  {
    for (const [cfg, code] of [[CFG({ is_temp: true }), 'config_temp'], [CFG({ fecha_limite: '2026-11-01' }), 'config_expired'], [CFG({ seq: { last_reserved: 8000 } }), 'range_exhausted']]) {
      const db = world(cfg); const before = snap(db);
      const p = await CLI.preview(db, ISSUE);
      assert.deepStrictEqual([p.ok, p.code], [false, code], `🔴 MFC-REFUSE: the preview refuses ${code}`);
      const a = await CLI.apply(db, ISSUE);
      assert.deepStrictEqual([a.ok, a.code, snap(db)], [false, code, before], `🔴 MFC-REFUSE: --apply refuses ${code}, nothing written`);
    }
    const bad = await CLI.preview(world(), { ...ISSUE, rtn: '123' });
    const noName = await CLI.preview(world(), { ...ISSUE, rtn: '08011999123456', name: '' });
    assert.deepStrictEqual([noName.ok, noName.code, CLI.messageOf('name_required_with_rtn')], [false, 'name_required_with_rtn', 'Con RTN, poné el nombre o razón social.'], '🔴 MFC-REFUSE: RTN without a name ⇒ refused with the owner\'s wording');
    assert.deepStrictEqual([bad.ok, bad.code], [false, 'bad_rtn'], 'MFC-REFUSE: a bad RTN is refused at preview');
    ok('MFC-REFUSE: temp / expired / range-exhausted / bad input refused at preview and at --apply (nothing written)');
  }
  {
    const db = world(); const a = await CLI.apply(db, { ...ISSUE, op: 'mf_0123456789abcdef' });
    const before = snap(db);
    const dry = await CLI.voidCmd(db, { rid: RID, op: a.op_id, reason: 'monto equivocado', by: 'owner', apply: false, now: NOW + 5 });
    assert.deepStrictEqual([dry.ok, dry.dryRun, dry.status.state, snap(db)], [true, true, 'issued', before], '🔴 MFC-VOID: without --apply it shows the state and writes nothing');
    const v = await CLI.voidCmd(db, { rid: RID, op: a.op_id, reason: 'monto equivocado', by: 'owner', apply: true, now: NOW + 5 });
    assert.deepStrictEqual([v.ok, v.status.state, v.status.copy_void], [true, 'voided', true], '🔴 MFC-VOID: --apply voids; the print copy follows');
    const st = await CLI.status(db, { rid: RID, op: a.op_id });
    assert.deepStrictEqual([st.found, st.state, st.numero], [true, 'voided', 42], 'MFC-VOID: status reports it');
    ok('MFC-VOID: dry run writes nothing; --apply voids monotonically and the copy follows; status reports it');
  }
  {
    const run = (args, env = {}) => spawnSync(process.execPath, [path.join(__dirname, 'manual-factura.js'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 20000 });
    const none = run(['issue', '--rid', RID, '--total', '115']);
    assert.strictEqual(none.status, 2, `🔴 MFC-PIN: no --project ⇒ exit 2 before anything (${none.status} ${none.stderr.slice(0, 80)})`);
    const wrong = run(['--project', 'demo-other', 'issue', '--rid', RID, '--total', '115']);
    assert.strictEqual(wrong.status, 2, `🔴 MFC-PIN: a wrong project ⇒ exit 2 (${wrong.status})`);
    const noRid = run(['--project', 'xpizza-delivery', 'issue', '--total', '115']);
    assert.strictEqual(noRid.status, 1, `🔴 MFC-PIN: --rid is required (usage ⇒ exit 1) (${noRid.status} ${noRid.stderr.slice(0, 80)})`);
    ok('MFC-PIN: a missing / wrong --project refuses before touching anything (exit 2); --rid required (exit 1)');
  }
  console.log(`manual-factura (CLI): OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
