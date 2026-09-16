'use strict';
// Portal 1C Task 2 — the signed quote token. Run: node quote-token.test.js
//
// This is the security spine of the confirmed-quote gate: the token is how the server recognises, at
// charge time, a net total IT issued for THIS cart — without trusting anything the client says. So the
// tests are about what an attacker can do, not about the happy path: forge, tamper, replay, swap the
// cart underneath a valid token, and (the one Task 1 forced) swap the REWARD underneath it.
const assert = require('node:assert');
const crypto = require('node:crypto');
const { signQuoteToken, verifyQuoteToken, cartFingerprint } = require('./quote-token');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const SEC = 'test-secret-do-not-ship';
const PAYLOAD = {
  rid: 'x_pizza', customer_id: 'c1', cart_fingerprint: 'fp', net_total_cents: 34000,
  components: { base_cents: 34000, reward_discount_cents: 0, delivery_cents: 0, fiscal_cents: 4435 },
  redemption_ref: null, issued_at: 1000, expires_at: 901000, quote_id: 'q1',
};

// ── 1. ROUND-TRIP — the payload comes back exactly as it went in ───────────────────────────────
{
  const t = signQuoteToken(PAYLOAD, SEC);
  assert.strictEqual(typeof t, 'string', 'the token is a string');
  const v = verifyQuoteToken(t, SEC, 5000);
  assert.deepStrictEqual(v, { ok: true, reason: 'ok', payload: PAYLOAD },
    '🔴 a valid token round-trips its payload deep-equal');
  // …including a populated redemption_ref, which Task 3 fills and the gate reads for provenance.
  const withRedeem = { ...PAYLOAD, redemption_ref: { id: 'r-9', model: 'add_free', items: [{ item_id: 'Margherita', qty: 1 }] } };
  assert.deepStrictEqual(verifyQuoteToken(signQuoteToken(withRedeem, SEC), SEC, 5000).payload, withRedeem,
    '🔴 …and a populated redemption_ref survives signing faithfully');
  ok('a valid token round-trips its payload exactly, redemption_ref included');
}

// ── 2. 🔴 TAMPERING IS REJECTED, WHEREVER IT LANDS ─────────────────────────────────────────────
{
  const t = signQuoteToken(PAYLOAD, SEC);
  const [body, sig] = t.split('.');
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

  assert.strictEqual(verifyQuoteToken(flip(body, 4) + '.' + sig, SEC, 5000).reason, 'bad_signature',
    '🔴 a flipped PAYLOAD byte is bad_signature');
  assert.strictEqual(verifyQuoteToken(body + '.' + flip(sig, 4), SEC, 5000).reason, 'bad_signature',
    '🔴 a flipped SIGNATURE byte is bad_signature');
  assert.strictEqual(verifyQuoteToken(t, 'wrong-secret', 5000).reason, 'bad_signature',
    '🔴 the wrong secret is bad_signature');

  // The attack that matters: re-price the cart and re-sign with a secret you do not have.
  const forged = { ...PAYLOAD, net_total_cents: 1 };
  const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
  assert.strictEqual(verifyQuoteToken(forgedBody + '.' + sig, SEC, 5000).reason, 'bad_signature',
    '🔴 a re-priced payload with the original signature is bad_signature');
  assert.strictEqual(verifyQuoteToken(signQuoteToken(forged, 'attacker-secret'), SEC, 5000).reason, 'bad_signature',
    '🔴 …and re-signing it with another secret does not help');
  ok('every tamper — payload, signature, secret, re-priced body — is bad_signature');
}

