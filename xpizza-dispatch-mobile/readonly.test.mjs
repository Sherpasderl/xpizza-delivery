import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

// §6.2 read-only invariant: the bundled SDK is the ONLY thing allowed to write, and the app may
// only invoke the sanctioned (re)assignment path(s). This test grows with the app; at Task 5 there
// is NO write yet (the reassign write lands in Task 8, which tightens the assertion to exactly one
// of each sanctioned call).
test('index.html calls no RTDB write helpers other than the single reassign', () => {
  const forbidden = [/XPD\.(set|update|remove|push|runTransaction|acceptTask|completeTask|cancel)/,
                     /\bref\s*\(/, /\bset\s*\(\s*ref/, /\bupdate\s*\(\s*ref/];
  for (const re of forbidden) assert.ok(!re.test(html), `unexpected write-ish call: ${re}`);
  const assigns = (html.match(/XPD\.assignOrderToDriver\s*\(/g) || []).length;
  assert.ok(assigns <= 1, `expected ≤1 assignOrderToDriver call, found ${assigns}`);
});
