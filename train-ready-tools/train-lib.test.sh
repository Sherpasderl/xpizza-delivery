#!/bin/bash
# Unit test for train-lib.sh (Codex #254 folds). Run: bash train-lib.test.sh   (< 5 s; a throwaway git repo + stubbed ps/lsof/kill)
T=$(cd "$(dirname "$0")" && pwd); . "$T/train-lib.sh" || exit 2
D=$(mktemp -d "${TMPDIR:-/tmp}/train-lib-test.XXXX") && [ -d "$D" ] || exit 2; D=$(cd "$D" && pwd -P)
fail=0; n=0
ok(){ n=$((n+1)); echo "  ✓ $1"; }; bad(){ n=$((n+1)); echo "  ✗ $1"; fail=$((fail+1)); }
is(){ [ "$2" = "$3" ] && ok "$1" || { bad "$1"; echo "      got:  $(printf '%q' "$2")"; echo "      want: $(printf '%q' "$3")"; }; }

echo "#254-1/5 norm_list: the ONE parse"
printf 'a\n\nb\nc' > $D/l1; norm_list $D/l1 $D/o1; rc=$?
is "an unterminated last line is kept (3 names, newline-terminated)" "$rc:$(cat $D/o1 | tr '\n' ,)" "0:a,b,c,"
printf 'a\nb\na\n' > $D/l2; out=$(norm_list $D/l2 $D/o2); rc=$?
is "a duplicate line is refused, naming it" "$rc:$out" "1:a"
printf 'x' > $D/l3; norm_list $D/l3 $D/o3; is "a one-line list without a newline" "$(cat $D/o3)" "x"

echo "#254-2 verdict: only PASS passes"
is "rc 0, load 46 ⇒ UNTRUSTED" "$(verdict 0 46 142 960)" "UNTRUSTED"
is "rc 0, load 45 ⇒ PASS" "$(verdict 0 45 142 960)" "PASS"
is "rc 1, load 46 ⇒ FAIL (a failure stays a failure)" "$(verdict 1 46 142 960)" "FAIL"
is "the timeout rc ⇒ TIMEOUT" "$(verdict 142 3 142 960)" "TIMEOUT(960s)"

echo "#254-3/4 tree_dirty + tip_holds"
R=$D/wt; mkdir -p $R/xpizza-reference $R/xpizza-functions
( cd $R && git init -q && git config user.email t@t && git config user.name t \
  && echo '{"rules":{}}' > xpizza-reference/database.rules.json && echo 'x' > xpizza-functions/a.js \
  && printf 'xpizza-functions/database.rules.json\n' > .gitignore && git add -A && git commit -qm base )
TIP=$(git -C $R rev-parse --short=8 HEAD)
tip_holds $R $TIP > /dev/null; is "a clean tree at the tip holds" "$?" "0"
cp $R/xpizza-reference/database.rules.json $R/xpizza-functions/database.rules.json; echo changed >> $R/xpizza-functions/database.rules.json
tip_holds $R $TIP > /dev/null; is "the gitignored generated rules copy (sync:rules) is not dirt" "$?" "0"
echo '{"rules":{"x":1}}' > $R/xpizza-reference/database.rules.json
out=$(tip_holds $R $TIP); rc=$?
is "a change to the CANONICAL xpizza-reference rules is dirt (#254-3)" "$rc:$(echo "$out" | grep -c 'xpizza-reference/database.rules.json')" "1:1"
git -C $R checkout -q -- xpizza-reference/database.rules.json
echo y >> $R/xpizza-functions/a.js; tip_holds $R $TIP > /dev/null; is "a tracked code edit is dirt" "$?" "1"
git -C $R checkout -q -- xpizza-functions/a.js
echo u > $R/untracked.txt; tip_holds $R $TIP > /dev/null; is "an untracked file is not dirt (untracked-files=no)" "$?" "0"; rm $R/untracked.txt
git -C $R commit -q --allow-empty -m moved; out=$(tip_holds $R $TIP); rc=$?
is "HEAD moved off the tip ⇒ does not hold (#254-4)" "$rc:${out%% *}" "1:HEAD"

