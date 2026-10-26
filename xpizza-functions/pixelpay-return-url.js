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
// entry_mode: 'direct' (absent / unknown → direct, byte-identical) | 'app' → the customer APP's deployment (S2 P-A, below).
//
// S2 P-A (PLAN-capp-S2-r4 §2.1/§2.1a): 'app' resolves through THE single `context:"platform"` orders deployment (the
// manifest validator allows at most one) and NEVER reads a rid's deployment or brand leaf. Its base is the request's
// Origin when that Origin is EXACTLY one of the deployment's declared origins (a page always returns to its own storage
// origin, which keeps an old host working after a domain swap — app origins are only ever added); otherwise
// env[pay_return.env] || pay_return.default, which must itself be a declared origin, else fail-closed. The Origin is only
// ever chosen from the declared list, so it cannot steer a return anywhere new.
//
// ONE PRECEDENCE RULE (both the fresh and the resume path — a checkout can never return to a different site on resume than
// at issue): the rid's OWN orders deployment if one exists; else its brand_id's deployment (a BRANCH returns to its brand's
// site); else fail-closed. The fresh path passes the brand_id of the identity it already read; a resume reads ONLY the
// identity/brand_id leaf, and only when the rid has no deployment of its own (today's brands: no new read).
const { PLATFORM, PLATFORM_CONTEXT } = require('./platform-manifest');
const { isBrandId } = require('./brands/brand-model');

const ENTRY_MODES = new Set(['direct', 'app']);
const ordersDeployments = (sites, ctx) => (ctx === PLATFORM_CONTEXT ? [] : sites.deployments.filter((d) => d.app === 'orders' && d.context === ctx && d.pay_return));
const appDeployments = (sites) => sites.deployments.filter((d) => d.app === 'orders' && d.context === PLATFORM_CONTEXT && d.pay_return);

// 'app' (pure): the request's declared Origin, else the env/default — which must be a declared origin too.
function resolveAppReturnBase(env, requestOrigin, sites) {
  const dep = appDeployments(sites);
  if (dep.length !== 1) return { base: null, error: 'return_url_unconfigured: no app deployment' };
  const { origins, pay_return: pr } = dep[0];
  if (typeof requestOrigin === 'string' && origins.includes(requestOrigin)) return { base: requestOrigin, error: null };
  const raw = env[pr.env] || pr.default;
  const base = raw ? String(raw).replace(/\/+$/, '') : null;
  if (!base || !origins.includes(base)) return { base: null, error: 'return_url_unconfigured: app base not a declared origin' };
  return { base, error: null };
}
const hasOwnDeployment = (rid, sites = PLATFORM.sites) => ordersDeployments(sites, rid).length === 1;

// THE RULE (pure). brandId: the location's identity.brand_id (undefined / null when it has none). Deviates from
// brands/brand-model.js brandIdOf on purpose: no legacy /brands/{rid} read on the charge path, and a malformed brand_id is
// refused (never guessed).
function resolveReturnBase(restaurantId, env, { brandId = null, entryMode = null, requestOrigin = null, sites = PLATFORM.sites } = {}) {
  const e = env || {};
  if ((ENTRY_MODES.has(entryMode) ? entryMode : 'direct') === 'app') return resolveAppReturnBase(e, requestOrigin, sites);
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
async function resolveReturnBaseForCharge(restaurantId, env, { identity = null, entryMode = null, requestOrigin = null, readBrandId, sites = PLATFORM.sites } = {}) {
  // S2 P-A: app routing short-circuits FIRST — before the rid's own deployment and before any brand_id read, so an
  // unreadable brand leaf can never refuse an app resume
  if (entryMode === 'app') return resolveAppReturnBase(env || {}, requestOrigin, sites);
  if (hasOwnDeployment(restaurantId, sites)) return resolveReturnBase(restaurantId, env, { entryMode, sites });
  let brandId = identity ? identity.brand_id : undefined;
  if (!identity) {
    try { brandId = await readBrandId(); } catch (_) { return { base: null, error: `return_url_unconfigured: ${restaurantId} brand unreadable` }; }
  }
  return resolveReturnBase(restaurantId, env, { brandId, entryMode, sites });
}

module.exports = { resolveReturnBase, resolveReturnBaseForCharge, hasOwnDeployment };
