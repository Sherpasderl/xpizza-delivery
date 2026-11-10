// Portal 2b-2b Task 5 — THE REVIEW SCREEN.
//
// 🔴🔴 MONEY. The last thing a merchant reads before their prices become what customers pay. Three
// ways it can lie, all of them silent:
//
//   WAS/NOW SWAPPED — it says 900→349 when the change is 349→900, and the merchant approves a rise
//   they read as a cut.
//   WRONG ROW — right numbers, wrong dish. Every value on screen is correct and the sentence is false.
//   BIG FLAG DERIVED HERE — the highlight and the acknowledgement set disagree, so the screen
//   emphasises one set of changes while the server demands confirmation of another.
//
// The defence against all three is the same: THIS FILE COMPUTES NOTHING ABOUT THE DIFF. It reads the
// server's `changed`, `added`, `removed` and `largeChangeSet` and arranges them. There is no local
// >50% rule, no re-derivation from the draft, no second opinion — the screen shows what the server
// decided, because that is what the token is bound to and what publishEdited will re-check.

import { isPhotoLine, lineKind, COPY as PHOTO } from './photo-logic.js';

// The acknowledgement set: the server's OWN objects, untouched.
//
// Not mapped, not filtered, not reshaped to {key,surface}. `ackMatches` compares membership in both
// directions and sentinel-collapses anything that is not an object with string key and surface, so a
// rebuilt list can only ever match by luck — and reshaping is precisely the client-side re-derivation
// this screen exists to avoid. Always an ARRAY: ackMatches refuses a non-array outright, so an empty
// set that collapsed to undefined would turn a valid modest publish into a 400.
export function ackSetFrom(diff) {
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
const isProductLine = (c) => !!c && c.surface === 'item' && (TEXT_FIELDS.includes(c.field) || GATES.some(([f]) => f === c.field));
function productsOf(lines, optionParent, optionIndex) {
  const parentOf = typeof optionParent === 'function' ? optionParent : () => null;
  const byKey = new Map();
  const productOf = (key) => {
    if (!byKey.has(key)) byKey.set(key, { key, lines: [], consequences: [], options: [], absorbed: [], sources: [] });
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
      if (c.field === 'name') { o.was = c.old; o.now = c.new; continue; }
      if (own.some((x) => x.key === parent && x.field === c.field && same(x.old, c.old) && same(x.new, c.new))) { p.absorbed.push(c); continue; }
      o.extra.push(c.field === 'cat' || c.field === 'subcat' ? { kind: 'cat', field: c.field, was: c.old, now: c.new } : { kind: c.field, was: c.old, now: c.new });
      continue;
    }
    if (c.field === 'name' || c.field === 'desc') p.lines.push({ kind: c.field, was: c.old, now: c.new });
    else if (c.field === 'cat' || c.field === 'subcat') {
      let l = p.lines.find((x) => x.kind === 'cat');
      if (!l) { l = { kind: 'cat', cat: null, subcat: null }; p.lines.push(l); }
      l[c.field] = { was: c.old, now: c.new };
    } else {
      const g = GATES.find(([f]) => f === c.field);
      p.consequences.push(c.new ? g[1] : g[2]);
    }
  }
  const order = ['name', 'desc', 'cat'];
  // the options in their product's own choice order (the caller's draft), never the diff's key order
  const idx = typeof optionIndex === 'function' ? optionIndex : () => 0;
  for (const p of byKey.values()) {
    p.options.sort((a, b) => idx(a.key) - idx(b.key));
    p.lines.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    p.consequences.sort((a, b) => GATES.findIndex((g) => g.includes(a)) - GATES.findIndex((g) => g.includes(b)));
  }
  return [...byKey.values()];
}

export function reviewModel(diff, ctx = {}) {
  const d = diff || {};
  // DISH PHOTOS B (§2.1) — the server's photo lines ({field:'photo', old, new} three-state) are their own group, «Fotos»;
  // arranged, never derived: every line the server sent is shown exactly once.
  const all = Array.isArray(d.changed) ? d.changed : [];
  const productLines = all.filter((c) => !isPhotoLine(c) && isProductLine(c));
  const products = productsOf(productLines, ctx && ctx.optionParent, ctx && ctx.optionIndex);
  for (const c of (Array.isArray(d.consequences) ? d.consequences : []).filter(isExtrasConsequence)) {
    let p = products.find((x) => x.key === c.key);
    if (!p) { p = { key: c.key, lines: [], consequences: [], options: [], absorbed: [], sources: [] }; products.push(p); }
    p.consequences = [...c.lost.map((x) => EXTRA_LOST(String(x))), ...c.gained.map((x) => EXTRA_GAINED(String(x))), ...p.consequences];
  }
  const changed = all.filter((c) => !isPhotoLine(c) && !isProductLine(c));
  const photos = all.filter(isPhotoLine);
  const added = Array.isArray(d.added) ? d.added : [];
  const removed = Array.isArray(d.removed) ? d.removed : [];
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
    // everything that will publish, so the header cannot understate it
    total: rows.length + sections.length + productLines.length + added.length + removed.length + renamed.length + photos.length,
  };
}

// ── DOM ────────────────────────────────────────────────────────────────────────────────────────
// createElement + textContent throughout. A dish name arrives from a merchant-editable document and
// reaches this screen unchanged; it is data, and this is the one screen a menu editor must not
// execute its own input on. There is no innerHTML in this file — asserted by the portal-wide sink
// guard, and again here by the review's own tests.
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const shown = (v) => (Number.isInteger(v) && v > 0 ? `L ${v}` : (v === null || v === undefined ? '—' : String(v)));
// A section's name as the review shows it: no name is «Sin nombre», never a dash or the raw id.
const sectionName = (v) => (typeof v === 'string' && v.trim() ? v : 'Sin nombre');
// The section a line is about: its name before the change, or its id while it has none (as the rail shows it).
const sectionLabel = (r) => (typeof r.was === 'string' && r.was.trim() ? r.was : String(r.key));