// ── 3. MALFORMED INPUT IS bad_format, NEVER A THROW ────────────────────────────────────────────
// A verifier that throws on garbage is a denial-of-service on the charge path: the caller is an
// endpoint handling whatever the client sent.
{
  const garbage = ['garbage', '', '.', 'a.b.c', 'onlybody.', '.onlysig', null, undefined, 42, {}, [],
    'not-base64!.also-not', Buffer.from('{"a":1}').toString('base64url') /* no dot */];
  for (const g of garbage) {
    const v = verifyQuoteToken(g, SEC, 5000);
    assert.strictEqual(v.ok, false, `🔴 ${JSON.stringify(g)} is refused`);
    assert.ok(['bad_format', 'bad_signature'].includes(v.reason), `🔴 …with a typed reason (got ${v.reason})`);
  }
  // A body that decodes but is not JSON, and one that is JSON but not an object.
  const notJson = Buffer.from('this is not json').toString('base64url');
  assert.strictEqual(verifyQuoteToken(notJson + '.' + 'x'.repeat(43), SEC, 5000).ok, false, 'a non-JSON body is refused');
  ok(`${garbage.length + 1} malformed inputs are refused with a typed reason and no throw`);
}

// ── 4. 🔴 EXPIRY IS ENFORCED — AND ONLY AFTER THE SIGNATURE IS TRUSTED ─────────────────────────
// expires_at lives IN the payload, so it is the attacker's field until the signature says otherwise.
// A forged token claiming a far-future expiry must report bad_signature, never ok — checking expiry
// first would mean reading an untrusted number to decide whether to trust the token.
{
  const t = signQuoteToken(PAYLOAD, SEC);
  assert.strictEqual(verifyQuoteToken(t, SEC, 900999).reason, 'ok', 'valid one millisecond before expiry');
  assert.strictEqual(verifyQuoteToken(t, SEC, 901000).reason, 'expired', 'expired AT expires_at (not after)');
  assert.strictEqual(verifyQuoteToken(t, SEC, 902000).reason, 'expired', 'expired after');

  const forgedLongLife = signQuoteToken({ ...PAYLOAD, expires_at: 9e15 }, 'attacker-secret');
  assert.strictEqual(verifyQuoteToken(forgedLongLife, SEC, 5000).reason, 'bad_signature',
    '🔴 a forged far-future expiry is bad_signature — the signature is checked BEFORE the payload is believed');
  ok('expiry is enforced at the boundary, and never read before the signature is verified');
}

// ── 5. 🔴 THE FINGERPRINT BINDS THE REWARD — THE TASK 1 CARRY-FORWARD ──────────────────────────
// Task 1 proved a la_musa reward is NET-INVARIANT: add_free does not discount and there is no ISV
// split, so a reward-active cart and its no-reward twin produce the same net_total_cents. If the
// fingerprint ignored the reward, those two carts would be indistinguishable to the gate — a token
// issued for the no-reward cart would validate for the reward-active one, and the customer would
// receive a free item the quote never priced. The fingerprint is the ONLY place that difference can
// live, which is why this is a security assertion and not a hashing detail.
{
  const items = [{ id: 'dimsum_01', qty: 2 }];
  const reward = { model: 'add_free', freeItems: [{ item_id: 'dimsum_01', qty: 1, price_cents: 22300 }] };
  const other = { model: 'add_free', freeItems: [{ item_id: 'noodle_02', qty: 1, price_cents: 49200 }] };

  assert.notStrictEqual(cartFingerprint(items, reward), cartFingerprint(items, null),
    '🔴 a reward-active cart NEVER fingerprints as its no-reward twin');
  assert.notStrictEqual(cartFingerprint(items, reward), cartFingerprint(items, other),
    '🔴 two different rewards on the same cart fingerprint differently');
  assert.strictEqual(cartFingerprint(items, reward), cartFingerprint(items, { ...reward }),
    'the same reward fingerprints the same, whatever object carries it');
  // Reward QUANTITY is part of it too — two free dumplings is not one.
  assert.notStrictEqual(cartFingerprint(items, reward),
    cartFingerprint(items, { model: 'add_free', freeItems: [{ item_id: 'dimsum_01', qty: 2, price_cents: 22300 }] }),
    '🔴 the reward quantity is bound');
  ok('the fingerprint binds the reward — a reward-active cart cannot pass as its net-identical twin');
}

