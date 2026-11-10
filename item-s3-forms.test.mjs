// S3 (D4c-grill/item-s1/S3-DESIGN.md D1/D3 + the advisor's Q3 ruling) — THE ORDER FORMS send item_key. Run: node item-s3-forms.test.mjs
// Both forms, the REAL booted page, served the REAL published body (item-s3-fixtures.mjs: publish → buildPublicMenu's endpoint path,
// S1d's top-level `item_keys`), every body judged by the server's OWN stage (resolveLines) over the SAME version's tables:
//   1  PREP: liveMenuPrepare carries the map as the ITEM_KEYS global, applied with MENU; a body without one EMPTIES it (never «keep
//      in force»); the baked page before any live apply holds {}
//   2  LINE: a fresh card cart sends item_key = the map's, appended LAST; name kept; la_musa's id kept (it equals the key); the same
//      cart served WITHOUT a map sends exactly the line minus item_key (no map = today's bytes)
//   3  RENAME (x_pizza, the editor's recordRenames): the renamed dish's line {name: new label, item_key: kept key} resolves and
//      prices; the same line without item_key is the server's menu_changed (the field is load-bearing)
//   4  MINT (la_musa, S1c's allocator): the minted dish's line carries item_key ALONE (no id — it would disagree); it resolves; the
//      same line with its display id is the server's invalid_line
//   5  REWARD: the picker's key is the dish's item_key (a renamed x_pizza dish, a minted la_musa dish) — rewards resolve by exact key
//   6  AVAILABILITY: an 86 under the item_key (the portal's writer key, ops-core.js:385-390) marks a minted dish sold, in both forms
//      (a minted dish, never a renamed one: the form's own key history already holds a renamed dish's old name = its key)
//   7  Q3-A DEPLOY-SPANNING: a stash written by the pre-S3 page (af69a266) resumes here — with the map served — byte-identically:
//      order_id, items (no item_key), items_text, orderFingerprint, charge_inputs_fp; card and cash
//   8  Q3-B: an S3 stash (lines WITH item_key) resumed BEFORE the live map arrives keeps item_key byte-identically
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { counter, settle, loadForm, res, serve, BRAND, closeAll, loadAvail } from './form-harness.mjs';
import { published } from './item-s3-fixtures.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { computeServerTotal } = require('./menu-pricing');
const { resolveLines } = require('./catalog/resolve-lines');
const { orderFingerprint } = require('./pixelpay-charge');
const { chargeInputsFingerprint } = require('./catalog/charge-inputs');
const { ok } = counter();
const WATCHDOG = setTimeout(() => { console.error('item-s3-forms: FAILED — watchdog'); process.exit(1); }, 300000);
const plain = (x) => JSON.parse(JSON.stringify(x));
const clone = plain;
const STASH = { 'xpizza-orders': 'xpizza_pending_pay', 'la-musa-orders': 'lamusa_pending_pay' };
const DIR = { x_pizza: 'xpizza-orders', la_musa: 'la-musa-orders' };
const quiet = async (fn) => { const l = console.log, wn = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = wn; } };

// the PRE-S3 page (the capp tip this branch starts from), beside this suite; removed on exit
const OLD_SHA = 'af69a266';
const ROOT = fileURLToPath(new URL('./', import.meta.url));
const OLD_DIR = 'node_modules/.s3-old-client';
function materializeOld(dir) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-tree', '--name-only', OLD_SHA, `${dir}/`], { encoding: 'utf8' }).split('\n').filter((f) => /\.(html|js)$/.test(f));
  assert.ok(files.includes(`${dir}/index.html`), `premise: ${OLD_SHA} has ${dir}/index.html`);
  mkdirSync(`${ROOT}${OLD_DIR}/${dir}`, { recursive: true });
  for (const f of files) writeFileSync(`${ROOT}${OLD_DIR}/${f}`, execFileSync('git', ['-C', ROOT, 'show', `${OLD_SHA}:${f}`]));
}
process.on('exit', () => { try { rmSync(`${ROOT}${OLD_DIR}`, { recursive: true, force: true }); } catch (_) {} try { rmdirSync(`${ROOT}node_modules`); } catch (_) {} });

