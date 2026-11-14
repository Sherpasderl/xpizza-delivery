# vclock chunk 1: evidence (PLAN-capp-virtual-clock r0 §4)

**Scope:** capp-s7a2 cells 1–46 in file order (directory, Inicio, Buscar, shell, location, browse-only, frames 10/11, return, Codex s7a2 r1, G2, stamp, G6).
- The cells are NAMED in the file's VIRTUAL list.
- 27 of them boot the shell (directly or through a helper) and now run on the virtual clock. The rest are pure or rig cells with no real waits.
- No cell line changed.

## 1. Assertion inventory
Command: `node review/capp-vclock/assert-inventory.mjs --diff customer-app/capp-s7a2.test.mjs <parent> <chunk-1 commit>`
- All 290 pre-existing tests, plus the shared helpers' 21 assertions, have IDENTICAL ordered assert lists (1,571 assertions).
- The only addition is the guard cell VC-M:
  - every VIRTUAL name is exactly one cell;
  - every listed cell that boots the shell DID boot on the virtual clock in this run (recorded in bootShell).
- The tool is proven to flag an added test and a planted `assert.equal` → `assert.ok`.

## 2. Mutant re-kill
The 24 catalogue mutants whose commands exercise chunk-1 cells: **24/24 KILLED at their recorded kills_with.**
- s7a2-01/02/03/04/06/07/08/10/11/12/13/15/16/17/18/19;
- guest-10;
- g6-07/08/09/12/14/16;
- s2ck-h02.

Baseline green. One earlier sweep refused on a flake in a cell still on the REAL clock (a later chunk; the same tree then passed 291/0 twice).

## 3. Stress
- **20× back to back, chunk-1 cells only:** 20/20, 46/46 each, at load 8–13.
- **5× under synthetic load:** DEFERRED until the slot frees (the quiet box forbids raising the load).

## 4. Findings (reported as found, nothing silently fixed)
- No hidden false-green surfaced in chunk 1: every cell passed on the virtual clock as written, the interval case included.
