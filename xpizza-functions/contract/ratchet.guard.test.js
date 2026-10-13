'use strict';
// R3 P1 §3d — THE RATCHET GUARD (gate B; static; npm test chain). The reviewed baseline (contract/p1-hits.json) and shrink
// list (contract/p1-hits-shrink.json) are well-formed, every baseline site is a CURRENT census site, and the ratchet refuses
// lost coverage and stale shrink entries. (The enforced run itself applies the ratchet: test:r3-p1a-journey.)
// Run: node contract/ratchet.guard.test.js
const assert = require('assert');
const RAT = require('./ratchet');
const { censusIndex } = require('./tracer');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-RATCHET ${m}`;
const { baseline, shrink } = RAT.load();
const ctxs = Object.keys(baseline.contexts || {});
assert.ok(ctxs.length > 0, FAIL('the baseline has no context'));
const ids = new Set(censusIndex().ids);
const unknown = ctxs.flatMap((c) => baseline.contexts[c].filter((s) => !ids.has(s)).map((s) => `${c}|${s}`));
assert.deepStrictEqual(unknown, [], FAIL(`baseline sites that are not current census sites (the census moved — re-review the baseline):\n  ${unknown.slice(0, 10).join('\n  ')}`));
for (const c of ctxs) assert.deepStrictEqual(baseline.contexts[c], [...new Set(baseline.contexts[c])].sort(), FAIL(`${c}: baseline not sorted / unique`));
ok(`baseline: ${ctxs.length} contexts (${ctxs.map((c) => `${c} ${baseline.contexts[c].length}`).join(', ')}), every site a current census site; shrink entries ${(shrink.entries || []).length}`);

const self = RAT.ratchet({ baseline, shrink, current: baseline.contexts });
assert.deepStrictEqual(self.problems, [], FAIL(`the baseline does not satisfy itself: ${self.problems.join('; ')}`));
ok('the baseline satisfies the ratchet (no stale shrink entry against it)');

const c0 = ctxs.find((c) => baseline.contexts[c].length > 1); const s0 = baseline.contexts[c0][0];
const lost = { ...baseline.contexts, [c0]: baseline.contexts[c0].slice(1) };
assert.ok(RAT.ratchet({ baseline, shrink: { entries: [] }, current: lost }).problems.some((p) => p.includes(`baseline site ${s0} is no longer reached`)), FAIL('a shrunken hit set without a shrink entry passed'));
assert.deepStrictEqual(RAT.ratchet({ baseline, shrink: { entries: [{ context: c0, site: s0, reason: 'reviewed' }] }, current: lost }).problems, [], FAIL('a reviewed shrink entry did not cover the lost site'));
ok('negative: a shrunken hit set without a reviewed shrink entry → RED; with one → accepted');
assert.ok(RAT.ratchet({ baseline, shrink: { entries: [{ context: c0, site: s0, reason: 'r' }] }, current: baseline.contexts }).problems.some((p) => /stale shrink entry .* reached again/.test(p)), FAIL('a stale shrink entry (site reached again) passed'));
assert.ok(RAT.ratchet({ baseline, shrink: { entries: [{ context: c0, site: 'nope#x#y#0', reason: 'r' }] }, current: baseline.contexts }).problems.some((p) => /not in the baseline/.test(p)), FAIL('a stale shrink entry (not in baseline) passed'));
assert.ok(RAT.ratchet({ baseline, shrink: { entries: [{ context: c0, site: s0 }] }, current: lost }).problems.some((p) => /needs a reason/.test(p)), FAIL('a shrink entry without a reason passed'));
ok('negative: a stale shrink entry (reached again / not in the baseline) or one without a reason → RED');
assert.ok(RAT.ratchet({ baseline, shrink, current: { ...baseline.contexts, 'S9/new/ctx': ['x'] } }).problems.some((p) => /no baseline/.test(p)), FAIL('an unreviewed run context passed'));
const grown = RAT.ratchet({ baseline, shrink, current: { ...baseline.contexts, [c0]: [...baseline.contexts[c0], 'zz-new-site'] } });
assert.ok(grown.problems.length === 0 && grown.grown[c0].includes('zz-new-site'), FAIL('growth is not reported as growth'));
ok('a run context without a reviewed baseline → RED; new sites are reported as growth (enter the baseline only by a reviewed rewrite)');
// the reviewed NONDETERMINISTIC sites: current census sites, not in the baseline; neither required nor growth
for (const e of shrink.nondeterministic || []) assert.ok(ids.has(e.site) && e.reason && !(baseline.contexts[e.context] || []).includes(e.site), FAIL(`nondeterministic entry ${e.context}|${e.site} malformed / stale`));
{
  const e0 = (shrink.nondeterministic || [])[0];
  if (e0) {
    const withIt = { ...baseline.contexts, [e0.context]: [...(baseline.contexts[e0.context] || []), e0.site] };
    const r1 = RAT.ratchet({ baseline, shrink, current: withIt }); const r2 = RAT.ratchet({ baseline, shrink, current: baseline.contexts });
    assert.ok(r1.problems.length === 0 && !(r1.grown[e0.context] || []).includes(e0.site) && r2.problems.length === 0, FAIL('a nondeterministic site was required or counted as growth'));
    const bad = { ...baseline, contexts: withIt };
    assert.ok(RAT.ratchet({ baseline: bad, shrink, current: withIt }).problems.some((p) => /also in the baseline/.test(p)), FAIL('a nondeterministic site in the baseline passed'));
    assert.ok(RAT.ratchet({ baseline, shrink: { ...shrink, nondeterministic: [{ ...e0, reason: '' }] }, current: baseline.contexts }).problems.some((p) => /needs a reason/.test(p)), FAIL('a nondeterministic entry without a reason passed'));
  }
}
ok(`reviewed nondeterministic sites (${(shrink.nondeterministic || []).length}): current census sites outside the baseline, reached or not → no problem and no growth; one placed in the baseline / without a reason → RED`);
console.log(`\nr3-ratchet guard: OK (${n})`);
