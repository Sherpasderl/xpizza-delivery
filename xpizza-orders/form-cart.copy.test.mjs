// Portal 1B Task 4 — COPY INTEGRITY for the shared cart model.
// Run: node --test xpizza-orders/form-cart.copy.test.mjs
//
// 🔴 IN ITS OWN FILE, deliberately — the same reason as form-live-menu.copy.test.mjs. The mutation
// sweep mutates the CANONICAL copy and runs a suite; with this assertion sitting beside behavioural
// tests, EVERY mutant trips it, every mutant is "killed" by the copies differing, and not one of them
// ever reaches a behavioural assertion. That slice reported 13/13 and proved nothing. Separated, a
// kill in the behavioural suite means the behaviour noticed.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('the la_musa copy of the cart model is byte-identical to the canonical one', () => {
  const canonical = readFileSync(new URL('./form-cart.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../la-musa-orders/form-cart.js', import.meta.url), 'utf8');
  assert.strictEqual(copy, canonical,
    'la-musa-orders/form-cart.js has drifted — copy xpizza-orders/form-cart.js over it');
  assert.ok(canonical.includes('function createCart'), 'non-vacuity: the file really is the cart model');
  // COMMENT-STRIPPED and line-anchored — a guard that matched the word `export` inside the file's own
  // prose explaining it uses no `export` would be reading its documentation as evidence.
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code),
    'no ESM syntax — the same bytes must load as a Node module AND a classic browser script');
  assert.ok(/module\.exports/.test(code) && /window\.createCart/.test(code),
    '...and it must publish itself to BOTH worlds');
  assert.ok(/^\s*export[\s{]/m.test('export function x() {}'), 'non-vacuity: the detector can see an export');
});

test('both forms load the cart model, and neither still filters the cart out of MENU', () => {
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const html = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    assert.ok(html.includes('<script src="form-cart.js"></script>'), `${dir}: form-cart.js is not loaded`);
    // 🔴 THE CENSUS. Task 4's whole claim is that no cart read is menu-derived any more. Code only —
    // the comments in both forms quote the old expression to explain what was wrong with it, and a
    // census that counted its own explanation would report a violation forever (or, worse, be
    // "fixed" by deleting the explanation).
    // BLOCK comments stripped before line comments — the first version of this filtered only on a
    // line's leading token, so the middle lines of the /* … */ header (which quotes the old expression
    // to explain what was wrong with it) still counted, and the census reported a violation against
    // its own documentation. Same failure as the `export`-in-a-comment one, one file over.
    const code = html.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const menuDerived = code.match(/MENU\.(filter|reduce|some|every)\([^\n]{0,90}?qty\[/g) || [];
    assert.deepStrictEqual(menuDerived, [], `${dir}: a cart read is still derived from MENU: ${menuDerived.join(' | ')}`);
    // non-vacuity: the detector really fires on the shipped expression it is looking for
    assert.strictEqual((`const items=MENU.filter(p=>qty[p.id]>0);`.match(/MENU\.(filter|reduce|some|every)\([^\n]{0,90}?qty\[/g) || []).length, 1,
      'non-vacuity: the census can see the old expression');
  }
});
