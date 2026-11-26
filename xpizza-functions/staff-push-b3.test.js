'use strict';
// B3 (PLAN-brand-agnostic-convergence r9, audit G4): the staff push counts and labels EVERY restaurant from data — a `{rid: n}` buffer
// and the label from the restaurant's identity (display_name, else name, else a neutral «Restaurante»; never another brand's name).
//   B3-COUNTS-ANY-RID     addPending / pendingCounts count a third restaurant under its OWN id (no founder fallback)
//   B3-LEGACY-BUFFER      a buffer written before B3 ({ x_pizza: n, la_musa: n, ids }) is read with the same counts
//   B3-GROUPED-LABELS     formatGrouped names each restaurant by ITS label, a 3rd restaurant included (most orders first)
//   B3-NEWORDER-LABEL     formatNewOrder uses the label it is given (the order's own restaurant)
//   B3-LABEL-SOURCE       staffLabels(db, rids): identity display_name → name → «Restaurante» (an unreadable / absent identity never
//                         borrows another restaurant's name); unshowable text is not used
//   B3-NO-FOUNDER-LITERAL staff-push.js names no restaurant id
// Run: node staff-push-b3.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeHonestDb } = require('./_honest-rtdb-model');
const SP = require('./staff-push');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

(async () => {
  await cell('B3-COUNTS-ANY-RID: a third restaurant is counted under its own id', async (L) => {
    let p = SP.addPending(null, 'x_pizza', 'o1'); p = SP.addPending(p, 'tb_third', 'o2'); p = SP.addPending(p, 'tb_third', 'o3');
    assert.deepStrictEqual(SP.pendingCounts(p), { x_pizza: 1, tb_third: 2 }, `🔴 ${L}`);
    assert.deepStrictEqual(p, { x_pizza: 1, tb_third: 2, ids: ['o1', 'o2', 'o3'] }, `🔴 ${L}: the FLAT shape (today's), ids kept in order`);
  });
  await cell('B3-LEGACY-BUFFER: a pre-B3 buffer is read with the same counts (and grows correctly)', async (L) => {
    const legacy = { x_pizza: 2, la_musa: 1, ids: ['a', 'b', 'c'] };
    assert.deepStrictEqual(SP.pendingCounts(legacy), { x_pizza: 2, la_musa: 1 }, `🔴 ${L}`);
    assert.deepStrictEqual(SP.pendingCounts(SP.addPending(legacy, 'la_musa', 'd')), { x_pizza: 2, la_musa: 2 }, `🔴 ${L}: one more`);
  });
  await cell('B3-GROUPED-LABELS: each restaurant by ITS label, a third one included, most orders first', async (L) => {
    let p = null; for (const [rid, k] of [['x_pizza', 1], ['tb_third', 2], ['la_musa', 1]]) for (let i = 0; i < k; i++) p = SP.addPending(p, rid, `${rid}${i}`);
    const g = SP.formatGrouped(p, { x_pizza: 'X. Pizza', la_musa: 'La Musa', tb_third: 'Tercera Casa' });
    assert.deepStrictEqual(g, { title: '4 pedidos nuevos', body: '2 Tercera Casa · 1 La Musa · 1 X. Pizza' }, `🔴 ${L}: ${JSON.stringify(g)}`);
    assert.deepStrictEqual(SP.formatGrouped({ tb_third: 1, ids: ['z'] }, {}), { title: '1 pedido nuevo', body: '1 Restaurante' }, `🔴 ${L}: no label ⇒ neutral`);
  });
  await cell('B3-NEWORDER-LABEL: the single push uses the given label', async (L) => {
    const r = SP.formatNewOrder({ restaurant_id: 'tb_third', display_number: 12, customer_name: 'Ana' }, 'Tercera Casa');
    assert.deepStrictEqual(r, { title: 'Nuevo pedido', body: 'Tercera Casa · #12 · Ana' }, `🔴 ${L}: ${JSON.stringify(r)}`);
  });
  await cell('B3-LABEL-SOURCE: identity display_name → name → «Restaurante»; never another restaurant\'s name', async (L) => {
    const db = makeHonestDb({ restaurants: {
      a_disp: { identity: { display_name: 'Casa A', name: 'a internal' } },
      b_name: { identity: { name: 'Casa B' } },
      c_none: { identity: { phone: '+504' } },
      d_bad: { identity: { display_name: 'Casa\u0007D', name: 'Casa D' } },   // a control character: unshowable (pickup-label.brandText)
    } }, { beforeRead: async (p) => { if (p.startsWith('restaurants/e_down/')) throw new Error('unavailable'); } });
    const got = await SP.staffLabels(db, ['a_disp', 'b_name', 'c_none', 'd_bad', 'e_down', 'f_absent']);
    assert.deepStrictEqual(got, { a_disp: 'Casa A', b_name: 'Casa B', c_none: 'Restaurante', d_bad: 'Casa D', e_down: 'Restaurante', f_absent: 'Restaurante' }, `🔴 ${L}: ${JSON.stringify(got)}`);
  });
  await cell('B3-NO-FOUNDER-LITERAL: staff-push.js names no restaurant id', async (L) => {
    const src = fs.readFileSync(path.join(__dirname, 'staff-push.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/x_pizza|la_musa|X\. Pizza|La Musa/.test(src), `🔴 ${L}`);
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`staff-push-b3: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
