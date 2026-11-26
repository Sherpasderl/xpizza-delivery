'use strict';
// PLAN-brand-agnostic-convergence §4 STEP 0 + §3-G — the brand-literal RATCHET, in the light chain.
//   R  the real tree has NO occurrence beyond the committed baseline (tools/brand-literal.baseline.json)
//   S  shrink-only: the working baseline never exceeds origin/main's (no key added, no count raised)
//   B  bypass cells: each planted form is caught — planted into a REAL shipped file and pushed through the SAME per-file path the
//      real check uses (rowsOfFile), then diffed against the real baseline. A planted literal that does not trip = a RED cell.
//   N  negative controls: a comment, a platform infra name, and an unchanged file add nothing (the guard is not trivially red)
//   P  (runs first) the rid-predicate scanner alone: a presence check (`rid !== ''`) is not a predicate
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('./brand-literal-guard');
const C = require('./brand-census');

const ROOT = path.join(__dirname, '..', '..');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// P  the rid-predicate scanner alone, BEFORE the tree scan (a real-tree line must not shadow it): the empty string names no
//    restaurant, so a presence check is not a predicate; a named literal still is (the control)
{
  const preds = (src) => G.predicatesIn(src, 'zz.js').out.map((o) => o.snippet);
  assert.deepStrictEqual(preds("function zzS(b) { return b.rid !== ''; }"), [], '🔴 false positive: a rid PRESENCE check (the empty string names no restaurant) is not a predicate');
  assert.deepStrictEqual(preds("function zzT(rid) { return rid === 'brand_c'; }"), ['brand_c'], '🔴 the scanner lost the named-literal predicate');
  ok('P a rid presence check (`!== \'\'`) adds no predicate; a named literal still does');
  // a const alias shadowed by a second binding of ANY pattern is ambiguous, never resolved (Codex #425); the control resolves
  assert.deepStrictEqual(preds("const zzV0R = 'brand_s'; function zzV0(rid) { return rid === zzV0R; }"), ['brand_s'], '🔴 the scanner lost the const-alias predicate');
  // names that exist on Object.prototype are ordinary names (Codex #426): resolved once, ambiguous when bound twice
  for (const nm of ['constructor', '__proto__', 'toString']) {
    assert.deepStrictEqual(preds(`const ${nm} = 'brand_ab'; function zzW(rid) { return rid === ${nm}; }`), ['brand_ab'], `🔴 a const alias named «${nm}» (an Object.prototype name) was not resolved`);
    assert.deepStrictEqual(preds(`const ${nm} = 'brand_ab'; function zzW(rid, ${nm}) { return rid === ${nm}; }`), [], `🔴 false positive: «${nm}» bound twice was resolved`);
  }
  ok('P const aliases named constructor / __proto__ / toString resolve once and are ambiguous when bound twice');
  for (const [label, src] of [
    ['a destructured param', "const zzV1R = 'brand_t'; function zzV1(rid, { zzV1R }) { return rid === zzV1R; }"],
    ['a param default', "const zzV2R = 'brand_u'; function zzV2(rid, zzV2R = '') { return rid === zzV2R; }"],
    ['a rest param', "const zzV3R = ['brand_v']; function zzV3(rid, ...zzV3R) { return zzV3R.includes(rid); }"],
    ['an array-destructured const', "const zzV4R = 'brand_w'; function zzV4(rid, a) { const [zzV4R] = a; return rid === zzV4R; }"],
    ['a catch binding', "const zzV5R = 'brand_x'; function zzV5(rid) { try { return 0; } catch (zzV5R) { return rid === zzV5R; } }"],
    ['a named function expression', "const zzV6R = 'brand_y'; const zzV6 = function zzV6R(rid) { return rid === zzV6R; };"],
    ['a destructured default + object rest', "const zzV7R = new Set(['brand_z']); function zzV7(rid, { a = 1, ...zzV7R }) { return zzV7R.has(rid); }"],
    ['a nested object/array pattern', "const zzV8R = { brand_aa: 1 }; function zzV8(rid, { p: [{ zzV8R }] }) { return zzV8R[rid]; }"],
  ]) {
    assert.deepStrictEqual(preds(src), [], `🔴 false positive: a const alias shadowed by ${label} was resolved`);
    ok(`P a const alias shadowed by ${label} is ambiguous → no predicate`);
  }
}

const rows = G.collect();
const base = G.readBaseline();
const vocab = JSON.parse(fs.readFileSync(path.join(__dirname, 'brand-vocabulary.json'), 'utf8'));
const match = C.matcher(vocab);

