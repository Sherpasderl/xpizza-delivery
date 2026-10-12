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
   the dish list). Throws with a typed reason; the error strings are the form's established apply-rejection codes.
   A GROUP IS ONE ID NAMESPACE: its choice ids are all strings or all finite numbers (whatever the brand's dish ids
   are), each resolved strictly; the launcher KEY — a JSON key, so always a string — resolves only to a dish whose id
   has that SAME type. So x_pizza's numeric group { "30": { variantIds: [31, 32] } } is drawable, while a key or an id
   that matches only after coercion (a numeric dish under a string group, "7" vs 7) is still refused. */
const idTypeOf = (id) => (typeof id === "string" && id !== "") ? "string" : (typeof id === "number" && isFinite(id)) ? "number" : null;
function validateVariantBlock(vi, dishes, origin) {
  if (!vi || typeof vi !== "object" || Array.isArray(vi)) throw new Error("apply_variant_items_malformed@" + origin);
  Object.keys(vi).forEach(function (k) {
    const cfg = vi[k];
    if (!cfg || typeof cfg !== "object") throw new Error("apply_variant_cfg_malformed@" + origin + ":" + k);
    if (!(typeof cfg.basePrice === "number" && isFinite(cfg.basePrice) && cfg.basePrice > 0)) throw new Error("apply_variant_basePrice@" + origin + ":" + k);
    if (!Array.isArray(cfg.variantIds) || !cfg.variantIds.length) throw new Error("apply_variant_ids_missing@" + origin + ":" + k);
    const groupType = idTypeOf(cfg.variantIds[0]);
    cfg.variantIds.forEach(function (vid) {
      if (!groupType || idTypeOf(vid) !== groupType) throw new Error("apply_variant_id_type@" + origin + ":" + k + ":" + String(vid));
      if (!dishes.some(function (d) { return sameDishId(d.id, vid); })) throw new Error("apply_variant_id_orphan@" + origin + ":" + k + ":" + vid);
    });
    if (!dishes.some(function (d) { return typeof d.id === groupType && String(d.id) === k; })) throw new Error("apply_variant_launcher_orphan@" + origin + ":" + k);
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

/* ── THE CHOICE ROWS, AS DATA ─────────────────────────────────────────────────────────────────────────────────────
   One entry per RESOLVED choice, in the group's order (an unresolvable id renders nothing). Each form draws these in its
   own markup (a brand slot); WHAT a row says — its label, its amount, whether it is chosen, whether it is recommended —
   is decided here, once. */
const RECOMMENDED_LABEL = "Recomendada";
function isRecommended(v) { return !!(v && Array.isArray(v.tags) && v.tags.indexOf("recommended") !== -1); }
function choiceRows(cfg, menu, stagedId) {
  const range = priceRange(cfg, menu);
  const rows = [];
  (cfg.variantIds || []).forEach(vid => {
    const v = menu.find(p => sameDishId(p.id, vid)); if (!v) return;
    rows.push({ id: vid, choice: v.choice, delta: choiceDelta(v, range), selected: stagedId === vid, recommended: isRecommended(v) });
  });
  return rows;
}

/* ── EXTRAS POLICY (rev 6 §0b.7) — one source field, `extras_policy: 'none'`, stamped on a group's launcher AND every
   choice. Absent = today's behaviour. Any other value is a snapshot the form refuses whole. */
function noExtras(item) { return !!(item && item.extras_policy === "none"); }
function validateExtrasPolicy(dishes) {
  dishes.forEach(function (d, i) {
    if (d && Object.prototype.hasOwnProperty.call(d, "extras_policy") && d.extras_policy !== "none") throw new Error("apply_dish_extras_policy@" + i);
  });
}

/* ── REWARDS (rev 6 §0d.1, owner 2026-10-10) — the reward list offers ORDERABLE dishes only: a group appears as its CHOICES,
   each its own reward row; the bare launcher never does. `isEligible` is the brand's eligibility DATA (its categories,
   its exclusions); this adds the one group rule, identically for every restaurant. */
function rewardDishes(menu, variantItems, isEligible) {
  return menu.filter(p => isEligible(p) && !isLauncher(p, variantItems));
}

/* ── WHOLE-DISH AVAILABILITY (rev 6 §0d.4) — a choice is available iff the choice AND its launcher are. `ownSoldOut` is
   the form's own per-record reader (its keys, its fail-open rule); this only adds the parent. */
function parentOf(item, menu) { return item && item.variantOf !== undefined ? menu.find(p => sameDishId(p.id, item.variantOf)) || null : null; }
function soldOutWithParent(item, menu, ownSoldOut) {
  if (ownSoldOut(item)) return true;
  const parent = parentOf(item, menu);
  return !!(parent && ownSoldOut(parent));
}

/* ── A BARE LAUNCHER IS NEVER A CART LINE (rev 6 §0d.1 / §0d.3) — only its chosen choice is. A launcher line can still
   arrive: a cart saved before its group (payment return, self-update reload) or a dish that became a launcher while it
   sat in the cart. Every such line is BLOCKED with reason 'choice', so the send gate and buildOrder refuse it, and the
   customer is told to choose again — the same rule, the same words, on every form. */
function markLauncherLines(lines, variantItems) {
  return lines.map(l => (isLauncher({ id: l.key }, variantItems) ? Object.assign({}, l, { unresolved: "choice", blocked: true }) : l));
}
function launcherKeys(keys, variantItems) { return keys.filter(k => isLauncher({ id: k }, variantItems)); }
// `names`: [{ key, name }] — a cart key IS the variant map's key (both are the id as a string), so the label reads directly
function reChooseText(names, variantItems) {
  return names.map(n => {
    const cfg = variantItems[n.key];
    const label = cfg && cfg.label ? String(cfg.label).toLocaleLowerCase("es") : "opción";
    return "Elegí de nuevo tu " + label + " para " + n.name + ".";
  }).join(" ");
}

/* ── KEYBOARD (codex PB-2 r1 P2-6) — each choice row carries a NATIVE radio: one group name per launcher, the checked state,
   an accessible name (the choice, its tag, its amount). It is visually hidden inside the row (the mock's look is the
   row's own radio dot), and focusable, so Tab reaches the group, the arrows move the choice, Space and Enter choose,
   and the commit button then enables. The pointer path is unchanged (the row's own click). One implementation, every
   form. `esc` is the form's text escaper. */
const CHOICE_INPUT_CLASS = "choice-radio";
function choiceInputHtml(r, launcherId, esc) {
  const name = r.choice + (r.recommended ? " · " + RECOMMENDED_LABEL : "") + (r.delta !== null ? " · +L " + r.delta : "");
  return '<input type="radio" class="' + CHOICE_INPUT_CLASS + '" name="choice-' + esc(String(launcherId)) + '" value="' + esc(String(r.id))
    + '" aria-label="' + esc(name) + '"' + (r.selected ? " checked" : "") + ">";
}
// a choice re-render replaces the row markup; a keyboard user's focus returns to the checked radio (else the arrows stop)
function choiceHasFocus(doc) { const a = doc.activeElement; return !!(a && a.classList && a.classList.contains(CHOICE_INPUT_CLASS)); }
function refocusChoice(doc, hadFocus) {
  if (!hadFocus) return;
  const el = doc.querySelector("input." + CHOICE_INPUT_CLASS + ":checked") || doc.querySelector("input." + CHOICE_INPUT_CLASS);
  if (el) el.focus();
}
// attached once at boot: `onChoose(rawValue)` — the form resolves the value to its dish id (its own id types)
function wireChoiceKeys(doc, onChoose) {
  if (doc.__choiceKeysWired) return;
  doc.__choiceKeysWired = true;
  const isChoice = t => !!(t && t.classList && t.classList.contains(CHOICE_INPUT_CLASS));
  doc.addEventListener("change", ev => { if (isChoice(ev.target) && ev.target.checked) onChoose(ev.target.value); });
  doc.addEventListener("keydown", ev => { if (isChoice(ev.target) && ev.key === "Enter") { ev.preventDefault(); onChoose(ev.target.value); } });
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

const GroupPicker = { GROUP_PICKER_V1, RECOMMENDED_LABEL, sameDishId, isLauncher, isVariant, validateVariantBlock, priceRange, priceText, choiceDelta,
  promptText, isRecommended, choiceRows, noExtras, validateExtrasPolicy, rewardDishes, parentOf, soldOutWithParent, ctaDecision,
  markLauncherLines, launcherKeys, reChooseText, CHOICE_INPUT_CLASS, choiceInputHtml, choiceHasFocus, refocusChoice, wireChoiceKeys };
if (typeof module !== "undefined" && module.exports) module.exports = GroupPicker;
if (typeof window !== "undefined") { window.GroupPicker = GroupPicker; }
