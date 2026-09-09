// Portal 2b-2b Task 5 — the review screen. Run: node --test xpizza-portal/review.test.mjs
//
// 🔴🔴 MONEY. This is the last thing a merchant reads before their prices become what customers pay.
// Three ways it can lie, all silent:
//
//   WAS/NOW SWAPPED — the screen says a price went 900→349 when it is going 349→900. The merchant
//   approves a rise they read as a cut.
//   WRONG ROW — the right numbers against the wrong dish. Every value on screen is correct and the
//   sentence it forms is false.
//   BIG-FLAG DERIVED CLIENT-SIDE — the highlight and the acknowledgement set disagree, so the screen
//   emphasises one set of changes while the server demands confirmation of another.
//
// So: the model is built from the SERVER's diff, the big flag is MEMBERSHIP in the server's
// largeChangeSet (never a client recomputation of >50%), and the ack set is those objects verbatim.
//
// THE FIXTURE IS SERVER-PRODUCED, not hand-written. Regenerate with:
//   cd xpizza-functions && node -e "const {catalogDiff}=require('./catalog/catalog-edit'); …"
// (299→310 modest, 349→900 big up, extra 40→15 big down). Hand-writing it would let the test agree
// with my idea of the diff rather than with the diff.
import { test } from 'node:test';
import assert from 'node:assert';
import { reviewModel, ackSetFrom, renderReview } from './review.js';

const SERVER_DIFF = () => ({
  added: [],
  removed: [],
  renamed: [],
  changed: [
    { key: 'Queso extra', surface: 'extra', field: 'price', old: 40, new: 15 },
    { key: 'Pizza Margherita', surface: 'item', field: 'price', old: 299, new: 310 },
    { key: 'Pizza Pepperoni', surface: 'item', field: 'price', old: 349, new: 900 },
  ],
  largeChangeSet: [
    { key: 'Queso extra', surface: 'extra', reason: 'swing_gt_50', old: 40, new: 15 },
    { key: 'Pizza Pepperoni', surface: 'item', reason: 'swing_gt_50', old: 349, new: 900 },
  ],
});

// the same minimal shim render.test.mjs uses — only what review.js touches
function fakeDom() {
  const mk = (tag) => {
    const n = {
      tag, children: [], attrs: {}, listeners: {}, _class: '', dataset: {}, textContent: undefined,
      get className() { return n._class; },
      set className(v) { n._class = v; },
      classList: { add: (c) => { n._class = `${n._class} ${c}`.trim(); } },
      // append(string) creates a TEXT NODE in a real DOM. Modelling it as one keeps the shim honest:
      // without this, text appended as a raw string is invisible to the assertions and a string that
      // never rendered would pass unnoticed.
      append: (...cs) => n.children.push(...cs.map((c) => (typeof c === 'string' ? { tag: '#text', children: [], textContent: c, _class: '' } : c))),
      replaceChildren: (...cs) => { n.children = [...cs]; },
      setAttribute: (k, v) => { n.attrs[k] = v; },
      addEventListener: (ev, fn) => { (n.listeners[ev] = n.listeners[ev] || []).push(fn); },
    };
    return n;
  };
  globalThis.document = { createElement: mk, createElementNS: (_ns, tag) => mk(tag) };
  return mk('div');
}
const walk = (n, out = []) => { out.push(n); for (const c of n.children || []) walk(c, out); return out; };
const byClass = (root, cls) => walk(root).filter((n) => String(n._class || '').split(/\s+/).includes(cls));
const textOf = (n) => walk(n).map((x) => x.textContent).filter((t) => t !== undefined).join(' ');

