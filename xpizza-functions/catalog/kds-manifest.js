'use strict';
// ---------------------------------------------------------------------------
// 1D add-product PHASE A (PLAN-addproduct.md rev 5 §0.4, §0b.3) — THE KDS MANIFEST, FROM THE ACTIVE CATALOG.
//
// The kitchen's "Disponibilidad" panel lists exactly the rows of RTDB /menus/{rid} (xpizza-kitchen subscribes
// to that node), and until now only the owner CLI wrote it, from a CODE proxy. A product added in the portal
// would therefore never get a row, and staff could not 86 it. So every activation now writes the manifest of
// the catalog it just made active, through this ONE writer shared by publishEdited, rollback-version and
// publish-menus.
//
// 🔴 A CONDITIONAL ATOMIC COMMIT, NOT A READ-THEN-WRITE. Two activations can race, and a delayed retry of an
// older one must never overwrite a newer list. The generation lives beside the manifest, under the SAME
// parent (/menus/_meta/{rid} = {source_generation, version_id, written_at}), and the writer runs ONE RTDB
// transaction on the common ancestor /menus: inside it, it reads the stored generation and ONLY if its own is
// ≥ that does it replace /menus/{rid} AND /menus/_meta/{rid}, returning every other child (other brands,
// unrelated keys) exactly as it found them. Otherwise it returns undefined — the SDK aborts, nothing is
// written. A separate "read the generation, then update" is forbidden: it is precisely the race this closes.
//
// The array at /menus/{rid} keeps today's shape: [{key, label, category}] in served order, from
// generateKdsManifest(). Availability flags live elsewhere and are not touched. Admin SDK only — the rules
// deny client writes to /menus/_meta.
// ---------------------------------------------------------------------------
const { generateKdsManifest } = require('./generate-form-bundle');

const MAX_ATTEMPTS = 3;

// The pure decision inside the transaction. `current` is the whole /menus value (or null).
function nextMenus(current, rid, manifest, meta) {
  const cur = current && typeof current === 'object' ? current : {};
  const metas = cur._meta && typeof cur._meta === 'object' && !Array.isArray(cur._meta) ? cur._meta : {};
  const stored = metas[rid];
  const storedGen = stored && Number.isInteger(stored.source_generation) ? stored.source_generation : null;
  if (storedGen !== null && storedGen > meta.source_generation) return undefined;   // older → abort (no-op)
  return { ...cur, [rid]: manifest, _meta: { ...metas, [rid]: meta } };
}

/* Write the manifest of the ACTIVE catalog at `generation`.
   rtdb         an Admin SDK database handle
   catalog      {items:[{key, display}]} in served order (previewVersion(...).items)
   generation   the activation's pointer generation (a non-negative integer)
   Returns { written: boolean, reason: 'written' | 'older_generation', attempts }. Throws after MAX_ATTEMPTS
   failed attempts (callers turn that into kds_sync_pending — never into a failed publish). */
// `_onRead(current)` is a TEST SEAM only (kds-manifest-writer.test.mjs): called synchronously inside the
// transaction callback, after the read and before the decision, so a test can hold one writer there while
// another commits. Production callers never pass it.
async function writeKdsManifest(rtdb, rid, { catalog, generation, versionId, now = () => Date.now(), maxAttempts = MAX_ATTEMPTS, _onRead = null }) {
  if (!Number.isInteger(generation) || generation < 0) throw new Error(`kds_manifest_bad_generation: ${rid}/${generation}`);
  if (typeof versionId !== 'string' || !versionId) throw new Error(`kds_manifest_bad_version: ${rid}`);
  const manifest = generateKdsManifest(rid, catalog);
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const meta = { source_generation: generation, version_id: versionId, written_at: now() };
    try {
      const res = await rtdb.ref('menus').transaction((current) => { if (_onRead) _onRead(current); return nextMenus(current, rid, manifest, meta); }, undefined, false);
      if (res && res.committed) return { written: true, reason: 'written', attempts: attempt };
      return { written: false, reason: 'older_generation', attempts: attempt };
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error(`kds_manifest_sync_failed: ${rid}/${versionId}@${generation} after ${maxAttempts} attempts: ${lastErr && lastErr.message}`);
  err.code = 'kds_manifest_sync_failed';
  throw err;
}

// For the post-activation callers: never throws. Logs the structured failure and reports it.
async function syncKdsManifest(rtdb, rid, opts, log = (l) => console.error(l)) {
  try {
    return { pending: false, ...(await writeKdsManifest(rtdb, rid, opts)) };
  } catch (e) {
    try { log(`kds_manifest_sync_failed ${JSON.stringify({ rid, version: opts && opts.versionId, generation: opts && opts.generation, error: String((e && e.message) || e).slice(0, 200) })}`); } catch (_) {}
    return { pending: true, written: false, reason: 'failed' };
  }
}

module.exports = { MAX_ATTEMPTS, nextMenus, writeKdsManifest, syncKdsManifest };
