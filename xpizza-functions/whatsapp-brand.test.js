'use strict';
// D12b — WhatsApp names the restaurant from its OWN config (restaurants/{rid}/identity: display_name → name → neutral),
// through the REAL sendMessage. A branded template is a DEFERRED message: sendMessage resolves the brand FIRST and then
// renders the template with `brand` as an argument (codex D12b r1 P2-1) — no text substitution ever runs over customer data.
// Covered: x_pizza (byte-identical to the old literal once display_name is seeded), la_musa, a synthetic THIRD restaurant;
// neutral copy when nothing names the restaurant; customer text carrying marker-like strings is sent VERBATIM; a configured
// marker never becomes a brand; plain strings are sent unchanged with no read; a look-alike object is refused; the OTP.
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
const PHONE = '+50499998888';
const ID = {
  x_pizza: { name: 'X Pizza', display_name: 'X. Pizza' },   // the post-seed identity (owner step, RUNBOOK-D12)
  la_musa: { name: 'La Musa', display_name: null },
  r3_synth: { name: 'Sushi Sur', display_name: 'Sushi Sur HN' },
};
const reader = (calls, ids = ID) => async (rid) => { calls.push(rid); return ids[rid] || null; };

(async () => {
  // ── 1. every branded template, three restaurants, through the REAL send ──
  for (const [rid, brand] of [['x_pizza', 'X. Pizza'], ['la_musa', 'La Musa'], ['r3_synth', 'Sushi Sur HN']]) {
    sent.length = 0; const calls = [];
    const msgs = [
      [w.tplOrderReceived({ customerName: 'Ana', total: 299, itemsText: 'X', trackingToken: 'T', restaurantId: rid }), `Recibimos tu pedido en ${brand} ✅`],
      [w.tplPickupReceived({ customerName: 'Ana', total: 299, itemsText: 'X', pickupTime: 'standard', trackingToken: 'T', restaurantId: rid }), `Recibimos tu pedido en ${brand} ✅`],
      [w.tplPickupReady({ customerName: 'Ana', trackingToken: 'T', restaurantId: rid }), `Ya puedes pasar por ${brand} a recogerlo.`],
      [w.tplDelivered({ customerName: 'Ana', restaurantId: rid }), `Esperamos que disfrutes ${brand}, Ana.`],
      [w.tplCancelled({ displayNumber: 12, restaurantId: rid }), `pedido #12 en ${brand} fue cancelado.`],
      [w.tplPreparing({ customerName: 'Ana', etaMinutes: 20, orderType: 'pickup', trackingToken: 'T', restaurantId: rid }), `Estamos preparando tu pedido en ${brand} —`],
      [w.tplOtp({ code: '123456' }), `Tu código de ${brand} es 123456. Vence en 5 minutos. No lo compartas.`],
    ];
    // the OTP is SYNC-ONLY (codex r2): its brand comes from an identity already in hand (the peek), never a read
    for (const [m] of msgs) { assert.ok(w.isDeferred(m), `${rid}: a deferred message`); assert.ok(await w.sendMessage(PHONE, m, rid, { readBrand: reader(calls), peekBrand: (r) => ID[r] || null }), `${rid}: sent`); }
    msgs.forEach(([, want], i) => assert.ok(sent[i].body.includes(want), `${rid}: "${want}" in ${JSON.stringify(sent[i].body)}`));
    assert.deepStrictEqual(calls, msgs.slice(0, -1).map(() => rid), `${rid}: the brand was read for THIS restaurant — for every template but the OTP`);
    if (rid !== 'x_pizza') assert.ok(sent.every((s) => !/X\.? ?Pizza/.test(s.body)), `🔴 ${rid}: never "X. Pizza"`);
  }
  ok('the REAL sendMessage resolves the brand first, then renders: 7 templates (incl. the OTP, from an identity in hand) × x_pizza "X. Pizza" (today\'s text), la_musa, a third "Sushi Sur HN"');

  // ── codex r2: a LOGIN CODE never waits on branding — a HUNG identity read does not delay the OTP POST ──
  {
    sent.length = 0; let readStarted = 0;
    const hung = () => { readStarted += 1; return new Promise(() => {}); };   // never resolves
    const t0 = Date.now();
    const r = await w.sendMessage(PHONE, w.tplOtp({ code: '424242' }), 'x_pizza', { readBrand: hung, peekBrand: () => null });
    const ms = Date.now() - t0;
    assert.ok(r && sent.length === 1, 'the OTP was sent');
    assert.ok(ms < 50, `🔴 the OTP POST is immediate under a hung identity read (${ms} ms)`);
    assert.strictEqual(sent[0].body, 'Tu código es 424242. Vence en 5 minutos. No lo compartas.', 'neutral copy when no brand is in hand');
    assert.strictEqual(readStarted, 0, 'the OTP never even STARTS an identity read');
    // an identity already in hand brands it, still without any read
    sent.length = 0;
    await w.sendMessage(PHONE, w.tplOtp({ code: '424242' }), 'x_pizza', { readBrand: hung, peekBrand: () => ({ name: 'X Pizza', display_name: 'X. Pizza' }) });
    assert.strictEqual(sent[0].body, 'Tu código de X. Pizza es 424242. Vence en 5 minutos. No lo compartas.');
    assert.strictEqual(readStarted, 0);
    // a non-OTP template still uses the (bounded) live read — the OTP rule is scoped to login codes
    sent.length = 0;
    await w.sendMessage(PHONE, w.tplPickupReady({ trackingToken: 'T', restaurantId: 'x_pizza' }), 'x_pizza', { readBrand: async () => ID.x_pizza, peekBrand: () => null });
    assert.ok(sent[0].body.includes('pasar por X. Pizza'));
  }
  ok('codex r2: the OTP never awaits branding — a HUNG identity read: sent immediately, neutral "Tu código es …", no read started; an identity in hand brands it; other templates keep the live read');

  // ── codex r3: the OTP's peek accepts only a FRESH restaurant-config cache entry (the DEFAULT peek, the real cache) ──
  {
    const { _cache, TTL_MS } = require('./restaurant-config');
    let reads = 0; const hung = () => { reads += 1; return new Promise(() => {}); };
    const otp = async () => { sent.length = 0; await w.sendMessage(PHONE, w.tplOtp({ code: '111111' }), 'r3_fresh', { readBrand: hung }); return sent[0].body; };
    const entry = (fetched_at) => _cache.set('r3_fresh', { identity: { name: 'Old Name', display_name: 'Sushi Sur HN' }, fetched_at, version: 1 });
    entry(Date.now());
    assert.strictEqual(await otp(), 'Tu código de Sushi Sur HN es 111111. Vence en 5 minutos. No lo compartas.', 'a FRESH entry brands the OTP');
    for (const [fa, why] of [[Date.now() - TTL_MS - 1, 'stale (older than the TTL)'], [Date.now() - 24 * 3600e3, 'a day old (a renamed brand)'], [undefined, 'no fetched_at'], ['soon', 'a non-numeric fetched_at'], [Date.now() + 60e3, 'a future fetched_at']]) {
      entry(fa);
      assert.strictEqual(await otp(), 'Tu código es 111111. Vence en 5 minutos. No lo compartas.', `🔴 ${why} → neutral`);
    }
    _cache.delete('r3_fresh');
    assert.strictEqual(await otp(), 'Tu código es 111111. Vence en 5 minutos. No lo compartas.', 'no entry → neutral');
    assert.strictEqual(reads, 0, 'zero reads in every case');
  }
  ok('codex r3: the OTP peek accepts only a FRESH cache entry (within restaurant-config TTL_MS) — stale / day-old / missing / non-numeric / future fetched_at → neutral; zero reads');

  // ── 2. neutral copy: nothing names the restaurant (null / failed / blank / unshowable) ──
  const neutral = [
    [w.tplOrderReceived({ customerName: 'Ana', total: 1, itemsText: 'X', trackingToken: 'T', restaurantId: 'la_musa' }), 'Recibimos tu pedido ✅'],
    [w.tplPickupReady({ trackingToken: 'T', restaurantId: 'la_musa' }), 'Ya puedes pasar por el restaurante a recogerlo.'],
    [w.tplDelivered({ customerName: 'Ana', restaurantId: 'la_musa' }), 'Esperamos que disfrutes tu pedido, Ana.'],
    [w.tplCancelled({ displayNumber: 12, restaurantId: 'la_musa' }), 'pedido #12 fue cancelado.'],
    [w.tplPreparing({ etaMinutes: 20, orderType: 'pickup', trackingToken: 'T', restaurantId: 'la_musa' }), 'Estamos preparando tu pedido —'],
    [w.tplOtp({ code: '654321' }), 'Tu código es 654321. Vence en 5 minutos. No lo compartas.'],
  ];
  for (const readBrand of [async () => null, async () => { throw new Error('down'); }, async () => ({ name: '  ', display_name: '' }), async () => ({ name: 'Ab', display_name: '\u0007' })]) {
    sent.length = 0;
    for (const [m] of neutral) await w.sendMessage(PHONE, m, 'la_musa', { readBrand });
    neutral.forEach(([, want], i) => assert.ok(sent[i].body.includes(want), `neutral "${want}" in ${JSON.stringify(sent[i].body)}`));
    assert.ok(sent.every((s) => !/X\.? ?Pizza|La Musa/.test(s.body)), '🔴 no brand is guessed');
  }
  sent.length = 0;
  await w.sendMessage(PHONE, w.tplPickupReady({ trackingToken: 'T', restaurantId: 'x_pizza' }), 'x_pizza', { readBrand: async () => ({ name: 'X Pizza' }) });
  assert.ok(sent[0].body.includes('pasar por X Pizza a recogerlo'), 'no display_name → the config name (why the owner seed comes first)');
  ok('nothing names the restaurant (null / failed / blank / unshowable) → each template\'s NEUTRAL wording, never another brand; no display_name → the config name');

  // ── 3. codex r1 P2-1: customer text is NEVER rewritten — marker-like strings reach the wire verbatim ──
  for (const evil of ['Ana brand', 'brand', '{{brand}}', 'brand-or-meal', '${brand}']) {
    sent.length = 0;
    await w.sendMessage(PHONE, w.tplPickupReady({ customerName: evil, trackingToken: 'T', restaurantId: 'x_pizza' }), 'x_pizza', { readBrand: reader([]) });
    await w.sendMessage(PHONE, w.tplOrderReceived({ customerName: evil, itemsText: `Pizza (notas: ${evil})`, total: 1, trackingToken: 'T', restaurantId: 'x_pizza' }), 'x_pizza', { readBrand: reader([]) });
    assert.ok(sent[0].body.includes(`¡Hola ${evil}! 👋 Ya puedes pasar por X. Pizza`), `the name "${evil}" is sent verbatim: ${JSON.stringify(sent[0].body)}`);
    assert.ok(sent[1].body.includes(`¡Hola ${evil}!`) && sent[1].body.includes(`Pizza (notas: ${evil})`), `name + notes verbatim: ${JSON.stringify(sent[1].body)}`);
    assert.strictEqual((sent[0].body.match(/X\. Pizza/g) || []).length, 1, 'the brand appears exactly once (where the template puts it)');
  }
  // an inbound reply / any plain string — even one carrying a marker — is sent unchanged with NO identity read
  for (const plain of ['Recibimos tu pago. Lastimosamente el pedido se recibió fuera de horario.', 'eco: brand {{brand}} brand']) {
    sent.length = 0; const calls = [];
    await w.sendMessage(PHONE, plain, 'x_pizza', { readBrand: reader(calls) });
    assert.deepStrictEqual([sent[0].body, calls], [plain, []], `plain "${plain.slice(0, 30)}…" unchanged, and NO read`);
  }
  // a configured display_name carrying a marker / control char is NOT a brand (the config name is used; nothing leaks)
  sent.length = 0;
  await w.sendMessage(PHONE, w.tplPickupReady({ trackingToken: 'T', restaurantId: 'x_pizza' }), 'x_pizza', { readBrand: async () => ({ name: 'X Pizza', display_name: 'X. Pizzabrand' }) });
  assert.ok(sent[0].body.includes('pasar por X Pizza a recogerlo') && !sent[0].body.includes(''), `a configured marker is never a brand, never on the wire: ${JSON.stringify(sent[0].body)}`);
  ok('codex r1 P2-1: customer names / notes carrying "brand", private-use markers, {{brand}}, ${brand} are sent VERBATIM; plain strings (inbound) unchanged with no read; a configured marker is never a brand and never reaches the wire');

  // ── 4. only messages MINTED by this module are rendered — a look-alike object is refused, not rendered ──
  sent.length = 0;
  const fake = Object.freeze({ name: 'otp', args: Object.freeze({ code: '000000' }) });
  assert.strictEqual(w.isDeferred(fake), false);
  assert.strictEqual(await w.sendMessage(PHONE, fake, 'x_pizza', { readBrand: reader([]) }), null, 'refused (an invalid body)');
  assert.strictEqual(sent.length, 0, 'nothing sent');
  assert.throws(() => w.renderTemplate(fake, 'X'), /minted/);
  ok('a look-alike { name, args } object is not a minted message: refused, nothing sent');

  // ── 5. the default reader: fails SOFT without an Admin app (neutral, the send still happens) ──
  sent.length = 0;
  await w.sendMessage(PHONE, w.tplPickupReady({ trackingToken: 'T', restaurantId: 'x_pizza' }), 'x_pizza');
  assert.ok(sent[0].body.includes('pasar por el restaurante a recogerlo'), `default reader without an Admin app → neutral (${sent[0].body})`);
  ok('the default reader fails SOFT (no Admin app → neutral copy, the send still happens)');

  // ── 6. no brand literal survives in the WhatsApp modules or the OTP block (code, not comments) ──
  const fs = require('fs'); const strip = require('./tools/strip-comments');
  for (const f of ['whatsapp.js', 'whatsapp_inbound.js']) {
    const code = strip(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    assert.ok(!/X\.? ?Pizza|La Musa/.test(code), `🔴 ${f} carries a brand-name literal`);
    assert.ok(!/BRAND_BY_RESTAURANT|restaurantName\s*:|\\uE000/.test(code), `🔴 ${f}: the name map / placeholder machinery is gone`);
  }
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const otp = idx.slice(idx.indexOf('/* d12b:begin */'), idx.indexOf('/* d12b:end */'));
  assert.ok(otp.includes('whatsapp.tplOtp({ code })') && !/X\.? ?Pizza|La Musa|la_musa/.test(otp), '🔴 the OTP message is the config-branded template, no literal');
  ok('no brand-name literal, no name map and no placeholder machinery in whatsapp.js / whatsapp_inbound.js; the OTP block uses tplOtp');

  console.log(`\nwhatsapp-brand: OK (${n})`);
})().catch((e) => { console.error('whatsapp-brand FAILED:', e); process.exit(1); });
