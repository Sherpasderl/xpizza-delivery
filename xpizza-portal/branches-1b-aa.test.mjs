// PORTAL-UI 1b — AA contrast of every 1b text class in BOTH themes (AA gate 2026-10-26). portal-look's discovering sweep is
// light-mode only; this test reads the REAL token blocks (light :root, dark [data-theme="dark"], and the prefers-color-scheme
// copy, which must equal the explicit dark block) and the REAL 1b rules from styles.css. For each text class it takes the
// rule's declared `color` token, pairs it with the surface the element sits on (declared `background`, else the named
// container surface), and requires ≥ 4.5:1 in light AND dark. A rule whose colour drifts from the table fails here first.
// 1a follow-up (2026-10-26): the same sweep covers every 1a `.ops` / `.drawer.ops` text rule, and a completeness check
// discovers those rules from styles.css so a new one cannot land outside the table.
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
// 1a text rules: [selector, surface token it sits on when the rule declares no background]
const TEXT_1A = [
  ['.ops .card', null], ['.ops .cmeta', 'card'], ['.ops .cmeta b', 'card'], ['.ops .callout', null], ['.ops .callout b', 'amber-soft'],
  ['.ops .errbox b,#detail .errbox b', 'red-soft'], ['.ops .errbox p,#detail .errbox p', 'red-soft'], ['.ops .crumb', 'board'],
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

test('every 1b text class clears 4.5:1 in light AND dark (dark --mute2 on --card is 4.46 — small text uses --mute)', () => {
  sweep(TEXT);
  // non-vacuity: the pair the gate found really fails, and the swap really passes
  assert.ok(ratio(DARK.mute2, DARK.card) < 4.5 && ratio(DARK.mute, DARK.card) >= 4.5 && ratio(LIGHT.mute, LIGHT.card) >= 4.5);
});

test('every 1a .ops / .drawer.ops text rule clears 4.5:1 in light AND dark (1a follow-up: .hint, .fld .lab, .fnote → --mute)', () => {
  sweep(TEXT_1A);
});

test('the 1a table is complete: every non-1b .ops / .drawer.ops rule that sets a text colour is swept', () => {
  const found = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!/^\.(drawer\.)?ops\b/.test(sel) || /1b|#sucmodal|:hover|@/.test(sel)) continue;
    if (/(?:^|;)\s*color:\s*var\(--/.test(m[2])) found.push(sel);
  }
  assert.ok(found.length >= 20, 'non-vacuity: the 1a rules were discovered');
  assert.deepEqual([...found].sort(), TEXT_1A.map(([sel]) => sel).sort());
});
