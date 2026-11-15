'use strict';
// The shared in-memory RTDB (merchant/_fake-db.js) — its OWN suite (PLAN-3a-merchant-reviews-v2 r6.2 §2). The transaction must behave
// like RTDB's compare-and-set: a value that changed between the updater's run and the put forces a RE-RUN of the updater on the new
// value. The additive one-shot hook afterUpdater(path, proposed) runs AFTER the updater and BEFORE the compare, so a test can commit a
// competing write exactly in that gap (onTxn runs BEFORE the updater, so it can never prove a re-run).
// Run: node merchant/_fake-db.test.js
const assert = require('assert');
const { createFakeDb } = require('./_fake-db');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 _fake-db: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });

(async () => {
  // ── 1. afterUpdater: a write committed between the updater's run and the put ⇒ the updater RE-RUNS on the winner's value ──
  {
    const fake = createFakeDb({ cfg: { v: 1 } });
    const seen = [];
    fake.hooks.afterUpdater = async (p, proposed) => {
      assert.strictEqual(p, 'cfg', 'the hook names the transaction path');
      assert.deepStrictEqual(proposed, { v: 2 }, 'the hook sees the first run\'s proposal');
      await fake.ref('cfg').set({ v: 10 });
    };
    const r = await fake.ref('cfg').transaction((cur) => { seen.push(cur); return { v: cur.v + 1 }; });
    assert.deepStrictEqual(seen, [{ v: 1 }, { v: 10 }], 'afterUpdater self-test: the updater ran TWICE and its second input is the injected value');
    assert.strictEqual(r.committed, true);
    assert.deepStrictEqual(fake.get('cfg'), { v: 11 }, 'afterUpdater self-test: the retry committed on the winner\'s value');
    assert.strictEqual(fake.hooks.afterUpdater, null, 'the hook is one-shot');
  }
  ok('afterUpdater: a competing write between the updater and the put ⇒ the updater re-runs on the winner\'s value (RTDB compare-and-set)');

  // ── 2. without the hook: byte-identical behaviour (one run, the proposal committed); onTxn unchanged ──
  {
    const fake = createFakeDb({ cfg: { v: 1 } });
    const seen = [];
    await fake.ref('cfg').transaction((cur) => { seen.push(cur); return { v: cur.v + 1 }; });
    assert.deepStrictEqual([seen, fake.get('cfg')], [[{ v: 1 }], { v: 2 }], 'no hook ⇒ one run, committed');
    const g = createFakeDb({ cfg: { v: 1 } });
    const seen2 = [];
    g.hooks.onTxn = async () => { await g.ref('cfg').set({ v: 5 }); };
    await g.ref('cfg').transaction((cur) => { seen2.push(cur); return { v: cur.v + 1 }; });
    assert.deepStrictEqual([seen2, g.get('cfg')], [[{ v: 5 }], { v: 6 }], 'onTxn still runs BEFORE the updater (one run on the injected value)');
  }
  ok('without afterUpdater the transaction is unchanged; onTxn keeps its before-the-updater timing');

  FINISHED = true;
  console.log(`_fake-db: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\n`); process.stderr.write(`_fake-db: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
