'use strict';
// MINT_OPAQUE prerequisite 3 (advisor 2026-11-11) — the EMULATOR half of kds-ticket-names: La Musa re-keys orders from the KDS
// ticket, so the ticket must print HUMAN names. Through the REAL publisher (an existing dish renamed under its frozen key + a NEW
// minted dish), the REAL public menu (buildPublicMenu) → the capp's own adapter/cart/serializer → the REAL createOrder with a
// member's reward of the minted dish (no client name) → the STORED items_text → the kitchen's own renderer (lifted from
// xpizza-kitchen/index.html) and the handheld's orderView. Both key modes. Run: npm run test:kds-names
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'kds-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'kds-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(q.pixelpayOrderId); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { verifyQuoteToken } = require('../quote-token');
const ROOT = require('path').join(__dirname, '..', '..');
const { buildPublicMenu } = require('../catalog/public-menu');
const { adaptMenu } = require(require('path').join(ROOT, 'customer-app/capp-menu.js'));
const { createCart } = require(require('path').join(ROOT, 'customer-app/capp-cart.js'));
const { serialize } = require(require('path').join(ROOT, 'customer-app/capp-serialize.js'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('kds-names(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const MENU_CHANGED = { error: 'menu_changed', detail: 'El menú se actualizó, recargá la página', retryable: false };
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: res.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
async function seed(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `kds-${rid}` });
  await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid));
}
const dish = (rid) => catalogSnapshot(rid).items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
const lineOf = (rid, over = {}) => { const it = dish(rid); return { ...(rid === 'x_pizza' ? { name: it.display.name } : { id: it.key, name: it.display.name, cat: it.display.cat }), qty: 1, price: it.price, extras: [], ...over }; };
const bodyFor = (rid, oid, phone, items, extra = {}) => ({ restaurant_id: rid, order_id: oid, customer_name: 'KDS Test', customer_phone: phone, customer_email: 'kds@example.com',
  items_text: '1x test', order_type: 'pickup', payment_method: 'cash', items, ...extra });
let seq = 0;
const fresh = async () => { await rtdb.ref('rate_limits').remove(); seq += 1; return { oid: `kds_${seq}_${Date.now() % 100000}`, phone: `9945${String(1000 + seq).slice(-4)}` }; };
const written = async (oid) => (await rtdb.ref(`orders/${oid}`).get()).exists();


const fsys = require('fs');
const vm = require('vm');
const { mintKey } = require('../catalog/mint-opaque');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const KEY_RE = /\bi_[a-z2-7]{12}\b/i;
function kitchen() {   // the kitchen's renderer, lifted verbatim (function source by brace matching)
  const html = fsys.readFileSync(require('path').join(ROOT, 'xpizza-kitchen/index.html'), 'utf8');
  const lift = (name) => { const at = html.indexOf(`function ${name}(`); assert.ok(at >= 0, `premise: the kitchen defines ${name}`);
    let depth = 0, i = html.indexOf('{', at); for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; } return html.slice(at, i + 1); };
  const ctx = {}; vm.createContext(ctx); vm.runInContext(`${lift('escapeHtml')}\n${lift('renderItems')}\nthis.renderItems = renderItems;`, ctx); return ctx.renderItems;
}
const ticketText = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
// the owner's publish of a version with an existing dish RENAMED (key frozen) + a NEW minted dish, on top of the seeded one
async function publishMinted(rid) {
  const src = canonicalize(buildSourceFromCode(rid));
  const dishes = src.items.filter((i) => i.display && !i.display.variantOf && !(src.structure.variant_items || {})[i.display.id]);
  const renamed = dishes[0]; const oldKey = renamed.key;
  const nextId = Math.max(...src.items.map((i) => Number(i.display.id)).filter(Number.isFinite)) + 1;
  const minted = mintKey();
  src.frozen_keys = { ...(src.frozen_keys || {}), [renamed.display.id]: oldKey, [rid === 'la_musa' ? minted : nextId]: minted };
  renamed.display = { ...renamed.display, name: 'Especial de la Casa' };
  const disp = { ...renamed.display, id: rid === 'la_musa' ? minted : nextId, name: 'Pizza Nueva', price: 150, desc: '' };
  delete disp.identity_id; delete disp.has_photo; delete disp.extras_policy;
  src.items.push({ key: minted, price: 150, display: disp }); src.structure.item_order.push(minted);
  await sourceRefOf(fs, rid).set(src);
  const { inputs, built } = buildSourceCandidate(rid, src);
  const active = (await getActivePointer(fs, rid)).version;
  await publishVersion(fs, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: `kds-minted-${rid}`, key_mode: built.key_mode, frozen_keys: built.frozen_keys },
    { expected: { activeVersionId: active }, mirror: makeRtdbMirror(rtdb) });
  return { minted, oldKey };
}

