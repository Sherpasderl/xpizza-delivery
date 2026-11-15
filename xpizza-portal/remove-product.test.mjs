// «Quitar del menú» (PLAN-portal-remove-product-r3, APPROVED 11-12; MOCKUP-portal-remove-product.html) — the PURE editor.js half:
// the ONE predicate (§2), the removal and its undo (§4.1 / §4.2), the ONE order rebuild over the served live order (P-R9), the claim's
// withdraw mode (Ruling A) and the shared dish unit (dropDishUnit; removeAddition byte-identical, T3).
// Seeds are the REAL ones (buildSourceFromCode: la_musa id-mode with options and rewards, x_pizza name-mode). Dish identity stamps follow
// 5f's own server-suite convention (remove-product-server.test.js `base`: `id_${key}`) until the chain cells run on the train's real
// publish (they then come from the post-flip identity pass).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { installFetch, okJson, errJson, loadModules } from './ventas-harness.mjs';
import {
  createDraft, draftSource, mergeDeletionClaim, addProduct, setAddition, setRequiredChoice, setGroupLabel, setChoiceName, addChoice, removeAddition, applyExposureOps,
  canRemoveProduct, removeProduct, undoRemoveProduct, rebuildOrders, removalListSource, setPhoto,
} from './editor.js';

const req = createRequire(import.meta.url);
// the server's «Quitar del menú» switch (5f catalog/platform-removal, D-4): the ONE stub of the chain cells below, installed before any
// handler loads — ON unless a cell turns it off (T19 / T23)
const RP_SW = { on: true };
{ const p = req.resolve('../xpizza-functions/catalog/platform-removal'); req.cache[p] = { id: p, filename: p, loaded: true, exports: { removalCapabilities: () => ({ productRemoval: RP_SW.on }) } }; }
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const { buildSourceFromCode } = req('../xpizza-functions/tools/seed-source-store');
const { canonicalize } = req('../xpizza-functions/catalog/source-store.js');
const clone = (x) => JSON.parse(JSON.stringify(x));
const stamp = (k) => `id_${String(k).replace(/[^A-Za-z0-9]/g, '_')}`;
// the certified live menu (5f's convention) and what getEditableCatalog serves beside it while the switch is on (P-R9)
const live = (rid) => { const s = canonicalize(buildSourceFromCode(rid)); for (const it of s.items) it.display.identity_id = stamp(it.key); return s; };
const liveOrderOf = (src) => ({ items: [...src.structure.item_order], rewards: [...(src.structure.redeem_eligible_items || [])] });
const ON = (src, extra = {}) => ({ on: true, baseReadable: true, liveOrder: liveOrderOf(src), ...extra });
const isOpt = (r) => r.display && (Object.prototype.hasOwnProperty.call(r.display, 'variantOf') || Object.prototype.hasOwnProperty.call(r.display, 'choice'));
const groupKeys = (src) => new Set(Object.values(src.structure.variant_items || {}).flatMap((g) => g.variantIds || []).map(String));
// a plain published dish: no options, not a launcher, no refs of its own
function plainDish(src) {
  const st = src.structure; const ov = (st.exposure && st.exposure.item_overrides) || {}; const ebi = st.extras_by_item || {}; const rei = st.redeem_eligible_items || [];
  const launchers = new Set(Object.keys(st.variant_items || {}).map(String));
  return src.items.find((r) => !isOpt(r) && !launchers.has(String(r.display.id)) && !ov[r.key] && !ebi[r.key] && !rei.includes(r.key)).key;
}
const rowOf = (d, k) => draftSource(d).items.find((r) => r.key === k);

// ── T1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
for (const rid of ['la_musa', 'x_pizza']) {
  test(`T1 ${rid}: removeProduct drops the row, its order entry and its photo, and claims its identity stamp`, () => {
    const src = live(rid); const k = plainDish(src);
    const d = createDraft(src);
    draftSource(d).deleted_ids = ['id_zz_adopted'];                       // a claim already adopted from an earlier save
    draftSource(d).photos = { [k]: { status: 'active', url: 'https://x/a.jpg' } };
    const before = clone(draftSource(d));
    const r = removeProduct(d, k, ON(src));
    assert.equal(r.ok, true, `premise: a plain stamped dish is removable (${JSON.stringify(r)})`);
    const after = draftSource(d);
    assert.equal(rowOf(d, k), undefined, 'the row is gone');
    assert.ok(!after.structure.item_order.includes(k), 'its item_order entry is gone');
    assert.ok(!after.photos || !Object.prototype.hasOwnProperty.call(after.photos, k), 'the dish’s photo goes with it');
    assert.deepEqual(after.deleted_ids, ['id_zz_adopted', stamp(k)].sort(), 'the claim keeps the adopted ids');
    assert.deepEqual(after.items, before.items.filter((x) => x.key !== k), 'every other row is byte-identical');
    assert.deepEqual(r.snap.row, before.items.find((x) => x.key === k), 'the snapshot holds the row as it was');
  });
}

// ── T2: the predicate, row by row ────────────────────────────────────────────────────────────────────────────────────────────────────
test('T2 la_musa: the predicate (§2 rows 1–6); each refusal leaves the draft byte-identical', () => {
  const src = live('la_musa'); const k = plainDish(src);
  const refuse = (d, key, ctx, code, show) => {
    const p = canRemoveProduct(d, key, ctx);
    assert.equal(p.code, code, `${code}: the predicate's code`);
    assert.equal(p.show, show, `${code}: shown = ${show}`);
    assert.equal(p.enabled, false, `${code}: not enabled`);
    const b = clone(draftSource(d));
    const r = removeProduct(d, key, ctx);
    assert.deepEqual([r.ok, r.code], [false, code], `${code}: removeProduct refuses with the same code`);
    assert.deepEqual(draftSource(d), b, `${code}: the draft is byte-identical`);
  };
  assert.deepEqual(canRemoveProduct(createDraft(src), k, ON(src)), { show: true, enabled: true, code: null }, 'premise: a plain stamped dish');
  refuse(createDraft(src), k, ON(src, { on: false }), 'off', false);
  refuse(createDraft(src, { canEdit: () => false }), k, ON(src), 'not_editable', false);
  refuse(createDraft(src, { held: () => 'names' }), k, ON(src), 'not_editable', false);
  refuse(createDraft(src), 'no_such_dish', ON(src), 'unknown_item', false);
  { const d = createDraft(src); addProduct(d, { ref: 'tmp:aaaaaaaa-0001', cat: src.items[0].display.cat }); setAddition(d, 'tmp:aaaaaaaa-0001', 'name', 'Plato Nuevo');
    refuse(d, 'tmp:aaaaaaaa-0001', ON(src), 'new_item', false); }
  { const keys = groupKeys(src); const opt = src.items.find((r) => isOpt(r) || keys.has(String(r.display.id)));
    refuse(createDraft(src), opt.key, ON(src), 'has_options', false);
    const launcher = src.items.find((r) => !isOpt(r) && Object.keys(src.structure.variant_items).map(String).includes(String(r.display.id)));
    assert.ok(launcher, 'premise: la_musa has a dish with options');
    refuse(createDraft(src), launcher.key, ON(src), 'has_options', false); }
  { const s2 = clone(src); delete s2.items.find((r) => r.key === k).display.identity_id;
    refuse(createDraft(s2), k, ON(s2), 'unstamped', false); }
  refuse(createDraft(src), k, ON(src, { baseReadable: false }), 'base_unreadable', true);
  refuse(createDraft(src), k, ON(src, { liveOrder: null }), 'base_unreadable', true);
  refuse(createDraft(src), k, ON(src, { liveOrder: { items: 'x' } }), 'base_unreadable', true);
});
test('T2 a saved-but-unpublished addition (by key) is a NEW dish: it keeps «Descartar», never «Quitar del menú»', () => {
  const src = live('x_pizza'); const k = plainDish(src);
  const p = canRemoveProduct(createDraft(src), k, ON(src, { savedAdditions: new Set([k]) }));
  assert.deepEqual([p.show, p.code], [false, 'new_item'], 'a new dish keeps Descartar, no Quitar del menú');
});

// ── T11 (pure half): the dish's OWN entries leave with it (P-R4 / 5f d1309843), nothing else; undo restores them ──────────────────────
test('T11 la_musa: removing rice_03 (extras_by_item), a dish with an item override, and soft_01 (a reward) takes exactly their own entries', () => {
  const src = live('la_musa');
  const ov = Object.keys(src.structure.exposure.item_overrides)[0];
  for (const k of ['rice_03', ov, 'soft_01']) {
    const d = createDraft(src);
    const r = removeProduct(d, k, ON(src));
    assert.equal(r.ok, true, `premise: ${k} removable (${JSON.stringify(r)})`);
    const a = draftSource(d).structure, b = src.structure;
    assert.ok(!Object.prototype.hasOwnProperty.call(a.exposure.item_overrides, k), `${k}: the removed dish's own entries leave with it (override)`);
    assert.ok(!Object.prototype.hasOwnProperty.call(a.extras_by_item, k), `${k}: the removed dish's own entries leave with it (extras_by_item)`);
    assert.ok(!(a.redeem_eligible_items || []).includes(k), `${k}: the removed dish's own entries leave with it (reward)`);
    const others = (m) => Object.fromEntries(Object.entries(m || {}).filter(([x]) => x !== k));
    assert.deepEqual(a.exposure.item_overrides, others(b.exposure.item_overrides), `${k}: every other dish's entries are byte-identical (overrides)`);
    assert.deepEqual(a.extras_by_item, others(b.extras_by_item), `${k}: every other dish's entries are byte-identical (extras_by_item)`);
    assert.deepEqual(a.redeem_eligible_items, b.redeem_eligible_items.filter((x) => x !== k), `${k}: every other dish's entries are byte-identical (rewards)`);
    const u = undoRemoveProduct(d, k, r.snap, liveOrderOf(src));
    assert.equal(u.ok, true, `${k}: undo applies`);
    assert.deepEqual(draftSource(d).structure, src.structure, `${k}: undo restores the dish's own entries (structure byte-identical to live)`);
    assert.deepEqual(draftSource(d).items, src.items, `${k}: undo restores the row in place`);
    assert.ok(!('deleted_ids' in draftSource(d)) || draftSource(d).deleted_ids.length === 0, `${k}: undo withdraws the claim`);
  }
});
// T20 (pure half, B-3): the map ITSELF is never deleted — the last entry leaves the authored {}
test('T20 la_musa: removing the only extras_by_item dish leaves the authored {}', () => {
  const src = live('la_musa');
  assert.deepEqual(Object.keys(src.structure.extras_by_item), ['rice_03'], 'premise: rice_03 is the only entry');
  const d = createDraft(src);
  assert.equal(removeProduct(d, 'rice_03', ON(src)).ok, true);
  assert.deepEqual(draftSource(d).structure.extras_by_item, {}, 'the authored {} stays');
});

