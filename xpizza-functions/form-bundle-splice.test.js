'use strict';
// Phase 1c-b3 — the form renders the catalog-generated bundle. Run: node form-bundle-splice.test.js
//
// The forms are the revenue surface and the committed HTML IS production, so every assertion here is
// about one of two things: the menu is byte-identical to today, and the menu ALWAYS renders.
const assert = require('assert');
const vm = require('vm');
const { readFileSync } = require('fs');
const { join } = require('path');
const S = require('./catalog/splice-form-bundle');
const { readLiteral, readSetLiteral } = require('./catalog/form-menu-source');
const { catalogSnapshot, generateFormBundle } = require('./catalog/generate-form-bundle');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const ROOT = join(__dirname, '..');
const FORM = { x_pizza: join(ROOT, 'xpizza-orders', 'index.html'), la_musa: join(ROOT, 'la-musa-orders', 'index.html') };
const html = (rid) => readFileSync(FORM[rid], 'utf8');

// ── 1. SPLICE VALIDITY: the block in the shipped HTML re-parses to exactly the source bundle ────
for (const rid of ['x_pizza', 'la_musa']) {
  const bundle = generateFormBundle(rid, catalogSnapshot(rid));
  const got = S.extractBundle(html(rid));
  assert.deepStrictEqual(got, bundle, `${rid}: the spliced block must re-parse to the catalog-generated bundle`);
  ok(`splice validity ${rid}: the shipped block re-parses to the catalog bundle (${got.dishes.length} dishes)`);
}

// ── 2. BYTE-PARITY: the served bundle == the form's own FALLBACK literals (a SOURCE swap, not a
//     menu change). If these ever differ, customers see a different menu than today. ────────────
for (const rid of ['x_pizza', 'la_musa']) {
  const src = html(rid), b = S.extractBundle(src);
  assert.deepStrictEqual(b.dishes, readLiteral(src, 'MENU'), `${rid}: served dishes == the hard-coded fallback, field for field AND in order`);
  ok(`byte-parity ${rid}: ${b.dishes.length} served dishes identical to the current hard-coded menu`);
}
{
  const src = html('la_musa'), b = S.extractBundle(src);
  assert.deepStrictEqual(b.categories, readLiteral(src, 'CATEGORIES'));
  assert.deepStrictEqual(b.variant_items, readLiteral(src, 'VARIANT_ITEMS', '{', '}'));
  assert.deepStrictEqual(b.has_photo.slice().sort(), readSetLiteral(src, 'HAS_PHOTO').slice().sort());
  ok('byte-parity la_musa: categories/subcats, variant map and photo set identical to the fallbacks');
}
{
  const src = html('x_pizza'), b = S.extractBundle(src);
  assert.deepStrictEqual(b.pickup_only_cats, readLiteral(src, 'PICKUP_ONLY_CATS'));
  assert.deepStrictEqual(b.weekend_only_cats, readLiteral(src, 'WEEKEND_ONLY_CATS'));
  ok('byte-parity x_pizza: the PICKUP_ONLY / WEEKEND_ONLY gate arrays come from the bundle and match');
}

