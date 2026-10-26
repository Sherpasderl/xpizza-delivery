// NEVER-SHIP (browser half): proves — as a REAL computed style, not a source scan — that the WINNING --accent and
// every .slide-confirm track/fill/thumb background resolve to the Cuadra azul-acero, never an orange, in all four
// DOM contexts a live slide appears in (bare / #screen-onshift / .action-zone / .incoming-banner). This is what makes
// the finding robust against specificity (:root:not(.x)), @media ordering, rgb()/hsl() forms, and later <style>
// overrides that a static last-hex scan cannot see.
//
// Drives chrome-headless-shell over a harness page that embeds BOTH real <style> blocks verbatim + synthetic slides.
// Resolve the binary via $CHROME_HEADLESS_SHELL / $CHROME, else the puppeteer cache. REQUIRES a headless Chrome — it
// throws (never silently skips) if none is found, so the scheduled slot runs it where Chrome exists.
// Run: `node fa4400-render.browser.test.js`  (CHROME_HEADLESS_SHELL=/path/to/chrome-headless-shell to override).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));

function resolveChrome() {
  for (const e of [process.env.CHROME_HEADLESS_SHELL, process.env.CHROME]) if (e && existsSync(e)) return e;
  const root = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  if (existsSync(root)) {
    for (const ver of readdirSync(root)) {
      for (const sub of (existsSync(join(root, ver)) ? readdirSync(join(root, ver)) : [])) {
        const bin = join(root, ver, sub, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  throw new Error('chrome-headless-shell not found — set CHROME_HEADLESS_SHELL=/path/to/chrome-headless-shell (browser test REQUIRES a headless Chrome).');
}

// orange = hue 10–45°, saturation ≥ .45, lightness .2–.7 → covers #FA4400 and every derived slide orange; excludes
// steel rgb(47,95,184) (hue ~220) and the translucent whites.
function isOrange(css) {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(css || '');
  if (!m) return false;
  const [r, g, b] = [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return h >= 10 && h <= 45 && s >= 0.45 && l >= 0.2 && l <= 0.7;
}

const STYLE = [...readFileSync(join(__dir, 'index.html'), 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
  .map((m) => m[1]).join('\n');

const STATES = ['accept', 'pickup', 'delivered'];
const slide = (id, st) => `<div class="slide-confirm ${st}" id="${id}"><div class="slide-fill"></div><div class="slide-text">X</div><div class="slide-thumb">t</div></div>`;
const ctx = {
  bare: (st) => slide(`bare-${st}`, st),
  onshift: (st) => `<div id="screen-onshift">${slide(`onshift-${st}`, st)}</div>`,
  zone: (st) => `<div id="screen-onshift"><div class="action-zone">${slide(`zone-${st}`, st)}</div></div>`,
  banner: (st) => `<div class="incoming-banner">${slide(`banner-${st}`, st)}</div>`,
};
const CONTEXTS = Object.keys(ctx);

const body = CONTEXTS.map((c) => STATES.map((st) => ctx[c](st)).join('')).join('');
// resolve --accent through a probe's computed background (custom props return their raw token, not resolved rgb)
const html = `<!doctype html><html><head><meta charset="utf8"><style>${STYLE}</style></head><body>${body}
<div id="accent-probe" style="background:var(--accent)"></div>
<script>
  const bg=(s)=>{const e=document.querySelector(s);return e?getComputedStyle(e).backgroundColor:'MISSING';};
  const out={ accent:bg('#accent-probe') };
  for (const c of ${JSON.stringify(CONTEXTS)}) for (const st of ${JSON.stringify(STATES)}) {
    out[c+'/'+st+'/track']=bg('#'+c+'-'+st);
    out[c+'/'+st+'/fill']=bg('#'+c+'-'+st+' .slide-fill');
    out[c+'/'+st+'/thumb']=bg('#'+c+'-'+st+' .slide-thumb');
  }
  document.title='PROBE'+JSON.stringify(out);
</script></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'fa4400-render-'));
const page = join(dir, 'probe.html');
writeFileSync(page, html);
let out;
try {
  const CHS = resolveChrome();
  const dom = execFileSync(CHS, ['--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=2500', '--dump-dom', `file://${page}`], { encoding: 'utf8', maxBuffer: 1e8 });
  out = JSON.parse(dom.match(/PROBE(\{[\s\S]*?\})<\/title>/)[1]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ok -', name); }

t('the WINNING computed --accent is azul-acero, never an orange', () => {
  assert.ok(!isOrange(out.accent), `computed --accent is orange: ${out.accent}`);
  // steel is rgb(47, 95, 184); normalise spacing before comparing
  assert.equal(out.accent.replace(/\s+/g, ''), 'rgb(47,95,184)', `computed --accent = ${out.accent}, expected steel rgb(47, 95, 184)`);
});

t('no .slide-confirm track / fill / thumb computes to orange in any of the 4 contexts × 3 states', () => {
  const bad = [];
  for (const [k, v] of Object.entries(out)) {
    if (k === 'accent') continue;
    assert.notEqual(v, 'MISSING', `probe element missing for ${k}`);
    if (isOrange(v)) bad.push(`${k} = ${v}`);
  }
  assert.deepEqual(bad, [], `slide element(s) render orange:\n  ${bad.join('\n  ')}`);
});

t('every slide-confirm track computes to the steel track colour (the prototype .slide background)', () => {
  const bad = [];
  for (const [k, v] of Object.entries(out)) {
    if (!k.endsWith('/track')) continue;
    if (v.replace(/\s+/g, '') !== 'rgb(47,95,184)') bad.push(`${k} = ${v}`);
  }
  assert.deepEqual(bad, [], `slide track(s) not steel rgb(47, 95, 184):\n  ${bad.join('\n  ')}`);
});

console.log(`✓ fa4400-render (browser): ${passed} checks passed`);