test('the ack set is the server largeChangeSet, verbatim in both directions', () => {
  const diff = SERVER_DIFF();
  const ack = ackSetFrom(diff);
  // deep-equal BOTH ways: a missing entry and an invented one both fail ackMatches at the server, and
  // a re-derived list would differ from the one the token was bound to.
  assert.deepStrictEqual(ack, diff.largeChangeSet, 'the ack set equals the server set');
  assert.deepStrictEqual(diff.largeChangeSet, ack, '...and the server set equals the ack set');
  assert.strictEqual(ack.length, 2);
  // the SAME objects, carrying fields the server sent that it does not read back. Reshaping to
  // {key,surface} would still satisfy ackMatches today and would be a client-side rebuild of the very
  // thing that must not be rebuilt.
  assert.strictEqual(ack[0].reason, 'swing_gt_50', 'the reason survives');
  assert.strictEqual(ack[0].old, 40, '...and both values');
  assert.strictEqual(ack[0].new, 15);
  for (let i = 0; i < ack.length; i++) assert.strictEqual(ack[i], diff.largeChangeSet[i], 'same object identity — nothing was copied or mapped');

  // an EMPTY set is an empty ARRAY, not null or undefined: ackMatches refuses a non-array outright,
  // so a modest fiscal edit would turn into a 400 if this collapsed.
  const modest = { added: [], removed: [], renamed: [], changed: [{ key: 'a', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] };
  assert.deepStrictEqual(ackSetFrom(modest), [], 'an empty largeChangeSet stays an empty array');
  assert.ok(Array.isArray(ackSetFrom(modest)), '...and is still an array');
  // a diff with no largeChangeSet key at all must not become undefined
  assert.deepStrictEqual(ackSetFrom({ changed: [] }), [], 'a diff missing the field yields [], never undefined');
});

test('the big flag is MEMBERSHIP in the server set, never a client recomputation', () => {
  const model = reviewModel(SERVER_DIFF());
  const flag = (k) => model.rows.find((r) => r.key === k).big;
  assert.strictEqual(flag('Pizza Pepperoni'), true, '349→900 is in the server set');
  assert.strictEqual(flag('Queso extra'), true, '40→15 is too');
  assert.strictEqual(flag('Pizza Margherita'), false, '299→310 is not');

  // 🔴 THE DISCRIMINATOR. Hand the model a diff whose largeChangeSet DISAGREES with any client rule:
  // a tiny change the server flagged, and a huge one it did not. A client that recomputed >50% would
  // get both backwards. Only membership gets them right.
  const contrary = SERVER_DIFF();
  contrary.changed = [
    { key: 'Tiny', surface: 'item', field: 'price', old: 100, new: 101 },      // +1%, but flagged
    { key: 'Huge', surface: 'item', field: 'price', old: 100, new: 900 },      // +800%, NOT flagged
  ];
  contrary.largeChangeSet = [{ key: 'Tiny', surface: 'item', reason: 'nonpositive', old: 100, new: 101 }];
  const m2 = reviewModel(contrary);
  assert.strictEqual(m2.rows.find((r) => r.key === 'Tiny').big, true, 'the server flagged it, so it is flagged — whatever the arithmetic says');
  assert.strictEqual(m2.rows.find((r) => r.key === 'Huge').big, false, 'the server did not, so it is not');

  // membership is by KEY *and* SURFACE — an item and an extra can share a key
  const collide = {
    added: [], removed: [], renamed: [],
    changed: [{ key: 'Queso', surface: 'item', field: 'price', old: 10, new: 20 }, { key: 'Queso', surface: 'extra', field: 'price', old: 10, new: 20 }],
    largeChangeSet: [{ key: 'Queso', surface: 'extra', reason: 'swing_gt_50', old: 10, new: 20 }],
  };
  const m3 = reviewModel(collide);
  assert.strictEqual(m3.rows.find((r) => r.surface === 'item').big, false, 'the item is not flagged');
  assert.strictEqual(m3.rows.find((r) => r.surface === 'extra').big, true, '...while the extra with the SAME key is');
});

test('was and now are never swapped, and each belongs to its own row', () => {
  const model = reviewModel(SERVER_DIFF());
  const row = (k) => model.rows.find((r) => r.key === k);
  // asserted against the server's own field names, so a swap in either direction fails
  for (const c of SERVER_DIFF().changed) {
    const r = model.rows.find((x) => x.key === c.key && x.surface === c.surface && x.field === c.field);
    assert.ok(r, `a row for ${c.surface}/${c.key}`);
    assert.strictEqual(r.was, c.old, `${c.key}: was === the server's old`);
    assert.strictEqual(r.now, c.new, `${c.key}: now === the server's new`);
    assert.notStrictEqual(r.was, r.now, 'a change whose was equals its now is not a change');
  }
  // direction, stated independently of the numbers
  assert.strictEqual(row('Pizza Pepperoni').direction, 'up', '349→900 goes up');
  assert.strictEqual(row('Queso extra').direction, 'down', '40→15 goes down');
  assert.strictEqual(row('Pizza Margherita').direction, 'up', '299→310 goes up');
});

test('every server change is shown — including fields this slice cannot edit', () => {
  // The diff is against the LIVE version, so a draft can differ in ways this editor never touched
  // (someone else edited the store, or an older draft was left behind). Hiding those would let a
  // merchant approve a publish carrying changes the screen never mentioned.
  const diff = SERVER_DIFF();
  diff.changed.push({ key: 'Focaccia', surface: 'item', field: 'desc', old: 'vieja', new: 'nueva' });
  diff.added.push({ key: 'Nueva Pizza', surface: 'item', price: 500 });
  diff.removed.push({ key: 'Vieja Pizza', surface: 'item', price: 200 });
  const m = reviewModel(diff);
  assert.strictEqual(m.rows.length, 4, 'every changed entry gets a row, price or not');
  const desc = m.rows.find((r) => r.field === 'desc');
  assert.ok(desc, 'the non-price change is present');
  assert.strictEqual(desc.isPrice, false, '...and marked as not a price, so the screen can say so');
  assert.strictEqual(m.rows.filter((r) => r.isPrice).length, 3, 'the three price changes are marked as prices');
  assert.deepStrictEqual(m.added.map((a) => a.key), ['Nueva Pizza'], 'additions are surfaced');
  assert.deepStrictEqual(m.removed.map((r) => r.key), ['Vieja Pizza'], '...and removals');
  assert.strictEqual(m.total, 6, 'the total counts everything that will publish');
});

test('the review renders one row per change, with the values as text', () => {
  const root = fakeDom();
  renderReview(root, reviewModel(SERVER_DIFF()));
  const rows = byClass(root, 'prow');
  assert.strictEqual(rows.length, 3, 'one row per changed entry');

  const pep = rows.find((r) => textOf(r).includes('Pizza Pepperoni'));
  const t = textOf(pep);
  assert.ok(t.includes('349'), 'the old price is on screen');
  assert.ok(t.includes('900'), '...and the new one');
  assert.ok(t.indexOf('349') < t.indexOf('900'), 'in that order — was before now, or the sentence reverses');
  assert.ok(String(pep._class).includes('big'), 'and it carries the big flag the server asked for');

  const mar = rows.find((r) => textOf(r).includes('Pizza Margherita'));
  assert.strictEqual(String(mar._class).includes('big'), false, 'while the modest change does not');

  // nothing is written as markup: every node carrying server text used textContent
  for (const n of walk(root)) {
    assert.ok(!('innerHTML' in n && n.innerHTML !== undefined), 'no node was given innerHTML');
  }
});

test('a name that looks like markup is rendered as text, not parsed', () => {
  // A dish name is data. This screen is the one place a menu editor must not execute its own input,
  // and the name reaches it straight from a merchant-editable document.
  const diff = SERVER_DIFF();
  diff.changed = [{ key: '<img src=x onerror=alert(1)>', surface: 'item', field: 'price', old: 10, new: 20 }];
  diff.largeChangeSet = [];
  const root = fakeDom();
  renderReview(root, reviewModel(diff));
  const texts = walk(root).map((n) => n.textContent).filter(Boolean);
  assert.ok(texts.includes('<img src=x onerror=alert(1)>'), 'the name appears verbatim as TEXT');
  assert.strictEqual(walk(root).filter((n) => n.tag === 'img').length, 0, 'and no element was created from it');
});

test('an empty diff renders an honest empty state rather than a blank panel', () => {
  const empty = { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] };
  const m = reviewModel(empty);
  assert.strictEqual(m.total, 0);
  assert.deepStrictEqual(ackSetFrom(empty), []);
  const root = fakeDom();
  renderReview(root, m);
  assert.strictEqual(byClass(root, 'prow').length, 0, 'no rows');
  assert.ok(textOf(root).length > 0, 'but the panel says something — a blank screen reads as a broken one');
});

