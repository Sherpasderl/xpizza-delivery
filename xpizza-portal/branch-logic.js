// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5) — the PURE decisions behind the branch screens: no DOM, no fetch, no
// clock of its own (every `now` is passed in). Node-tested in branch-logic.test.mjs. Copy is the approved prototype's,
// minus the r5 §2 truthfulness deltas (D1–D13).
//
// Brand-agnostic: every name, number and state comes from getMyBranches data. Nothing here names a restaurant.

export const OPS_CAPS = Object.freeze(['location.prep', 'location.pause', 'availability.set']);
const HN_OFFSET_MS = 6 * 3600 * 1000;   // America/Tegucigalpa, UTC-6 all year (no DST) — the server's isOpenAt clock
export const DAYS = Object.freeze([['mon', 'Lun'], ['tue', 'Mar'], ['wed', 'Mié'], ['thu', 'Jue'], ['fri', 'Vie'], ['sat', 'Sáb'], ['sun', 'Dom']]);
const DAY_BY_UTC = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const PREP_MIN = 5;
export const PREP_MAX = 120;
export const PREP_STEP = 5;
// The handheld's pause allowlist (the ONE list, D9) and the prototype's «Hasta» chips.
export const PAUSE_REASONS = Object.freeze(['Cocina llena', 'Falta personal', 'Problema técnico', 'Otro']);
export const PAUSE_DURS = Object.freeze([{ label: '30 min', dur_min: 30 }, { label: '1 hora', dur_min: 60 }, { label: 'Hasta que la reanude', dur_min: null }]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (b, cap) => !!(b && Array.isArray(b.caps) && b.caps.includes(cap));
export const can = has;
export const isOperational = (b) => !!(b && !b.degraded && OPS_CAPS.some((c) => has(b, c)) && isObj(b.control));
export const hasEditor = (b) => has(b, 'catalog.read_editor');

// ── time ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const local = (ms) => new Date(ms - HN_OFFSET_MS);
const pad2 = (n) => String(n).padStart(2, '0');
export function hhmm(ms) {
  if (!Number.isFinite(ms)) return '';
  const t = local(ms);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}
export function dayKeyAt(ms) { return DAY_BY_UTC[local(ms).getUTCDay()]; }
const isDay = (h) => isObj(h) && (h.open === false || (h.open === true && typeof h.start === 'string' && typeof h.end === 'string'));

// today's closing time, or null (closed today / unknown)
export function closesAt(hours, nowMs) {
  const h = isObj(hours) ? hours[dayKeyAt(nowMs)] : null;
  return isDay(h) && h.open === true ? h.end : null;
}
// the next opening, from now: { day: 'Lun'|null (null = later today), at: 'HH:MM' } or null
export function nextOpening(hours, nowMs) {
  if (!isObj(hours)) return null;
  const t = local(nowMs);
  const minsNow = t.getUTCHours() * 60 + t.getUTCMinutes();
  for (let i = 0; i < 8; i++) {
    const key = DAY_BY_UTC[(t.getUTCDay() + i) % 7];
    const h = hours[key];
    if (!isDay(h) || h.open !== true) continue;
    const [sh, sm] = h.start.split(':').map(Number);
    if (i === 0 && sh * 60 + sm <= minsNow) continue;
    return { day: i === 0 ? null : (i === 1 ? 'mañana' : DAYS.find(([k]) => k === key)[1]), at: h.start };
  }
  return null;
}

// the 7 rows of S2's «Horario por día», Monday first (the prototype's order)
export function hoursRows(hours) {
  return DAYS.map(([key, d]) => {
    const h = isObj(hours) ? hours[key] : null;
    if (isDay(h) && h.open === true) return { key, d, open: true, from: h.start, to: h.end };
    return { key, d, open: false, from: '', to: '' };
  });
}

// ── numbers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Lossless: the stored radius exactly as stored (7 → "7", 9.66 → "9.66"). Never rounded, never clamped.
export function kmText(n) { return Number.isFinite(n) ? String(n) : '—'; }
export function prepText(n) { return Number.isInteger(n) ? String(n) : 'Falta'; }
export function stepPrep(cur, dir) {
  const base = Number.isInteger(cur) ? cur : null;
  if (base === null) return 20;   // an unset prep starts from the prototype's default value, whichever button was pressed
  const next = base + (dir > 0 ? PREP_STEP : -PREP_STEP);
  return Math.min(PREP_MAX, Math.max(PREP_MIN, next));
}
export const validPrep = (n) => Number.isInteger(n) && n >= PREP_MIN && n <= PREP_MAX;
export function lastOrderText(n) { return Number.isInteger(n) ? `#${n}` : 'Sin pedidos hoy'; }

// ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const STATE_LABEL = Object.freeze({ open: 'Abierta', paused: 'Pausada', closed: 'Cerrada', inactive: 'Inactiva', unknown: 'Sin datos' });

// The card / pill / status-line model of a branch's control state (S1 cards, S2 header, S3 cards).
export function stateModel(b, nowMs) {
  const c = (b && isObj(b.control)) ? b.control : { state: 'unknown' };
  const state = Object.prototype.hasOwnProperty.call(STATE_LABEL, c.state) ? c.state : 'unknown';
  const hours = b && b.readonly ? b.readonly.hours : null;
  const out = { state, pillCls: state === 'inactive' || state === 'unknown' ? 'closed' : state, label: STATE_LABEL[state], line1: '', line2: '' };
  if (state === 'open') {
    out.line1 = 'Abierta · recibe pedidos';
    const end = closesAt(hours, nowMs);
    out.line2 = end ? `Cierra a las ${end}` : '';
  } else if (state === 'paused') {
    out.line1 = `Pausada · ${c.pause_reason || 'Manual'}`;
    const since = Number.isFinite(c.pause_since) ? `Desde las ${hhmm(c.pause_since)}` : '';
    const until = Number.isFinite(c.paused_until) ? `hasta las ${hhmm(c.paused_until)}` : 'hasta que la reanudés';
    out.line2 = since ? `${since} · ${until}` : until.charAt(0).toUpperCase() + until.slice(1);
  } else if (state === 'closed') {
    out.line1 = 'Cerrada por horario';
    const nx = nextOpening(hours, nowMs);
    out.line2 = nx ? `Abre ${nx.day ? `${nx.day} ` : ''}a las ${nx.at}` : '';
  } else if (state === 'inactive') {
    out.line1 = 'Inactiva · no recibe pedidos';
    out.line2 = '';
  } else {
    out.line1 = 'Sin datos de esta sucursal';
    out.line2 = '';
  }
  return out;
}

// prep missing → the S1/S2 callout (D2)
export const prepMissing = (b) => !!(b && b.editable && !validPrep(b.editable.prep_default_min));

// ── the S2 draft (prep is the only editable field in 1a) ──────────────────────────────────────────────────────────────
export function dirtyLabels(b, draft) {
  const out = [];
  if (draft && Object.prototype.hasOwnProperty.call(draft, 'prep_default_min') && b && b.editable && draft.prep_default_min !== b.editable.prep_default_min) out.push('preparación');
  return out;
}

// ── selection (one per page load, §5.1 / §11 A1–A2) ───────────────────────────────────────────────────────────────────
// E1 → { brands: [{brand_id, name, branches:[operational branches by name]}] }. Only operational branches are selectable;
// a stats-only (retired) branch never enters the operational scope.
export function brandsOf(e1) {
  const branches = (e1 && Array.isArray(e1.branches) ? e1.branches : []).filter(isOperational);
  const names = new Map((e1 && Array.isArray(e1.brands) ? e1.brands : []).map((b) => [b.brand_id, b.name]));
  const by = new Map();
  for (const b of branches) {
    if (!by.has(b.brand_id)) by.set(b.brand_id, []);
    by.get(b.brand_id).push(b);
  }
  const byName = (a, z) => String(a.name).localeCompare(String(z.name), 'es');
  return [...by.entries()].map(([brand_id, list]) => ({ brand_id, name: names.get(brand_id) || brand_id, branches: list.sort(byName) })).sort(byName);
}

const isOwnerOf = (brand) => brand.branches.every((b) => b.role === 'owner');

// stored = { brand_id, scope } | null (whatever sessionStorage held). → { brand_id, scope: rid|'all', locked } | null
export function resolveSelection(e1, stored) {
  const brands = brandsOf(e1);
  if (!brands.length) return null;
  let brand = brands.find((b) => stored && b.brand_id === stored.brand_id) || brands[0];
  const owner = isOwnerOf(brand);
  const rids = brand.branches.map((b) => b.rid);
  const single = rids.length === 1;
  let scope;
  if (stored && stored.brand_id === brand.brand_id && (stored.scope === 'all' ? owner && !single : rids.includes(stored.scope))) scope = stored.scope;
  else scope = owner && !single ? 'all' : rids[0];
  return { brand_id: brand.brand_id, scope, locked: !owner && single, owner, brand };
}

// The editor's rid for this page: the selected branch if it has catalog.read_editor; with 'all', the brand's single editor
// rid when there is exactly one, else the remembered single branch (or the first by name) among editor branches.
export function editorRidFor(sel, rememberedRid) {
  if (!sel) return null;
  const list = sel.brand.branches;
  if (sel.scope !== 'all') { const b = list.find((x) => x.rid === sel.scope); return b && hasEditor(b) ? b.rid : null; }
  const eds = list.filter(hasEditor);
  if (!eds.length) return null;
  if (eds.length === 1) return eds[0].rid;
  const r = eds.find((x) => x.rid === rememberedRid);
  return (r || eds[0]).rid;
}
// §11 A3 — Ventas in 1a is OWNER-ONLY: a temporary presentation deferral, not authorization (the server's stats.read gate is
// unchanged); slice 5 replaces it with the sales scope.
export function salesFor(sel, rid) {
  if (!sel || !rid) return false;
  const b = sel.brand.branches.find((x) => x.rid === rid);
  return !!(b && has(b, 'stats.read') && b.role === 'owner');
}
export const scopeBranches = (sel) => (sel ? sel.brand.branches.filter((b) => sel.scope === 'all' || b.rid === sel.scope) : []);
export const scopeLabel = (sel) => {
  if (!sel) return '';
  if (sel.scope === 'all') return 'Todas las sucursales';
  const b = sel.brand.branches.find((x) => x.rid === sel.scope);
  return b ? b.name : '';
};

// ── availability (E4 per-branch menus → the «Todas» union with applicability) ────────────────────────────────────────
// menus = [{ rid, published, items:[{key,name,category_id,category_name,price,description}], unavailable:[keys], error? }]
export function availabilityUnion(menus, orderRids) {
  const rank = new Map((orderRids || []).map((r, i) => [r, i]));
  const ordered = [...(menus || [])].sort((a, z) => (rank.has(a.rid) ? rank.get(a.rid) : 1e9) - (rank.has(z.rid) ? rank.get(z.rid) : 1e9));
  const items = new Map();
  const cats = new Map();
  for (const m of ordered) {
    if (!m || m.published !== true || m.error) continue;
    const out = new Set(Array.isArray(m.unavailable) ? m.unavailable : []);
    for (const it of m.items || []) {
      if (!items.has(it.key)) {
        const cid = it.category_id || '__none__';
        items.set(it.key, { key: it.key, name: it.name, price: it.price, description: it.description || '', category_id: cid, applicable: [], out: [] });
        if (!cats.has(cid)) cats.set(cid, { id: cid, name: it.category_name || it.category_id || 'Sin categoría', keys: [] });
        cats.get(cid).keys.push(it.key);
      }
      const row = items.get(it.key);
      row.applicable.push(m.rid);
      if (out.has(it.key)) row.out.push(m.rid);
    }
  }
  return { items, categories: [...cats.values()] };
}
export function soldOutCount(menus, rid) {
  const m = (menus || []).find((x) => x && x.rid === rid);
  return m && Array.isArray(m.unavailable) ? m.unavailable.length : 0;
}

export function priceText(n) {
  if (!Number.isInteger(n)) return '';
  const digits = String(Math.abs(n));
  const groups = [];
  for (let i = digits.length; i > 0; i -= 3) groups.unshift(digits.slice(Math.max(0, i - 3), i));
  return `L ${n < 0 ? '-' : ''}${groups.join(',')}`;
}

// Ventas-free nav model (§1 S0): owner = Productos · Sucursales n, Pausar pedidos; manager = Productos · Mi sucursal, Pausar.
export function navModel(sel) {
  if (!sel) return { ops: false };
  const pause = sel.brand.branches.some((b) => has(b, 'location.pause'));
  return { ops: true, owner: sel.owner, sucLabel: sel.owner ? 'Sucursales' : 'Mi sucursal', sucCount: sel.owner ? sel.brand.branches.length : null, pause };
}
