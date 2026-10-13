'use strict';
/* R3 P1 §3c — OUTPUT APPLICABILITY (PLAN-R3-P1 rev 4; codex r3 P1-2). contract/output-applicability.json (reviewed) lists
 * the (region, scenario, LP, brand) combinations in which a region does NOT apply — an event-driven call site that the
 * scenario never reaches (a pickup-ready send on a delivery order, a kitchen tap on an untouched ticket). Each exclusion is:
 *   · BOUND to its source: the region's call-site text (sha256) AND its enclosing census function scope (sha256) — a change
 *     to either INVALIDATES it (the cell is required again until re-reviewed);
 *   · BOUND to the scenario definition: sha256 of the scenario's spec in contract/p1-scenarios.json (intent, steps, LPs);
 *   · justified by named CONTRACT PRECONDITIONS (§1 / §2 / the scenario definition — never the reader's own visibility
 *     code), each ASSERTED in the run from fixture intent / acknowledged writer evidence / the step log before it applies.
 *     An unmet precondition → RED.
 * Absence and display obligations are assertions, never exclusions: the guard refuses an exclusion on a region that holds
 * one. Unknown applicability = required.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sources, walk, parseUnit } = require('./census');

const REPO = path.join(__dirname, '..', '..');
const FILE = path.join(__dirname, 'output-applicability.json');
const SCENARIOS = path.join(__dirname, 'p1-scenarios.json');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

// census function scopes: 'file#fn' → [source text of every function the census names fn in that unit]
let SCOPES = null;
function scopes(units = null) {
  if (SCOPES && !units) return SCOPES;
  const map = new Map();
  for (const u of units || sources()) {
    const base = u.file.replace(/<script@\d+>$/, '');
    walk(parseUnit(u), (node, fn) => {
      if (!/Function/.test(node.type) || !fn) return;
      // one key when the unit IS its file (no duplicated text)
      for (const k of new Set([`${u.file}#${fn}`, `${base}#${fn}`])) { if (!map.has(k)) map.set(k, []); map.get(k).push(u.code.slice(node.start, node.end)); }
    });
  }
  if (!units) SCOPES = map;
  return map;
}
const scopeText = (key, units = null) => { const t = scopes(units).get(key); return t && t.length ? t.join('\n\u0000\n') : null; };
const lineText = (file, line) => { const f = path.join(REPO, file.replace(/<script@\d+>$/, '')); const ls = fs.readFileSync(f, 'utf8').split('\n'); return ls[line - 1] === undefined ? null : ls[line - 1].trim(); };

/* the binding of a region: its call site (consumer line) or, for an @self region, its own definition */
function bindOf(r) {
  if (r.consumer) {
    const i = r.consumer.lastIndexOf('#'); const file = r.consumer.slice(0, i);
    const site = lineText(file, r.line); const scope = scopeText(r.consumer);
    return { site, siteSha: site == null ? null : sha(site), scope: r.consumer, scopeSha: scope == null ? null : sha(scope) };
  }
  const scope = scopeText(r.output);
  return { site: scope == null ? null : scope.split('\n')[0].trim(), siteSha: scope == null ? null : sha(scope.split('\n')[0].trim()), scope: r.output, scopeSha: scope == null ? null : sha(scope) };
}
/* the GUARD binding (codex P1-a r1 P1-6): the DISPATCH / guarding source that decides a region is not reached — a
 * census function scope containing an exact text (the scope's sha256 is recorded: any change to that function re-opens the
 * exclusion), or a repo file in which an exact text occurs exactly once (a top-level table such as whatsapp.js RENDERERS,
 * a static markup handler). An exclusion with no guard is malformed. */
function bindGuard(g) {
  const [kind, where, text] = g;
  if (kind === 'S') { const t = scopeText(where); if (t == null) throw new Error(`guard scope ${where} not found`); if (!t.includes(text)) throw new Error(`guard text not in ${where}: ${text}`); return { kind, scope: where, text, scopeSha: sha(t) }; }
  if (kind === 'F') { const f = fs.readFileSync(path.join(REPO, where), 'utf8'); const k = f.split(text).length - 1; if (k !== 1) throw new Error(`guard text occurs ${k}× in ${where}: ${text}`); return { kind, file: where, text }; }
  throw new Error(`unknown guard kind ${kind}`);
}
function guardStale(gb, { readFile = (f) => fs.readFileSync(path.join(REPO, f), 'utf8'), units = null } = {}) {
  if (gb.kind === 'S') { const t = scopeText(gb.scope, units); if (t == null) return `guard scope ${gb.scope} is gone`; if (!t.includes(gb.text)) return `guard text no longer in ${gb.scope}: "${gb.text}"`; if (sha(t) !== gb.scopeSha) return `guard scope ${gb.scope} changed`; return null; }
  if (gb.kind === 'F') { let f; try { f = readFile(gb.file); } catch (_) { return `guard file ${gb.file} is gone`; } const k = f.split(gb.text).length - 1; return k === 1 ? null : `guard text occurs ${k}× in ${gb.file} (was exactly once): "${gb.text}"`; }
  return `unknown guard kind ${gb.kind}`;
}
const scenarioSha = (S, doc = JSON.parse(fs.readFileSync(SCENARIOS, 'utf8'))) => (doc.scenarios[S] ? sha(canon(doc.scenarios[S])) : null);

