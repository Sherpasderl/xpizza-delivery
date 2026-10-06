'use strict';
// RAW-LINE allowlists for deploy instructions and force-flag lines (codex stats build r6; advisor ruling).
//   node tools/deploy-instruction-scan.test.js
// The strings in this file are scanner FIXTURES (excluded from the repo scan by deploy-instruction-scan.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanText, scanRepo, trackedFiles, FIXTURES } = require('./deploy-instruction-scan');
const { DEPLOY_LINES, FORCE_LINES } = require('./deploy-instruction-pins');
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const REPO = path.join(__dirname, '..', '..');
const FORCE = /--force/;
const REASONS = new Set(['enforcement code', 'Firebase source contract', 'non-deploy firebase command']);
const key = (file, text) => `${file}\u0000${text}`;
const multiset = (pins) => new Map(pins.map((p) => [key(p.file, p.text), p.count]));
const DPIN = multiset(DEPLOY_LINES), FPIN = multiset(FORCE_LINES);

// Violations for ONE file's text against the pins (the same rules the repo cell applies).
function violations(file, text) {
  const { deploy, force } = scanText(text);
  const out = [];
  const tally = (list, pins, kind) => {
    const seen = new Map();
    for (const x of list) seen.set(x.text, (seen.get(x.text) || 0) + 1);
    for (const x of list) if (!pins.has(key(file, x.text))) out.push(`${kind} ${file}:${x.line} NOT PINNED  ${x.text}`);
    for (const [t, c] of seen) if (pins.has(key(file, t)) && pins.get(key(file, t)) < c) out.push(`${kind} ${file} count ${c} > pinned ${pins.get(key(file, t))}  ${t}`);
  };
  tally(deploy, DPIN, 'deploy');
  for (const d of deploy) if (FORCE.test(d.text)) out.push(`FORCE ON A DEPLOY LINE ${file}:${d.line}  ${d.text}`);
  tally(force.filter((f) => !deploy.some((d) => d.line === f.line)), FPIN, 'force');
  return out;
}

// 1. 🔴 THE REPO'S DEPLOY LINES EQUAL THE PINS EXACTLY (raw text, counts) — new / changed / moved → file:line;
//    stale pin → fail; the force flag on ANY deploy line → fail OUTRIGHT (and no pin carries it).
{
  const r = scanRepo(REPO);
  assert(r.text > 500, `premise: git ls-files covered the repo (${r.text} text files, ${r.binary} binary skipped)`);
  const fresh = [];
  const seen = new Map();
  for (const d of r.deploy) {
    const k = key(d.file, d.text);
    seen.set(k, (seen.get(k) || 0) + 1);
    if (!DPIN.has(k)) fresh.push(`${d.file}:${d.line}  ${d.text}`);
    if (FORCE.test(d.text)) fresh.push(`FORCE ON A DEPLOY LINE ${d.file}:${d.line}  ${d.text}`);
  }
  for (const [k, c] of seen) if (DPIN.has(k) && DPIN.get(k) !== c) { const [f, t] = k.split('\u0000'); fresh.push(`${f}  count ${c} ≠ pinned ${DPIN.get(k)}  ${t}`); }
  const stale = DEPLOY_LINES.filter((p) => !seen.has(key(p.file, p.text))).map((p) => `${p.file}  ${p.text}`);
  for (const p of DEPLOY_LINES) assert(!FORCE.test(p.text), `a DEPLOY pin carries the force flag: ${p.file}  ${p.text}`);
  assert.deepStrictEqual(fresh, [], `🔴 deploy lines NOT on the pinned allowlist (review, then pin in tools/deploy-instruction-pins.js):\n  ${fresh.join('\n  ')}`);
  assert.deepStrictEqual(stale, [], `🔴 stale DEPLOY pins (the line is gone or changed):\n  ${stale.join('\n  ')}`);
  ok(`${r.deploy.length} raw deploy lines across ${r.text} tracked text files (${r.binary} binary skipped) == the ${DEPLOY_LINES.length} pins exactly; no force flag on any deploy line`);
}

