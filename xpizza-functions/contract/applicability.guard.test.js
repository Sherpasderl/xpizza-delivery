'use strict';
// R3 P1 §3c — THE APPLICABILITY GUARD (static; npm test chain). Every reviewed exclusion (contract/output-applicability.json)
// is bound to its current source (call-site text + enclosing census scope) and to its scenario definition; names only
// CONTRACT preconditions; never waives an absence / display obligation; and agrees with gate B's evidence — an output
// whose every region is excluded for a scenario was NOT reached by that scenario's run (contract/p1-hits.json).
// Run: node contract/applicability.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AP = require('./applicability');
const { gateA } = require('./gate-a');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-APPLICABILITY ${m}`;
const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const doc = AP.load(); const regionsDoc = load('regions.json'); const scen = load('p1-scenarios.json'); const registry = load('outputs/registry.json');

// 1. every binding and scenario hash is current
const st = AP.staleness(doc, regionsDoc, scen);
assert.deepStrictEqual(st, [], FAIL(`stale / malformed exclusion(s):\n  ${st.slice(0, 10).join('\n  ')}`));
ok(`${doc.exclusions.length} exclusions: each bound to its call-site text + census scope (sha256) and its scenario definition — all current`);

// 2. well-formed: a real region, not terminal/via (a reached region is compared, never excluded), contract preconditions only
const byId = new Map(regionsDoc.regions.map((r) => [r.region, r]));
const dup = new Set(); const p2 = [];
for (const x of doc.exclusions) {
  const k = `${x.region}|${x.scope.S}|${x.scope.brands}|${x.scope.lps}`; if (dup.has(k)) p2.push(`${x.region}: duplicate`); dup.add(k);
  if (!byId.has(x.region)) p2.push(`${x.region}: not a region`);
  const e = registry.regions[x.region]; if (e && e.status !== 'pending') p2.push(`${x.region}: is ${e.status} in the registry — a compared region cannot also be excluded`);
  for (const pc of x.preconditions) if (!AP.PRECONDITIONS[pc] || !/§|scenario definition|LP/.test(AP.PRECONDITIONS[pc].contract)) p2.push(`${x.region}: precondition ${pc} has no contract authority`);
}
assert.deepStrictEqual(p2, [], FAIL(p2.join('\n  ')));
ok(`each exclusion names a real, uncompared (pending) region and only preconditions with a contract authority (${Object.keys(AP.PRECONDITIONS).length} defined)`);

// 3. no exclusion waives an absence / display obligation
const scopes = [...new Set(doc.exclusions.map((x) => JSON.stringify(x.scope)))].map((s) => JSON.parse(s));
const cells = scopes.flatMap((s) => gateA({ scenarios: s.S, brands: s.brands, lps: s.lps }).cells);
const sh = AP.shadowsAssertion(doc, cells);
assert.deepStrictEqual(sh, [], FAIL(sh.join('\n  ')));
const dispCells = cells.filter((c) => c.kind === 'display' || c.kind === 'absence');
ok(`no absence / display obligation is waived: ${dispCells.length} such cell-region(s) in scope, every obligation keeps ≥ 1 required region`);

// 4. agreement with gate B: an output whose EVERY region is excluded for a scenario had NO site reached by that scenario
const hits = load('p1-hits.json').contexts;
const norm = (s) => s.replace(/<script@\d+>/, '');
const fnOf = (id) => norm(id.split('#').slice(0, 2).join('#'));
const reached = new Set(Object.values(hits).flat().map(fnOf));
const p4 = [];
for (const s of scopes) {
  const exR = new Set(doc.exclusions.filter((x) => JSON.stringify(x.scope) === JSON.stringify(s)).map((x) => x.region));
  const outs = new Set(regionsDoc.regions.filter((r) => exR.has(r.region)).map((r) => r.output));
  for (const o of outs) {
    const all = regionsDoc.regions.filter((r) => r.output === o);
    if (all.every((r) => exR.has(r.region)) && reached.has(norm(o))) p4.push(`${o}: every region excluded for ${JSON.stringify(s)}, yet the run reached its sites (gate B) — the exclusion is contradicted`);
  }
}
assert.deepStrictEqual(p4, [], FAIL(p4.join('\n  ')));
ok('gate B agrees: no output with all regions excluded was reached by the scenario run');

// negatives (in memory)
const clone = () => JSON.parse(JSON.stringify(doc));
const x0 = doc.exclusions[0];
{ const d = clone(); d.exclusions[0].bind.siteSha = AP.sha('changed text'); assert.ok(AP.staleness(d, regionsDoc, scen).some((p) => p.startsWith(`${x0.region}: call-site text changed`)), FAIL('a changed call site was not stale')); }
{ const d = clone(); d.exclusions[0].bind.scopeSha = AP.sha('changed scope'); assert.ok(AP.staleness(d, regionsDoc, scen).some((p) => /scope .* changed/.test(p)), FAIL('a changed scope was not stale')); }
{ const s2 = JSON.parse(JSON.stringify(scen)); s2.scenarios.S1.steps.push('form.another-order'); assert.ok(AP.staleness(doc, regionsDoc, s2).some((p) => /scenario S1 definition changed/.test(p)), FAIL('a changed scenario was not stale')); }
{ const d = clone(); const gi = d.exclusions.findIndex((e) => e.guards.some((g) => g.kind === 'F')); const g = d.exclusions[gi].guards.find((x) => x.kind === 'F'); g.text = `${g.text} /*changed*/`; assert.ok(AP.staleness(d, regionsDoc, scen).some((p) => p.startsWith(`${d.exclusions[gi].region}: guard text occurs 0×`)), FAIL('a changed guard source did not make the exclusion stale')); }
{ const d = clone(); delete d.exclusions[0].guards; assert.ok(AP.staleness(d, regionsDoc, scen).some((p) => /needs at least one GUARD/.test(p)), FAIL('an exclusion without a guard binding passed')); }
{ // codex P1-a r1 P1-6: RENDERERS.orderReceived re-pointed at renderPickupReceived → the pickup-body exclusion is stale
  const x = doc.exclusions.find((e) => e.region === 'xpizza-functions/whatsapp.js#renderPickupReceived@self');
  assert.ok(x, FAIL('no renderPickupReceived exclusion'));
  const real = fs.readFileSync(path.join(__dirname, '..', 'whatsapp.js'), 'utf8');
  const mutated = real.replace('orderReceived: renderOrderReceived, pickupReceived:', 'orderReceived: renderPickupReceived, pickupReceived:');
  assert.ok(mutated !== real, FAIL('the RENDERERS probe text moved'));
  const st = x.guards.map((g) => AP.guardStale(g, { readFile: (f) => (f === 'xpizza-functions/whatsapp.js' ? mutated : fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8')) })).filter(Boolean);
  assert.ok(st.length > 0, FAIL('re-pointing RENDERERS.orderReceived did not invalidate the renderPickupReceived exclusion'));
}
ok('negative: a stale exclusion (call-site text / scope / scenario definition / GUARD changed — codex\'s RENDERERS re-point) → stale → the cell is required again; an exclusion without a guard is malformed');
{
  const ev = { intent: { fulfil: 'delivery', pay: 'cash' }, persisted: { order_type: 'pickup', payment_method: 'cash', status: 'new' }, steps: [], routed: [], kdsActions: [], kdsHttp: [], kdsTickets: 1 };
  const x = { preconditions: ['delivery', 'status-new'] };
  assert.deepStrictEqual(AP.unmet(x, ev), ['delivery'], FAIL('an unmet precondition was not reported'));
  assert.deepStrictEqual(AP.unmet({ preconditions: ['no-kitchen-action'] }, { ...ev, kdsActions: ['kds.tap'] }), ['no-kitchen-action'], FAIL('a kitchen tap did not unmeet no-kitchen-action'));
}
ok('negative: an unmet declared precondition (a pickup order / a kitchen tap) → reported unmet (RED in the run)');
{
  const d = clone(); const disp = dispCells[0]; assert.ok(disp, FAIL('no display cell in scope for the negative'));
  for (const c of dispCells.filter((y) => y.cell === disp.cell)) d.exclusions.push({ region: c.viaFrom || c.region, scope: { S: [c.S], brands: [c.brand], lps: [c.lp] }, preconditions: ['delivery'], reason: 'negative', bind: {}, scenarioSha: {} });
  assert.ok(AP.shadowsAssertion(d, cells).some((p) => p.startsWith(disp.cell)), FAIL('an absence / display obligation expressed as an exclusion passed'));
}
{ // codex r1 P1-7: another OUTPUT's surviving region cannot keep an obligation alive — exclude every renderStage2Summary
  // region of the R14 Envío Gratis obligation; the freeDeliveryRowHTML regions of other cells do not discharge it
  const d = clone(); const ob = dispCells.filter((c) => /R14:DISPLAY/.test(c.cell) && /renderStage2Summary$/.test(c.output));
  assert.ok(ob.length > 0, FAIL('no R14 display obligation on renderStage2Summary in scope'));
  for (const c of ob) d.exclusions.push({ region: c.viaFrom || c.region, scope: { S: [c.S], brands: [c.brand], lps: [c.lp] }, preconditions: ['delivery'], reason: 'negative', bind: {}, scenarioSha: {} });
  assert.ok(AP.shadowsAssertion(d, cells).some((p) => p.startsWith(`${ob[0].cell}|${ob[0].output}`)), FAIL('a display obligation of one output survived on another output\'s region'));
}
ok('negative: a display obligation expressed as an exclusion (every region of it — of its OWN output — excluded) → RED, even while another output keeps regions');

console.log(`\nr3-applicability guard: OK (${n})`);