export function renderReview(root, model, opts = {}) {
  root.replaceChildren();

  if (model.total === 0) {
    // An empty panel reads as a broken one. Say plainly that there is nothing to publish.
    root.append(el('div', 'empty', 'No hay cambios sin publicar.'));
    return root;
  }

  const groupHead = (label, count) => {
    const l = el('div', 'mglabel');
    l.append(el('span', null, label));
    l.append(el('span', 'mgn', String(count)));
    return l;
  };

  const sections = Array.isArray(model.sections) ? model.sections : [];
  if (sections.length) {
    const g = el('div', 'mgroup');
    g.append(groupHead('Secciones', sections.length));
    for (const r of sections) {
      const row = el('div', 'prow');
      row.dataset.k = `${r.surface}::${r.key}`;
      const main = el('div', 'pmain');
      main.append(el('div', 'pname', sectionLabel(r)));     // textContent: a section name is data
      main.append(el('div', 'psub', 'Nombre de la sección'));
      row.append(main);
      const val = el('div', 'pval');                        // WAS then NOW, as separate nodes (the price rows' rule)
      val.append(el('span', 'was', sectionName(r.was)));
      val.append(el('span', 'arr', '\u2192'));
      val.append(el('span', 'now', sectionName(r.now)));
      row.append(val);
      g.append(row);
    }
    root.append(g);
  }

  // S4 «Productos» (frame E): one row per changed field, «Nombre» / «Descripción» / «Categoría», was → now as separate nodes;
  // the consequence sentences under the section row; a group's options folded beneath. Text rows wrap under the product name.
  const products = Array.isArray(model.products) ? model.products : [];
  if (products.length) {
    const po = opts.products || {};
    const nameOf = typeof po.nameOf === 'function' ? po.nameOf : (k) => String(k);
    const catName = typeof po.categoryName === 'function' ? po.categoryName : (id) => String(id);
    const sectionOf = typeof po.sectionOf === 'function' ? po.sectionOf : () => ({ cat: null, subcat: null });
    const textOrDash = (v) => (typeof v === 'string' && v.trim() ? v : '\u2014');
    const place = (cat, sub) => [cat == null ? null : catName(cat), typeof sub === 'string' && sub ? sub : null].filter(Boolean).join(' \u00b7 ') || '\u2014';
    const g = el('div', 'mgroup');
    g.append(groupHead('Productos', products.reduce((n, p) => n + p.lines.length, 0)));
    const LABEL = { name: 'Nombre', desc: 'Descripción', cat: 'Categoría' };
    for (const p of products) {
      const now = sectionOf(p.key) || {};
      // frame E: the rows head with the PUBLISHED name — a renamed product's name line carries it (old); otherwise the lookup
      const nl = p.lines.find((l) => l.kind === 'name');
      const head = nl && typeof nl.was === 'string' && nl.was.trim() ? nl.was : nameOf(p.key);
      const textRow = (sub) => {
        const row = el('div', 'prow mk-trow');
        const main = el('div', 'pmain');
        main.append(el('div', 'pname', head), el('div', 'psub', sub));
        row.append(main);
        return row;
      };
      const wasNow = (was, now2) => { const v = el('div', 'pval'); v.append(el('span', 'was', was), el('span', 'arr', '\u2192'), el('span', 'now', now2)); return v; };
      const cons = () => { const ul = el('ul', 'mk-cons'); for (const c of p.consequences) { const li = el('li'); li.append(el('span', 'mk-cdot'), el('span', null, c)); ul.append(li); } return ul; };
      const catLine = p.lines.find((l) => l.kind === 'cat');
      for (const l of p.lines) {
        const row = textRow(LABEL[l.kind]);
        row.dataset.k = `item::${p.key}::${l.kind}`;
        if (l.kind === 'cat') {
          const cw = l.cat ? l.cat.was : now.cat, cn = l.cat ? l.cat.now : now.cat;
          const sw = l.subcat ? l.subcat.was : now.subcat, sn = l.subcat ? l.subcat.now : now.subcat;
          row.append(wasNow(place(cw, sw), place(cn, sn)));
        } else row.append(wasNow(textOrDash(l.was), textOrDash(l.now)));
        // the consequence sentences sit under the section line (frame E); with no section line, under the product's last line
        if (p.consequences.length && (l === catLine || (!catLine && l === p.lines[p.lines.length - 1]))) row.append(cons());
        g.append(row);
      }
      if (!p.lines.length && p.consequences.length) { const row = textRow(LABEL.cat); row.append(cons()); g.append(row); }
      // advisor ruling 2: a group's option lines fold under their product — «Opciones (n)», each derived name was → now
      if (p.options.length) {
        const label = 'Opciones';
        const row = textRow(`${label} (${p.options.length})`);
        row.dataset.k = `item::${p.key}::options`;
        for (const o of p.options) {
          const v = o.was !== null || o.now !== null ? wasNow(textOrDash(o.was), textOrDash(o.now)) : el('div', 'pval', nameOf(o.key));
          v.dataset.k = `item::${o.key}`;
          row.append(v);
          for (const x of o.extra) {
            const lab = x.kind === 'cat' ? (x.field === 'subcat' ? 'Subcategoría' : 'Categoría') : String(x.kind);
            const show = (val) => (x.field === 'cat' ? (val == null ? '\u2014' : catName(val)) : (val === true ? 'Sí' : val === false ? 'No' : textOrDash(val)));
            const xv = el('div', 'pval');
            xv.append(el('span', 'psub', `${lab}: `), el('span', 'was', show(x.was)), el('span', 'arr', '\u2192'), el('span', 'now', show(x.now)));
            row.append(xv);
          }
        }
        g.append(row);
      }
    }
    root.append(g);
  }

  if (model.rows.length) {
    const g = el('div', 'mgroup');
    g.append(groupHead('Precios', model.rows.length));
    for (const r of model.rows) {
      const row = el('div', `prow${r.big ? ' big' : ''}`);
      row.dataset.k = `${r.surface}::${r.key}`;

      const main = el('div', 'pmain');
      // S4 (frame E): with the products lookup (the text-edit switch on) the row names the product by its CURRENT name and its
      // section beneath; without it, today's row exactly
      const pl = r.surface === 'item' && opts.products && typeof opts.products.nameOf === 'function' ? opts.products : null;
      main.append(el('div', 'pname', pl ? pl.nameOf(r.key) : String(r.key)));      // textContent: a dish name is data
      if (pl && r.isPrice && typeof pl.sectionOf === 'function') {
        const sec = pl.sectionOf(r.key) || {};
        const cn = typeof pl.categoryName === 'function' ? pl.categoryName : (id) => String(id);
        const where = [sec.cat == null ? null : cn(sec.cat), typeof sec.subcat === 'string' && sec.subcat ? sec.subcat : null].filter(Boolean).join(' \u00b7 ');
        if (where) main.append(el('div', 'psub', where));
      }
      // a non-price change still gets a row; the sub line names the field, so nothing publishes unseen
      if (!r.isPrice) main.append(el('div', 'psub', String(r.field)));
      if (r.pct !== null) {
        // AMBER for anything needing attention — a rise, or ANY change the server flagged, in either
        // direction. Green is reserved for a modest decrease. That is the mock's own rule
        // (`big || dpct >= 0 ? 'up' : 'dn'`) and it is the right way round: a price going up costs a
        // customer money, and a big drop costs the merchant.
        const tone = (r.big || r.pct >= 0) ? 'up' : 'dn';
        main.append(el('span', `pdelta ${tone}`, `${r.pct >= 0 ? '+' : ''}${r.pct}%`));
      }
      row.append(main);

      // WAS then NOW as separate nodes, so the order is structural rather than an assembled string
      // that could be built backwards.
      const val = el('div', 'pval');
      val.append(el('span', 'was', shown(r.was)));
      val.append(el('span', 'arr', '\u2192'));
      val.append(el('span', 'now', shown(r.now)));
      row.append(val);

      if (r.big) {
        // The server flagged it. The wording states what the merchant must DO; why the arithmetic
        // tripped is the server's business, the confirmation is theirs.
        const f = el('div', 'pflag');
        f.append(el('span', null, 'Cambio grande \u2014 confirmalo antes de publicar'));
        row.append(f);
      }
      g.append(row);
    }
    root.append(g);
  }

  for (const [list, label, chip, cls] of [
    [model.added, 'Nuevos', 'Nuevo', 'add'],
    [model.removed, 'Se eliminan', 'Elimina', 'rem'],
  ]) {
    if (!list.length) continue;
    const g = el('div', 'mgroup');
    g.append(groupHead(label, list.length));
    // 1D add-product B — a new product's OPTIONS (the server lists each one) are shown UNDER their product rather than as
    // products of their own. Arrangement only: every row the server listed is rendered exactly once, and an option whose
    // product is not in this list stays a row of its own.
    const describeOf = cls === 'add' && typeof opts.describe === 'function' ? opts.describe : () => null;
    const infos = new Map(list.map((x) => [x, describeOf(x)]));
    const keys = new Set(list.map((x) => x && x.key));
    const nested = (x) => { const i = infos.get(x); return !!(i && i.option && keys.has(i.parent)); };
    for (const x of list) {
      if (nested(x)) continue;
      const r = el('div', `brow${cls === 'rem' ? ' rem' : ''}`);
      r.dataset.k = `${x.surface}::${x.key}`;
      r.append(el('span', `bchip ${cls}`, chip));
      // 1D add-product A — a NEW product reads as the merchant wrote it: its name, its section and the rules it
      // INHERITS from that section (e.g. "Solo para recoger · Solo fines de semana"), not its pricing key.
      const info = infos.get(x);
      const opts2 = info && info.choice ? list.filter((y) => { const i = infos.get(y); return nested(y) && i.parent === x.key; }) : [];
      if (info) {
        const nm = el('span', 'bnm');
        nm.append(el('b', null, info.name || String(x.key)));
        if (info.section) nm.append(el('span', 'bsec', ` · ${info.section}`));
        if (Array.isArray(info.rules) && info.rules.length) nm.append(el('span', 'brules', info.rules.join(' · ')));
        // the required choice: its name, "el cliente elige 1", and "sin extras" when set
        if (info.choice) nm.append(el('span', 'bchoice', [`Elección requerida: ${info.choice.label || '—'} · el cliente elige 1`, ...(info.choice.extrasNone ? ['Sin extras'] : [])].join(' · ')));
        r.append(nm);
      } else r.append(el('span', 'bnm', String(x.key)));
      // a product with a required choice is priced by its options — the SERVER's numbers for them, as the order page shows it
      const ps = opts2.map((y) => y.price).filter((v) => Number.isInteger(v) && v > 0);
      r.append(el('span', 'bval', opts2.length && ps.length === opts2.length ? (Math.min(...ps) === Math.max(...ps) ? shown(ps[0]) : `desde ${shown(Math.min(...ps))}`) : shown(x.price)));
      g.append(r);
      for (const y of opts2) {
        const i = infos.get(y);
        const sr = el('div', 'brow sub');
        sr.dataset.k = `${y.surface}::${y.key}`;
        const nm = el('span', 'bnm');
        nm.append(el('b', null, i.name || String(y.key)));
        if (i.recommended) nm.append(el('span', 'recpill recpill-on', 'Recomendada'));
        sr.append(nm, el('span', 'bval', shown(y.price)));
        g.append(sr);
      }
    }
    root.append(g);
  }

  if (model.renamed.length) {
    const g = el('div', 'mgroup');
    g.append(groupHead('Renombrados', model.renamed.length));
    for (const r of model.renamed) {
      const row = el('div', 'brow');
      row.append(el('span', 'bnm', String(r.from)));
      row.append(el('span', 'bval', `\u2192 ${r.to}`));
      g.append(row);
    }
    root.append(g);
  }

  // DISH PHOTOS B (P8) — «Fotos»: one line per dish, «Foto nueva / cambiada / quitada», antes → después as 4:3 card thumbs
  // («Sin foto» where there is none). The URLs come from the caller (E-P3 previews / legacy previews); an unknown one draws
  // the neutral frame, never a broken image.
  if (model.photos && model.photos.length) {
    const ph = opts.photos || {};
    const nameOf = typeof ph.nameOf === 'function' ? ph.nameOf : (k) => String(k);
    const urlOf = typeof ph.urlOf === 'function' ? ph.urlOf : () => null;
    const g = el('div', 'mgroup');
    g.append(groupHead(PHOTO.group, model.photos.length));
    for (const c of model.photos) {
      const kind = lineKind(c, ph.legacy);
      const row = el('div', 'prow');
      row.dataset.k = `${c.surface}::${c.key}`;
      const main = el('div', 'pmain');
      main.append(el('div', 'pname', nameOf(c.key)), el('div', 'psub', PHOTO.line[kind]));
      const val = el('div', 'pval phpval');
      const side = (st, cls) => {
        const has = kind === 'changed' || (cls === 'was' ? kind === 'removed' : kind === 'new');
        if (!has) return el('span', `${cls} phnone`, PHOTO.none);
        const t = el('span', `phpth${cls === 'was' ? ' was' : ''}`);
        const u = urlOf(st, c.key);
        if (u) {
          const i = el('img', 'gimg'); i.alt = '';
          // the photo's identity, so a preview renewal can replace this picture in place (no rebuild of the review)
          i.dataset.ph = st && st.kind === 'pid' ? `pid:${st.pid}` : `legacy:${c.key}`;
          // ONE handler for the node's life, bound to the photo's IDENTITY (codex r2 #1): a renewal swaps only the src, so an
          // obsolete URL can never be mistaken for another photo; the handler reports whatever the node is showing now
          if (typeof ph.onImgError === 'function') i.addEventListener('error', () => ph.onImgError(i.getAttribute('src'), i.dataset.ph));
          i.src = u; t.append(i);
        }
        return t;
      };
      val.append(side(c.old, 'was'), el('span', 'arr', '\u2192'), side(c.new, 'now'));
      row.append(main, val);
      g.append(row);
    }
    root.append(g);
  }
  return root;
}

