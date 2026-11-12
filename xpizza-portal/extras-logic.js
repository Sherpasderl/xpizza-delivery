// STRUCTURE S2 — the «Extras» page's MODEL (PLAN-portal-structure-S2-ui r3 §2 items 2–3; MOCKUP-portal-structure-edit frame X). Pure:
// a reader of the draft, never a writer (every Extras-page write goes through editor.js applyExposureOps / setExtraPrice).
//   rail    every group in the ONE order (structure.extra_categories), its extras count, «en N productos» = the SERVER's reach rule
//           (catalog/review-diff.js: the launchers whose EFFECTIVE groups include it — 5f's writer's effectiveGroups over THE ONE
//           eligibility projection, the portal's byte copies)
//   detail  the selected group's rows — a published extra by { key }, a new (keyless) one by { ref } with «Nuevo», a changed price
//           marked, an extra removed in this draft still listed (greyed, «Se quita al publicar») — its count, reach and shared warning
// Names are TEXT in S2-core (renames come with S2b).
import { draftSource, attachRefusal } from './editor.js';

const groupsOf = (src) => (src && src.structure && Array.isArray(src.structure.extra_categories) ? src.structure.extra_categories.map(String) : []);
const extrasOf = (src) => (src && Array.isArray(src.extras) ? src.extras.filter((e) => e && e.display) : []);
const idOf = (e) => (typeof e.key === 'string' ? { key: e.key } : { ref: e.ref });

