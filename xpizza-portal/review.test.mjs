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

// ── Task 6 Step 3b — THE PUBLISH PAYLOAD, AT THE WIRE ────────────────────────────────────────────
// The attestation exists to authorize a send. Building the payload and never verifying what leaves
// the browser would mean the SAR authorization is asserted about but never observed.
//
// publishPayload is a PURE function so this can be checked in node rather than only structurally:
// app.js hands it the review state and passes the result straight to publishEdited.
import { publishPayload } from './review.js';

const reviewState = (over = {}) => ({
  rid: 'merch_7',
  editToken: 'ET-1',
  diff: MODEST(),
  attestation: attestationModel(MODEST(), { usesPlatformFactura: true }),
  acknowledged: true,
  ...over,
});

test('the payload carries the edit token, the verbatim ack set, and a strict fiscalAck', () => {
  const r = reviewState();
  const p = publishPayload(r);
  assert.strictEqual(p.rid, 'merch_7');
  assert.strictEqual(p.editToken, 'ET-1', 'the REVIEW token, which the server re-matches against the diff');
  // 🔴 the ack set travels by identity — the same array the server sent, not a copy or a rebuild
  assert.strictEqual(p.acknowledgedChanges, r.attestation.ackSet, 'the ack set is the server array itself');
  assert.deepStrictEqual(p.acknowledgedChanges, [], '...which for this modest edit is empty');
  assert.strictEqual(p.fiscalAck, true, 'and a fiscal merchant who acknowledged sends fiscalAck:true');
});

test('🔴 the modest fiscal case sends fiscalAck:true WITH acknowledgedChanges:[]', () => {
  // The codex NEW-HIGH, verified at the wire rather than in the model. These two fields answer two
  // different questions, and this is the case where they disagree.
  const p = publishPayload(reviewState());
  assert.strictEqual(p.fiscalAck, true);
  assert.deepStrictEqual(p.acknowledgedChanges, []);
  assert.ok(Array.isArray(p.acknowledgedChanges), 'an ARRAY — ackMatches refuses a non-array outright');
});

test('a >50% change sends the flagged objects verbatim alongside fiscalAck', () => {
  const diff = {
    added: [], removed: [], renamed: [],
    changed: [{ key: 'Pepperoni', surface: 'item', field: 'price', old: 349, new: 900 }],
    largeChangeSet: [{ key: 'Pepperoni', surface: 'item', reason: 'swing_gt_50', old: 349, new: 900 }],
  };
  const p = publishPayload(reviewState({ diff, attestation: attestationModel(diff, { usesPlatformFactura: true }) }));
  assert.deepStrictEqual(p.acknowledgedChanges, diff.largeChangeSet, 'the server objects, unchanged');
  assert.strictEqual(p.acknowledgedChanges[0].reason, 'swing_gt_50', 'including fields it does not read back');
  assert.strictEqual(p.fiscalAck, true);
});

test('a NON-fiscal merchant never sends a fiscal acknowledgement', () => {
  // Sending fiscalAck:true here would record an attestation nobody was asked for, on a merchant that
  // files its own documents. The server ignores it — which is exactly why the client must not send it.
  const diff = MODEST();
  const p = publishPayload(reviewState({ attestation: attestationModel(diff, { usesPlatformFactura: false }) }));
  assert.strictEqual(p.fiscalAck, false, 'no attestation for a non-fiscal merchant');
  assert.deepStrictEqual(p.acknowledgedChanges, [], 'while the ack set still travels');
});

test('fiscalAck is FALSE unless the owner actually ticked it', () => {
  // The button is disabled until acknowledged, but a disabled attribute is a UI state, not a
  // guarantee — it can be cleared from devtools. The payload states what was actually signed.
  const p = publishPayload(reviewState({ acknowledged: false }));
  assert.strictEqual(p.fiscalAck, false, 'a fiscal merchant who did not tick sends false, and the server refuses');
  for (const truthy of ['yes', 1, {}, [], 'on']) {
    assert.strictEqual(publishPayload(reviewState({ acknowledged: truthy })).fiscalAck, false,
      `${JSON.stringify(String(truthy))} is truthy but is not a signature`);
  }
  assert.strictEqual(publishPayload(reviewState({ acknowledged: true })).fiscalAck, true, 'only a literal true signs');
});

