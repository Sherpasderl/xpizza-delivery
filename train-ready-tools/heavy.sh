#!/bin/bash
# THE HEAVY PASS (advisor 11-01; rebuilt 2026-11-07 into a DURABLE place after the scratchpad was wiped). One suite at a time, each in
# its OWN process group (perl fork + setpgrp; on alarm TERM the group → 15 s → KILL), then wait ≤ 120 s for this checkout's
# firebase.emulator.*.json lock to clear (11-01 defect: a killed suite's lock refused 49 later suites). Load gate 25 before each suite;
# load > 45 after a suite counts as UNTRUSTED. Alarms: 960 s; test:quality-runner 1800 s; test:tracker-measure 2400 s.
# The suite list is ENUMERATED at run time unless LIST= is given: `gate-all --emulators --list` + test:apps / test:kds-manifest-writer /
# test:portal. Without LISTONLY=1 it also runs emulator-ports.guard and census.negative (3600 s alarm; census.negative is better run
# SHARDED — train-ready-tools/census-neg-shard/).
# Usage: W=<worktree root> TIP=<sha8> [LISTONLY=1] [LIST=<file>] heavy.sh        logs: $LOGROOT (default: $TMPDIR/train-tools-logs)
W=${W:?set W (worktree root)}; TIP=${TIP:?set TIP}
LOGROOT=${LOGROOT:-${TMPDIR:-/tmp}/train-tools-logs}
cd "$W/xpizza-functions" || exit 9
unset NODE_OPTIONS NODE_PATH
export JAVA_HOME=/opt/homebrew/opt/openjdk; export PATH=$JAVA_HOME/bin:$PATH
node -e "require.resolve('firebase-admin');require.resolve('acorn');require.resolve('sharp')" 2>/dev/null || { echo "HEAVY REFUSED: node_modules does not resolve"; exit 3; }
[ -f database.rules.json ] || { echo "HEAVY REFUSED: run npm run sync:rules"; exit 3; }
[ "$(git rev-parse --short=8 HEAD)" = "$TIP" ] || { echo "HEAVY REFUSED: HEAD is not $TIP"; exit 3; }
[ -z "$(git -C "$W" status --porcelain --untracked-files=no)" ] || { echo "HEAVY REFUSED: tree dirty"; exit 3; }
mkdir -p "$LOGROOT"; OUT=$(mktemp -d "$LOGROOT/hv.XXXX"); echo "logs $OUT"; fail=0; n=0; untrusted=0
# the DERIVED suite set, every run (advisor 11-19, after asm11's hand-saved 194-line list skipped 11 suites): a LIST may only be a
# SUBSET of it (an unknown name ⇒ REFUSED), and a LIST run is PARTIAL — never a gate pass — unless GREEN_FROM names a results.txt of
# a green run at the SAME TIP that holds a PASS for every derived suite the LIST leaves out.
DERIVED=$OUT/derived.txt
node tools/gate-all.js --emulators --list 2>/dev/null | grep '^test:' | sed 's/ .*//' > $DERIVED
printf 'test:apps\ntest:kds-manifest-writer\ntest:portal\n' >> $DERIVED
[ "$(wc -l < $DERIVED | tr -d ' ')" -gt 3 ] || { echo "HEAVY REFUSED: the derived suite list is empty"; exit 3; }
PARTIAL=
if [ -z "$LIST" ]; then LIST=$DERIVED
else
  bad=$(grep -vxF -f $DERIVED "$LIST" | grep -v '^$'); [ -z "$bad" ] || { echo "HEAVY REFUSED: LIST names suite(s) not in the derived set: $(echo $bad)"; exit 3; }
  cmp -s <(grep -v '^$' "$LIST" | sort -u) <(sort -u $DERIVED) || PARTIAL=1
