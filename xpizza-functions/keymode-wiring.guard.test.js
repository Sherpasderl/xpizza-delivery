'use strict';
// S0 key mode as data (PLAN-portal-item-edit r6) — the wiring guard. Run: node keymode-wiring.guard.test.js
//   1. tools/keymode-module-inverse.js returns each owned file to its BASE byte-for-byte; a byte inside a hunk, a
//      duplicated hunk and a byte outside every hunk are each caught; files older layers pin take same-line edits only.
//   2. The ONE surviving key-deciding brand literal is the frozen default; no item-key accessor carries one (relay inv. 2).
//   3. The three extras-MODEL literals (ruling R5) are exactly where they were — a known brand literal, not a key rule.
//   4. Every call of a key accessor / keyed consumer passes a mode, except an exact, named allowlist (ruling R3).
//   5. The served tables are built at exactly two sites, both through the hidden-mode attach (ruling R1).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parse } = require('acorn');
const { BASE, HUNKS, FILES, unapplyKeyModeModule } = require('./tools/keymode-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const peelTip = (f, s) => (f === 'index.js' ? require('./tools/tippref-inverse').unapplyTipprefIndex(s) : s);   /* DRYRUN R-WIRE (2e asm5): tip C's tippref layer is newer than this pin's base — peeled first */
const read = (f) => require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/pp-module-inverse').unapplyPpModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, peelTip(f, require('./tools/s1srv-module-inverse').unapplyS1srvModule(f, require('./tools/s2core-module-inverse').unapplyS2coreModule(f, require('./tools/grpid-module-inverse').unapplyGrpidModule(f, require('./tools/s3choice-module-inverse').unapplyS3choiceModule(f, require('./tools/d3live-module-inverse').unapplyD3liveModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8')))))))))))));   // S1a's newer layer is peeled first; F-1 (portal line, newer still — train asm4) before it

// ── 2 ──
const BRAND = /'la_musa'|'x_pizza'|"la_musa"|"x_pizza"/;
const parseFile = (f) => parse(read(f), { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
function visit(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach((x) => visit(x, fn)); else if (v && typeof v.type === 'string') visit(v, fn); }
}
function definitionText(f, name) {
  const src = read(f); let found = null;
  visit(parseFile(f), (nd) => {
    if (nd.type === 'FunctionDeclaration' && nd.id && nd.id.name === name) found = src.slice(nd.start, nd.end);
    if (nd.type === 'VariableDeclarator' && nd.id && nd.id.name === name && nd.init) found = src.slice(nd.start, nd.end);
  });
  assert.ok(found, `premise: ${f} defines ${name}`);
  return found;
}
const ACCESSORS = [['menu-pricing.js', 'itemPricingKey'], ['menu-pricing.js', 'extraPricingKey'], ['menu-pricing.js', 'availIdentityField'],
  ['menu-pricing.js', 'effectiveKeyMode'], ['catalog/form-menu-source.js', 'pricingKeyOf'], ['catalog/form-menu-source.js', 'extrasKeyOf'], ['catalog/identity-grace.js', 'rawLegacyKey']];
for (const [f, name] of ACCESSORS) assert.ok(!BRAND.test(definitionText(f, name)), `🔴 ${f}: ${name} carries a brand literal — a key must come from the mode`);
assert.strictEqual(definitionText('menu-pricing.js', 'defaultKeyMode'), "defaultKeyMode = (rid) => (rid === 'la_musa' ? 'id' : 'name')", 'the frozen default is today\'s rule, verbatim');
{
  let defs = 0;
  for (const f of ['menu-pricing.js', 'catalog/form-menu-source.js', 'catalog/identity-grace.js', 'catalog/source-store.js', 'factura/eligibility.js'])
    visit(parseFile(f), (nd) => { if ((nd.type === 'VariableDeclarator' || nd.type === 'FunctionDeclaration') && nd.id && nd.id.name === 'defaultKeyMode') defs += 1; });
  assert.strictEqual(defs, 1, 'one definition of the default, in menu-pricing.js');
}
ok('no item-key accessor carries a brand literal; the frozen default is the one rule, defined once');

// ── 3 ── (ruling R5: the extras CARDINALITY model, a known brand literal for a later «extras model as data» slice)
{
  const BYID = "const byId = restaurantId === 'la_musa';";
  assert.strictEqual(read('menu-pricing.js').split(BYID).length - 1, 2, 'menu-pricing.js keeps its two extras-model literals');
  assert.strictEqual(read('reorder-normalize.js').split(BYID).length - 1, 1, 'reorder-normalize.js keeps its extras-model literal');
  ok('the three extras-model literals are unchanged (R5)');
}

// ── 4 ──
const ARITY = { itemPricingKey: 3, extraPricingKey: 3, availIdentityField: 2, pricingKeyOf: 3, extrasKeyOf: 3, rawLegacyKey: 3,
  normalizeCartForFingerprint: 3, checkItemAvailability: 4, absentFromMenu: 4, dishQtyOf: 4 };
// EXACT, by name (R3): the identity world stays on the default until S1 (overlay, backfill, canonical binding); the
// legacy code-seeded brands' build rows and seed derive the default by design; a one-shot historical migration.
const ALLOWED = {
  'catalog/canonical-binding.js::normalizeCartForFingerprint': 1,
  'catalog/identity-backfill.js::itemPricingKey': 1,
  'catalog/identity-overlay.js::itemPricingKey': 1,
  'catalog/menu-structure-rows.js::extrasKeyOf': 1,
  'catalog/menu-structure-rows.js::pricingKeyOf': 1,
  'tools/migrations/gen-menu-structure-2026-10-26.js::extrasKeyOf': 1,
  'tools/migrations/gen-menu-structure-2026-10-26.js::pricingKeyOf': 5,
  'tools/seed-source-store.js::extrasKeyOf': 1,
  'tools/seed-source-store.js::pricingKeyOf': 1,
};
{
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(path.join(__dirname, d), { withFileTypes: true })) {
      const p = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!['node_modules', 'test', 'contract', '.git'].includes(e.name)) walk(p); }
      else if (/\.js$/.test(e.name) && !/\.test\.js$|-inverse\.js$|\.measure\.js$/.test(e.name)) files.push(p);
    }
  })('');
  const found = {};
  let calls = 0;
  for (const f of files) {
    let ast; try { ast = parseFile(f); } catch (e) { continue; }   // a non-script (e.g. an ES module fragment) carries no CommonJS call of these
    visit(ast, (nd) => {
      if (nd.type !== 'CallExpression') return;
      const c = nd.callee; const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null);
      if (name && ARITY[name]) { calls += 1; if (nd.arguments.length < ARITY[name]) found[`${f}::${name}`] = (found[`${f}::${name}`] || 0) + 1; }
      if (name === 'groupIssues' && nd.arguments[0] && nd.arguments[0].type === 'ObjectExpression') {
        calls += 1;
        if (!nd.arguments[0].properties.some((p) => p.key && p.key.name === 'keyMode')) found[`${f}::groupIssues`] = (found[`${f}::groupIssues`] || 0) + 1;
      }
    });
  }
  assert.ok(calls > 40, `premise: the walk sees the call sites (${calls})`);
  assert.deepStrictEqual(Object.keys(found).sort().reduce((o, k) => ({ ...o, [k]: found[k] }), {}), ALLOWED,
    '🔴 a key accessor or keyed consumer is called WITHOUT a mode outside the named allowlist');
  ok(`every keyed call passes a mode (${calls} calls) except the ${Object.keys(ALLOWED).length} named allowlist entries`);
}

