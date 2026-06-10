/** Void experiment — find the auth model the sandbox void accepts. */
const PixelPay = require('@pixelpay/sdk-core');
const crypto = require('crypto');
const { Settings, Card, Order, Billing } = PixelPay.Models;
const { AuthTransaction } = PixelPay.Requests;
const { Transaction } = PixelPay.Services;
const EP='https://pixelpay.dev', KEY='1234567890', HASH='36cdf8271723276cb6f94904f8bde4b6', SECRET='@s4ndb0x-abcd-1234-n1l4-p1x3l';
const sha512 = s => crypto.createHash('sha512').update(String(s)).digest('hex');

async function authOnce(){
  const s=new Settings(); s.setupSandbox(); const tx=new Transaction(s);
  const orderId='PZX-VEXP-'+Date.now()+'-'+Math.floor(Math.random()*1e6);
  const c=new Card(); c.number='4111111111111111'; c.cvv2='300'; c.expire_month=12; c.expire_year=2027; c.cardholder='Test User';
  const o=new Order(); o.id=orderId; o.currency='HNL'; o.amount=1; o.tax_amount=0; o.customer_name='Test User'; o.customer_email='cliente.prueba@gmail.com';
  const b=new Billing(); b.address='Col. Test 123'; b.country='HN'; b.state='HN-CR'; b.city='San Pedro Sula'; b.zip='21101'; b.phone='50497952893';
  const a=new AuthTransaction(); a.setCard(c); a.setBilling(b); a.setOrder(o);
  const r=await tx.doAuth(a); return { uuid:r.data&&r.data.payment_uuid, orderId };
}
async function voidPost(body, headers){
  const r= await fetch(`${EP}/api/v2/transaction/void`, { method:'POST',
    headers:{Accept:'application/json','Content-Type':'application/json','x-auth-key':KEY,'x-auth-hash':HASH, ...headers},
    body: JSON.stringify({ env:'sandbox', ...body }) });
  let j=null; try{ j=await r.json(); }catch{}
  return { http:r.status, success:j&&j.success, msg:j&&j.message, code:j&&j.code, errors:j&&j.errors };
}

(async()=>{
  const variants = [
    { name:'A no-user, sig=sha512(order|secret)', mk:(u,o)=>({ body:{payment_uuid:u, void_reason:'anulacion_automatica', void_signature:sha512([o,SECRET].join('|'))}, headers:{} }) },
    { name:'B no-user, sig=sha512(uuidauth|order|secret) authuser=sha512(email)', mk:(u,o)=>{const au=sha512('sandbox@pixelpay.dev'); return { body:{payment_uuid:u, void_reason:'anulacion_automatica', void_signature:sha512([au,o,SECRET].join('|'))}, headers:{} };} },
    { name:'C user=sha512(KEY), sig=sha512(authuser|order|secret)', mk:(u,o)=>{const au=sha512(KEY); return { body:{payment_uuid:u, void_reason:'anulacion_automatica', void_signature:sha512([au,o,SECRET].join('|'))}, headers:{'x-auth-user':au} };} },
    { name:'D user=KEY raw, sig=sha512(KEY|order|secret)', mk:(u,o)=>({ body:{payment_uuid:u, void_reason:'anulacion_automatica', void_signature:sha512([KEY,o,SECRET].join('|'))}, headers:{'x-auth-user':KEY} }) },
    { name:'E no-user, sig=sha512(uuid|secret)', mk:(u,o)=>({ body:{payment_uuid:u, void_reason:'anulacion_automatica', void_signature:sha512([u,SECRET].join('|'))}, headers:{} }) },
    { name:'F no-user, no-sig', mk:(u,o)=>({ body:{payment_uuid:u, void_reason:'anulacion_automatica'}, headers:{} }) },
  ];
  for (const v of variants) {
    const { uuid, orderId } = await authOnce();
    const { body, headers } = v.mk(uuid, orderId);
    const res = await voidPost(body, headers);
    console.log(`[${v.name}] http=${res.http} success=${res.success} msg=${res.msg} ${res.errors?JSON.stringify(res.errors):''}`);
  }
})().catch(e=>{ console.error('ERR', e.message); process.exit(1); });
