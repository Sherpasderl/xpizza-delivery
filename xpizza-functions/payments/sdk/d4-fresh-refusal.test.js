'use strict';
// D4 §A3 (PLAN-sdk-d4-r11) — the deferred refusals of a FRESH issuance become ONE exported function, freshIssueRefusal, that the
// hosted acquire and the SDK finish (B4) both call. Behaviour-preserving: the BASE acquireHostedAttempt (53edc481, compiled from
// git) and the tip answer every flag combination with the same outcome and leave the same tree.
// Run: node payments/sdk/d4-fresh-refusal.test.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { makeHonestDb } = require('../../_honest-rtdb-model');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const HC = () => require('../../pixelpay-hosted-charge');
// today's precedence (pixelpay-hosted-charge.js at 53edc481): control → menu → choice → extras → cart → floor race → payer
const ORDER = [
  ['controlRefuseFresh', true, { outcome: 'conflict', reason: 'order_control' }],
  ['menuRefuseFresh', true, { outcome: 'conflict', reason: 'menu_updating' }],
  ['choiceRefuseFresh', true, { outcome: 'conflict', reason: 'choice_required' }],
  ['extrasRefuseFresh', 'extra_not_allowed', { outcome: 'conflict', reason: 'extra_not_allowed' }],
  ['cartBlocked', ['tb_item_86'], { outcome: 'item_unavailable', blocked: ['tb_item_86'] }],
  ['refuseFresh', true, { outcome: 'conflict', reason: 'client_update_race' }],
  ['payerRefuseFresh', true, { outcome: 'conflict', reason: 'payer_email_unconfigured' }],
];

(async () => {
  await cell('SDK-D4-FRESH-REFUSAL-EACH', async (L) => {
    assert.strictEqual(typeof HC().freshIssueRefusal, 'function', `${L}: freshIssueRefusal is exported from pixelpay-hosted-charge.js`);
    assert.strictEqual(HC().freshIssueRefusal({}), null, `${L}: no flag ⇒ null`);
    for (const [k, v, want] of ORDER) assert.deepStrictEqual(HC().freshIssueRefusal({ [k]: v }), want, `${L}: ${k} alone ⇒ today's outcome`);
    assert.deepStrictEqual(HC().freshIssueRefusal({ extrasRefuseFresh: 'eligibility_unavailable' }), { outcome: 'conflict', reason: 'eligibility_unavailable' }, `${L}: extras eligibility_unavailable`);
    assert.strictEqual(HC().freshIssueRefusal({ extrasRefuseFresh: 'something_else', cartBlocked: [] }), null, `${L}: an unknown extras reason / an empty cart ⇒ no refusal`);
  });

  await cell('SDK-D4-COMPETING-REFUSALS', async (L) => {
    for (let i = 0; i < ORDER.length; i++) for (let j = i + 1; j < ORDER.length; j++) {
      const [ki, vi, wi] = ORDER[i]; const [kj, vj] = ORDER[j];
      assert.deepStrictEqual(HC().freshIssueRefusal({ [kj]: vj, [ki]: vi }), wi, `${L}: ${ki} + ${kj} ⇒ the FIRST in today's precedence (${ki})`);
    }
  });

  await cell('SDK-D4-FRESH-REFUSAL-HOSTED-PARITY', async (L) => {
    const file = path.resolve(__dirname, '..', '..', 'pixelpay-hosted-charge.js');
    const src = execFileSync('git', ['-C', path.dirname(file), 'show', '53edc481:xpizza-functions/pixelpay-hosted-charge.js'], { encoding: 'utf8' });
    const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file)); m._compile(src, file);
    const BASE = m.exports;
    assert.notStrictEqual(BASE.acquireHostedAttempt, HC().acquireHostedAttempt, `${L}: premise — two distinct modules`);
    const pending = { order_id: 'tb_o1', restaurant_id: 'tb_rest', status: 'pending_payment', payment_status: 'pending', total_cents: 10000 };
    const run = async (mod, flags, seeded) => {
      const db = makeHonestDb(seeded ? { orders: { tb_o1: { ...pending, payment_fingerprint: 'fp1' } } } : {}, { now: () => 5 });
      let k = 0; const genId = () => `aid${++k}`; const genTok = () => 'tok';
      const out = await mod.acquireHostedAttempt(db, 'tb_o1', pending, 'fp1', 1000, flags.cartBlocked, genId, genTok, null, flags.refuseFresh, flags.controlRefuseFresh, flags.menuRefuseFresh, flags.choiceRefuseFresh, flags.extrasRefuseFresh, null, 0, flags.payerRefuseFresh);
      return JSON.stringify({ out, root: db.root });
    };
    let n = 0;
    for (const control of [false, true]) for (const menu of [false, true]) for (const choice of [false, true]) for (const extras of [null, 'extra_not_allowed', 'eligibility_unavailable'])
      for (const cart of [[], ['tb_item_86']]) for (const floor of [false, true]) for (const payer of [false, true]) for (const seeded of [false, true]) {
        const flags = { controlRefuseFresh: control, menuRefuseFresh: menu, choiceRefuseFresh: choice, extrasRefuseFresh: extras, cartBlocked: cart, refuseFresh: floor, payerRefuseFresh: payer };
        const [b, t] = [await run(BASE, flags, seeded), await run(HC(), flags, seeded)];
        assert.strictEqual(t, b, `${L}: ${JSON.stringify(flags)} seeded=${seeded}: the tip's acquire is byte-identical to the base (outcome + tree)`);
        n += 1;
      }
    assert.strictEqual(n, 384, `${L}: premise — every combination ran`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-fresh-refusal: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