// ── 3. 🔒 SCRIPT-INJECTION — the load-bearing safety test. ──────────────────────────────────────
// The HTML tokenizer, not the JS parser, ends a <script>: at the first `</script` followed by
// whitespace, `/` or `>`, even inside what JS would call a string. An unescaped dish name containing
// `</script>` therefore closes the tag EARLY — the rest of the bundle becomes page text and any
// injected <script> becomes a real script element. Escaping `<` removes every `<` from the payload,
// so no HTML construct can form at all.
{
  const EVIL = `Pizza</script><!-- FORM-MENU-BUNDLE:END --><script>alert(1)</script><!--x-->`;
  const bundle = { dishes: [{ id: 1, name: EVIL, desc: '--> <!-- also evil', price: 1 }], categories: [{ id: 'c' }] };
  const doc = `<html><body>\n${S.BEGIN}\n${S.END}\n<script>/* main form script */</script></body></html>`;
  const out = S.spliceBundle(doc, bundle, 'evil');

  const scriptText = S.extractGeneratedScriptText(out);
  assert.ok(!scriptText.includes('<'), 'no raw "<" may survive in the payload — that is the whole property');
  assert.ok(scriptText.includes('\\u003C'), 'the "<" characters must be present as \\u003C escapes');
  const back = S.extractBundle(out);
  assert.strictEqual(back.dishes[0].name, EVIL, 'the dish name round-trips with its literal </script> intact');
  assert.deepStrictEqual(back, bundle, 'the whole bundle survives the hostile payload');
  // Marker injection must not fool the NEXT regeneration.
  assert.strictEqual(out.split(S.BEGIN).length - 1, 1, 'exactly one BEGIN marker despite the injected one');
  assert.strictEqual(out.split(S.END).length - 1, 1, 'exactly one END marker despite the injected one');
  // The injected script must NOT have become a real script element.
  assert.ok(!/<script>alert\(1\)<\/script>/.test(out), 'the injected <script> never materialises as markup');
  assert.strictEqual((out.match(/<script/gi) || []).length, 2, 'exactly the generated script + the main script — no third one was created');
  ok('SCRIPT-INJECTION: a dish named with </script> + marker + comment injection is fully neutralised');
}
{
  // FALSIFIABILITY — without the `<`-escape the attack works. Rebuild the block using bare
  // JSON.stringify and prove the tokenizer closes the script early and the payload is truncated.
  const EVIL = `X</script><script>alert(1)</script>`;
  const bundle = { dishes: [{ id: 1, name: EVIL }] };
  const unsafe = `<script id="form-menu-bundle">${S.GLOBAL} = ${JSON.stringify(bundle)};</script>`;
  const doc = `<html><body>${unsafe}</body></html>`;
  assert.ok(unsafe.includes('</script><script>alert(1)'), 'the unescaped payload carries a raw </script> into the markup');
  const text = S.extractGeneratedScriptText(doc);
  // The extracted text is TRUNCATED at the injected `</script>` — that truncation IS the attack, and it
  // is why the extracted text ironically contains no `<` any more: everything from it onward was cut.
  assert.ok(text.length < unsafe.length - 40 && text.endsWith('"name":"X'),
    'unescaped: the tokenizer closes the element early, truncating the payload mid-string');
  assert.throws(() => S.extractBundle(doc), /splice_script_shape_unexpected|Unexpected|JSON/,
    'unescaped: the truncated payload no longer parses — the attack this prevents');
  assert.ok(/<script>alert\(1\)<\/script>/.test(doc), 'and the injected script IS present as real markup');
  ok('SCRIPT-INJECTION falsifiable: without the escape the tag closes early and the injected script becomes real markup');
}
{
  // The extractor implements the HTML rule, not a JS-string rule — mutation-check it directly so a
  // buggy scanner cannot make the test above pass vacuously.
  const s = '<script id="form-menu-bundle">x = "a</script > b";</script>';
  assert.strictEqual(S.extractGeneratedScriptText(s), 'x = "a',
    'the scanner must end the script at `</script >` even INSIDE a JS string (the HTML rule)');
  const probe = '<script>ok</scriptx> still</script>';
  assert.strictEqual(S.scriptDataEnd(probe, 8), probe.lastIndexOf('</script>'),
    '`</scriptx` does NOT end the element (the next char must be space, / or >); the real `</script>` does');
  ok('scanner: implements the HTML script-data rule (ends inside JS strings; ignores </scriptx)');
}

// ── 4. FAIL-CLOSED SPLICE: marker problems and round-trip failures write NOTHING ────────────────
for (const [label, doc] of [
  ['no markers', '<html></html>'],
  ['duplicate BEGIN', `${S.BEGIN}${S.BEGIN}${S.END}`],
  ['END before BEGIN', `${S.END}${S.BEGIN}`],
]) {
  assert.throws(() => S.spliceBundle(doc, { dishes: [] }, label), /splice_marker/, `${label} must throw`);
}
ok('fail-closed: a missing, duplicated or out-of-order marker pair throws — the generator writes nothing');

