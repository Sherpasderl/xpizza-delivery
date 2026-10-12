'use strict';
// 1D add-product B — the READ-ONLY verifier of a published required-choice group (first use: NY Plain Slice). Brand-
// agnostic: the restaurant and the EXPECTED group come in as arguments (the spec is data, never a literal here). It
// reads the three LIVE surfaces through the readers production uses, and checks each against the spec:
//   1. the ACTIVE catalog   — catalog-firestore getActiveVersionId + catalog-publish previewVersion (what intake prices)
//   2. the PUBLIC menu      — catalog/public-menu buildPublicMenu with getPublicMenu's own known/isActive wiring
//   3. the KDS manifest     — RTDB /menus/{rid} (the node the kitchen subscribes to) + /menus/_meta/{rid}: exactly the
//                             shipped shape (generateKdsManifest, asserted by PB-1's composed cell) — a WHOLE-DISH row for
//                             the product (staff 86 the whole dish there) followed by one row per choice, in order.
//   ⚠️ DEVIATION FROM PLAN §8 (advisor ruling 2026-10-12): §8 says the KDS excludes a non-orderable launcher, but PB-1 —
//   codex-approved and live — writes the whole-dish row (it is how the kitchen 86s the dish). This tool verifies what
//   production DOES, so the whole-dish row is REQUIRED here; a missing one fails.
// 🔴 ZERO WRITES: the handles it is given are wrapped so that every write method THROWS (readOnly()).
//
// spec = {
//   launcher: { name, cat, desc?, extras_policy?, price? },  // the product the customer opens; price defaults to the
//                                                            // cheapest choice (what the server sets on a NEW group)
//   label: "Salsa",                                          // the group label (the picker CTA derives from it)
//   choices: [ { choice, price, tags? }, … ]                 // IN ORDER; tags default []
// }
const { getActiveVersionId } = require('../catalog/catalog-firestore');
const { previewVersion } = require('../catalog/catalog-publish');
const { buildPublicMenu, defaultIsActive } = require('../catalog/public-menu');
const { createRestaurantRegistry, makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');

const WRITE_METHODS = new Set(['set', 'update', 'delete', 'create', 'add', 'remove', 'push', 'transaction', 'runTransaction', 'batch', 'bulkWriter', 'recursiveDelete', 'setWithPriority', 'setPriority']);
// a proxy over a Firestore / RTDB handle (and everything it returns) on which any write method throws
function readOnly(target, where = 'db') {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return target;
  return new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) return () => { throw new Error(`verify-first-group: refused write ${where}.${prop} — this tool is read-only`); };
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== 'function') return v;
      return function (...args) {
        const out = v.apply(t, args);
        if (out && typeof out.then === 'function') return out.then((r) => readOnly(r, `${where}.${String(prop)}()`));
        return readOnly(out, `${where}.${String(prop)}()`);
      };
    },
  });
}

function validateSpec(spec) {
  const errs = [];
  const str = (v) => typeof v === 'string' && v.trim() === v && v.length > 0;
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];
  if (!spec.launcher || !str(spec.launcher.name) || !str(spec.launcher.cat)) errs.push('spec.launcher needs name + cat');
  if (!str(spec.label)) errs.push('spec.label must be a non-blank string');
  if (!Array.isArray(spec.choices) || spec.choices.length < 2) errs.push('spec.choices needs ≥ 2 entries');
  else spec.choices.forEach((c, i) => {
    if (!c || !str(c.choice) || !(Number.isSafeInteger(c.price) && c.price > 0)) errs.push(`spec.choices[${i}] needs choice + a positive integer price`);
    if (c && c.tags !== undefined && !(Array.isArray(c.tags) && c.tags.every(str))) errs.push(`spec.choices[${i}].tags must be an array of strings`);
  });
  if (spec.launcher && spec.launcher.price !== undefined && !(Number.isSafeInteger(spec.launcher.price) && spec.launcher.price > 0)) errs.push('spec.launcher.price must be a positive integer when given');
  if (Array.isArray(spec.choices) && new Set(spec.choices.map((c) => c && c.choice)).size !== spec.choices.length) errs.push('spec.choices repeat a choice');
  return errs;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// `_buildPublicMenu` / `_previewVersion` are TEST SEAMS only (verify-first-group.emulator.test.js): a served menu, or an
