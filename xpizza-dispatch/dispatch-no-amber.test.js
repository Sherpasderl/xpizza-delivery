// xpizza-dispatch/dispatch-no-amber.test.js
//
// Polish §5 (owner rule: no amber / mustard chips — calm pastels only). The amber token family
// (--warn / --warn-soft / --warn-glow / --warn-fg, --sched-bg / --sched-fg / --gold, --btn-warn-*) is RETIRED:
// every caution cue re-maps to the pastel --sand pair, every attention cue to --info (sky), «Programado» to
// --primary (lavender), and the refund action to a ghost outline. This guard fails if any amber token, amber
// hex, or amber dot vocab comes back.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// 1) The amber token family is gone — no definitions, no var() references anywhere.
for (const tok of ['--warn', '--warn-soft', '--warn-glow', '--warn-fg', '--sched-bg', '--sched-fg', '--gold', '--btn-warn-bg', '--btn-warn-fg']) {
  assert.ok(!html.includes(`${tok}:`), `token ${tok} is no longer defined`);
  assert.ok(!html.includes(`var(${tok})`), `token ${tok} is no longer referenced`);
}
// a catch-all for any var(--warn* / --sched* / --gold* / --btn-warn*) we might have missed
assert.ok(!/var\(--warn|var\(--sched|var\(--gold|var\(--btn-warn/.test(html), 'no amber-family var() survives anywhere');
ok('the amber token family (--warn / --sched / --gold / --btn-warn) is fully retired');

// 2) The pastel sand pair replaced it (defined in BOTH themes).
assert.ok((html.match(/--sand:/g) || []).length >= 2, '--sand is defined in both themes');
assert.ok((html.match(/--sand-soft:/g) || []).length >= 2 && (html.match(/--sand-glow:/g) || []).length >= 2, '--sand-soft + --sand-glow defined in both themes');
ok('the --sand pastel pair is defined in both themes');

// 3) No amber HEX survives ANYWHERE in the file — the stylesheet, inline style attributes, OR script literals
// (Codex #245 P2-3: scan the whole file, not just the first <style> block; #b45309 is the map-marker amber).
const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const htmlLow = html.toLowerCase();
for (const hex of ['#e7bd86', '#e9c877', '#fbf0ce', '#7a5b0c', '#edc292', '#8a6118', '#856410', '#f3ead0', '#eccf95', '#5a3d12', '#5a3c10', '#b45309']) {
  assert.ok(!htmlLow.includes(hex), `the amber hex ${hex} is gone (whole file — style, inline, or script)`);
}
ok('no retired amber hex survives anywhere in the file (style + inline + script)');

// 4) The driver-dot vocab is pastel (idle-stale = sand, returning/assigned = sky), never amber.
const gdc = html.slice(html.indexOf('function getDotClass('), html.indexOf('function getDotClass(') + 700);
assert.match(gdc, /return 'sand';/, 'getDotClass: idle-stale → sand');
assert.match(gdc, /return 'sky';/, 'getDotClass: returning/assigned → sky');
assert.ok(!html.includes("dotClass = 'amber'") && !html.includes("return 'amber'"), 'no amber dot vocab anywhere');
assert.match(style, /\.status-dot\.sand\b/, '.status-dot.sand CSS exists');
assert.match(style, /\.status-dot\.sky\b/, '.status-dot.sky CSS exists');
ok('the driver-dot vocab is pastel sand/sky — no amber');

// 5) The approved cue mapping: attention → --info (sky), «Programado» → --primary (lavender), refund → ghost.
assert.match(style, /\.status-pill\.assigned \{ background: var\(--info-soft\); color: var\(--info\); \}/, 'assigned pill → sky (--info)');
assert.match(style, /\.comms-flag \{[^}]*color: var\(--info\); background: var\(--info-soft\)/, '«Sin atender» comms flag → sky (--info)');
assert.match(style, /\.recon-reason \{[^}]*color: var\(--info\)/, 'recon reason line → sky (--info)');
assert.match(style, /background: var\(--primary-soft\); color: var\(--primary\);/, '«Programado» badge → lavender (--primary)');
assert.match(style, /\.recon-btn\.refund \{ background: transparent; color: var\(--text\); border: 1px solid var\(--border\); \}/, 'refund action → ghost outline');
// and the caution cues landed on sand
assert.match(style, /\.tag\.risk\s+\{ color: var\(--sand\); background: var\(--sand-soft\); \}/, '«En riesgo» tag → sand');
ok('cue mapping: attention → sky, «Programado» → lavender, refund → ghost, caution → sand');

// 5b) Codex #245 P3: the amber-severity alert renders the .sand class (the amber class is gone), and the dead
// .tb-kpi / .tb-kpi.alert rules are removed (the KPI tiles went in §5).
assert.match(style, /\.ex\.sand \.exi \{ color: var\(--sand\); \}/, 'alert amber-severity → .ex.sand (pastel)');
assert.ok(!/\.ex\.amber\b/.test(style), 'the .ex.amber class is gone (renamed to .ex.sand)');
assert.match(html, /e\.severity === 'amber' \? 'sand'/, "the 'amber' severity renders the .sand class (the data key stays 'amber')");
assert.ok(!style.includes('.tb-kpi.alert') && !style.includes('.tb-kpi {') && !style.includes('.tb-kpi b'), 'the dead .tb-kpi / .tb-kpi.alert rules are removed');
ok('P3: amber severity → .sand class; dead .tb-kpi rules removed');

// 5c) Codex #245 P2-2: the desktop map markers read AA-dark sand/sky tokens (white initials need ≥4.5:1), no
// amber literal — same mapping as the roster dots.
assert.match(html, /--mk-stale: #[0-9a-f]{6}; --mk-move: #[0-9a-f]{6};/i, 'AA-dark marker tokens --mk-stale / --mk-move are defined');
const udm = html.slice(html.indexOf('function updateDriverMarkers('), html.indexOf('function updateDriverMarkers(') + 1600);
assert.match(udm, /color = MK_STALE;/, 'stale map marker → the sand token (not an amber literal)');
assert.match(udm, /color = MK_MOVE;/, 'returning/assigned map marker → the sky token');
ok('P2-2: map markers read the AA-dark sand/sky tokens, no amber literal');

// 6) The mobile surface is no-amber too (same owner rule; the uniform look can't put an amber chip on mobile
// next to the pastel desktop).
{
  const mob = fs.readFileSync(path.join(__dirname, '..', 'xpizza-dispatch-mobile', 'index.html'), 'utf8');
  assert.ok(!/var\(--warn|var\(--sched|var\(--gold|var\(--btn-warn/.test(mob), 'mobile: no amber-family var() survives');
  for (const hex of ['#e7bd86', '#8a5a12', '#fbefdd', '#2e2413', '#e9c877', '#5a3c10', '#b45309']) {
    assert.ok(!mob.toLowerCase().includes(hex), `mobile: the amber hex ${hex} is gone (whole file)`);
  }
  assert.match(mob, /\.mdra-act\.warn\{background:transparent;/, 'mobile: the warn action is a ghost outline');
  // Codex #245 P2-1: the mdra sheet is dark-always (background: var(--bg,#1c2027); mobile defines no --bg), so
  // its cues use FIXED dark-scheme sand — a theme-aware --sand would flip dark text onto the dark sheet in the
  // light OS theme. The orphaned mobile --sand tokens are removed; the cash chip (theme-aware surface) keeps --cash-*.
  assert.ok(!mob.includes('--sand'), 'mobile: the orphaned theme-aware --sand tokens are removed');
  assert.match(mob, /\.mdra-pill\.pend\{background:rgba\(207,198,184,\.16\);color:#cfc6b8\}/, 'mobile: mdra pending pill is fixed dark-scheme sand');
  assert.match(mob, /\.mdra-act\.warn\{background:transparent;color:#f1effa;/, 'mobile: «Suspender» uses fixed dark-scheme light text (not theme-aware --ink)');
  assert.match(mob, /--cash-ink:#6F6456|--cash-ink:#CFC6B8/i, 'mobile: the cash chip ink is sand (theme-aware surface), not amber');
  ok('mobile: no-amber (fixed dark-scheme sand on the dark mdra sheet; theme-aware --cash chip)');
}

// Codex #245 P2-1 cell — the mobile mdra admin controls stay ≥ 4.5:1 in BOTH OS themes. The mdra sheet is
// dark-always (background: var(--bg,#1c2027); mobile defines no --bg), so its cue foregrounds are fixed
// dark-scheme and their contrast over the sheet cannot drop when the OS theme flips. Computed from the values.
{
  const relLum = (hex) => {
    const v = hex.replace('#', '');
    const c = [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255).map(u => (u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [hi, lo] = [relLum(a), relLum(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
  const mob = fs.readFileSync(path.join(__dirname, '..', 'xpizza-dispatch-mobile', 'index.html'), 'utf8');
  assert.ok(!/--bg\s*:/.test(mob), 'mobile defines no --bg → the mdra sheet background is the same fixed fallback in BOTH OS themes');
  const sheetBg = (mob.match(/#mdra-sheet\{[^}]*background:var\(--bg,(#[0-9a-f]{6})\)/i) || [])[1];
  assert.ok(sheetBg, 'located the dark-always mdra sheet background');
  const pendFg = (mob.match(/\.mdra-pill\.pend\{[^}]*color:(#[0-9a-f]{6})\}/i) || [])[1];
  const suspFg = (mob.match(/\.mdra-act\.warn\{[^}]*color:(#[0-9a-f]{6})/i) || [])[1];
  for (const [name, fg] of [['pending pill', pendFg], ['«Suspender» button', suspFg]]) {
    assert.ok(fg, `located the ${name} foreground`);
    const r = ratio(fg, sheetBg);
    assert.ok(r >= 4.5, `${name}: ${r.toFixed(2)}:1 over the mdra sheet ≥ 4.5:1 (both OS themes — sheet bg is theme-independent)`);
  }
  ok('P2-1 cell: mdra pending pill + «Suspender» ≥ 4.5:1 on the dark-always sheet in both OS themes');
}

console.log(`dispatch-no-amber: OK (${n})`);
