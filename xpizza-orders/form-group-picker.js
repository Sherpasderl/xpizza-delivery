"use strict";
// ── form-group-picker — THE ONE REQUIRED-CHOICE PICKER, shared by every order form (1D add-product B, rev 6) ────────
//
// GROUP_PICKER_V1 — the platform RENDER capability is GENERATED from this marker (tools/generate-renderer-contract.js):
// only when every shipped form loads this module may the server treat a bare launcher as non-orderable.
//
// A required-choice GROUP is a LAUNCHER dish plus N priced VARIANT dishes (`variantOf`, `choice`) and a variant map
// `VARIANT_ITEMS[launcherId] = { label, variantIds, basePrice }`. Everything here is a RULE, identical for every brand:
// how a dish id is compared, what makes a launcher, whether a variant map is renderable, the choice rows, and what the
// commit button may do. A form keeps only PRESENTATION (its photo, theme, copy tokens) — never a price or choice rule.
//
// Same bytes load as a classic browser script AND a Node module (no ESM), like the other shared form modules.

const GROUP_PICKER_V1 = 1;

// ONE dish-identity comparison: strict WITHIN a type, never coerced. la_musa ids are strings, x_pizza ids are numbers;
// "123" and 123 are different dishes, so a map that mixes them is caught instead of silently matching nothing.
function sameDishId(a, b) {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "number" && typeof b === "number") return isFinite(a) && a === b;
  return false;
}

function isLauncher(p, variantItems) { return !!(p && variantItems && variantItems[p.id]); }
function isVariant(p) { return !!(p && p.variantOf); }

/* A variant map the renderer can draw, judged against the dishes ARRIVING with it (a map is a set of references into
   the dish list). Throws with a typed reason; the error strings are the form's established apply-rejection codes. */
function validateVariantBlock(vi, dishes, origin) {
  if (!vi || typeof vi !== "object" || Array.isArray(vi)) throw new Error("apply_variant_items_malformed@" + origin);
  Object.keys(vi).forEach(function (k) {
    const cfg = vi[k];
    if (!cfg || typeof cfg !== "object") throw new Error("apply_variant_cfg_malformed@" + origin + ":" + k);
    if (!(typeof cfg.basePrice === "number" && isFinite(cfg.basePrice) && cfg.basePrice > 0)) throw new Error("apply_variant_basePrice@" + origin + ":" + k);
    if (!Array.isArray(cfg.variantIds) || !cfg.variantIds.length) throw new Error("apply_variant_ids_missing@" + origin + ":" + k);
    cfg.variantIds.forEach(function (vid) {
      if (typeof vid !== "string" || !vid) throw new Error("apply_variant_id_type@" + origin + ":" + k + ":" + String(vid));
      if (!dishes.some(function (d) { return sameDishId(d.id, vid); })) throw new Error("apply_variant_id_orphan@" + origin + ":" + k + ":" + vid);
    });
    if (!dishes.some(function (d) { return sameDishId(d.id, k); })) throw new Error("apply_variant_launcher_orphan@" + origin + ":" + k);
  });
}

/* ── THE PRICE RULE (rev 6 §0c.3 / §0d.2) — identical for every restaurant ─────────────────────────────────────────
   Everything is DERIVED from the choices' own prices; a launcher's stored price (and any authored basePrice) is legacy,
   non-chargeable data and is never an input. */
function choicePrices(cfg, menu) {
  return (cfg.variantIds || []).map(vid => menu.find(p => sameDishId(p.id, vid)))
    .filter(v => v && typeof v.price === "number" && isFinite(v.price) && v.price > 0).map(v => v.price);
}
function priceRange(cfg, menu) {
  const ps = choicePrices(cfg, menu);
  return ps.length ? { min: Math.min.apply(null, ps), max: Math.max.apply(null, ps) } : null;
}
// card / header: "L {min}" when every choice costs the same, else "desde L {min}"; null = nothing renderable
function priceText(cfg, menu) {
  const r = priceRange(cfg, menu);
  return r ? (r.min === r.max ? "L " + r.min : "desde L " + r.min) : null;
}
// a choice row's amount: the delta above the cheapest choice, or nothing (the cheapest, or all equal)
function choiceDelta(v, range) { const d = range ? v.price - range.min : 0; return d > 0 ? d : null; }
// the disabled commit prompt, derived from the group label: "Elegí tu {label en minúscula}"
function promptText(cfg) { return "Elegí tu " + String(cfg.label).toLocaleLowerCase("es"); }

/* The required single-select group: its label row and one row per choice. Text reaches the page only through the
   form's own escapers (escapeHtml for body text, safeText for the data-id attribute). */
function choiceRowsHtml(opts) {
  const cfg = opts.cfg, menu = opts.menu, stagedId = opts.stagedId, escapeHtml = opts.escapeHtml, safeText = opts.safeText;
  const range = priceRange(cfg, menu);
  let html = `<div class="detail-cat-label">${escapeHtml(cfg.label)} <span class="detail-req">· Requerido</span></div>`;
  html += `<div class="detail-extras-list">`;
  cfg.variantIds.forEach(vid => {
    const v = menu.find(p => sameDishId(p.id, vid)); if (!v) return;
    const delta = choiceDelta(v, range);
    const sel = stagedId === vid;
    html += `<div class="detail-variant-row${sel ? ' sel' : ''}" data-act="variant" data-id="${safeText(vid)}">
      <div><span class="detail-extras-name">${escapeHtml(v.choice)}</span>${delta !== null ? `
      <span class="detail-extras-price">+L ${delta}</span>` : ''}</div>
      <span class="detail-variant-radio"></span>
    </div>`;
  });
  html += `</div>`;
  return html;
}

/* What the commit button may do for an open launcher:
   { kind: 'choose' }            nothing chosen yet — disabled
   { kind: 'soldout' }           the chosen choice is sold out — disabled
   { kind: 'add', total }        commit the chosen choice; total = its price + the staged extras */
function ctaDecision(opts) {
  const stagedId = opts.stagedId;
  if (!stagedId) return { kind: "choose" };
  const v = opts.menu.find(p => p.id === stagedId);
  if (v && typeof opts.isSoldOut === "function" && opts.isSoldOut(v)) return { kind: "soldout" };
  const staged = opts.stagedExtras || {};
  const extrasSum = Object.keys(staged).reduce((s, eid) => {
    const e = opts.extras.find(x => x.id === eid); return s + (e ? e.price * staged[eid] : 0);
  }, 0);
  return { kind: "add", total: (v ? v.price : 0) + extrasSum };
}

const GroupPicker = { GROUP_PICKER_V1, sameDishId, isLauncher, isVariant, validateVariantBlock, priceRange, priceText, choiceDelta, promptText, choiceRowsHtml, ctaDecision };
if (typeof module !== "undefined" && module.exports) module.exports = GroupPicker;
if (typeof window !== "undefined") { window.GroupPicker = GroupPicker; }
