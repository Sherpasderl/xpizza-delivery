'use strict';
// The PINNED ALLOWLIST of deploy instructions (codex stats build r5; advisor ruling). Run:
//   node tools/deploy-instruction-scan.test.js
// The strings in this file are scanner FIXTURES (excluded from the repo scan by deploy-instruction-scan.js).
const assert = require('assert');
const path = require('path');
const { occurrences, scanRepo } = require('./deploy-instruction-scan');
const { classify } = require('./deploy-instruction-classify');
const { PINS } = require('./deploy-instruction-pins');
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const REPO = path.join(__dirname, '..', '..');
const SANCTIONED = new Set(['xpizza-functions/tools/deploy-indexes.js', 'xpizza-functions/tools/firebase-cli-nodelete.js', 'xpizza-functions/tools/firestore-indexes-report.js']);
const key = (file, command) => `${file}\u0000${command}`;
const pinCount = new Map(PINS.map((p) => [key(p.file, p.command), p.count]));
const unpinned = (file, text) => occurrences(text).filter((o) => !pinCount.has(key(file, o.command)));

// 1. 🔴 THE REPO'S OCCURRENCES EQUAL THE PINS EXACTLY — new or changed → fail with file + line; stale pin → fail.
{
  const { hits, files } = scanRepo(REPO);
  assert(files > 300, `premise: the scan covered the repo (${files} files)`);
  const seen = new Map();
  const fresh = [];
  for (const h of hits) {
    const k = key(h.file, h.command);
    seen.set(k, (seen.get(k) || 0) + 1);
    if (!pinCount.has(k)) fresh.push(`${h.file}:${h.line}  ${h.command}`);
    if (classify(h.command) === 'FORBIDDEN') fresh.push(`${h.file}:${h.line}  FORBIDDEN  ${h.command}`);
  }
  for (const [k, c] of seen) if (pinCount.has(k) && pinCount.get(k) !== c) { const [f, cmd] = k.split('\u0000'); const lines = hits.filter((h) => h.file === f && h.command === cmd).map((h) => h.line); fresh.push(`${f}:${lines.join(',')}  count ${c} ≠ pinned ${pinCount.get(k)}  ${cmd}`); }
  const stale = PINS.filter((p) => !seen.has(key(p.file, p.command))).map((p) => `${p.file}  ${p.command}`);
  assert.deepStrictEqual(fresh, [], `🔴 deploy instructions NOT on the pinned allowlist (review, then pin in tools/deploy-instruction-pins.js):\n  ${fresh.join('\n  ')}`);
  assert.deepStrictEqual(stale, [], `🔴 stale pins (the instruction is gone — remove the pin):\n  ${stale.join('\n  ')}`);
  ok(`${hits.length} deploy-instruction occurrences across ${files} files == the ${PINS.length} pinned entries exactly`);
}

// 2. Every pin's class is RE-DERIVED from its command; nothing FORBIDDEN is pinned; the wrapper's documented
//    command appears only in its three own files; --force appears in no pin.
{
  for (const p of PINS) {
    assert.strictEqual(classify(p.command), p.class, `${p.file}: pinned as ${p.class} but the command classifies as ${classify(p.command)}`);
    assert.notStrictEqual(p.class, 'FORBIDDEN');
    assert(!/--force/.test(p.command), `${p.file}: --force in a pin`);
    if (p.class === 'wrapper-doc') assert(SANCTIONED.has(p.file), `${p.file}: the wrapper's command outside its own files`);
  }
  for (const f of SANCTIONED) assert(PINS.some((p) => p.file === f && p.class === 'wrapper-doc'), `${f} carries its exact documented command pin`);
  const counts = PINS.reduce((a, p) => { a[p.class] = (a[p.class] || 0) + p.count; return a; }, {});
  ok(`every pin's class re-derived (${Object.entries(counts).map(([c, k]) => `${c} ${k}`).join(', ')}); no FORBIDDEN, no --force; wrapper-doc only in its 3 files`);
}

