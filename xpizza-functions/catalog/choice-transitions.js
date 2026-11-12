// S3 (PLAN-structure-S3-r3 §0, §2) — THE writer for the required choice on an EXISTING dish. Every op writes the minimal source
// change on a COPY and returns { source, deletedIds } (the identity stamps of rows it removed, for the reviewed deletion claim — the
// exposure-transitions shape). The server never trusts the op list: it re-judges the RESULTING draft (choice-activation.js), so a
// draft written any other way meets the same rules.
//   choice.label        { launcher, label }                    the group's name
//   option.rename       { key, choice }                        the option's choice text; its composed name «{dish} - {choice}» follows
//                                                              (the server re-derives it, add-product rederiveOptionNames); its KEY is kept
//   option.add          { launcher, ref, choice, price }       a new option row (a tmp ref; the save's allocator gives it its key)
//   option.remove       { key }                                the row leaves (≥ 2 stay — choices_too_few; or the merchant removes the choice)
//   choice.recommended  { launcher, option }                   ATOMIC: that option gains 'recommended', every sibling loses it
//   choice.add          { key, label, options: [{ ref, choice, price? }] }   a plain dish gains a group (≥ 2 options); the FIRST option
//                                                              takes the dish's price when it names none and is «Recomendada»
//   choice.remove       { launcher, price_from }               every option leaves; the dish is plain at price_from's price
// `launcher` / `key` / `option` / `price_from` name rows by KEY (an existing row) or by REF (a row new in this draft). A group lives in
// structure.variant_items under its dish's DISPLAY id, listing display ids / refs (the namespace group-index.js joins to keys).
// UMD-lite (the exposure-transitions.js pattern): CommonJS here, a global in the portal's classic script — the SAME bytes write the
// draft in the portal and are proven here (tools/sync-client.js writes the copy). Pure; never mutates its input.

