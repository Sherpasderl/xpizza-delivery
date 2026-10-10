'use strict';
// 1D add-product B (rev 6, UNIFORM) — the group rules at intake / quote, decided in catalog/group-intake.js, on BOTH brands'
// key adapters (x_pizza lines key by NAME, la_musa lines by ID). Run: node catalog/group-intake.test.js
const assert = require('assert');
const GI = require('./group-intake');
const { availKey } = require('../avail-key');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ON = { render: true, authoring: false }; const OFF = { render: false, authoring: true };
/* PRODUCTION-FAITHFUL gate snapshots (codex PB-1 r1: the old hand-built fixtures omitted `known`, which masked P1-1):
   each brand's snapshot is what the REAL gate reader (catalog/menu-gates.js createGateReader) derives from a REAL built
   catalog — known dish keys, known extra keys and the group index all from the same version. la_musa = its live catalog
   (Pad Thai = noodle_01 + three choices); x_pizza = its live catalog plus a NY Plain Slice group with two choices. */
const { buildCatalogV2 } = require('./form-menu-source');
const { createGateReader } = require('./menu-gates');
function xpWithGroup() {
  const b = buildCatalogV2('x_pizza');
  const maxId = Math.max(...b.items.map((it) => Number(it.display.id) || 0));
  const L = maxId + 1; const A = L + 1; const C = L + 2;
  b.items.push({ key: 'NY Plain Slice', price: 624, display: { id: L, cat: 'ny', name: 'NY Plain Slice', price: 624 } });
  b.items.push({ key: 'NY Plain Slice - Salsa Roja', price: 624, display: { id: A, cat: 'ny', name: 'NY Plain Slice - Salsa Roja', price: 624, variantOf: L, choice: 'Salsa Roja' } });
  b.items.push({ key: 'NY Plain Slice - Combinada', price: 654, display: { id: C, cat: 'ny', name: 'NY Plain Slice - Combinada', price: 654, variantOf: L, choice: 'Combinada' } });
  b.structure.variant_items = { [String(L)]: { label: 'Salsa', variantIds: [A, C] } };
  return b;
}
const BUILT = { x_pizza: xpWithGroup(), la_musa: buildCatalogV2('la_musa') };
// the handlers' PRICING TABLES in their production shape ({ restaurantId, menu, extras }), from the same built catalogs
const tablesOf = (rid, b) => ({ restaurantId: rid, menu: Object.fromEntries(b.items.map((it) => [it.key, it.price])),
  extras: Object.fromEntries((b.extras || []).map((e) => [e.key, e.price])) });
