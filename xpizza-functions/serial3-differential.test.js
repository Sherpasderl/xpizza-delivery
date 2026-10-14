'use strict';
// §3 r5 (codex serialization r5) — NO-REGRESSION DIFFERENTIAL of the materialize-side duplicate guard against MAIN.
// Run: node serial3-differential.test.js
//
// MAIN's guard (207170e: materialize-guard.js + its own order-dedup.js + scheduled-orders.js, read from GIT — the real old
// code, never a re-implementation) and the candidate run the SAME corpus, each with the stamps ITS OWN server writes
// (createOrder stamps a cash order from its text BEFORE appending a reward's lines, under the version's own key function;
// the incoming online order's own stamp is older). Asserted: wherever MAIN holds, the candidate holds — except when the
// sibling's content truly differs from the content the stamp names (a corrupted pointer), which the candidate refuses and
// LOGS. The corpus crosses: a reward on either side or both; brackets / parens / "(Recompensa)" in paid AND reward names; a
// paid line ending the marker; line order; delivery / pickup; ASAP / scheduled; the sibling written before or after this
// deploy (reward provenance or not); the incoming order with or without persisted keys. Codex r5's two repros verbatim.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const OD = require('./order-dedup');
const { holdIfDuplicateSibling } = require('./materialize-guard');
const { rewardAppendText } = OD;

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// ── MAIN, from git ──
const BASE = '207170e';
const OLD = path.join(__dirname, 'node_modules', `.serial3-main-${BASE}`);
fs.mkdirSync(OLD, { recursive: true });
for (const f of ['materialize-guard.js', 'order-dedup.js', 'scheduled-orders.js']) {
  fs.writeFileSync(path.join(OLD, f), execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 }));
}
const MAIN = require(path.join(OLD, 'materialize-guard.js'));
const MAIN_OD = require(path.join(OLD, 'order-dedup.js'));
assert.ok(!/content_key|clientTextOf/.test(fs.readFileSync(path.join(OLD, 'materialize-guard.js'), 'utf8')), 'premise: the lifted guard is MAIN\'s (no §3)');

function fakeDb(store) {
  return { ref: (p) => ({
    async once() { return { val: () => store[p] }; },
    async transaction(fn) { const next = fn(store[p]); if (next === undefined) return { committed: false }; store[p] = next; return { committed: true }; },
    async set(v) { store[p] = v; }, async update() {},
  }) };
}
const quiet = async (fn) => { const logs = []; const w = console.warn; console.warn = (...a) => logs.push(a.join(' ')); try { return { r: await fn(), logs }; } finally { console.warn = w; } };
const PHONE = '+50433901234';
const MENU = ['Carnivora', 'Margherita [special', 'Pad (Thai)', 'Extra dish', 'Pepperoni'];
const PAID = {
  carn: '2x Carnivora (L340) [Pizza 1: Mozzarella | Pizza 2: Pepperoni]',
  pep: '1x Pepperoni (L307)',
  brk: '1x Margherita [special (L250)',            // an unbalanced bracket in a PAID name
  par: '1x Pad (Thai) (L280)',                    // parens in a PAID name
  mrk: '1x Extra dish (L99) (Recompensa)',         // a PAID line that merely ends with the marker
};
const REWARD = {   // the server's own formatter (rewardAppendText) — what prepareRedemption appends
  none: null,
  plain: [{ qty: 1, name: 'Margherita' }],
  brk: [{ qty: 1, name: 'Margherita [special' }],
  par: [{ qty: 2, name: 'Pad (Thai)' }],
  two: [{ qty: 1, name: 'Margherita' }, { qty: 1, name: 'Té (helado)' }],
};
const keyArgs = (text, type, slot) => ({ phone: PHONE, itemsText: text, orderType: type, scheduledFor: slot });

