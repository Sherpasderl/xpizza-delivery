'use strict';
// DRIVER F — driver-problem-alert.js: the report → ONE keyed dispatcher alert. Synthetic tb_ fixtures, brand-agnostic.
// Run: node driver-problem-alert.test.js
const assert = require('assert');
const { alertOnDriverProblem, validReport, alertKey, REASONS } = require('./driver-problem-alert');

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const quiet = { warn: () => {}, error: () => {} };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// A path-map fake. transaction() models the Admin SDK null-first pass: an existing (uncached) value first sees a speculative
// null; a proposal there is rejected by the server and re-run with the real value (claim-delivery.test.js model).
function fakeDb(init = {}, { failRead = [], failTxn = false } = {}) {
  const data = clone(init);
  const db = { data, txns: 0, writes: 0 };
  db.ref = (p) => ({
    once: async () => { if (failRead.includes(p)) throw new Error(`tb_read_failed ${p}`); return { val: () => (data[p] === undefined ? null : clone(data[p])) }; },
    transaction: async (fn) => {
      db.txns += 1;
      if (failTxn) throw new Error('tb_txn_failed');
      const real = data[p] === undefined ? null : data[p];
      if (real !== null) {
        const spec = fn(null);
        if (spec === undefined) return { committed: false, snapshot: { val: () => clone(real) } };
      }
      const next = fn(clone(real));
      if (next === undefined) return { committed: false, snapshot: { val: () => clone(real) } };
      data[p] = clone(next); db.writes += 1;
      return { committed: true, snapshot: { val: () => clone(next) } };
    },
  });
  return db;
}

const OID = 'tb_order_1', PID = 'tb_push_1', UID = 'tb_driver_1', NOW = 1_800_000_000_000;
const ORDER = { status: 'out_for_delivery', restaurant_id: 'tb_rest', display_number: 42, total: 100 };
const TASKS = { [`tasks/${OID}_delivery`]: { order_id: OID, type: 'delivery', status: 'in_progress', assigned_driver_id: UID } };
const names = async (db, uid) => (uid === UID ? 'Tbname' : null);
const rec = (o = {}) => ({ reason: 'customer_no_answer', by: UID, at: NOW - 5000, ...o });
const AK = `dispatcher_alerts/${alertKey(OID, PID)}`;