// ── Task 6 — THE SAR ATTESTATION ─────────────────────────────────────────────────────────────────
// 🔴🔴 A merchant's signature that a change to a legal tax document is theirs. Three things are
// constantly conflated here, and each conflation is its own defect:
//
//   THE SEAL'S ROWS       every fiscal price change, from diff.changed where field === 'price'.
//   THE ACK SET           diff.largeChangeSet, verbatim, and frequently []. A 299→310 edit is a 3.7%
//                         swing: the seal lists it, the ack set is empty, and the publish carries
//                         fiscalAck:true WITH acknowledgedChanges: [].
//   WHETHER IT IS NEEDED  neither of the above.
//
// That last one is not a judgement call. publishEditedCore's fiscal gate reads usesPlatformFactura(rid)
// and NOTHING else — not the diff, not largeChangeSet, not `changed`. So a fiscal merchant needs
// fiscalAck for ANY publish, including one that changes no price at all.
//
// The plan says to show the seal "iff usesPlatformFactura AND ≥1 fiscal price change". That is one
// step too clever: the diff is against the LIVE version, so a draft can differ only in a description
// (an older draft, another editor), and requiring a price change would leave that publish facing a
// 403 the screen offers no way to clear. The seal is shown whenever the merchant is fiscal; when
// there are no price rows it says so.

// The rows the seal LISTS: price changes on either surface, from the server's own `changed`.
// Deliberately NOT largeChangeSet, which holds only >50%/new/zero and is empty for a modest edit.
export function fiscalPriceChanges(diff) {
  const changed = (diff && Array.isArray(diff.changed)) ? diff.changed : [];
  return changed.filter((c) => c && c.field === 'price').map((c) => ({
    surface: c.surface, key: c.key, was: c.old, now: c.new,
  }));
}

// `usesPlatformFactura` comes from the getEditableCatalog response (Task 2b). NEVER from the rid: a
// `rid === 'x_pizza'` literal is accidentally correct for every restaurant that exists today, which is
// exactly what makes it survive review — and wrong the day a third merchant joins the platform
// factura. Strictly `=== true`, so an absent or non-boolean flag is not read as a capability.
export function attestationModel(diff, ctx = {}) {
  const isFiscal = ctx.usesPlatformFactura === true;
  const sealRows = fiscalPriceChanges(diff);
  const ackSet = ackSetFrom(diff);
  // 🔴 NOTHING TO PUBLISH IS ITS OWN ANSWER — and only since #7-B, which made the review reachable on a
  // draft that may turn out to equal live. It is NOT the same as "changed, but no price changed": that
  // one still publishes and still needs the seal (see the desc-only case). This one publishes nothing.
  //
  // Publishing an empty diff would mint an immutable version, flip active_version, and on a fiscal
  // merchant record a SAR attestation against zero changes. A signature for nothing makes the fiscal
  // record say something untrue, which is the same class as a signature for someone else's changes —
  // so no signature is collected and the gate refuses outright.
  const hasNothing = reviewModel(diff).total === 0;
  // A price we cannot vouch for blocks the publish outright, ahead of any acknowledgement — the server
  // would refuse it anyway, and no signature should be collected for something that cannot go live.
  // 1D add-product A — NEW products are priced lines too: they join the zero-price refusal and the attestation copy.
  const addedRows = ((diff && Array.isArray(diff.added)) ? diff.added : []).filter((a) => a && a.surface === 'item')
    .map((a) => ({ key: a.key, now: a.price }));
  const hasZero = sealRows.some((r) => !(Number.isInteger(r.now) && r.now > 0)) || addedRows.some((r) => !(Number.isInteger(r.now) && r.now > 0));
  // DISH PHOTOS B (§2.4) — a publish whose EVERY diff line is a photo line gets the photos seal copy (client-side, like the
  // names-only seal); the server's gate is unchanged (usesPlatformFactura only). The kind of each line is fixed HERE, at mint,
  // from the legacy previews the caller had — the record is evidence and does not change afterwards.
  const m = reviewModel(diff);
  const photoRows = m.photos.map((c) => ({ key: c.key, kind: lineKind(c, ctx.legacy) }));
  // S4 (Codex S4P2 r1 P1-2): a product line (name / description / section — moved out of `rows` into `products`) is NOT a photo:
  // any of them ends «photos only», exactly as a description line did before S4; a rename then puts its name on the seal
  const photosOnly = photoRows.length > 0 && m.rows.length === 0 && m.products.length === 0 && m.added.length === 0 && m.removed.length === 0 && m.renamed.length === 0;

  // PLAN-public-menu-display T1 — the section names this publish changes (a rename publishes alone, so on a fiscal brand
  // these are the seal's only lines): listed with the same was → now as the prices.
  const sectionRows = reviewModel(diff).sections;
  // S4 (frame E; OWNER-approved copy 11-10) — only display.name reaches a factura description (S2 §1.3): the products this publish
  // RENAMES, one row each; a group's options (derived names) fold under their product (ctx.optionParent, the caller's draft)
  const parentOf = typeof ctx.optionParent === 'function' ? ctx.optionParent : () => null;
  const nameRows = ((diff && Array.isArray(diff.changed)) ? diff.changed : [])
    .filter((c) => c && c.surface === 'item' && c.field === 'name' && !parentOf(c.key)).map((c) => ({ key: c.key, was: c.old, now: c.new }));
  return {
    isFiscal,
    nameRows,
    hasNothing,
    sectionRows,
    needsSeal: isFiscal && !hasNothing,
    needsPlainAck: !isFiscal && ackSet.length > 0,
    needsAck: !hasNothing && (isFiscal || ackSet.length > 0),
    sealRows,
    addedRows,
    ackSet,
    hasZero,
    photoRows,
    photosOnly,
    // What the publish will send. Two separate fields for two separate facts: the attestation, and
    // the exact set of large changes the server flagged.
    fiscalAck: isFiscal,
  };
}

