// Portal 1D · D1 — the browser strip: behaviour + copy integrity.
// Run: node --test xpizza-orders/form-identity-strip.copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadForm, closeAll, BRAND } from '../form-harness.mjs';
const { stripIdentity, legacyCartForSig, IDENTITY_FIELDS } = createRequire(import.meta.url)('./form-identity-strip.js');

/* THE SERVED BODY, BUILT FROM THE PAGE'S OWN LIVE STATE AND THEN OVERLAID. A hand-composed body fails
   la_musa's refresh validator for reasons that have nothing to do with identity — it cross-references
   categories, and variant blocks against the variants currently retained — so the body here is the one
   the page already holds (BRAND[dir].menu, the same source every other runtime suite uses), with ids
   laid on top exactly as the D1 overlay lays them on the served projection. */
function servedBodyFor(dir, w) {
  const body = BRAND[dir].menu(w);
  body.dishes = body.dishes.map((d) => ({ ...d, dish_id: `ID_dish_${d.id}` }));
  body.extras = body.extras.map((e) => ({ ...e, extra_id: `ID_extra_${e.id}` }));
  // Non-vacuity at the source: if the fixture ever stops carrying ids, every assertion downstream
  // passes for the wrong reason.
  assert.ok(body.dishes.length > 0 && body.dishes.every((d) => d.dish_id), `${dir}: dishes must arrive carrying identity`);
  assert.ok(body.extras.length > 0 && body.extras.every((e) => e.extra_id), `${dir}: extras must arrive carrying identity`);
  return body;
}

test('🔴 the catalog id never survives into a browser working record', () => {
  /* The cart holds whole records and serializes them into the order, so an id that survives this
     function reaches the order payload, the redemption canonical and the quote fingerprint. A field
     inside a fingerprint is not shadow — it would make a pre-backfill and a post-backfill client
     disagree about the same cart. */
  const served = [
    { id: 2, name: 'Carnivora', price: 340, dish_id: 'ABC1234567' },
    { id: 'e1', name: 'Salsa Roja', price: 25, extra_id: 'XYZ7654321' },
    { id: 'dimsum_01', name: 'Wonton', price: 180, dish_id: 'dimsum_01' },
  ];
  const out = stripIdentity(served);
  for (const rec of out) {
    for (const f of IDENTITY_FIELDS) {
      assert.ok(!Object.prototype.hasOwnProperty.call(rec, f),
        `🔴 ${f} survived into a browser record: ${JSON.stringify(rec)}`);
    }
  }
  // …and NOTHING else moved. A strip that also dropped a price would be a far worse bug.
  assert.deepStrictEqual(out.map((r) => [r.id, r.name, r.price]), served.map((r) => [r.id, r.name, r.price]),
    'every other field is preserved exactly');
  assert.ok(served[0].dish_id, 'the input is not mutated — a served body that has been edited no longer matches its etag');
});

test('a record with nothing to strip is passed through untouched', () => {
  const clean = [{ id: 1, name: 'Plain' }];
  const out = stripIdentity(clean);
  assert.strictEqual(out[0], clean[0], 'same reference — no needless copying');
});

test('malformed input is survived, not crashed into', () => {
  // This runs at form load. A throw here is a blank page.
  for (const bad of [null, undefined, 'str', 42, {}]) {
    assert.strictEqual(stripIdentity(bad), bad, `${JSON.stringify(bad)} passes through`);
  }
  assert.deepStrictEqual(stripIdentity([null, 3, { dish_id: 'x', a: 1 }]), [null, 3, { a: 1 }],
    'a ragged array strips what it can and keeps the rest');
});

test('the la_musa copy is byte-identical to the canonical one', () => {
  const canonical = readFileSync(new URL('./form-identity-strip.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../la-musa-orders/form-identity-strip.js', import.meta.url), 'utf8');
  assert.strictEqual(copy, canonical,
    'la-musa-orders/form-identity-strip.js has drifted — copy xpizza-orders/form-identity-strip.js over it');
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code), 'no ESM syntax');
  assert.ok(/module\.exports/.test(code) && /window\.stripIdentity/.test(code), '…and it publishes to both worlds');
});

