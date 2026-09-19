'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-grace — the id on the FORWARD resolution path, as a verification shim.
//
// D3 asks the reverse question: given this line's legacy key, does the registry hold the id the client
// claimed. This asks the forward one: given the id, which object does the registry say it is — the
// direction an eventual enforce would key by. The answer is then used ONLY when it agrees with the key
// the line would have been priced by anyway.
//
// 🔴 SO IT IS A NO-OP ON MONEY BY CONSTRUCTION, NOT BY TESTING. A line is stamped only when the
// resolved key EQUALS the raw legacy accessor computed from the client's own fields; on disagreement
// nothing is stamped and the disagreement is logged. The key that prices every line is therefore
// exactly the key that priced it before D4 existed. The value of the stage is not what it changes —
// nothing — it is that the resolver, the fan-out budget, the freshness bound and the wiring all get
// exercised on live traffic while a mistake in them is still free.
//
// 🔴 AND THE ID IS NOT RENAME-STABLE YET. A renamed x_pizza dish mints a NEW id today, because the
// registry freezes legacy_key at mint. Under grace that churn is invisible and harmless — an id that
// no longer matches simply disagrees, and disagreement never reprices. It is also exactly why this
// stage does not make the id authoritative: enforce would refuse a renamed dish. Rename-stability is
// its own later stage.
// ---------------------------------------------------------------------------
const { resolveLegacyByIds } = require('./identity-registry');

/* The RAW legacy accessor, duplicated here deliberately and for one reason: the agreement check must
   compare against what the client actually sent, computed BEFORE anything is stamped. Calling
   itemPricingKey would read the stamp once one exists, so the check would be comparing the resolved
   key against itself and would agree with everything. A copy that can never see a stamp is the point;
   it is pinned against menu-pricing's own accessor by test. */
const rawLegacyKey = (rid, node) => (rid === 'la_musa' ? (node && node.id) : (node && node.name));

/* Every id-carrying node a cart holds — dish lines and their nested extras — with the raw key each
   would price by. Mirrors D3's occurrence walk so the two stages cannot disagree about what a cart
   contains. */
function occurrences(rid, items) {
  const out = [];
  (Array.isArray(items) ? items : []).forEach((line, i) => {
    if (!line || typeof line !== 'object') return;
    out.push({ node: line, line: i, kind: 'dish', id: line.dish_id, raw: rawLegacyKey(rid, line) });
    (Array.isArray(line.extras) ? line.extras : []).forEach((ex, j) => {
      if (!ex || typeof ex !== 'object') return;
      out.push({ node: ex, line: i, slot: j, kind: 'extra', id: ex.extra_id, raw: rawLegacyKey(rid, ex) });
    });
  });
  return out;
}

/* Resolve forward, then stamp ONLY where the registry agrees. Never throws: this runs on the charge
   path, and a verification shim that can fail an order is worse than no verification at all. */
async function applyGraceResolution(fs, rid, items, { stamp, timeoutMs, maxLookups } = {}) {
  const coverage = { checked: 0, resolved: 0, agree: 0, disagree: 0, absent: 0, read_error: 0, unresolved: 0, incomplete: false };
  const disagreements = [];
  try {
    const occ = occurrences(rid, items);
    const carrying = occ.filter((o) => typeof o.id === 'string' && o.id);
    coverage.absent = occ.length - carrying.length;
    coverage.checked = carrying.length;
    if (!carrying.length) return { coverage, disagreements };

    const byKind = { dish: [], extra: [] };
    for (const o of carrying) byKind[o.kind].push(o.id);

    const results = {};
    let incomplete = false;
    for (const kind of ['dish', 'extra']) {
      if (!byKind[kind].length) { results[kind] = new Map(); continue; }
      const r = await resolveLegacyByIds(fs, rid, kind, byKind[kind], { timeoutMs, maxLookups });
      results[kind] = r.byId;
      if (r.incomplete) incomplete = true;
    }
    coverage.incomplete = incomplete;

    for (const o of carrying) {
      const got = results[o.kind].get(o.id) || { outcome: 'read_error', reason: 'missing_result' };
      if (got.outcome === 'read_error') { coverage.read_error += 1; continue; }
      if (got.outcome === 'unresolved') { coverage.unresolved += 1; continue; }
      coverage.resolved += 1;
      if (got.legacyKey === o.raw) {
        coverage.agree += 1;
        /* 🔴 STAMPED ONLY HERE — on the server's own copy, with a Symbol the client cannot have
           supplied, and only with a value already proven equal to the raw key. Every other branch
           leaves the line exactly as it arrived. */
        if (stamp && o.node && typeof o.node === 'object') o.node[stamp] = got.legacyKey;
      } else {
        coverage.disagree += 1;
        disagreements.push({ line: o.line, kind: o.kind, id: o.id, raw_key: o.raw, registry_key: got.legacyKey });
      }
    }
    return { coverage, disagreements };
  } catch (_e) {
    coverage.incomplete = true;
    return { coverage, disagreements };
  }
}

/* The forward-coverage heartbeat — the evidence an eventual enforce would be argued from, and the
   reason "zero disagreements" is not by itself evidence of anything. A resolver reading the wrong
   collection, or one starved by the budget, also reports zero; what separates a clean order from a
   broken one is `resolved` beside `read_error` and the INCOMPLETE flag. Synchronous, like D3's. */
function reportForwardCoverage(orderId, rid, coverage, disagreements) {
  try {
    console.log('order_identity_forward_coverage', JSON.stringify({ rid, order_id: orderId, ...coverage }));
  } catch (_) {}
  for (const d of (disagreements || [])) {
    try {
      console.warn('order_identity_forward_disagreement', JSON.stringify({ rid, order_id: orderId, ...d }));
    } catch (_) {}
  }
}

/* The guarded entry point both handlers use. 🔴 THE HANDLE GETTER IS CALLED INSIDE THE TRY, for the
   reason D3 paid for: getFirestore() is synchronous and can throw on a cold instance, and a throw in
   a handler body is a failed request. Here it would fail a request that has not yet become an order —
   better than D3's case, and still not acceptable for a verification shim.
   🔴 AND THIS ONE IS AWAITED, DELIBERATELY, unlike D3's. D3 runs AFTER the order exists, so it must
   never hold the response. This runs BEFORE pricing because pricing is what consumes the stamp, so
   the wait is real — bounded by the resolver's own deadline and its lookup budget, and it buys the
   thing the stage exists for. Nothing here can refuse: every failure path returns grace. */
async function resolveGraceKeys(getFs, rid, items, opts = {}) {
  try {
    return await applyGraceResolution(getFs(), rid, items, opts);
  } catch (_e) {
    return { coverage: { checked: 0, resolved: 0, agree: 0, disagree: 0, absent: 0, read_error: 0, unresolved: 0, incomplete: true }, disagreements: [] };
  }
}

module.exports = { applyGraceResolution, resolveGraceKeys, reportForwardCoverage, occurrences, rawLegacyKey };