// Never with a zero price, and never before the confirmation it asked for.
// `hasNothing` first, and as its own clause rather than folded into needsAck: an unsigned review and an
// empty one are refused for different reasons, and a merchant who checks the box must still be refused.
export const canPublish = (model, acknowledged) =>
  !model.hasNothing && !model.hasZero && (!model.needsAck || acknowledged === true);

export function renderAttestation(root, model, onToggle, opts = {}) {
  const nameOf = (key) => { const d = typeof opts.describe === 'function' ? opts.describe({ surface: 'item', key }) : null; return (d && d.name) || String(key); };
  root.replaceChildren();
  const checkbox = (cls, build) => {
    const label = el('label', cls);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => onToggle(cb.checked === true));
    label.append(cb);
    label.append(build());
    return label;
  };

  if (model.needsSeal && model.photosOnly) {
    // DISH PHOTOS B (P8) — the photos-only seal: the same box and the same one checkbox, the approved photo copy
    const nameP = (k) => (opts.photos && typeof opts.photos.nameOf === 'function' ? opts.photos.nameOf(k) : String(k));
    const seal = el('div', 'seal phseal');
    const h = el('div', 'sealh');
    h.append(el('div', 'sealbadge'));
    const ht = el('div');
    ht.append(el('b', null, 'Autorización fiscal · SAR'), el('span', null, PHOTO.sealSub));
    h.append(ht);
    seal.append(h);
    const body = el('div', 'sealbody');
    body.append(el('p', null, PHOTO.sealBody));
    for (const r of model.photoRows) {
      const c = el('div', 'seachg');
      c.append(el('span', 'sn', nameP(r.key)), el('span', 'sv', PHOTO.line[r.kind]));
      body.append(c);
    }
    seal.append(body);
    seal.append(checkbox('attest', () => {
      const t = el('span', 'at');
      t.append(el('b', null, 'Autorizo'), document.createTextNode(PHOTO.sealAck(model.photoRows.length)));
      return t;
    }));
    root.append(seal);
    return root;
  }

  if (model.needsSeal) {
    const seal = el('div', 'seal');
    const h = el('div', 'sealh');
    h.append(el('div', 'sealbadge'));
    const ht = el('div');
    ht.append(el('b', null, 'Autorización fiscal · SAR'));
    // NO BRAND NAME. The seal is rendered for whichever merchant the server flagged, and hard-coding
    // one would be the same literal the capability flag exists to remove.
    // PLAN-public-menu-display T1 (owner-approved mockup R5b): a publish that changes only SECTION NAMES prints no price, so
    // the seal says what is true — the publish needs the owner's authorization — and never that the name is on the factura.
    const namesOnly = (model.sectionRows || []).length > 0 && !model.sealRows.length && !(model.addedRows || []).length;
    const renames = Array.isArray(model.nameRows) ? model.nameRows : [];
    ht.append(el('span', null, namesOnly || renames.length ? 'Esta publicación requiere tu autorización como propietario' : 'Estos precios se imprimen en tu factura fiscal'));
    h.append(ht);
    seal.append(h);

    const body = el('div', 'sealbody');
    if (namesOnly) {
      body.append(el('p', null, 'Como propietario, autorizás esta publicación. No cambia ningún precio: solo el nombre de las secciones.'));
      for (const r of model.sectionRows) {
        const c = el('div', 'seachg');
        c.append(el('span', 'sn', sectionLabel(r)));
        const v = el('span', 'sv');
        v.append(el('span', 'was', sectionName(r.was)));
        v.append(el('span', 'arr', ' → '));
        v.append(el('span', 'now', sectionName(r.now)));
        c.append(v);
        body.append(c);
      }
      seal.append(body);
      const n = model.sectionRows.length;
      seal.append(checkbox('attest', () => {
        const t = el('span', 'at');
        t.append(el('b', null, 'Autorizo'));
        t.append(n === 1 ? ' publicar el nombre de esta sección.' : ` publicar el nombre de estas ${n} secciones.`);
        return t;
      }));
      root.append(seal);
      return root;
    }
    if (renames.length) {
      // the owner-approved sentences (11-10): 1 price + 1 name is frame E's, verbatim
      const N = model.sealRows.length, M = renames.length;
      const names = M === 1 ? 'el nombre de un producto' : `el nombre de ${M} productos`;
      body.append(el('p', null, `Como propietario, autorizás esta publicación. ${N === 0 ? `Cambia ${names}: ${M === 1 ? 'aparece' : 'aparecen'} en la factura.`
        : (N === 1 && M === 1 ? 'Cambia un precio y el nombre de un producto: los dos aparecen en la factura.' : `Cambia ${N === 1 ? 'un precio' : `${N} precios`} y ${names}: aparecen en la factura.`)}`));
    } else {
      body.append(el('p', null,
        'Como propietario, autorizás que estos precios se cobren en el documento tributario. La factura describe cada línea con el precio que publiques.'));
    }
    // S4 (frame E): with the products lookup a price row reads the product's CURRENT name (as printed after this publish)
    const nowName = (k) => (opts.products && typeof opts.products.nameOf === 'function' ? opts.products.nameOf(k) : String(k));
    for (const r of model.sealRows) {
      const c = el('div', 'seachg');
      c.append(el('span', 'sn', nowName(r.key)));          // textContent: a dish name is data
      const v = el('span', 'sv');
      v.append(el('span', 'was', shown(r.was)));
      v.append(el('span', 'arr', '→'));
      v.append(el('span', 'now', shown(r.now)));
      c.append(v);
      body.append(c);
    }
    // S4 (frame E): one «Nombre en factura» row per renamed product, after the price rows
    for (const r of renames) {
      const c = el('div', 'seachg');
      c.append(el('span', 'sn', 'Nombre en factura'));
      const v = el('span', 'sv');
      v.append(el('span', 'was', String(r.was)));
      v.append(el('span', 'arr', '→'));
      v.append(el('span', 'now', String(r.now)));
      c.append(v);
      body.append(c);
    }
    // 1D add-product A — the NEW products, with the prices the factura will print for them.
    // 1D add-product B (§0d.5) — a product with a required choice is never a factura line itself: each OPTION is, under its
    // full name ("{product} - {choice}"), so the seal lists every option with its price, under its product.
    const added = Array.isArray(model.addedRows) ? model.addedRows : [];
    const desc = (k) => (typeof opts.describe === 'function' ? opts.describe({ surface: 'item', key: k }) : null);
    const addedKeys = new Set(added.map((r) => r.key));
    const optionOf = (r) => { const d = desc(r.key); return d && d.option && addedKeys.has(d.parent) ? d : null; };
    const products = added.filter((r) => !optionOf(r));
    const optionCount = added.length - products.length;
    if (added.length) {
      body.append(el('p', null, optionCount
        ? (products.length === 1 ? 'Vas a agregar 1 producto nuevo. La factura imprimirá cada opción con su precio:' : `Vas a agregar ${products.length} productos nuevos. La factura imprimirá cada línea con su precio:`)
        : (added.length === 1 ? 'Vas a agregar 1 producto nuevo con este precio:' : `Vas a agregar ${added.length} productos nuevos con estos precios:`)));
      for (const r of products) {
        const kids = added.filter((y) => { const d = optionOf(y); return d && d.parent === r.key; });
        const c = el('div', 'seachg');
        c.append(el('span', 'sn', nameOf(r.key)));
        const v = el('span', 'sv');
        if (!kids.length) v.append(el('span', 'now', shown(r.now)));
        c.append(v);
        body.append(c);
        for (const y of kids) {
          const kc = el('div', 'seachg sub');
          kc.append(el('span', 'sn', optionOf(y).fullName || nameOf(y.key)));
          const kv = el('span', 'sv');
          kv.append(el('span', 'now', shown(y.now)));
          kc.append(kv);
          body.append(kc);
        }
      }
    }
    if (!model.sealRows.length && !added.length && !renames.length) {
      // Honest, and clearable: the merchant is fiscal, so the server will demand the attestation even
      // though this particular edit moves no price.
      body.append(el('p', 'seachg', 'Esta edición no cambia ningún precio, pero afecta el documento fiscal.'));
    }
    seal.append(body);

    // ONE checkbox. It is the fiscal attestation AND, when the server flagged large changes, their
    // confirmation — one signature over one reviewed set, rather than two boxes for one decision.
    seal.append(checkbox('attest', () => {
      const t = el('span', 'at');
      t.append(el('b', null, 'Autorizo'));
      const n = model.sealRows.length;
      // products, not factura lines: a product's options are counted with it ("y sus N opciones")
      const a = products.length;
      const prices = n === 1 ? 'este cambio de precio' : `estos ${n} cambios de precio`;
      const adds = (a === 1 ? '1 producto nuevo' : `${a} productos nuevos`) + (optionCount ? ` y sus ${optionCount} opciones` : '');
      t.append(renames.length ? ' esta edición en la factura fiscal.' : a === 0
        ? (n === 1 ? ' este cambio de precio en la factura fiscal.' : (n === 0 ? ' esta edición en la factura fiscal.' : ` estos ${n} cambios de precio en la factura fiscal.`))
        : (n === 0 ? ` ${adds} con sus precios en la factura fiscal.` : ` ${prices} y ${adds} en la factura fiscal.`));
      return t;
    }));
    root.append(seal);
    return root;
  }

  if (model.needsPlainAck) {
    root.append(checkbox('ack', () => {
      const t = el('span', 'ackt');
      t.append(el('b', null, 'Confirmá los cambios grandes.'));
      // Real pluralisation rather than "cambio(s)": it reads better, and the parenthesised form parses
      // as a function call to the wiring guard that checks every call is defined or imported.
      const n = model.ackSet.length;
      t.append(` ${n} ${n === 1 ? 'cambio importante' : 'cambios importantes'}: ${model.ackSet.map((a) => (a.surface === 'item' ? nameOf(a.key) : a.key)).join(', ')}`);
      return t;
    }));
  }
  return root;
}

