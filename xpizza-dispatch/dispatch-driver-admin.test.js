// xpizza-dispatch/dispatch-driver-admin.test.js
/* Executes the REAL S1b "Administrar repartidores" pure helpers lifted out of index.html (same lift pattern as
   dispatch-driver-deactivated.test.js). Covers: state precedence, per-row action mapping, void/unknown rows carry
   NO destructive action, the cash-attest display (unavailable ≠ "L 0.00", never auto-satisfies), the deactivate
   blockers (checkbox-gated), latest-cuadre selection, filter/counts, and XSS-escaping of driver-supplied text.
   Pure-logic (node-only, deterministic) — the shipped functions are the ones under test. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${++pass} ${n}`); };

function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  assert.notStrictEqual(at, -1, `premise — ${name} must be findable in index.html`);
  let i = html.indexOf('{', at), depth = 0, end = i;
  for (; end < html.length; end++) { if (html[end] === '{') depth++; else if (html[end] === '}') { depth--; if (!depth) break; } }
  return html.slice(at, end + 1);
}
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAMES = ['deriveDriverAcctState', 'driverRowActions', 'driverAcctStatePill', 'driverAcctDisplayName', 'driverAcctMeta', 'latestCuadre', 'cashAttestDisplay', 'deactivateBlockers', 'deactivateReasonLabel', 'driverAcctRowHtml', 'driverAcctCounts', 'driverAcctMatchesFilter'];
const src = NAMES.map(lift).join('\n');
// eslint-disable-next-line no-new-func
const H = new Function('escapeHtml', `${src}\nreturn { ${NAMES.join(', ')} };`)(escapeHtml);

// ── 1. state precedence (deactivated > suspended > onboarding > active; void; unknown) ──
assert.strictEqual(H.deriveDriverAcctState({ enabled: true, onboarding_state: 'active' }), 'active');
assert.strictEqual(H.deriveDriverAcctState({ enabled: false, onboarding_state: 'active', approved_at: 1 }), 'suspended');
assert.strictEqual(H.deriveDriverAcctState({ enabled: false, onboarding_state: 'active', grandfathered: true }), 'suspended', 'grandfathered counts as previously-approved for suspended');
assert.strictEqual(H.deriveDriverAcctState({ enabled: true, deactivated: true, onboarding_state: 'active' }), 'deactivated', 'deactivated beats enabled/active');
assert.strictEqual(H.deriveDriverAcctState({ enabled: false, onboarding_state: 'pending' }), 'pending');
assert.strictEqual(H.deriveDriverAcctState({ enabled: false, onboarding_state: 'profile_submitted' }), 'profile_submitted');
assert.strictEqual(H.deriveDriverAcctState({ onboarding_state: 'void' }), 'void');
assert.strictEqual(H.deriveDriverAcctState({ enabled: false, onboarding_state: 'active' }), 'unknown', 'suspended WITHOUT prior approval is not a clean suspended → unknown');
assert.strictEqual(H.deriveDriverAcctState(null), 'unknown');
assert.strictEqual(H.deriveDriverAcctState({ foo: 1 }), 'unknown');
ok('state precedence incl. grandfathered-suspended, void, and malformed→unknown');

// ── 2. per-row action mapping ──
assert.deepStrictEqual(H.driverRowActions('active'), ['suspend', 'deactivate']);
assert.deepStrictEqual(H.driverRowActions('profile_submitted'), ['approve']);
assert.deepStrictEqual(H.driverRowActions('pending'), ['reinvite']);
assert.deepStrictEqual(H.driverRowActions('suspended'), ['reactivate', 'deactivate']);
assert.deepStrictEqual(H.driverRowActions('deactivated'), ['reactivate']);
assert.deepStrictEqual(H.driverRowActions('void'), []);
assert.deepStrictEqual(H.driverRowActions('unknown'), []);
ok('row action mapping per state');

// ── 3. void/unknown rows carry NO destructive action in the rendered HTML ──
for (const rec of [{ onboarding_state: 'void' }, { foo: 1 }, null]) {
  const row = H.driverAcctRowHtml('u1', rec, null);
  assert.ok(!/data-act=/.test(row), 'void/unknown row has no action control at all');
  assert.ok(!/data-act="(suspend|deactivate)"/.test(row), 'no destructive control on void/unknown');
}
{
  const activeRow = H.driverAcctRowHtml('u1', { enabled: true, onboarding_state: 'active' }, null);
  assert.ok(/data-act="suspend"/.test(activeRow) && /data-act="deactivate"/.test(activeRow), 'active row offers suspend + deactivate');
}
ok('void/unknown rows render no destructive actions; active row does');

// ── 4. cash-attest display: unavailable is NEVER a clean L 0.00, and never auto-satisfies ──
assert.deepStrictEqual(H.cashAttestDisplay(null, { __error: true }).available, false);
assert.strictEqual(H.cashAttestDisplay(null, { __error: true }).text, 'Cuadre no disponible');
const absent = H.cashAttestDisplay(null, null);
assert.strictEqual(absent.available, false);
assert.ok(!/L\s*0/.test(absent.text), 'absent cuadre is NOT rendered as L 0.00');
const malformed = H.cashAttestDisplay({ cash_owed: 'x', closed_at: 1 }, null);
assert.strictEqual(malformed.available, false); assert.strictEqual(malformed.text, 'Cuadre no disponible');
const finalC = H.cashAttestDisplay({ cash_owed: 0, closed_at: Date.now(), provisional: false }, null);
assert.strictEqual(finalC.available, true); assert.ok(/L 0/.test(finalC.text), 'a GENUINE final zero cuadre may show L 0');
const provC = H.cashAttestDisplay({ cash_owed: 150, closed_at: Date.now(), provisional: true }, null);
assert.ok(/provisional/.test(provC.text));
ok('cash display: error/absent/malformed → "no disponible" (never L 0.00); genuine final → L figure');

// ── 5. deactivate blockers are gated by the CHECKBOX, independent of the (informational) cash figure ──
assert.deepStrictEqual(H.deactivateBlockers({ openShift: false, openOrders: [], cashAttested: true }), []);
assert.deepStrictEqual(H.deactivateBlockers({ openShift: false, openOrders: [], cashAttested: false }), ['cash'], 'no checkbox ⇒ cash blocker even when nothing else is wrong');
assert.deepStrictEqual(H.deactivateBlockers({ openShift: true, openOrders: ['o1'], cashAttested: false }).sort(), ['cash', 'open_shift', 'open_tasks']);
// a cuadre being "unavailable" must not satisfy the precondition on its own — only the checkbox clears 'cash'
assert.deepStrictEqual(H.deactivateBlockers({ openShift: false, openOrders: [], cashAttested: undefined }), ['cash']);
ok('deactivate blockers are checkbox-gated; unavailable cash never auto-satisfies');

// ── 6. latest cuadre selection by closed_at ──
assert.strictEqual(H.latestCuadre({ s1: { cuadre: { closed_at: 10, cash_owed: 1 } }, s2: { cuadre: { closed_at: 20, cash_owed: 2 } } }).cash_owed, 2);
assert.strictEqual(H.latestCuadre({}), null);
assert.strictEqual(H.latestCuadre(null), null);
ok('latestCuadre picks the most recent closed cuadre');

// ── 7. counts + filter ──
const recs = { a: { enabled: true, onboarding_state: 'active' }, b: { enabled: false, onboarding_state: 'pending' }, c: { deactivated: true, onboarding_state: 'active' }, d: { enabled: false, onboarding_state: 'active', approved_at: 1 } };
assert.deepStrictEqual(H.driverAcctCounts(recs), { all: 4, pending: 1, active: 1, suspended: 1, deactivated: 1 });
assert.ok(H.driverAcctMatchesFilter('profile_submitted', 'pending'), 'profile_submitted is under the Pendientes filter');
assert.ok(!H.driverAcctMatchesFilter('active', 'suspended'));
ok('counts + filter matching');

// ── 8. XSS: driver-supplied name is escaped in the row ──
{
  const row = H.driverAcctRowHtml('u1', { enabled: true, onboarding_state: 'active', profile: { name: '<img src=x onerror=alert(1)>' } }, null);
  assert.ok(!/<img/.test(row), 'driver-supplied name must be escaped');
  assert.ok(/&lt;img/.test(row), 'escaped form present');
}
ok('driver-supplied text is escaped (no raw HTML injected)');

console.log(`\nAll ${pass} driver-admin render/logic tests passed.`);