// ── mergeDeletionClaim: ONE withdraw mode (Ruling A — the claim is still named in one function) ──────────────────────────────────────
test('mergeDeletionClaim { withdraw }: drops only the named ids, either stored shape; [] stays []; the read modes are unchanged', () => {
  const a = { deleted_ids: ['id_a', 'id_b', 'id_c'] };
  mergeDeletionClaim(a, { withdraw: ['id_b'] });
  assert.deepEqual(a.deleted_ids, ['id_a', 'id_c'], 'the named id is withdrawn');
  const b = { deleted_ids: { ids: ['id_b', 'id_a'] } };
  mergeDeletionClaim(b, { withdraw: ['id_a'] });
  assert.deepEqual(b.deleted_ids, ['id_b'], 'the object shape is read and written as ONE sorted array');
  const c = { deleted_ids: ['id_a'] };
  mergeDeletionClaim(c, { withdraw: ['id_a'] });
  assert.deepEqual(c.deleted_ids, [], 'withdrawing the last id leaves [] (baseFor then sends no base)');
  assert.equal(mergeDeletionClaim(c, null), false, 'an empty claim reads as no claim');
  const e = {};
  mergeDeletionClaim(e, { withdraw: ['id_a'] });
  assert.deepEqual(e, {}, 'no claim: nothing is written');
  const f = { deleted_ids: { ids: ['id_c'] } };
  mergeDeletionClaim(f, { add: ['id_b', 'id_c'] });
  assert.deepEqual(f.deleted_ids, ['id_b', 'id_c'], '{ add } is the op results\u2019 union: ONE sorted array, no duplicate');
});

// ── T21 (pure half): the ONE order rebuild over the served live order (P-R9) — live filtered to what is present, THEN the additions ──
const orderAfterEveryStep = (label, src, steps, extra = []) => {
  const lo = liveOrderOf(src);
  const d = createDraft(src);
  for (const ref of extra) { addProduct(d, { ref, cat: src.items[0].display.cat }); setAddition(d, ref, 'name', `Nuevo ${ref.slice(-2)}`); }
  const snaps = new Map();
  const check = (what) => {
    const st = draftSource(d).structure; const present = new Set(draftSource(d).items.map((r) => r.key || r.ref));
    const want = [...lo.items.filter((k) => present.has(k)), ...extra.filter((k) => present.has(k))];
    assert.deepEqual(st.item_order, want, `${label} · ${what}: the live order filtered to what is present, then the additions`);
    assert.deepEqual(st.redeem_eligible_items || [], lo.rewards.filter((k) => present.has(k)), `${label} · ${what}: rewards follow the live order`);
    if (extra.length) assert.deepEqual(st.item_order.slice(-extra.length), extra, `${label} · ${what}: additions stay LAST, after every live item`);
  };
  for (const [op, k] of steps) {
    if (op === 'rm') { const r = removeProduct(d, k, ON(src)); assert.equal(r.ok, true, `${label}: premise ${k} removable (${JSON.stringify(r)})`); snaps.set(k, r.snap); }
    else { const u = undoRemoveProduct(d, k, snaps.get(k), lo); assert.equal(u.ok, true, `${label}: undo ${k} applies`); }
    check(`${op} ${k}`);
  }
};
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
test('T21a/b/c la_musa: dimsum_01 then dimsum_02 (every undo order); the FIRST dish; three adjacent (all six undo orders)', () => {
  const src = live('la_musa');
  const ord = src.structure.item_order;
  assert.ok(ord.includes('dimsum_01') && ord.includes('dimsum_02'), 'premise: Codex’s dimsum pair');
  for (const u of perms(['dimsum_01', 'dimsum_02'])) orderAfterEveryStep(`(a) undo ${u}`, src, [['rm', 'dimsum_01'], ['rm', 'dimsum_02'], ...u.map((k) => ['un', k])]);
  orderAfterEveryStep('(a) undo between', src, [['rm', 'dimsum_01'], ['un', 'dimsum_01'], ['rm', 'dimsum_02'], ['rm', 'dimsum_01'], ['un', 'dimsum_02'], ['un', 'dimsum_01']]);
  const plain = (k) => { const r = src.items.find((x) => x.key === k); return r && canRemoveProduct(createDraft(src), k, ON(src)).enabled; };
  const first = ord.find(plain);
  orderAfterEveryStep('(b) the first dish', src, [['rm', first], ['un', first]]);
  const i = ord.findIndex((k, j) => plain(k) && plain(ord[j + 1]) && plain(ord[j + 2]));
  const three = ord.slice(i, i + 3);
  for (const u of perms(three)) orderAfterEveryStep(`(c) ${three} undo ${u}`, src, [...three.map((k) => ['rm', k]), ...u.map((k) => ['un', k])]);
});
test('T21d la_musa: the rewards soft_01..04 — remove soft_01 and soft_02, restore in both orders', () => {
  const src = live('la_musa');
  assert.deepEqual(src.structure.redeem_eligible_items, ['soft_01', 'soft_02', 'soft_03', 'soft_04'], 'premise: Codex’s rewards');
  orderAfterEveryStep('(d) 02 then 01', src, [['rm', 'soft_01'], ['rm', 'soft_02'], ['un', 'soft_02'], ['un', 'soft_01']]);
  orderAfterEveryStep('(d) 01 then 02', src, [['rm', 'soft_01'], ['rm', 'soft_02'], ['un', 'soft_01'], ['un', 'soft_02']]);
});
test('T21e la_musa: Codex r4 — a draft addition (soft_new) stays LAST through removing and restoring soft_03 / soft_04', () => {
  const src = live('la_musa');
  orderAfterEveryStep('(e) 03 then 04', src, [['rm', 'soft_03'], ['rm', 'soft_04'], ['un', 'soft_03'], ['un', 'soft_04']], ['tmp:soft-new-01']);
  orderAfterEveryStep('(e) 04 then 03', src, [['rm', 'soft_03'], ['rm', 'soft_04'], ['un', 'soft_04'], ['un', 'soft_03']], ['tmp:soft-new-01']);
});
test('T21f x_pizza (name keys): the first in-session removal on a draft that saved none, undone', () => {
  const src = live('x_pizza'); const k = plainDish(src);
  orderAfterEveryStep('(f)', src, [['rm', k], ['un', k]]);
});
test('rebuildOrders: no liveOrder, no guessed order (the draft is left as it is)', () => {
  const src = live('la_musa'); const st = clone(src); st.structure.item_order.reverse();
  const b = clone(st);
  assert.equal(rebuildOrders(st, null), false, 'refused without the served order');
  assert.deepEqual(st, b, 'no liveOrder, no guessed order');
});
test('undoRemoveProduct refuses a dish already present, and without the served order', () => {
  const src = live('la_musa'); const k = plainDish(src);
  const d = createDraft(src); const r = removeProduct(d, k, ON(src));
  const b = clone(draftSource(d));
  assert.deepEqual(undoRemoveProduct(d, k, r.snap, null), { ok: false, code: 'base_unreadable' }, 'no liveOrder: refused');
  assert.deepEqual(draftSource(d), b, 'nothing written');
  assert.equal(undoRemoveProduct(d, k, r.snap, liveOrderOf(src)).ok, true);
  assert.deepEqual(undoRemoveProduct(d, k, r.snap, liveOrderOf(src)), { ok: false, code: 'present' }, 'a dish already present is refused');
});
// D-2: «Deshacer» restores the row as it was JUST BEFORE the removal (a pending price edit comes back)
test('D-2: undo restores the row as it was before the removal (a pending price edit included)', () => {
  const src = live('x_pizza'); const k = plainDish(src);
  const d = createDraft(src);
  rowOf(d, k).price += 5; rowOf(d, k).display.price = rowOf(d, k).price;
  const edited = clone(rowOf(d, k));
  const r = removeProduct(d, k, ON(src));
  undoRemoveProduct(d, k, r.snap, liveOrderOf(src));
  assert.deepEqual(rowOf(d, k), edited, 'undo restores the row as it was before the removal');
});

