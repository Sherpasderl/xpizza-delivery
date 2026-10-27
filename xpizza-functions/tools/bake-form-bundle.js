'use strict';
// PLAN 4 (bake from published) r3 §3 — BAKE a form's menu from its brand's PUBLISHED catalog at build time.
// Run (a form's Netlify build ONLY — it rewrites the build container's index.html):
//   node ../xpizza-functions/tools/bake-form-bundle.js --this-form
// The build command is `bake --this-form && stamp && check --this-form`: the bake runs BEFORE the stamp, so the build hash
// covers the bytes actually served, and the live check then proves the baked menu equals the published one.
//
// FRESH READ (P2-4): GET the form's own PUBLICMENU_URL + '/menu/<rid>?_bake=<build-start-ms>' with Cache-Control: no-cache
// — the server's rid parser ignores the query, and a unique query defeats any intermediary cache. One transport: the live
// check's getJson (one settle path; inactivity + total deadline).
//
// ENVELOPE CONTRACT (P2-5): every failed rule is a NAMED refusal; ANY refusal means NO file changes and a non-zero exit, so
// the build fails and the previous deploy stays live. The rules mirror the forms' own liveMenuPrepare (both forms) and the
// shared rules — loaded from the form's OWN shipped form-group-picker.js (validateVariantBlock, validateExtrasPolicy,
// validateDisplayStructures) — so a bake can never ship what the live apply would refuse.
//
// PROJECTION: the published `menu`, verbatim, minus the identity keys (identity_id / dish_id / extra_id) on dish and extra
// records — pre-apply order payloads stay byte-identical to today's, and the live apply adds the ids exactly as now.
// Node built-ins only (via the modules it shares with the live check): it runs where xpizza-functions' deps are not installed.
const { join, dirname } = require('path');
const { readFileSync } = require('fs');
const { spliceFormFile } = require('../catalog/splice-form-bundle');
const { premigrationGaps } = require('../catalog/menu-structure-rows');   // PLAN 4 GATED: the migrated fields are required
const { selectForms, publicMenuUrl, getJson, IDENTITY_KEYS } = require('./form-bundle-live-check');

// Every representation a consumer accepts during the rollout (r3 §8.1): the bake, the live check and the forms' adapter.
const KNOWN_REPRESENTATIONS = Object.freeze(['1d.1', '1d.2', '1d.3']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');

// The fresh-read URL: the form's own endpoint + a build-unique query.
function bakeUrl(html, rid, buildStartMs) { return `${publicMenuUrl(html, rid)}?_bake=${encodeURIComponent(String(buildStartMs))}`; }

// PURE. The published envelope against the contract → [refusal, …] (empty = bakeable). `groupPicker` is the form's own module.
function validateEnvelope(env, rid, { groupPicker }) {
  const r = [];
  if (!isObj(env)) return ['bake_envelope_malformed'];
  if (env.rid !== rid) r.push(`bake_wrong_rid: asked ${rid}, got ${JSON.stringify(env.rid)}`);
  if (!KNOWN_REPRESENTATIONS.includes(env.representation_version)) r.push(`bake_unknown_representation: ${JSON.stringify(env.representation_version)}`);
  const m = env.menu;
  if (!isObj(m)) { r.push('bake_menu_missing'); return r; }

  // THE COMPLETE MENU CONTRACT (Codex r1 #2 / #3) — the form's OWN shared rule (form-group-picker.js validateMenu), the one its
  // boot and every live apply run: records, positive-integer prices, unique ids, categories, extras_policy, a drawable variant
  // map with REVERSE coverage (a dish with variantOf needs its launcher map — the BODY's own; the bake has no retained map),
  // option maps, gates, badges, priority and reward icons. Its first problem is the refusal.
  try { groupPicker.validateMenu(m, { variantItems: m.variant_items, origin: 'bake' }); } catch (e) { r.push(`bake_${e.message}`); }
  // PLAN 4 GATED (Codex r3 #3): this runtime has NO literal fallback for the migrated fields — a pre-migration published body is
  // refused at BUILD time (the previous deploy stays live) instead of shipping Nutella with every option or La Musa without badges
  const gaps = premigrationGaps(rid, m);
  if (gaps.length) r.push(`bake_premigration_body: ${gaps.length} migrated field(s) missing — ${gaps.slice(0, 6).join(', ')}${gaps.length > 6 ? ', …' : ''}`);
  if (m.has_photo !== undefined && !isStrArray(m.has_photo)) r.push('bake_has_photo_malformed');
  return r;
}

// PURE. The published menu minus the identity keys on its dish and extra records; everything else verbatim.
function projectMenu(menu) {
  const out = JSON.parse(JSON.stringify(menu));
  const strip = (rec) => (isObj(rec) ? Object.fromEntries(Object.entries(rec).filter(([k]) => !IDENTITY_KEYS.has(k))) : rec);
  if (Array.isArray(out.dishes)) out.dishes = out.dishes.map(strip);
  if (Array.isArray(out.extras)) out.extras = out.extras.map(strip);
  return out;
}

// One form: fresh read → contract → projection → splice. → { rid, changed, refusals, dishes }
async function bakeForm(rid, file, { fetchJson = getJson, buildStartMs = Date.now(), splice = spliceFormFile, groupPicker = null } = {}) {
  const html = readFileSync(file, 'utf8');
  const gp = groupPicker || require(join(dirname(file), 'form-group-picker.js'));
  let env;
  try { env = await fetchJson(bakeUrl(html, rid, buildStartMs), { headers: { accept: 'application/json', 'cache-control': 'no-cache' } }); } catch (e) {
    return { rid, changed: false, refusals: [`bake_fetch_failed: ${e && e.message}`] };
  }
  const refusals = validateEnvelope(env, rid, { groupPicker: gp });
  if (refusals.length) return { rid, changed: false, refusals };
  const bundle = projectMenu(env.menu);
  const { changed } = splice(file, bundle, rid);   // fail-closed: a marker, serialization or round-trip failure throws, nothing written
  return { rid, changed, refusals: [], dishes: bundle.dishes.length };
}

async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  process.exitCode = 1;   // a failure until the very end proves otherwise (the live check's belt)
  if (!argv.includes('--this-form')) { console.error('bake-form-bundle: --this-form is required — the bake rewrites a BUILD container\'s form, never a working tree'); process.exit(1); }
  const selected = selectForms(argv, cwd);
  if (!selected) { console.error(`FAIL ${cwd}: --this-form, but this folder is not a registered form`); process.exit(1); }
  const buildStartMs = Date.now();
  let failed = false;
  for (const [rid, file] of selected) {
    let res;
    try { res = await bakeForm(rid, file, { buildStartMs }); } catch (e) { res = { rid, changed: false, refusals: [`bake_splice_failed: ${e && e.message}`] }; }
    for (const f of res.refusals) console.error(`FAIL ${rid} ${f}`);
    if (res.refusals.length) { failed = true; continue; }
    console.log(`${rid}: baked ${res.dishes} dishes from the published catalog (${res.changed ? 'form updated' : 'already identical'})`);
  }
  if (failed) { console.error('bake-form-bundle: REFUSED — nothing written; the build fails and the previous deploy stays live'); process.exit(1); }
  console.log('bake-form-bundle: OK');
  process.exitCode = 0;
}

if (require.main === module) main().catch((e) => { console.error('bake-form-bundle: ERROR', e && e.message); process.exit(1); });
module.exports = { validateEnvelope, projectMenu, bakeForm, bakeUrl, main, KNOWN_REPRESENTATIONS };
