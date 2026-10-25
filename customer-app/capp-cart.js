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

  const MAX_QTY = 50;   // the server's per-line cap (menu-pricing qty 1..50) — ONE policy for every write: over it, refused
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
    // the line for a dish — a NEW one is only registered by put() (so a refused write never leaves an empty line behind)
    function lineFor(key) { return lines.get(key) || { key, qty: 0, ex: [], added: seq + 1 }; }
    const claim = (l) => { if (l.added > seq) seq = l.added; };
    // THE single write point: every change to a line's instances lands here. Over MAX_QTY → refused, the cart unchanged (so a
    // "+" never reduces a quantity); an empty instance list deletes the line; qty is always ex.length (no instance ≥ qty).
    function put(l, ex) {
      if (ex.length > MAX_QTY) throw err('qty_limit', `${l.key} ${ex.length} > ${MAX_QTY}`);
      if (ex.length === 0) { lines.delete(l.key); return; }
      if (!lines.has(l.key)) lines.set(l.key, l);
      l.ex = ex; l.qty = ex.length;
    }
    // every REQUESTED quantity is validated BEFORE any coercion or allocation: an integer within [lo, MAX_QTY], else refused
    // with the cart unchanged (no `| 0` wrap-around, no huge array ever built)
    function wantQty(n, lo) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > MAX_QTY) throw err('qty_limit', String(n));
      return n;
    }
    // pad with plain instances / truncate to qty
    function setQty(key, qty) {
      const q = wantQty(qty, 0);
      const l = lines.get(String(key));
      if (!l) return;
      const ex = l.ex.slice(0, q);
      while (ex.length < q) ex.push({});
      put(l, ex);
    }
    // remove ONE instance at index i, re-indexing 0..qty-1 (the middle-removal case)
    function removeAt(key, i) {
      const l = lines.get(String(key));
      if (!l || i < 0 || i >= l.qty) return;
      put(l, l.ex.filter((_, j) => j !== i));
    }

    const api = {
      // menu-card controls: "+" adds a plain instance, "−" drops the last instance
      inc(key) { const d = orderable(key); const l = lineFor(d.key); put(l, [...l.ex, {}]); claim(l); },
      dec(key) { const l = lines.get(String(key)); if (l) setQty(l.key, l.qty - 1); },
      // the item sheet's add: n instances of ONE configuration
      add(key, extraKeys = [], n = 1) {
        const d = orderable(key); const cfg = validConfig(d.key, extraKeys);
        const l = lineFor(d.key);
        wantQty(n, 1); wantQty(l.qty + n, 1);   // both checked before a single instance is allocated
        put(l, [...l.ex, ...Array.from({ length: n }, () => instOf(cfg))]); claim(l);
      },
      // cart-line controls: "+" clones that configuration, "−" removes ONE instance OF THAT configuration (its last one)
      lineInc(key, sig) {
        const l = lines.get(String(key)); if (!l) return;
        const i = l.ex.findIndex((x) => sigOf(x) === sig); if (i < 0) return;
        put(l, [...l.ex, { ...l.ex[i] }]);
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
        const kept = l.ex.filter((x) => sigOf(x) !== sig);
        const sameLine = d.key === l.key;
        const t = sameLine ? l : lineFor(d.key);
        const moved = [...(sameLine ? kept : t.ex), ...Array.from({ length: n }, () => instOf(cfg))];
        if (moved.length > MAX_QTY) throw err('qty_limit', `${d.key} ${moved.length} > ${MAX_QTY}`);   // checked BEFORE any write
        if (!sameLine) put(l, kept);
        put(t, moved); claim(t);
      },
      setQty,
      // the sheet dresses ONE instance: its configuration replaced by extraKeys (validated; the single write point)
      setInstance(key, i, extraKeys) {
        const l = lines.get(String(key)); if (!l) return;
        if (!Number.isInteger(i) || i < 0 || i >= l.qty) throw err('bad_instance', String(i));
        const cfg = validConfig(l.key, extraKeys);
        put(l, l.ex.map((x, j) => (j === i ? instOf(cfg) : x)));
      },
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
            wantQty(raw.qty, 1);   // validated before the instances are read
            if (raw.qty !== ex.length) throw err('bad_line');
            const inst = ex.map((x) => { const ks = Object.keys(x || {}); if (ks.some((k) => x[k] !== 1)) throw err('unsupported_extra_quantity'); return instOf(validConfig(d.key, ks)); });
            const l = lineFor(d.key); put(l, [...l.ex, ...inst]); claim(l);   // the ONE write point (a repeated key merges, bounded by MAX_QTY)
          } catch (_) { dropped += (raw && Number.isInteger(raw.qty) && raw.qty > 0 && raw.qty <= MAX_QTY) ? raw.qty : 1; }   // an out-of-range quantity counts as ONE unavailable line
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

  return { createCart, fromLegacy, sigOf, MAX_QTY };
});
