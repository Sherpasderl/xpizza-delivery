/**
 * Probe 3 — lost-capture-response recovery (Codex gate).
 * auth -> capture -> capture AGAIN (same uuid, same amount) -> getStatus.
 * Does a 2nd doCapture on an already-captured uuid return the verifiable
 * result (payment_hash + amount), or error? Determines whether crash-after-
 * capture can recover safely or must go to manual reconciliation.
 */
const PixelPay = require('@pixelpay/sdk-core');
const crypto = require('crypto');
const { Settings, Card, Order, Billing } = PixelPay.Models;
const { AuthTransaction, CaptureTransaction } = PixelPay.Requests;
const { Transaction } = PixelPay.Services;
const KEY='1234567890', SECRET='@s4ndb0x-abcd-1234-n1l4-p1x3l';
function line(){ console.log('\n'+'='.repeat(70)); }

(async () => {
  const settings = new Settings(); settings.setupSandbox();
  const tx = new Transaction(settings);
  const orderId = 'PZX-RECAP-' + Date.now();
  console.log('pixelpay_order_id:', orderId);

  const card=new Card(); card.number='4111111111111111'; card.cvv2='300'; card.expire_month=12; card.expire_year=2027; card.cardholder='Test User';
  const order=new Order(); order.id=orderId; order.currency='HNL'; order.amount=1; order.tax_amount=0; order.customer_name='Test User'; order.customer_email='cliente.prueba@gmail.com';
  const billing=new Billing(); billing.address='Col. Test 123'; billing.country='HN'; billing.state='HN-CR'; billing.city='San Pedro Sula'; billing.zip='21101'; billing.phone='50497952893';

  const auth=new AuthTransaction(); auth.setCard(card); auth.setBilling(billing); auth.setOrder(order);
  const a = await tx.doAuth(auth);
  const uuid = a.data && a.data.payment_uuid;
  console.log('AUTH:', a.constructor.name, '| uuid:', uuid);
  if (!uuid) { console.log('no uuid, stop'); return; }

  const cap1 = new CaptureTransaction(); cap1.payment_uuid=uuid; cap1.transaction_approved_amount=1;
  const c1 = await tx.doCapture(cap1);
  line(); console.log('CAPTURE #1:', c1.constructor.name, '| http:', c1.status, '| success:', c1.success, '| msg:', c1.message);
  console.log('  payment_hash:', c1.data && c1.data.payment_hash, '| approved_amt:', c1.data && c1.data.transaction_approved_amount);

  const cap2 = new CaptureTransaction(); cap2.payment_uuid=uuid; cap2.transaction_approved_amount=1;
  const c2 = await tx.doCapture(cap2);
  line(); console.log('CAPTURE #2 (same uuid, recovery simulation):', c2.constructor.name, '| http:', c2.status, '| success:', c2.success, '| msg:', c2.message);
  console.log('  full data:\n', JSON.stringify(c2.data, null, 2));
  console.log('  errors:', JSON.stringify(c2.errors));

  line(); console.log('RECOVERY VERDICT');
  const d2 = c2.data || {};
  const expect = crypto.createHash('md5').update([orderId, KEY, SECRET].join('|')).digest('hex');
  const hashOk = d2.payment_hash === expect;
  const amtOk = d2.transaction_approved_amount === 1;
  console.log('2nd capture returns verifiable payment_hash?', d2.payment_hash ? (hashOk?'YES (matches)':'present but mismatch') : 'NO');
  console.log('2nd capture returns amount?', amtOk ? 'YES (=1)' : (d2.transaction_approved_amount ?? 'NO'));
  console.log('=> recovery via re-capture is', (d2.payment_hash && amtOk) ? 'SAFE (idempotent, re-returns verifiable result)' : 'NOT safe via re-capture — lost-capture must go to manual_reconciliation');
})().catch(e => { console.error('PROBE ERROR:', e && e.message ? e.message : e); process.exit(1); });
