'use strict';
// PER-PRODUCT EXTRAS — the intake check and its mode reader (catalog/extras-intake.js). Run: node catalog/extras-intake.test.js
const assert = require('assert');
const X = require('./extras-intake');
const { buildEligibilityDoc } = require('./extras-eligibility-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, computeServerTotal } = require('../menu-pricing');
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
    ok('la_musa: lines addressed by id (pricing\u2019s own resolver) — only the excluded extra is denied');
  }
  {
    // FORGED id/name (codex stage-2 r1 P1-1): the line is judged by the key it is CHARGED by — pricing's own resolvers. For each
    // forgery the denied pair is reported AND computeServerTotal charges exactly that extra (the judged key == the charged key).
    const lm = buildSourceFromCode('la_musa'); lm.structure.exposure.item_overrides.rice_02 = { deny_extras: ['rice_white'] };
    const BR = {
      x_pizza: { doc, tables, item: 'Margherita', denied: 'Salsa Roja', ok: 'Pepperoni', free: 'Pepperoni',
        forgeExtra: () => ({ name: 'Margherita', qty: 1, extras: [{ name: 'Salsa Roja', id: 'Pepperoni' }] }),
        forgeItem: () => ({ name: 'Margherita', id: 'Pepperoni', qty: 1, extras: [{ name: 'Salsa Roja' }] }) },
      la_musa: { doc: buildEligibilityDoc(lm), tables: { menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa }, item: 'rice_02', denied: 'rice_white', ok: 'sauce_aioli',
        forgeExtra: () => ({ id: 'rice_02', qty: 1, extras: [{ id: 'rice_white', name: 'sauce_aioli', qty: 1 }] }),
        forgeItem: () => ({ id: 'rice_02', name: 'rice_03', qty: 1, extras: [{ id: 'rice_white', qty: 1 }] }) },
    };
    for (const [rid, b] of Object.entries(BR)) {
      for (const forge of ['forgeExtra', 'forgeItem']) {
        const r = await X.extrasCheck({ mode: { mode: 'enforce' }, tables: b.tables, items: [b[forge]()], rid, envelopeOf: env, readEligibility: async () => b.doc });
        assert.deepStrictEqual(r.denied, [{ item: b.item, extra: b.denied }], `🔴 ${rid} ${forge}: judged by the CHARGED keys`);
        // the charge agrees: the forged line costs exactly the item + the DENIED extra
        const t = computeServerTotal([b[forge]()], rid, { restaurantId: rid, ...b.tables });
        const want = b.tables.menu[b.item] + (b.tables.extras[b.denied] * (rid === 'la_musa' ? 1 : 1));
        assert.strictEqual(t.total, want, `${rid} ${forge}: pricing charges the item + the denied extra (${t.total} vs ${want})`);
      }
    }
    // sensitivity: the OLD id-preferring resolution would have judged the x_pizza forgery as the allowed Pepperoni
    const preferId = (e) => (e.id !== undefined && Object.prototype.hasOwnProperty.call(tables.extras, String(e.id)) ? String(e.id) : e.name);
    assert.strictEqual(preferId(BR.x_pizza.forgeExtra().extras[0]), 'Pepperoni', 'premise — an id-preferring resolver picks the forged id');
    ok('forged id/name: x_pizza (a forged id) and la_musa (a forged name), extra AND item — each judged by the key pricing charges, and computeServerTotal charges that same denied extra');
  }
  {
    // codex stage-2 r1 P2-4 / P2-6: the shadow generation is the ORDERS client's compat, read like isBelowFloor; refusals go out one way
    assert.strictEqual(X.ordersClientGen({ app: 'orders', compat: 7 }), 7);
    assert.strictEqual(X.ordersClientGen({ app: 'portal', compat: 7 }), null, 'a foreign app → null');
    assert.strictEqual(X.ordersClientGen({ app: null, compat: null, headerless: true }), null, 'header-less → null');
    const logs = []; const l = console.log; console.log = (...a) => logs.push(a);
    try { X.logShadow('quoteOrder', 'x_pizza', { mode: 'shadow', outcome: 'denied', versionId: 'v7', denied: [] }, X.ordersClientGen({ app: 'orders', compat: 3 })); } finally { console.log = l; }
    assert.strictEqual(JSON.parse(logs[0][1]).client_gen, 3, 'the shadow record carries it');
    const fakeRes = () => { const r = { h: {}, set(k, v) { r.h[k] = v; return r; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
    const d = fakeRes(); X.sendRefusal(d, { outcome: 'denied', denied: [{ item: 'a', extra: 'b' }] }, { ok: false });
    assert.ok(d.code === 409 && d.body.ok === false && d.body.error === 'extra_not_allowed' && d.body.lines.length === 1 && !d.h['Retry-After']);
    const u = fakeRes(); X.sendRefusal(u, { outcome: 'unavailable', denied: [] }, { ok: false });
    assert.ok(u.code === 503 && u.body.retryable === true && u.h['Retry-After'] === '2');
    ok('ordersClientGen = the orders compat (foreign / header-less → null) and reaches the shadow record; sendRefusal: 409 +lines / 503 + Retry-After');
  }
  console.log(`\nextras-intake: OK (${n})`);
})().catch((e) => { console.error('extras-intake FAILED:', e); process.exit(1); });