// ── Task 6 BLOCK — THE IN-FLIGHT GUARD, AND THE WIRE, BOTH COMMITTED ─────────────────────────────
// Two gaps the gate found, and they share a root: a claim that lives outside the suite does not hold
// the line.
//
//   btn.disabled = true was the only double-publish guard — a UI STATE, which is precisely what the
//   same commit argued a gate must never be. A second scripted click before the await resolves
//   re-enters and sends the SAR publish twice.
//
//   "Verified at the wire" was a one-time browser check. It proved the code worked that afternoon; it
//   could not stop app.js from later rebuilding the payload or dropping a field.
//
// createPublisher owns both, and is pure enough for node to drive it end to end: real publishPayload
// → real publishEdited → intercepted fetch, asserting the bytes.
import { createPublisher } from './review.js';
import { publishEdited } from './api.js';

function captureFetch(response = { ok: true, status: 200, json: async () => ({ versionId: 'v-42' }) }) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, method: opts.method, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
    return typeof response === 'function' ? response(sent.length) : response;
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}
// the real send, exactly as app.js wires it
const realPublisher = () => createPublisher({ publish: (p) => publishEdited({ ...p, token: async () => 'TK-secret' }) });

const fiscalReview = (acknowledged) => {
  const diff = MODEST();
  return { rid: 'x_pizza', editToken: 'ET-9', diff, attestation: attestationModel(diff, { usesPlatformFactura: true }), acknowledged };
};

test('WIRE (a): a modest fiscal publish sends fiscalAck:true AND acknowledgedChanges:[]', async () => {
  const f = captureFetch();
  try {
    const out = await realPublisher().run(fiscalReview(true));
    assert.strictEqual(out.ok, true, 'the publish went through');
    assert.strictEqual(f.sent.length, 1, 'exactly one request');
    const b = f.sent[0].body;
    assert.strictEqual(f.sent[0].method, 'POST');
    assert.strictEqual(f.sent[0].auth, 'Bearer TK-secret', 'bearer in the header');
    assert.ok(!f.sent[0].url.includes('TK-secret'), '...never in the URL');
    assert.strictEqual(b.token, 'ET-9', 'body.token is the EDIT token');
    assert.strictEqual(b.fiscalAck, true, '🔴 fiscalAck:true');
    assert.deepStrictEqual(b.acknowledgedChanges, [], '🔴 WITH an empty ack set — the two answer different questions');
    assert.ok(Array.isArray(b.acknowledgedChanges), 'and it is an array, which ackMatches requires');
  } finally { f.restore(); }
});

test('WIRE (b): an UN-TICKED fiscal publish never leaves the browser', async () => {
  const f = captureFetch();
  try {
    const out = await realPublisher().run(fiscalReview(false));
    assert.strictEqual(out.ok, undefined, 'it did not publish');
    assert.strictEqual(out.skipped, 'not_ready', '...and says why');
    assert.strictEqual(f.sent.length, 0, '🔴 ZERO requests — an unsigned attestation is not sent at all');
  } finally { f.restore(); }
});

test('WIRE (c): a non-fiscal large change sends the server objects verbatim, fiscalAck false', async () => {
  const diff = {
    added: [], removed: [], renamed: [],
    changed: [{ key: 'Dumpling', surface: 'item', field: 'price', old: 100, new: 900 }],
    largeChangeSet: [{ key: 'Dumpling', surface: 'item', reason: 'swing_gt_50', old: 100, new: 900 }],
  };
  const f = captureFetch();
  try {
    await realPublisher().run({
      rid: 'la_musa', editToken: 'ET-7', diff,
      attestation: attestationModel(diff, { usesPlatformFactura: false }), acknowledged: true,
    });
    const b = f.sent[0].body;
    assert.strictEqual(b.fiscalAck, false, 'no fiscal attestation for a merchant that files its own documents');
    assert.deepStrictEqual(b.acknowledgedChanges, diff.largeChangeSet, 'the server objects, unchanged');
    assert.strictEqual(b.acknowledgedChanges[0].reason, 'swing_gt_50', 'including the field the server does not read back');
  } finally { f.restore(); }
});

test('🔴 two synchronous clicks send exactly ONE request', async () => {
  // The double-publish race. `disabled` is set on the element and cleared by anything that can reach
  // the DOM; the lock is a module value that a second entry cannot get past, and it is taken BEFORE
  // the await so there is no window between the check and the send.
  const f = captureFetch();
  try {
    const p = realPublisher();
    const r = fiscalReview(true);
    const [a, b] = await Promise.all([p.run(r), p.run(r)]);   // both dispatched before either resolves
    assert.strictEqual(f.sent.length, 1, 'ONE publish reached the server, not two');
    const outcomes = [a, b].map((x) => (x.ok ? 'ok' : x.skipped));
    assert.deepStrictEqual(outcomes.sort(), ['in_flight', 'ok'], 'one published, one was refused as already in flight');
  } finally { f.restore(); }
});