// ── T3: removeAddition after the dropDishUnit factoring — byte-identical to the base (14a66e5a) ──────────────────────────────────────
test('T3: removeAddition is byte-identical to the base for a new plain dish and a new dish with a choice group', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-base-'));
  const f = path.join(dir, 'editor.base.mjs');
  fs.writeFileSync(f, execFileSync('git', ['show', '14a66e5a:xpizza-portal/editor.js'], { cwd: here }));
  try {
    const BASE = await import(pathToFileURL(f).href);
    const src = live('la_musa'); const cat = src.items[0].display.cat;
    const build = (M) => {
      const out = [];
      { const d = M.createDraft(src); M.addProduct(d, { ref: 'tmp:pppppppp-0001', cat }); M.setAddition(d, 'tmp:pppppppp-0001', 'name', 'Plato'); M.setAddition(d, 'tmp:pppppppp-0001', 'price', '120');
        d.state.photos = { 'tmp:pppppppp-0001': { status: 'pending' } }; M.removeAddition(d, 'tmp:pppppppp-0001'); out.push(clone(d.state)); }
      { const d = M.createDraft(src); M.addProduct(d, { ref: 'tmp:pppppppp-0002', cat }); M.setAddition(d, 'tmp:pppppppp-0002', 'name', 'Con opciones');
        M.setRequiredChoice(d, 'tmp:pppppppp-0002', true, ['tmp:oooooooo-0001', 'tmp:oooooooo-0002']); M.setGroupLabel(d, 'tmp:pppppppp-0002', 'Tamaño');
        M.setChoiceName(d, 'tmp:oooooooo-0001', 'Chica'); M.addChoice(d, 'tmp:pppppppp-0002', 'tmp:oooooooo-0003'); M.removeAddition(d, 'tmp:pppppppp-0002'); out.push(clone(d.state)); }
      return out;
    };
    const mod = await import('./editor.js');
    assert.deepEqual(build(mod), build(BASE), 'removeAddition is byte-identical to the base');
    assert.deepEqual(build(mod)[1], src, 'premise: the unit leaves nothing behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// advisor (11-12, the stamp deviation): no pure cell may depend on the stamp's FORMAT — real stamps are opaque (i_…), not `id_${key}`.
// The same removals and undos over OPAQUE stamps give the same drafts, stamp for stamp (only presence and equality matter).
test('stamp format: the removal / undo results are the same with OPAQUE i_ stamps (presence and equality only)', () => {
  const opaque = (k) => `i_${[...String(k)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}q${String(k).length}`;
  const run = (rid, stampOf) => {
    const s = canonicalize(buildSourceFromCode(rid)); for (const it of s.items) it.display.identity_id = stampOf(it.key);
    const lo = liveOrderOf(s); const d = createDraft(s); const out = []; const snaps = new Map();
    const keys = rid === 'la_musa' ? ['rice_03', 'soft_01', 'dimsum_01', 'dimsum_02'] : [plainDish(s)];
    draftSource(d).deleted_ids = [stampOf('zz_adopted')];
    for (const k of keys) { const r = removeProduct(d, k, { on: true, baseReadable: true, liveOrder: lo }); out.push(r.ok); snaps.set(k, r.snap); out.push(clone(draftSource(d))); }
    for (const k of [...keys].reverse()) { out.push(undoRemoveProduct(d, k, snaps.get(k), lo).ok); out.push(clone(draftSource(d))); }
    return JSON.stringify(out);
  };
  for (const rid of ['la_musa', 'x_pizza']) {
    const a = run(rid, stamp), b = run(rid, opaque);
    assert.notEqual(a, b, `${rid}: premise — the stamps differ`);
    // map every opaque stamp back to its id_ form: the drafts must then be byte-identical
    const keysOf = canonicalize(buildSourceFromCode(rid)).items.map((r) => r.key).concat('zz_adopted');
    let back = b; for (const k of keysOf) back = back.split(JSON.stringify(opaque(k))).join(JSON.stringify(stamp(k)));
    // the claim is ONE sorted array: its ORDER follows the stamps' text, so compare it as a set (re-sorted after the mapping)
    const norm = (j) => JSON.stringify(JSON.parse(j).map((x) => (x && typeof x === 'object' && Array.isArray(x.deleted_ids) ? { ...x, deleted_ids: [...x.deleted_ids].sort() } : x)));
    assert.equal(norm(back), norm(a), `${rid}: the results do not depend on the stamp format`);
  }
});

// ── R2 (T14, the view half): openXConfirm — X2 and the discard confirm byte-identical to the base; the dish confirm as drawn ───────────
const XSCRIM = '<!doctype html><button id="ret">Quitar del menú</button><div class="scrim" id="xscrim"><div class="modal sm" role="dialog" aria-modal="true" aria-labelledby="xcf-t" aria-describedby="xcf-d"></div></div>';
async function withDom(fn, { sheet = false } = {}) {
  const { JSDOM } = req('../xpizza-functions/node_modules/jsdom');
  const w = new JSDOM(XSCRIM).window;
  w.matchMedia = (q) => ({ matches: sheet && q === '(max-width:560px)', media: q });
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = w.document; globalThis.window = w;
  try { return await fn(w); } finally { globalThis.document = saved.document; globalThis.window = saved.window; }
}
const key = (w, k, opts = {}) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
test('T14 openXConfirm: X2 and the discard confirm render byte-identical to the base (14a66e5a), focus included', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-xv-'));
  for (const f of ['extras-view.js', 'extras-logic.js', 'editor.js']) fs.writeFileSync(path.join(dir, f), execFileSync('git', ['show', `14a66e5a:xpizza-portal/${f}`], { cwd: here }));
  try {
    const BASE = await import(pathToFileURL(path.join(dir, 'extras-view.js')).href);
    const NOW = await import('./extras-view.js');
    const shot = (M, which) => withDom((w) => {
      if (which === 'x2') M.openRemoveConfirm({ title: '¿Quitar Jamón de Ingredientes extra?', sub: 'Extras · en 4 productos', body: 'Desaparece del menú en los 4 productos que usan este grupo. Tus pedidos pasados no cambian.', onConfirm: () => {}, returnTo: w.document.getElementById('ret') });
      else M.openDiscardConfirm({ onDiscard: () => {}, onKeep: () => {}, returnTo: w.document.getElementById('ret') });
      const s = w.document.getElementById('xscrim');
      const out = [s.outerHTML, w.document.activeElement.textContent];
      M.closeXConfirm();
      out.push(s.outerHTML);
      return out;
    });
    for (const which of ['x2', 'discard']) assert.deepEqual(await shot(NOW, which), await shot(BASE, which), `${which === 'x2' ? 'X2' : 'the discard confirm'} is byte-identical`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const R2 = { name: 'Pizza Margarita', place: 'Pizzas · Clásicas' };
const R2_BODY = 'Desaparece del menú al publicar. Tus pedidos pasados no cambian. Para volver a venderlo, crealo como un producto nuevo.';
const R5_LINE = 'Este producto se canjea con recompensas; al quitarlo deja de estar disponible como premio.';
test('T14 R2 desktop: the title with «del menú?» unbroken, the place, the body; «Volver» holds focus; Tab stays in; Escape / the scrim / «Volver» write nothing', async () => {
  const { openRemoveProductConfirm } = await import('./extras-view.js');
  await withDom((w) => {
    const ret = w.document.getElementById('ret'); const s = w.document.getElementById('xscrim'); const m = s.querySelector('.modal');
    for (const how of ['volver', 'escape', 'scrim']) {
      let went = 0, cancelled = 0;
      openRemoveProductConfirm({ ...R2, reward: false, onConfirm: () => { went += 1; }, onCancel: () => { cancelled += 1; }, returnTo: ret });
      assert.ok(s.classList.contains('show') && m.classList.contains('modal') && m.classList.contains('sm'), 'the small modal (.modal.sm) is up');
      assert.ok(s.classList.contains('mk-over'), 'over the still-open drawer (.mk-over)');
      const t = m.querySelector('.mt');
      assert.equal(t.className, 'mt mk-cft', 'the title class');
      assert.equal(t.textContent, '¿Quitar «Pizza Margarita» del menú?', 'the title text');
      assert.equal((t.querySelector('.nw') || {}).textContent, 'del menú?', '«del menú?» never breaks off alone');
      assert.equal(m.querySelector('.mh .ms').textContent, 'Pizzas · Clásicas', 'the place');
      assert.equal(m.querySelector('.mb .eqbody').textContent, R2_BODY, 'the body');
      assert.equal(m.querySelector('.mk-sandline'), null, 'no reward line on a non-reward dish');
      const bs = [...m.querySelectorAll('.mf button')];
      assert.deepEqual(bs.map((b) => [b.textContent, b.className]), [['Volver', 'btn ghost'], ['Quitar', 'btn ghost mk-quiet-danger']], 'the pair as drawn');
      assert.equal(w.document.activeElement, bs[0], 'Volver holds focus');
      key(w, 'Tab'); assert.equal(w.document.activeElement, bs[1], 'Tab moves to «Quitar»');
      key(w, 'Tab'); assert.equal(w.document.activeElement, bs[0], 'Tab stays inside');
      if (how === 'volver') bs[0].click();
      else if (how === 'escape') key(w, 'Escape');
      else s.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      assert.equal(went, 0, `${how}: Escape writes nothing`);
      assert.equal(cancelled, 1, `${how}: the cancel path ran once`);
      assert.ok(!s.classList.contains('show') && !s.classList.contains('mk-over'), `${how}: closed (and no longer over the drawer)`);
      assert.equal(w.document.activeElement, ret, `${how}: focus is back on «Quitar del menú»`);
    }
    let went = 0;
    openRemoveProductConfirm({ ...R2, reward: false, onConfirm: () => { went += 1; }, returnTo: ret });
    [...m.querySelectorAll('.mf button')][1].click();
    assert.equal(went, 1, '«Quitar» confirms once');
    assert.ok(!s.classList.contains('show'), '«Quitar» closes the confirm');
  });
});
test('T16 R5: a reward dish’s confirm carries the sand line under the body (desktop and the phone sheet)', async () => {
  const { openRemoveProductConfirm, closeXConfirm } = await import('./extras-view.js');
  for (const sheet of [false, true]) {
    await withDom((w) => {
      openRemoveProductConfirm({ ...R2, reward: true, onConfirm: () => {}, returnTo: w.document.getElementById('ret') });
      const line = w.document.querySelector('#xscrim .mk-sandline');
      assert.ok(line, `${sheet ? 'sheet' : 'desktop'}: a reward dish's confirm carries the sand line`);
      assert.equal(line.textContent, R5_LINE, 'the approved line');
      assert.ok(line.querySelector('svg'), 'with its glyph');
      assert.equal(line.previousElementSibling.className, 'eqbody', 'right under the body');
      closeXConfirm();
    }, { sheet });
  }
});
test('T14 R2 phone (≤ 560 px): the bottom sheet — handle, title, place, body, two side-by-side buttons «Volver» first; closing restores the modal', async () => {
  const { openRemoveProductConfirm, openRemoveConfirm, closeXConfirm } = await import('./extras-view.js');
  await withDom((w) => {
    const s = w.document.getElementById('xscrim'); const m = s.firstElementChild; const ret = w.document.getElementById('ret');
    openRemoveProductConfirm({ ...R2, reward: false, onConfirm: () => {}, returnTo: ret });
    assert.ok(s.classList.contains('mk-sheetscrim'), 'the scrim aligns the sheet to the bottom');
    assert.equal(m.className, 'mk-sheet', 'the sheet');
    assert.equal(m.getAttribute('role'), 'dialog'); assert.equal(m.getAttribute('aria-labelledby'), 'xcf-t');
    assert.deepEqual([...m.children].map((c) => c.className), ['mk-handle', 'mt mk-cft', 'ms', 'eqbody', 'mk-sheeta'], 'the sheet as drawn');
    const bs = [...m.querySelectorAll('.mk-sheeta button')];
    assert.deepEqual(bs.map((b) => [b.textContent, b.className]), [['Volver', 'btn'], ['Quitar', 'btn danger']], 'the sheet’s pair as drawn');
    assert.equal(w.document.activeElement, bs[0], 'Volver holds focus on the sheet');
    key(w, 'Escape');
    assert.ok(!s.classList.contains('show') && !s.classList.contains('mk-sheetscrim'), 'closed, the scrim back to itself');
    assert.equal(m.className, 'modal sm', 'the modal element is restored');
    openRemoveConfirm({ title: 'X', sub: 'Y', body: 'Z', onConfirm: () => {}, returnTo: ret });
    assert.equal(m.className, 'modal sm', 'X2 on a phone is still the small modal (the sheet is the dish confirm’s only)');
    closeXConfirm();
  }, { sheet: true });
});

// ═══ THE SERVER-DEPENDENT HALF (train/portal-structure) ════════════════════════════════════════════════════════════════════════════
// The REAL page (jsdom over index.html, the real app.js / ventas.js / shell.js; auth stubbed) against 5f's REAL backend over ONE store:
// getEditableCatalogCore, editCatalogCore, publishEditedCore and requestPublishCore over catalog/firestore-fake, the caller resolved by
// the real authorizeCatalogEdit over the merchant membership double. The menu is the seed PUBLISHED by the real publishVersion and
// stamped by the real identity bootstrap (stamp ledger condition 2: no cell below hand-sets an identity_id). The request bodies are
// the portal's own (api.js), travelling verbatim. The one stub is the switch (RP_SW, top of file).
const freq = createRequire(new URL('../xpizza-functions/package.json', import.meta.url));
const HERE = path.dirname(fileURLToPath(import.meta.url));
runInThisContext(fs.readFileSync(path.join(HERE, 'extras-eligibility.js'), 'utf8'));   // the page's classic scripts, in index.html order
runInThisContext(fs.readFileSync(path.join(HERE, 'exposure-transitions.js'), 'utf8'));
const EE = globalThis.ExtrasEligibility;
const HTML = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
const RP_UID = { owner: 'uOwnerRP', manager: 'uMgrRP' };
const OWNER_CAPS_RP = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'catalog.fiscal_ack', 'catalog.add_product', 'catalog.reset_draft', 'stats.read',
  'availability.set', 'location.prep', 'location.pause', 'location.hours', 'team.invite', 'team.revoke'];
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// a real handler chain takes as long as it takes: wait for the fact, bounded
async function until(fact, ms = 4000) { const t0 = Date.now(); while (!fact() && Date.now() - t0 < ms) await settle(20); return fact(); }

// `photo`: a dish key whose ACTIVE version carries a photo (T22 / T22b) — the version's meta/photos doc from 5f's own writer
// (photo-state.versionPhotosDoc), the pid published in the registry, the stored draft carrying the same entry; the editor read and the
// save then get 5f's REAL photo cores (makeEditableIo / makePhotoEditIo) over the same store, uploads OFF
async function rpBackend(rid, { photo = null } = {}) {
  const { makeDb } = freq('./catalog/firestore-fake');
  const { createFakeDb } = freq('./merchant/_fake-db');
  const { Timestamp } = freq('firebase-admin/firestore');
  const { sourceRefOf } = freq('./catalog/source-store');
  const { publishVersion } = freq('./catalog/catalog-publish');
  const { readPublishBaseline, buildPublishCandidate } = freq('./tools/publish-version');
  const { bootstrapIdentityStamps } = freq('./catalog/identity-bootstrap');
  const { getActiveVersionId } = freq('./catalog/catalog-firestore');
  const { authorizeCatalogEdit } = freq('./catalog/catalog-edit-auth');
  const { editCatalogCore } = freq('./catalog/edit-catalog-handler');
  const { publishEditedCore } = freq('./catalog/publish-edited-handler');
  const { getEditableCatalogCore } = freq('./catalog/portal-reads');
  const PR = freq('./catalog/publish-request');
  const fsdb = makeDb();
  const rtdb = createFakeDb({
    brands: { [rid]: { name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } } },
    restaurants: { [rid]: { identity: { name: rid } } },
    brand_members: { [rid]: { owners: { [RP_UID.owner]: { granted_at: 1 } }, managers: { [rid]: { [RP_UID.manager]: { granted_at: 1 } } },
      manager_perms: { [RP_UID.manager]: { can_edit_menu: true } }, profiles: { [RP_UID.manager]: { name: 'Dania Reyes', email: 'dania@m.hn' } } } },
  });
  const seed = clone(buildSourceFromCode(rid));
  // the profile's pricing_key_mode is the seeded source's own key_mode (data, never a rid literal) — the add-product I/O reads it
  await fsdb.collection('restaurants').doc(rid).set({ pricing_key_mode: seed.key_mode });
  // the published menu, the way production got it: the stored source → the real publish → the real identity bootstrap
  const publishStored = async () => {
    const baseline = await readPublishBaseline(fsdb, rid, { fromStore: true });
    const { input, expected } = buildPublishCandidate(rid, baseline, { source_sha: 'rp' });
    return publishVersion(fsdb, rid, input, { expected });
  };
  await sourceRefOf(fsdb, rid).set(seed);
  await publishStored();
  const boot = await bootstrapIdentityStamps(fsdb, rid);
  assert.equal(boot.stamped, true, `premise: the real bootstrap stamped ${rid}`);
  const readActiveBuilt = async () => PR.readActiveBuiltFrom(fsdb, rid);
  let photoReads = null, photos = null;
  const PHOTO_PID = 'b'.repeat(32);
  if (photo) {
    const vid = await getActiveVersionId(fsdb, rid);
    const doc = freq('./photos/photo-state').versionPhotosDoc({ [photo]: { state: 'pid', pid: PHOTO_PID } }, (p, sz) => `https://cdn.test/${p}-${sz}.webp`);
    await fsdb.collection('restaurants').doc(rid).collection('versions').doc(vid).collection('meta').doc('photos').set(doc);
    await fsdb.collection('photo_registry').doc(rid).collection('pids').doc(PHOTO_PID).set({ state: 'published' });
    await sourceRefOf(fsdb, rid).update({ photos: { [photo]: { state: 'pid', pid: PHOTO_PID } } });
    photoReads = freq('./photos/editable-io').makeEditableIo({ fs: fsdb, enabled: async () => false, publicBucket: () => 'tb-public', legacyBase: () => null,
      signRead: async (pp, e) => `https://storage.test/${pp}?e=${e}` });
    photos = freq('./photos/edit-io').makePhotoEditIo({ fs: fsdb, enabled: async () => false });
  }
  const toPrecondition = (v) => { if (typeof v !== 'string') return v; const [a, b] = v.split('.'); return /^\d+$/.test(a || '') && /^\d+$/.test(b || '') ? new Timestamp(Number(a), Number(b)) : v; };
  const addProduct = freq('./catalog/add-product-io').addProductIo({ fs: fsdb, rtdb });
  const B = { who: 'owner', rid, fs: fsdb, photoPid: PHOTO_PID, statuses: [], saves: [], publishBodies: [], tweakRead: null };
  const rq = (call, method) => ({ method, query: { restaurantId: rid }, get: (h) => (String(h).toLowerCase() === 'authorization' ? call.auth : undefined) });
  const authorize = (r, q) => authorizeCatalogEdit({ db: rtdb, verifyIdToken: async () => ({ uid: RP_UID[B.who] }) }, q, r);
  const out = (r) => (r.status === 200 ? okJson(r.body) : errJson(r.status, r.body));
  B.on = {
    getEditableCatalog: (call) => (async () => {
      const r = await getEditableCatalogCore({ db: rtdb, fsdb, readActiveVersionId: getActiveVersionId, readActiveBuilt, authorize, now: () => 6000, ...(photoReads ? { photoReads } : {}) }, rq(call, 'GET'));
      if (r.status === 200 && B.tweakRead) B.tweakRead(r.body);   // a contract break a cell stages on purpose (T21g)
      return out(r);
    })(),
    editCatalog: (call) => (async () => { const r = await editCatalogCore({ db: fsdb, authorize, readActiveBuilt, toPrecondition, addProduct, ...(photos ? { photos } : {}) }, call.body, rq(call, 'POST')); B.statuses.push(r.status); B.saves.push({ body: clone(call.body), status: r.status, reply: clone(r.body) }); return out(r); })(),
    publishEdited: (call) => (async () => {
      B.publishBodies.push(clone(call.body));
      const r = await publishEditedCore({ db: fsdb, authorize, readActiveBuilt, readDraft: () => PR.readDraftFrom(fsdb, rid), publishVersion, addProduct }, call.body, rq(call, 'POST'));
      B.statuses.push(`publish ${r.status}`); return out(r);
    })(),
    catalogRequestPublish: (call) => (async () => { const r = await PR.requestPublishCore({ fs: fsdb, db: rtdb, now: () => 5000, readActiveBuilt, readDraft: (x) => PR.readDraftFrom(fsdb, x), addProduct }, { uid: RP_UID[B.who], token: {} }, call.body); B.statuses.push(`request ${r.status}`); return out(r); })(),
    getMyBranches: () => okJson({ brands: [{ brand_id: rid, name: rid }], membership_writes_enabled: false,
      branches: [{ rid, brand_id: rid, role: B.who, state: 'member', name: 'Centro', identity_version: 2, editable: { prep_default_min: 20 },
        readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' }, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null,
        caps: B.who === 'owner' ? OWNER_CAPS_RP : [...freq('./access/membership').capsFor({ manager: true, manager_menu: true }, 'member')] }] }),
  };
  B.stored = async () => clone((await sourceRefOf(fsdb, rid).get()).data());
  B.claim = async () => { const d = await B.stored(); return d && d.deleted_ids !== undefined ? d.deleted_ids : null; };
  B.live = async () => (await readActiveBuilt()).built;
  // an activation moves the live pointer (a «moved base», T9): the real pointer doc, its generation one on — a real pointer write
  B.activateAgain = async () => { const ref = fsdb.collection('restaurants').doc(rid).collection('meta').doc('active_version'); const cur = (await ref.get()).data(); await ref.set({ ...cur, generation: cur.generation + 1 }); };
  B.request = async () => { const d = await PR.requestRefOf(fsdb, rid).get(); return d.exists ? d.data() : null; };
  B.publicMenu = async () => (await freq('./catalog/public-menu').buildPublicMenu(fsdb, rid, { known: new Set([rid]), isActive: async () => true })).body;
  return B;
}

async function rpPage(B) {
  const dom = new (freq('jsdom').JSDOM)(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.ExtrasEligibility = EE;
  globalThis.__branchesDirect = true;
  globalThis.CSS = { escape: (x) => String(x).replace(/["\\]/g, '\\$&') };
  const calls = installFetch((fn) => {
    const c = calls[calls.length - 1];
    if (B.on[fn]) return B.on[fn](c);
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadModules(['app', 'ventas', 'shell']);
  const d = w.document;
  const p = { w, d, mods, calls, B };
  p.signIn = async () => { d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid: RP_UID[B.who] } })); d.dispatchEvent(new w.CustomEvent('portal:signed-in')); await settle(150); };
  p.drawer = () => d.getElementById('drawer');
  p.open = async (key) => { mods.app.openDrawer(key); await settle(10); return p.drawer(); };
  p.rmAct = () => p.drawer().querySelector('.dwb > .mk-rmact');
  p.xbtn = (label) => [...d.querySelectorAll('#xscrim button')].find((b) => b.textContent.trim() === label);
  p.src = () => clone(draftSource(mods.app.state.draft));
  p.section = async (name) => { const b = [...d.querySelectorAll('#rail .railitem')].find((x) => x.querySelector('b').textContent === name); b.click(); await settle(10); };
  p.rowOf = (key) => { const c = d.querySelector(`#detail .irow > [data-k="item::${key}"]`); return c ? c.parentNode : null; };
  p.railCount = (name) => [...d.querySelectorAll('#rail .railitem')].find((x) => x.querySelector('b').textContent === name).querySelector('.rcount').textContent;
  // the R1 → R2 → «Quitar» path a person takes
  p.remove = async (key) => { await p.open(key); p.rmAct().querySelector('button').click(); await settle(5); p.xbtn('Quitar').click(); await settle(20); };
  p.undo = async (key) => { p.rowOf(key).querySelector('.mk-undo').click(); await settle(20); };
  p.review = async () => { d.getElementById('review').click(); await settle(250); };
  p.back = async () => { d.getElementById('pubback').click(); await settle(20); };
  p.publish = async () => { d.getElementById('pubbtn').click(); await settle(400); };
  p.reload = async () => { await mods.app.loadMenu(B.rid); await settle(150); };
  p.bar = () => d.getElementById('rbtxt').textContent;
  p.review_ = () => d.getElementById('mbody');
  return p;
}
const nameIn = (src, k) => src.items.find((r) => r.key === k).display.name;
const prodGroup = (p) => [...p.review_().querySelectorAll('.mgroup')].find((g) => g.querySelector('.mglabel span').textContent === 'Productos');
const RM_LINE = 'se quita del menú; tus pedidos pasados no cambian';
const U2 = 'No pudimos leer el menú publicado. Recargá la página.';

test('T13 R1 (real read, real stamps): «Quitar del menú» at the foot of the drawer body; absent on a dish with options and with the switch OFF; the press writes nothing', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  const dr = await p.open('dimsum_01');
  const act = p.rmAct();
  assert.ok(act, 'the action is drawn (the switch ON, a published stamped plain dish)');
  assert.equal(act, p.drawer().querySelector('.dwb').lastElementChild, 'the body\'s last child, above the footer');
  const btn = act.querySelector('button');
  assert.equal(btn.className, 'btn ghost mk-quiet-danger');
  assert.equal(btn.textContent, 'Quitar del menú');
  assert.ok(btn.querySelector('svg'), 'the row menu\'s trash glyph');
  assert.equal(btn.disabled, false);
  assert.ok(dr.querySelector('.dwf'), 'the footer stays «Cancelar» · «Guardar»');
  const before = JSON.stringify(p.src());
  btn.click(); await settle(5);
  assert.equal(JSON.stringify(p.src()), before, 'the press writes nothing');
  assert.ok(p.d.getElementById('xscrim').classList.contains('show'), 'the R2 confirm is open');
  p.xbtn('Volver').click(); await settle(5);
  assert.equal(JSON.stringify(p.src()), before, '«Volver» writes nothing');
  await p.open('noodle_01');
  assert.equal(p.rmAct(), null, 'a dish with options shows no Quitar del menú');
  RP_SW.on = false;
  try {
    const p2 = await rpPage(B); await p2.signIn(); await p2.open('dimsum_01');
    assert.equal(p2.rmAct(), null, 'the switch OFF: no action (today\'s drawer)');
  } finally { RP_SW.on = true; }
});

test('T21g / §2 row 6: a read WITHOUT liveOrder, or without a readable baseline — the action is present but disabled with the reused line', async () => {
  for (const drop of ['liveOrder', 'deletionBase']) {
    const B = await rpBackend('la_musa');
    B.tweakRead = (body) => { delete body[drop]; };
    const p = await rpPage(B); await p.signIn();
    await p.open('dimsum_01');
    const act = p.rmAct();
    assert.ok(act, `${drop} missing: the action is still drawn`);
    assert.equal(act.querySelector('button').disabled, true, `${drop} missing: an unreadable baseline: disabled with the reused line`);
    assert.equal((act.querySelector('.mk-ferr') || {}).textContent, U2, `${drop} missing: the U2 line under it`);
    const before = JSON.stringify(p.src());
    act.querySelector('button').click(); await settle(5);
    assert.equal(JSON.stringify(p.src()), before, `${drop} missing: no liveOrder, no guessed order — nothing written`);
  }
});

test('T15 R3 (real read): the pending row — greyed, the sand chip, no opener, the price inert, «Deshacer» focused; the rail count stays; the bar counts the dish once', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  const name = nameIn(p.src(), 'dimsum_02');
  const rail0 = p.railCount('Dim Sum');
  // an edit of the same dish first (its drawer's «Guardar»), so «edited and removed» is one product
  await p.open('dimsum_02');
  const desc = [...p.drawer().querySelectorAll('.dwb > .fld')].find((f) => f.querySelector('label').firstChild.textContent.trim() === 'Descripción').querySelector('textarea');
  desc.value = 'Otra descripción'; desc.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  [...p.drawer().querySelectorAll('.dwf button')].find((b) => b.textContent.trim() === 'Guardar').click(); await settle(10);
  await p.remove('dimsum_02');
  assert.equal(p.drawer().classList.contains('show'), false, '«Quitar» closes the confirm AND the drawer');
  const row = p.rowOf('dimsum_02');
  assert.ok(row, 'the dish stays in its place (the list projection)');
  assert.ok(row.classList.contains('mk-pend'), 'the row is greyed (irow mk-pend)');
  const chip = row.querySelector('.nm .tag.mk-sand');
  assert.equal(chip && chip.textContent, 'Se quita al publicar');
  assert.equal(row.querySelector('.rowchev'), null, 'no chevron');
  assert.equal(row.querySelector('.iinfo').classList.contains('clk'), false);
  row.querySelector('.iinfo').click(); await settle(5);
  assert.equal(p.drawer().classList.contains('show'), false, 'a pending row does not open the editor');
  assert.equal(row.querySelector('.price input').disabled, true, 'the price is inert');
  const undo = row.querySelector('button.mk-lnk.mk-undo');
  assert.equal(undo.textContent, 'Deshacer');
  assert.equal(undo.getAttribute('aria-label'), `Deshacer: ${name} vuelve al menú`);
  assert.equal(p.d.activeElement, undo, '«Quitar» focuses the row\'s «Deshacer»');
  assert.equal(p.railCount('Dim Sum'), rail0, 'the rail count stays until publish');
  assert.equal(p.bar(), '1 cambio sin publicar · 1 producto', 'an edited and removed dish counts once');
  // the text edit SAVED first (a reload serves it as pendingTexts), then the removal: still ONE product
  await p.undo('dimsum_02');
  await p.review(); await p.back(); await p.reload();
  await p.remove('dimsum_02');
  assert.match(p.bar(), / · 1 producto$/, 'an edited and removed dish counts once (the edit saved)');
});

test('T16 R5 (real read): the reward line follows the SERVED rewardKeys — a reward dish carries the sand line, a plain one does not; never derived on the client', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  await p.section('Bebidas');
  await p.open('soft_01');
  p.rmAct().querySelector('button').click(); await settle(5);
  assert.ok(p.d.querySelector('#xscrim .mk-sandline'), 'a reward dish\'s confirm carries the sand line');
  p.xbtn('Volver').click(); await settle(5);
  B.tweakRead = (body) => { body.rewardKeys = []; };                     // the server says no dish is a reward now
  await p.reload(); await p.section('Bebidas');
  await p.open('soft_01');
  p.rmAct().querySelector('button').click(); await settle(5);
  assert.equal(p.d.querySelector('#xscrim .mk-sandline'), null, 'the reward line follows the served rewardKeys');
  p.xbtn('Volver').click(); await settle(5);
  const app = fs.readFileSync(path.join(HERE, 'app.js'), 'utf8');
  assert.ok(!/redeem_eligible/.test(app.slice(app.indexOf('function openRemoveProduct'), app.indexOf('function openRemoveProduct') + 1500)), 'the R5 line reads rewardKeys only');
});

test('T7 chain: remove → «Deshacer» (in session) → save: 200, nothing removed, the claim withdrawn, no base sent', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  const before = p.src();
  await p.remove('dimsum_01');
  await p.undo('dimsum_01');
  assert.deepEqual(p.src().items, before.items, 'undo restores the row as it was before the removal');
  assert.deepEqual(p.src().structure.item_order, before.structure.item_order, 'undo restores the live place (no item_order_changed)');
  await p.review();
  const save = B.saves[B.saves.length - 1];
  assert.equal(save.status, 200, `the save answers 200 (${JSON.stringify(save.reply).slice(0, 160)})`);
  assert.equal(save.body.deleted_ids_loaded_base, undefined, 'undo withdraws the claim (no base sent)');
  assert.deepEqual([].concat(save.body.source.deleted_ids || []), [], 'undo withdraws the claim');
  assert.ok(!(save.reply.diff.removed || []).some((x) => x.key === 'dimsum_01'), 'nothing removed');
});

test('T4 + T5 chain (la_musa, REAL stamps): remove → the owner\'s save → R4 «Productos» row → publish: the version, the public menu and the claim', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  const sid = p.src().items.find((r) => r.key === 'dimsum_03').display.identity_id;
  assert.ok(typeof sid === 'string' && sid, 'premise: the dish carries the REAL stamp the bootstrap wrote');
  const name = nameIn(p.src(), 'dimsum_03');
  await p.remove('dimsum_03');
  await p.review();
  const save = B.saves[B.saves.length - 1];
  assert.equal(save.status, 200, `remove dish → save: 200 (not deleted_ids_unbound) (${JSON.stringify(save.reply).slice(0, 200)})`);
  assert.deepEqual(save.body.source.deleted_ids, [sid], 'the dish\'s identity stamp is claimed');
  assert.ok(!save.body.source.items.some((r) => r.key === 'dimsum_03'), 'the sent source lacks the removed dish');
  const g = prodGroup(p);
  assert.ok(g, 'the removal is listed under Productos');
  assert.equal(g.querySelector('.mgn').textContent, '1');
  const rows = [...g.querySelectorAll('.prow.mk-srow')];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('.pname').textContent, name);
  assert.equal(rows[0].querySelector('.psub').textContent, 'Dim Sum');
  assert.equal(rows[0].querySelector('.bchip.rem').textContent, 'Quitado');
  assert.equal(rows[0].querySelector('.now.plain').textContent, RM_LINE);
  assert.ok(![...p.review_().querySelectorAll('.mglabel span')].some((s) => s.textContent === 'Se eliminan'), 'the removal is listed once, under Productos');
  await p.publish();
  assert.equal(B.statuses[B.statuses.length - 1], 'publish 200', `publish answers 200 (${B.statuses.join(' ')})`);
  const live = await B.live();
  assert.ok(!live.items.some((r) => r.key === 'dimsum_03'), 'the version lacks the dish');
  assert.equal([].concat((await B.claim()) || []).length, 0, 'the claim is consumed');
  const menu = await B.publicMenu();
  assert.ok(!JSON.stringify(menu).includes(name), 'buildPublicMenu lacks it');
  await until(() => p.mods.app.state.removalStash.size === 0);
  assert.equal(p.mods.app.state.removalStash.size, 0, 'the stash ends with the publish');
});

