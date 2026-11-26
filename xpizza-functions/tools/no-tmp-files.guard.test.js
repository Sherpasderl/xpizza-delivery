'use strict';
// Codex #424: a temporary file (*.tmp.js, e.g. a test's prior-release copy) is NEVER part of the tracked tree. RED if git tracks one.
// Run: node tools/no-tmp-files.guard.test.js
const assert = require('assert');
const { execFileSync } = require('child_process');
// the WHOLE repository (`:(top,glob)`): a pathspec relative to this file's directory would only see tools/ (the first version's bug)
const tracked = execFileSync('git', ['ls-files', '--', ':(top,glob)**/*.tmp.js', ':(top,glob)**/*.tmp.json', ':(top,glob)*.tmp.js'], { cwd: __dirname, encoding: 'utf8' }).split('\n').filter(Boolean);
assert.deepStrictEqual(tracked, [], `🔴 NO-TMP-TRACKED: temporary files are tracked: ${tracked.join(', ')}`);
console.log('no-tmp-files.guard: OK (1)');
