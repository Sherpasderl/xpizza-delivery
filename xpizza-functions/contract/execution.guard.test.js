'use strict';
// R3 P1 §3d — THE EXECUTION GUARD (gate A; static; npm test chain). gate A's executor (contract/gate-a-run.js) gives every
// required cell of an enforced slice exactly one outcome, and refuses each way a cell could be silently skipped.
// The negatives run the REAL executor over an in-memory slice (synthetic cells / registry / observables) — what is under test
// is the executor's accounting, not a surface. Run: node contract/execution.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runGateA, formatFailure } = require('./gate-a-run');
const { gateA } = require('./gate-a');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-EXECUTION ${m}`;
const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));

// a minimal slice: output O has TWO regions (terminal T1 with observable A; terminal T2 with observable B); output U is unsited
// (its comparison is defined only by the matrix's output assertion); D is a display obligation at T1.
const C = (cell, fact, kind, region, extra = {}) => ({ id: `${cell}|o|${region}`, cell, R: 'R0', fact, S: 'S1', brand: 'b', lp: 'new', kind, output: 'o', region, status: 'terminal', fromRegions: [region], ...extra });
const registry = { regions: { T1: { status: 'terminal', observable: 'A', action: 'a' }, T2: { status: 'terminal', observable: 'B', action: 'b' }, P: { status: 'pending' }, X: { status: 'pending' } } };
const yes = () => ({ ok: true, mode: 'shown', detail: 'agrees' });
const observables = { A: { compare: { MONEY: yes, ITEMS: yes, 'DISPLAY:d': yes } }, B: { compare: { MONEY: yes } } };
const EXP = { exposed: { ok: true, detail: 'shown' } };
const snapshots = { A: EXP, B: EXP };
const empty = { exclusions: [] }; const regionsDoc = { regions: [{ region: 'T1' }, { region: 'T2' }, { region: 'P' }, { region: 'X' }] };
const base = { registry, applicability: empty, regionsDoc, scenariosDoc: { scenarios: {} }, evidence: {}, facts: {}, ctx: {}, observables, snapshots, pins: [] };
const cells = [C('R3:R0:MONEY:S1:b:new', 'MONEY', 'agreement', 'T1'), C('R3:R0:MONEY:S1:b:new', 'MONEY', 'agreement', 'T2'), C('R3:R0:ITEMS:S1:b:new', 'ITEMS', 'agreement', 'T1'), C('R3:R0:DISPLAY:d:S1:b:new', 'DISPLAY:d', 'display', 'T1')];
const good = runGateA({ ...base, cells });
assert.strictEqual(good.red.length, 0, FAIL(`the well-formed slice is not green: ${good.red.map(formatFailure).join(' | ')}`));
assert.strictEqual(good.results.length, cells.length, FAIL('a cell has no outcome'));
ok(`a well-formed slice: every cell one outcome (${JSON.stringify(good.counts.byOutcome)}), ${good.counts.comparisons} distinct comparisons`);

const red = (label, r, re) => { assert.ok(r.red.length > 0 && r.red.some((x) => re.test(x.detail)), FAIL(`negative "${label}" was not RED (${JSON.stringify(r.red.map((x) => x.detail))})`)); return label; };
const negs = [
  red('a missing unsited comparison (the observable has no comparator for the fact)', runGateA({ ...base, cells: [...cells, C('R3:R0:TENDER:S1:b:new', 'TENDER', 'agreement', 'T1')] }), /NO comparator for TENDER/),
  red('a missing display comparison', runGateA({ ...base, observables: { ...observables, A: { compare: { MONEY: yes, ITEMS: yes } } }, cells }), /NO comparator for DISPLAY:d/),
  red('one region of a multi-region output not compared (its observable was never captured)', runGateA({ ...base, snapshots: { A: EXP }, cells }), /observable B was not captured/),
  red('a terminal captured while NOT exposed (codex r1 P1-9: the sheet never opened)', runGateA({ ...base, snapshots: { A: { exposed: { ok: false, detail: 'the cart review sheet is OPEN' } }, B: EXP }, cells }), /was not EXPOSED/),
  red('a pending region in an enforced slice', runGateA({ ...base, cells: [...cells, C('R3:R0:MONEY:S1:b:new', 'MONEY', 'agreement', 'P', { status: 'pending' })] }), /is pending in an enforced slice/),
  red('a comparison that disagrees', runGateA({ ...base, observables: { ...observables, B: { compare: { MONEY: () => ({ ok: false, detail: 'observed L 341.00 ≠ expected HNL 340.00' }) } } }, cells }), /≠ expected/),
  red('a stale pin (the surface now agrees)', runGateA({ ...base, pins: [{ key: 'A|ITEMS|S1|b|new', D: 'Dx', observedShape: 's' }], cells }), /STALE PIN/),
  red('a pin whose recorded shape no longer matches', runGateA({ ...base, pins: [{ key: 'B|MONEY|S1|b|new', D: 'Dx', observedShape: 'old' }], observables: { ...observables, B: { compare: { MONEY: () => ({ ok: false, detail: 'x', shape: 'new' }) } } }, cells }), /pin Dx expects shape "old"/),
  red('a display obligation whose every region is excluded', runGateA({ ...base, cells: [C('R3:R0:DISPLAY:d:S1:b:new', 'DISPLAY:d', 'display', 'X', { status: 'pending' })], applicability: { exclusions: [{ region: 'X', scope: { S: ['S1'], brands: ['b'], lps: ['new'] }, preconditions: ['status-new'], reason: 'r', bind: {}, scenarioSha: {} }] }, evidence: { persisted: { status: 'new' } } }), /cannot waive a display assertion/),
  (() => {   // codex r1 P1-7: a display obligation of output o excluded at X cannot be discharged by ANOTHER output's pass
    const AP = require('./applicability');
    const scen = { scenarios: { S1: { steps: ['x'] } } };
    const ex = { exclusions: [{ region: 'X', scope: { S: ['S1'], brands: ['b'], lps: ['new'] }, preconditions: ['status-new'], reason: 'r', bind: { siteSha: null, scopeSha: null }, guards: [AP.bindGuard(['F', 'xpizza-functions/whatsapp.js', 'const RENDERERS = Object.freeze({'])], scenarioSha: { S1: AP.scenarioSha('S1', scen) } }] };
    const D = 'R3:R0:DISPLAY:d:S1:b:new';
    const other = C(D, 'DISPLAY:d', 'display', 'T1', { output: 'o2', id: `${D}|o2|T1` });
    const mine = C(D, 'DISPLAY:d', 'display', 'X', { status: 'pending' });
    const same = C(D, 'DISPLAY:d', 'display', 'T1', { id: `${D}|o|T1` });
    const okRun = runGateA({ ...base, cells: [same, mine], applicability: ex, scenariosDoc: scen, evidence: { persisted: { status: 'new' } } });
    assert.ok(okRun.red.length === 0 && okRun.results.find((x) => x.region === 'X').outcome === 'excluded', FAIL(`a sibling of the SAME output discharged at its terminal was not excluded: ${JSON.stringify(okRun.red)}`));
    return red('a sibling exclusion discharged only by ANOTHER output', runGateA({ ...base, cells: [other, mine], applicability: ex, scenariosDoc: scen, evidence: { persisted: { status: 'new' } } }), /not discharged at a reached terminal of the SAME output/);
  })(),
  (() => {   // an exclusion whose contract precondition is UNMET in the run (fresh binding, real executor) → RED, never excluded
    const AP = require('./applicability');
    const scen = { scenarios: { S1: { steps: ['x'] } } };
    const ex = { exclusions: [{ region: 'X', scope: { S: ['S1'], brands: ['b'], lps: ['new'] }, preconditions: ['status-new'], reason: 'r', bind: { siteSha: null, scopeSha: null }, guards: [AP.bindGuard(['F', 'xpizza-functions/whatsapp.js', 'const RENDERERS = Object.freeze({'])], scenarioSha: { S1: AP.scenarioSha('S1', scen) } }] };
    const cx = [C('R3:R0:STATUS:S1:b:new', 'STATUS', 'agreement', 'X', { status: 'pending' })];
    const met = runGateA({ ...base, cells: cx, applicability: ex, scenariosDoc: scen, evidence: { persisted: { status: 'new' } } });
    assert.ok(met.red.length === 0 && met.results[0].outcome === 'excluded', FAIL(`a fresh exclusion with its precondition met was not excluded: ${JSON.stringify(met.results)}`));
    return red('an exclusion whose precondition is unmet in the run', runGateA({ ...base, cells: cx, applicability: ex, scenariosDoc: scen, evidence: { persisted: { status: 'preparing' } } }), /UNMET in this run: status-new/);
  })(),
];
ok(`negatives RED: ${negs.join('; ')}`);

// a P2-scope cell is never executed in a P1 slice: the enforced slice carries only its declared scenarios / brands / LPs
const P1 = ['S1', 'S1t-a', 'S1t-b', 'S1t-c', 'S1a-on', 'S1a-off', 'S2', 'S3', 'S4', 'S13', 'S14-omitted', 'S14-empty', 'S14-efectivo', 'S14-bitcoin', 'S17d', 'S17p'];
const slice = gateA({ scenarios: ['S1'], brands: ['x_pizza'], lps: ['new'] }).cells;
assert.ok(slice.length > 0 && slice.every((c) => c.S === 'S1' && c.brand === 'x_pizza' && c.lp === 'new'), FAIL('the enforced slice holds a cell outside its scope'));
const allS = new Set(load('matrix.json').cells.map((c) => c.S)); const p2 = [...allS].filter((s) => !P1.includes(s));
assert.ok(p2.length > 0 && !slice.some((c) => p2.includes(c.S)), FAIL('a P2-scope cell joined a P1 slice'));
ok(`a P2-scope cell is never recorded as executed: the S1 slice holds only S1 / x_pizza / new cells (P2 scenarios ${p2.length}: ${p2.slice(0, 6).join(', ')}…)`);

// the failure line: ONE line, starting with the prefix, carrying the cell token
const line = formatFailure({ cell: 'R3:R13:MONEY:S1:x_pizza:new', region: 'r', observable: 'form.reviewSheet', detail: 'a\nb' });
assert.ok(/^R3-FAIL R3:R13:MONEY:S1:x_pizza:new /.test(line) && !line.includes('\n'), FAIL(`the failure line is malformed: ${line}`));
ok('a RED cell prints ONE line: the failure prefix + the cell token (the mutation sweep\'s kill_line)');

console.log(`\nr3-execution guard: OK (${n})`);
