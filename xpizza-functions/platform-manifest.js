'use strict';
// ── P-SELFUPDATE — the platform SITE MANIFEST and COMPATIBILITY GENERATIONS, as the functions see them ─────────────
//
// The canonical files are <repo>/platform/sites.json and <repo>/platform/compat.json. Functions deploy only this folder,
// so a BYTE-IDENTICAL copy is bundled at ./platform/ (written by `npm run sync:platform`; platform-sync.guard.test.js
// fails on any drift, like sync:rules).
//
// What reads it:
//   • the order-site CORS lists (advisor ruling, P-SELFUPDATE origins = option A): ACCOUNT_ORIGINS and
//     PUBLIC_MENU_ORIGINS are DERIVED here at module load from the `orders` deployments' exact origins, in manifest
//     order, and are still handed to the v2 `cors` option. Onboarding a merchant = a manifest entry + a functions deploy;
//     there is no runtime origin read, so a bad config write can never break CORS for existing merchants;
//   • reportClientVersion's schema (valid app × deployment × context combinations; compat bounded by the current
//     generation per app).
//
// A malformed bundled manifest THROWS at module load. That is deliberate: the files are static, so the failure is
// deterministic and surfaces at deploy analysis / in tests, never as a runtime surprise.
const SITES = require('./platform/sites.json');
const COMPAT = require('./platform/compat.json');

const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;        // restaurant ids (catalog/restaurant-registry.js RID_RE)
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;          // app / deployment ids: path-safe, bounded
const PLATFORM_CONTEXT = 'platform';
// Local development against production data — public menu only (kept from the pre-manifest literal list).
const LOCALHOST_DEV_RE = /^http:\/\/localhost(:\d+)?$/;
// PLAN-capp-native-shell §1.1 (Codex #1, P1): the bundled native shell's WebView origins — iOS (WKWebView, capacitor scheme) and
// Android (Capacitor's https://localhost). EXACTLY these two, and only in the platform orders deployment's `native` block: they are
// not https sites, so they never enter `origins` (the pay-return allowlist, the stamp, the domain swap) — only the CORS lists.
const NATIVE_ORIGINS = Object.freeze(['capacitor://localhost', 'https://localhost']);

function isExactHttpsOrigin(o) {
  if (typeof o !== 'string' || o.includes('*')) return false;
  try { const u = new URL(o); return u.protocol === 'https:' && u.origin === o; } catch (_) { return false; }
}

