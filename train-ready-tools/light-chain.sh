#!/bin/bash
# THE LIGHT CHAIN (advisor rule 2026-10-27; rebuilt 2026-11-07 into a DURABLE place after the scratchpad was wiped):
# the functions `npm test` chain GENERATED FROM package.json at run time (never a hand list) MINUS the two heavy steps
# (tools/emulator-ports.guard.test.js, contract/census.negative.test.js), every command run on its own with its rc (no short-
# circuit), + f2-narrow --check + check:rules + test:apps. Each command under an alarm: 120 s (standing rule), 600 s for census.guard, form-source-inventory.guard +
# applicability.guard; a 120 s TIMEOUT (rc 124, whole process group killed) is re-run once at 960 s and reported as such. Load gate: wait while the 1-min load ≥ LOADMAX (25).
# Usage: [LIST=<file>] [GREEN_FROM=<results.txt>] light-chain.sh <worktree root>   logs: $LOGROOT (default: $TMPDIR/train-tools-logs)
# DERIVED SET (advisor 11-21, same rule as heavy.sh): the chain commands + the three tail steps, written to derived.txt every run.
# A LIST (one command line per line, as derived.txt prints them) must be a SUBSET of it (an unknown line ⇒ REFUSED, rc 3). A LIST run
# is PARTIAL — never a pass, rc 4 — unless GREEN_FROM names a results.txt of a green run on the SAME CLEAN TIP holding a PASS for
# every derived step the LIST leaves out. Every run writes results.txt («TIP <sha8> clean|dirty», then «PASS|FAIL <command>»).
cd "${1:?worktree}/xpizza-functions" || exit 9
# every step runs under rungroup: its own process group, SIGKILLed WHOLE on the alarm (rc 124); smoke: run-group.smoke.sh
. "$(dirname "${BASH_SOURCE[0]}")/run-group.sh" || { echo "LIGHT-CHAIN REFUSED: run-group.sh missing"; exit 3; }
unset NODE_OPTIONS NODE_PATH
# ENVIRONMENT PRE-FLIGHT: an environment failure must refuse up front, never be scored as test results
node -e "require.resolve('firebase-admin');require.resolve('acorn')" 2>/dev/null || { echo "LIGHT-CHAIN REFUSED: xpizza-functions/node_modules does not resolve ($(readlink node_modules 2>/dev/null || echo 'no link'))"; exit 3; }
[ -f database.rules.json ] || { echo "LIGHT-CHAIN REFUSED: database.rules.json missing — run npm run sync:rules"; exit 3; }
# the portal's 62 node files run in test:apps (portal light chain r0): a missing xpizza-portal install refuses here, not as 62 reds
node tools/portal-preflight.js > /dev/null 2>&1 || { echo "LIGHT-CHAIN REFUSED: xpizza-portal dependencies do not resolve — npm --prefix ../xpizza-portal install"; exit 3; }
LOGROOT=${LOGROOT:-${TMPDIR:-/tmp}/train-tools-logs}
mkdir -p "$LOGROOT"; OUT=$(mktemp -d "$LOGROOT/lc.XXXX")
node -e "require('./package.json').scripts.test.split('&&').map(s=>s.trim()).filter(Boolean).filter(c=>!/emulator-ports\.guard|census\.negative/.test(c)).forEach(c=>console.log(c))" > $OUT/cmds.txt
n=$(wc -l < $OUT/cmds.txt | tr -d ' '); fail=0; i=0
[ "$n" -gt 0 ] || { echo "LIGHT-CHAIN REFUSED: no chain command derived from package.json"; exit 3; }
F2='node tools/f2-narrow-rules.js --check'; RULES='npm run -s check:rules'; APPS='npm run -s test:apps'
DERIVED=$OUT/derived.txt; { cat $OUT/cmds.txt; printf '%s\n' "$F2" "$RULES" "$APPS"; } > $DERIVED
TIP=$(git rev-parse --short=8 HEAD); DIRTY=$(git status --short --untracked-files=no | grep -v database.rules.json | wc -l | tr -d ' ')
PARTIAL=
if [ -n "$LIST" ]; then
  [ -f "$LIST" ] || { echo "LIGHT-CHAIN REFUSED: LIST $LIST does not exist"; exit 3; }
  bad=$(grep -v '^$' "$LIST" | grep -vxF -f $DERIVED); [ -z "$bad" ] || { echo "LIGHT-CHAIN REFUSED: LIST names step(s) not in the derived set:"; echo "$bad" | sed 's/^/  /'; exit 3; }
  cmp -s <(grep -v '^$' "$LIST" | sort -u) <(sort -u $DERIVED) || PARTIAL=1