// The endpoints, answered like the server over the SAME version's tables: the stage first (it stamps the resolved key), then
// pricing — the quote is fail-soft (200 { ok:false, error }), a charge refusal is resolutionRefusal's shape.
function respondWith(w, P, sent, { live = true } = {}) {
  const rid = P.env.rid;
  const judge = (body) => resolveLines(rid, body, P.tables);
  w.__respond = (url, init) => {
    if (url.includes('/menu/')) return live ? res(clone(P.env)) : new Promise(() => {});
    const body = JSON.parse((init && init.body) || '{}');
    if (url.includes('quoteOrder')) {
      const r = judge(clone(body)); if (!r.ok) return res({ ok: false, error: r.code });
      const b = clone(body); judge(b); const t = computeServerTotal(b.items, rid, P.tables);
      return res(t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100) });
    }
    if (url.includes('quoteRedemption')) return new Promise(() => {});
    if (/createOrder|chargeOnlineOrder/.test(url)) {
      sent.push({ url, body });
      return res(url.includes('chargeOnlineOrder') ? { ok: true, checkout_url: 'https://pay.test/checkout', order_id: body.order_id, poll_token: 'poll_tok_s3' } : { ok: true });
    }
    return new Promise(() => {});
  };
}
async function boot(dir, P, { old = false, live = true } = {}) {
  const w = loadForm(old ? `${OLD_DIR}/${dir}` : dir);
  await settle();
  const sent = [];
  if (live) await quiet(() => serve(w, clone(P.env)));
  respondWith(w, P, sent, { live });
  return { w, sent };
}
async function send(w, sent, path) {
  const before = sent.length;
  w.selectPay(path === 'cash' ? 'cash' : 'online');
  w.requestServerQuote(); await settle();
  assert.ok(w.buildOrder(), `premise — the cart composes an order (${path})`);
  if (path === 'cash') { try { await w.submitOrder('confirmed'); } catch (_) {} }
  else { const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {}); }
  await settle(); await settle();
  assert.strictEqual(sent.length, before + 1, `premise — one ${path} request left the page`);
  return sent[sent.length - 1].body;
}
const itemKeys = (w) => { try { return plain(w.liveMenuGlobalGet('ITEM_KEYS')); } catch (_) { return undefined; } };
const dishBy = (P, name) => P.body.dishes.find((d) => d.name === name);
const add = async (w, id) => { w.chg(/^\d+$/.test(String(id)) ? Number(id) : id, 1); await settle(); };
const fps = (b, id = 'O') => ({ legacy: orderFingerprint(id, Math.round(Number(b.total) * 100), b.items_text), charge: chargeInputsFingerprint({ ...b, order_id: id }) });
// two plain dishes per brand (no group, no required choice), by name in the published body
const PAIR = { x_pizza: ['Carnivora', 'Margherita'], la_musa: ['Sichuan Spicy Wonton', 'Pork Belly Buns'] };

const BASE = {};
for (const rid of ['x_pizza', 'la_musa']) BASE[rid] = await quiet(() => published(rid));

