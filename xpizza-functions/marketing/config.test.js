'use strict';
// PLAN-3a-marketing-server r0 §2.6 — platform_config/marketing: the owner's version-CAS writer and the fail-closed reader.
// The node is written ONLY by the real writer (writeMarketingConfig); malformed nodes are the off-shape values the reader must refuse.
// Production transaction semantics (the SDK's uncached first run sees null) as offers-core.test.js. Run: node marketing/config.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const CFG = require('./config');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ config: exited without completing (a hang)\n'); process.exitCode = 1; } });
function prodDb(fake) {
  return { ref(p = '') { const r = fake.ref(p); return { ...r, async transaction(fn) {
    const cold = fn(null);
    if (cold === undefined) return { committed: false, snapshot: { val: () => null } };
    if (fake.get(p) === null) { fake.put(p, cold); return { committed: true, snapshot: { val: () => fake.get(p) } }; }
    return r.transaction(fn);
  } }; } };
}
const SET = { offers_enabled: true, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } };

(async () => {
  try {
    const fake = createFakeDb({}); const db = prodDb(fake);
    assert.deepStrictEqual(await CFG.readMarketingConfig(db), { ...CFG.OFF }, 'an absent node is OFF');
    await db.ref('platform_config/pending_sweep_exit').set({ at: 1, by: 'test' });   // the owner's go-live marker (PLAN-5f-pending-sweep r1 §4)
    const dry = await CFG.writeMarketingConfig(db, { expected: 0, config: SET, actor: 'cli:op', now: 5, dryRun: true });
    assert.deepStrictEqual([dry.ok, dry.dry_run, fake.get(CFG.PATH)], [true, true, null], 'a dry run writes nothing');
    const w1 = await CFG.writeMarketingConfig(db, { expected: 0, config: SET, actor: 'cli:op', now: 5 });
    assert.deepStrictEqual(w1, { ok: true, policy_version: 1 }, 'create at expected 0');
    assert.deepStrictEqual(await CFG.readMarketingConfig(db), { policy_version: 1, ...SET, thresholds: { ...SET.thresholds, paused_max_h_30d: 4 } }, 'the reader returns what was written, «not paused-heavy» defaulted to 4 h (advisor 11-14: the merit bar)');
    ok('create (expected 0) after a dry run that wrote nothing; read back exactly');
    const stale = await CFG.writeMarketingConfig(db, { expected: 0, config: { ...SET, anuncio_enabled: true }, actor: 'cli:op', now: 6 });
    assert.deepStrictEqual(stale, { ok: false, code: 'superseded', current: 1 }, 'a stale expected ⇒ superseded');
    const w2 = await CFG.writeMarketingConfig(db, { expected: 1, config: { ...SET, offers_enabled: false }, actor: 'cli:op2', now: 7 });
    assert.deepStrictEqual(w2, { ok: true, policy_version: 2 });
    const node = fake.get(CFG.PATH);
    assert.deepStrictEqual(node.history.map((h) => [h.prev_version, h.new_version, h.actor, h.new.offers_enabled]), [[1, 2, 'cli:op2', false], [0, 1, 'cli:op', true]], 'the history: newest first, who and what');
    for (let i = 2; i < 14; i++) assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: i, config: SET, actor: 'cli:op', now: 8 + i })).ok, true);
    assert.strictEqual(fake.get(CFG.PATH).history.length, CFG.HISTORY_MAX, 'the history is bounded');
    ok('CAS: stale expected superseded; history newest first and bounded');
    for (const node2 of [{ ...SET }, { policy_version: 0, ...SET }, { policy_version: 3, ...SET, collections_enabled: 1 }, 'on', { policy_version: 3, ...SET, thresholds: null }]) {
      assert.deepStrictEqual(CFG.parseConfig(node2), { ...CFG.OFF }, `a malformed stored node is OFF: ${JSON.stringify(node2)}`);
    }
    for (const bad of [{ ...SET, offers_enabled: 'true' }, { ...SET, anuncio_price_cents: 450.5 }, { ...SET, thresholds: { rating_min: 6, min_ratings: 10 } }, { ...SET, extra: 1 }]) {
      assert.deepStrictEqual(await CFG.writeMarketingConfig(db, { expected: 14, config: bad, actor: 'cli:op', now: 30 }), { ok: false, code: 'bad_config' }, `refused: ${JSON.stringify(bad)}`);
    }
    fake.put(CFG.PATH, 'garbage');
    assert.deepStrictEqual(await CFG.writeMarketingConfig(db, { expected: 14, config: SET, actor: 'cli:op', now: 31 }), { ok: false, code: 'current_malformed' }, 'a malformed stored node is never overwritten blindly');
    ok('bad configs refused; malformed stored nodes read as OFF and are not overwritten');
    FINISHED = true;
    console.log(`config: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
