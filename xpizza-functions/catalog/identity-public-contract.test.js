'use strict';
/* THE PUBLIC `identity_id` CONTRACT, ENFORCED — docs/contracts/public-menu-identity_id.md
 *
 * 🔴 WHY THIS EXISTS. After the D4-P1a cutover, `getPublicMenu` returns an ADDITIVE `identity_id` on every
 * dish and extra of a certified version. The owner's decision was DOCUMENT, DO NOT STRIP — so the field is
 * public, reserved, and no consumer may depend on it. A contract that says "no consumer may depend on this"
 * and is enforced by review only is a sentence, not a contract: the first consumer to read the field will
 * do so in a commit nobody connects to this note.
 *
 * EVERYTHING ORIGINATES FROM THE REAL WRITERS, THE REAL READER AND THE REAL CONSUMERS. The version is
 * published by `publishVersion`, certified by `bootstrapIdentityStamps` (the actual cutover), served through
 * `buildPublicMenu`, priced through `getRestaurantDocs` + `buildTablesFromDocs` (the production transform),
 * and accepted by each form's own `liveMenuPrepare` and its own cart adapter, both lifted out of the form.
 *
 * 🔴 THE FIRST VERSION OF THIS FILE WAS WRONG IN THREE WAYS A REVIEW CAUGHT, and each is worth keeping:
 *   · the money-path scan SELECTED FILES BY FILENAME REGEX, so it missed index.js, catalog/catalog.js,
 *     catalog/pricing-tables.js and every EXTERNAL form script (form-cart.js, form-apply.js, …) — the real
 *     consumers, one of which is where `adapter.pricingKey(record)` lives. Selection is now the DEPENDENCY
 *     CLOSURE of the actual entry points. A name tells you what a file is CALLED; the closure tells you what
 *     the entry point can REACH, which is the question.
 *   · cell 2 built its price tables with a local converter and applied the sensitivity edit AFTER that
 *     conversion, so a converter returning fixed tables satisfied both halves. Both states now go through
 *     the PRODUCTION read, and the sensitivity partner changes the price UPSTREAM, in the catalog that is
 *     published.
 *   · Rule 3 ("tolerate absence and equality") was not enforced at all: nothing ran a CONSUMER on both
 *     payloads. Cell 3 does.
 *
 * ═══ 🔴 THREAT MODEL, STATED ═══
 * This detects ACCIDENTAL dependence on identity_id in our own code. Deliberate concealment — eval, the
 * Function constructor, an obfuscated loader, a native module — is OUT OF SCOPE, and platform tampering
 * belongs to the platform-security initiative rather than to this test. The same boundary the connection
 * guard states, for the same reason: every check here reads the source our repo ships, so someone who wants
 * to hide a read can. What that buys is a guarantee against carelessness, which is the failure that actually
 * happens — a consumer reaching for a convenient field in a commit nobody connects to the contract. Leaving
 * the difference unstated would be the dishonest part.
 *
 * Run: node catalog/identity-public-contract.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const acorn = require('acorn');

const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('./source-store');
const { bootstrapIdentityStamps } = require('./identity-bootstrap');
const { buildPublicMenu } = require('./public-menu');
const { getRestaurantDocs } = require('./catalog-firestore');
const { buildTablesFromDocs } = require('./catalog-transform');
const { computeServerTotal } = require('../menu-pricing');
const { stripIdentity } = require('../../xpizza-orders/form-identity-strip');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-public-contract: FAILED — exited without completing'); process.exitCode = 1; } });

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const FORM_DIR = { x_pizza: 'xpizza-orders', la_musa: 'la-musa-orders' };
const BRANDS = ['x_pizza', 'la_musa'];
const deps = { known: new Set(BRANDS), isActive: async () => true };

/* One live catalog through the real pipeline. `certify` runs the actual cutover; `bump` raises one dish's
   price UPSTREAM, in the catalog that gets published, so the sensitivity check exercises the whole path
   rather than a local conversion. */
async function state(rid, { certify = false, bump = 0 } = {}) {
  const db = makeDb();
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'contract' });
  let publishInput = input;
  let bumpedKey = null;
  if (bump) {
    const items = input.items.map((it, i) => (i === 0
      ? { ...it, price: it.price + bump, display: { ...it.display, price: it.display.price + bump } }
      : it));
    bumpedKey = items[0].key;
    publishInput = { ...input, items };
  }
  await publishVersion(db, rid, publishInput, { expected });
  if (certify) await bootstrapIdentityStamps(db, rid, { attempt: 'contract-test' });
  const body = (await buildPublicMenu(db, rid, deps)).body;
  /* THE PRODUCTION PRICING PATH, not a local converter: the same reader and the same pure transform the
     serve path uses — catalog-firestore.js documents buildTablesFromDocs as exactly that. */
  const { itemDocs, extraDocs } = await getRestaurantDocs(db, rid);
  const t = buildTablesFromDocs(itemDocs, extraDocs);
  return { body, tables: { restaurantId: rid, menu: t.menu, extras: t.extras }, bumpedKey };
}

/* ── the forms' OWN code, lifted out of the form rather than re-expressed ───────────────────────── */
const formHtml = (rid) => fs.readFileSync(path.join(REPO, FORM_DIR[rid], 'index.html'), 'utf8');

/* Lift one top-level FUNCTION declaration out of a form's HTML by name, brace-matched.
   🔴 FUNCTIONS ONLY, DELIBERATELY. I first also lifted `const/let NAME = …` initializers, and lifting
   la_musa's `let VARIANT_ITEMS = _okObj(_BUNDLE.variant_items) ? …` dragged in the form's whole bundle
   bootstrap (`_okObj`, `_BUNDLE`) and died with "Cannot access '_okObj' before initialization". The
   distinction that stops the expansion is real rather than convenient: a HELPER FUNCTION is logic this test
   should exercise as written, while a DATA global is an absent-structure fallback whose real value arrives
   in the served body being passed in. So helpers are lifted and data globals are stubbed empty. */
function functionDeclarationOf(html, name) {
  const at = html.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  let depth = 0;
  for (let j = html.indexOf('{', at); j < html.length; j += 1) {
    if (html[j] === '{') depth += 1;
    else if (html[j] === '}') { depth -= 1; if (depth === 0) return html.slice(at, j + 1); }
  }
  return null;
}

function livePrepareOf(rid, probeBody) {
  const html = formHtml(rid);
  const at = html.indexOf('function liveMenuPrepare(');
  assert.ok(at > 0, `premise — ${FORM_DIR[rid]} defines liveMenuPrepare inline`);
  const tail = html.slice(at);
  const src = tail.slice(0, tail.indexOf('\n}\n') + 3);
  assert.ok(src.split('\n').length > 20 && src.trimEnd().endsWith('}'),
    `premise — the extracted liveMenuPrepare looks whole (${src.split('\n').length} lines)`);

  /* 🔴 WHAT IT NEEDS IS RESOLVED TRANSITIVELY FROM THE FORM, NOT GUESSED — because the two forms do not
     need the same things and I got that wrong twice. First I hardcoded x_pizza's PICKUP_ONLY_CATS /
     WEEKEND_ONLY_CATS and la_musa threw "VARIANT_ITEMS is not defined"; then I derived SCREAMING_CASE names
     and la_musa threw "sameDishId is not defined" — a camelCase helper. Two wrong heuristics in a row, both
     of which LOOKED general because x_pizza passed.
     So: build it, and on each "X is not defined" lift X's own declaration out of the SAME form and retry.
     A name with no declaration gets an empty fallback ([] for *_CATS, {} otherwise) — those are the form's
     "absent structure keeps what is in force" defaults, and the served bodies passed below carry their real
     values anyway. The loop is CAPPED and fails by name, so an unresolvable dependency is loud. */
  /* 🔴 IT MUST BE BUILT *AND CALLED* IN THE LOOP. `new Function` succeeds even when the body references
     an undefined global — the ReferenceError only arrives when the function RUNS. My first resolve loop
     caught build-time errors only, so x_pizza passed with nothing to resolve and la_musa still threw
     "VARIANT_ITEMS is not defined" at call time. A probe body is therefore passed in and invoked here. */
  const extras = [];
  const stubs = new Map();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const names = [...stubs.keys()];
    try {
      const fn = new Function(...names, `${extras.join('\n')}\n${src}\n; return liveMenuPrepare;`)(...names.map((k) => stubs.get(k)));
      fn(probeBody);                                  // the call is where a missing global actually surfaces
      return { fn, lifted: extras.length, stubbed: names };
    } catch (e) {
      const m = /^(\w[\w$]*) is not defined$/.exec(e && e.message ? e.message : '');
      assert.ok(m, `premise — building ${FORM_DIR[rid]}'s liveMenuPrepare failed for a reason this harness cannot resolve: ${e && e.message}`);
      const missing = m[1];
      const decl = functionDeclarationOf(html, missing);
      if (decl) extras.push(decl);
      else stubs.set(missing, /_CATS$/.test(missing) ? [] : {});
    }
  }
  assert.fail(`premise — could not satisfy ${FORM_DIR[rid]}'s liveMenuPrepare within 24 resolutions (lifted ${extras.length}, stubbed ${[...stubs.keys()].join(', ')})`);
}

function cartAdapterOf(rid) {
  const html = formHtml(rid);
  const at = html.indexOf('window.createCart({ adapter: {');
  assert.ok(at > 0, `premise — ${FORM_DIR[rid]} constructs its cart with an inline adapter`);
  const block = html.slice(at, html.indexOf('} });', at) + 5);
  const pick = (name) => {
    const m = new RegExp(`${name}:\\s*(\\([^)]*\\)\\s*=>\\s*[^,\\n]+)`).exec(block);
    assert.ok(m, `premise — ${FORM_DIR[rid]}'s adapter defines ${name}, which is what money is keyed on`);
    return new Function(`return ${m[1]};`)();
  };
  return { itemKey: pick('itemKey'), pricingKey: pick('pricingKey') };
}

