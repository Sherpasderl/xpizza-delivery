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
    /* 🔴 THE GATE, THEN AT MOST THE 1C TOKEN ATTACH, THEN THE FETCH — and nothing else. 1C Task 7 adds
       one line between the gate and each send (it must attach at the send, for the same reason the gate
       is there: anything earlier binds to a cart the customer can still edit). So the adjacency is
       widened by exactly that one statement, spelled out in full rather than replaced by a wildcard —
       a `[\s\S]*?` here would let any future statement slip between the conflict check and the fetch,
       which is the precise thing this assertion exists to forbid. */
    const ATTACH = String.raw`(?:\s*/\*[\s\S]*?\*/\n)?(?:\s*try\{ if\(__confirmQuote\) __confirmQuote\.attach\(currentOrder, __orderSigAtBuild\); \}catch\(_\)\{\}\n)?`;
    assert.ok(new RegExp(String.raw`for\(let attempt=1; attempt<=MAX_TRIES; attempt\+\+\)\{\n    try \{\n(?:[^\n]*\n){0,4}?      if\(refuseConflictedSend\('createOrder'\)\)\{ orderSubmitting=false; return; \}\n` + ATTACH + String.raw`      const res = await fetch\(CREATEORDER_URL,\{`).test(raw),
      `${dir}: the createOrder send gate must sit INSIDE the retry loop, immediately before the fetch`);
    assert.ok(new RegExp(String.raw`if\(refuseConflictedSend\('chargeOnlineOrder'\)\) return paymentFallback\([^\n]*\);\n` + ATTACH + String.raw`    const res = await fetch\(CHARGEORDER_URL, \{`).test(raw),
      `${dir}: the chargeOnlineOrder send gate must sit immediately before the fetch`);
    // non-vacuity: the widened pattern must still REFUSE an unrelated statement wedged in between.
    assert.ok(!new RegExp(String.raw`if\(refuseConflictedSend\('chargeOnlineOrder'\)\) return paymentFallback\([^\n]*\);\n` + ATTACH + String.raw`    const res = await fetch\(CHARGEORDER_URL, \{`)
      .test("if(refuseConflictedSend('chargeOnlineOrder')) return paymentFallback('x');\n    mutateCart();\n    const res = await fetch(CHARGEORDER_URL, {"),
      'non-vacuity: the widened adjacency still rejects an arbitrary statement between the gate and the fetch');

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

test('the la_musa copy of the safe renderer is byte-identical to the canonical one', () => {
  const canonical = readFileSync(new URL('./form-safe-render.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../la-musa-orders/form-safe-render.js', import.meta.url), 'utf8');
  assert.strictEqual(copy, canonical,
    'la-musa-orders/form-safe-render.js has drifted — copy xpizza-orders/form-safe-render.js over it');
  assert.ok(canonical.includes('function safeImgUrl'), 'non-vacuity: the file really is the renderer');
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code), 'no ESM syntax');
  assert.ok(/module\.exports/.test(code) && /window\.safeText/.test(code), '…and it publishes to both worlds');
});

