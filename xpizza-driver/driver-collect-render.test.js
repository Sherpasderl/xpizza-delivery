// Render + golden tests for the paid-online collect fix. Run: `node driver-collect-render.test.js`.
// Order shapes ORIGINATE from the real server writers (buildCreateOrderUpdates / buildMaterializeUpdates),
// never hand-built, then flow through the REAL extracted render code (paymentRowHtml / queuePayHtml).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { paymentRowHtml, queuePayHtml, COLLECT_WARN_TEXT } from './cash-helpers.js';

const require = createRequire(import.meta.url);
const { buildCreateOrderUpdates } = require('../xpizza-functions/create-order-build.js');
const { buildMaterializeUpdates } = require('../xpizza-functions/materialize.js');
const { COMBOS } = require('../xpizza-functions/deploy/combo-validation.js');

let passed = 0;
function t(name, fn) { fn(); passed++; }

// Faithful copy of index.html's escapeHtml — the escaper the real render passes in.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// --- Originate REAL order nodes from the real create writer (reuse the validated delivery combo) ---
const deliveryCombo = Object.values(COMBOS).find(c => c.input.orderType === 'delivery');
const OID = deliveryCombo.input.orderId;
function realOrderNode(paymentMethod) {
  const input = JSON.parse(JSON.stringify(deliveryCombo.input));
  input.fields.payment_method = paymentMethod;
  const updates = buildCreateOrderUpdates({ ...input, hubSnap: deliveryCombo.snapshot });
  return updates[`orders/${OID}`];   // the exact orders/{id} node the server writes
}

const cashOrder = realOrderNode('cash');
const cardOrder = realOrderNode('card_delivery');
// A fully-comped redemption is a cash order the server additionally stamps free_order:true + total 0
// (index.js at re-priced total 0). Build the real cash node, apply the documented stamp.
const freeOrder = { ...realOrderNode('cash'), free_order: true, total: 0 };

// online CONFIRMED: run the REAL materialize writer — it is the writer that sets payment_status 'confirmed'
// (materialize.js:41), the exact field collectionFor keys on. Merge its orders/{id}/* field patches back.
function materializedOnlineOrder() {
  const pending = realOrderNode('online');
  const restaurant = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+504' };
  const up = buildMaterializeUpdates({ orderId: OID, order: pending, trackingToken: 'TOK', now: 999, restaurant, paymentMethod: 'online' });
  const merged = { ...pending };
  for (const [k, v] of Object.entries(up)) { const m = k.match(new RegExp(`^orders/${OID}/(.+)$`)); if (m) merged[m[1]] = v; }
  return merged;
}
const onlinePaid = materializedOnlineOrder();
const onlinePending = { ...realOrderNode('online'), payment_status: 'pending' };
const unknownMethod = realOrderNode('');   // server sanitizes any invalid method to '' (index.js:561)

t('sanity: the materialize writer is what set payment_status confirmed', () => {
  assert.equal(onlinePaid.payment_method, 'online');
  assert.equal(onlinePaid.payment_status, 'confirmed');
});

