// R3 P0 — FORM FETCH ROUTING (PLAN-R3 rev 4.1 §5a): the REAL order form (shared /form-harness.mjs) with every network call
// routed to the REAL handlers (contract/form-router.js). The menu comes from the real getPublicMenu, the quote from the
// real quoteOrder, the order from the real createOrder via the form's own submitOrder; the confirmation screen is
// rendered from that real response. Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:r3-p0-forms
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { loadForm, settle, closeAll } from '../../form-harness.mjs';
const require = createRequire(import.meta.url);
require('../test/_emulator-required')('database', 'firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
// the order-intake bearer the FORM sends is the constant in its own (public) page source; production's server secret
// equals it. Read from the page — never from a .env — so the real handler authenticates the real request.
{
  const { readFileSync } = await import('node:fs');
  const m = /const ORDER_SECRET\s*=\s*'([0-9a-f]+)'/.exec(readFileSync(new URL('../../xpizza-orders/index.html', import.meta.url), 'utf8'));
  if (!m) throw new Error('premise — the form\'s ORDER_SECRET constant was not found in its page source');
  process.env.MAKE_SECRET = m[1];
}

// send boundaries
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (cell, msg) => `🔴 R3-P0:${cell} ${msg}`;

require('../test/_catalog-clock').install();
require('./version-witness').install();
const admin = require('firebase-admin');
const app = require('../index.js');
const { makeFormRouter } = require('./form-router');
const rtdb = admin.database(); const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const OPEN = { open: true, start: '00:00', end: '24:00' };

try {
  await rtdb.ref().set(null);
  const rid = 'x_pizza';
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'forms' });
  await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
  // identities exist BEFORE the active publish (production order): republish so the serving version carries them
  { const v1 = (await getActivePointer(fs, rid)).version; const b = buildPublishCandidate(rid, { activeVersionId: v1 }, { source_sha: 'forms-v2' });
    await publishVersion(fs, rid, b.input, { expected: { activeVersionId: v1 }, mirror: makeRtdbMirror(rtdb) }); }
  await rtdb.ref(`restaurants/${rid}/identity`).set({ name: 'X Pizza', phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });

  const R = makeFormRouter({ app, rtdb });
  const w = loadForm('xpizza-orders');
  w.__respond = (url, init) => R.respond(url, init);
  await w.__liveMenu.feed.refresh(); await settle();
  await w.loadAvailability(); await settle();
  const menuCall = R.log.find((x) => x.fn === 'getPublicMenu');
  assert.ok(menuCall && menuCall.status === 200, FAIL('F1', `the form's live menu came from the REAL getPublicMenu (${JSON.stringify(R.log.map((x) => `${x.fn}:${x.status}`))})`));
  const menu = w.liveMenuGlobalGet('MENU');
  const dish = menu.find((d) => /Carnivora/.test(d.name)) || menu[0];
  assert.ok(dish && dish.id != null, FAIL('F1', 'premise — the applied live menu has a dish'));
  ok(`F1 the real form booted; its live menu came from the real getPublicMenu (${menu.length} dishes applied); availability via the RTDB read`);

  // the customer's turn: the form's OWN setters and inputs
  w.chg(dish.id, 1);
  w.setOrderType('pickup');
  w.document.getElementById('cname').value = 'Forms Real';
  w.document.getElementById('cphone').value = '99887766';
  w.document.getElementById('cemail').value = 'forms@example.com';
  w.requestServerQuote();
  // the real handler answers over a real (in-process) HTTP round trip — wait for it, bounded, then let the page apply it
  const waitFor = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };
  await waitFor(() => R.log.some((x) => x.fn === 'quoteOrder')); await settle(); await new Promise((r) => setTimeout(r, 300)); await settle();
  const quote = R.log.filter((x) => x.fn === 'quoteOrder').pop();
  assert.ok(quote && quote.status === 200 && quote.res && quote.res.ok, FAIL('F2', `the real quoteOrder priced the cart (${JSON.stringify(quote && { s: quote.status, r: quote.res })}; calls ${JSON.stringify(R.log.map((x) => x.fn))}; sent ${JSON.stringify(quote && quote.req).slice(0, 600)}; headers ${JSON.stringify(quote && quote.headers)}; dish ${JSON.stringify(dish).slice(0, 300)})`));
  ok(`F2 the real quoteOrder priced the form's own serialized cart: ${quote.res.total_cents} cents`);

  // the real sequence (as whole-flow drives it): the checkout step composes the order with the form's own buildOrder(),
  // then the confirm sends it with submitOrder — no field of currentOrder is written by the test
  const built = w.buildOrder();
  assert.ok(built !== false, FAIL('F3', 'premise — the form composed the order (buildOrder refused it)'));
  const p = w.submitOrder('confirmed'); if (p && p.catch) p.catch(() => {});
  for (let i = 0; i < 40 && !R.log.some((x) => x.fn === 'createOrder'); i += 1) await new Promise((r) => setTimeout(r, 50));
  await settle(); await settle();
  const create = R.log.find((x) => x.fn === 'createOrder');
  assert.ok(create, FAIL('F3', `the form's submit reached the REAL createOrder (${JSON.stringify(R.log.map((x) => x.fn))}; refused ${JSON.stringify(R.refused)})`));
  assert.strictEqual(create.status, 200, FAIL('F3', `createOrder HTTP 200 (${create.status} ${JSON.stringify(create.res).slice(0, 200)})`));
  const oid = create.res.order_id;
  const order = (await rtdb.ref(`orders/${oid}`).get()).val();
  assert.ok(order && order.customer_name === 'Forms Real' && order.order_type === 'pickup', FAIL('F3', `the order the FORM built was persisted (${JSON.stringify(order && { n: order.customer_name, t: order.order_type })})`));
  assert.strictEqual(order.total_cents, quote.res.total_cents, FAIL('F3', `persisted total (${order.total_cents}) = the quote the customer saw (${quote.res.total_cents})`));
  ok(`F3 the form's own submitOrder → the REAL createOrder (HTTP 200) → order ${oid} persisted: total ${order.total_cents} = the quoted ${quote.res.total_cents}`);

  // showSuccess → stage #s5 becomes the active stage (after showStage's 170 ms cross-dissolve fallback) and prints the id
  let s5 = null;
  for (let i = 0; i < 60; i += 1) { s5 = w.document.querySelector('#s5.stage.active'); if (s5) break; await new Promise((r) => setTimeout(r, 50)); }
  const shown = (w.document.getElementById('order-id-display') || {}).textContent || '';
  console.log(`F4-OBS active stage: ${(w.document.querySelector('.stage.active') || {}).id}; order-id-display: ${shown}; s5 text: ${(s5 ? s5.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  assert.ok(s5, FAIL('F4', `the confirmation stage #s5 is active after the REAL createOrder response (active: ${(w.document.querySelector('.stage.active') || {}).id})`));
  // R3-REPIN D19 (2026-10-13, owner fix 3a cb21bb9): the confirmation's number is the kitchen's display_number (F-NUM),
  // NEVER the long order_id. Old pin: "#order-id-display includes the createOrder order_id". New: the long id is ABSENT
  // and the line starts "Orden #"; once the order's tracking node carries the stamped display_number (written here as
  // allocateDisplayNumberOnSale writes it — this suite runs no triggers; the P1 journey runs the real allocator), the line
  // is exactly "Orden #<that number>".
  assert.ok(!shown.includes(oid) && /^Orden #/.test(shown.trim()), FAIL('F4', `the confirmation must not show the long order id and must start "Orden #" (shown "${shown}", order_id ${oid})`));
  const token = order.tracking_token;
  assert.ok(typeof token === 'string' && token.length >= 8, FAIL('F4', `premise — the persisted order carries its tracking_token (${token})`));
  const N = 47;
  await rtdb.ref(`order_tracking/${token}/display_number`).set(N);
  let numbered = '';
  for (let i = 0; i < 160; i += 1) { await settle(); numbered = ((w.document.getElementById('order-id-display') || {}).textContent || '').trim(); if (numbered === `Orden #${N}`) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.strictEqual(numbered, `Orden #${N}`, FAIL('F4', `after display_number ${N} is stamped on order_tracking/${token}, the confirmation reads "Orden #${N}" (got "${numbered}")`));
  assert.ok(!numbered.includes(oid), FAIL('F4', 'the long order id reappeared'));
  ok(`F4 the confirmation stage (#s5) is active; before the number lands it shows "${shown.trim()}" (never the long id ${oid}); once display_number ${N} is stamped on the order's tracking node it reads "${numbered}" — rendered from the real submit, no currentOrder injection`);

  assert.deepStrictEqual(R.refused, [], FAIL('F5', `unrouted network calls: ${JSON.stringify(R.refused)}`));
  ok(`F5 every network call the form made was routed to a real handler (${[...new Set(R.log.map((x) => x.fn))].join(', ')}); none refused`);

  closeAll();
  console.log(`\nr3-p0-forms: OK (${n})`);
  process.exit(0);
} catch (e) { console.error('r3-p0-forms FAILED:', e && e.stack || e); process.exit(1); }
