'use strict';
// PLAN 4 (bake from published) r3 §1 — THE RUNTIME-LITERAL GUARD. Every form boots its menu structures from the bundle the
// build BAKES from the published catalog; the literal declarations that remain in each form are the in-repo seed / test
// bootstrap only (the catalog readers read them by name — readLiteral's FALLBACK_ alias). So each such name may occur in a
// form's code EXACTLY ONCE — its own declaration — and nowhere else. Tokenized with acorn per inline script, so a comment or a
// string that mentions a name is not a use, and a real use cannot hide in one.
// PLAN 4 GATED (after the §8.2 migration was published and verified): TAG_PRIORITY joins the seed-only names, and the reward
// icon maps and the Nutella name check are gone from both runtimes (asserted below).
// Run: node form-runtime-literals.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { tokenizer } = require('acorn');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const SEED_ONLY = {
  'xpizza-orders': ['FALLBACK_MENU', 'FALLBACK_EXTRAS', 'FALLBACK_PICKUP_ONLY', 'FALLBACK_WEEKEND_ONLY'],
  'la-musa-orders': ['FALLBACK_MENU', 'FALLBACK_CATEGORIES', 'FALLBACK_VARIANT_ITEMS', 'FALLBACK_HAS_PHOTO', 'FALLBACK_EXTRAS',
    'FALLBACK_EXTRAS_BY_CATEGORY', 'FALLBACK_EXTRAS_BY_ITEM', 'FALLBACK_TAG_BADGES', 'FALLBACK_TAG_PRIORITY'],
};
const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// identifier tokens per name (a regex literal or template is tokenized correctly by acorn, so nothing is mis-split)
function identifierCounts(code) {
  const counts = new Map();
  for (const t of tokenizer(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true })) {
    if (t.type.label === 'name') counts.set(t.value, (counts.get(t.value) || 0) + 1);
  }
  return counts;
}
function usesOutsideDeclaration(html, names) {
  const total = new Map(); let declared = new Map();
  for (const code of inlineScripts(html)) {
    for (const [k, v] of identifierCounts(code)) total.set(k, (total.get(k) || 0) + v);
    for (const nm of names) if (new RegExp(`(^|\\n)\\s*const ${nm} = `).test(code)) declared.set(nm, (declared.get(nm) || 0) + 1);
  }
  return names.map((nm) => ({ name: nm, tokens: total.get(nm) || 0, declarations: declared.get(nm) || 0 }));
}

const REPO = path.join(__dirname, '..');
for (const [dir, names] of Object.entries(SEED_ONLY)) {
  const html = fs.readFileSync(path.join(REPO, dir, 'index.html'), 'utf8');
  for (const r of usesOutsideDeclaration(html, names)) {
    assert.strictEqual(r.declarations, 1, `${dir}: ${r.name} must still be DECLARED once (the seed / test bootstrap reads it by name)`);
    assert.strictEqual(r.tokens, 1, `🔴 ${dir}: ${r.name} is referenced ${r.tokens - 1} time(s) outside its declaration — a runtime path fell back to a literal`);
  }
  ok(`${dir}: ${names.length} seed-only literals (${names.join(', ')}) are each declared once and referenced NOWHERE at runtime`);
}
// sensitivity: a planted runtime use, and a use hidden next to a comment / string mention, are caught; a mention is not a use
{
  const html = fs.readFileSync(path.join(REPO, 'xpizza-orders', 'index.html'), 'utf8');
  const planted = html.replace("let EXTRAS = _bootSelect('extras', _okRecords, [], true);", "let EXTRAS = _bootSelect('extras', _okRecords, FALLBACK_EXTRAS, true);");
  assert.notStrictEqual(planted, html, 'premise: the plant applies');
  assert.strictEqual(usesOutsideDeclaration(planted, ['FALLBACK_EXTRAS'])[0].tokens, 2, 'a planted fallback is a second token');
  const mention = html.replace("let EXTRAS = _bootSelect(", "/* FALLBACK_EXTRAS */ const _m = 'FALLBACK_EXTRAS'; // FALLBACK_EXTRAS\nlet EXTRAS = _bootSelect(");
  assert.strictEqual(usesOutsideDeclaration(mention, ['FALLBACK_EXTRAS'])[0].tokens, 1, 'a comment or string mention is not a use');
  ok('sensitivity: a planted runtime fallback is caught; comment and string mentions are not uses');
}
// ── GATED: no literal reward-icon map, no literal priority, no name-keyed "no options" ──
{
  const code = (dir) => inlineScripts(fs.readFileSync(path.join(REPO, dir, 'index.html'), 'utf8')).join('\n');
  const xp = code('xpizza-orders'), lm = code('la-musa-orders');
  const redeem = (src) => src.slice(src.indexOf('function buildRedeemCatalog(){'), src.indexOf('\n}\n', src.indexOf('function buildRedeemCatalog(){')));
  assert.ok(redeem(xp).length > 50 && redeem(lm).length > 50, 'premise: both reward catalogs found');
  assert.ok(!/const ICON\s*=/.test(redeem(xp)) && /icon:p\.reward_icon\|\|'star'/.test(redeem(xp)), '🔴 x_pizza: the reward icon is the published field (no name-keyed map)');
  assert.ok(!/\[\s*'[^']*'\s*,\s*'[a-z_]+'\s*\]/.test(redeem(lm).match(/const CAT=\{[^}]*\}/)[0]), '🔴 la_musa: CAT carries sections only, no icons');
  assert.ok(/icon:p\.reward_icon\|\|'star'/.test(redeem(lm)) && /icon:e\.reward_icon\|\|'star'/.test(redeem(lm)) && !/icon:'rice'/.test(redeem(lm)), '🔴 la_musa: dish and extra icons are the published field');
  assert.ok(!/===\s*'Nutella'|'Nutella'\s*===/.test(xp), '🔴 x_pizza: "no options" is the published extras_policy, never a name check');
  assert.ok(!/\bTAG_PRIORITY\b/.test(lm.replace(/FALLBACK_TAG_PRIORITY/g, '')), '🔴 la_musa: no runtime TAG_PRIORITY (BADGE_PRIORITY is the published order)');
  ok('GATED: the brand-neutral default reward icon is \'star\' in both forms (advisor ruling); no reward-icon literal map (x_pizza ICON, la_musa CAT icons / \'rice\'), no runtime TAG_PRIORITY, no Nutella name check');
}
console.log(`\nform-runtime-literals.guard: OK (${n})`);
