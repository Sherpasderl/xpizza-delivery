# vclock: the owed slot items (advisor 11-14: slot granted after 5f released)

Tip 7357d5161 (contains 087924300). One process at a time; rc captured on its own line; hard per-file timeout (n22.sh).

## A. The 37-file gate (owed for capp-ui commit 087924300)
- **37 files, 0 failed**, load 4–10. Each runs 1 test file; the counts are as reported:
  - **Guards:** mutation-anchors, sweep-baseline, firestore-config-isolation and app-suites.guard, all rc=0.
  - **Customer-app files:** capp-api-sdk 57/0, capp-api 54/0, capp-s7a2 292/0, capp-ui 252/0, capp-s7a1 24/0, s7a1-shell 13/0, test-clock 9/0.
  - **The rest:** the other capp-* files, fixtures.probe 4/0 and package-capp 1/0, all green.
- **Outside the 37:** `capp-url-token.test.mjs` is KNOWN_RED by design (rule 20, excused in app-suites.js KNOWN_RED). Run separately, it is red as expected (1/1); the excuse is still live.

## B. 5× under synthetic load (PLAN §4: `yes > /dev/null` ×8)
| File | Covers | Result | Duration (quiet → loaded) |
|---|---|---|---|
| capp-s7a2 (full) | chunks 1–6 + step 9 | 5/5, 292/0 | ~139 s → 167–183 s |
| capp-ui (full) | steps 8a + 8b | 5/5, 252/0 | ~45 s → 100–111 s |
| test-clock | step 8b | 5/5, 9/0 | |
| capp-api-sdk | step 9 + F-3 | 5/5, 57/0 | |

- **The load gate:** a run starts only when (load − my 8 hogs) ≤ 30. Load at run start was 15–36 (real ≤ 28).
- **Load from others during the slot:** it peaked at ~150 (real ~140) between runs. My own share was ~9 (8 hogs plus one test process). The gate paused each time (see the run log).
  - Because load averages lag, some runs probably finished under heavier real load than the gate allows. They all passed, which only strengthens the result.
  - The other load is a quiet-box breach by another session, reported to the advisor.
- **Clean:** the hogs were stopped, the tree is clean and no .bak was left.
