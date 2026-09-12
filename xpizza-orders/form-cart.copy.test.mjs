// Portal 1B Task 4 — COPY INTEGRITY for the shared cart model.
// Run: node --test xpizza-orders/form-cart.copy.test.mjs
//
// 🔴 IN ITS OWN FILE, deliberately — the same reason as form-live-menu.copy.test.mjs. The mutation
// sweep mutates the CANONICAL copy and runs a suite; with this assertion sitting beside behavioural
// tests, EVERY mutant trips it, every mutant is "killed" by the copies differing, and not one of them
// ever reaches a behavioural assertion. That slice reported 13/13 and proved nothing. Separated, a
// kill in the behavioural suite means the behaviour noticed.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

test('the la_musa copy of the cart model is byte-identical to the canonical one', () => {
  const canonical = readFileSync(new URL('./form-cart.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../la-musa-orders/form-cart.js', import.meta.url), 'utf8');
  assert.strictEqual(copy, canonical,
    'la-musa-orders/form-cart.js has drifted — copy xpizza-orders/form-cart.js over it');
  assert.ok(canonical.includes('function createCart'), 'non-vacuity: the file really is the cart model');
  // COMMENT-STRIPPED and line-anchored — a guard that matched the word `export` inside the file's own
  // prose explaining it uses no `export` would be reading its documentation as evidence.
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code),
    'no ESM syntax — the same bytes must load as a Node module AND a classic browser script');
  assert.ok(/module\.exports/.test(code) && /window\.createCart/.test(code),
    '...and it must publish itself to BOTH worlds');
  assert.ok(/^\s*export[\s{]/m.test('export function x() {}'), 'non-vacuity: the detector can see an export');
});