// one corpus case through BOTH guards
async function runCase(c) {
  const yClient = c.yLines.join(' | ');
  const yAppend = c.yReward ? rewardAppendText(c.yReward) : '';
  const xClient = c.xLines.join(' | ');
  const xAppend = c.xReward ? rewardAppendText(c.xReward) : '';
  const xFull = xClient + xAppend;
  const yRecord = { order_id: 'Y', status: 'preparing', customer_phone: PHONE, items_text: yClient + yAppend, order_type: c.yType, payment_method: 'cash',
    ...(c.ySlot != null ? { scheduled_for: c.ySlot } : {}), ...(c.yReward ? { redemption: { model: 'add_free' } } : {}),
    ...(c.yReward && c.yProvenance ? { reward_text_appended: yAppend } : {}) };
  const xBase = { order_id: 'X', customer_phone: PHONE, items_text: xFull, order_type: c.xType, payment_method: 'online', payment_status: 'confirmed', status: 'pending_payment',
    ...(c.xSlot != null ? { scheduled_for: c.xSlot } : {}) };
  // MAIN: every stamp under main's key function (verbatim); Y stamped from its PRE-append text, last
  const mainStore = {};
  const mainLeaf = (t, type, slot) => `recent_order_content/${MAIN_OD.rateLimitKey(PHONE)}/${MAIN_OD.orderContentKey(keyArgs(t, type, slot))}`;
  mainStore[mainLeaf(xFull, c.xType, c.xSlot)] = { at: 1000, order_id: 'X', payment_method: 'online' };
  mainStore[mainLeaf(yClient, c.yType, c.ySlot)] = { at: 2000, order_id: 'Y', payment_method: 'cash' };
  mainStore['orders/Y'] = { ...yRecord }; mainStore['orders/X'] = { ...xBase };
  const main = (await quiet(() => MAIN.holdIfDuplicateSibling({ db: fakeDb(mainStore) }, 'X', { ...xBase }, 1))).r;
  // CANDIDATE: X stamped by the new server (canonical); Y by the new server (canonical) or — written before the deploy — by main's
  const candStore = {};
  const newLeaf = (t, type, slot) => `recent_order_content/${OD.rateLimitKey(PHONE)}/${OD.orderContentKey(keyArgs(t, type, slot))}`;
  candStore[newLeaf(xFull, c.xType, c.xSlot)] = { at: 1000, order_id: 'X', payment_method: 'online' };
  candStore[c.yProvenance ? newLeaf(yClient, c.yType, c.ySlot) : mainLeaf(yClient, c.yType, c.ySlot)] = { at: 2000, order_id: 'Y', payment_method: 'cash' };
  const xRecord = { ...xBase, ...(c.xKeys ? { ...OD.contentKeysRecord(keyArgs(xFull, c.xType, c.xSlot), { menuNames: MENU, suffix: xAppend || null, log: () => {} }), ...(xAppend ? { reward_text_appended: xAppend } : {}) } : {}) };
  candStore['orders/Y'] = { ...yRecord }; candStore['orders/X'] = { ...xRecord };
  const { r: cand, logs } = await quiet(() => holdIfDuplicateSibling({ db: fakeDb(candStore) }, 'X', { ...xRecord }, 1));
  return { main, cand, logs };
}

