'use strict';
// owner GO 11-18 («airtight» BY CONSTRUCTION, after Codex #150 / #156 found census bypasses): the reusable card token is NOT on the payment
// record any more — it lives at payment_sdk_tokens/{oid}/{attempt_id}, server-only, and ONE module names that path. This guard pins the
// construction instead of chasing readers:
//   RT-PATH      over EVERY tracked non-test JS file (AST, comments excluded): a string / template literal — or a `+` / template join of
//                literal pieces — whose static text contains `sdk_tokens` appears ONLY in record-token.js, the owner's migration tool and
//                the rules clause list;
//   RT-POINTER   the record's pointer key `token_attempt` is touched ONLY in record-token.js (and the migration tool);
//   RT-OWNER     the owner's exports are exactly the reviewed surface;
//   RT-RULES     the canonical rules deny payment_sdk_tokens for every client (and the server-only clause list names it);
//   RT-NEG-*     planted bypasses (a new file, a concatenation, a template, the pointer elsewhere) are each caught.
// Run: node payments/sdk/record-token.guard.test.js
const assert = require('assert');
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const acorn = require('acorn');
const FN = path.join(__dirname, '..', '..');
let pass = 0; const fails = [];
const cell = (L, fn) => { try { fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const OWNER = 'payments/sdk/record-token.js';
const MIGRATION = 'tools/migrate-sdk-tokens.js';
const PATH_ALLOWED = [OWNER, 'payments/sdk/rules-clauses.js'];   // payment_sdk_tokens, its cursor and payment_sdk_token_refs   // Codex #158: the migration writes through record-token.stashToken
const POINTER_ALLOWED = [OWNER, MIGRATION];
const FILES = execFileSync('git', ['ls-files', '*.js', ':!*.test.js', ':!test/**', ':!**/node_modules/**'], { cwd: FN, encoding: 'utf8' }).split('\n').filter(Boolean);
const real = (f) => fs.readFileSync(path.join(FN, f), 'utf8');
function parse(src) {
  const o = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true };
  try { return acorn.parse(src, { ...o, sourceType: 'script' }); } catch (_) { return acorn.parse(src, { ...o, sourceType: 'module' }); }
}
// the static text of a literal, a template (its quasis + any literal expressions) or a `+` chain of those (non-literal parts drop out)
function staticText(n) {
  if (!n) return '';
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis.map((q, i) => q.value.cooked + (n.expressions[i] ? staticText(n.expressions[i]) : '')).join('');
  if (n.type === 'BinaryExpression' && n.operator === '+') return staticText(n.left) + staticText(n.right);
  return '';
}
function scan(files, read) {
  const pathSites = new Set(); const pointerSites = new Set(); const queueSites = new Set();
  for (const f of files) {
    const ast = parse(read(f));
    const walk = (n, parent) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach((x) => walk(x, parent)); return; }
      if (typeof n.type !== 'string') return;
      // the outermost string-building expression only (a `+` chain's parts are not re-counted)
      const building = (x) => x && (x.type === 'Literal' || x.type === 'TemplateLiteral' || (x.type === 'BinaryExpression' && x.operator === '+'));
      if (building(n) && !(parent && parent.type === 'BinaryExpression' && parent.operator === '+' && building(parent)) && /payment_sdk_token/.test(staticText(n))) pathSites.add(f);
      // card-cleanup: the provider-delete queue has ONE owner too
      if (building(n) && !(parent && parent.type === 'BinaryExpression' && parent.operator === '+' && building(parent)) && /provider_token_deletes/.test(staticText(n))) queueSites.add(f);
      if (n.type === 'Identifier' && n.name === 'token_attempt') pointerSites.add(f);
      // Codex #158 r1 F4: the pointer key by static evaluation — a literal, a template or a `+` join of literal pieces
      if (building(n) && !(parent && parent.type === 'BinaryExpression' && parent.operator === '+' && building(parent)) && /token_attempt/.test(staticText(n))) pointerSites.add(f);
      for (const [k, v] of Object.entries(n)) if (k !== 'start' && k !== 'end') walk(v, n);
    };
    walk(ast, null);
  }
  return { path: [...pathSites].sort(), pointer: [...pointerSites].sort(), queue: [...queueSites].sort() };
}
const S = scan(FILES, real);