(async () => {
  // ── 1. RULE 1 — THE SERVED SHAPE: EQUAL WHEN CERTIFIED, ABSENT WHEN NOT ──────────────────────
  /* 🔴 WHAT EACH HALF ACTUALLY PROVES, stated correctly this time. The certified check
     (`!d.identity_id || d.identity_id !== d.dish_id`) ALREADY catches deletion of the field — an absent
     identity_id fails `!d.identity_id`. So the uncertified half is NOT the deletion guard, as an earlier
     comment here claimed. It proves a different thing, and the one Rule 1 rests on: an uncertified version
     carries NO stamp, which is why a consumer must tolerate absence. La Musa is not cut over in production,
     so that is the live case rather than a hypothetical. */
  for (const rid of BRANDS) {
    const { body: stamped } = await state(rid, { certify: true });
    assert.ok(stamped.dishes.length > 0 && stamped.extras.length > 0,
      `premise — ${rid} serves dishes and extras (${stamped.dishes.length}/${stamped.extras.length})`);
    assert.deepStrictEqual(stamped.dishes.filter((d) => !d.identity_id || d.identity_id !== d.dish_id).map((d) => d.name), [],
      `🔴 ${rid}: a certified version served a dish whose identity_id is absent or differs from dish_id — see docs/contracts/public-menu-identity_id.md before changing this deliberately`);
    assert.deepStrictEqual(stamped.extras.filter((e) => !e.identity_id || e.identity_id !== e.extra_id).map((e) => e.name), [],
      `🔴 ${rid}: a certified version served an extra whose identity_id is absent or differs from extra_id`);

    const { body: plain } = await state(rid, { certify: false });
    assert.deepStrictEqual([
      ...plain.dishes.filter((d) => 'identity_id' in d).map((d) => `dish ${d.name}`),
      ...plain.extras.filter((e) => 'identity_id' in e).map((e) => `extra ${e.name}`),
    ], [], `🔴 ${rid}: an UNCERTIFIED version served identity_id — Rule 1 is that it may be ABSENT, which is La Musa's live state`);
    ok(`${rid}: a certified version serves identity_id === dish_id/extra_id on all ${stamped.dishes.length} dishes and ${stamped.extras.length} extras; an uncertified one carries no stamp at all`);
  }

  // ── 2. RULE 2, AT RUNTIME — THROUGH THE PRODUCTION READ, WITH AN UPSTREAM SENSITIVITY ────────
  for (const rid of BRANDS) {
    const certified = await state(rid, { certify: true });
    const plain = await state(rid, { certify: false });
    assert.deepStrictEqual(certified.tables.menu, plain.tables.menu, `🔴 ${rid}: the cutover changed the production dish price table`);
    assert.deepStrictEqual(certified.tables.extras, plain.tables.extras, `🔴 ${rid}: the cutover changed the production extra price table`);
    assert.ok(Object.keys(certified.tables.menu).length > 0,
      `premise — the production read produced a table (${Object.keys(certified.tables.menu).length} keys)`);
    assert.ok(!JSON.stringify(certified.tables).includes('identity_id'), `🔴 ${rid}: identity reached the production pricing tables`);

    const dish = certified.body.dishes[0];
    const cartOf = (d) => [{ name: d.name, id: d.dish_id, qty: 2, price: d.price, extras: [] }];
    const totalC = computeServerTotal(cartOf(dish), rid, certified.tables);
    const totalP = computeServerTotal(cartOf(dish), rid, plain.tables);
    assert.deepStrictEqual(totalC, totalP, `🔴 ${rid}: the same cart priced against a certified and an uncertified version differs`);
    assert.ok(Number.isFinite(totalC.total) && totalC.total > 0,
      `premise — the comparison priced something real (${JSON.stringify(totalC).slice(0, 80)})`);

    /* 🔴 THE SENSITIVITY PARTNER, UPSTREAM. The earlier version bumped a price AFTER its own conversion,
       which a converter returning fixed tables would have survived. This raises one dish's price in the
       CATALOG THAT GETS PUBLISHED and requires the production read — reader, transform and all — to show
       it. An invariance claim whose comparison cannot move is not a claim. */
    const bumped = await state(rid, { certify: true, bump: 7 });
    assert.notDeepStrictEqual(bumped.tables.menu, certified.tables.menu,
      `🔴 ${rid}: sensitivity FAILED — a 7 L UPSTREAM catalog change did not reach the production price table, so the agreement above proves nothing about the path`);
    assert.strictEqual(bumped.tables.menu[bumped.bumpedKey], certified.tables.menu[bumped.bumpedKey] + 7,
      `🔴 ${rid}: the upstream bump did not land on the expected key (${bumped.bumpedKey})`);
    const bumpedDish = bumped.body.dishes.find((d) => d.name === dish.name) || bumped.body.dishes[0];
    assert.notDeepStrictEqual(computeServerTotal(cartOf(bumpedDish), rid, bumped.tables), totalP,
      `🔴 ${rid}: sensitivity FAILED — the quote total did not move for a 7 L upstream change`);
    ok(`${rid}: certifying a version changes neither the production price tables nor the quote total, and a 7 L UPSTREAM catalog change is proven to move both through that same read`);
  }

  // ── 3. RULE 3 — A REAL CONSUMER, ON BOTH PAYLOADS ────────────────────────────────────────────
  /* Rule 3 is "tolerate absence and equality", and nothing above runs a CONSUMER, so nothing above
     enforces it. This drives each form's OWN liveMenuPrepare and its OWN cart adapter — both lifted out of
     the shipped HTML, so the code under test is the code that ships — over the certified and uncertified
     payloads, and requires the accepted menu and the cart keys and prices to be identical. */
  for (const rid of BRANDS) {
    const certified = await state(rid, { certify: true });
    const plain = await state(rid, { certify: false });
    const { fn: prepare, lifted, stubbed } = livePrepareOf(rid, certified.body);
    const adapter = cartAdapterOf(rid);

    const accepted = {};
    for (const [label, s] of [['certified', certified], ['uncertified', plain]]) {
      let out;
      /* THE WHOLE SERVED BODY, as the form actually receives it — not a {dishes, extras} subset. la_musa's
         liveMenuPrepare additionally requires `categories` and threw apply_categories_missing on the
         subset, which is the validator being stricter than my fixture rather than a contract problem. */
      assert.doesNotThrow(() => { out = prepare(s.body); },
        `🔴 ${rid}: the form's own liveMenuPrepare REFUSED the ${label} payload — a consumer must work whether identity_id is present or absent`);
      accepted[label] = out;
    }
    /* PREMISE FIRST: the two payloads really did differ, or every comparison below is trivially true. */
    assert.ok(accepted.certified.MENU.some((d) => 'identity_id' in d),
      `premise — the certified payload carried identity_id into MENU, so there is something to tolerate`);
    assert.ok(!accepted.uncertified.MENU.some((d) => 'identity_id' in d),
      `premise — the uncertified payload carried none`);

    /* 🔴 THE COMPARISON TOLERATES EXACTLY THE IDENTITY FIELDS, AND TWO OF THE THREE COME FROM THE
       SHARED DEFINITION. `stripIdentity` (xpizza-orders/form-identity-strip.js) owns `dish_id`/`extra_id`,
       and it is used here rather than re-listed so that a fourth identity field added there does not leave
       this comparison behind — the same reason public-menu.test.js uses it. `identity_id` is NOT in that
       list, deliberately: that helper is D1's boundary for the shadow ids, while identity_id is D4-P1a's
       additive public field, so it is named here with its reason instead of being smuggled into a shared
       constant this file does not own.
       And the ids DO differ run to run: each publish MINTS fresh canonical ids, so comparing raw records
       would fail for a reason that has nothing to do with the contract. */
    const deIdent = (recs) => stripIdentity(recs).map((r) => { const { identity_id: _drop, ...rest } = r; return rest; });
    assert.deepStrictEqual(deIdent(accepted.certified.MENU), deIdent(accepted.uncertified.MENU),
      `🔴 ${rid}: the accepted MENU differs between the certified and uncertified payloads by something beyond the identity fields`);
    assert.deepStrictEqual(deIdent(accepted.certified.EXTRAS), deIdent(accepted.uncertified.EXTRAS),
      `🔴 ${rid}: the accepted EXTRAS differ beyond the identity fields`);

    /* THE CART KEYS — where Rules 2 and 3 meet: `adapter.pricingKey(record)` is what money is keyed on, and
       it must be unmoved by identity appearing on the record. */
    const keysOf = (menu) => menu.map((r) => ({ itemKey: adapter.itemKey(r), pricingKey: adapter.pricingKey(r), price: r.price }));
    const keysC = keysOf(accepted.certified.MENU);
    assert.deepStrictEqual(keysC, keysOf(accepted.uncertified.MENU),
      `🔴 ${rid}: the form's OWN adapter produced different cart/pricing keys for the certified payload — identity_id has become a pricing key`);
    /* 🔴 THE ASSERTION THAT BELONGS HERE IS "REMOVING identity_id CHANGES NOTHING", NOT
       "pricingKey !== identity_id". I wrote the latter first and la_musa failed it — correctly. la_musa
       prices by `r.id`, and TODAY its display id, its dish_id and its identity_id are all the same string
       (`dimsum_01`), which is exactly the contract's "may EQUAL the display id / must not assume it
       differs". So "the key is not the stamp" is not a contract claim at all; it is an assumption the
       contract explicitly forbids making, and my check was asserting the opposite of Rule 3.
       What IS the claim: identity_id is not an INPUT to the key. Proven by feeding the adapter the same
       record with the field deleted and requiring the same answer. */
    const withoutStamp = accepted.certified.MENU.map((r) => { const { identity_id: _drop, ...rest } = r; return rest; });
    assert.deepStrictEqual(keysOf(withoutStamp), keysC,
      `🔴 ${rid}: deleting identity_id changed the form's own cart/pricing keys — the field is an INPUT to them, which Rule 2 forbids`);
    assert.ok(accepted.certified.MENU.some((r) => 'identity_id' in r),
      'premise — the records fed to the adapter really carried the stamp, so removing it was a real change');
    ok(`${rid}: the form's OWN liveMenuPrepare (lifted whole from the form, with ${lifted} of its own declarations pulled in transitively and ${stubbed.length} absent-structure fallback(s) supplied empty) accepts BOTH payloads, and its OWN adapter yields identical cart/pricing keys and prices for all ${keysC.length} dishes — identity_id is tolerated, present or absent, and keys nothing`);
  }

  // ── 4. RULE 2, STRUCTURALLY — identity_id IS READ NOWHERE ON THE MONEY PATH ───────────────────
  /* 🔴 SELECTION BY DEPENDENCY CLOSURE, NOT BY FILENAME. The first version matched names
     (/^(menu-pricing|quote-|order-|…)/) and so missed index.js, catalog/catalog.js,
     catalog/pricing-tables.js and EVERY external form script — form-cart.js among them, which is exactly
     where `adapter.pricingKey(record)` lives. */
  /* 🔴 DISCOVERY IS AN ALLOWLIST OF KNOWN-SAFE SHAPES, AND EVERYTHING ELSE IS A NAMED FAILURE.
     Three rounds of review each found another spelling that discovery missed — `require (…)` with a space,
     then `module.require(…)`, then `module["require"](…)` — and each fix taught the same lesson one spelling
     later: a DENYLIST over syntax can only ever enumerate the forms someone thought of. So the model is
     inverted. Two shapes are accepted and followed; any other reference to a loader is reported with its
     file and line, and the run fails.
     ACCEPTED:
       (i)  `require('./x')` — callee is the BARE identifier `require`, exactly one argument, a string
            Literal or a TemplateLiteral with no substitutions;
       (ii) `import … from './x'` / `export … from './x'` with a literal source.
     REPORTED, therefore failing: `module.require(...)` in any form including `module["require"]`, any other
     computed member of `module` (it cannot be ruled out), a bare `require` used anywhere that is not such a
     callee (`const r = require`, `require.call(...)`, passing it as an argument), `import(x)`, and any
     accepted-looking shape whose specifier is not literal.
     If a real module ever needs another shape, it will fail HERE by name and be decided deliberately — which
     is the whole point of an allowlist over a pattern. */
  const loaderProblems = [];
  /* 🔴 ONE SHAPE IS ACCEPTED AS A READ, AND IT IS PINNED TO ITS SITE RATHER THAN WAVED THROUGH.
     `if (require.main === module)` — the standard Node CLI-entrypoint guard — is a bare `require` that is
     not a callee, so the allowlist flags it. I audited all 131 closure modules before deciding: there is
     EXACTLY ONE such touch in the whole closure, and `require.main` is a PROPERTY READ that cannot load
     anything, so accepting it cannot hide a dependency.
     It is not simply exempted. Every accepted read is recorded and the list is asserted to equal the known
     site, so if `require.main` appears anywhere new — or if any other read-shape is added to this rule — the
     test fails and the decision is taken deliberately. That is the difference between an allowlist with one
     pinned exception and a widened pattern. */
  const acceptedLoaderReads = [];
  /* Edges the OLD prefix rule would have dropped and resolution now FOLLOWS. Classification by resolution can
     only widen the closure, and a widening nobody states is the silent skip inverted: the scan would quietly
     start covering modules the counts pinned in this cell were never agreed over. So each such edge is
     RECORDED and the real tree is asserted to have none — if one appears, this names the specifier, the file it
     came from and what it resolved to, rather than absorbing it into a growing count. */
  const nonRelativeLocals = [];
  const noteProblem = (absFile, node, what) => {
    const line = node && node.loc ? node.loc.start.line : '?';
    loaderProblems.push(`${what} at ${path.relative(ROOT, absFile)}:${line}`);
  };

  /* ONE node/parent walk, shared by the server graph and the browser graph below. It is hoisted rather than
     copied because two walks drift: the de-duplication and the parent map are what the require.main pin and
     every "fail by name" message depend on, and a second implementation would be a second set of blind spots. */
  const astNodes = (ast) => {
    const nodes = [];
    const parentOf = new Map();
    const collect = (node, parent) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach((x) => collect(x, parent)); return; }
      if (typeof node.type === 'string') { nodes.push(node); parentOf.set(node, parent); }
      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'loc') continue;
        if (node[k] && typeof node[k] === 'object') collect(node[k], typeof node.type === 'string' ? node : parent);
      }
    };
    collect(ast, null);
    return { nodes, parentOf };
  };
  const literalOf = (arg) => {
    if (arg && arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
    if (arg && arg.type === 'TemplateLiteral' && arg.expressions.length === 0 && arg.quasis.length === 1) return arg.quasis[0].value.cooked;
    return null;
  };
  const IMPORTS_SOURCE = (node) => node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration'
    || (node.type === 'ExportNamedDeclaration' && node.source);

  const dependenciesOf = (absFile) => {
    const src = fs.readFileSync(absFile, 'utf8');
    // a required .json file is DATA (Node JSON.parses it; it cannot load anything) → a validated LEAF with no edges.
    // Malformed JSON throws here, failing the walk by name (P-SELFUPDATE: the bundled platform manifest).
    if (/\.json$/.test(absFile)) { JSON.parse(src); return []; }
    let ast;
    // CommonJS: a top-level `return` is legal (index.js's isolated-portal early branch — PORTAL SPEED P1).
    try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true }); }
    catch (_) { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
    const { nodes, parentOf } = astNodes(ast);

    /* PASS 1 — the accepted shapes, and the exact nodes they account for. */
    const accountedCallees = new Set();
    const specifiers = [];
    for (const node of nodes) {
      if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require'
          && node.arguments.length === 1 && literalOf(node.arguments[0]) !== null) {
        accountedCallees.add(node.callee);
        specifiers.push(literalOf(node.arguments[0]));
      }
      if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration'
           || (node.type === 'ExportNamedDeclaration' && node.source))
          && node.source && node.source.type === 'Literal' && typeof node.source.value === 'string') {
        specifiers.push(node.source.value);
      }
    }

    /* PASS 2 — every remaining touch of a loader is a failure, named. Nodes are de-duplicated: the walk can
       reach one node by more than one key, and a single `require.main` was reported TWICE before this. */
    for (const node of new Set(nodes)) {
      if (node.type === 'Identifier' && node.name === 'require' && !accountedCallees.has(node)) {
        /* 🔴 ACCEPTED BY EXACT CONTEXT, NOT BY LOCATION. The previous pin rejected CALLING require.main
           but accepted it as a RECEIVER, so `require.main["require"]("./hidden.js")` on the pinned line was
           accepted, its dependency omitted, and the pinned list unchanged — the exception became a hole at
           the one address nobody re-reads. Acceptance is now the whole shape:
             IfStatement.test === BinaryExpression('===', require.main, module)     (either operand order)
           `require.main` reached ANY other way — a further member access, a call, an assignment, a different
           comparison, an argument — fails by name. */
        const mainMember = parentOf.get(node);
        const isRequireMain = mainMember && mainMember.type === 'MemberExpression' && mainMember.object === node
          && !mainMember.computed && mainMember.property && mainMember.property.name === 'main';
        let guarded = false;
        if (isRequireMain) {
          const cmp = parentOf.get(mainMember);
          if (cmp && cmp.type === 'BinaryExpression' && cmp.operator === '==='
              && ((cmp.left === mainMember && cmp.right && cmp.right.type === 'Identifier' && cmp.right.name === 'module')
               || (cmp.right === mainMember && cmp.left && cmp.left.type === 'Identifier' && cmp.left.name === 'module'))) {
            const ifStmt = parentOf.get(cmp);
            guarded = !!(ifStmt && ifStmt.type === 'IfStatement' && ifStmt.test === cmp);
          }
        }
        if (guarded) acceptedLoaderReads.push(`require.main at ${path.relative(ROOT, absFile)}:${node.loc.start.line}`);
        else noteProblem(absFile, node, 'UNACCEPTED use of `require` (only `require("./literal")` as a direct callee, or the exact `if (require.main === module)` guard, is accepted)');
      } else if (node.type === 'MemberExpression' && node.object && node.object.type === 'Identifier' && node.object.name === 'module') {
        const isRequireProp = (!node.computed && node.property && node.property.name === 'require')
          || (node.computed && node.property && node.property.type === 'Literal' && node.property.value === 'require');
        const isOpaqueProp = node.computed && node.property && node.property.type !== 'Literal';
        if (isRequireProp) noteProblem(absFile, node, 'UNACCEPTED loader `module.require` / `module["require"]`');
        else if (isOpaqueProp) noteProblem(absFile, node, 'UNACCEPTED computed member of `module` — it cannot be ruled out as a loader');
      } else if (node.type === 'ImportExpression') {
        noteProblem(absFile, node, 'UNACCEPTED dynamic `import(...)`');
      } else if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration'
                  || (node.type === 'ExportNamedDeclaration' && node.source))
                 && node.source && node.source.type !== 'Literal') {
        noteProblem(absFile, node, 'UNACCEPTED non-literal import/export source');
      }
    }
    return specifiers;
  };

  /* 🔴 NODE'S OWN PREDICATE, NOT A PREFIX TEST. This was
     `spec.startsWith('node:') || BUILTINS.has(spec.replace(/^node:/, ''))`, which classified ANY `node:`
     specifier as a builtin on the strength of the prefix alone — `node:not-a-real-builtin-xyz` came back
     {kind:'builtin'} while Node's resolver says MODULE_NOT_FOUND. It cannot hide a local module (nothing
     local is spelled `node:`), but it breaks the contract that an unresolvable specifier FAILS BY NAME, and
     it is the same defect as the dot-prefix test one layer down: a spelling standing in for the fact.
     `module.isBuiltin` is the loader's own answer, so it moves with the runtime instead of with my
     recollection of it. Measured before swapping: it accepts every `module.builtinModules` entry (0 lost),
     and every name where the two disagree — `node:`, `node:acorn`, `node:quic`, `node:not-a-real-builtin-xyz`
     — is one Node genuinely refuses to resolve, so each becomes a named failure rather than a false one. */
  const isBuiltin = (spec) => require('module').isBuiltin(spec);
  /* 🔴 "LOCAL" MEANS INSIDE A DECLARED ROOT, AND THE CELLS DECLARE THEIRS. Resolution-based
     classification immediately rejected this file's OWN fixtures, which live in os.tmpdir() and so resolve
     outside the repo — correctly, by the new rule. The fix is not to loosen the rule back to a prefix test:
     it is to say what counts as local. The production scan has exactly one root, the repo; a cell that needs
     to drive the closure over a fixture tree PUSHES its root and pops it, so the widening is scoped to the
     cell that asked for it and cannot leak into the real scan. */
  const REPO_REAL = fs.realpathSync(REPO);
  const LOCAL_ROOTS = [REPO_REAL];
  const withLocalRoot = (dir, fn) => {
    LOCAL_ROOTS.push(fs.realpathSync(dir));
    try { return fn(); } finally { LOCAL_ROOTS.pop(); }
  };
  const insideLocalRoot = (abs) => LOCAL_ROOTS.some((root) => abs === root || abs.startsWith(root + path.sep));

  /* Every accepted literal specifier is classified by WHERE IT RESOLVES:
       builtin                                  — node:… or in module.builtinModules
       inside a node_modules directory          — a package; not ours, not followed
       any other resolved path inside the repo  — LOCAL: followed and scanned, however it was spelled
       resolved outside the repo                — FAIL by name (it is neither ours nor a package)
       unresolvable                             — FAIL by name
     The two FAIL branches are the point: a specifier this harness cannot place is never quietly skipped. */
  const classifySpecifier = (spec, fromDir, fromFile) => {
    if (isBuiltin(spec)) return { kind: 'builtin' };
    let resolved;
    try { resolved = require.resolve(spec, { paths: [fromDir] }); }
    catch (_) {
      loaderProblems.push(`UNRESOLVABLE dependency ${JSON.stringify(spec)} from ${path.relative(ROOT, fromFile)}`);
      return { kind: 'fail' };
    }
    if (isBuiltin(resolved)) return { kind: 'builtin' };
    const real = (() => { try { return fs.realpathSync(resolved); } catch (_) { return resolved; } })();
    if (real.split(path.sep).includes('node_modules')) return { kind: 'package', resolved: real };
    if (insideLocalRoot(real)) return { kind: 'local', resolved };
    loaderProblems.push(`dependency ${JSON.stringify(spec)} from ${path.relative(ROOT, fromFile)} resolves OUTSIDE every declared local root and is not a package: ${real}`);
    return { kind: 'fail' };
  };

  const localClosure = (entryAbs) => {
    const seen = new Set(); const stack = [path.resolve(entryAbs)];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
      seen.add(f);
      for (const spec of dependenciesOf(f)) {
        /* 🔴 CLASSIFY BY RESOLUTION, NOT BY PREFIX. The previous line was
           `if (!spec.startsWith('.')) continue;` — i.e. anything not starting with a dot was ASSUMED to be a
           package and silently dropped. So `require('/abs/path/local.js')` passed the shape allowlist, was
           never followed, and never scanned: a local module reachable by an absolute specifier simply was not
           in the closure. The prefix is a convention; resolution is the fact. */
        const cls = classifySpecifier(spec, path.dirname(f), f);
        if (cls.kind === 'local') {
          if (!spec.startsWith('.')) {
            nonRelativeLocals.push(`${JSON.stringify(spec)} in ${path.relative(ROOT, f)} → ${path.relative(ROOT, cls.resolved)}`);
          }
          stack.push(cls.resolved);
        }
        // 'builtin' and 'package' need no follow; 'fail' has already been recorded by name.
      }
    }
    return [...seen];
  };

  /* The identity/catalog modules that legitimately OWN the field, each with its reason. Derived from the
     tree, then classified — and each asserted to be REACHED by the closure, so a stale entry is a failure
     rather than dead weight that quietly excuses nothing. */
  /* The identity/catalog modules that legitimately OWN the field AND are reached by the serving entry
     point, each with its reason. Every one is asserted to be IN the closure, so a stale entry is a failure
     rather than dead weight that excuses nothing. */
  const OWNS_IDENTITY = {
    'catalog/identity-stampmap.js': 'builds the stamp map the writer applies',
    'catalog/identity-partition.js': 'the partition law is stated over these ids',
    'catalog/catalog-publish.js': 'the writer that stamps display.identity_id from the draft',
    'catalog/catalog-edit.js': 'the merchant diff, which must EXCLUDE identity from content',
    'catalog/content-hash.js': 'excludes identity from the content fingerprint',
    'catalog/catalog-context.js': "D4-a resolved context: the single gateway mapping a certified version's own stamp to canonicalId; reported only; keys no price/cart/quote/redemption/factura; not in the public payload",
  };

  /* \u{1f534} TWO OWNERS ARE DELIBERATELY NOT LISTED, AND THAT IS ITSELF PINNED BELOW.
     `catalog/identity-bootstrap.js` (the cutover) and `catalog/identity-restore.js` are OPERATOR TOOLING,
     reached from tools/, not from index.js \u2014 measured: they are absent from the serving closure. They need no
     exclusion because they are never scanned, and listing them anyway would be an allowlist entry that
     excuses nothing while implying the serving path touches the cutover. The assertion that they stay OUT is
     the useful one: if a change ever pulls the cutover into the request path, this cell says so. */
  const OWNERS_OUTSIDE_SERVING = ['catalog/identity-bootstrap.js', 'catalog/identity-restore.js'];

  const codeHasIdentity = (source) => {
    let toks;
    try { toks = [...acorn.tokenizer(source, { ecmaVersion: 'latest' })]; } catch (_) { return null; }
    return toks.some((t) => typeof t.value === 'string' && t.value.includes('identity_id'));
  };
  /* 🔴 THE FORM IS PARSED WITH jsdom, NOT WITH A REGEX. `/\bsrc\s*=/` matched inside `data-src`, so
     `<script data-src="https://cdn/x.js" src="hidden.js">` returned the EXTERNAL url and hidden.js was
     dropped — a real consumer vanishing because an attribute name contained the attribute I was looking for.
     No amount of tightening a pattern fixes the class; an HTML parser knows what an attribute is.
     jsdom is already a declared devDependency (^30.0.1), so this adds nothing. Both the src set AND the
     inline set now come from the DOM: `script[src]` via getAttribute, and `script:not([src])` textContent. */
  const { JSDOM } = require('jsdom');
  const domOf = (html) => new JSDOM(html).window.document;
  const inlineScripts = (html) => [...domOf(html).querySelectorAll('script:not([src])')].map((el) => el.textContent || '');
  const scriptSrcs = (html) => [...domOf(html).querySelectorAll('script[src]')].map((el) => {
    const raw = String(el.getAttribute('src') || '').trim();
    return { raw, external: /^(?:https?:)?\/\//i.test(raw) || /^data:/i.test(raw), file: raw.replace(/[?#].*$/, '') };
  }).filter((x) => x.raw);

  /* ═══ THE BROWSER GRAPH, UNDER THE SAME ALLOWLIST AS THE SERVER GRAPH ═══
     🔴 THE SERVER FIX LEFT ITS BROWSER COUNTERPART OPEN. Inline blocks and local <script src> files were
     each handed to codeHasIdentity and nothing else: neither discovered what a browser script LOADS. So
     `<script type="module">import './pricing-helper.js'</script>` reported srcs [] and inlineHits [false]
     while the helper it pulled in read record.identity_id — ORDINARY modularization, squarely inside the
     accidental threat model this test is for, and the exact shape the server closure exists to prevent.
     The rules are the server's, one runtime over: literal import/export-from sources are FOLLOWED and
     scanned transitively; a remote source is classified external and asserted remote; everything else that
     could load — dynamic import(), importScripts(), new Worker/SharedWorker, a non-literal source, or a
     `require` (not a browser loader at all) — FAILS BY NAME with file:line.
     Resolution is BROWSER semantics, not Node's: a relative URL against the importing file's own location,
     with ?query and #fragment stripped. There is no node_modules and no extension guessing, so a bare
     specifier (which needs an import map) and a site-absolute '/x.js' (whose site root this scan cannot map
     onto a file) are named failures rather than silent passes — the same refusal-to-guess as the server side. */
  const BROWSER_LOADER_NAMES = new Set(['Worker', 'SharedWorker', 'importScripts']);
  const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis']);
  const BROWSER_EXTERNAL = (raw) => /^(?:https?:)?\/\//i.test(raw) || /^data:/i.test(raw);
  const browserProblems = [];
  const browserImports = [];
  const browserExternals = [];
  const dynamicSites = [];   // (C) the pinned backstop: every dynamic import (D) accepts, recorded
  const computedGlobalSites = [];   // opaque keys on window/self/globalThis: recorded, then pinned by text
  const loaderTokenHits = [];       // (A) every loader-name TOKEN seen in browser code
  const noteBrowser = (what, label, node) => {
    browserProblems.push(`${what} at ${label}${node && node.loc ? ':' + node.loc.start.line : ''}`);
  };

  /* ═══ (D) PROVE THE BASE REMOTE BY TOKEN INVENTORY ═══
     Both forms lazy-load the modular Firebase SDK with `import(`${V}/firebase-app.js`)`, and the remote-ness
     is NOT in the specifier: the template STARTS with the interpolation, so its static prefix is the EMPTY
     STRING. The base's value therefore has to be proved from the file — but NOT by hand-rolled binding
     analysis any more.
     🔴 THAT APPROACH LOST THREE TIMES, EACH TIME TO ANOTHER JS BINDING FORM I HAD NOT MODELLED:
       · counting bindings in the file — a const in an unrelated function "proved" an import that actually
         read `window.V`;
       · then a lexical scope walk — `const C = class V { f(){ return import(`${V}/a.js`) } }` slipped
         through, because a ClassExpression's own name is a binding the walker did not know about;
       · and its sibling, the loader rule — `const { Worker: W } = window` slipped through, because an
         ObjectPattern key looked to my code like an object-literal key.
     Every fix was one more clause for one more remembered form: the denylist-over-syntax game, one level up
     from where this file already abandoned it. The deciding rule is now a TOKEN INVENTORY — the same
     instrument the identity_id scan itself uses — because acorn's tokenizer enumerates EVERY appearance of a
     name whether or not I thought of the form it appears in. A surplus token (a class name, a destructuring
     key, a parameter, a property, `window.V`) makes the count wrong and the site is refused by name.
     All that remains of the structure is ONE ancestor test, which asks nothing about bindings. */
  const staticStringOf = (node) => {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked;
    return null;
  };

  /* The accepted SHAPE: `${IDENT}<tail>`, nothing else in the template. A shape claim only — no value claim. */
  const dynamicShapeOf = (node, source) => {
    const T = node.source;
    if (!T || T.type !== 'TemplateLiteral') return { reason: 'the specifier is not a template literal, so its value cannot be proved from this file' };
    if (T.expressions.length !== 1) return { reason: `the specifier has ${T.expressions.length} interpolations; exactly one is provable` };
    if (T.expressions[0].type !== 'Identifier') return { reason: `the interpolation is a ${T.expressions[0].type}, not a bare identifier` };
    if (T.quasis.length !== 2) return { reason: 'the template is not exactly `${V}<tail>`' };
    if (T.quasis[0].value.cooked !== '') return { reason: `the template does not START with the interpolation (leading text ${JSON.stringify(T.quasis[0].value.cooked)})` };
    const tail = T.quasis[1].value.cooked;
    if (typeof tail !== 'string' || !tail.startsWith('/')) return { reason: `the tail ${JSON.stringify(tail)} does not start with '/'` };
    return { name: T.expressions[0].name, tail, text: source.slice(T.start, T.end), exprStart: T.expressions[0].start };
  };

  /* THE DECIDING RULE. `group` is every shape-valid site in this file that interpolates `name`.
     The inventory is a FILE-level fact, which is why the verdict is taken per NAME rather than per site. */
  const tokenInventoryVerdict = (name, group, tokens, nodes, parentOf) => {
    const nameTokens = tokens.filter((t) => t.type.label === 'name' && t.value === name);
    const expected = 1 + group.length;
    if (nameTokens.length !== expected) {
      return { reason: `the file holds ${nameTokens.length} \`${name}\` identifier token(s) (line(s) ${nameTokens.map((t) => t.loc.start.line).join(',') || 'none'}), but ${group.length} interpolation(s) plus exactly one declaration would be ${expected} — any other appearance of the name is something that could change what the import reads, in whatever JS form it takes` };
    }
    const interpStarts = new Set(group.map((c) => c.exprStart));
    const others = nameTokens.filter((t) => !interpStarts.has(t.start));
    if (others.length !== 1) return { reason: `${others.length} \`${name}\` token(s) are not interpolations of a candidate site; exactly one declaration is required` };
    const declToken = others[0];
    const declarator = [...new Set(nodes)].find((n) => n.type === 'VariableDeclarator' && n.id
      && n.id.type === 'Identifier' && n.id.name === name && n.id.start === declToken.start);
    if (!declarator) {
      return { reason: `the one non-interpolation \`${name}\` token (line ${declToken.loc.start.line}) is not the id of a variable declarator — a class name, a property or a pattern key cannot fix the value` };
    }
    const decl = parentOf.get(declarator);
    if (!decl || decl.type !== 'VariableDeclaration' || decl.kind !== 'const') {
      return { reason: `\`${name}\` is declared with ${decl && decl.kind ? decl.kind : 'something other than a variable declaration'}, not const` };
    }
    const base = staticStringOf(declarator.init);
    if (base === null) return { reason: `\`${name}\` is not initialized to a static string` };
    if (!base.startsWith('https://')) return { reason: `\`${name}\` is ${JSON.stringify(base)}, which does not start with https:// — it cannot be proved remote` };
    /* The one STRUCTURAL test, and it is not binding analysis: the statement list holding the declaration
       must CONTAIN every site that uses it. A declaration somewhere else in the file cannot be what an
       import reads, however the inventory counts. */
    const encl = parentOf.get(decl);
    if (!encl) return { reason: `the \`${name}\` declaration has no enclosing node` };
    for (const c of group) {
      let cur = parentOf.get(c.node); let found = false;
      while (cur) { if (cur === encl) { found = true; break; } cur = parentOf.get(cur); }
      if (!found) return { reason: `the \`${name}\` declaration (line ${declToken.loc.start.line}) does not enclose the import at line ${c.node.loc.start.line}, so it is not what that import reads` };
    }
    return { base, declLine: declToken.loc.start.line };
  };
  const browserDepsOf = (source, label, baseDir) => {
    let ast = null; let usedType = null;
    for (const sourceType of ['module', 'script']) {
      try { ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true }); usedType = sourceType; break; } catch (_) { /* try the other */ }
    }
    if (!ast) { browserProblems.push(`UNPARSEABLE browser script ${label} — it cannot be scanned at all`); return { local: [], external: [] }; }
    let tokens;
    try { tokens = [...acorn.tokenizer(source, { ecmaVersion: 'latest', sourceType: usedType, locations: true })]; }
    catch (_) { browserProblems.push(`UNTOKENIZABLE browser script ${label} — the token rules below cannot run on it, so it is not scanned`); return { local: [], external: [] }; }
    const { nodes, parentOf } = astNodes(ast);
    const out = { local: [], external: [] };
    const accountedSources = new Set();
    const dynamicCandidates = [];

    /* 🔴 (A) LOADERS BY TOKEN, NOT BY POSITION. `new Worker()`, `new window.Worker()`, `const W = Worker`,
       `self.importScripts()`, `globalThis["Worker"]` and `const { Worker: W } = window` are six spellings of
       one thing, and the AST rules caught them one review round at a time — the last escape was an
       ObjectPattern key my code mistook for an object-literal key. A token carries no position semantics to
       get wrong: every appearance of the name — identifier, property, pattern key, string, template chunk — is
       reported. Measured on the real forms before this replaced anything: 22 browser units, 0 unparseable,
       0 loader-name tokens. */
    for (const t of tokens) {
      if (BROWSER_LOADER_NAMES.has(t.value)) {
        loaderTokenHits.push(`${t.value} at ${label}:${t.loc.start.line}`);
        browserProblems.push(`UNACCEPTED browser loader token \`${t.value}\` at ${label}:${t.loc.start.line} — it can load code this scan never sees`);
      }
    }

    for (const node of nodes) {
      if (!IMPORTS_SOURCE(node) || !node.source || node.source.type !== 'Literal' || typeof node.source.value !== 'string') continue;
      accountedSources.add(node.source);
      const raw = node.source.value;
      if (BROWSER_EXTERNAL(raw)) { out.external.push(raw); continue; }
      const bare = raw.replace(/[?#].*$/, '');
      if (!/^\.{0,2}\//.test(bare)) {
        noteBrowser(`UNRESOLVABLE browser import ${JSON.stringify(raw)} — a bare specifier needs an import map this scan cannot follow`, label, node);
      } else if (bare.startsWith('/')) {
        noteBrowser(`UNRESOLVABLE site-absolute browser import ${JSON.stringify(raw)} — this scan cannot map the site root onto a file`, label, node);
      } else {
        const abs = path.resolve(baseDir, bare);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          noteBrowser(`UNRESOLVABLE local browser import ${JSON.stringify(raw)} → ${path.relative(REPO, abs)}`, label, node);
        } else out.local.push({ spec: raw, abs });
      }
    }

    for (const node of new Set(nodes)) {
      if (IMPORTS_SOURCE(node) && node.source && !accountedSources.has(node.source)) {
        noteBrowser('UNACCEPTED non-literal import/export source', label, node);
      } else if (node.type === 'ImportExpression') {
        dynamicCandidates.push(node);   // decided together below: the inventory is a FILE-level fact
      } else if (node.type === 'MemberExpression' && node.computed && node.property && node.property.type !== 'Literal'
                 && node.object && node.object.type === 'Identifier' && GLOBAL_OBJECTS.has(node.object.name)) {
        /* An opaque key on a global cannot be ruled out as a loader, so it is not ignored — but it is also not
           refused outright, because the real forms use `window[key]` to stash and remove a one-off click
           handler six times each. Recorded by SOURCE TEXT (not line: inline-block lines shift on any HTML
           edit) and pinned below, so these exact spellings pass and anything new fails. */
        computedGlobalSites.push(`${label} ${source.slice(node.start, node.end)}`);
      } else if (node.type === 'Identifier' && node.name === 'require') {
        noteBrowser('UNACCEPTED `require` in BROWSER code — it is not a browser loader, so whatever supplies it is a bundler or shim this scan cannot follow', label, node);
      }
    }
    /* (B) THE DYNAMIC IMPORTS: shape per site, then ONE verdict per base name over the whole file, because
       "how many times does this name appear" is not a question about any single site. Every site in a refused
       group is named individually, so a reader sees which imports are unaccounted for. */
    const groups = new Map();
    for (const node of dynamicCandidates) {
      const shape = dynamicShapeOf(node, source);
      if (shape.reason) { noteBrowser(`UNACCEPTED dynamic \`import(...)\` in browser code — ${shape.reason}`, label, node); continue; }
      if (!groups.has(shape.name)) groups.set(shape.name, []);
      groups.get(shape.name).push({ node, ...shape });
    }
    for (const [name, group] of groups) {
      const verdict = tokenInventoryVerdict(name, group, tokens, nodes, parentOf);
      if (verdict.reason) {
        for (const c of group) noteBrowser(`UNACCEPTED dynamic \`import(...)\` in browser code — ${verdict.reason}`, label, c.node);
        continue;
      }
      for (const c of group) {
        let folded = null;
        try { folded = new URL(verdict.base + c.tail); } catch (_) { /* named below */ }
        if (!folded || folded.protocol !== 'https:') {
          noteBrowser(`UNACCEPTED dynamic \`import(...)\` in browser code — the folded specifier ${JSON.stringify(verdict.base + c.tail)} is not an https: URL`, label, c.node);
          continue;
        }
        dynamicSites.push(`${label}:${c.node.loc.start.line} ${c.text} → ${folded.href}`);
        out.external.push(folded.href);
      }
    }
    return out;
  };

  /* Transitive, breadth-first, over seeds that are already the real consumers (each form's inline blocks and
     its local <script src> files). A file reached twice is walked once; every followed edge is RECORDED, so
     "0 browser imports" below is a measurement rather than an assumption. */
  const browserClosure = (seeds) => {
    const seen = new Set(seeds.map((x) => x.file).filter(Boolean));
    const units = []; const queue = [...seeds];
    while (queue.length) {
      const cur = queue.shift();
      units.push(cur);
      const deps = browserDepsOf(cur.source, cur.label, cur.baseDir);
      for (const ext of deps.external) browserExternals.push(`${JSON.stringify(ext)} in ${cur.label}`);
      for (const l of deps.local) {
        browserImports.push(`${JSON.stringify(l.spec)} in ${cur.label} → ${path.relative(REPO, l.abs)}`);
        if (seen.has(l.abs)) continue;
        seen.add(l.abs);
        queue.push({ label: path.relative(REPO, l.abs), source: fs.readFileSync(l.abs, 'utf8'), baseDir: path.dirname(l.abs), file: l.abs });
      }
    }
    return units;
  };
  const seedsFromDir = (dirAbs, dirLabel) => {
    const html = fs.readFileSync(path.join(dirAbs, 'index.html'), 'utf8');
    const seeds = [];
    inlineScripts(html).forEach((b, i) => seeds.push({ label: `${dirLabel}/index.html (inline block ${i})`, source: b, baseDir: dirAbs }));
    for (const src of scriptSrcs(html).filter((x) => !x.external)) {
      const abs = path.join(dirAbs, src.file);
      if (fs.existsSync(abs)) seeds.push({ label: `${dirLabel}/${src.file}`, source: fs.readFileSync(abs, 'utf8'), baseDir: path.dirname(abs), file: abs });
    }
    return seeds;
  };
  /* Probe a raw source string directly — needed for the same-site regression, which edits a REAL account.js
     in memory rather than inventing a fixture that merely resembles one. */
  const sourceProbe = (source, label, baseDir) => {
    const pB = browserProblems.length, dB = dynamicSites.length, cB = computedGlobalSites.length, eB = browserExternals.length, lB = loaderTokenHits.length;
    const deps = browserDepsOf(source, label, baseDir);
    const out = { deps, problems: browserProblems.slice(pB), dynamic: dynamicSites.slice(dB), computed: computedGlobalSites.slice(cB) };
    browserProblems.length = pB; dynamicSites.length = dB; computedGlobalSites.length = cB; browserExternals.length = eB; loaderTokenHits.length = lB;
    return out;
  };

  /* Fixture runs snapshot and restore all three browser collectors, exactly as the server probes do. */
  const browserProbe = (seeds) => {
    const pB = browserProblems.length, iB = browserImports.length, eB = browserExternals.length, dB = dynamicSites.length, cB = computedGlobalSites.length, lB = loaderTokenHits.length;
    const units = browserClosure(seeds);
    const out = { units, problems: browserProblems.slice(pB), imports: browserImports.slice(iB), externals: browserExternals.slice(eB), dynamic: dynamicSites.slice(dB), computed: computedGlobalSites.slice(cB), loaders: loaderTokenHits.slice(lB) };
    loaderTokenHits.length = lB;
    browserProblems.length = pB; browserImports.length = iB; browserExternals.length = eB; dynamicSites.length = dB; computedGlobalSites.length = cB;
    return out;
  };

  const fnClosure = localClosure(path.join(ROOT, 'index.js')).map((f) => path.relative(ROOT, f)).sort();
  /* 🔴 THE FAIL-CLOSED HALF, ASSERTED. Collecting problems and not checking them would be the silent
     skip wearing a different coat. A non-literal require or an unresolvable local specifier means the
     closure is INCOMPLETE, and an incomplete closure makes every "identity_id appears nowhere" below a
     statement about the part of the graph this harness happened to reach. */
  assert.deepStrictEqual(acceptedLoaderReads.sort(), ['require.main at ready-time-quality-run.js:192'],
    `🔴 the set of ACCEPTED loader reads changed: ${JSON.stringify(acceptedLoaderReads)}. Exactly one was audited and accepted — \`if (require.main === module)\`, the CLI-entrypoint guard, which cannot load anything. A new one is a decision to take deliberately, not a line to update`);
  assert.deepStrictEqual(nonRelativeLocals, [],
    `🔴 resolution-based classification ADDED ${nonRelativeLocals.length} local module(s) that the old prefix rule dropped:\n    ${nonRelativeLocals.join('\n    ')}\n    Scanning them is correct — but the counts pinned in this cell were agreed over the closure WITHOUT them. Report and re-agree them; do not let the closure widen silently.`);
  assert.deepStrictEqual(loaderProblems, [],
    `🔴 dependency discovery could not account for ${loaderProblems.length} edge(s), so the closure is incomplete and the scan below cannot be trusted:\n    ${loaderProblems.join('\n    ')}`);
  assert.ok(fnClosure.length >= 40, `premise — the require-closure of index.js reached the codebase (${fnClosure.length} modules)`);
  for (const must of ['menu-pricing.js', 'compute-server-net.js', 'catalog/catalog.js', 'catalog/pricing-tables.js', 'factura/pricing.js']) {
    assert.ok(fnClosure.includes(must), `premise — the closure reaches ${must}, which the old FILENAME scan missed`);
  }
  for (const owner of Object.keys(OWNS_IDENTITY)) {
    assert.ok(fnClosure.includes(owner), `premise — allowlisted ${owner} is actually reached by the closure; a stale allowlist entry excuses nothing and hides that it is dead`);
  }
  for (const outside of OWNERS_OUTSIDE_SERVING) {
    assert.ok(!fnClosure.includes(outside),
      `🔴 ${outside} is now reachable from index.js. It is the identity CUTOVER / restore path — operator tooling that the request path must not be able to run. Either that is a deliberate architectural change, in which case it needs an allowlist entry and a reason, or it is an accidental require and the real finding`);
  }
  const scanned = fnClosure.filter((rel) => !Object.prototype.hasOwnProperty.call(OWNS_IDENTITY, rel));

  const violations = [];
  for (const rel of scanned) {
    const hit = codeHasIdentity(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.notStrictEqual(hit, null, `premise — ${rel} must tokenize, or the scan silently skips it`);
    if (hit) violations.push(`xpizza-functions/${rel}`);
  }
  let formFiles = 0;
  let browserFollowed = 0;
  for (const rid of BRANDS) {
    const dir = FORM_DIR[rid];
    const html = formHtml(rid);
    const blocks = inlineScripts(html);
    assert.ok(blocks.length > 0, `premise — ${dir}/index.html has inline scripts`);
    const srcs = scriptSrcs(html);
    const local = srcs.filter((x) => !x.external);
    const external = srcs.filter((x) => x.external);
    assert.ok(local.length >= 5, `premise — ${dir} loads its local scripts (${local.length} local, ${external.length} external); these are the real consumers the filename scan missed`);
    assert.ok(external.every((x) => /^(?:https?:)?\/\//i.test(x.raw) || /^data:/i.test(x.raw)),
      `premise — every src classified EXTERNAL really is remote, so the classification is not a way of excusing a local file`);
    for (const src of local) {
      const abs = path.join(REPO, dir, src.file);
      /* FAIL, never skip: an unresolvable local src is either a broken page or a consumer this scan cannot
         see, and both deserve a name rather than a `continue`. */
      assert.ok(fs.existsSync(abs),
        `🔴 ${dir}/index.html loads a LOCAL script this scan cannot resolve: src=${JSON.stringify(src.raw)} → ${path.relative(REPO, abs)}. Either the page is broken or a real consumer is escaping the scan; the earlier version silently skipped exactly this case`);
      formFiles += 1;
    }
    /* Every browser unit — inline block, local src file, AND anything they import transitively — is scanned
       through the SAME closure the fixtures below drive, so the real forms and the fixtures cannot diverge. */
    const seeds = seedsFromDir(path.join(REPO, dir), dir);
    assert.strictEqual(seeds.length, blocks.length + local.length,
      `premise — every inline block and every local src became a seed for ${dir} (${seeds.length} vs ${blocks.length + local.length})`);
    const units = browserClosure(seeds);
    browserFollowed += units.length - seeds.length;
    for (const u of units) {
      const hit = codeHasIdentity(u.source);
      assert.notStrictEqual(hit, null, `premise — ${u.label} must tokenize, or the scan silently skips it`);
      if (hit) violations.push(u.label);
    }
  }
  /* 🔴 THE BROWSER FAIL-CLOSED HALF, AND THE MEASUREMENT BEHIND "0 IMPORTS". Per the owner's instruction for
     this round: if a real form already used imports or workers, this STOPS and reports rather than widening. */
  assert.deepStrictEqual(browserProblems, [],
    `🔴 browser dependency discovery could not account for ${browserProblems.length} edge(s), so the form graph is incomplete and every "identity_id appears nowhere" below is a statement about the part of it this harness reached:\n    ${browserProblems.join('\n    ')}`);
  assert.deepStrictEqual(loaderTokenHits, [],
    `🔴 the forms contain ${loaderTokenHits.length} browser-loader token(s):\n    ${loaderTokenHits.join('\n    ')}\n    Worker / SharedWorker / importScripts can each run code this scan never sees. Measured as 0 across 22 browser units when this rule was written; a new one is a decision, not a line to update.`);
  assert.deepStrictEqual(browserImports, [],
    `🔴 the forms now import ${browserImports.length} local module(s) in the browser:\n    ${browserImports.join('\n    ')}\n    They ARE followed and scanned, so this is not a hole — but the pinned form counts were agreed over a graph without them. Report and re-agree them; do not let the browser closure widen silently.`);
  assert.strictEqual(browserFollowed, 0,
    `🔴 ${browserFollowed} file(s) entered the scan only through a browser import; the pinned counts predate them (${browserImports.join(', ')})`);
  assert.ok(browserExternals.every((x) => /^"(?:https?:)?\/\//.test(x) || /^"data:/.test(x)),
    `premise — every browser import classified EXTERNAL really is remote (${JSON.stringify(browserExternals)})`);

  /* ═══ (C) THE PIN, AS THE BACKSTOP BEHIND (D) ═══
     (D) decides whether a dynamic import can be PROVED remote; the pin decides whether it is one we have
     ACTUALLY AGREED TO. A new dynamic import that (D) would happily accept still fails here until someone
     adds it deliberately — the same arrangement as the single `require.main` read on the server side, and the
     reason neither exception can quietly become a habit. Each entry is file:line + the exact specifier source
     text + the folded URL, so a pinned site cannot change what it loads without failing.
     🔴 WRITTEN FROM THE SPEC AND FROM READING account.js, NOT PASTED FROM THE RUN'S OUTPUT — a pin copied
     from what the code printed asserts only that the code agrees with itself. If these six strings are wrong,
     this must fail. */
  /* Opaque keys on a global, pinned by TEXT and COUNT. Both forms stash a dismiss handler on
     `window[key]` — a write and a truthiness test, neither of which can load anything — and the alternative
     to pinning them was a taxonomy of "safe positions", which is the enumerate-the-spellings game that has
     already lost three times in this file. Written from reading index.html, not from the run's output. */
  const countByText = (list) => {
    const m = new Map();
    for (const x of list) m.set(x, (m.get(x) || 0) + 1);
    return [...m.entries()].map(([k, v]) => `${k} \u00d7${v}`).sort();
  };
  const PINNED_COMPUTED_GLOBALS = [
    'la-musa-orders/index.html (inline block 2) window[key] \u00d76',
    'xpizza-orders/index.html (inline block 2) window[key] \u00d76',
  ];
  assert.deepStrictEqual(countByText(computedGlobalSites), PINNED_COMPUTED_GLOBALS,
    `🔴 the set of opaque computed members on window/self/globalThis in the forms changed:\n    ${countByText(computedGlobalSites).join('\n    ')}\n  pinned:\n    ${PINNED_COMPUTED_GLOBALS.join('\n    ')}\n    An opaque key on a global cannot be ruled out as a loader by reading it. The pinned ones are a stashed click handler; a NEW one must be looked at rather than absorbed.`);

  const PINNED_DYNAMIC_IMPORTS = [
    'xpizza-orders/account.js:28 `${V}/firebase-app.js` → https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js',
    'xpizza-orders/account.js:29 `${V}/firebase-auth.js` → https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js',
    'xpizza-orders/account.js:30 `${V}/firebase-database.js` → https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js',
    'la-musa-orders/account.js:32 `${V}/firebase-app.js` → https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js',
    'la-musa-orders/account.js:33 `${V}/firebase-auth.js` → https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js',
    'la-musa-orders/account.js:34 `${V}/firebase-database.js` → https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js',
  ];
  assert.deepStrictEqual(dynamicSites.slice().sort(), PINNED_DYNAMIC_IMPORTS.slice().sort(),
    `🔴 the set of ACCEPTED dynamic imports in the forms changed:\n    ${dynamicSites.join('\n    ')}\n  pinned:\n    ${PINNED_DYNAMIC_IMPORTS.join('\n    ')}\n    These are the modular Firebase SDK's lazy loads, accepted because the base const is PROVED to be an https:// literal in the same file. A new one — even one the proof accepts — is a decision to take deliberately, not a line to update. account.js is production and is NOT edited for this test's sake.`);
  assert.deepStrictEqual(violations, [],
    `🔴 identity_id is READ as code on the money path: ${violations.join(', ')}. Rule 2 is that pricing, cart, quote, redemption and factura key off the display id / name and NEVER off identity_id. Do NOT widen the allowlist to make this pass — it is for the identity/catalog modules that OWN the field. A consumer starting to depend on identity_id is the event this test exists to catch: finalize the public contract first (docs/contracts/public-menu-identity_id.md)`);

  /* 🔴 THE CELLS THAT PROVE THE SCAN IS A SCAN — including DISCOVERY, which the filename version could not
     have had: a module reached ONLY through a require chain, with a name that matches no pattern. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-'));
  try {
    fs.writeFileSync(path.join(tmp, 'entry.js'), "const dep = require('./zzz-unnamed-helper.js');\nmodule.exports = { dep };\n");
    fs.writeFileSync(path.join(tmp, 'zzz-unnamed-helper.js'), 'module.exports = (rec) => rec.identity_id;\n');
    const found = withLocalRoot(tmp, () => localClosure(path.join(tmp, 'entry.js'))).map((f) => path.basename(f));
    assert.ok(found.includes('zzz-unnamed-helper.js'),
      `🔴 the closure did not DISCOVER a module reachable only by require — that is the whole reason for using a closure instead of filenames (found ${JSON.stringify(found)})`);
    assert.strictEqual(codeHasIdentity(fs.readFileSync(path.join(tmp, 'zzz-unnamed-helper.js'), 'utf8')), true,
      '🔴 and the discovered module\'s identity_id read was not a hit');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* 🔴 THE ALLOWLIST, PROVEN IN BOTH DIRECTIONS. Three review rounds each found another spelling a denylist
     missed, so what has to be demonstrated now is not "these spellings are caught" but "the accepted shapes
     are followed AND everything else fails by name". */
  const spell = fs.mkdtempSync(path.join(os.tmpdir(), 'spelling-'));
  const closureIn = (entryAbs) => withLocalRoot(spell, () => localClosure(entryAbs));
  /* Fixture runs must not leak into the two asserted lists: loaderProblems is checked empty and
     acceptedLoaderReads is pinned to the single real site, so both are snapshotted and restored. */
  const probeFor = (entryRel) => {
    const pBefore = loaderProblems.length; const aBefore = acceptedLoaderReads.length; const nBefore = nonRelativeLocals.length;
    const closure = closureIn(path.join(spell, entryRel)).map((f) => path.basename(f));
    const problems = loaderProblems.slice(pBefore);
    const accepted = acceptedLoaderReads.slice(aBefore);
    const added = nonRelativeLocals.slice(nBefore);
    loaderProblems.length = pBefore; acceptedLoaderReads.length = aBefore; nonRelativeLocals.length = nBefore;
    return { closure, problems, accepted, added };
  };
  const problemsFor = (entryRel) => probeFor(entryRel).problems;
  try {
    fs.writeFileSync(path.join(spell, 'helper.js'), 'module.exports = (r) => r.identity_id;\n');

    // ACCEPTED, and FOLLOWED — including the spaced spelling that started this.
    fs.writeFileSync(path.join(spell, 'ok-spaced.js'), "const h = require ('./helper.js');\nmodule.exports = h;\n");
    const spaced = closureIn(path.join(spell, 'ok-spaced.js')).map((f) => path.basename(f));
    assert.ok(spaced.includes('helper.js'), `🔴 \`require ('./x')\` with a space was not followed (${JSON.stringify(spaced)})`);
    assert.deepStrictEqual(problemsFor('ok-spaced.js'), [], 'and an accepted shape reports no problem');
    assert.strictEqual(codeHasIdentity(fs.readFileSync(path.join(spell, 'helper.js'), 'utf8')), true,
      '🔴 the followed module\'s identity_id read was not flagged');

    // ACCEPTED: a template literal with no substitutions is still a literal specifier.
    fs.writeFileSync(path.join(spell, 'ok-template.js'), 'const h = require(`./helper.js`);\nmodule.exports = h;\n');
    assert.ok(closureIn(path.join(spell, 'ok-template.js')).map((f) => path.basename(f)).includes('helper.js'),
      '🔴 a quasi-free template specifier was not followed');

    // REJECTED, each by name. These are the three escapes review found, plus the shapes around them.
    const rejects = [
      ['bad-computed.js', 'const h = module["require"]("./helper.js");\nmodule.exports = h;\n', /module\.require/, 'module["require"] — the computed spelling the last walk skipped entirely'],
      ['bad-modreq.js', 'const h = module.require("./helper.js");\nmodule.exports = h;\n', /module\.require/, 'module.require'],
      ['bad-alias.js', 'const r = require;\nmodule.exports = r("./helper.js");\n', /UNACCEPTED use of `require`/, 'const r = require — an aliased loader'],
      ['bad-call.js', 'module.exports = require.call(null, "./helper.js");\n', /UNACCEPTED use of `require`/, 'require.call(...)'],
      ['bad-dynamic.js', 'const w = process.env.X;\nmodule.exports = require("./" + w);\n', /UNACCEPTED use of `require`/, 'a non-literal specifier'],
      ['bad-opaque.js', 'const k = "require";\nmodule.exports = module[k]("./helper.js");\n', /computed member of `module`/, 'module[k] — an opaque computed member that cannot be ruled out'],
    ];
    for (const [file, body, pattern, label] of rejects) {
      fs.writeFileSync(path.join(spell, file), body);
      const added = problemsFor(file);
      assert.ok(added.length > 0, `🔴 ${label} was SILENTLY ACCEPTED — an unknown loader shape must fail by name, which is the whole point of inverting the model`);
      assert.ok(added.some((a) => pattern.test(a)), `🔴 ${label} was reported but not named recognisably: ${JSON.stringify(added)}`);
      assert.ok(added.every((a) => /:\d+$/.test(a) || /^UNRESOLVABLE/.test(a)), `🔴 ${label} was reported without a file:line`);
    }

    // ESM: a dynamic import() must be rejected; a literal `import … from` must be followed.
    fs.writeFileSync(path.join(spell, 'bad-import.mjs'), 'const w = process.env.X;\nconst m = await import(w);\nexport default m;\n');
    assert.ok(problemsFor('bad-import.mjs').some((a) => /dynamic `import/.test(a)), '🔴 a dynamic import(x) was not rejected');
    fs.writeFileSync(path.join(spell, 'ok-esm.mjs'), "import h from './helper.js';\nexport default h;\n");
    assert.ok(closureIn(path.join(spell, 'ok-esm.mjs')).map((f) => path.basename(f)).includes('helper.js'),
      '🔴 a literal ESM import was not followed');

    /* 🔴 require.main IS ACCEPTED BY USE, NOT BY LOCATION. The previous pin rejected CALLING require.main
       and accepted it as a RECEIVER, so this exact line on the pinned file would have been accepted with its
       dependency omitted and the pinned list unchanged — the exception turning into a hole at the one
       address nobody re-reads. */
    fs.writeFileSync(path.join(spell, 'bad-main-receiver.js'),
      'if (require.main["require"]("./helper.js")) { module.exports = 1; }\n');
    const recv = probeFor('bad-main-receiver.js');
    assert.ok(recv.problems.length > 0,
      '🔴 `require.main["require"](…)` was ACCEPTED — using require.main as a receiver must fail, or the pin is a location exemption rather than a shape one');
    assert.deepStrictEqual(recv.accepted, [],
      '🔴 and it must not be recorded as an accepted read: only the exact `if (require.main === module)` guard is');
    assert.ok(!recv.closure.includes('helper.js'),
      'premise — its dependency was indeed not followed, which is why silently accepting it would have hidden a module');

    // THE EXACT GUARD is accepted, and recorded as a read.
    fs.writeFileSync(path.join(spell, 'ok-main-guard.js'),
      'module.exports = 1;\nif (require.main === module) { console.log("cli"); }\n');
    const guard = probeFor('ok-main-guard.js');
    assert.deepStrictEqual(guard.problems, [], `🔴 the exact CLI guard was rejected (${JSON.stringify(guard.problems)})`);
    assert.strictEqual(guard.accepted.length, 1, '🔴 the exact CLI guard was not recorded as an accepted read');
    // …and the reversed operand order is the same shape.
    fs.writeFileSync(path.join(spell, 'ok-main-reversed.js'),
      'module.exports = 1;\nif (module === require.main) { console.log("cli"); }\n');
    assert.deepStrictEqual(probeFor('ok-main-reversed.js').problems, [], '🔴 `module === require.main` (reversed) was rejected');
    // …while any OTHER comparison or use of it fails.
    for (const [file, body, label] of [
      ['bad-main-neq.js', 'if (require.main !== module) { module.exports = 1; }\n', 'a different comparison'],
      ['bad-main-assign.js', 'const m = require.main;\nmodule.exports = m;\n', 'an assignment'],
      ['bad-main-call.js', 'module.exports = require.main();\n', 'a call'],
    ]) {
      fs.writeFileSync(path.join(spell, file), body);
      assert.ok(probeFor(file).problems.length > 0, `🔴 ${label} on require.main was accepted`);
    }

    /* 🔴 SPECIFIERS ARE CLASSIFIED BY RESOLUTION, NOT BY PREFIX. `if (!spec.startsWith('.')) continue` meant
       anything without a leading dot was ASSUMED to be a package: `require('/abs/local.js')` passed the shape
       allowlist and was never followed or scanned. */
    fs.writeFileSync(path.join(spell, 'abs-helper.js'), 'module.exports = (r) => r.identity_id;\n');
    fs.writeFileSync(path.join(spell, 'ok-absolute.js'),
      `const h = require(${JSON.stringify(path.join(spell, 'abs-helper.js'))});\nmodule.exports = h;\n`);
    const abs = probeFor('ok-absolute.js');
    assert.ok(abs.closure.includes('abs-helper.js'),
      `🔴 an ABSOLUTE local specifier was not followed — it has no leading dot, which the prefix test treated as a package (${JSON.stringify(abs.closure)})`);
    assert.deepStrictEqual(abs.problems, [], 'and it is local, not a failure');
    /* The reported target is the RESOLVED path, which on macOS means the realpath (/private/var/… for a
       tmpdir), so the expectation is DERIVED from realpathSync rather than spelled out — reporting where the
       specifier actually landed is the point. */
    assert.deepStrictEqual(abs.added, [`${JSON.stringify(path.join(spell, 'abs-helper.js'))} in ${path.relative(ROOT, path.join(spell, 'ok-absolute.js'))} → ${path.relative(ROOT, fs.realpathSync(path.join(spell, 'abs-helper.js')))}`],
      `🔴 the edge was FOLLOWED but not REPORTED as one the prefix rule would have dropped (${JSON.stringify(abs.added)}) — widening the closure silently is the defect this pairs with`);
    // …while an ordinary relative edge is followed and is NOT reported, so the report means what it says.
    fs.writeFileSync(path.join(spell, 'rel-helper.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(spell, 'ok-relative.js'), "const h = require('./rel-helper.js');\nmodule.exports = h;\n");
    const rel = probeFor('ok-relative.js');
    assert.ok(rel.closure.includes('rel-helper.js'), 'premise — the relative edge is followed');
    assert.deepStrictEqual(rel.added, [], '🔴 a plain relative edge was reported as a prefix-rule addition');
    assert.strictEqual(codeHasIdentity(fs.readFileSync(path.join(spell, 'abs-helper.js'), 'utf8')), true,
      '🔴 and the module it reached would not have been scanned for identity_id');

    /* The remaining three classes are probed on classifySpecifier DIRECTLY, from a directory where packages
       actually resolve. 🔴 MY FIRST FIXTURE GOT THIS WRONG: it did `require('acorn')` from the tmp dir, and
       the classifier correctly reported UNRESOLVABLE because node_modules is not reachable from
       /var/folders/… . The rule was right and the fixture was wrong about its own environment — so the probe
       now asks the question from ROOT, where a package specifier is genuinely resolvable. */
    const classifyProbe = (spec, fromDir) => {
      const before = loaderProblems.length;
      const cls = classifySpecifier(spec, fromDir, path.join(ROOT, 'index.js'));
      const problems = loaderProblems.slice(before);
      loaderProblems.length = before;
      return { kind: cls.kind, problems };
    };

    // A real package resolves inside node_modules: classified package, never followed, not a failure.
    const asPkg = classifyProbe('acorn', ROOT);
    assert.strictEqual(asPkg.kind, 'package', `🔴 a bare package specifier was classified ${asPkg.kind}, not package`);
    assert.deepStrictEqual(asPkg.problems, [], 'and a package is not a problem');

    // Builtins, both spellings, and one resolved from a directory with no node_modules at all.
    for (const spec of ['fs', 'node:path', 'module']) {
      assert.strictEqual(classifyProbe(spec, spell).kind, 'builtin', `🔴 ${spec} was not classified as a builtin`);
    }

    /* 🔴 AND AN UNKNOWN `node:` NAME IS A FAILURE, NOT A BUILTIN. The prefix test accepted it, so a
       specifier Node cannot resolve was silently accounted for. Both spellings of a REAL builtin stay
       builtin (above), which is what makes this cell about the unknown name rather than about the prefix. */
    for (const fake of ['node:not-a-real-builtin-xyz', 'node:']) {
      const bad = classifyProbe(fake, ROOT);
      assert.strictEqual(bad.kind, 'fail', `🔴 ${JSON.stringify(fake)} was classified ${bad.kind} — the prefix was taken as proof of a builtin`);
      assert.ok(bad.problems.some((x) => /UNRESOLVABLE/.test(x) && x.includes(fake)),
        `🔴 and it was not named as unresolvable (${JSON.stringify(bad.problems)})`);
    }

    // An unresolvable bare specifier FAILS by name rather than being assumed to be a package.
    const unres = classifyProbe('definitely-not-a-real-package-xyz', ROOT);
    assert.strictEqual(unres.kind, 'fail', '🔴 an unresolvable bare specifier was not a failure');
    assert.ok(unres.problems.some((x) => /UNRESOLVABLE/.test(x)),
      `🔴 it was not named as unresolvable (${JSON.stringify(unres.problems)})`);

    /* And a specifier that resolves OUTSIDE every declared local root, and is not a package, fails too — the
       branch that exists so "not local and not a package" can never be silently skipped. */
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'stranger.js'), 'module.exports = 1;\n');
      const out = classifyProbe(path.join(outside, 'stranger.js'), ROOT);
      assert.strictEqual(out.kind, 'fail', `🔴 a module resolving outside every local root was classified ${out.kind}`);
      assert.ok(out.problems.some((x) => /OUTSIDE every declared local root/.test(x)), '🔴 and it was not named as such');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }

    /* THE FORM SPELLINGS, ON THE DOM PATH — including the data-src trap, which is why this is jsdom. */
    fs.writeFileSync(path.join(spell, 'form-cart.js'), 'window.x = 1;\n');
    const trap = scriptSrcs('<script data-src="https://cdn.example/x.js" src="hidden.js"></script>');
    assert.deepStrictEqual(trap.map((t) => t.raw), ['hidden.js'],
      '🔴 the data-src trap won: a regex on /\\bsrc\\s*=/ matches inside data-src and returns the EXTERNAL url, dropping the real local script');
    assert.strictEqual(trap[0].external, false, '🔴 and the local src was misclassified as external');

    const page = `<script src='form-cart.js'></script><script src=form-cart.js></script><script src="form-cart.js?v=2"></script><script src="https://cdn.example/x.js"></script><script>var inline = 1;</script>`;
    const parsed = scriptSrcs(page);
    assert.deepStrictEqual(parsed.filter((x) => !x.external).map((x) => x.file), ['form-cart.js', 'form-cart.js', 'form-cart.js'],
      '🔴 a src spelling was missed: single-quoted, unquoted and ?query-bearing srcs must all resolve to the same local file');
    assert.deepStrictEqual(parsed.filter((x) => x.external).map((x) => x.raw), ['https://cdn.example/x.js'],
      '🔴 the remote src was not classified external');
    assert.strictEqual(inlineScripts(page).length, 1, '🔴 the inline set must come from the DOM too: script:not([src])');
    assert.match(inlineScripts(page)[0], /var inline = 1;/, 'and it must carry the inline body');

    const missing = scriptSrcs('<script src="not-here.js"></script>').filter((x) => !x.external);
    assert.strictEqual(missing.length, 1, 'premise — a missing-file src is still DISCOVERED');
    assert.ok(!fs.existsSync(path.join(spell, missing[0].file)),
      'premise — and it does not exist, which the scan fails on by name rather than skipping');
  } finally {
    fs.rmSync(spell, { recursive: true, force: true });
  }

  /* ═══ THE BROWSER GRAPH'S CELLS ═══
     Each case gets its OWN fixture directory and its own probe, because a shared fixture lets the FIRST
     refusal shadow the case that names a later one — the scan stops accounting for a graph it has already
     failed on, and the cell that was supposed to prove the second rule never runs its assertion. */
  const browserFix = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-'));
  try {
    let fixN = 0;
    const probeHtml = (html, files = {}) => {
      const dir = path.join(browserFix, `f${++fixN}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html);
      for (const [name, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), body);
      }
      return browserProbe(seedsFromDir(dir, path.relative(REPO, dir)));
    };

    /* 🔴 CODEX'S EXACT PROBE, which the previous version answered srcs [] / inlineHits [false]: an inline
       module importing a helper that reads identity_id. The helper must be FOUND and FLAGGED. */
    const mod = probeHtml('<script type="module">import "./pricing-helper.js";</script>',
      { 'pricing-helper.js': 'export const key = (record) => record.identity_id;\n' });
    assert.deepStrictEqual(mod.problems, [], `🔴 an ordinary inline module import was reported as a problem (${JSON.stringify(mod.problems)})`);
    assert.strictEqual(mod.imports.length, 1, `🔴 the inline module import was not recorded (${JSON.stringify(mod.imports)})`);
    const helperUnit = mod.units.find((u) => /pricing-helper\.js$/.test(u.label));
    assert.ok(helperUnit, `🔴 the imported helper was not FOUND — this is the gap: units were ${JSON.stringify(mod.units.map((u) => u.label))}`);
    assert.strictEqual(codeHasIdentity(helperUnit.source), true,
      '🔴 the helper was found but not FLAGGED as reading identity_id, so discovery improved and detection did not');

    // A LOCAL src file that imports a helper: followed transitively, two hops from the page.
    const viaSrc = probeHtml('<script src="form-cart.js"></script>', {
      'form-cart.js': "import { key } from './deep/adapter.js';\nwindow.k = key;\n",
      'deep/adapter.js': 'export const key = (r) => r.identity_id;\n',
    });
    assert.deepStrictEqual(viaSrc.problems, [], `🔴 a src file's own import was reported as a problem (${JSON.stringify(viaSrc.problems)})`);
    assert.ok(viaSrc.units.some((u) => /adapter\.js$/.test(u.label) && codeHasIdentity(u.source) === true),
      `🔴 a helper reached through a local src file's import was not followed and flagged (${JSON.stringify(viaSrc.units.map((u) => u.label))})`);

    /* (C) IS A REAL BACKSTOP, not decoration: a site (D) fully ACCEPTS is still not in the pin, and the main
       assertion above compares the whole set with deepStrictEqual — so its presence there fails the run. */
    const unpinned = probeHtml("<script type=\"module\">const V = 'https://cdn.example/x';\nimport(`${V}/a.js`);</script>");
    assert.deepStrictEqual(unpinned.problems, [], `🔴 (D) refused a provable https base (${JSON.stringify(unpinned.problems)})`);
    assert.strictEqual(unpinned.dynamic.length, 1, '🔴 (D) did not accept a dynamic import whose base is a proved https const');
    assert.ok(!PINNED_DYNAMIC_IMPORTS.includes(unpinned.dynamic[0]),
      `🔴 (C) would not catch it: a site (D) accepts is already in the pin (${unpinned.dynamic[0]})`);

    // An EXTERNAL literal import is classified external rather than followed or failed.
    const ext = probeHtml('<script type="module">import "https://cdn.example/lib.js";</script>');
    assert.deepStrictEqual(ext.problems, [], `🔴 an external literal import failed (${JSON.stringify(ext.problems)})`);
    assert.deepStrictEqual(ext.imports, [], '🔴 an external import was followed as if it were local');
    assert.ok(ext.externals.some((x) => x.includes('https://cdn.example/lib.js')), `🔴 it was not recorded as external (${JSON.stringify(ext.externals)})`);

    /* EVERY OTHER LOADER SHAPE FAILS BY NAME — one fixture each, and the message must name the REASON, so a
       cell cannot pass on a failure that happened for a different cause. */
    for (const [what, html, mustMatch] of [
      ['a let base', "<script type=\"module\">let V = 'https://cdn.example/x';\nimport(`${V}/a.js`);</script>", /is declared with let, not const/],
      ['a var base', "<script type=\"module\">var V = 'https://cdn.example/x';\nimport(`${V}/a.js`);</script>", /is declared with var, not const/],
      ['a reassigned base', "<script type=\"module\">const V = 'https://cdn.example/x';\nV = 'x';\nimport(`${V}/a.js`);</script>", /identifier token\(s\)/],
      ['a shadowed base', "<script type=\"module\">const V = 'https://cdn.example/x';\nfunction f(V) { return import(`${V}/a.js`); }\n</script>", /identifier token\(s\)/],
      ['a non-remote base', "<script type=\"module\">const V = './local';\nimport(`${V}/a.js`);</script>", /does not start with https:\/\//],
      ['two interpolations', "<script type=\"module\">const V = 'https://cdn.example/x';\nconst W = 'a.js';\nimport(`${V}${W}`);</script>", /has 2 interpolations/],
      ['a leading literal', "<script type=\"module\">const V = 'x';\nimport(`https://cdn.example/${V}`);</script>", /does not START with the interpolation/],
      ['an opaque specifier', '<script type="module">const x = "a"; import(x);</script>', /not a template literal/],
      ['a member interpolation', "<script type=\"module\">const C = { v: 'https://cdn.example/x' };\nimport(`${C.v}/a.js`);</script>", /interpolation is a MemberExpression/],
      ['a worker', '<script>new Worker("./w.js");</script>', /UNACCEPTED browser loader token `Worker`/],
      ['a shared worker', '<script>new SharedWorker("./w.js");</script>', /UNACCEPTED browser loader token `SharedWorker`/],
      ['importScripts', '<script>importScripts("./w.js");</script>', /UNACCEPTED browser loader token `importScripts`/],
      ['require in browser code', '<script>var h = require("./helper.js");</script>', /UNACCEPTED `require` in BROWSER code/],
      ['a bare specifier', '<script type="module">import "lodash";</script>', /a bare specifier needs an import map/],
      ['a site-absolute import', '<script type="module">import "/assets/a.js";</script>', /site-absolute browser import/],
      ['a missing local import', '<script type="module">import "./not-here.js";</script>', /UNRESOLVABLE local browser import/],
      /* 🔴 CODEX'S TWO LATEST ESCAPES, the ones that ended the binding-form chase. Both were INVISIBLE to the
         AST rules: a destructuring key looked like an object-literal key, and a ClassExpression's own name was
         a binding form my scope walker did not model. Neither can hide from a token. */
      ['a destructured loader', "<script>const { Worker: W } = window;\nnew W('./w.js');</script>", /UNACCEPTED browser loader token `Worker`/],
      ['a quoted destructuring key', "<script>const { 'Worker': W } = window;\nnew W('./w.js');</script>", /UNACCEPTED browser loader token `Worker`/],
      ['a loader named only in a string', '<script>const n = "importScripts";\nwindow.stash = n;</script>', /UNACCEPTED browser loader token `importScripts`/],
      ['a class-expression base', "<script type=\"module\">const C = class V { f() { return import(`${V}/a.js`); } };\nwindow.C = C;</script>", /not the id of a variable declarator/],
      /* 🔴 CODEX'S THREE PROBES — each returned empty deps AND empty problems when the rule matched a call
         spelling instead of a reference. A worker is the worst case: it runs code this scan never sees. */
      ['a member-qualified worker', '<script>new window.Worker("./w.js");</script>', /UNACCEPTED browser loader token `Worker`/],
      ['an aliased worker', '<script>const W = Worker;\nnew W("./w.js");</script>', /UNACCEPTED browser loader token `Worker`/],
      ['a member-qualified importScripts', '<script>self.importScripts("./w.js");</script>', /UNACCEPTED browser loader token `importScripts`/],
      ['a string-keyed worker', '<script>const W = globalThis["Worker"];\nnew W("./w.js");</script>', /UNACCEPTED browser loader token `Worker`/],
      ['a worker never called', '<script>const keep = Worker;\nwindow.stash = keep;</script>', /UNACCEPTED browser loader token `Worker`/],
      /* (D) BY SCOPE — codex's exact counterexample first: the const is real, is a const, and is an https
         literal, and it governs NOTHING at the import site. Counting accepted it; resolution refuses it. */
      ['codex\'s out-of-scope base', "<script type=\"module\">window.V = './local';\nfunction f() { const V = 'https://cdn.example/x'; }\nimport(`${V}/a.js`);</script>", /identifier token\(s\)/],
      ['a function-local base used outside it', "<script type=\"module\">function f() { const V = 'https://cdn.example/x'; }\nimport(`${V}/a.js`);</script>", /does not enclose the import/],
      ['a top-level const shadowed by a global property', "<script type=\"module\">const V = 'https://cdn.example/x';\nwindow.V = './local';\nimport(`${V}/a.js`);</script>", /identifier token\(s\)/],
      ['a base bound in a sibling block', "<script type=\"module\">{ const V = 'https://cdn.example/x'; }\nimport(`${V}/a.js`);</script>", /does not enclose the import/],
    ]) {
      const r = probeHtml(html);
      assert.ok(r.problems.some((x) => mustMatch.test(x)),
        `🔴 ${what}: expected a named failure matching ${mustMatch}, got ${JSON.stringify(r.problems)}`);
      assert.strictEqual(r.dynamic.length, 0, `🔴 ${what}: the site was ACCEPTED as a provable dynamic import`);
      assert.deepStrictEqual(r.imports, [], `🔴 ${what}: something was followed as a local import`);
    }

    /* An opaque key on a global is RECORDED, never ignored — and a spelling that is not in the pin is exactly
       what makes the pin bite. `self[k]` and a computed `globalThis[k]` are accounted for and absent from
       PINNED_COMPUTED_GLOBALS, so were either to appear in a real form the pin assertion above would fail.
       (Same structure as the (C) backstop cell: a fixture cannot enter the real collected set.) */
    for (const [what, html, text] of [
      ['self[k]', '<script>const k = "x";\nself[k]();</script>', 'self[k]'],
      ['globalThis[k]', '<script>const k = "x";\nglobalThis[k] = 1;</script>', 'globalThis[k]'],
    ]) {
      const r = probeHtml(html);
      assert.deepStrictEqual(r.computed.map((x) => x.split(' ').pop()), [text],
        `🔴 ${what} was not RECORDED as an opaque member of a global (${JSON.stringify(r.computed)})`);
      assert.ok(!PINNED_COMPUTED_GLOBALS.some((pinned) => pinned.includes(` ${text} `)),
        `🔴 ${what} is already in the pin, so the pin would not catch it`);
    }

    /* ═══ THE SAME-SITE REGRESSION, ON A REAL account.js ═══
       Codex's point about the pin: with the declaration moved, all six pins were UNCHANGED — the pin
       preserved a false remote classification instead of catching it, which is the one thing a backstop must
       never do. So the regression is run against the REAL file, edited in memory, rather than a lookalike.
       (The instruction's literal form was "moved into a function"; the real declaration is ALREADY inside a
       function — ensureFirebase, measured — so the equivalent mutation is moving it OUT OF THE SCOPE CHAIN of
       the import sites, into a sibling function. That is the same defect on the same axis.) */
    const realAccount = fs.readFileSync(path.join(REPO, 'xpizza-orders/account.js'), 'utf8');
    const baseline = sourceProbe(realAccount, 'xpizza-orders/account.js', path.join(REPO, 'xpizza-orders'));
    assert.strictEqual(baseline.dynamic.length, 3,
      `premise — the UNEDITED real file's three sites ARE accepted (${JSON.stringify(baseline.dynamic)}); without this the regression below could pass on a file nothing accepts`);
    assert.deepStrictEqual(baseline.problems, [], `premise — and it has no browser problems (${JSON.stringify(baseline.problems)})`);

    const declRe = /const V = '(https:\/\/[^']+)';/;
    assert.match(realAccount, declRe, 'premise — the real declaration is where this mutation expects it');
    const moved = realAccount.replace(declRe, "function __holder() { const V = '$1'; }");
    const regressed = sourceProbe(moved, 'xpizza-orders/account.js (V moved out of scope)', path.join(REPO, 'xpizza-orders'));
    assert.deepStrictEqual(regressed.dynamic, [],
      `🔴 moving the base declaration out of the import's scope did NOT withdraw acceptance (${JSON.stringify(regressed.dynamic)}) — the classification survives an edit that changes what the import resolves to`);
    assert.ok(regressed.problems.some((x) => /does not enclose the import/.test(x)),
      `🔴 and it was not refused with the scope reason (${JSON.stringify(regressed.problems)})`);
    for (const site of regressed.dynamic) {
      assert.ok(!PINNED_DYNAMIC_IMPORTS.includes(site), `🔴 the pin would still hold this site (${site})`);
    }

    /* 🔴 AND CODEX'S CLASS REFACTOR, ON THE SAME REAL FILE. This is the sharper regression, because the TOKEN
       COUNT still comes out right: replacing the const with `const C = class V {}` leaves exactly one
       non-interpolation `V` token, so 1 + 3 = 4 as before. What refuses it is the next clause — that one token
       must be the id of a VARIABLE DECLARATOR, and a class name is not. Codex reported that under the previous
       rule this edit left all three pins intact, i.e. the pin preserved a remote classification for a base
       that no longer had a value. It must now withdraw acceptance. */
    const classRefactor = realAccount.replace(declRe, "const C = class V {};");
    assert.notStrictEqual(classRefactor, realAccount, 'premise — the class refactor actually changed the source');
    const asClass = sourceProbe(classRefactor, 'xpizza-orders/account.js (V as a class name)', path.join(REPO, 'xpizza-orders'));
    assert.deepStrictEqual(asClass.dynamic, [],
      `🔴 a class-expression name passed as a proved base (${JSON.stringify(asClass.dynamic)}) — the token count is unchanged at 4, so only the declarator clause can catch this`);
    assert.ok(asClass.problems.some((x) => /not the id of a variable declarator/.test(x)),
      `🔴 and it was not refused for the right reason (${JSON.stringify(asClass.problems)})`);
    for (const site of asClass.dynamic) {
      assert.ok(!PINNED_DYNAMIC_IMPORTS.includes(site), `🔴 the pin would still hold this site (${site})`);
    }
  } finally {
    fs.rmSync(browserFix, { recursive: true, force: true });
  }

  const xpHtml = formHtml('x_pizza');
  assert.ok((xpHtml.match(/identity_id/g) || []).length >= 4,
    'premise — the real order form mentions identity_id in prose (the accept-and-ignore contract note)');
  assert.strictEqual(inlineScripts(xpHtml).some((b) => codeHasIdentity(b)), false,
    '🔴 a COMMENT mentioning identity_id registered as a hit — comments must be excluded by construction, not by allowlisting their location');
  assert.strictEqual(codeHasIdentity('const d = {}; use(d.identity_id);'), true, '🔴 a property read was NOT a hit');
  assert.strictEqual(codeHasIdentity("const k = 'identity_id'; use(x[k]);"), true, '🔴 a string key was NOT a hit');
  assert.strictEqual(codeHasIdentity('const s = `${x.identity_id}`;'), true, '🔴 a template use was NOT a hit');
  ok(`identity_id is read nowhere on the money path: ${scanned.length} modules in the require-closure of index.js (${Object.keys(OWNS_IDENTITY).length} allowlisted, each proven reachable) plus ${formFiles} local form scripts and both forms' inline code — discovery is an ALLOWLIST of two loader shapes with ${acceptedLoaderReads.length} pinned read, proven in both directions: the accepted shapes (spaced require, quasi-free template, literal ESM import) are FOLLOWED, while module.require, module["require"], module[k], an aliased require, require.call, a non-literal specifier and a dynamic import() each FAIL BY NAME with file:line; the form is read from the DOM so the data-src trap cannot hide a local script; and prose is ignored while a property read, a string key and a template use are each caught; specifiers are classified by RESOLUTION rather than by a leading dot, with ${nonRelativeLocals.length} non-relative local edge(s) — so an absolute local specifier is followed and named instead of being assumed to be a package; and the one accepted require.main read is matched on its exact AST context, so any other comparison, assignment or call on it fails by name. THE BROWSER GRAPH is walked under the SAME allowlist and is transitive: ${formFiles} local scripts plus both forms' inline blocks and anything they import (${browserImports.length} local browser import(s) followed, ${browserFollowed} file(s) reached only that way), resolved with BROWSER semantics — so a bare specifier, a site-absolute path, an unresolvable local import, importScripts, new Worker/SharedWorker, a non-literal source and a require in browser code each FAIL BY NAME with file:line; browser loaders are decided by TOKEN INVENTORY rather than by any AST position — ${loaderTokenHits.length} token(s) named Worker/SharedWorker/importScripts anywhere in browser code, in any form (identifier, property, destructuring key, string, template chunk), so an aliased, member-qualified, string-keyed or destructured loader cannot hide where a call-shape or reference rule let it; ${dynamicSites.length} dynamic import(s) are accepted ONLY when the file's identifier-token count for the base equals one declaration plus its interpolations, that single non-interpolation token is the id of a const declarator holding an https literal, and the declaration structurally ENCLOSES every site using it — then PINNED by site+text+folded URL, so a new one fails even where the proof would accept it; and ${countByText(computedGlobalSites).length} pinned spelling(s) of an opaque key on a global are recorded by text rather than ignored`);

  /* 🔴 THE NUMBER IN THE LABEL MUST BE THE NUMBER ASSERTED. The loader-token counter is shared with the
     fixtures, and my first snapshot captured its length AFTER the walk, so the restore was a no-op: the
     assertion above passed at 0 (it runs before the fixtures) while the label printed 11. A count that is
     asserted early and printed late has to be re-checked late. */
  assert.deepStrictEqual(loaderTokenHits, [],
    `🔴 fixture loader tokens leaked into the real-forms counter (${JSON.stringify(loaderTokenHits)}) — the label would report a number nobody asserted`);

  FINISHED = true;
  console.log(`identity-public-contract: OK (${n})`);
})().catch((e) => { console.error('identity-public-contract FAILED:', (e && e.stack) || e); process.exit(1); });