// ── 1. PREP ──
for (const rid of ['x_pizza', 'la_musa']) {
  const dir = DIR[rid], P = BASE[rid];
  const w = loadForm(dir); await settle();
  assert.deepStrictEqual(itemKeys(w), {}, `🔴 ${dir}: the baked page holds an EMPTY item-key map before any live apply (S3-PREP-BAKED)`);
  await quiet(() => serve(w, clone(P.env)));
  assert.ok(Object.keys(P.body.item_keys).length === P.body.dishes.length, `premise: the endpoint body maps every dish (${dir})`);
  assert.deepStrictEqual(itemKeys(w), P.body.item_keys, `🔴 ${dir}: the live apply carries the served item_keys as ITEM_KEYS (S3-PREP-APPLY)`);
  const bare = clone(P.env); delete bare.menu.item_keys; bare.menu.dishes[0].price += 1;   // a different body (so it applies) with no map
  await quiet(() => serve(w, bare));
  assert.strictEqual(w.liveMenuGlobalGet('MENU')[0].price, bare.menu.dishes[0].price, `premise: the map-less body applied (${dir})`);
  assert.deepStrictEqual(itemKeys(w), {}, `🔴 ${dir}: a body without item_keys EMPTIES the map — never keeps the previous snapshot's (S3-PREP-ABSENT)`);
  ok(`${dir}: PREP — baked {} → the live map applied with MENU → a map-less body empties it`);
}

// ── 2. LINE (identity: nothing renamed) ──
for (const rid of ['x_pizza', 'la_musa']) {
  const dir = DIR[rid], P = BASE[rid];
  const [A, B] = PAIR[rid].map((n) => dishBy(P, n));
  assert.ok(A && B, `premise: ${dir} serves ${PAIR[rid].join(' + ')}`);
  const { w, sent } = await boot(dir, P);
  await add(w, B.id); await add(w, A.id);
  const body = await send(w, sent, 'card');
  for (const line of body.items) {
    const d = P.body.dishes.find((x) => (rid === 'la_musa' ? x.id === line.id : x.name === line.name));
    assert.ok(d, `premise: ${dir} line names a served dish`);
    assert.strictEqual(line.item_key, P.body.item_keys[String(d.id)], `🔴 ${dir}: the line carries the dish's item_key (S3-LINE-KEY)`);
    assert.strictEqual(Object.keys(line).at(-1), 'item_key', `🔴 ${dir}: item_key is appended LAST — the legacy fields keep their positions (S3-LINE-LAST)`);
    assert.strictEqual(line.name, d.name, `${dir}: the name is kept`);
    if (rid === 'la_musa') assert.strictEqual(line.id, d.id, `🔴 ${dir}: an id equal to the key is kept (S3-LINE-ID)`);
  }
  assert.deepStrictEqual(resolveLines(rid, clone(body), P.tables), { ok: true }, `${dir}: the server's stage accepts the body`);
  // the same cart, served WITHOUT a map → exactly the line minus item_key
  const bareP = { ...P, env: clone(P.env) }; delete bareP.env.menu.item_keys;
  const b2 = await boot(dir, bareP);
  await add(b2.w, B.id); await add(b2.w, A.id);
  const bareBody = await send(b2.w, b2.sent, 'card');
  assert.deepStrictEqual(bareBody.items, body.items.map((l) => { const { item_key, ...rest } = l; return rest; }), `🔴 ${dir}: no map = today's bytes (S3-LINE-NOMAP)`);
  ok(`${dir}: LINE — item_key appended last from the map; name kept${rid === 'la_musa' ? '; the equal id kept' : ''}; no map = today's lines`);
}

// ── 3. RENAME (x_pizza) ──
{
  const P = await quiet(() => published('x_pizza', { rename: { key: 'Carnivora', to: 'Carnívora Suprema' } }));
  const d = dishBy(P, 'Carnívora Suprema');
  assert.ok(d && P.body.item_keys[String(d.id)] === 'Carnivora', 'premise: the renamed dish is served under its new label with its kept key');
  const { w, sent } = await boot('xpizza-orders', P);
  await add(w, d.id);
  const body = await send(w, sent, 'card');
  const line = body.items[0];
  assert.deepStrictEqual([line.name, line.item_key], ['Carnívora Suprema', 'Carnivora'], '🔴 xpizza-orders: the renamed line names its new label and its kept key (S3-RENAME-LINE)');
  const judged = clone(body);
  assert.deepStrictEqual(resolveLines('x_pizza', judged, P.tables), { ok: true }, '🔴 xpizza-orders: the server resolves the renamed line (S3-RENAME-RESOLVE)');
  assert.ok(!computeServerTotal(judged.items, 'x_pizza', P.tables).error, 'xpizza-orders: …and prices it');
  const stripped = clone(body); delete stripped.items[0].item_key;
  assert.strictEqual(resolveLines('x_pizza', stripped, P.tables).code, 'menu_changed', 'premise: without item_key the renamed line is the server\'s menu_changed (the field is load-bearing)');
  ok('xpizza-orders: RENAME — {new label, kept key} resolves and prices; without item_key it is menu_changed');
}