const NS = { x_pizza: GI.rewardNamespaceIn('x_pizza', tablesOf('x_pizza', BUILT.x_pizza)), la_musa: GI.rewardNamespaceIn('la_musa', tablesOf('la_musa', BUILT.la_musa)) };
// every call below resolves reward namespaces as the handler does, unless a cell overrides it
const GIs = (o) => GI.groupIssues({ rewardNamespace: NS[o.restaurantId], ...o });
const READER = createGateReader({ getMenu: async (rid) => BUILT[rid], getVersionId: async (rid) => `v-${rid}` });
const SNAP = {};
// the same order, written in each brand's line shape
const LINE = {
  x_pizza: (key) => ({ name: key, qty: 1, price: 624 }),
  la_musa: (key) => ({ id: key, name: key, qty: 1, price: 342 }),
};
const L = { x_pizza: 'NY Plain Slice', la_musa: 'noodle_01' };
const VAR = { x_pizza: 'NY Plain Slice - Salsa Roja', la_musa: 'noodle_01_pollo' };
const PLAIN = { x_pizza: 'Pepperoni', la_musa: 'dimsum_01' };
const node86 = (key) => ({ [availKey(key)]: { available: false } });

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) SNAP[rid] = await READER.intakeGatesFor(rid);
  assert.ok(SNAP.x_pizza.groups && SNAP.x_pizza.groups.launchers.has('NY Plain Slice') && SNAP.la_musa.groups.launchers.has('noodle_01'), 'premise: the real reader indexes both groups');
  assert.ok(SNAP.la_musa.knownExtras.has('rice_white') && SNAP.x_pizza.known.has('Pepperoni'), 'premise: known dishes AND known extras come from the same snapshot');
  {
    let reads = 0;
    for (const rid of ['x_pizza', 'la_musa']) {
      const r = await GIs({ caps: OFF, gates: SNAP[rid], items: [LINE[rid](L[rid])], restaurantId: rid, rewardKeys: [L[rid]], readAvailability: async () => { reads += 1; return {}; } });
      assert.strictEqual(r, null, `${rid}: render OFF → no rule, whatever the order holds`);
      assert.strictEqual(await GIs({ caps: undefined, gates: SNAP[rid], items: [LINE[rid](L[rid])], restaurantId: rid }), null);
    }
    assert.strictEqual(reads, 0, 'and NO availability read happens');
    ok('render capability OFF: nothing is decided and nothing is read (PB-1 ships dormant)');
  }
  {
    for (const rid of ['x_pizza', 'la_musa']) {
      const bare = await GIs({ caps: ON, gates: SNAP[rid], items: [LINE[rid](PLAIN[rid]), LINE[rid](L[rid]), LINE[rid](L[rid])], restaurantId: rid });
      assert.deepStrictEqual(bare, { bare: [L[rid]], rewardBare: [], parentBlocked: [] }, `${rid}: a bare launcher LINE (deduplicated, by pricing key)`);
      const reward = await GIs({ caps: ON, gates: SNAP[rid], items: [LINE[rid](PLAIN[rid])], restaurantId: rid, rewardKeys: [L[rid]] });
      assert.deepStrictEqual(reward, { bare: [], rewardBare: [L[rid]], parentBlocked: [] }, `${rid}: a bare launcher REWARD`);
      assert.strictEqual(await GIs({ caps: ON, gates: SNAP[rid], items: [LINE[rid](VAR[rid]), LINE[rid](PLAIN[rid])], restaurantId: rid, rewardKeys: [VAR[rid]] }), null,
        `${rid}: a CHOICE (line or reward) and a plain dish are fine`);
      assert.deepStrictEqual(await GIs({ caps: ON, gates: { groups: null }, items: [LINE[rid](PLAIN[rid])], restaurantId: rid }), { unclassifiable: true },
        `${rid}: an unreadable variant map is UNCLASSIFIABLE, never "no launchers"`);
    }
    ok('the SAME rule on both brands’ key adapters: a bare launcher line or reward is refused; a choice is fine; an unreadable map is unclassifiable');
  }
  /* ── codex PB-1 r1 P1-1 — a REWARD is classified by the SAME snapshot: an unknown reward key is UNCLASSIFIABLE ── */
  {
    for (const rid of ['x_pizza', 'la_musa']) {
      const ghost = rid === 'la_musa' ? 'noodle_09' : 'NY Garlic Slice';   // a product added AFTER this snapshot (e.g. a new launcher)
      assert.deepStrictEqual(await GIs({ caps: ON, gates: SNAP[rid], items: [LINE[rid](PLAIN[rid])], restaurantId: rid, rewardKeys: [ghost] }), { unclassifiable: true },
        `🔴 ${rid}: a reward key the snapshot does not know → unclassifiable (menu_updating), never "not a launcher"`);
      assert.deepStrictEqual(await GIs({ caps: ON, gates: { ...SNAP[rid], knownExtras: undefined }, items: [LINE[rid](PLAIN[rid])], restaurantId: rid, rewardKeys: [PLAIN[rid]] }), { unclassifiable: true },
        `🔴 ${rid}: a snapshot without extra membership cannot classify a reward → unclassifiable`);
    }
    assert.strictEqual(await GIs({ caps: ON, gates: SNAP.la_musa, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', rewardKeys: ['rice_white'] }), null,
      'la_musa: a KNOWN extra (acompañamiento) as the reward stays legitimate');
    // the reproduced path: the gate POINTER read fails → the code fallback; a launcher added in the portal is in neither code set
    const failing = createGateReader({ getMenu: async () => BUILT.la_musa, getVersionId: async () => { throw new Error('pointer read failed'); } });
    const fb = await failing.intakeGatesFor('la_musa');
    assert.strictEqual(fb.fallback, true, 'premise: the fallback snapshot is in force');
    assert.deepStrictEqual(await GIs({ caps: ON, gates: fb, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', rewardKeys: ['noodle_09'] }), { unclassifiable: true },
      '🔴 la_musa, gate pointer failing: a portal-added launcher as the reward is unclassifiable (no bypass at its stored price)');
    assert.deepStrictEqual(await GIs({ caps: ON, gates: fb, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', rewardKeys: ['noodle_01'] }), { bare: [], rewardBare: ['noodle_01'], parentBlocked: [] },
      'la_musa, fallback: the CODE launcher (Pad Thai) is still recognised as bare');
    assert.strictEqual(await GIs({ caps: ON, gates: fb, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', rewardKeys: ['rice_white'] }), null,
      'la_musa, fallback: a code-known extra reward stays legitimate');
    // codex PB-1 r2 P1 — a reward is classified in its RESOLVED namespace (dish before extra, as the calculator resolves)
    // a portal group "Rice White": its launcher key rice_white is ALSO the key of the extra "Arroz Blanco"
    const shadow = buildCatalogV2('la_musa');
    shadow.items.push({ key: 'rice_white', price: 600, display: { id: 'rice_white', cat: 'rice', name: 'Rice White', price: 600 } });
    shadow.items.push({ key: 'rice_white_a', price: 600, display: { id: 'rice_white_a', cat: 'rice', name: 'Rice White - A', price: 600, variantOf: 'rice_white', choice: 'A' } });
    shadow.items.push({ key: 'rice_white_b', price: 650, display: { id: 'rice_white_b', cat: 'rice', name: 'Rice White - B', price: 650, variantOf: 'rice_white', choice: 'B' } });
    shadow.structure.variant_items = { ...shadow.structure.variant_items, rice_white: { label: 'Opción', variantIds: ['rice_white_a', 'rice_white_b'] } };
    const nsShadow = GI.rewardNamespaceIn('la_musa', tablesOf('la_musa', shadow));
    assert.strictEqual(nsShadow('rice_white'), 'dish', 'premise: the calculator would resolve rice_white to the DISH (menu before extras)');
    assert.deepStrictEqual(await GI.groupIssues({ caps: ON, gates: fb, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', rewardKeys: ['rice_white'], rewardNamespace: nsShadow }), { unclassifiable: true },
      '🔴 codex r2 repro: fallback snapshot + a dish key shadowing an extra → the extra\'s membership does NOT admit the dish → unclassifiable');
    const healthy = await createGateReader({ getMenu: async () => shadow, getVersionId: async () => 'v-shadow' }).intakeGatesFor('la_musa');
    assert.deepStrictEqual(await GI.groupIssues({ caps: ON, gates: healthy, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', rewardKeys: ['rice_white'], rewardNamespace: nsShadow }), { bare: [], rewardBare: ['rice_white'], parentBlocked: [] },
      '🔴 a healthy snapshot that knows the dish: the shadowing key is classified as the DISH — a bare launcher reward');
    assert.strictEqual(await GI.groupIssues({ caps: ON, gates: healthy, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', rewardKeys: ['rice_white'], rewardNamespace: NS.la_musa }), null,
      'a snapshot NEWER than the pricing tables (it knows the shadowing launcher; the tables still price rice_white as the EXTRA): the reward is what the calculator charges — the extra — never refused as a launcher');
    assert.strictEqual(await GI.groupIssues({ caps: ON, gates: SNAP.la_musa, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', rewardKeys: ['rice_white'], rewardNamespace: NS.la_musa }), null,
      'without the shadowing dish, rice_white is the EXTRA and stays a legitimate reward');
    assert.deepStrictEqual(await GI.groupIssues({ caps: ON, gates: SNAP.la_musa, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', rewardKeys: ['rice_white'] }), { unclassifiable: true },
      'no namespace resolver supplied → a reward is unclassifiable (fail closed)');
    ok('rewards are classified by the same snapshot: an unknown reward key (incl. a portal launcher under the read-failure fallback) or a snapshot without extra membership is unclassifiable; known extras and choices stay legitimate');
  }
  {
    for (const rid of ['x_pizza', 'la_musa']) {
      const p86 = await GIs({ caps: ON, gates: SNAP[rid], items: [LINE[rid](VAR[rid])], restaurantId: rid, readAvailability: async () => node86(L[rid]) });
      assert.deepStrictEqual(p86, { bare: [], rewardBare: [], parentBlocked: [VAR[rid]] }, `${rid}: the LAUNCHER 86'd blocks its choice (whole-dish 86)`);
      const c86 = await GIs({ caps: ON, gates: SNAP[rid], items: [LINE[rid](VAR[rid])], restaurantId: rid, readAvailability: async () => node86(VAR[rid]) });
      assert.strictEqual(c86, null, `${rid}: a CHILD 86 is the existing availability gate's business, not this one`);
      const rw = await GIs({ caps: ON, gates: SNAP[rid], items: [LINE[rid](PLAIN[rid])], restaurantId: rid, rewardKeys: [VAR[rid]], readAvailability: async () => node86(L[rid]) });
      assert.deepStrictEqual(rw.parentBlocked, [VAR[rid]], `${rid}: a reward choice whose launcher is 86'd is blocked too`);
      const failed = await GIs({ caps: ON, gates: SNAP[rid], items: [LINE[rid](VAR[rid])], restaurantId: rid, readAvailability: async () => { throw new Error('rtdb down'); } });
      assert.strictEqual(failed, null, `${rid}: an availability READ FAILURE blocks nothing (today's fail-open)`);
    }
    let reads = 0;
    await GIs({ caps: ON, gates: SNAP.la_musa, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', readAvailability: async () => { reads += 1; return {}; } });
    assert.strictEqual(reads, 0, 'no variant in the order → no availability read at all');
    ok('parent-or-variant availability: a launcher 86 blocks its choices (lines and rewards); a read failure blocks nothing; no variant → no read');
  }
  {
    const issues = { bare: ['L'], rewardBare: [], parentBlocked: ['V'] };
    assert.deepStrictEqual(GI.chargeDecision(issues, null).respond.status, 503, 'classifier failed → retryable 503 (a retry re-classifies)');
    const fresh = GI.chargeDecision(issues, { willIssueFreshUrl: true });
    assert.deepStrictEqual([fresh.respond.status, fresh.respond.body.error, fresh.respond.body.keys], [409, 'choice_required', ['L']], 'a FRESH issuance is refused');
    const reuse = GI.chargeDecision(issues, { willIssueFreshUrl: false, outcome: 'reuse' });
    assert.deepStrictEqual([reuse.respond, reuse.armChoice, reuse.block], [null, true, ['V']], 'a verified REUSE is honoured (bound snapshot) and ARMS the acquire guard');
    const blockedOnly = GI.chargeDecision({ bare: [], rewardBare: [], parentBlocked: ['V'] }, { willIssueFreshUrl: true });
    assert.deepStrictEqual([blockedOnly.respond, blockedOnly.block], [null, ['V']], 'parent-86 joins cartBlocked, which acquire already enforces on fresh issuance');
    assert.deepStrictEqual(GI.chargeDecision({ unclassifiable: true }, { willIssueFreshUrl: false }), { respond: null, armChoice: false, armMenu: true, block: [] }, 'unclassifiable + reuse → arm the menu guard');
    assert.strictEqual(GI.chargeDecision({ unclassifiable: true }, { willIssueFreshUrl: true }).respond.status, 503);
    assert.strictEqual(GI.chargeDecision({ unclassifiable: true }, null).respond.status, 503, 'unclassifiable + the classifier failed → retryable 503 (never an armed guard on an unknown issuance)');
    assert.deepStrictEqual(GI.chargeDecision(null, { willIssueFreshUrl: true }), { respond: null, armChoice: false, armMenu: false, block: [] }, 'nothing to object to → nothing');
    ok('card: classifier failed → 503; fresh → 409 choice_required; reuse → honoured + guard armed; parent-86 → cartBlocked; unclassifiable → 503 / menu guard');
  }
  {
    assert.deepStrictEqual(GI.cashRefusal({ unclassifiable: true }), { status: 503, retryAfter: 2, body: { error: 'menu_updating', detail: 'El menú se está actualizando — probá de nuevo en un momento', retryable: true } });
    assert.deepStrictEqual(GI.cashRefusal({ bare: ['L'], rewardBare: ['R'], parentBlocked: [] }).body, { error: 'choice_required', detail: 'Elegí una opción antes de pedir este producto.', keys: ['L', 'R'] });
    assert.deepStrictEqual(GI.cashRefusal({ bare: [], rewardBare: [], parentBlocked: ['V'] }), { status: 400, body: { error: 'item_unavailable', blocked: ['V'] } });
    assert.strictEqual(GI.cashRefusal(null), null);
    assert.deepStrictEqual([GI.quoteRefusal({ bare: ['L'], rewardBare: [], parentBlocked: [] }), GI.quoteRefusal({ unclassifiable: true }), GI.quoteRefusal(null)],
      [{ error: 'choice_required' }, { error: 'menu_updating' }, null]);
    assert.deepStrictEqual(GI.rewardKeysOf({ items: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, {}], item_id: 'c' }), ['a', 'b', 'c'], 'reward keys: multiset ids + the single-item form, deduplicated');
    assert.deepStrictEqual([GI.rewardKeysOf(null), GI.rewardKeysOf({})], [[], []]);
    ok('cash: 503 / 409 choice_required (all bare keys) / 400 item_unavailable; quotes answer the same codes; reward keys read both request shapes');
  }
  console.log(`\ngroup-intake: OK (${n})`);
})().catch((e) => { console.error('group-intake FAILED:', e); process.exit(1); });
