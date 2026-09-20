// xpizza-dispatch/dispatch-paid-after-close.test.js
/* 🔴 EXECUTES THE REAL RENDERER AGAINST THE REAL EMITTER'S PAYLOAD.
 *
 * The paid-after-close alert is an INSTRUCTION — it tells a dispatcher which order to refund and
 * which button to press — and it reached nobody TWICE. First it fell through the unknown-kind
 * fallback and rendered "Alerta — paid after close manual refund required": English, no order
 * number, no action. Then a fix matched the UNPREFIXED kind and read top-level ids, while
 * paymentAlert (xpizza-functions/index.js) emits `payment_${kind}` with everything nested under
 * `detail` — so it fell through the SAME fallback and still said nothing. Both times the diff read
 * correctly and nobody ran it.
 *
 * All nine existing dispatch suites pass and none of them touch these inline renders, so "the suites
 * are green" proved nothing about the thing that changed. This one lifts alertContent out of
 * index.html and calls it with a payload built the way the emitter builds it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// Lift the real function out of the page by brace-matching, so this tests the shipped source.
const at = html.indexOf('function alertContent(a) {');
assert.notStrictEqual(at, -1, 'premise — alertContent must be findable in index.html');
let i = html.indexOf('{', at), depth = 0, end = i;
for (; end < html.length; end++) {
  if (html[end] === '{') depth++;
  else if (html[end] === '}') { depth--; if (!depth) break; }
}
const src = html.slice(at, end + 1);
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const displayOrderLabel = (id) => String(id == null ? '—' : id);
// eslint-disable-next-line no-new-func
const alertContent = new Function('escapeHtml', 'displayOrderLabel', `${src}; return alertContent;`)(escapeHtml, displayOrderLabel);

/* Built the way xpizza-functions/index.js paymentAlert writes it: type is `payment_` + the kind the
   server passed, and every field the server sent is nested under `detail`. Getting either of those
   wrong is exactly how this alert has failed twice. */
const realAlert = {
  type: 'payment_paid_after_close_manual_refund_required',
  detail: {
    orderId: 'PZX123',
    order_id: 'PZX123',
    restaurant_id: 'x_pizza',
    missing: ['voidOrRefund'],
    action: 'Reembolsar el pedido desde la cola de Pedidos — el reembolso automático no está disponible en esta ruta',
  },
  created_at: 1_700_000_000_000,
};

{
  const out = alertContent(realAlert);
  assert.notStrictEqual(out.title, 'Alerta',
    '🔴 the alert fell through the unknown-kind fallback — the dispatcher sees a humanised English type with no instruction');
  assert.match(out.title, /Reembolso manual requerido/, 'the title names the situation in Spanish');
  assert.match(out.detail, /PZX123/,
    '🔴 the order number is missing — a dispatcher cannot act on an alert that does not say WHICH order');
  assert.match(out.detail, /Reembolsar/,
    '🔴 the instruction is missing — naming the button is the entire point of this alert');
  assert.doesNotMatch(out.detail, /undefined|\[object Object\]/, 'no placeholder leaked into the copy');
  ok('the REAL emitter payload renders with the order number and the Reembolsar instruction');
}

{
  // The unprefixed kind must NOT be what we match on: that was the second failure.
  const unprefixed = { ...realAlert, type: 'paid_after_close_manual_refund_required' };
  const out = alertContent(unprefixed);
  assert.strictEqual(out.title, 'Alerta',
    'an UNPREFIXED kind is not what the server emits; if this ever renders, the match is keyed on the wrong string');
  ok('the match is keyed on the prefixed kind the server actually emits, not the bare one');
}

{
  // A missing detail must degrade to a readable line, never "undefined".
  const out = alertContent({ type: 'payment_paid_after_close_manual_refund_required' });
  assert.match(out.title, /Reembolso manual requerido/);
  assert.doesNotMatch(out.detail, /undefined/, 'a missing detail must not print "undefined" to a dispatcher');
  ok('a payload with no detail still renders a readable instruction');
}

console.log(`\nAll ${pass} paid-after-close render tests passed.`);
