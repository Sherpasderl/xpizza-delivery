# train-lib.sh: sourced by heavy.sh and light-chain.sh (2e, Codex #254 folds). ONE definition each of: the list parse, the tree/tip
# check, the per-step verdict, the receipt check and the orphan reap, so both runners apply the same rule and each is fixture-tested
# (train-lib.test.sh) without emulators.

# norm_list <in> <out>: the ONE parse of a list file (#254-1, #254-5). Reads every line INCLUDING an unterminated last one, drops
# empty lines, writes <out> newline-terminated. Everything after (set comparison, the run loop, coverage) reads <out>, never <in>.
# A duplicate line is refused (rc 1, the duplicates on stdout): a list names each step once.
norm_list() {
  local l; : > "$2"
  while IFS= read -r l || [ -n "$l" ]; do [ -n "$l" ] && printf '%s\n' "$l" >> "$2"; done < "$1"
  local d; d=$(sort "$2" | uniq -d); [ -z "$d" ] || { printf '%s\n' "$d"; return 1; }
}

# tree_dirty <worktree>: tracked changes, printed (empty = clean) (#254-3). NO exclusion: the only generated rules file,
# xpizza-functions/database.rules.json (npm run sync:rules), is gitignored and untracked, so it never appears here; the canonical
# xpizza-reference/database.rules.json is tracked and a change to it is dirt like any other.
tree_dirty() { git -C "$1" status --porcelain --untracked-files=no; }

# tip_holds <worktree> <tip8>: rc 0 iff HEAD is still <tip8> and the tree is clean (#254-4: checked at the START and again at the END
# of a run; a run whose HEAD moved or whose tree changed certifies nothing). Prints why not.
tip_holds() {
  local h; h=$(git -C "$1" rev-parse --short=8 HEAD)
  [ "$h" = "$2" ] || { echo "HEAD is $h, not $2"; return 1; }
  local d; d=$(tree_dirty "$1"); [ -z "$d" ] || { echo "tree dirty:"; printf '%s\n' "$d" | head -5 | sed 's/^/  /'; return 1; }
}

# verdict <rc> <load-after> <timeout-rc> <alarm-s>: the ONE per-step tag (#254-2). Only PASS is a pass; UNTRUSTED (load > 45 after a
# passing step) and TIMEOUT are failures like FAIL. A failing step stays FAIL/TIMEOUT whatever the load.
verdict() {
  if [ "$1" -eq "$3" ]; then echo "TIMEOUT(${4}s)"; elif [ "$1" -ne 0 ]; then echo FAIL; elif [ "$2" -gt 45 ]; then echo UNTRUSTED; else echo PASS; fi
}

# Receipts (results.txt): line 1 «TIP <tip8>», then one «<TAG> <name>» per step, then — written LAST, only by a run that ended
# green with its tip holding — the footer «END green <tip8> <count>». (#254-5)
receipt_footer() { echo "END green $2 $(($(wc -l < "$1") - 1))" >> "$1"; }

# receipt_covers <receipt> <tip8> <names-file>: rc 0 iff <receipt> is a COMPLETED green run at <tip8> (header, footer last with the
# right count, every body line PASS, each name exactly once) and holds a PASS for every name in <names-file>. Prints each problem.
receipt_covers() {
  local r=$1 tip=$2 want=$3 ok=0 n
  [ -f "$r" ] || { echo "  GREEN_FROM $r does not exist"; return 1; }
  [ "$(head -1 "$r")" = "TIP $tip" ] || { echo "  GREEN_FROM is not a receipt for TIP $tip"; return 1; }
  n=$(($(wc -l < "$r") - 2))
  local last; last=$(tail -1 "$r")
  case "$last" in "END green "*) ;; *) echo "  GREEN_FROM has no «END green» footer as its last line (not a completed green run)"; return 1;; esac
  [ "$last" = "END green $tip $n" ] || { echo "  GREEN_FROM's footer does not match its body: «${last}», want «END green ${tip} ${n}»"; return 1; }
  local body; body=$(sed '1d;$d' "$r")
  local notpass; notpass=$(printf '%s\n' "$body" | grep -v '^PASS ' | grep -v '^$')
  [ -z "$notpass" ] || { echo "  GREEN_FROM holds non-PASS lines:"; printf '%s\n' "$notpass" | head -5 | sed 's/^/    /'; ok=1; }
  local dup; dup=$(printf '%s\n' "$body" | sed 's/^[^ ]* //' | sort | uniq -d)
  [ -z "$dup" ] || { echo "  GREEN_FROM names a step more than once:"; printf '%s\n' "$dup" | sed 's/^/    /'; ok=1; }
  local s; while IFS= read -r s; do grep -qxF -- "PASS $s" "$r" || { echo "  not covered by GREEN_FROM: $s"; ok=1; }; done < "$want"
  return $ok
}

# close_green <results> <tip> <run> <derived> <partial> <green_from>: the ONE place a receipt becomes usable (Codex #255). Called
# only after a run with fail=0 whose tip held. A full run, or a PARTIAL run whose GREEN_FROM covers every derived step it skipped,
# gets the footer (written LAST) and rc 0. An uncovered PARTIAL run gets NO footer and rc 4: it is not a gate pass, so its receipt
# can never later stand in as GREEN_FROM.
close_green() {
  if [ -n "$5" ]; then
    grep -vxF -f "$3" "$4" > "$3.rest"
    receipt_covers "$6" "$2" "$3.rest" || return 4
  fi
  receipt_footer "$1" "$2"
}

# reap <worktree>: end every emulator java whose open files lie inside <worktree> (#254-6: canonical containment — the realpath of the
# worktree, equal or prefix + '/'; never a substring). By exact pid. PS / LSOF / KILL are overridable for the fixture test only.
reap() {
  local rw p; rw=$(cd "$1" && pwd -P) || return 0
  for p in $(${PS:-ps} -axo pid=,command= | awk '/java/ && /emulator/ && !/awk/ {print $1}'); do
    ${LSOF:-lsof} -p "$p" -Fn 2>/dev/null | sed -n 's/^n//p' | awk -v w="$rw" '$0 == w || index($0, w "/") == 1 {f=1} END {exit !f}' || continue
    ${KILL:-kill} -TERM "$p" 2>/dev/null && echo "  reaped orphan emulator java $p ($rw)"
  done
}
