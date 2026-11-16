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
    assert.deepStrictEqual(await CFG.readMarketingConfig(db), { policy_version: 1, ...SET, audience_enabled: false, thresholds: { ...SET.thresholds, paused_max_h_30d: 4 } }, 'the reader returns what was written, «not paused-heavy» defaulted to 4 h (advisor 11-14: the merit bar)');
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
    // PLAN-5f-offer-audience r2 §5 (advisor 11-16): `audience_enabled` — OPTIONAL (absent = false), boolean, the same fail-closed reader;
    // the program is ON only with offers_enabled too (audienceEnabled — 5f's pricing reads it)
    { const f2 = createFakeDb({}); const d2 = prodDb(f2);
      await d2.ref('platform_config/pending_sweep_exit').set({ at: 1, by: 'test' });
      assert.strictEqual(CFG.OFF.audience_enabled, false, 'AUDCFG-OFF-STATES-IT');
      assert.strictEqual(CFG.audienceEnabled(await CFG.readMarketingConfig(d2)), false, 'AUDCFG-ABSENT-NODE-FALSE');
      assert.strictEqual((await CFG.writeMarketingConfig(d2, { expected: 0, config: SET, actor: 'cli:op', now: 1 })).ok, true, 'premise: written without the key');
      const r0 = await CFG.readMarketingConfig(d2);
      assert.deepStrictEqual([r0.audience_enabled, CFG.audienceEnabled(r0), CFG.switchesOf(r0).audience_enabled], [false, false, false], '🔴 AUDCFG-ABSENT-KEY-FALSE');
      assert.strictEqual((await CFG.writeMarketingConfig(d2, { expected: 1, config: { ...SET, audience_enabled: true }, actor: 'cli:op', now: 2 })).ok, true, 'premise: switched ON by the real writer');
      const r1 = await CFG.readMarketingConfig(d2);
      assert.deepStrictEqual([r1.audience_enabled, CFG.audienceEnabled(r1), CFG.switchesOf(r1).audience_enabled], [true, true, true], '🔴 AUDCFG-ON');
      assert.strictEqual(f2.get(CFG.PATH).history[0].new.audience_enabled, true, 'AUDCFG-HISTORY-RECORDS-IT');
      assert.strictEqual((await CFG.writeMarketingConfig(d2, { expected: 2, config: { ...SET, offers_enabled: false, audience_enabled: true }, actor: 'cli:op', now: 3 })).ok, true, 'premise: offers OFF, audience ON');
      const r2 = await CFG.readMarketingConfig(d2);
      assert.deepStrictEqual([r2.audience_enabled, CFG.audienceEnabled(r2)], [true, false], '🔴 AUDCFG-NEEDS-OFFERS (program ON ⇔ offers_enabled ∧ audience_enabled)');
      for (const bad of ['true', 1, null, {}]) {
        assert.deepStrictEqual(await CFG.writeMarketingConfig(d2, { expected: 3, config: { ...SET, audience_enabled: bad }, actor: 'cli:op', now: 4 }), { ok: false, code: 'bad_config' }, `🔴 AUDCFG-WRITER-REFUSES ${JSON.stringify(bad)}`);
        const stored = { ...f2.get(CFG.PATH), audience_enabled: bad };
        assert.deepStrictEqual(CFG.parseConfig(stored), { ...CFG.OFF }, `🔴 AUDCFG-MALFORMED-OFF ${JSON.stringify(bad)} (a malformed node never enables ANY switch)`);
      }
      f2.failReads.add(CFG.PATH);
      assert.strictEqual(CFG.audienceEnabled(await CFG.readMarketingConfig(d2)), false, '🔴 AUDCFG-READ-FAILURE-FALSE'); }
    ok('audience_enabled: optional (absent = false), stated, recorded in the history; ON needs offers_enabled too; a non-boolean is refused by the writer and makes a stored node OFF; a read failure is OFF');
    FINISHED = true;
    console.log(`config: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