test('1B Task 8 — the authored-field census (A DOCUMENTED LINT, NOT A PROOF)', () => {
  /* 🔴 WHAT THIS IS. A tripwire over the render paths, listing the contexts that were converted so a
     new one is noticed. It is NOT the guarantee, and the distinction matters: the guarantee is 1A's
     publish-time validation plus the reviewed renderers in form-safe-render.js. A regex census cannot
     see a template nobody has written yet, cannot follow a value through a helper, and cannot know
     which context a new interpolation lands in. Read it as "nothing known regressed", never as
     "nothing can get through".

     CONVERTED SITES, by context:
       body text   card name/desc/emoji/price, bev-row name/price, cart-review name/qty,
                   category titles, detail name/desc/price, option names/prices
       attribute   every element id and data- attribute built from an authored id; img alt
       URL         card photo, detail hero photo (both brands) — safeImgUrl policy
       CSS         card and hero background colour — safeColor grammar
       identifier  every click that used to be onclick="fn(<authored id>)" — now data-act/data-id
                   resolved through MENU/EXTRAS by one delegated listener per form */
  for (const dir of ['xpizza-orders', 'la-musa-orders']) {
    const raw = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    // Comment-stripped: this file's own prose quotes the old onclick shape to explain what was wrong
    // with it, and a census that counted its own documentation would report a violation forever.
    const html = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    assert.ok(raw.includes('<script src="form-safe-render.js"></script>'), `${dir}: the renderer is not loaded`);

    /* 🔴 NO HANDLER MAY BE BUILT FROM AUTHORED DATA — the whole identifier class, as one check.
       TWO PRECISE PATTERNS, not one line-scoped heuristic. A handler can be assembled two ways: inside a
       template literal (onclick="fn(${id})") or by CONCATENATION ('onclick="fn(\'' + id + '\')"'). An
       earlier version anchored on `on…="` and matched forward, which cannot span the second shape at
       all — it would have missed la_musa's original templates entirely, a lint blind to the very form it
       was written for. A line-scoped version saw both but also flagged three lines whose interpolation
       fed a `src`, not a handler; it did find a real unconverted hero photo among them, which is the
       argument for having it at all, and the argument for making it precise enough to keep. Both
       patterns stop at the closing quote of the handler's own value, so an interpolation elsewhere on
       the line is not its business. */
    const TEMPLATE_HANDLER = /\bon[a-z]+\s*=\s*"[^"]*\$\{/;
    const CONCAT_HANDLER   = /\bon[a-z]+\s*=\s*"[^"]*'\s*\+/;
    const handlerLines = html.split('\n').filter((l) => TEMPLATE_HANDLER.test(l) || CONCAT_HANDLER.test(l));
    assert.deepStrictEqual(handlerLines.map((l) => l.trim().slice(0, 90)), [],
      `${dir}: an event attribute is built from authored data on these lines`);

    /* 🔴 AND THE URL CONTEXT, which the handler census above cannot see — it is not a handler. This is
       the line that would have caught the la_musa detail hero photo, whose src was still built straight
       from an authored id after the first conversion pass: every `src=` assembled from data must go
       through safeImgUrl. `logoSrc` is excluded by name and for a stated reason — it is read from the
       page's own DOM (.logo-img), not from the catalog, so it is not authored input. */
    /* A sink may ALSO satisfy the policy through a named binding — `const heroUrl = HAS_PHOTO.has(id)
       ? safeImgUrl(...) : ''` then `src="${safeText(heroUrl)}"`. That indirection is not evasion, it is
       the fix for a real bug: when the image branch asked the helper and the placeholder branch asked
       HAS_PHOTO, a rejected photo produced neither and left an empty tile. Both branches now ask the
       one binding. So the census RESOLVES the identifier rather than trusting it — the name must be
       bound in this file from safeImgUrl. A bare `src="${safeText(p.img)}"` still fails, because
       `p.img` is no such binding. */
    const policedBindings = new Set(
      [...html.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*safeImgUrl\s*\(/g)].map((m) => m[1])
    );
    const unpolicedSrc = (html.match(/src="[^"]*\$\{[^}]*\}[^"]*"/g) || [])
      .filter((m) => !/safeImgUrl/.test(m) && !/logoSrc/.test(m))
      .filter((m) => {
        const via = m.match(/\$\{\s*safeText\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\}/);
        return !(via && policedBindings.has(via[1]));
      });
    assert.deepStrictEqual(unpolicedSrc, [],
      `${dir}: a src is built from data without the URL policy: ${unpolicedSrc.join(' | ')}`);

    /* 🔴 AND THE BINDING BRANCH IS NOT A LOOPHOLE. Widening a lint is exactly where one stops biting, so
       the widened census is run against hostile shapes it MUST still flag, and against the shipped shape
       it must accept. Without this, `src="${safeText(anything)}"` would have become a free pass. */
    const censor = (src) => {
      const bound = new Set([...src.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*safeImgUrl\s*\(/g)].map((m) => m[1]));
      return (src.match(/src="[^"]*\$\{[^}]*\}[^"]*"/g) || [])
        .filter((m) => !/safeImgUrl/.test(m) && !/logoSrc/.test(m))
        .filter((m) => {
          const via = m.match(/\$\{\s*safeText\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\}/);
          return !(via && bound.has(via[1]));
        });
    };
    for (const hostile of [
      'x = `<img src="${safeText(p.img)}">`',                              // escaped, never policed
      'const u = p.img;\nx = `<img src="${safeText(u)}">`',                // bound, but not from the helper
      'x = `<img src="${p.img}">`',                                        // raw
      'const heroUrl = pickUrl(p);\nx = `<img src="${safeText(heroUrl)}">`', // right NAME, wrong source
    ]) assert.strictEqual(censor(hostile).length, 1, `non-vacuity: the src census still flags ${JSON.stringify(hostile)}`);
    for (const ok of [
      'const heroUrl = HAS.has(i) ? safeImgUrl(p.img) : "";\nx = `<img src="${safeText(heroUrl)}">`',
      'x = `<img src="${safeText(safeImgUrl(p.img))}">`',
    ]) assert.deepStrictEqual(censor(ok), [], `the src census accepts the policed shape ${JSON.stringify(ok)}`);
    // non-vacuity: the src census sees the shape it is looking for, and passes the policed one
    assert.strictEqual(('src="images/${p.id}-hero.webp"'.match(/src="[^"]*\$\{[^}]*\}[^"]*"/g) || []).length, 1,
      'non-vacuity: the unpoliced-src detector works');
    assert.strictEqual((['src="${safeImgUrl(u)}"'].filter((m) => !/safeImgUrl/.test(m))).length, 0,
      'non-vacuity: …and a policed src is not a finding');

    // Every form has exactly one delegate, wired once at boot.
    assert.strictEqual((html.match(/function wireMenuDelegate\(\)/g) || []).length, 1, `${dir}: one delegate`);
    assert.ok(/\nwireMenuDelegate\(\);\nrenderMenu\(\);/.test(html), `${dir}: …wired before the first render`);

    // non-vacuity: both hostile shapes must trip, and the three shapes that are NOT handlers must not
    const trips = (l) => TEMPLATE_HANDLER.test(l) || CONCAT_HANDLER.test(l);
    assert.ok(trips('const card = p => `<div onclick="chg(${p.id},1)">x</div>`;'),
      'non-vacuity: a template-literal handler trips it');
    assert.ok(trips(String.raw`'<button onclick="chg(\'' + p.id + '\',1)">+</button>'`),
      'non-vacuity: …and a concatenated one, which an earlier version could not see');
    assert.ok(!trips(String.raw`'<img alt="" src="' + safeImgUrl(u) + '" onerror="this.remove()">'`),
      'non-vacuity: an interpolation feeding a src is not a handler');
    assert.ok(!trips('`<button onclick="detailQtyChange(-1)">${qty}</button>`'),
      'non-vacuity: a constant handler beside an unrelated interpolation is not a finding');
    assert.ok(!trips('<button class="change-chip" data-act="tender">x</button>'),
      'non-vacuity: a delegated control is not a finding');
  }
});