(function (root) {
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  const fail = (code, message, detail) => { throw Object.assign(new Error(message), { code, detail: detail || {} }); };
  const TAG = 'recommended';
  const REF_RE = /^tmp:/;

  function apply(input, op) {
    const s = JSON.parse(JSON.stringify(input));
    if (!isObj(op) || typeof op.op !== 'string') fail('unknown_op', 'no op');
    if (!Array.isArray(s.items)) fail('source_malformed', 'the menu has no items');
    s.structure = isObj(s.structure) ? s.structure : {};
    const st = s.structure;
    const deletedIds = [];
    const rowOf = (name) => s.items.find((it) => isObj(it) && (it.key === name || (has(it, 'ref') && it.ref === name)));
    const idOf = (row) => (has(row, 'ref') ? row.ref : row.display.id);
    const map = () => (isObj(st.variant_items) ? st.variant_items : null);
    const groupOf = (launcherName) => {
      const l = rowOf(launcherName);
      const m = map();
      const id = l && isObj(l.display) ? idOf(l) : undefined;
      if (!l || !m || !has(m, String(id))) fail('choice_group_missing', `${JSON.stringify(launcherName)} has no choice group`, { key: launcherName });
      return { l, spec: m[String(id)], id };
    };
    const membersOf = (g) => g.spec.variantIds.map((v) => s.items.find((it) => isObj(it) && isObj(it.display) && String(idOf(it)) === String(v)));
    const optionOf = (g, name) => {
      const o = rowOf(name);
      if (!o || !g.spec.variantIds.some((v) => String(v) === String(idOf(o)))) fail('choice_option_missing', `${JSON.stringify(name)} is not an option of this group`, { key: name });
      return o;
    };
    const composed = (l, choice) => `${l.display.name} - ${choice}`;
    const order = () => (Array.isArray(st.item_order) ? st.item_order : (st.item_order = []));
    const placeAfter = (afterId, id) => { const o = order(); const j = o.indexOf(afterId); if (j === -1) o.push(id); else o.splice(j + 1, 0, id); };
    const dropOrder = (id) => { const o = order(); const j = o.indexOf(id); if (j !== -1) o.splice(j, 1); };
    const orderIdOf = (row) => (has(row, 'ref') ? row.ref : row.key);
    const removeRow = (row) => {
      const stamp = row.display && row.display.identity_id;
      if (typeof stamp === 'string' && stamp) deletedIds.push(stamp);
      s.items.splice(s.items.indexOf(row), 1);
      dropOrder(orderIdOf(row));
    };
    const newOption = (l, lid, o) => {
      if (!isObj(o) || typeof o.ref !== 'string' || !REF_RE.test(o.ref)) fail('addition_malformed', 'a new option needs a temporary reference', { field: 'choices' });
      if (rowOf(o.ref)) fail('addition_malformed', `the reference ${o.ref} is already used`, { ref: o.ref, field: 'choices' });
      const choice = typeof o.choice === 'string' ? o.choice : '';
      const price = Number.isInteger(o.price) && o.price > 0 ? o.price : null;
      return { ref: o.ref, price, display: { variantOf: lid, choice, name: composed(l, choice), price } };
    };
    const setRecommended = (g, chosen) => {
      for (const m of membersOf(g)) {
        if (!m) continue;
        const tags = Array.isArray(m.display.tags) ? m.display.tags.filter((t) => t !== TAG) : [];
        if (m === chosen) tags.push(TAG);
        if (tags.length) m.display.tags = tags; else delete m.display.tags;
      }
    };

    switch (op.op) {
      case 'choice.label': {
        const g = groupOf(op.launcher);
        g.spec.label = typeof op.label === 'string' ? op.label : '';
        break;
      }
      case 'option.rename': {
        const o = rowOf(op.key);
        const lid = o && isObj(o.display) ? o.display.variantOf : undefined;
        const l = lid == null ? null : s.items.find((it) => isObj(it) && isObj(it.display) && String(idOf(it)) === String(lid));
        if (!o || !l) fail('choice_option_missing', `${JSON.stringify(op.key)} is not an option`, { key: op.key });
        o.display.choice = typeof op.choice === 'string' ? op.choice : '';
        o.display.name = composed(l, o.display.choice);
        break;
      }
      case 'option.add': {
        const g = groupOf(op.launcher);
        const members = membersOf(g);
        const row = newOption(g.l, g.id, op);
        s.items.push(row);
        const last = members.length ? members[members.length - 1] : g.l;
        placeAfter(orderIdOf(last), row.ref);
        g.spec.variantIds.push(row.ref);
        break;
      }
      case 'option.remove': {
        const o = rowOf(op.key);
        const lid = o && isObj(o.display) ? o.display.variantOf : undefined;
        const l = lid == null ? null : s.items.find((it) => isObj(it) && isObj(it.display) && String(idOf(it)) === String(lid));
        if (!o || !l) fail('choice_option_missing', `${JSON.stringify(op.key)} is not an option`, { key: op.key });
        const g = groupOf(has(l, 'ref') ? l.ref : l.key);
        if (g.spec.variantIds.length <= 2) fail('choices_too_few', 'a required choice needs at least 2 options — remove the choice instead', { key: op.key, field: 'choices' });
        g.spec.variantIds = g.spec.variantIds.filter((v) => String(v) !== String(idOf(o)));
        removeRow(o);
        break;
      }
      case 'choice.recommended': {
        const g = groupOf(op.launcher);
        setRecommended(g, optionOf(g, op.option));
        break;
      }
      case 'choice.add': {
        const l = rowOf(op.key);
        if (!l || !isObj(l.display) || l.display.variantOf != null) fail('choice_dish_missing', `${JSON.stringify(op.key)} is not a dish`, { key: op.key });
        const lid = idOf(l);
        if (map() && has(map(), String(lid))) fail('choice_group_exists', 'this dish already has a choice', { key: op.key });
        const opts = Array.isArray(op.options) ? op.options : [];
        if (opts.length < 2) fail('choices_too_few', 'a required choice needs at least 2 options', { key: op.key, field: 'choices' });
        if (!map()) st.variant_items = {};
        const spec = { label: typeof op.label === 'string' ? op.label : '', variantIds: [] };
        st.variant_items[String(lid)] = spec;
        let after = orderIdOf(l);
        opts.forEach((o, i) => {
          const row = newOption(l, lid, i === 0 && !(Number.isInteger(o && o.price) && o.price > 0) ? { ...o, price: l.price } : o);
          s.items.push(row);
          placeAfter(after, row.ref); after = row.ref;
          spec.variantIds.push(row.ref);
        });
        setRecommended({ l, spec, id: lid }, rowOf(opts[0].ref));
        break;
      }
      case 'choice.remove': {
        const g = groupOf(op.launcher);
        const from = optionOf(g, op.price_from);
        if (!(Number.isInteger(from.price) && from.price > 0)) fail('choice_price_from_invalid', 'the price must come from an option with a price', { key: op.price_from, field: 'price_from' });
        const price = from.price;
        for (const m of membersOf(g)) if (m) removeRow(m);
        delete st.variant_items[String(g.id)];
        if (!Object.keys(st.variant_items).length) delete st.variant_items;   // the map goes back to ABSENT when it empties (the drawer's dropGroup rule)
        g.l.price = price;
        g.l.display.price = price;
        break;
      }
      default: fail('unknown_op', `unknown op ${JSON.stringify(op.op)}`);
    }
    return { source: s, deletedIds };
  }

  const api = { apply, TAG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChoiceTransitions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
