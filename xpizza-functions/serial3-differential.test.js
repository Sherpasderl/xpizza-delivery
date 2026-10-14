'use strict';
// §3 r5/r6 (codex serialization r5 + r6) — the materialize-side duplicate guard is a provable SUPERSET of MAIN, every extra
// hold verified. Run: node serial3-differential.test.js
//
// MAIN's guard is read from GIT (207170e: materialize-guard.js + its own order-dedup.js + scheduled-orders.js — the real old
// code). EVERY stamp is WRITTEN by the real stamp blocks lifted from each version's index.js (207170e's and the candidate's
// createOrder + chargeOnlineOrder blocks — never seeded through key functions), in mixed-version sequences BOTH ways; the
// records' persisted §3 fields come from the candidate's real `card-content-keys` / `cash-reward-provenance` blocks. Main and
// the candidate then decide on the SAME final state, and per case (EQUALITY, not just ⊇):
//   candidate_held ⇔ (main_held AND NOT provable_mismatch) OR verified_same_cart_via_new_path
// provable_mismatch: the stamp main follows names a sibling whose CLIENT content is known (no redemption, or reward
// provenance stripped exactly) and is another cart. verified_same_cart_via_new_path: a §3 key (order-independent / rebuilt
// legacy, each on its own) names a live cash sibling whose client content is known and is this cart.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SCHED = require('./scheduled-orders');
const OD = require('./order-dedup');
const MG = require('./materialize-guard');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '207170e';
const gitShow = (ref, f) => execFileSync('git', ['show', `${ref}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
// ── MAIN, from git ──
const OLD = path.join(__dirname, 'node_modules', `.serial3-main-${BASE}`);
fs.mkdirSync(OLD, { recursive: true });
for (const f of ['materialize-guard.js', 'order-dedup.js', 'scheduled-orders.js']) fs.writeFileSync(path.join(OLD, f), gitShow(BASE, f));
const MAIN = require(path.join(OLD, 'materialize-guard.js'));
const MAIN_OD = require(path.join(OLD, 'order-dedup.js'));
assert.ok(!/content_key|clientTextOf/.test(fs.readFileSync(path.join(OLD, 'materialize-guard.js'), 'utf8')), 'premise: the lifted guard is MAIN\'s (no §3)');

// ── the REAL stamp blocks, lifted from each version's index.js ──
function blocksOf(src) {
  const between = (a, b, from) => { const i = src.indexOf(a, from); assert.ok(i >= 0, `anchor ${a}`); const j = src.indexOf(b, i); assert.ok(j > i, `anchor ${b}`); return src.slice(i, j + b.length); };
  const co = src.indexOf('createOrderApp.all('), ch = src.indexOf('chargeOnlineApp.all(');
  const create = between('  let phoneRetap = false;', '  } catch (_) { phoneRetap = false; }', co);
  const charge = between('    let phoneRetap = false;', '    } catch (_) { phoneRetap = false; }', ch);
  assert.ok(src.indexOf('  let phoneRetap = false;', co) < ch && src.indexOf('    let phoneRetap = false;', ch) > ch, 'premise: the blocks are createOrder\'s and chargeOnlineOrder\'s');
  return { create, charge };
}
const NEW_SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const OLD_BLOCKS = blocksOf(gitShow(BASE, 'index.js')), NEW_BLOCKS = blocksOf(NEW_SRC);
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); const j = src.indexOf(b, i); return src.slice(i, j + b.length); };
const KEYS_BLOCK = between(NEW_SRC, '  /* serial3:begin card-content-keys */', '  /* serial3:end card-content-keys */');
const PROV_BLOCK = between(NEW_SRC, '  /* serial3:begin cash-reward-provenance */', '  /* serial3:end cash-reward-provenance */');
const REWARD_SUFFIX_OF = between(NEW_SRC, 'const rewardSuffixOf = (freeItems, itemsText) =>', ';\n');
// run a lifted block verbatim: its free names resolve through `scope` (sloppy-mode `with`); anything else is a no-op stub
function runBlock(block, provided, ret = 'undefined') {
  const w = console.warn; console.warn = () => {};   // the writers' own intake logs are not under test here
  try { return runBlock0(block, provided, ret); } finally { console.warn = w; }
}
function runBlock0(block, provided, ret) {
  const scope = new Proxy(provided, { has: (t, k) => typeof k === 'string' && !(k in globalThis), get: (t, k) => (k in t ? t[k] : () => {}) });
  return new Function('scope', `with (scope) { return (async () => { ${block}\n return ${ret}; })(); }`)(scope).finally(() => {});   // eslint-disable-line no-new-func
}
function fakeDb(store) {
  const ref = (p) => ({
    child: (k) => ref(`${p}/${k}`),
    async once() {
      if (/^recent_order_content\/[^/]+$/.test(p)) { const pre = `${p}/`; const o = {}; for (const [k, v] of Object.entries(store)) if (k.startsWith(pre)) o[k.slice(pre.length)] = v; return { val: () => (Object.keys(o).length ? o : null) }; }
      return { val: () => store[p] };
    },
    async set(v) { store[p] = v; },
    async update(o) { for (const [k, v] of Object.entries(o)) { if (v === null) delete store[`${p}/${k}`]; else store[`${p}/${k}`] = v; } },
    async transaction(fn) { const next = fn(store[p]); if (next === undefined) return { committed: false }; store[p] = next; return { committed: true }; },
  });
  return { ref };
}
const quiet = async (fn) => { const logs = []; const w = console.warn; console.warn = (...a) => logs.push(a.join(' ')); try { return { r: await fn(), logs }; } finally { console.warn = w; } };
const sleep1 = () => new Promise((r) => setTimeout(r, 2));   // successive writers' Date.now() differ (the later stamp is the newer)

const PHONE = '+50433901234';
const MENU = ['Carnivora', 'Mushroom', 'Margherita', 'Pepperoni', 'Pad (Thai)', 'Extra dish'];
const PAID = { carn: '2x Carnivora (L340)', pep: '1x Pepperoni (L307)', mush: '1x Mushroom (L323)', par: '1x Pad (Thai) (L280)', mrk: '1x Extra dish (L99) (Recompensa)', brk: '1x Margherita [special (L250)' };
const REWARD = { none: null, plain: [{ qty: 1, name: 'Margherita' }], brk: [{ qty: 1, name: 'Margherita [special' }], two: [{ qty: 1, name: 'Margherita' }, { qty: 2, name: 'Pad (Thai)' }] };
const versionOf = (v) => (v === 'old'
  ? { blocks: OLD_BLOCKS, orderContentKey: MAIN_OD.orderContentKey, rateLimitKey: MAIN_OD.rateLimitKey, isContentRetap: MAIN_OD.isContentRetap, duplicateSiblingDecision: MAIN.duplicateSiblingDecision }
  : { blocks: NEW_BLOCKS, orderContentKey: OD.orderContentKey, rateLimitKey: OD.rateLimitKey, isContentRetap: OD.isContentRetap, duplicateSiblingDecision: MG.duplicateSiblingDecision, readContentStamp: OD.readContentStamp });
const common = { SCHED, CONTENT_DEDUP_WINDOW_MS: 120000, restaurantId: 'x_pizza', pricingTables: null, menuNamesOf: () => MENU, console: { warn() {} } };

// X: the online checkout — its stamp by `xv`'s REAL charge block; the pending record (+ the candidate intake's §3 fields)
async function intakeX(store, xv, text, freeItems, type, slot) {
  const V = versionOf(xv);
  const fields = { customer_phone: PHONE, items_text: text, payment_method: 'online' };
  await runBlock(V.blocks.charge, { ...common, ...V, db: fakeDb(store), body: { scheduled_for: slot }, fields, orderType: type, orderId: 'X' }, 'phoneRetap');
  const rec = { order_id: 'X', customer_phone: PHONE, items_text: text, order_type: type, payment_method: 'online', payment_status: 'confirmed', status: 'pending_payment', restaurant_id: 'x_pizza', ...(slot ? { scheduled_for: slot } : {}) };
  if (xv === 'new') {
    const rewardSuffixOf = new Function('rewardAppendText', `${REWARD_SUFFIX_OF}\nreturn rewardSuffixOf;`)(OD.rewardAppendText);   // eslint-disable-line no-new-func
    await runBlock(KEYS_BLOCK, { ...common, pendingOrderRecord: rec, fields, orderType: type, isScheduled: !!slot, scheduledForRaw: slot || NaN, orderId: 'X',
      contentKeysRecord: (a, o) => OD.contentKeysRecord(a, { ...o, log: () => {} }), rewardSuffixOf, redemptionCanonical: freeItems ? { model: 'add_free' } : null, redemptionFreeItems: freeItems || null });
  }
  store['orders/X'] = rec;
}
// Y: the cash order — stamped by `yv`'s REAL createOrder block from its PRE-append text, then the reward lines appended
async function createY(store, yv, clientText, freeItems, type, slot) {
  const V = versionOf(yv);
  const fields = { customer_phone: PHONE, items_text: clientText, payment_method: 'cash' };
  await runBlock(V.blocks.create, { ...common, ...V, db: fakeDb(store), body: { scheduled_for: slot }, fields, orderType: type, orderId: 'Y' }, 'phoneRetap');
  const appended = freeItems ? OD.rewardAppendText(freeItems) : '';
  fields.items_text = clientText + appended;   // the server's append (prepareRedemption), AFTER the stamp
  const updates = { 'orders/Y': { order_id: 'Y', status: 'preparing', customer_phone: PHONE, items_text: fields.items_text, order_type: type, payment_method: 'cash', ...(slot ? { scheduled_for: slot } : {}) } };
  if (freeItems) updates['orders/Y'].redemption = { model: 'add_free' };
  if (yv === 'new') {
    const rewardSuffixOf = new Function('rewardAppendText', `${REWARD_SUFFIX_OF}\nreturn rewardSuffixOf;`)(OD.rewardAppendText);   // eslint-disable-line no-new-func
    await runBlock(PROV_BLOCK, { updates, orderId: 'Y', fields, rewardSuffixOf, redemptionCanonical: freeItems ? { model: 'add_free' } : null, redemptionFreeItems: freeItems || null });
  }
  Object.assign(store, updates);
}

// the SPEC's oracle — independent of the guard's code paths; reads the final state directly
const clientOf = (sib) => {
  if (!sib || typeof sib.items_text !== 'string') return null;
  if (sib.reward_text_appended) return sib.items_text.endsWith(sib.reward_text_appended) && sib.items_text !== sib.reward_text_appended ? sib.items_text.slice(0, -sib.reward_text_appended.length) : null;
  return sib.redemption ? null : sib.items_text;
};
function oracle(store, x) {
  const sf = SCHED.normalizeScheduledFor(x.scheduled_for);
  const args = { phone: x.customer_phone, itemsText: x.items_text, orderType: x.order_type, scheduledFor: Number.isFinite(sf) ? sf : null };
  const canon = OD.orderContentKey(args), verb = OD.orderContentKeyVerbatim(args);
  const leaf = (k) => store[`recent_order_content/${OD.rateLimitKey(PHONE)}/${k}`];
  const live = (st) => st && st.order_id && st.order_id !== 'X' && st.payment_method === 'cash' && MG.duplicateSiblingDecision('X', st, store[`orders/${st.order_id}`], 'cash').collision;
  const sameCart = (sib) => { const c = clientOf(sib); if (c == null) return null; const s2 = SCHED.normalizeScheduledFor(sib.scheduled_for); return OD.orderContentKey({ phone: sib.customer_phone, itemsText: c, orderType: sib.order_type, scheduledFor: Number.isFinite(s2) ? s2 : null }) === canon; };
  const ms = leaf(verb);
  const provableMismatch = live(ms) && sameCart(store[`orders/${ms.order_id}`]) === false;
  const keys = [canon];
  if (x.content_key === canon && x.content_legacy_order != null) { const lk = OD.legacyKeyByOrder(args, x.content_legacy_order, x.reward_text_appended || null); if (lk) keys.push(lk); }
  const vnp = [...new Set(keys)].filter((k) => k !== verb).some((k) => { const st = leaf(k); return live(st) && sameCart(store[`orders/${st.order_id}`]) === true; });
  return { provableMismatch, vnp };
}
const decide = async (store) => {
  const mainStore = JSON.parse(JSON.stringify(store)), candStore = JSON.parse(JSON.stringify(store));
  const main = (await quiet(() => MAIN.holdIfDuplicateSibling({ db: fakeDb(mainStore) }, 'X', { ...mainStore['orders/X'] }, 1))).r;
  const { r: cand, logs } = await quiet(() => MG.holdIfDuplicateSibling({ db: fakeDb(candStore) }, 'X', { ...candStore['orders/X'] }, 1));
  return { main, cand, logs, ...oracle(store, store['orders/X']) };
};

(async () => {
  // ── the corpus: real writers, mixed versions BOTH ways, either order ──
  const lineSets = [['carn', 'pep'], ['carn'], ['mush', 'pep', 'carn'], ['par', 'carn'], ['mrk', 'pep'], ['brk', 'pep']];
  const SEQ = [['new', 'old', 'X'], ['new', 'old', 'Y'], ['old', 'new', 'X'], ['old', 'new', 'Y'], ['new', 'new', 'X'], ['new', 'new', 'Y'], ['old', 'old', 'X'], ['old', 'old', 'Y']];   // [X intake, Y createOrder, who first]
  let cases = 0, mainHolds = 0, candHolds = 0, extra = 0, refused = 0;
  const bad = [];
  for (const ls of lineSets) for (const perm of ['same', 'reversed']) for (const yR of Object.keys(REWARD)) for (const xR of ['none', 'plain']) for (const [type, slot] of [['pickup', null], ['delivery', null], ['pickup', 1767290400000]]) for (const [xv, yv, first] of SEQ) {
    const lines = ls.map((k) => PAID[k]);
    const yText = lines.join(' | '), xText = (perm === 'same' ? lines : [...lines].reverse()).join(' | ') + (REWARD[xR] ? OD.rewardAppendText(REWARD[xR]) : '');
    const store = {};
    if (first === 'X') { await intakeX(store, xv, xText, REWARD[xR], type, slot); await sleep1(); await createY(store, yv, yText, REWARD[yR], type, slot); }
    else { await createY(store, yv, yText, REWARD[yR], type, slot); await sleep1(); await intakeX(store, xv, xText, REWARD[xR], type, slot); }
    const d = await decide(store);
    cases += 1; if (d.main) mainHolds += 1; if (d.cand) candHolds += 1; if (d.cand && !d.main) extra += 1; if (d.main && !d.cand) refused += 1;
    const want = (d.main && !d.provableMismatch) || d.vnp;
    if (d.cand !== want) bad.push(`${ls.join('+')} ${perm} yR=${yR} xR=${xR} ${type}${slot ? ' sched' : ''} X:${xv} Y:${yv} first:${first} → cand ${d.cand}, main ${d.main}, pm ${d.provableMismatch}, vnp ${d.vnp} :: ${d.logs.join(' / ')}`);
    if (d.main && !d.cand && !d.logs.some((l) => l.includes('duplicate_sibling_not_verified') && l.includes('"path":"main"'))) bad.push(`UNLOGGED refusal of main's hold: ${ls.join('+')} ${perm} yR=${yR} xR=${xR} X:${xv} Y:${yv} first:${first}`);
  }
  const FAILS = [];
  if (bad.length) FAILS.push(`🔴 EQUALITY candidate ⇔ (main ∧ ¬provable_mismatch) ∨ verified_new_path — ${bad.length} case(s):\n    ${bad.slice(0, 6).join('\n    ')}`);
  assert.ok(mainHolds > 100 && extra > 0, `non-vacuity: main holds ${mainHolds}, extra ${extra}`);
  if (!bad.length) ok(`differential vs MAIN (git ${BASE}), stamps WRITTEN by both versions' real blocks: ${cases} cases (mixed versions both ways, either order) — main holds ${mainHolds}, the candidate ${candHolds}: ${extra} extra holds, all VERIFIED same cart via §3; ${refused} of main's refused, each a PROVABLE mismatch, logged; equality holds in every case`);

  // ── codex r6 repros, verbatim ──
  const repro = async (label, fn) => { try { await fn(); return true; } catch (e) { FAILS.push(`🔴 ${label}: ${e.message.split('\n')[0]}`); return false; } };
  let okR6 = true;
  okR6 = (await repro('codex r6 P1-A', async () => { // P1-A: X "1x Pepperoni (L307) | 2x Carnivora (L340)", perm [1,0]; a NEWER legacy stamp for the menu-ordered text points to an
    // UNRELATED cash Y "1x Mushroom (L323) | 1x Margherita (Recompensa)" (redeemed, no provenance) — a corrupted pointer
    const store = {};
    await intakeX(store, 'new', '1x Pepperoni (L307) | 2x Carnivora (L340)', null, 'pickup', null);
    assert.deepStrictEqual(store['orders/X'].content_legacy_order, [1, 0], 'premise: perm [1,0]');
    const legacy = OD.orderContentKeyVerbatim({ phone: PHONE, itemsText: '2x Carnivora (L340) | 1x Pepperoni (L307)', orderType: 'pickup', scheduledFor: null });
    store[`recent_order_content/${OD.rateLimitKey(PHONE)}/${legacy}`] = { at: Date.now() + 5000, order_id: 'Y', payment_method: 'cash' };
    store['orders/Y'] = { order_id: 'Y', status: 'preparing', customer_phone: PHONE, items_text: '1x Mushroom (L323) | 1x Margherita (Recompensa)', order_type: 'pickup', payment_method: 'cash', redemption: { model: 'add_free' } };
    const d = await decide(store);
    assert.strictEqual(d.main, false, 'premise: main does NOT hold (it never follows that pointer)');
    assert.strictEqual(d.cand, false, '🔴 r6 P1-A: the candidate does NOT hold');
    assert.ok(d.logs.some((l) => l.includes('"path":"new"') && l.includes('"reason":"no_reward_provenance"')), '…logged (new path, unverifiable)');
  })) && okR6;
  okR6 = (await repro('codex r6 P1-B', async () => { // P1-B: X and Y both submit "1x Pepperoni (L307) | 1x Carnivora (L340)"; X's snapshot orders Carnivora first (perm [1,0]);
    // the NEW intake stamps X, then an OLD createOrder stamps cash Y — real stamp blocks
    const store = {};
    await intakeX(store, 'new', '1x Pepperoni (L307) | 1x Carnivora (L340)', null, 'pickup', null);
    assert.deepStrictEqual(store['orders/X'].content_legacy_order, [1, 0], 'premise: perm [1,0]');
    await sleep1(); await createY(store, 'old', '1x Pepperoni (L307) | 1x Carnivora (L340)', null, 'pickup', null);
    const d = await decide(store);
    assert.strictEqual(d.main, true, 'premise: main HOLDS');
    assert.strictEqual(d.cand, true, '🔴 r6 P1-B: the candidate HOLDS (main\'s lookup is its own path, never dropped)');
  })) && okR6;
  if (okR6) ok('codex r6 repros verbatim (real stamp blocks): P1-A unrelated redeemed sibling behind a legacy pointer → main no, candidate no (logged unverifiable); P1-B new intake + OLD createOrder, perm [1,0] → main holds, candidate HOLDS');

  // ── codex r5 repros (kept) ──
  let okR5 = await repro('codex r5 P1-A', async () => { // P1-A r5: a corrupted pointer under X's VERBATIM key → main holds; the sibling's client content is KNOWN and differs → refused, logged
    const store = {}; const X = `${PAID.carn} | ${PAID.pep}`;
    await intakeX(store, 'new', X, null, 'pickup', null);
    store[`recent_order_content/${OD.rateLimitKey(PHONE)}/${OD.orderContentKeyVerbatim({ phone: PHONE, itemsText: X, orderType: 'pickup', scheduledFor: null })}`] = { at: Date.now() + 5000, order_id: 'Y', payment_method: 'cash' };
    store['orders/Y'] = { order_id: 'Y', status: 'preparing', customer_phone: PHONE, items_text: `${X} | 1x Extra dish (L99) (Recompensa)`, order_type: 'pickup', payment_method: 'cash' };
    const d = await decide(store);
    assert.strictEqual(d.main, true, 'premise: main holds on the pointer'); assert.strictEqual(d.cand, false, '🔴 r5 P1-A: not held');
    assert.ok(d.logs.some((l) => l.includes('"path":"main"') && l.includes('"reason":"sibling_content_mismatch"')), 'logged');
  });
  for (const yv of ['new', 'old']) okR5 = (await repro(`codex r5 P1-B (${yv} createOrder)`, async () => { // P1-B r5: "2x Carnivora (L340) | 1x Margherita [special (Recompensa)" cash Y + online X → HELD
    const store = {};
    await intakeX(store, 'new', '2x Carnivora (L340)', null, 'pickup', null); await sleep1();
    await createY(store, yv, '2x Carnivora (L340)', [{ qty: 1, name: 'Margherita [special' }], 'pickup', null);
    assert.strictEqual(store['orders/Y'].items_text, '2x Carnivora (L340) | 1x Margherita [special (Recompensa)', 'premise');
    const d = await decide(store);
    assert.strictEqual(d.main, true, 'premise: main holds'); assert.strictEqual(d.cand, true, `🔴 r5 P1-B (${yv} createOrder): held`);
  })) && okR5;
  if (okR5) ok('codex r5 repros (real stamp blocks): P1-A paid "(Recompensa)" line behind X\'s own key → refused, logged (main path, provable); P1-B "[special" reward → HELD with a new and an old createOrder');
  if (FAILS.length) throw new Error(`${FAILS.length} failing check(s):\n  - ${FAILS.join('\n  - ')}`);
  console.log(`\nserial3-differential: OK (${n})`);
})().catch((e) => { console.error('serial3-differential FAILED:', e); process.exit(1); });
