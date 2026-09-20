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

/* Lift the real functions out of the page by brace-matching, so this tests the shipped source.
   🔴 BOTH of them. The first version of this cell stubbed displayOrderLabel with an identity
   function and then asserted "the full order id renders" — a claim about the stub, not the screen.
   That is the very class of error this file exists to catch: the diff read right, the real thing did
   something else. The REAL formatter renders a per-restaurant display number (#42) when one exists
   and otherwise the last four characters of the id (#X123), which is what a dispatcher actually uses
   and what the alert therefore shows. */
function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  assert.notStrictEqual(at, -1, `premise — ${name} must be findable in index.html`);
  let i = html.indexOf('{', at), depth = 0, end = i;
  for (; end < html.length; end++) {
    if (html[end] === '{') depth++;
    else if (html[end] === '}') { depth--; if (!depth) break; }
  }
  return html.slice(at, end + 1);
}

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// `allOrders` is the page's own order map, which the real formatter consults for a display number.
function build(allOrders) {
  // eslint-disable-next-line no-new-func
  return new Function('escapeHtml', 'allOrders', `${lift('displayOrderLabel')}; ${lift('alertContent')}; return alertContent;`)(escapeHtml, allOrders);
}

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
  /* No display number known → the real formatter shows the last four of the id. */
  const out = build({})(realAlert);
  assert.notStrictEqual(out.title, 'Alerta',
    '🔴 the alert fell through the unknown-kind fallback — the dispatcher sees a humanised English type with no instruction');
  assert.match(out.title, /Reembolso manual requerido/, 'the title names the situation in Spanish');
  assert.match(out.detail, /#X123/,
    '🔴 the order is not identified — a dispatcher cannot act on an alert that does not say WHICH order');
  assert.match(out.detail, /Reembolsar/,
    '🔴 the instruction is missing — naming the button is the entire point of this alert');
  assert.doesNotMatch(out.detail, /undefined|\[object Object\]/, 'no placeholder leaked into the copy');
  ok('the REAL renderer and REAL formatter show the order as #X123 with the Reembolsar instruction');
}

{
  /* 🔴 WHAT A DISPATCHER ACTUALLY SEES when the order has a display number: "#42", the per-restaurant
     daily number they use on the floor — not the internal id. Asserted against the real formatter so
     the deploy note can state it truthfully. */
  const out = build({ PZX123: { display_number: 42 } })(realAlert);
  assert.match(out.detail, /#42/, 'the alert shows the display number the dispatcher recognises');
  assert.doesNotMatch(out.detail, /PZX123/, 'and not the internal id, which would be worse on screen');
  assert.match(out.detail, /Reembolsar/, 'with the instruction intact');
  ok('with a display number, the alert identifies the order as #42 — the number dispatchers use');
}

{
  // The unprefixed kind must NOT be what we match on: that was the second failure.
  const out = build({})({ ...realAlert, type: 'paid_after_close_manual_refund_required' });
  assert.strictEqual(out.title, 'Alerta',
    'an UNPREFIXED kind is not what the server emits; if this ever renders, the match is keyed on the wrong string');
  ok('the match is keyed on the prefixed kind the server actually emits, not the bare one');
}

{
  // A missing detail must degrade to a readable line, never "undefined".
  const out = build({})({ type: 'payment_paid_after_close_manual_refund_required' });
  assert.match(out.title, /Reembolso manual requerido/);
  assert.doesNotMatch(out.detail, /undefined/, 'a missing detail must not print "undefined" to a dispatcher');
  ok('a payload with no detail still renders a readable instruction');
}

console.log(`\nAll ${pass} paid-after-close render tests passed.`);