test('T19 chain (x_pizza, fiscal): a removal alone — the REAL save says fiscalAckRequired:false → no seal, no fiscalAck, publish 200; a reprice too → today\'s seal', async () => {
  const B = await rpBackend('x_pizza');
  const p = await rpPage(B); await p.signIn();
  const src = p.src(); const k = plainDish(src);
  await p.remove(k);
  await p.review();
  const save = B.saves[B.saves.length - 1];
  assert.equal(save.status, 200, `save 200 (${JSON.stringify(save.reply).slice(0, 200)})`);
  assert.equal(save.reply.fiscalAckRequired, false, 'premise: the server waives the ack for a removal-only draft');
  assert.equal(p.d.querySelector('#revFoot .seal, #scrim .seal'), null, 'a removal alone asks no Autorizo');
  assert.equal(p.d.getElementById('pubbtn').disabled, false, '«Publicar» enabled at once');
  await p.publish();
  assert.notEqual(B.publishBodies[B.publishBodies.length - 1].fiscalAck, true, 'no seal, no fiscalAck');
  assert.equal(B.statuses[B.statuses.length - 1], 'publish 200', `publish 200 (${B.statuses.join(' ')})`);
  // a draft that ALSO reprices: the field is absent → today's seal
  const B2 = await rpBackend('x_pizza');
  const p2 = await rpPage(B2); await p2.signIn();
  const k2 = plainDish(p2.src());
  const other = p2.src().items.find((r) => r.key !== k2 && Number.isInteger(r.price) && r.display && !('variantOf' in r.display));
  await p2.remove(k2);
  const pin = p2.rowOf(other.key) && p2.rowOf(other.key).querySelector('.price input');
  assert.ok(pin, 'premise: the repriced dish is on screen');
  pin.value = String(other.price + 5); pin.dispatchEvent(new p2.w.Event('input', { bubbles: true }));
  await p2.review();
  const save2 = B2.saves[B2.saves.length - 1];
  assert.equal(save2.status, 200);
  assert.equal(save2.reply.fiscalAckRequired, undefined, 'premise: a reprice keeps the ack (field absent)');
  assert.ok(p2.d.querySelector('#scrim .seal'), 'absent ⇒ today\'s seal (a reprice still draws the seal)');
});

