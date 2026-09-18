// Portal 1D · D1 — the browser strip: behaviour + copy integrity.
// Run: node --test xpizza-orders/form-identity-strip.copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { stripIdentity, IDENTITY_FIELDS } = createRequire(import.meta.url)('./form-identity-strip.js');

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

test('both forms load the strip and apply it at BOTH boundaries', () => {
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const raw = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    assert.ok(raw.includes('<script src="form-identity-strip.js"></script>'), `${dir}: the strip is not loaded`);
    const html = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    /* 🔴 BOTH BOUNDARIES. The spliced bundle is built offline and carries no ids today, so stripping
       only the refresh would pass every test — until the day the splice tool is made identity-aware
       and the initial load starts carrying them into the cart. Counted, not sampled. */
    assert.ok(/let MENU = _okDishes\(_BUNDLE\.dishes\) \? \(typeof stripIdentity === 'function' \? stripIdentity\(_BUNDLE\.dishes\)/.test(html),
      `${dir}: 🔴 the INITIAL bundle boundary does not strip`);
    assert.ok(/MENU: \(typeof stripIdentity === 'function' \? stripIdentity\(dishes\) : dishes\)/.test(html),
      `${dir}: 🔴 the live REFRESH boundary does not strip dishes`);
    assert.ok(/EXTRAS: \(typeof stripIdentity === 'function' \? stripIdentity\(extras\) : extras\)/.test(html),
      `${dir}: 🔴 …or extras`);
    assert.strictEqual((html.match(/stripIdentity\(/g) || []).length, 3,
      `${dir}: exactly three applications — the initial dishes, and the refresh's dishes and extras`);

    /* 🔴 THE INITIAL *EXTRAS* BOUNDARY DOES NOT EXIST — PINNED SO IT CANNOT APPEAR UNGUARDED.
       The gate asked why the initial boundary strips dishes but not extras. The answer is that neither
       form reads _BUNDLE.extras at all: initial EXTRAS is a hardcoded literal, and options only ever
       arrive through the live refresh, which IS stripped. So there is nothing to strip there today.
       "Today" is the problem. If someone later wires the spliced bundle into EXTRAS — an obvious
       tidy-up, since the bundle already carries them — the id would reach the cart through a boundary
       nobody re-examined. This asserts the absence, so that change has to come with its strip. */
    const bundleExtrasReads = (html.match(/_BUNDLE\.extras/g) || []);
    if (bundleExtrasReads.length > 0) {
      assert.ok(/stripIdentity\(_BUNDLE\.extras\)/.test(html),
        `${dir}: 🔴 the initial bundle's EXTRAS are now read — they must be stripped, like the dishes are`);
    } else {
      assert.ok(/let EXTRAS = \[/.test(html),
        `${dir}: initial EXTRAS is a literal and the bundle's extras are unread — if that changed, the branch above applies`);
    }
    // non-vacuity: the detector can see the read it is guarding against
    assert.ok(/_BUNDLE\.extras/.test('let E = _BUNDLE.extras;'), 'non-vacuity: the bundle-extras detector works');
  }
});
