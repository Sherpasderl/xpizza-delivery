// CUSTOMER APP S0-test — THE INERT CONFIG PLUMBING (PLAN-shared-order-form.FINAL §5 S0).
//
// Derives each brand's restaurant config from its RUNNING page (xpizza-functions/contract/capp/brand-config.mjs)
// and pins it. These are the values S0-prod's RESTAURANT_CONFIG must reproduce (§A4: the legacy storage keys
// byte-identical), so S0-prod can swap the source and prove nothing moved. Also checks that the single
// source-text fallback fails loudly on zero or several matches, and that the inert validator rejects
// malformed configs. Third brand = PROVISIONAL (the declared x_pizza fork).
//
// Run:   node capp-s0-config.test.mjs            (check)
//        node capp-s0-config.test.mjs --write    (re-derive from the CURRENT forms)
import assert from 'node:assert';
import { readFileSync, writeFileSync, rmdirSync } from 'node:fs';
import { closeAll, counter, loadForm, settle } from './form-harness.mjs';
import { deriveBrandConfig, validateRestaurantConfig, exactlyOne } from './xpizza-functions/contract/capp/brand-config.mjs';
import { provisionThirdBrand, materializeFork, removeFork } from './xpizza-functions/contract/capp/third-brand-fork.mjs';
import { PREAMBLE } from './xpizza-functions/contract/capp/capture.mjs';

const GOLDEN = new URL('./capp-s0-config.golden.json', import.meta.url);
const WRITE = process.argv.includes('--write');
const { ok, count } = counter();
const plain = (x) => JSON.parse(JSON.stringify(x));

async function derive(dir) {
  const w = loadForm(dir, { preamble: PREAMBLE }); await settle();
  return plain(await deriveBrandConfig(w, { dir, html: readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8') }));
}

(async () => {
  const got = {};
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const c = await derive(dir);
    assert.deepStrictEqual(validateRestaurantConfig(c), [], `${dir}: the derived config validates`);
    got[c.restaurant_id] = c;
  }
  // §A4 — the storage keys S0-prod must keep byte-identical (pending payments and sessions survive cutover).
  assert.deepStrictEqual([got.x_pizza.storage_keys, got.la_musa.storage_keys],
    [{ pending_pay: 'xpizza_pending_pay', account_marker: 'xpizza_acct' }, { pending_pay: 'lamusa_pending_pay', account_marker: 'lamusa_acct' }],
    'the legacy localStorage keys, read from the running pages');
  ok('x_pizza + la_musa: config derived from the RUNNING pages validates; §A4 legacy storage keys pinned');

  const third = await provisionThirdBrand();
  const fork = materializeFork(third);
  try {
    const c = await derive(fork.dir);
    assert.deepStrictEqual(validateRestaurantConfig(c), [], 'third brand: the derived config validates');
    assert.strictEqual(c.restaurant_id, third.rid, 'third brand: its id is the one the account module and the menu feed both carry');
    c.form.dir = '<third-brand fork>';
    got[`${third.rid} (PROVISIONAL)`] = c;
    ok(`third brand ${third.rid}: config derived from the transformed fork validates (PROVISIONAL)`);
  } finally { removeFork(); try { rmdirSync(new URL('./node_modules', import.meta.url)); } catch (_) {} }

  // The one source-text fallback is EXACTLY-ONE or an error.
  assert.throws(() => exactlyOne('nothing here', /localStorage\.setItem\('([a-z_]+_pending_pay)'/, 'zero'), /expected exactly ONE match .* found 0/);
  assert.throws(() => exactlyOne("localStorage.setItem('a_pending_pay' localStorage.setItem('b_pending_pay'", /localStorage\.setItem\('([a-z_]+_pending_pay)'/, 'two'), /found 2/);
  assert.strictEqual(exactlyOne("localStorage.setItem('a_pending_pay'", /localStorage\.setItem\('([a-z_]+_pending_pay)'/, 'one')[1], 'a_pending_pay');
  ok('source-text fallback: zero matches and two matches both throw; exactly one returns it');

  // Payment methods come from the RUNTIME handlers, fail-closed: a handler the regex era would have skipped is
  // either derived (and then refused by the validator) or refused outright.
  {
    const html = readFileSync(new URL('./la-musa-orders/index.html', import.meta.url), 'utf8');
    const withHandler = async (onclick) => { const w = loadForm('la-musa-orders', { preamble: PREAMBLE }); await settle(); const b = w.document.createElement('button'); b.setAttribute('onclick', onclick); w.document.body.appendChild(b); return w; };
    const dq = await deriveBrandConfig(await withHandler('selectPay("bitcoin")'), { dir: 'la-musa-orders', html });
    assert.deepStrictEqual(dq.payment_methods, ['bitcoin', 'cash', 'online'], 'a double-quoted handler is DERIVED, not skipped');
    assert.ok(validateRestaurantConfig(plain(dq)).includes('payment_methods'), '…and the validator refuses the unknown method');
    await assert.rejects(async () => await deriveBrandConfig(await withHandler("selectPay('cash');selectPay('online')"), { dir: 'la-musa-orders', html }), /instead of exactly one selectPay/);
    await assert.rejects(async () => await deriveBrandConfig(await withHandler("if (false) selectPay('cash')"), { dir: 'la-musa-orders', html }), /instead of exactly one selectPay/);
    await assert.rejects(async () => await deriveBrandConfig(await withHandler('selectPay()'), { dir: 'la-musa-orders', html }), /instead of exactly one selectPay/);
  }
  ok('payment methods derive from the runtime handlers: a double-quoted unknown method is derived and refused; a double call, no call or no argument throws');

  // The inert validator refuses what RESTAURANT_CONFIG must never carry.
  const base = got.la_musa;
  const bad = (patch, re) => { const c = { ...plain(base), ...patch }; const e = validateRestaurantConfig(c); assert.ok(e.some((m) => re.test(m)), `validator must reject ${JSON.stringify(patch)} (got ${JSON.stringify(e)})`); };
  bad({ extra_field: 1 }, /unknown key extra_field/);
  bad({ restaurant_id: 'La Musa' }, /restaurant_id/);
  bad({ uses_platform_factura: true }, /uses_platform_factura/);
  bad({ payment_methods: ['cash', 'bitcoin'] }, /payment_methods/);
  bad({ hours: { ...base.hours, 3: { open: 900, close: 600 } } }, /hours/);
  bad({ storage_keys: { pending_pay: 'x', account_marker: 'y' } }, /storage_keys/);
  ok('validator rejects an unknown key, a non-id restaurant_id, a client-side factura flag, an unknown payment method, inverted hours, a malformed storage key');

  if (WRITE) {
    writeFileSync(GOLDEN, JSON.stringify({ _about: 'Customer App S0-test brand configs, derived from the CURRENT running forms by capp-s0-config.test.mjs --write; never hand-edit.', configs: got }, null, 2) + '\n');
    console.log(`\nWROTE ${GOLDEN.pathname}`);
  } else {
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8')).configs;
    assert.deepStrictEqual(got, want, 'derived configs differ from capp-s0-config.golden.json');
    ok(`${Object.keys(want).length} brand configs equal to capp-s0-config.golden.json`);
  }
  console.log(`\ncapp-s0-config: ${count()} passed`);
  closeAll();
})().catch((e) => { console.error('capp-s0-config FAILED:', (e && e.stack) || e); closeAll(); removeFork(); process.exit(1); });
