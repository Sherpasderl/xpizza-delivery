// A peer lane's functions tree at a PINNED ref, read-only, as `git archive` writes it — the functions tree + the two order forms its
// seed reads (catalog/form-menu-source.js) — in a temp dir (node_modules linked), removed at exit. The MC_REF / S4_REF pattern (Inicio
// S2 / S3, «Tu nivel»). NOT a test file, NOT served. ASSEMBLY: real-backend.mjs's s4Snapshot (feat/portal-structure-s3-ui) is the same
// helper — fold the two into one when those branches meet.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export function refTree(ref) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'portal-ref-'));
  execFileSync('tar', ['-x', '-C', dir], { input: execFileSync('git', ['archive', '--format=tar', ref, 'xpizza-functions', 'xpizza-orders/index.html', 'la-musa-orders/index.html'], { cwd: repo, maxBuffer: 1 << 28 }) });
  symlinkSync(join(repo, 'xpizza-functions', 'node_modules'), join(dir, 'xpizza-functions', 'node_modules'));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  return createRequire(join(dir, 'xpizza-functions', 'package.json'));
}
