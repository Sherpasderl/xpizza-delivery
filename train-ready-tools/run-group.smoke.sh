#!/bin/bash
# Smoke test for run-group.sh (rungroup). Run: bash run-group.smoke.sh [path/to/run-group.sh]  (about 8 s; spawns only sleep)
# 1 the rc passes through; 2 a timeout gives 124 and kills the CHILDREN, not just the leader; 3 children left behind after a
# normal exit are killed; 4 POSITIVE CONTROL: the old `perl alarm; exec` form leaves the child alive, so this test can see an orphan.
. "${1:-$(dirname "$0")/run-group.sh}" || exit 2
D=$(mktemp -d "${TMPDIR:-/tmp}/rungroup-smoke.XXXX") && [ -d "$D" ] || exit 2; fail=0
ok(){ echo "  ✓ $1"; }; bad(){ echo "  ✗ $1"; fail=$((fail+1)); }
alive(){ kill -0 "$1" 2>/dev/null; }
sleep_child(){ echo "sleep 300 & echo \$! > $D/$1; $2"; }   # a background child whose pid is recorded, then the leader's own step (`wait`: the leader stays bash, so nothing but the recorded child can outlive it)

rungroup 10 true; [ $? -eq 0 ] && ok "rc 0 passes through" || bad "rc 0 did not pass through"
rungroup 10 bash -c 'exit 7'; [ $? -eq 7 ] && ok "rc 7 passes through" || bad "rc 7 did not pass through"

t0=$(date +%s); rungroup 2 bash -c "$(sleep_child a 'wait')"; rc=$?; dt=$(( $(date +%s) - t0 ))
c=$(cat $D/a 2>/dev/null); sleep 0.3
[ $rc -eq 124 ] && [ $dt -lt 10 ] && ok "a timeout gives rc 124 (after ${dt}s)" || bad "timeout rc=$rc after ${dt}s (want 124)"
if [ -n "$c" ] && ! alive "$c"; then ok "the timed-out command's child ($c) is dead"; else bad "the timed-out command's child ($c) survived"; [ -n "$c" ] && kill -9 "$c"; fi

rungroup 10 bash -c "$(sleep_child b 'exit 3')"; rc=$?; c=$(cat $D/b 2>/dev/null); sleep 0.3
[ $rc -eq 3 ] && ok "rc 3 passes through when the leader leaves a child behind" || bad "rc=$rc (want 3)"
if [ -n "$c" ] && ! alive "$c"; then ok "a child left behind by a normal exit ($c) is killed"; else bad "a child left behind ($c) survived"; [ -n "$c" ] && kill -9 "$c"; fi

# POSITIVE CONTROL: the old form. Its child must SURVIVE here, or the checks above prove nothing. Then kill that exact pid.
{ perl -e 'alarm 2; exec @ARGV' bash -c "$(sleep_child old 'wait')"; } 2>/dev/null; c=$(cat $D/old 2>/dev/null); sleep 0.3
if [ -n "$c" ] && alive "$c"; then ok "positive control: the old perl-alarm-exec form orphans its child ($c), and this test sees it"; kill -9 "$c"; else bad "positive control: the old form's child ($c) was not seen alive"; fi

rm -f "$D/a" "$D/b" "$D/old"; rmdir "$D"
[ $fail -eq 0 ] && echo "run-group.smoke: OK (7 checks)" || echo "run-group.smoke: $fail FAILED"
exit $fail
