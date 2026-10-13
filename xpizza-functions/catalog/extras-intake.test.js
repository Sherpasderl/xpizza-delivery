'use strict';
// PER-PRODUCT EXTRAS — the intake check and its mode reader (catalog/extras-intake.js). Run: node catalog/extras-intake.test.js
const assert = require('assert');
const X = require('./extras-intake');
const { buildEligibilityDoc } = require('./extras-eligibility-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };

(async () => {
  // ── the mode reader (advisor ruling, plan rev 2.2 §4) ──
  {
    let t = 0; const now = () => t;
    for (const v of ['off', 'shadow', 'enforce']) assert.strictEqual((await X.createExtrasModeReader({ read: async () => v, now }).getMode()).mode, v, `${v} read`);
    // a SUCCESSFUL read of an absent node = off (orders flow)
    for (const v of [null, undefined]) assert.deepStrictEqual(await X.createExtrasModeReader({ read: async () => v, now }).getMode(), { mode: 'off', stale: false }, `absent (${v}) → off`);
    // cold + a failed read → UNKNOWN (never off)
    for (const [label, read] of [['malformed', async () => 'ON'], ['malformed object', async () => ({ mode: 'off' })], ['error', async () => { throw new Error('rtdb'); }], ['timeout', () => new Promise(() => {})]]) {
      const r = await quiet(() => X.createExtrasModeReader({ read, now, timeoutMs: 20 }).getMode());
      assert.deepStrictEqual(r, { mode: 'unknown', stale: false }, `🔴 cold + ${label} → UNKNOWN (never off)`);
    }
    // warm: a later failure keeps the last-known mode (stale) — within the bound; past it, UNKNOWN
    let v = 'enforce'; const rd = X.createExtrasModeReader({ read: async () => { if (v instanceof Error) throw v; return v; }, now, ttlMs: 100, maxStaleMs: 1000 });
    assert.strictEqual((await rd.getMode()).mode, 'enforce');
    t = 200; v = new Error('down');
    assert.deepStrictEqual(await quiet(() => rd.getMode()), { mode: 'enforce', stale: true }, 'warm + error → last-known (stale)');
    t = 1200;
    assert.deepStrictEqual(await quiet(() => rd.getMode()), { mode: 'unknown', stale: false }, 'warm + error PAST the bound → unknown');
    // warm on an absent node: absent is a successful read → off, not stale
    const ab = X.createExtrasModeReader({ read: async () => null, now });
    assert.deepStrictEqual(await ab.getMode(), { mode: 'off', stale: false });
    // single-flight: concurrent cold reads share one read
    let reads = 0; const sf = X.createExtrasModeReader({ read: async () => { reads += 1; await new Promise((r) => setTimeout(r, 10)); return 'shadow'; }, now });
    await Promise.all([sf.getMode(), sf.getMode(), sf.getMode()]);
    assert.strictEqual(reads, 1, 'single-flight');
    ok('mode reader: off/shadow/enforce read; an ABSENT node (successful read) → off; cold malformed/error/timeout → UNKNOWN (never off); warm failure → last-known within 10 min, then unknown; single-flight');
  }

  // ── the check ──
  const src = buildSourceFromCode('x_pizza');
  src.structure.exposure.item_overrides.Margherita = { deny_extras: ['Salsa Roja'] };
  const doc = buildEligibilityDoc(src);
  const tables = { menu: MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza };
  const env = () => ({ versionId: 'v7' });
  let readsFor = [];
  const readEligibility = async (rid, vid) => { readsFor.push(vid); return vid === 'v7' ? doc : null; };
  const line = (name, extras) => ({ name, qty: 1, extras: extras.map((e) => ({ name: e })) });
  const run = (mode, items, extra = {}) => X.extrasCheck({ mode: { mode }, tables, items, rid: 'x_pizza', envelopeOf: env, readEligibility, ...extra });
  {
    readsFor = [];
    assert.deepStrictEqual((await run('off', [line('Margherita', ['Salsa Roja'])])).outcome, 'skip');
    assert.deepStrictEqual(readsFor, [], 'off reads NOTHING');
    const d = await run('enforce', [line('Margherita', ['Salsa Roja', 'Pepperoni']), line('Pepperoni', ['Salsa Roja'])]);
    assert.strictEqual(d.outcome, 'denied');
    assert.deepStrictEqual(d.denied, [{ item: 'Margherita', extra: 'Salsa Roja' }], 'only the excluded pair is denied');
    assert.deepStrictEqual(readsFor, ['v7'], 'read for EXACTLY the pricing version');
    assert.strictEqual((await run('enforce', [line('Margherita', ['Pepperoni'])])).outcome, 'allow');
    const nu = await run('enforce', [line('Nutella', ['Mozzarella'])]);
    assert.strictEqual(nu.outcome, 'denied', 'Nutella takes nothing (legacy "*")');
    ok('check: off reads nothing; enforce reads the pricing version’s document and denies exactly the excluded pairs (incl. Nutella), allows the rest');
  }
  {
    assert.strictEqual((await run('enforce', [line('Margherita', [])], { envelopeOf: () => ({ versionId: 'v-old' }) })).outcome, 'unavailable', '🔴 a pre-feature version (no document) is UNAVAILABLE, never unrestricted');
    assert.strictEqual((await run('enforce', [line('Margherita', [])], { envelopeOf: () => undefined })).outcome, 'unavailable', 'no envelope / flat pricing → unavailable');
    assert.strictEqual((await run('enforce', [line('Margherita', [])], { readEligibility: async () => { throw new Error('fs'); } })).outcome, 'unavailable', 'a read error → unavailable');
    assert.strictEqual((await run('enforce', [line('Margherita', [])], { readEligibility: () => new Promise(() => {}), deadlineMs: 20 })).outcome, 'unavailable', 'a hung read → unavailable at the deadline');
    const u = await run('unknown', [line('Margherita', [])]);
    assert.ok(u.outcome === 'unavailable' && X.refuses(u), '🔴 an UNKNOWN mode refuses a fresh issuance (never silently skipped)');
    ok('check: an absent document / no version / a read error / a hung read → unavailable; an UNKNOWN mode → unavailable and refusing');
  }
  {
    const sh = await quiet(() => run('shadow', [line('Margherita', ['Salsa Roja'])]));
    assert.ok(sh.outcome === 'denied' && !X.refuses(sh), 'shadow decides but never refuses');
    const en = await run('enforce', [line('Margherita', ['Salsa Roja'])]);
    assert.ok(X.refuses(en) && X.refusalStatus(en) === 409 && X.refusalBody(en).error === 'extra_not_allowed' && X.guardReason(en) === 'extra_not_allowed');
    const un = await run('enforce', [line('Margherita', [])], { envelopeOf: () => undefined });
    assert.ok(X.refusalStatus(un) === 503 && X.refusalBody(un).retryable === true && X.guardReason(un) === 'eligibility_unavailable');
    assert.strictEqual(X.guardReason(sh), null, 'shadow arms no guard');
    ok('decisions: shadow never refuses; enforce denied → 409 extra_not_allowed (+lines); unavailable → 503 retryable eligibility_unavailable; the acquire guard reason follows');
  }
  {
    // la_musa addresses by ID — decided by DATA (the tables price ids), no brand literal
    const lm = buildSourceFromCode('la_musa'); lm.structure.exposure.item_overrides.rice_02 = { deny_extras: ['rice_white'] };
    const ldoc = buildEligibilityDoc(lm);
    const r = await X.extrasCheck({ mode: { mode: 'enforce' }, tables: { menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa },
      items: [{ id: 'rice_02', qty: 1, extras: [{ id: 'rice_white', qty: 1 }, { id: 'sauce_aioli', qty: 1 }] }], rid: 'la_musa', envelopeOf: env, readEligibility: async () => ldoc });
    assert.deepStrictEqual(r.denied, [{ item: 'rice_02', extra: 'rice_white' }], 'la_musa ids: only rice_white denied');
    ok('la_musa: lines addressed by id (decided by the tables, not the brand) — only the excluded extra is denied');
  }
  console.log(`\nextras-intake: OK (${n})`);
})().catch((e) => { console.error('extras-intake FAILED:', e); process.exit(1); });
