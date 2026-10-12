// Menu-card QUANTITY STEPPER — regression guard (both forms). The UberEats-style qty overlay must stay
// EXPANDED while the customer taps +/−, and collapse to the total badge only on a GENUINE outside tap.
// The regression: registerOutsideClick's document listener collapsed on EVERY click (no target check), so
// after the safe-render refactor dropped the inline onclick="event.stopPropagation()", each +/− tap bubbled
// to it and collapsed the stepper. This drives REAL click events through the real delegated handler + the
// real document outside-click listener (the 150ms-deferred one), so it catches exactly that interaction.
// Run: node qty-stepper-outside-click.test.mjs
import assert from 'node:assert';
import { loadForm, closeAll, counter, settle, BRAND } from './form-harness.mjs';

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(dir) {
  const w = loadForm(dir);
  const prepared = w.liveMenuPrepare(BRAND[dir].menu(w));
  w.liveMenuGlobalSet('MENU', prepared.MENU); w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
  await settle();
  const doc = w.document;
  // a CARD-GRID dish with the collapse-to-badge UX (has both the add button and a badge element)
  const id = prepared.MENU.map((d) => d.id).find((x) => doc.getElementById('qty-add-' + x) && doc.getElementById('qty-badge-' + x));
  assert.ok(id != null, `${dir}: premise — a card-grid dish with the qty stepper rendered`);
  const controls = () => doc.getElementById('qty-controls-' + id);
  const badge = () => doc.getElementById('qty-badge-' + id);
  const vis = () => controls() && controls().classList.contains('visible');

  // open the stepper: tap the + add button
  doc.getElementById('qty-add-' + id).click(); await settle();
  assert.ok(vis(), `${dir}: stepper opens on the first add`);
  await wait(200); // let registerOutsideClick's deferred (150ms) document listener attach

  // THE regression, asserted on the FIRST tap after the outside-click listener is live: a +/− tap must not
  // collapse the stepper. (Checking after the first tap matters — the buggy listener self-removes after one
  // collapse, so chg would re-show the controls on later taps and mask the bug.)
  controls().querySelector('[data-act="inc"]').click(); await settle();
  assert.ok(vis(), `${dir}: 🔴 the stepper STAYS open after a +/− tap (the regression collapsed it to the badge on every tap)`);
  assert.strictEqual(doc.getElementById('qty-' + id).textContent, '2', `${dir}: qty incremented to 2`);
  // keeps open across more +/− taps
  controls().querySelector('[data-act="inc"]').click(); await settle();
  controls().querySelector('[data-act="dec"]').click(); await settle();
  assert.ok(vis() && doc.getElementById('qty-' + id).textContent === '2', `${dir}: stays open across +/− (qty back to 2)`);
  ok(`${dir}: +/− taps keep the stepper open and change the qty`);

  // a GENUINE outside tap collapses it to the total badge
  doc.body.click(); await settle();
  assert.ok(!vis(), `${dir}: an outside tap collapses the stepper`);
  assert.ok(badge() && badge().style.display === 'flex', `${dir}: collapsed to the total badge (showing the qty)`);
  ok(`${dir}: a genuine outside tap collapses to the badge`);

  // tapping the badge reopens the stepper
  badge().click(); await settle();
  assert.ok(vis(), `${dir}: tapping the badge reopens the stepper`);
  ok(`${dir}: badge tap reopens the stepper`);
}

(async () => {
  for (const dir of DIRS) await run(dir);
  console.log(`\nqty-stepper-outside-click: ${count()} passed`);
  closeAll();
})().catch((e) => { console.error('qty-stepper-outside-click FAILED:', (e && e.stack) || e); closeAll(); process.exit(1); });
