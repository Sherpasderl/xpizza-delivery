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
// over P1-a's ENFORCED slice readers (frozen.readers): the cells the 66 were reviewed for; other readers' S1 / new
// exclusions are new reviewed entries (the review report lists them)
const s1 = gateA({ scenarios: ['S1'], brands: ['x_pizza'], lps: ['new'] }).cells.filter((c) => frozen.readers.includes(c.R));
assert.deepStrictEqual(frozen.readers, ['R1', 'R9', 'R13', 'R14', 'R15'], FAIL(`the lock's reader set changed: ${JSON.stringify(frozen.readers)}`));
const derived = [...new Set(RA.derive(doc, s1, paths).map((x) => x.region))].sort();
assert.deepStrictEqual(derived, [...frozen.regions].sort(), FAIL(`derived exclusions at ${frozen.context} ≠ the frozen P1-a 66 (${frozen.frozenAt}):\n  missing ${JSON.stringify(frozen.regions.filter((r) => !derived.includes(r)))}\n  extra ${JSON.stringify(derived.filter((r) => !frozen.regions.includes(r)))}`));
ok(`regression lock: the derived exclusions at ${frozen.context} on P1-a's slice readers (${frozen.readers.join(' ')}) are EXACTLY the ${frozen.regions.length} P1-a regions frozen at ${frozen.frozenAt}`);

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
  // codex b12 r1 P1-5: BOTH storage areas, before the scripts; a stored key (codex's sessionStorage sherpa_reload_snapshot) → unknown; a late capture → unknown
  const B = (local, session, at = 'beforeScripts') => ({ at, local, session });
  assert.ok(SS.CHECKS.restore.check(v, { formEvents: [], formStorageAtBoot: B([], ['sherpa_reload_snapshot']) }).unknown, FAIL('a sessionStorage reload snapshot before the scripts did not leave restore unknown'));
  assert.ok(SS.CHECKS.restore.check(v, { formEvents: [], formStorageAtBoot: B([], [], 'afterBoot') }).unknown, FAIL('storage captured after the scripts established restore'));
  assert.strictEqual(SS.CHECKS.restore.check(v, { formEvents: [], formStorageAtBoot: B([], []) }), true, FAIL('empty storage before the scripts did not establish no restore'));
  assert.strictEqual(SS.CHECKS.restore.check(v, { formEvents: [{ type: 'click', restore: true }], formStorageAtBoot: B([], []) }), false, FAIL('a restore event did not contradict restore=false'));
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
{ // P1-b bulk (messaging): the driver check reads the order's TASKS; no-call:<fn> from a COMPLETE invocation log; caller sets
  const v = SS.vectorOf('S1', 'x_pizza', 'new', paths); const per = { restaurant_id: 'x_pizza', status: 'new' };
  const AL = (events, complete = true) => ({ complete, events });
  assert.ok(SS.CHECKS.driver.check(v, { persisted: per, tasks: {} }).unknown, FAIL('driver none established without the assignment transition log'));
  assert.ok(SS.CHECKS.driver.check(v, { persisted: per, tasks: {}, assignLog: AL([], false) }).unknown, FAIL('an incomplete assignment log established driver none'));
  assert.strictEqual(SS.CHECKS.driver.check(v, { persisted: per, tasks: {}, assignLog: AL([]) }), true, FAIL('no assignment transition did not establish driver none'));
  // codex b12 r1 P1-3: assigned THEN cleared before gate time is "assigned" (the final snapshot alone would say none)
  assert.strictEqual(SS.CHECKS.driver.check(v, { persisted: per, tasks: { o_pickup: { assigned_driver_id: null } }, assignLog: AL([{ path: 'tasks/o_pickup', before: null, after: 'd1' }, { path: 'tasks/o_pickup', before: 'd1', after: null }]) }), false, FAIL('assigned-then-cleared did not contradict driver none'));
  assert.strictEqual(SS.CHECKS.driver.check(v, { persisted: per, tasks: { o_pickup: { assigned_driver_id: 'd1' } }, assignLog: AL([]) }), false, FAIL('a task with an assigned driver did not contradict driver none'));
  const nc = 'xpizza-functions/index.js#send@xpizza-functions/index.js#pixelPayWebhook'; const cell = { S: 'S1', brand: 'x_pizza', lp: 'new' };
  const ev = { persisted: { ...per, order_type: 'delivery', payment_method: 'cash' }, lpAction: { action: 'create', ack: true } };
  assert.strictEqual(RA.runDecision(doc, nc, cell, { ...ev, fnCalls: { complete: true, names: ['createOrder'] } }, paths).outcome, 'excluded', FAIL('no pixelPayWebhook call (complete log) did not exclude'));
  assert.strictEqual(RA.runDecision(doc, nc, cell, { ...ev, fnCalls: { complete: true, names: ['createOrder', 'pixelPayWebhook'] } }, paths).outcome, 'required', FAIL('a pixelPayWebhook call did not keep it required'));
  assert.strictEqual(RA.runDecision(doc, nc, cell, { ...ev, fnCalls: { complete: false, names: ['createOrder'] } }, paths).outcome, 'required', FAIL('an incomplete invocation log established no-call'));
  assert.strictEqual(RA.runDecision(doc, nc, cell, ev, paths).outcome, 'required', FAIL('no invocation log established no-call'));
  const d = clone(); d.regions[nc].context = ['no-call:noSuchFunction'];
  assert.ok(RA.problems(d, regionsDoc, paths).some((p) => p.startsWith(`${nc}: unknown context no-call:noSuchFunction`)), FAIL('a no-call context on a non-exported function passed'));
  const k = 'xpizza-functions/staff-push.js#orderAgeAnchor@xpizza-functions/staff-push.js#isStuck'; const cg = doc.regions[k].guards.find((g) => g.kind === 'C' && /isStuck$/.test(g.output));
  const rd2 = { regions: [...regionsDoc.regions, { output: 'xpizza-functions/staff-push.js#isStuck', region: 'x@new', consumer: 'xpizza-functions/index.js#createOrderApp.all>anon', line: 1 }] };
  assert.ok(cg && AP.guardStale(cg, { regionsDoc: rd2 }) && !AP.guardStale(cg), FAIL('a new caller of isStuck did not make the sweep-only exclusion stale'));
}
ok('bulk mechanism: driver none needs the COMPLETE assignment transition log + task records (an assigned task, or assigned-then-cleared, contradicts); no-call:<fn> only from a COMPLETE invocation log naming no <fn> (a call / incomplete / absent → required; a non-exported fn → RED); a new caller of a sweep-only function → stale');
{ // P1-b bulk (dispatch): the contract UI recorder on a REAL DOM + the no-ui:<page>:<kind>=<value> context + K guards
  const { JSDOM } = require('jsdom'); const UI = require('./ui-recorder');
  const dom = new JSDOM('<!doctype html><body><div class="sheet"><button data-pick="o1"><span id="inner">Reasignar</span></button><div data-detail="o2" class="ord">x</div></div></body>');
  const sink = UI.installUiRecorder(dom.window);
  dom.window.document.getElementById('inner').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(sink.events.length === 1 && UI.matches(sink.events[0], 'attr', 'data-pick') && !UI.matches(sink.events[0], 'attr', 'data-detail') && UI.matches(sink.events[0], 'class', 'sheet'), FAIL(`the UI recorder did not record the click's ancestor path (${JSON.stringify(sink.events)})`));
  const P = 'xpizza-dispatch-mobile'; const c = SS.contextOf(`no-ui:${P}:attr=data-pick`);
  assert.ok(c, FAIL('no-ui on a real page control was not a valid context'));
  assert.ok(c.check({}).unknown && c.check({ uiEvents: { [P]: { installedAt: 'after-boot', events: [] } } }).unknown, FAIL('an absent / late recorder established no-ui'));
  assert.strictEqual(c.check({ uiEvents: { [P]: sink.installedAt && { installedAt: 'beforeScripts', events: sink.events } } }), false, FAIL('a recorded [data-pick] click did not defeat no-ui'));
  assert.strictEqual(c.check({ uiEvents: { [P]: { installedAt: 'beforeScripts', events: [] } } }), true, FAIL('zero recorded events did not establish no-ui'));
  assert.ok(!SS.contextOf(`no-ui:${P}:attr=data-r3-no-such-control`) && !SS.contextOf('no-ui:no-such-page:attr=data-pick') && !SS.contextOf(`no-ui:${P}:style=x`), FAIL('a no-ui matcher absent from the page source / unknown page / unknown kind was accepted'));
  const k = 'xpizza-orders/index.html#renderStage2Summary@xpizza-orders/index.html<script@2>#applyRedeemQuoteToTotals'; const FP = 'xpizza-orders';
  const rk = UI.installUiRecorder(new JSDOM('<!doctype html><body><div class="rk"><button data-rk-clear="1">Quitar</button></div></body>').window); rk.events.length = 0;
  { const w2 = new JSDOM('<!doctype html><body><button data-rk-clear="1" id="q">Quitar</button></body>').window; const s2 = UI.installUiRecorder(w2); w2.document.getElementById('q').dispatchEvent(new w2.MouseEvent('click', { bubbles: true })); rk.events.push(...s2.events); }
  const cell = { S: 'S1', brand: 'x_pizza', lp: 'new' }; const ev = { persisted: { restaurant_id: 'x_pizza', status: 'new' }, lpAction: { action: 'create', ack: true } };
  const ev2 = { ...ev, persisted: { ...ev.persisted, order_type: 'delivery', payment_method: 'cash' }, formEvents: [], formStorageAtBoot: { at: 'beforeScripts', local: [], session: [] } };
  assert.strictEqual(RA.runDecision(doc, k, cell, { ...ev2, uiEvents: { [FP]: { installedAt: 'beforeScripts', events: [] } } }, paths).outcome, 'excluded', FAIL('redeem summary: zero reward-control events did not exclude'));
  // codex b12 r1 P1-4: apply-then-remove a reward (a [data-rk-clear] click) on an ordinary cash order → REQUIRED
  assert.strictEqual(RA.runDecision(doc, k, cell, { ...ev2, uiEvents: { [FP]: { installedAt: 'beforeScripts', events: rk.events } } }, paths).outcome, 'required', FAIL('redeem summary: a reward removal ([data-rk-clear]) did not keep it required'));
  assert.strictEqual(RA.runDecision(doc, k, cell, ev2, paths).outcome, 'required', FAIL('redeem summary: no form UI recorder did not keep it required'));
  const kg = AP.bindGuard(['K', 'xpizza-dispatch/index.html', 'openOrderDetailModal(']);
  const real = fs.readFileSync(path.join(__dirname, '..', '..', kg.file), 'utf8');
  assert.ok(!AP.guardStale(kg) && AP.guardStale(kg, { readFile: () => real + '\nopenOrderDetailModal(x);' }), FAIL('a new openOrderDetailModal( call site did not make a K guard stale'));
}
ok('UI mechanism: the UI recorder records a click\'s ancestor path on a real DOM; no-ui is established only by a before-scripts recorder with no matching event (absent / late → unknown; a matching click → required; codex b12 P1-4: a reward removal [data-rk-clear] keeps the redeem summary required); matchers absent from the page source / unknown page or kind → invalid; a new call site of a K-pinned handler → stale');
{ // codex b12 r1 P1-1: the invocation log is recorded at the FUNCTION BOUNDARY — a direct .run() is recorded; an export
  // that is not (or no longer) a recorder wrapper, or an invocation before installation, makes the log incomplete
  const FR = require('./fn-recorder');
  const mod = { flushStaffPushQueue: { run: () => 'ran', __endpoint: { scheduleTrigger: {} } }, createOrder: Object.assign(function () { return 'http'; }, { __endpoint: { httpsTrigger: {} } }), CONST: 3 };
  const r = FR.installFnRecorder(mod);
  mod.flushStaffPushQueue.run(); mod.createOrder();
  assert.ok(r.complete() && r.names.includes('flushStaffPushQueue') && r.names.includes('createOrder') && mod.flushStaffPushQueue.__endpoint && mod.createOrder.__endpoint, FAIL(`a direct .run() / an HTTP call was not recorded at the boundary (${JSON.stringify(r.names)})`));
  mod.createOrder = function () { return 'replaced'; };
  assert.ok(!r.complete(), FAIL('an export replaced after installation (unwrapped) still claimed a complete log'));
  assert.ok(!FR.installFnRecorder({ a() {} }, { invocationsBefore: 1 }).complete(), FAIL('a recorder installed after an invocation claimed a complete log'));
  // codex b12 r1 P1-2: an ALIAS reference (const check = isStuck; check(...)) escapes the caller census → the R guard is stale
  const k = 'xpizza-functions/staff-push.js#orderAgeAnchor@xpizza-functions/staff-push.js#isStuck';
  const rg = doc.regions[k].guards.find((g) => g.kind === 'R' && g.name === 'isStuck');
  const units = require('./census').sources();
  const alias = units.map((u) => (u.file === 'xpizza-functions/index.js' ? { ...u, code: `${u.code}\nconst check = isStuck; check({});` } : u));
  assert.ok(rg && !AP.guardStale(rg) && /references to isStuck changed/.test(AP.guardStale(rg, { units: alias }) || ''), FAIL('an alias of isStuck did not make the sweep-only exclusion stale'));
}
ok('boundary + references (codex b12 P1-1/2): a direct .run() and an HTTP call are recorded at the function boundary; a replaced export / late install → incomplete log; an alias reference to a caller-guarded function → stale');
{ // dispatch batch: the delegated dispatch-lite picker and the desktop detail modal decide on their own controls
  const { JSDOM } = require('jsdom'); const UI = require('./ui-recorder');
  const P = 'xpizza-dispatch-mobile'; const k = `${P}/index.html<script@0>#openPicker@${P}/index.html<script@0>#document.addEventListener`;
  const dom = new JSDOM('<!doctype html><body><div class="pass"><button data-pick="o1"><span id="t">Reasignar</span></button></div></body>');
  const sink = UI.installUiRecorder(dom.window); dom.window.document.getElementById('t').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const cell = { S: 'S1', brand: 'x_pizza', lp: 'new' }; const ev = { persisted: { restaurant_id: 'x_pizza', status: 'new' }, lpAction: { action: 'create', ack: true } };
  const U = (page, events) => ({ uiEvents: { [page]: { installedAt: 'beforeScripts', events } } });
  assert.strictEqual(RA.runDecision(doc, k, cell, { ...ev, ...U(P, []) }, paths).outcome, 'excluded', FAIL('dispatch-lite openPicker: zero events did not exclude'));
  assert.strictEqual(RA.runDecision(doc, k, cell, { ...ev, ...U(P, sink.events) }, paths).outcome, 'required', FAIL('dispatch-lite openPicker: a [data-pick] click did not keep it required'));
  assert.strictEqual(RA.runDecision(doc, k, cell, ev, paths).outcome, 'required', FAIL('dispatch-lite openPicker: no recorder did not keep it required'));
  const D = 'xpizza-dispatch'; const m = `${D}/index.html<script@0>#renderOrderDetailModal@${D}/index.html<script@0>#openOrderDetailModal`;
  const d2 = new JSDOM('<!doctype html><body><div class="delivered-card" data-order-id="o9"><b id="t">x</b></div></body>'); const s2 = UI.installUiRecorder(d2.window); d2.window.document.getElementById('t').dispatchEvent(new d2.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(RA.runDecision(doc, m, cell, { ...ev, ...U(D, s2.events) }, paths).outcome, 'required', FAIL('dispatch detail modal: a delivered-card click did not keep it required'));
  assert.strictEqual(RA.runDecision(doc, m, cell, { ...ev, ...U(D, []) }, paths).outcome, 'excluded', FAIL('dispatch detail modal: zero events did not exclude'));
  const n = Object.values(doc.regions).filter((e) => /^dispatch(-lite)?-ui$/.test(e.group)).length;
  assert.ok(n === 61, FAIL(`dispatch-ui entries: ${n} (expected 61)`));
}
ok('dispatch batch: 61 dispatch-ui entries; the delegated dispatch-lite picker ([data-pick]) and the desktop detail modal (a delivered-card click) stay REQUIRED on a matching event or with no recorder, excluded only with zero recorded events');
console.log(`\nr3-applicability guard: OK (${n})`);