test('a SUCCESS stays latched; a FAILURE releases so the merchant can retry', async () => {
  // Latching after success is deliberate: the reviewed set is published, the token is spent, and a
  // second press must not re-send. A failure is the opposite — an outage must not strand the merchant
  // with a dead button.
  const ok = captureFetch();
  try {
    const p = realPublisher();
    await p.run(fiscalReview(true));
    const again = await p.run(fiscalReview(true));
    // 'spent', not 'in_flight' — the request settled, so the wire is free; what refuses the second
    // press is that this reviewed set's TOKEN is used. Splitting those two states is what stopped
    // reset() from releasing a live request.
    assert.strictEqual(again.skipped, 'spent', 'a second publish of the same reviewed set is refused');
    assert.strictEqual(ok.sent.length, 1, 'and sends nothing');
  } finally { ok.restore(); }

  const bad = captureFetch({ ok: false, status: 503, json: async () => ({ error: 'store_unavailable' }) });
  try {
    const p = realPublisher();
    await assert.rejects(() => p.run(fiscalReview(true)), (e) => e.code === 'store_unavailable');
    assert.strictEqual(bad.sent.length, 1, 'the failed attempt was sent');
    // the lock released, so a retry is possible
    await assert.rejects(() => p.run(fiscalReview(true)), (e) => e.code === 'store_unavailable');
    assert.strictEqual(bad.sent.length, 2, 'and the retry really went out — a failure must not strand the merchant');
  } finally { bad.restore(); }

  // A NEW reviewed set publishes with no reset call at all — its token is what makes it new. That is
  // the point of the per-token design: there is no release path to get wrong.
  const third = captureFetch();
  try {
    const p = realPublisher();
    await p.run(fiscalReview(true));
    await p.run({ ...fiscalReview(true), editToken: 'ET-NEXT' });
    assert.strictEqual(third.sent.length, 2, 'a new reviewed set publishes without any reset');
  } finally { third.restore(); }
});

test('the publisher refuses a review that is missing or not ready, without touching the network', async () => {
  const f = captureFetch();
  try {
    const p = realPublisher();
    for (const bad of [null, undefined, {}, { attestation: null }]) {
      const out = await p.run(bad);
      assert.strictEqual(out.skipped, 'not_ready', `${JSON.stringify(bad)} is refused`);
    }
    // a zero price blocks it even when acknowledged
    const zero = {
      added: [], removed: [], renamed: [],
      changed: [{ key: 'Focaccia', surface: 'item', field: 'price', old: 120, new: 0 }],
      largeChangeSet: [{ key: 'Focaccia', surface: 'item', reason: 'nonpositive', old: 120, new: 0 }],
    };
    const out = await p.run({ rid: 'x', editToken: 'E', diff: zero, attestation: attestationModel(zero, { usesPlatformFactura: true }), acknowledged: true });
    assert.strictEqual(out.skipped, 'not_ready', 'a zero price is refused even when signed');
    assert.strictEqual(f.sent.length, 0, 'and nothing reached the network in any of these cases');
  } finally { f.restore(); }
});

// ── Task 7 — THE PUBLISH STATE MACHINE ───────────────────────────────────────────────────────────
// Every way a publish can end has to land somewhere a merchant can act on. The failure this guards
// against is not a wrong panel — it is NO panel: an unhandled code falling through to a toast, or to
// nothing, on the screen that decides whether their prices changed.
import { outcomeFor, renderOutcome, receiptFor, renderReceipt, PUBLISH_ACTIONS } from './review.js';

const SIX = ['stale_edit', 'edit_superseded', 'large_change_unconfirmed', 'not_owner', 'fiscal_ack_required', 'store_unavailable'];
// STATUS IS PART OF THE SHAPE. api.js always sets one, and outcomeFor now uses it to tell a server
// ANSWER (pre-commit) from a lost connection (uncertain). A fixture without it models a request that
// never got a reply — which is a different case, not a simpler one.
const err = (code, status = 400) => Object.assign(new Error(code), { code, status });