/* CONTRACT PRECONDITIONS — each asserted from evidence = { intent, persisted, steps, routed, kdsActions, kdsHttp, kdsTickets } */
const routedFns = (ev) => new Set((ev.routed || []).map((x) => x.fn));
const PRECONDITIONS = {
  delivery: { contract: '§1 F-FULFIL: the order is a delivery (intent fulfilment = persisted order_type)', check: (ev) => ev.intent.fulfil === 'delivery' && ev.persisted.order_type === 'delivery' },
  cash: { contract: '§1 F-COLLECT: payment method cash (intent = persisted payment_method)', check: (ev) => ev.intent.pay === 'cash' && ev.persisted.payment_method === 'cash' },
  'not-online-payment': { contract: '§1 F-PAYLIFE: no online payment exists (no charge / confirm / poll call; method ≠ online)', check: (ev) => ev.persisted.payment_method !== 'online' && !['chargeOnlineOrder', 'pixelpayConfirm', 'getPaymentStatus'].some((f) => routedFns(ev).has(f)) && !ev.persisted.payment_status },
  asap: { contract: '§1 F-SCHED: no scheduled_for (ASAP) in intent or the persisted order', check: (ev) => !ev.intent.scheduledFor && !ev.persisted.scheduled_for },
  'status-new': { contract: 'the scenario LP is new: persisted status = new (no kitchen / dispatch / driver transition has happened)', check: (ev) => ev.persisted.status === 'new' },
  'not-cancelled': { contract: '§1 F-STATUS: the order is not cancelled', check: (ev) => ev.persisted.status !== 'cancelled' && !ev.persisted.cancelled_at },
  'no-redeem': { contract: '§1 F-REWARD: no redemption requested or persisted', check: (ev) => !ev.intent.redeem && !ev.persisted.redemption },
  'no-refund': { contract: '§1 F-PAYLIFE: no refund state', check: (ev) => !ev.persisted.refunded_at && !/refund/.test(String(ev.persisted.payment_status || '')) },
  'no-inbound': { contract: 'scenario definition: the customer sends no inbound WhatsApp', check: (ev) => !(ev.steps || []).some((s) => /inbound/i.test(s)) && !routedFns(ev).has('onIncomingWhatsApp') },
  'no-otp': { contract: 'scenario definition: guest checkout, no OTP requested', check: (ev) => !routedFns(ev).has('requestOtp') },
  'no-driver': { contract: '§1 F-DRIVER: no driver assigned at this LP (auto-assign off, nobody assigned)', check: (ev) => !ev.persisted.driver_id && !ev.persisted.assigned_driver && !ev.persisted.driver_uid },
  'no-kitchen-action': { contract: 'scenario definition: LP new — nobody taps the ticket (no start / ready / hold / item check / log)', check: (ev) => Array.isArray(ev.kdsActions) && ev.kdsActions.length === 0 },
  'kds-no-http': { contract: 'scenario definition: the KDS issues no HTTP request at LP new (its HTTP calls are kitchen actions)', check: (ev) => Array.isArray(ev.kdsHttp) && ev.kdsHttp.length === 0 },
  'single-live-order': { contract: 'scenario definition: one order on the board (no ordering between tickets to compare)', check: (ev) => ev.kdsTickets === 1 },
  'createorder-configured': { contract: 'scenario definition: the form submits to the REAL createOrder (routed and answered 200), never the demo branch', check: (ev) => (ev.routed || []).some((x) => x.fn === 'createOrder' && x.status === 200) },
  'no-reorder': { contract: 'scenario definition: a fresh cart (no reorder from history)', check: (ev) => !(ev.steps || []).some((s) => /reorder/i.test(s)) },
  'no-restore': { contract: 'scenario definition: no saved-form / snapshot restore', check: (ev) => !(ev.steps || []).some((s) => /restore/i.test(s)) },
  'no-another-order': { contract: 'scenario definition: one order (no "Hacer otro pedido")', check: (ev) => !(ev.steps || []).some((s) => /another/i.test(s)) },
  'no-extras': { contract: 'scenario definition: no extras on the dish', check: (ev) => !(ev.steps || []).some((s) => /extra/i.test(s)) && !(ev.intent.extras && ev.intent.extras.length) },
  'no-sheet-edit': { contract: 'scenario definition: the cart sheet is opened and read, not edited', check: (ev) => !(ev.steps || []).some((s) => /sheet-(inc|dec)/i.test(s)) },
};