// ---------- GOLDEN: cash / card / free render BYTE-IDENTICAL to the 37dcf43 inline templates ----------
// Legacy templates reconstructed verbatim from main @ 37dcf43 (pre-fix), same escaper.
function legacyPaymentRow(order) {
  const isFree = !!order.free_order;
  const isCash = /efectivo|cash/i.test(order.payment_method || '');
  const isCard = /tarjeta|pixel|card/i.test(order.payment_method || '');
  const paymentClass = isCash ? 'cash' : isCard ? 'card' : '';
  const paymentChipLabel = isCash ? 'Efectivo' : isCard ? 'Tarjeta' : (order.payment_method || '—');
  const totalFmt = order.total != null ? Number(order.total).toLocaleString('es-HN') : '—';
  return isFree
    ? `<div class="payment-row"><div><div class="pay-label">A COBRAR</div><div class="payment-amount free-amount">Nada que cobrar</div></div><div class="payment-method free">Pedido gratis</div></div>`
    : `<div class="payment-row"><div><div class="pay-label">A COBRAR</div><div class="payment-amount"><span class="pay-cur">L</span>${totalFmt}</div></div><div class="payment-method ${paymentClass}">${escapeHtml(paymentChipLabel)}</div></div>`;
}
function legacyQpay(order) {
  const isFree = !!order.free_order;
  const isCash = /efectivo|cash/i.test(order.payment_method || '');
  const isCard = /tarjeta|pixel|card/i.test(order.payment_method || '');
  const payClass = isCash ? '' : isCard ? 'card' : '';
  const payLabel = isFree ? 'Gratis' : isCash ? `L ${Number(order.total || 0).toLocaleString('es-HN')}` : isCard ? 'Tarjeta' : (order.payment_method || '—');
  return `<span class="qpay ${payClass}">${escapeHtml(payLabel)}</span>`;
}
t('golden: cash payment row byte-identical', () => assert.equal(paymentRowHtml(cashOrder, escapeHtml), legacyPaymentRow(cashOrder)));
t('golden: card_delivery payment row byte-identical', () => assert.equal(paymentRowHtml(cardOrder, escapeHtml), legacyPaymentRow(cardOrder)));
t('golden: free payment row byte-identical', () => assert.equal(paymentRowHtml(freeOrder, escapeHtml), legacyPaymentRow(freeOrder)));
t('golden: cash qpay byte-identical', () => assert.equal(queuePayHtml(cashOrder, escapeHtml), legacyQpay(cashOrder)));
t('golden: card qpay byte-identical', () => assert.equal(queuePayHtml(cardOrder, escapeHtml), legacyQpay(cardOrder)));
t('golden: free qpay byte-identical', () => assert.equal(queuePayHtml(freeOrder, escapeHtml), legacyQpay(freeOrder)));

// ---------- THE FIX: a verified-paid online order NEVER shows "A COBRAR" or an amount ----------
t('paid online: row says Pagado, no A COBRAR, no L amount', () => {
  const row = paymentRowHtml(onlinePaid, escapeHtml);
  assert.ok(row.includes('Pagado — nada que cobrar'), row);
  assert.ok(!row.includes('A COBRAR'), 'must NOT say A COBRAR on a paid order');
  assert.ok(!/<span class="pay-cur">L<\/span>/.test(row), 'must NOT render an L amount');
  assert.ok(row.includes('payment-method paid'));
});
t('paid online: qpay says Pagado (never a raw method, never an amount)', () => {
  const q = queuePayHtml(onlinePaid, escapeHtml);
  assert.ok(q.includes('>Pagado<'), q);
  assert.ok(!q.includes('online'));
  assert.ok(!q.includes('L '));
});

// ---------- online UNCONFIRMED + unknown/'' → warning, never a collect amount ----------
for (const [label, ord] of [['online pending', onlinePending], ['unknown/empty method', unknownMethod]]) {
  t(`warning: ${label} → consultá a despacho, no amount`, () => {
    const row = paymentRowHtml(ord, escapeHtml);
    assert.ok(row.includes(COLLECT_WARN_TEXT), row);
    assert.ok(!row.includes('A COBRAR'));
    assert.ok(!/<span class="pay-cur">L<\/span>/.test(row));
    assert.ok(queuePayHtml(ord, escapeHtml).includes('>Revisar<'));
  });
}

// ---------- brand-agnostic: identical render for x_pizza and la_musa (driver UI is shared) ----------
t('brand-agnostic: la_musa renders identically to x_pizza', () => {
  for (const base of [cashOrder, cardOrder, freeOrder, onlinePaid, onlinePending, unknownMethod]) {
    const xp = { ...base, restaurant_id: 'x_pizza' };
    const lm = { ...base, restaurant_id: 'la_musa' };
    assert.equal(paymentRowHtml(lm, escapeHtml), paymentRowHtml(xp, escapeHtml));
    assert.equal(queuePayHtml(lm, escapeHtml), queuePayHtml(xp, escapeHtml));
  }
});

console.log(`✓ driver-collect-render: ${passed} tests passed`);
