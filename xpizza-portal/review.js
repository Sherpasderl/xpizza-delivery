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
export function reviewModel(diff) {
  const d = diff || {};
  const changed = Array.isArray(d.changed) ? d.changed : [];
  const added = Array.isArray(d.added) ? d.added : [];
  const removed = Array.isArray(d.removed) ? d.removed : [];
  const renamed = Array.isArray(d.renamed) ? d.renamed : [];
  const flagged = new Set(ackSetFrom(d).map(idOf));

  const rows = changed.map((c) => ({
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
    added,
    removed,
    renamed,
    // everything that will publish, so the header cannot understate it
    total: rows.length + added.length + removed.length + renamed.length,
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

const shown = (v) => (Number.isInteger(v) && v > 0 ? `L${v}` : (v === null || v === undefined ? '—' : String(v)));

export function renderReview(root, model) {
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

  if (model.rows.length) {
    const g = el('div', 'mgroup');
    g.append(groupHead('Precios', model.rows.length));
    for (const r of model.rows) {
      const row = el('div', `prow${r.big ? ' big' : ''}`);
      row.dataset.k = `${r.surface}::${r.key}`;

      const main = el('div', 'pmain');
      main.append(el('div', 'pname', String(r.key)));      // textContent: a dish name is data
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
    for (const x of list) {
      const r = el('div', `brow${cls === 'rem' ? ' rem' : ''}`);
      r.dataset.k = `${x.surface}::${x.key}`;
      r.append(el('span', `bchip ${cls}`, chip));
      r.append(el('span', 'bnm', String(x.key)));
      r.append(el('span', 'bval', shown(x.price)));
      g.append(r);
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
  return root;
}
