'use strict';
// R3 P1-b — THE APPLICABILITY GUARD (static; npm test chain) for the REGION-LEVEL, DERIVED model
// (contract/region-applicability.js; DESIGN-R3-P1B.md rev 2). Every reviewed region entry is fresh (call site, scope,
// guard / dispatch source, scenario bindings), well-formed (declared fields, in-domain values, contract authority, why
// false excludes) and its reviewed cases evaluate as stated; the derived exclusions at S1 / x_pizza / new are EXACTLY the
// frozen P1-a 66; no absence / display obligation is waived anywhere in P1; gate B agrees.
// Run: node contract/applicability.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AP = require('./applicability');
const RA = require('./region-applicability');
const SS = require('./scenario-state');
const { gateA } = require('./gate-a');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-APPLICABILITY ${m}`;
const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const doc = RA.load(); const regionsDoc = load('regions.json'); const registry = load('outputs/registry.json'); const paths = SS.load();
const P1 = ['S1', 'S1t-a', 'S1t-b', 'S1t-c', 'S1a-on', 'S1a-off', 'S2', 'S3', 'S4', 'S13', 'S14-omitted', 'S14-empty', 'S14-efectivo', 'S14-bitcoin', 'S17d', 'S17p'];

// 1. fresh + well-formed + reviewed cases hold
const pr = RA.problems(doc, regionsDoc, paths);
assert.deepStrictEqual(pr, [], FAIL(`region applicability problems:\n  ${pr.slice(0, 12).join('\n  ')}`));
const entries = Object.entries(doc.regions);
const nCases = entries.reduce((a, [, e]) => a + (e.cases.required || []).length + (e.cases.excluded || []).length, 0);
ok(`${entries.length} reviewed region entries: call site / scope / guard bindings fresh, ${Object.keys(doc.scenarioBinding).length} scenario bindings current, declared fields only, contract authority + why-false on each; ${nCases} reviewed cases evaluate as stated`);

// 2. each entry's region is uncompared (pending) — a compared region is never excluded
const compared = entries.filter(([id]) => registry.regions[id] && registry.regions[id].status !== 'pending').map(([id]) => id);
assert.deepStrictEqual(compared, [], FAIL(`entries on terminal / via regions: ${compared.join(', ')}`));
ok('every entry is on an uncompared (pending) region');

// 3. THE REGRESSION LOCK — exact identities, at the original context
const frozen = load('p1a-frozen-exclusions.json');
const s1 = gateA({ scenarios: ['S1'], brands: ['x_pizza'], lps: ['new'] }).cells;
const derived = [...new Set(RA.derive(doc, s1, paths).map((x) => x.region))].sort();
assert.deepStrictEqual(derived, [...frozen.regions].sort(), FAIL(`derived exclusions at ${frozen.context} ≠ the frozen P1-a 66 (${frozen.frozenAt}):\n  missing ${JSON.stringify(frozen.regions.filter((r) => !derived.includes(r)))}\n  extra ${JSON.stringify(derived.filter((r) => !frozen.regions.includes(r)))}`));
ok(`regression lock: the derived exclusions at ${frozen.context} are EXACTLY the ${frozen.regions.length} P1-a regions frozen at ${frozen.frozenAt}`);

// 4. no absence / display obligation is waived anywhere in P1 (the (cell, output) terminal rule)
const p1cells = gateA({ scenarios: P1 }).cells;
const w = RA.waivedObligations(doc, p1cells, paths);
assert.deepStrictEqual(w, [], FAIL(w.slice(0, 10).join('\n  ')));
const derivedP1 = RA.derive(doc, p1cells, paths);
ok(`no absence / display obligation is waived across all ${p1cells.length} P1 cells; ${derivedP1.length} cells statically excluded by ${new Set(derivedP1.map((x) => x.region)).size} reviewed regions (each still needs the run's evidence)`);

// 5. gate B agrees: an output whose every region is excluded at S1 / x_pizza / new had no site hit in S1's contexts
{
  const hits = load('p1-hits.json').contexts; const norm = (s) => s.replace(/<script@\d+>/, '');
  const reached = new Set([...(hits['S1/x_pizza/new'] || []), ...(hits['S1/x_pizza/form'] || [])].map((id) => norm(id.split('#').slice(0, 2).join('#'))));
  const ex = new Set(derived); const outs = new Set(regionsDoc.regions.filter((r) => ex.has(r.region)).map((r) => r.output));
  const contra = [...outs].filter((o) => regionsDoc.regions.filter((r) => r.output === o).every((r) => ex.has(r.region)) && reached.has(norm(o)));
  assert.deepStrictEqual(contra, [], FAIL(`gate B contradicts: ${contra.join(', ')}`));
  ok('gate B agrees: no output with every region excluded at S1 / x_pizza / new was reached by that run');
}

// ── negatives (in memory) ──
const clone = () => JSON.parse(JSON.stringify(doc));
const [id0] = Object.keys(doc.regions);
{ const d = clone(); d.regions[id0].bind.siteSha = AP.sha('changed'); assert.ok(RA.problems(d, regionsDoc, paths).some((p) => p.startsWith(`${id0}: its call site / scope changed`)), FAIL('a changed scope was not stale')); }
{ const d = clone(); const k = Object.keys(d.regions).find((r) => d.regions[r].guards.some((g) => g.kind === 'F')); d.regions[k].guards.find((g) => g.kind === 'F').text += ' /*changed*/'; assert.ok(RA.problems(d, regionsDoc, paths).some((p) => p.startsWith(`${k}: guard text occurs 0×`)), FAIL('a changed guard source did not make the exclusion stale')); }
{ // codex P1-a: RENDERERS.orderReceived → renderPickupReceived; and the dispatcher renderTemplate re-point
  const e = doc.regions['xpizza-functions/whatsapp.js#renderPickupReceived@self'];
  const real = fs.readFileSync(path.join(__dirname, '..', 'whatsapp.js'), 'utf8');
  const st = e.guards.map((g) => AP.guardStale(g, { readFile: (f) => (f === 'xpizza-functions/whatsapp.js' ? real.replace('orderReceived: renderOrderReceived, pickupReceived:', 'orderReceived: renderPickupReceived, pickupReceived:') : fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8')) })).filter(Boolean);
  const { sources } = require('./census'); const u = sources().find((x) => x.file === 'xpizza-functions/whatsapp.js');
  const disp = e.guards.find((g) => g.kind === 'S' && g.scope === 'xpizza-functions/whatsapp.js#renderTemplate');
  const st2 = disp && AP.guardStale(disp, { units: sources().map((x) => (x.file === u.file ? { ...u, code: u.code.replace('const r = RENDERERS[msg.name];', 'const r = RENDERERS.pickupReceived;') } : x)) });
  assert.ok(st.length > 0, FAIL('re-pointing RENDERERS.orderReceived did not invalidate the renderPickupReceived exclusion'));
  assert.ok(st2, FAIL('re-pointing renderTemplate\'s selection did not invalidate the renderPickupReceived exclusion'));
}
ok('negative: a changed call site / guard text, the RENDERERS table re-point and the renderTemplate dispatcher re-point → stale → required + RED');
{ // scenario invalidation: a changed scenario definition re-opens its exclusions EVEN IF the derived set is unchanged
  const p2 = JSON.parse(JSON.stringify(paths)); p2.scenarios.S3.path = [...p2.scenarios.S3.path]; p2.scenarios.S3.path.splice(1, 0, 'noop');
  const before = RA.derive(doc, p1cells.filter((c) => c.S === 'S3'), paths).length; const after = RA.derive(doc, p1cells.filter((c) => c.S === 'S3'), p2).length;
  assert.ok(before === after && RA.problems(doc, regionsDoc, p2).some((p) => /^scenario S3: its definition \/ LPs \/ vectors changed/.test(p)), FAIL('a scenario definition change (derived set unchanged) did not invalidate its exclusions'));
}
ok('negative: a scenario definition change re-opens every exclusion in it (RED) even when the derived set is unchanged');
{ // invalid never reads as false
  const d = clone(); d.regions[id0].appliesWhenAny = [{ colour: ['red'] }];
  assert.ok(RA.problems(d, regionsDoc, paths).some((p) => /undeclared field colour/.test(p)), FAIL('an undeclared field passed'));
  const st = RA.staticDecision(d, id0, { S: 'S1', brand: 'x_pizza', lp: 'new' }, paths);
  assert.ok(st.invalid && !st.excluded, FAIL('an invalid condition was read as an exclusion'));
  const p2 = JSON.parse(JSON.stringify(paths)); p2.defaults.inbound = 'maybe';
  const st2 = RA.staticDecision(doc, Object.keys(doc.regions).find((r) => doc.regions[r].group === 'inbound'), { S: 'S1', brand: 'x_pizza', lp: 'new' }, p2);
  assert.ok(st2.invalid && !st2.excluded, FAIL('an out-of-domain vector value was read as false'));
}
ok('negative: an undeclared field, or a vector value outside its domain, is INVALID — never read as false / excluded');
{ // display / absence waiver
  const d = clone(); const disp = p1cells.filter((c) => c.kind === 'display' && c.S === 'S1' && c.brand === 'x_pizza' && c.lp === 'new');
  for (const c of disp) { const r = c.viaFrom || c.region; d.regions[r] = { ...doc.regions[id0], appliesWhenAny: [{ fulfil: ['pickup'] }] }; }
  assert.ok(RA.waivedObligations(d, p1cells, paths).some((p) => /DISPLAY:envio_gratis/.test(p)), FAIL('an absence / display obligation expressed as an exclusion passed'));
}
ok('negative: a display obligation whose every region is excluded → RED');
{ // a reviewed case that no longer evaluates as stated
  const k = Object.keys(doc.regions).find((r) => (doc.regions[r].cases.required || []).length);
  const d = clone(); d.regions[k].cases.excluded.push(d.regions[k].cases.required[0]);
  assert.ok(RA.problems(d, regionsDoc, paths).some((p) => /reviewed EXCLUDED case .* evaluates as applies/.test(p)), FAIL('a mis-stated reviewed case passed'));
}
ok('negative: a reviewed case that does not evaluate as stated → RED');
{ // run evidence: established → excluded; unknown → required; contradicted → RED-worthy
  const ex = 'xpizza-functions/whatsapp.js#sendMessage@xpizza-functions/index.js#notifyPickupReady';
  const cell = { S: 'S1', brand: 'x_pizza', lp: 'new' };
  const evOk = { persisted: { restaurant_id: 'x_pizza', order_type: 'delivery', payment_method: 'cash', status: 'new' }, lpAction: { action: 'create', ack: true }, kdsActions: [], kdsEvents: [], routed: [], steps: [] };
  assert.strictEqual(RA.runDecision(doc, ex, cell, evOk, paths).outcome, 'excluded', FAIL('an established exclusion did not apply'));
  assert.strictEqual(RA.runDecision(doc, ex, cell, { ...evOk, lpAction: undefined }, paths).outcome, 'required', FAIL('an unestablished field did not keep the cell required'));
  assert.strictEqual(RA.runDecision(doc, ex, cell, { ...evOk, persisted: { ...evOk.persisted, order_type: 'pickup' } }, paths).outcome, 'contradicted', FAIL('contradicting evidence was not reported'));
  // lpAction: an UNACKED action, or a different recorded action, is never established
  assert.strictEqual(RA.runDecision(doc, ex, cell, { ...evOk, lpAction: { action: 'create', ack: false } }, paths).outcome, 'contradicted', FAIL('an unacked action established lpAction'));
}
ok('run evidence: established → excluded; a field this run cannot establish → the cell stays REQUIRED; contradicting evidence (incl. an unacked action) → contradicted (RED)');
{ // codex mech r1 P1-3: the LP's expected STATUS is asserted for EVERY exclusion — persisted "ready" at LP new (an empty
  // KDS recorder) contradicts; no persisted status → unknown → required
  const ex = 'xpizza-functions/whatsapp.js#sendMessage@xpizza-functions/index.js#notifyPickupReady';
  const cell = { S: 'S1', brand: 'x_pizza', lp: 'new' };
  const evOk = { persisted: { restaurant_id: 'x_pizza', order_type: 'delivery', payment_method: 'cash', status: 'ready' }, lpAction: { action: 'create', ack: true }, kdsActions: [], kdsEvents: [] };
  const d = RA.runDecision(doc, ex, cell, evOk, paths);
  assert.ok(d.outcome === 'contradicted' && /status/.test(d.reason), FAIL(`a persisted status "ready" at LP new did not contradict (${JSON.stringify(d)})`));
  const { status, ...noStatus } = evOk.persisted;
  assert.strictEqual(RA.runDecision(doc, ex, cell, { ...evOk, persisted: noStatus }, paths).outcome, 'required', FAIL('an unevidenced status did not keep the cell required'));
  // every LP vector carries an in-domain expected status
  for (const S of Object.keys(paths.scenarios)) for (const b of paths.scenarios[S].brands || paths.defaultBrands) for (const [lp, v] of Object.entries(SS.vectorsOf(S, b, paths))) assert.ok(SS.FIELDS.status.includes(v.status), FAIL(`${S}|${b}|${lp} has no in-domain expected status (${v.status})`));
}
ok('status (codex P1-3): every LP has an explicit expected status from its effects; a persisted status that disagrees → contradicted for every exclusion; none persisted → required');
{ // codex mech r1 P1-2: form-action fields come from the OBSERVED recorder; a step LABEL alone never establishes them
  const v = SS.vectorOf('S1', 'x_pizza', 'new', paths);
  assert.ok(SS.CHECKS.sheetEdit.check(v, { steps: ['form.cart-sheet-edit'] }).unknown, FAIL('a step label alone established sheetEdit'));
  assert.strictEqual(SS.CHECKS.sheetEdit.check(v, { formEvents: [{ type: 'click', sheetEdit: true }] }), false, FAIL('an observed sheet edit did not contradict sheetEdit=false'));
  assert.ok(SS.CHECKS.restore.check(v, { formEvents: [] }).unknown, FAIL('restore established without the boot storage'));
  assert.strictEqual(SS.CHECKS.restore.check(v, { formEvents: [], formStorageAtBoot: ['xp_order_snapshot'] }), false, FAIL('a snapshot in storage at boot did not contradict restore=false'));
  // writeFailure: only a COMPLETE ack log establishes it
  assert.ok(SS.CHECKS.writeFailure.check(v, { ackLog: { complete: false, failures: 0 } }).unknown, FAIL('an incomplete ack log established writeFailure=false'));
  assert.strictEqual(SS.CHECKS.writeFailure.check(v, { ackLog: { complete: true, failures: 1 } }), false, FAIL('a failed write did not contradict writeFailure=false'));
  assert.ok(SS.CHECKS.lpAction.check(v, { steps: ['form.pay'] }).unknown, FAIL('a step label established lpAction'));
}
ok('action evidence (codex P1-2): step labels never establish a form action / lpAction; observed events, boot storage and a failed write contradict; an incomplete ack log → unknown');
{ // codex mech r1 P1-1: the binding covers p1-scenarios.json's EXECUTED definition — the tender 50000 → 100000 change
  const exec = JSON.parse(fs.readFileSync(path.join(__dirname, 'p1-scenarios.json'), 'utf8'));
  const e2 = JSON.parse(JSON.stringify(exec)); const k = Object.keys(e2.scenarios).find((S) => e2.scenarios[S].intent && 'tenderCents' in e2.scenarios[S].intent);
  assert.ok(k, FAIL('no executed scenario carries an intent tender to perturb'));
  e2.scenarios[k].intent.tenderCents = e2.scenarios[k].intent.tenderCents === 100000 ? 50000 : 100000;
  assert.ok(RA.problems(doc, regionsDoc, paths, e2).some((p) => p.startsWith(`scenario ${k}: its definition`)), FAIL(`changing ${k}'s executed tender did not re-open its exclusions`));
  const e3 = JSON.parse(JSON.stringify(exec)); e3.scenarios[k].steps = [...(e3.scenarios[k].steps || []), 'form.extra-step'];
  assert.ok(RA.problems(doc, regionsDoc, paths, e3).some((p) => p.startsWith(`scenario ${k}: its definition`)), FAIL(`changing ${k}'s executed steps did not re-open its exclusions`));
}
ok('scenario binding (codex P1-1): a change to the EXECUTED intent (tender 50000 ↔ 100000) or steps in p1-scenarios.json re-opens the scenario (RED)');
{ // codex mech r1 P1-4: an empty appliesWhenAny needs a nonempty validated context; context decides per run
  const k = Object.keys(doc.regions).find((r) => !doc.regions[r].appliesWhenAny.length && (doc.regions[r].context || []).includes('single-live-order'));
  assert.ok(k, FAIL('no single-live-order context entry to exercise'));
  const d = clone(); delete d.regions[k].context;
  assert.ok(RA.problems(d, regionsDoc, paths).some((p) => p.startsWith(`${k}: an empty appliesWhenAny needs a nonempty`)), FAIL('an empty appliesWhenAny without context passed (an unconditional exclusion)'));
  const d2 = clone(); d2.regions[k].context = ['no-such-context'];
  assert.ok(RA.problems(d2, regionsDoc, paths).some((p) => p.startsWith(`${k}: an empty appliesWhenAny needs a nonempty`)), FAIL('an unvalidated context passed'));
  const cell = { S: 'S1', brand: 'x_pizza', lp: 'new' };
  const ev = { persisted: { restaurant_id: 'x_pizza', order_type: 'delivery', payment_method: 'cash', status: 'new' }, lpAction: { action: 'create', ack: true }, kdsActions: [], kdsEvents: [], kdsHttp: [], routed: [] };
  assert.strictEqual(RA.runDecision(doc, k, cell, { ...ev, kdsTickets: 1 }, paths).outcome, 'excluded', FAIL('a single live order (established) did not exclude'));
  assert.strictEqual(RA.runDecision(doc, k, cell, { ...ev, kdsTickets: 2 }, paths).outcome, 'required', FAIL('2 tickets did not keep the context region required'));
  assert.strictEqual(RA.runDecision(doc, k, cell, ev, paths).outcome, 'required', FAIL('an unestablished ticket count did not keep the region required'));
  const kl = `xpizza-kitchen/index.html<script@0>#showLog@self`;
  assert.strictEqual(RA.runDecision(doc, kl, cell, { ...ev, kdsEvents: [{ type: 'click', logTap: true }] }, paths).outcome, 'required', FAIL('a log tap did not keep showLog required'));
  assert.strictEqual(RA.runDecision(doc, kl, cell, ev, paths).outcome, 'excluded', FAIL('no log tap did not exclude showLog'));
}
ok('context (codex P1-4): an empty condition without a nonempty validated context → RED; single-live-order established → excluded, 2 tickets / unknown → required; a recorded log tap keeps showLog required');
{ // codex mech r2 P1: codex's probe — S1 / x_pizza / preparing (lpAction kitchenStart, acked; status preparing; the kitchen
  // field unknown) with a stray hold gesture (pointerdown → pointerup before the threshold, no write): the hold family
  // must be REQUIRED, never excluded; without the gesture it is excluded; without a recorder it stays required
  const cell = { S: 'S1', brand: 'x_pizza', lp: 'preparing' };
  const ev = { persisted: { restaurant_id: 'x_pizza', order_type: 'delivery', payment_method: 'cash', status: 'preparing' }, lpAction: { action: 'kitchenStart', ack: true }, kdsHttp: [], routed: [] };
  const hold = Object.keys(doc.regions).filter((r) => (doc.regions[r].context || []).includes('kds-no-hold-gesture'));
  assert.ok(hold.includes('xpizza-kitchen/index.html<script@0>#setHoldVisual@xpizza-kitchen/index.html<script@0>#holdBegin') && hold.includes('xpizza-kitchen/index.html<script@0>#setHoldVisual@xpizza-kitchen/index.html<script@0>#holdCancel'), FAIL('the hold family lacks the kds-no-hold-gesture context'));
  const stray = [{ type: 'pointerdown', inTicket: true, holdGesture: true }, { type: 'pointerup', inTicket: true, holdGesture: true }];
  for (const r of hold) {
    assert.strictEqual(RA.runDecision(doc, r, cell, { ...ev, kdsEvents: stray }, paths).outcome, 'required', FAIL(`${r}: a stray hold gesture did not keep it required`));
    assert.strictEqual(RA.runDecision(doc, r, cell, { ...ev, kdsEvents: [] }, paths).outcome, 'excluded', FAIL(`${r}: no hold gesture did not exclude it`));
    assert.strictEqual(RA.runDecision(doc, r, cell, ev, paths).outcome, 'required', FAIL(`${r}: no KDS recorder did not keep it required`));
  }
  ok(`hold gestures (codex r2 P1): at S1 / preparing a stray hold (no write) keeps all ${hold.length} hold-family regions REQUIRED; zero observed gestures → excluded; no recorder → required`);
}
{ // codex mech r2 P2: extras by CONTENTS — empty collections are no extras; an unsupported representation is unknown
  const v = SS.vectorOf('S1', 'x_pizza', 'new', paths); const X = (items) => SS.CHECKS.extras.check(v, { formEvents: [], persisted: { items } });
  assert.strictEqual(X([{ extras: [] }]), true, FAIL('items:[{extras:[]}] contradicted extras=false'));
  assert.strictEqual(X([{ options: [] }]), true, FAIL('items:[{options:[]}] contradicted extras=false'));
  assert.strictEqual(X([{ extras: {} }, { id: 'a' }]), true, FAIL('an empty keyed extras object contradicted extras=false'));
  assert.strictEqual(X([{ extras: [{ id: 'queso' }] }]), false, FAIL('a real extra did not contradict extras=false'));
  assert.strictEqual(X({ 0: { options: { size: 'L' } } }), false, FAIL('a real option (keyed items) did not contradict extras=false'));
  assert.ok(X([{ extras: 'queso' }]).unknown && X('items').unknown && X([null]).unknown, FAIL('an unsupported extras representation was not unknown'));
}
ok('extras (codex r2 P2): empty extras / options collections are no extras; real entries contradict; an unsupported representation is unknown, never contradicted');
console.log(`\nr3-applicability guard: OK (${n})`);
