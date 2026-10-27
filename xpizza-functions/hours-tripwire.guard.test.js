'use strict';
// S4 C′ G2 (PLAN-capp-S4-r5 §1 + r5.1 BC-1) — the BEST-EFFORT lexical hours tripwire. NOT a completeness guarantee (the Codex
// gate on every build is the backstop). Every hit must be in tools/hours-tripwire.allow.json (keyed by file + trimmed-line hash
// + OCCURRENCE), no allowlist entry may be stale, and allow ⊆ the FIXED baseline. Run: node hours-tripwire.guard.test.js
const assert = require('assert');
const fs = require('fs');
const T = require('./tools/hours-tripwire');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const PINS = T.loadPins();
const ALLOW = JSON.parse(fs.readFileSync(T.ALLOW, 'utf8'));
const BASE = JSON.parse(fs.readFileSync(T.BASELINE, 'utf8'));
const FILES = T.readFiles();
const evalFiles = (files, allow = ALLOW) => T.evaluate(T.scan(files, PINS), allow, BASE);

const live = evalFiles(FILES);
assert.deepStrictEqual(live, [], `🔴 hours tripwire:\n${live.join('\n')}`);
assert.ok(ALLOW.length > 0 && ALLOW.every((a) => typeof a.reason === 'string' && a.reason.trim()), 'every entry carries a reason');
ok(`LIVE: ${ALLOW.length} hits, all allowlisted with reasons; no stale entry; allow ⊆ fixed baseline`);

const withFile = (file, text) => FILES.filter((f) => f.file !== file).concat([{ file, text }]);
const edit = (file, fn) => { const f = FILES.find((x) => x.file === file); assert.ok(f, `fixture file ${file}`); return withFile(file, fn(f.text)); };
const fails = (files, re, label, allow) => { const b = evalFiles(files, allow); assert.ok(b.some((m) => re.test(m)), `${label}: expected a failure matching ${re}, got:\n${b.join('\n') || '(none)'}`); };

// MUTANTS (each must FAIL the guard)
const READ_LINE = "  const raw = identity && typeof identity === 'object' ? identity.hours : undefined;";
fails(edit('schedule/load-schedule.js', (t) => t.replace(READ_LINE, `${READ_LINE}\n  {\n${READ_LINE}\n  }`)), /new hours hit not in allowlist/, 'G2-MUT-DUPLICATE-IDENTICAL-READ (occurrence 2)');
fails(edit('pickup-label.js', (t) => t + "\nasync function x(db, rid) { return (await db.ref(`restaurants/${rid}/identity`).once('value')).val().hours; }\n"), /new hours hit not in allowlist/, 'G2-MUT-SECOND-READ-IN-ALLOWED-FILE');
fails(edit('schedule/load-schedule.js', (t) => t.replace(READ_LINE, '  const raw = undefined;').replace("module.exports", "const other = (id) => id['hours'];\nmodule.exports")), /new hours hit not in allowlist/, 'G2-MUT-EQUAL-COUNT-SUBSTITUTION');
fails(withFile('newfile.js', "const parseHM = (s) => { const m = /^(\\d{1,2}):(\\d{2})$/.exec(s); return m; };\n"), /new hours hit not in allowlist/, 'G2-MUT-COPIED-PARSEHM (R2)');
fails(withFile('brands/brand-extra.js', "const { DAYS } = require('./brand-model');\nconst HHMM_X = require('./x').HHMM;\nfunction v(h) {\n  for (const d of DAYS) {\n    if (!HHMM_X.test(h[d].start)) return false;\n  }\n}\n"), /new hours hit not in allowlist/, 'G2-MUT-VALIDATOR-COPY-REUSING-CONSTANTS (R5)');
fails(withFile('newreader.js', "async function readAll(db) {\n  const all = (await db.ref('restaurants').once('value')).val();\n  return Object.values(all).map((n) => n.identity);\n}\n"), /new hours hit not in allowlist/, 'G2-MUT-ANCESTOR-READ (R4)');
fails(edit('branches/branch-ops.js', (t) => t.replace("const { hours7Errors } = require('../schedule/hours-grammar');", "const HHMM = /^([01]\\d|2[0-3]):[0-5]\\d$/;\nfunction hours7Errors(h) { for (const d of DAYS) { if (!HHMM.test(h[d].start)) return ['x']; } return []; }")), /new hours hit not in allowlist/, 'G2-MUT-BRANCH-OPS-REIMPLEMENTS');
{   // SOURCE + ALLOWLIST substitution: add a new reader AND its allowlist entry → fails allow ⊆ baseline
  const files = withFile('newfile2.js', "const x = (id) => id.hours;\n");
  const hit = T.scan(files, PINS).find((h) => h.file === 'newfile2.js');
  fails(files, /allowlist entry not in the fixed baseline/, 'G2-MUT-SOURCE-PLUS-ALLOWLIST', ALLOW.concat([{ file: hit.file, line_sha256: hit.line_sha256, occurrence: hit.occurrence, reason: 'sneaky' }]));
}
fails(FILES, /stale allowlist entry/, 'G2-MUT-STALE-ENTRY', ALLOW.concat([{ ...ALLOW[0], occurrence: 99 }]));
ok('MUTANTS: duplicate identical read, second read in an allowed file, equal-count substitution, copied parseHM, validator copy reusing constants, ancestor read, branch-ops re-implementation, source+allowlist substitution, stale entry — each FAILS');
console.log(`\nhours-tripwire.guard: OK (${n})`);
