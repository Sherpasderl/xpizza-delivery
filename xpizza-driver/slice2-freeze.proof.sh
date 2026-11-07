#!/usr/bin/env bash
# slice2-freeze.proof.sh — PROOF that slice2-freeze.guard.test.js goes RED on any mutation OUTSIDE the
# SLICE2 regions (a frozen .js, index.html outside a region, a forbidden import in a new module, a stray
# new module), and STAYS GREEN for the permitted surface (a change INSIDE a region).
#
# Reversible by construction: every touched file is backed up to a temp dir and restored on exit via a
# trap. No `git stash` / `git checkout` (stash is repo-global across worktrees), so uncommitted work is
# never touched.
#
# Run: bash slice2-freeze.proof.sh   (exit 0 = every expectation held)

set -u
cd "$(dirname "$0")"                       # xpizza-driver/
GUARD=(node slice2-freeze.guard.test.js)
TMP="$(mktemp -d)"
FILES=(driver-complete.js index.html overview-map.js)

backup()  { for f in "${FILES[@]}"; do cp "$f" "$TMP/${f//\//_}.bak"; done; }
restore() { for f in "${FILES[@]}"; do cp "$TMP/${f//\//_}.bak" "$f"; done; }
cleanup() { restore; rm -f stray2.js; rm -rf "$TMP"; }
trap cleanup EXIT
backup

fail=0
run_guard() { "${GUARD[@]}" >/dev/null 2>&1; echo $?; }
sub() {
  node -e 'const fs=require("fs");const[,f,a,b]=process.argv;const s=fs.readFileSync(f,"utf8");
    if(!s.includes(a)){console.error("ANCHOR NOT FOUND in "+f+": "+a);process.exit(3);}
    fs.writeFileSync(f,s.replace(a,b));' "$@"
}
expect() { # $1=label  $2=GREEN|RED  $3=actual guard exit
  if { [ "$2" = GREEN ] && [ "$3" -eq 0 ]; } || { [ "$2" = RED ] && [ "$3" -ne 0 ]; }; then
    echo "PASS  [$2]  $1  (guard exit=$3)"
  else
    echo "FAIL  [expected $2]  $1  (guard exit=$3)"; fail=1
  fi
}

echo "== slice-2 freeze guard: mutation proof =="

# 0. Clean tree → GREEN.
restore
expect "clean working tree" GREEN "$(run_guard)"

# 1. Mutate a FROZEN core logic file (append a byte) → RED.
restore
printf '\n// freeze-proof mutation\n' >> driver-complete.js
expect "byte appended to frozen driver-complete.js" RED "$(run_guard)"

# 2. Mutate index.html OUTSIDE every region (the frozen version comment) → RED.
restore
sub index.html 'version: 1.8.0' 'version: 1.8.1'
expect "frozen byte changed outside regions (index.html version)" RED "$(run_guard)"

# 3. Mutate index.html INSIDE the PRESENTATION region (the --muted token byte) → GREEN (permitted).
restore
sub index.html '--muted: #6B7687;' '--muted: #6B7688;'
expect "byte changed INSIDE the PRESENTATION region (index.html)" GREEN "$(run_guard)"

# 4. Add a FORBIDDEN import to overview-map.js (which must import NOTHING) → RED.
restore
sub overview-map.js \
  'export const VIEWBOX = { w: 358, h: 150 };' \
  "import { readFileSync } from 'node:fs';
export const VIEWBOX = { w: 358, h: 150 };"
expect "forbidden import added to overview-map.js" RED "$(run_guard)"

# 5. Introduce a stray new production module → RED.
restore
printf 'export const stray = 1;\n' > stray2.js
expect "stray new production module (stray2.js)" RED "$(run_guard)"
rm -f stray2.js

# 6. DELETE a DIFFERENT frozen baseline file (NOT in ALLOWED_DELETE) → RED. The slice retires exactly one
#    baseline file (single-order-branch.test.js); the allowed-DELETE list must be tight, so deleting any other
#    frozen file is still refused. (The ALLOWED delete itself is proven GREEN by expectation 0 on the clean tree,
#    where single-order-branch.test.js is already removed.)
restore
rm -f driver-complete.js
expect "a DIFFERENT baseline file deleted (driver-complete.js) → RED (allowed-DELETE is tight)" RED "$(run_guard)"
restore

echo "== $([ "$fail" -eq 0 ] && echo 'ALL EXPECTATIONS HELD' || echo 'SOME EXPECTATIONS FAILED') =="
exit "$fail"
