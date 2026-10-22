'use strict';

// Restaurant-aware hosted-checkout return base (B2-server; S3b: routing as DATA). After paying on PixelPay's hosted
// page the customer returns HERE — so it must be the brand's OWN order-site origin (where the return/poll page + its
// localStorage stash live).
//
// S3b (PLAN §5 S3, advisor rulings 2026-10-22): the allowlist is platform/sites.json — the SAME manifest the CORS
// audience is derived from. Each `orders` deployment carries `pay_return: { env, default? }`; the selected deployment's
// base is env[pay_return.env] || pay_return.default, else FAIL-CLOSED (ADR-0002: reject rather than return a customer to
// another brand's site, where its stash is not). No brand literal:
//   orders-xpizza → { env: PIXELPAY_RETURN_URL, default: https://xpizzaorders.netlify.app }   (byte-identical to before)
//   orders-lamusa → { env: PIXELPAY_RETURN_URL_LA_MUSA }                                       (fail-closed if unset, as before)
// entry_mode: 'direct' (absent / unknown → direct, byte-identical) | 'app' → fail-closed until an app deployment exists.
//
// ONE PRECEDENCE RULE (both the fresh and the resume path — a checkout can never return to a different site on resume than
// at issue): the rid's OWN orders deployment if one exists; else its brand_id's deployment (a BRANCH returns to its brand's
// site); else fail-closed. The fresh path passes the brand_id of the identity it already read; a resume reads ONLY the
// identity/brand_id leaf, and only when the rid has no deployment of its own (today's brands: no new read).
const { PLATFORM } = require('./platform-manifest');
const { isBrandId } = require('./brands/brand-model');

const ENTRY_MODES = new Set(['direct', 'app']);
const ordersDeployments = (sites, ctx) => sites.deployments.filter((d) => d.app === 'orders' && d.context === ctx && d.pay_return);
const hasOwnDeployment = (rid, sites = PLATFORM.sites) => ordersDeployments(sites, rid).length === 1;

// THE RULE (pure). brandId: the location's identity.brand_id (undefined / null when it has none). Deviates from
// brands/brand-model.js brandIdOf on purpose: no legacy /brands/{rid} read on the charge path, and a malformed brand_id is
// refused (never guessed).
function resolveReturnBase(restaurantId, env, { brandId = null, entryMode = null, sites = PLATFORM.sites } = {}) {
  const e = env || {};
  if ((ENTRY_MODES.has(entryMode) ? entryMode : 'direct') === 'app') return { base: null, error: 'return_url_unconfigured: no app deployment yet' };
  let dep = ordersDeployments(sites, restaurantId);
  if (dep.length !== 1) {
    if (brandId === undefined || brandId === null) return { base: null, error: `return_url_unconfigured: no orders deployment for ${restaurantId}` };
    if (!isBrandId(brandId)) return { base: null, error: `return_url_unconfigured: ${restaurantId} has a malformed brand_id` };
    dep = ordersDeployments(sites, brandId);
    if (dep.length !== 1) return { base: null, error: `return_url_unconfigured: no orders deployment for brand ${brandId}` };
  }
  const pr = dep[0].pay_return;
  const base = e[pr.env] || pr.default;
  if (!base) return { base: null, error: `${pr.env} not configured` };
  return { base: String(base).replace(/\/+$/, ''), error: null };
}

// The charge path: the SAME rule; the brand_id comes from the identity the fresh path holds, else (resume) the one leaf —
// read only when the rid has no deployment of its own.
async function resolveReturnBaseForCharge(restaurantId, env, { identity = null, entryMode = null, readBrandId, sites = PLATFORM.sites } = {}) {
  if (hasOwnDeployment(restaurantId, sites)) return resolveReturnBase(restaurantId, env, { entryMode, sites });
  let brandId = identity ? identity.brand_id : undefined;
  if (!identity) {
    try { brandId = await readBrandId(); } catch (_) { return { base: null, error: `return_url_unconfigured: ${restaurantId} brand unreadable` }; }
  }
  return resolveReturnBase(restaurantId, env, { brandId, entryMode, sites });
}

module.exports = { resolveReturnBase, resolveReturnBaseForCharge, hasOwnDeployment };
