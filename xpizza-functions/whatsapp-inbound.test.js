'use strict';

// Golden tests for the per-restaurant inbound auto-reply (whatsapp_inbound.js). Run: node whatsapp-inbound.test.js
// The load-bearing guarantee: the x_pizza path is BYTE-IDENTICAL to today EXCEPT the single order-form
// URL (xpizzaorders.netlify.app → orders.xpizza.hn), and the ?restaurant= resolver fail-safes to x_pizza.
const assert = require('assert');
const {
  classify, getHoursStatus, hoursFromIdentity, resolveInboundRestaurant, isUnrecognizedRestaurantParam, configFor,
  tplGeneralInquiry, tplStatusCheckFound, tplStatusCheckNotFound, tplShortAck, tplUnhandled, CONFIG_BY_RESTAURANT,
  muteKeyFor, isHumanOutbound, shouldSuppressAutoReply, resolveMuteWindowMs
} = require('./whatsapp_inbound');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const X = configFor('x_pizza'), L = configFor('la_musa');

// ── resolveInboundRestaurant — fail-safe to x_pizza (the param only routes an authenticated inbound) ──
assert.strictEqual(resolveInboundRestaurant(undefined), 'x_pizza'); ok('absent → x_pizza');
assert.strictEqual(resolveInboundRestaurant(''), 'x_pizza'); ok('empty → x_pizza');
assert.strictEqual(resolveInboundRestaurant('X_PIZZA'), 'x_pizza'); ok('wrong-case unknown → x_pizza');
assert.strictEqual(resolveInboundRestaurant('nope'), 'x_pizza'); ok('unknown → x_pizza');
assert.strictEqual(resolveInboundRestaurant(['la_musa']), 'x_pizza'); ok('non-string (injection-ish) → x_pizza');
assert.strictEqual(resolveInboundRestaurant('  la_musa  '), 'la_musa'); ok('trims whitespace → la_musa');
assert.strictEqual(resolveInboundRestaurant('la_musa'), 'la_musa'); ok('la_musa → la_musa');

// ── isUnrecognizedRestaurantParam — fires the mis-wired-webhook warn (accept: warn+x_pizza) ──
assert.strictEqual(isUnrecognizedRestaurantParam(undefined), false); ok('unrecognized: absent → false (legit default, no warn)');
assert.strictEqual(isUnrecognizedRestaurantParam(''), false); ok('unrecognized: empty → false');
assert.strictEqual(isUnrecognizedRestaurantParam('x_pizza'), false); ok('unrecognized: x_pizza → false (no warn)');
assert.strictEqual(isUnrecognizedRestaurantParam('la_musa'), false); ok('unrecognized: la_musa → false');
assert.strictEqual(isUnrecognizedRestaurantParam('  la_musa  '), false); ok('unrecognized: padded la_musa → false');
assert.strictEqual(isUnrecognizedRestaurantParam('nope'), true); ok('unrecognized: nope → true (WARN + x_pizza fail-safe)');
assert.strictEqual(isUnrecognizedRestaurantParam('LA_MUSA'), true); ok('unrecognized: wrong-case → true (mis-wired webhook)');
assert.strictEqual(isUnrecognizedRestaurantParam(['la_musa']), true); ok('unrecognized: non-string → true');

// ── config integrity — x_pizza is exact-current-except-URL; la_musa is its own ──
assert.deepStrictEqual(X, { orderFormUrl: 'https://orders.xpizza.hn', trackingBase: 'https://xpizzatrack.netlify.app', restaurantName: 'X. Pizza', ackEmoji: '🍕' }); ok('x_pizza config (order-form → orders.xpizza.hn; tracker/name/emoji unchanged)');
assert.deepStrictEqual(L, { orderFormUrl: 'https://orders.lamusa.hn', trackingBase: 'https://track.lamusa.hn', restaurantName: 'La Musa', ackEmoji: '🍜' }); ok('la_musa config (orders.lamusa.hn / track.lamusa.hn / La Musa / 🍜)');
assert.strictEqual(configFor('nope'), X); ok('configFor(unknown) → x_pizza');

// ── x_pizza templates — BYTE-IDENTICAL to today except the order-form URL ──
assert.strictEqual(tplGeneralInquiry(X, { isOpen: true }),
  '¡Hola! 👋\n\nPara ver el menú y hacer tu pedido, visita:\nhttps://orders.xpizza.hn\n\nSi tienes una pregunta sobre un pedido existente, respóndenos aquí.'); ok('x_pizza general/open — exact');