// active catalog the validators would never publish, that disagrees must fail on its own checks. Production always uses
// buildPublicMenu / previewVersion.
async function verifyFirstGroup({ fs, rtdb, rid, spec, _buildPublicMenu = buildPublicMenu, _previewVersion = previewVersion }) {
  const specErrs = validateSpec(spec);
  if (specErrs.length) return { ok: false, checks: specErrs.map((e) => ({ surface: 'spec', ok: false, what: e })) };
  const F = readOnly(fs, 'firestore'); const R = readOnly(rtdb, 'rtdb');
  const checks = [];
  const check = (surface, what, ok, detail) => { checks.push({ surface, what, ok: !!ok, ...(ok ? {} : { detail }) }); return !!ok; };
  const tagsOf = (d) => (Array.isArray(d && d.tags) ? d.tags : []);
  const prices = spec.choices.map((c) => c.price);
  const minPrice = Math.min(...prices);
  const launcherPrice = spec.launcher.price !== undefined ? spec.launcher.price : minPrice;

  // ── 1. the ACTIVE catalog ──
  const versionId = await getActiveVersionId(F, rid);
  check('catalog', 'an active version exists', versionId, versionId);
  if (!versionId) return { ok: false, rid, checks };
  const active = await _previewVersion(F, rid, versionId);
  const items = active.items || [];
  const launchers = items.filter((i) => i && i.display && i.display.name === spec.launcher.name && i.display.variantOf === undefined);
  check('catalog', `exactly one product named "${spec.launcher.name}"`, launchers.length === 1, `found ${launchers.length}`);
  const L = launchers[0];
  let optionKeys = []; let optionIds = [];
  if (L) {
    const d = L.display; const lid = String(d.id);
    check('catalog', `its section is "${spec.launcher.cat}"`, d.cat === spec.launcher.cat, d.cat);
    if (spec.launcher.desc !== undefined) check('catalog', 'its description', d.desc === spec.launcher.desc, d.desc);
    if (spec.launcher.extras_policy !== undefined) check('catalog', `its extras_policy is "${spec.launcher.extras_policy}"`, d.extras_policy === spec.launcher.extras_policy, d.extras_policy);
    check('catalog', `its own price is L ${launcherPrice}${spec.launcher.price === undefined ? ' (the cheapest choice)' : ''}`, L.price === launcherPrice && d.price === launcherPrice, `${L.price}/${d.price}`);
    const vm = (active.structure && active.structure.variant_items) || {};
    const g = vm[lid];
    check('catalog', `a variant map entry for display id ${lid}`, g && Array.isArray(g.variantIds), g);
    if (g) {
      check('catalog', `the group label is "${spec.label}"`, g.label === spec.label, g.label);
      const opts = g.variantIds.map((v) => items.find((i) => i && i.display && String(i.display.id) === String(v)));
      check('catalog', 'every variantId resolves to an item', opts.every(Boolean), g.variantIds);
      check('catalog', `the choices IN ORDER: ${spec.choices.map((c) => c.choice).join(' → ')}`, same(opts.map((o) => o && o.display.choice), spec.choices.map((c) => c.choice)), opts.map((o) => o && o.display.choice));
      const strays = items.filter((i) => i && i.display && String(i.display.variantOf) === lid && !g.variantIds.map(String).includes(String(i.display.id)));
      check('catalog', 'no item claims this product outside the map', strays.length === 0, strays.map((s) => s.key));
      spec.choices.forEach((c, k) => {
        const o = opts[k]; if (!o) return;
        const want = `${spec.launcher.name} - ${c.choice}`;
        check('catalog', `${c.choice}: name "${want}"`, o.display.name === want, o.display.name);
        check('catalog', `${c.choice}: price L ${c.price}`, o.price === c.price && o.display.price === c.price, `${o.price}/${o.display.price}`);
        check('catalog', `${c.choice}: tags ${JSON.stringify(c.tags || [])}`, same([...tagsOf(o.display)].sort(), [...(c.tags || [])].sort()), tagsOf(o.display));
        check('catalog', `${c.choice}: section "${spec.launcher.cat}"`, o.display.cat === spec.launcher.cat, o.display.cat);
        check('catalog', `${c.choice}: belongs to the product`, String(o.display.variantOf) === lid, o.display.variantOf);
        if (spec.launcher.extras_policy !== undefined) check('catalog', `${c.choice}: extras_policy "${spec.launcher.extras_policy}"`, o.display.extras_policy === spec.launcher.extras_policy, o.display.extras_policy);
      });
      optionKeys = opts.filter(Boolean).map((o) => o.key);
      optionIds = opts.filter(Boolean).map((o) => String(o.display.id));
    }

    // ── 2. the PUBLIC menu (getPublicMenu's own wiring) ──
    const registry = createRestaurantRegistry({ listIds: makeFirestoreRegistryReader(F) });
    await registry.ready();
    let pm = null;
    try { pm = await _buildPublicMenu(F, rid, { known: () => registry.known(), isActive: defaultIsActive(R) }); } catch (e) { check('public', 'the public menu builds', false, String((e && e.message) || e)); }
    if (pm) {
      const spec2 = pm.body.variant_items && pm.body.variant_items[lid];
      check('public', `the public menu serves the group for ${lid}`, spec2, Object.keys(pm.body.variant_items || {}));
      if (spec2) {
        check('public', `label "${spec.label}"`, spec2.label === spec.label, spec2.label);
        check('public', `the derived starting price ("desde") is L ${minPrice}`, spec2.basePrice === minPrice, spec2.basePrice);
        check('public', 'its choices IN ORDER', same((spec2.variantIds || []).map(String), optionIds), spec2.variantIds);
      }
    }
  }

  // ── 3. the KDS manifest the kitchen reads ──
  const rows = (await R.ref(`menus/${rid}`).once('value')).val();
  const meta = (await R.ref(`menus/_meta/${rid}`).once('value')).val();
  check('kds', 'the manifest belongs to the ACTIVE version', meta && meta.version_id === versionId, meta && meta.version_id);
  const list = (Array.isArray(rows) ? rows : Object.values(rows || {})).filter(Boolean);
  if (L) {
    const unit = [L.key, ...optionKeys];
    const mine = list.filter((r) => unit.includes(r.key) || (typeof r.label === 'string' && r.label.startsWith(`${spec.launcher.name} - `)));
    check('kds', `exactly the whole-dish row + one row per choice, in order: ${unit.join(' | ')}`, same(mine.map((r) => r.key), unit), mine.map((r) => r.key));
    const byKey = new Map(list.map((r) => [r.key, r]));
    check('kds', 'each row is labelled with its full name and the product\'s section', unit.every((k, i) => byKey.has(k)
      && byKey.get(k).label === (i === 0 ? spec.launcher.name : `${spec.launcher.name} - ${spec.choices[i - 1].choice}`)
      && byKey.get(k).category === spec.launcher.cat), unit.map((k) => byKey.get(k)));
  }

  return { ok: checks.every((c) => c.ok), rid, versionId, checks };
}

module.exports = { verifyFirstGroup, validateSpec, readOnly };
