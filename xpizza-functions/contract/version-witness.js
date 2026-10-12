'use strict';
/* R3 §1a — THE SERVED-VERSION WITNESS = the FINALIZED pricing result, never the reader's completion.
 *
 * createPricingResolver.getPricingTables(rid) races the catalog read against a deadline and may serve the fallback ladder
 * (last_good) while the read finishes later with a newer version (catalog/pricing-tables.js). `finalize` already attaches
 * the envelope { versionId, seq, source } to the returned tables (envelopeOf). install() — BEFORE index.js, after the
 * R1c catalog clock — wraps the resolver index.js builds so each COMPLETED getPricingTables call appends
 * { rid, versionId, seq, source } to the `served` list of the active writer context (contract/scheduler ALS store). A late
 * reader completion cannot alter a completed call's record. Reader-level completions are kept as DIAGNOSTICS only.
 *
 * The OTHER serving paths (plan §1a), each with its own evidence:
 *   · CONTEXT: contextOf(result) rides the same envelope. An attached context carries { rid, versionId, seq } and is
 *     REFUSED by the source on any provenance mismatch, so it is recorded as { availability, reason, versionId, seq }.
 *   · VERIFIER: it attests identity-REGISTRY eligibility, not a catalog version ("not applicable" for version); its
 *     state is the context's registryEligibility.state, recorded with the context.
 *   · GATES (menu-gates): the reader's result carries no version. Evidence = the pointer value IT cached for the rid,
 *     observed through its own getVersionId (wrapped, never replaced), which only refills when the R1c catalog clock is
 *     advanced; plus its own `fallback` flag. Recorded per call as { rid, method, versionId, fallback }. Caveat (stated):
 *     a pointer read that completes AFTER the gate's deadline is observed but not cached — such a call returns
 *     fallback:true, which is recorded as such.
 */
const path = require('path');
const { ALS } = require('./scheduler');
const { AsyncLocalStorage } = require('async_hooks');
const GATE_CALL = new AsyncLocalStorage();   // codex r1 P1-6: provenance bound to EACH gate call, not read from a shared per-rid slot

const FN = path.join(__dirname, '..');
let installed = null;

function install() {
  if (installed) throw new Error('version-witness: install() called twice');
  if (require.cache[require.resolve(path.join(FN, 'index.js'))]) throw new Error('version-witness: index.js is already loaded — install before it');
  const unattributed = []; const readerDiag = []; let built = 0;
  const pt = require(path.join(FN, 'catalog/pricing-tables'));
  const realResolver = pt.createPricingResolver;
  pt.createPricingResolver = function witnessedResolver(opts) {
    built += 1;
    const res = realResolver.call(this, opts);
    return { ...res, getPricingTables: async (rid) => {
      const tables = await res.getPricingTables(rid);
      const env = pt.envelopeOf(tables);
      const rec = env ? { rid, versionId: env.versionId, seq: env.seq, source: env.source } : { rid, versionId: undefined, seq: undefined, source: 'no-envelope' };
      const ctx = env && env.context;
      rec.context = ctx ? { availability: ctx.availability, reason: ctx.reason || null, versionId: ctx.versionId === undefined ? null : ctx.versionId, seq: ctx.seq === undefined ? null : ctx.seq,
        verifier: ctx.registryEligibility ? ctx.registryEligibility.state : null } : null;
      const store = ALS.getStore();
      if (store && Array.isArray(store.served)) store.served.push(rec); else unattributed.push(rec);
      return tables;
    } };
  };
  const cat = require(path.join(FN, 'catalog/catalog'));
  const hookedReader = cat.createCatalogReader;          // the R1c-hooked factory (install the clock FIRST)
  cat.createCatalogReader = function diagReader(opts = {}) {
    const r = hookedReader.call(this, opts);
    const getTables = r.getTables;
    return { ...r, getTables: async (rid) => { const t = await getTables(rid); readerDiag.push({ rid, versionId: t && t.versionId, at: Date.now() }); return t; } };
  };
  // GATES
  const mg = require(path.join(FN, 'catalog/menu-gates'));
  const hookedGate = mg.createGateReader;                 // the R1c-hooked factory
  const lastPointer = new Map(); const pointerReads = []; let gatesBuilt = 0;
  // Per CALL: the call runs in its own GATE_CALL context, which records — in order of authority — the version its menu
  // read was made FOR (getMenu(rid, versionId)), the pointer IT fetched (getVersionId inside the call), else the cached
  // pointer at the moment the call STARTED (the gate checks its pointer cache synchronously, before its first await, so no
  // other call can move it in between). A fallback result has no version. A concurrent call never overwrites another's.
  mg.createGateReader = function witnessedGate(opts = {}) {
    gatesBuilt += 1;
    const gv = opts.getVersionId; const gm = opts.getMenu;
    const observed = { ...opts };
    if (typeof gv === 'function') observed.getVersionId = async (rid) => { const v = await gv(rid); lastPointer.set(rid, v); pointerReads.push({ rid, versionId: v }); const st = GATE_CALL.getStore(); if (st && st.rid === rid) st.fetched = v; return v; };
    if (typeof gm === 'function') observed.getMenu = (rid, versionId) => { const st = GATE_CALL.getStore(); if (st && st.rid === rid) st.menuFor = versionId; return gm(rid, versionId); };
    const g = hookedGate.call(this, observed);
    const record = (call, method, extra) => {
      const store = ALS.getStore();
      const versionId = extra.fallback ? null : (call.menuFor !== undefined ? call.menuFor : (call.fetched !== undefined ? call.fetched : (call.startPointer !== undefined ? call.startPointer : null)));
      const rec = { rid: call.rid, method, versionId, via: extra.fallback ? 'fallback' : (call.menuFor !== undefined ? 'menu-read' : (call.fetched !== undefined ? 'pointer-fetch' : 'cached-pointer-at-start')), ...extra };
      if (store && Array.isArray(store.served)) (store.gates || (store.gates = [])).push(rec); else unattributed.push({ gate: rec });
    };
    const wrapCall = (method, fn, summarize) => async (rid, ...a) => {
      const call = { rid, startPointer: lastPointer.has(rid) ? lastPointer.get(rid) : undefined };
      const r = await GATE_CALL.run(call, () => fn(rid, ...a));
      record(call, method, summarize(r));
      return r;
    };
    const out = { ...g };
    if (typeof g.intakeGatesFor === 'function') out.intakeGatesFor = wrapCall('intakeGatesFor', g.intakeGatesFor, (r) => ({ fallback: !!(r && r.fallback) }));
    if (typeof g.redeemEligibleFor === 'function') out.redeemEligibleFor = wrapCall('redeemEligibleFor', g.redeemEligibleFor, (r) => ({ rule: r == null ? 'static' : 'authored' }));
    return out;
  };
  installed = {
    pointerReads: () => pointerReads.slice(),
    gatesBuilt: () => gatesBuilt,
    unattributed: () => unattributed.slice(),
    readerDiag: () => readerDiag.slice(),
    built: () => built,
  };
  return installed;
}

module.exports = { install };
