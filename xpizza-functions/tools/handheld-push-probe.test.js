'use strict';
const assert = require('assert');
const { parseArgs, buildProbeMessage } = require('./handheld-push-probe');
let n = 0; const ok = (m) => console.log(`  ✓ ${++n} ${m}`);
const T = 'x'.repeat(40);

assert.deepStrictEqual(parseArgs(['--project', 'xpizza-delivery', '--token', T, '--trial', 'c']), { project: 'xpizza-delivery', token: T, trial: 'c' });
ok('parses the three required arguments');
const { execFileSync } = require('child_process');
const path = require('path');
for (const args of [['--token', T, '--trial', 'a'], ['--project', 'lamusa-social', '--token', T, '--trial', 'a']]) {
  let code = 0; let out = '';
  try { execFileSync(process.execPath, [path.join(__dirname, 'handheld-push-probe.js'), ...args], { encoding: 'utf8', env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/never', GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: '' } }); }
  catch (e) { code = e.status; out = `${e.stdout || ''}${e.stderr || ''}`; }
  assert.strictEqual(code, 2, `${args.join(' ')} → exit 2`); assert.match(out, /project_guard_refused/);
}
ok('no --project / a wrong project → refused by require-project (exit 2), before any client exists');
assert.throws(() => parseArgs(['--project', 'p', '--trial', 'a']), /--token/);
assert.throws(() => parseArgs(['--project', 'p', '--token', 'short', '--trial', 'a']), /--token/);
assert.throws(() => parseArgs(['--project', 'p', '--token', T, '--trial', 'e']), /--trial/);
assert.throws(() => parseArgs(['--project', '--token', T]), /needs a value/);
assert.throws(() => parseArgs(['--project', 'p', '--token', T, '--trial', 'a', '--dry']), /unknown argument/);
ok('missing / short token, unknown trial, a flag as a value, an unknown flag → refused');
const m = buildProbeMessage(T, 'b', 1760000000000);
assert.deepStrictEqual(m, { token: T, data: { type: 'probe', sent_at: '1760000000000', trial: 'b' }, android: { priority: 'high', ttl: 600000 } });
assert.ok(Object.values(m.data).every((v) => typeof v === 'string'), 'FCM data values are strings');
assert.ok(!('notification' in m), 'data-only');
ok('a data-only, high-priority message: {type: probe, sent_at, trial} as strings; no order or brand data');
console.log(`\nhandheld-push-probe: OK (${n})`);
