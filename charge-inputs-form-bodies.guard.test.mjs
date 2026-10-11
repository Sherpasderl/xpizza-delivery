// CHARGE-INPUTS FORM-BODY GUARD — every field the order forms actually SEND must be classified in
// charge-inputs.js, so chargeInputsFingerprint() never silently returns null (which would disable PB-1's
// reward bound-checkout reuse). This is the guard that would have caught codex P1-2: the Phase-1 location
// telemetry fields (client_user_agent / client_referrer) were unclassified, so their mere presence nulled
// the fingerprint. The bodies here are captured from the REAL form code (buildOrder + the real submit /
// charge / quote builders) driven through the jsdom harness — NOT hand-built — so a NEW form field that
// nobody classifies makes this FAIL on the next run.
// Run: node charge-inputs-form-bodies.guard.test.mjs
import assert from 'node:assert';
import { loadForm, closeAll, counter, settle, BRAND } from './form-harness.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { chargeInputsFingerprint } = require('./catalog/charge-inputs');

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];

// Drive a real order through the form and capture every body it sends (createOrder / chargeOnlineOrder / quoteOrder).
async function capture(dir, { card }) {
  const w = loadForm(dir);
  const sent = {};
  w.__respond = (url, init) => {
    const u = String(url); const body = init && init.body ? JSON.parse(init.body) : null;
    if (u.includes('createOrder')) sent.createOrder = body;
    else if (u.includes('chargeOnlineOrder')) sent.charge = body;
    else if (u.includes('quoteOrder')) sent.quote = body;
    return new Promise(() => {}); // never settles — leave page state where the builder left it
  };
  const prepared = w.liveMenuPrepare(BRAND[dir].menu(w));
  w.liveMenuGlobalSet('MENU', prepared.MENU);
  w.liveMenuGlobalSet('EXTRAS', prepared.EXTRAS);
  await settle();
  const dish = prepared.MENU.find((d) => d.price > 0);
  w.chg(dish.id, 2); await settle();
  if (prepared.EXTRAS[0]) { w.toggleDetailExtra(prepared.EXTRAS[0].id, dish.id, 0); await settle(); }
  const g = (id) => w.document.getElementById(id);
  for (const [id, v] of [['cname', 'Cliente Prueba'], ['cphone', '98765432'], ['cemail', 'cliente@test.hn'], ['notes', '']]) if (g(id)) g(id).value = v;
  assert.strictEqual(w.buildOrder(), true, `${dir}: premise — the order composes (card=${card})`);
  const pend = card ? (w.selectPay('online'), w.processPixelPay()) : w.submitOrder('confirmed');
  if (pend && pend.catch) pend.catch(() => {});
  await settle(); await settle();
  return sent;
}

(async () => {
  for (const dir of DIRS) {
    const cash = await capture(dir, { card: false });
    const card = await capture(dir, { card: true });
    // The three real money-path bodies that MUST fingerprint — each REQUIRED to be captured (not skipped),
    // so a missing capture can't let the guard pass vacuously. (quoteOrder rides the card path.)
    const required = {
      'createOrder (cash)': cash.createOrder,
      'chargeOnlineOrder (card)': card.charge,
      'quoteOrder (card)': card.quote,
    };
    for (const [name, body] of Object.entries(required)) {
      assert.ok(body && typeof body === 'object',
        `${dir}: premise — a REAL ${name} body must be captured (got ${body === undefined ? 'undefined' : typeof body}); the guard can't fingerprint what was never sent`);
      const fp = chargeInputsFingerprint(body);
      assert.ok(typeof fp === 'string' && fp.length === 64,
        `${dir}: ${name} → chargeInputsFingerprint returned ${fp === null ? 'NULL' : JSON.stringify(fp)}. A real form body carries a field that charge-inputs.js does not classify (CHARGE_INPUT_FIELDS / NON_CHARGE_FIELDS / UNREAD_FORM_FIELDS) — its presence nulls the fingerprint and disables PB-1 reward bound-reuse. Classify the new field (this is exactly how the Phase-1 telemetry P1 slipped in).`);
    }
    ok(`${dir}: real createOrder + chargeOnlineOrder + quoteOrder bodies all fingerprint non-null (no unclassified form field)`);
  }
  console.log(`\ncharge-inputs-form-bodies.guard: ${count()} passed`);
  closeAll();
})().catch((e) => { console.error('charge-inputs-form-bodies FAILED:', e && e.stack || e); closeAll(); process.exit(1); });