// ── Task 6 — THE SAR ATTESTATION ─────────────────────────────────────────────────────────────────
// 🔴🔴 A merchant's signature that a change to a legal tax document is theirs. Three separate things
// that keep getting conflated, and each conflation is its own defect:
//
//   THE SEAL'S ROWS come from diff.changed where field === 'price'. Every fiscal price change.
//   THE ACK SET is diff.largeChangeSet, verbatim, and may be []. A 299→310 edit is a 3.7% swing:
//     the seal lists it, the ack set is empty, and publish sends fiscalAck:true WITH
//     acknowledgedChanges: [].
//   WHETHER AN ATTESTATION IS REQUIRED is neither of those. Verified at source: publishEditedCore
//     gates on usesPlatformFactura(rid) ALONE — it never reads the diff. So a fiscal merchant needs
//     fiscalAck for ANY publish, including one that changes no price at all.
import { attestationModel, renderAttestation, canPublish, fiscalPriceChanges } from './review.js';

const MODEST = () => ({
  added: [], removed: [], renamed: [],
  changed: [{ key: 'Pizza Margherita', surface: 'item', field: 'price', old: 299, new: 310 }],
  largeChangeSet: [],                                    // 3.7% — the server flags nothing
});

test('a MODEST fiscal price change still needs the seal, with an EMPTY ack set', () => {
  // The codex NEW-HIGH, pinned. If the seal were driven by largeChangeSet this edit would show no
  // attestation, the merchant would press Publicar, and the server would refuse with
  // fiscal_ack_required — a 403 with nothing on screen to clear it.
  const m = attestationModel(MODEST(), { usesPlatformFactura: true });
  assert.strictEqual(m.needsSeal, true, 'the seal is shown');
  assert.deepStrictEqual(m.sealRows.map((r) => [r.key, r.was, r.now]), [['Pizza Margherita', 299, 310]],
    'listing the price change from diff.changed');
  assert.deepStrictEqual(m.ackSet, [], 'while the ack set stays the server largeChangeSet — empty');
  assert.strictEqual(m.needsAck, true, 'an attestation is still required');
  assert.strictEqual(canPublish(m, false), false, 'and publish is blocked until it is given');
  assert.strictEqual(canPublish(m, true), true, '...and allowed once it is');
  // what the publish will send: BOTH, and they are different things
  assert.strictEqual(m.fiscalAck, true, 'this publish must carry fiscalAck:true');
  assert.deepStrictEqual(m.ackSet, [], '...alongside acknowledgedChanges: []');
});

