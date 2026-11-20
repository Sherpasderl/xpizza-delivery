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

// 3) No amber HEX survives in the stylesheet (the exact retired amber values).
const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
for (const hex of ['#e7bd86', '#e9c877', '#fbf0ce', '#7a5b0c', '#edc292', '#8a6118', '#856410', '#f3ead0', '#eccf95', '#5a3d12', '#5a3c10']) {
  assert.ok(!style.toLowerCase().includes(hex), `the amber hex ${hex} is gone`);
}
ok('no retired amber hex value survives in the stylesheet');

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
assert.match(style, /\.ex\.amber \.exi \{ color: var\(--sand\); \}/, 'alert amber-severity band → sand');
ok('cue mapping: attention → sky, «Programado» → lavender, refund → ghost, caution → sand');

// 6) The mobile surface is no-amber too (same owner rule; the uniform look can't put an amber chip on mobile
// next to the pastel desktop).
{
  const mob = fs.readFileSync(path.join(__dirname, '..', 'xpizza-dispatch-mobile', 'index.html'), 'utf8');
  assert.ok(!/var\(--warn|var\(--sched|var\(--gold|var\(--btn-warn/.test(mob), 'mobile: no amber-family var() survives');
  for (const hex of ['#e7bd86', '#8a5a12', '#fbefdd', '#2e2413', '#e9c877', '#5a3c10']) {
    assert.ok(!mob.toLowerCase().includes(hex), `mobile: the amber hex ${hex} is gone`);
  }
  assert.ok((mob.match(/--sand:/g) || []).length >= 2, 'mobile: --sand defined in both themes');
  assert.match(mob, /\.mdra-act\.warn\{background:transparent;/, 'mobile: the warn action is a ghost outline');
  ok('mobile surface is no-amber (cash chip + warn cues on the pastel --sand pair)');
}

console.log(`dispatch-no-amber: OK (${n})`);