(async () => {
  const render = kitchen();
  const { orderView } = await import(require('path').join(ROOT, 'xpizza-handheld/model.js'));
  // every publish BEFORE the first request: no handler has cached a pointer yet
  for (const rid of ['x_pizza', 'la_musa']) await seed(rid);
  const V = {};
  for (const rid of ['x_pizza', 'la_musa']) V[rid] = await publishMinted(rid);
  await rtdb.ref('config/redemption_enabled').set(true);
  const uid = 'u_kds';
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`user_rewards/${uid}/${rid}`).set({ balance: 100000, reserved: 0 });

  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 }, { merge: true });
    const pm = await buildPublicMenu(fs, rid, { known: new Set([rid]), isActive: async () => true });
    const m = adaptMenu({ rid: pm.rid, representation_version: pm.representation_version, menu: pm.body });
    const byName = (nm) => m.dishes.find((d) => d.name === nm);
    const mintedDish = byName('Pizza Nueva'); const renamedDish = byName('Especial de la Casa');
    assert.ok(mintedDish && renamedDish, `KDS-E-PREMISE ${rid}: the served menu carries both dishes by their labels`);
    const cart = createCart(m); cart.inc(renamedDish.key); cart.inc(mintedDish.key);
    const offered = m.extrasFor(mintedDish.key).filter((e) => e.supported);
    if (offered.length) cart.setInstance(mintedDish.key, 0, [offered[0].key]);
    const s = serialize(cart, m);
    const redeem = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: V[rid].minted } : { type: 'points_ala_carte', items: [{ id: V[rid].minted, qty: 1 }] };
    const f = await fresh();
    const co = await post(app.createOrder, bodyFor(rid, f.oid, f.phone, s.items, { items_text: s.items_text, redeem }), { 'x-firebase-id-token': uid });
    assert.strictEqual(co.status, 200, `KDS-E-ORDER ${rid}: the order with the minted dish, its extra and its reward places (${co.text.slice(0, 200)})`);
    const stored = (await rtdb.ref(`orders/${f.oid}`).get()).val();
    const text = stored.items_text;
    assert.ok(!KEY_RE.test(text), `KDS-E-STORED ${rid}: no minted key in the stored order text: ${text}`);
    assert.ok(text.endsWith(' | 1x Pizza Nueva (Recompensa)'), `KDS-E-REWARD ${rid}: the server's reward line names the dish: ${text}`);
    const kds = ticketText(render(text));
    for (const nm of ['Especial de la Casa', 'Pizza Nueva', ...(offered.length ? [offered[0].name] : [])]) assert.ok(kds.includes(nm), `KDS-E-TICKET ${rid}: the kitchen ticket shows «${nm}»: ${kds}`);
    assert.ok(!KEY_RE.test(kds), `KDS-E-TICKET ${rid}: no minted key on the kitchen ticket: ${kds}`);
    const hv = JSON.stringify(orderView(stored));
    assert.ok(hv.includes('Pizza Nueva') && hv.includes('Especial de la Casa') && !KEY_RE.test(hv), `KDS-E-HANDHELD ${rid}: ${hv.slice(0, 300)}`);
    ok(`${rid}: renamed dish, NEW minted dish${offered.length ? ' + its extra' : ''} and its reward print by name on the stored order, the kitchen ticket and the handheld`);
  }

  FINISHED = true;
  console.log(`\nkds-names(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('kds-names(emulator) FAILED:', e && e.message ? e.message.slice(0, 600) : e); process.exit(1); });