// group → the number of launchers it is offered on (null when the shared evaluator / writer is not loaded: nothing is guessed)
function reachOf(src) {
  const E = globalThis.ExtrasEligibility, X = globalThis.ExposureTransitions;
  if (!E || typeof E.projectEligibility !== 'function' || !X || typeof X.effectiveGroups !== 'function') return null;
  try {
    const P = E.projectEligibility(src), eff = X.effectiveGroups(P), out = new Map();
    for (const [k, gs] of Object.entries(eff)) {
      if (P.items[k].launcherKey || !Array.isArray(gs)) continue;
      for (const g of gs) out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  } catch (_) { return null; }
}

export function extrasPageModel(draft, { group = null } = {}) {
  const src = draftSource(draft), orig = draft && draft.orig;
  const groups = groupsOf(src);
  const reach = reachOf(src);
  const xs = extrasOf(src);
  const rail = groups.map((g) => ({ group: g, count: xs.filter((e) => String(e.display.cat) === g).length, reach: reach ? (reach.get(g) || 0) : null }));
  const selected = groups.includes(group) ? group : (groups[0] || null);
  let detail = null;
  if (selected !== null) {
    const was = new Map(extrasOf(orig).filter((e) => typeof e.key === 'string').map((e) => [e.key, e]));
    const rows = xs.filter((e) => String(e.display.cat) === selected).map((e) => {
      const isNew = typeof e.key !== 'string';
      const before = isNew ? null : was.get(e.key);
      return { id: idOf(e), name: e.display.name, price: e.price, isNew, priceChanged: !!before && before.price !== e.price, removed: false };
    });
    const present = new Set(xs.filter((e) => typeof e.key === 'string').map((e) => e.key));
    for (const e of was.values()) {
      if (String(e.display.cat) !== selected || present.has(e.key)) continue;
      rows.push({ id: { key: e.key }, name: e.display.name, price: e.price, isNew: false, priceChanged: false, removed: true });
    }
    const n = reach ? (reach.get(selected) || 0) : null;
    detail = { group: selected, rows, count: rows.filter((r) => !r.removed).length, reach: n, shared: n !== null && n > 1 };
  }
  return { rail, selected, detail };
}

// ── X3 «Crear grupo» + X3b «A productos que elija» (MOCKUP x4b; plan r3 §2 items 5 / 5b, §3.5) ───────────────────────────────────
// The form is LOCAL state (never the draft) until «Crear grupo» builds ONE group.create op for the writer. Each mode keeps its own
// inputs; the op reads only the selected one. Eligibility is the WRITER's own dry run (editor.js attachRefusal), never a parallel rule.
export const GROUP_NAME_MAX = 40;
// the writer's refusal → the row's line (X3b and B read ONE table)
export const refusalReason = (r) => (r ? (REASON[r.reason] || null) : null);
const REASON = { none: 'Tiene «Sin extras»', deny_all: 'No ofrece extras', option_override: 'Sus opciones tienen reglas propias', unsaved: 'Guardá el producto primero' };
const chars = (x) => [...String(x)].length;
const newRef = () => {
  const c = globalThis.crypto;
  const id = c && typeof c.randomUUID === 'function' ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`.padEnd(12, '0');
  return `tmp:${id}`;
};
const priceOf = (raw) => { const t = String(raw ?? '').trim(); return /^\d+$/.test(t) ? Number(t) : null; };

// ONE row rule (R6) for X3's extra rows and the detail's inline «Agregar extra» row: a row with neither name nor price is not started
// (ignored); a started row needs a name and a whole price ≥ L 1
export function extraRowCheck(r) {
  const name = String((r && r.name) ?? ''), raw = String((r && r.raw) ?? '');
  const started = name.trim() !== '' || raw.trim() !== '';
  const p = priceOf(raw);
  const nameError = started && !name.trim() ? 'Escribí el nombre.' : null;
  const priceError = started && (p === null || p < 1) ? 'El precio debe ser al menos L 1.' : null;
  return { started, nameError, priceError, complete: started && !nameError && !priceError };
}
// «Agregar extra» (plan §2 item 3, §3.5 row 2): the inline row is LOCAL state { group, ref, name, raw } until it commits ONE extra.add
export function addExtraRow(group) { return { group: String(group), ref: newRef(), name: '', raw: '' }; }
export function addExtraOp(r) {
  if (!r || !extraRowCheck(r).complete) return null;
  return { op: 'extra.add', group: r.group, ref: r.ref, name: r.name.replace(/\s+/g, ' ').trim(), price: priceOf(r.raw) };
}

export function createGroupForm() {
  return { name: '', rows: [{ ref: newRef(), name: '', raw: '' }], mode: 'none', cat: null, marked: [] };
}
// one change → a NEW form (the caller keeps it); unknown fields change nothing
export function setCreateField(f, field, v) {
  const n = { ...f, rows: f.rows.map((r) => ({ ...r })), marked: f.marked.slice() };
  if (field === 'name') n.name = typeof v === 'string' ? v : '';
  else if (field === 'row' && v && n.rows[v.i]) { if ('name' in v) n.rows[v.i].name = String(v.name ?? ''); if ('raw' in v) n.rows[v.i].raw = String(v.raw ?? ''); }
  else if (field === 'addRow') n.rows.push({ ref: newRef(), name: '', raw: '' });
  else if (field === 'removeRow' && n.rows.length > 1) n.rows.splice(v, 1);
  else if (field === 'mode' && ['none', 'cat', 'items'].includes(v)) n.mode = v;
  else if (field === 'cat') n.cat = v == null ? null : String(v);
  else if (field === 'mark' && v && typeof v.key === 'string') n.marked = v.on ? [...new Set([...n.marked, v.key])] : n.marked.filter((k) => k !== v.key);
  else if (field === 'markAll' || field === 'markNone') n.__sectionOp = { field, cat: v && v.cat };
  return n;
}
function launchersOf(src) {
  const items = Array.isArray(src.items) ? src.items : [];
  return items.filter((r) => r && r.display && r.display.variantOf == null && r.display.choice == null);
}
function sectionsOf(src, f) {
  const cats = (src.structure && Array.isArray(src.structure.categories)) ? src.structure.categories : [];
  const rows = launchersOf(src).map((r) => {
    const key = typeof r.key === 'string' ? r.key : r.ref;
    const refused = attachRefusal(src, { mode: 'items', items: [key] });
    return { key, name: r.display.name, sub: r.display.subcat || null, cat: String(r.display.cat), disabled: !!refused, reason: refusalReason(refused) };
  });
  let marked = new Set(f.marked);
  if (f.__sectionOp) {   // «Marcar todos» / «Ninguno» on one section: its ELIGIBLE rows only
    const inSec = rows.filter((r) => r.cat === String(f.__sectionOp.cat) && !r.disabled).map((r) => r.key);
    if (f.__sectionOp.field === 'markAll') inSec.forEach((k) => marked.add(k)); else inSec.forEach((k) => marked.delete(k));
  }
  marked = new Set([...marked].filter((k) => rows.some((r) => r.key === k && !r.disabled)));   // a disabled row is never marked
  const out = [];
  for (const c of cats) {
    const rs = rows.filter((r) => r.cat === String(c.id)).map((r) => ({ ...r, checked: marked.has(r.key) }));
    if (!rs.length) continue;
    const el = rs.filter((r) => !r.disabled), m = el.filter((r) => r.checked).length;
    out.push({ cat: String(c.id), name: c.name || String(c.id), rows: rs, count: `${m} de ${el.length}`, link: el.length === 0 ? null : (m === el.length ? 'Ninguno' : 'Marcar todos') });
  }
  return { sections: out, marked: [...marked] };
}
// a form with its section op applied (the caller stores this as the new form)
export function settleForm(src, f) {
  let n = f;
  if (n.__sectionOp) { const { marked } = sectionsOf(src, n); n = { ...n, marked }; delete n.__sectionOp; }
  // category mode starts on the first section the writer accepts (the mockup preselects; there is no placeholder)
  if (n.mode === 'cat' && !n.cat) {
    const cats = (src.structure && Array.isArray(src.structure.categories)) ? src.structure.categories : [];
    const first = cats.find((c) => !attachRefusal(src, { mode: 'cat', cat: String(c.id) }));
    if (first) n = { ...n, cat: String(first.id) };
  }
  return n;
}
export function createGroupView(draft, f0) {
  const src = draftSource(draft);
  const f = settleForm(src, f0);
  const groups = src.structure && Array.isArray(src.structure.extra_categories) ? src.structure.extra_categories.map(String) : [];
  const nm = f.name.replace(/\s+/g, ' ').trim();
  const nameError = nm && groups.includes(nm) ? 'Ya hay un grupo con ese nombre.' : null;
  const rows = f.rows.map((r) => { const c = extraRowCheck(r); return { ref: r.ref, name: r.name, raw: r.raw, started: c.started, nameError: c.nameError, priceError: c.priceError }; });
  const complete = rows.filter((r) => r.started && !r.nameError && !r.priceError);
  const pick = sectionsOf(src, f);
  const cats = (src.structure && Array.isArray(src.structure.categories)) ? src.structure.categories : [];
  const categories = cats.map((c) => {
    const refused = attachRefusal(src, { mode: 'cat', cat: String(c.id) });
    const nDish = launchersOf(src).filter((r) => String(r.display.cat) === String(c.id)).length;
    const label = !refused ? `${c.name || String(c.id)} · ${nDish} ${nDish === 1 ? 'producto' : 'productos'}`
      : `${c.name || String(c.id)} · ${refused.code === 'exposure_option_override' ? 'un producto tiene opciones con reglas propias' : 'sin productos'}`;
    return { cat: String(c.id), label, disabled: !!refused };
  });
  let catNote = null;
  if (f.mode === 'cat' && f.cat) {
    const n = launchersOf(src).filter((r) => String(r.display.cat) === f.cat && attachRefusal(src, { mode: 'items', items: [r.key] })).length;
    if (n) catNote = n === 1 ? '1 producto de esta categoría no muestra extras.' : `${n} productos de esta categoría no muestran extras.`;
  }
  const markedN = pick.marked.length;
  const attachOk = f.mode === 'none' || (f.mode === 'cat' && f.cat && !(categories.find((o) => o.cat === f.cat) || {}).disabled) || (f.mode === 'items' && markedN > 0);
  return {
    name: f.name, counter: `${chars(f.name)}/${GROUP_NAME_MAX}`, nameError, rows, mode: f.mode,
    modeSub: f.mode === 'items' ? `· ${markedN} ${markedN === 1 ? 'producto' : 'productos'}` : null,
    sections: pick.sections, categories, cat: f.cat, catNote,
    canCreate: !!nm && !nameError && chars(f.name) <= GROUP_NAME_MAX && complete.length > 0 && rows.every((r) => !r.started || (!r.nameError && !r.priceError)) && attachOk,
  };
}
// the ONE op «Crear grupo» sends to the writer — the selected mode only; complete rows only; new extras by tmp ref (no key / id / stamp)
export function createGroupOp(draft, f0) {
  const src = draftSource(draft);
  const f = settleForm(src, f0);
  const extras = f.rows.filter((r) => r.name.trim() && priceOf(r.raw) !== null && priceOf(r.raw) >= 1)
    .map((r) => ({ ref: r.ref, name: r.name.replace(/\s+/g, ' ').trim(), price: priceOf(r.raw) }));
  const attach = f.mode === 'cat' ? { mode: 'cat', cat: f.cat } : f.mode === 'items' ? { mode: 'items', items: sectionsOf(src, f).marked } : { mode: 'none' };
  return { op: 'group.create', group: f.name.replace(/\s+/g, ' ').trim(), extras, attach };
}

// the published order and the draft's (the bar's «· N grupos» reads review.js movedGroups over these — the review's own rule)
export function groupOrders(draft) {
  return { was: groupsOf(draft && draft.orig), now: groupsOf(draftSource(draft)) };
}

// ── X4 / X4b — the ONE group order (plan r3 §2 item 8). Every move builds the WHOLE order (every group once), rebuilt from the
// draft's current groups on each move, so the writer's structure_changed is unreachable by construction. null = nothing to write.
export function moveGroupOrder(order, g, delta) {
  const i = order.indexOf(g), j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return null;
  const n = order.slice(); n.splice(i, 1); n.splice(j, 0, g);
  return n;
}
// the drop: `index` is the place among the OTHER groups (the dragged one taken out)
export function groupOrderTo(order, g, index) {
  if (!order.includes(g)) return null;
  const rest = order.filter((x) => x !== g);
  const at = Math.max(0, Math.min(rest.length, index));
  const n = [...rest.slice(0, at), g, ...rest.slice(at)];
  return JSON.stringify(n) === JSON.stringify(order) ? null : n;
}
// the pointer's y against the other rows' midlines → the drop index
export function dropIndexAt(mids, y) { return mids.filter((m) => m < y).length; }

// STRUCTURE S2 §5.2 — the outcome context for review.js outcomeFor: which refusal target names an EXTRA row of the draft (a new one by
// its ref, a published one by its key) and its group. Pure; precomputed, so the returned functions hold no reference to the draft.
export function extrasOutcomeCtx(draft) {
  const groupById = new Map();
  for (const e of extrasOf(draftSource(draft))) {
    const g = String(e.display.cat);
    if (typeof e.key === 'string') groupById.set(e.key, g);
    else if (typeof e.ref === 'string') groupById.set(e.ref, g);
  }
  return { isExtra: (t) => groupById.has(t), groupOf: (t) => (groupById.has(t) ? groupById.get(t) : null) };
}

// STRUCTURE S2 §5.2 REVIEW-DELETIONS (frame X2b): the FULL deletion list, by name. `ids` = the claim's identity ids (the fresh read's
// deletionClaim ∪ the refusal's existing_ids ∪ the draft's own claim); each is named from the extra row that carried it (display.identity_id —
// the published row, or a row still in the draft) with its group; an id no row carries is «Un extra que ya no está en el menú». Pure.
export function deletionRows(draft, ids) {
  const byId = new Map();
  for (const src of [draft && draft.orig, draftSource(draft)]) {
    for (const e of extrasOf(src)) { const id = e.display.identity_id; if (typeof id === 'string' && id && !byId.has(id)) byId.set(id, { name: e.display.name, group: String(e.display.cat) }); }
  }
  return [...new Set((Array.isArray(ids) ? ids : []).map(String))].sort().map((id) => (byId.has(id) ? { id, ...byId.get(id), gone: false } : { id, name: 'Un extra que ya no está en el menú', group: null, gone: true }));
}