test('a >50% fiscal change appears in the seal AND carries a non-empty ack set', () => {
  const diff = {
    added: [], removed: [], renamed: [],
    changed: [
      { key: 'Pizza Margherita', surface: 'item', field: 'price', old: 299, new: 310 },
      { key: 'Pizza Pepperoni', surface: 'item', field: 'price', old: 349, new: 900 },
    ],
    largeChangeSet: [{ key: 'Pizza Pepperoni', surface: 'item', reason: 'swing_gt_50', old: 349, new: 900 }],
  };
  const m = attestationModel(diff, { usesPlatformFactura: true });
  assert.strictEqual(m.sealRows.length, 2, 'the seal lists BOTH price changes, not just the flagged one');
  assert.strictEqual(m.ackSet.length, 1, 'while the ack set holds only what the server flagged');
  assert.notStrictEqual(m.sealRows.length, m.ackSet.length, 'the two sets are genuinely different sizes here');
  assert.strictEqual(m.ackSet[0].reason, 'swing_gt_50', 'and the ack set is the server objects, verbatim');
});

test('🔴 the gate is the CAPABILITY FLAG, never the restaurant id', () => {
  // The two-brands trap. `rid === 'x_pizza'` is accidentally correct for every restaurant that exists
  // today, so a value assertion cannot catch it. MOVE THE FACT: a merchant with no brand meaning at
  // all, flagged fiscal by the server, must get the seal — and x_pizza itself, flagged NOT fiscal,
  // must not. A literal gets both backwards.
  const fiscalUnknownMerchant = attestationModel(MODEST(), { usesPlatformFactura: true, rid: 'merch_7' });
  assert.strictEqual(fiscalUnknownMerchant.needsSeal, true,
    'a merchant the client has never heard of gets the seal when the SERVER says it is fiscal');

  const xPizzaNotFiscal = attestationModel(MODEST(), { usesPlatformFactura: false, rid: 'x_pizza' });
  assert.strictEqual(xPizzaNotFiscal.needsSeal, false,
    'and x_pizza does NOT, when the server says it is not — the id carries no authority here');
  assert.strictEqual(xPizzaNotFiscal.fiscalAck, false, '...nor does it send a fiscal acknowledgement');

  // absent / non-boolean must NOT be read as fiscal, but must also not silently permit publishing
  for (const bad of [undefined, null, 'true', 1, {}]) {
    const m = attestationModel(MODEST(), { usesPlatformFactura: bad });
    assert.strictEqual(m.needsSeal, false, `a non-true flag (${JSON.stringify(bad)}) is not a fiscal capability`);
    assert.strictEqual(m.fiscalAck, false, '...and never sends fiscalAck');
  }
});

