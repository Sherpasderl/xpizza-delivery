// slice1-font-resolution.test.js — proves the card/body font resolves to the SELF-HOSTED Red Hat faces
// for EVERY used weight even though the Google Fonts <link> is still present (advisor ruling: the <link>
// stays in slice 1 so xpizza-driver/ remains byte-equal to the native www/ mirror; its removal + family
// rename is slice 5). Run: `node slice1-font-resolution.test.js` (ESM, no framework — repo idiom).
//
// MECHANISM (runtime-verified in Chrome against the real page, Google <link> present + online):
//   • Red Hat is aliased onto the OLD family names ('Plus Jakarta Sans', 'IBM Plex Mono'), declared in
//     the inline <style> AFTER the Google <link>, so local faces win the cascade.
//   • The DISPLAY range (501–900) and MONO range (300–900) win for their weights via range faces; PJS
//     300 wins because it is below Google's 400 floor.
//   • At the 400–500 pivot, Chrome prefers Google's covering-RANGE variable face over a local covering-
//     RANGE face (a later local range face still loses) — so PJS 400/500 need EXACT-weight local faces,
//     which DO win the cascade. Those two exact faces are the load-bearing pins proven here.
//   Measured on the real page: with Google present AND disabled, glyph metrics for all 12 used
//   (family,weight) pairs are identical → every used weight resolves to local Red Hat. The native
//   cold-offline launch is the release-time runtime corroboration; slice1-font-resolution.proof.sh is
//   the mutant (remove an exact face → this test goes RED).

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, 'index.html'), 'utf8');

// Weights the driver CSS actually uses (enumerated from index.html font-weight declarations; PJS 400 is
// the body default). PJS and Mono each resolve through the aliased faces.
const USED = {
  'Plus Jakarta Sans': [300, 400, 500, 501, 600, 700, 800, 900],
  'IBM Plex Mono': [400, 500, 700, 800],
};
// The weights the Google css2 sheet offers (so the ones that could otherwise win): PJS 400..800, Mono 400,500.
// Of those, the PJS 400–500 pivot is the only place a local RANGE face loses → must be pinned EXACT.
const EXACT_REQUIRED = { 'Plus Jakarta Sans': [400, 500] };

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

const GOOGLE_LINK_RE = /<link[^>]+href="https:\/\/fonts\.googleapis\.com\/css2\?([^"]+)"[^>]*rel="stylesheet"/;

let linkIdx = -1;
t('Google Fonts stylesheet <link> is present (slice-1 keep; byte-equal to native www/ mirror)', () => {
  const m = html.match(GOOGLE_LINK_RE);
  assert.ok(m, 'expected the Google Fonts css2 <link rel="stylesheet"> to be present in slice 1');
  linkIdx = m.index;
});

function parseFontFaces(src) {
  const faces = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[1];
    const fam = (body.match(/font-family:\s*['"]([^'"]+)['"]/) || [])[1];
    const url = (body.match(/src:\s*url\(\s*['"]?([^'")]+)/) || [])[1];
    const woff2 = /format\(\s*['"]?woff2/.test(body);
    const wm = body.match(/font-weight:\s*(\d+)(?:\s+(\d+))?/);
    const lo = wm ? Number(wm[1]) : 400;
    const hi = wm && wm[2] !== undefined ? Number(wm[2]) : lo;
    const exact = !(wm && wm[2] !== undefined);   // a single font-weight value, not a range
    faces.push({ fam, url, woff2, lo, hi, exact, idx: m.index });
  }
  return faces;
}

let faces = [];
t('all @font-face are self-hosted woff2 under fonts/ (local Red Hat), none remote, files present', () => {
  faces = parseFontFaces(html);
  assert.ok(faces.length >= 5, `expected the 3 range + 2 exact faces (>=5), found ${faces.length}`);
  for (const f of faces) {
    assert.ok(f.fam, '@font-face missing font-family');
    assert.ok(f.woff2, `${f.fam}: @font-face must declare format("woff2")`);
    assert.ok(/^fonts\/redhat.*\.woff2$/.test(f.url), `${f.fam}: src must be a local Red Hat woff2, got "${f.url}"`);
    assert.ok(!/^https?:/i.test(f.url) && !/gstatic|googleapis/.test(f.url), `${f.fam}: @font-face must not be remote`);
    assert.ok(existsSync(join(__dir, f.url)), `${f.fam}: referenced font file missing on disk: ${f.url}`);
    assert.ok(f.idx > linkIdx, `${f.fam} @${f.exact ? f.lo : f.lo + '-' + f.hi}: @font-face must come after the Google <link>`);
  }
});

t('local faces alias the OLD family names (Plus Jakarta Sans, IBM Plex Mono)', () => {
  const fams = new Set(faces.map((f) => f.fam));
  assert.ok(fams.has('Plus Jakarta Sans'), 'no local @font-face aliases "Plus Jakarta Sans"');
  assert.ok(fams.has('IBM Plex Mono'), 'no local @font-face aliases "IBM Plex Mono"');
});

// LOAD-BEARING: the exact-weight text pins. Removing either → PJS 400/500 fall back to Google online
// (the mutant in slice1-font-resolution.proof.sh). This is the assertion that makes that mutant RED.
t('EXACT-weight local faces pin PJS 400 and 500 to Red Hat (the online text-weight fix)', () => {
  for (const [fam, weights] of Object.entries(EXACT_REQUIRED)) {
    for (const w of weights) {
      const pin = faces.find((f) => f.fam === fam && f.exact && f.lo === w);
      assert.ok(pin, `missing EXACT-weight @font-face for ${fam} ${w} (a range face loses to Google at the 400–500 pivot)`);
      assert.ok(/redhattext/.test(pin.url), `${fam} ${w} exact face should use the Red Hat Text woff2, got "${pin.url}"`);
    }
  }
});

// NO GAP: every used weight has SOME local face that wins — an exact pin, or a range face that covers it
// (ranges win everywhere except the PJS 400–500 pivot handled by the exact pins above).
t('every used weight resolves to a local Red Hat face (exact pin or winning range) — no gap', () => {
  const gaps = [];
  for (const [fam, weights] of Object.entries(USED)) {
    const fam_faces = faces.filter((f) => f.fam === fam);
    for (const w of weights) {
      const exactPin = fam_faces.some((f) => f.exact && f.lo === w);
      const pivotNeedsExact = fam === 'Plus Jakarta Sans' && w >= 400 && w <= 500;
      const rangeWins = fam_faces.some((f) => !f.exact && w >= f.lo && w <= f.hi) && !pivotNeedsExact;
      if (!(exactPin || rangeWins)) gaps.push(`${fam}@${w}`);
    }
  }
  assert.deepEqual(gaps, [], `used weight(s) with no winning local face: ${gaps.join(', ')}`);
});

t('body font-family leads with the aliased family (body + card text resolve to the local face)', () => {
  const body = html.match(/\bbody\s*\{[^}]*\}/);
  assert.ok(body, 'no body {} rule found');
  assert.match(body[0], /font-family:\s*['"]Plus Jakarta Sans['"]/, 'body must lead with the aliased family');
});

console.log(`✓ slice1-font-resolution: ${passed} checks passed`);
