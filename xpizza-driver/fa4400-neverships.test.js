// NEVER-SHIP: #FA4400 is the X. Pizza RESTAURANT identity colour. It may appear in the driver UI ONLY on the
// .rchip.xp .rdot brand dots (data-driven restaurant identity) — never as chrome, and never on the slide-confirms.
// Two guards:
//   1. Every literal #FA4400 in the stylesheet heads a .rchip.xp .rdot rule (the one allowed exception is the
//      baseline --accent: token on :root, which the live Cuadra :root overrides to azul-acero anyway).
//   2. The WINNING :root --accent (last definition by source order) is the Cuadra azul-acero #2F5FB8 — so every
//      var(--accent) slide-confirm track renders steel-blue (the prototype .slide colour), never brand-orange.
// This is a RENDER-faithful pair: #1 keeps literal brand-orange off the chrome; #2 proves the token the slides
// read is steel. It does NOT police the dead baseline slide hexes (they are overridden at render by both the steel
// --accent and the SLICE1 `!important` translucent-white rules, and they live in frozen slice-1 regions).
// Run: `node fa4400-neverships.test.js`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
// strip CSS comments first (they mention #FA4400 descriptively); replace each with same-length spaces so byte
// offsets (and selectorOf) stay aligned with the live source.
const CSS = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1]
  .replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ok -', name); }

// the full comma-separated selector list that heads the rule containing position `i`
function selectorOf(i) {
  const open = CSS.lastIndexOf('{', i);
  const prevClose = CSS.lastIndexOf('}', open);
  const prevOpen = CSS.lastIndexOf('{', open - 1);
  const start = Math.max(prevClose, prevOpen) + 1;   // after the previous rule's boundary
  return CSS.slice(start, open).trim();
}

t('literal #FA4400 appears ONLY on .rchip.xp .rdot brand dots (+ the baseline --accent token)', () => {
  const violations = [];
  const re = /#FA4400/gi;
  let m;
  while ((m = re.exec(CSS))) {
    const i = m.index;
    // the --accent custom-property definition is the single allowed non-dot occurrence
    const lineStart = CSS.lastIndexOf('\n', i) + 1;
    const lineEnd = CSS.indexOf('\n', i);
    const line = CSS.slice(lineStart, lineEnd < 0 ? CSS.length : lineEnd);
    if (/--accent:\s*#FA4400/i.test(line)) continue;
    const sel = selectorOf(i);
    const okDot = /\.rchip\.xp\b/.test(sel) && /\.rdot\b/.test(sel);
    if (!okDot) violations.push(`#FA4400 in a non-brand-dot rule → "${sel.slice(0, 80)}"`);
  }
  assert.deepEqual(violations, [], `brand-orange leaked off the .rchip.xp .rdot dots:\n  ${violations.join('\n  ')}`);
});

t('the WINNING :root --accent is the Cuadra azul-acero #2F5FB8 — so slide tracks render steel, never brand-orange', () => {
  // every var(--accent) consumer (incl. .slide-confirm track at background:var(--accent)) resolves to the LAST
  // :root --accent by source order. Prove that winner is the steel, not the brand-orange.
  const defs = [...CSS.matchAll(/--accent:\s*(#[0-9A-Fa-f]{6})/g)].map((m) => m[1].toUpperCase());
  assert.ok(defs.length >= 1, 'no --accent definition found');
  assert.equal(defs[defs.length - 1], '#2F5FB8',
    `the winning --accent is ${defs[defs.length - 1]} (all defs: ${defs.join(', ')}) — slides would render that colour`);
});

console.log(`✓ fa4400-neverships: ${passed} checks passed`);
