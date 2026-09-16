// Portal 1C Task 7 — COPY INTEGRITY for the confirmed-quote store.
// Run: node --test xpizza-orders/form-confirm-quote.copy.test.mjs
//
// 🔴 IN ITS OWN FILE, for the same reason as form-cart.copy.test.mjs: the mutation sweep mutates the
// CANONICAL copy, so a byte-parity assertion sitting beside behavioural tests would kill every mutant
// by the copies differing, and not one would reach a behavioural assertion.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('the la_musa copy of the confirmed-quote store is byte-identical to the canonical one', () => {
  const canonical = readFileSync(new URL('./form-confirm-quote.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../la-musa-orders/form-confirm-quote.js', import.meta.url), 'utf8');
  assert.strictEqual(copy, canonical,
    'la-musa-orders/form-confirm-quote.js has drifted — copy xpizza-orders/form-confirm-quote.js over it');
  assert.ok(canonical.includes('function createConfirmQuote'), 'non-vacuity: the file really is the store');
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code),
    'no ESM syntax — the same bytes must load as a Node module AND a classic browser script');
  assert.ok(/module\.exports/.test(code) && /window\.createConfirmQuote/.test(code),
    '…and it must publish itself to BOTH worlds');
});

test('both forms load the store and wire it at every seam — identically', () => {
  const census = {};
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const raw = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    assert.ok(raw.includes('<script src="form-confirm-quote.js"></script>'), `${dir}: the store is not loaded`);

    // Comments stripped: this wiring is heavily commented and every one of those comments names the
    // very identifiers this census counts. Reading its own documentation as evidence is the failure
    // two earlier censuses in this repo already made.
    const html = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const n = (re) => (html.match(re) || []).length;

    census[dir] = {
      // TWO quote paths store: quoteOrder's response handler and the reward callback. Both, or a
      // reward-active cart silently never gets a token.
      store: n(/__confirmQuote\.store\(/g),
      // TWO sends attach: createOrder and chargeOnlineOrder — the two charge paths 1B established.
      attach: n(/__confirmQuote\.attach\(/g),
      refreshStart: n(/__confirmQuote\.scheduleRefresh\(/g),
      refreshStop: n(/__confirmQuote\.stopRefresh\(/g),
      sig: n(/function confirmQuoteCartSig\(\)/g),
    };
    assert.deepStrictEqual(census[dir], { store: 2, attach: 2, refreshStart: 1, refreshStop: 1, sig: 1 },
      `${dir}: the confirmed-quote wiring census does not match`);

    /* 🔴 THE ATTACH MUST SIT AT THE SEND, BEHIND THE CONFLICT GATE — not earlier. Attaching while
       composing the order would bind a token to a cart the customer can still edit before the fetch,
       which is the one thing this module exists to prevent. Anchored on `raw` because where a call
       sits is a fact about the code as written. */
    assert.ok(/if\(refuseConflictedSend\('createOrder'\)\)\{ orderSubmitting=false; return; \}\n(?:[^\n]*\n){0,10}?      try\{ if\(__confirmQuote\) __confirmQuote\.attach\(currentOrder, __orderSigAtBuild\); \}catch\(_\)\{\}\n      const res = await fetch\(CREATEORDER_URL,\{/.test(raw),
      `${dir}: the createOrder attach must sit between the conflict gate and the fetch`);
    assert.ok(/if\(refuseConflictedSend\('chargeOnlineOrder'\)\) return paymentFallback\([^\n]*\);\n(?:[^\n]*\n){0,10}?    try\{ if\(__confirmQuote\) __confirmQuote\.attach\(currentOrder, __orderSigAtBuild\); \}catch\(_\)\{\}\n    const res = await fetch\(CHARGEORDER_URL, \{/.test(raw),
      `${dir}: the chargeOnlineOrder attach must sit between the conflict gate and the fetch`);

    /* 🔴 THE SIGNATURE MUST FOLD IN THE REWARD. redeemCartItems() serializes the cart only, so without
       the reward a reward-active token would attach to a reward-off cart and meet the server's
       fingerprint. Proven behaviourally in confirm-quote-wiring.test.mjs; pinned here so a future
       simplification back to `JSON.stringify(redeemCartItems())` fails the build. */
    assert.ok(/function confirmQuoteCartSig\(\)\{[\s\S]{0,700}?getRedeemPayload[\s\S]{0,400}?reward:/.test(html),
      `${dir}: the token signature must include the applied reward, not just the cart`);

    /* 🔴 THE ATTACH TAKES THE BUILD-TIME STAMP, NOT A LIVE READ. currentOrder is composed at
       buildOrder() and sent later, behind an auth await and a retry loop; reading the signature at the
       send binds the token to whatever the cart is by THEN, so an edit in that window ships one cart's
       body carrying another cart's token — refused by the server's fingerprint even under grace.
       Proven behaviourally in confirm-quote-wiring.test.mjs; pinned here because the difference between
       the two is a single argument and reads as cosmetic. */
    assert.strictEqual((html.match(/__confirmQuote\.attach\(currentOrder, __orderSigAtBuild\)/g) || []).length, 2,
      `${dir}: both attaches must use the build-time signature`);
    assert.ok(!/__confirmQuote\.attach\(currentOrder, confirmQuoteCartSig\(\)\)/.test(html),
      `${dir}: …and neither may re-read the signature from live state at the send`);
    assert.strictEqual((html.match(/__orderSigAtBuild = confirmQuoteCartSig\(\);/g) || []).length, 1,
      `${dir}: the stamp is taken exactly once, where the body is composed`);
    // …and it must NOT have become an alias for the 1B display key, whose semantics it deliberately
    // does not share.
    assert.ok(!/function confirmQuoteCartSig\(\)\{ ?return serverQuoteCartKey\(\)/.test(html),
      `${dir}: the token signature must stay distinct from serverQuoteCartKey()`);
  }
  assert.deepStrictEqual(census['xpizza-orders'], census['la-musa-orders'],
    'the two forms must be wired identically — a seam present in one brand only is a silent asymmetry');
});

test('every inline script in both forms parses — the wiring did not break the page', () => {
  /* 🔴 THIS IS NOT PARANOIA, IT IS A REGRESSION TEST. The first draft of the T7 wiring inserted the
     store between an `if(...){...}` and its `else`, which is a SyntaxError that takes the entire form
     script down: no menu, no cart, no checkout. Every structural assertion above still passed on that
     file, because they read text. The jsdom suite caught it, and so does this — cheaply, and with an
     error that names the problem. */
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const html = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(inline.length >= 1, `${dir}: non-vacuity — there are inline scripts to check`);
    for (const [i, m] of inline.entries()) {
      assert.doesNotThrow(() => new Function(m[1]),
        `${dir}: inline script #${i} does not parse — the form would not boot`);
    }
  }
  assert.throws(() => new Function('if(a){}\nfoo();\nelse{}'), 'non-vacuity: the parser check can see the exact break this caught');
});
