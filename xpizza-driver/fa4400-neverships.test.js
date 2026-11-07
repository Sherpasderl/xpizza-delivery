// NEVER-SHIP (static half): #FA4400 is the X. Pizza RESTAURANT identity colour. In the driver stylesheet it may
// appear ONLY on the .rchip.xp .rdot brand dots (class-driven restaurant identity). The one allowed exception is the
// baseline `--accent: #FA4400` custom-property declaration on :root (the Cuadra :root overrides it to azul-acero;
// the browser half, fa4400-render.browser.test.js, proves the WINNING --accent computes to steel).
//
// This half polices the BRAND orange specifically (rgb(250,68,0) in any syntax: #FA4400/#fa4400, 8-digit hex,
// rgb()/rgba(), hsl()/hsla()). It does NOT police the derived baseline slide hexes (#C2410C/#FF7438/#F23E00) — those
// live in frozen slice-1 regions, are overridden at render, and the owner ruled they stay; the browser half proves
// no slide renders orange. Scans EVERY <style> block AND every inline style= attribute, parses rules properly, and
// checks each selector in a comma group INDEPENDENTLY. Run: `node fa4400-neverships.test.js`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dir, 'index.html'), 'utf8');

const BRAND = [250, 68, 0];                 // #FA4400
const TOL = 3;                              // absorb hsl↔rgb rounding; tight enough to exclude the file's other warms

// ---- colour parsing: return [r,g,b] for a token, else null ----
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
}
function isBrand(rgb) { return rgb && BRAND.every((c, k) => Math.abs(rgb[k] - c) <= TOL); }

// every brand-orange colour token in `text`, each with its char offset
function brandHits(text) {
  const hits = [];
  let m;
  const hex = /#([0-9a-fA-F]{3,8})\b/g;
  while ((m = hex.exec(text))) {
    const h = m[1]; let rgb = null;
    if (h.length === 3) rgb = [...h].map((c) => parseInt(c + c, 16));
    else if (h.length === 4) rgb = [...h.slice(0, 3)].map((c) => parseInt(c + c, 16));
    else if (h.length === 6 || h.length === 8) rgb = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
    if (isBrand(rgb)) hits.push({ index: m.index, raw: m[0] });
  }
  const rgbRe = /rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/gi;
  while ((m = rgbRe.exec(text))) {
    if (isBrand([+m[1], +m[2], +m[3]].map(Math.round))) hits.push({ index: m.index, raw: m[0] });
  }
  const hslRe = /hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/gi;
  while ((m = hslRe.exec(text))) {
    if (isBrand(hslToRgb(+m[1], +m[2], +m[3]))) hits.push({ index: m.index, raw: m[0] });
  }
  return hits;
}

// ---- CSS rule parser: every style rule, descending into @media/@supports/@container ----
function walkRules(css) {
  const rules = [];
  const n = css.length;
  let i = 0;
  function block(cond) {
    while (i < n) {
      while (i < n && /\s/.test(css[i])) i++;
      if (i >= n || css[i] === '}') { i++; return; }
      const start = i;
      while (i < n && css[i] !== '{' && css[i] !== '}' && css[i] !== ';') i++;
      if (i >= n) break;
      if (css[i] === ';') { i++; continue; }            // @import / @charset — no block
      if (css[i] === '}') { i++; return; }
      const prelude = css.slice(start, i).replace(/\s+/g, ' ').trim();
      i++;                                              // consume '{'
      if (/^@(media|supports|container|document|layer)\b/i.test(prelude)) {
        block(true);                                    // conditional group — anything inside is conditional
      } else {
        const bstart = i; let depth = 1;
        while (i < n && depth > 0) { if (css[i] === '{') depth++; else if (css[i] === '}') { depth--; if (!depth) break; } i++; }
        rules.push({ sel: prelude, body: css.slice(bstart, i), conditional: cond });
        i++;                                            // consume matching '}'
      }
    }
  }
  block(false);
  return rules;
}

// split a selector list on TOP-LEVEL commas (ignore commas inside :is()/:not()/:where())
function selectors(list) {
  const out = []; let depth = 0, cur = '';
  for (const ch of list) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const isDot = (sel) => /\.rchip\.xp(?![\w-])/.test(sel) && /\.rdot\s*$/.test(sel);

// the declaration (`prop: value`) surrounding offset `o` in a rule body
function declAt(body, o) {
  const s = body.lastIndexOf(';', o - 1) + 1;
  let e = body.indexOf(';', o); if (e < 0) e = body.length;
  return body.slice(s, e).trim();
}

const STYLE_BLOCKS = [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ok -', name); }

t(`found ${STYLE_BLOCKS.length} <style> block(s) — scanning all of them`, () => {
  assert.ok(STYLE_BLOCKS.length >= 1, 'no <style> block found in index.html');
});

const isBaselineDecl = (decl) => /^--accent\s*:\s*#fa4400$/i.test(decl.replace(/\s+/g, ' ').trim());

t('every brand-orange rule targets ONLY .rchip.xp .rdot dots (per selector) — the SINGLE baseline --accent aside', () => {
  const violations = [];
  // flatten all rules across every <style> block in source order
  const rules = STYLE_BLOCKS.flatMap((raw) => walkRules(stripComments(raw)));
  // the one allowed exception is the baseline token: the FIRST top-level (non-@media) :root rule's `--accent: #FA4400`.
  // Any other brand-orange — a second --accent anywhere, one inside @media, a different :root block — is a violation.
  const baselineRule = rules.find((r) => r.sel === ':root' && !r.conditional && /--accent\s*:\s*#fa4400/i.test(r.body));   // the :root that HOLDS the baseline token (a --fb :root may precede it now)
  let baselineClaimed = false;
  for (const rule of rules) {
    {
      for (const hit of brandHits(rule.body)) {
        const decl = declAt(rule.body, hit.index);
        if (rule === baselineRule && !baselineClaimed && isBaselineDecl(decl)) { baselineClaimed = true; continue; }
        for (const sel of selectors(rule.sel)) {
          if (!isDot(sel)) violations.push(`brand-orange (${hit.raw}) in "${decl.slice(0, 50)}" via non-dot selector "${sel.slice(0, 60)}"`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `brand-orange leaked off the .rchip.xp .rdot dots:\n  ${violations.join('\n  ')}`);
});

t('no inline style= attribute carries the brand orange', () => {
  const violations = [];
  for (const m of HTML.matchAll(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const val = m[2] ?? m[3] ?? '';
    for (const hit of brandHits(val)) violations.push(`brand-orange (${hit.raw}) inline → "${val.slice(0, 70)}"`);
  }
  assert.deepEqual(violations, [], `brand-orange leaked into inline styles:\n  ${violations.join('\n  ')}`);
});

console.log(`✓ fa4400-neverships (static): ${passed} checks passed`);
