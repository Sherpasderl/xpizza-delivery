#!/bin/bash
# End-to-end fixture test of light-chain.sh and heavy.sh (Codex #254 folds) on a THROWAWAY git repo: a stub chain of tiny steps (and a
# stub tools/gate-all.js for heavy), so each runner's real wiring is exercised in seconds with no emulator and no real suite.
# Run: NM=<an installed xpizza-functions/node_modules> bash train-runners.test.sh [light|heavy]   (the runners require firebase-admin,
# acorn and sharp to resolve; NM is symlinked, never written). A step misbehaves only when its env var names it:
# FAIL_STEP (exit 1), MUTATE_STEP (edits a tracked file mid-run), HEADMOVE_STEP (commits mid-run).
T=$(cd "$(dirname "$0")" && pwd); WHICH=${1:-all}
NM=${NM:?set NM to an installed xpizza-functions/node_modules}; [ -d "$NM/firebase-admin" ] || { echo "NM has no firebase-admin"; exit 2; }
D=$(mktemp -d "${TMPDIR:-/tmp}/train-runners.XXXX") && [ -d "$D" ] || exit 2; D=$(cd "$D" && pwd -P)
W=$D/wt; F=$W/xpizza-functions; export LOGROOT=$D/logs
mkdir -p $F/s $F/tools $W/xpizza-reference
cat > $F/s/step.js <<'EOF'
const name = process.argv[2], fs = require('fs'), { execSync } = require('child_process');
if (process.env.MUTATE_STEP === name) fs.appendFileSync(__dirname + '/../tracked.js', '// mutated mid-run\n');
if (process.env.HEADMOVE_STEP === name) execSync('git commit -q --allow-empty -m moved', { cwd: __dirname });
if (process.env.FAIL_STEP === name) process.exit(1);
EOF
cat > $F/tools/gate-all.js <<'EOF'
const a = process.argv.slice(2);
if (a.includes('--list')) { console.log('test:e1\ntest:e2\n\n2 emulator scripts'); process.exit(0); }
const only = (a.find((x) => x.startsWith('--only=')) || '').slice(7);
process.argv = [process.argv[0], 'step.js', only]; require('../s/step.js');
EOF
echo 'process.exit(0)' > $F/tools/f2-narrow-rules.js; echo 'process.exit(0)' > $F/tools/portal-preflight.js; echo '// tracked' > $F/tracked.js
cat > $F/package.json <<'EOF'
{ "scripts": { "test": "node s/step.js a && node s/step.js b && node s/step.js c", "check:rules": "node s/step.js rules", "test:apps": "node s/step.js apps" } }
EOF
echo '{"rules":{}}' > $W/xpizza-reference/database.rules.json; cp $W/xpizza-reference/database.rules.json $F/database.rules.json
printf 'xpizza-functions/database.rules.json\nxpizza-functions/node_modules\n' > $W/.gitignore; ln -s "$NM" $F/node_modules
( cd $W && git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm base ) || exit 2
TIP=$(git -C $W rev-parse --short=8 HEAD)
reset(){ git -C $W reset -q --hard $TIP; }
fail=0; n=0
# run_case <name> <want rc> <want-in-output> <must-NOT-be-in-output or ''> -- <command…>
run_case(){ local name=$1 want=$2 has=$3 hasnt=$4; shift 5; n=$((n+1))
  out=$("$@" 2>&1); rc=$?
  if [ $rc -eq $want ] && grep -qF -- "$has" <<<"$out" && { [ -z "$hasnt" ] || ! grep -qF -- "$hasnt" <<<"$out"; }; then echo "  ✓ $name"
  else echo "  ✗ $name (rc=$rc, want $want; want «${has}»${hasnt:+, never «${hasnt}»})"; echo "$out" | tail -6 | sed 's/^/      /'; fail=$((fail+1)); fi; }
receipt_of(){ sed -n 's/.*results \([^;)]*results\.txt\).*/\1/p' <<<"$out" | tail -1; }
receipt_hv(){ echo "$(sed -n 's/^logs //p' <<<"$out" | head -1)/results.txt"; }
fab(){ # a fabricated receipt: the given receipt with «FAIL <step>» added after its PASS and the footer recounted
  { sed '$d' "$1"; echo "FAIL $2"; } > $D/fab; echo "END green $TIP $(($(wc -l < $D/fab) - 1))" >> $D/fab; }