// ── Task 6 Step 3b — THE PUBLISH PAYLOAD ─────────────────────────────────────────────────────────
// 🔴🔴 What actually leaves the browser to authorize a change to a legal tax document. Pure, so it is
// checked in node rather than only asserted about structurally: app.js hands it the review state and
// passes the result straight to publishEdited.
//
// TWO FIELDS, TWO QUESTIONS, and this is the pair that keeps being conflated:
//
//   acknowledgedChanges  the server's largeChangeSet, BY IDENTITY. Frequently []. Answers "which
//                        large changes did the merchant see?"
//   fiscalAck            true only when this merchant is fiscal AND the owner actually ticked
//                        Autorizo. Answers "did a legally responsible person sign?"
//
// A modest 299→310 on a fiscal merchant sends fiscalAck:true WITH acknowledgedChanges:[]. Neither
// field can be derived from the other.
export function publishPayload(review) {
  const att = (review && review.attestation) || {};
  return {
    rid: review && review.rid,
    editToken: review && review.editToken,
    // the server array itself — never a copy, a map or a rebuild
    acknowledgedChanges: Array.isArray(att.ackSet) ? att.ackSet : [],
    // STRICT on both halves. `isFiscal` is the server's capability flag; `acknowledged` is a literal
    // true or it is not a signature. The publish button being enabled is a UI state, not a guarantee —
    // it can be cleared from devtools — so the payload states what was actually signed rather than
    // what the screen looked like.
    fiscalAck: att.isFiscal === true && review.acknowledged === true,
  };
}

// ── Task 6 BLOCK — THE PUBLISHER, WITH A REAL IN-FLIGHT GUARD ────────────────────────────────────
// 🔴🔴 The double-publish race. The first version's only protection was `btn.disabled = true` — a UI
// STATE, which is exactly what the same code argues a gate must never be. `disabled` lives on the
// element: devtools clears it, a script never consults it, and a second dispatched click re-enters
// before the await resolves while the review state is still perfectly valid. The SAR publish goes
// twice.
//
// The lock is a closure value instead. It is taken BEFORE the await, so there is no window between
// deciding to send and sending; a second entry cannot get past it whatever the DOM says.
//
// Spent-ness is PER TOKEN, so a success does not latch anything shut: the set that published is
// recorded by its own token, a failure records nothing (the merchant can retry), and a new review is
// free because it carries a different token. There is no release path to get wrong.
//
// Injected `publish` rather than importing publishEdited, so node can drive the whole path — real
// payload, real client, intercepted fetch — and assert the bytes that actually leave.
export function createPublisher({ publish }) {
  // TWO FLAGS, because they answer two different questions — and one boolean doing both was the T6
  // regression:
  //
  //   inFlight  a request is ON THE WIRE right now. Nothing may release this but the request
  //             settling — not a new review, not an auth change. Releasing it re-opens the
  //             double-publish window T6 closed.
  //   spent     this reviewed set has already been published; its token is used, so pressing again
  //             must not re-send. Tracked PER TOKEN, so a new review is free by construction.
  let inFlight = false;
  // 🔴 PER-REVIEW, not a global boolean. The question is "has THIS reviewed set been published?", and
  // a shared flag answered a different one: publish A on the wire, merchant opens review B (reset
  // clears the flag), A settles and sets it again — and B, which never published, is refused as
  // 'spent'. The merchant could not publish at all until reloading.
  //
  // The token identifies the set: it is what the server binds the diff to, so two reviews can never
  // share one.
  // A SET, and it is never cleared. Once a token has published, it has published — for the life of
  // the session. A single slot was not enough: publishing review B overwrote A's entry and made A
  // re-publishable.
  //
  // Note what this design DELETES: there is no release path at all. A new review carries a new token
  // and is free automatically, so nothing has to be un-set — and a lock with no release is a lock that
  // cannot be released at the wrong moment.
  const spentTokens = new Set();
  // A monotonic count of requests this publisher actually ADMITTED. Callers read it either side of
  // run() to learn whether THEIR call went on the wire — `busy` cannot answer that, because it is true
  // whenever ANY request is in flight, including someone else's that caused this one to be refused.
  let admissions = 0;
  return {
    get busy() { return inFlight; },
    get admissions() { return admissions; },
    isSpent(token) { return spentTokens.has(token); },
    async run(review) {
      // The overlap lock stays GLOBAL — only one request may be on the wire at a time, whichever set
      // it belongs to.
      if (inFlight) return { skipped: 'in_flight' };
      if (review && review.editToken && spentTokens.has(review.editToken)) return { skipped: 'spent' };
      if (!review || !review.attestation || !canPublish(review.attestation, review.acknowledged)) {
        return { skipped: 'not_ready' };
      }
      inFlight = true;
      admissions += 1;                 // synchronous, before the first await: this call is on the wire
      try {
        const res = await publish(publishPayload(review));
        if (review && review.editToken) spentTokens.add(review.editToken);   // THIS set published; others did not
        return { ok: true, res };
      } finally {
        inFlight = false;              // the wire is free either way; a failure leaves `spent` false so a retry works
      }
    },
  };
}