// ── 5. IDEMPOTENCE: re-splicing the shipped HTML changes nothing (diff-stable regeneration) ─────
for (const rid of ['x_pizza', 'la_musa']) {
  const src = html(rid);
  assert.strictEqual(S.spliceBundle(src, generateFormBundle(rid, catalogSnapshot(rid)), rid), src, `${rid}: re-splice is byte-identical`);
}
ok('idempotence: re-splicing both shipped forms yields byte-identical HTML');
{
  // and it touches ONLY the marked region — surrounding form JS is untouched.
  const src = html('x_pizza');
  const outside = (s) => s.slice(0, s.indexOf(S.BEGIN)) + s.slice(s.indexOf(S.END) + S.END.length);
  const other = S.spliceBundle(src, { dishes: [{ id: 9, name: 'Z' }] }, 'x_pizza');
  assert.strictEqual(outside(other), outside(src), 'everything outside the markers is byte-unchanged');
  ok('splice scope: a completely different bundle changes ONLY the marked region');
}

// ── 6. THE VALIDATED SELECT: the bundle is used when valid, and EVERY structure falls back on its
//     own validity. This is the always-renders guarantee. ─────────────────────────────────────────
// Evaluate ONLY the validated-select block, with the form's own FALLBACK_* literals injected as
// globals. The form interleaves other statements between the literals and the select, so slicing a
// contiguous region would drag in code that uses MENU before the select declares it. This isolates
// the decision logic, which is precisely what the always-renders guarantee rests on.
const SELECT_NAMES = { x_pizza: ['MENU', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS'], la_musa: ['MENU', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO'] };
function selectBlock(src, rid) {
  const from = src.indexOf('const _BUNDLE = ');
  assert.ok(from > 0, 'the validated-select block must be present in the form');
  const lastName = SELECT_NAMES[rid][SELECT_NAMES[rid].length - 1];
  const lastDecl = src.indexOf(`const ${lastName} = `, from);
  return src.slice(from, src.indexOf('\n', src.indexOf(';', lastDecl)));
}
function runSelect(rid, bundleGlobal) {
  const src = html(rid);
  const sandbox = {
    window: bundleGlobal === undefined ? {} : { __FORM_MENU_BUNDLE__: bundleGlobal },
    FALLBACK_MENU: readLiteral(src, 'MENU'),
  };
  if (rid === 'la_musa') {
    sandbox.FALLBACK_CATEGORIES = readLiteral(src, 'CATEGORIES');
    sandbox.FALLBACK_VARIANT_ITEMS = readLiteral(src, 'VARIANT_ITEMS', '{', '}');
    sandbox.FALLBACK_HAS_PHOTO = readSetLiteral(src, 'HAS_PHOTO');
  } else {
    sandbox.FALLBACK_PICKUP_ONLY = readLiteral(src, 'PICKUP_ONLY_CATS');
    sandbox.FALLBACK_WEEKEND_ONLY = readLiteral(src, 'WEEKEND_ONLY_CATS');
  }
  vm.createContext(sandbox);
  vm.runInContext(`${selectBlock(src, rid)}\n;globalThis.__out = { ${SELECT_NAMES[rid].join(', ')} };`, sandbox);
  return sandbox.__out;
}
for (const rid of ['x_pizza', 'la_musa']) {
  const src = html(rid), bundle = S.extractBundle(src);
  const used = runSelect(rid, bundle);
  assert.deepStrictEqual(used.MENU, bundle.dishes, `${rid}: a VALID bundle is used for MENU`);
  const fell = runSelect(rid, undefined);
  assert.deepStrictEqual(fell.MENU, readLiteral(src, 'MENU'), `${rid}: NO bundle → the fallback literal renders`);
  for (const bad of [{}, { dishes: [] }, { dishes: 'nope' }, { dishes: [{ id: 1 }] }, { dishes: [null] }]) {
    assert.deepStrictEqual(runSelect(rid, bad).MENU, readLiteral(src, 'MENU'), `${rid}: malformed bundle (${JSON.stringify(bad)}) → fallback`);
  }
  ok(`validated select ${rid}: valid bundle used; absent/empty/malformed (5 shapes) → fallback — the menu ALWAYS renders`);
}
{
  // Per-structure independence: a bundle with good dishes but a broken aux structure must fall back
  // for THAT structure only — a partial bundle can never leave one undefined.
  const src = html('la_musa'), b = S.extractBundle(src);
  const out = runSelect('la_musa', { ...b, categories: 'broken', variant_items: null, has_photo: 42 });
  assert.deepStrictEqual(out.MENU, b.dishes, 'good dishes are still used');
  assert.deepStrictEqual(out.CATEGORIES, readLiteral(src, 'CATEGORIES'), 'broken categories fall back independently');
  assert.deepStrictEqual(out.VARIANT_ITEMS, readLiteral(src, 'VARIANT_ITEMS', '{', '}'), 'broken variant_items fall back independently');
  assert.deepStrictEqual([...out.HAS_PHOTO].sort(), readSetLiteral(src, 'HAS_PHOTO').slice().sort(), 'broken has_photo falls back independently');
  ok('validated select: each structure falls back on its OWN validity (a partial bundle leaves nothing undefined)');
  const x = runSelect('x_pizza', { dishes: S.extractBundle(html('x_pizza')).dishes, pickup_only_cats: 7, weekend_only_cats: null });
  assert.deepStrictEqual(x.PICKUP_ONLY_CATS, readLiteral(html('x_pizza'), 'PICKUP_ONLY_CATS'), 'x_pizza gate arrays fall back independently');
  ok('validated select x_pizza: the gate arrays fall back independently of the dish array');
}
// ── 6b. SERVED MENU vs SERVER PRICING — asserted DIRECTLY, not via transitivity. The customer sees
//      the bundle; the server charges from menu-pricing. Those two must agree item-for-item. ─────
{
  const { MENU_BY_RESTAURANT } = require('./menu-pricing');
  for (const [rid, keyOf] of [['x_pizza', (d) => d.name], ['la_musa', (d) => d.id]]) {
    const b = S.extractBundle(html(rid));
    const table = MENU_BY_RESTAURANT[rid];
    const served = {}; for (const d of b.dishes) served[keyOf(d)] = d.price;
    assert.deepStrictEqual(Object.keys(served).sort(), Object.keys(table).sort(), `${rid}: served key set == server key set`);
    for (const k of Object.keys(table)) {
      assert.strictEqual(served[k], table[k], `${rid}/${k}: displayed price must equal the server price`);
    }
    ok(`displayed == charged ${rid}: all ${Object.keys(table).length} served prices match the server pricing table exactly`);
  }
}