test('each of the six primary codes gets its OWN designed panel', () => {
  const outs = SIX.map((c) => outcomeFor(err(c)));
  for (const [i, o] of outs.entries()) {
    assert.strictEqual(o.code, SIX[i], `${SIX[i]} keeps its code`);
    assert.ok(o.title && o.title.length > 3, `${SIX[i]} has a title`);
    assert.ok(o.detail && o.detail.length > 30, `${SIX[i]} explains what happened and what to do`);
    assert.ok(o.action && o.action.label, `${SIX[i]} offers an action`);
    assert.strictEqual(o.generic, false, `${SIX[i]} is FIRST-CLASS, not the fallback`);
  }
  // genuinely distinct, not six labels on one panel
  assert.strictEqual(new Set(outs.map((o) => o.title)).size, 6, 'six distinct titles');
  assert.strictEqual(new Set(outs.map((o) => o.detail)).size, 6, 'six distinct explanations');

  // not_owner is a DESIGNED screen, not the generic one wearing a code
  const owner = outcomeFor(err('not_owner', 403));
  const generic = outcomeFor(err('publish_failed', 500));
  assert.notStrictEqual(owner.title, generic.title, 'not_owner is not the generic panel');
  assert.ok(/propietario|dueñ/i.test(owner.title + owner.detail), '...and says who can publish a fiscal change');
});

test('🔴 EVERY other server error lands on the generic durable panel — never nothing', () => {
  // codex #1. The list is the rest of the handler's response surface, plus shapes that are not codes
  // at all. None may fall through.
  const others = ['bad_source', 'bad_request', 'invalid_source', 'source_missing', 'live_version_unavailable',
    'draft_build_failed', 'publish_failed', 'not_authorized', 'error', 'something_new_next_year'];
  for (const c of others) {
    const o = outcomeFor(err(c));
    assert.ok(o, `${c} produces a panel`);
    assert.strictEqual(o.generic, true, `${c} routes to the generic durable panel`);
    assert.ok(o.title && o.detail, `${c} still says something`);
    assert.ok(o.action && o.action.label, `${c} still offers a way forward`);
  }
  // and the shapes that are not typed errors at all
  for (const weird of [new Error('boom'), { code: null }, {}, null, undefined, 'a string', 0]) {
    const o = outcomeFor(weird);
    assert.ok(o && o.title && o.action, `${JSON.stringify(String(weird))} still yields a durable panel`);
    assert.strictEqual(o.generic, true);
  }
  // the durable panel must offer retry AND reload — "durable" means the merchant is never stuck
  const g = outcomeFor(err('publish_failed'));
  assert.ok(['retry', 'reload'].includes(g.action.id), 'the generic action is actionable, not a dead end');
});

test('🔴 edit_superseded re-reviews — it must NEVER retry publishEdited with the stale token', () => {
  // codex #6. The token is bound to a diff that no longer describes reality. Retrying the publish
  // would either fail again or, worse, succeed against state nobody reviewed.
  const o = outcomeFor(err('edit_superseded', 409));
  assert.strictEqual(o.action.id, PUBLISH_ACTIONS.REREVIEW, 'the action is to review again');
  assert.notStrictEqual(o.action.id, PUBLISH_ACTIONS.RETRY, '...and explicitly NOT a retry');
  assert.ok(/revis/i.test(o.action.label), 'the button says so');
  // no other panel may claim rereview by accident, and none of the six may offer a bare publish retry
  const rereviewers = SIX.filter((c) => outcomeFor(err(c)).action.id === PUBLISH_ACTIONS.REREVIEW);
  assert.deepStrictEqual(rereviewers, ['edit_superseded'], 'exactly one code re-reviews');
  // stale_edit is the sibling trap: the DRAFT moved, so it reloads rather than re-reviewing
  assert.strictEqual(outcomeFor(err('stale_edit')).action.id, PUBLISH_ACTIONS.RELOAD,
    'stale_edit reloads the draft — a different failure with a different fix');
});

test('the two acknowledgement codes send the merchant back to the review, not to a retry', () => {
  // large_change_unconfirmed and fiscal_ack_required both mean "something on the review screen was
  // not ticked". Retrying the same payload would repeat the same refusal.
  for (const c of ['large_change_unconfirmed', 'fiscal_ack_required']) {
    const o = outcomeFor(err(c, 403));
    assert.strictEqual(o.action.id, PUBLISH_ACTIONS.BACK, `${c} returns to the review to confirm`);
    assert.notStrictEqual(o.action.id, PUBLISH_ACTIONS.RETRY, `${c} does not blindly retry`);
  }
  // store_unavailable is the one that legitimately retries the same payload
  assert.strictEqual(outcomeFor(err('store_unavailable', 503)).action.id, PUBLISH_ACTIONS.RETRY,
    'an outage retries — nothing about the edit was wrong');
});