test('🔴 legacyCartForSig is DEEP — a nested extra_id is stripped too', () => {
  /* The trap this function exists for. stripIdentity removes a record's dish_id and stops there,
     because in D1 the records it strips have no nested extras. A cart LINE does, and a nested
     extra_id shifts the three client signatures exactly as a dish_id does. A shallow projection here
     would pass a dish-only test and leave the extras half of the hazard live. */
  const line = { name: 'Carnivora', qty: 2, price: 340, subtotal: 680,
    extras: [{ instance: 0, name: 'Salsa Roja', price: 25, extra_id: 'XYZ7654321' }],
    extrasTotal: 25, dish_id: 'ABC1234567' };
  const out = legacyCartForSig([line]);
  assert.ok(!('dish_id' in out[0]), '🔴 the dish id is gone');
  assert.ok(!('extra_id' in out[0].extras[0]), '🔴 …and so is the NESTED extra id — the shallow-strip trap');
  // …and a SHALLOW strip would not have done that, which is why this is a separate function.
  assert.ok('extra_id' in stripIdentity([line])[0].extras[0],
    '🔴 non-vacuity: stripIdentity really is shallow here — reusing it would have left the nested id in');
});

test('🔴 the projection is byte-identical to what a pre-D2 client emitted', () => {
  /* These signatures are JSON.stringify output, so key ORDER is part of the value. "Same fields" is
     not the claim — "same string" is, because that is what makes an id appearing a no-op rather than
     a token that fails to attach. */
  const withIds = [{ name: 'Carnivora', qty: 2, price: 340, subtotal: 680,
    extras: [{ instance: 0, name: 'Salsa Roja', price: 25, extra_id: 'E1' }], extrasTotal: 25, dish_id: 'D1' }];
  const legacy = [{ name: 'Carnivora', qty: 2, price: 340, subtotal: 680,
    extras: [{ instance: 0, name: 'Salsa Roja', price: 25 }], extrasTotal: 25 }];
  assert.strictEqual(JSON.stringify(legacyCartForSig(withIds)), JSON.stringify(legacy),
    '🔴 the projected cart must serialize byte-identically to a pre-D2 cart');
  // la_musa's shape too, where `id` is the load-bearing legacy slug and must SURVIVE.
  const lm = [{ id: 'dimsum_01', name: 'Wonton', cat: 'dim_sum', qty: 1, price: 223, subtotal: 223,
    extras: [{ id: 'rice_white', name: 'Arroz', price: 45, qty: 1, extra_id: 'rice_white' }], extrasTotal: 45, dish_id: 'dimsum_01' }];
  const lmOut = legacyCartForSig(lm)[0];
  assert.strictEqual(lmOut.id, 'dimsum_01', '🔴 la_musa\'s legacy SLUG id survives — it is not the identity field');
  assert.strictEqual(lmOut.extras[0].id, 'rice_white', '🔴 …and the option\'s slug id survives too');
  assert.ok(!('dish_id' in lmOut) && !('extra_id' in lmOut.extras[0]), 'only the identity fields go');
});

test('legacyCartForSig does not mutate what it is handed', () => {
  // The array it projects is the one about to be SENT. Mutating it would strip the ids out of the body.
  const items = [{ name: 'A', qty: 1, price: 10, extras: [{ name: 'x', price: 1, extra_id: 'E' }], dish_id: 'D' }];
  const snapshot = JSON.stringify(items);
  legacyCartForSig(items);
  assert.strictEqual(JSON.stringify(items), snapshot, '🔴 the input cart is untouched — the body still carries its ids');
});

test('legacyCartForSig survives malformed input rather than crashing', () => {
  // It runs on every signature computation. A throw here blocks a token, a send, or a quote.
  for (const bad of [null, undefined, 'str', 42, {}]) assert.strictEqual(legacyCartForSig(bad), bad, `${JSON.stringify(bad)} passes through`);
  assert.deepStrictEqual(legacyCartForSig([null, 3, { dish_id: 'x', a: 1 }]), [null, 3, { a: 1 }], 'a ragged array projects what it can');
  assert.deepStrictEqual(legacyCartForSig([{ a: 1, extras: 'not-an-array', dish_id: 'd' }]), [{ a: 1, extras: 'not-an-array' }],
    'a non-array extras field is carried through untouched');
});

