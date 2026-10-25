'use strict';
// BUILD-stacked-seq-server r5 T9 / D10 — the stacks/ retention pass (runStackPass), isolated inside runRetentionSweep:
//   refused   → deleted once past expires_at + 1 day;
//   committed → deleted once decided_at is older than 7 days AND neither member's delivery task exists (the detector and the
//               reuse rule may still need it while either does);
//   every delete is a transaction that re-checks the record (a record re-written meanwhile is kept);
//   a failure in this pass never touches the task pass's result.
// Run: node sequencing/retention.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const { runStackPass, DAY_MS } = require('./retention');
const { runRetentionSweep } = require('../retention-sweep');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('stack-retention: FAILED — exited without completing'); process.exitCode = 1; } });

const NOW = 10_000 * DAY_MS;
const refused = (expires_at) => ({ state: 'refused', driver_uid: 'd', pair: ['a', 'b'], reason: 'over_6min', expires_at });
const committed = (decided_at, pair = ['a', 'b']) => ({ state: 'committed', driver_uid: 'd', pair, ranks: { [pair[0]]: 1, [pair[1]]: 2 }, decided_at });

(async () => {
  // ── 1. which records go ──────────────────────────────────────────────────────────────────────────────────────
  {
    const db = createFakeDb({
      stacks: {
        r_old: refused(NOW - DAY_MS - 1), r_young: refused(NOW - DAY_MS + 1), r_live: refused(NOW + 60000),
        c_old_gone: committed(NOW - 7 * DAY_MS - 1, ['x1', 'y1']),
        c_old_one_task: committed(NOW - 7 * DAY_MS - 1, ['x2', 'y2']),
        c_young: committed(NOW - 7 * DAY_MS + 1, ['x3', 'y3']),
        junk: { state: 'weird' }, junk2: 'x',
      },
      tasks: { y2_delivery: { order_id: 'y2', type: 'delivery', status: 'accepted' } },
    });
    const r = await runStackPass(db, NOW);
    assert.deepStrictEqual(Object.keys(db.get('stacks')).sort(), ['c_old_one_task', 'c_young', 'junk', 'junk2', 'r_live', 'r_young']);
    assert.deepStrictEqual(r, { scanned: 8, deleted: 2, kept: 6 });
    ok('refused past expires_at + 1 d → deleted; committed > 7 d with NO member task → deleted; a member task alive / younger / unknown shapes → kept');
  }

  // ── 2. the delete re-checks: a record re-written between the scan and the delete is kept ──────────────────
  {
    const db = createFakeDb({ stacks: { r: refused(NOW - 2 * DAY_MS) } });
    db.hooks.onTxn = async () => { db.put('stacks/r', committed(NOW)); };   // a fresh committed decision lands mid-pass
    await runStackPass(db, NOW);
    assert.strictEqual(db.get('stacks/r/state'), 'committed', 'a re-written record is kept');
    const db2 = createFakeDb({ stacks: { c: committed(NOW - 8 * DAY_MS, ['p', 'q']) } });
    db2.hooks.onTxn = async () => { db2.put('stacks/c/decided_at', NOW); };
    await runStackPass(db2, NOW);
    assert.ok(db2.get('stacks/c'), 'a committed record whose decided_at moved is kept');
    ok('every delete is a transaction re-checking the record: a refusal turned committed, or a moved decided_at, is kept');
  }

  // ── 3. isolated inside runRetentionSweep: a failure never changes the task pass's result ──────────────────
  {
    const seed = { config: { retention: { tasks_mode: 'dry_run' }, stack_sequencing_enabled: true }, tasks: {}, orders: {}, stacks: { r_old: refused(1) } };
    const good = createFakeDb(seed); const a = await runRetentionSweep(good, { healTerminalStatuses: new Set(['cancelled']) });
    assert.strictEqual(good.get('stacks/r_old'), null, 'the stack pass ran from the sweep');
    const bad = createFakeDb(seed); bad.failReads.add('stacks');
    const b = await runRetentionSweep(bad, { healTerminalStatuses: new Set(['cancelled']) });
    assert.deepStrictEqual(b, a, 'a failing stack pass leaves the task pass result unchanged');
    ok('runRetentionSweep runs the stack pass in its own try/catch: it deletes, and a failure leaves the task pass result unchanged');
  }

  // ── 4. r1 P2: a COLD cache — the SDK's first transaction call is a speculative null; the delete still lands ─────────
  {
    // models the Admin SDK: fn(null) first; undefined → ABORT (nothing written); any other value on a non-null node → the
    // server rejects it and the SDK re-runs fn with the real value (here: the fake's own transaction)
    const cold = (db) => ({ ...db, ref: (p) => { const r = db.ref(p); if (!p.startsWith('stacks/')) return r; return { ...r, transaction: async (fn) => {
      const spec = fn(null);
      if (spec === undefined) return { committed: false, snapshot: { val: () => null } };
      if (db.get(p) === null) { db.put(p, spec); return { committed: true, snapshot: { val: () => spec } }; }
      return r.transaction(fn);
    } }; } });
    const db = createFakeDb({
      stacks: { r_old: refused(NOW - 2 * DAY_MS), c_old: committed(NOW - 8 * DAY_MS, ['p1', 'q1']), r_live: refused(NOW + 60000), c_live: committed(NOW - 8 * DAY_MS, ['p2', 'q2']) },
      tasks: { q2_delivery: { order_id: 'q2', type: 'delivery', status: 'accepted' } },
    });
    const r = await runStackPass(cold(db), NOW);
    assert.deepStrictEqual(Object.keys(db.get('stacks')).sort(), ['c_live', 'r_live'], 'cold cache: both expired records deleted, the live ones kept');
    assert.deepStrictEqual(r, { scanned: 4, deleted: 2, kept: 2 });
    // a record re-written between the scan and the delete is still kept on a cold cache (the guards run on the real value)
    const db2 = createFakeDb({ stacks: { r: refused(NOW - 2 * DAY_MS) } });
    db2.hooks.onTxn = async () => { db2.put('stacks/r', committed(NOW)); };
    await runStackPass(cold(db2), NOW);
    assert.strictEqual(db2.get('stacks/r/state'), 'committed', 'cold cache: a re-written record is kept');
    ok('a cold cache (speculative null first): expired records are deleted, live and re-written ones kept');
  }

  // ── 5. r1 P2: flag OFF (absent / false) → the sweep reads NOTHING under stacks/ and deletes nothing ──────────────────
  {
    for (const flag of ['ABSENT', false]) {
      const config = { retention: { tasks_mode: 'dry_run' } }; if (flag !== 'ABSENT') config.stack_sequencing_enabled = flag;
      const hist = { r_old: refused(1), c_old: committed(1, ['h1', 'h2']), r_mid: refused(NOW - 3 * DAY_MS) };
      const db = createFakeDb({ config, tasks: {}, orders: {}, stacks: JSON.parse(JSON.stringify(hist)) });
      const paths = []; const spy = { ...db, ref: (p) => { paths.push(String(p)); return db.ref(p); } };
      const out = await runRetentionSweep(spy, { healTerminalStatuses: new Set(['cancelled']) });
      assert.deepStrictEqual(paths.filter((p) => p.startsWith('stacks')), [], `flag ${flag}: zero reads / writes under stacks/`);
      assert.deepStrictEqual(db.get('stacks'), hist, `flag ${flag}: zero deletes`);
      const base = createFakeDb({ config, tasks: {}, orders: {} });
      assert.deepStrictEqual(out, await runRetentionSweep(base, { healTerminalStatuses: new Set(['cancelled']) }), `flag ${flag}: the task pass result is today's`);
    }
    ok('flag absent / false: runRetentionSweep reads nothing under stacks/ and deletes no historical record; the task pass result unchanged');
  }

  FINISHED = true;
  console.log(`\nstack-retention: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
