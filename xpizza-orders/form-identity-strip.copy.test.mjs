// Portal 1D · D1 — the browser strip: behaviour + copy integrity.
// Run: node --test xpizza-orders/form-identity-strip.copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadForm, closeAll, BRAND } from '../form-harness.mjs';
const { stripIdentity, IDENTITY_FIELDS } = createRequire(import.meta.url)('./form-identity-strip.js');

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

test('both forms load the strip and apply it at BOTH boundaries', () => {
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const raw = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    assert.ok(raw.includes('<script src="form-identity-strip.js"></script>'), `${dir}: the strip is not loaded`);
    const html = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    /* 🔴 BOTH BOUNDARIES. The spliced bundle is built offline and carries no ids today, so stripping
       only the refresh would pass every test — until the day the splice tool is made identity-aware
       and the initial load starts carrying them into the cart. Counted, not sampled. */
    assert.ok(/let MENU = _okDishes\(_BUNDLE\.dishes\) \? _stripIdentityOrFail\(_BUNDLE\.dishes\)/.test(html),
      `${dir}: 🔴 the INITIAL bundle boundary does not strip`);
    assert.ok(/MENU: _stripIdentityOrFail\(dishes\)/.test(html),
      `${dir}: 🔴 the live REFRESH boundary does not strip dishes`);
    assert.ok(/EXTRAS: _stripIdentityOrFail\(extras\)/.test(html),
      `${dir}: 🔴 …or extras`);

    /* 🔴 EVERY BOUNDARY GOES THROUGH THE FAIL-CLOSED WRAPPER, AND NONE CALLS THE MODULE DIRECTLY.
       The earlier form of this counted `stripIdentity(` applications, which is exactly what a
       reintroduced `typeof stripIdentity === 'function' ? … : records` would satisfy — the fail-OPEN
       shape passes a strip census while passing ids through whenever the module is missing. So the
       census now counts the WRAPPER (its definition plus three applications) and asserts the module is
       called from precisely one place: inside the wrapper. */
    assert.strictEqual((html.match(/_stripIdentityOrFail\(/g) || []).length, 4,
      `${dir}: one definition plus three applications — the initial dishes, and the refresh's dishes and extras`);
    assert.strictEqual((html.match(/(?<!_)\bstripIdentity\(/g) || []).length, 1,
      `${dir}: 🔴 the module is called from ONE place — the wrapper — so no boundary can fail open around it`);
    assert.ok(!/typeof stripIdentity === 'function' \? stripIdentity\([a-zA-Z_.]+\) : [a-zA-Z_.]+/.test(html),
      `${dir}: 🔴 the fail-OPEN ternary is back — a missing module would send ids into the cart`);

    /* 🔴 THE INITIAL *EXTRAS* BOUNDARY DOES NOT EXIST — PINNED SO IT CANNOT APPEAR UNGUARDED.
       The gate asked why the initial boundary strips dishes but not extras. The answer is that neither
       form reads _BUNDLE.extras at all: initial EXTRAS is a hardcoded literal, and options only ever
       arrive through the live refresh, which IS stripped. So there is nothing to strip there today.
       "Today" is the problem. If someone later wires the spliced bundle into EXTRAS — an obvious
       tidy-up, since the bundle already carries them — the id would reach the cart through a boundary
       nobody re-examined. This asserts the absence, so that change has to come with its strip. */
    const bundleExtrasReads = (html.match(/_BUNDLE\.extras/g) || []);
    if (bundleExtrasReads.length > 0) {
      assert.ok(/_stripIdentityOrFail\(_BUNDLE\.extras\)/.test(html),
        `${dir}: 🔴 the initial bundle's EXTRAS are now read — they must be stripped, like the dishes are`);
    } else {
      assert.ok(/let EXTRAS = \[/.test(html),
        `${dir}: initial EXTRAS is a literal and the bundle's extras are unread — if that changed, the branch above applies`);
    }
    // non-vacuity: the detector can see the read it is guarding against
    assert.ok(/_BUNDLE\.extras/.test('let E = _BUNDLE.extras;'), 'non-vacuity: the bundle-extras detector works');
  }
});

test("🔴 the inline fallback's field list cannot drift from the module's", () => {
  /* _stripIdentityOrFail duplicates ['dish_id','extra_id'] deliberately — it has to work when the
     module that owns IDENTITY_FIELDS is the thing that failed to load, so it cannot import the list it
     is standing in for. Deliberate duplication is defensible only while something notices it drifting,
     which is this. Add a third identity field to the module and this fails until the inline copy
     learns about it. */
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const html = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    const body = html.slice(html.indexOf('function _stripIdentityOrFail'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    const skipped = [...fn.matchAll(/k === '([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(skipped.sort(), [...IDENTITY_FIELDS].sort(),
      `${dir}: 🔴 the inline fallback strips ${JSON.stringify(skipped)} but the module owns ${JSON.stringify(IDENTITY_FIELDS)}`);
    // …and it guards on the same names before deciding a record is clean.
    for (const f of IDENTITY_FIELDS) {
      assert.ok(fn.includes(`'${f}'`), `${dir}: the fallback does not mention ${f}`);
    }
  }
});

test('🔴 RUNTIME: with the strip module missing, the refresh still lets no id through', async (t) => {
  /* THE BRANCH THAT WAS NEVER EXECUTED. Every earlier check here read the page as TEXT or exercised
     the module in isolation; the interesting state — the page running with form-identity-strip.js
     absent — had no test at all, which is how a guard that failed OPEN survived. This loads the real
     form with that one script dropped, exactly as a 404 or a CSP block would, and drives the real
     refresh adapter. */
  t.after(() => closeAll());
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const w = loadForm(dir, { omit: ['form-identity-strip.js'] });
    assert.strictEqual(typeof w.stripIdentity, 'undefined',
      `${dir}: premise — the module really is absent, so the fallback is what runs`);
    assert.strictEqual(typeof w._stripIdentityOrFail, 'function',
      `${dir}: …and the page itself still defines the wrapper`);

    const served = servedBodyFor(dir, w);
    const prepared = w.liveMenuPrepare(served);

    for (const rec of prepared.MENU) {
      for (const f of IDENTITY_FIELDS) {
        assert.ok(!Object.prototype.hasOwnProperty.call(rec, f),
          `${dir}: 🔴 ${f} reached a browser working record with the strip module missing — this is the leak, it just took a failed script to open it`);
      }
    }
    for (const rec of prepared.EXTRAS) {
      for (const f of IDENTITY_FIELDS) {
        assert.ok(!Object.prototype.hasOwnProperty.call(rec, f), `${dir}: 🔴 ${f} survived on an extra`);
      }
    }
    // Non-vacuity on both halves: the records really did arrive carrying ids, and nothing else moved.
    assert.ok(served.dishes[0].dish_id, `${dir}: the served input genuinely carried an id`);
    assert.deepStrictEqual(prepared.MENU.map((r) => [r.id, r.name, r.price]),
      served.dishes.map((r) => [r.id, r.name, r.price]), `${dir}: every other field survives the fallback`);
    assert.deepStrictEqual(prepared.EXTRAS.map((r) => [r.id, r.name, r.price]),
      served.extras.map((r) => [r.id, r.name, r.price]), `${dir}: …on extras too`);
  }
});

test('🔴 RUNTIME: with the module PRESENT the same refresh is equally clean', async (t) => {
  // The other half of the pair. Without it the test above could pass on a page too broken to carry an
  // id anywhere — and it says nothing about the ordinary path, which is the one customers use.
  t.after(() => closeAll());
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const w = loadForm(dir);
    assert.strictEqual(typeof w.stripIdentity, 'function', `${dir}: premise — the module loaded`);
    const prepared = w.liveMenuPrepare(servedBodyFor(dir, w));
    assert.ok(prepared.MENU.every((r) => !Object.prototype.hasOwnProperty.call(r, 'dish_id')), `${dir}: no dish_id on the normal path`);
    assert.ok(prepared.EXTRAS.every((r) => !Object.prototype.hasOwnProperty.call(r, 'extra_id')), `${dir}: no extra_id on the normal path`);
    assert.ok(prepared.MENU[0].name && prepared.MENU[0].price > 0, `${dir}: and the records are otherwise intact`);
  }
});
