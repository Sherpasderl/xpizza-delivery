'use strict';
// PLATFORM F1 — the owner brands CLI's logic over an injected RTDB handle (tools/brands-admin.js adds only the project guard,
// the Admin app and argv). DRY RUN unless `apply`: a mutation command writes ONE path, and only with apply. Exit codes:
// 0 ok / dry run / no-op, 1 refusal or membership findings, 2 usage.
const { validateBrand, checkMembership } = require('./brand-model');
const S = require('./brand-store');

async function runBrandsAdmin({ rtdb, op, id, apply, nowMs, log }) {
  if (op === 'status') {
    // Never fail open: absent (null) is an empty /brands; any other non-plain-object root (a scalar, or an array — RTDB returns a
    // 0..n-keyed map as one) is itself a finding. An invalid brand inside a valid root is checkMembership's brand_invalid finding.
    const root = await S.readNode(rtdb, 'brands');
    const rootOk = root === null || (typeof root === 'object' && !Array.isArray(root));
    const brands = rootOk && root !== null ? root : {};
    const findings = rootOk ? [] : [{ code: 'brands_root_invalid', type: Array.isArray(root) ? 'array' : typeof root }];
    findings.push(...checkMembership(brands, await S.readIdentities(rtdb)));
    const summary = Object.fromEntries(Object.keys(brands).sort().map((b) => {
      const st = brands[b] && brands[b].activation && brands[b].activation.state;
      return [b, { state: st === undefined ? null : st, valid: validateBrand(b, brands[b]).ok }];
    }));
    log(JSON.stringify({ brands: summary, findings }, null, 2));
    return findings.length ? 1 : 0;
  }
  if (op === 'seed-legacy' && id) {
    const plan = S.planSeedLegacy({ rid: id, identity: await S.readNode(rtdb, `restaurants/${id}/identity`), existing: await S.readNode(rtdb, S.brandPath(id)), nowMs });
    if (!plan.ok) { log(`brands-admin: REFUSED — ${plan.error}`); return 1; }
    if (plan.noop) { log(`brands-admin: ${S.brandPath(id)} already holds this legacy record — nothing to do`); return 0; }
    log(`brands-admin seed-legacy ${apply ? 'APPLY' : 'DRY RUN'}\n  ${plan.row.path} := ${JSON.stringify(plan.row.to)}`);
    if (!apply) { log('(dry run — nothing written; add --apply)'); return 0; }
    const r = await S.applySeedLegacy(rtdb, plan);
    if (!r.ok) { log(`brands-admin: ${r.error}${r.back !== undefined ? ` — read ${JSON.stringify(r.back)}` : ''}`); return 1; }
    log('brands-admin: created and read back');
    return 0;
  }
  if (op === 'publish' && id) {
    const observedAlert = await S.observeProjectionStale(rtdb, id);   // O1b: read BEFORE the plan — the only alert this publish may clear
    const plan = S.planPublish({ brandId: id, brand: await S.readNode(rtdb, S.brandPath(id)), identities: await S.readIdentities(rtdb), current: await S.readNode(rtdb, S.publicPath(id)) });
    if (!plan.ok) { log(`brands-admin: REFUSED — ${plan.errors.join('; ')}`); return 1; }
    log(`brands-admin publish ${apply ? 'APPLY' : 'DRY RUN'}\n  ${plan.row.path}: ${plan.changed ? 'CHANGES' : 'unchanged'}\n${JSON.stringify(plan.row.to, null, 2)}`);
    if (!apply) { log('(dry run — nothing written; add --apply)'); return 0; }
    if (!plan.changed) { log(`(unchanged — nothing written${(await S.clearProjectionStale(rtdb, id, observedAlert)) ? '; projection_stale alert cleared' : ''})`); return 0; }   // O1b T7: the no-op recovery
    const r = await S.applyPublish(rtdb, plan);
    if (r.error) { log(`brands-admin: REFUSED (fenced) — ${r.error}`); return 1; }
    if (!r.ok) { log(`brands-admin: READ-BACK MISMATCH — read ${JSON.stringify(r.back)}`); return 1; }
    log(`brands-admin: published and read back${(await S.clearProjectionStale(rtdb, id, observedAlert)) ? '; projection_stale alert cleared' : ''}`);
    return 0;
  }
  log('usage: brands-admin.js --project <id> (status | seed-legacy <rid> | publish <brandId>) [--apply]');
  return 2;
}

module.exports = { runBrandsAdmin };