// 2. 🔴 EVERY OTHER FORCE-FLAG LINE EQUALS A REVIEWED FORCE PIN, with a valid reason.
{
  const r = scanRepo(REPO);
  const deployAt = new Set(r.deploy.map((d) => `${d.file}:${d.line}`));
  const fresh = [];
  const seen = new Map();
  for (const f of r.force) {
    if (deployAt.has(`${f.file}:${f.line}`)) continue;   // a deploy line — cell 1 already fails it outright
    const k = key(f.file, f.text);
    seen.set(k, (seen.get(k) || 0) + 1);
    if (!FPIN.has(k)) fresh.push(`${f.file}:${f.line}  ${f.text}`);
  }
  for (const [k, c] of seen) if (FPIN.has(k) && FPIN.get(k) !== c) { const [f, t] = k.split('\u0000'); fresh.push(`${f}  count ${c} ≠ pinned ${FPIN.get(k)}  ${t}`); }
  const stale = FORCE_LINES.filter((p) => !seen.has(key(p.file, p.text))).map((p) => `${p.file}  ${p.text}`);
  for (const p of FORCE_LINES) assert(REASONS.has(p.reason), `${p.file}: unknown reason "${p.reason}"`);
  assert.deepStrictEqual(fresh, [], `🔴 force-flag lines NOT on the reviewed FORCE_LINES pins:\n  ${fresh.join('\n  ')}`);
  assert.deepStrictEqual(stale, [], `🔴 stale FORCE pins:\n  ${stale.join('\n  ')}`);
  const by = FORCE_LINES.reduce((a, p) => { a[p.reason] = (a[p.reason] || 0) + p.count; return a; }, {});
  ok(`every force-flag line is a reviewed pin (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')})`);
}

// 3. SCOPE: every tracked file, NO extension list (Makefile / deploy.bash / deploy.ts are scanned like any
//    other), binaries skipped by NUL; exclusions are exactly the three fixture files.
{
  const tracked = trackedFiles(REPO);
  // No extension list: tracked text files with extensions the OLD scanner never read (e.g. firestore.rules, .css)
  // are in scope — proven by scanning them for a line.
  const OLD_EXT = /\.(md|js|mjs|cjs|json|sh|txt|html|yml|yaml|toml)$/;
  const others = tracked.filter((f) => !OLD_EXT.test(f) && !/\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|aab|apk|jar|zip)$/i.test(f));
  assert(tracked.includes('xpizza-functions/firestore.rules') && others.length > 5, `premise: tracked text files outside the old extension list exist (${others.length})`);
  assert(scanRepo(REPO, { files: ['xpizza-functions/firestore.rules'] }).text === 1, 'a .rules file is scanned (no extension filter)');
  assert.deepStrictEqual([...FIXTURES].sort(), ['xpizza-functions/tools/deploy-instruction-pins.js', 'xpizza-functions/tools/deploy-instruction-scan.test.js', 'xpizza-functions/tools/mutation-sweep.mutants.json']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployscan-'));
  fs.writeFileSync(path.join(dir, 'Makefile'), 'release:\n\tfirebase deploy --only firestore:indexes\n');
  fs.writeFileSync(path.join(dir, 'deploy.bash'), '#!/bin/bash\nnpx firebase-tools deploy --only firestore --project x\n');
  fs.writeFileSync(path.join(dir, 'deploy.ts'), 'await exec(`firebase deploy --only firestore:indexes`);\n');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x66, 0x69, 0x72, 0x65, 0x00, 0x64, 0x65, 0x70, 0x6c, 0x6f, 0x79]));
  const r = scanRepo(dir, { files: ['Makefile', 'deploy.bash', 'deploy.ts', 'blob.bin'] });
  assert.deepStrictEqual(r.deploy.map((d) => d.file).sort(), ['Makefile', 'deploy.bash', 'deploy.ts']);
  assert.strictEqual(r.binary, 1, 'a NUL-bearing file is skipped as binary');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('scope = git ls-files (no extension list): Makefile / deploy.bash / deploy.ts scanned; NUL files skipped; exclusions = the 3 fixtures');
}

