'use strict';
// R3 P1-b — THE APPLICABILITY GUARD (static; npm test chain) for the REGION-LEVEL, DERIVED model
// (contract/region-applicability.js; DESIGN-R3-P1B.md rev 2). Every reviewed region entry is fresh (call site, scope,
// guard / dispatch source, scenario bindings), well-formed (declared fields, in-domain values, contract authority, why
// false excludes) and its reviewed cases evaluate as stated; the derived exclusions at S1 / x_pizza / new are EXACTLY the
// frozen P1-a set (66 + int7 detailCtaTap = 67) — P1-c's R4 / R5 entries are other readers; no absence / display obligation is waived anywhere in P1; gate B agrees.
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
assert.deepStrictEqual(derived, [...frozen.regions].sort(), FAIL(`derived exclusions at ${frozen.context} ≠ the frozen P1-a ${frozen.regions.length} (${frozen.frozenAt}):\n  missing ${JSON.stringify(frozen.regions.filter((r) => !derived.includes(r)))}\n  extra ${JSON.stringify(derived.filter((r) => !frozen.regions.includes(r)))}`));
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
{ // int7: re-pointing the detail modal's CTA (its onclick no longer the reviewed detailCtaTap button) re-opens the detailCtaTap entry
  const id = Object.keys(doc.regions).find((r) => /#detailCtaTap$/.test(r));
  assert.ok(id && JSON.stringify(doc.regions[id].appliesWhenAny) === JSON.stringify([{ detailCta: [true] }]), FAIL('no detailCtaTap entry on detailCta'));
  const real = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-orders', 'index.html'), 'utf8');
  const mutated = real.replace('id="detail-cta" onclick="detailCtaTap()"', 'id="detail-cta" onclick="openCartReview()"');
  assert.ok(mutated !== real, FAIL('the detail-cta probe text moved'));
  const st = doc.regions[id].guards.map((g) => AP.guardStale(g, { readFile: (f) => (f === 'xpizza-orders/index.html' ? mutated : fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8')) })).filter(Boolean);
  assert.ok(st.length > 0, FAIL('re-pointing the detail CTA did not invalidate the detailCtaTap entry'));
}
ok('status (codex P1-3): every LP has an explicit expected status from its effects; a persisted status that disagrees → contradicted for every exclusion; none persisted → required');
{ // codex mech r1 P1-2: form-action fields come from the OBSERVED recorder; a step LABEL alone never establishes them
  const v = SS.vectorOf('S1', 'x_pizza', 'new', paths);
  assert.ok(SS.CHECKS.sheetEdit.check(v, { steps: ['form.cart-sheet-edit'] }).unknown, FAIL('a step label alone established sheetEdit'));
  assert.strictEqual(SS.CHECKS.sheetEdit.check(v, { formEvents: [{ type: 'click', sheetEdit: true }] }), false, FAIL('an observed sheet edit did not contradict sheetEdit=false'));
  // int7 (P1-a e8d0414 → P1-b): detailCta — the dish detail CTA (detailCtaTap launcher add) comes from the recorder, never a label
  assert.ok(SS.CHECKS.detailCta.check(v, { steps: ['form.detail-cta'] }).unknown, FAIL('a step label alone established detailCta'));
  assert.strictEqual(SS.CHECKS.detailCta.check(v, { formEvents: [{ type: 'click', target: 'button#detail-cta', detailCta: true }] }), false, FAIL('an observed detail-CTA tap did not contradict detailCta=false'));
  assert.strictEqual(SS.CHECKS.detailCta.check(v, { formEvents: [{ type: 'click', target: 'button#x' }] }), true, FAIL('a run with no detail-CTA tap did not establish detailCta=false'));
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
  // codex b3 r1: the redeem summary is decided on EXECUTION of applyRedeemQuoteToTotals (the UI recorder only supports)
  const k = 'xpizza-orders/index.html#renderStage2Summary@xpizza-orders/index.html<script@2>#applyRedeemQuoteToTotals'; const fk = 'xpizza-orders/index.html<script@2>#applyRedeemQuoteToTotals';
  const cell = { S: 'S1', brand: 'x_pizza', lp: 'new' }; const ev = { persisted: { restaurant_id: 'x_pizza', status: 'new' }, lpAction: { action: 'create', ack: true } };
  const ev2 = { ...ev, persisted: { ...ev.persisted, order_type: 'delivery', payment_method: 'cash' }, formEvents: [], formStorageAtBoot: { at: 'beforeScripts', local: [], session: [] } };
  assert.deepStrictEqual(doc.regions[k].context, [`no-exec:${fk}`], FAIL('the redeem summary is not decided on the execution of applyRedeemQuoteToTotals'));
  assert.strictEqual(RA.runDecision(doc, k, cell, { ...ev2, exec: { probed: [fk], entered: [] } }, paths).outcome, 'excluded', FAIL('redeem summary: a probed, never-entered callback did not exclude'));
  assert.strictEqual(RA.runDecision(doc, k, cell, { ...ev2, exec: { probed: [fk], entered: [fk] } }, paths).outcome, 'required', FAIL('redeem summary: an entered callback (e.g. a reward removal) did not keep it required'));
  assert.strictEqual(RA.runDecision(doc, k, cell, { ...ev2, exec: { probed: [], entered: [] } }, paths).outcome, 'required', FAIL('redeem summary: an UNPROBED callback established no-exec'));
  assert.strictEqual(RA.runDecision(doc, k, cell, ev2, paths).outcome, 'required', FAIL('redeem summary: no trace did not keep it required'));
  assert.ok(!SS.contextOf('no-exec:xpizza-orders/index.html<script@2>#noSuchFunction'), FAIL('a no-exec context on a scope the census does not name was accepted'));
  const kg = AP.bindGuard(['K', 'xpizza-dispatch/index.html', 'openOrderDetailModal(']);
  const real = fs.readFileSync(path.join(__dirname, '..', '..', kg.file), 'utf8');
  assert.ok(!AP.guardStale(kg) && AP.guardStale(kg, { readFile: () => real + '\nopenOrderDetailModal(x);' }), FAIL('a new openOrderDetailModal( call site did not make a K guard stale'));
}
ok('UI + exec mechanism: the redeem summary is decided on the EXECUTION of applyRedeemQuoteToTotals (probed + never entered → excluded; entered / unprobed / no trace → required; an unknown scope → invalid); the (supporting) UI recorder records a click\'s ancestor path on a real DOM; no-ui is established only by a before-scripts recorder with no matching event (absent / late → unknown; a matching click → required; codex b12 P1-4: a reward removal [data-rk-clear] keeps the redeem summary required); matchers absent from the page source / unknown page or kind → invalid; a new call site of a K-pinned handler → stale');
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
{ // dispatch batch on EXECUTION (codex P1-b b3 r1): the tracer probes the real dispatch unit; codex's detached .click(),
  // value= rewiring and timer drift all ENTER the handler → required; never entered → excluded
  const T = require('./tracer'); const { JSDOM } = require('jsdom'); const acorn = require('acorn');
  const D = 'xpizza-dispatch/index.html<script@0>'; const X = 'xpizza-dispatch/xpizza-delivery.js';
  const unit = require('./census').sources().find((u) => u.file === D);
  const tr = T.transform(D, unit.code, { module: unit.module });
  for (const f of ['confirmCancelOrder', 'resolveReconciliationAction', 'openOrderDetailModal', 'openPicker']) assert.ok(tr.probed.includes(`${D}#${f}`), FAIL(`the tracer did not probe ${D}#${f} on the real unit (${JSON.stringify(tr.probed)})`));
  assert.strictEqual(tr.code.split('\n').length, unit.code.split('\n').length, FAIL('the entry probes changed the line count (not line-preserving)'));
  acorn.parse(tr.code, { ecmaVersion: 'latest', sourceType: unit.module ? 'module' : 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  // the three paths codex probed, executed through the SAME probe rewrite
  const FNS = ['confirmCancelOrder', 'resolveReconciliationAction', 'openOrderDetailModal']; const probes = new Map(FNS.map((f, i) => [f, i]));
  const snippet = `function confirmCancelOrder(oid){ window.__c = oid; }
function resolveReconciliationAction(oid, a){ window.__r = a; }
function openOrderDetailModal(id){ window.__o = id; }
const b = document.createElement('button'); b.addEventListener('click', () => confirmCancelOrder('o1')); window.__detached = b;
const c = document.createElement('button'); c.value = 'close_fulfilled'; c.className = 'recon-btn'; document.body.appendChild(c);
c.addEventListener('click', () => resolveReconciliationAction('o1', c.dataset.reconAction || c.value)); window.__recon = c;
window.__timer = () => setTimeout(() => openOrderDetailModal('o9'), 0);`;
  const rw = T.rewrite(snippet, [], false, probes, D);
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }); const w = dom.window; const entered = new Set();
  // a deterministic timer queue (the guard is synchronous): the callback runs from the queue, not from any UI event
  const timers = []; w.setTimeout = (f) => { timers.push(f); return timers.length; };
  w.__r3enter = (i) => entered.add(`${D}#${FNS[i]}`); w.eval(rw.code);
  const sink = require('./ui-recorder').installUiRecorder(w);
  w.__detached.click(); w.__recon.click(); w.__timer(); while (timers.length) timers.shift()();
  assert.ok(w.__c === 'o1' && w.__r === 'close_fulfilled' && w.__o === 'o9', FAIL('the drift snippet did not run its handlers'));
  assert.ok(FNS.every((f) => entered.has(`${D}#${f}`)), FAIL(`a detached .click() / a value= rewiring / a timer was not recorded as handler entry (${[...entered]})`));
  assert.ok(!sink.events.some((e) => e.path.some((n) => n.attrs.includes('data-recon-action'))), FAIL('probe premise: the rewired recon button carried no data-recon-action'));
  const cell = { S: 'S1', brand: 'x_pizza', lp: 'new' }; const ev = { persisted: { restaurant_id: 'x_pizza', status: 'new' }, lpAction: { action: 'create', ack: true } };
  const probed = FNS.map((f) => `${D}#${f}`);
  const regs = [`${X}#cancelOrderRemote@${D}#confirmCancelOrder`, `${X}#resolveReconciliation@${D}#resolveReconciliationAction`, `${D}#renderOrderDetailModal@${D}#openOrderDetailModal`];
  for (const r of regs) {
    assert.strictEqual(RA.runDecision(doc, r, cell, { ...ev, exec: { probed, entered: [...entered] } }, paths).outcome, 'required', FAIL(`${r}: an executed handler (detached click / rewired value / timer) did not keep it required`));
    assert.strictEqual(RA.runDecision(doc, r, cell, { ...ev, exec: { probed, entered: [] } }, paths).outcome, 'excluded', FAIL(`${r}: a probed, never-entered handler did not exclude`));
    assert.strictEqual(RA.runDecision(doc, r, cell, { ...ev, uiEvents: { 'xpizza-dispatch': { installedAt: 'beforeScripts', events: [] } } }, paths).outcome, 'required', FAIL(`${r}: UI evidence alone (no trace) excluded it — the UI recorder is not the authority`));
  }
  const n = Object.values(doc.regions).filter((e) => /^dispatch(-lite)?-ui$/.test(e.group)).length;
  const noUi = Object.entries(doc.regions).filter(([, e]) => (e.context || []).some((c) => /^no-ui:/.test(c))).map(([id]) => id);
  assert.ok(n === 61 && noUi.length === 0, FAIL(`dispatch entries ${n} (expected 61); entries still decided on UI events: ${noUi.slice(0, 3)}`));
}
ok('dispatch on EXECUTION (codex b3 r1): the real dispatch unit is probed line-preservingly; a detached .click(), a value= rewiring and a timer each ENTER the handler → required; probed + never entered → excluded; UI evidence alone never excludes; no entry is decided on UI events');
{ // P1-c c1 (R4 driver board + R5 assignment push): the board entries are decided on getDriverOrders' filter, the
  // atomic delivered writers and the server's terminal task delete; drift in any of them → stale; run evidence can
  // establish only "never assigned" (an unassigned / delivered LP stays required)
  const P = 'xpizza-driver/index.html<script@0>'; const D = 'xpizza-driver/xpizza-delivery.js'; const I = 'xpizza-functions/index.js';
  const board = Object.entries(doc.regions).filter(([, e]) => e.group === 'driverBoard');
  const push = [`${I}#notifyDriverOnAssignment@self`, `${I}#sendDriverPush@${I}#notifyDriverOnAssignment`];
  assert.ok(board.length === 22 && board.every(([, e]) => JSON.stringify(e.appliesWhenAny) === JSON.stringify([{ driver: ['assigned', 'reassigned'], terminal: ['none'] }])) && push.every((k) => doc.regions[k] && doc.regions[k].group === 'driverPush'), FAIL(`driver board entries ${board.length} (expected 22) / assignment push entries missing`));
  const units = require('./census').sources();
  const edit = (file, from, to) => units.map((u) => { if (u.file !== file) return u; assert.strictEqual(u.code.split(from).length - 1, 1, FAIL(`probe text not exactly once in ${file}: ${from}`)); return { ...u, code: u.code.replace(from, to) }; });
  // each distinct guard once per probe; a scope guard re-parses only its own unit (the R guards scan every unit)
  const uniq = new Map(); for (const [, e] of board) for (const g of e.guards) uniq.set(JSON.stringify(g), g);
  const ownUnit = (g, u) => u.filter((x) => g.scope.startsWith(`${x.file}#`) || g.scope.startsWith(`${x.file.replace(/<script@\d+>$/, '')}#`));
  // F / K guards read the file: serve a whole-file unit's (edited) code, else the disk
  const fileOf = (u) => (f) => { const x = u.find((y) => y.file === f); return x ? x.code : fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8'); };
  const staleIn = (u) => { const st = new Set([...uniq].filter(([, g]) => AP.guardStale(g, { units: g.kind === 'S' ? ownUnit(g, u) : u, readFile: fileOf(u) })).map(([k]) => k)); return board.filter(([, e]) => e.guards.some((g) => st.has(JSON.stringify(g)))).length; };
  const base = staleIn(units); assert.strictEqual(base, 0, FAIL(`${base} driver board entries are stale on the real source`));
  const drift = [
    ['the assigned-driver filter removed', edit(D, 'if (t.assigned_driver_id !== driverId) return;\n    if (!grouped[t.order_id])', 'if (!grouped[t.order_id])')],
    ['completed deliveries kept on the board', edit(P, 'const orders = XPD.getDriverOrders(currentUser.uid, allTasks, allOrders);', 'const orders = XPD.getDriverOrders(currentUser.uid, allTasks, allOrders, true);')],
    ['the idle screen renders a payment row', edit(P, 'syncIdleStats();\n}', 'syncIdleStats(); paymentRowHtml(allOrders, escapeHtml);\n}')],
    ['a new ORDER_STATUS.DELIVERED writer', units.map((u) => (u.file === 'xpizza-dispatch/index.html<script@0>' ? { ...u, code: u.code + '\nfunction __forceDelivered(id) { return { [\'orders/\' + id + \'/status\']: ORDER_STATUS.DELIVERED }; }' } : u))],
    ['the server terminal task delete dropped', edit(I, 'await captureDeliveryAttributionAndDelete(db, orderId);', '')],
    // codex P1-c r1 P2: the deletion INSIDE the helper, and the terminal-edge implementation
    ['the helper\'s task deletion dropped', edit('xpizza-functions/driver-attribution.js', 'await db.ref().update({ [`tasks/${orderId}_pickup`]: null, [`tasks/${orderId}_delivery`]: null });', '')],
    ['the terminal edge never fires', edit('xpizza-functions/tasks-retention.js', 'return !!terminalSet && terminalSet.has(after) && !terminalSet.has(before);', 'return false;')],
    ['delivered dropped from the real-time terminal set', edit('xpizza-functions/tasks-retention.js', "const REALTIME_TERMINAL_STATUSES = new Set(['delivered', 'completed']);", "const REALTIME_TERMINAL_STATUSES = new Set(['completed']);")],
  ];
  for (const [what, u] of drift) { const k = what === 'the idle screen renders a payment row' ? board.filter(([id]) => /paymentRowHtml/.test(id)).length : board.length; const got = staleIn(u); assert.ok(got >= k, FAIL(`${what}: only ${got} of the driver board entries went stale`)); }
  const pg = doc.regions[push[0]].guards.find((g) => g.kind === 'S' && g.text === 'if (!newDriverId) return;');
  assert.ok(pg && !AP.guardStale(pg) && AP.guardStale(pg, { units: edit(I, 'if (!newDriverId) return;', 'if (!newDriverId && false) return;') }), FAIL('weakening the assignment push guard did not make it stale'));
  // run evidence: never assigned (complete log + task records) → excluded; an assigned task → contradicted; unassigned /
  // delivered LPs cannot be established by evidence (driver ≠ none) → required, never excluded
  const r = `${D}#getDriverOrders@${P}#renderActiveAndQueue`; const id = board.find(([k]) => /paymentRowHtml@.*renderActiveCard$/.test(k))[0];
  assert.ok(!doc.regions[r], FAIL('getDriverOrders itself (the filter) must stay REQUIRED'));
  const ev = (st, tasks, events = [], action = st === 'delivered' ? 'completeDelivery' : 'create') => ({ persisted: { restaurant_id: 'x_pizza', status: st }, tasks, assignLog: { complete: true, events }, lpAction: { action, ack: true } });
  const at = (S, lp) => ({ S, brand: 'x_pizza', lp });
  assert.strictEqual(RA.runDecision(doc, id, at('S1', 'new'), ev('new', { t_pickup: { assigned_driver_id: null } })).outcome, 'excluded', FAIL('never assigned did not exclude the board at S1/new'));
  assert.strictEqual(RA.runDecision(doc, id, at('S1', 'new'), ev('new', { t_pickup: { assigned_driver_id: 'd1' } })).outcome, 'contradicted', FAIL('an assigned task at S1/new did not contradict'));
  assert.strictEqual(RA.runDecision(doc, id, at('S1', 'new'), ev('new', {}, [{ before: null, after: 'd1' }])).outcome, 'contradicted', FAIL('assigned-then-cleared at S1/new did not contradict'));
  assert.strictEqual(RA.runDecision(doc, id, at('S1t-c', 'unassigned'), ev('ready', {}, [], 'unassign')).outcome, 'required', FAIL('an unassigned LP was excluded on evidence that cannot establish it'));
  assert.strictEqual(RA.runDecision(doc, id, at('S1', 'delivered'), ev('delivered', {})).outcome, 'required', FAIL('a delivered LP was excluded without driver evidence'));
  assert.strictEqual(RA.staticDecision(doc, id, at('S1', 'assigned')).excluded, false, FAIL('the board was excluded at an assigned LP'));
}
ok('driver board (P1-c c1): 22 entries on driver ∈ {assigned, reassigned} ∧ terminal = none + 2 assignment-push entries; dropping the assigned-driver filter, keeping completed deliveries, an idle-screen payment row, a new DELIVERED writer, dropping the server terminal task delete, the helper\'s deletion itself (codex r1 P2), the terminal edge or delivered from its set → stale; weakening `if (!newDriverId) return;` → stale; getDriverOrders stays required; never assigned → excluded, assigned / assigned-then-cleared → contradicted, unassigned / delivered LPs → required');
{ // P1-c c2 (R4 driver actions): decided on the ACTION's own execution (no-exec on xpizza-delivery.js#<fn>, never the
  // generic handler bundle); where the action IS the LP's action (pickupComplete / completeDelivery) it stays required
  const D = 'xpizza-driver/xpizza-delivery.js'; const P = 'xpizza-driver/index.html<script@0>';
  const acts = Object.entries(doc.regions).filter(([, e]) => e.group === 'driver-action');
  const want = { acceptTask: 1, pickupComplete: 1, completeTask: 2, acceptSecondOrder: 2, arriveAtRestaurant: 1 };
  const got = {}; for (const [, e] of acts) { assert.strictEqual(e.context.length, 1, FAIL('a driver action entry has more than its own no-exec')); const m = /^no-exec:xpizza-driver\/xpizza-delivery\.js#(\w+)$/.exec(e.context[0]); assert.ok(m, FAIL(`driver action decided on ${e.context[0]} (not the action's own scope)`)); got[m[1]] = (got[m[1]] || 0) + 1; }
  assert.deepStrictEqual(got, want, FAIL(`driver action entries by probe scope ${JSON.stringify(got)}`));
  const exOf = (fn, entered) => ({ exec: { probed: [`${D}#${fn}`], entered: entered ? [`${D}#${fn}`] : [] } });
  const ev = (st, action, x) => ({ persisted: { restaurant_id: 'x_pizza', status: st }, lpAction: { action, ack: true }, ...x });
  const cT = `${D}#completeTask@${P}#attachActiveCardHandlers>anon`; const aT = `${D}#acceptTask@${P}#attachActiveCardHandlers>anon`;
  const at = (S, lp) => ({ S, brand: 'x_pizza', lp });
  // out_for_delivery LP (pickupComplete): completeTask probed + never entered → excluded; entered → required; unprobed → required
  assert.strictEqual(RA.runDecision(doc, cT, at('S1', 'out_for_delivery'), ev('out_for_delivery', 'pickupComplete', exOf('completeTask', false))).outcome, 'excluded', FAIL('a probed, never-entered completeTask was not excluded'));
  assert.strictEqual(RA.runDecision(doc, cT, at('S1', 'out_for_delivery'), ev('out_for_delivery', 'pickupComplete', exOf('completeTask', true))).outcome, 'required', FAIL('an entered completeTask was excluded'));
  assert.strictEqual(RA.runDecision(doc, cT, at('S1', 'out_for_delivery'), ev('out_for_delivery', 'pickupComplete', exOf('acceptTask', false))).outcome, 'required', FAIL('completeTask excluded on a trace that never probed it'));
  // the delivered LP IS completeTask's action → required even with no entry recorded (another surface may have completed it)
  assert.strictEqual(RA.staticDecision(doc, cT, at('S1', 'delivered')).excluded, false, FAIL('completeTask was excluded at the completeDelivery LP'));
  assert.strictEqual(RA.staticDecision(doc, `${D}#pickupComplete@${P}#attachActiveCardHandlers>anon`, at('S1', 'out_for_delivery')).excluded, false, FAIL('pickupComplete was excluded at the pickupComplete LP'));
  // acceptTask: no LP is an accept → excluded only on its own execution evidence
  assert.strictEqual(RA.runDecision(doc, aT, at('S1', 'new'), ev('new', 'create', exOf('acceptTask', false))).outcome, 'excluded', FAIL('a probed, never-entered acceptTask was not excluded'));
  assert.strictEqual(RA.runDecision(doc, aT, at('S1', 'new'), ev('new', 'create', {})).outcome, 'required', FAIL('acceptTask excluded with no trace'));
}
ok('driver actions (P1-c c2): 7 entries decided on the action\'s OWN scope (acceptTask, pickupComplete, completeTask ×2, acceptSecondOrder ×2, arriveAtRestaurant), never the handler bundle; probed + never entered → excluded; entered / unprobed / no trace → required; completeTask at a completeDelivery LP and pickupComplete at a pickupComplete LP stay required');
{ // P1-c c3 (codex P1-c r1 P1 fold): the shift AGGREGATES show a figure at every LP (zero deliveries is a figure) → stay
  // REQUIRED; only per-delivery code (runs once per order shiftDeliveries lists — delivered_at, stamped only with the
  // delivered status, or cancelled after it) is reviewed
  const CH = 'xpizza-driver/cash-helpers.js'; const P = 'xpizza-driver/index.html<script@0>'; const DD = 'xpizza-driver/xpizza-delivery.js';
  const per = Object.entries(doc.regions).filter(([, e]) => e.group === 'driverShiftDelivery');
  assert.ok(per.length === 2 && per.every(([, e]) => JSON.stringify(e.appliesWhenAny) === JSON.stringify([{ terminal: ['delivered'] }, { cancelled: [true] }])), FAIL(`per-delivery shift entries ${per.length} (expected 2) / condition`));
  const aggregates = [`${CH}#cuadreRecordPayload@${DD}#recordCuadre`, `${CH}#computeShiftCash@${P}#renderCuadreReceipt`, `${CH}#computeShiftCash@${P}#syncIdleStats`, `${CH}#shiftDeliveries@${CH}#computeShiftCash`, `${CH}#shiftDeliveries@${P}#renderHistoryModal`, `${P}#renderIdleState@${P}#renderActiveAndQueue`];
  for (const r of aggregates) assert.ok(!doc.regions[r], FAIL(`${r}: a shift aggregate is excluded — it shows a figure (zero deliveries included) at every LP`));
  // codex P1-c r1 P1 reproduction: a zero-delivery shift's cuadre is REAL output — execute the real cash helpers on no
  // deliveries, mutate the zero cash to 1 inside the payload builder; the S1 / assigned CASH cell must stay required
  const vm = require('vm'); const src = fs.readFileSync(path.join(__dirname, '..', '..', CH), 'utf8').replace(/^export /gm, '');
  const load = (code) => { const ctx = {}; vm.runInNewContext(`${code}\nthis.computeShiftCash = computeShiftCash; this.cuadreRecordPayload = cuadreRecordPayload;`, ctx); return ctx; };
  const real = load(src); const zero = real.cuadreRecordPayload(real.computeShiftCash({}, 'd1', 0, null));
  assert.ok(zero.cash_owed === 0 && zero.cash_order_count === 0, FAIL('probe premise: a zero-delivery cuadre writes cash_owed 0'));
  const from = 'cash_owed: num(c.cashOwed != null ? c.cashOwed : c.cash_owed),'; assert.strictEqual(src.split(from).length - 1, 1, FAIL('the cuadre payload probe text moved'));
  const mut = load(src.replace(from, 'cash_owed: num(c.cashOwed != null ? c.cashOwed : c.cash_owed) || 1,'));
  assert.strictEqual(mut.cuadreRecordPayload(mut.computeShiftCash({}, 'd1', 0, null)).cash_owed, 1, FAIL('probe premise: the mutated payload did not write 1'));
  const cells = gateA({ scenarios: ['S1'], brands: ['x_pizza'], lps: ['assigned'] }).cells.filter((c) => c.R === 'R4' && c.fact === 'CASH' && (c.viaFrom || c.region) === aggregates[0]);
  assert.ok(cells.length > 0 && cells.every((c) => !RA.staticDecision(doc, c.viaFrom || c.region, c).excluded), FAIL(`R3:R4:CASH:S1:x_pizza:assigned on the cuadre payload is excluded (${cells.length} cells) — a mutated zero-delivery cuadre would escape`));
  const units = require('./census').sources();
  const edit = (file, from2, to) => units.map((u) => { if (u.file !== file) return u; assert.strictEqual(u.code.split(from2).length - 1, 1, FAIL(`probe text not exactly once in ${file}: ${from2}`)); return { ...u, code: u.code.replace(from2, to) }; });
  const uniq = new Map(); for (const [, e] of per) for (const g of e.guards) uniq.set(JSON.stringify(g), g);
  const ownUnit = (g, u) => u.filter((x) => g.scope.startsWith(`${x.file}#`) || g.scope.startsWith(`${x.file.replace(/<script@\d+>$/, '')}#`));
  const staleIn = (u) => { const st = new Set([...uniq].filter(([, g]) => AP.guardStale(g, { units: g.kind === 'S' ? ownUnit(g, u) : u })).map(([k]) => k)); return per.filter(([, e]) => e.guards.some((g) => st.has(JSON.stringify(g)))).length; };
  assert.strictEqual(staleIn(units), 0, FAIL('per-delivery shift entries are stale on the real source'));
  for (const [what, u] of [
    ['shiftDeliveries lists undelivered orders', edit(CH, 'if (at == null || at < sinceMs) continue;', 'if (at != null && at < sinceMs) continue;')],
    ['a new delivered_at writer', units.map((x) => (x.file === 'xpizza-dispatch/index.html<script@0>' ? { ...x, code: x.code + '\nfunction __stamp(id) { return { [\'orders/\' + id + \'/delivered_at\']: Date.now() }; }' } : x))],
    ['computeShiftCash collects outside its delivered loop', edit(CH, 'for (const { order } of resolved.concat(legacyProvisional)) {', 'for (const { order } of resolved.concat(legacyProvisional, pending.map((id) => ({ order: ordersMap[id] })))) {')],
  ]) { const got = staleIn(u); assert.ok(got === per.length, FAIL(`${what}: only ${got} of ${per.length} per-delivery entries went stale`)); }
  const id = `${CH}#collectionFor@${CH}#computeShiftCash`; const e = doc.regions[id];
  const v = SS.vectorOf('S1', 'x_pizza', 'out_for_delivery');
  assert.strictEqual(RA.evaluate(e, { ...v, cancelled: true }).result, 'applies', FAIL('a cancelled (after delivery) order was excluded from the per-delivery collection'));
  const ev = (st, x = {}) => ({ persisted: { restaurant_id: 'x_pizza', status: st, ...x }, lpAction: { action: 'pickupComplete', ack: true } });
  const at = { S: 'S1', brand: 'x_pizza', lp: 'out_for_delivery' };
  assert.strictEqual(RA.runDecision(doc, id, at, ev('out_for_delivery')).outcome, 'excluded', FAIL('a live, undelivered order was not excluded from the per-delivery collection'));
  assert.strictEqual(RA.runDecision(doc, id, at, ev('cancelled', { cancelled_at: 1 })).outcome, 'contradicted', FAIL('a cancelled order at an out_for_delivery LP did not contradict'));
  assert.strictEqual(RA.staticDecision(doc, id, { S: 'S1', brand: 'x_pizza', lp: 'cuadre' }).excluded, false, FAIL('the per-delivery collection was excluded at the cuadre LP'));
}
ok('driver shift (P1-c c3, codex r1 P1 fold): the 6 shift AGGREGATES (cuadre payload, receipt, idle stats + idle state, shiftDeliveries ×2) stay REQUIRED — a mutated zero-delivery cuadre (cash 0 → 1, real helpers) keeps R3:R4:CASH:S1:x_pizza:assigned required; 2 per-delivery entries on terminal = delivered ∨ cancelled; listing undelivered orders, a new delivered_at writer or collecting outside the delivered loop → stale; cancelled-after-delivery applies; live undelivered → excluded, cancelled → contradicted; the cuadre LP stays required');
console.log(`\nr3-applicability guard: OK (${n})`);
