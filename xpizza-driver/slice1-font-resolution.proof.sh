#!/usr/bin/env bash
# slice1-font-resolution.proof.sh — MUTANT proof that the exact-weight text pins are load-bearing:
# removing either the PJS font-weight:400 or font-weight:500 local @font-face turns
# slice1-font-resolution.test.js RED (that weight would fall back to Google's PJS online — runtime-
# verified: with the pin removed, the glyph metrics change when the Google sheet is disabled).
#
# Reversible: index.html is backed up and restored via a trap; no git stash/checkout (uncommitted work
# is never touched). Run: bash slice1-font-resolution.proof.sh  (exit 0 = every expectation held)

set -u
cd "$(dirname "$0")"
TEST=(node slice1-font-resolution.test.js)
TMP="$(mktemp -d)"
cp index.html "$TMP/index.html.bak"
restore() { cp "$TMP/index.html.bak" index.html; }
cleanup() { restore; rm -rf "$TMP"; }
trap cleanup EXIT

fail=0
run_test() { "${TEST[@]}" >/dev/null 2>&1; echo $?; }
# Delete the first line containing an anchor (exact string match) via node.
del_line() {
  node -e 'const fs=require("fs");const[,f,a]=process.argv;const s=fs.readFileSync(f,"utf8");
    if(!s.includes(a)){console.error("ANCHOR NOT FOUND: "+a);process.exit(3);}
    fs.writeFileSync(f,s.replace(a+"\n","").replace(a,""));' "$@"
}
expect() { # $1=label $2=GREEN|RED $3=exit
  if { [ "$2" = GREEN ] && [ "$3" -eq 0 ]; } || { [ "$2" = RED ] && [ "$3" -ne 0 ]; }; then
    echo "PASS  [$2]  $1  (test exit=$3)"; else echo "FAIL  [expected $2]  $1  (test exit=$3)"; fail=1; fi
}

PIN400='@font-face { font-family:'"'"'Plus Jakarta Sans'"'"'; src:url("fonts/redhattext-var.woff2") format("woff2"); font-weight:400; font-style:normal; font-display:swap; }'
PIN500='@font-face { font-family:'"'"'Plus Jakarta Sans'"'"'; src:url("fonts/redhattext-var.woff2") format("woff2"); font-weight:500; font-style:normal; font-display:swap; }'

echo "== slice-1 font-resolution: exact-weight pin mutant proof =="
restore; expect "clean (both exact pins present)" GREEN "$(run_test)"
restore; del_line index.html "$PIN400"; expect "removed exact PJS font-weight:400 pin" RED "$(run_test)"
restore; del_line index.html "$PIN500"; expect "removed exact PJS font-weight:500 pin" RED "$(run_test)"
restore

echo "== $([ "$fail" -eq 0 ] && echo 'ALL EXPECTATIONS HELD' || echo 'SOME EXPECTATIONS FAILED') =="
exit "$fail"