test('a fiscal merchant needs the attestation even when NO price changed', () => {
  // 🔴 Verified at source: publishEditedCore's fiscal gate reads usesPlatformFactura(rid) and NOTHING
  // else — not the diff, not largeChangeSet, not `changed`. The diff is against the LIVE version, so a
  // draft can legitimately differ only in a description (an older draft, another editor). Requiring
  // "≥1 price change" to show the seal would leave that publish with a 403 the screen cannot clear.
  const descOnly = {
    added: [], removed: [], renamed: [],
    changed: [{ key: 'Focaccia', surface: 'item', field: 'desc', old: 'vieja', new: 'nueva' }],
    largeChangeSet: [],
  };
  const m = attestationModel(descOnly, { usesPlatformFactura: true });
  assert.strictEqual(m.needsSeal, true, 'the seal still appears — the server will demand fiscalAck regardless');
  assert.deepStrictEqual(m.sealRows, [], 'with no price rows to list');
  assert.strictEqual(m.needsAck, true, 'and publish is still gated on it');
  assert.strictEqual(canPublish(m, false), false);
  assert.strictEqual(canPublish(m, true), true);
});

test('a NON-fiscal merchant gets a plain confirm only when the server flagged something', () => {
  const big = {
    added: [], removed: [], renamed: [],
    changed: [{ key: 'Dumpling', surface: 'item', field: 'price', old: 100, new: 900 }],
    largeChangeSet: [{ key: 'Dumpling', surface: 'item', reason: 'swing_gt_50', old: 100, new: 900 }],
  };
  const m = attestationModel(big, { usesPlatformFactura: false });
  assert.strictEqual(m.needsSeal, false, 'no SAR seal — this merchant files its own documents');
  assert.strictEqual(m.needsPlainAck, true, 'but the large change still needs confirming');
  assert.strictEqual(m.needsAck, true);
  assert.strictEqual(canPublish(m, false), false);
  assert.deepStrictEqual(m.ackSet.length, 1, 'and the ack set travels regardless');

  // ...and a modest change on a non-fiscal merchant needs nothing at all
  const m2 = attestationModel(MODEST(), { usesPlatformFactura: false });
  assert.strictEqual(m2.needsSeal, false);
  assert.strictEqual(m2.needsPlainAck, false);
  assert.strictEqual(m2.needsAck, false, 'nothing to confirm');
  assert.strictEqual(canPublish(m2, false), true, 'so publish is available immediately');
});

test('a zero price blocks publishing no matter what is acknowledged', () => {
  const zero = {
    added: [], removed: [], renamed: [],
    changed: [{ key: 'Focaccia', surface: 'item', field: 'price', old: 120, new: 0 }],
    largeChangeSet: [{ key: 'Focaccia', surface: 'item', reason: 'nonpositive', old: 120, new: 0 }],
  };
  for (const fiscal of [true, false]) {
    const m = attestationModel(zero, { usesPlatformFactura: fiscal });
    assert.strictEqual(m.hasZero, true, `a non-positive new price is detected (fiscal=${fiscal})`);
    assert.strictEqual(canPublish(m, true), false, 'and blocks publishing even when acknowledged');
    assert.strictEqual(canPublish(m, false), false, '...and when not');
  }
});

test('fiscalPriceChanges reads diff.changed, not largeChangeSet', () => {
  const diff = {
    changed: [
      { key: 'a', surface: 'item', field: 'price', old: 1, new: 2 },
      { key: 'b', surface: 'extra', field: 'price', old: 3, new: 4 },
      { key: 'c', surface: 'item', field: 'desc', old: 'x', new: 'y' },
    ],
    largeChangeSet: [{ key: 'zzz', surface: 'item', reason: 'swing_gt_50', old: 1, new: 99 }],
  };
  const rows = fiscalPriceChanges(diff);
  assert.deepStrictEqual(rows.map((r) => r.key), ['a', 'b'], 'both surfaces, price only');
  assert.ok(!rows.some((r) => r.key === 'zzz'), 'and nothing from largeChangeSet leaks in');
  assert.ok(!rows.some((r) => r.field === 'desc'), 'nor a non-price change');
});