(async () => {
  // every reason → one keyed alert with the full payload
  for (const reason of REASONS) {
    const db = fakeDb({ [`orders/${OID}`]: ORDER });
    const r = await alertOnDriverProblem(db, { oid: OID, pid: PID, rec: rec({ reason }), now: NOW }, { resolveDriverName: names, log: quiet });
    assert.strictEqual(r.written, true, `DRVF-WRITE ${reason} must write`);
    assert.deepStrictEqual(db.data[AK], { type: 'driver_problem', order_id: OID, driver_uid: UID, reason, reported_at: NOW - 5000, created_at: NOW, display_number: 42, restaurant_id: 'tb_rest', driver_name: 'Tbname' }, `DRVF-PAYLOAD ${reason}`);
    assert.strictEqual(db.data[AK].detail, undefined, 'DRVF-NO-DETAIL: order_id stays top-level so alert-prune ignores it');
  }
  ok('each of the 6 reasons → one keyed alert, exact payload, order_id top-level (no detail)');

  // note carried when present
  {
    const db = fakeDb({ [`orders/${OID}`]: ORDER });
    await alertOnDriverProblem(db, { oid: OID, pid: PID, rec: rec({ reason: 'other', note: 'tb <b>nota</b>' }), now: NOW }, { resolveDriverName: names, log: quiet });
    assert.strictEqual(db.data[AK].note, 'tb <b>nota</b>', 'DRVF-NOTE carried verbatim (escaping is the renderer\'s job)');
  }
  ok('the note is carried verbatim');

  // two-pass cold-null: an existing alert → the speculative-null proposal is rejected, the real-value pass aborts, no overwrite
  {
    const prior = { type: 'driver_problem', order_id: OID, driver_uid: 'tb_prior', reason: 'other', reported_at: 1, created_at: 1 };
    const db = fakeDb({ [`orders/${OID}`]: ORDER, [AK]: prior });
    const r = await alertOnDriverProblem(db, { oid: OID, pid: PID, rec: rec(), now: NOW }, { resolveDriverName: names, log: quiet });
    assert.strictEqual(r.written, false, 'DRVF-COLDNULL an existing alert is never overwritten');
    assert.deepStrictEqual(db.data[AK], prior, 'DRVF-COLDNULL-INTACT the existing alert is byte-unchanged');
    assert.strictEqual(db.writes, 0, 'DRVF-COLDNULL-NOWRITE');
  }
  ok('two-pass cold-null: an existing alert aborts on the real value, no overwrite');

  // a replay after a commit → no duplicate; after a dismiss (remove) → re-created (the documented, accepted limitation)
  {
    const db = fakeDb({ [`orders/${OID}`]: ORDER });
    const args = { oid: OID, pid: PID, rec: rec(), now: NOW };
    await alertOnDriverProblem(db, args, { resolveDriverName: names, log: quiet });
    const again = await alertOnDriverProblem(db, args, { resolveDriverName: names, log: quiet });
    assert.strictEqual(again.written, false, 'DRVF-REPLAY a replay never duplicates');
    assert.strictEqual(Object.keys(db.data).filter((k) => k.startsWith('dispatcher_alerts/')).length, 1, 'DRVF-REPLAY-ONE');
    delete db.data[AK];   // Torre dismiss = remove()
    const after = await alertOnDriverProblem(db, args, { resolveDriverName: names, log: quiet });
    assert.strictEqual(after.written, true, 'DRVF-DISMISS-REPLAY a replay after a dismiss re-creates the alert (accepted)');
  }
  ok('replay → no duplicate; dismiss → replay re-creates (documented limitation)');

  // one alert PER REPORT: a second report on the same order is its own alert (the key carries the push id)
  {
    const db = fakeDb({ [`orders/${OID}`]: ORDER });
    await alertOnDriverProblem(db, { oid: OID, pid: 'tb_push_1', rec: rec(), now: NOW }, { resolveDriverName: names, log: quiet });
    const r2 = await alertOnDriverProblem(db, { oid: OID, pid: 'tb_push_2', rec: rec({ reason: 'other' }), now: NOW }, { resolveDriverName: names, log: quiet });
    assert.strictEqual(r2.written, true, 'DRVF-PER-REPORT a second report on the same order writes its own alert');
    assert.deepStrictEqual(Object.keys(db.data).filter((k) => k.startsWith('dispatcher_alerts/')).sort(),
      ['dispatcher_alerts/driver_problem_tb_order_1_tb_push_1', 'dispatcher_alerts/driver_problem_tb_order_1_tb_push_2'], 'DRVF-PER-REPORT-KEYS keyed driver_problem_{oid}_{pid}');
  }
  ok('one alert per report, keyed driver_problem_{oid}_{pid}');

  // a transaction error PROPAGATES (retry:true must see it)
  {
    const db = fakeDb({ [`orders/${OID}`]: ORDER }, { failTxn: true });
    await assert.rejects(alertOnDriverProblem(db, { oid: OID, pid: PID, rec: rec(), now: NOW }, { resolveDriverName: names, log: quiet }), /tb_txn_failed/, 'DRVF-RETHROW the alert write error must propagate');
  }
  ok('an alert-write error is rethrown (retry:true re-runs the trigger)');

  // malformed stored records → a log + no alert, no throw
  {
    // object-shaped invalid records FIRST, so a bypassed check fails on its own marker (not on a TypeError from a scalar)
    const bad = [rec({ reason: 'tb_unknown' }), rec({ by: '' }), rec({ by: 7 }), rec({ at: 'now' }), rec({ at: Infinity }),
      rec({ note: 5 }), rec({ note: 'x'.repeat(201) }), {}, [], 'x', null];
    for (const b of bad) {
      let warned = 0;
      const db = fakeDb({ [`orders/${OID}`]: ORDER });
      const r = await alertOnDriverProblem(db, { oid: OID, pid: PID, rec: b, now: NOW }, { resolveDriverName: names, log: { warn: () => { warned++; } } });
      assert.strictEqual(r.written, false, `DRVF-MALFORMED ${JSON.stringify(b)} → no alert`);
      assert.strictEqual(db.txns, 0, `DRVF-MALFORMED-NOTXN ${JSON.stringify(b)}`);
      assert.strictEqual(warned, 1, `DRVF-MALFORMED-LOG ${JSON.stringify(b)}`);
    }
    assert.strictEqual(validReport(rec({ note: 'x'.repeat(200) })), true, 'DRVF-NOTE200 a 200-char note is valid');
    assert.strictEqual(validReport(rec({ note: undefined })), true, 'DRVF-NONOTE no note is valid');
  }
  ok('malformed stored records → one log line, no alert, no throw; the 200-char boundary holds');

  // enrichment failures drop the field, never the alert
  {
    const db = fakeDb({ [`orders/${OID}`]: ORDER }, { failRead: [`orders/${OID}`] });
    const r = await alertOnDriverProblem(db, { oid: OID, pid: PID, rec: rec(), now: NOW }, { resolveDriverName: async () => { throw new Error('tb_name'); }, log: quiet })
      .catch((e) => assert.fail(`DRVF-ENRICH-FAIL an enrichment read failure must not reject the alert: ${e.message}`));
    assert.strictEqual(r.written, true, 'DRVF-ENRICH-FAIL the alert is still written');
    assert.deepStrictEqual(db.data[AK], { type: 'driver_problem', order_id: OID, driver_uid: UID, reason: 'customer_no_answer', reported_at: NOW - 5000, created_at: NOW }, 'DRVF-ENRICH-FAIL-SHAPE no enrichment fields');
  }
  {
    const db = fakeDb({});   // the order is gone
    const r = await alertOnDriverProblem(db, { oid: OID, pid: PID, rec: rec(), now: NOW }, { resolveDriverName: async () => null, log: quiet });
    assert.strictEqual(r.written, true, 'DRVF-ORDER-GONE the alert is still written');
    assert.strictEqual(db.data[AK].display_number, undefined, 'DRVF-ORDER-GONE-NODN');
  }
  ok('enrichment read failures / a missing order → the alert is still written without those fields');

  // an OLD `at` is accepted (no clock comparison); a task reassigned / deleted after the report still alerts
  {
    const db = fakeDb({ [`orders/${OID}`]: ORDER });   // no task at all (deleted on delivery)
    const r = await alertOnDriverProblem(db, { oid: OID, pid: PID, rec: rec({ at: 1 }), now: NOW }, { resolveDriverName: names, log: quiet });
    assert.strictEqual(r.written, true, 'DRVF-OLD-AT an old at is accepted');
    const db2 = fakeDb({ [`orders/${OID}`]: ORDER, [`tasks/${OID}_delivery`]: { ...TASKS[`tasks/${OID}_delivery`], assigned_driver_id: 'tb_other' } });
    const r2 = await alertOnDriverProblem(db2, { oid: OID, pid: PID, rec: rec(), now: NOW }, { resolveDriverName: names, log: quiet });
    assert.strictEqual(r2.written, true, 'DRVF-REASSIGNED a report whose task moved on still alerts');
  }
  ok('an old `at`, a deleted task, a reassigned task → the alert is still written');

  // order + task state byte-unchanged: the core only ever writes the alert key
  {
    const init = { [`orders/${OID}`]: ORDER, ...TASKS };
    const db = fakeDb(init);
    await alertOnDriverProblem(db, { oid: OID, pid: PID, rec: rec(), now: NOW }, { resolveDriverName: names, log: quiet });
    for (const k of Object.keys(init)) assert.deepStrictEqual(db.data[k], init[k], `DRVF-NO-STATE ${k} unchanged`);
    assert.deepStrictEqual(Object.keys(db.data).sort(), [...Object.keys(init), AK].sort(), 'DRVF-ONLY-ALERT only the alert key is added');
  }
  ok('order and task state byte-unchanged; only the alert key is written');

  // alert-prune leaves it alone (no detail → no referenced orders), including when the order is gone
  {
    const { alertOrderIds } = require('./alert-prune');
    const db = fakeDb({ [`orders/${OID}`]: ORDER });
    await alertOnDriverProblem(db, { oid: OID, pid: PID, rec: rec(), now: NOW }, { resolveDriverName: names, log: quiet });
    assert.deepStrictEqual(alertOrderIds(db.data[AK]), [], 'DRVF-PRUNE alert-prune sees no referenced order');
  }
  ok('alert-prune references no order → the alert is never auto-pruned');

  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
