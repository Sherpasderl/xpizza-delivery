'use strict';
// MINT_OPAQUE prerequisite 3 (advisor 2026-11-11): La Musa has no POS link — staff re-key orders from the KDS ticket — so the
// evidence is that the ticket prints HUMAN names, never a minted key, for (1) an existing renamed dish, (2) a NEW minted dish,
// (3) its extras, (4) its redemption. Unit half (single-file): the real builders (seed source → candidate → price docs →
// labels exactly as the reader takes them), the real reward intake (the free line the SERVER appends), the real capp serializer
// (the paid lines the CLIENT writes), the kitchen's own ticket renderer (lifted verbatim from xpizza-kitchen/index.html) and the
// handheld's orderView. The emulator half (test/kds-ticket-names.emulator.test.js) runs the same through the real handlers.
// Run: node kds-ticket-names.test.js
const assert = require('assert');
const path = require('path');
const fsys = require('fs');
const vm = require('vm');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const { buildSourceCandidate } = require('./catalog/candidate-validate');
const { buildTablesFromDocs, labelsFromSnap } = require('./catalog/catalog-transform');
const { attachTablesKeyMode, attachTablesLabels, computeServerTotal } = require('./menu-pricing');
const { redeemEligibleFrom } = require('./catalog/menu-gates');
const { composeServedMenu } = require('./catalog/public-menu');
const { withServedItemKeys, servedKeyMap } = require('./catalog/identity-overlay');
const { mintKey, OPAQUE_SYNTAX } = require('./catalog/mint-opaque');
const { prepareRedemption } = require('./rewards-redeem-intake');
const RL = require('./catalog/resolve-lines');
const ROOT = path.join(__dirname, '..');
const { adaptMenu } = require(path.join(ROOT, 'customer-app/capp-menu.js'));
const { createCart } = require(path.join(ROOT, 'customer-app/capp-cart.js'));
const { serialize } = require(path.join(ROOT, 'customer-app/capp-serialize.js'));

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const KEY_RE = /\bi_[a-z2-7]{12}\b/i;   // the minted-key shape (OPAQUE_SYNTAX, unanchored)

// the kitchen's renderer, lifted verbatim (function source by brace matching) — never re-implemented here
function kitchen() {
  const html = fsys.readFileSync(path.join(ROOT, 'xpizza-kitchen/index.html'), 'utf8');
  const lift = (name) => {
    const at = html.indexOf(`function ${name}(`); assert.ok(at >= 0, `premise: the kitchen defines ${name}`);
    let depth = 0, i = html.indexOf('{', at);
    for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
    return html.slice(at, i + 1);
  };
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(`${lift('escapeHtml')}\n${lift('renderItems')}\nthis.renderItems = renderItems;`, ctx);
  return ctx.renderItems;
}
const ticketText = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// a version as an owner publishes it: an existing dish RENAMED (its key frozen) + a NEW minted dish in the reward category
function versionOf(rid, { renameTo, mintName }) {
  const src = buildSourceFromCode(rid);
  const dishes = src.items.filter((i) => i.display && !i.display.variantOf && !(src.structure.variant_items || {})[i.display.id]);
  const renamed = dishes[0];
  const oldKey = renamed.key;
  const nextId = Math.max(...src.items.map((i) => Number(i.display.id)).filter(Number.isFinite)) + 1;
  const minted = mintKey();
  assert.ok(OPAQUE_SYNTAX.test(minted), 'premise: the real minter shapes the key');
  src.frozen_keys = { ...(src.frozen_keys || {}), [renamed.display.id]: oldKey, [rid === 'la_musa' ? minted : nextId]: minted };
  renamed.display = { ...renamed.display, name: renameTo };
  const cat = renamed.display.cat;
  const disp = { ...renamed.display, id: rid === 'la_musa' ? minted : nextId, name: mintName, price: 150, desc: '' };
  delete disp.identity_id; delete disp.has_photo; delete disp.extras_policy;
  src.items.push({ key: minted, price: 150, display: disp });
  src.structure.item_order.push(minted);
  const { built } = buildSourceCandidate(rid, src);
  // the reader's tables: price docs {key, price} → buildTablesFromDocs, labels from the same docs (catalog-firestore.js:174)
  const t = buildTablesFromDocs(built.items.map((i) => ({ key: i.key, price: i.price })), (built.extras || []).map((e) => ({ key: e.key, price: e.price })));
  const labels = labelsFromSnap({ docs: built.items.map((i) => ({ data: () => i })) });
  const tables = attachTablesLabels(attachTablesKeyMode({ restaurantId: rid, ...t }, built.key_mode), labels);
  return { built, tables, oldKey, minted, cat };
}
// the RTDB the intake reads (redemption flag on, no availability node = every line available) — read-only, as production reads it
const dbOf = (vals) => ({ ref: (p) => ({ get: async () => ({ val: () => (p in vals ? vals[p] : null) }), once: async () => ({ val: () => (p in vals ? vals[p] : null) }) }) });
const DB = dbOf({ 'config/redemption_enabled': true });
// the handler's resolution stage first (index.js:831 / :1557): it stamps every paid line with its resolved key, as production does
async function intake(rid, { redeem, items, itemsText, tables, eligible }) {
  const body = { items: JSON.parse(JSON.stringify(items)), redeem };
  const rl = RL.resolveLines(rid, body, tables);
  assert.ok(rl.ok, `premise: the stage resolves (${JSON.stringify(rl)})`);
  const total = computeServerTotal(body.items, rid, tables);   // the handler's own total (validateOrderPayload)
  assert.ok(!total.error, `premise: the paid cart prices (${total.error})`);
  return prepareRedemption(DB, { redeem, items: body.items, restaurantId: rid, itemsText, totalLempiras: total.total, customerUid: 'u_kds', tables, eligible });
}