test('T8 + T11 chain (REAL stamps, condition 2): remove rice_03 (extras_by_item + override) and soft_01 (reward) → save → reload → the rows from P-R1 → «Deshacer» → save 200, restored WITH its refs', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  const before = p.src();
  await p.section('Rice'); await p.remove('rice_03');
  await p.section('Bebidas'); await p.remove('soft_01');
  const mid = p.src();
  assert.ok(!mid.structure.extras_by_item.rice_03 && !(mid.structure.exposure.item_overrides || {}).rice_03, 'the removed dish\'s own entries leave with it');
  assert.ok(!mid.structure.redeem_eligible_items.includes('soft_01'));
  for (const k of Object.keys(before.structure.exposure.item_overrides || {})) if (k !== 'rice_03') assert.deepEqual(mid.structure.exposure.item_overrides[k], before.structure.exposure.item_overrides[k], 'every other dish\'s entries are byte-identical');
  await p.review();
  assert.equal(B.saves[B.saves.length - 1].status, 200, `save 200 (${JSON.stringify(B.saves[B.saves.length - 1].reply).slice(0, 200)})`);
  await p.back();
  await p.reload();
  await p.section('Rice');
  assert.ok(p.rowOf('rice_03') && p.rowOf('rice_03').classList.contains('mk-pend'), 'after a reload the pending row is drawn');
  const riceName = nameIn(before, 'rice_03');
  await p.review();
  const named = [...prodGroup(p).querySelectorAll('.prow.mk-srow .pname')].map((x) => x.textContent);
  assert.ok(named.includes(riceName) && !named.includes('rice_03'), `the removed dish is named after a reload (${named.join(', ')})`);
  await p.back();
  await p.section('Rice');
  await p.undo('rice_03');
  await p.section('Bebidas');
  assert.ok(p.rowOf('soft_01').classList.contains('mk-pend'));
  await p.undo('soft_01');
  const back = p.src();
  assert.deepEqual(back.structure.extras_by_item.rice_03, before.structure.extras_by_item.rice_03, 'restored WITH its refs');
  assert.deepEqual(back.structure.exposure.item_overrides.rice_03, before.structure.exposure.item_overrides.rice_03, 'restored WITH its refs');
  assert.deepEqual(back.structure.redeem_eligible_items, before.structure.redeem_eligible_items, 'rewards follow the live order');
  assert.deepEqual(back.structure.item_order, before.structure.item_order, 'the live order filtered to what is present');
  await p.review();
  const s2 = B.saves[B.saves.length - 1];
  assert.equal(s2.status, 200, `undo after a reload saves 200 (${JSON.stringify(s2.reply).slice(0, 200)})`);
  assert.deepEqual([].concat(s2.body.source.deleted_ids || []), [], 'undo withdraws the claim');
});

