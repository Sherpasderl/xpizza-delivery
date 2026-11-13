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
import {
  createDraft, draftSource, mergeDeletionClaim, addProduct, setAddition, setRequiredChoice, setGroupLabel, setChoiceName, addChoice, removeAddition,
  canRemoveProduct, removeProduct, undoRemoveProduct, rebuildOrders,
} from './editor.js';

const req = createRequire(import.meta.url);
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
