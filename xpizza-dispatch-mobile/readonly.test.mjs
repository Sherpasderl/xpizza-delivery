import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

// §6.2 read-only invariant (Phase 2a + the "Quitar repartidor" slice): the PWA performs EXACTLY THREE mutations —
//   (1) assignment, via XPD.assignOrderToDriver;
//   (2) reassignment, via XPD.reassignOrder;
//   (3) unassignment ("Quitar repartidor"), via the XPD.unassignOrder callable (order → unassigned queue);
//   all three are desktop-authoritative SDK entrypoints, each its own ops-gate, and
//   (+) the user's OWN push subscription: a single direct set(ref(getDb(), `staff_push/<uid>`)).
// Nothing else may write. unassignOrder is an ASSIGN-FAMILY action (the order stays open) — NOT a cancel; the
// cancel ban and the raw-write ban are unchanged. The bundled SDK's internal writes are byte-identical desktop
// code (parity.test) and out of this file's scope.
test('exactly three mutation sites: 1 assign + 1 reassign + 1 unassign + 1 own staff_push write, nothing else', () => {
  const assigns   = (html.match(/XPD\.assignOrderToDriver\s*\(/g) || []).length;
  const reassigns = (html.match(/XPD\.reassignOrder\s*\(/g) || []).length;
  const unassigns = (html.match(/XPD\.unassignOrder\s*\(/g) || []).length;
  assert.equal(assigns, 1, `expected exactly 1 assignOrderToDriver call, found ${assigns}`);
  assert.equal(reassigns, 1, `expected exactly 1 reassignOrder call, found ${reassigns}`);
  assert.equal(unassigns, 1, `expected exactly 1 unassignOrder call, found ${unassigns}`);
  // (4) dismiss a dispatcher alert (driver_problem), via XPD.dismissDispatcherAlert — removal only, exactly once.
  const dismisses = (html.match(/XPD\.dismissDispatcherAlert\s*\(/g) || []).length;
  assert.equal(dismisses, 1, `expected exactly 1 dismissDispatcherAlert call, found ${dismisses}`);
  // the ONLY sanctioned direct RTDB write: set(ref(XPD.getDb(), `staff_push/${uid}`), …)
  const staffPushWrites = (html.match(/set\(\s*ref\(\s*XPD\.getDb\(\)\s*,\s*`staff_push\//g) || []).length;
  assert.equal(staffPushWrites, 1, `expected exactly 1 staff_push write, found ${staffPushWrites}`);
  // no OTHER writes: no XPD write helpers (cancel included), and the staff_push set() is the ONLY set/update/remove(ref(…)).
  assert.ok(!/XPD\.(set|update|remove|push|runTransaction|setOrderStatus|cancel)/.test(html), 'unexpected XPD write helper');
  const otherSet = (html.match(/\b(set|update|remove)\s*\(\s*ref\(/g) || []).length;
  assert.equal(otherSet, 1, `only the staff_push set may write; found ${otherSet} ref-writes`);
});

// Access validation (codex P2-3): counting literal `XPD.foo(` is not enough — bracket access and aliasing bypass
// it. Every reference to a mutation method must be a DIRECT dotted call at an approved site. `accessViolations`
// is pure so the three documented bypasses can be driven as sensitivity cells (not just asserted on index.html).
const MUTATIONS = ['assignOrderToDriver', 'reassignOrder', 'unassignOrder', 'dismissDispatcherAlert'];
function accessViolations(src) {
  const v = [];
  // (a) no computed/bracket access to the SDK object — hides XPD["unassignOrder"](…) and XPD["cancel…"](…)
  if (/\bXPD\s*\[/.test(src)) v.push('computed/bracket access to XPD');
  // (b) no destructuring or whole-object aliasing of XPD
  if (/(?:const|let|var)\s*\{[^}]*\}\s*=\s*XPD\b/.test(src)) v.push('destructuring XPD');
  if (/(?:const|let|var)\s+\w+\s*=\s*XPD\s*;/.test(src)) v.push('aliasing the XPD object');
  // (c) no method aliasing: `const release = XPD.unassignOrder` (+ the cancel family) — and every mutation
  //     reference must be immediately a call (refs === calls), so a bare `XPD.unassignOrder` without `(` fails.
  if (/(?:const|let|var)\s+\w+\s*=\s*XPD\.(assignOrderToDriver|reassignOrder|unassignOrder|dismissDispatcherAlert|cancel\w*)\b/.test(src))
    v.push('aliasing an XPD mutation method');
  for (const m of MUTATIONS) {
    const refs  = (src.match(new RegExp(`XPD\\.${m}\\b`, 'g')) || []).length;
    const calls = (src.match(new RegExp(`XPD\\.${m}\\s*\\(`, 'g')) || []).length;
    if (refs !== calls) v.push(`${m} referenced without calling (alias): ${refs} refs vs ${calls} calls`);
  }
  return v;
}

test('mutation access is direct-call-only in index.html (no bracket/alias bypass)', () => {
  assert.deepEqual(accessViolations(html), [], 'index.html must reference mutations only as direct dotted calls');
});

test('sensitivity: the documented access bypasses are rejected; a clean direct call is not', () => {
  // codex's three bypasses — each MUST produce a violation:
  assert.ok(accessViolations('XPD["unassignOrder"](otherId, otherDriver);').length > 0, 'bracket access must fail');
  assert.ok(accessViolations('const release = XPD.unassignOrder;\nrelease(otherId, otherDriver);').length > 0, 'method aliasing must fail');
  assert.ok(accessViolations('XPD["cancelOrder"](x);').length > 0, 'bracket-notation cancel must fail');
  // whole-object alias + destructure also fail:
  assert.ok(accessViolations('const s = XPD;\ns.unassignOrder(x, y);').length > 0, 'object aliasing must fail');
  assert.ok(accessViolations('const { unassignOrder } = XPD;\nunassignOrder(x, y);').length > 0, 'destructuring must fail');
  // a clean single direct call is NOT a violation:
  assert.deepEqual(accessViolations('await XPD.unassignOrder(orderId, pickerFromDriver);'), [], 'a direct call is allowed');
});