fi
RESULTS=$OUT/results.txt; echo "TIP $TIP" > $RESULTS
echo "suites: $(wc -l < $LIST | tr -d ' ')"
l1(){ uptime | sed 's/.*averages*: //' | awk '{print int($1)}'; }
gate(){ while [ "$(l1)" -ge 25 ]; do sleep 30; done; }
# emulator Java started by a suite lives in ITS OWN process group, so the alarm's group kill misses it (asm12: orphans after
# capped runs). After each suite: every emulator java whose open files are under THIS worktree is ended by its exact pid.
reap(){ local p; for p in $(ps -axo pid=,command= | awk '/java/ && /emulator/ && !/awk/ {print $1}'); do
  lsof -p "$p" 2>/dev/null | grep -qF "$W/" || continue
  kill -TERM "$p" 2>/dev/null && echo "  reaped orphan emulator java $p ($W)"; done; }
run(){ # <label> <alarm> <cmd...>
  local label=$1 al=$2; shift 2; n=$((n+1)); gate; local t0; t0=$(date +%s)
  perl -e 'my $al=shift; my $p=fork; if(!$p){ setpgrp(0,0); exec @ARGV or exit 127 } $SIG{ALRM}=sub{ kill "TERM",-$p; sleep 15; kill "KILL",-$p; waitpid($p,0); exit 142 }; alarm $al; waitpid($p,0); exit($? & 127 ? 128+($? & 127) : $?>>8)' "$al" "$@" > "$OUT/$n.log" 2>&1 < /dev/null; local rc=$?
  local w=0; while ls "$W"/xpizza-functions/firebase.emulator.*.json >/dev/null 2>&1 && [ $w -lt 120 ]; do sleep 5; w=$((w+5)); done
  ls "$W"/xpizza-functions/firebase.emulator.*.json >/dev/null 2>&1 && echo "  ⚠ emulator lock still present after ${w}s — later suites may be refused"
  local dt; dt=$(( $(date +%s)-t0 )); local ld; ld=$(l1)
  [ "$ld" -gt 45 ] && untrusted=$((untrusted+1))
  reap
  local tag=PASS; [ $rc -ne 0 ] && { fail=$((fail+1)); tag=FAIL; [ $rc -eq 142 ] && tag="TIMEOUT(${al}s)"; }
  [ "$ld" -gt 45 ] && echo "UNTRUSTED $label" >> $RESULTS || echo "$tag $label" >> $RESULTS
  echo "$tag rc=$rc ${dt}s load=$ld [$n] $label | $(grep -v '^\s*$' "$OUT/$n.log" | tail -1 | cut -c1-110)"
}
if [ -z "$LISTONLY" ]; then
  run emulator-ports.guard 960 node tools/emulator-ports.guard.test.js
  run census.negative 3600 node contract/census.negative.test.js
fi
while IFS= read -r s; do
  [ -z "$s" ] && continue
  al=960; case "$s" in test:quality-runner) al=1800;; test:tracker-measure) al=2400;; esac
  EM=--emulators; case "$s" in test:apps|test:kds-manifest-writer|test:portal) EM=;; esac
  run "$s" $al node tools/gate-all.js $EM --only="$s"
done < "$LIST"
echo "HEAVY fail=$fail of $n; untrusted(load>45)=$untrusted; logs $OUT"
if [ -n "$PARTIAL" ]; then
  REST=$(grep -vxF -f <(grep -v '^$' "$LIST") $DERIVED)
  covered=0
  if [ -n "$GREEN_FROM" ] && [ -f "$GREEN_FROM" ] && [ "$(head -1 "$GREEN_FROM")" = "TIP $TIP" ]; then
    covered=1; for s in $REST; do grep -qxF "PASS $s" "$GREEN_FROM" || { covered=0; echo "  not covered by GREEN_FROM: $s"; }; done
  fi
  if [ $covered = 1 ]; then echo "HEAVY (resume): the LIST + GREEN_FROM $GREEN_FROM cover all $(wc -l < $DERIVED | tr -d ' ') derived suites at $TIP"
  else echo "HEAVY PARTIAL: ran $(grep -vc '^$' "$LIST") of $(wc -l < $DERIVED | tr -d ' ') derived suites — NOT a gate pass (GREEN_FROM=<results.txt of a green run at TIP $TIP> must cover the rest)"; [ $fail -eq 0 ] && exit 4; fi
fi
[ -z "$(git -C "$W" status --porcelain --untracked-files=no)" ] && echo "tree clean" || { echo "TREE DIRTY:"; git -C "$W" status --short | head; }
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