test('the receipt is built from the CAPTURED review, because the draft is already discarded', () => {
  // The forward note from Task 6: on success app.js discards the draft and repaints, so by the time
  // the receipt renders there is nothing pending to read. Reading the draft would show zero changes.
  const captured = { diff: SERVER_DIFF() };
  const r = receiptFor({ versionId: 'v-9a1e88301' }, captured);
  assert.strictEqual(r.versionId, 'v-9a1e88301', 'the new version id');
  assert.strictEqual(r.count, 3, 'and how many changes went live, from the captured diff');
  assert.deepStrictEqual(r.rows.map((x) => x.key).sort(), ['Pizza Margherita', 'Pizza Pepperoni', 'Queso extra']);
  // a response with no version id is still a successful publish — say so without inventing one
  const r2 = receiptFor({}, captured);
  assert.strictEqual(r2.versionId, null, 'no id is null, never a fabricated string');
  assert.strictEqual(r2.count, 3, 'and the count still comes from what was published');
  // and a missing capture does not throw on the success path
  const r3 = receiptFor({ versionId: 'v1' }, null);
  assert.strictEqual(r3.count, 0);
  assert.deepStrictEqual(r3.rows, []);
});

test('the receipt and the panels render as text, with an action the merchant can press', () => {
  const root = fakeDom();
  renderReceipt(root, receiptFor({ versionId: 'v-42' }, { diff: SERVER_DIFF() }));
  assert.strictEqual(byClass(root, 'receipt').length, 1, 'the durable receipt');
  assert.strictEqual(byClass(root, 'rcheck').length, 1, '...with its confirmation mark');
  const t = textOf(root);
  assert.ok(t.includes('v-42'), 'naming the version that went live');
  assert.ok(/3/.test(t), '...and how many changes it carried');

  const root2 = fakeDom();
  let fired = null;
  renderOutcome(root2, outcomeFor(err('store_unavailable', 503)), (id) => { fired = id; });
  assert.strictEqual(byClass(root2, 'conflict').length, 1, 'a conflict panel');
  assert.ok(byClass(root2, 'cicon').length === 1, '...with an icon slot');
  const btn = walk(root2).find((n) => n.tag === 'button');
  assert.ok(btn, 'and a real button');
  btn.listeners.click[0]();
  assert.strictEqual(fired, PUBLISH_ACTIONS.RETRY, 'pressing it reports the action id — the caller decides what that means');

  // no server string is ever markup
  const root3 = fakeDom();
  renderOutcome(root3, outcomeFor(err('<img src=x onerror=alert(1)>')), () => {});
  assert.strictEqual(walk(root3).filter((n) => n.tag === 'img').length, 0, 'a hostile code creates no element');
});

test('no Historial button ships — there is no such screen and no rollback endpoint', () => {
  // The mock offers "Ver en Historial" wired to alert(). Neither a Historial view nor an exported
  // rollback endpoint exists, so shipping the button would be a dead control on the receipt — the
  // exact class this slice has been guarding against since the 2b-2a switcher.
  const root = fakeDom();
  renderReceipt(root, receiptFor({ versionId: 'v-42' }, { diff: SERVER_DIFF() }));
  assert.ok(!/historial/i.test(textOf(root)), 'the receipt does not offer a screen that does not exist');
});

test('the receipt and the panels actually draw their icons', () => {
  // `.rcheck svg` is animated with a stroke-dasharray draw-in, and `.cicon svg` is the panel's tone.
  // Without the SVG both render as an empty circle — a confirmation mark that confirms nothing. And
  // createElement would silently produce an inert HTMLUnknownElement, so this asserts the namespaced
  // element and a real path.
  const root = fakeDom();
  renderReceipt(root, receiptFor({ versionId: 'v1' }, { diff: SERVER_DIFF() }));
  const tick = byClass(root, 'rcheck')[0];
  const svg = walk(tick).find((n) => n.tag === 'svg');
  assert.ok(svg, 'the confirmation mark has an svg');
  assert.ok(walk(svg).some((n) => n.tag === 'path' && n.attrs.d), '...with a real path');

  for (const code of ['store_unavailable', 'edit_superseded', 'publish_failed']) {
    const r2 = fakeDom();
    renderOutcome(r2, outcomeFor(err(code)), () => {});
    const ic = byClass(r2, 'cicon')[0];
    assert.ok(walk(ic).some((n) => n.tag === 'svg'), `${code}'s panel draws its icon`);
  }
});

