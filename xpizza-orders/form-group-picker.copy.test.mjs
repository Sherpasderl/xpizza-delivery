// 1D add-product B — COPY INTEGRITY for the shared required-choice picker. Run: node --test xpizza-orders/form-group-picker.copy.test.mjs
// In its own file for the same reason as the other copy tests: a mutation of the canonical copy must reach a BEHAVIOURAL
// assertion, not be "killed" by the copies merely differing.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('the la_musa copy of the group picker is byte-identical to the canonical one', () => {
  const canonical = readFileSync(new URL('./form-group-picker.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../la-musa-orders/form-group-picker.js', import.meta.url), 'utf8');
  assert.strictEqual(copy, canonical, 'la-musa-orders/form-group-picker.js has drifted — copy xpizza-orders/form-group-picker.js over it');
  assert.ok(canonical.includes('function choiceRowsHtml') && canonical.includes('GROUP_PICKER_V1'), 'non-vacuity: the file really is the group picker');
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code), 'no ESM syntax — the same bytes load in Node and as a classic script');
  assert.ok(/module\.exports/.test(code) && /window\.GroupPicker/.test(code), '...and it publishes itself to BOTH worlds');
});

test('the forms that render groups load the shared picker BEFORE their own code', () => {
  for (const dir of ['la-musa-orders']) {
    const html = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    const tag = html.indexOf('<script src="form-group-picker.js"></script>');
    assert.ok(tag > 0, `${dir} loads form-group-picker.js`);
    assert.ok(tag < html.indexOf('function itemIsLauncher'), `${dir}: the picker loads before the form code that calls it`);
  }
});
