// PORTAL-UI 1b — AA contrast of every 1b text class in BOTH themes (AA gate 2026-10-26). portal-look's discovering sweep is
// light-mode only; this test reads the REAL token blocks (light :root, dark [data-theme="dark"], and the prefers-color-scheme
// copy, which must equal the explicit dark block) and the REAL 1b rules from styles.css. For each text class it takes the
// rule's declared `color` token, pairs it with the surface the element sits on (declared `background`, else the named
// container surface), and requires ≥ 4.5:1 in light AND dark. A rule whose colour drifts from the table fails here first.
// 1a follow-up (2026-10-26): every `color` declaration on an `.ops` selector anywhere in styles.css (1a and 1b; each selector
// of a list on its own, theme-prefixed ones in their theme only; only `:hover` selectors are skipped) is DISCOVERED and
// evaluated against its surface in both themes. A selector missing from the surface table, or a value the sweep cannot
// evaluate (not a token or a #hex), fails by name.
// Run: node --test xpizza-portal/branches-1b-aa.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// hex tokens as-is; an rgba() token (--tint) is composited over the surface it is painted on (see `over`)
const block = (re) => { const m = re.exec(css); assert.ok(m, `token block ${re}`); return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6}|rgba\([^)]*\))/g)].map((x) => [x[1], x[2]])); };
const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');
const flat = (v, under) => { const m = /^rgba\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)$/.exec(String(v).replace(/\s/g, '')); if (!m) return v; const a = +m[4]; const u = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16)); return `#${[+m[1], +m[2], +m[3]].map((c, i) => hex2(c * a + u[i] * (1 - a))).join('')}`; };
const LIGHT = block(/:root, :root\[data-theme="light"\]\{([^}]*)\}/);
const DARK = block(/:root\[data-theme="dark"\]\{([^}]*)\}/);
const DARK_MQ = block(/@media\(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)\{([^}]*)\}/);
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const declared = (sel, prop) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[}\\s])${esc}\\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(m, `rule ${sel} exists`);
  const d = new RegExp(`(?:^|;)\\s*${prop}:\\s*var\\(--([\\w-]+)\\)`).exec(m[1]);
  return d ? d[1] : null;
};
// [selector, surface token it sits on when the rule declares no background]
// an rgba surface is composited over --card (every 1b chip sits on a card / the modal)
const over = 'card';
const TEXT = [
  ['.ops .hoff1b', null], ['.ops .lock1b', 'card'], ['.ops .bt1b span', 'card'], ['#sucmodal .fld .lab', 'card'], ['#sucmodal .fnote', 'card'],
  ['.ops .emptynote1b', 'board'], ['.ops .emptyline1b', 'board'], ['.ops .csub1b', 'card'], ['.ops .legend1b', 'board'], ['.ops .chipq1b', 'card'],
  ['.ops .chip1b', null], ['.ops .ferr1b', 'card'], ['.ops .herr1b', 'card'], ['.ops .hday1b', 'card'], ['.ops .htime1b', null], ['.ops .hmiss1b', null],
  ['.ops .sherpa1b', null], ['.ops .tel1b', null], ['.nvin1b', null], ['.cqt1b span', 'card'], ['.cqfoot1b', 'card'], ['.ops .addcard1b', null],
  ['.pillok1b', null], ['.pillwarn1b', null], ['.pillwait1b', null], ['.pilldraft1b', null], ['.pillstaged1b', null], ['.pillinactive1b', null],
  ['.chipon1b', null], ['#sucmodal .chip1b.chipon1b', null], ['.ops .calloutok1b b', 'green-soft'],
];
// .ops text selectors not in the 1b table above (1a's, plus 1b's quiet callout title): [selector, surface when the rule declares no background]
const TEXT_1A = [
  ['.ops .card', null], ['.ops .cmeta', 'card'], ['.ops .cmeta b', 'card'], ['.ops .callout', null], ['.ops .callout b', 'amber-soft'],
  ['.ops .errbox b', 'red-soft'], ['.ops .errbox p', 'red-soft'], ['.ops .crumb', 'board'], ['.ops .calloutquiet1b b', 'board-2'],
  ['.ops .sec h3 .hint', 'card'], ['.ops .sec p.help', 'card'], ['.ops .fld .lab', 'card'], ['.ops .inval', null], ['.ops .inval.inro', null],
  ['.ops .fnote', 'card'], ['.ops .hrow .d', 'card'], ['.ops .step .val span', 'card'], ['.ops .step .val.miss', 'card'], ['.ops .stepb', null],
  ['.ops .map .mz', null], ['.ops .status .sub', 'board-2'], ['.drawer.ops .adwx', null], ['.drawer.ops .bt span', 'card'], ['.drawer.ops .fnote', 'card'],
];
const sweep = (rows) => {
  let cells = 0;
  for (const [sel, surface] of rows) {
    const fg = declared(sel, 'color');
    const bg = declared(sel, 'background') || surface;
    assert.ok(fg && bg, `${sel}: a colour token and a surface`);
    for (const [name, T] of [['light', LIGHT], ['dark', DARK]]) {
      assert.ok(T[fg] && T[bg], `${sel}: tokens --${fg} / --${bg} exist in ${name}`);
      const r = ratio(flat(T[fg], T[over]), flat(T[bg], T[over]));
      assert.ok(r >= 4.5, `${sel} (${name}): --${fg} on --${bg} = ${r.toFixed(3)} < 4.5`);
      cells += 1;
    }
  }
  assert.equal(cells, rows.length * 2);
};