test('receipt counts EVERY surface — an added item is a change', () => {
  // Not reachable while the editor is price-only, which is exactly why it would ship silently: a
  // future add/remove slice would render "estos 0 cambios" on a real publish.
  const addOnly = { changed: [], added: [{ key: 'Nueva Pizza', surface: 'item', price: 500 }], removed: [], renamed: [] };
  const r = receiptFor({ versionId: 'v1' }, { diff: addOnly });
  assert.strictEqual(r.count, 1, 'an addition alone counts as a change');
  assert.ok(r.count >= 1, '...so the receipt never says zero on a real publish');

  const mixed = {
    changed: [{ key: 'a', surface: 'item', field: 'price', old: 1, new: 2 }],
    added: [{ key: 'b', surface: 'item', price: 5 }],
    removed: [{ key: 'c', surface: 'item', price: 9 }],
    renamed: [{ from: 'd', to: 'e', surface: 'item' }],
  };
  assert.strictEqual(receiptFor({}, { diff: mixed }).count, 4, 'every surface is counted');
  // malformed arrays must not throw on the success path
  assert.strictEqual(receiptFor({}, { diff: { changed: null, added: 'x' } }).count, 0, 'non-arrays count as nothing rather than throwing');
});

// ── Closing-gate #2 + #4 ─────────────────────────────────────────────────────────────────────────
test('🔴 an outcome carries the OPERATION that failed, so RETRY redoes the right one', () => {
  // editCatalog and publishEdited share most of their error surface. Routing both through the same
  // panels was right; letting both RETRY buttons mean "publish" was not. A failed SAVE retried as a
  // PUBLISH would push a reviewed-and-acknowledged set the merchant had already moved on from.
  const e = Object.assign(new Error('store_unavailable'), { code: 'store_unavailable' });
  assert.strictEqual(outcomeFor(e, 'edit').op, 'edit', 'an editCatalog failure is marked as an edit');
  assert.strictEqual(outcomeFor(e, 'publish').op, 'publish', '...and a publishEdited failure as a publish');
  assert.strictEqual(outcomeFor(e).op, 'publish', 'the default stays publish — the historical caller');
  // the op rides on every panel, not just the retryable ones
  for (const code of ['stale_edit', 'edit_superseded', 'not_owner', 'weird_code']) {
    const o = outcomeFor(Object.assign(new Error(code), { code, status: 503 }), 'edit');
    assert.strictEqual(o.op, 'edit', `${code} carries the operation`);
  }
});

test('🔴 uncertainty is about TRANSPORT, not about the error code', () => {
  // Refined by the closing gate, and the refinement matters. My first version of this rule keyed on
  // the CODE — so a coded 503 store_unavailable got "verify your live menu". But that code is the
  // server's ANSWER: it read the store, failed, and refused before writing anything. Sending a
  // merchant to verify a menu we know is untouched is its own false alarm.
  //
  // The discriminator is whether an answer arrived at all.
  const answered = (code, status) => Object.assign(new Error(code), { code, status });
  const lost = () => Object.assign(new Error('Unavailable'), { code: null, status: 0, kind: 'Unavailable' });

  const u = outcomeFor(lost(), 'publish');
  assert.ok(/verific/i.test(u.detail), 'a publish whose answer never arrived says the result is unknown');
  assert.ok(/no sabemos|no pudimos confirmar/i.test(u.detail), '...in those words, not as a guess either way');

  for (const [code, status] of [['store_unavailable', 503], ['publish_failed', 500], ['bad_request', 400],
                                 ['not_owner', 403], ['fiscal_ack_required', 403], ['stale_edit', 409]]) {
    const o = outcomeFor(answered(code, status), 'publish');
    assert.ok(!/verific/i.test(o.detail),
      `${code} (${status}) is a server ANSWER — it refused pre-commit, so no verify prompt`);
    assert.ok(/no publicamos|nada cambió|borrador/i.test(o.detail), `${code} says plainly that nothing went live`);
  }
});

test('an EDIT failure describes saving, not publishing', () => {
  const o = outcomeFor(Object.assign(new Error('store_unavailable'), { code: 'store_unavailable', status: 503 }), 'edit');
  assert.strictEqual(o.op, 'edit');
  assert.ok(!/publicar|publicamos/i.test(o.title), 'the title does not claim a publish was attempted');
});

