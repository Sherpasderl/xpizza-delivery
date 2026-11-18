'use strict';
// PLAN-5f-pending-sweep r1 §4 GO-LIVE GATE (advisor Q-gate: BOTH, 11-14) — the marketing config writer refuses to switch offers ON until
// the owner has written platform_config/pending_sweep_exit (after the pending-sweep exit B1 + B2 is deployed): the price path's
// offer_changed refusals retire hosted attempts down the path that used to orphan pending orders.
//   CG-OFF:       offers_enabled false ⇒ written, with or without the marker (switching off is never gated)
//   CG-ON:        offers_enabled true and NO marker ⇒ { ok:false, code:'pending_sweep_exit_required' }, nothing written — a dry run too
//   CG-MARKER:    a well-formed marker ({ at: ms, by: string }) ⇒ the ON write proceeds; a malformed one ⇒ still refused
//   CG-UNREADABLE: the marker read fails ⇒ { ok:false, code:'unavailable' }, nothing written (fail closed)
// Run: node marketing/config-gate.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const CFG = require('./config');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ config-gate: exited without completing\n'); process.exitCode = 1; } });
const SET = (on) => ({ offers_enabled: on, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } });
const MARKER = 'platform_config/pending_sweep_exit';

(async () => {
  {
    const fake = createFakeDb({});
    assert.deepStrictEqual(await CFG.writeMarketingConfig(fake, { expected: 0, config: SET(false), actor: 'cli:op', now: 5 }), { ok: true, policy_version: 1 }, 'CG-OFF: no marker');
    fake.put(MARKER, { at: 1, by: 'owner' });
    assert.deepStrictEqual(await CFG.writeMarketingConfig(fake, { expected: 1, config: SET(false), actor: 'cli:op', now: 6 }), { ok: true, policy_version: 2 }, 'CG-OFF: with the marker');
  }
  ok('CG-OFF: switching offers off is never gated');

  {
    const fake = createFakeDb({});
    const r = await CFG.writeMarketingConfig(fake, { expected: 0, config: SET(true), actor: 'cli:op', now: 5 });
    assert.deepStrictEqual([r, fake.get(CFG.PATH)], [{ ok: false, code: 'pending_sweep_exit_required' }, null], '🔴 CG-ON: refused, nothing written');
    const d = await CFG.writeMarketingConfig(fake, { expected: 0, config: SET(true), actor: 'cli:op', now: 5, dryRun: true });
    assert.deepStrictEqual(d, { ok: false, code: 'pending_sweep_exit_required' }, 'CG-ON: a dry run is refused too');
  }
  ok('CG-ON: offers ON without the marker ⇒ pending_sweep_exit_required, nothing written (dry run too)');

  {
    for (const bad of [true, 'yes', {}, { at: 'x', by: 'owner' }, { at: 1 }, { at: 1, by: '' }]) {
      const fake = createFakeDb({}); fake.put(MARKER, bad);
      assert.deepStrictEqual(await CFG.writeMarketingConfig(fake, { expected: 0, config: SET(true), actor: 'cli:op', now: 5 }), { ok: false, code: 'pending_sweep_exit_required' }, `CG-MARKER: malformed ${JSON.stringify(bad)}`);
    }
    const fake = createFakeDb({}); fake.put(MARKER, { at: 1, by: 'owner' });
    assert.deepStrictEqual(await CFG.writeMarketingConfig(fake, { expected: 0, config: SET(true), actor: 'cli:op', now: 5 }), { ok: true, policy_version: 1 }, 'CG-MARKER: well-formed ⇒ written');
    assert.strictEqual((await CFG.readMarketingConfig(fake)).offers_enabled, true, 'CG-MARKER: on');
  }
  ok('CG-MARKER: a well-formed marker lets offers on; a malformed one does not');

  {
    const fake = createFakeDb({}); fake.failReads.add(MARKER);
    assert.deepStrictEqual([await CFG.writeMarketingConfig(fake, { expected: 0, config: SET(true), actor: 'cli:op', now: 5 }), fake.get(CFG.PATH)], [{ ok: false, code: 'unavailable' }, null], 'CG-UNREADABLE: fail closed');
  }
  ok('CG-UNREADABLE: an unreadable marker ⇒ unavailable, nothing written');

  FINISHED = true;
  console.log(`config-gate: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