test('T21 chain (REAL stamps): dimsum_01 then dimsum_02, a save after EVERY step and both undo orders — every save 200', async () => {
  for (const order of [['dimsum_01', 'dimsum_02'], ['dimsum_02', 'dimsum_01']]) {
    const B = await rpBackend('la_musa');
    const p = await rpPage(B); await p.signIn();
    const live = p.src().structure.item_order.slice();
    const step = async (label) => {
      await p.review();
      const s = B.saves[B.saves.length - 1];
      assert.equal(s.status, 200, `${label}: save 200 (${JSON.stringify(s.reply).slice(0, 200)})`);
      const present = new Set(p.src().items.map((r) => r.key));
      assert.deepEqual(s.body.source.structure.item_order, live.filter((k) => present.has(k)), `${label}: the live order filtered to what is present`);
      await p.back();
    };
    await p.remove('dimsum_01'); await step('remove 1');
    await p.remove('dimsum_02'); await step('remove 2');
    await p.undo(order[0]); await step(`undo ${order[0]}`);
    await p.undo(order[1]); await step(`undo ${order[1]}`);
  }
});

test('T12 / T12b chain: the last dishes of a SECTION (Crudo) and of a SUBSECTION (Bebidas · Sodas) — the REAL refusal, the existing line verbatim, the rows stay pending', async () => {
  const IE = await import('./item-edit-logic.js');
  for (const [sec, keys, code, line] of [['Crudo', ['crudo_01', 'crudo_02', 'crudo_03'], 'section_emptied', IE.COPY.cat.section_empty],
    ['Bebidas', ['soft_01', 'soft_02', 'soft_03', 'soft_04'], 'subsection_emptied', IE.COPY.cat.subsection_empty]]) {
    const B = await rpBackend('la_musa');
    const p = await rpPage(B); await p.signIn();
    await p.section(sec);
    for (const k of keys) await p.remove(k);
    await p.review();
    const s = B.saves[B.saves.length - 1];
    assert.equal(s.reply.error, code, `the server refuses, the existing panel shows (${JSON.stringify(s.reply).slice(0, 160)})`);
    const txt = p.d.getElementById('scrim').textContent;
    assert.ok(txt.includes(line), `${code}: ${code === 'subsection_emptied' ? 'the subsection line, verbatim' : 'never the generic panel'} (${txt.slice(0, 200)})`);
    assert.ok(!txt.includes('No se pudo guardar el borrador'), 'never the generic panel');
    await p.back();
    await p.section(sec);
    for (const k of keys) assert.ok(p.rowOf(k) && p.rowOf(k).classList.contains('mk-pend'), `${k}: the row stays pending`);
    await p.undo(keys[0]);
    await p.review();
    assert.equal(B.saves[B.saves.length - 1].status, 200, '«Deshacer» then saves 200');
  }
});

