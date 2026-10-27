// PLAN 4 r2 (Codex r1 P1 / #2 / #3) — A BROKEN BOOT IS VISIBLY NOT ORDERABLE, on the REAL pages.
// Run: node boot-broken-latch.test.mjs
//
// Each form is booted (jsdom, its real scripts) from its committed page with ONE defect spliced into the bundle by the real
// splice: no extras, a negative price, duplicate dish ids, a malformed variant map, variants whose map is missing. On every one:
// nothing boots, adding to the cart and the send gate both refuse, and the existing menu-broken announcement is shown in the
// stage the customer is ON (s1 → err1). A live apply that is itself malformed leaves it latched; only a COMPLETE live menu that
// applies clears it — after which the page orders again.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadForm, closeAll, counter, settle, serve, envelope } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { extractBundle, spliceBundle } = require('./catalog/splice-form-bundle');

const { ok, count } = counter();
const clone = (v) => JSON.parse(JSON.stringify(v));
// the cart's quantity for a dish, through the page's own cartLines() (CART is module-lexical)
const inCart = (w, id) => { const l = w.cartLines().find((x) => String(x.key) === String(id)); return l ? Number(l.qty) : 0; };
const FORMS = { 'xpizza-orders': 'x_pizza', 'la-musa-orders': 'la_musa' };
const pageWith = (dir, mutate) => {
  const html = readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
  const b = extractBundle(html);
  mutate(b);
  return { html: spliceBundle(html, b, dir), good: extractBundle(html) };
};
const visibleErr = (w) => {
  const active = w.document.querySelector('.stage.active');
  return ['err3', 'err1'].map((id) => w.document.getElementById(id)).find((el) => el && active && active.contains(el)) || null;
};
const DEFECTS = {
  'no extras': (b) => { delete b.extras; },
  'a negative dish price': (b) => { b.dishes[0].price = -5; },
  'duplicate dish ids': (b) => { b.dishes[1].id = b.dishes[0].id; },
  'a variant dish whose map is missing': (b) => {
    if (b.variant_items) delete b.variant_items;
    else b.dishes[1] = { ...b.dishes[1], variantOf: b.dishes[0].id, choice: 'X' };   // x_pizza ships no groups: plant one variant
  },
};

try {
  for (const [dir, rid] of Object.entries(FORMS)) {
    const defects = { ...DEFECTS };
    if (rid === 'la_musa') defects['a malformed variant map'] = (b) => { const k = Object.keys(b.variant_items)[0]; b.variant_items[k].variantIds = ['ghost']; };
    for (const [label, mutate] of Object.entries(defects)) {
      const { html, good } = pageWith(dir, mutate);
      const w = loadForm(dir, { html }); await settle();
      const anyId = good.dishes.find((d) => !d.variantOf && !(good.variant_items && good.variant_items[d.id])).id;
      assert.strictEqual(w.liveMenuGlobalGet('MENU').length, 0, `${dir} / ${label}: nothing boots`);
      w.chg(anyId, 1);
      assert.strictEqual(inCart(w, anyId), 0, `${dir} / ${label}: 🔴 adding to the cart is refused`);
      // the LATCH is what refuses (an empty cart has its own refusal, so the reason is asserted, not just the verdict)
      const warned = []; const realWarn = w.console.warn; w.console.warn = (...a) => { warned.push(a.join(' ')); };
      assert.strictEqual(w.refuseConflictedSend('latch'), true, `${dir} / ${label}: 🔴 the send gate refuses`);
      w.console.warn = realWarn;
      assert.ok(warned.some((x) => /cart_blocked_send_menu_broken/.test(x) && /"error":"boot"/.test(x)), `${dir} / ${label}: …because the boot is latched broken (${JSON.stringify(warned)})`);
      const err = visibleErr(w);
      assert.ok(err && err.style.display === 'block' && /No pudimos actualizar el menú/.test(err.textContent), `${dir} / ${label}: the existing announcement shows in the VISIBLE stage`);
      assert.strictEqual(w.document.querySelector('.stage.active').id, 's1', 'premise: the customer is on the menu stage');
    }
    ok(`${dir}: ${Object.keys(defects).length} boot defects (${Object.keys(defects).join(', ')}) → nothing boots, add refused, send refused, the announcement visible on s1`);

    // the latch survives a MALFORMED live apply and clears only on a COMPLETE one
    const { html, good } = pageWith(dir, DEFECTS['no extras']);
    const w = loadForm(dir, { html }); await settle();
    const live = clone(good);
    const cats = []; for (const d of live.dishes) if (!cats.includes(d.cat)) cats.push(d.cat);
    if (!live.categories) live.categories = cats.map((id) => ({ id }));
    const broken = clone(live); broken.dishes[0].price = -1;
    await serve(w, envelope(rid, broken, '1d.3'));
    const probe = good.dishes.find((d) => !d.variantOf && !(good.variant_items && good.variant_items[d.id])).id;
    w.chg(probe, 1);
    assert.strictEqual(inCart(w, probe), 0, `${dir}: a MALFORMED live menu does not clear the latch (still nothing can be added)`);
    await serve(w, envelope(rid, live, '1d.3'));
    assert.ok(w.liveMenuGlobalGet('MENU').length > 0, `${dir}: the complete live menu applied`);
    const anyId = good.dishes.find((d) => !d.variantOf && !(good.variant_items && good.variant_items[d.id])).id;
    w.chg(anyId, 1);
    assert.strictEqual(inCart(w, anyId), 1, `${dir}: 🔴 a COMPLETE live menu clears the latch — the page adds again`);
    assert.strictEqual(w.refuseConflictedSend('latch'), false, `${dir}: …and the send gate opens (a cart is needed: an EMPTY cart is refused by its own rule)`);
    assert.ok(!/No pudimos actualizar el menú/.test((w.document.getElementById('err1') || {}).textContent || ''), `${dir}: …and the announcement is withdrawn`);
    ok(`${dir}: a malformed live menu leaves the page latched; a COMPLETE live menu clears it — the page orders again and the announcement is withdrawn`);
  }
} finally { closeAll(); }
console.log(`\nboot-broken-latch: OK (${count()})`);
