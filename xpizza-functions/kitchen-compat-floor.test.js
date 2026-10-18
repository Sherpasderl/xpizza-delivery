'use strict';
// PLATFORM F2 Q2 (RUNBOOK-F2-Q3 §3, advisor ruling) — the kitchen compat generation is 2 for the Q2 KDS, so raising the kitchen
// floor to 2 moves every stamped KDS onto it:
//   - the Q2 kitchen folder, stamped by THIS commit's platform/stamp-version.js, reports generation 2 (version.json + the identity
//     <meta>), and its own kdsBelowFloor(2) is FALSE (it stays; an up-to-date page does not refresh);
//   - the b98cd04d kitchen folder, stamped by b98cd04d's OWN stamp script + compat.json, reports generation 1, and its own
//     kdsBelowFloor(2) is TRUE (it is told to refresh onto the new build).
// Each page's floor decision is its own inline kdsCompat / kdsBelowFloor, evaluated in a vm against the identity it was stamped
// with. Run: node kitchen-compat-floor.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-compat-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// a stamped kitchen folder: the working tree (Q2) or a past commit — each stamped by ITS OWN platform/ (stamp script + compat.json)
function stamped(label, rev) {
  const dir = path.join(TMP, label);
  fs.mkdirSync(dir, { recursive: true });
  if (rev) execFileSync('bash', ['-c', `git archive ${rev} xpizza-kitchen platform | tar -x -C ${dir}`], { cwd: ROOT });
  else {
    const files = execFileSync('git', ['ls-files', '--', 'xpizza-kitchen', 'platform'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const f of files) { const out = path.join(dir, f); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), out); }
  }
  execFileSync(process.execPath, [path.join(dir, 'platform', 'stamp-version.js')], { cwd: path.join(dir, 'xpizza-kitchen'), env: { ...process.env, SITE_NAME: 'xpizzakitchendisplay', COMMIT_REF: rev || 'q2', CONTEXT: 'production' }, stdio: 'pipe' });
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'xpizza-kitchen', 'version.json'), 'utf8'));
  const html = fs.readFileSync(path.join(dir, 'xpizza-kitchen', 'index.html'), 'utf8');
  const meta = /<meta name="app-compat" content="(\d+)">/.exec(html);   // sherpa-client readIdentity: compat = meta app-compat
  return { version, metaCompat: meta ? Number(meta[1]) : undefined, html };
}
// the page's OWN floor decision, run against the identity it was stamped with
function belowFloor(html, compat, floor) {
  const fn = (name) => { const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(html); assert.ok(m, `${name} found in the page`); return m[0]; };
  const ctx = { window: { SherpaClient: { inert: false, identity: { compat } } }, Number };
  vm.createContext(ctx);
  vm.runInContext(`${fn('kdsCompat')}\n${fn('kdsBelowFloor')}\nthis.__r = kdsBelowFloor(${floor});`, ctx);
  return ctx.__r;
}

const q2 = stamped('q2', null);
assert.strictEqual(q2.version.compat, 2, 'the Q2 kitchen build stamps generation 2 (platform/compat.json kitchen = 2)');
assert.strictEqual(q2.metaCompat, 2, 'its identity <meta> carries generation 2');
assert.strictEqual(belowFloor(q2.html, q2.metaCompat, 2), false, 'a generation-2 page under floor 2 does NOT refresh');
assert.strictEqual(belowFloor(q2.html, q2.metaCompat, 3), true, 'control: the same page under floor 3 would refresh');
ok('the Q2 kitchen build stamps generation 2 (version.json + <meta>); under floor 2 its own kdsBelowFloor is false — it stays');

const old = stamped('b98', 'b98cd04d');
assert.strictEqual(old.version.compat, 1, 'the b98cd04d kitchen build stamped generation 1');
assert.strictEqual(old.metaCompat, 1);
assert.strictEqual(belowFloor(old.html, old.metaCompat, 2), true, 'a generation-1 (b98cd04d) page under floor 2 is told to refresh');
assert.strictEqual(belowFloor(old.html, old.metaCompat, 1), false, 'control: under today\'s floor 1 it stays');
ok('the b98cd04d kitchen build stamps generation 1; under floor 2 its own kdsBelowFloor is true — it is forced to refresh onto the Q2 build');

assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'platform', 'compat.json'), 'utf8')).generations.kitchen, 2);
ok('platform/compat.json: kitchen = 2');
console.log(`kitchen-compat-floor: OK (${n})`);