test('both forms load the cart model, and neither still filters the cart out of MENU', () => {
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const html = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    assert.ok(html.includes('<script src="form-cart.js"></script>'), `${dir}: form-cart.js is not loaded`);
    // 🔴 THE CENSUS. Task 4's whole claim is that no cart read is menu-derived any more. Code only —
    // the comments in both forms quote the old expression to explain what was wrong with it, and a
    // census that counted its own explanation would report a violation forever (or, worse, be
    // "fixed" by deleting the explanation).
    // BLOCK comments stripped before line comments — the first version of this filtered only on a
    // line's leading token, so the middle lines of the /* … */ header (which quotes the old expression
    // to explain what was wrong with it) still counted, and the census reported a violation against
    // its own documentation. Same failure as the `export`-in-a-comment one, one file over.
    const code = html.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const menuDerived = code.match(/MENU\.(filter|reduce|some|every)\([^\n]{0,90}?qty\[/g) || [];
    assert.deepStrictEqual(menuDerived, [], `${dir}: a cart read is still derived from MENU: ${menuDerived.join(' | ')}`);
    // non-vacuity: the detector really fires on the shipped expression it is looking for
    assert.strictEqual((`const items=MENU.filter(p=>qty[p.id]>0);`.match(/MENU\.(filter|reduce|some|every)\([^\n]{0,90}?qty\[/g) || []).length, 1,
      'non-vacuity: the census can see the old expression');
  }
});

test('the conflict gate sits at every path to a charge — structural census, both forms', () => {
  // 🔴 THIS LIVES HERE, NOT IN THE BEHAVIOURAL SUITE, and it is the Task 3 drift-mask correction again.
  // The mutation sweep runs cart-decoupling.test.mjs; a textual "the gate is present" check sitting in
  // that file would kill every gate-removal mutant by TEXT, so the kill count would say nothing about
  // whether any behaviour noticed. Behaviour proves the gates work; this proves they are where the
  // argument says they are — two different claims, kept in two different files.
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const raw = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    /* 🔴 COMMENTS STRIPPED BEFORE COUNTING — and this is the SECOND census in this file to need it.
       The first counted the old MENU-derived cart expression that the code's own header quotes while
       explaining what was wrong with it. This one counted a comment in the Task 6 apply block that
       mentions cartConflicts() while describing what reconciles the cart, and reported five gates where
       there are four. A census that reads its own documentation as evidence can be "fixed" by deleting
       the explanation, which is the wrong repair and the reason this is stripped rather than reworded. */
    const html = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    // COUNTS use the comment-stripped source; PLACEMENT assertions below read `raw`, because where a
    // gate sits is a fact about the code as written — and two of those patterns deliberately anchor on
    // the comment that marks the gate.
    // Exactly four sites: the definition, the SEND gate, and the two entry gates.
    assert.strictEqual((html.match(/cartConflicts\(\)/g) || []).length, 4,
      `${dir}: expected 4 cartConflicts() sites — definition, refuseConflictedSend, buildOrder, submitOrder`);

    // 🔴 THE SEND GATE, INSIDE THE RETRY LOOP, with nothing between the check and the fetch. The retry
    // re-sends createOrder without rebuilding the order, so a gate before the loop does not cover it.
    assert.ok(/for\(let attempt=1; attempt<=MAX_TRIES; attempt\+\+\)\{\n    try \{\n(?:[^\n]*\n){0,4}?      if\(refuseConflictedSend\('createOrder'\)\)\{ orderSubmitting=false; return; \}\n      const res = await fetch\(CREATEORDER_URL,\{/.test(raw),
      `${dir}: the createOrder send gate must sit INSIDE the retry loop, immediately before the fetch`);
    assert.ok(/if\(refuseConflictedSend\('chargeOnlineOrder'\)\) return paymentFallback\([^\n]*\);\n    const res = await fetch\(CHARGEORDER_URL, \{/.test(raw),
      `${dir}: the chargeOnlineOrder send gate must sit immediately before the fetch`);

    /* 🔴 A DOCUMENTED LINT, NOT A PROOF — and saying so is the point. The guarantee is that the two
       sends which exist are each gated, asserted structurally above and behaviourally in
       cart-decoupling.test.mjs. THIS check is a tripwire for a future third send, and a tripwire is
       only as good as its pattern: the first version matched `await fetch(CONSTANT` alone, so an
       un-awaited fetch, a `window.fetch`, an XHR, a sendBeacon, or a literal URL would all have walked
       past it while it reported "exactly 2 charge sends" with total confidence. Widened below — but it
       still cannot see a URL assembled at runtime, and no regex can. It is a lint. If a third send is
       ever added, gate it; do not expect this to be what tells you. */
    const chargeRef = String.raw`(CREATEORDER_URL|CHARGEORDER_URL|['"\`][^'"\`]*(createOrder|chargeOnlineOrder)[^'"\`]*['"\`])`;
    const sendRe = new RegExp(String.raw`(?:fetch|sendBeacon|\.open)\s*\(\s*(?:['"\`]?(?:POST|GET)['"\`]?\s*,\s*)?` + chargeRef, 'g');
    const sends = html.match(sendRe) || [];
    assert.strictEqual(sends.length, 2,
      `${dir}: expected exactly 2 charge-send call sites, found ${sends.length} — a new one needs its own gate: ${sends.join(' | ')}`);
    // …and no XHR or beacon anywhere near a charge URL, which the count above would not distinguish.
    assert.ok(!/XMLHttpRequest[\s\S]{0,400}?(CREATEORDER_URL|CHARGEORDER_URL)/.test(html),
      `${dir}: a charge sent over XHR would bypass the fetch-shaped gate entirely`);
    // non-vacuity: each shape the widened pattern claims to catch really is caught
    // A probe for EVERY shape the pattern claims to recognise. Widening a regex and then proving only
    // the shapes it already caught leaves the new branches unexercised — the pattern would claim XHR
    // and sendBeacon coverage it had never been shown to have.
    // Each transport is probed in BOTH forms it can take — against a URL constant and against a literal
    // URL — because those exercise different alternatives of the pattern. Proving only the constant form
    // would leave the literal branch unexercised for that transport, which is the same gap this list was
    // widened to close.
    for (const probe of ['fetch(CREATEORDER_URL,{', 'window.fetch(CHARGEORDER_URL, {',
                         "fetch('https://x/createOrder', {", "xhr.open('POST', CHARGEORDER_URL)",
                         "navigator.sendBeacon(CREATEORDER_URL, body)",
                         "xhr.open('POST', 'https://x/chargeOnlineOrder')",
                         "navigator.sendBeacon('https://x/createOrder', body)"]) {
      assert.ok(new RegExp(sendRe.source).test(probe), `non-vacuity: the send-site lint can see ${probe}`);
    }
    // …and that it does NOT fire on an unrelated request, or the count above would be noise.
    assert.ok(!new RegExp(sendRe.source).test("fetch(AVAIL_URL, { cache:'no-store' })"),
      'the send-site lint must not match a non-charge request');

    // The dispatch must honour buildOrder()'s refusal BEFORE it branches to cash or online.
    assert.ok(/\n  if\(!buildOrder\(\)\) return;   \/\/ 1B Task 4[^\n]*\n  if\(isFreeOrder\)\{[\s\S]{0,900}?if\(selectedPayment==='online'\)\{\n    await processPixelPay\(\);/.test(raw),
      `${dir}: processPayment must honour buildOrder()'s refusal before branching`);

    /* 🔴 NOTHING OUTSIDE THE BODY. The live apply's rollback captures whole top-level regions — body's
       element children — which is closed by construction for everything inside the body, and says
       nothing about <head>. That is sound only while no renderer writes there, so that is asserted
       rather than assumed: a style or script injected into <head> by a render would be unrollbackable
       and would leave a failed apply's styling behind. Checked on the comment-stripped source so a
       mention in prose does not count. */
    assert.ok(!/document\.head/.test(html), `${dir}: no code may write to <head> — the apply's rollback cannot reach it`);
    assert.ok(!/createElement\(\s*['"](?:style|link|script)['"]\s*\)/.test(html),
      `${dir}: no stylesheet/script injection — same reason`);
    // non-vacuity: the detectors fire on the shapes they claim to catch
    assert.ok(/document\.head/.test('document.head.appendChild(x)'), 'non-vacuity: head-write detector works');
    assert.ok(/createElement\(\s*['"](?:style|link|script)['"]\s*\)/.test("createElement('style')"), 'non-vacuity: injection detector works');
    // non-vacuity: stripping comments must not have eaten the code the census counts
    assert.ok(html.includes('function cartConflicts()'), `${dir}: the comment-strip left the code intact`);
    assert.strictEqual(('a(); // cartConflicts()\n/* cartConflicts() */\ncartConflicts();'
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
      .match(/cartConflicts\(\)/g) || []).length, 1, 'non-vacuity: the strip removes both comment forms and keeps the call');
    // non-vacuity: the send-site detector really fires on the shipped expression
    assert.strictEqual(('const res = await fetch(CREATEORDER_URL,{'.match(/await fetch\((CREATEORDER_URL|CHARGEORDER_URL)/g) || []).length, 1,
      'non-vacuity: the send-site census can see a charge send');
  }
});

test('the la_musa copy of the applier is byte-identical to the canonical one', () => {
  const canonical = readFileSync(new URL('./form-apply.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../la-musa-orders/form-apply.js', import.meta.url), 'utf8');
  assert.strictEqual(copy, canonical,
    'la-musa-orders/form-apply.js has drifted — copy xpizza-orders/form-apply.js over it');
  assert.ok(canonical.includes('function createMenuApplier'), 'non-vacuity: the file really is the applier');
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code), 'no ESM syntax');
  assert.ok(/module\.exports/.test(code) && /window\.createMenuApplier/.test(code), '…and it publishes to both worlds');
});

test('both forms load all three shared modules and boot the live feed', () => {
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const html = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    for (const mod of ['form-cart.js', 'form-live-menu.js', 'form-apply.js']) {
      assert.ok(html.includes(`<script src="${mod}"></script>`), `${dir}: ${mod} is not loaded`);
    }
    // 🔴 THE BRAND'S OWN rid, READ AT CALL TIME. Bound eagerly this sat above the constant it reads and
    // threw a temporal-dead-zone ReferenceError that took the whole form script down — a page with no
    // menu, no cart and no checkout. Pinned so it cannot quietly become a const again.
    assert.ok(/function liveMenuRid\(\)\{ return (AVAIL_RID|RESTAURANT_ID); \}/.test(html),
      `${dir}: the rid must be read at call time, not bound above its declaration`);
    // The coordinator is given a fetch rather than closing over one — a missing injection used to look
    // exactly like being offline.
    assert.ok(/fetchImpl: function \(u, o\) \{ return window\.fetch\(u, o\); \}/.test(html),
      `${dir}: the live feed must be given a fetch implementation`);
  }
});