cell('RT-PATH', (L) => assert.deepStrictEqual(S.path, [...PATH_ALLOWED].sort(), `${L}: payment_sdk_tokens is named ONLY by record-token.js and the rules clause list`));
cell('RT-QUEUE', (L) => assert.deepStrictEqual(S.queue, ['payments/sdk/rules-clauses.js', 'payments/sdk/token-queue.js'], `${L}: provider_token_deletes is named ONLY by token-queue.js and the rules clause list (producers ride its enqueueEntries)`));
// the vendored SDK fixture is TEST-ONLY: over EVERY tracked JS / MJS file (tests included), only the equality cell names it
cell('RT-FIXTURE', (L) => {
  const all = execFileSync('git', ['ls-files', '*.js', '*.mjs', ':!test/fixtures/pixelpay-sdk-2.5.2/**'], { cwd: FN, encoding: 'utf8' }).split('\n').filter(Boolean);
  // a file LOADS the fixture only through a string naming its path (require / import / readFile / path.join) — comments do not count
  const names = (f) => {
    let ast; try { ast = parse(fs.readFileSync(path.join(FN, f), 'utf8')); } catch (_) { return true; }   // unparseable ⇒ counted (never silently passed)
    let hit = false;
    const walk = (n) => { if (hit || !n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(walk); return; } if (typeof n.type !== 'string') return;
      if ((n.type === 'Literal' && typeof n.value === 'string' && n.value.includes('pixelpay-sdk-2.5.2')) || (n.type === 'TemplateElement' && String(n.value.cooked).includes('pixelpay-sdk-2.5.2'))) { hit = true; return; }
      for (const [k, v] of Object.entries(n)) if (k !== 'start' && k !== 'end') walk(v); };
    walk(ast); return hit;
  };
  const users = all.filter(names);
  assert.deepStrictEqual(users, ['payments/sdk/provider-delete-request.test.js', 'payments/sdk/record-token.guard.test.js'], `${L}: the vendored SDK fixture is named ONLY by the equality cell (and this guard's own exclusion) — never by runtime code (${users.join(', ')})`);
  const planted = (() => { const t = 'z-runtime.js'; const src = "module.exports = require('../test/fixtures/pixelpay-sdk-2.5.2/lib/models/Settings.js');"; let ast = parse(src); let hit = false; const w = (n) => { if (hit || !n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(w); return; } if (n.type === 'Literal' && typeof n.value === 'string' && n.value.includes('pixelpay-sdk-2.5.2')) { hit = true; return; } for (const v of Object.values(n)) w(v); }; w(ast); return hit && t; })();
  assert.ok(planted, `${L}: control — a runtime require of the fixture would be caught`);
});
cell('RT-POINTER', (L) => assert.deepStrictEqual(S.pointer, [...POINTER_ALLOWED].sort(), `${L}: the record's token pointer is touched ONLY by record-token.js and the migration tool`));
cell('RT-OWNER', (L) => {
  const ex = Object.keys(require(path.join(FN, OWNER))).sort();
  assert.deepStrictEqual(ex, ['claimFor', 'dropPointer', 'enqueueAndDrop', 'hasLiveRefs', 'hasToken', 'hasTokens', 'pageTokenOrders', 'readAttemptToken', 'readToken', 'stashToken'], `${L}: the owner's exports are exactly the reviewed surface`);
  assert.ok(FILES.length > 500 && FILES.includes('index.js') && FILES.includes(OWNER), `${L}: premise — the scan spans the whole tree (${FILES.length} files)`);
});
cell('RT-RULES', (L) => {
  const rules = JSON.parse(fs.readFileSync(path.join(FN, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
  assert.deepStrictEqual(rules.payment_sdk_tokens, { '.read': false, '.write': false }, `${L}: the canonical rules deny payment_sdk_tokens to every client`);
  assert.deepStrictEqual(rules.payment_sdk_tokens_cursor, { '.read': false, '.write': false }, `${L}: the orphan-sweep cursor is server-only too`);
  assert.ok(rules['.read'] === undefined && rules['.write'] === undefined && !Object.keys(rules).some((k) => k.startsWith('$')), `${L}: no root grant or root wildcard re-opens it`);
  assert.ok(require(path.join(FN, 'payments/sdk/rules-clauses')).D4_SERVER_ONLY.includes('payment_sdk_tokens') && require(path.join(FN, 'payments/sdk/rules-clauses')).D4_SERVER_ONLY.includes('payment_sdk_tokens_cursor'), `${L}: the server-only clause list names it (sdk-pay-rules.guard + the emulator deny cells)`);
});
// ── negatives: each planted bypass must surface ──
const plant = (extra) => (f) => (extra[f] !== undefined ? extra[f] : real(f));
const withFile = (f, src) => scan([...FILES, f], plant({ [f]: src }));
cell('RT-NEG-NEW-FILE', (L) => assert.ok(withFile('z-new-reader.js', "const z = (db, id) => db.ref(`payment_sdk_tokens/${id}`).once('value');\nmodule.exports = { z };\n").path.includes('z-new-reader.js'), `${L}: a NEW file naming the path is caught`));
cell('RT-NEG-CONCAT', (L) => {
  assert.ok(withFile('z-concat.js', "const z = (db, id) => db.ref('payment_sdk' + '_tokens/' + id).once('value');\n").path.includes('z-concat.js'), `${L}: a + concatenation of literal pieces is caught`);
  assert.ok(withFile('z-tpl.js', "const P = 'payment_sdk'; const z = (db, id) => db.ref(`${'payment_sdk'}_tokens/${id}`);\n").path.includes('z-tpl.js'), `${L}: a template joining literal pieces is caught`);
});
cell('RT-NEG-EXISTING-FILE', (L) => {
  const f = 'payments/sdk/coordinator.js';
  assert.ok(scan(FILES, plant({ [f]: `${real(f)}\nconst zz = (db, id) => db.ref(\`payment_sdk_tokens/\${id}\`).remove();\n` })).path.includes(f), `${L}: the path planted in the coordinator is caught`);
});
cell('RT-NEG-POINTER', (L) => {
  const f = 'payments/sdk/cards.js';
  assert.ok(scan(FILES, plant({ [f]: `${real(f)}\nconst zp = (rec) => rec.token_attempt;\n` })).pointer.includes(f), `${L}: the pointer read outside the owner is caught`);
  assert.ok(scan(FILES, plant({ [f]: `${real(f)}\nconst zq = (rec) => rec['token_attempt'];\n` })).pointer.includes(f), `${L}: a computed pointer read is caught`);
  assert.ok(scan(FILES, plant({ [f]: `${real(f)}\nconst zt = (rec) => rec[\`token_attempt\`];\n` })).pointer.includes(f), `${L}: a template-key pointer read is caught (Codex #158 F4)`);
  assert.ok(scan(FILES, plant({ [f]: `${real(f)}\nconst zc = (rec) => rec['token_' + 'attempt'];\n` })).pointer.includes(f), `${L}: a concatenated pointer key is caught (Codex #158 F4)`);
});
console.log(fails.length ? `\nrecord-token.guard: FAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nrecord-token.guard: OK (${pass})`);
process.exit(fails.length ? 1 : 0);
