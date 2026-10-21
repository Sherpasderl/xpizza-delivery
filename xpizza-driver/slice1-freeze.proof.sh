#!/usr/bin/env bash
# slice1-freeze.proof.sh — PROOF that slice1-freeze.guard.test.js goes RED on any mutation OUTSIDE the
# three SLICE1 regions (frozen .js, or index.html outside a region, or a stray new module, or a
# forbidden import), and STAYS GREEN for the permitted surface (a change INSIDE a region).
#
# Reversible by construction: every touched file is backed up to a temp dir and restored on exit via a
# trap. No `git stash` / `git checkout` is used, so uncommitted work (e.g. index.html) is never touched.
#
# Run: bash slice1-freeze.proof.sh   (exit 0 = every expectation held)

set -u
cd "$(dirname "$0")"                       # xpizza-driver/
GUARD=(node slice1-freeze.guard.test.js)
TMP="$(mktemp -d)"
FILES=(brand-helpers.js index.html single-order-view.js)

backup()  { for f in "${FILES[@]}"; do cp "$f" "$TMP/${f//\//_}.bak"; done; }
restore() { for f in "${FILES[@]}"; do cp "$TMP/${f//\//_}.bak" "$f"; done; }
cleanup() { restore; rm -f stray.js; rm -rf "$TMP"; }
trap cleanup EXIT
backup

fail=0

run_guard() { "${GUARD[@]}" >/dev/null 2>&1; echo $?; }

# Exact string substitution (first occurrence) via node; exits 3 if the anchor is missing.
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

echo "== slice-1 freeze guard: mutation proof =="

# 0. Clean tree → GREEN (the guard passes on the real slice).
restore
expect "clean working tree" GREEN "$(run_guard)"

# 1. Mutate a FROZEN logic file (append a byte) → RED.
restore
printf '\n// freeze-proof mutation\n' >> brand-helpers.js
expect "byte appended to frozen brand-helpers.js" RED "$(run_guard)"

# 2. Mutate index.html OUTSIDE every region (a frozen .sched-badge CSS byte) → RED.
restore
sub index.html 'gap: 4px; background: #FBF0CE;' 'gap: 4px; background: #FBF0CD;'
expect "frozen CSS byte changed outside regions (index.html)" RED "$(run_guard)"

# 3. Mutate index.html INSIDE the PRESENTATION region (a Cuadra --accent byte) → GREEN (permitted).
restore
sub index.html '#2F5FB8' '#2F5FB9'
expect "byte changed INSIDE the PRESENTATION region (index.html)" GREEN "$(run_guard)"

# 4. Add a FORBIDDEN import to the new module → RED.
restore
sub single-order-view.js \
  "import { brandLabel, brandMeta, driverGreeting } from './brand-helpers.js';" \
  "import { readFileSync } from 'node:fs';
import { brandLabel, brandMeta, driverGreeting } from './brand-helpers.js';"
expect "forbidden import added to single-order-view.js" RED "$(run_guard)"

# 5. Introduce a stray new production module → RED.
restore
printf 'export const stray = 1;\n' > stray.js
expect "stray new production module (stray.js)" RED "$(run_guard)"
rm -f stray.js

restore
echo "== $([ "$fail" -eq 0 ] && echo 'ALL EXPECTATIONS HELD' || echo 'SOME EXPECTATIONS FAILED') =="
exit "$fail"