test('T20 chain: removing the only extras_by_item dish (rice_03) keeps the authored {} — save 200, publish 200', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  await p.section('Rice'); await p.remove('rice_03');
  await p.review();
  const s = B.saves[B.saves.length - 1];
  assert.equal(s.status, 200, `save 200 (${JSON.stringify(s.reply).slice(0, 200)})`);
  assert.deepEqual(s.body.source.structure.extras_by_item, {}, 'the authored {} stays');
  await p.publish();
  assert.equal(B.statuses[B.statuses.length - 1], 'publish 200', `publish 200 (${B.statuses.join(' ')})`);
});

test('T9 chain: a moved base under the claim — REVIEW-DELETIONS names the DISH with its place; «Confirmar y seguir» resends with deleted_ids_reviewed → 200', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  const name = nameIn(p.src(), 'dimsum_04');
  await p.remove('dimsum_04');
  await B.activateAgain();                                   // the live pointer moves under the loaded base
  await p.review(); await settle(150);
  const first = B.saves[B.saves.length - 1];
  assert.match(String(first.reply.error), /^deleted_ids_/, `premise: the claim judgment refuses (${JSON.stringify(first.reply).slice(0, 160)})`);
  const sheet = p.d.getElementById('xscrim');
  assert.ok(sheet.classList.contains('show'), 'REVIEW-DELETIONS is open');
  assert.ok(sheet.textContent.includes(name), `the deletion list names the dish (${sheet.textContent.slice(0, 200)})`);
  assert.ok(sheet.textContent.includes('Dim Sum'), 'with its place');
  assert.ok(!sheet.textContent.includes('Un extra que ya no está en el menú'), 'a known dish never gets the extra string');
  p.xbtn('Confirmar y seguir').click(); await settle(300);
  const resend = B.saves[B.saves.length - 1];
  assert.equal(resend.body.deleted_ids_reviewed, true, 'the resend acknowledges the re-shown list');
  assert.equal(resend.status, 200, `the resend saves (${JSON.stringify(resend.reply).slice(0, 160)})`);
});

test('T6 chain (x_pizza: a manager SENDS — the real read decides): «Enviar al dueño» sends the same base; the owner\'s review (a reload with P-R1) shows the same R4 row', async () => {
  const B = await rpBackend('x_pizza');
  B.who = 'manager';
  const p = await rpPage(B); await p.signIn();
  assert.equal(p.mods.app.state.publishViaRequest, true, `premise: the real read makes this manager a sender (${p.d.getElementById('review').textContent})`);
  const k = plainDish(p.src());
  const name = nameIn(p.src(), k);
  await p.remove(k);
  p.d.getElementById('review').click();
  await until(() => B.statuses.some((s) => String(s).startsWith('request ')));
  const sent = B.saves[B.saves.length - 1];
  assert.equal(sent.status, 200, `the manager's save (${JSON.stringify(sent.reply).slice(0, 160)})`);
  assert.ok(sent.body.deleted_ids_loaded_base, 'the same base is sent');
  assert.ok(B.statuses.includes('request 200'), `the request records (${B.statuses.join(' ')})`);
  B.who = 'owner';
  const o = await rpPage(B); await o.signIn();
  await o.review();
  const g = prodGroup(o);
  const row = g && g.querySelector('.prow.mk-srow');
  assert.ok(row, 'the owner\'s review (after a reload with P-R1) lists the removal');
  assert.equal(row.querySelector('.pname').textContent, name, 'the removed dish is named after a reload');
  assert.equal(row.querySelector('.now.plain').textContent, RM_LINE);
});

test('T17 / §9: the stash ends with the world — a new load and a tenant change leave no stash; «Descartar» brings the row back', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  await p.remove('dimsum_01');
  assert.equal(p.mods.app.state.removalStash.size, 1, 'premise: the in-session stash holds the snapshot');
  p.d.getElementById('discard').click(); await settle(20);
  assert.ok(p.src().items.some((r) => r.key === 'dimsum_01'), '«Descartar»: the row is back');
  assert.equal(p.mods.app.state.removalStash.size, 0, '«Descartar» clears the stash');
  await p.remove('dimsum_01');
  await p.reload();
  assert.equal(p.mods.app.state.removalStash.size, 0, 'the stash ends with the world');
});

test('T23 chain (A-2): ON — remove the last extras_by_item dish and publish; then OFF — an unrelated description edit saves 200 (the rollback lever keeps menu editing)', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  await p.section('Rice'); await p.remove('rice_03');
  await p.review(); await p.publish();
  assert.equal(B.statuses[B.statuses.length - 1], 'publish 200', `ON: publish 200 (${B.statuses.join(' ')})`);
  RP_SW.on = false;
  try {
    const p2 = await rpPage(B); await p2.signIn();
    await p2.open('dimsum_01');
    const desc = [...p2.drawer().querySelectorAll('.dwb > .fld')].find((f) => f.querySelector('label').firstChild.textContent.trim() === 'Descripción').querySelector('textarea');
    desc.value = 'Nueva descripción'; desc.dispatchEvent(new p2.w.Event('input', { bubbles: true }));
    [...p2.drawer().querySelectorAll('.dwf button')].find((b) => b.textContent.trim() === 'Guardar').click(); await settle(10);
    await p2.review();
    const s = B.saves[B.saves.length - 1];
    assert.equal(s.status, 200, `OFF: save 200 (${JSON.stringify(s.reply).slice(0, 200)})`);
  } finally { RP_SW.on = true; }
});

test('T9b: REVIEW-DELETIONS over a mixed list — a dish by name and place, an unnamed dish, an extra, and an id neither lists', async () => {
  const { deletionRows } = await import('./extras-logic.js');
  const src = live('la_musa');
  const d = createDraft(src);
  const ex = src.extras.find((e) => e.display && e.display.cat != null);
  ex.display.identity_id = 'xid_extra_1';
  const d2 = createDraft(src);
  const dishes = new Map([['id_dimsum_01', { name: 'Sichuan Spicy Wonton', place: 'Dim Sum' }], ['id_gone_dish', { name: '', place: 'Crudo' }]]);
  const rows = deletionRows(d2, ['id_dimsum_01', 'id_gone_dish', 'xid_extra_1', 'id_nobody'], dishes);
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual([by.get('id_dimsum_01').name, by.get('id_dimsum_01').group], ['Sichuan Spicy Wonton', 'Dim Sum'], 'the deletion list names the dish');
  assert.equal(by.get('id_gone_dish').name, 'Un producto que ya no está en el menú', 'a known dish never gets the extra string');
  assert.equal(by.get('xid_extra_1').name, ex.display.name, 'the extra keeps its own name');
  assert.equal(by.get('id_nobody').name, 'Un extra que ya no está en el menú', 'only the unclassifiable id gets the extra fallback');
  assert.deepEqual(deletionRows(d2, ['xid_extra_1', 'id_nobody']), deletionRows(d2, ['xid_extra_1', 'id_nobody'], null), 'without dish rows: S2\'s list exactly');
  void d;
});

test('T18 perf (§12): removeProduct and undoRemoveProduct each stay within 5 ms on the larger seed; the list projection within 2 ms', () => {
  const src = live('la_musa'); const lo = liveOrderOf(src);
  const best = (fn) => { let b = Infinity; for (let i = 0; i < 25; i++) { const t0 = process.hrtime.bigint(); fn(); b = Math.min(b, Number(process.hrtime.bigint() - t0) / 1e6); } return b; };
  const tRemove = best(() => { const d = createDraft(src); removeProduct(d, 'dimsum_02', ON(src)); });
  const tCreate = best(() => { createDraft(src); });
  const d = createDraft(src); const r = removeProduct(d, 'dimsum_02', ON(src));
  const tUndo = best(() => { const dd = createDraft(draftSource(d)); undoRemoveProduct(dd, 'dimsum_02', r.snap, lo); });
  const pend = new Map([['dimsum_02', r.snap]]);
  const tList = best(() => { removalListSource(d, pend, lo); });
  assert.ok(tRemove - tCreate <= 5, `removeProduct ${(tRemove - tCreate).toFixed(2)} ms ≤ 5`);
  assert.ok(tUndo - tCreate <= 5, `undoRemoveProduct ${(tUndo - tCreate).toFixed(2)} ms ≤ 5`);
  assert.ok(tList <= 2, `the list projection ${tList.toFixed(2)} ms ≤ 2`);
});

test('T10 chain (P-R3): remove one dish and add a new dish at the same price — R4 shows «Quitado» AND the addition, never a rename', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  const gone = p.src().items.find((r) => r.key === 'dimsum_04');
  await p.remove('dimsum_04');
  const draft = p.mods.app.state.draft;                                  // the add flow's own writers (editor.js), on the page's draft
  addProduct(draft, { ref: 'tmp:rp-t10-new1', cat: gone.display.cat });
  setAddition(draft, 'tmp:rp-t10-new1', 'name', 'Wonton de la Casa');
  setAddition(draft, 'tmp:rp-t10-new1', 'price', gone.price);
  await p.review();
  const s = B.saves[B.saves.length - 1];
  assert.equal(s.status, 200, `save 200 (${JSON.stringify(s.reply).slice(0, 200)})`);
  assert.deepEqual(s.reply.diff.renamed || [], [], 'a declared removal is never rename-paired');
  const row = prodGroup(p) && prodGroup(p).querySelector('.prow.mk-srow');
  assert.ok(row && row.querySelector('.bchip.rem'), 'R4 shows «Quitado»');
  assert.ok(p.review_().textContent.includes('Wonton de la Casa'), 'AND the addition');
});

