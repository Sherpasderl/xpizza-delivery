'use strict';
// TEST-ONLY preload for branches/branch-races-runner.guard.test.js (Codex r2 P3): materializeBranch refuses immediately, so a gate
// in the race scenarios is never reached. The race runner must then FAIL loudly — never exit 0 with no output.
const S = require('../branches/branch-store');
S.materializeBranch = async () => ({ ok: false, error: 'probe_refused' });