// 4. 🔴 FIXTURES — every codex r6 and r5 evasion, and the force-line cases, are CAUGHT.
{
  const F = 'docs/some-runbook.md';
  const pinnedFile = 'README.md';
  const pinnedLine = DEPLOY_LINES.find((p) => p.file === pinnedFile && /firebase deploy --only functions/.test(p.text));
  assert(pinnedLine, 'premise: README carries a pinned functions deploy line');
  const cases = {
    // codex r6
    'r6-1a: pinned command changed via `,\\` continuation': [pinnedFile, pinnedLine.text.replace('--only functions', '--only functions,\\') + '\nfirestore:indexes'],
    "r6-1b: pinned command gains '--force'": [pinnedFile, pinnedLine.text.replace('--only functions', "--only functions '--force'")],
    'r6-2: `// firebase` then `// deploy --only firestore:indexes`': [F, '// firebase\n// deploy --only firestore:indexes\n'],
    'r6-3: npx firebase-tools deploy': [F, 'npx firebase-tools deploy --only firestore --project xpizza-delivery\n'],
    'r6-4a: Makefile': ['Makefile', 'release:\n\tfirebase deploy --only firestore:indexes\n'],
    'r6-4b: deploy.bash': ['scripts/deploy.bash', 'firebase deploy --only firestore\n'],
    'r6-4c: deploy.ts': ['tools/deploy.ts', "execSync('firebase deploy --only firestore:indexes');\n"],
    // r5
    'r5: shell \\ continuation': [F, 'firebase deploy \\\n  --only firestore:indexes --project xpizza-delivery\n'],
    'r5: comment-wrapped': [F, '// Deploy with firebase deploy\n// --only firestore:indexes --project xpizza-delivery\n'],
    'r5: continued target list': [F, 'firebase deploy --only functions,\nfirestore:indexes\n'],
    'r5: value wrapped after --only': [F, '`firebase deploy --only\nfirestore:indexes`\n'],
    'r5: -P before the verb': [F, 'firebase -P xpizza-delivery deploy --only firestore:indexes\n'],
    'r5: bare deploy borrowing the next scope': [F, 'firebase deploy && firebase deploy --only firestore:rules\n'],
    "r5: the wrapper's command + force": ['xpizza-functions/tools/deploy-indexes.js', '//   = firebase deploy --only firestore:indexes --non-interactive --force --project <pinned-and-checked>\n'],
    'r5: a new harmless functions deploy line': [F, 'then: firebase deploy --only functions:somethingNew --project xpizza-delivery\n'],
    // force lines (approved r6 addendum)
    'force: a NEW force line in a non-deploy file': ['scripts/cleanup.sh', 'echo "firebase database:remove /x --project xpizza-delivery --force"\n'],
    'force: a CHANGED pinned force-line': [FORCE_LINES.find((p) => p.file === 'test-order.sh').file, FORCE_LINES.find((p) => p.file === 'test-order.sh').text.replace('/orders/', '/payments/')],
  };
  for (const [label, [file, text]] of Object.entries(cases)) {
    const v = violations(file, text);
    assert(v.length > 0, `${label}: NOT caught`);
  }
  // r6-1b is failed OUTRIGHT as a force-on-deploy line, not merely as "unpinned"
  assert(violations(pinnedFile, cases["r6-1b: pinned command gains '--force'"][1]).some((x) => /^FORCE ON A DEPLOY LINE/.test(x)));
  // r6-2: the deploy word on the line BELOW `firebase` is a deploy line (the 3-line window)
  assert.deepStrictEqual(scanText('// firebase\n// deploy --only firestore:indexes\n').deploy.map((d) => d.line), [2]);
  ok(`all ${Object.keys(cases).length} fixtures caught: codex r6 (1)–(4), every r5 evasion, a new force line, a changed pinned force-line`);
}

// 5. Each PINNED line passes, byte-for-byte, in its own file (and trailing whitespace alone is not a change).
{
  for (const p of DEPLOY_LINES) assert.deepStrictEqual(violations(p.file, `${p.text}   \r\n`), [], `${p.file}: its pinned deploy line was not recognised`);
  for (const p of FORCE_LINES) {
    const { deploy } = scanText(p.text);
    if (deploy.length) continue;   // (none expected — cell 1 forbids force on deploy lines)
    assert.deepStrictEqual(violations(p.file, p.text), [], `${p.file}: its pinned force line was not recognised`);
  }
  ok(`every pinned line (${DEPLOY_LINES.length} deploy + ${FORCE_LINES.length} force) passes in its own file; only trailing whitespace is ignored`);
}
console.log(`\ndeploy-instruction-scan: ${n} cells passed`);
__finished = true;
