// PLAN-portal-fonts r1.1 §5 — the portal's self-hosted Archivo, static guards (light; in test:portal). The ONE pipeline
// (platform/fonts, PLAN-forms-fonts-preconnect r6.1) generates the assets; this asserts the portal wires them exactly:
// no Google font host anywhere, optional only, the baseline's RANGE descriptor verbatim, preload = the manifest's set on BOTH
// entry pages, the metric-matched fallbacks named right after 'Archivo', CSP style/font-src 'self', the hashed .woff2 immutable,
// and the preconnects tied to their source constants. Run: node --test xpizza-portal/portal-fonts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, plan, parseBaseline, loadBaseline, check } from '../platform/fonts/build-fonts.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(DIR, f), 'utf8');
const PAGES = ['index.html', 'aceptar.html'];
const SHEETS = ['styles.css', 'aceptar.css'];
const man = loadManifest();
const P = plan('portal', man);
const csp = (/Content-Security-Policy = "([^"]+)"/.exec(read('netlify.toml')) || [])[1] || '';
const dir = (name) => (csp.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name} `)) || '').split(/\s+/).slice(1);
const linksOf = (html) => [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag, a) => (new RegExp(`\\b${a}="([^"]*)"`).exec(tag) || [])[1];

test('no Google font host anywhere: the entry pages, the stylesheets, the CSP', () => {
  for (const f of [...PAGES, ...SHEETS]) assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(read(f)), `${f} still names a Google font host`);
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(csp), 'the CSP still admits a Google font host');
  assert.ok(csp.length > 50, 'non-vacuity: the CSP was read');
});

