// PER-PRODUCT EXTRAS — GATE 0, rendered-set parity on the CURRENT forms (PLAN rev 2.1 §13 gate 0). Run: node extras-parity-current.test.mjs
// For EVERY orderable product on BOTH brands, the extras the REAL current form's picker renders must equal
// eligibleExtras(projection, item) from the one evaluator (catalog/extras-eligibility.js), in pricing keys. Until this holds
// on live data, no restriction may become authoritative: a form that already hides (or shows) something the evaluator
// disagrees with would make every later shadow log meaningless.
//
//   default: each brand's code-seeded source (tools/seed-source-store buildSourceFromCode) against the form's own bundle.
//   LIVE (read-only, the advisor's run): EXTRAS_PARITY_<RID>_SOURCE=<source.json> and EXTRAS_PARITY_<RID>_MENU=<getPublicMenu
//   body.json> (RID = X_PIZZA / LA_MUSA) — the form is served that menu, the evaluator reads that source.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadForm, settle, serve, envelope, closeAll, counter, BRAND } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { projectEligibility, eligibleExtras } = require('./catalog/extras-eligibility');
const { buildSourceFromCode } = require('./tools/seed-source-store');
// a portal-authored group, through the REAL writers: the add-only core allocates it into the source, publish's own builder
// builds the catalog from that source, and getPublicMenu's own generator projects the served bundle from that catalog
const A = require('./catalog/add-product');
const { canonicalize, sourceToBuildInputs } = require('./catalog/source-store');
const { buildCatalogV2 } = require('./catalog/form-menu-source');
const { generateFormBundle } = require('./catalog/generate-form-bundle');
const { buildEligibilityDoc } = require('./catalog/extras-eligibility-store');
const { seedPayload } = require('./tools/seed-catalog');   // each brand's seeded restaurant profile (its pricing_key_mode)
const { ok } = counter();
const $ = (w, id) => w.document.getElementById(id);

// the extra ids the open detail modal renders as addable (ordinary rows, or a launcher's staged rows — a stepper on one
// brand's picker, a native checkbox on the other's), unique, in order
function renderedExtraIds(w) {
  const scroll = $(w, 'detail-scroll');
  const ids = [...scroll.querySelectorAll('[data-act="extra"], [data-act="staged"], [data-act="staged-extra"]')].map((b) => b.getAttribute('data-eid'));
  return [...new Set(ids)];
}

