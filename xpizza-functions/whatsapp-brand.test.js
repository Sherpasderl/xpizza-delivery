'use strict';
// D12b — WhatsApp names the restaurant from its OWN config (restaurants/{rid}/identity: display_name → name → neutral),
// through the REAL sendMessage: the template's placeholder is resolved before the POST, for x_pizza (byte-identical to the
// old literal once display_name is seeded), la_musa and a synthetic THIRD restaurant; a failed read sends NEUTRAL copy,
// never another brand; a body without a placeholder sends unchanged with NO identity read; the placeholder never leaks.
const assert = require('assert');
const path = require('path');

// the real module, loaded fresh with a test UltraMsg config and node-fetch captured (nothing leaves the process)
process.env.ULTRAMSG_INSTANCE_ID = 'instTEST'; process.env.ULTRAMSG_TOKEN = 'tokTEST';
process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA = 'instLM'; process.env.ULTRAMSG_TOKEN_LA_MUSA = 'tokLM'; process.env.TRACKING_BASE_LA_MUSA = 'https://track.example';
const sent = [];
const fetchPath = require.resolve('node-fetch');
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: async (url, opts) => {
  sent.push({ url, body: new URLSearchParams(opts.body).get('body') });
  return { ok: true, status: 200, json: async () => ({ sent: 'true', id: 'MSG' }) };
} };
delete require.cache[require.resolve('./whatsapp')];
const w = require('./whatsapp');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ID = {
  x_pizza: { name: 'X Pizza', display_name: 'X. Pizza' },   // the post-seed identity (owner step, RUNBOOK-D12)
  la_musa: { name: 'La Musa', display_name: null },
  r3_synth: { name: 'Sushi Sur', display_name: 'Sushi Sur HN' },
};
const reader = (calls) => async (rid) => { calls.push(rid); return ID[rid] || null; };

(async () => {
  for (const [rid, brand] of [['x_pizza', 'X. Pizza'], ['la_musa', 'La Musa'], ['r3_synth', 'Sushi Sur HN']]) {
    sent.length = 0; const calls = [];
    const msgs = [
      [w.tplOrderReceived({ customerName: 'Ana', total: 299, itemsText: 'X', trackingToken: 'T', restaurantId: rid }), `Recibimos tu pedido en ${brand} ✅`],
      [w.tplPickupReady({ customerName: 'Ana', trackingToken: 'T', restaurantId: rid }), `Ya puedes pasar por ${brand} a recogerlo.`],
      [w.tplDelivered({ customerName: 'Ana', restaurantId: rid }), `Esperamos que disfrutes ${brand}, Ana.`],
      [w.tplCancelled({ orderId: 'P-1', restaurantId: rid }), `pedido #P-1 en ${brand} fue cancelado.`],
      [w.tplPreparing({ customerName: 'Ana', etaMinutes: 20, orderType: 'pickup', trackingToken: 'T', restaurantId: rid }), `Estamos preparando tu pedido en ${brand}`],
    ];
    for (const [body] of msgs) assert.ok(await w.sendMessage('+50499998888', body, rid, { readBrand: reader(calls) }), `${rid}: sent`);
    msgs.forEach(([, want], i) => assert.ok(sent[i].body.includes(want), `${rid}: "${want}" in ${JSON.stringify(sent[i].body)}`));
    assert.ok(sent.every((s) => !s.body.includes('')), `${rid}: no placeholder ever reaches the wire`);
    assert.deepStrictEqual(calls, msgs.map(() => rid), `${rid}: the brand was read for THIS restaurant`);
    if (rid !== 'x_pizza') assert.ok(sent.every((s) => !/X\.? ?Pizza/.test(s.body)), `🔴 ${rid}: never "X. Pizza"`);
  }
  ok('the REAL sendMessage resolves the brand from each restaurant\'s config before the POST: x_pizza "X. Pizza" (today\'s text), la_musa "La Musa", a third "Sushi Sur HN"; no placeholder reaches the wire');

  // no display_name configured → the config name; a failed / null read → NEUTRAL copy (never another brand)
  sent.length = 0;
  await w.sendMessage('+50499998888', w.tplPickupReady({ trackingToken: 'T', restaurantId: 'x_pizza' }), 'x_pizza', { readBrand: async () => ({ name: 'X Pizza' }) });
  assert.ok(sent[0].body.includes('pasar por X Pizza a recogerlo'), 'before the owner seed: the config name (why the seed comes first)');
  for (const readBrand of [async () => null, async () => { throw new Error('down'); }, async () => ({ name: '  ', display_name: '' })]) {
    sent.length = 0;
    await w.sendMessage('+50499998888', w.tplPickupReady({ trackingToken: 'T', restaurantId: 'la_musa' }), 'la_musa', { readBrand });
    await w.sendMessage('+50499998888', w.tplDelivered({ customerName: 'Ana', restaurantId: 'la_musa' }), 'la_musa', { readBrand });
    assert.ok(sent[0].body.includes('pasar por el restaurante a recogerlo') && sent[1].body.includes('disfrutes tu pedido, Ana.'), `neutral copy: ${JSON.stringify(sent.map((s) => s.body))}`);
    assert.ok(sent.every((s) => !/X\.? ?Pizza|La Musa/.test(s.body)), '🔴 no brand is guessed');
  }
  ok('display_name absent → the config name; a null / failed / blank read → NEUTRAL copy ("el restaurante", "tu pedido") — never another brand');

  // a body WITHOUT a placeholder (an inbound reply, a locked owner sentence) is sent unchanged and reads nothing
  sent.length = 0; const calls = [];
  const plain = 'Recibimos tu pago. Lastimosamente el pedido se recibió fuera de horario.';
  await w.sendMessage('+50499998888', plain, 'x_pizza', { readBrand: reader(calls) });
  assert.deepStrictEqual([sent[0].body, calls], [plain, []], 'unchanged, and NO identity read');
  ok('a body without a placeholder is sent byte-unchanged with no identity read');

  // the default reader is the bounded, fail-soft live read (no Admin app here → it fails soft → neutral, never a throw)
  sent.length = 0;
  await w.sendMessage('+50499998888', w.tplPickupReady({ trackingToken: 'T', restaurantId: 'x_pizza' }), 'x_pizza');
  assert.ok(sent[0].body.includes('pasar por el restaurante a recogerlo'), `default reader without an Admin app → neutral (${sent[0].body})`);
  ok('the default reader fails SOFT (no Admin app → neutral copy, the send still happens)');

  // no brand literal survives in the WhatsApp modules (code, not comments)
  const strip = require('./tools/strip-comments');
  for (const f of ['whatsapp.js', 'whatsapp_inbound.js']) {
    const code = strip(require('fs').readFileSync(path.join(__dirname, f), 'utf8'));
    assert.ok(!/X\.? ?Pizza|La Musa/.test(code), `🔴 ${f} carries a brand-name literal`);
    assert.ok(!/BRAND_BY_RESTAURANT|restaurantName\s*:/.test(code), `🔴 ${f}: the per-brand name map is gone`);
  }
  ok('no brand-name literal and no per-brand name map in whatsapp.js / whatsapp_inbound.js');

  console.log(`\nwhatsapp-brand: OK (${n})`);
})().catch((e) => { console.error('whatsapp-brand FAILED:', e); process.exit(1); });