test('🔴 WHOLE FLOW: a published price stays published, and does not ride into the next diff', async () => {
  // The reversion defect, end to end through the real publisher. Publish 299→310, then make an
  // UNRELATED edit and check what the next review would carry. Before the fix the draft had been
  // reset to the pre-edit prices, so Pizza=299 rode along and the next publish silently reverted the
  // price that had just gone live — the merchant would have had to publish twice for one change.
  const { createDraft, setItemPrice, pendingChanges, pendingCount, commit, draftSource } = await import('./editor.js');
  const SRC = () => ({
    restaurant_id: 'x_pizza', schema_version: 1,
    items: [{ key: 'Pizza', price: 299, display: { id: 1, cat: 'c', name: 'Pizza', price: 299 } },
            { key: 'Agua', price: 20, display: { id: 2, cat: 'c', name: 'Agua', price: 20 } }],
    extras: [], structure: { schema_version: 2, item_order: ['Pizza', 'Agua'], categories: [{ id: 'c' }] },
  });
  const draft = createDraft(SRC());
  setItemPrice(draft, 'Pizza', '310');

  const diff = { added: [], removed: [], renamed: [],
    changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] };
  const review = { rid: 'x_pizza', editToken: 'ET-1', diff,
    attestation: attestationModel(diff, { usesPlatformFactura: true }), acknowledged: true };

  const f = captureFetch();
  try {
    const out = await realPublisher().run(review);
    assert.strictEqual(out.ok, true, 'the publish succeeded');
    assert.strictEqual(f.sent[0].body.fiscalAck, true);
  } finally { f.restore(); }

  // what app.js does on success
  commit(draft);

  assert.strictEqual(pendingCount(draft), 0, 'nothing pending — the publish IS the baseline');
  assert.strictEqual(draftSource(draft).items[0].price, 310, '🔴 the editor shows the PUBLISHED price, not the old one');

  // an unrelated edit later
  setItemPrice(draft, 'Agua', '25');
  const next = pendingChanges(draft);
  assert.deepStrictEqual(next.map((c) => c.key), ['Agua'], 'only the new edit is pending');
  assert.ok(!next.some((c) => c.key === 'Pizza'),
    '🔴 Pizza is NOT in the next diff — carrying 310→299 there would revert the published price');
  assert.strictEqual(next[0].from, 20, 'and the unrelated change measures from its own published value');
});

// ── Closing re-gate: the four targeted fixes ─────────────────────────────────────────────────────
test('🔴 reset() clears the SPENT latch but never releases a request on the wire', async () => {
  // The T6 regression. ONE boolean was doing two jobs — "a request is in flight" and "this reviewed
  // set has been published" — and reset() cleared both. So an auth change or a re-review mid-flight
  // re-opened the double-publish window T6 closed.
  //
  // Asserted on SYNCHRONOUS evidence (how many requests reached the wire) rather than by awaiting the
  // second call: on the broken code that call never settles, and the test would HANG instead of
  // failing. A test that hangs reports nothing.
  let release;
  const sent = [];
  // Only the FIRST call is held open; later ones resolve immediately, or awaiting the third would
  // hang on a promise nothing ever settles — a test that hangs reports nothing.
  const p = createPublisher({ publish: (payload) => {
    sent.push(payload);
    if (sent.length === 1) return new Promise((r) => { release = r; });
    return Promise.resolve({ versionId: `v${sent.length}` });
  } });
  const review = () => ({ rid: 'r', editToken: 'E', diff: MODEST(),
    attestation: attestationModel(MODEST(), { usesPlatformFactura: true }), acknowledged: true });

  const first = p.run(review());
  assert.strictEqual(sent.length, 1, 'one request went out');
  const second = p.run(review());             // a second press while the first is on the wire
  await Promise.resolve();                    // let a synchronous refusal settle
  assert.strictEqual(sent.length, 1, '🔴 nothing second reached the wire — reset must not release a live request');
  const outcome = await Promise.race([second, new Promise((r) => setTimeout(() => r({ skipped: 'HUNG' }), 50))]);
  assert.strictEqual(outcome.skipped, 'in_flight', 'the second attempt is refused as in-flight');

  release({ versionId: 'v1' });
  await first;
  // once it has settled, a DIFFERENT reviewed set publishes — no reset required, because the token
  // is what makes it different
  const third = await p.run({ ...review(), editToken: 'ET-OTHER' });
  assert.strictEqual(third.ok, true, 'a new reviewed set publishes after the first settles');
  assert.strictEqual(sent.length, 2, 'and it really went out');
});

test('a spent review stays spent without reset, even after settling', () => {
  const p = createPublisher({ publish: async () => ({ versionId: 'v1' }) });
  const review = () => ({ rid: 'r', editToken: 'E', diff: MODEST(),
    attestation: attestationModel(MODEST(), { usesPlatformFactura: true }), acknowledged: true });
  return p.run(review()).then((a) => {
    assert.strictEqual(a.ok, true);
    return p.run(review());
  }).then((b) => {
    assert.strictEqual(b.skipped, 'spent', 'the same reviewed set cannot be published twice');
  });
});