if [ $WHICH != heavy ]; then
echo "light-chain.sh"; L="bash $T/light-chain.sh $W"
run_case "a full green run prints the stage-L marker" 0 "LIGHT-CHAIN fail=0 of 6" "" -- $L
GREEN=$(receipt_of); n=$((n+1)); [ "$(tail -1 "$GREEN")" = "END green $TIP 6" ] && echo "  ✓ its receipt ends with the footer, written last" || { echo "  ✗ receipt footer: $(tail -1 "$GREEN")"; fail=$((fail+1)); }
printf 'node s/step.js a\nnode s/step.js b\nnode s/step.js c\nnode tools/f2-narrow-rules.js --check\nnpm run -s check:rules\nnpm run -s test:apps' > $D/all-unterminated
run_case "#254-1 a complete LIST without a trailing newline runs ALL steps (not PARTIAL)" 0 "LIGHT-CHAIN fail=0 of 6" "PARTIAL" -- env LIST=$D/all-unterminated $L
n=$((n+1)); [ "$(grep -c '^PASS ' "$(receipt_of)")" = 6 ] && echo "  ✓ … and its receipt holds 6 PASS lines (the last LIST line ran)" || { echo "  ✗ PASS lines: $(grep -c '^PASS ' "$(receipt_of)")"; fail=$((fail+1)); }
printf 'node s/step.js a\nnode s/step.js a\n' > $D/dup
run_case "#254-5 a duplicate LIST line is refused" 3 "LIGHT-CHAIN REFUSED: LIST names step(s) more than once:" "" -- env LIST=$D/dup $L
echo '// dirty' >> $F/tracked.js
run_case "#254-4 a dirty tree at the START is refused (full run)" 3 "LIGHT-CHAIN REFUSED: tree dirty:" "" -- $L; reset
echo '{"rules":{"x":1}}' > $W/xpizza-reference/database.rules.json
run_case "#254-3 a change to the canonical xpizza-reference rules is dirt" 3 "xpizza-reference/database.rules.json" "" -- $L; reset
echo '// regenerated' >> $F/database.rules.json
run_case "#254-3 … while the gitignored generated copy is not" 0 "LIGHT-CHAIN fail=0 of 6" "" -- $L
run_case "#254-4 a tracked edit DURING the run is NOT A PASS, never the marker" 5 "LIGHT-CHAIN NOT A PASS: the tip did not hold through the run" "LIGHT-CHAIN fail=0" -- env MUTATE_STEP=b $L; reset
run_case "#254-4 HEAD moving DURING the run is NOT A PASS" 5 "HEAD is" "LIGHT-CHAIN fail=0" -- env HEADMOVE_STEP=b $L; reset
run_case "a failing step: FAILED, never the marker" 1 "LIGHT-CHAIN FAILED: fail=1" "LIGHT-CHAIN fail=0" -- env FAIL_STEP=b $L
n=$((n+1)); grep -q '^END green' "$(receipt_of)" && { echo "  ✗ a failed run's receipt has a footer"; fail=$((fail+1)); } || echo "  ✓ … and its receipt has NO footer (unusable as GREEN_FROM)"
printf 'node s/step.js a\n' > $D/one
run_case "#254-5 resume: a completed green receipt covers the rest" 0 "LIGHT-CHAIN (resume)" "" -- env LIST=$D/one GREEN_FROM=$GREEN $L
printf 'node s/step.js b\nnode s/step.js c\nnode tools/f2-narrow-rules.js --check\nnpm run -s check:rules\nnpm run -s test:apps\n' > $D/rest5
run_case "#255 an uncovered PARTIAL subset run: rc 4, never the marker" 4 "its receipt gets no footer" "LIGHT-CHAIN fail=0" -- env LIST=$D/one $L
PART=$(sed -n 's/.*; logs \([^)]*\)).*/\1/p' <<<"$out" | tail -1)/results.txt
n=$((n+1)); grep -q '^END green' "$PART" && { echo "  ✗ the PARTIAL run's receipt has a footer"; fail=$((fail+1)); } || echo "  ✓ … its receipt has NO footer"
run_case "#255 … and that receipt is REFUSED as GREEN_FROM for the complementary LIST" 4 "GREEN_FROM has no «END green» footer" "LIGHT-CHAIN fail=0" -- env LIST=$D/rest5 GREEN_FROM=$PART $L
fab $GREEN 'npm run -s test:apps'
run_case "#254-5 resume: a fabricated receipt (PASS then FAIL) is PARTIAL, never the marker" 4 "LIGHT-CHAIN PARTIAL" "LIGHT-CHAIN fail=0" -- env LIST=$D/one GREEN_FROM=$D/fab $L
fi

