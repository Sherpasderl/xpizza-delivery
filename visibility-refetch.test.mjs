// 1D add-product B (rev 6 §2, codex plainslice r1 #9) — the live menu RE-FETCHES when the page comes back into view, through
// the real chain (visibilitychange → coordinator → adapter → applier → form), on both forms. Run: node visibility-refetch.test.mjs
// Covered: a re-fetch picks up a published group; a return while a modal is open or a payment is in flight is DEFERRED and
// lands when the form goes idle; a rollback removing a launcher applies; a malformed variant block is refused whole (the
// prior menu stands); returns inside 60 s are rate-limited. (Stale-response ordering is the coordinator's, unit-tested.)
import assert from 'node:assert';
import { loadForm, settle, res, closeAll, counter, BRAND, envelope } from './form-harness.mjs';

const { ok } = counter();

function rig(dir) {
  const w = loadForm(dir);
  let t = Date.now();
  w.Date.now = () => t;                                             // the coordinator's clock is the page's Date.now
  let vis = 'visible';
  Object.defineProperty(w.document, 'visibilityState', { get: () => vis, configurable: true });
  let body = null;
  w.__respond = (url) => (url.includes('/menu/') && body ? res(body) : new Promise(() => {}));
  const menuCalls = () => w.__calls.filter((u) => u.includes('/menu/')).length;
  const comeBack = async (afterMs = 60001) => {
    t += afterMs;
    vis = 'hidden'; w.document.dispatchEvent(new w.Event('visibilitychange'));
    vis = 'visible'; w.document.dispatchEvent(new w.Event('visibilitychange'));
    await settle();
  };
  return { w, serveNext: (b) => { body = b; }, comeBack, menuCalls };
}
function xpGroup(B, w) {
  const m = B.menu(w);
  m.dishes.push({ id: 30, cat: 'ny', name: 'NY Plain Slice', price: 624 });
  [['Salsa Roja', 31], ['Salsa Vodka', 32]].forEach(([c, id]) => m.dishes.push({ id, cat: 'ny', name: `NY Plain Slice - ${c}`, price: 624, variantOf: 30, choice: c }));
  m.variant_items = { 30: { label: 'Salsa', basePrice: 624, variantIds: [31, 32] } };
  return m;
}

// ── x_pizza ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const dir = 'xpizza-orders'; const B = BRAND[dir];
  const { w, serveNext, comeBack, menuCalls } = rig(dir);
  await settle();
  const boot = menuCalls();
  const base = B.menu(w);

  // a published group arrives on the next return to view
  serveNext(envelope(B.rid, xpGroup(B, w)));
  await comeBack();
  assert.strictEqual(menuCalls(), boot + 1, 'a return to view after 60 s re-fetches once');
  assert.ok(w.document.getElementById('card-30'), 'the published group\'s launcher is on the grid');

  // rate limit
  await comeBack(1000);
  assert.strictEqual(menuCalls(), boot + 1, 'a return within 60 s does not re-fetch');

  // a rollback removing the launcher, arriving while a dish modal is open → deferred, lands on close
  serveNext(envelope(B.rid, { ...base, variant_items: {} }));
  w.openDetailModal(19); await settle();
  await comeBack();
  assert.strictEqual(menuCalls(), boot + 2, 'the re-fetch ran');
  assert.ok(w.liveMenuGlobalGet('VARIANT_ITEMS')[30], 'a modal is open → the snapshot is DEFERRED, the menu stands');
  w.closeDetailModal(); await settle(); await settle();
  assert.strictEqual(Object.keys(w.liveMenuGlobalGet('VARIANT_ITEMS')).length, 0, 'on close the rollback applies');
  assert.strictEqual(w.document.getElementById('card-30'), null, '…and the launcher is gone');

  // a payment in flight → deferred until idle
  serveNext(envelope(B.rid, xpGroup(B, w)));
  w.__paySubmitting = true;
  await comeBack();
  assert.strictEqual(w.document.getElementById('card-30'), null, 'a payment in flight → DEFERRED');
  w.__paySubmitting = false;
  w.__liveMenu.flush(); await settle();
  assert.ok(w.document.getElementById('card-30'), 'idle again → the held snapshot applies');

  // a malformed variant block is refused whole — the prior menu stands
  const before = w.liveMenuGlobalGet('MENU');
  const bad = xpGroup(B, w); bad.variant_items[30].variantIds = [31, 99];
  serveNext(envelope(B.rid, bad));
  await comeBack();
  assert.strictEqual(w.liveMenuGlobalGet('MENU'), before, '🔴 a malformed variant block is refused — MENU is the identical prior array');
  ok('x_pizza: a return to view re-fetches (rate-limited to 60 s) through the real chain — a published group appears, a rollback removing it applies after a modal closes, a payment in flight defers, a malformed variant block is refused whole');
}

// ── la_musa ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const dir = 'la-musa-orders'; const B = BRAND[dir];
  const { w, serveNext, comeBack, menuCalls } = rig(dir);
  await settle();
  const boot = menuCalls();
  const m = B.menu(w);
  m.dishes = m.dishes.map((d) => (d.id === 'dimsum_01' ? { ...d, price: d.price + 7 } : d));
  serveNext(envelope(B.rid, m));
  await comeBack();
  assert.strictEqual(menuCalls(), boot + 1);
  assert.strictEqual(w.liveMenuGlobalGet('MENU').find((d) => d.id === 'dimsum_01').price, 223 + 7, 'a re-priced dish applies on return');
  const before = w.liveMenuGlobalGet('MENU');
  const bad = B.menu(w); bad.variant_items = { noodle_01: { label: 'Proteína', basePrice: 307, variantIds: ['noodle_01_sin', 'gone'] } };
  serveNext(envelope(B.rid, bad));
  await comeBack();
  assert.strictEqual(w.liveMenuGlobalGet('MENU'), before, '🔴 la_musa: a malformed variant block is refused — the prior menu stands');
  ok('la_musa: a return to view re-fetches and applies a re-price; a malformed variant block is refused whole');
}

closeAll();
console.log('\nvisibility-refetch: OK');
