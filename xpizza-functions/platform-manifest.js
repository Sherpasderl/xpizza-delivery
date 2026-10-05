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
    if (!Array.isArray(d.origins)) errs.push(`${tag}: origins must be an array`);
    else for (const o of d.origins) {
      if (!isExactHttpsOrigin(o)) errs.push(`${tag}: origin ${JSON.stringify(o)} is not an exact https origin`);
      if (origins.has(o)) errs.push(`${tag}: origin ${o} listed twice`);
      origins.add(o);
    }
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
function deriveCorsLists(m) {
  const o = orderOrigins(m);
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
module.exports = { PLATFORM, loadPlatform, validateManifest, validateCompat, deriveCorsLists, isExactHttpsOrigin, LOCALHOST_DEV_RE, PLATFORM_CONTEXT, RID_RE, ID_RE };
