/**
 * PixelPay sandbox probe — answers the Stage-4 hard gate:
 * does getStatus(payment_uuid) return payment_hash and/or an order/reference field?
 *
 * Runs a real sandbox SALE (amount=1 => success) via the SDK (handles card
 * encryption), captures payment_uuid, then calls getStatus BOTH via the SDK and
 * via a RAW fetch (exactly what our Cloud Function will do) and dumps everything.
 */
const PixelPay = require('@pixelpay/sdk-core');
const { Settings, Card, Order, Billing } = PixelPay.Models;
const { SaleTransaction, StatusTransaction } = PixelPay.Requests;
const { Transaction } = PixelPay.Services;

const SANDBOX_ENDPOINT = 'https://pixelpay.dev';
const SANDBOX_KEY = '1234567890';
const SANDBOX_HASH = '36cdf8271723276cb6f94904f8bde4b6';

function line() { console.log('\n' + '='.repeat(70)); }

(async () => {
  const settings = new Settings();
  settings.setupSandbox();

  const orderId = 'PZX-PROBE-' + Date.now();
  console.log('pixelpay_order_id used:', orderId);

  const card = new Card();
  card.number = '4111111111111111';
  card.cvv2 = '300';
  card.expire_month = 12;
  card.expire_year = 2027;
  card.cardholder = 'Test User';

  const order = new Order();
  order.id = orderId;
  order.currency = 'HNL';
  order.amount = 1;          // sandbox: 1 => Successful Transaction
  order.tax_amount = 0.13;
  order.customer_name = 'Test User';
  order.customer_email = 'cliente.prueba@gmail.com';

  const billing = new Billing();
  billing.address = 'Col. Test 123';
  billing.country = 'HN';
  billing.state = 'HN-CR';
  billing.city = 'San Pedro Sula';
  billing.zip = '21101';
  billing.phone = '50497952893';

  const sale = new SaleTransaction();
  sale.setCard(card);
  sale.setBilling(billing);
  sale.setOrder(order);

  const tx = new Transaction(settings);

  line(); console.log('STEP 1 — SALE');
  const result = await tx.doSale(sale);
  console.log('class:', result.constructor.name, '| http:', result.status, '| success:', result.success, '| msg:', result.message);
  console.log('SALE errors:\n', JSON.stringify(result.errors, null, 2));
  console.log('SALE data:\n', JSON.stringify(result.data, null, 2));

  const payment_uuid = result.data && result.data.payment_uuid;
  const sale_payment_hash = result.data && result.data.payment_hash;
  if (!payment_uuid) { console.log('\nNO payment_uuid in sale — cannot probe status. Stop.'); return; }

  line(); console.log('STEP 2a — getStatus via SDK');
  const st = new StatusTransaction();
  st.payment_uuid = payment_uuid;
  const sdkStatus = await tx.getStatus(st);
  console.log('class:', sdkStatus.constructor.name, '| http:', sdkStatus.status, '| success:', sdkStatus.success, '| msg:', sdkStatus.message);
  console.log('SDK status data:\n', JSON.stringify(sdkStatus.data, null, 2));

  line(); console.log('STEP 2b — getStatus via RAW fetch WITH env (what the Cloud Function will do)');
  const raw = await fetch(`${SANDBOX_ENDPOINT}/api/v2/transaction/status`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-auth-key': SANDBOX_KEY,
      'x-auth-hash': SANDBOX_HASH
    },
    body: JSON.stringify({ env: 'sandbox', payment_uuid })
  });
  const rawJson = await raw.json().catch(() => null);
  console.log('http:', raw.status);
  console.log('RAW status response:\n', JSON.stringify(rawJson, null, 2));

  line(); console.log('VERDICT — the Stage-4 gate');
  const sd = (rawJson && rawJson.data) || (sdkStatus && sdkStatus.data) || {};
  const statusHash = sd.payment_hash;
  const orderRef = sd.order_id || sd.order_reference || sd.reference || sd.transaction_reference;
  console.log('sale payment_hash      :', sale_payment_hash);
  console.log('status payment_hash    :', statusHash, statusHash ? '<-- PRESENT' : '<-- ABSENT');
  console.log('status echoes order ref:', orderRef || '(none of order_id/order_reference/reference/transaction_reference)');
  console.log('status response_approved:', sd.response_approved, '| approved_amount:', sd.transaction_approved_amount);
  const crypto = require('crypto');
  if (statusHash) {
    const expect = crypto.createHash('md5').update([orderId, SANDBOX_KEY, '@s4ndb0x-abcd-1234-n1l4-p1x3l'].join('|')).digest('hex');
    console.log('expected MD5(pixelpay_order_id|auth_key|sandbox_secret):', expect);
    console.log('status payment_hash == expected MD5 ?', statusHash === expect ? 'YES — binding works' : 'NO — different formula, investigate');
  }
  console.log('\nGATE:', statusHash ? 'PASS (payment_hash returned)' : (orderRef ? 'PASS (order ref returned)' : 'FAIL — needs alternate reference mechanism'));
})().catch(e => { console.error('PROBE ERROR:', e && e.message ? e.message : e); process.exit(1); });
