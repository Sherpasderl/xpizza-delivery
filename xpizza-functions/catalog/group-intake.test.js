'use strict';
// 1D add-product B (rev 6, UNIFORM) — the group rules at intake / quote, decided in catalog/group-intake.js, on BOTH brands'
// key adapters (x_pizza lines key by NAME, la_musa lines by ID). Run: node catalog/group-intake.test.js
const assert = require('assert');
const GI = require('./group-intake');
const { availKey } = require('../avail-key');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ON = { render: true, authoring: false }; const OFF = { render: false, authoring: true };
// one gate snapshot per brand: a launcher with two choices, by PRICING key
const SNAP = {
  x_pizza: { groups: { launchers: new Set(['NY Plain Slice']), parentOf: new Map([['NY Plain Slice - Salsa Roja', 'NY Plain Slice'], ['NY Plain Slice - Combinada', 'NY Plain Slice']]) } },
  la_musa: { groups: { launchers: new Set(['noodle_01']), parentOf: new Map([['noodle_01_pollo', 'noodle_01'], ['noodle_01_sin', 'noodle_01']]) } },
};
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
  {
    let reads = 0;
    for (const rid of ['x_pizza', 'la_musa']) {
      const r = await GI.groupIssues({ caps: OFF, gates: SNAP[rid], items: [LINE[rid](L[rid])], restaurantId: rid, rewardKeys: [L[rid]], readAvailability: async () => { reads += 1; return {}; } });
      assert.strictEqual(r, null, `${rid}: render OFF → no rule, whatever the order holds`);
      assert.strictEqual(await GI.groupIssues({ caps: undefined, gates: SNAP[rid], items: [LINE[rid](L[rid])], restaurantId: rid }), null);
    }
    assert.strictEqual(reads, 0, 'and NO availability read happens');
    ok('render capability OFF: nothing is decided and nothing is read (PB-1 ships dormant)');
  }
  {
    for (const rid of ['x_pizza', 'la_musa']) {
      const bare = await GI.groupIssues({ caps: ON, gates: SNAP[rid], items: [LINE[rid](PLAIN[rid]), LINE[rid](L[rid]), LINE[rid](L[rid])], restaurantId: rid });
      assert.deepStrictEqual(bare, { bare: [L[rid]], rewardBare: [], parentBlocked: [] }, `${rid}: a bare launcher LINE (deduplicated, by pricing key)`);
      const reward = await GI.groupIssues({ caps: ON, gates: SNAP[rid], items: [LINE[rid](PLAIN[rid])], restaurantId: rid, rewardKeys: [L[rid]] });
      assert.deepStrictEqual(reward, { bare: [], rewardBare: [L[rid]], parentBlocked: [] }, `${rid}: a bare launcher REWARD`);
      assert.strictEqual(await GI.groupIssues({ caps: ON, gates: SNAP[rid], items: [LINE[rid](VAR[rid]), LINE[rid](PLAIN[rid])], restaurantId: rid, rewardKeys: [VAR[rid]] }), null,
        `${rid}: a CHOICE (line or reward) and a plain dish are fine`);
      assert.deepStrictEqual(await GI.groupIssues({ caps: ON, gates: { groups: null }, items: [LINE[rid](PLAIN[rid])], restaurantId: rid }), { unclassifiable: true },
        `${rid}: an unreadable variant map is UNCLASSIFIABLE, never "no launchers"`);
    }
    ok('the SAME rule on both brands’ key adapters: a bare launcher line or reward is refused; a choice is fine; an unreadable map is unclassifiable');
  }
  {
    for (const rid of ['x_pizza', 'la_musa']) {
      const p86 = await GI.groupIssues({ caps: ON, gates: SNAP[rid], items: [LINE[rid](VAR[rid])], restaurantId: rid, readAvailability: async () => node86(L[rid]) });
      assert.deepStrictEqual(p86, { bare: [], rewardBare: [], parentBlocked: [VAR[rid]] }, `${rid}: the LAUNCHER 86'd blocks its choice (whole-dish 86)`);
      const c86 = await GI.groupIssues({ caps: ON, gates: SNAP[rid], items: [LINE[rid](VAR[rid])], restaurantId: rid, readAvailability: async () => node86(VAR[rid]) });
      assert.strictEqual(c86, null, `${rid}: a CHILD 86 is the existing availability gate's business, not this one`);
      const rw = await GI.groupIssues({ caps: ON, gates: SNAP[rid], items: [LINE[rid](PLAIN[rid])], restaurantId: rid, rewardKeys: [VAR[rid]], readAvailability: async () => node86(L[rid]) });
      assert.deepStrictEqual(rw.parentBlocked, [VAR[rid]], `${rid}: a reward choice whose launcher is 86'd is blocked too`);
      const failed = await GI.groupIssues({ caps: ON, gates: SNAP[rid], items: [LINE[rid](VAR[rid])], restaurantId: rid, readAvailability: async () => { throw new Error('rtdb down'); } });
      assert.strictEqual(failed, null, `${rid}: an availability READ FAILURE blocks nothing (today's fail-open)`);
    }
    let reads = 0;
    await GI.groupIssues({ caps: ON, gates: SNAP.la_musa, items: [LINE.la_musa(PLAIN.la_musa)], restaurantId: 'la_musa', readAvailability: async () => { reads += 1; return {}; } });
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