(async () => {
  const render = kitchen();
  const { orderView } = await import(path.join(ROOT, 'xpizza-handheld/model.js'));

  for (const rid of ['x_pizza', 'la_musa']) {
    const v = versionOf(rid, { renameTo: 'Especial de la Casa', mintName: 'Pizza Nueva' });
    // the capp's paid lines from the served body: THE composer buildPublicMenu serves (public-menu.js composeServedMenu) + the
    // endpoint's item_keys overlay (identity-overlay.js withServedItemKeys, S1d D7) — the eligibility/photos decorations play no
    // part in names
    const menu = { items: v.built.items, structure: v.built.structure, extras: v.built.extras };
    const body = withServedItemKeys(rid, composeServedMenu(rid, menu), servedKeyMap(menu));
    const m = adaptMenu({ rid, representation_version: 1, menu: body });
    const dishFor = (name) => m.dishes.find((d) => d.name === name);
    const mintedDish = dishFor('Pizza Nueva'); const renamedDish = dishFor('Especial de la Casa');

    await cell(`KDS-NAMES-PREMISE ${rid}: the served menu names the minted and the renamed dish by their labels`, (L) => {
      assert.ok(mintedDish && renamedDish, `${L}: both dishes are in the capp's menu`);
    });

    const cart = createCart(m);
    cart.inc(renamedDish.key);
    cart.inc(mintedDish.key);
    const offered = m.extrasFor(mintedDish.key).filter((e) => e.supported);
    let paid;
    await cell(`KDS-NAMES-CAPP-LINES ${rid}: the client's paid lines (renamed dish, minted dish + its extra) carry names only`, (L) => {
      paid = serialize(cart, m);
      assert.ok(!KEY_RE.test(paid.items_text), `${L}: no minted key in the client text: ${paid.items_text}`);
      assert.ok(paid.items_text.includes('Especial de la Casa') && paid.items_text.includes('Pizza Nueva'), `${L}: both names: ${paid.items_text}`);
    });
    if (offered.length) {
      const c2 = createCart(m); c2.inc(mintedDish.key);
      await cell(`KDS-NAMES-CAPP-EXTRA ${rid}: the minted dish's extra prints by its name`, (L) => {
        c2.setInstance(mintedDish.key, 0, [offered[0].key]);
        const s = serialize(c2, m);
        assert.ok(s.items_text.includes(`[${offered[0].name}]`) && !KEY_RE.test(s.items_text), `${L}: ${s.items_text}`);
      });
    }

    // the reward: the client's redeem body WITHOUT a display name — the server must name the free line itself
    const eligible = redeemEligibleFrom(rid, v.built);
    const redeemOf = (name) => (rid === 'x_pizza'
      ? { type: 'free_pizza_choice', item_id: v.minted, ...(name ? { name } : {}) }
      : { type: 'points_ala_carte', items: [{ id: v.minted, qty: 1, ...(name ? { name } : {}) }] });
    const items = paid ? paid.items : [];
    for (const [tag, clientName] of [['NO-CLIENT-NAME', null], ['STALE-CLIENT-NAME', 'Nombre Viejo']]) {
      await cell(`KDS-NAMES-REWARD-${tag} ${rid}: the server's free line names a minted key by its LABEL, never the key`, async (L) => {
        const r = await intake(rid, { redeem: redeemOf(clientName), items, itemsText: paid.items_text, tables: v.tables, eligible });
        assert.ok(r.ok, `${L}: premise: the redemption prepares (${JSON.stringify(r.body || {})})`);
        const tail = r.itemsText.slice(paid.items_text.length);
        assert.strictEqual(tail, ' | 1x Pizza Nueva (Recompensa)', `${L}: the appended line`);
        assert.ok(!KEY_RE.test(r.itemsText), `${L}: no minted key anywhere in the ticket text`);
      });
    }

    await cell(`KDS-NAMES-TICKET ${rid}: the kitchen ticket and the handheld show the renamed dish, the minted dish and the reward by name`, async (L) => {
      const r = await intake(rid, { redeem: redeemOf(null), items, itemsText: paid.items_text, tables: v.tables, eligible });
      const kds = ticketText(render(r.itemsText));
      for (const name of ['Especial de la Casa', 'Pizza Nueva']) assert.ok(kds.includes(name), `${L}: kitchen shows «${name}»: ${kds}`);
      assert.ok(!KEY_RE.test(kds), `${L}: no minted key on the kitchen ticket: ${kds}`);
      const hv = JSON.stringify(orderView({ items_text: r.itemsText }));
      assert.ok(hv.includes('Pizza Nueva') && !KEY_RE.test(hv), `${L}: handheld view: ${hv}`);
    });
  }

  // NO-REGRESSION: a non-minted reward key keeps today's exact text (the client's name, else the key itself)
  await cell('KDS-NAMES-LEGACY-BYTES x_pizza: a non-minted reward line is byte-identical to today', async (L) => {
    const v = versionOf('x_pizza', { renameTo: 'Especial de la Casa', mintName: 'Pizza Nueva' });
    const eligible = redeemEligibleFrom('x_pizza', v.built);
    const plain = [...eligible.allow].find((k) => !OPAQUE_SYNTAX.test(k) && Object.prototype.hasOwnProperty.call(v.tables.menu, k) && k !== v.oldKey);
    assert.ok(plain, 'premise: a plain redeemable dish');
    for (const [name, want] of [[plain, plain], ['Cliente Dice', 'Cliente Dice'], [null, plain]]) {
      const r = await intake('x_pizza', { redeem: { type: 'free_pizza_choice', item_id: plain, ...(name ? { name } : {}) }, items: [{ name: plain, qty: 1, price: v.tables.menu[plain], extras: [] }], itemsText: '1x test', tables: v.tables, eligible });
      assert.ok(r.ok, `${L}: premise: prepares (${JSON.stringify(r.body || {})})`);
      assert.strictEqual(r.itemsText, `1x test | 1x ${want} (Recompensa)`, `${L}: name=${name}`);
    }
  });

  if (fails.length) { console.log(`kds-ticket-names FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`kds-ticket-names: OK (${n})`);
})().catch((e) => { console.error('kds-ticket-names FAILED:', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e); process.exit(1); });
