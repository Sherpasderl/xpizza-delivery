// S5 §3.3 / §6 — the confirmation's PRE-CHANGE goldens, captured on the base before s5 is restructured. Run:
//   node s5-baseline.golden.test.mjs [--write]
// Both REAL pages (form-harness) run today's showSuccess() for a fixed order matrix; what S5 must PRESERVE is recorded:
//   - the rewards card (#acct-success-rewards: class + markup) for guest and member, redeemed or not;
//   - the CLAIM GOLDEN: the exact context the guest CTA hands openLoginSheet ({phone, name, order_id, n, unit, order_type,
//     address fields, lat, lng}) — captured with a recording probe on openLoginSheet's entry (the only transform);
//   - the receipt blocks (#receipt-items, #receipt-payment);
//   - SCHEDULED confirmations: the scheduled-slot message (#success-sub) and the hidden number line, byte-for-byte.
// After the build the same capture must equal this file (the element MOVES; its contents do not change).
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { counter, settle, stageSettle, envelope, loadForm, res, BRAND, closeAll } from './form-harness.mjs';

const { ok, count } = counter();
const WATCHDOG = setTimeout(() => { console.error('s5-baseline.golden: FAILED — watchdog'); process.exit(1); }, 300000);
const GOLDEN = new URL('./s5-baseline.golden.json', import.meta.url);
const MARK = { 'xpizza-orders': 'xpizza_acct', 'la-musa-orders': 'lamusa_acct' };
const PROBE = {
  'account.js': (code) => {
    const at = 'function openLoginSheet(prefill) {';
    assert.strictEqual(code.split(at).length, 2, 'premise: one openLoginSheet definition');
    return code.replace(at, `${at} try { (window.__claimSpy = window.__claimSpy || []).push(JSON.parse(JSON.stringify(prefill === undefined ? null : prefill))); } catch (_) {}`);
  },
};

const ORDER = (dir, v) => ({
  order_id: 'PZX-261014-190502-K7Q2M9TB',
  items: dir === 'xpizza-orders'
    ? [{ name: 'Carnivora', qty: 2, price: 340, subtotal: 680, extras: [] }, { name: 'Margherita NY', qty: 1, price: 295, subtotal: 295, extras: [] }]
    : [{ name: 'Dim Sum de cerdo', qty: 2, price: 180, subtotal: 360, extras: [] }, { name: 'Arroz frito', qty: 1, price: 210, subtotal: 210, extras: [] }],
  total: dir === 'xpizza-orders' ? 975 : 570,
  payment_method: v.pay, payment_status: v.pay === 'online' ? 'confirmed' : 'pending',
  order_type: v.type, customer_name: 'Ana Pérez', customer_phone: '9999-0000', notes: v.notes ? 'Llamar al llegar' : '—',
  address_detected: v.type === 'delivery' ? 'Col. Los Próceres, calle 4, casa 12' : '', address_details: v.type === 'delivery' ? 'Portón negro, segundo piso' : '',
  lat: v.type === 'delivery' ? 15.5102 : undefined, lng: v.type === 'delivery' ? -88.0251 : undefined,
  maps_link: 'https://maps.google.com/?q=15.5102,-88.0251', waze_link: 'https://waze.com/ul?ll=15.5102,-88.0251',
  ...(v.scheduled ? { scheduled: true, scheduled_for: '2026-10-20T19:00' } : {}),
  ...(v.redeem ? { redeem: { type: 'free_pizza_choice', item_id: 'pepperoni', name: 'Pepperoni' } } : {}),
});
const VARIANTS = [];
for (const member of [false, true]) for (const type of ['delivery', 'pickup']) for (const pay of ['cash', 'online']) VARIANTS.push({ member, type, pay });
VARIANTS.push({ member: false, type: 'delivery', pay: 'cash', scheduled: true }, { member: true, type: 'pickup', pay: 'online', scheduled: true },
  { member: true, type: 'delivery', pay: 'cash', redeem: true, notes: true }, { member: false, type: 'delivery', pay: 'cash', notes: true });
const vname = (v) => `${v.member ? 'member' : 'guest'}/${v.type}/${v.pay}${v.scheduled ? '/scheduled' : ''}${v.redeem ? '/redeem' : ''}${v.notes ? '/notes' : ''}`;

async function capture(dir, v) {
  const B = BRAND[dir];
  const w = loadForm(dir, { transforms: PROBE });
  w.__respond = (u) => (u.includes('/menu/') ? res(envelope(B.rid, { dishes: [], extras: [] })) : new Promise(() => {}));
  if (v.member) w.localStorage.setItem(MARK[dir], JSON.stringify({ uid: 'u1', name: 'Ana Pérez', phone: '+50499990000' }));
  else w.localStorage.removeItem(MARK[dir]);
  await settle();
  w.__s5Order = ORDER(dir, v);
  w.eval(`currentOrder = window.__s5Order; __confirmTrackingToken = ${v.scheduled ? 'null' : "'TrkTok12345678'"};${v.scheduled ? ' window.__scheduledFor = currentOrder.scheduled_for;' : ''} showSuccess();`);
  await stageSettle();
  const $ = (id) => w.document.getElementById(id);
  const rw = $('acct-success-rewards');
  const out = { rewards: { cls: rw.className, html: rw.innerHTML }, receiptItems: $('receipt-items').innerHTML, receiptPayment: $('receipt-payment').innerHTML };
  if (v.scheduled) { out.scheduledSub = $('success-sub').innerHTML; out.numberLine = { display: $('order-id-display').style.display, text: $('order-id-display').textContent }; }
  if (!v.member) {
    const cta = rw.querySelector('.rwcta'); assert.ok(cta, `${dir}/${vname(v)}: premise — the guest card has its CTA`);
    w.__claimSpy = []; cta.click(); await settle();
    assert.strictEqual(w.__claimSpy.length, 1, `${dir}/${vname(v)}: the CTA opened the sheet once`);
    out.claim = w.__claimSpy[0];
  }
  w.close();
  return JSON.parse(JSON.stringify(out));   // the page realm's objects → plain objects (deepStrictEqual compares prototypes)
}

const got = {};
for (const dir of Object.keys(BRAND)) for (const v of VARIANTS) got[`${dir}/${vname(v)}`] = await capture(dir, v);
if (process.argv.includes('--write')) {
  writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n');
  console.log(`wrote s5-baseline.golden.json (${Object.keys(got).length} cells)`);
} else {
  const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'the same cell set as the golden');
  for (const k of Object.keys(want)) assert.deepStrictEqual(got[k], want[k], `🔴 the confirmation drifted from the pre-change golden: ${k}`);
  ok(`both forms reproduce the pre-change confirmation golden (${Object.keys(want).length} cells: rewards card, claim context, receipts, scheduled message + hidden number)`);
  const g = want['xpizza-orders/guest/delivery/cash'].claim;
  assert.ok(g && g.order_id && g.phone && g.address_detected && Number.isFinite(g.lat) && g.unit === 'punch', 'non-vacuity: the claim golden carries the order, phone, address and coords');
  assert.ok(/programado/.test(want['la-musa-orders/guest/delivery/cash/scheduled'].scheduledSub) && want['la-musa-orders/guest/delivery/cash/scheduled'].numberLine.display === 'none', 'non-vacuity: the scheduled cell holds the slot message and a hidden number');
  ok('non-vacuity: the claim golden carries order/phone/address/coords; the scheduled golden holds the slot message and the hidden number');
  console.log(`\ns5-baseline.golden: OK (${count()})`);
}
closeAll(); clearTimeout(WATCHDOG);
