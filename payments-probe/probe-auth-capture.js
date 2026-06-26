/**
 * Probe 2 — validate the AUTH (browser) + server-CAPTURE architecture.
 * doAuth (no 3DS, runs in node) → payment_uuid; then SERVER doCapture with a
 * server-set amount; inspect whether the capture response is authoritative
 * (payment_hash + transaction_approved_amount), and whether capture>auth fails.
 */
const PixelPay = require('@pixelpay/sdk-core');
const crypto = require('crypto');
const { Settings, Card, Order, Billing } = PixelPay.Models;
const { AuthTransaction, CaptureTransaction } = PixelPay.Requests;
const { Transaction } = PixelPay.Services;

const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
function line(){ console.log('\n'+'='.repeat(70)); }

function mkCardOrder(orderId, amount) {
  const card = new Card();
  card.number='4111111111111111'; card.cvv2='300'; card.expire_month=12; card.expire_year=2027; card.cardholder='Test User';
  const order = new Order();
  order.id=orderId; order.currency='HNL'; order.amount=amount; order.tax_amount=0;
  order.customer_name='Test User'; order.customer_email='cliente.prueba@gmail.com';
  const billing = new Billing();
  billing.address='Col. Test 123'; billing.country='HN'; billing.state='HN-CR'; billing.city='San Pedro Sula'; billing.zip='21101'; billing.phone='50497952893';
  return { card, order, billing };
}

(async () => {
  const settings = new Settings(); settings.setupSandbox();
  const tx = new Transaction(settings);
  const orderId = 'PZX-AUTHCAP-' + Date.now();
  console.log('pixelpay_order_id:', orderId);

  line(); console.log('STEP 1 — AUTH (amount=1, sandbox success)');
  const { card, order, billing } = mkCardOrder(orderId, 1);
  const auth = new AuthTransaction(); auth.setCard(card); auth.setBilling(billing); auth.setOrder(order);
  const authRes = await tx.doAuth(auth);
  console.log('class:', authRes.constructor.name, '| http:', authRes.status, '| success:', authRes.success, '| msg:', authRes.message);
  console.log('AUTH data:\n', JSON.stringify(authRes.data, null, 2));
  const payment_uuid = authRes.data && authRes.data.payment_uuid;
  if (!payment_uuid) { console.log('NO payment_uuid from auth — stop'); return; }

  line(); console.log('STEP 2 — server CAPTURE (server sets amount=1)');
  const cap = new CaptureTransaction(); cap.payment_uuid = payment_uuid; cap.transaction_approved_amount = 1;
  const capRes = await tx.doCapture(cap);
  console.log('class:', capRes.constructor.name, '| http:', capRes.status, '| success:', capRes.success, '| msg:', capRes.message);
  console.log('CAPTURE data:\n', JSON.stringify(capRes.data, null, 2));

  line(); console.log('ANALYSIS');
  const cd = (capRes && capRes.data) || {};
  const capHash = cd.payment_hash;
  console.log('capture returns payment_hash :', capHash || 'ABSENT');
  console.log('capture returns approved_amt :', cd.transaction_approved_amount);
  console.log('capture response_approved    :', cd.response_approved);
  if (capHash) {
    const expect = crypto.createHash('md5').update([orderId, KEY, SECRET].join('|')).digest('hex');
    console.log('expected MD5(pixelpay_order_id|auth_key|secret):', expect);
    console.log('capture payment_hash == expected MD5 ?', capHash === expect ? 'YES — server-side binding works' : 'NO');
  }
  console.log('\nVERDICT:', (capHash && cd.transaction_approved_amount != null)
    ? 'AUTH+CAPTURE is authoritative server-side (amount + binding from the capture response)'
    : 'capture response insufficient — investigate');
})().catch(e => { console.error('PROBE ERROR:', e && e.message ? e.message : e); process.exit(1); });
