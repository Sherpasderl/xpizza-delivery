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
  const pointerReads = []; let gatesBuilt = 0;
  // codex r2 P1-2: a gate result is attributed by IDENTITY to the gate's own cache entry. intakeGatesFor returns the cached
  // entry's own objects (weekend / known / groups), redeemEligibleFor its `redeem` rule; the reader exposes peek(rid, v).
  // Candidates = the versions the gate has READ menus for. Nothing is inferred from a pointer read — a late, rejected
  // pointer completion (never accepted into the gate's cache) cannot poison anything. Fallback = no version; more than
  // one identical entry = recorded as AMBIGUOUS, never guessed.
  const menusRead = new Map();   // rid -> Set(versionId) the gate built from
  mg.createGateReader = function witnessedGate(opts = {}) {
    gatesBuilt += 1;
    const gv = opts.getVersionId; const gm = opts.getMenu;
    const observed = { ...opts };
    if (typeof gv === 'function') observed.getVersionId = async (rid) => { const v = await gv(rid); pointerReads.push({ rid, versionId: v }); return v; };   // diagnostic only
    if (typeof gm === 'function') observed.getMenu = (rid, versionId) => { (menusRead.get(rid) || menusRead.set(rid, new Set()).get(rid)).add(versionId); return gm(rid, versionId); };
    const g = hookedGate.call(this, observed);
    const attribute = (rid, matches) => {
      const cands = [...(menusRead.get(rid) || [])].filter((v) => { const e = typeof g.peek === 'function' ? g.peek(rid, v) : null; return e && matches(e); });
      if (cands.length === 1) return { versionId: cands[0], via: 'cache-identity' };
      if (cands.length > 1) return { versionId: null, via: 'ambiguous', candidates: cands };
      return { versionId: null, via: 'no-cache-entry' };
    };
    const record = (rid, method, rec) => {
      const store = ALS.getStore();
      const out = { rid, method, ...rec };
      if (store && Array.isArray(store.served)) (store.gates || (store.gates = [])).push(out); else unattributed.push({ gate: out });
    };
    const out = { ...g };
    if (typeof g.intakeGatesFor === 'function') out.intakeGatesFor = async (rid, ...a) => {
      const r = await g.intakeGatesFor(rid, ...a);
      if (r && r.fallback) record(rid, 'intakeGatesFor', { versionId: null, via: 'fallback', fallback: true });
      else record(rid, 'intakeGatesFor', { ...attribute(rid, (e) => e.weekend === r.weekend && (e.known === undefined || e.known === r.known) && (e.groups === undefined || e.groups === r.groups)), fallback: false });
      return r;
    };
    if (typeof g.redeemEligibleFor === 'function') out.redeemEligibleFor = async (rid, ...a) => {
      const r = await g.redeemEligibleFor(rid, ...a);
      if (r == null) record(rid, 'redeemEligibleFor', { versionId: null, via: 'static', rule: 'static' });
      else record(rid, 'redeemEligibleFor', { ...attribute(rid, (e) => e.redeem === r), rule: 'authored' });
      return r;
    };
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
