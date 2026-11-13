// The opening animation «wake» (OWNER 2026-11-01, DECISIONS:3308; MOCKUP-capp-splash-animation.html Variant A): one source for the
// mark (the native icon/splash's geometry and palettes), the overlay ONLY in the native package, the exit at READY / the 4 s cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const SP = require('./capp-splash.js');
const BA = require('../platform/native/brand-assets.js');
const P = require('../platform/native/package-capp.js');
const { JSDOM } = createRequire(join(ROOT, 'xpizza-functions/x.js'))('jsdom');

test('WAKE-1 one source: the overlay mark is the native icon/splash geometry, byte for byte; the CSS recipes are its palettes', () => {
  assert.deepEqual([SP.RING, SP.NORTH, SP.SOUTH, SP.PIVOT_R], [BA.RING, BA.NORTH, BA.SOUTH, BA.PIVOT_R], '🔴 WAKE-1: the geometry');
  const m = SP.markupHtml();
  for (const d of [BA.RING, BA.NORTH, BA.SOUTH]) assert.equal(m.split(`d="${d}"`).length, 2, `the markup carries ${d} once`);
  const css = readFileSync(join(HERE, 'capp.css'), 'utf8');
  const vars = (block) => Object.fromEntries([...block.matchAll(/--cs-(bg|m1|m2):(#[0-9A-Fa-f]{6})/g)].map(([, k, v]) => [k, v.toUpperCase()]));
  const light = css.match(/\.csplash\{[^}]*\}/), dark = css.match(/@media \(prefers-color-scheme:dark\)\{\.csplash\{[^}]*\}\}/);
  assert.ok(light && dark, 'premise: the light recipe and the dark one');
  assert.deepEqual(vars(light[0]), { bg: BA.PALETTE.light.bg, m1: BA.PALETTE.light.m1, m2: BA.PALETTE.light.m2 }, '🔴 WAKE-1: the light recipe = the splash palette');
  assert.deepEqual(vars(dark[0]), { bg: BA.PALETTE.dark.bg, m1: BA.PALETTE.dark.m1, m2: BA.PALETTE.dark.m2 }, '🔴 WAKE-1: the dark recipe = the splash palette');
  for (const [k, ms] of [['a-settle', '720ms'], ['a-ring', '900ms'], ['a-halo', '900ms'], ['a-pivot', '240ms']]) assert.ok(new RegExp(`animation:${k} ${ms}`).test(css), `🔴 WAKE-1: Variant A's ${k} ${ms}`);
  assert.ok(/@media \(prefers-reduced-motion:reduce\)\{[^}]*\.csplash \.needle[^}]*animation:none/.test(css), '🔴 WAKE-1: reduced motion ⇒ nothing moves');
});

// the packager reads files AT a commit; the cell overlays the working tree (the test files' own pattern) so it judges THIS change
const WT = (rel) => readFileSync(join(ROOT, rel));
const HEAD = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
test('WAKE-2 the native package paints the overlay with the FIRST frame (right after #app) and loads capp-splash.js before the boot; the WEBSITE page never carries the overlay', () => {
  const N = P.build({ sha: HEAD, target: 'native', env: 'production', flags: ['guestCardOnly'], show: WT });
  const html = N.files.get(P.ENTRY).toString('utf8');
  assert.ok(html.includes('<div class="app" id="app"></div>' + SP.markupHtml()), '🔴 WAKE-2: native — the overlay right after #app');
  const iS = html.indexOf('<script src="capp-splash.js"></script>'), iB = html.indexOf('<script src="capp-boot.js"></script>');
  assert.ok(iS > 0 && iS < iB && N.files.has('capp-splash.js'), '🔴 WAKE-2: native — capp-splash.js packaged and loaded before the boot');
  const W = P.build({ sha: HEAD, target: 'web', env: 'production', flags: ['guestCardOnly'], show: WT });
  const wh = W.files.get(P.ENTRY).toString('utf8');
  assert.ok(!wh.includes('csplash'), '🔴 WAKE-2: the website page never carries the overlay (owner: not on the website)');
  assert.ok(W.files.get('capp-splash.js').equals(N.files.get('capp-splash.js')), 'D-1: one file set — the controller is the same file in both (inert on the web: the boot starts it only in native mode, WAKE-5)');
});

function page({ ready = false, reduced = false, capacitor = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html${ready ? ' data-capp-ready="1"' : ''}><body><div class="app" id="app"></div>${SP.markupHtml()}</body></html>`);
  const w = dom.window, timers = [];
  w.matchMedia = (q) => ({ matches: reduced && /reduce/.test(q) });
  if (capacitor) w.Capacitor = capacitor;
  const T = { setTimeout: (f, ms) => { const t = { f, ms, on: true }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; } };
  const run = (ms) => { for (const t of timers.filter((x) => x.on && x.ms === ms)) { t.on = false; t.f(); } };
  const el = () => w.document.getElementById('csplash');
  return { w, T, run, el, timers };
}
test('WAKE-3 READY fades it (200 ms) and removes it; a READY BEFORE start is honoured; the SplashScreen plugin is hidden at once', () => {
  const hid = [], A = page({ capacitor: { Plugins: { SplashScreen: { hide: () => hid.push(1) } } } });
  SP.start({ doc: A.w.document, win: A.w, timers: A.T });
  assert.deepEqual(hid, [1], '🔴 WAKE-3: the native plugin hidden at once (one splash on screen)');
  assert.ok(!A.el().classList.contains('exit'), 'playing until READY');
  SP.signalReady(A.w.document, A.w);
  assert.ok(A.el().classList.contains('exit'), '🔴 WAKE-3: READY ⇒ the fade');
  A.run(200); assert.ok(A.el().classList.contains('gone'), '🔴 WAKE-3: removed after 200 ms');
  assert.ok(!A.timers.some((t) => t.on), 'no timer left (the cap cleared)');
  const B = page({ ready: true });
  SP.start({ doc: B.w.document, win: B.w, timers: B.T });
  assert.ok(B.el().classList.contains('exit'), '🔴 WAKE-3: a READY that came first ⇒ the fade at once');
});
test('WAKE-4 the hard cap: no READY by 4 s ⇒ it fades regardless (a stuck boot never traps the customer); reduced motion fades in 150 ms', () => {
  const A = page();
  SP.start({ doc: A.w.document, win: A.w, timers: A.T });
  assert.ok(A.timers.some((t) => t.on && t.ms === 4000), '🔴 WAKE-4: the 4 s cap armed');
  A.run(4000); assert.ok(A.el().classList.contains('exit'), '🔴 WAKE-4: the cap fades it');
  const R = page({ reduced: true });
  SP.start({ doc: R.w.document, win: R.w, timers: R.T }); SP.signalReady(R.w.document, R.w);
  assert.ok(R.timers.some((t) => t.on && t.ms === 150) && !R.timers.some((t) => t.on && t.ms === 200), '🔴 WAKE-4: reduced motion ⇒ 150 ms');
});
test('WAKE-5 the boot starts the splash in the INSTALLED app (runtime.mode native) before mounting — never on the website', () => {
  const BOOT_SRC = readFileSync(join(HERE, 'capp-boot.js'), 'utf8'), SPLASH_SRC = readFileSync(join(HERE, 'capp-splash.js'), 'utf8');
  for (const mode of ['native', 'web']) {
    const dom = new JSDOM(`<!doctype html><html><body><div class="app" id="app"></div>${SP.markupHtml()}</body></html>`, { runScripts: 'outside-only' });
    const w = dom.window; w.matchMedia = () => ({ matches: false });
    let mounted = null;
    w.CappShellUI = { mount: () => { mounted = w.document.documentElement.getAttribute('data-capp-ready'); SP.signalReady(w.document, w); return {}; } };   // READY during the mount
    w.CAPP_RUNTIME = { mode, functions_base: 'https://fn.test', menu_endpoint: 'getPublicMenu' };
    w.eval(SPLASH_SRC); w.eval(BOOT_SRC);
    assert.equal(mounted, null, 'premise: the mount ran');
    const ex = w.document.getElementById('csplash').classList.contains('exit');
    assert.equal(ex, mode === 'native', `🔴 WAKE-5: ${mode} ⇒ ${mode === 'native' ? 'started (READY during the mount fades it)' : 'never started'}`);
  }
});
test('WAKE-7 (Codex r1 P2): the page owns an INDEPENDENT ceiling — if capp-splash.js never loads, the CSS alone fades and hides the overlay at the same 4 s (no inline script: CSP)', () => {
  const css = readFileSync(join(HERE, 'capp.css'), 'utf8');
  const base = css.match(/\.csplash\{[^}]*\}/)[0];
  const m = base.match(/animation:cs-cap (\d+)ms [a-z-]+ (\d+)ms forwards/);
  assert.ok(m, '🔴 WAKE-7: the base overlay rule (no JS-added class) carries the cap animation');
  assert.equal(Number(m[2]), SP.CAP_MS, '🔴 WAKE-7: ONE ceiling — the CSS delay is capp-splash.js CAP_MS');
  const kf = css.match(/@keyframes cs-cap\{[^}]*\{[^}]*\}[^}]*\{([^}]*)\}\}/);
  assert.ok(kf && /opacity:0/.test(kf[1]) && /visibility:hidden/.test(kf[1]), '🔴 WAKE-7: the cap ends invisible AND hidden (never a lingering layer)');
  const rm = css.match(/@media \(prefers-reduced-motion:reduce\)\{[^@]*?\}\}/)[0];
  assert.ok(!/\.csplash\{[^}]*animation:none/.test(rm), '🔴 WAKE-7: reduced motion never disables the ceiling (only the mark\'s motion)');
});