async function parityFor(dir, inject = null) {
  const B = BRAND[dir];
  const RID = B.rid;
  const envKey = RID.toUpperCase();
  const liveSrc = process.env[`EXTRAS_PARITY_${envKey}_SOURCE`];
  const liveMenu = process.env[`EXTRAS_PARITY_${envKey}_MENU`];
  // codex gate0 r1 P1-4: LIVE inputs come as a PAIR — a source alone would be checked against the bundled form
  if (!inject) assert.ok(!!liveSrc === !!liveMenu, `🔴 ${RID}: EXTRAS_PARITY_${envKey}_SOURCE and _MENU must be given TOGETHER (got ${liveSrc ? 'source' : 'no source'}, ${liveMenu ? 'menu' : 'no menu'})`);
  // `inject` (the sensitivity cells below): an in-memory source and/or public-menu body instead of files
  const source = inject && inject.source ? inject.source : (liveSrc ? JSON.parse(readFileSync(liveSrc, 'utf8')) : buildSourceFromCode(RID));
  const proj = projectEligibility(source);
  const w = loadForm(dir); await settle();
  // PRESENCE is decided by the input, never by the parsed value (codex gate0 r2 P1): a supplied file that parses to null,
  // a number or an array is a supplied, INVALID body — refused, never confused with "no menu supplied"
  const menuSupplied = !!(inject && 'menu' in inject) || !!liveMenu;
  const menuBody = inject && 'menu' in inject ? inject.menu : (liveMenu ? JSON.parse(readFileSync(liveMenu, 'utf8')) : undefined);
  if (menuSupplied) {
    assert.ok(menuBody !== null && typeof menuBody === 'object' && !Array.isArray(menuBody), `🔴 ${RID}: the supplied public menu is not a JSON object (${menuBody === null ? 'null' : Array.isArray(menuBody) ? 'array' : typeof menuBody}) — refusing, never the bundled fallback`);
    const body = menuBody;
    await serve(w, body);
    // …and the served menu was ACCEPTED and APPLIED before a single control is read (a rejected body leaves the bundle)
    const st = w.__liveMenu && w.__liveMenu.feed && w.__liveMenu.feed.state();
    assert.ok(st && st.source === 'live', `🔴 ${RID}: the supplied public menu was NOT applied (feed source: ${st && st.source}; error: ${st && st.lastError})`);
    const served = ((body.menu || body).dishes || []).map((d) => String(d.id)).sort();
    assert.deepStrictEqual(w.liveMenuGlobalGet('MENU').map((d) => String(d.id)).sort(), served, `🔴 ${RID}: the form's MENU is not the supplied menu's dishes`);
  }
  const MENU = w.liveMenuGlobalGet('MENU');
  const EXTRAS = w.liveMenuGlobalGet('EXTRAS');
  const VARIANTS = w.liveMenuGlobalGet('VARIANT_ITEMS') || {};
  // the form's addressing → pricing keys (by data: x_pizza addresses dishes and extras by NAME, la_musa by ID)
  const byName = RID === 'x_pizza';
  const dishKey = (d) => (byName ? d.name : String(d.id));
  const extraKey = (e) => (byName ? e.name : String(e.id));
  const extraKeyById = new Map(EXTRAS.map((e) => [String(e.id), extraKey(e)]));
  const mismatches = []; const visited = new Set(); const pickerChecked = [];
  const compare = (key, shown, where = '') => {
    const want = eligibleExtras(proj, key);
    if (JSON.stringify([...shown].sort()) !== JSON.stringify([...want].sort())) mismatches.push(`${key}: ${where}form shows [${shown.join(', ')}] vs evaluator [${want.join(', ')}]`);
    visited.add(key);
  };
  // A LAUNCHER'S PICKER, the way a customer uses it: before a choice it offers either nothing (a choice-first picker) or
  // exactly the launcher's own set; then EVERY choice is picked in it, and the extras it offers for that choice — the ones
  // the add puts on that choice's line — must equal THAT choice's eligibleExtras. Brand-agnostic: the choices are the
  // picker's own rows, checked against the group the menu declares.
  const pickerFor = async (d) => {
    w.openDetailModal(d.id); await settle();
    const before = renderedExtraIds(w).map((id) => extraKeyById.get(id) || `?${id}`);
    if (before.length) compare(dishKey(d), before, 'picker before a choice: '); else visited.add(dishKey(d));
    const scroll = $(w, 'detail-scroll');
    const rows = [...scroll.querySelectorAll('.detail-variant-row')].map((r) => r.getAttribute('data-id'));
    const declared = (VARIANTS[d.id].variantIds || []).map(String);
    if (JSON.stringify([...rows].sort()) !== JSON.stringify([...declared].sort())) mismatches.push(`${dishKey(d)}: the picker offers choices [${rows.join(', ')}] vs the group's [${declared.join(', ')}]`);
    for (const vid of rows) {
      $(w, 'detail-scroll').querySelector(`.detail-variant-row[data-id="${vid}"]`).dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle();
      const v = MENU.find((x) => String(x.id) === String(vid));
      const shown = renderedExtraIds(w).map((id) => extraKeyById.get(id) || `?${id}`);
      if (!v || !proj.items[dishKey(v)]) { mismatches.push(`${dishKey(d)}: picker choice ${vid} is not in the source`); continue; }
      compare(dishKey(v), shown, `picker of ${dishKey(d)}: `);
      pickerChecked.push(dishKey(v));
    }
    w.closeDetailModal(); await settle();
  };
  const shownFor = async (d) => {
    // the picker a customer reaches: a dish's (or a chosen variant's, reopened from the cart) extras show once it is in
    // the cart; a launcher's own picker shows its staged extras at once
    const isLauncher = !!VARIANTS[d.id];
    if (!isLauncher) { w.chg(d.id, 1); await settle(); }
    w.openDetailModal(d.id); await settle();
    const shown = renderedExtraIds(w).map((id) => extraKeyById.get(id) || `?${id}`);
    w.closeDetailModal(); await settle();
    if (!isLauncher) { w.chg(d.id, -1); await settle(); }
    return shown;
  };
  for (const d of MENU) {
    if (!(d.price > 0) && !VARIANTS[d.id]) continue;  // "próximamente" rows are not orderable
    const key = dishKey(d);
    if (!proj.items[key]) { mismatches.push(`${key}: on the form, not in the source`); continue; }
    // codex gate0 r1 P1-2: EVERY picker, a variant's own included — compared with the variant's OWN eligibility
    if (VARIANTS[d.id]) await pickerFor(d); else compare(key, await shownFor(d));
  }
  // codex gate0 r1 P1-3: COMPLETENESS from the SOURCE — every orderable source product and variant had its picker visited
  const required = Object.entries(proj.items).filter(([k]) => { const it = (source.items || []).find((i) => i.key === k); return it && it.price > 0; }).map(([k]) => k).sort();
  const missing = required.filter((k) => !visited.has(k));
  if (missing.length) mismatches.push(`source products/variants whose picker was never visited (absent from the form?): ${missing.join(', ')}`);
  return { RID, checked: visited.size, required: required.length, mismatches, pickerChecked, live: !!liveSrc || menuSupplied };
}