// ── 4. MINT (la_musa) ──
{
  const P = await quiet(() => published('la_musa', { mint: { name: 'Bao Nuevo', key: 'i_aaaaaaaaaaac' } }));
  const d = dishBy(P, 'Bao Nuevo');
  assert.ok(d && d.id === 'bao_nuevo' && P.body.item_keys.bao_nuevo === 'i_aaaaaaaaaaac', 'premise: the minted dish keeps today\'s id; its key is opaque');
  const { w, sent } = await boot('la-musa-orders', P);
  await add(w, d.id);
  const body = await send(w, sent, 'card');
  const line = body.items[0];
  assert.strictEqual(line.item_key, 'i_aaaaaaaaaaac', '🔴 la-musa-orders: the minted line carries its item_key (S3-MINT-KEY)');
  assert.ok(!Object.prototype.hasOwnProperty.call(line, 'id'), '🔴 la-musa-orders: …ALONE — no id that would disagree with it (S3-MINT-NOID)');
  assert.deepStrictEqual(resolveLines('la_musa', clone(body), P.tables), { ok: true }, '🔴 la-musa-orders: the server resolves the minted line (S3-MINT-RESOLVE)');
  const withId = clone(body); withId.items[0] = { id: 'bao_nuevo', ...withId.items[0] };
  // asm5 (S2 × S3, advisor ruling 11-10): S2's «item_key wins» reverses S1d's agreement clause — a held key decides the line and a
  // disagreeing display id is advisory. The premise is restated under S2; MINT-NOID above still pins that the form never sends the id.
  assert.deepStrictEqual(resolveLines('la_musa', withId, P.tables), { ok: true }, 'premise (S2 item_key wins): the same line WITH its disagreeing display id still resolves');
  assert.strictEqual(withId.items[0][Symbol.for('xpizza.d4.pricingKeyStamp')], 'i_aaaaaaaaaaac', 'premise (S2 item_key wins): …and prices by its key, not the display id');
  ok('la-musa-orders: MINT — the minted line sends item_key alone and resolves; with a disagreeing id it still resolves and prices by the key (S2)');
}

// ── 5. REWARD ──
{
  const P = await quiet(() => published('x_pizza', { rename: { key: 'Carnivora', to: 'Carnívora Suprema' } }));
  const { w } = await boot('xpizza-orders', P);
  const r = w.buildRedeemCatalog().find((x) => x.name === 'Carnívora Suprema');
  assert.ok(r, 'premise: the renamed 12" pizza is in the reward catalog');
  assert.strictEqual(r.key, 'Carnivora', '🔴 xpizza-orders: the reward key is the dish\'s item_key, not its new label (S3-REWARD-XP)');
  const L = await quiet(() => published('la_musa', { mint: { name: 'Bao Nuevo', key: 'i_aaaaaaaaaaac' } }));
  const lw = (await boot('la-musa-orders', L)).w;
  const lr = lw.buildRedeemCatalog().find((x) => x.name === 'Bao Nuevo');
  assert.ok(lr, 'premise: the minted dish is in La Musa\'s reward catalog');
  assert.strictEqual(lr.key, 'i_aaaaaaaaaaac', '🔴 la-musa-orders: the reward key is the minted item_key, not the display id (S3-REWARD-LM)');
  ok('REWARD — the picker keys a renamed (x_pizza) and a minted (la_musa) dish by its item_key');
}

