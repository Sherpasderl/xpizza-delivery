'use strict';
// Calificaciones v2 — platform_config/ratings, the owner's config writer (PLAN-3a-merchant-reviews-v2 r1 §0 B1, r6.1 §1, r6.2 §2).
// The REAL writer (ratings-config.writeRatingsConfig) over merchant/_fake-db, whose transaction is RTDB's compare-and-set: a value
// that moves between the updater's run and the put re-runs the updater (afterUpdater commits a competing write in that exact gap).
//   - enabling disclosure (disclosure_v 1) needs a well-formed policy_ack and stamps disclosure_cutover_at in the SAME transaction;
//   - the cut-over, once written, is carried forward by every write and can never be changed or removed (cutover_immutable).
// Run: node ratings/ratings-config.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const RC = require('./ratings-config');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 ratings-config: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });

const ACK = { at: 1_700_000_000_000, by: 'owner', policy_url: 'https://sherpa.example/privacidad' };
const C1 = 1_800_000_000_000, C2 = 1_800_000_500_000;
const cfg = (fake) => fake.get(RC.PATH);
const write = (fake, payload, stamp) => RC.writeRatingsConfig(fake, { payload, stamp });

(async () => {
  // ── 1. the enable stamps the cut-over WITH disclosure_v + policy_ack, in one transaction; an ack is required ──
  {
    const fake = createFakeDb();
    const noAck = await write(fake, { disclosure_v: 1 }, C1);
    assert.deepStrictEqual([noAck.ok, noAck.error, cfg(fake)], [false, 'policy_ack_required', null], 'stamped with the enable: disclosure_v 1 without a policy_ack ⇒ refused, nothing written');
    const badAck = await write(fake, { disclosure_v: 1, policy_ack: { ...ACK, by: '' } }, C1);
    assert.deepStrictEqual([badAck.ok, badAck.error, cfg(fake)], [false, 'policy_ack_required', null], 'a malformed ack (by \'\') ⇒ refused');
    const own = await write(fake, { disclosure_v: 1, policy_ack: ACK, disclosure_cutover_at: C2 }, C1);
    assert.deepStrictEqual([own.ok, own.error, cfg(fake)], [false, 'cutover_immutable', null], 'a payload naming its OWN cut-over ⇒ refused (the cut-over is stamped by the writer only)');
    const r = await write(fake, { disclosure_v: 1, policy_ack: ACK }, C1);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(cfg(fake), { disclosure_v: 1, policy_ack: ACK, disclosure_cutover_at: C1 }, 'stamped with the enable: the accepted write carries disclosure_v, policy_ack AND the cut-over');
  }
  ok('the enable: disclosure_v 1 needs a well-formed policy_ack and is stamped with disclosure_cutover_at in the same write; a payload cut-over is refused');

  // ── 2. immutability: a 2nd enable, an off→on cycle, an explicit change and a removal ⇒ refused / unchanged ──
  {
    const fake = createFakeDb();
    await write(fake, { disclosure_v: 1, policy_ack: ACK }, C1);
    await write(fake, { disclosure_v: 1, policy_ack: ACK }, C2);
    assert.strictEqual(cfg(fake).disclosure_cutover_at, C1, 'the cutover is immutable: a 2nd enable keeps the first cut-over');
    await write(fake, { disclosure_v: 0, policy_ack: ACK }, C2);
    assert.deepStrictEqual(cfg(fake), { disclosure_v: 0, policy_ack: ACK, disclosure_cutover_at: C1 }, 'the cutover is immutable: a disable keeps it');
    await write(fake, { disclosure_v: 1, policy_ack: ACK }, C2);
    assert.strictEqual(cfg(fake).disclosure_cutover_at, C1, 'the cutover is immutable: an off→on cycle keeps the first cut-over');
    const before = cfg(fake);
    const chg = await write(fake, { disclosure_v: 1, policy_ack: ACK, disclosure_cutover_at: C2 }, C2);
    assert.deepStrictEqual([chg.ok, chg.error, cfg(fake)], [false, 'cutover_immutable', before], 'the cutover is immutable: an explicit change ⇒ cutover_immutable, nothing written');
    const rm = await write(fake, { disclosure_v: 0, disclosure_cutover_at: null }, C2);
    assert.deepStrictEqual([rm.ok, rm.error, cfg(fake)], [false, 'cutover_immutable', before], 'the cutover is immutable: a removal attempt ⇒ cutover_immutable, nothing written');
    const same = await write(fake, { disclosure_v: 1, policy_ack: ACK, disclosure_cutover_at: C1 }, C2);
    assert.deepStrictEqual([same.ok, cfg(fake)], [true, before], 'naming the SAME cut-over is accepted (byte-identical)');
  }
  ok('the cut-over is immutable: a 2nd enable, off→on, an explicit change and a removal never move it');

  // ── 3. a stale whole-node replacement (a payload read BEFORE the enable) ⇒ the cut-over is carried forward ──
  {
    const fake = createFakeDb();
    const stale = { disclosure_v: 0 };   // read while nothing was enabled
    await write(fake, { disclosure_v: 1, policy_ack: ACK }, C1);
    const r = await write(fake, stale, C2);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(cfg(fake), { disclosure_v: 0, disclosure_cutover_at: C1 }, 'a stale whole-node replacement: its fields applied, the cutover is unchanged');
  }
  ok('a stale whole-node replacement applies its fields and carries the cut-over forward');

  // ── 4. competing enables (r6.2 §2): A's updater runs (cut-over absent ⇒ proposes C1); B commits C2 in the gap; A re-runs ⇒ keeps C2 ──
  {
    const fake = createFakeDb();
    const ACK_A = { ...ACK, by: 'owner-a' };
    fake.hooks.afterUpdater = async () => { const b = await write(fake, { disclosure_v: 1, policy_ack: ACK }, C2); assert.strictEqual(b.ok, true, 'premise: B committed'); };
    const a = await write(fake, { disclosure_v: 1, policy_ack: ACK_A }, C1);
    assert.strictEqual(a.ok, true);
    assert.deepStrictEqual(cfg(fake), { disclosure_v: 1, policy_ack: ACK_A, disclosure_cutover_at: C2 }, 'competing enables: ONE cut-over = the first committer\'s (B), A\'s own fields applied without moving it');
  }
  ok('competing enables serialise on the node: one cut-over (the first committer\'s); the loser\'s fields applied on top');

  // ── 5. payload shape: unknown keys / a bad disclosure_v ⇒ bad_payload; the writer never throws on a malformed stored node ──
  {
    const fake = createFakeDb();
    for (const p of [{ disclosure_v: 2 }, { disclosure_v: 1, policy_ack: ACK, extra: 1 }, null, { policy_ack: ACK }]) {
      const r = await write(fake, p, C1);
      assert.deepStrictEqual([r.ok, r.error, cfg(fake)], [false, 'bad_payload', null], `bad payload ${JSON.stringify(p)} ⇒ refused`);
    }
    const g = createFakeDb({ platform_config: { ratings: { disclosure_v: 1, policy_ack: ACK, disclosure_cutover_at: 'x' } } });
    await write(g, { disclosure_v: 0, policy_ack: ACK }, C1);
    assert.strictEqual(cfg(g).disclosure_cutover_at, 'x', 'a stored (malformed) cut-over is carried forward byte-identical, never replaced');
  }
  ok('payload shape is exact; a malformed stored cut-over is still carried forward, never replaced');

  // ── 6. the dry run plans with the SAME rule and writes nothing ──
  {
    const fake = createFakeDb({ platform_config: { ratings: { disclosure_v: 1, policy_ack: ACK, disclosure_cutover_at: C1 } } });
    const p = RC.planRatingsConfig(cfg(fake), { payload: { disclosure_v: 1, policy_ack: ACK, disclosure_cutover_at: C2 }, stamp: C2 });
    assert.deepStrictEqual([p.ok, p.error], [false, 'cutover_immutable'], 'the dry run refuses what the write refuses');
    assert.strictEqual(cfg(fake).disclosure_cutover_at, C1);
  }
  ok('the dry run applies the same rule and writes nothing');

  FINISHED = true;
  console.log(`ratings-config: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\n`); process.stderr.write(`ratings-config: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