// ── 5 ──
{
  const pt = read('catalog/pricing-tables.js');
  assert.strictEqual(pt.split('attachTablesKeyMode({ restaurantId, menu:').length - 1, 2, 'the served tables are built at two sites, both through the attach');
  assert.strictEqual(pt.replace(/attachTablesKeyMode\(\{ restaurantId, menu:/g, '').split('{ restaurantId, menu:').length - 1, 0, 'no served table is built without it');
  ok('the served tables are constructed at exactly two sites, both attaching the mode');
}

// ── 6 ── wiring the unit tests cannot reach (the request handlers, publish / rollback / backfill / CLI, the public menu); the
//        emulator matrix proves the behaviour, these pin the text so a removal fails here first
{
  const MUST = [
    ['index.js', 'const tokenEnforce = await tokenEnforceEnabled(db); if (!fiscalKeyModeOk(restaurantId, keyModeOfTables(pricingTables))) return pricingUnavailable(res);', 2, 'GUARD-FENCE both request heads'],
    ['index.js', 'resolveGraceKeys(getFirestore, restaurantId, body.items, { stamp: PRICING_KEY_STAMP, keyMode: keyModeOfTables(pricingTables) })', 2, 'GUARD-GRACE both handlers'],
    ['catalog/catalog-publish.js', 'structure: input && input.structure, key_mode: input && input.key_mode }), `${rid} (pre-publish)`', 1, 'GUARD-PUBLISH-VALIDATE'],
    ['catalog/catalog-publish.js', "source_sha: source_sha || 'unknown', created_at: FieldValue.serverTimestamp(), ...(key_mode == null ? {} : { key_mode }),", 1, 'GUARD-PUBLISH-RECORD'],
    ['catalog/catalog-publish.js', 'const snapshot = snapshotOf(rid, versionId, seq, menuTable, extraTable, input && input.key_mode);', 1, 'GUARD-PUBLISH-SNAPSHOT'],
    ['catalog/catalog-publish.js', '...(input && input.key_mode != null ? { keyMode: input.key_mode } : {}) });', 1, 'GUARD-PUBLISH-MIRROR'],
    ['catalog/catalog-publish.js', 'const snapshot = snapshotOf(rid, targetVersionId, seq, menuTable, extraTable, targetDocs.keyMode);', 1, 'GUARD-ROLLBACK-SNAPSHOT'],
    ['catalog/catalog-publish.js', '...(targetDocs.keyMode != null ? { keyMode: targetDocs.keyMode } : {}) });', 1, 'GUARD-ROLLBACK-MIRROR'],
    ['tools/backfill-snapshot.js', 'snapshotOf(rid, versionId, docs.seq, menuTable, extraTable, docs.keyMode)', 1, 'GUARD-BACKFILL-SNAPSHOT'],
    ['tools/backfill-snapshot.js', '...(docs.keyMode != null ? { keyMode: docs.keyMode } : {}) });', 1, 'GUARD-BACKFILL-MIRROR'],
    ['catalog/publish-edited-handler.js', '...(draftBuilt.key_mode == null ? {} : { key_mode: draftBuilt.key_mode }),', 1, 'GUARD-PORTAL-PUBLISH'],
    ['tools/publish-version.js', '...(built.key_mode == null ? {} : { key_mode: built.key_mode }) }, expected };', 1, 'GUARD-CLI-FROM-STORE'],
    ['catalog/public-menu.js', 'body.avail_identity = { field: availIdentityField(restaurantId, menu.keyMode) };', 1, 'GUARD-PUBLIC-MENU'],
    ['catalog/catalog-menu.js', "identity, ...require('./catalog-firestore').keyModeField(record.key_mode, where) };", 1, 'GUARD-VERSION-MENU'],
    ['catalog/edit-catalog-handler.js', 'let candidate = canonicalize(withServerKeyMode(source, keyModeOwn.key_mode));', 1, 'GUARD-PORTAL-SAVE'],
    ['catalog/reset-draft.js', "&& k !== 'key_mode') payload[k] = null;", 1, 'GUARD-RESET-KEEPS'],
    ['catalog/catalog-publish.js', 'structure: served.structure, key_mode: served.keyMode }),\n    `${rid}/versions/${versionId} (pre-flip)`', 1, 'GUARD-PREFLIP the persisted version is judged by its own mode (publish and rollback)'],
    ['reorder-normalize.js', 'const eid = extraPricingKey(ex, restaurantId, keyMode);', 1, 'GUARD-REORDER-EXTRAS id-model extras keyed by the mode'],
    ['reorder-normalize.js', 'const ename = extraPricingKey(ex, restaurantId, keyMode);', 1, 'GUARD-REORDER-EXTRAS name-model extras keyed by the mode'],
  ];
  for (const [f, text, count, label] of MUST) assert.strictEqual(read(f).split(text).length - 1, count, `🔴 ${label}: ${f} must carry the mode here (${count}×)`);
  ok(`${MUST.length} handler / publish / rollback / backfill / CLI / public-menu carries are in place`);
}

// The inverse round-trip runs LAST: a mutant in an owned file breaks it, so every named pin above must get its turn first.
// ── 1 ──
const pinnedElsewhere = new Set();
for (const t of fs.readdirSync(path.join(__dirname, 'tools')).filter((x) => /-inverse\.js$/.test(x) && x !== 'keymode-module-inverse.js' && x !== 'frozenkeys-module-inverse.js' && x !== 'reservedkeys-module-inverse.js' && x !== 's1d-module-inverse.js' && x !== 's2-module-inverse.js' && x !== 's2core-module-inverse.js' && x !== 'grpid-module-inverse.js' && x !== 's3choice-module-inverse.js')) {   // newer layers are not older pins
  const txt = fs.readFileSync(path.join(__dirname, 'tools', t), 'utf8');
  for (const f of FILES) if (txt.includes(`"${f}"`) || txt.includes(`'${f}'`)) pinnedElsewhere.add(f);
}
assert.ok(pinnedElsewhere.has('index.js') && pinnedElsewhere.has('menu-pricing.js'), 'premise: the older layers are found');
for (const f of FILES) {
  const src = read(f);
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyKeyModeModule(f, src), b, `🔴 ${f} minus the S0 key-mode hunks is not ${BASE}:${f}`);
  if (pinnedElsewhere.has(f)) assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f} is pinned by an older layer: same-line edits only`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyKeyModeModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyKeyModeModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyKeyModeModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyKeyModeModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte (${pinnedElsewhere.size} pinned by older layers: same-line only); inside / duplicate / outside caught (${HUNKS.length} hunks)`);

console.log(`\nkeymode-wiring.guard: OK (${n})`);
