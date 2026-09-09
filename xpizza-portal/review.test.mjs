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
      append: (...cs) => n.children.push(...cs),
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