// ── 7. THE FORM STILL PARSES. The cutover edits real form JS, and a syntax error there is a blank
//     page — the exact availability failure this phase must not cause. Parse every inline script.
{
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = html(rid);
    let count = 0, at = 0;
    while ((at = src.indexOf('<script', at)) >= 0) {
      const gt = src.indexOf('>', at);
      const isExternal = /\ssrc=/.test(src.slice(at, gt));
      const bodyEnd = S.scriptDataEnd(src, gt + 1);
      if (!isExternal) {
        assert.doesNotThrow(() => new vm.Script(src.slice(gt + 1, bodyEnd)), `${rid}: inline script #${count + 1} must PARSE (a syntax error = blank page)`);
        count++;
      }
      // Advance PAST the element, as the tokenizer would — scanning from inside the body would match a
      // `<script` occurring in a JS string and mis-identify a fragment as an element.
      at = bodyEnd < 0 ? gt + 1 : bodyEnd + '</script>'.length;
    }
    assert.ok(count >= 2, `${rid}: expected at least the generated + main inline scripts, saw ${count}`);
    ok(`form parses ${rid}: all ${count} inline scripts are syntactically valid after the cutover edits`);
  }
}
{
  // And the generated block is genuinely SEPARATE, so a broken bundle cannot take the main script
  // down with it — the isolation the always-renders guarantee depends on.
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = html(rid);
    const gen = src.indexOf(S.SCRIPT_OPEN);
    const main = src.indexOf('const _BUNDLE = ');
    assert.ok(gen > 0 && main > gen, `${rid}: the generated block must precede the consuming script`);
    assert.ok(S.scriptDataEnd(src, gen) < main, `${rid}: the generated <script> must CLOSE before the main script starts (separate elements)`);
  }
  ok('script isolation: the generated block is its own <script>, closed before the main script begins');
}

