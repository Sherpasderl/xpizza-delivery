import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

// §6.2 read-only invariant: the bundled SDK is the ONLY thing allowed to write, and the app performs
// exactly ONE logical mutation — the (re)assignment — realized via the two DESKTOP-AUTHORITATIVE SDK
// entrypoints (spec §6.1 named assignOrderToDriver; faithfully reproducing the desktop's behavior for
// an already-assigned order additionally requires reassignOrder — see the Task-8 write comment). No
// other RTDB write-family call may appear in index.html; the SDK's own internal writes are the
// byte-identical desktop code (parity.test) and out of this file's scope.
test('exactly one mutation site: a single assignOrderToDriver + a single reassignOrder, no other writes', () => {
  const forbidden = [/XPD\.(set|update|remove|push|runTransaction|acceptTask|completeTask|cancel)/,
                     /\bref\s*\(/, /\bset\s*\(\s*ref/, /\bupdate\s*\(\s*ref/];
  for (const re of forbidden) assert.ok(!re.test(html), `unexpected write-ish call: ${re}`);
  const assigns   = (html.match(/XPD\.assignOrderToDriver\s*\(/g) || []).length;
  const reassigns = (html.match(/XPD\.reassignOrder\s*\(/g) || []).length;
  assert.equal(assigns, 1, `expected exactly 1 assignOrderToDriver call, found ${assigns}`);
  assert.equal(reassigns, 1, `expected exactly 1 reassignOrder call, found ${reassigns}`);
});