// ── Task 7 — THE PUBLISH STATE MACHINE ───────────────────────────────────────────────────────────
// Every way a publish can end has to land somewhere the merchant can act on. The failure this guards
// against is not a wrong panel — it is NO panel: an unhandled code falling through to a toast, or to
// nothing at all, on the screen that decides whether their prices changed.

// What a panel's button MEANS. The caller decides how to carry it out; the panel only says which.
export const PUBLISH_ACTIONS = {
  RELOAD: 'reload',       // the DRAFT moved — fetch it again and re-apply
  REREVIEW: 'rereview',   // the LIVE version moved — call editCatalog for a fresh diff + token
  BACK: 'back',           // something on the review was not confirmed — return and tick it
  RETRY: 'retry',         // nothing about the edit was wrong — send the same payload again
  FIX: 'fix',             // 1D add-product A: a NEW product needs a correction — back to editing, its drawer open at the field
  RESET: 'reset',         // 1D add-product A: the saved draft cannot publish — "Volver al menú publicado"
};

// The six first-class states, each with its own explanation and its own way forward. The copy says
// what happened, what it means for the merchant's data, and what to do — in that order, because the
// first question anyone has after a failed publish is "did I lose my changes?".
const PANELS = {
  stale_edit: {
    icon: 'warn',
    title: 'Tu borrador cambió',
    // No reassurance about the DRAFT here — the draft moving under the merchant is precisely what
    // happened. What CAN be said honestly is that nothing was published.
    detail: 'Se guardó otra edición sobre este menú mientras revisabas, así que no publicamos nada. Recargá para traer la última versión y volvé a aplicar tu cambio — así no pisás lo que se guardó.',
    action: { id: PUBLISH_ACTIONS.RELOAD, label: 'Recargar y reaplicar' },
  },
  edit_superseded: {
    icon: 'info',
    title: 'Se revisó contra una versión vieja',
    // 🔴 REREVIEW, never RETRY. The token is bound to a diff that no longer describes reality;
    // retrying the publish would either fail again or succeed against state nobody reviewed.
    detail: 'El menú en vivo cambió desde que abriste esta revisión. Por seguridad no publicamos: revisá de nuevo los cambios contra la versión actual antes de confirmar.',
    action: { id: PUBLISH_ACTIONS.REREVIEW, label: 'Revisar de nuevo' },
  },
  large_change_unconfirmed: {
    icon: 'warn',
    title: 'Falta confirmar los cambios grandes',
    detail: 'Hay cambios de precio importantes que necesitan tu confirmación explícita. Tus cambios siguen guardados como borrador — volvé a la revisión y confirmá exactamente los que aparecen marcados.',
    action: { id: PUBLISH_ACTIONS.BACK, label: 'Volver a la revisión' },
  },
  not_owner: {
    icon: 'warn',
    title: 'Solo el propietario puede publicar un cambio fiscal',
    detail: 'Esta edición afecta la factura fiscal, y ese documento lo autoriza el propietario del local. Tus cambios quedan guardados como borrador: pedile al propietario que ingrese y los publique.',
    action: { id: PUBLISH_ACTIONS.BACK, label: 'Entendido' },
  },
  fiscal_ack_required: {
    icon: 'warn',
    title: 'Falta la autorización fiscal',
    detail: 'Para publicar precios que se imprimen en la factura fiscal hay que autorizarlos explícitamente. Nada cambió en vivo — volvé a la revisión y marcá "Autorizo".',
    action: { id: PUBLISH_ACTIONS.BACK, label: 'Volver a autorizar' },
  },
  // ── 1D add-product A — the add-only refusals. Each names what to do; the field ones reopen the product. ──
  name_taken: { icon: 'warn', title: 'Ese nombre ya está en tu menú',
    detail: 'Ya hay un producto u opcional con ese nombre. Cambiale el nombre al producto nuevo para poder guardarlo.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Corregir el nombre' } },
  key_taken: { icon: 'warn', title: 'Ese nombre ya está en tu menú',
    detail: 'Ese nombre coincide con un producto que ya existe. Cambiale el nombre al producto nuevo para poder guardarlo.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Corregir el nombre' } },
  name_previously_used: { icon: 'warn', title: 'Ese nombre ya existió en tu menú',
    detail: 'Ese nombre ya se usó antes en tu menú — usá otro nombre para el producto nuevo.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Corregir el nombre' } },
  name_required: { icon: 'warn', title: 'Falta el nombre',
    detail: 'Cada producto nuevo necesita un nombre.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Agregar el nombre' } },
  name_unusable: { icon: 'warn', title: 'Ese nombre no sirve',
    detail: 'El nombre necesita al menos una letra o un número.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Corregir el nombre' } },
  text_unsafe: { icon: 'warn', title: 'Ese nombre lleva caracteres que no se pueden usar',
    detail: 'El nombre de un producto no puede llevar comillas ni apóstrofos, ni los signos < y >. Cambialo para poder guardarlo.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Corregir el nombre' } },
  // 1D add-product B — required-choice groups: every refusal reopens the product at the field the server named
  label_required: { icon: 'warn', title: 'Falta el nombre de la elección',
    detail: 'Cada elección necesita un nombre, por ejemplo "Salsa".',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Agregar el nombre' } },
  choice_label_required: { icon: 'warn', title: 'Falta el nombre de una opción',
    detail: 'Cada opción de la elección necesita un nombre.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Agregar el nombre' } },
  choice_duplicate: { icon: 'warn', title: 'Esa opción está repetida',
    detail: 'Dos opciones de la misma elección tienen el mismo nombre. Cambiale el nombre a una de ellas.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Corregir la opción' } },
  choices_too_few: { icon: 'warn', title: 'Faltan opciones',
    detail: 'Una elección necesita al menos 2 opciones para que el cliente pueda elegir.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Agregar opción' } },
  subcat_invalid: { icon: 'warn', title: 'Falta la subsección',
    detail: 'Esa sección se divide en subsecciones. Elegí en cuál va el producto nuevo.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Elegir la subsección' } },
  category_not_renderable: { icon: 'warn', title: 'Esa sección no se muestra en tu página de pedidos',
    detail: 'Elegí una de las secciones que tus clientes ven al pedir.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Elegir la sección' } },
  too_many_additions: { icon: 'warn', title: 'Demasiados productos nuevos a la vez',
    detail: 'Podés agregar hasta 20 productos por publicación. Quitá algunos, publicá, y agregá el resto después.',
    action: { id: PUBLISH_ACTIONS.BACK, label: 'Entendido' } },
  choices_not_supported_yet: { icon: 'info', title: 'Todavía no se pueden agregar productos con elección',
    detail: 'Por ahora solo se pueden agregar productos sin elección obligatoria.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Entendido' } },
  existing_item_changed: { icon: 'warn', title: 'Solo se pueden cambiar precios y agregar productos',
    detail: 'Tu borrador cambia algo más que precios en un producto existente. Volvé al menú publicado y aplicá tus cambios de nuevo.',
    action: { id: PUBLISH_ACTIONS.RESET, label: 'Volver al menú publicado' } },
  // PLAN-public-menu-display T1 (owner-approved mockup R4): a section rename travels ALONE — the server refuses a draft
  // that renames and changes anything else. The draft is not publishable as it stands, so the way out is the published menu.
  rename_not_alone: { icon: 'warn', title: 'Un cambio de nombre se publica solo',
    detail: 'Tu borrador cambia el nombre de una sección y también otras cosas. Volvé al menú publicado, cambiá solo el nombre y publicalo; el resto hacelo después.',
    action: { id: PUBLISH_ACTIONS.RESET, label: 'Volver al menú publicado' } },
  structure_changed: { icon: 'warn', title: 'Tu borrador no coincide con el menú publicado',
    detail: 'Tu borrador cambia la estructura del menú. Volvé al menú publicado y aplicá tus cambios de nuevo.',
    action: { id: PUBLISH_ACTIONS.RESET, label: 'Volver al menú publicado' } },
  // A saved draft that already differs from the live menu (removed product, changed opcionales, reordered
  // products) is refused on EVERY save — "Reintentar" would loop forever, so these go to RESET too.
  existing_item_removed: { icon: 'warn', title: 'Tu borrador no coincide con el menú publicado',
    detail: 'Tu borrador no tiene un producto que está en el menú publicado. Volvé al menú publicado y aplicá tus cambios de nuevo.',
    action: { id: PUBLISH_ACTIONS.RESET, label: 'Volver al menú publicado' } },
  extras_changed: { icon: 'warn', title: 'Tu borrador no coincide con el menú publicado',
    detail: 'Tu borrador cambia los opcionales más allá de sus precios. Volvé al menú publicado y aplicá tus cambios de nuevo.',
    action: { id: PUBLISH_ACTIONS.RESET, label: 'Volver al menú publicado' } },
  item_order_changed: { icon: 'warn', title: 'Tu borrador no coincide con el menú publicado',
    detail: 'Tu borrador cambia el orden de los productos. Volvé al menú publicado y aplicá tus cambios de nuevo.',
    action: { id: PUBLISH_ACTIONS.RESET, label: 'Volver al menú publicado' } },
  // F-2 (owner-approved mockup ENrjdkJmw3mzy9PkFCy4D1, N2) — Sherpa wrote fields into this draft that live does not carry yet; the
  // server refuses the reset. Nothing went wrong on the merchant's side (info, not warn); «Entendido» only closes (FIX, no target).
  platform_changes_pending: { icon: 'info', title: 'Sherpa está actualizando tu menú',
    detail: 'No se guardó ni se publicó nada. Cuando Sherpa termine vas a poder publicar de nuevo; tus cambios de precio podés hacerlos después.',
    action: { id: PUBLISH_ACTIONS.FIX, label: 'Entendido' } },
  draft_unbuildable: { icon: 'warn', title: 'Tu borrador no se puede publicar',
    detail: 'Volvé al menú publicado y aplicá tus cambios de nuevo.',
    action: { id: PUBLISH_ACTIONS.RESET, label: 'Volver al menú publicado' } },
  flip_evidence_exists: { icon: 'info', title: 'No se publicó',
    detail: 'El menú en vivo no cambió. Revisá de nuevo los cambios y volvé a confirmar.',
    action: { id: PUBLISH_ACTIONS.REREVIEW, label: 'Revisar de nuevo' } },
  store_unavailable: {
    icon: 'warn',
    title: 'No se pudo publicar',
    // This is a coded ANSWER: the handler returns it after failing to READ the store, before writing
    // anything. So the reassurance is true and belongs here. Genuine uncertainty — the answer never
    // arriving — is a different case, handled by the transport branch in outcomeFor rather than by
    // rewording a panel that describes a refusal.
    detail: 'El servicio de catálogo no respondió. Tus cambios siguen guardados como borrador — nada se perdió y nada cambió en vivo. Probá de nuevo en un momento.',
    action: { id: PUBLISH_ACTIONS.RETRY, label: 'Reintentar' },
  },
};