test('🔴 copy branches on (operation) x (did the server ANSWER?)', () => {
  // Only a PUBLISH whose transport was uncertain may say the change might have gone live. A server
  // that ANSWERED — even with 503 store_unavailable, which it returns after failing to read the store —
  // has refused pre-commit, and saying "verify your live menu" there is a false alarm. An EDIT never
  // publishes, so it can never claim one might have.
  const answered = (code, status) => Object.assign(new Error(code), { code, status });
  const transport = () => Object.assign(new Error('Unavailable'), { code: null, status: 0, kind: 'Unavailable' });

  // publish + transport uncertainty → the only case that may say "verify"
  const u = outcomeFor(transport(), 'publish');
  assert.ok(/verific/i.test(u.detail), 'a publish whose answer never arrived tells the merchant to verify');

  // publish + the server ANSWERED → pre-commit, must NOT send them to verify
  for (const [code, status] of [['store_unavailable', 503], ['bad_request', 400], ['publish_failed', 500]]) {
    const o = outcomeFor(answered(code, status), 'publish');
    assert.ok(!/verific/i.test(o.detail), `${code} (${status}) is a server ANSWER — nothing committed, so no verify prompt`);
  }
  // edit, either way → never claims a publish
  for (const e of [transport(), answered('store_unavailable', 503), answered('bad_request', 400)]) {
    const o = outcomeFor(e, 'edit');
    assert.ok(!/public|publicar|en vivo/i.test(o.detail), 'an edit failure never mentions publishing — it never attempted one');
    assert.ok(!/verific/i.test(o.detail), '...and never sends the merchant to verify a live menu it did not touch');
  }
});

test('🔴 spent is per-REVIEW: a new review is never locked out by an older one settling', () => {
  // Availability on the money path. `spent` was a global boolean: publish A goes on the wire, the
  // merchant opens review B (reset clears the flag), then A settles and sets it again — and B, which
  // never published anything, is refused as 'spent'. The merchant cannot publish at all until they
  // reload.
  //
  // Binding it to the TOKEN makes the question answerable: "has THIS reviewed set been published?"
  let releaseA;
  const sent = [];
  const p = createPublisher({ publish: (payload) => {
    sent.push(payload);
    if (sent.length === 1) return new Promise((r) => { releaseA = r; });
    return Promise.resolve({ versionId: `v${sent.length}` });
  } });
  const mk = (editToken) => ({ rid: 'r', editToken, diff: MODEST(),
    attestation: attestationModel(MODEST(), { usesPlatformFactura: true }), acknowledged: true });

  const a = p.run(mk('ET-A'));                 // on the wire
  // no reset needed: review B carries a different token and is free by construction
  return Promise.resolve().then(() => releaseA({ versionId: 'vA' }))
    .then(() => a)
    .then(() => p.run(mk('ET-B')))              // a genuinely different reviewed set
    .then((out) => {
      assert.strictEqual(out.ok, true, '🔴 review B publishes — it was never published before');
      assert.strictEqual(sent.length, 2, 'and it really went out');
      // ...while re-pressing A's own set is still refused
      return p.run(mk('ET-A'));
    })
    .then((again) => {
      assert.strictEqual(again.skipped, 'spent', "A's own token stays spent — that set really did publish");
      assert.strictEqual(sent.length, 2, 'and nothing re-sent');
    });
});

test('🔴 an EMPTY diff attests to nothing and publishes nothing', () => {
  // Reachable only since #7-B: the review can now be opened on a draft that turns out to equal live.
  // The desc-only case above proves the seal must NOT be keyed to price changes — but "some change,
  // no price change" and "no change at all" are different facts, and this is the second one.
  //
  // 🔴 Publishing an empty diff would mint an immutable version, flip active_version, and — on a
  // fiscal merchant — record a SAR attestation against zero changes. A signature for nothing is the
  // same class as a signature for someone else's changes: it makes the fiscal record say something
  // untrue. Refused before any signature is collected.
  const EMPTY = { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] };
  for (const usesPlatformFactura of [true, false]) {
    const m = attestationModel(EMPTY, { usesPlatformFactura });
    assert.strictEqual(m.hasNothing, true, `nothing to publish (fiscal=${usesPlatformFactura})`);
    assert.strictEqual(m.needsSeal, false, 'no seal is raised for zero changes');
    assert.strictEqual(m.needsAck, false, 'and no acknowledgement is asked for');
    assert.strictEqual(canPublish(m, true), false,
      '🔴 and it cannot be published even by a merchant who checked the box');
    assert.strictEqual(canPublish(m, false), false, 'nor by one who did not');
  }

  // NON-VACUITY: the same model with one real change is still publishable, so `hasNothing` is not
  // simply refusing everything.
  const one = attestationModel({ added: [], removed: [], renamed: [], largeChangeSet: [],
    changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }] }, { usesPlatformFactura: false });
  assert.strictEqual(one.hasNothing, false, 'one change is not nothing');
  assert.strictEqual(canPublish(one, false), true, 'and it publishes');
});
