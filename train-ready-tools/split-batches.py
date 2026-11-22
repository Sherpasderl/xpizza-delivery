#!/usr/bin/env python3
# split-batches.py (2e, asm13; generalized from asm12-assembly/split-batches.py, which stays as asm12's record).
# Split a deploy closure (deploy-closure2 r5 JSON, run at the release tip) into ordered batches and PROVE the split:
#   - the union of the batches == the closure's changed+new set, minus the HELD functions;
#   - no name in two batches;
#   - no name outside the closure;
#   - no exported HELPER (not a Cloud Function) in a batch;
#   - every caller of a changed helper is in a batch (unless that caller is HELD);
#   - every NEW function is in a batch;
#   - no HELD function in a batch (deploy-held.json: in code, deliberately never deployed), and no stale hold (a HELD name that is
#     not a Cloud Function in the reach any more).
# Usage: split-batches.py <reach.json> <batches.json> [<out dir>] [--held <deploy-held.json>]
#   batches.json = {"F1": ["name", ...], "F2": [...], ...} in deploy order. The out dir gets F*.txt + names.txt (non-new names).
# Exit 0 = proven; exit 1 = refused (each problem printed); exit 2 = bad input.
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
held_path = os.path.join(HERE, 'deploy-held.json')
if '--held' in args:
    i = args.index('--held'); held_path = args[i + 1]; del args[i:i + 2]
if len(args) not in (2, 3):
    print('usage: split-batches.py <reach.json> <batches.json> [<out dir>] [--held <deploy-held.json>]'); sys.exit(2)

def load(p, what):
    try:
        with open(p) as f: return json.load(f)
    except Exception as e:
        print(f'SPLIT REFUSED: cannot read {what} {p}: {e}'); sys.exit(2)

reach = load(args[0], 'the reach file')
batches = load(args[1], 'the batches file')
held_doc = load(held_path, 'the HELD list')
if 'deployedFunctionCount' not in reach or 'nonFunctionExports' not in reach or reach.get('draft'):
    print('SPLIT REFUSED: the reach file is not a final r5 run (function-only targets, loaded at the release tip; never a draft)'); sys.exit(2)
if not isinstance(batches, dict) or not batches or not all(isinstance(v, list) and v for v in batches.values()):
    print('SPLIT REFUSED: batches.json must map each batch name to a non-empty list of function names'); sys.exit(2)
held_list = held_doc.get('held') if isinstance(held_doc, dict) else None
if not isinstance(held_list, list) or any(not isinstance(h, dict) or not h.get('name') or not h.get('reason') or not h.get('since') for h in held_list):
    print(f'SPLIT REFUSED: {held_path} must hold "held": [{{name, reason, since}}, ...]'); sys.exit(2)
held = {h['name']: h for h in held_list}

functions = {f['name'] for f in reach['functions']}
closure = {f['name'] for f in reach['functions'] if f.get('changed') or f.get('isNew')}
helpers = {h['name'] for h in reach['nonFunctionExports']}
new = sorted(f['name'] for f in reach['functions'] if f.get('isNew'))

problems = []
seen = {}
for b, names in batches.items():
    for n in names:
        if n in seen: problems.append(f'{n} is in {seen[n]} AND {b}')
        seen[n] = b
union = set(seen)
for n in sorted(held):
    if n not in functions: problems.append(f'stale hold: HELD {n} is not a Cloud Function in this reach (remove it from {held_path}, dated)')
for n in sorted(union & set(held)): problems.append(f'{n} ({seen[n]}) is HELD, never deployed: {held[n]["reason"]} [since {held[n]["since"]}]')
for n in sorted(union & helpers): problems.append(f'{n} ({seen[n]}) is an exported HELPER, not a Cloud Function')
for n in sorted(union - closure - helpers - set(held)): problems.append(f'{n} ({seen[n]}) is NOT in the closure')
for n in sorted(closure - union - set(held)): problems.append(f'{n} is in the closure but in NO batch')
for h in reach['nonFunctionExports']:
    if h['changed']:
        for c in h['callers']:
            if c not in union and c not in held: problems.append(f'changed helper {h["name"]}: its caller {c} is in no batch')
for n in new:
    if n not in union and n not in held: problems.append(f'NEW {n} is in no batch')
if problems:
    print('SPLIT REFUSED:\n  ' + '\n  '.join(problems)); sys.exit(1)

held_in_closure = sorted(closure & set(held))
if len(args) == 3:
    out = args[2]; os.makedirs(out, exist_ok=True)
    for b, names in batches.items():
        with open(os.path.join(out, f'{b}.txt'), 'w') as f: f.write('\n'.join(names) + '\n')
    with open(os.path.join(out, 'names.txt'), 'w') as f: f.write('\n'.join(sorted(union - set(new))) + '\n')
for b, names in batches.items():
    print(f'{b}: {len(names)} — firebase deploy --project xpizza-delivery --only "' + ','.join(f'functions:{n}' for n in names) + '"')
print(f'OK: {len(union)} names in {len(batches)} batches == the closure ({len(closure)}: {len(closure) - len(new)} changed + {len(new)} new'
      + (f': {", ".join(new)}' if new else '') + f') minus {len(held_in_closure)} HELD'
      + (f' ({", ".join(held_in_closure)})' if held_in_closure else '') + '; no duplicates, no helper, no held function')