if [ $WHICH != light ]; then
echo "heavy.sh"; H="env W=$W TIP=$TIP LISTONLY=1 bash $T/heavy.sh"
run_case "a full green run" 0 "HEAVY GREEN at $TIP" "" -- $H
HGREEN=$(receipt_hv); n=$((n+1)); [ "$(tail -1 "$HGREEN")" = "END green $TIP 5" ] && echo "  ✓ its receipt ends with the footer" || { echo "  ✗ receipt footer: $(tail -1 "$HGREEN")"; fail=$((fail+1)); }
printf 'test:e1\ntest:e2\ntest:apps\ntest:kds-manifest-writer\ntest:portal' > $D/h-all
run_case "#254-1 a complete LIST without a trailing newline runs ALL suites" 0 "HEAVY GREEN at $TIP" "PARTIAL" -- env LIST=$D/h-all $H
n=$((n+1)); [ "$(grep -c '^PASS ' "$(receipt_hv)")" = 5 ] && echo "  ✓ … 5 PASS lines (test:portal, the unterminated last line, ran)" || { echo "  ✗ PASS lines: $(grep -c '^PASS ' "$(receipt_hv)")"; fail=$((fail+1)); }
printf 'test:e1\ntest:e1\n' > $D/h-dup
run_case "#254-5 a duplicate LIST line is refused" 3 "HEAVY REFUSED: LIST names suite(s) more than once: test:e1" "" -- env LIST=$D/h-dup $H
run_case "#254-4 a tracked edit DURING the run is NOT A PASS" 5 "HEAVY NOT A PASS: the tip did not hold through the run" "HEAVY GREEN" -- env MUTATE_STEP=test:e2 $H; reset
run_case "a failing suite: rc 1, no green line" 1 "FAIL rc=1" "HEAVY GREEN" -- env FAIL_STEP=test:e2 $H
n=$((n+1)); grep -q '^END green' "$(receipt_hv)" && { echo "  ✗ a failed run's receipt has a footer"; fail=$((fail+1)); } || echo "  ✓ … and its receipt has NO footer"
printf 'test:e1\n' > $D/h-one
run_case "#254-5 resume with a completed green receipt" 0 "HEAVY (resume)" "" -- env LIST=$D/h-one GREEN_FROM=$HGREEN $H
printf 'test:e2\ntest:apps\ntest:kds-manifest-writer\ntest:portal\n' > $D/h-rest4
run_case "#255 an uncovered PARTIAL subset run: rc 4" 4 "its receipt gets no footer" "HEAVY GREEN" -- env LIST=$D/h-one $H
HPART=$(receipt_hv); n=$((n+1)); grep -q '^END green' "$HPART" && { echo "  ✗ the PARTIAL run's receipt has a footer"; fail=$((fail+1)); } || echo "  ✓ … its receipt has NO footer"
run_case "#255 … and that receipt is REFUSED as GREEN_FROM for the complementary LIST" 4 "GREEN_FROM has no «END green» footer" "HEAVY (resume)" -- env LIST=$D/h-rest4 GREEN_FROM=$HPART $H
fab $HGREEN test:portal
run_case "#254-5 resume with a fabricated receipt (PASS then FAIL) is PARTIAL" 4 "HEAVY PARTIAL" "HEAVY (resume)" -- env LIST=$D/h-one GREEN_FROM=$D/fab $H
n=$((n+1)); grep -q 'verdict \$rc' $T/heavy.sh && grep -q 'echo "\$tag rc=\$rc' $T/heavy.sh && echo "  ✓ #254-2 heavy's console line and receipt both print the verdict() tag (UNTRUSTED is unit-tested in train-lib.test)" || { echo "  ✗ heavy does not print verdict()'s tag"; fail=$((fail+1)); }
fi

rm -f $F/node_modules; rm -rf "$D"
[ $fail -eq 0 ] && echo "train-runners.test: OK ($n checks)" || echo "train-runners.test: $fail of $n FAILED"
exit $fail