fi
want(){ [ -z "$PARTIAL" ] || grep -qxF -- "$1" "$LIST"; }
RESULTS=$OUT/results.txt; echo "TIP $TIP $([ "$DIRTY" = 0 ] && echo clean || echo dirty)" > $RESULTS
rec(){ [ "$1" -eq 0 ] && echo "PASS $2" >> $RESULTS || echo "FAIL $2" >> $RESULTS; }
echo "HEAD $TIP dirty=$DIRTY — $n chain commands (emulator-ports + census.negative excluded)${PARTIAL:+ — LIST: $(grep -vc '^$' "$LIST") of $((n+3)) derived steps}"
LOADMAX=${LOADMAX:-25}; waited=0
l1(){ uptime | sed 's/.*averages*: //' | awk '{print int($1)}'; }
while IFS= read -r c; do
  i=$((i+1)); want "$c" || continue
  while [ "$(l1)" -ge "$LOADMAX" ]; do sleep 30; waited=$((waited+30)); done
  al=120; [[ "$c" =~ census\.guard|applicability\.guard|form-source-inventory\.guard ]] && al=600
  rungroup $al bash -c "$c" > "$OUT/$i.log" 2>&1 < /dev/null; rc=$?
  if [ $rc -eq 124 ] && [ $al -eq 120 ]; then
    echo "  note: TIMEOUT(120s) [$i] → re-run at 960s: $c"
    while [ "$(l1)" -ge "$LOADMAX" ]; do sleep 30; waited=$((waited+30)); done
    rungroup 960 bash -c "$c" > "$OUT/$i.960.log" 2>&1 < /dev/null; rc=$?; al=960
  fi
  echo "$i $(l1)" >> $OUT/load.txt; rec $rc "$c"
  if [ $rc -ne 0 ]; then fail=$((fail+1)); if [ $rc -eq 124 ]; then echo "rc=124 TIMEOUT(${al}s) [$i] $c"; else echo "rc=$rc [$i] $c"; fi; fi
done < $OUT/cmds.txt
gate(){ while [ "$(l1)" -ge "$LOADMAX" ]; do sleep 30; waited=$((waited+30)); done; }
if want "$F2"; then gate; rungroup 120 $F2 > $OUT/f2.log 2>&1 < /dev/null; rc=$?; rec $rc "$F2"; [ $rc -eq 0 ] || { fail=$((fail+1)); echo "rc=$rc f2-narrow-rules --check"; }; fi
if want "$RULES"; then gate; rungroup 120 $RULES > $OUT/rules.log 2>&1 < /dev/null; rc=$?; rec $rc "$RULES"; [ $rc -eq 0 ] || { fail=$((fail+1)); echo "rc=$rc npm run check:rules"; }; fi
# FULL light = + `npm run test:apps` (advisor standing rule 2026-11-08: app suites outside xpizza-functions — incl. 9 customer-app
# suites — run ONLY there). ~280 s at ba47f627, + ~285 s for the 62 portal files (portal light chain r0, 11-16); own alarm
# 2400 s; each file is its own verdict inside (tools/app-suites.js; a cancelled/timed-out file is RED).
if want "$APPS"; then
  gate; rungroup 2400 $APPS > $OUT/apps.log 2>&1 < /dev/null; rc=$?; rec $rc "$APPS"
  if [ $rc -ne 0 ]; then fail=$((fail+1)); echo "rc=$rc npm run test:apps — $(grep -E "^app-suites:" $OUT/apps.log | tail -1)"; grep -E "^  🔴" $OUT/apps.log | sed "s/^/    /"; fi
fi
[ -f $OUT/load.txt ] && echo "load max (1-min, after each cmd): $(sort -k2 -n $OUT/load.txt | tail -1)"
if [ -n "$PARTIAL" ]; then
  ran=$(grep -vc '^$' "$LIST"); covered=0
  # resume coverage: both runs on the SAME CLEAN tip (a dirty tree's sha does not name what was tested)
  if [ "$DIRTY" = 0 ] && [ -n "$GREEN_FROM" ] && [ -f "$GREEN_FROM" ] && [ "$(head -1 "$GREEN_FROM")" = "TIP $TIP clean" ]; then
    covered=1; while IFS= read -r c; do grep -qxF -- "$c" "$LIST" && continue; grep -qxF -- "PASS $c" "$GREEN_FROM" || { covered=0; echo "  not covered by GREEN_FROM: $c"; }; done < $DERIVED
  fi
  if [ $covered = 0 ]; then
    echo "LIGHT-CHAIN PARTIAL: fail=$fail, ran $ran of $((n+3)) derived steps — NOT a gate pass (GREEN_FROM=<results.txt of a green run on the clean TIP $TIP> must cover the rest; logs $OUT)"
    exit $([ $fail -eq 0 ] && echo 4 || echo 1)
  fi
  echo "LIGHT-CHAIN (resume): the LIST ($ran) + GREEN_FROM $GREEN_FROM cover all $((n+3)) derived steps at $TIP"
fi
echo "LIGHT-CHAIN fail=$fail of $((n+3)) (logs $OUT; results $RESULTS; paused ${waited}s for load>=${LOADMAX})"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
