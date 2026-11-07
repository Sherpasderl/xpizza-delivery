'use strict';
// Phase 1c-b3 — the form renders the catalog-generated bundle. Run: node form-bundle-splice.test.js
//
// The forms are the revenue surface and the committed HTML IS production, so every assertion here is
// about one of two things: the menu is byte-identical to today, and the menu ALWAYS renders.
const assert = require('assert');
const vm = require('vm');
const { readFileSync } = require('fs');
const { join, dirname } = require('path');
const { FORMS } = require('./tools/splice-form-bundle');
const S = require('./catalog/splice-form-bundle');
const { readLiteral, readSetLiteral } = require('./catalog/form-menu-source');
const { catalogSnapshot } = require('./catalog/generate-form-bundle');
// PLAN 4 (gap resolution A): the spliced bundle is the PUBLISHED shape — the ONE composer getPublicMenu serves
const { composeServedMenu } = require('./catalog/public-menu');
const generateFormBundle = composeServedMenu;

// PLAN 4 GATED (G1): the bootstrap's record set = the form literals + the ONE reviewed data file's rows (reward_icon / extras_policy)
const { withBootstrapRows } = require('./catalog/menu-structure-rows');
const BR = (rid, src) => withBootstrapRows(rid, { dishes: readLiteral(src, 'MENU'), extras: readLiteral(src, 'EXTRAS') });
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
  assert.deepStrictEqual(b.dishes, BR(rid, src).dishes, `${rid}: served dishes == the hard-coded fallback (+ the reviewed rows), field for field AND in order`);
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

