// Portal 1B Task 3 — COPY INTEGRITY for the shared coordinator.
// Run: node --test xpizza-orders/form-live-menu.copy.test.mjs
//
// 🔴 IN ITS OWN FILE, AND THIS IS NOT TIDINESS. The mutation sweep mutates the CANONICAL copy and
// runs a suite; while this assertion lived beside the behavioural tests, every single mutant tripped
// it — so every mutant was "killed" by the copies differing, and not one of them ever reached a
// behavioural test. The slice reported 13/13 and proved nothing at all.
//
// That is the same failure as a check whose failure looks like its success. Separated, so a kill in
// the behavioural suite means the BEHAVIOUR noticed; this file still runs in npm test, where its job
// — catching a hand-edit to one copy — is exactly right.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('the la_musa copy is byte-identical to the canonical one', () => {
  // 🔴 THE SAME DISCIPLINE avail-key.js CARRIES, AND FOR THE SAME REASON. Two copies of a rule that
  // decides what a customer sees is two rules the moment one is edited — and the drift would show up
  // as one brand behaving correctly and the other not, on a code path nobody thinks of as shared.
  // The forms have no build step, so a copy is the only way to share; a test is the only way to keep
  // it honest.
  const canonical = readFileSync(new URL('./form-live-menu.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../la-musa-orders/form-live-menu.js', import.meta.url), 'utf8');
  assert.strictEqual(copy, canonical,
    'la-musa-orders/form-live-menu.js has drifted — copy xpizza-orders/form-live-menu.js over it');
  assert.ok(canonical.includes('function createLiveMenu'), 'non-vacuity: the file really is the coordinator');
  // COMMENT-STRIPPED. The first version of this matched the word `export` inside the file's own
  // comment explaining that it uses no `export` keyword — a guard reading its own documentation as
  // evidence, which is the failure this repo's other censuses already carry warnings about. Checked
  // against ESM syntax at the start of a line, in code only.
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code),
    'no ESM syntax — the same bytes must load as a Node module AND a classic browser script');
  assert.ok(/module\.exports/.test(code) && /window\.createLiveMenu/.test(code),
    '...and it must publish itself to BOTH worlds');
  // non-vacuity: the detector really fires on ESM
  assert.ok(/^\s*export[\s{]/m.test('export function x() {}'), 'the detector can see an export');
});