// ── 6. AVAILABILITY ──
{
  // a MINTED x_pizza dish: its name never was its key on this page (a renamed one is not a fair cell — the baked menu showed it
  // under its old name, which the form's own key history already keeps, so the history alone would mark it sold)
  const P = await quiet(() => published('x_pizza', { mint: { name: 'Pizza Nueva', key: 'i_aaaaaaaaaaab' } }));
  const { w } = await boot('xpizza-orders', P);
  const d = w.liveMenuGlobalGet('MENU').find((x) => x.name === 'Pizza Nueva');
  assert.ok(d && P.body.item_keys[String(d.id)] === 'i_aaaaaaaaaaab', 'premise: the minted x_pizza dish is served with its opaque key');
  assert.strictEqual(w.isSoldOut(d), false, 'premise: available before the 86');
  await loadAvail(w, { [w.availKey('i_aaaaaaaaaaab')]: { available: false, updated_at: 1 } });
  assert.strictEqual(w.isSoldOut(d), true, '🔴 xpizza-orders: an 86 under the item_key marks the minted dish sold (S3-AVAIL-XP)');
  const L = await quiet(() => published('la_musa', { mint: { name: 'Bao Nuevo', key: 'i_aaaaaaaaaaac' } }));
  const lw = (await boot('la-musa-orders', L)).w;
  const ld = lw.liveMenuGlobalGet('MENU').find((x) => x.name === 'Bao Nuevo');
  await loadAvail(lw, { [lw.availKey('i_aaaaaaaaaaac')]: { available: false, updated_at: 1 } });
  assert.strictEqual(lw.isSoldOut(ld), true, '🔴 la-musa-orders: an 86 under the minted item_key marks the dish sold (S3-AVAIL-LM)');
  ok('AVAILABILITY — an 86 under the item_key (the portal writer\'s key) marks a minted dish sold, in both forms');
}

// ── 7. Q3-A: the pre-S3 page's stash resumes here byte-identically, the map served ──
for (const rid of ['x_pizza', 'la_musa']) {
  const dir = DIR[rid], P = BASE[rid];
  const [A, B] = PAIR[rid].map((n) => dishBy(P, n));
  materializeOld(dir);
  const old = await boot(dir, P, { old: true });
  await add(old.w, B.id); await add(old.w, A.id);
  const oldBody = await send(old.w, old.sent, 'card');
  assert.ok(oldBody.items.every((l) => !('item_key' in l)), `premise: the pre-S3 page sends no item_key (${dir})`);
  const stash = old.w.localStorage.getItem(STASH[dir]);
  assert.ok(stash && JSON.parse(stash).order_id === oldBody.order_id, `premise: the old page stashed its pending payment (${dir})`);
  // non-vacuity: this page, with the same map served, puts item_key on a FRESH cart
  { const f = await boot(dir, P); await add(f.w, B.id); await add(f.w, A.id); const fb = await send(f.w, f.sent, 'card');
    assert.ok(fb.items.every((l) => typeof l.item_key === 'string'), `premise: a fresh cart here carries item_key (${dir}) — the resume cell is not vacuous`); }
  for (const path of ['card', 'cash']) {
    const { w, sent } = await boot(dir, P);
    assert.deepStrictEqual(itemKeys(w), P.body.item_keys, `premise: the live map is in force at the resume (${dir})`);
    w.localStorage.setItem(STASH[dir], stash);
    w.restoreOrderForm(); await settle();
    const body = await send(w, sent, path);
    assert.strictEqual(body.order_id, oldBody.order_id, `🔴 ${dir} ${path}: the resumed order keeps its order_id (S3-Q3A-ID)`);
    assert.deepStrictEqual(body.items, oldBody.items, `🔴 ${dir} ${path}: the resumed items are byte-identical to the pre-S3 stash — no item_key added (S3-Q3A-ITEMS)`);
    assert.strictEqual(body.items_text, oldBody.items_text, `🔴 ${dir} ${path}: items_text byte-identical`);
    assert.strictEqual(fps(body, body.order_id).legacy, fps(oldBody, oldBody.order_id).legacy, `🔴 ${dir} ${path}: the same orderFingerprint`);
    if (path === 'card') assert.strictEqual(chargeInputsFingerprint(body), chargeInputsFingerprint(oldBody), `🔴 ${dir} card: the same charge_inputs_fp (S3-Q3A-FP)`);
  }
  ok(`${dir}: Q3-A — a pre-S3 stash (${OLD_SHA}) resumes with the map served byte-identically (order_id, items, items_text, both fingerprints; card + cash)`);
}