// → [] when valid, else the list of problems
function validateManifest(m) {
  const errs = [];
  if (!m || m.schema !== 1) errs.push('schema must be 1');
  const apps = Array.isArray(m && m.apps) ? m.apps : [];
  if (!apps.length) errs.push('apps must be a non-empty array');
  if (new Set(apps).size !== apps.length) errs.push('apps must be unique');
  for (const a of apps) if (typeof a !== 'string' || !ID_RE.test(a)) errs.push(`bad app id ${JSON.stringify(a)}`);
  const deps = Array.isArray(m && m.deployments) ? m.deployments : [];
  if (!deps.length) errs.push('deployments must be a non-empty array');
  const ids = new Set();
  const origins = new Set();
  for (const d of deps) {
    const tag = JSON.stringify(d && d.id);
    if (!d || typeof d.id !== 'string' || !ID_RE.test(d.id)) { errs.push(`bad deployment id ${tag}`); continue; }
    if (ids.has(d.id)) errs.push(`duplicate deployment ${tag}`);
    ids.add(d.id);
    if (!apps.includes(d.app)) errs.push(`${tag}: unknown app ${JSON.stringify(d.app)}`);
    if (typeof d.folder !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(d.folder)) errs.push(`${tag}: bad folder`);
    if (!Array.isArray(d.entrypoints) || !d.entrypoints.length
      || d.entrypoints.some((e) => typeof e !== 'string' || !/^[a-z0-9][a-z0-9_/-]*\.html$/.test(e) || e.includes('..'))) errs.push(`${tag}: bad entrypoints`);
    if (!(d.context === PLATFORM_CONTEXT || (typeof d.context === 'string' && RID_RE.test(d.context)))) errs.push(`${tag}: bad context`);
    // S3b: the hosted-checkout RETURN routing (pixelpay-return-url.js) — only an `orders` deployment may carry it: the env key
    // naming its base, and an optional exact https default (absent → fail-closed when the env is unset)
    if (d.pay_return !== undefined) {
      const pr = d.pay_return;
      if (d.app !== 'orders') errs.push(`${tag}: pay_return is only for an orders deployment`);
      else if (!pr || typeof pr !== 'object' || Array.isArray(pr) || Object.keys(pr).some((k) => k !== 'env' && k !== 'default')) errs.push(`${tag}: pay_return must be { env, default? }`);
      else {
        if (typeof pr.env !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(pr.env)) errs.push(`${tag}: pay_return.env must be an ENV_KEY`);
        if (pr.default !== undefined && !isExactHttpsOrigin(pr.default)) errs.push(`${tag}: pay_return.default must be an exact https origin`);
      }
    }
    if (d.native !== undefined) {
      const nv = d.native;
      if (d.app !== 'orders' || d.context !== PLATFORM_CONTEXT) errs.push(`${tag}: native is only for the platform orders deployment`);
      else if (!nv || typeof nv !== 'object' || Array.isArray(nv) || Object.keys(nv).some((k) => k !== 'origins')) errs.push(`${tag}: native must be { origins }`);
      else if (!Array.isArray(nv.origins) || !nv.origins.length) errs.push(`${tag}: native.origins must be a non-empty array`);
      else {
        for (const o of nv.origins) if (!NATIVE_ORIGINS.includes(o)) errs.push(`${tag}: native origin ${JSON.stringify(o)} is not one of ${NATIVE_ORIGINS.join(', ')}`);
        if (new Set(nv.origins).size !== nv.origins.length) errs.push(`${tag}: native origins must be unique`);
      }
    }
    if (!Array.isArray(d.origins)) errs.push(`${tag}: origins must be an array`);
    else for (const o of d.origins) {
      if (!isExactHttpsOrigin(o)) errs.push(`${tag}: origin ${JSON.stringify(o)} is not an exact https origin`);
      if (origins.has(o)) errs.push(`${tag}: origin ${o} listed twice`);
      origins.add(o);
    }
  }
  // S2 P-A: the customer APP's orders deployment (context 'platform', never a rid's own) — at most ONE, and it must carry a
  // pay_return whose default is one of its OWN declared origins (pixelpay-return-url.js only ever returns to a declared origin)
  const appDeps = deps.filter((d) => d && d.app === 'orders' && d.context === PLATFORM_CONTEXT);
  if (appDeps.length > 1) errs.push('at most one orders deployment may have context platform');
  for (const d of appDeps) {
    const pr = d.pay_return;
    if (!pr || typeof pr !== 'object' || pr.default === undefined) errs.push(`${JSON.stringify(d.id)}: the platform orders deployment needs pay_return with a default`);
    else if (!Array.isArray(d.origins) || !d.origins.includes(pr.default)) errs.push(`${JSON.stringify(d.id)}: pay_return.default must be one of its own origins`);
  }
  return errs;
}

function validateCompat(c, apps) {
  const errs = [];
  if (!c || c.schema !== 1 || !c.generations || typeof c.generations !== 'object') return ['compat schema must be 1 with generations'];
  for (const a of apps) {
    const g = c.generations[a];
    if (!Number.isInteger(g) || g < 1 || g > 1000000) errs.push(`compat generation for ${a} must be an integer ≥ 1`);
  }
  for (const a of Object.keys(c.generations)) if (!apps.includes(a)) errs.push(`compat names unknown app ${a}`);
  return errs;
}

// The order sites' exact origins, in manifest order (the CORS audience of the shared order-site constants).
const orderOrigins = (m) => m.deployments.filter((d) => d.app === 'orders').flatMap((d) => d.origins);
// …then the native shell's WebView origins (§1.1), AFTER every site origin (today's lists keep their members and order)
const nativeOrigins = (m) => m.deployments.filter((d) => d.app === 'orders' && d.context === PLATFORM_CONTEXT && d.native).flatMap((d) => d.native.origins);
function deriveCorsLists(m) {
  const o = [...orderOrigins(m), ...nativeOrigins(m)];
  return { ACCOUNT_ORIGINS: [...o], PUBLIC_MENU_ORIGINS: [LOCALHOST_DEV_RE, ...o] };
}

function loadPlatform(sites = SITES, compat = COMPAT) {
  const errs = [...validateManifest(sites), ...validateCompat(compat, (sites && sites.apps) || [])];
  if (errs.length) throw new Error(`platform manifest invalid: ${errs.join('; ')}`);
  const byId = new Map(sites.deployments.map((d) => [d.id, d]));
  return {
    sites, compat, ...deriveCorsLists(sites),
    // a heartbeat's (app, deployment, context) must be exactly a manifest combination
    isValidCombination: (app, deployment, context) => { const d = byId.get(deployment); return !!d && d.app === app && d.context === context; },
    maxCompat: (app) => (Number.isInteger(compat.generations[app]) ? compat.generations[app] : 0),
    isKnownApp: (app) => sites.apps.includes(app),
  };
}

const PLATFORM = loadPlatform();
module.exports = { PLATFORM, loadPlatform, validateManifest, validateCompat, deriveCorsLists, isExactHttpsOrigin, LOCALHOST_DEV_RE, NATIVE_ORIGINS, PLATFORM_CONTEXT, RID_RE, ID_RE };