// R
{
  const { added } = G.diff(rows, base);
  assert.deepStrictEqual(added.map((a) => `${a.file}:${a.lines.join(',')} ${a.kind} ${a.brand} «${a.snippet}» ${a.count}>${a.allowed}`), [],
    '🔴 NEW brand-literal occurrence(s): make the difference portal-sourced data, never a new literal (run `node tools/brand-literal-guard.js` for the list)');
  ok(`R the tree is at or below the baseline (${G.tally(rows).size} keys / ${rows.length} occurrences; baseline ${base.size} keys)`);
}

// S
{
  let main = null;
  try { main = execFileSync('git', ['show', 'origin/main:xpizza-functions/tools/brand-literal.baseline.json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { main = null; }
  if (main === null) ok('S shrink-only vs origin/main: no baseline on origin/main yet (this commit INTRODUCES it) — checked from the next change on');
  else {
    const m = new Map(JSON.parse(main).entries.map((e) => [G.keyOf(e), e]));
    const grew = [...base.values()].filter((e) => !m.has(G.keyOf(e)) || e.count > m.get(G.keyOf(e)).count);
    assert.deepStrictEqual(grew.map((e) => `${e.file} ${e.kind} «${e.snippet}» ${e.count}`), [], '🔴 the baseline GREW vs origin/main — it only shrinks (--write); new debt is not baselined');
    ok(`S shrink-only: every baseline key/count ≤ origin/main's (${base.size} ≤ ${m.size} keys)`);
  }
  assert.ok([...base.values()].every((e) => e.file && e.snippet !== '' && e.snippet !== '*'), '🔴 a whole-file / wildcard baseline entry (no exemptions)');
}

// B + N: plant into a REAL shipped file; re-collect ONLY that file (same rowsOfFile path); diff the whole tree vs the baseline
const planted = (file, add, where = 'end') => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const mut = where === 'body' ? src.replace('</body>', `${add}\n</body>`) : where === 'json' ? src.replace('{', `{${add}, `) : `${src}\n${add}\n`;
  assert.notStrictEqual(mut, src, `cannot plant into ${file}`);
  const r = G.rowsOfFile(file, mut, match);
  const others = rows.filter((x) => x.file !== file);
  const fileRows = r.unscanned ? r.rows.concat([{ file, kind: 'unscanned', brand: '-', snippet: r.unscanned, line: 0 }]) : r.rows;
  return G.diff(others.concat(fileRows), base).added;
};
const JS = 'xpizza-functions/restaurant-config.js';
const HTML = 'xpizza-orders/index.html';
const JSON_F = 'xpizza-dispatch/manifest.json';
const CELLS = [
  ['plain rid', JS, "const zzA = 'x_pizza';", 'rid'],
  ['UPPER-case rid', JS, "const zzB = 'X_PIZZA';", 'rid'],
  ['hex escape', JS, "const zzC = '\\x78_pizza';", 'rid'],
  ['unicode escape', JS, "const zzD = '\\u006ca_musa';", 'rid'],
  ['concatenation', JS, "const zzE = 'x_' + 'pizza';", 'rid'],
  ['template', JS, "const zzF = `la_${'musa'}`;", 'rid'],
  ['const alias concat', JS, "const zzG1 = 'la_'; const zzG2 = zzG1 + 'musa';", 'rid'],
  ['rid as object key', JS, "const zzH = { la_musa: 1 };", 'rid'],
  ['brand name, spacing + case', JS, "const zzI = 'LA   MUSA';", 'name'],
  ['brand name, punctuation', JS, "const zzJ = 'X. Pizza';", 'name'],
  ['host → brand map', JS, "const zzK = { 'lamusakitchendisplay.netlify.app': 1 };", 'host'],
  ['ARBITRARY future rid ===', JS, "function zzL(restaurantId) { return restaurantId === 'brand_c'; }", 'rid-predicate'],
  ['ARBITRARY future rid !== on a member', JS, "function zzM(o) { return o.restaurant_id !== 'brand_d'; }", 'rid-predicate'],
  ['ARBITRARY future rid switch', JS, "function zzN(rid) { switch (rid) { case 'brand_e': return 1; } return 0; }", 'rid-predicate'],
  ['ARBITRARY future rid [list].includes', JS, "function zzO(rid) { return ['brand_f', 'brand_g'].includes(rid); }", 'rid-predicate'],
  // r9 B0 (#334-13): constant operands, aliases, and literal-set membership — a third restaurant through each form
  ['3rd rid, === a constant concatenation', JS, "function zzT1(rid) { return rid === 'brand_' + 'i'; }", 'rid-predicate'],
  ['3rd rid, === a same-file const alias', JS, "const zzT2R = 'brand_j'; function zzT2(rid) { return rid === zzT2R; }", 'rid-predicate'],
  ['3rd rid, switch on an aliased template', JS, "const zzT3R = `brand_${'k'}`; function zzT3(rid) { switch (rid) { case zzT3R: return 1; } return 0; }", 'rid-predicate'],
  ['3rd rid, new Set([..]).has(rid)', JS, "function zzT4(rid) { return new Set(['brand_l']).has(rid); }", 'rid-predicate'],
  ['3rd rid, an aliased Set .has(rid)', JS, "const zzT5S = new Set(['brand_m']); function zzT5(o) { return zzT5S.has(o.restaurant_id); }", 'rid-predicate'],
  ['3rd rid, an aliased array .includes(rid)', JS, "const zzT6L = ['brand_n']; function zzT6(rid) { return zzT6L.includes(rid); }", 'rid-predicate'],
  ['3rd rid, an object-key lookup ({..})[rid]', JS, "function zzT7(rid) { return ({ brand_o: true })[rid]; }", 'rid-predicate'],
  ['3rd rid, an aliased map lookup MAP[rid]', JS, "const zzT8M = { brand_p: 1 }; function zzT8(rid) { return zzT8M[rid]; }", 'rid-predicate'],
  ['3rd rid, rid in MAP', JS, "const zzT9M = { brand_q: 1 }; function zzT9(rid) { return rid in zzT9M; }", 'rid-predicate'],
  ['HTML text with an entity', HTML, '<p>La&#32;Musa</p>', 'name', 'body'],
  ['inline <script> concatenation', HTML, "<script>var zzP = 'la_m' + 'usa';</script>", 'rid', 'body'],
  ['inline on* handler predicate', HTML, `<button onclick="if (rid === 'brand_h') go()">x</button>`, 'rid-predicate', 'body'],
  ['a shipped JSON / manifest value', JSON_F, '"zz_label": "La Musa Cocina"', 'name', 'json'],
  ['a SECOND copy of an existing literal (count)', HTML, null, null],
  ['unparseable shipped JS (blind spot)', JS, 'const = ;', 'unscanned'],
];
for (const [label, file, add, kind, where] of CELLS) {
  if (add === null) {   // duplicate an occurrence the baseline already allows: the COUNT must trip
    const e = [...base.values()].find((x) => x.file === file && x.kind === 'name' && x.snippet.length > 3 && x.snippet.length < 40 && !/[<>&]/.test(x.snippet));
    assert.ok(e, `no baselined name in ${file} to duplicate`);
    const added = planted(file, `<p>${e.snippet}</p>`, 'body');
    assert.ok(added.some((a) => a.kind === e.kind && a.snippet === e.snippet && a.count > a.allowed), `🔴 BYPASS: ${label} («${e.snippet}») did not trip (${JSON.stringify(added.slice(0, 2))})`);
    ok(`B ${label}: «${e.snippet}» ×${e.count + 1} > baseline ${e.count} → RED`);
    continue;
  }
  const added = planted(file, add, where);
  assert.ok(added.some((a) => a.kind === kind), `🔴 BYPASS: «${label}» planted in ${file} was NOT caught (kind ${kind}; got ${JSON.stringify(added.map((a) => a.kind + ':' + a.snippet))})`);
  ok(`B ${label} → RED (${kind})`);
}
// N
for (const [label, file, add] of [
  ['a comment is never a token', JS, '// x_pizza La Musa lamusakitchendisplay.netlify.app'],
  ['a platform infra name (the Firebase project id), scoped by exact string', JS, "const zzQ = 'us-central1-xpizza-delivery';"],
  ['a rid compared with a VARIABLE (data-driven) is not a predicate', JS, 'function zzR(rid, cfg) { return rid === cfg.rid; }'],
  ['a lookup in a DATA map (a parameter) is not a predicate', JS, 'function zzU1(rid, cfg) { return cfg.byRid[rid] || (rid in cfg.byRid); }'],
  ['a `let` (reassignable) is not a constant alias', JS, "let zzU2R = 'brand_r'; function zzU2(rid) { return rid === zzU2R; }"],
  ['a name declared twice is not resolved as an alias', JS, "const zzU3R = 'brand_s'; function zzU3(rid, zzU3R) { return rid === zzU3R; }"],
]) {
  const added = planted(file, add);
  assert.deepStrictEqual(added.map((a) => a.kind + ':' + a.snippet), [], `🔴 false positive: ${label}`);
  ok(`N ${label} → no new occurrence`);
}
console.log(`\nbrand-literal.guard: OK (${n})`);