// ── 6. THE BOOT SELECT (PLAN 4 r3 §3): the bundle is the ONLY boot source. Valid → used; a REQUIRED structure that is absent
//     or any malformed one boots EMPTY, is announced (announceMenuBroken, once) and NEVER becomes a literal; an OPTIONAL one
//     that is absent is simply none. Each structure is judged on its own. The REAL boot block and selects are lifted from each
//     form and run with the form's own shared picker. ─────────────────────────────────────────────────────────────────────
const SELECT_NAMES = {
  x_pizza: ['MENU', 'EXTRAS', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS'],
  la_musa: ['MENU', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO', 'EXTRAS', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM', 'TAG_BADGES', 'BADGE_PRIORITY'],
};
function stmt(src, decl) {
  const at = src.indexOf(decl);
  if (at > 0) return src.slice(at, src.indexOf(';', at) + 1);
  return assert.fail(`expected declaration in form: ${decl}`);
}
const clone = (v) => JSON.parse(JSON.stringify(v));
function bootBlock(src) {
  const a = src.indexOf('/* ── PLAN 4 (bake from published, r3 §3) — THE BUNDLE IS THE ONLY BOOT SOURCE');
  const fn = src.indexOf('function _announceBootBroken(){', a);
  assert.ok(a > 0 && fn > a, 'the boot block is in the form');
  return src.slice(a, src.indexOf('\n}\n', fn) + 3);
}
function runSelect(rid, bundleGlobal) {
  const src = html(rid);
  const announced = [];
  const sandbox = {
    window: bundleGlobal === undefined ? {} : { __FORM_MENU_BUNDLE__: bundleGlobal },
    GroupPicker: require(join(dirname(FORMS[rid]), 'form-group-picker.js')),
    announceMenuBroken: () => announced.push(1), console: { error: () => {}, warn: () => {} },
    document: { readyState: 'complete', addEventListener: () => {} },
  };
  vm.createContext(sandbox);
  const helpers = ['const _BUNDLE = ', 'const _okDishes = ', 'const _okStrArr = '].concat(rid === 'la_musa' ? ['const _okCats = ', 'const _okObj = '] : []);
  const selects = SELECT_NAMES[rid].map((k) => `let ${k} = ${k === 'HAS_PHOTO' ? 'new Set(_bootSelect(' : '_bootSelect('}`);
  const code = helpers.map((d) => stmt(src, d)).join('\n') + '\n' + bootBlock(src) + '\n' + selects.map((d) => stmt(src, d)).join('\n')
    + `\n_announceBootBroken();\n;globalThis.__out = { ${SELECT_NAMES[rid].join(', ')}, _BOOT_BROKEN, _MENU_BROKEN };`;
  vm.runInContext(code, sandbox);
  // out of the vm realm: plain arrays / objects (a cross-realm array fails deepStrictEqual on its prototype alone)
  const out = {};
  for (const [k, v] of Object.entries(sandbox.__out)) out[k] = JSON.parse(JSON.stringify(Object.prototype.toString.call(v) === '[object Set]' ? [...v] : v));
  return { ...out, announced: announced.length };
}
const LITERAL_NAMES = { x_pizza: ['MENU', 'EXTRAS'], la_musa: ['MENU', 'EXTRAS', 'CATEGORIES'] };
for (const rid of ['x_pizza', 'la_musa']) {
  const src = html(rid), bundle = S.extractBundle(src);
  const used = runSelect(rid, bundle);
  assert.deepStrictEqual(used.MENU, bundle.dishes, `${rid}: a VALID bundle is used for MENU`);
  assert.deepStrictEqual(used.EXTRAS, bundle.extras, `${rid}: … and for EXTRAS`);
  assert.deepStrictEqual(used.EXTRAS_BY_CATEGORY, bundle.extras_by_category, `${rid}: … and for the option map`);
  assert.deepStrictEqual([used._BOOT_BROKEN, used.announced], [[], 0], `${rid}: nothing broken, nothing announced`);
  const none = runSelect(rid, undefined);
  for (const k of LITERAL_NAMES[rid]) {
    assert.deepStrictEqual(none[k], [], `${rid}: NO bundle → ${k} boots EMPTY`);
    assert.notDeepStrictEqual(none[k], readLiteral(src, k), `🔴 ${rid}: ${k} must never become the literal`);
  }
  assert.strictEqual(none.announced, 1, `${rid}: announced once`);
  assert.strictEqual(used._MENU_BROKEN, false, `${rid}: a valid bundle does not latch`);
  assert.strictEqual(none._MENU_BROKEN, true, `${rid}: no bundle LATCHES the page non-orderable`);
  // PLAN 4 r2 (Codex r1 #2): the COMPLETE contract at boot — any failure boots NOTHING (every structure empty), announced, latched
  const dup = clone(bundle); dup.dishes[1] = { ...dup.dishes[1], id: dup.dishes[0].id };
  const neg = clone(bundle); neg.dishes[0] = { ...neg.dishes[0], price: -5 };
  for (const [label, bad] of [['empty dishes', { ...bundle, dishes: [] }], ['dishes not an array', { ...bundle, dishes: 'nope' }], ['an unnamed dish', { ...bundle, dishes: [{ id: 1 }] }],
    ['a null dish', { ...bundle, dishes: [null] }], ['a NEGATIVE price', neg], ['DUPLICATE dish ids', dup], ['no extras', (() => { const b = clone(bundle); delete b.extras; return b; })()]]) {
    const out = runSelect(rid, bad);
    assert.deepStrictEqual([out.MENU, out.EXTRAS, out.announced, out._MENU_BROKEN], [[], [], 1, true], `${rid}: ${label} → EVERY structure empty, announced once, latched`);
  }
  ok(`boot select ${rid}: a valid bundle is used for every structure; no bundle, a malformed record, a negative price, duplicate ids or no extras → NOTHING boots, announced once, latched non-orderable — never the literal`);
}
{
  // per-structure independence + optional absence
  const src = html('la_musa'), b = S.extractBundle(src);
  const out = runSelect('la_musa', { ...b, categories: 'broken' });
  assert.deepStrictEqual([out.MENU, out.CATEGORIES, out.EXTRAS, out.VARIANT_ITEMS, out.HAS_PHOTO, out.EXTRAS_BY_CATEGORY, out.TAG_BADGES], [[], [], [], {}, [], {}, {}], 'broken categories → nothing boots');
  assert.deepStrictEqual(out._BOOT_BROKEN, ['apply_categories_missing'], 'the first problem is named');
  // PLAN 4 r2 (Codex r1 #2 / #3): a malformed variant map, and dishes whose variant map is MISSING, boot nothing either
  const bvm = clone(b); bvm.variant_items[Object.keys(bvm.variant_items)[0]].variantIds = ['ghost'];
  assert.deepStrictEqual(runSelect('la_musa', bvm)._BOOT_BROKEN.map((x) => x.split('@')[0]), ['apply_variant_id_orphan'], 'a malformed variant map refuses the boot');
  const nvm = clone(b); delete nvm.variant_items;
  const o0 = runSelect('la_musa', nvm);
  assert.ok(/^apply_variant_uncovered@/.test(o0._BOOT_BROKEN[0]) && o0._MENU_BROKEN && o0.MENU.length === 0, 'variants with NO map (reverse coverage) refuse the boot — never "no groups"');
  const opt = { ...b }; delete opt.extras_by_item; delete opt.badges; delete opt.badge_priority;
  const o2 = runSelect('la_musa', opt);
  assert.deepStrictEqual([o2.EXTRAS_BY_ITEM, o2.TAG_BADGES, o2._BOOT_BROKEN], [{}, {}, []], 'an OPTIONAL structure that is absent is simply none — not broken');
  assert.deepStrictEqual(o2.BADGE_PRIORITY, [], 'PLAN 4 GATED: with no published priority NO badge is chosen — there is no literal order to fall back to');
  const o3 = runSelect('la_musa', { ...b, badge_priority: ['must_try', 'chefs_pick'] });
  assert.deepStrictEqual(o3.BADGE_PRIORITY, ['must_try', 'chefs_pick'], 'a published priority wins');
  const o4 = runSelect('la_musa', { ...b, extras_by_category: { ...b.extras_by_category, ghost: [] } });
  assert.deepStrictEqual([o4.EXTRAS_BY_CATEGORY, o4.MENU, o4.announced, o4._MENU_BROKEN], [{}, [], 1, true], 'a map the shared rule refuses boots NOTHING (never the literal), announced, latched');
  ok('boot select la_musa: broken categories, a malformed variant map, variants with no map, a refused option map → nothing boots, latched; optional absent = none; a published priority wins over TAG_PRIORITY');
  const x = runSelect('x_pizza', { ...S.extractBundle(html('x_pizza')), pickup_only_cats: 7, weekend_only_cats: null });
  assert.deepStrictEqual([x.PICKUP_ONLY_CATS, x.WEEKEND_ONLY_CATS, x.MENU, x.announced, x._MENU_BROKEN], [[], [], [], 1, true], 'x_pizza malformed gates → nothing boots, announced, latched — never the literal');
  ok('boot select x_pizza: malformed gate arrays refuse the boot (nothing orderable), announced and latched');
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