// THE DEFAULT BRANCH, and it is the point of this function. Every other server code, every untyped
// throw, every shape that is not an error at all — all of them land here rather than nowhere. A
// merchant who cannot tell whether their prices changed is worse off than one reading a plain error.
const GENERIC = {
  icon: 'warn',
  title: 'No se pudo publicar',
  // The generic panel is reached with a coded answer OR with nothing at all; outcomeFor rewrites the
  // detail per (operation x answered?), so this is the neutral base rather than a claim either way.
  detail: 'Algo falló y no pudimos completar el cambio. Tu borrador está guardado. Probá de nuevo; si sigue fallando, recargá la página.',
  action: { id: PUBLISH_ACTIONS.RETRY, label: 'Reintentar' },
};

// `op` is WHICH CALL FAILED — 'edit' (editCatalog) or 'publish' (publishEdited). It rides on the
// outcome so RETRY redoes the operation that actually failed. Both calls share most of their error
// surface, which is why routing them through the same panels is right; letting both RETRY buttons
// mean "publish" is not. A failed SAVE retried as a PUBLISH would push a reviewed-and-acknowledged
// set the merchant had already moved past.
// DID THE SERVER ANSWER? That is the whole discriminator for whether anything could have committed.
//
// A coded response — even 503 store_unavailable, which the handler returns after failing to READ the
// store — is an ANSWER: the server refused on its way in and wrote nothing. Only a request whose
// answer never arrived (api.js raises Unavailable with status 0 for a network or CORS failure) leaves
// the outcome genuinely unknown.
//
// Sending a merchant to verify a live menu we KNOW is untouched is its own false alarm, and it teaches
// them to distrust the one panel that will someday be telling the truth.
const serverAnswered = (err) => !!(err && typeof err.status === 'number' && err.status > 0);