test('the seal renders the exact rows, with one Autorizo that gates publish', () => {
  const root = fakeDom();
  const m = attestationModel(MODEST(), { usesPlatformFactura: true });
  let acked = null;
  renderAttestation(root, m, (v) => { acked = v; });
  assert.strictEqual(byClass(root, 'seal').length, 1, 'the gold seal is rendered');
  const rows = byClass(root, 'seachg');
  assert.strictEqual(rows.length, 1, 'one row per fiscal price change');
  const t = textOf(rows[0]);
  assert.ok(t.includes('Pizza Margherita') && t.includes('L299') && t.includes('L310'), 'naming the dish and both prices');
  assert.ok(t.indexOf('L299') < t.indexOf('L310'), 'was before now');

  const boxes = walk(root).filter((n) => n.tag === 'input');
  assert.strictEqual(boxes.length, 1, 'exactly ONE Autorizo — it satisfies the fiscal ack and the large-change ack together');
  assert.strictEqual(boxes[0].attrs.type || boxes[0].type, 'checkbox');
  boxes[0].checked = true;
  boxes[0].listeners.change[0]();
  assert.strictEqual(acked, true, 'ticking it reports up');

  // the copy must not name a brand — it is rendered for whichever merchant the server flagged
  const all = textOf(root);
  assert.ok(!/X\.\s*Pizza|x_pizza|La Musa|la_musa/i.test(all), 'no brand name in the attestation copy');
});

test('a non-fiscal large change renders the plain ack, not the seal', () => {
  const root = fakeDom();
  const big = {
    added: [], removed: [], renamed: [],
    changed: [{ key: 'Dumpling', surface: 'item', field: 'price', old: 100, new: 900 }],
    largeChangeSet: [{ key: 'Dumpling', surface: 'item', reason: 'swing_gt_50', old: 100, new: 900 }],
  };
  renderAttestation(root, attestationModel(big, { usesPlatformFactura: false }), () => {});
  assert.strictEqual(byClass(root, 'seal').length, 0, 'no SAR seal');
  assert.strictEqual(byClass(root, 'ack').length, 1, 'a plain confirmation instead');
  assert.ok(textOf(root).includes('Dumpling'), 'naming what needs confirming');

  // and nothing at all when nothing needs confirming
  const root2 = fakeDom();
  renderAttestation(root2, attestationModel(MODEST(), { usesPlatformFactura: false }), () => {});
  assert.strictEqual(walk(root2).filter((n) => n.tag === 'input').length, 0, 'no checkbox when nothing is required');
});

test('ONLY a literal true is an acknowledgement — nothing truthy unlocks a signature', () => {
  // Third appearance of this coercion class in the slice (Task 2's fiscalAck on the wire, Task 2b's
  // capability flag, now the local gate). It survives every time because the tests pass literal
  // booleans and `!!true === true`. What it would permit here is the worst of the three: a stray
  // truthy — a DOM event object handed to the callback, a string from a query param — unlocking
  // "Publicar" on a SAR change nobody signed.
  const m = attestationModel(MODEST(), { usesPlatformFactura: true });
  assert.strictEqual(m.needsAck, true, 'premise: this publish needs an acknowledgement');
  for (const truthy of ['yes', 'true', 1, {}, [], 'on', () => {}]) {
    assert.strictEqual(canPublish(m, truthy), false,
      `${JSON.stringify(String(truthy))} is truthy but is NOT an acknowledgement`);
  }
  for (const falsy of [undefined, null, false, 0, '']) {
    assert.strictEqual(canPublish(m, falsy), false, 'and nothing falsy is either');
  }
  assert.strictEqual(canPublish(m, true), true, 'only a literal true unlocks it');

  // the checkbox reports a real boolean, so the honest path still works end to end
  const root = fakeDom();
  let seen;
  renderAttestation(root, m, (v) => { seen = v; });
  const cb = walk(root).filter((n) => n.tag === 'input')[0];
  cb.checked = true; cb.listeners.change[0]();
  assert.strictEqual(seen, true, 'ticking reports exactly true');
  assert.strictEqual(canPublish(m, seen), true, '...which is what unlocks publish');
  cb.checked = false; cb.listeners.change[0]();
  assert.strictEqual(seen, false, 'un-ticking reports exactly false');
  assert.strictEqual(canPublish(m, seen), false, '...and re-locks it');
});
