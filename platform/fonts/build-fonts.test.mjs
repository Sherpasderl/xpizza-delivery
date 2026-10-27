// PLAN-forms-fonts-preconnect r6.1 §2.1 / §5 — the font pipeline's OFFLINE gate (build-fonts.mjs --check) and what it refuses.
// Light: no network, no browser. Each negative control runs the REAL check() against a temp copy of the tree with ONE defect.
// Run: node platform/fonts/build-fonts.test.mjs
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, plan, loadManifest, parseBaseline } from './build-fonts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const man = loadManifest();

// the real tree passes
assert.deepEqual(check(man), [], 'the committed tree passes --check');
ok('the committed tree passes: pinned files, css, OFL and site identity');

// the rendered css keeps Google's DISCRETE descriptors (plan §0: the forms request 450/550/650/750 — a range would re-typeface)
const p = plan('orders-form', man);
const baseline = parseBaseline(readFileSync(join(HERE, 'baseline', 'orders-form.google.css'), 'utf8'));
const prim = [...p.css.matchAll(/@font-face\{font-family:'(DM Sans|Playfair Display)';[^}]*\}/g)].map((m) => m[0]);
assert.equal(prim.length, baseline.length, 'one primary face per baseline block');
for (const f of prim) {
  assert.match(f, /font-weight:\d{3};/, `🔴 a primary face with a weight RANGE: ${f.slice(0, 90)}`);
  assert.match(f, /font-display:optional;/);
}
const weightsOf = (fam, sub) => baseline.filter((b) => b.family === fam && b.subset === sub).map((b) => b.weight);
assert.deepEqual(weightsOf('DM Sans', 'latin'), ['300', '400', '500', '600', '700', '800']);
assert.deepEqual(weightsOf('Playfair Display', 'latin'), ['600', '700', '900']);
assert.doesNotMatch(p.css, /Special Elite|fonts\.(googleapis|gstatic)\.com|font-display:\s*(swap|fallback|block|auto)/);
for (const fb of p.css.match(/@font-face\{font-family:'[^']+ Fallback[^']*';[^}]*\}/g)) for (const d of ['size-adjust', 'ascent-override', 'descent-override', 'line-gap-override']) assert.match(fb, new RegExp(`${d}:[\\d.]+%`), fb);
assert.deepEqual(p.preload, ['dm-sans-latin.', 'playfair-display-latin.'].map((pre) => `fonts/${[...p.files.keys()].find((k) => k.startsWith(pre))}`), 'preload = the census-decided critical set: DM Sans latin + Playfair latin (latin subsets only)');
ok(`${prim.length} primary faces carry Google's discrete weights (DM Sans 300…800, Playfair 600/700/900 per subset), optional only, no Special Elite / Google host; every fallback is metric-matched`);

// each name carries its own bytes' hash and equals the pin
for (const [name, pin] of p.files) assert.equal(name.split('.').slice(-2, -1)[0], pin.sha256.slice(0, 10));
ok('every hosted file name carries the first 10 hex of its pinned sha256');

// NEGATIVE CONTROLS — each ONE defect, in a temp copy, must be named by check()
function withCopy(mutate, expect, label) {
  const tmp = mkdtempSync(join(tmpdir(), 'fonts-'));
  try {
    for (const site of p.sites) cpSync(join(ROOT, site, 'fonts'), join(tmp, site, 'fonts'), { recursive: true }), cpSync(join(ROOT, site, p.cssName), join(tmp, site, p.cssName));
    const fdir = join(tmp, 'platform-fonts'); cpSync(HERE, fdir, { recursive: true });
    mutate(tmp, fdir);
    const got = check(loadManifest(fdir), tmp, fdir);
    assert.ok(got.some((x) => expect.test(x)), `🔴 ${label} was NOT caught (${JSON.stringify(got)})`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
const site0 = p.sites[0], aFile = [...p.files.keys()][0];
withCopy((t) => { const f = join(t, site0, 'fonts', aFile); const b = readFileSync(f); b[b.length - 1] ^= 1; writeFileSync(f, b); }, /bytes differ from the pin/, 'a flipped byte in a hosted file');
withCopy((t) => unlinkSync(join(t, site0, 'fonts', aFile)), /is missing/, 'a missing hosted file');
withCopy((t) => writeFileSync(join(t, site0, 'fonts', 'stray.0000000000.woff2'), 'x'), /orphan/, 'an orphan woff2');
withCopy((t) => writeFileSync(join(t, site0, p.cssName), readFileSync(join(t, site0, p.cssName), 'utf8').replace('font-display:optional', 'font-display:swap')), /differs from what --write produces/, 'a hand-edited css (swap)');
withCopy((t) => writeFileSync(join(t, p.sites[1], 'fonts', 'OFL.txt'), 'nope'), /OFL\.txt differs/, 'a wrong OFL');
withCopy((t, f) => writeFileSync(join(f, 'baseline', 'orders-form.google.css'), readFileSync(join(f, 'baseline', 'orders-form.google.css'), 'utf8').replace('font-weight: 600;', 'font-weight: 400 700;')), /differ from the pin/, 'a baseline css edited after pinning (a range smuggled in)');
withCopy((t, f) => { const m = JSON.parse(readFileSync(join(f, 'fonts.manifest.json'), 'utf8')); delete m.surfaces['orders-form'].metrics; writeFileSync(join(f, 'fonts.manifest.json'), JSON.stringify(m)); }, /no derived fallback metrics/, 'missing fallback metrics');
ok('negative controls: a flipped byte, a missing file, an orphan, a hand-edited css, a wrong OFL, a re-edited baseline and missing metrics are each refused');

console.log(`\nbuild-fonts: OK (${n})`);