// 3. Classifier: --force fails OUTRIGHT (even on the wrapper's own command); every forbidden shape is FORBIDDEN.
{
  assert.strictEqual(classify('firebase deploy --only firestore:indexes --non-interactive --project <pinned>'), 'wrapper-doc');
  assert.strictEqual(classify('firebase deploy --only firestore:indexes --non-interactive --force --project x'), 'FORBIDDEN');
  assert.strictEqual(classify('firebase deploy --only functions --force'), 'FORBIDDEN');
  assert.strictEqual(classify('firebase deploy --only firestore:indexes --project x'), 'FORBIDDEN', 'without --non-interactive');
  assert.strictEqual(classify('firebase deploy --only firestore'), 'FORBIDDEN');
  assert.strictEqual(classify('firebase deploy --only functions,firestore'), 'FORBIDDEN');
  assert.strictEqual(classify('firebase deploy --project x'), 'FORBIDDEN', 'flags without --only deploy everything');
  assert.strictEqual(classify('firebase deploy --only firestore:rules'), 'rules-only');
  assert.strictEqual(classify('firebase deploy --only functions:a,functions:b --project x'), 'functions-only');
  assert.strictEqual(classify('firebase deploy --only database'), 'hosting-database');
  assert.strictEqual(classify('firebase deploy'), 'mention');
  ok('classifier: --force FORBIDDEN outright (incl. on the wrapper\'s command); bare firestore / indexes-outside-wrapper / no --only FORBIDDEN');
}

// 4. 🔴 EVERY CODEX EVASION IS CAUGHT — each yields an occurrence that is not on the allowlist (or FORBIDDEN).
{
  const F = 'docs/some-runbook.md';
  const evasions = {
    'shell \\ continuation before --only': 'run:\n  firebase deploy \\\n    --only firestore:indexes --project xpizza-delivery\n',
    'comment-wrapped command': '// Deploy with firebase deploy\n// --only firestore:indexes --project xpizza-delivery\n',
    'continued target list': 'firebase deploy --only functions,\nfirestore:indexes\n',
    'value wrapped after --only': '`firebase deploy --only\nfirestore:indexes`\n',
    'short -P flag before the verb': 'firebase -P xpizza-delivery deploy --only firestore:indexes\n',
    'borrowing the NEXT command\'s scope': 'firebase deploy && firebase deploy --only firestore:rules\n',
    'the wrapper\'s documented command with --force': '//   = firebase deploy --only firestore:indexes --non-interactive --force --project x\n',
    'a NEW, otherwise harmless functions deploy line': 'then: firebase deploy --only functions:somethingNew --project xpizza-delivery\n',
  };
  for (const [label, text] of Object.entries(evasions)) {
    const occ = occurrences(text);
    assert(occ.length >= 1, `${label}: no occurrence found — the scanner is blind to it`);
    const caught = unpinned(F, text).length > 0 || occ.some((o) => classify(o.command) === 'FORBIDDEN');
    assert(caught, `${label}: NOT caught (${JSON.stringify(occ)})`);
  }
  // and the specific normalizations produce the exact command
  assert.deepStrictEqual(occurrences(evasions['shell \\ continuation before --only']).map((o) => o.command), ['firebase deploy --only firestore:indexes --project xpizza-delivery']);
  assert.deepStrictEqual(occurrences(evasions['comment-wrapped command']).map((o) => o.command), ['firebase deploy --only firestore:indexes --project xpizza-delivery']);
  assert.deepStrictEqual(occurrences(evasions['continued target list']).map((o) => o.command), ['firebase deploy --only functions,firestore:indexes']);
  assert.deepStrictEqual(occurrences(evasions['short -P flag before the verb']).map((o) => o.command), ['firebase -P xpizza-delivery deploy --only firestore:indexes']);
  assert.deepStrictEqual(occurrences(evasions['borrowing the NEXT command\'s scope']).map((o) => o.command), ['firebase deploy', 'firebase deploy --only firestore:rules'], 'the first command is BARE — it never borrows the second\'s --only');
  ok(`all ${Object.keys(evasions).length} codex evasion shapes are caught (unpinned or FORBIDDEN), with exact normalization`);
}

// 5. Each PINNED form passes, in its own file — and prose boundaries do not leak into a command.
{
  for (const p of PINS) {
    const text = `see \`${p.command}\` for details\n`;
    assert.deepStrictEqual(unpinned(p.file, text), [], `${p.file}: its pinned command was not recognised as pinned`);
  }
  assert.deepStrictEqual(occurrences('`firebase deploy --only functions` (adds the triggers)').map((o) => o.command), ['firebase deploy --only functions']);
  assert.deepStrictEqual(occurrences('firebase deploy --only firestore:indexes --non-interactive, never --force').map((o) => o.command), ['firebase deploy --only firestore:indexes --non-interactive']);
  assert.deepStrictEqual(occurrences('firebase.json deploy source; firebase-tools deploy').length, 0, 'firebase.json / firebase-tools are not the CLI');
  ok('every pinned form passes in its own file; prose ` (` and `, ` end a command; firebase.json is not the CLI');
}
console.log(`\ndeploy-instruction-scan: ${n} cells passed`);
__finished = true;
