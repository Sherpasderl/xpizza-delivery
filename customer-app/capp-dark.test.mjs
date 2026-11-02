// capp-dark (PLAN-capp-dark-mode r2, APPROVED) — §2.1 the PAIRING GUARD: every dark rule exists in its three forms (the forced class
// .app.dark, :root[data-theme="dark"] .app, and the OS media query under :root:not([data-theme="light"]) .app) with byte-identical
// declarations; no orphan; the media forms only inside @media (prefers-color-scheme: dark); the canvas (--page-bg) and the theme-color
// metas equal the app's own backgrounds. Parsed at the SOURCE level (comments stripped, braces matched), NOT with jsdom's CSSOM: the
// CSSOM silently drops values it cannot parse (color-mix(…)), which would make every form compare equal — the guard would be vacuous
// for exactly the drift Codex named. Run: node --test customer-app/capp-dark.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { inventory, servedSources } from './capp-colour-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const CSS = readFileSync(join(HERE, 'capp.css'), 'utf8');

const FORCED = '.app.dark', ATTR = ':root[data-theme="dark"] .app', MEDIA = ':root:not([data-theme="light"]) .app';
// the rules of a stylesheet source → [{ selector, body } | { media, rules }] (comments stripped; strings are not expected in capp.css)
function rulesOf(src) {
  const t = src.replace(/\/\*[\s\S]*?\*\//g, ''); let i = 0;
  function list(end) {
    const out = [];
    while (i < t.length) {
      while (i < t.length && /\s/.test(t[i])) i++;
      if (i >= t.length || t[i] === '}') { i++; return out; }
      const open = t.indexOf('{', i); if (open < 0) { i = t.length; return out; }
      const head = t.slice(i, open).trim(); i = open + 1;
      if (head.startsWith('@media')) { out.push({ media: head.slice(6).trim(), rules: list('}') }); continue; }
      if (head.startsWith('@')) { let d = 1; while (i < t.length && d) { d += (t[i] === '{') - (t[i] === '}'); i++; } continue; }   // @font-face / @keyframes: not theme rules
      const close = t.indexOf('}', i); out.push({ selector: head, body: t.slice(i, close).trim().replace(/;\s*$/, '') }); i = close + 1;
    }
    return out;
  }
  return list();
}
const split = (sel) => sel.split(',').map((x) => x.trim()).filter(Boolean);
// → { pairs: Map(suffix → { forced, attr, media }), stray: [selectors] } for one stylesheet's text
export function pairsOf(cssText) {
  const pairs = new Map(), stray = [];
  const put = (suffix, form, d, where) => { const e = pairs.get(suffix) || {}; if (e[form] !== undefined) stray.push(`${form} twice: ${suffix || '(the tokens)'}`); e[form] = d; e[`${form}At`] = where; pairs.set(suffix, e); };
  const visit = (rules, media) => {
    for (const r of rules) {
      if (r.rules) { visit(r.rules, r.media); continue; }   // @media
      const d = r.body;
      for (const s of split(r.selector)) {
        if (s.startsWith(FORCED) && !/^\.app\.dark[\w-]/.test(s)) { if (media) stray.push(`forced form inside @media: ${s}`); else put(s.slice(FORCED.length), 'forced', d, s); continue; }
        if (s.startsWith(ATTR)) { if (media) stray.push(`attr form inside @media: ${s}`); else put(s.slice(ATTR.length), 'attr', d, s); continue; }
        if (s.startsWith(MEDIA)) { if (!media || !/prefers-color-scheme:\s*dark/.test(media)) stray.push(`media form outside @media (prefers-color-scheme: dark): ${s}`); else put(s.slice(MEDIA.length), 'media', d, s); continue; }
        // a theme selector in any OTHER shape (a bare «.dark X» descendant) can never follow the OS — refused; the .btn2.dark button
        // variant and the review page's own chrome (.dark-sys, :root[data-theme] .dec) are not theme rules of the app
        if (/(^|\s)\.dark(\s|$|[.:#[])/.test(s) && !/\.btn2\.dark/.test(s)) stray.push(`a theme selector outside the three forms: ${s}`);
      }
    }
  };
  visit(rulesOf(cssText), null);
  return { pairs, stray };
}
function problems(cssText) {
  const { pairs, stray } = pairsOf(cssText), out = [...stray];
  for (const [suffix, e] of pairs) {
    const name = suffix || '(the tokens)';
    for (const f of ['forced', 'attr', 'media']) if (e[f] === undefined) out.push(`${name}: the ${f} form is missing`);
    if (e.forced !== undefined && e.attr !== undefined && e.forced !== e.attr) out.push(`${name}: the attr form's declarations differ from the forced form's`);
    if (e.forced !== undefined && e.media !== undefined && e.forced !== e.media) out.push(`${name}: the media form's declarations differ from the forced form's`);
  }
  return out;
}

test('capp-dark §2.1: every dark rule in capp.css exists in its THREE forms with byte-identical declarations; no orphan; media forms only in @media (prefers-color-scheme: dark)', () => {
  const { pairs } = pairsOf(CSS);
  assert.ok(pairs.size >= 5, `premise: the token block + the dark component rules are found (${[...pairs.keys()].join(' | ')})`);
  assert.ok(pairs.has('') && pairs.has(' .okbtn .fill') && pairs.has(' .map'), 'premise: the tokens, .okbtn .fill, the map');
  assert.deepEqual(problems(CSS), [], '🔴 DK-pair: every dark rule paired');
});
test('capp-dark §2.1 controls: the guard SEES drift (Codex r2: only the auto .okbtn .fill 55% → 72%), a missing form, a form moved out of its @media, a bare .dark rule', () => {
  const auto = CSS.replace(/(:root:not\(\[data-theme="light"\]\) \.app \.okbtn \.fill\{background:color-mix\(in srgb,var\(--acc\) )55%/, '$172%');
  assert.notEqual(auto, CSS, 'premise: the auto counterpart of .okbtn .fill exists');
  assert.ok(problems(auto).some((p) => /okbtn .fill: the media form's declarations differ/.test(p)), '🔴 control: the 55% → 72% drift is caught');
  const gone = CSS.replace(/@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\) \.app \.map\{[^}]*\}\}/, '');
  assert.notEqual(gone, CSS); assert.ok(problems(gone).some((p) => / \.map: the media form is missing/.test(p)), '🔴 control: a deleted counterpart');
  const moved = CSS.replace(/@media \(prefers-color-scheme: dark\)\{(:root:not\(\[data-theme="light"\]\) \.app \.order-map\{[^}]*\})\}/, '$1');
  assert.notEqual(moved, CSS); assert.ok(problems(moved).some((p) => /media form outside @media/.test(p)), '🔴 control: a form moved out of its @media');
  assert.ok(problems(CSS + '\n.dark .newthing{color:#fff}').some((p) => /outside the three forms/.test(p)), '🔴 control: a bare .dark rule');
});
test('capp-dark §2.2/§2.3: the canvas (--page-bg on html.capp-shell) and the theme-color metas equal the app\'s own backgrounds, light and dark; shell.html declares color-scheme', () => {
  const light = /\.app\{[^}]*--bg:(#[0-9A-Fa-f]{6})/.exec(CSS)[1], dark = /\.app\.dark,:root\[data-theme="dark"\] \.app\{[^}]*?--bg:(#[0-9A-Fa-f]{6})/.exec(CSS)[1];
  assert.equal(/:root\{--page-bg:(#[0-9A-Fa-f]{6})\}/.exec(CSS)[1], light, '🔴 --page-bg light = the app\'s --bg');
  assert.equal(/:root\[data-theme="dark"\]\{--page-bg:(#[0-9A-Fa-f]{6})\}/.exec(CSS)[1], dark, '🔴 --page-bg forced dark = the dark --bg');
  assert.equal(/@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{--page-bg:(#[0-9A-Fa-f]{6})\}\}/.exec(CSS)[1], dark, '🔴 --page-bg auto dark = the dark --bg');
  assert.match(CSS, /\.capp-shell,\.capp-shell body\{background:var\(--page-bg\)\}/);
  const shell = readFileSync(join(HERE, 'shell.html'), 'utf8');
  assert.match(shell, /<html lang="es-HN" class="capp-shell">/, 'the shell page opts in (markup only, no script)');
  assert.match(shell, /<meta name="color-scheme" content="light dark">/);
  assert.equal(/<meta name="theme-color" content="(#[0-9A-Fa-f]{6})" media="\(prefers-color-scheme: light\)">/.exec(shell)[1], light, '🔴 theme-color light');
  assert.equal(/<meta name="theme-color" content="(#[0-9A-Fa-f]{6})" media="\(prefers-color-scheme: dark\)">/.exec(shell)[1], dark, '🔴 theme-color dark');
  assert.ok(!/<script>/.test(shell), 'no inline script (the CSP is unchanged: script-src stays \'self\')');
});
test('capp-dark §3: the schematic maps (the checkout map\'s fallback, the order screen\'s map) carry NO hex literal — their colours are the --map-* tokens, which have dark values in the token blocks', () => {
  const require = createRequire(import.meta.url);
  const svgs = [require('./capp-ui.js').MAP_SVG, (/<svg class="mapsvg"[\s\S]*?<\/svg>/.exec(require('./capp-order.js').orderHtml({ order_id: 'X', mode: 'delivery', status: 'new', storeName: 'S', lines: [], total: 1, pay: 'cash', addr: 'a' }, { entry: 'app', now: 0 })) || [''])[0]];
  for (const svg of svgs) {
    assert.ok(svg.includes('var(--map-park)') && svg.includes('var(--map-road)'), 'premise: the tokens are used');
    assert.ok(!/#[0-9A-Fa-f]{3,8}\b/.test(svg), `🔴 DK-map: a hex literal in a schematic map: ${(/#[0-9A-Fa-f]{3,8}\b/.exec(svg) || [])[0]}`);
  }
  const { pairs } = pairsOf(CSS), tok = pairs.get('');
  for (const k of ['--map-road', '--map-minor', '--map-park', '--map-water']) assert.ok(new RegExp(`${k}:#`).test(tok.forced), `🔴 DK-map: ${k} has a dark value`);
});
// ── §2.5 CappTheme: the one theme source for the JS surfaces ──
function fakeWin(dark, attr = null) {
  const ls = new Set(), vis = new Set(); let d = dark;
  const mq = { get matches() { return d; }, addEventListener: (t, f) => { if (t === 'change') ls.add(f); }, removeEventListener: (t, f) => ls.delete(f) };
  const doc = { visibilityState: 'visible', documentElement: { getAttribute: (k) => (k === 'data-theme' ? attr : null) }, addEventListener: (t, f) => { if (t === 'visibilitychange') vis.add(f); }, removeEventListener: (t, f) => vis.delete(f) };
  return { win: { matchMedia: () => mq, document: doc }, flip: (v) => { d = v; for (const f of [...ls]) f(); }, silentFlip: (v) => { d = v; }, wake: () => { for (const f of [...vis]) f(); }, ls, vis };
}
test('CappTheme: the OS preference (fail-safe light), an explicit data-theme wins, change notifies ONCE per real change, a wake re-reads, unsubscribe detaches', () => {
  const require = createRequire(import.meta.url), T = require('./capp-theme.js');
  assert.equal(T.isDark(fakeWin(true).win), true); assert.equal(T.isDark(fakeWin(false).win), false);
  assert.equal(T.isDark(fakeWin(false, 'dark').win), true, 'a manual dark wins'); assert.equal(T.isDark(fakeWin(true, 'light').win), false, 'a manual light wins');
  assert.equal(T.isDark({ matchMedia: () => { throw new Error('x'); } }), false, '🔴 DK-theme: a throwing matchMedia ⇒ light'); assert.equal(T.isDark(null), false);
  const f = fakeWin(false), seen = [];
  const un = T.subscribe(f.win, (v) => seen.push(v));
  f.flip(true); f.flip(true); f.flip(false);
  assert.deepEqual(seen, [true, false], '🔴 DK-theme: one call per real change');
  f.silentFlip(true); f.wake(); assert.deepEqual(seen, [true, false, true], '🔴 DK-theme: a wake (the media event lost while backgrounded) re-reads');
  un(); assert.equal(f.ls.size + f.vis.size, 0, '🔴 DK-theme: unsubscribe detaches both listeners');
  assert.equal(T.mapStyles(fakeWin(true).win), T.MAP_DARK); assert.equal(T.mapStyles(fakeWin(false).win), null);
});

// ── §5 the LITERAL-COLOUR guard: every colour literal outside the token blocks (capp.css rule by rule, every served module's SVG
// attributes / template styles / cssText / CSSOM strings) is listed in capp-colour-allowlist.json with its disposition. A new literal
// (a post-v6 rule that would not follow dark) ⇒ red; a stale entry ⇒ red. Dispositions per PLAN §5 + the advisor's 2026-11-01 rulings
// (v6-exact for the qty controls / store nav / map tag). v6-parity entries were checked once against the pinned
// customer-app-prototype-v6.html (not in this repo) on 2026-11-01. Update: node customer-app/capp-colour-scan.mjs --print, then review.
const ALLOW = JSON.parse(readFileSync(join(HERE, 'capp-colour-allowlist.json'), 'utf8'));
const DISPOSITIONS = new Set(['theme-pair', 'v6-parity', 'fixed', 'unused', 'ported', 'external']);
const missingFrom = (a, b) => a.filter((x) => !b.includes(x));

test('capp-dark §5: every colour literal in the served app is in the allowlist, with a disposition and its reason — and no stale entry', () => {
  const inv = inventory(), listed = Object.keys(ALLOW);
  assert.deepEqual(missingFrom(inv, listed), [], '🔴 DK-lit: a colour literal NOT in capp-colour-allowlist.json (a new rule that will not follow dark — use a token, or list it with its disposition)');
  assert.deepEqual(missingFrom(listed, inv), [], '🔴 DK-lit: a stale allowlist entry (its literal is gone — drop it)');
  for (const [site, e] of Object.entries(ALLOW)) {
    assert.ok(e && DISPOSITIONS.has(e.disposition), `🔴 DK-lit: ${site}: unknown disposition ${e && e.disposition}`);
    assert.ok(e && typeof e.why === 'string' && e.why.length >= 12, `🔴 DK-lit: ${site}: no reason`);
  }
});

test('capp-dark §5: each disposition holds — a theme-pair has both sides in all three forms, «ported» is a guarded byte copy, «unused» is never rendered', () => {
  const sites = Object.keys(ALLOW), css = sites.filter((k) => k.startsWith('css ')).map((k) => ({ k, sel: k.slice(4).split(' | ')[0], prop: k.split(' | ')[1].split(' ')[0] }));
  const darkSel = (sel) => [`${FORCED} ${sel},${ATTR} ${sel}`, `@media (prefers-color-scheme: dark) ${MEDIA} ${sel}`];
  for (const c of css.filter((x) => ALLOW[x.k].disposition === 'theme-pair')) {
    if (/^(\.app\.dark |@media )/.test(c.sel)) {
      const base = c.sel.startsWith('@media') ? c.sel.slice(`@media (prefers-color-scheme: dark) ${MEDIA} `.length) : c.sel.split(',')[0].slice(FORCED.length + 1);
      assert.ok(css.some((x) => x.sel === base && x.prop === c.prop && ALLOW[x.k].disposition === 'theme-pair'), `🔴 DK-lit: ${c.k}: a dark side with no light side`);
    } else for (const d of darkSel(c.sel)) assert.ok(css.some((x) => x.sel === d && x.prop === c.prop), `🔴 DK-lit: ${c.k}: its dark form «${d}» is missing`);
  }
  const guards = readFileSync(join(HERE, 'capp-guards.test.mjs'), 'utf8'), ported = ((guards.match(/const PORTED = \{([\s\S]*?)\};/) || [])[1] || '').match(/'[\w.-]+\.js'(?=:)/g) || [];
  assert.ok(ported.length >= 4, 'premise: the PORTED map read from capp-guards');
  for (const k of sites.filter((x) => ALLOW[x].disposition === 'ported')) assert.ok(ported.includes(`'${k.split(' ')[1]}'`), `🔴 DK-lit: ${k}: «ported» but not a PORTED byte copy`);
  const src = servedSources(), markup = Object.values(src.js).join('\n') + readFileSync(join(HERE, 'shell.html'), 'utf8');
  for (const c of css.filter((x) => ALLOW[x.k].disposition === 'unused')) {
    const cls = (c.sel.match(/\.([a-z][\w-]*)/g) || []).map((x) => x.slice(1)).filter((x) => x !== 'app' && x !== 'dark-sys')[0];
    assert.ok(cls, `premise: ${c.k} names a class`);
    assert.ok(!new RegExp(`class="[^"]*\\b${cls}\\b|classList\\.(add|toggle)\\('${cls}'|className = '[^']*\\b${cls}\\b`).test(markup), `🔴 DK-lit: ${c.k}: «unused» but .${cls} is rendered`);
  }
});

test('capp-dark §5 controls: the scan SEES a new rule, an SVG attribute, a template style, cssText after «:», a CSSOM rgb() — and ignores token blocks, comments, HTML entities', () => {
  const base = { css: '.app{--bg:#FFFFFF}\n.app.dark{--bg:#0A0F1C}\n:root[data-theme="dark"] .app{--bg:#0A0F1C}\n@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .app{--bg:#0A0F1C}}\n/* .x{color:#999} */\n', js: { 'a.js': "// fill=\"#888\"\nconst q = '&#039;';\n/* '#777' */\n" } };
  assert.deepEqual(inventory(base), [], '🔴 DK-lit control: token blocks (light + the three dark forms), comments and entities are not sites');
  const plus = { css: base.css + '.newx{color:#123456;box-shadow:0 1px 2px rgba(0,0,0,.2)}', js: { 'a.js': base.js['a.js'] + 'const svg = `<path fill="#ABCDEF"/>`; el.style.cssText = \'background:#abc;color:#111\'; s.color = \'rgb(1, 2, 3)\'; const h = `<b style="color:#C0FFEE">`;' } };
  assert.deepEqual(inventory(plus), ['css .newx | box-shadow rgba(0,0,0,.2)', 'css .newx | color #123456', 'js a.js #111', 'js a.js #ABCDEF', 'js a.js #C0FFEE', 'js a.js #abc', 'js a.js rgb(1,2,3)'], '🔴 DK-lit control: every new literal is a site');
  const all = servedSources(), first = Object.keys(ALLOW).find((k) => k.startsWith('css .qty-add-btn | background'));
  assert.ok(first, 'premise: the qty-add-btn background is listed');
  const cut = { ...all, css: all.css.replace('.qty-add-btn{width:36px;height:36px;border-radius:50%;background:#fff;', '.qty-add-btn{width:36px;height:36px;border-radius:50%;background:var(--surf2);') };
  assert.ok(cut.css !== all.css && !inventory(cut).includes(first), '🔴 DK-lit control: a literal turned into a token leaves the inventory (its entry would be stale)');
});
