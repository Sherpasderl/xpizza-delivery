#!/usr/bin/env node
// ── PLAN-forms-fonts-preconnect r6.1 §2.1 — THE ONE FONT PIPELINE (self-hosted, content-hashed, font-display:optional) ─────
// One tool for every webfont surface (fonts.manifest.json). The primary faces are NOT authored here: their families, weights,
// styles, unicode-ranges and files come VERBATIM from the surface's PINNED Google baseline (baseline/<surface>.google.css +
// .pin.json: the exact UA, the versioned source URLs, full sha256 + byte length). The forms request weights between the declared
// ones (450 / 550 / 650 / 750), so the discrete per-weight descriptors are kept exactly as Google declares them — a range
// descriptor would render those weights differently (a re-typeface by stealth; plan §0).
//
//   node platform/fonts/build-fonts.mjs --fetch <surface>   NETWORK: fetch the CSS with the pinned UA → must equal the committed
//                                                           baseline byte-for-byte; download every pinned file → must match its
//                                                           sha256 + length; write each into every site's fonts/ (hashed name)
//   node platform/fonts/build-fonts.mjs --write <surface>   OFFLINE: verify the site files against the pins, then (re)write the
//                                                           surface css + fonts/OFL.txt in every site, removing orphan woff2
//   node platform/fonts/build-fonts.mjs --check             OFFLINE (the npm chain): every surface's sites carry exactly the pinned
//                                                           files, the css and OFL equal what --write would produce, and every
//                                                           site of a surface is byte-identical. Any difference fails (exit 1).
// The files are served UNMODIFIED (Playfair Display has a Reserved Font Name: a modified version may not carry it — the pins
// make modification impossible). Fallback overrides are derived by metrics.py and only rendered here.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { const e = new Error(m); e.fontsFail = true; throw e; };

export function loadManifest(dir = HERE) { return JSON.parse(readFileSync(join(dir, 'fonts.manifest.json'), 'utf8')); }

export function loadBaseline(surface, man, dir = HERE) {
  const s = man.surfaces[surface]; if (!s) fail(`unknown surface ${surface}`);
  const pin = JSON.parse(readFileSync(join(dir, `${s.baseline}.pin.json`), 'utf8'));
  const css = readFileSync(join(dir, s.baseline, '..', pin.css.file));
  if (sha(css) !== pin.css.sha256 || css.length !== pin.css.bytes) fail(`${pin.css.file}: bytes differ from the pin (a font update is a deliberate re-pin)`);
  return { pin, css: css.toString('utf8') };
}

// The baseline's @font-face blocks, in order: { subset, family, style, weight, url, unicodeRange }.
export function parseBaseline(cssText) {
  const out = [];
  for (const m of cssText.matchAll(/\/\* ([a-z-]+) \*\/\s*@font-face \{([^}]*)\}/g)) {
    const b = m[2];
    const get = (re) => { const x = b.match(re); if (!x) fail(`baseline block without ${re}`); return x[1].trim(); };
    out.push({ subset: m[1], family: get(/font-family: '([^']+)'/), style: get(/font-style: ([a-z]+)/), weight: get(/font-weight: ([0-9 ]+);/),
      url: get(/src: url\(([^)]+)\)/), unicodeRange: get(/unicode-range: ([^;]+);/) });
  }
  if (!out.length) fail('the baseline css has no @font-face blocks');
  return out;
}

const fileFor = (s, face, pinFile) => `${s.families[face.family].slug}-${face.subset}.${pinFile.sha256.slice(0, 10)}.woff2`;

// Everything --write would produce for a surface: { files: name→pin, css, ofl, faces, preload }.
export function plan(surface, man = loadManifest(), dir = HERE) {
  const s = man.surfaces[surface];
  const { pin, css } = loadBaseline(surface, man, dir);
  const byUrl = new Map(pin.files.map((f) => [f.url, f]));
  const faces = parseBaseline(css).map((f) => {
    if (!s.families[f.family]) fail(`${surface}: the baseline names ${f.family}, which the manifest does not host`);
    const p = byUrl.get(f.url); if (!p) fail(`${surface}: ${f.url} is in the baseline css but not pinned`);
    return { ...f, file: fileFor(s, f, p), pin: p };
  });
  const files = new Map(faces.map((f) => [f.file, f.pin]));
  if (!s.metrics) fail(`${surface}: no derived fallback metrics — run python3 -P platform/fonts/metrics.py --derive ${surface}`);
  const primary = faces.map((f) => `@font-face{font-family:'${f.family}';font-style:${f.style};font-weight:${f.weight};font-display:optional;`
    + `src:url(fonts/${f.file}) format('woff2');unicode-range:${f.unicodeRange}}`);
  const fallback = [];
  for (const [family, fam] of Object.entries(s.families)) {
    for (const fb of fam.fallbacks) {
      const m = s.metrics[`${fb.name}|${fb.weights}`]; if (!m) fail(`${surface}: no metrics for ${fb.name} ${fb.weights}`);
      const o = m.overrides;
      fallback.push(`@font-face{font-family:'${fb.name}';font-weight:${fb.weights};src:${fb.local.map((l) => `local('${l}')`).join(',')};`
        + `size-adjust:${o['size-adjust']};ascent-override:${o['ascent-override']};descent-override:${o['descent-override']};line-gap-override:${o['line-gap-override']}}`);
    }
  }
  const out = [
    `/* GENERATED by platform/fonts/build-fonts.mjs — do not edit (PLAN-forms-fonts-preconnect r6.1). Surface: ${surface}.`,
    `   Primary faces: Google Fonts' own files, pinned (platform/fonts/${s.baseline}.pin.json), self-hosted under content-hashed`,
    `   names and served immutable; descriptors exactly as Google declares them; font-display:optional (never swaps after paint).`,
    `   Fallback faces: metric-matched (size-adjust / ascent / descent / line-gap, platform/fonts/metrics.py). OFL 1.1: fonts/OFL.txt. */`,
    ...primary, '', '/* metric-matched fallbacks (regular and bold system faces, so weights are real, never synthesized) */', ...fallback, ''].join('\n');
  const body = readFileSync(join(dir, 'OFL-1.1.body.txt'), 'utf8');
  const ofl = Object.values(s.families).map((f) => f.copyright).join('\n') + '\n\n'
    + 'This Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttps://scripts.sil.org/OFL\n\n' + body;
  const preload = (s.preload || []).map(({ family, subset }) => {
    const f = faces.find((x) => x.family === family && x.subset === subset); if (!f) fail(`${surface}: preload ${family} ${subset} is not a hosted face`);
    return `fonts/${f.file}`;
  });
  return { surface, sites: s.sites, cssName: s.css, files, css: out, ofl, faces, preload: [...new Set(preload)] };
}

