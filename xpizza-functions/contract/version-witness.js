'use strict';
/* R3 §1a — THE SERVED-VERSION WITNESS = the FINALIZED pricing result, never the reader's completion.
 *
 * createPricingResolver.getPricingTables(rid) races the catalog read against a deadline and may serve the fallback ladder
 * (last_good) while the read finishes later with a newer version (catalog/pricing-tables.js). `finalize` already attaches
 * the envelope { versionId, seq, source } to the returned tables (envelopeOf). install() — BEFORE index.js, after the
 * R1c catalog clock — wraps the resolver index.js builds so each COMPLETED getPricingTables call appends
 * { rid, versionId, seq, source } to the `served` list of the active writer context (contract/scheduler ALS store). A late
 * reader completion cannot alter a completed call's record. Reader-level completions are kept as DIAGNOSTICS only.
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
  installed = {
    unattributed: () => unattributed.slice(),
    readerDiag: () => readerDiag.slice(),
    built: () => built,
  };
  return installed;
}

module.exports = { install };