// ── 6. THE FINGERPRINT IS ORDER-INDEPENDENT AND SENSITIVE TO WHAT IS ORDERED ───────────────────
{
  assert.strictEqual(cartFingerprint([{ id: 1, qty: 2 }, { id: 2, qty: 1 }], null),
                     cartFingerprint([{ id: 2, qty: 1 }, { id: 1, qty: 2 }], null),
                     'item order does not change the hash');
  assert.notStrictEqual(cartFingerprint([{ id: 1, qty: 2 }], null), cartFingerprint([{ id: 1, qty: 3 }], null),
                        '🔴 quantity changes it');
  assert.notStrictEqual(cartFingerprint([{ id: 1, qty: 1 }], null), cartFingerprint([{ id: 2, qty: 1 }], null),
                        '🔴 the item changes it');
  // Extras: order-independent within a line, but present/absent and qty both matter.
  const withExtras = (ex) => cartFingerprint([{ id: 1, qty: 1, extras: ex }], null);
  assert.strictEqual(withExtras([{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }]),
                     withExtras([{ id: 'b', qty: 2 }, { id: 'a', qty: 1 }]), 'extras order does not change the hash');
  assert.notStrictEqual(withExtras([{ id: 'a', qty: 1 }]), withExtras([]), '🔴 an extra changes it');
  assert.notStrictEqual(withExtras([{ id: 'a', qty: 1 }]), withExtras([{ id: 'a', qty: 2 }]), '🔴 an extra QUANTITY changes it');
  /* 🔴 ZERO IS NOT ONE. `Number(qty) || 1` made a quantity of 0 hash identically to 1, so a cart
     claiming none of something matched a token issued for one of it. The default is gone: the
     fingerprint records what it was given, because repairing a value is how two different carts
     become one hash. */
  assert.notStrictEqual(withExtras([{ id: 'a', qty: 0 }]), withExtras([{ id: 'a', qty: 1 }]),
    '🔴 an extra quantity of 0 does not fingerprint as 1');
  assert.notStrictEqual(cartFingerprint([{ id: 1, qty: 0 }], null), cartFingerprint([{ id: 1, qty: 1 }], null),
    '🔴 an item quantity of 0 does not fingerprint as 1');
  const rw = (q) => cartFingerprint([{ id: 'x', qty: 1 }], { model: 'add_free', freeItems: [{ item_id: 'f', qty: q, price_cents: 100 }] });
  assert.notStrictEqual(rw(0), rw(1), '🔴 a REWARD quantity of 0 does not fingerprint as 1');
  // x_pizza keys options by NAME and la_musa by ID — both must be bound.
  assert.notStrictEqual(cartFingerprint([{ name: 'Margherita', qty: 1 }], null),
                        cartFingerprint([{ name: 'Pepperoni', qty: 1 }], null), '🔴 a name-keyed item is bound');
  ok('the fingerprint is order-independent and sensitive to item, qty, extras and extra-qty');
}