// ── 8. Q3-B: an S3 stash (with item_key) resumes before the live map arrives — item_key kept ──
for (const rid of ['x_pizza', 'la_musa']) {
  const dir = DIR[rid], P = BASE[rid];
  const [A, B] = PAIR[rid].map((n) => dishBy(P, n));
  const first = await boot(dir, P);
  await add(first.w, B.id); await add(first.w, A.id);
  const firstBody = await send(first.w, first.sent, 'card');
  assert.ok(firstBody.items.every((l) => typeof l.item_key === 'string'), `premise: the S3 page's card body carries item_key (${dir})`);
  const stash = first.w.localStorage.getItem(STASH[dir]);
  const { w, sent } = await boot(dir, P, { live: false });   // the live fetch never settles: the BAKED menu, ITEM_KEYS = {}
  assert.deepStrictEqual(itemKeys(w), {}, `premise: no live map at this resume (${dir})`);
  w.localStorage.setItem(STASH[dir], stash);
  w.restoreOrderForm(); await settle();
  const body = await send(w, sent, 'card');
  assert.strictEqual(body.order_id, firstBody.order_id, `${dir}: the same order_id`);
  assert.deepStrictEqual(body.items.map((l) => [l.item_key, 'item_key' in l, Object.keys(l).at(-1), 'id' in l]), firstBody.items.map((l) => [l.item_key, 'item_key' in l, Object.keys(l).at(-1), 'id' in l]),
    `🔴 ${dir}: the resumed lines keep their item_key (and id presence) exactly as first sent, with no live map (S3-Q3B-ITEMS)`);
  // the ONE other difference is dish_id: the baked menu carries no identity until the live apply (post-bake-artifact.test.mjs), so a
  // resume before it lands drops dish_id — PRE-EXISTING: the pre-S3 page does exactly the same (proved below), not this slice's
  const noDish = (items) => items.map((l) => { const { dish_id, ...rest } = l; return rest; });
  assert.deepStrictEqual(noDish(body.items), noDish(firstBody.items), `🔴 ${dir}: apart from the pre-existing dish_id, the resumed items are byte-identical (S3-Q3B-REST)`);
  {
    materializeOld(dir);
    const o1 = await boot(dir, P, { old: true });
    await add(o1.w, B.id); await add(o1.w, A.id);
    const ob = await send(o1.w, o1.sent, 'card');
    const ostash = o1.w.localStorage.getItem(STASH[dir]);
    const o2 = await boot(dir, P, { old: true, live: false });
    o2.w.localStorage.setItem(STASH[dir], ostash);
    o2.w.restoreOrderForm(); await settle();
    const orb = await send(o2.w, o2.sent, 'card');
    assert.ok(ob.items.every((l) => typeof l.dish_id === 'string') && orb.items.every((l) => !('dish_id' in l)), `premise (base ${OLD_SHA}): a resume before the live apply drops dish_id on the pre-S3 page too`);
  }
  ok(`${dir}: Q3-B — an S3 stash resumed before the live map arrives keeps each line's item_key (and id presence) as first sent; dish_id's drop there is pre-existing (base ${OLD_SHA} does the same)`);
}

closeAll();
clearTimeout(WATCHDOG);
console.log('\nitem-s3-forms: OK');
process.exit(0);
