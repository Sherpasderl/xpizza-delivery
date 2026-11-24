#!/bin/bash
# Fixture test for split-batches.py (2e, asm13). Run: bash split-batches.test.sh   (< 5 s; python only, no repo, no network)
# The fixtures (fixtures/asm12/) are the REAL asm12 writer output, copied unchanged: deploy-closure2 r5's reach (31f05c8a4 →
# b4f7ff063) and the F1–F5 batches the owner deployed. Each case changes ONE thing and must end at its own refusal line (or OK), checked by exact text.
T=$(cd "$(dirname "$0")" && pwd); A=$T/fixtures/asm12
REACH=$A/reach-31f05c8a-b4f7ff06.r5.json; RB=$A
[ -f "$REACH" ] && [ -f "$RB/F5.txt" ] || { echo "split-batches.test: the asm12 fixtures are missing"; exit 2; }
D=$(mktemp -d "${TMPDIR:-/tmp}/split-test.XXXX") && [ -d "$D" ] || exit 2
fail=0; n=0
py(){ python3 -I -c "$@"; }
# the real batches as JSON, plus one edit: $1 = python statement on dict b
batches(){ py "import json,sys
b={k:[l.strip() for l in open('$RB/'+k+'.txt') if l.strip()] for k in ['F1','F2','F3','F4','F5']}
$1
json.dump(b,open(sys.argv[1],'w'))" "$2"; }
reach(){ py "import json,sys
r=json.load(open('$REACH'))
$1
json.dump(r,open(sys.argv[1],'w'))" "$2"; }
held(){ py "import json,sys; json.dump({'held':$1},open(sys.argv[1],'w'))" "$2"; }
check(){ # name, want rc, want text (grep -F), args…
  local name=$1 want=$2 text=$3; shift 3; n=$((n+1))
  out=$(python3 -I $T/split-batches.py "$@" 2>&1); rc=$?
  if [ $rc -eq $want ] && grep -qF -- "$text" <<<"$out"; then echo "  ✓ $name"; else echo "  ✗ $name (rc=$rc, want ${want} + «${text}»)"; echo "$out" | sed 's/^/      /' | head -8; fail=$((fail+1)); fi
}
batches 'pass' $D/b.json
reach 'pass' $D/r.json
VII='{"name":"verifyIdentityIntegrity","reason":"held","since":"asm7"}'
held "[$VII]" $D/h.json
held '[]' $D/h0.json

check "positive control: the real asm12 split passes with the HELD list loaded" 0 "OK: 66 names in 5 batches" $D/r.json $D/b.json --held $D/h.json
batches "b['F4'].append('verifyIdentityIntegrity')" $D/b-held.json
check "a HELD function in a batch is refused, by name, with its reason" 1 "verifyIdentityIntegrity (F4) is HELD, never deployed: held [since asm7]" $D/r.json $D/b-held.json --held $D/h.json
out=$(python3 -I $T/split-batches.py $D/r.json $D/b-held.json --held $D/h.json 2>&1)
n=$((n+1)); if [ "$(grep -c '^  ' <<<"$out")" = 1 ]; then echo "  ✓ the HELD refusal is the ONLY problem (not also «NOT in the closure»)"; else echo "  ✗ more than the HELD line:"; echo "$out" | sed 's/^/      /'; fail=$((fail+1)); fi
reach "[f.update(changed=True) for f in r['functions'] if f['name']=='verifyIdentityIntegrity']" $D/r-reach.json
check "a closure that REACHES the held function still splits (it is left out by design)" 0 "minus 1 HELD (verifyIdentityIntegrity)" $D/r-reach.json $D/b.json --held $D/h.json
check "POSITIVE CONTROL: the same closure with NO hold is refused (the hold is what lets it pass)" 1 "verifyIdentityIntegrity is in the closure but in NO batch" $D/r-reach.json $D/b.json --held $D/h0.json
held '[{"name":"sendPaidAfterCloseRefund","reason":"x","since":"y"}]' $D/h-stale.json
check "a stale hold (the name is no Cloud Function in the reach) is refused" 1 "stale hold: HELD sendPaidAfterCloseRefund is not a Cloud Function in this reach" $D/r.json $D/b.json --held $D/h-stale.json
held '[{"name":"verifyIdentityIntegrity","since":"asm7"}]' $D/h-bad.json
check "a HELD entry without a reason is bad input" 2 'must hold "held": [{name, reason, since}' $D/r.json $D/b.json --held $D/h-bad.json
reach "r['draft']=True" $D/r-draft.json
check "a DRAFT reach (predicted commit) is never split" 2 "never a draft" $D/r-draft.json $D/b.json --held $D/h.json
batches "b['F1'].append('sendPaidAfterCloseRefund')" $D/b-helper.json
check "regression: an exported helper in a batch is still refused" 1 "sendPaidAfterCloseRefund (F1) is an exported HELPER, not a Cloud Function" $D/r.json $D/b-helper.json --held $D/h.json
batches "b['F3'].remove('useMyAddress')" $D/b-new.json
check "regression: a NEW function left out is still refused" 1 "NEW useMyAddress is in no batch" $D/r.json $D/b-new.json --held $D/h.json
check "the committed deploy-held.json loads (default path) and the real split passes" 0 "OK: 66 names in 5 batches" $D/r.json $D/b.json
# Codex #254-8: each remaining refusal, by exact text
batches "b['F2'].append('createOrder')" $D/b-dup.json
check "a name in two batches is refused" 1 "createOrder is in F1 AND F2" $D/r.json $D/b-dup.json --held $D/h.json
batches "b['F5'].append('alertOnDriverProblem')" $D/b-nonclosure.json
check "a function outside the closure is refused" 1 "alertOnDriverProblem (F5) is NOT in the closure" $D/r.json $D/b-nonclosure.json --held $D/h.json
batches "b['F1'].remove('materializeOnConfirm')" $D/b-caller.json
check "a changed helper's omitted caller is refused" 1 "changed helper sendPaidAfterCloseRefund: its caller materializeOnConfirm is in no batch" $D/r.json $D/b-caller.json --held $D/h.json
# Codex #254-7: the output directory — a fresh one is written whole; a reused (non-empty) one is refused and left untouched
check "a new output directory is written" 0 "OK: 66 names in 5 batches" $D/r.json $D/b.json $D/out --held $D/h.json
n=$((n+1)); if [ "$(ls $D/out | tr '\n' ,)" = "F1.txt,F2.txt,F3.txt,F4.txt,F5.txt,names.txt," ] && cmp -s $D/out/F3.txt $RB/F3.txt; then echo "  ✓ it holds exactly F1–F5 + names.txt, F3 byte-identical to the deployed batch"; else echo "  ✗ the written directory: $(ls $D/out | tr '\n' ' ')"; fail=$((fail+1)); fi
echo "verifyIdentityIntegrity" > $D/out/F6.txt   # a stale batch from an older generation
check "a reused (non-empty) output directory is refused" 2 "SPLIT REFUSED: the output directory $D/out exists and is not empty" $D/r.json $D/b.json $D/out --held $D/h.json
n=$((n+1)); if [ "$(cat $D/out/F6.txt)" = verifyIdentityIntegrity ] && [ "$(ls $D/out | wc -l | tr -d ' ')" = 7 ]; then echo "  ✓ the refused directory is left untouched (nothing half-written)"; else echo "  ✗ the refused directory changed"; fail=$((fail+1)); fi
mkdir $D/empty; check "an existing EMPTY output directory is accepted" 0 "OK: 66 names in 5 batches" $D/r.json $D/b.json $D/empty --held $D/h.json
n=$((n+1)); [ "$(ls -a $D | grep -c '^\.split-')" = 0 ] && echo "  ✓ no temp directory is left behind" || { echo "  ✗ a .split- temp directory survived"; fail=$((fail+1)); }
rm -f $D/out/* $D/empty/*; rmdir $D/out $D/empty

rm -f $D/*.json; rmdir "$D"
[ $fail -eq 0 ] && echo "split-batches.test: OK ($n checks)" || echo "split-batches.test: $fail of $n FAILED"
exit $fail
