// xpizza-dispatch/dispatch-polish-styledconfirm-adoption.test.js
//
// Polish §6 — the last three native window.confirm() dialogs in the dispatch board move to the generic
// styledConfirm: «Cancelar pedido», «Sacar de turno», and the three assign-override confirms. No logic
// change (the money-safe cancel + the off-shift call are untouched); only the confirm presentation + the
// owner-approved copy. The cascade's exact messages/priority stay frozen in dispatch-picker-a11y.test.js.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const fnSrc = (name) => {
  const s = html.indexOf(`function ${name}(`);
  return s < 0 ? null : html.slice(s, html.indexOf('\n}', s) + 2);
};
const noNativeConfirm = (src) => !/[^A-Za-z.]confirm\(/.test(src.replace(/\/\/[^\n]*/g, ''));   // ignore // comments

// «no native confirm() anywhere» — none of the three functions calls window.confirm any more.
{
  for (const nm of ['confirmCancelOrder', 'forceOffShift', 'confirmAssignOverride']) {
    const src = fnSrc(nm);
    assert.ok(src, `${nm} present`);
    assert.ok(noNativeConfirm(src), `${nm} no longer calls native confirm()`);
    assert.ok(src.includes('styledConfirm('), `${nm} uses styledConfirm`);
  }
  ok('Cancelar pedido / Sacar de turno / assign-override all use styledConfirm — no native confirm() left');
}

// Cancelar pedido — new copy + the money logic preserved verbatim inside onConfirm.
{
  const src = fnSrc('confirmCancelOrder');
  assert.ok(src.includes("title: 'Cancelar pedido'"), 'title');
  assert.ok(src.includes('Vas a cancelar el pedido ${displayOrderLabel(orderId)} de ${o.customer_name'), 'approved cancel body (template)');
  assert.ok(src.includes("confirmLabel: 'Cancelar pedido'") && src.includes("cancelLabel: 'Volver'"), '«Cancelar pedido» / «Volver» (no «Cancelar» collision)');
  assert.ok(src.includes("busyLabel: 'Cancelando…'"), 'busy «Cancelando…»');
  // money logic intact: the cancelInFlight latch + the money-safe server call + its outcome mapping
  assert.ok(src.includes('cancelInFlight.add(orderId)') && src.includes('cancelInFlight.delete(orderId)'), 'cancelInFlight latch preserved');
  assert.ok(src.includes("XPD.cancelOrderRemote(orderId, 'Cancelado por dispatcher')"), 'money-safe cancelOrderRemote preserved');
  assert.ok(src.includes("refund === 'refunded'") && src.includes("refund === 'refund_pending'") && src.includes('e.outcome'), 'the exact refund/outcome mapping preserved');
  ok('«Cancelar pedido»: styledConfirm + approved copy; the money-safe cancel logic is untouched inside onConfirm');
}

// Sacar de turno — the honest clause (verified: endShift does not reassign) + busy label + active-count sub.
{
  const src = fnSrc('forceOffShift');
  assert.ok(src.includes("title: 'Sacar de turno'"), 'title');
  assert.ok(src.includes('no se reasigna solo: queda con este repartidor, reasignalo vos.'), 'the honest off-shift clause is in the body');
  assert.ok(src.includes("confirmLabel: 'Sacar de turno'") && src.includes("cancelLabel: 'Cancelar'"), '«Sacar de turno» / «Cancelar»');
  assert.ok(src.includes("busyLabel: 'Sacando de turno…'"), 'busy «Sacando de turno…»');
  assert.ok(src.includes('pedido activo') && src.includes('pedidos activos'), 'the sub counts active orders (singular/plural)');
  assert.ok(src.includes('XPD.endShift(uid)'), 'the off-shift call is unchanged');
  ok('«Sacar de turno»: styledConfirm + honest clause + active-count sub; endShift unchanged');
}

// assign-override — async, «Asignar igual», driver-name title. (Exact messages/priority: picker-a11y freeze.)
{
  const src = fnSrc('confirmAssignOverride');
  assert.ok(/async function confirmAssignOverride/.test(html), 'confirmAssignOverride is async now');
  assert.ok(src.includes("confirmLabel: 'Asignar igual'"), '«Asignar igual» override label');
  assert.ok(src.includes('driverName || ') && src.includes('title'), 'the driver name titles the confirm');
  ok('assign-override cascade on styledConfirm («Asignar igual»); both call sites await it (picker rows + «A mí»)');
}

console.log(`dispatch-polish-styledconfirm-adoption: OK (${n})`);
