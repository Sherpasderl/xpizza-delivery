'use strict';
// R3 P1 §12 C2 — THE BINARY-BLINDNESS GUARD (static; npm test chain). A raw NUL makes plain `grep` treat a file as BINARY and
// silently drop its matching lines. This guard lists every TRACKED text source that contains a NUL — an exact reviewed list
// (file + byte offset) — and asserts that every P1 scanner's input set INCLUDES each of them (the census units, which the
// region inventory, the applicability bindings and the tracer all read by content). A new NUL-bearing source, a moved NUL,
// or a scanner that skips one → RED. P1 tooling never uses plain grep (it reads file contents directly).
// Run: node contract/binary-blindness.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sources } = require('./census');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-BINARY-BLIND ${m}`;
const REPO = path.join(__dirname, '..', '..');
const TEXT = /\.(c?js|mjs|ts|tsx|jsx|json|html?|css|md|txt|ya?ml|xml|svg|sh|rules|toml|gradle|kt|java|swift|plist|properties)$/i;
// the REVIEWED list (PLAN-R3-P1 §12 C2): a product finding for the advisor — removing it is a production edit
const REVIEWED = [{ file: 'xpizza-functions/catalog/publish-edited-handler.js', offset: 3215 }];

const env = { ...process.env }; delete env.NODE_OPTIONS;
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, env, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
const found = [];
for (const f of tracked) {
  if (!TEXT.test(f)) continue;
  let b; try { b = fs.readFileSync(path.join(REPO, f)); } catch (_) { continue; }
  const i = b.indexOf(0); if (i >= 0) found.push({ file: f, offset: i });
}
assert.deepStrictEqual(found, REVIEWED, FAIL(`the NUL-bearing tracked text sources changed:\n  found    ${JSON.stringify(found)}\n  reviewed ${JSON.stringify(REVIEWED)}`));
ok(`${tracked.filter((f) => TEXT.test(f)).length} tracked text sources read by content: exactly the reviewed NUL-bearing list (${REVIEWED.map((r) => `${r.file}@${r.offset}`).join(', ')})`);

const units = new Set(sources().map((u) => u.file));
const missing = REVIEWED.filter((r) => !units.has(r.file));
assert.deepStrictEqual(missing, [], FAIL(`a P1 scanner input set skips a NUL-bearing source: ${JSON.stringify(missing)}`));
const u = sources().find((x) => x.file === REVIEWED[0].file);
assert.ok(u && u.code.includes('\u0000') && u.code.split('\n').length > 46, FAIL('the census unit for the NUL-bearing source does not hold its full content'));
ok('every P1 scanner reads it: the census units (→ region inventory, applicability bindings, tracer) include it with its full content, NUL included');
// negatives (in memory, the same comparisons)
const differs = (a, b) => { try { assert.deepStrictEqual(a, b); return false; } catch (_) { return true; } };
assert.ok(differs([...found, { file: 'xpizza-kitchen/new.js', offset: 9 }], REVIEWED), FAIL('a new NUL-bearing source passed'));
assert.ok(differs([{ ...found[0], offset: found[0].offset + 1 }], REVIEWED), FAIL('a moved NUL passed'));
const skipping = new Set([...units].filter((f) => f !== REVIEWED[0].file));
assert.ok(REVIEWED.filter((r) => !skipping.has(r.file)).length === 1, FAIL('a scanner skipping the source passed'));
ok('negatives: a new NUL-bearing source, a moved NUL, a scanner input set skipping it → RED');
console.log(`\nr3-binary-blindness guard: OK (${n})`);
