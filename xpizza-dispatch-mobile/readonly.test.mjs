import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

// §6.2 read-only invariant (Phase 2a): the PWA performs EXACTLY TWO mutations —
//   (1) the (re)assignment, via the two desktop-authoritative SDK entrypoints (assignOrderToDriver +
//       reassignOrder — see the Task-8 write comment); still its own ops-gate, and
//   (2) the user's OWN push subscription: a single direct set(ref(getDb(), `staff_push/<uid>`)).
// Nothing else may write. The bundled SDK's internal writes are the byte-identical desktop code
// (parity.test) and out of this file's scope.
test('exactly two mutation sites: 1 assign + 1 reassign + 1 own staff_push write, nothing else', () => {
  const assigns   = (html.match(/XPD\.assignOrderToDriver\s*\(/g) || []).length;
  const reassigns = (html.match(/XPD\.reassignOrder\s*\(/g) || []).length;
  assert.equal(assigns, 1, `expected exactly 1 assignOrderToDriver call, found ${assigns}`);
  assert.equal(reassigns, 1, `expected exactly 1 reassignOrder call, found ${reassigns}`);
  // the ONLY sanctioned direct RTDB write: set(ref(XPD.getDb(), `staff_push/${uid}`), …)
  const staffPushWrites = (html.match(/set\(\s*ref\(\s*XPD\.getDb\(\)\s*,\s*`staff_push\//g) || []).length;
  assert.equal(staffPushWrites, 1, `expected exactly 1 staff_push write, found ${staffPushWrites}`);
  // no OTHER writes: no XPD write helpers, and the staff_push set() is the ONLY set/update/remove(ref(…)).
  assert.ok(!/XPD\.(set|update|remove|push|runTransaction|setOrderStatus|cancel)/.test(html), 'unexpected XPD write helper');
  const otherSet = (html.match(/\b(set|update|remove)\s*\(\s*ref\(/g) || []).length;
  assert.equal(otherSet, 1, `only the staff_push set may write; found ${otherSet} ref-writes`);
});