echo "#254-5 receipt_covers: only a COMPLETED green run counts"
printf 's1\ns2\n' > $D/want
mk(){ { echo "TIP abcd1234"; printf '%s\n' "$@"; } > $D/r; }
mk "PASS s0" "PASS s1" "PASS s2"; receipt_footer $D/r abcd1234
is "the footer counts the body lines" "$(tail -1 $D/r)" "END green abcd1234 3"
receipt_covers $D/r abcd1234 $D/want > /dev/null; is "a completed green receipt covers" "$?" "0"
out=$(receipt_covers $D/r ffff0000 $D/want); is "another tip's receipt is refused" "$?:$out" "1:  GREEN_FROM is not a receipt for TIP ffff0000"
mk "PASS s1" "PASS s2"; out=$(receipt_covers $D/r abcd1234 $D/want)
is "no footer (an interrupted or failed run) is refused" "$?:$out" "1:  GREEN_FROM has no «END green» footer as its last line (not a completed green run)"
mk "PASS s1" "PASS s2"; receipt_footer $D/r abcd1234; echo "PASS s9" >> $D/r; out=$(receipt_covers $D/r abcd1234 $D/want)
is "a line after the footer is refused (the footer must be last)" "$?:$out" "1:  GREEN_FROM has no «END green» footer as its last line (not a completed green run)"
mk "PASS s1" "PASS s2" "FAIL s2"; echo "END green abcd1234 3" >> $D/r; out=$(receipt_covers $D/r abcd1234 $D/want); rc=$?
is "a fabricated footer over PASS-then-FAIL is refused (non-PASS line + duplicate name)" "$rc:$(echo "$out" | grep -c 'non-PASS lines'):$(echo "$out" | grep -c 'more than once')" "1:1:1"
mk "PASS s1" "UNTRUSTED s2"; echo "END green abcd1234 2" >> $D/r; out=$(receipt_covers $D/r abcd1234 $D/want); rc=$?
is "an UNTRUSTED line is refused" "$rc:$(echo "$out" | grep -c 'UNTRUSTED s2')" "1:1"
mk "PASS s1" "PASS s1"; echo "END green abcd1234 2" >> $D/r; out=$(receipt_covers $D/r abcd1234 $D/want); rc=$?
is "a duplicate PASS (and s2 missing) is refused" "$rc:$(echo "$out" | grep -c 'more than once'):$(echo "$out" | grep -c 'not covered by GREEN_FROM: s2')" "1:1:1"
mk "PASS s1"; receipt_footer $D/r abcd1234; out=$(receipt_covers $D/r abcd1234 $D/want)
is "an uncovered name is refused, by name" "$?:$out" "1:  not covered by GREEN_FROM: s2"
mk "PASS s1" "PASS s2"; echo "END green abcd1234 5" >> $D/r; out=$(receipt_covers $D/r abcd1234 $D/want)
is "a footer whose count does not match the body is refused" "$?:$out" "1:  GREEN_FROM's footer does not match its body: «END green abcd1234 5», want «END green abcd1234 2»"
out=$(receipt_covers $D/none abcd1234 $D/want); is "a missing receipt is refused" "$?:$out" "1:  GREEN_FROM $D/none does not exist"

echo "#255 close_green: the footer only for a full run or a COVERED partial run"
printf 'a\nb\nc\n' > $D/derived; printf 'a\n' > $D/run
{ echo "TIP abcd1234"; echo "PASS a"; echo "PASS b"; echo "PASS c"; } > $D/full; close_green $D/full abcd1234 $D/derived $D/derived "" ""
is "a full run gets the footer" "$?:$(tail -1 $D/full)" "0:END green abcd1234 3"
{ echo "TIP abcd1234"; echo "PASS a"; } > $D/part; close_green $D/part abcd1234 $D/run $D/derived 1 "" > /dev/null
is "an uncovered PARTIAL run: rc 4 and NO footer" "$?:$(tail -1 $D/part)" "4:PASS a"
{ echo "TIP abcd1234"; echo "PASS a"; } > $D/part2; close_green $D/part2 abcd1234 $D/run $D/derived 1 $D/full > /dev/null
is "a PARTIAL run covered by a completed green receipt gets the footer" "$?:$(tail -1 $D/part2)" "0:END green abcd1234 1"
printf 'b\nc\n' > $D/want-bc; out=$(receipt_covers $D/part abcd1234 $D/want-bc)
is "the uncovered PARTIAL run's receipt is refused as GREEN_FROM" "$?:$out" "1:  GREEN_FROM has no «END green» footer as its last line (not a completed green run)"

echo "#254-6 reap: realpath containment, never a substring"
W=$D/tmp/worktree; mkdir -p $W/xpizza-functions $D/tmp/worktree-other $D/backup$D/tmp/worktree/x; ln -s $W $D/link
fake_ps(){ printf '101 /usr/bin/java -jar cloud-firestore-emulator.jar\n102 /usr/bin/java -jar cloud-firestore-emulator.jar\n103 /usr/bin/java -jar cloud-firestore-emulator.jar\n104 /usr/bin/java -jar cloud-firestore-emulator.jar\n105 /usr/bin/java -jar firebase-database-emulator.jar\n'; }
fake_lsof(){ case "$2" in
  101) printf 'p101\nn%s/xpizza-functions/firebase.json\n' "$W";;
  102) printf 'p102\nn%s/backup%s/tmp/worktree/x/f\n' "$D" "$D";;
  103) printf 'p103\nn%s/tmp/worktree-other/f\n' "$D";;
  104) printf 'p104\nn/etc/hosts\n';;
  105) printf 'p105\nn%s\n' "$W";;
esac; }
killed=$D/killed; : > $killed; fake_kill(){ echo "$2" >> $killed; }
PS=fake_ps LSOF=fake_lsof KILL=fake_kill reap $W > /dev/null
is "only the processes with files INSIDE the worktree (or the worktree itself) are signalled" "$(tr '\n' , < $killed)" "101,105,"
: > $killed; PS=fake_ps LSOF=fake_lsof KILL=fake_kill reap $D/link > /dev/null
is "a symlinked worktree path resolves to the same realpath" "$(tr '\n' , < $killed)" "101,105,"

rm -rf "$D"
[ $fail -eq 0 ] && echo "train-lib.test: OK ($n checks)" || echo "train-lib.test: $fail of $n FAILED"
exit $fail