// ── 7. 🔴 NO DELIMITER COLLISION — the classic hashing hole ────────────────────────────────────
// A fingerprint built by joining fields with a separator collides whenever the separator can appear
// inside a field: an item literally named "a|1" would hash identically to two different items. These
// are the pairs that must NOT collide.
{
  const pairs = [
    [[{ id: 'a', qty: 1 }, { id: 'b', qty: 1 }], [{ id: 'a|b', qty: 1 }]],
    [[{ id: 'a:1', qty: 2 }], [{ id: 'a', qty: 12 }]],
    [[{ id: 'x', qty: 1, extras: [{ id: 'y', qty: 1 }] }], [{ id: 'x', qty: 1 }, { id: 'y', qty: 1 }]],
  ];
  for (const [a, b] of pairs) {
    assert.notStrictEqual(cartFingerprint(a, null), cartFingerprint(b, null),
      `🔴 no collision: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  ok(`${pairs.length} delimiter-collision pairs hash differently`);
}

// ── 8. THE SIGNATURE IS HMAC-SHA256 AND THE COMPARE IS CONSTANT-TIME ───────────────────────────
// Asserted structurally: the digest must equal an independently computed HMAC-SHA256 (so the
// algorithm is what it claims), and the source must use timingSafeEqual (so a byte-at-a-time forgery
// oracle is not available). A behavioural timing test would be flaky; the structural one is exact.
{
  const t = signQuoteToken(PAYLOAD, SEC);
  const [body, sig] = t.split('.');
  const expect = crypto.createHmac('sha256', SEC).update(Buffer.from(body, 'base64url')).digest('base64url');
  assert.strictEqual(sig, expect, '🔴 the signature IS HMAC-SHA256 over the exact signed bytes');
  assert.strictEqual(Buffer.from(sig, 'base64url').length, 32, 'a full 256-bit digest, not truncated');

  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'quote-token.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(/timingSafeEqual/.test(src), '🔴 the compare is crypto.timingSafeEqual, not ===');
  assert.ok(!/===\s*expectedSig|expectedSig\s*===/.test(src), 'no string-equality shortcut beside it');
  // NON-VACUITY: the strip really removed comments, so this is reading code and not its documentation.
  assert.ok(!/THE COMPARE IS CONSTANT-TIME/.test(src), 'non-vacuity: prose was stripped before the census');
  ok('HMAC-SHA256 over the signed bytes, full-length, compared in constant time');
}

// ── 9. THE TOKEN IS URL-SAFE AND SELF-DELIMITING ───────────────────────────────────────────────
// It travels in JSON bodies today and may end up in a header or a query later; base64url avoids the
// re-encoding bugs that only show up in production.
{
  const t = signQuoteToken({ ...PAYLOAD, quote_id: 'q/with+odd=chars' }, SEC);
  assert.ok(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t), `🔴 the token is URL-safe base64url (${t.slice(0, 40)}…)`);
  assert.strictEqual(t.split('.').length, 2, 'exactly two parts');
  assert.strictEqual(verifyQuoteToken(t, SEC, 5000).payload.quote_id, 'q/with+odd=chars',
    'and odd characters survive the round-trip');
  ok('the token is URL-safe, two-part, and round-trips awkward characters');
}

// ── 10. 🔴 ORDER-INDEPENDENCE WHERE THE COMPARATOR USED TO TIE ─────────────────────────────────
// Two lines of the same dish at the same quantity, differing only in their extras — an ordinary
// x_pizza cart (two Carnívoras, one with extra cheese, one with pepperoni). The first comparator
// sorted on key then qty, so these TIED, and a stable sort then preserved input order: the two
// orderings of one cart hashed differently and the gate would have refused an honest customer.
{
  const a = { id: 'carn', qty: 1, extras: [{ id: 'cheese', qty: 1 }] };
  const b = { id: 'carn', qty: 1, extras: [{ id: 'pepperoni', qty: 1 }] };
  assert.strictEqual(cartFingerprint([a, b], null), cartFingerprint([b, a], null),
    '🔴 same dish, same qty, different extras — reordering must NOT change the hash');
  // …and the same tie by NAME, which is how x_pizza keys.
  const c = { name: 'Carnivora', qty: 2, extras: [{ name: 'Mozzarella' }] };
  const d = { name: 'Carnivora', qty: 2, extras: [{ name: 'Basil Pesto' }] };
  assert.strictEqual(cartFingerprint([c, d], null), cartFingerprint([d, c], null),
    '🔴 …and the same holds for name-keyed lines');
  // Three-way tie, to be sure the fix is a total order and not a two-element accident.
  const e = { id: 'carn', qty: 1, extras: [{ id: 'bacon', qty: 1 }] };
  assert.strictEqual(cartFingerprint([a, b, e], null), cartFingerprint([e, a, b], null), 'a three-way tie is stable too');
  assert.strictEqual(cartFingerprint([a, b, e], null), cartFingerprint([b, e, a], null), '…in every rotation');
  // NON-VACUITY: these carts are genuinely DIFFERENT from each other, so the equality above is the
  // sort working and not everything collapsing to one hash.
  assert.notStrictEqual(cartFingerprint([a, b], null), cartFingerprint([a, e], null),
    'non-vacuity: different extras still produce different carts');
  ok('order-independence holds where the comparator used to tie — same dish, same qty, different extras');
}

// ── 11. 🔴 A CLOCK THAT CANNOT BE TRUSTED IS A REFUSAL, NOT A PASS ─────────────────────────────
// The bug was FAIL-OPEN: NaN >= expires_at is false, so an invalid clock read as "not expired" and an
// EXPIRED token verified ok. A clock we cannot trust is the absence of evidence about freshness, and
// the safe reading of that at a charge boundary is no.
{
  const expired = signQuoteToken({ ...PAYLOAD, expires_at: 1000 }, SEC);
  for (const clock of [undefined, NaN, 'bad', null, {}, [], Infinity, -Infinity, '5000']) {
    const v = verifyQuoteToken(expired, SEC, clock);
    assert.strictEqual(v.ok, false, `🔴 clock ${JSON.stringify(clock)} must not verify an expired token`);
    assert.strictEqual(v.reason, 'bad_clock', `🔴 …and says the CLOCK is the problem (got ${v.reason})`);
  }
  // NON-VACUITY: a real clock still works, in both directions.
  assert.strictEqual(verifyQuoteToken(signQuoteToken(PAYLOAD, SEC), SEC, 5000).reason, 'ok', 'a real clock still verifies');
  assert.strictEqual(verifyQuoteToken(expired, SEC, 5000).reason, 'expired', 'and still expires');
  assert.strictEqual(verifyQuoteToken(signQuoteToken(PAYLOAD, SEC), SEC, 0).reason, 'ok', 'zero is a legitimate clock');
  ok('a non-finite or non-numeric clock refuses — fail closed, and a real clock is unaffected');
}

// ── 12. 🔴 THE TWO PROPERTIES, PINNED DIRECTLY RATHER THAN AS A SIDE EFFECT ────────────────────
{
  // (a) SIGNATURE BEFORE EXPIRY. The earlier forged-expiry case used a FUTURE expiry, so mutated code
  //     that checks expiry first would pass that check and still reach the signature — it reported
  //     bad_signature either way and proved nothing about the order. A forged token that is ALSO
  //     EXPIRED separates them: check-expiry-first answers 'expired' (having believed an unsigned
  //     payload), check-signature-first answers 'bad_signature'.
  const forgedExpired = signQuoteToken({ ...PAYLOAD, expires_at: 1000 }, 'attacker-secret');
  assert.strictEqual(verifyQuoteToken(forgedExpired, SEC, 5000).reason, 'bad_signature',
    '🔴 a forged AND expired token is a FORGERY — the signature is judged before the payload is believed');

  // (b) HMAC OVER THE TRANSMITTED BYTES. A body that parses to the same object but is encoded
  //     differently must not verify: re-serialising before hashing would make the signature cover "the
  //     object" rather than "the bytes", and two encodings of one object would be interchangeable.
  const body = JSON.stringify(PAYLOAD);
  const sig = crypto.createHmac('sha256', SEC).update(Buffer.from(body)).digest('base64url');
  const reEncoded = '{ ' + body.slice(1);                       // same object, different bytes
  assert.deepStrictEqual(JSON.parse(reEncoded), PAYLOAD, 'premise: the re-encoded body parses identically');
  assert.notStrictEqual(reEncoded, body, 'premise: …but the bytes differ');
  const swapped = Buffer.from(reEncoded).toString('base64url') + '.' + sig;
  assert.strictEqual(verifyQuoteToken(swapped, SEC, 5000).reason, 'bad_signature',
    '🔴 an alternate encoding of the same payload does not verify — the HMAC covers the BYTES');
  ok('sig-before-expiry and HMAC-over-transmitted-bytes each have their own discriminating case');
}

console.log(`\nquote-token: OK (${n})`);