function verifySiteFiles(p, root = ROOT) {
  const problems = [];
  for (const site of p.sites) {
    const d = join(root, site, 'fonts');
    const have = existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.woff2')).sort() : [];
    const want = [...p.files.keys()].sort();
    for (const n of want) {
      if (!have.includes(n)) { problems.push(`${site}/fonts/${n} is missing`); continue; }
      const b = readFileSync(join(d, n)); const pin = p.files.get(n);
      if (sha(b) !== pin.sha256 || b.length !== pin.bytes) problems.push(`${site}/fonts/${n}: bytes differ from the pin`);
    }
    for (const n of have) if (!p.files.has(n)) problems.push(`${site}/fonts/${n} is not a pinned face (orphan)`);
  }
  return problems;
}

export function check(man = loadManifest(), root = ROOT, dir = HERE) {
  const problems = [];
  for (const surface of Object.keys(man.surfaces)) {
    let p; try { p = plan(surface, man, dir); } catch (e) { problems.push(e.message); continue; }
    problems.push(...verifySiteFiles(p, root));
    const seen = [];
    for (const site of p.sites) {
      const cssPath = join(root, site, p.cssName), oflPath = join(root, site, 'fonts', 'OFL.txt');
      const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : null, ofl = existsSync(oflPath) ? readFileSync(oflPath, 'utf8') : null;
      if (css !== p.css) problems.push(`${site}/${p.cssName} differs from what --write produces`);
      if (ofl !== p.ofl) problems.push(`${site}/fonts/OFL.txt differs from what --write produces`);
      seen.push(css + '\0' + ofl);
    }
    if (new Set(seen).size > 1) problems.push(`${surface}: the sites are not byte-identical`);
  }
  return problems;
}

async function fetchSurface(surface, man) {
  const s = man.surfaces[surface];
  const { pin, css } = loadBaseline(surface, man);
  const res = await fetch(pin.request, { headers: { 'user-agent': pin.ua } });
  if (!res.ok) fail(`baseline css answered ${res.status}`);
  const live = Buffer.from(await res.arrayBuffer());
  if (sha(live) !== pin.css.sha256) fail(`Google's css for the pinned request no longer equals the committed baseline — a font release happened; re-pin deliberately (nothing written)`);
  const faces = parseBaseline(css);
  const got = new Map();
  for (const f of pin.files) {
    const r = await fetch(f.url); if (!r.ok) fail(`${f.url} answered ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    if (sha(b) !== f.sha256 || b.length !== f.bytes) fail(`${f.url}: bytes differ from the pin (nothing written)`);
    got.set(f.url, b);
  }
  for (const site of s.sites) {
    const d = join(ROOT, site, 'fonts'); mkdirSync(d, { recursive: true });
    for (const face of faces) writeFileSync(join(d, fileFor(s, face, pin.files.find((x) => x.url === face.url))), got.get(face.url));
  }
  console.log(`build-fonts: fetched + verified ${pin.files.length} pinned files into ${s.sites.join(', ')}`);
}

function writeSurface(surface, man) {
  const p = plan(surface, man);
  for (const site of p.sites) {
    const d = join(ROOT, site, 'fonts');
    if (existsSync(d)) for (const n of readdirSync(d)) if (n.endsWith('.woff2') && !p.files.has(n)) unlinkSync(join(d, n));
  }
  const problems = verifySiteFiles(p);
  if (problems.length) fail(`${problems.join('; ')} — run --fetch ${surface} first`);
  for (const site of p.sites) { writeFileSync(join(ROOT, site, p.cssName), p.css); writeFileSync(join(ROOT, site, 'fonts', 'OFL.txt'), p.ofl); }
  console.log(`build-fonts: wrote ${p.cssName} + fonts/OFL.txt in ${p.sites.join(', ')} (${p.faces.length} primary faces, ${p.files.size} files)`);
}

async function main() {
  const [mode, surface] = process.argv.slice(2);
  const man = loadManifest();
  if (mode === '--fetch' && surface) return fetchSurface(surface, man);
  if (mode === '--write' && surface) return writeSurface(surface, man);
  if (mode === '--check') {
    const problems = check(man);
    if (problems.length) { for (const x of problems) console.error(`  ✗ ${x}`); fail(`${problems.length} problem(s)`); }
    console.log(`build-fonts: OK (${Object.keys(man.surfaces).length} surface(s): pinned files, css, OFL, site identity)`);
    return;
  }
  fail('usage: build-fonts.mjs --fetch <surface> | --write <surface> | --check');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`build-fonts: FAILED — ${e.message}`); process.exit(1); });
}