(async () => {
  // ── the corpus ──
  const lineSets = [['carn', 'pep'], ['carn'], ['brk', 'pep'], ['par', 'carn'], ['mrk', 'pep'], ['carn', 'brk', 'par']];
  const cases = [];
  for (const ls of lineSets) {
    const lines = ls.map((k) => PAID[k]);
    for (const perm of ['same', 'reversed']) for (const yR of Object.keys(REWARD)) for (const xR of ['none', 'plain', 'brk']) {
      for (const [type, slot] of [['delivery', null], ['pickup', null], ['pickup', 1767290400000]]) for (const yProv of [true, false]) for (const xKeys of [true, false]) {
        if (!REWARD[yR] && !yProv) continue;   // no reward: provenance is moot (one case per side)
        cases.push({ label: `${ls.join('+')} ${perm} yR=${yR} xR=${xR} ${type}${slot ? ' sched' : ''} y${yProv ? 'new' : 'pre'} x${xKeys ? 'keys' : 'nokeys'}`,
          yLines: lines, xLines: perm === 'same' ? lines : [...lines].reverse(), yReward: REWARD[yR], xReward: REWARD[xR],
          yType: type, xType: type, ySlot: slot, xSlot: slot, yProvenance: yProv, xKeys });
      }
    }
  }
  // genuinely different carts / slots / types — neither guard may hold
  for (const [label, d] of [['another line', { xLines: [PAID.carn, PAID.par] }], ['another slot', { xSlot: 1767294000000 }], ['another type', { xType: 'delivery' }]]) {
    cases.push({ label: `different: ${label}`, yLines: [PAID.carn, PAID.pep], xLines: [PAID.carn, PAID.pep], yReward: null, xReward: null, yType: 'pickup', xType: 'pickup', ySlot: 1767290400000, xSlot: 1767290400000, yProvenance: true, xKeys: true, ...d });
  }
  let mainHolds = 0, both = 0, candOnly = 0, regressions = [];
  for (const c of cases) {
    const { main, cand, logs } = await runCase(c);
    if (main) { mainHolds += 1; if (cand) both += 1; else regressions.push(`${c.label} :: ${logs.join(' / ')}`); }
    else if (cand) {
      candOnly += 1;
      // a hold MAIN does not make must be the §3 feature: the same cart in another line order (never another cart)
      assert.strictEqual(OD.orderContentKey(keyArgs(c.xLines.join(' | ') + (c.xReward ? rewardAppendText(c.xReward) : ''), c.xType, c.xSlot)),
        OD.orderContentKey(keyArgs(c.yLines.join(' | '), c.yType, c.ySlot)), `🔴 the candidate holds where main does not, on a DIFFERENT cart: ${c.label}`);
    }
    if (c.label.startsWith('different:')) assert.ok(!main && !cand, `different carts are never held: ${c.label}`);
  }
  assert.deepStrictEqual(regressions, [], `🔴 NO-REGRESSION: the candidate must hold wherever MAIN holds (honest stamps) — ${regressions.length} regression(s):\n  ${regressions.slice(0, 8).join('\n  ')}`);
  assert.ok(mainHolds > 50, `non-vacuity: main holds in ${mainHolds} corpus cases`);
  ok(`differential vs MAIN (git ${BASE}): ${cases.length} corpus cases — main holds ${mainHolds}, the candidate holds ALL ${both} of them; ${candOnly} extra holds, each the same cart in another line order (§3); different carts held by neither`);

  // ── codex r5 repros, verbatim, through both guards ──
  { // P1-A: a corrupted pointer — the stamp under the incoming order's key names a sibling whose CLIENT text differs ("… (Recompensa)" paid line, no redemption)
    const A = PAID.carn, B = PAID.pep, X_TEXT = `${A} | ${B}`, Y_TEXT = `${A} | ${B} | 1x Extra dish (L99) (Recompensa)`;
    const y = { order_id: 'Y', status: 'preparing', customer_phone: PHONE, items_text: Y_TEXT, order_type: 'pickup', payment_method: 'cash' };
    const x = { order_id: 'X', customer_phone: PHONE, items_text: X_TEXT, order_type: 'pickup', payment_method: 'online', payment_status: 'confirmed', status: 'pending_payment' };
    const mStore = { [`recent_order_content/${MAIN_OD.rateLimitKey(PHONE)}/${MAIN_OD.orderContentKey(keyArgs(X_TEXT, 'pickup', null))}`]: { at: 2, order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { ...y }, 'orders/X': { ...x } };
    const mainR = (await quiet(() => MAIN.holdIfDuplicateSibling({ db: fakeDb(mStore) }, 'X', { ...x }, 1))).r;
    const xk = { ...x, ...OD.contentKeysRecord(keyArgs(X_TEXT, 'pickup', null), { menuNames: MENU, log: () => {} }) };
    const cStore = { [`recent_order_content/${OD.rateLimitKey(PHONE)}/${OD.orderContentKey(keyArgs(X_TEXT, 'pickup', null))}`]: { at: 2, order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { ...y }, 'orders/X': { ...xk } };
    const { r, logs } = await quiet(() => holdIfDuplicateSibling({ db: fakeDb(cStore) }, 'X', { ...xk }, 1));
    assert.strictEqual(mainR, true, 'premise: main holds on the pointer alone');
    assert.strictEqual(r, false, '🔴 r5 P1-A: the candidate does NOT hold — the sibling\'s content differs (the allowed exception)');
    assert.ok(logs.some((l) => l.includes('duplicate_sibling_not_verified') && l.includes('"reason":"sibling_content_mismatch"')), '…and LOGS it');
    ok('codex r5 P1-A verbatim: a paid line ending "(Recompensa)" on a sibling with no redemption → main holds on the pointer; the candidate does NOT, logged (sibling_content_mismatch)');
  }
  for (const yProv of [true, false]) { // P1-B: online X + live cash Y with the same paid cart, Y redeemed a reward named "Margherita [special"
    const c = { label: 'P1-B', yLines: ['2x Carnivora (L340)'], xLines: ['2x Carnivora (L340)'], yReward: [{ qty: 1, name: 'Margherita [special' }], xReward: null,
      yType: 'pickup', xType: 'pickup', ySlot: null, xSlot: null, yProvenance: yProv, xKeys: true };
    assert.strictEqual(rewardAppendText(c.yReward), ' | 1x Margherita [special (Recompensa)', 'premise: "2x Carnivora (L340) | 1x Margherita [special (Recompensa)"');
    const { main, cand, logs } = await runCase(c);
    assert.strictEqual(main, true, 'premise: main (207170e) HOLDS');
    assert.strictEqual(cand, true, `🔴 r5 P1-B (${yProv ? 'sibling with provenance' : 'sibling written before the deploy'}): the candidate HOLDS too`);
    if (!yProv) assert.ok(logs.some((l) => l.includes('"reason":"no_reward_provenance"')), 'a pre-deploy redeemed sibling is held as today, LOGGED unverifiable');
  }
  ok('codex r5 P1-B verbatim: "2x Carnivora (L340) | 1x Margherita [special (Recompensa)" cash Y + online X → HELD, as on main (with provenance; and a pre-deploy Y as today, logged)');
  console.log(`\nserial3-differential: OK (${n})`);
})().catch((e) => { console.error('serial3-differential FAILED:', e); process.exit(1); });
