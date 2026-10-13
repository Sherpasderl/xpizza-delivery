// xpizza-dispatch/dispatch-driver-deactivated.test.js
/* Executes the REAL alertContent renderer against the REAL payload the sweeper's §5 monitor emits
   (xpizza-functions/index.js: type 'driver_deactivated' + driver_uid/driver_name/order_ids/open_shift/shift_id).
   codex r1 P1-8: the alert must identify the driver + the affected work and name the action, not fall through
   the humanised unknown-type fallback. Lifts alertContent + displayOrderLabel out of index.html. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

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
function build(allOrders, allDrivers) {
  // eslint-disable-next-line no-new-func
  return new Function('escapeHtml', 'allOrders', 'allDrivers', `${lift('displayOrderLabel')}; ${lift('alertContent')}; return alertContent;`)(escapeHtml, allOrders, allDrivers);
}

// The payload the §5 monitor writes (index.js).
const alert = { type: 'driver_deactivated', driver_uid: 'D1', driver_name: 'Gabriel', order_ids: ['PZX123', 'PZY456'], open_shift: true, shift_id: 's1', created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 };

{
  const out = build({ PZX123: { display_number: 42 } }, { D1: { name: 'Gabriel' } })(alert);
  assert.notStrictEqual(out.title, 'Alerta', '🔴 the alert fell through the unknown-type fallback — no driver, no work, no action');
  assert.match(out.title, /Repartidor desactivado/, 'the title names the situation in Spanish');
  assert.match(out.detail, /Gabriel/, '🔴 the driver is not identified — a dispatcher cannot act on a nameless alert');
  assert.match(out.detail, /#42/, '🔴 the affected order is not identified by the number the dispatcher recognises');
  assert.match(out.detail, /sigue en turno|turno/, 'notes the open shift');
  assert.match(out.detail, /Reasignar/, '🔴 the instruction is missing — naming the action is the point');
  assert.doesNotMatch(out.detail, /undefined|\[object Object\]/, 'no placeholder leaked into the copy');
  ok('driver_deactivated renders the driver + affected orders (#display) + shift + the Reasignar action');
}
{
  // driver_name absent → fall back to the live drivers map; no orders/shift → a readable generic line, still actionable.
  const out = build({}, { D1: { name: 'Elmer' } })({ type: 'driver_deactivated', driver_uid: 'D1', order_ids: [], open_shift: false });
  assert.match(out.detail, /Elmer/, 'falls back to the live driver name when the alert omits it');
  assert.match(out.detail, /trabajo activo/, 'a readable generic line when there are no specifics');
  assert.match(out.detail, /Reasignar/, 'still names the action');
  assert.doesNotMatch(out.detail, /undefined/, 'no "undefined" on screen');
  ok('degrades gracefully with no driver_name and no specifics, staying actionable');
}

console.log(`\nAll ${pass} driver-deactivated render tests passed.`);
