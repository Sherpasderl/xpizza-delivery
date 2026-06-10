/**
 * Stage-4 sub-stage 1 — live sandbox verification of pixelpay-client.js.
 * Drives the REAL server client (../xpizza-functions/pixelpay-client) against the
 * live sandbox. AUTH is done via the SDK (it encrypts the card); capture/status/void
 * use OUR client — exactly what the Cloud Functions will call.
 *
 *   npm i @pixelpay/sdk-core@2.5.2   (in this dir)
 *   PIXELPAY_MODE=sandbox node verify-pins.js
 *
 * Pins: (1) capture authoritative + verifyCaptureResult passes; (2) getStatus enum
 * after capture; (3) capture>auth rejected; (4) void signature keying + status after void.
 */
process.env.PIXELPAY_MODE = process.env.PIXELPAY_MODE || 'sandbox';
const PixelPay = require('@pixelpay/sdk-core');
const client = require('../xpizza-functions/pixelpay-client');
const { Settings, Card, Order, Billing } = PixelPay.Models;
const { AuthTransaction } = PixelPay.Requests;
const { Transaction } = PixelPay.Services;

function line(t){ console.log('\n' + '='.repeat(70) + (t ? '\n'+t : '')); }

// 3DS-less AUTH via the SDK → { uuid, orderId }.
async function authOnce(amount) {
  const settings = new Settings(); settings.setupSandbox();
  const tx = new Transaction(settings);
  const orderId = 'PZX-PIN-' + Date.now() + '-' + Math.floor(Math.random()*1e6);
  const card = new Card();
  card.number='4111111111111111'; card.cvv2='300'; card.expire_month=12; card.expire_year=2027; card.cardholder='Test User';
  const order = new Order();
  order.id=orderId; order.currency='HNL'; order.amount=amount; order.tax_amount=0;
  order.customer_name='Test User'; order.customer_email='cliente.prueba@gmail.com';
  const billing = new Billing();
  billing.address='Col. Test 123'; billing.country='HN'; billing.state='HN-CR'; billing.city='San Pedro Sula'; billing.zip='21101'; billing.phone='50497952893';
  const auth = new AuthTransaction(); auth.setCard(card); auth.setBilling(billing); auth.setOrder(order);
  const res = await tx.doAuth(auth);
  return { uuid: res.data && res.data.payment_uuid, orderId, ok: res.success, msg: res.message };
}

(async () => {
  // PIN 1 — capture is authoritative + verifyCaptureResult passes.
  line('PIN 1 — capture + verifyCaptureResult (amount=1)');
  const a1 = await authOnce(1);
  console.log('auth:', a1.ok, '| uuid:', a1.uuid, '| order:', a1.orderId);
  const cap = await client.capture({ payment_uuid: a1.uuid, amountLempiras: 1 });
  console.log('capture: ok=%s http=%s msg=%s', cap.ok, cap.httpStatus, cap.message);
  const v = client.verifyCaptureResult(cap.data, { pixelpayOrderId: a1.orderId, expectedAmountLempiras: 1 });
  console.log('verifyCaptureResult:', JSON.stringify(v));

  // PIN 2 — getStatus enum after capture.
  line('PIN 2 — getStatus after capture (expect paid)');
  const st = await client.getStatus({ payment_uuid: a1.uuid });
  console.log('status: ok=%s http=%s data.status=%s', st.ok, st.httpStatus, st.data && st.data.status);
  console.log('interpretStatus:', JSON.stringify(client.interpretStatus(st)));

  // PIN 3 — capture > auth must be rejected.
  line('PIN 3 — capture > auth (auth=1, capture=2) must be REJECTED');
  const a3 = await authOnce(1);
  const capOver = await client.capture({ payment_uuid: a3.uuid, amountLempiras: 2 });
  console.log('over-capture: ok=%s http=%s msg=%s', capOver.ok, capOver.httpStatus, capOver.message);
  console.log('=> capture>auth rejected?', capOver.ok ? 'NO (!!) — amount NOT enforced' : 'YES (good)');

  // PIN 4 — void an uncaptured auth (signature keying) + status after void.
  line('PIN 4 — void uncaptured auth (signature keying) + status');
  const a4 = await authOnce(1);
  const vd = await client.voidTransaction({ payment_uuid: a4.uuid, pixelpayOrderId: a4.orderId, voidReason: 'pin_test' });
  console.log('void: ok=%s http=%s msg=%s errors=%s', vd.ok, vd.httpStatus, vd.message, JSON.stringify(vd.errors));
  const stV = await client.getStatus({ payment_uuid: a4.uuid });
  console.log('status after void: data.status=%s', stV.data && stV.data.status);

  line('SUMMARY');
  console.log('PIN1 capture authoritative+bound:', v.ok ? 'PASS' : 'FAIL ('+v.reason+')');
  console.log('PIN2 status-after-capture enum  :', st.data && st.data.status);
  console.log('PIN3 capture>auth rejected       :', capOver.ok ? 'FAIL' : 'PASS');
  console.log('PIN4 void (sig keying) accepted  :', vd.ok ? 'PASS' : 'FAIL ('+vd.message+')', '| status→', stV.data && stV.data.status);
})().catch(e => { console.error('VERIFY ERROR:', e && e.message ? e.message : e); process.exit(1); });