assert.strictEqual(tplGeneralInquiry(X, { isOpen: false, opensLabel: 'hoy a las 12:00 PM' }),
  '¡Hola! 👋\n\nEstamos cerrados ahora. Abrimos hoy a las 12:00 PM.\n\nMientras tanto, puedes ver el menú en:\nhttps://orders.xpizza.hn\n\nY hacer tu pedido cuando abramos. ¡Gracias!'); ok('x_pizza general/closed — exact');
assert.strictEqual(tplStatusCheckFound(X, { trackingToken: 'TOK', customerName: 'Ana' }),
  '¡Hola Ana! Aquí puedes seguir tu pedido en tiempo real:\nhttps://xpizzatrack.netlify.app/TOK'); ok('x_pizza status-found — exact (tracker unchanged)');
assert.strictEqual(tplStatusCheckNotFound(X),
  'No encontramos un pedido activo a tu nombre.\n\nSi acabas de ordenar, espera unos minutos — te avisaremos por aquí.\n\nSi quieres hacer un nuevo pedido: https://orders.xpizza.hn'); ok('x_pizza status-not-found — exact');
assert.strictEqual(tplShortAck(X), '¡Con gusto! 🍕'); ok('x_pizza short-ack — exact (🍕)');
assert.strictEqual(tplUnhandled(X, { isOpen: true }),
  'Recibimos tu mensaje. Un colaborador te responderá pronto.\n\nSi quieres hacer un pedido: https://orders.xpizza.hn'); ok('x_pizza unhandled/open — exact');

// ── la_musa templates — same shape, la_musa substitutions ──
assert.ok(tplGeneralInquiry(L, { isOpen: true }).includes('https://orders.lamusa.hn')); ok('la_musa general → orders.lamusa.hn');
assert.strictEqual(tplStatusCheckFound(L, { trackingToken: 'T2', customerName: 'Bo' }),
  '¡Hola Bo! Aquí puedes seguir tu pedido en tiempo real:\nhttps://track.lamusa.hn/T2'); ok('la_musa status-found → track.lamusa.hn');
assert.strictEqual(tplShortAck(L), '¡Con gusto! 🍜'); ok('la_musa short-ack → 🍜');

// ── hoursFromIdentity — identity config shape → day-index/open-close; Mon-only-closed ──
const IDENT = { mon: { open: false }, tue: { open: true, start: '17:00', end: '20:45' }, wed: { open: true, start: '17:00', end: '20:45' }, thu: { open: true, start: '17:00', end: '20:45' }, fri: { open: true, start: '17:00', end: '21:45' }, sat: { open: true, start: '17:00', end: '21:45' }, sun: { open: true, start: '17:00', end: '20:45' } };
const HM = hoursFromIdentity(IDENT);
assert.strictEqual(HM[1], null); ok('hoursFromIdentity: Monday(idx1) → null (closed)');
assert.deepStrictEqual(HM[2], { open: '17:00', close: '20:45' }); ok('Tuesday(idx2) → open 17:00-20:45 (now open)');
assert.deepStrictEqual(HM[0], { open: '17:00', close: '20:45' }); ok('Sunday(idx0) → 17:00-20:45 (day-index mapping correct)');
assert.deepStrictEqual(HM[5], { open: '17:00', close: '21:45' }); ok('Friday(idx5) → 17:00-21:45');
assert.deepStrictEqual(hoursFromIdentity(null), { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null }); ok('null identity → all-closed (safe degrade)');

// ── malformed HH:MM → null (closed), never passed through → degrades to a closed reply, never throws ──
const BAD = { mon: { open: true, start: '5pm', end: '20:45' }, tue: { open: true, start: '17:00', end: '25:99' }, wed: { open: true, start: '17:00' }, thu: { open: true, start: '17:00', end: '20:45' } };
const BADHM = hoursFromIdentity(BAD);
assert.strictEqual(BADHM[1], null); ok('malformed: bad start "5pm" → null (closed)');
assert.strictEqual(BADHM[2], null); ok('malformed: out-of-range end "25:99" → null');
assert.strictEqual(BADHM[3], null); ok('malformed: missing end → null');
assert.deepStrictEqual(BADHM[4], { open: '17:00', close: '20:45' }); ok('valid day still parses among malformed');
assert.strictEqual(typeof getHoursStatus(new Date('2026-07-08T02:00:00Z'), BADHM).isOpen, 'boolean'); ok('getHoursStatus(malformed-derived map) → no throw (closed-reply-safe)');