test('the prefers-color-scheme dark tokens equal the explicit dark theme (one dark palette)', () => {
  assert.deepEqual(DARK_MQ, DARK);
  assert.ok(Object.keys(DARK).length > 15, 'non-vacuity: the palette was parsed');
});

test('every 1b text class clears 4.5:1 in light AND dark (dark --mute2 was 4.46 on --card until the 11-10 token fix — small text still uses --mute)', () => {
  sweep(TEXT);
  // the pair the gate once found is FIXED (advisor AA ruling 11-10: dark --mute2 #7C7C80 → #7E7E82, ≥ 4.5 on --card), and --mute still passes
  assert.ok(ratio(DARK.mute2, DARK.card) >= 4.5 && ratio(DARK.mute, DARK.card) >= 4.5 && ratio(LIGHT.mute, LIGHT.card) >= 4.5);
});

// ── discovery: every colour declaration on an .ops selector ──
const splitList = (sel) => { const out = []; let depth = 0; let cur = ''; for (const ch of sel) { if (ch === '(') depth += 1; if (ch === ')') depth -= 1; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
const declsOf = (body) => body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]);
// a leading theme compound (`:root[data-theme="dark"]`, the prefers-color-scheme `:root:not([data-theme="light"])`) scopes the
// selector to one theme; the table key is the selector without it
const themed = (sel) => {
  const [head, ...rest] = sel.split(/\s+/);
  if (!/data-theme/.test(head)) return { key: sel, themes: ['light', 'dark'] };
  const themes = /:not\(\[data-theme="light"\]\)/.test(head) || /data-theme="dark"/.test(head) ? ['dark'] : /data-theme="light"/.test(head) ? ['light'] : null;
  assert.ok(themes, `${sel}: a theme prefix the sweep cannot place`);
  return { key: rest.join(' '), themes };
};
const discover = (text) => {
  const found = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = declsOf(m[2]);
    const colours = decls.filter(([prop]) => prop === 'color').map(([, v]) => v);
    if (!colours.length) continue;
    const bg = (decls.find(([prop]) => prop === 'background-color') || decls.find(([prop]) => prop === 'background') || [])[1] || null;
    for (const sel of splitList(m[1].trim())) {
      if (!/\.ops(?![\w-])/.test(sel) || /:hover/.test(sel)) continue;
      for (const colour of colours) found.push({ sel, colour, bg, ...themed(sel) });
    }
  }
  return found;
};
const evaluate = (v, T, where) => {
  const val = v.replace(/\s*!important$/, '');
  const tok = /^var\(--([\w-]+)\)$/.exec(val);
  if (tok) { assert.ok(T[tok[1]], `${where}: --${tok[1]} exists`); return flat(T[tok[1]], T[over]); }
  if (/^#[0-9a-f]{6}$/i.test(val)) return val;
  if (/^#[0-9a-f]{3}$/i.test(val)) return `#${[...val.slice(1)].map((c) => c + c).join('')}`;
  return assert.fail(`${where}: «${v}» cannot be evaluated by the AA sweep — use a token or a #hex`);
};
const SURFACE = new Map([...TEXT, ...TEXT_1A].filter(([sel]) => /\.ops(?![\w-])/.test(sel)));
const sweepOps = (text) => {
  const found = discover(text);
  const missing = [...new Set(found.filter((f) => !SURFACE.has(f.key)).map((f) => f.sel))];
  assert.deepEqual(missing, [], 'every .ops selector that sets a text colour is in the surface table');
  let cells = 0;
  for (const f of found) {
    for (const name of f.themes) {
      const T = name === 'light' ? LIGHT : DARK;
      const where = `${f.sel} (${name})`;
      const fg = evaluate(f.colour, T, where);
      const bgv = f.bg && !/^(none|transparent)$/.test(f.bg) ? f.bg : SURFACE.get(f.key) && `var(--${SURFACE.get(f.key)})`;
      assert.ok(bgv, `${where}: a surface`);
      const r = ratio(fg, evaluate(bgv, T, where));
      assert.ok(r >= 4.5, `${where}: ${f.colour} on ${bgv} = ${r.toFixed(3)} < 4.5`);
      cells += 1;
    }
  }
  return { found, cells };
};

test('every colour on an .ops / .drawer.ops selector clears 4.5:1 in light AND dark (1a follow-up: .hint, .fld .lab, .fnote → --mute)', () => {
  const { found, cells } = sweepOps(css);
  assert.ok(found.length >= 40 && cells >= 80, `non-vacuity: ${found.length} declarations discovered`);
  // the table carries no stale rows: each .ops row is a selector the stylesheet really colours
  const seen = new Set(found.map((f) => f.key));
  assert.deepEqual([...SURFACE.keys()].filter((k) => !seen.has(k)), []);
});

// Codex 1a-aa r1 P2: each of these additions slipped past the first completeness check; each must now fail the sweep
const MUTANTS = [
  ['a selector list with an uncovered .ops member', '.other, .ops .uncovered{color:var(--ink)}', /\.ops \.uncovered/],
  ['a selector list with :hover in it', '.ops .fnote:hover, .ops .uncov2{color:var(--ink)}', /\.ops \.uncov2/],
  ['a theme-prefixed uncovered selector', ':root[data-theme="dark"] .ops .uncov3{color:var(--ink)}', /\.ops \.uncov3/],
  ['a theme-prefixed low-contrast override', ':root[data-theme="dark"] .ops .fnote{color:var(--line)}', /\.ops \.fnote \(dark\): var\(--line\)/],   // --line (1.23 on dark --card): --mute2 passes since the 11-10 token fix
  ['a literal colour below 4.5', '.ops .fnote{color:#777777}', /\.ops \.fnote \(light\): #777777/],
  ['a value the sweep cannot evaluate', '.ops .fnote{color:gray}', /«gray» cannot be evaluated/],
];
for (const [label, add, why] of MUTANTS) {
  test(`AA sweep mutant dies: ${label}`, () => {
    assert.throws(() => sweepOps(`${css}\n${add}\n`), (e) => why.test(`${e.message}\n${JSON.stringify(e.actual ?? '')}`));
  });
}
test('a passing literal and a passing theme-prefixed rule are evaluated, not just tolerated', () => {
  const add = ':root[data-theme="light"] .ops .fnote{color:#000} :root[data-theme="dark"] .ops .fnote{color:#FFFFFF}';
  const { found } = sweepOps(`${css}\n${add}\n`);
  assert.ok(found.some((f) => f.colour === '#000' && f.themes.join() === 'light' && f.key === '.ops .fnote'));
  assert.ok(found.some((f) => f.colour === '#FFFFFF' && f.themes.join() === 'dark' && f.key === '.ops .fnote'));
});