export function outcomeFor(err, op = 'publish') {
  const code = (err && typeof err.code === 'string') ? err.code : null;
  const panel = (code && Object.prototype.hasOwnProperty.call(PANELS, code)) ? PANELS[code] : null;
  const base = { code, op, generic: !panel, ...(panel || GENERIC) };
  // 1D add-product A — WHICH new product and WHICH field, when the server named them (field-mapped refusals).
  const b = err && err.body && typeof err.body === 'object' ? err.body : null;
  if (b) {
    const target = typeof b.ref === 'string' ? b.ref : (typeof b.key === 'string' ? b.key : null);
    if (target) base.target = target;
    if (typeof b.field === 'string') base.field = b.field;
    if (typeof b.option_key === 'string' && b.option_key) base.optionKey = b.option_key;   // S4: a derived option name's refusal
  }
  // the description has its own (looser) rule: quotes are fine there, the signs < and > are not
  if (code === 'text_unsafe' && base.field === 'desc') {
    base.title = 'La descripción lleva caracteres que no se pueden usar';
    base.detail = 'La descripción de un producto no puede llevar los signos < y >. Cambiala para poder guardarlo.';
    base.action = { id: PUBLISH_ACTIONS.FIX, label: 'Corregir la descripción' };
  }
  // 1D add-product B: an OPTION's name becomes part of the product name ("Producto - Opción"), so it follows the name's
  // rule (no quotes or apostrophes, no < >); the group name and prompt are plain text (only < > are forbidden).
  if (code === 'text_unsafe' && base.field === 'choice') {
    base.title = 'Esa opción lleva caracteres que no se pueden usar';
    base.detail = 'El nombre de una opción no puede llevar comillas ni apóstrofos, ni los signos < y >. Cambialo para poder guardarlo.';
    base.action = { id: PUBLISH_ACTIONS.FIX, label: 'Corregir la opción' };
  }
  if (code === 'text_unsafe' && (base.field === 'label' || base.field === 'prompt')) {
    base.title = 'El nombre de la elección lleva caracteres que no se pueden usar';
    base.detail = 'El nombre de una elección no puede llevar los signos < y >. Cambialo para poder guardarlo.';
    base.action = { id: PUBLISH_ACTIONS.FIX, label: 'Corregir el nombre' };
  }
  // not_owner on a draft that ADDS products is about adding, not the factura
  if (code === 'not_owner' && b && typeof b.detail === 'string' && /add products/.test(b.detail)) {
    base.title = 'Solo el propietario puede agregar productos';
    base.detail = 'Agregar productos al menú lo hace el propietario del local. Tus cambios de precio siguen en pantalla.';
  }

  // (operation) x (did the server answer?) — the only cell that may claim uncertainty is a PUBLISH
  // whose answer never arrived.
  if (op === 'publish' && !serverAnswered(err)) {
    base.title = 'No pudimos confirmar el resultado';
    base.detail = 'Se perdió la conexión antes de recibir la respuesta, así que no sabemos si el cambio llegó a publicarse. Tu borrador está guardado — verificá tu menú en vivo antes de reintentar.';
    base.action = { id: PUBLISH_ACTIONS.RETRY, label: 'Reintentar' };
    return base;
  }
  if (op === 'edit') {
    // An edit never publishes, so it may never mention publishing NOR send anyone to verify a live
    // menu it did not touch. The panels are written for the publish path; restate for this one.
    // ANY publish-flavoured title, not just the generic one: `store_unavailable`'s panel says
    // "No se pudo publicar", which is simply untrue of a save.
    // PLAN-public-menu-display T1 — EXCEPT rename_not_alone: its words state the RULE ("a rename is published on its own"),
    // never that this operation published, and they are as true of the save that refused it as of a publish (mockup R4).
    if (code === 'rename_not_alone') return base;
    // F-2 (mockup N2) — likewise: «No se guardó ni se publicó nada» is the literal truth of a refused reset, in the approved words
    if (code === 'platform_changes_pending') return base;
    if (base.generic || /public/i.test(base.title)) base.title = 'No se pudo guardar el borrador';
    if (base.generic || /verific|en vivo|public/i.test(base.detail)) {
      base.detail = 'No pudimos guardar tu borrador. Tus cambios siguen en pantalla — probá de nuevo; si sigue fallando, recargá la página.';
    }
    return base;
  }
  // a publish the server ANSWERED: pre-commit, so nothing went live and the panel says so
  if (base.generic) {
    base.detail = 'El servidor rechazó el cambio y no publicamos nada. Tu borrador está guardado — probá de nuevo; si sigue fallando, recargá la página.';
  }
  return base;
}

// The receipt is built from the CAPTURED review, not the draft. On success the draft is discarded and
// the screen repaints — the publish IS the new baseline — so by the time this renders there is nothing
// pending left to read. Reading the draft would report zero changes on a successful publish.
export function receiptFor(res, captured, opts = {}) {
  const diff = (captured && captured.diff) || {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const rows = arr(diff.changed);
  // DISH PHOTOS B (P9) — a publish of photos only says which dishes' photos are live; mixed keeps today's sentence
  const photoKeys = rows.filter(isPhotoLine).map((c) => c.key);
  const photosOnly = photoKeys.length > 0 && photoKeys.length === rows.length && !arr(diff.added).length && !arr(diff.removed).length && !arr(diff.renamed).length;
  const nameOf = typeof opts.nameOf === 'function' ? opts.nameOf : (k) => String(k);
  return {
    photoNames: photosOnly ? photoKeys.map(nameOf) : null,
    versionId: (res && typeof res.versionId === 'string' && res.versionId) ? res.versionId : null,
    // EVERY surface, not just `changed`. An added or removed item is genuinely a change, and a
    // receipt that counted only `changed` would read "estos 0 cambios" on a real publish the moment
    // an add/remove slice lands. Not reachable while the editor is price-only — which is exactly why
    // it would ship silently — so it is counted correctly now rather than left as a trap.
    count: rows.length + arr(diff.added).length + arr(diff.removed).length + arr(diff.renamed).length,
    rows,
    // PLAN-public-menu-display T1 — the section names this publish changed, for the receipt's sentence
    sections: reviewModel(diff).sections,
    // 1D add-product A §0b.3: the publish went live but the kitchen's list could not be updated after 3 tries.
    kdsSyncPending: !!(res && res.kds_sync_pending === true),
  };
}

// SVG needs createElementNS — createElement would make an inert HTMLUnknownElement that draws nothing.
// The stylesheet animates `.rcheck svg` with a stroke-dasharray draw-in, so an absent icon is not just
// a missing tick: it is an empty circle where a confirmation should be.
function icon(paths) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const d of paths.split('|')) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
const ICONS = {
  check: 'M20 6L9 17l-5-5',
  warn: 'M12 3l9 16H3z|M12 10v4|M12 17.5v.01',
  info: 'M21 12a9 9 0 11-6.2-8.5|M12 7v5l3 2',
};

// PLAN-public-menu-display T1 (owner-approved mockup R6) — what a names-only publish changed, in the receipt's words. It says
// the published menu carries the name, never where a customer sees it.
function sectionsReceipt(secs) {
  const list = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`);
  if (secs.every((r) => !(typeof r.was === 'string' && r.was.trim()))) return `Tus secciones ya tienen nombre: ${list(secs.map((r) => sectionName(r.now)))}.`;
  if (secs.length === 1) return `«${sectionLabel(secs[0])}» ahora se llama «${sectionName(secs[0].now)}». El menú publicado ya lleva el nuevo nombre.`;
  return `${secs.map((r) => `«${sectionLabel(r)}» ahora se llama «${sectionName(r.now)}»`).join('; ')}. El menú publicado ya lleva los nuevos nombres.`;
}

export function renderReceipt(root, receipt) {
  root.replaceChildren();
  const r = el('div', 'receipt');
  const ck = el('div', 'rcheck');
  ck.append(icon(ICONS.check));
  r.append(ck);
  r.append(el('h3', null, 'Publicado'));
  // DISH PHOTOS B (P9) × PLAN-public-menu-display T1 (R6): the photos-only and names-only sentences are mutually exclusive by
  // construction (each requires EVERY changed line to be its kind); anything mixed keeps today's sentence
  const secs = Array.isArray(receipt.sections) ? receipt.sections : [];
  if (receipt.photoNames) r.append(el('p', null, PHOTO.receipt(receipt.photoNames)));
  else if (secs.length && secs.length === receipt.count) r.append(el('p', null, sectionsReceipt(secs)));
  else r.append(el('p', null, receipt.count === 1
    ? 'Tu menú en vivo ya muestra este precio. Los clientes que ordenen ahora verán la nueva versión.'
    : `Tu menú en vivo ya muestra estos ${receipt.count} cambios. Los clientes que ordenen ahora verán la nueva versión.`));
  // The version id, when the server gave one. No "Ver en Historial" button: neither a Historial view
  // nor a rollback endpoint exists, and a control that does nothing is the failure this slice has been
  // guarding against since the 2b-2a switcher shipped display-only.
  if (receipt.kdsSyncPending) {
    r.append(el('p', 'kdswarn', 'No se pudo actualizar la lista de la cocina. Avisá al equipo para sincronizarla.'));
  }
  if (receipt.versionId) {
    const vp = el('div', 'vpill');
    vp.append(el('span', null, 'Versión '));
    vp.append(el('b', null, receipt.versionId));
    r.append(vp);
  }
  root.append(r);
  return root;
}

export function renderOutcome(root, outcome, onAction) {
  root.replaceChildren();
  const box = el('div', 'conflict');
  const ic = el('div', `cicon ${outcome.icon}`);
  ic.append(icon(ICONS[outcome.icon] || ICONS.warn));
  box.append(ic);
  box.append(el('h3', null, outcome.title));      // textContent: even a hostile code is only ever text
  box.append(el('p', null, outcome.detail));
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn accent';
  b.textContent = outcome.action.label;
  b.addEventListener('click', () => onAction(outcome.action.id));
  box.append(b);
  root.append(box);
  return root;
}