test('T22 chain (B-5, P-R7): a dish WITH an active photo, uploads off — save 200 (no photo_change_disabled); R4 one «Quitado» row, no «Fotos» row; «Deshacer» puts the photo back', async () => {
  const B = await rpBackend('la_musa', { photo: 'rice_03' });
  const p = await rpPage(B); await p.signIn();
  assert.deepEqual(p.src().photos && p.src().photos.rice_03, { state: 'pid', pid: B.photoPid }, 'premise: the loaded draft carries the live photo');
  await p.section('Rice'); await p.remove('rice_03');
  assert.ok(!(p.src().photos && p.src().photos.rice_03), 'the dish\'s photo goes with it');
  await p.review();
  const s = B.saves[B.saves.length - 1];
  assert.equal(s.status, 200, `save 200, never photo_change_disabled (${JSON.stringify(s.reply).slice(0, 200)})`);
  const labels = [...p.review_().querySelectorAll('.mglabel span:first-child')].map((x) => x.textContent);
  assert.ok(!labels.includes('Fotos'), `ONE «Quitado» row, no «Fotos» row (${labels.join(', ')})`);
  assert.equal(prodGroup(p).querySelectorAll('.prow.mk-srow').length, 1, 'ONE «Quitado» row, no «Fotos» row');
  await p.back();
  await p.section('Rice'); await p.undo('rice_03');
  assert.deepEqual(p.src().photos.rice_03, { state: 'pid', pid: B.photoPid }, '«Deshacer» puts the photo back');
});

test('T22b chain (A-4): a photo dish removed → saved → «Deshacer» after a reload, uploads OFF — save 200, its own active photo comes back; an unrelated photo change is still refused', async () => {
  const B = await rpBackend('la_musa', { photo: 'rice_03' });
  const p = await rpPage(B); await p.signIn();
  await p.section('Rice'); await p.remove('rice_03');
  await p.review();
  assert.equal(B.saves[B.saves.length - 1].status, 200);
  await p.back(); await p.reload();
  await p.section('Rice');
  assert.ok(p.rowOf('rice_03').classList.contains('mk-pend'), 'premise: the pending row from P-R1');
  await p.undo('rice_03');
  assert.deepEqual(p.src().photos.rice_03, { state: 'pid', pid: B.photoPid }, 'its own active photo comes back');
  await p.review();
  const s = B.saves[B.saves.length - 1];
  assert.equal(s.status, 200, `the withdrawn removal saves 200 with uploads off (${JSON.stringify(s.reply).slice(0, 200)})`);
  await p.back();
  setPhoto(p.mods.app.state.draft, 'rice_01', { state: 'removed' });   // an unrelated photo change, through the draft's ONE photo setter
  await p.review();
  const s2 = B.saves[B.saves.length - 1];
  assert.deepEqual([s2.status, s2.reply.error], [409, 'photo_change_disabled'], 'an unrelated photo change in the same draft is still refused');
});

test('T13 R1 (real read): a «Nuevo» dish keeps «Descartar» — its drawer carries no «Quitar del menú»', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  const draft = p.mods.app.state.draft;                                  // the add flow's own writer (editor.js), on the page's draft
  addProduct(draft, { ref: 'tmp:rp-t13-nuevo', cat: 'dim_sum' });
  setAddition(draft, 'tmp:rp-t13-nuevo', 'name', 'Bao Nuevo');
  setAddition(draft, 'tmp:rp-t13-nuevo', 'price', 120);
  await p.open('tmp:rp-t13-nuevo');
  assert.ok(p.drawer().classList.contains('show'), 'premise: the new dish\'s drawer opened');
  assert.equal(p.drawer().querySelector('.mk-rmact'), null, 'a new dish keeps Descartar, no Quitar del menú');
  // SAVED but unpublished (the server's addition, now known by key): still «Nuevo», still no «Quitar del menú»
  p.mods.app.closeDrawer && p.mods.app.closeDrawer();
  await p.review();
  const s = B.saves[B.saves.length - 1];
  assert.equal(s.status, 200, `the addition saves (${JSON.stringify(s.reply).slice(0, 160)})`);
  const key = (s.reply.diff.added || []).find((a) => a && a.surface === 'item').key;
  await p.back();
  await p.open(key);
  assert.ok(p.drawer().classList.contains('show'), 'premise: the saved addition\'s drawer opened');
  assert.equal(p.drawer().querySelector('.mk-rmact'), null, 'a saved addition keeps Descartar, no Quitar del menú');
});

test('SBS 11-13 (R3 bar): a removal is ONE pending change — the dish\'s own item_overrides entry leaves with it, never a second «dish» structure change', async () => {
  const { pendingCount, pendingStructure } = await import('./editor.js');
  const src = live('la_musa');
  assert.ok(src.structure.exposure.item_overrides.rice_03, 'premise: rice_03 carries its own override');
  const d = createDraft(src);
  const r = removeProduct(d, 'rice_03', ON(src));
  assert.equal(r.ok, true);
  assert.deepEqual(pendingStructure(d), [], 'no «dish» structure line for the removed dish\'s own entry');
  assert.equal(pendingCount(d, new Set()), 1, 'the bar says «1 cambio sin publicar» (MOCKUP R3)');
  undoRemoveProduct(d, 'rice_03', r.snap, liveOrderOf(src));
  assert.equal(pendingCount(d, new Set()), 0, 'undone: nothing pending');
});

test('Codex HIGH r1 P3: the pending row keeps the dish\'s photo (the removal snapshot\'s), desaturated by the approved CSS — never an empty thumb', async () => {
  const B = await rpBackend('la_musa', { photo: 'rice_03' });
  const p = await rpPage(B); await p.signIn();
  await p.section('Rice');
  const thumbOf = () => { const t = p.rowOf('rice_03').querySelector('.thumb'); return t ? { cls: t.className.replace(/\s*mk-chg/, ''), kids: [...t.querySelectorAll('img, i, span')].map((x) => x.tagName + '.' + x.className).join(',') } : null; };
  const before = thumbOf();
  assert.ok(before && before.kids, `premise: the live row draws the photo (${JSON.stringify(before)})`);
  await p.remove('rice_03');
  assert.ok(p.rowOf('rice_03').classList.contains('mk-pend'), 'premise: pending');
  assert.deepEqual(thumbOf(), before, 'the pending row draws the SAME photo the row had (the snapshot\'s entry)');
});

test('Codex HIGH r1 P3 (R3 bar): removing a PHOTOGRAPHED dish is still ONE change — its photo cleanup is the removal, never a «· 1 foto» line', async () => {
  const { pendingCount, pendingPhotos } = await import('./editor.js');
  const src = live('la_musa');
  src.photos = { rice_03: { state: 'pid', pid: 'b'.repeat(32) } };            // the dish carries a published photo (the draft map's shape)
  const d = createDraft(src);
  const r = removeProduct(d, 'rice_03', ON(src));
  assert.equal(r.ok, true);
  assert.deepEqual(pendingPhotos(d), [], 'no photo line for the removed dish');
  assert.equal(pendingCount(d, new Set()), 1, '«1 cambio sin publicar» (MOCKUP R3)');
  undoRemoveProduct(d, 'rice_03', r.snap, liveOrderOf(src));
  assert.equal(pendingCount(d, new Set()), 0, 'undone: nothing pending, the photo back');
});

// Codex HIGH r1 P2 — the snapshot's refs must still resolve in the draft NOW: an extra deleted between the removal and «Deshacer» would make
// the restored override name a key the source no longer has (the REAL editCatalog refuses the whole save, 400 invalid_source)
async function untickedDish(src, dish) {   // the drawer's own writer unticks one extra of the dish (deny_extras), as S2's suite does
  const IE = await import('./item-edit-logic.js');
  const d = createDraft(src);
  const s = IE.open(d, dish, [], { extrasAuthoring: true, extrasCatalog: true });
  const x = src.extras.find((e) => e.display && e.display.cat === 'Salsas').key;   // dimsum_01 offers «Salsas» (structure-s2's premise)
  IE.set(s, 'extraOn', { key: x, on: false });
  assert.deepEqual(IE.save(d, s), { ok: true }, 'premise: the drawer writer saved the untick');
  return { src: clone(draftSource(d)), x };
}
test('Codex HIGH r1 P2: «Deshacer» refuses a snapshot whose override names an extra deleted meanwhile — the draft byte-identical, never an invalid source', async () => {
  const base = live('la_musa');
  const { src, x } = await untickedDish(base, 'dimsum_01');
  assert.ok(((src.structure.exposure.item_overrides.dimsum_01 || {}).deny_extras || []).includes(x), `premise: dimsum_01 denies ${x}`);
  const d = createDraft(src);
  const r = removeProduct(d, 'dimsum_01', ON(src));
  assert.equal(r.ok, true);
  assert.equal(applyExposureOps(d, [{ op: 'extra.remove', key: x }], { extrasCatalog: true }).ok, true, 'premise: the extra is deleted (the Extras writer)');
  const before = JSON.stringify(draftSource(d));
  const u = undoRemoveProduct(d, 'dimsum_01', r.snap, liveOrderOf(src));
  assert.deepEqual(u, { ok: false, code: 'refs_stale' }, 'undo refuses: its override would name a deleted extra');
  assert.equal(JSON.stringify(draftSource(d)), before, 'the draft is byte-identical');
  const { validateSource } = req('../xpizza-functions/catalog/source-store.js');
  assert.doesNotThrow(() => validateSource(clone(draftSource(d)), 'la_musa'), 'the draft stays a source the server accepts');
});

test('Codex HIGH r1 P2 (page): a refused «Deshacer» keeps the row pending and says so with the existing generic line — never an invalid save', async () => {
  const B = await rpBackend('la_musa');
  const p = await rpPage(B); await p.signIn();
  const IE = await import('./item-edit-logic.js');
  const draft = p.mods.app.state.draft;
  const x = draftSource(draft).extras.find((e) => e.display && e.display.cat === 'Salsas').key;
  const s = IE.open(draft, 'dimsum_01', [], { extrasAuthoring: true, extrasCatalog: true });   // the drawer writer, on the page's draft
  IE.set(s, 'extraOn', { key: x, on: false });
  assert.deepEqual(IE.save(draft, s), { ok: true }, 'premise: the untick saved');
  await p.remove('dimsum_01');
  assert.equal(applyExposureOps(draft, [{ op: 'extra.remove', key: x }], { extrasCatalog: true }).ok, true, 'premise: the extra is deleted');
  await p.undo('dimsum_01');
  const row = p.rowOf('dimsum_01');
  assert.ok(row && row.classList.contains('mk-pend'), 'the row stays pending (nothing restored)');
  assert.equal((row.querySelector('.ferr.mk-ferr') || {}).textContent, 'No pudimos aplicar el cambio. Recargá la página.', 'the existing generic refusal line, under the row');
});