const load = (f = FILE) => JSON.parse(fs.readFileSync(f, 'utf8'));
const inScope = (x, cell) => x.scope.S.includes(cell.S) && x.scope.brands.includes(cell.brand) && x.scope.lps.includes(cell.lp);
const exclusionFor = (doc, region, cell) => doc.exclusions.find((x) => x.region === region && inScope(x, cell)) || null;

/* static freshness of every exclusion (guard + run): binding hashes and the scenario hash */
function staleness(doc, regionsDoc, scenariosDoc) {
  const byId = new Map(regionsDoc.regions.map((r) => [r.region, r])); const p = [];
  for (const x of doc.exclusions) {
    const r = byId.get(x.region);
    if (!r) { p.push(`${x.region}: no such region (stale)`); continue; }
    const b = bindOf(r);
    if (b.siteSha !== x.bind.siteSha) p.push(`${x.region}: call-site text changed (was "${x.bind.site}", now "${b.site}") — re-review; the cell is required again`);
    if (b.scopeSha !== x.bind.scopeSha) p.push(`${x.region}: its scope ${b.scope} changed (sha ${String(b.scopeSha).slice(0, 12)} ≠ ${String(x.bind.scopeSha).slice(0, 12)}) — re-review; the cell is required again`);
    for (const S of x.scope.S) { const h = scenarioSha(S, scenariosDoc); if (h !== (x.scenarioSha || {})[S]) p.push(`${x.region}: scenario ${S} definition changed — re-review`); }
    if (!Array.isArray(x.guards) || !x.guards.length) p.push(`${x.region}: an exclusion needs at least one GUARD binding (the dispatch / guarding source)`);
    for (const gb of x.guards || []) { const st = guardStale(gb); if (st) p.push(`${x.region}: ${st} — re-review; the cell is required again`); }
    for (const pc of x.preconditions) if (!PRECONDITIONS[pc]) p.push(`${x.region}: unknown precondition ${pc}`);
    if (!x.preconditions.length) p.push(`${x.region}: an exclusion needs at least one contract precondition`);
    if (!(x.reason && x.reason.trim())) p.push(`${x.region}: an exclusion needs a reason`);
  }
  return p;
}
/* an exclusion may not WAIVE an absence / display obligation (those are assertions): for each such matrix cell, at least
 * one of its regions must stay required (not excluded) — the obligation is asserted there. Excluding an unreachable sibling
 * call site of the same output is allowed only because the obligation is still discharged at the reached region. */
function shadowsAssertion(doc, cells) {
  // codex P1-a r1 P1-7: the obligation is (matrix cell, OUTPUT) — a sibling call site may be excluded only as an alternate
  // entry to the SAME output's terminal obligation; another output's region can never discharge it
  const p = []; const byOb = new Map();
  for (const c of cells) { if (c.kind !== 'absence' && c.kind !== 'display') continue; const k = `${c.cell}|${c.output}`; if (!byOb.has(k)) byOb.set(k, []); byOb.get(k).push(c); }
  for (const [k, cs] of byOb) {
    const excluded = cs.filter((c) => exclusionFor(doc, c.viaFrom || c.region, c));
    if (excluded.length && excluded.length === cs.length) p.push(`${k}: every region of this ${cs[0].kind} obligation (cell + output) is excluded (${excluded.map((c) => c.viaFrom || c.region).join(', ')}) — absence / display are assertions, never exclusions`);
  }
  return p;
}
function unmet(x, ev) { return x.preconditions.filter((pc) => { try { return !PRECONDITIONS[pc].check(ev); } catch (_) { return true; } }); }

module.exports = { scopeTextOf: (k) => scopeText(k), FILE, SCENARIOS, PRECONDITIONS, bindOf, bindGuard, guardStale, scenarioSha, load, exclusionFor, staleness, shadowsAssertion, unmet, sha, canon };
