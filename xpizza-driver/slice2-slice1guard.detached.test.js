// slice2-slice1guard.detached.test.js — compose slice 1's freeze guard WITHOUT modifying it (Codex P2-6/r2).
// Run: `node slice2-slice1guard.detached.test.js`  (ESM, no framework — repo idiom).
//
// slice1-freeze.guard reads the CURRENT disk, strips only the SLICE1:* regions, and rejects files outside
// its historical allowlist (slice1-freeze.guard.test.js:144/186) — so it CANNOT run against the slice-2
// working tree (the slice-2 files + SLICE2 regions would turn it RED). Pinning its baseline does not fix
// that. The honest composition is to run slice 1's guard UNCHANGED, against slice 1's OWN tree, at the
// immutable landed slice-1 SHA — in a DETACHED git worktree checked out at that SHA.
//
// A `git archive | tar -x` dump does NOT work: the guard calls `git rev-parse --show-toplevel` and
// `git diff --name-status <baseline>` / `git show <baseline>:…` (guard:77/169), so it needs a REAL git repo
// with the baseline object (eac09cdd) reachable — which it is, in a detached worktree sharing this repo's
// object store. Passing there proves slice 1's own baseline relationship is intact at the SHA slice 2
// builds on, so slice 2's restoration proof (equals this SHA byte-for-byte) preserves slice 1 transitively.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));

// The landed slice-1 SHA slice 2 builds on (PROXY base = ff045243 + the 2e re-pin). Re-pinned to the true
// landed main SHA after slice 1 ships (same value as slice2-freeze.guard's BASELINE; stated in hand-back).
const LANDED = 'e2266b24';
// slice 1's guard freezes against this (it is reachable from LANDED's history, and in the shared object store).
const SLICE1_BASELINE = 'eac09cdd';

// The slice-1 freeze guard this composes, as a repo-relative path. Taken from argv so the npm chain can NAME
// it (slice 2 UNWIRES the direct `node slice1-freeze.guard.test.js` chain line — that guard cannot pass on the
// slice-2 tree by construction — and re-homes it here; naming the path keeps it honestly reachable for
// no-code-authority.guard). Defaults to the slice-1 guard when run bare.
const GUARD_REL = (process.argv[2] || 'xpizza-driver/slice1-freeze.guard.test.js').replace(/^(?:\.\.\/)+/, '');
const GUARD_NAME = GUARD_REL.split('/').pop();

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dir }).toString('utf8').trim();
const gitStr = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

t('the slice-1 baseline (eac09cdd) is reachable from the shared object store', () => {
  const sha = gitStr('rev-parse', '--verify', `${SLICE1_BASELINE}^{commit}`).trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
});

t('eac09cdd is an ancestor of the landed slice-1 SHA (the detached worktree can diff against it)', () => {
  // merge-base --is-ancestor exits 0 iff reachable.
  let ok = true;
  try { execFileSync('git', ['merge-base', '--is-ancestor', SLICE1_BASELINE, LANDED], { cwd: REPO }); }
  catch { ok = false; }
  assert.ok(ok, `${SLICE1_BASELINE} must be an ancestor of ${LANDED}`);
});

t('slice1-freeze.guard passes UNCHANGED in a DETACHED worktree checked out at the landed slice-1 SHA', () => {
  const wt = mkdtempSync(join(tmpdir(), 'slice2-s1guard-'));
  try {
    // Detached worktree at the landed SHA — shares this repo's objects, so eac09cdd resolves.
    execFileSync('git', ['worktree', 'add', '--detach', wt, LANDED], { cwd: REPO, stdio: 'pipe' });
    const guard = join(wt, GUARD_REL);
    assert.ok(existsSync(guard), `${GUARD_NAME} must exist at the landed SHA`);
    // Run slice 1's guard verbatim inside its own tree. Non-zero exit throws → this test fails.
    const out = execFileSync('node', [guard], { cwd: join(wt, GUARD_REL.split('/').slice(0, -1).join('/')), encoding: 'utf8', stdio: 'pipe' });
    const okRe = new RegExp(`${GUARD_NAME.replace('.test.js', '').replace(/[.]/g, '\\.')}: \\d+ checks passed`);
    assert.match(out, okRe, `slice 1 guard output unexpected:\n${out}`);
  } finally {
    // Always detach + remove the temp worktree (force: it is unmodified, but be robust to a failed run).
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: REPO, stdio: 'pipe' }); }
    catch { try { rmSync(wt, { recursive: true, force: true }); execFileSync('git', ['worktree', 'prune'], { cwd: REPO }); } catch {} }
  }
});

console.log(`✓ slice2-slice1guard.detached: ${passed} checks passed (slice-1 guard verified at ${LANDED})`);
