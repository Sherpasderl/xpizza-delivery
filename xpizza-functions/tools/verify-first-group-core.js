'use strict';
// 1D add-product B — the READ-ONLY verifier of a published required-choice group (first use: NY Plain Slice). Brand-
// agnostic: the restaurant and the EXPECTED group come in as arguments (the spec is data, never a literal here). It
// reads the three LIVE surfaces through the readers production uses, and checks each against the spec:
//   1. the ACTIVE catalog   — catalog-firestore getActivePointer + catalog-publish previewVersion (what intake prices)
//   2. the PUBLIC menu      — catalog/public-menu buildPublicMenu with getPublicMenu's own known/isActive wiring: the
//                             served group spec AND the served dishes (launcher + every choice)
//   3. the KDS manifest     — RTDB /menus/{rid} (the node the kitchen subscribes to) + /menus/_meta/{rid}: exactly the
//                             shipped shape (generateKdsManifest, asserted by PB-1's composed cell) — a WHOLE-DISH row for
//                             the product (staff 86 the whole dish there) followed by one row per choice, in order.
//   ⚠️ DEVIATION FROM PLAN §8 (advisor ruling 2026-10-12): §8 says the KDS excludes a non-orderable launcher, but PB-1 —
//   codex-approved and live — writes the whole-dish row (it is how the kitchen 86s the dish). This tool verifies what
//   production DOES, so the whole-dish row is REQUIRED here; a missing one fails.
//
// ONE SNAPSHOT (codex r1 P1-3): the active pointer {version, generation} is captured ONCE; the catalog is read AT that
// version, the public menu must have been served from it (its seq = that version's seq), the KDS manifest must belong to
// it (_meta.version_id), and the pointer is re-read at the end — if it moved, the run FAILS: "catalog changed during
// verification, re-run". A publish racing the run can never produce a false "active".
//
// 🔴 ZERO WRITES (codex r1 P1-1): the production readers are handed a RESTRICTED READ-ONLY ADAPTER, never an SDK handle.
// It exposes only the read operations they use (Firestore: collection / doc / where / orderBy / limit / get /
// listDocuments and read-only snapshots; RTDB: ref / child / once / get and read-only snapshots). Nothing it returns
// carries a writable handle — no `.firestore`, `.parent`, `.database`, snapshot `.ref` — so no write is reachable through
// it, not even by a reader's own bug.
//
// spec = {
//   launcher: { name, cat, desc?, extras_policy?, price? },  // the product the customer opens; price defaults to the
//                                                            // cheapest choice (what the server sets on a NEW group)
//   label: "Salsa",                                          // the group label (the picker CTA derives from it)
//   choices: [ { choice, price, tags? }, … ]                 // IN ORDER; tags default []
// }
const { getActivePointer } = require('../catalog/catalog-firestore');
const { previewVersion } = require('../catalog/catalog-publish');
const { buildPublicMenu, defaultIsActive } = require('../catalog/public-menu');
const { createRestaurantRegistry, makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
const { RID_RE } = require('../catalog/catalog-edit-auth');   // production's restaurant-id shape (codex r1 P2-5)

// ── the restricted read-only adapters ────────────────────────────────────────────────────────────────────────────
// Each wraps ONE underlying object and exposes a fixed set of members. Data values pass through as plain copies.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function roDocSnap(s) {
  return Object.freeze({
    id: s.id, exists: s.exists, updateTime: s.updateTime, createTime: s.createTime, readTime: s.readTime,
    data: () => (s.exists ? plain(s.data()) : undefined),
    get: (field) => plain(s.get(field)),
  });
}
function roQuerySnap(q) {
  const docs = q.docs.map(roDocSnap);
  return Object.freeze({ docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) });
}
function roQuery(q) {
  return Object.freeze({
    where: (...a) => roQuery(q.where(...a)), orderBy: (...a) => roQuery(q.orderBy(...a)), limit: (n) => roQuery(q.limit(n)),
    get: async () => roQuerySnap(await q.get()),
  });
}
function roCollection(c) {
  return Object.freeze({
    id: c.id, path: c.path,
    doc: (id) => roDoc(c.doc(id)),
    where: (...a) => roQuery(c.where(...a)), orderBy: (...a) => roQuery(c.orderBy(...a)), limit: (n) => roQuery(c.limit(n)),
    get: async () => roQuerySnap(await c.get()),
    listDocuments: async () => (await c.listDocuments()).map(roDoc),
  });
}
function roDoc(d) {
  return Object.freeze({
    id: d.id, path: d.path,
    collection: (p) => roCollection(d.collection(p)),
    get: async () => roDocSnap(await d.get()),
  });
}
function readOnlyFirestore(fs) {
  return Object.freeze({ collection: (p) => roCollection(fs.collection(p)), doc: (p) => roDoc(fs.doc(p)) });
}
function roRtdbSnap(s) {
  return Object.freeze({ key: s.key, val: () => plain(s.val()), exists: () => s.exists(), child: (p) => roRtdbSnap(s.child(p)) });
}
function roRtdbRef(r) {
  return Object.freeze({
    key: r.key, child: (p) => roRtdbRef(r.child(p)),
    once: async (ev) => { if (ev !== 'value') throw new Error('verify-first-group: only once("value") is supported'); return roRtdbSnap(await r.once('value')); },
    get: async () => roRtdbSnap(await r.get()),
  });
}
function readOnlyRtdb(rtdb) { return Object.freeze({ ref: (p) => roRtdbRef(rtdb.ref(p)) }); }

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
  if (Array.isArray(spec.choices) && new Set(spec.choices.map((c) => c && c.choice)).size !== spec.choices.length) errs.push('spec.choices repeat a choice');
  if (spec.launcher && spec.launcher.price !== undefined && !(Number.isSafeInteger(spec.launcher.price) && spec.launcher.price > 0)) errs.push('spec.launcher.price must be a positive integer when given');
  return errs;
}
const validRid = (rid) => typeof rid === 'string' && RID_RE.test(rid);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// `_buildPublicMenu` / `_previewVersion` / `_onRead` are TEST SEAMS only (verify-first-group.emulator.test.js): a served
// menu, or an active catalog the validators would never publish, that disagrees must fail on its own checks; `_onRead`
// runs between the reads and the final pointer re-read (a racing publish). Production always uses buildPublicMenu /
// previewVersion and no hook.
async function verifyFirstGroup({ fs, rtdb, rid, spec, _buildPublicMenu = buildPublicMenu, _previewVersion = previewVersion, _onRead = null }) {
  const specErrs = validateSpec(spec);
  if (!validRid(rid)) specErrs.unshift(`not a restaurant id: ${JSON.stringify(rid)}`);
  if (specErrs.length) return { ok: false, checks: specErrs.map((e) => ({ surface: 'spec', ok: false, what: e })) };
  const F = readOnlyFirestore(fs); const R = readOnlyRtdb(rtdb);
  const checks = [];
  const check = (surface, what, ok, detail) => { checks.push({ surface, what, ok: !!ok, ...(ok ? {} : { detail }) }); return !!ok; };
  const tagsOf = (d) => (Array.isArray(d && d.tags) ? d.tags : []);
  const prices = spec.choices.map((c) => c.price);
  const minPrice = Math.min(...prices);
  const launcherPrice = spec.launcher.price !== undefined ? spec.launcher.price : minPrice;

  // ── 0. ONE snapshot: the pointer, captured once ──
  const pointer = await getActivePointer(F, rid);
  check('catalog', 'an active version exists', pointer.version, pointer);
  if (!pointer.version) return { ok: false, rid, checks };
  const versionId = pointer.version;

  // ── 1. the ACTIVE catalog, AT the captured version ──
  const active = await _previewVersion(F, rid, versionId);
  const items = active.items || [];
  const launchers = items.filter((i) => i && i.display && i.display.name === spec.launcher.name && i.display.variantOf === undefined);
  check('catalog', `exactly one product named "${spec.launcher.name}"`, launchers.length === 1, `found ${launchers.length}`);
  const L = launchers[0];
  let optionKeys = []; let optionIds = []; let lid = null;
  const fullName = (c) => `${spec.launcher.name} - ${c.choice}`;
  if (L) {
    const d = L.display; lid = String(d.id);
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
        check('catalog', `${c.choice}: name "${fullName(c)}"`, o.display.name === fullName(c), o.display.name);
        check('catalog', `${c.choice}: price L ${c.price}`, o.price === c.price && o.display.price === c.price, `${o.price}/${o.display.price}`);
        check('catalog', `${c.choice}: tags ${JSON.stringify(c.tags || [])}`, same([...tagsOf(o.display)].sort(), [...(c.tags || [])].sort()), tagsOf(o.display));
        check('catalog', `${c.choice}: section "${spec.launcher.cat}"`, o.display.cat === spec.launcher.cat, o.display.cat);
        check('catalog', `${c.choice}: belongs to the product`, String(o.display.variantOf) === lid, o.display.variantOf);
        if (spec.launcher.extras_policy !== undefined) check('catalog', `${c.choice}: extras_policy "${spec.launcher.extras_policy}"`, o.display.extras_policy === spec.launcher.extras_policy, o.display.extras_policy);
      });
      optionKeys = opts.filter(Boolean).map((o) => o.key);
      optionIds = opts.filter(Boolean).map((o) => String(o.display.id));
    }

    // ── 2. the PUBLIC menu (getPublicMenu's own wiring): the group spec AND the served dishes ──
    const registry = createRestaurantRegistry({ listIds: makeFirestoreRegistryReader(F) });
    await registry.ready();
    let pm = null;
    try { pm = await _buildPublicMenu(F, rid, { known: () => registry.known(), isActive: defaultIsActive(R) }); } catch (e) { check('public', 'the public menu builds', false, String((e && e.message) || e)); }
    if (pm) {
      check('public', 'the served menu is the captured active version (its seq)', pm.seq === (active.record && active.record.seq), `${pm.seq} vs ${active.record && active.record.seq}`);
      const spec2 = pm.body.variant_items && pm.body.variant_items[lid];
      check('public', `the public menu serves the group for ${lid}`, spec2, Object.keys(pm.body.variant_items || {}));
      if (spec2) {
        check('public', `label "${spec.label}"`, spec2.label === spec.label, spec2.label);
        check('public', `the derived starting price ("desde") is L ${minPrice}`, spec2.basePrice === minPrice, spec2.basePrice);
        check('public', 'its choices IN ORDER', same((spec2.variantIds || []).map(String), optionIds), spec2.variantIds);
      }
      // codex r1 P1-2: the served DISHES themselves — the launcher and every choice, as the order form renders them
      const dishes = Array.isArray(pm.body.dishes) ? pm.body.dishes : [];
      const byId = new Map(dishes.map((x) => [String(x && x.id), x]));
      const ld = byId.get(lid);
      check('public', `the served product "${spec.launcher.name}" (id ${lid})`, ld && ld.name === spec.launcher.name && ld.cat === spec.launcher.cat && ld.price === launcherPrice
        && ld.variantOf === undefined && (spec.launcher.extras_policy === undefined || ld.extras_policy === spec.launcher.extras_policy), ld);
      spec.choices.forEach((c, k) => {
        const x = byId.get(optionIds[k]);
        check('public', `served ${c.choice}: name, choice, price L ${c.price}, section, product, tags, extras_policy`, x
          && x.name === fullName(c) && x.choice === c.choice && x.price === c.price && x.cat === spec.launcher.cat && String(x.variantOf) === lid
          && same([...tagsOf(x)].sort(), [...(c.tags || [])].sort()) && (spec.launcher.extras_policy === undefined || x.extras_policy === spec.launcher.extras_policy), x);
      });
      const servedMembers = dishes.filter((x) => x && String(x.variantOf) === lid).map((x) => String(x.id));
      check('public', 'the served menu has no other choice for this product', same([...servedMembers].sort(), [...optionIds].sort()), servedMembers);
    }
  }

  // ── 3. the KDS manifest the kitchen reads ──
  const rows = (await R.ref(`menus/${rid}`).once('value')).val();
  const meta = (await R.ref(`menus/_meta/${rid}`).once('value')).val();
  check('kds', 'the manifest belongs to the captured active version', meta && meta.version_id === versionId, meta && meta.version_id);
  const list = (Array.isArray(rows) ? rows : Object.values(rows || {})).filter(Boolean);
  if (L) {
    const unit = [L.key, ...optionKeys];
    // codex r1 P2-4: a stray row is one with a unit KEY, the launcher's exact LABEL, or a "{launcher} - …" label
    const mine = list.filter((r) => unit.includes(r.key) || r.label === spec.launcher.name || (typeof r.label === 'string' && r.label.startsWith(`${spec.launcher.name} - `)));
    check('kds', `exactly the whole-dish row + one row per choice, in order: ${unit.join(' | ')}`, same(mine.map((r) => r.key), unit), mine.map((r) => r.key));
    const byKey = new Map(list.map((r) => [r.key, r]));
    check('kds', 'each row is labelled with its full name and the product\'s section', unit.every((k, i) => byKey.has(k)
      && byKey.get(k).label === (i === 0 ? spec.launcher.name : fullName(spec.choices[i - 1]))
      && byKey.get(k).category === spec.launcher.cat), unit.map((k) => byKey.get(k)));
  }

  // ── 4. the pointer did not move under us ──
  if (_onRead) await _onRead();
  const after = await getActivePointer(F, rid);
  check('catalog', 'catalog unchanged during verification (else: catalog changed during verification, re-run)',
    after.version === pointer.version && after.generation === pointer.generation, { before: pointer, after });

  return { ok: checks.every((c) => c.ok), rid, versionId, checks };
}

module.exports = { verifyFirstGroup, validateSpec, validRid, readOnlyFirestore, readOnlyRtdb };
