// Customer app S1 (PLAN-capp-S1.FINAL §2; NOTE-cart-instance-model.md) — ONE per-dish-INSTANCE cart for every restaurant.
// Pure, UMD, brand-agnostic (no restaurant id or name in this file — guarded).
//
//   line   = { key, qty, ex[0..qty-1], added }  — key = the dish's served dish_id (capp-menu keyOf); ex[i] = { extraKey: 1 }
//   group  = the instances of one line that share a configuration signature (sorted extra keys) — DERIVED, never stored
//   S1 extras are TOGGLES only: a selection is { extraKey: 1 }; any other quantity, or an extra the menu does not offer to the
//   dish (unknown / unsupported / not eligible), is refused on every write and makes a restored line unavailable.
//   ONE quantity write point (setQty) pads with {} / truncates / re-indexes, so no instance ≥ qty ever exists.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappCart = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const sigOf = (inst) => Object.keys(inst || {}).sort().join(',');
  const instOf = (keys) => { const o = {}; for (const k of [...keys].sort()) o[k] = 1; return o; };
  const err = (code, detail) => { const e = new Error(detail ? `${code}: ${detail}` : code); e.code = code; return e; };

  function createCart(menu) {
    if (!menu || typeof menu.dish !== 'function') throw new Error('capp-cart: a capp-menu model is required');
    const lines = new Map();
    let seq = 0;

    // the configuration a dish may legally carry (S1: toggles of the extras the menu offers THIS dish)
    function validConfig(key, keys) {
      const allowed = new Map(menu.extrasFor(key).map((e) => [e.key, e]));
      for (const k of keys) {
        const e = allowed.get(String(k));
        if (!e) throw err('extra_not_offered', `${k} on ${key}`);
        if (!e.supported) throw err('unsupported_extra_quantity', String(k));
      }
      return [...new Set(keys.map(String))].sort();
    }
    function orderable(key) {
      const d = menu.dish(key);
      if (!d) throw err('unknown_dish', String(key));
      if (d.launcher) throw err('choice_required', String(key));
      return d;
    }
    function lineFor(key) {
      let l = lines.get(key);
      if (!l) { l = { key, qty: 0, ex: [], added: ++seq }; lines.set(key, l); }
      return l;
    }
    // THE single quantity write point: pad with plain instances, truncate, delete at 0
    function setQty(key, qty) {
      const l = lines.get(String(key));
      if (!l) return;
      const q = Math.max(0, Math.min(50, qty | 0));
      if (q === 0) { lines.delete(l.key); return; }
      const ex = l.ex.slice(0, q);
      while (ex.length < q) ex.push({});
      l.ex = ex; l.qty = q;
    }
    // remove ONE instance at index i, re-indexing 0..qty-1 (the middle-removal case)
    function removeAt(key, i) {
      const l = lines.get(String(key));
      if (!l || i < 0 || i >= l.qty) return;
      l.ex = l.ex.filter((_, j) => j !== i);
      if (l.ex.length === 0) { lines.delete(l.key); return; }
      l.qty = l.ex.length;
    }

    const api = {
      // menu-card controls: "+" adds a plain instance, "−" drops the last instance
      inc(key) { const d = orderable(key); const l = lineFor(d.key); setQty(d.key, l.qty + 1); },
      dec(key) { const l = lines.get(String(key)); if (l) setQty(l.key, l.qty - 1); },
      // the item sheet's add: n instances of ONE configuration
      add(key, extraKeys = [], n = 1) {
        const d = orderable(key); const cfg = validConfig(d.key, extraKeys);
        const l = lineFor(d.key);
        for (let i = 0; i < n; i++) l.ex.push(instOf(cfg));
        l.qty = l.ex.length;
      },
      // cart-line controls: "+" clones that configuration, "−" removes ONE instance OF THAT configuration (its last one)
      lineInc(key, sig) {
        const l = lines.get(String(key)); if (!l) return;
        const i = l.ex.findIndex((x) => sigOf(x) === sig); if (i < 0) return;
        l.ex.push({ ...l.ex[i] }); l.qty = l.ex.length;
      },
      lineDec(key, sig) {
        const l = lines.get(String(key)); if (!l) return;
        for (let i = l.ex.length - 1; i >= 0; i--) if (sigOf(l.ex[i]) === sig) { removeAt(l.key, i); return; }
      },
      // Editar: every instance of the group is REPLACED (a fresh add × n); a choice change moves them to the target line
      edit(key, sig, extraKeys, targetKey = key) {
        const l = lines.get(String(key)); if (!l) return;
        const n = l.ex.filter((x) => sigOf(x) === sig).length; if (!n) return;
        const d = orderable(targetKey); const cfg = validConfig(d.key, extraKeys);
        l.ex = l.ex.filter((x) => sigOf(x) !== sig);
        if (l.ex.length === 0) lines.delete(l.key); else l.qty = l.ex.length;
        const t = lineFor(d.key);
        for (let i = 0; i < n; i++) t.ex.push(instOf(cfg));
        t.qty = t.ex.length;
      },
      setQty,
      // DERIVED display: lines in first-add order, groups in first-instance order
      groups() {
        const out = [];
        for (const l of [...lines.values()].sort((a, b) => a.added - b.added)) {
          const d = menu.dish(l.key); const bySig = new Map();
          l.ex.forEach((x, i) => { const s = sigOf(x); if (!bySig.has(s)) bySig.set(s, { key: l.key, sig: s, n: 0, first: i, extras: Object.keys(x).sort() }); bySig.get(s).n += 1; });
          for (const g of [...bySig.values()].sort((a, b) => a.first - b.first)) {
            const extras = g.extras.map((k) => menu.extra(k));
            const unit = d.price + extras.reduce((s, e) => s + e.price, 0);
            out.push(Object.freeze({ key: g.key, sig: g.sig, n: g.n, dish: d, extras, unitPrice: unit, total: unit * g.n, editable: !!(d.variantOf || menu.extrasFor(d.key).length) }));
          }
        }
        return out;
      },
      count() { let c = 0; for (const l of lines.values()) c += l.qty; return c; },
      subtotalCents() { return api.groups().reduce((s, g) => s + g.total * 100, 0); },
      // the raw lines in first-add order (the serializer's input) — copies, never the live state
      lines() { return [...lines.values()].sort((a, b) => a.added - b.added).map((l) => ({ key: l.key, qty: l.qty, ex: l.ex.map((x) => ({ ...x })), added: l.added })); },
      snapshot() { return { v: 2, lines: api.lines() }; },
      // restore: a line that no longer fits the menu (unknown dish, a launcher, an extra not offered / unsupported / not a 1)
      // is DROPPED and counted (the prototype's «N platos ya no están disponibles»); never silently re-priced
      hydrate(snap) {
        lines.clear(); seq = 0; let dropped = 0;
        const src = snap && snap.v === 2 && Array.isArray(snap.lines) ? snap.lines : [];
        for (const raw of src.slice().sort((a, b) => (a.added | 0) - (b.added | 0))) {
          try {
            const d = orderable(raw.key);
            const ex = Array.isArray(raw.ex) ? raw.ex : [];
            if (!Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty !== ex.length) throw err('bad_line');
            const inst = ex.map((x) => { const ks = Object.keys(x || {}); if (ks.some((k) => x[k] !== 1)) throw err('unsupported_extra_quantity'); return instOf(validConfig(d.key, ks)); });
            lines.set(d.key, { key: d.key, qty: inst.length, ex: inst, added: ++seq });
          } catch (_) { dropped += (raw && Number.isInteger(raw.qty) && raw.qty > 0) ? raw.qty : 1; }
        }
        return { dropped };
      },
    };
    return api;
  }

  // a LEGACY form snapshot ({ lines } = form-cart.js snapshot v:1 lines [{key,qty,added}], { extras } = the form's pizzaExtras) —
  // a line's extras, per instance ({ inst: { legacyExtra: 1 } }) or line-level ({ legacyExtra: qty }), are kept per instance or
  // go to INSTANCE 0 when line-level (the total is unchanged); the result is a v:2 snapshot for hydrate, which then refuses what
  // S1 cannot carry (a quantity ≠ 1 → the line is dropped and counted). The mappers turn old keys into the menu's keys.
  function fromLegacy(legacy, legacyKeyToDish, legacyExtraToKey = (k) => k) {
    const out = { v: 2, lines: [] };
    const ls = legacy && Array.isArray(legacy.lines) ? legacy.lines : [];
    const ext = (legacy && legacy.extras) || {};
    ls.forEach((l, i) => {
      const key = legacyKeyToDish(l.key);
      const qty = Number(l.qty) | 0;
      if (!key || qty < 1) return;
      const ex = Array.from({ length: qty }, () => ({}));
      const raw = ext[l.key] || {};
      const perInstance = Object.keys(raw).length > 0 && Object.keys(raw).every((k) => /^\d+$/.test(k) && raw[k] && typeof raw[k] === 'object');
      const remap = (o) => { const r = {}; for (const [k, q] of Object.entries(o || {})) if (q) r[legacyExtraToKey(k) || `?${k}`] = q; return r; };
      if (perInstance) { for (const [k, v] of Object.entries(raw)) if (Number(k) < qty) ex[Number(k)] = remap(v); }
      else if (Object.keys(raw).length) ex[0] = remap(raw);
      out.lines.push({ key, qty, ex, added: Number.isFinite(l.added) ? l.added : i + 1 });
    });
    return out;
  }

  return { createCart, fromLegacy, sigOf };
});