test('the generated css: the pinned baseline\'s faces VERBATIM (range 600 800, font-stretch 100%), font-display optional only; the pipeline --check is clean', () => {
  const css = read(P.cssName);
  assert.equal(css, P.css, 'portal-fonts.css is exactly what the pipeline produces');
  const { css: baseline } = loadBaseline('portal', man);
  const base = parseBaseline(baseline);
  assert.equal(base.length, 3, 'three subsets: vietnamese, latin-ext, latin');
  for (const f of base) {
    assert.equal(f.weight, '600 800', `${f.subset}: the RANGE descriptor, as Google declares it (no weight trap: 750 / 800 render as requested)`);
    assert.equal(f.stretch, '100%');
    assert.ok(css.includes(`font-family:'Archivo';font-style:normal;font-weight:600 800;font-stretch:100%;font-display:optional;`), f.subset);
    assert.ok(css.includes(`unicode-range:${f.unicodeRange}`), `${f.subset}: the unicode-range verbatim`);
  }
  const displays = [...css.matchAll(/font-display:([a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(displays)], ['optional'], 'font-display:optional only (never swaps after paint)');
  assert.deepEqual(check(man), [], 'build-fonts --check: pinned files, css, OFL, site identity (both surfaces)');
  const woff = readdirSync(join(DIR, 'fonts')).filter((n) => n.endsWith('.woff2')).sort();
  assert.deepEqual(woff, [...P.files.keys()].sort(), 'exactly the pinned files, no orphan');
  assert.ok(existsSync(join(DIR, 'fonts', 'OFL.txt')) && read('fonts/OFL.txt').includes('The Archivo Project Authors'), 'the OFL notice with Archivo\'s copyright');
});

test('every fallback face carries all four metric overrides; --disp names them right after \'Archivo\' in BOTH stylesheets; --body untouched', () => {
  const fb = [...P.css.matchAll(/@font-face\{font-family:'(Archivo Fallback[^']*)';([^}]*)\}/g)];
  assert.equal(fb.length, 2, 'Arial Bold + Roboto Bold');
  for (const [, name, body] of fb) for (const o of ['size-adjust', 'ascent-override', 'descent-override', 'line-gap-override']) assert.match(body, new RegExp(`${o}:[0-9.]+%`), `${name}: ${o}`);
  for (const f of SHEETS) {
    const css = read(f);
    assert.match(css, /--disp:'Archivo','Archivo Fallback','Archivo Fallback Roboto','Söhne','Helvetica Neue',system-ui,sans-serif;/, `${f}: the fallbacks right after the face, the rest of the stack unchanged`);
    assert.match(css, /--body:'Söhne','Helvetica Neue',system-ui,-apple-system,'Segoe UI',sans-serif;/, `${f}: --body has no hosted face and is not touched`);
  }
});

test('preload ⇔ the manifest\'s critical set, on BOTH entry pages (as=font, type=font/woff2, crossorigin), before the stylesheets; the font heads are identical', () => {
  assert.deepEqual(P.preload, ['fonts/archivo-latin.7150c0ec5a.woff2'], 'the latin subset only (Spanish UI)');
  const heads = PAGES.map((page) => {
    const links = linksOf(read(page));
    const pre = links.filter((l) => attr(l, 'rel') === 'preload');
    assert.deepEqual(pre.map((l) => attr(l, 'href')), P.preload, `${page}: preload = the manifest's set`);
    for (const l of pre) { assert.equal(attr(l, 'as'), 'font'); assert.equal(attr(l, 'type'), 'font/woff2'); assert.ok(/\bcrossorigin\b/.test(l), `${page}: crossorigin`); }
    const iPre = links.indexOf(pre[0]);
    const sheets = links.filter((l) => attr(l, 'rel') === 'stylesheet');
    assert.deepEqual(sheets.map((l) => attr(l, 'href')), ['./portal-fonts.css', page === 'index.html' ? './styles.css' : './aceptar.css'], `${page}: the self-hosted font css, then the page's own`);
    for (const s of sheets) assert.ok(iPre < links.indexOf(s), `${page}: the preload precedes ${attr(s, 'href')}`);
    return links.filter((l) => /rel="(preload|preconnect)"|portal-fonts\.css/.test(l)).join('\n');
  });
  assert.equal(heads[0], heads[1], 'the two entry pages carry the same font head');
});

test('CSP: style-src \'self\' and font-src \'self\' (tightened, nothing widened); script-src keeps the Firebase SDK host', () => {
  assert.deepEqual(dir('style-src'), ["'self'"]);
  assert.deepEqual(dir('font-src'), ["'self'"]);
  assert.ok(dir('script-src').includes('https://www.gstatic.com'), 'the SDK import still loads');
});

test('/fonts/*.woff2 — and ONLY the hashed woff2 — is immutable', () => {
  const toml = read('netlify.toml');
  const blocks = [...toml.matchAll(/\[\[headers\]\]\s*\n\s*for = "([^"]+)"\s*\n\s*\[headers\.values\]([\s\S]*?)(?=\n\[\[|\n#|$)/g)].map((m) => [m[1], m[2]]);
  const imm = blocks.filter(([, v]) => /immutable/.test(v)).map(([f]) => f);
  assert.deepEqual(imm, ['/fonts/*.woff2'], 'one immutable rule, on the hashed files only (OFL.txt / portal-fonts.css keep the default)');
  assert.match(blocks.find(([f]) => f === '/fonts/*.woff2')[1], /Cache-Control = "public, max-age=31536000, immutable"/);
});

// the Firebase Auth REST hosts the SDK may call; one is preconnected ONLY when the §3.1 trace shows it before the useful paint
const AUTH_HOSTS = ['https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com'];
const origins = () => JSON.parse(read('perf/portal.origins.json'));

test('preconnects: www.gstatic.com + the Functions origin (tied to their source constants) + exactly the trace-admitted auth hosts, both pages, each crossorigin', () => {
  const sdkOrigin = new URL(/from '(https:\/\/www\.gstatic\.com\/[^']+)'/.exec(read('firebase.js'))[1]).origin;
  const base = (f) => new URL(/const BASE = '([^']+)'/.exec(read(f))[1]).origin;
  assert.equal(base('api.js'), base('aceptar-boot.js'), 'one Functions origin');
  const auth = origins().admitted.filter((o) => AUTH_HOSTS.includes(o));
  const want = [sdkOrigin, base('api.js'), ...auth].sort();
  for (const page of PAGES) {
    const pc = linksOf(read(page)).filter((l) => attr(l, 'rel') === 'preconnect');
    assert.deepEqual(pc.map((l) => attr(l, 'href')).sort(), want, `${page}: exactly the SDK origin + the Functions origin`);
    for (const l of pc) assert.ok(/\bcrossorigin\b/.test(l), `${page}: ${attr(l, 'href')} needs crossorigin (CORS module / fetch pool)`);
  }
});

// P2 — the §3.1 real-SDK origin trace (portal-origins.cdp.mjs --write, heavy slot) recorded perf/portal.origins.json: the preconnect
// set IS its admitted set, it ran the SDK firebase.js imports from the pinned bytes, and nothing it admitted is an excluded origin.
test('the trace-ratified preconnect set (perf/portal.origins.json)', () => {
  const rec = origins();
  for (const page of PAGES) {
    const pc = linksOf(read(page)).filter((l) => attr(l, 'rel') === 'preconnect').map((l) => attr(l, 'href')).sort();
    assert.deepEqual(pc, [...rec.admitted].sort(), `${page}: preconnects = the trace's admitted set`);
  }
  assert.equal(rec.sdkVersion, /firebasejs\/([0-9.]+)\//.exec(read('firebase.js'))[1], 'the trace ran the SDK firebase.js imports');
  const pin = JSON.parse(readFileSync(join(DIR, '..', 'platform/perf/sdk/firebasejs', rec.sdkVersion, 'sdk.pin.json'), 'utf8'));
  assert.deepEqual(rec.sdkFiles, pin.files.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })), 'the trace ran the PINNED SDK bytes');
  assert.ok(rec.repeats >= 3 && ['T1', 'T2', 'T3', 'T4'].every((t) => rec.states[t] && rec.states[t].runs.length === rec.repeats), 'every boot state, every repeat');
  for (const o of rec.admitted) assert.ok(!/fonts\.(googleapis|gstatic)\.com|storage\.googleapis\.com|firebaseio\.com/.test(o), `excluded origin admitted: ${o}`);
  for (const o of rec.admitted) assert.ok(['T2', 'T4'].some((t) => rec.states[t].runs.every((r) => r.origins.some((x) => x.origin === o && x.beforeMarker))), `${o}: admitted only on T2/T4 evidence before the marker, every repeat`);
  assert.ok(!/AIza/.test(read('perf/portal.origins.json')), 'the record carries no api key');
});
