// CUSTOMER APP S0-test — DOM GOLDENS for BOTH brands (PLAN-shared-order-form.FINAL §5 S0, §7 oracle 1).
//
// Fills the asymmetry the existing goldens leave (an x_pizza-only grid golden, a la_musa-only picker golden):
// the same surfaces are captured for every brand, from the CURRENT forms, with the catalog each brand's real
// publish produces, served as getPublicMenu serves it.
//
// Surfaces (each brand): grid (the live-menu containers) · detail modal with an extra selected · group picker
// (first launcher dish, when the catalog has one) · cart review · Stage-2 summary · rewards: guest, signed-in
// with an eligible balance, signed-in with points/stamps HELD by a pending order (chip, cart earn line, redeem
// ticket). Third brand (r3_synth, PROVISIONAL, the declared x_pizza fork): grid, modal, cart, summary, plus a
// leak check — no x_pizza/la_musa literal in any visible text, attribute or the title.
//
// Run:   node capp-s0-dom.golden.test.mjs            (check)
//        node capp-s0-dom.golden.test.mjs --write    (re-capture from the CURRENT forms; review the diff)
import assert from 'node:assert';
import { readFileSync, writeFileSync, rmdirSync } from 'node:fs';
import { closeAll, counter, settle } from './form-harness.mjs';
import { provisionBrand, boot, composeCart, GSTATIC, rewardsPreamble, REWARD } from './xpizza-functions/contract/capp/capture.mjs';
import { provisionThirdBrand, materializeFork, removeFork } from './xpizza-functions/contract/capp/third-brand-fork.mjs';

const GOLDEN = new URL('./capp-s0-dom.golden.json', import.meta.url);
const WRITE = process.argv.includes('--write');
const { ok, count } = counter();
const LEAK = /x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i;
const tick = async () => { await new Promise((r) => setTimeout(r, 30)); await settle(); };

const BRANDS = [
  { rid: 'x_pizza', dir: 'xpizza-orders', marker: 'xpizza_acct', reward: 'punch', eligible: { balance: 8, reserved: 0 }, held: { balance: 8, reserved: 8 } },
  { rid: 'la_musa', dir: 'la-musa-orders', marker: 'lamusa_acct', reward: 'points', eligible: { balance: 400, reserved: 0 }, held: { balance: 400, reserved: 334 } },
];

const html = (w, id) => { const el = w.document.getElementById(id); if (!el) throw new Error(`capp dom: no #${id}`); return el.innerHTML; };

// The shopping surfaces, on a booted page with the live catalog applied.
async function shopping(w) {
  const out = {};
  out.grid = Array.from(w.liveMenuContainers(), (id) => html(w, id));   // a node-realm array: deepStrictEqual compares prototypes
  const { dish, extra } = await composeCart(w);
  w.openDetailModal(dish.id); await tick();
  out.detail_modal = html(w, 'detail-modal');
  w.closeDetailModal(); await tick();
  const variants = w.liveMenuGlobalGet('VARIANT_ITEMS') || {};
  const launcher = w.liveMenuGlobalGet('MENU').find((d) => Object.prototype.hasOwnProperty.call(variants, String(d.id)));
  if (launcher) { w.openDetailModal(launcher.id); await tick(); out.group_picker = html(w, 'detail-modal'); w.closeDetailModal(); await tick(); }
  else out.group_picker = null;
  w.openCartReview(); await tick();
  out.cart_review = html(w, 'cart-review-sheet');
  w.closeCartReview(); await tick();
  w.renderStage2Summary(); await tick();
  out.stage2_summary = html(w, 's2-summary');
  return { out, extra, launcher: !!launcher };
}

async function rewardsCell(B, envelope, state) {
  const { w } = state
    ? await boot(B.dir, envelope, { transforms: GSTATIC, preamble: rewardsPreamble(B.marker, state) })
    : await boot(B.dir, envelope);
  await composeCart(w); await tick();
  w.renderRedeemUI(); await tick();
  if (w.__netEscapes.length) throw new Error(`capp dom: network escape ${w.__netEscapes.join(' | ')}`);
  return { chip: html(w, 'acct-chip'), cart_earn: w.document.getElementById('acct-cart-earn').outerHTML, redeem: html(w, 'acct-redeem') };
}