// ── getHoursStatus consumes the PASSED hoursMap (the refactor's core) — timezone-agnostic ──
assert.strictEqual(getHoursStatus(new Date('2026-07-08T02:00:00Z'), hoursFromIdentity(null)).isOpen, false); ok('getHoursStatus: all-closed map → closed (any date)');
const allOpen = {}; for (let i = 0; i < 7; i++) allOpen[i] = { open: '00:00', close: '23:59' };
assert.strictEqual(getHoursStatus(new Date('2026-07-08T02:00:00Z'), allOpen).isOpen, true); ok('getHoursStatus: all-open map → open (uses the passed map, NOT the x_pizza default)');
// x_pizza byte-identity of the hours path: no hoursMap arg → falls back to the hardcoded x_pizza HOURS.
assert.strictEqual(typeof getHoursStatus().isOpen, 'boolean'); ok('getHoursStatus() no-arg → uses x_pizza default HOURS (byte-identical path intact)');

// classify sanity (restaurant-agnostic — unchanged)
assert.strictEqual(classify('hola quiero una pizza'), 'GENERAL_INQUIRY'); ok('classify greeting/order → GENERAL_INQUIRY');
assert.strictEqual(classify('donde esta mi pedido'), 'STATUS_CHECK'); ok('classify → STATUS_CHECK');
assert.strictEqual(classify('gracias'), 'SHORT_ACK'); ok('classify → SHORT_ACK');

// ── auto-mute helpers (Path A: staff app-reply → suppress the bot auto-reply for a window) ──
const WMS = 10 * 60 * 1000;

// shouldSuppressAutoReply — fresh mark within the window → true; else false
assert.strictEqual(shouldSuppressAutoReply(null, 1000, WMS), false); ok('mute: no record → false');
assert.strictEqual(shouldSuppressAutoReply(undefined, 1000, WMS), false); ok('mute: undefined record → false');
assert.strictEqual(shouldSuppressAutoReply({}, 1000, WMS), false); ok('mute: missing at → false');
assert.strictEqual(shouldSuppressAutoReply({ at: 'x' }, 1000, WMS), false); ok('mute: non-finite at → false');
assert.strictEqual(shouldSuppressAutoReply({ at: 1000 }, 1000 + WMS - 1, WMS), true); ok('mute: fresh (within window) → true');
assert.strictEqual(shouldSuppressAutoReply({ at: 1000 }, 1000 + WMS, WMS), false); ok('mute: at window edge → false (>= window)');
assert.strictEqual(shouldSuppressAutoReply({ at: 1000 }, 1000 + WMS + 5000, WMS), false); ok('mute: stale → false');

// resolveMuteWindowMs — live value, else 10-min default
assert.strictEqual(resolveMuteWindowMs(120000), 120000); ok('window: valid → value');
assert.strictEqual(resolveMuteWindowMs(undefined), WMS); ok('window: unset → 10-min default');
assert.strictEqual(resolveMuteWindowMs(null), WMS); ok('window: null → default');
assert.strictEqual(resolveMuteWindowMs(0), WMS); ok('window: 0 → default');
assert.strictEqual(resolveMuteWindowMs(-5), WMS); ok('window: negative → default');
assert.strictEqual(resolveMuteWindowMs('nope'), WMS); ok('window: NaN → default');

// muteKeyFor — same last-8 suffix as order-matching; inbound-from & outbound-to → one leaf
assert.strictEqual(muteKeyFor('50499887766@c.us'), '99887766'); ok('key: strips @c.us + last-8');
assert.strictEqual(muteKeyFor('50499887766'), '99887766'); ok('key: bare 504 number → last-8');
assert.strictEqual(muteKeyFor('+50499887766'), '99887766'); ok('key: +504 → last-8');
assert.strictEqual(muteKeyFor('99887766'), '99887766'); ok('key: 8-digit local → itself');
assert.strictEqual(muteKeyFor('50499887766@c.us'), muteKeyFor('+50499887766')); ok('key: inbound-from == outbound-to leaf (PARITY)');
assert.strictEqual(muteKeyFor(''), ''); ok('key: empty → empty (caller skips the write)');
assert.strictEqual(muteKeyFor(null), ''); ok('key: null → empty');

// isHumanOutbound — self:false = human app-reply, self:true = our bot API send
assert.strictEqual(isHumanOutbound({ fromMe: true, self: false }), true); ok('human: fromMe + self:false → true');
assert.strictEqual(isHumanOutbound({ fromMe: true, self: true }), false); ok('human: bot self:true → false');
assert.strictEqual(isHumanOutbound({ fromMe: false, self: false }), false); ok('human: not fromMe → false');
assert.strictEqual(isHumanOutbound({ fromMe: true }), false); ok('human: self undefined → false (safe: never self-mutes)');
assert.strictEqual(isHumanOutbound(null), false); ok('human: null → false');

console.log(`whatsapp-inbound: OK (${n} cases)`);