test('both forms project at EVERY raw-items signature, and no longer strip at the boundaries', () => {
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const raw = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    assert.ok(raw.includes('<script src="form-identity-strip.js"></script>'), `${dir}: the identity module is not loaded`);
    const html = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    /* 🔴 D2 INVERTS D1 AT THE BOUNDARIES. The id must now REACH the cart, so neither boundary strips —
       and the old wrapper is gone entirely rather than left unused, so nobody re-wires it. */
    assert.ok(!/_stripIdentityOrFail/.test(html), `${dir}: 🔴 the D1 boundary strip is still present — the id cannot reach the cart`);
    assert.ok(/let MENU = _okDishes\(_BUNDLE\.dishes\) \? _BUNDLE\.dishes : FALLBACK_MENU;/.test(html),
      `${dir}: 🔴 the initial bundle boundary must pass records through un-stripped`);
    assert.ok(/MENU: dishes,\s*\n\s*EXTRAS: extras,/.test(html),
      `${dir}: 🔴 the live refresh boundary must pass both collections through un-stripped`);

    /* …and every signature that hashes raw emitted items goes through the projection. Counted: the
       wrapper's definition plus B, D-consumer and D-producer. A new raw-items signature added later
       shows up as a count mismatch rather than as a token that quietly stops attaching. */
    assert.strictEqual((html.match(/_legacyCartForSig\(/g) || []).length, 4,
      `${dir}: one definition plus three applications — confirmQuoteCartSig, serverQuoteCartKey, requestServerQuote`);
    assert.ok(/return JSON\.stringify\(\{ items: _legacyCartForSig\(redeemCartItems\(\)\), reward/.test(html),
      `${dir}: 🔴 confirmQuoteCartSig hashes the projection`);
    assert.ok(/function serverQuoteCartKey\(\)\{ try\{ return JSON\.stringify\(_legacyCartForSig\(redeemCartItems\(\)\)\)/.test(html),
      `${dir}: 🔴 the serverQuoteCartKey CONSUMER hashes the projection`);
    assert.ok(/const key = JSON\.stringify\(_legacyCartForSig\(items\)\);/.test(html),
      `${dir}: 🔴 the requestServerQuote PRODUCER hashes the projection — both D sites or neither`);
    assert.ok(!/JSON\.stringify\(redeemCartItems\(\)\)(?!\))/.test(html.replace(/_legacyCartForSig\(redeemCartItems\(\)\)/g, '')),
      `${dir}: 🔴 a raw-items signature survives somewhere`);

    /* 🔴 items_text NEVER CARRIES THE ID. It is hashed by two server bindings (orderFingerprint,
       orderContentKey) and rendered verbatim on the KDS ticket, the WhatsApp message and the tracker.
       An id reaching it would change a server hash AND put an opaque token in front of a kitchen. It
       is built from qty/name/price/extra-names, and this asserts the builder never reaches for an
       identity field. */
    const itemsTextBlock = html.slice(html.indexOf('items_text:'), html.indexOf('items_text:') + 900);
    assert.ok(itemsTextBlock.length > 100, `${dir}: premise — the items_text builder was located`);
    for (const f of IDENTITY_FIELDS) {
      assert.ok(!itemsTextBlock.includes(f), `${dir}: 🔴 ${f} appears in the items_text builder — it is hashed by the server and shown on the KDS`);
    }
    assert.ok(/\$\{qty\[p\.id\]\}x|\$\{l\.qty\}x|qty/.test(itemsTextBlock), `${dir}: non-vacuity — the block really is the items_text builder`);

    // cartSig is id-blind BY CONSTRUCTION (it projects captured fields) and must stay untouched.
    assert.ok(/function cartSig\(\)/.test(html) && !/cartSig[\s\S]{0,400}_legacyCartForSig/.test(html),
      `${dir}: cartSig must not be rewired — it already projects, and changing it would change its semantics`);
  }
});

test("🔴 the inline fallback's field list cannot drift from the module's", () => {
  /* _legacyCartForSig duplicates ['dish_id','extra_id'] deliberately — it has to work when the module
     that owns IDENTITY_FIELDS is the thing that failed to load. Deliberate duplication is defensible
     only while something notices it drifting. Same for account.js's inline fallback in redeemSig. */
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const html = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    const body = html.slice(html.indexOf('function _legacyCartForSig'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    const skipped = [...fn.matchAll(/(?:k|j) === '([a-z_]+)'/g)].map((m) => m[1]).filter((x) => x !== 'extras');
    assert.deepStrictEqual([...new Set(skipped)].sort(), [...IDENTITY_FIELDS].sort(),
      `${dir}: 🔴 the inline projection skips ${JSON.stringify(skipped)} but the module owns ${JSON.stringify(IDENTITY_FIELDS)}`);

    const acct = readFileSync(new URL(`../${dir}/account.js`, import.meta.url), 'utf8');
    for (const f of IDENTITY_FIELDS) {
      assert.ok(acct.includes(`'${f}'`), `${dir}/account.js: the redeemSig fallback does not mention ${f}`);
    }
  }
});

test('🔴 RUNTIME: the live refresh now CARRIES ids into the working records', async (t) => {
  /* The exact inverse of D1's runtime test, and the reason D2 needs one at all. D1 proved no id
     survived liveMenuPrepare; D2 requires that they do, because the cart captures whole records and
     redeemCartItems emits from them. If this regresses, every cart silently goes back to being
     id-less and D3/D4 have nothing to read — with no other symptom. */
  t.after(() => closeAll());
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const w = loadForm(dir);
    assert.strictEqual(typeof w.legacyCartForSig, 'function', `${dir}: premise — the module loaded`);
    const served = servedBodyFor(dir, w);
    const prepared = w.liveMenuPrepare(served);
    assert.ok(prepared.MENU.every((r) => r.dish_id), `${dir}: 🔴 every refreshed dish carries its dish_id into MENU`);
    assert.ok(prepared.EXTRAS.every((r) => r.extra_id), `${dir}: 🔴 …and every option its extra_id into EXTRAS`);
    assert.deepStrictEqual(prepared.MENU.map((r) => [r.id, r.name, r.price]), served.dishes.map((r) => [r.id, r.name, r.price]),
      `${dir}: and nothing else about the records moved`);
  }
});

test('🔴 RUNTIME: with the identity module missing, the SIGNATURES are still id-blind', async (t) => {
  /* D1's fail-closed guarantee did not disappear at D2 — it MOVED, from the menu boundary to the
     signature boundary, and this is where it now lives. If form-identity-strip.js fails to load (a
     404, a cache miss, a CSP block) the page must still project before hashing. Hashing raw items
     would not corrupt anything, but it is customer-visible in three ways the moment a backfilled menu
     serves ids: the quote token stops attaching, a valid reward order is blocked from sending as a
     stale quote, and a cached total is discarded. So the page's own wrapper projects inline. */
  t.after(() => closeAll());
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const w = loadForm(dir, { omit: ['form-identity-strip.js'] });
    assert.strictEqual(typeof w.legacyCartForSig, 'undefined', `${dir}: premise — the module really is absent`);
    assert.strictEqual(typeof w._legacyCartForSig, 'function', `${dir}: …and the page still defines its own wrapper`);

    const cart = [{ name: 'Carnivora', qty: 2, price: 340, subtotal: 680,
      extras: [{ instance: 0, name: 'Salsa Roja', price: 25, extra_id: 'E1' }], extrasTotal: 25, dish_id: 'D1' }];
    const projected = w._legacyCartForSig(cart);
    assert.ok(!('dish_id' in projected[0]), `${dir}: 🔴 the dish id is projected out even with the module gone`);
    assert.ok(!('extra_id' in projected[0].extras[0]), `${dir}: 🔴 …and the NESTED extra id too — the fallback is deep as well`);
    assert.strictEqual(JSON.stringify(projected), JSON.stringify([{ name: 'Carnivora', qty: 2, price: 340, subtotal: 680,
      extras: [{ instance: 0, name: 'Salsa Roja', price: 25 }], extrasTotal: 25 }]),
      `${dir}: 🔴 …to a byte-identical legacy cart, which is what keeps the token attaching`);
    assert.ok(JSON.stringify(cart).includes('D1') && JSON.stringify(cart).includes('E1'),
      `${dir}: non-vacuity — the input still carries both ids, so the body would still send them`);
  }
});