// a three-choice group, shaped as the portal sends one (tmp refs in both namespaces), in the brand's first category, allocated
// by the REAL add-only core (authoring on) — it derives keys, display ids and names per the brand's own key mode
function authoredGroup(rid) {
  const base = canonicalize(buildSourceFromCode(rid));
  const L = 'tmp:llllllll-0001'; const V = ['tmp:vvvvvvvv-0001', 'tmp:vvvvvvvv-0002', 'tmp:vvvvvvvv-0003'];
  const cat = base.items[0].display.cat;
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.items.push({ ref: L, price: 1, display: { cat, name: 'NY Plain Slice', price: 1, desc: 'La clásica' } });
  incoming.structure.item_order.push(L);
  ['Salsa Roja', 'Salsa Vodka', 'Combinada'].forEach((choice, i) => {
    incoming.items.push({ ref: V[i], price: 624, display: { choice, variantOf: L, price: 624 } });
    incoming.structure.item_order.push(V[i]);
  });
  incoming.structure.variant_items = { ...(incoming.structure.variant_items || {}), [L]: { label: 'Salsa', variantIds: V } };
  const { source } = A.allocateAdditions({ incoming, stored: base, activeItems: base.items, keyMode: A.resolveKeyMode(seedPayload()[rid].profile.pricing_key_mode, base.items),
    hwm: null, registryHasKey: () => false, fieldProblem: () => null, authoring: true });
  const inputs = sourceToBuildInputs(source);
  const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable, extrasTable: inputs.extras });
  const menu = generateFormBundle(rid, { items: built.items, extras: built.extras, structure: built.structure });
  const doc = buildEligibilityDoc({ items: built.items, extras: built.extras, structure: built.structure });
  const added = source.items.slice(-4);
  return { source, menu: envelope(rid, { ...menu, extras_eligibility: { version: doc.version, deny: doc.public_deny } }),
    launcherKey: added[0].key, choices: added.slice(1).map((i) => i.key) };
}

