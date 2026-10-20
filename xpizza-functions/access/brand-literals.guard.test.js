'use strict';
// OWNER RULE (brand-agnostic portal): the membership server (access/) and the team / invite UI never decide behaviour on a
// brand name. No 'x_pizza' / 'la_musa' / 'X. Pizza' / 'La Musa' literal in production sources (tests and the census-shaped
// fixtures may name them). The fiscal path keys on usesPlatformFactura (factura/eligibility.js), the one data flag.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const LIT = /x_pizza|la_musa|X\. ?Pizza|La Musa|xpizza|lamusa/i;
const files = [];
for (const f of fs.readdirSync(__dirname)) if (/\.js$/.test(f) && !/\.test\.js$|^_/.test(f)) files.push(path.join('xpizza-functions', 'access', f));
// the team / invite UI (portal): any team*, invite*, aceptar* source, now or later
const portal = path.join(ROOT, 'xpizza-portal');
if (fs.existsSync(portal)) for (const f of fs.readdirSync(portal)) if (/^(team|equipo|invite|aceptar)/i.test(f) && /\.(js|mjs|html)$/.test(f)) files.push(path.join('xpizza-portal', f));
const hits = [];
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  src.forEach((l, i) => { const code = l.replace(/\/\/.*$/, ''); if (LIT.test(code)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 100)}`); });
}
assert.ok(files.some((f) => f.endsWith('membership.js')) && files.some((f) => f.endsWith('roster.js')), 'non-vacuity: the access sources are scanned');
assert.deepStrictEqual(hits, [], `🔴 brand literals in brand-agnostic membership / team sources:\n  ${hits.join('\n  ')}`);
console.log(`brand-literals.guard: OK (${files.length} sources, no brand literal)`);