// ── 8. GATE PARITY — the client gate arrays must match what the server actually enforces, or a
//     catalog gate-flag edit could let the cart accept what the server rejects. ─────────────────
{
  const { X_PIZZA_WEEKEND_ONLY, weekendOnlyViolation } = require('./menu-pricing');
  const b = S.extractBundle(html('x_pizza'));
  const weekendCats = new Set(b.weekend_only_cats);
  const clientWeekend = b.dishes.filter((d) => weekendCats.has(d.cat)).map((d) => d.name).sort();
  assert.deepStrictEqual(clientWeekend, [...X_PIZZA_WEEKEND_ONLY].sort(),
    'the bundle-derived weekend-only item set must equal the server_s X_PIZZA_WEEKEND_ONLY set');
  // and the server agrees item-by-item on a weekday
  const MON = Date.UTC(2026, 8, 7, 18, 0, 0);   // a Monday in Honduras (UTC-6)
  for (const d of b.dishes) {
    const serverBlocks = weekendOnlyViolation([{ name: d.name }], 'x_pizza', MON) !== null;
    assert.strictEqual(serverBlocks, weekendCats.has(d.cat), `weekend gate disagreement for ${d.name}`);
  }
  ok(`gate parity x_pizza: the bundle's weekend gate matches the server for all ${b.dishes.length} items (checked on a weekday)`);
  const pickupCats = new Set(b.pickup_only_cats);
  assert.deepStrictEqual([...pickupCats].sort(), ['ny'], 'pickup-only cats come from the bundle and match the known server scope');
  ok('gate parity x_pizza: the pickup-only category set is bundle-sourced and matches');
}

// ── 9. REWARDS PICKER + 86 OVERLAY — both key off MENU/p.id, so they must work against the bundle. ──
{
  const { isRedeemEligible } = require('./rewards-redeem-config');
  const b = S.extractBundle(html('x_pizza'));
  // The picker's rule (x_pizza: individual-category dishes, keyed by NAME) must select exactly the
  // items the server will honour — otherwise a customer picks a reward the server then rejects.
  const pickerEligible = b.dishes.filter((d) => d.cat === 'individual').map((d) => d.name).sort();
  const serverEligible = b.dishes.map((d) => d.name).filter((k) => isRedeemEligible('x_pizza', k)).sort();
  assert.deepStrictEqual(pickerEligible, serverEligible,
    'the bundle-driven picker set must equal the server-honoured redeem set (no offer the server rejects)');
  ok(`rewards picker x_pizza: ${pickerEligible.length} bundle-derived eligible items == the server's redeem-eligible set`);
  const lb = S.extractBundle(html('la_musa'));
  const laEligible = lb.dishes.map((d) => d.id).filter((id) => isRedeemEligible('la_musa', id));
  assert.ok(laEligible.length > 0 && laEligible.every((id) => !id.startsWith('beer_')),
    'la_musa: bundle ids resolve through the server eligibility rule, alcohol excluded');
  ok(`rewards picker la_musa: ${laEligible.length} bundle ids resolve as server-eligible (alcohol excluded)`);
}
{
  // The 86 overlay keys off MENU item ids; the bundle preserves every id, so the overlay is untouched.
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = html(rid), b = S.extractBundle(src);
    assert.deepStrictEqual(b.dishes.map((d) => d.id), readLiteral(src, 'MENU').map((d) => d.id),
      `${rid}: every MENU id is preserved — the 86 overlay and cart qty[p.id] key off these`);
    assert.ok(!/applyAvailability[\s\S]{0,200}__FORM_MENU_BUNDLE__/.test(src), `${rid}: the availability overlay is not rewired to the bundle`);
  }
  ok('86 overlay + cart: every MENU id is preserved and the overlay code is untouched');
}

console.log(`form-bundle-splice: OK (${n})`);