for (const dir of ['xpizza-orders', 'la-musa-orders']) {
  const r = await parityFor(dir);
  assert.ok(r.checked > 0 && r.checked >= r.required, `${r.RID}: premise — products were checked (${r.checked} of ${r.required})`);
  assert.deepStrictEqual(r.mismatches, [], `🔴 GATE 0 ${r.RID}${r.live ? ' (LIVE)' : ''}: the current form's picker and the evaluator disagree:\n  ${r.mismatches.join('\n  ')}`);
  ok(`${r.RID}${r.live ? ' (LIVE data, applied)' : ''}: all ${r.required} orderable source products AND variants were visited, and each one's rendered extras equal ITS eligibleExtras (pricing keys)`);
}
// ── SENSITIVITY (codex gate0 r1): each counter-example must turn gate 0 RED ───────────────────────────────────────────
if (!process.env.EXTRAS_PARITY_X_PIZZA_SOURCE && !process.env.EXTRAS_PARITY_LA_MUSA_SOURCE) {
  { // P1-2: a launcher legacy add the VARIANT pickers do not render (they filter by category) → the variants' own pickers fail
    const src = buildSourceFromCode('la_musa');
    src.structure.exposure.item_overrides.noodle_01 = { add: ['Proteínas'] };
    const r = await parityFor('la-musa-orders', { source: src });
    for (const v of ['noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron']) assert.ok(r.mismatches.some((m) => m.startsWith(`${v}:`)), `🔴 the VARIANT ${v}'s own picker is checked and fails (${r.mismatches.length} mismatches)`);
    ok('sensitivity P1-2: a launcher add the variant pickers do not render turns each VARIANT red');
  }
  { // P1-3: a priced product in the source that the form does not render → RED (completeness from the source)
    const src = buildSourceFromCode('x_pizza');
    src.items.push({ key: 'Pizza Fantasma', price: 300, display: { id: 999, cat: 'individual', name: 'Pizza Fantasma', price: 300 } });
    src.structure.item_order.push('Pizza Fantasma');
    const r = await parityFor('xpizza-orders', { source: src });
    assert.ok(r.mismatches.some((m) => /never visited.*Pizza Fantasma/.test(m)), `🔴 a source product absent from the form is RED (${r.mismatches.join(' | ')})`);
    ok('sensitivity P1-3: a source product the form never renders is RED');
  }
  { // the LIVE path itself works: a VALID served public menu (each brand's own, as getPublicMenu serves it) is applied and passes
    for (const dir of ['xpizza-orders', 'la-musa-orders']) {
      const f = loadForm(dir); await settle();
      const body = envelope(BRAND[dir].rid, BRAND[dir].menu(f));
      const r = await parityFor(dir, { menu: body });
      assert.ok(r.live && r.mismatches.length === 0 && r.checked >= r.required, `${dir}: a served, applied menu passes (${r.mismatches.join(' | ')})`);
    }
    ok('the live path: a valid served public menu is accepted, APPLIED (feed source "live", MENU = its dishes) and passes on both brands');
  }
  { // THE PICKER'S STAGED-EXTRA ROWS, on a group authored the way the portal authors one, on EVERY brand: the source is
    // the add-only core's output, the served menu is getPublicMenu's generator over publish's build of THAT source (with
    // the version's eligibility document, as served), and the evaluator reads the same source
    for (const dir of ['xpizza-orders', 'la-musa-orders']) {
      const { source, menu, choices } = authoredGroup(BRAND[dir].rid);
      const r = await parityFor(dir, { source, menu });
      assert.deepStrictEqual([...r.pickerChecked].filter((k) => choices.includes(k)).sort(), [...choices].sort(), `${dir}: premise — every choice of the authored group was picked in its picker and checked`);
      assert.ok(r.live && r.checked >= r.required, `${dir}: premise — the served menu was applied and every product visited`);
      assert.deepStrictEqual(r.mismatches, [], `🔴 ${dir}: an authored group's picker and the evaluator disagree:\n  ${r.mismatches.join('\n  ')}`);
    }
    ok('a portal-authored group on BOTH brands: each choice picked in the picker offers exactly ITS eligibleExtras (staged-extra rows included)');
  }
  { // …and that check bites: the evaluator denies one extra to the group (the launcher owns its choices' policy) while the
    // served menu still offers it → every choice's PICKER check is RED, on both brands
    for (const dir of ['xpizza-orders', 'la-musa-orders']) {
      const { source, menu, choices, launcherKey } = authoredGroup(BRAND[dir].rid);
      const denied = eligibleExtras(projectEligibility(source), choices[0])[0];
      const strict = JSON.parse(JSON.stringify(source));
      strict.structure.exposure = strict.structure.exposure || {}; strict.structure.exposure.item_overrides = strict.structure.exposure.item_overrides || {};
      strict.structure.exposure.item_overrides[launcherKey] = { ...(strict.structure.exposure.item_overrides[launcherKey] || {}), deny_extras: [denied] };
      const r = await parityFor(dir, { source: strict, menu });
      for (const c of choices) assert.ok(r.mismatches.some((m) => m.startsWith(`${c}: picker of ${launcherKey}: `)), `🔴 ${dir}: choice ${c}'s PICKER check turns red on a denied ${denied} (${r.mismatches.join(' | ')})`);
    }
    ok('sensitivity: an extra the evaluator denies to an authored group but the picker still offers turns EACH choice\'s picker check red, on both brands');
  }
  { // P1-4: a supplied menu the form REJECTS ({}) is never silently replaced by the bundle
    await assert.rejects(parityFor('xpizza-orders', { menu: {} }), /was NOT applied/, '🔴 a rejected live menu fails before any control is read');
    // codex gate0 r2 P1: a supplied body that parses to null / a number / an array is refused — never "not supplied"
    for (const bad of [null, 42, [], 'menu']) await assert.rejects(parityFor('la-musa-orders', { menu: bad }), /not a JSON object/, `🔴 a supplied ${JSON.stringify(bad)} body is refused`);
    ok('sensitivity P1-4: a supplied public menu the form rejects ({}), or a supplied null / number / array / string body, fails gate 0 — never the bundled fallback');
  }
}
closeAll();
console.log('\nextras-parity-current: OK');