function visibleLeak(w) {
  const body = w.document.body.cloneNode(true);
  for (const el of [...body.querySelectorAll('script, style, template')]) el.remove();
  const attrs = [...body.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value)).filter((v) => !/^data:image\//.test(v));
  for (const s of [w.document.title, body.textContent, ...attrs]) { const m = LEAK.exec(s || ''); if (m) return m[0] + ' in ' + JSON.stringify(String(s).slice(Math.max(0, m.index - 40), m.index + 40)); }
  return null;
}

(async () => {
  const got = {};
  for (const B of BRANDS) {
    const prov = await provisionBrand(B.rid);
    const { w } = await boot(B.dir, prov.envelope);
    const s = await shopping(w);
    assert.strictEqual(s.extra, true, `${B.rid}: non-vacuity — the cart carries an extra`);
    assert.ok(s.out.grid.join('').length > 1000 && s.out.cart_review.length > 200, `${B.rid}: non-vacuity — the grid and cart rendered`);
    got[`${B.rid}/shopping`] = s.out;
    got[`${B.rid}/rewards-guest`] = await rewardsCell(B, prov.envelope, null);
    got[`${B.rid}/rewards-eligible`] = await rewardsCell(B, prov.envelope, B.eligible);
    got[`${B.rid}/rewards-held`] = await rewardsCell(B, prov.envelope, B.held);
    assert.ok(/acct-chip--out/.test(got[`${B.rid}/rewards-guest`].chip) && /acct-cart-earn--guest/.test(got[`${B.rid}/rewards-guest`].cart_earn), `${B.rid}: the guest cell renders the guest chip and the guest earn line`);
    assert.ok(/rk-tk/.test(got[`${B.rid}/rewards-eligible`].redeem), `${B.rid}: the eligible cell renders the ${B.reward} redeem ticket`);
    assert.ok(/en un pedido pendiente/.test(got[`${B.rid}/rewards-held`].chip), `${B.rid}: the held cell shows the balance held by a pending order`);
    ok(`${B.rid}: grid, modal+extra, ${s.launcher ? 'group picker, ' : '(no launcher dish) '}cart, Stage-2 summary; rewards guest / eligible (${B.reward}) / held`);
  }

  const third = await provisionThirdBrand();
  const fork = materializeFork(third);
  try {
    const { w } = await boot(fork.dir, third.envelope);
    const s = await shopping(w);
    const leak = visibleLeak(w);
    assert.strictEqual(leak, null, `third brand: another brand's literal is visible: ${leak}`);
    assert.ok(/R3 /.test(s.out.grid.join('')), 'third brand: non-vacuity — the grid renders the third brand\'s renamed dishes');
    got[`${third.rid}/shopping (PROVISIONAL)`] = s.out;
    ok(`third brand ${third.rid}: grid/modal/cart/summary rendered from its own catalog; no x_pizza/la_musa literal visible (PROVISIONAL)`);
  } finally { removeFork(); try { rmdirSync(new URL('./node_modules', import.meta.url)); } catch (_) {} }

  if (WRITE) {
    writeFileSync(GOLDEN, JSON.stringify({ _about: 'Customer App S0-test DOM goldens, captured from the CURRENT forms by capp-s0-dom.golden.test.mjs --write; never hand-edit.', cells: got }, null, 2) + '\n');
    console.log(`\nWROTE ${GOLDEN.pathname} (${Object.keys(got).length} cells)`);
  } else {
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8')).cells;
    assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'the cell set matches the golden');
    const firstDiff = (a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); let i = 0; while (i < x.length && x[i] === y[i]) i++; return `at char ${i}: got …${x.slice(Math.max(0, i - 60), i + 80)}… want …${y.slice(Math.max(0, i - 60), i + 80)}…`; };
    for (const k of Object.keys(want)) for (const part of Object.keys(want[k])) assert.deepStrictEqual(got[k][part], want[k][part], `${k} ${part}: DOM differs from the golden (re-capture only for an APPROVED change) ${firstDiff(got[k][part], want[k][part])}`);
    ok(`${Object.keys(want).length} cells equal to capp-s0-dom.golden.json`);
  }
  console.log(`\ncapp-s0-dom.golden: ${count()} passed`);
  closeAll();
})().catch((e) => { console.error('capp-s0-dom.golden FAILED:', (e && e.stack) || e); closeAll(); removeFork(); process.exit(1); });
