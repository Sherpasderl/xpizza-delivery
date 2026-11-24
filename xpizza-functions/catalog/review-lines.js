'use strict';
// THE REVIEW LINE MODEL — ONE source for «Revisar y publicar» and the server's «cambios sin publicar» count (PLAN-portal-review-lines-r0,
// advisor 11-23: cut on the S3S4 tip, so the choice (S3) and section (S4) rows are in it). The portal's review screen (review.js renders
// it) and 5f's S3 `pending_count` read the SAME model, so the number the home shows is exactly the number of sentences the review draws:
// every server line once — an extra added / removed / repriced on the Extras page is its «Estructura» row only, an option's line
// identical to its product's is absorbed, a checklist cleanup folds into its structural row, a removed dish is its «Productos» row, a
// choice / section change is its own «Estructura» row. A raw sum of the diff's arrays over-counts.
// The code below was MOVED byte-verbatim from review.js, app.js productReviewCtx, item-edit-logic.js (S3_COPY) and render.js (S4_COPY,
// nProd); read their history there. UMD-lite: CommonJS where `module` exists (xpizza-functions/catalog/review-lines.js, the byte copy
// tools/sync-client.js writes), else the global ReviewLines (the portal imports it for that side effect). No DOM, no I/O, no imports.
(function (root) {
// the diff contract's photo line (DISH PHOTOS B §2.2): {field:'photo', old, new} — photo-logic.js reads it from here
const isPhotoLine = (c) => !!(c && c.field === 'photo');

// S3_COPY: the S3 addendum's lines verbatim (owner 11-14); labelTooLong / optNameRequired = the owner's own strings (11-19)
const S3_COPY = Object.freeze({ recRequired: "Falta la opción recomendada: marcá una para guardar los cambios.", recRemoved: "Quitaste la opción recomendada: marcá otra para guardar.", tooFew: "Una elección necesita al menos dos opciones. Agregá otra o quitá la elección.", removePick: "{nombre} queda con un solo precio. Elegí cuál; podés cambiarlo antes de publicar.", pickTitle: "Elegí el precio que queda", pickAria: "Precio que queda", b7Line: "La primera opción queda como recomendada. Tocá otra para cambiarla.", labelRequired: "Escribí el nombre de la elección.", labelTooLong: "El nombre de la elección pasa de 40 letras. Acortalo.", optNameRequired: "Escribí el nombre de la opción.", dupName: "Ya hay una opción con ese nombre en esta elección. Usá otro.",
  recMany: "Solo una opción puede ser la recomendada. Dejá una marcada.", priceFromInvalid: "Ese precio ya no está entre las opciones. Elegí uno de la lista.", indexInvalid: "No pudimos revisar las elecciones del menú. Recargá la página.", nameNeedsNewId: "Ese nombre se quitó en esta misma publicación. Publicá primero y agregalo después.",
  revLauncher: "elección {nombre} · {n} opciones · desde L {min}", revPlain: "elección {nombre} · queda con un solo precio: L {precio}", revRecChanged: "Recomendada · {old} → {new}", revRecNew: "Recomendada · {new}" });
// an approved line may name its data as {token}s (the review rows: {nombre}, {n}, {min}, {precio}, {old}, {new}); a placeholder shows none
const s3Copy = (k, vars = null) => (typeof S3_COPY[k] === 'string' ? S3_COPY[k].replace(/\{(\w+)\}/g, (m, v) => (vars && Object.prototype.hasOwnProperty.call(vars, v) ? String(vars[v]) : m)) : `⟦s3.${k}⟧`);

// ── STRUCTURE S4 — the addendum's PROPOSED lines (MOCKUP-portal-structure-S4-addendum H3): null ⇒ «⟦s4.key⟧» on screen until the owner
// approves them (structure-s4-ui's SHIP GATE stays red until then). Frame E's own strings are the approved base mockup's, literal.
const S4_COPY = Object.freeze({
  emptyTitle: "Todavía no tiene productos", emptyBody: "Se muestra a tus clientes cuando tenga al menos uno. Agregá uno nuevo o traé uno desde otra categoría con «Mover a…».", subcatNeedsDish: "Agregá un producto primero", dropCat: "Quitar categoría", dropTitle: "¿Quitar la categoría {nombre}?", dropSub: "Categoría nueva · sin productos", dropBody: "No tiene productos y nunca se mostró a tus clientes. Podés deshacerlo hasta publicar.", nameTaken: "Ya hay una categoría con ese nombre. Elegí otro.",
  sheetSubFirst: "{categoria} · {nprod} · primera subcategoría", sheetSub: "{categoria} · {subs}", subName: "Nombre de la subcategoría", subPh: "Ej. Rellenas, Al horno", products: "Productos", firstLine: "La primera subcategoría agrupa todos los productos de {categoria}. Después creá otra y pasá a ella los que quieras.", moveLine: "Los marcados salen de su subcategoría actual y pasan a {nueva}.", needOne: "Marcá al menos un producto para crear la subcategoría.", createSub: "Crear subcategoría",
  subNameTaken: "Ya hay una subcategoría con ese nombre en {categoria}. Elegí otro.", subCaps: "Llegaste al máximo de 12 subcategorías en {categoria}.", menuNote: "{categoria} queda vacía y oculta hasta que tenga productos.", toastBack: "{producto} volvió a {seccion} · {categoria} queda vacía", unpromoteLine: "{categoria} queda vacía: se muestra cuando tenga productos.", barSub: " · 1 subcategoría", barSubs: " · {n} subcategorías", barOrder: " · orden",
  mismatchBody: "Otra edición movió las categorías mientras trabajabas, así que no guardamos nada. Recargá para traer la última versión y volvé a aplicar tu cambio.", partialTitle: "{categoria} cambió mientras editabas", partialBody: "La primera subcategoría de {categoria} tiene que incluir todos sus productos, y {categoria} tiene productos nuevos que no estaban en tu lista. Recargá para traer la última versión y volvé a crear la subcategoría.", partialLine: "La primera subcategoría de {categoria} tiene que incluir todos sus productos. Recargá para ver los nuevos y volvé a crear la subcategoría.", goSection: "Ir a la sección", notAttachTitle: "{categoria} todavía no puede llevar extras", notAttachBody: "{categoria} es nueva y aún no se muestra a tus clientes. Publicala con productos primero y después asignale el grupo de extras.", notAttachLine: "{categoria} es nueva y aún no se muestra a tus clientes. Publicala con productos primero y después asignale el grupo de extras.",
  capsCats: "Llegaste al máximo de 30 categorías. Usá una existente o quitá una vacía.", unnamedLine: "Antes de crear una categoría, poné nombre a las que no tienen.", nameAll: "Ponerles nombre",
  rowSubcat: "Subcategoría", subAddedRow: "{sub} · {nprod}", rowCatSubcat: "{categoria} · Subcategoría", rowCatNew: "Categoría · nueva", promoteRow: "se muestra con {nprod} · pasa después de {anterior}", promoteRowFirst: "se muestra con {nprod}", rowCatEmpty: "Categoría · vacía", neverShown: "nunca se mostró a tus clientes", afterRow: "pasa después de {categoria}",
  notAttachOption: "{categoria} · nueva · publicala con productos primero",
});
// «N productos» with agreement (advisor 11-19, the barSuffix ruling): the approved «N productos» strings take {nprod} = nProd(n)
const nProd = (n) => `${n} ${n === 1 ? 'producto' : 'productos'}`;
const s4Copy = (k, vars = null) => (typeof S4_COPY[k] === 'string' ? S4_COPY[k].replace(/\{(\w+)\}/g, (m, v) => (vars && Object.prototype.hasOwnProperty.call(vars, v) ? String(vars[v]) : m)) : `⟦s4.${k}⟧`);

// The acknowledgement set: the server's OWN objects, untouched.
//
// Not mapped, not filtered, not reshaped to {key,surface}. `ackMatches` compares membership in both
// directions and sentinel-collapses anything that is not an object with string key and surface, so a
// rebuilt list can only ever match by luck — and reshaping is precisely the client-side re-derivation
// this screen exists to avoid. Always an ARRAY: ackMatches refuses a non-array outright, so an empty
// set that collapsed to undefined would turn a valid modest publish into a 400.
function ackSetFrom(diff) {
  const set = diff && diff.largeChangeSet;
  return Array.isArray(set) ? set : [];
}

const idOf = (x) => `${x && x.surface}::${x && x.key}`;

// The view model. Every row's `was`/`now` come from the server's `old`/`new` by name, and `big` is
// MEMBERSHIP in largeChangeSet keyed by surface AND key — an item and an extra can legitimately share
// a key, and flagging by key alone would light the wrong row.
// S4 «Editar producto» (MOCKUP-portal-item-edit frame E; advisor rulings 2026-11-08) — an EXISTING product's text and
// section lines are their own group, «Productos»: name / description / section (+ subsection) as was → now, and the section's
// GATE lines as the drawer's consequence sentences. A group's OPTION lines fold under their product («Opciones (n)»); an
// option's line that repeats its product's own line (the move it shares) is ABSORBED by it — recorded in `absorbed`, so
// every server line is still accounted for exactly once. `ctx.optionParent(key)` → the product key of an option, from the
// caller's draft (arrangement only: nothing here re-derives the diff). Without it, an option line is a product of its own.
const TEXT_FIELDS = ['name', 'desc', 'cat', 'subcat'];
const GATES = [['pickup_only', 'Queda solo para recoger', 'Vuelve a entregarse a domicilio'],
  ['weekend_only', 'Pasa a venderse solo los fines de semana', 'Pasa a venderse todos los días'],
  ['redeem_eligible', 'Pasa a canjearse con puntos', 'Deja de canjearse con puntos']];
// S2-DESIGN §1.3 — the server's extras consequences: diff.consequences, ONE { key, kind:'extras', gained, lost } per product (on
// the launcher: the union over its options), never in `changed`. Read as the drawer's frame D sentences, before the gates.
const EXTRA_LOST = (x) => `Deja de aceptar el extra ${x}`;
const EXTRA_GAINED = (x) => `Acepta el extra ${x}`;
const isExtrasConsequence = (c) => !!c && c.kind === 'extras' && typeof c.key === 'string' && Array.isArray(c.gained) && Array.isArray(c.lost);
// STRUCTURE S1 (advisor 11-12; 5f 98ba304f): a dish's checklist and «Sin extras» are the SERVER's token-bound lines —
// { field:'deny_extras', old:[keys], new:[keys] } and { field:'extras_policy', old, new } — read here as the product's sentences
const DISH_EXTRAS = ['deny_extras', 'extras_policy'];
const dishExtrasLines = (c, extraName) => {
  // Codex S2 UI r1 P1-4: an extra is named, never shown by its raw key — an unnamed key is left out of the sentence
  const nm = (k) => { const n = typeof extraName === 'function' ? extraName(k) : null; return typeof n === 'string' && n ? n : null; };
  if (c.field === 'extras_policy') return c.new === 'none' ? ['Sin extras'] : (c.old === 'none' ? ['Vuelve a ofrecer extras'] : []);
  const was = Array.isArray(c.old) ? c.old.map(String) : [], now = Array.isArray(c.new) ? c.new.map(String) : [];
  const denied = now.filter((k) => !was.includes(k) && nm(k)), restored = was.filter((k) => !now.includes(k) && nm(k));
  return [...(denied.length ? [`Sin ${denied.map(nm).join(', ')} (solo en la app Sherpa)`] : []), ...(restored.length ? [`Vuelve a ofrecer ${restored.map(nm).join(', ')}`] : [])];
};
const isProductLine = (c) => !!c && c.surface === 'item' && (TEXT_FIELDS.includes(c.field) || GATES.some(([f]) => f === c.field) || DISH_EXTRAS.includes(c.field));
function productsOf(lines, optionParent, optionIndex, extraName) {
  const parentOf = typeof optionParent === 'function' ? optionParent : () => null;
  const byKey = new Map();
  const productOf = (key) => {
    // `count` = the change SENTENCES this product renders (Codex S1 follow-up r1 P2: every count is the rendered, folded list)
    if (!byKey.has(key)) byKey.set(key, { key, lines: [], consequences: [], options: [], absorbed: [], sources: [], count: 0 });
    return byKey.get(key);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const own = lines.filter((c) => !parentOf(c.key));
  for (const c of lines) {
    const parent = parentOf(c.key);
    const p = productOf(parent || c.key);
    p.sources.push(c);
    if (parent) {
      let o = p.options.find((x) => x.key === c.key);
      if (!o) { o = { key: c.key, was: null, now: null, extra: [] }; p.options.push(o); }
      if (c.field === 'name') { o.was = c.old; o.now = c.new; p.count += 1; continue; }   // the option's derived name: one sentence
      if (own.some((x) => x.key === parent && x.field === c.field && same(x.old, c.old) && same(x.new, c.new))) { p.absorbed.push(c); continue; }   // folded: no sentence
      o.extra.push(c.field === 'cat' || c.field === 'subcat' ? { kind: 'cat', field: c.field, was: c.old, now: c.new } : { kind: c.field, was: c.old, now: c.new });
      p.count += 1;
      continue;
    }
    if (c.field === 'name' || c.field === 'desc') { p.lines.push({ kind: c.field, was: c.old, now: c.new }); p.count += 1; }
    else if (c.field === 'cat' || c.field === 'subcat') {
      let l = p.lines.find((x) => x.kind === 'cat');
      if (!l) { l = { kind: 'cat', cat: null, subcat: null }; p.lines.push(l); p.count += 1; }   // section + subsection: ONE sentence
      l[c.field] = { was: c.old, now: c.new };
    } else if (DISH_EXTRAS.includes(c.field)) { const ss = dishExtrasLines(c, extraName); p.consequences.push(...ss); p.count += ss.length; }
    else {
      const g = GATES.find(([f]) => f === c.field);
      p.consequences.push(c.new ? g[1] : g[2]);
      p.gates = (p.gates || 0) + 1;   // counted below: a gate EXPLAINING the product's own section move is not a change of its own
    }
  }
  const order = ['name', 'desc', 'cat'];
  // the options in their product's own choice order (the caller's draft), never the diff's key order
  const idx = typeof optionIndex === 'function' ? optionIndex : () => 0;
  for (const p of byKey.values()) {
    // approved frame E: «Productos 3» for name + description + section, its gate sentences under the section line uncounted
    if (!p.lines.some((l) => l.kind === 'cat')) p.count += p.gates || 0;
    delete p.gates;
    p.options.sort((a, b) => idx(a.key) - idx(b.key));
    p.lines.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    // the gates in their order; the dish's extras sentences after them (their own order kept)
    const rank = (x) => { const i = GATES.findIndex((g) => g.includes(x)); return i < 0 ? GATES.length : i; };
    p.consequences.sort((a, b) => rank(a) - rank(b));
  }
  return [...byKey.values()];
}

// ── STRUCTURE S2 — the review's «Estructura» group (MOCKUP frame F; PLAN-portal-structure-S2-ui r3 §4) ─────────────────────────
// ONLY the server's token-bound S2 fields: `attachments` (the authored attach / detach, P-2), `extras` (added / removed / repriced),
// `structure.extra_categories` (the one group order) and `reach` («en N productos», P-3). Never a client operation log.
const S2_CHIP = { Nuevo: 'add', Quitado: 'rem', Cambio: 'chg', Orden: 'chg' };
const enN = (n) => (Number.isInteger(n) ? `Extras \u00b7 en ${n} ${n === 1 ? 'producto' : 'productos'}` : 'Extras');
// the groups that MOVED: those outside the longest run kept in their old relative order (one move ⇒ one row, not every shifted group)
function movedGroups(was, now) {
  const kept = now.filter((g) => was.includes(g));
  const idx = kept.map((g) => was.indexOf(g));
  const best = []; const prev = new Array(idx.length).fill(-1); const tails = [];
  for (let i = 0; i < idx.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (idx[tails[mid]] < idx[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) best.push(kept[i]);
  const stay = new Set(best);
  return kept.filter((g) => !stay.has(g));
}
function structureRowsOf(d, names = {}) {
  const nameOf = typeof names.nameOf === 'function' ? names.nameOf : (k) => String(k);
  const catName = typeof names.categoryName === 'function' ? names.categoryName : (id) => String(id);
  const sectionOf = typeof names.sectionOf === 'function' ? names.sectionOf : () => ({ cat: null, subcat: null });
  const reach = d.reach && typeof d.reach === 'object' ? d.reach : {};
  const rows = [];
  const row = (name, sub, kind, parts, src) => rows.push({ name, sub, kind, chip: S2_CHIP[kind], parts, src });
  for (const a of Array.isArray(d.attachments) ? d.attachments : []) {
    if (!a || typeof a.group !== 'string') continue;
    const kind = a.change === 'attached' ? 'Nuevo' : 'Quitado';
    if (a.scope === 'category') row(catName(a.target), 'Categoría', kind, [`grupo ${a.group}`], a);
    else { const sec = sectionOf(a.target) || {}; row(nameOf(a.target), [sec.cat == null ? null : catName(sec.cat), sec.subcat || null].filter(Boolean).join(' \u00b7 ') || '\u2014', kind, [`grupo ${a.group}`], a); }
  }
  const oldPrice = new Map((Array.isArray(d.changed) ? d.changed : []).filter((c) => c && c.surface === 'extra' && c.field === 'price').map((c) => [c.key, c.old]));
  for (const x of Array.isArray(d.extras) ? d.extras : []) {
    if (!x || typeof x.group !== 'string') continue;
    if (x.change === 'added') row(x.group, enN(reach[x.group]), 'Nuevo', [`${x.name} \u00b7 L ${x.price}`], x);
    else if (x.change === 'removed') row(x.group, enN(reach[x.group]), 'Quitado', [x.name], x);
    else if (x.change === 'repriced') row(x.group, enN(reach[x.group]), 'Cambio', [x.name, '\u00b7', `L ${oldPrice.has(x.key) ? oldPrice.get(x.key) : '\u2014'}`, '\u2192', `L ${x.price}`], x);
  }
  const ec = d.structure && d.structure.extra_categories;
  if (ec && Array.isArray(ec.old) && Array.isArray(ec.new)) {
    for (const g of movedGroups(ec.old, ec.new)) row(g, 'Extras', 'Orden', [`pasa al ${ec.new.indexOf(g) + 1}.\u00ba lugar`], { group: g });
  }
  return rows;
}

// STRUCTURE S3 (addendum B3) — the server's `choices` rows (choice-activation choiceRows, token-bound) in «Estructura»: a dish that
// gained its choice (ONE «Nuevo» row) or lost it (ONE «Quitado» row); otherwise one row per facet under «{dish} · {choice}» — the label
// (was → now), each option added («Nuevo», app-only) or removed («Quitado»), the «Recomendada» change. Names from the draft (the server
// names rows by key); the addendum's proposed lines are ⟦s3.key⟧ until approved. «Solo en la app Sherpa» is the diff's OWN row.app_only
// (5f 437ce1ef4: a gained / lost choice and a new option, = !choicesGeneric); a label, a removal or a «Recomendada» row never carries it.
function choiceRowsOf(d, names = {}) {
  const cs = Array.isArray(d.choices) ? d.choices : [];
  const nameOf = typeof names.nameOf === 'function' ? names.nameOf : (k) => String(k);
  const catName = typeof names.categoryName === 'function' ? names.categoryName : (id) => String(id);
  const sectionOf = typeof names.sectionOf === 'function' ? names.sectionOf : () => ({ cat: null, subcat: null });
  const choiceOf = typeof names.choiceOf === 'function' ? names.choiceOf : (k) => String(k);
  const labelOf = typeof names.choiceLabel === 'function' ? names.choiceLabel : () => null;
  const priceOf = typeof names.priceOf === 'function' ? names.priceOf : () => null;   // Codex #183-6: the canonical saved price
  const addedPrice = new Map((Array.isArray(d.added) ? d.added : []).filter((x) => x && x.surface === 'item').map((x) => [x.key, x.price]));
  const newPrice = new Map((Array.isArray(d.changed) ? d.changed : []).filter((c) => c && c.surface === 'item' && c.field === 'price').map((c) => [c.key, c.new]));
  const rows = [];
  const row = (name, sub, kind, parts, src, appOnly) => rows.push({ name, sub, kind, chip: S2_CHIP[kind], parts, src, ...(appOnly ? { appOnly: true } : {}) });
  for (const c of cs) {
    if (!c || typeof c.launcher !== 'string') continue;
    const dish = typeof c.name === 'string' && c.name.trim() ? c.name : nameOf(c.launcher);
    const sec = sectionOf(c.launcher) || {};
    const place = [sec.cat == null ? null : catName(sec.cat), sec.subcat || null].filter(Boolean).join(' \u00b7 ') || '\u2014';
    const lb = c.label && typeof c.label === 'object' ? c.label : null;
    const added = c.members && Array.isArray(c.members.added) ? c.members.added : [];
    const removed = c.members && Array.isArray(c.members.removed) ? c.members.removed : [];
    if (c.became === 'launcher') {
      const ps = added.map((k) => addedPrice.get(k)).filter((x) => Number.isInteger(x));
      row(dish, place, 'Nuevo', [s3Copy('revLauncher', { nombre: lb ? lb.new : '', n: added.length, min: ps.length ? Math.min(...ps) : '' })], c, c.app_only === true);
      continue;
    }
    // the price that stays: the server's price change when there is one, else the dish's canonical saved price (no delta ⇒ no row)
    if (c.became === 'plain') { row(dish, place, 'Quitado', [s3Copy('revPlain', { nombre: lb ? lb.old : '', precio: newPrice.has(c.launcher) ? newPrice.get(c.launcher) : priceOf(c.launcher) })], c, c.app_only === true); continue; }
    const head = `${dish} \u00b7 ${lb && lb.old != null ? lb.old : labelOf(c.launcher) || ''}`;
    const REQ = 'Elección requerida';
    if (lb) row(head, REQ, 'Cambio', [lb.old, '\u2192', lb.new], c);
    for (const k of added) row(head, REQ, 'Nuevo', [`${choiceOf(k)} \u00b7 L ${addedPrice.get(k)}`], c, c.app_only === true);
    for (const k of removed) row(head, REQ, 'Quitado', [choiceOf(k)], c);
    if (c.recommended && typeof c.recommended === 'object') {
      const was = (c.recommended.old || []).map(choiceOf).join(', '); const now = (c.recommended.new || []).map(choiceOf).join(', ');
      if (was) row(head, REQ, 'Cambio', [s3Copy('revRecChanged', { old: was, new: now })], c);
      else row(head, REQ, 'Nuevo', [s3Copy('revRecNew', { new: now })], c);
    }
  }
  return rows;
}
// STRUCTURE S4-E — the server's S4 lines (review-diff.js sections, token-bound) in «Estructura», in the canonical order: subsections
// added / renamed, the section order, the subsection order, the dish order, the staged lines (add · drop · rename · move · promote), the
// sections declared in this draft, then each dish moved into one of those. A subsection rename is ONE row (its members' lines are it).
// «Solo en la app Sherpa» follows the diff's own app_only. Approved words are literal (F: «Categoría», «pasa al N.º lugar», the staged
// row, was → now); the addendum's proposed lines are ⟦s4.key⟧ until approved.
function sectionRowsOf(d, names = {}) {
  const S = d.sections && typeof d.sections === 'object' ? d.sections : null;
  if (!S) return [];
  const catName = typeof names.categoryName === 'function' ? names.categoryName : (id) => String(id);
  const nameOf = typeof names.nameOf === 'function' ? names.nameOf : (k) => String(k);
  const sectionOf = typeof names.sectionOf === 'function' ? names.sectionOf : () => ({ cat: null, subcat: null });
  const dishesIn = typeof names.dishesIn === 'function' ? names.dishesIn : () => 0;
  const appOnly = !!((S.categories && S.categories.app_only === true) || (Array.isArray(S.added) && S.added.some((a) => a && a.app_only === true)));
  const rows = [];
  const row = (name, sub, kind, parts, src, app) => rows.push({ name, sub, kind, chip: S2_CHIP[kind], parts, src, ...(app && appOnly ? { appOnly: true } : {}) });
  const place = (n) => `pasa al ${n}.\u00ba lugar`;
  for (const c of Array.isArray(S.subcats) ? S.subcats : []) {
    if (!c) continue;
    if (c.change === 'added') row(catName(c.cat), s4Copy('rowSubcat'), 'Nuevo', [s4Copy('subAddedRow', { sub: c.new, nprod: nProd(dishesIn(c.cat, c.new)) })], c, true);
    else if (c.change === 'renamed') row(catName(c.cat), s4Copy('rowSubcat'), 'Cambio', [c.old, '\u2192', c.new], c, true);
  }
  const ord = S.categories && S.categories.order;
  if (ord && Array.isArray(ord.old) && Array.isArray(ord.new)) {
    const common = ord.new.filter((x) => ord.old.includes(x));
    for (const id of movedGroups(ord.old.filter((x) => common.includes(x)), common)) row(catName(id), 'Categoría', 'Orden', [place(ord.new.indexOf(id) + 1)], { id }, true);
  }
  for (const o of Array.isArray(S.subcat_order) ? S.subcat_order : []) {
    if (!o || !Array.isArray(o.old) || !Array.isArray(o.new)) continue;
    // a subsection renamed in the same save is the SAME subsection: compare the old order under its new names (5f 290fa5baa)
    const renamed = new Map((Array.isArray(S.subcats) ? S.subcats : []).filter((c) => c && c.change === 'renamed' && c.cat === o.cat).map((c) => [c.old, c.new]));
    const was = o.old.map((x) => (renamed.has(x) ? renamed.get(x) : x));
    for (const sub of movedGroups(was.filter((x) => o.new.includes(x)), o.new.filter((x) => was.includes(x)))) row(sub, s4Copy('rowCatSubcat', { categoria: catName(o.cat) }), 'Orden', [place(o.new.indexOf(sub) + 1)], o, true);
  }
  for (const it of Array.isArray(S.items) ? S.items : []) {
    if (!it || typeof it.key !== 'string' || !Number.isInteger(it.new_index)) continue;
    const sec = sectionOf(it.key) || {};
    row(nameOf(it.key), [sec.cat == null ? null : catName(sec.cat), sec.subcat || null].filter(Boolean).join(' \u00b7 ') || '\u2014', 'Orden', [place(it.new_index + 1)], it, false);
  }
  const staged = Array.isArray(S.staged) ? S.staged : [];
  const kinds = ['add', 'drop', 'rename', 'move', 'promote'];
  const promotedIds = [];
  for (const k of kinds) {
    for (const x of staged.filter((y) => y && y.change === k)) {
      if (k === 'add') row(x.name || catName(x.id), 'Categoría', 'Nuevo', ['categoría vacía \u00b7 se muestra cuando tenga productos'], x, true);
      else if (k === 'drop') row(catName(x.id), s4Copy('rowCatEmpty'), 'Quitado', [s4Copy('neverShown')], x, false);
      else if (k === 'rename') row(x.old, s4Copy('rowCatEmpty'), 'Cambio', [x.old, '\u2192', x.new], x, false);
      else if (k === 'move') { if (x.old_after !== x.new_after) row(catName(x.id), s4Copy('rowCatEmpty'), 'Orden', [s4Copy('afterRow', { categoria: catName(x.new_after) })], x, false); }
      else if (k === 'promote') promotedIds.push(x.id);
    }
  }
  // a section new to the menu: promoted from staged, or declared in this draft — «se muestra con N productos · pasa después de {anterior}»
  const order = ord && Array.isArray(ord.new) ? ord.new : [];
  const declared = [...promotedIds, ...(Array.isArray(S.added) ? S.added.map((a) => a && a.id).filter((id) => id != null && !promotedIds.includes(id)) : [])];
  for (const id of declared) {
    const i = order.indexOf(id);
    // first place: no «pasa después de» clause (advisor 11-19)
    row(catName(id), s4Copy('rowCatNew'), 'Nuevo', [i > 0 ? s4Copy('promoteRow', { nprod: nProd(dishesIn(id)), anterior: catName(order[i - 1]) }) : s4Copy('promoteRowFirst', { nprod: nProd(dishesIn(id)) })], { id }, true);
  }
  // each dish moved INTO one of those sections (its «Categoría» line is this row)
  for (const c of Array.isArray(d.changed) ? d.changed : []) {
    if (!c || c.surface !== 'item' || c.field !== 'cat' || !declared.includes(c.new)) continue;
    row(nameOf(c.key), catName(c.old), 'Cambio', [catName(c.old), '\u2192', catName(c.new)], c, true);
  }
  return rows;
}
// the lines an S4 row already says: a subsection's members (added / renamed), a dish moved into a new section
// Codex #183-2: a dish's subsection line folds into an S4 row ONLY when it IS that row's own transition — same category, and either the
// subsection was added there (the dish moved into it) or renamed there (the dish's old → new is that rename). Never by the destination
// name alone (another category's same-named subsection is an unrelated move). An unknown category folds nothing (never hide a line).
function sectionFacts(d, ctx = {}) {
  const S = d.sections && typeof d.sections === 'object' ? d.sections : null;
  if (!S) return () => false;
  const K = (cat, sub) => `${cat}\u0000${sub}`;
  const list = Array.isArray(S.subcats) ? S.subcats : [];
  const added = new Set(list.filter((c) => c && c.change === 'added').map((c) => K(c.cat, c.new)));
  const renamed = new Map(list.filter((c) => c && c.change === 'renamed').map((c) => [K(c.cat, c.old), c.new]));
  const sectionOf = ctx && ctx.structure && typeof ctx.structure.sectionOf === 'function' ? ctx.structure.sectionOf : null;
  const fresh = new Set([...(Array.isArray(S.staged) ? S.staged : []).filter((x) => x && x.change === 'promote').map((x) => x.id), ...(Array.isArray(S.added) ? S.added.map((a) => a && a.id) : [])]);
  const subFolds = (c) => {
    const cat = sectionOf ? (sectionOf(c.key) || {}).cat : null;
    if (cat == null) return false;
    return added.has(K(cat, c.new)) || renamed.get(K(cat, c.old)) === c.new;
  };
  return (c) => !!c && c.surface === 'item' && ((c.field === 'subcat' && subFolds(c)) || (c.field === 'cat' && fresh.has(c.new)));
}

// the facts a choice row already says — never ALSO a generic line (every server fact shown once): the option rows added / removed,
// the mark's tag line, and a dish that lost its choice's reprice (that row and the seal)
function choiceFacts(d) {
  const cs = Array.isArray(d.choices) ? d.choices : [];
  const added = new Set(), removed = new Set(), tags = new Set(), plain = new Set();
  for (const c of cs) {
    if (!c || typeof c.launcher !== 'string') continue;
    for (const k of (c.members && c.members.added) || []) added.add(k);
    for (const k of (c.members && c.members.removed) || []) removed.add(k);
    for (const k of [...((c.recommended && c.recommended.old) || []), ...((c.recommended && c.recommended.new) || [])]) tags.add(k);
    if (c.became === 'plain') plain.add(c.launcher);
  }
  const said = (x) => !!x && x.surface === 'item' && ((x.field === 'tags' && tags.has(x.key)) || (x.field === 'price' && plain.has(x.key)));
  return { added, removed, said };
}

// Codex S2 UI r1 P1-4 — a checklist key a dish stops denying BECAUSE of a structural change is that change's cleanup, already its
// «Estructura» row: the extra is removed (diff.extras), or its group leaves the dish (an authored detach of the dish or its section, the
// group gone from extra_categories, or the server's consequence: the dish no longer takes the group). It is never ALSO «Vuelve a ofrecer
// {extra}» (it says the opposite) nor a product count; a line left with nothing to say is dropped. Any other restore is real and stays.
function foldChecklistCleanup(lines, d, ctx) {
  const xs = Array.isArray(d.extras) ? d.extras : [];
  const removedKeys = new Set(xs.filter((x) => x && x.change === 'removed').map((x) => String(x.key)));
  const groupOf = (k) => {
    const g = ctx && typeof ctx.extraGroup === 'function' ? ctx.extraGroup(k) : null;
    if (g != null) return String(g);
    const x = xs.find((e) => e && String(e.key) === k); return x && x.group != null ? String(x.group) : null;
  };
  const parentOf = ctx && typeof ctx.optionParent === 'function' ? ctx.optionParent : () => null;
  const sectionOf = ctx && ctx.structure && typeof ctx.structure.sectionOf === 'function' ? ctx.structure.sectionOf : () => ({ cat: null });
  const lost = new Map((Array.isArray(d.consequences) ? d.consequences : []).filter(isExtrasConsequence).map((c) => [c.key, new Set(c.lost.map(String))]));
  const detached = (Array.isArray(d.attachments) ? d.attachments : []).filter((a) => a && a.change === 'detached');
  const ec = d.structure && d.structure.extra_categories;
  const gone = new Set(ec && Array.isArray(ec.old) && Array.isArray(ec.new) ? ec.old.map(String).filter((g) => !ec.new.map(String).includes(g)) : []);
  const leaves = (dish, g) => {
    if (g == null) return false;
    const head = parentOf(dish) || dish; const cat = (sectionOf(head) || {}).cat;
    return gone.has(g) || (lost.get(head) || new Set()).has(g)
      || detached.some((a) => String(a.group) === g && ((a.scope === 'item' && (a.target === head || a.target === dish)) || (a.scope === 'category' && cat != null && String(a.target) === String(cat))));
  };
  const out = [];
  for (const c of lines) {
    if (!(c && c.field === 'deny_extras' && Array.isArray(c.old))) { out.push(c); continue; }
    const now = Array.isArray(c.new) ? c.new.map(String) : [];
    const old = c.old.map(String).filter((k) => now.includes(k) || !(removedKeys.has(k) || leaves(c.key, groupOf(k))));
    if (old.length === now.length && old.every((k) => now.includes(k))) continue;   // only cleanup: the structural row says it
    out.push(old.length === c.old.length ? c : { ...c, old });
  }
  return out;
}

function reviewModel(diff, ctx = {}) {
  const d0 = diff || {};
  // STRUCTURE S3 (B3): a fact a choice row says is dropped from the generic lists before anything else reads them
  const cf = choiceFacts(d0);
  const sf = sectionFacts(d0, ctx);   // S4-E: the same rule for the S4 rows (category-scoped, Codex #183-2)
  const d = (Array.isArray(d0.choices) && d0.choices.length) || d0.sections ? { ...d0,
    changed: (Array.isArray(d0.changed) ? d0.changed : []).filter((c) => !cf.said(c) && !sf(c)),
    added: (Array.isArray(d0.added) ? d0.added : []).filter((x) => !(x && x.surface === 'item' && cf.added.has(x.key))),
    removed: (Array.isArray(d0.removed) ? d0.removed : []).filter((x) => !(x && x.surface === 'item' && cf.removed.has(x.key))) } : d0;
  // DISH PHOTOS B (§2.1) — the server's photo lines ({field:'photo', old, new} three-state) are their own group, «Fotos»;
  // arranged, never derived: every line the server sent is shown exactly once.
  const all = Array.isArray(d.changed) ? d.changed : [];
  const productLines = foldChecklistCleanup(all.filter((c) => !isPhotoLine(c) && isProductLine(c)), d, ctx);
  const products = productsOf(productLines, ctx && ctx.optionParent, ctx && ctx.optionIndex, ctx && ctx.extraName);
  // STRUCTURE S2: an authored attach / detach is its «Estructura» row — the same group's consequence on that dish is not shown twice
  const authored = new Set((Array.isArray(d.attachments) ? d.attachments : []).filter((a) => a && a.scope === 'item').map((a) => `${a.target}\u0000${a.group}`));
  for (const c0 of (Array.isArray(d.consequences) ? d.consequences : []).filter(isExtrasConsequence)) {
    const c = { ...c0, gained: c0.gained.filter((g) => !authored.has(`${c0.key}\u0000${g}`)), lost: c0.lost.filter((g) => !authored.has(`${c0.key}\u0000${g}`)) };
    if (!c.gained.length && !c.lost.length) continue;
    let p = products.find((x) => x.key === c.key);
    if (!p) { p = { key: c.key, lines: [], consequences: [], options: [], absorbed: [], sources: [], count: 0 }; products.push(p); }
    p.consequences = [...c.lost.map((x) => EXTRA_LOST(String(x))), ...c.gained.map((x) => EXTRA_GAINED(String(x))), ...p.consequences];
  }
  const structure = [...choiceRowsOf(d0, ctx && ctx.structure), ...sectionRowsOf(d0, ctx && ctx.structure), ...structureRowsOf(d, ctx && ctx.structure)];
  // a repriced extra is its «Estructura» row; its price line is not ALSO a «Precios» row (every server fact shown once)
  const repricedKeys = new Set((Array.isArray(d.extras) ? d.extras : []).filter((x) => x && x.change === 'repriced').map((x) => x.key));
  const changed = all.filter((c) => !isPhotoLine(c) && !isProductLine(c) && !(c.surface === 'extra' && c.field === 'price' && repricedKeys.has(c.key)));
  const photos = all.filter(isPhotoLine);
  // an extra added / removed on the Extras page is its «Estructura» row («Nuevo» / «Quitado»): not ALSO a «Se agregan» / «Se eliminan»
  // line (SBS 11-12: the generic line showed the raw key, twice) — every server fact shown once
  const s2Extras = new Set((Array.isArray(d.extras) ? d.extras : []).filter((x) => x && (x.change === 'added' || x.change === 'removed')).map((x) => `${x.change}\u0000${x.key}`));
  const notS2 = (change) => (e) => !(e && e.surface === 'extra' && s2Extras.has(`${change}\u0000${e.key}`));
  const added = (Array.isArray(d.added) ? d.added : []).filter(notS2('added'));
  // «Quitar del menú» (MOCKUP-portal-remove-product frame R4): with the server's switch on (ctx.productRemoval, the caller's served fact)
  // a DISH's removal is its «Productos» row («Quitado»), not ALSO a «Se eliminan» line — every server fact shown once (the notS2
  // pattern). Switch off: today's «Se eliminan» exactly.
  const removed0 = (Array.isArray(d.removed) ? d.removed : []).filter(notS2('removed'));
  const dishOut = (x) => ctx && ctx.productRemoval === true && !!x && x.surface === 'item';
  const removed = removed0.filter((x) => !dishOut(x));
  for (const x of removed0.filter(dishOut)) {
    const p = products.find((y) => y.key === x.key);
    if (p) { p.removal = true; p.count += 1; } else products.push({ key: x.key, removal: true, lines: [], consequences: [], options: [], absorbed: [], sources: [], count: 1 });
  }
  const renamed = Array.isArray(d.renamed) ? d.renamed : [];
  const flagged = new Set(ackSetFrom(d).map(idOf));
  // PLAN-public-menu-display T1 — a SECTION'S NAME is the server's `{surface:'category', field:'name'}` line. It is shown
  // in its own group («Secciones»), never among the prices; any other category line (none exists) stays a row of its own.
  const isSectionName = (c) => !!c && c.surface === 'category' && c.field === 'name';
  const sections = changed.filter(isSectionName).map((c) => ({ surface: c.surface, key: c.key, was: c.old, now: c.new }));

  const rows = changed.filter((c) => !isSectionName(c)).map((c) => ({
    surface: c.surface,
    key: c.key,
    field: c.field,
    isPrice: c.field === 'price',
    was: c.old,
    now: c.new,
    big: flagged.has(idOf(c)),
    // direction is a statement about the two numbers, made once, so the screen never re-derives it
    direction: (typeof c.old === 'number' && typeof c.new === 'number')
      ? (c.new > c.old ? 'up' : (c.new < c.old ? 'down' : 'same'))
      : null,
    // The percentage is ARITHMETIC ON TWO SERVER NUMBERS, not a second opinion about the diff. It
    // presents old and new; it never decides whether a change is big. That decision stays with
    // `big`, which is membership in the server's own largeChangeSet.
    pct: (typeof c.old === 'number' && typeof c.new === 'number' && c.old > 0)
      ? Math.round(((c.new - c.old) / c.old) * 100)
      : null,
  }));

  return {
    rows,
    sections,
    products,
    added,
    removed,
    renamed,
    photos,
    structure,
    // everything that will publish, so the header cannot understate it
    // every product sentence once, as rendered (an option's identical line folded, a checklist swap = two sentences); a move's
    // «Acepta / Deja de aceptar» explanations (diff.consequences) describe a counted change, they are not changes of their own
    total: structure.length + rows.length + sections.length + products.reduce((n, p) => n + p.count, 0) + added.length + removed.length + renamed.length + photos.length,
  };
}

// the context the model needs, from the draft SOURCE (app.js passes its own lookups; S3 passes the server's) — moved from app.js
function reviewCtxFromSource(source, opts = {}) {
  // the caller's own lookups (app.js: its draft helpers; S3: the server's) — a missing one names nothing (the raw key / id)
  const removedRowFor = typeof opts.removedRowFor === 'function' ? opts.removedRowFor : () => null;   // a row pending removal
  const categoryName = typeof opts.categoryName === 'function' ? opts.categoryName : (id) => String(id);   // a section's name
  const stagedName = typeof opts.stagedName === 'function' ? opts.stagedName : () => null;   // a section only the staged list knows
  const choiceGroup = typeof opts.choiceGroup === 'function' ? opts.choiceGroup : () => null;   // a dish's choice group now
  const items = ((source || {}).items || []).filter((r) => r && r.display && typeof r.key === 'string');
  const keyOfId = new Map(items.map((r) => [String(r.display.id), r.key]));
  const parent = new Map();
  const index = new Map();
  for (const r of items) {
    if (r.display.variantOf == null) continue;
    const pk = keyOfId.get(String(r.display.variantOf));
    if (pk) { parent.set(r.key, pk); index.set(r.key, index.size); }
  }
  // STRUCTURE S1 (advisor 11-12): the server's checklist lines name extras by key — their display names, from the draft
  const extraNames = new Map((source.extras || []).filter((x) => x && typeof x.key === 'string' && x.display).map((x) => [x.key, x.display.name]));
  // STRUCTURE S2: the «Estructura» rows' names (the server diff names dishes by key and sections by id) — the draft's, ungated: the
  // server sends S2 fields only for an S2 op
  const structure = { nameOf: (k) => { const r = items.find((x) => x.key === k) || removedRowFor(k); return r && typeof r.display.name === 'string' && r.display.name.trim() ? `${r.display.name}` : String(k); },
    categoryName, sectionOf: (k) => { const r = items.find((x) => x.key === k) || removedRowFor(k); return r ? { cat: r.display.cat == null ? null : `${r.display.cat}`, subcat: typeof r.display.subcat === 'string' ? `${r.display.subcat}` : null } : { cat: null, subcat: null }; } };
  // STRUCTURE S4-E: how many dishes a section (or one of its subsections) holds now, and a section's name that only the staged list knows
  structure.dishesIn = (id, sub = null) => items.filter((r) => r.display.variantOf == null && String(r.display.cat) === String(id) && (sub == null || r.display.subcat === sub)).length;
  structure.categoryName = (id) => stagedName(id) || categoryName(id);
  // STRUCTURE S3 (B3): an option's choice text (a removed one from the loaded rows) and a dish's choice label now, from the draft
  structure.choiceOf = (k) => { const r = items.find((x) => x.key === k) || removedRowFor(k); return r && typeof r.display.choice === 'string' ? `${r.display.choice}` : String(k); };
  structure.priceOf = (k) => { const r = items.find((x) => x.key === k); return r && Number.isInteger(r.price) ? r.price : null; };   // Codex #183-6: the saved price (the S3 «queda con un solo precio» row)
  structure.choiceLabel = (k) => { const g = choiceGroup(k); return g && typeof g.label === 'string' ? `${g.label}` : null; };
  // Codex S2 UI r1 P1-4: each extra's group, so a checklist key its group's detach drops folds into that «Estructura» row
  const extraGroups = new Map((source.extras || []).filter((x) => x && typeof x.key === 'string' && x.display && x.display.cat != null).map((x) => [x.key, `${x.display.cat}`]));
  return { optionParent: (k) => parent.get(k) || null, optionIndex: (k) => (index.has(k) ? index.get(k) : 0), extraName: (k) => extraNames.get(k) || null,
    extraGroup: (k) => extraGroups.get(k) || null, structure, productRemoval: opts.productRemoval === true };   // «Quitar del menú» (R4): the served switch
}

// INTERNAL, NEVER SHOWN (OWNER 11-23, Codex #296): the model's total — the sum of the review groups' own numbers (one per price / structure
// fact / changed product FIELD / added / removed / renamed line / photo; never a move's consequence sentences). No screen shows a total.
const reviewCount = (diff, ctx) => reviewModel(diff, ctx).total;
// WHAT S3 STORES (OWNER 11-23: Inicio shows no number — «Tenés cambios sin publicar» / «Todo en orden»): has_pending is true exactly when
// «Revisar y publicar» does NOT draw its empty state (renderReview: total === 0 ⇒ «No hay cambios sin publicar.»)
const hasPending = (diff, ctx) => reviewModel(diff, ctx).total > 0;

const api = { reviewModel, reviewCount, hasPending, reviewCtxFromSource, ackSetFrom, movedGroups, isPhotoLine, S3_COPY, s3Copy, S4_COPY, s4Copy, nProd };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ReviewLines = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
