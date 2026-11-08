// «Marca» (NOTE-portal-marca-build, forks ruled 2026-11-02; approved mockup R1pshGArpS5Af2tzcdCvTW, frames B1–B4 / P1) — the owner's
// brand page, layered on the shell through registerView: NO shell edits. Visible only to an owner holding brand.settings; the server
// re-checks the BRAND capability on every call. Contract agreed with 3a (BRIEF-3a-marca-server):
//   GET  getBrandProfile    → { version|null, fields|null, seed?, palette, platform, projection }
//   POST updateBrandProfile → 200 { version, projected: n | false } | 400 { field, reason } | 409 version_conflict
// Changes reach customers ON SAVE (no publish step). projected:false = saved, the projection converges in minutes (its own toast).
// The swatches come ONLY from the server's palette (one source, platform/brand-palette.json); an accent is a FILL with its `on`
// text, never text itself. The logo uploader waits for the logo pipeline (M2): until then the monogram row shows, no uploader.
//
// LIFECYCLE (the team.js discipline): a module generation is bumped on every portal:auth and on unmount; every async continuation
// captures (generation, uid, brand) and drops its result when any changed. Unsaved edits are kept in module memory across a nav
// switch for the same uid + brand (the shell never blocks a nav switch), and canLeave() defers a self-update reload while dirty.
import { registerView, toast, goto } from './shell.js';
import { token } from './auth.js';
import { getBrandProfile, updateBrandProfile } from './api.js';
import { el, svg, icon, button, topBlock, errBox, skeleton, OFFLINE } from './ops-dom.js';
import * as BF from './brand-fields.js';

const ICON_D = 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01';   // the mockup's tag icon
const LOGO_ENABLED = false;   // M2 (the logo pipeline on main + Part A's logo frame) turns the uploader on
export const COPY = Object.freeze({
  lede: 'Cómo ven tu negocio tus clientes: el nombre, el color y el logo. Lo que guardés acá les llega al instante.',
  nameNote: 'Entre 2 y 40 caracteres. Así aparecés en la página de pedidos, el seguimiento, los recibos y las pantallas de cocina y de repartidores.',
  colorNote: 'Elegí uno de los colores de Sherpa: todos se leen bien sobre fondo claro y oscuro.',
  noteNote: 'Opcional. El cliente la ve cuando elige recoger y en el seguimiento de su pedido. La dirección de cada sucursal la define Sherpa; la ves en Sucursales.',
  notePh: 'Ej.: Pasá por la ventanilla de la izquierda y decí tu número de pedido.',
  clean: 'Los cambios llegan a tus clientes al guardar; no hay que publicar.',
  saved: 'Marca guardada',
  converging: 'Guardado. Tus clientes lo ven en unos minutos.',
  conflict: ['Alguien guardó la marca antes que vos', 'Trajimos lo último que se guardó. Tus cambios siguen acá: revisalos y volvé a guardar.'],
  preview: 'Ilustrativa. El nombre y el logo también aparecen en el seguimiento, en los recibos y en las pantallas de cocina y de repartidores; el color, en los botones y acentos de la página de pedidos.',
});

const S = {
  gen: 0, uid: null, sel: null, body: null,
  status: 'idle',        // idle | loading | error | ready
  version: null, base: null, st: null, palette: [], platform: null,
  saving: false, showErr: false, serverErr: null, conflict: false, saveFailed: false,
  touched: new Set(), refs: null, kept: null, toasted: null,
};
const keyOf = () => (S.uid && S.sel ? `${S.uid}|${S.sel.brandId}` : null);
const clone = (o) => ({ display_name: o.display_name, accent: o.accent, pickup_note: o.pickup_note });
const swatchOf = (id) => S.palette.find((p) => p && p.id === id) || null;
const dirtyKeys = () => (S.st && S.base ? BF.changed(S.st, S.base) : []);

function snap() {
  const g = { gen: S.gen, uid: S.uid, brandId: S.sel ? S.sel.brandId : null };
  g.alive = () => g.gen === S.gen && g.uid === S.uid && !!S.sel && g.brandId === S.sel.brandId;
  g.assertLive = () => { if (!g.alive()) throw Object.assign(new Error('obsolete'), { kind: 'obsolete' }); };
  return g;
}
const obsolete = (g, err) => !g.alive() || (err && err.kind === 'obsolete');
function say(text) { S.toasted = text; toast(text); }
function clearToast() {
  const t = document.getElementById('opstoast');
  if (t && S.toasted !== null && t.textContent === S.toasted) { t.replaceChildren(); t.classList.remove('show'); }
  S.toasted = null;
}
function wipe() {
  S.status = 'idle'; S.version = null; S.base = null; S.st = null; S.palette = []; S.platform = null; S.kept = null;
  S.saving = false; S.showErr = false; S.serverErr = null; S.conflict = false; S.saveFailed = false; S.touched = new Set(); S.refs = null;
  if (S.body) S.body.replaceChildren();
  clearToast();
}
document.addEventListener('portal:auth', (e) => {
  const uid = e && e.detail ? e.detail.uid : null;
  S.gen += 1;
  if (uid !== S.uid) wipe();
  S.uid = uid;
});

// ── load ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// adopt the server's answer as the baseline; the screen keeps `keep` (unsaved edits) on top of it when given
function adopt(res, keep) {
  const f = res && res.fields;
  S.version = res && Number.isSafeInteger(res.version) ? res.version : null;
  S.palette = Array.isArray(res && res.palette) ? res.palette : [];
  S.platform = res && res.platform && typeof res.platform === 'object' ? res.platform : null;
  S.base = f ? { display_name: String(f.display_name || ''), accent: f.accent || null, pickup_note: String(f.pickup_note || '') }
    : { display_name: String((res && res.seed && res.seed.display_name) || ''), accent: null, pickup_note: '' };
  S.st = keep ? clone(keep) : clone(S.base);
}
async function load({ keep = null, conflict = false } = {}) {
  const g = snap();
  if (!S.base) { S.status = 'loading'; render(); }
  try {
    const res = await getBrandProfile({ brandId: g.brandId, token, assertLive: g.assertLive });
    if (!g.alive()) return;
    adopt(res, keep);
    S.status = 'ready'; S.conflict = conflict;
  } catch (err) {
    if (obsolete(g, err)) return;
    if (!S.base) S.status = 'error'; else S.saveFailed = true;
  }
  render();
}

// ── save ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function save() {
  if (S.saving || S.status !== 'ready') return;
  S.serverErr = null; S.saveFailed = false; S.conflict = false;
  if (BF.firstProblem(S.st, S.palette)) { S.showErr = true; sync(); return; }
  if (!dirtyKeys().length) return;
  const g = snap();
  const fields = BF.toFields(S.st);
  S.saving = true; sync();
  try {
    const res = await updateBrandProfile({ brandId: g.brandId, expectedVersion: S.version, fields, token, assertLive: g.assertLive });
    if (!g.alive()) return;
    S.saving = false;
    S.version = res && Number.isSafeInteger(res.version) ? res.version : S.version;
    S.base = { display_name: fields.display_name, accent: fields.accent, pickup_note: fields.pickup_note };
    // what was saved is the baseline; an edit typed while the save was in flight stays pending on top of it
    if (S.st.display_name.trim() === fields.display_name) S.st.display_name = fields.display_name;
    S.showErr = false; S.touched = new Set();
    say(res && res.projected === false ? COPY.converging : COPY.saved);
    render();
  } catch (err) {
    if (obsolete(g, err)) return;
    S.saving = false;
    const b = err && err.body;
    if (err && err.status === 409 && b && b.error === 'version_conflict') { await load({ keep: S.st, conflict: true }); return; }
    if (err && err.status === 400 && b && b.error === 'invalid' && typeof b.field === 'string') { S.serverErr = { field: b.field, reason: b.reason }; S.showErr = true; sync(); return; }
    S.saveFailed = true; render();
  }
}
function discard() {
  if (S.saving || !S.base) return;
  S.st = clone(S.base); S.showErr = false; S.serverErr = null; S.touched = new Set();
  render();
}

// ── render: the page is built once per state; typing only re-syncs the parts that depend on it (never under the caret) ──
const lockHint = (text) => { const h = el('span', 'hint'); h.append(icon('lock'), document.createTextNode(text)); return h; };
function section(title, hint) { const s = el('div', 'sec'); const h = el('h3', null, title); if (hint) h.append(lockHint(hint)); s.append(h); return s; }
function fld(label, forId) { const f = el('div', 'fld'); const l = el('label', 'lab', label); if (forId) l.htmlFor = forId; f.append(l); return f; }
function roField(label, value, note) {
  const f = el('div', 'fld');
  f.append(el('span', 'lab', label));
  const v = el('div', 'inval inro'); if (typeof value === 'string') v.textContent = value; else v.append(value); f.append(v);
  if (note) { const n = el('span', 'fnote'); if (typeof note === 'string') n.textContent = note; else n.append(...note); f.append(n); }
  return f;
}
function mono(color, name) {
  const m = el('div', 'mk-mono'); if (color) m.style.background = color; m.textContent = BF.initial(name);
  return m;
}

function render() {
  if (!S.body) return;
  S.refs = null;
  const { top } = topBlock('Marca', COPY.lede, []);
  const out = [top];
  if (S.status === 'loading' || S.status === 'idle') out.push(skeleton());
  else if (S.status === 'error') out.push(errBox(OFFLINE[0], OFFLINE[1], () => load()));
  else out.push(...page());
  S.body.replaceChildren(...out);
  if (S.status === 'ready') sync();
}

function page() {
  const R = (S.refs = {});
  const out = [];
  if (S.conflict) {
    const box = errBox(COPY.conflict[0], COPY.conflict[1]);
    box.append(button('btn', 'Entendido', () => { S.conflict = false; render(); }));
    out.push(box);
  }
  if (S.saveFailed) out.push(errBox(OFFLINE[0], OFFLINE[1], () => { S.saveFailed = false; save(); }));
  const grid = el('div', 'grid2');
  const left = el('div', 'dcol'); const right = el('div', 'dcol');

  // Identidad
  const ident = section('Identidad');
  const fName = fld('Nombre de la marca', 'mk-name');
  const nameIn = el('input'); nameIn.type = 'text'; nameIn.id = 'mk-name'; nameIn.maxLength = BF.NAME_MAX; nameIn.value = S.st.display_name; nameIn.autocomplete = 'off';
  nameIn.addEventListener('input', () => { S.st.display_name = nameIn.value; clearServerErr('display_name'); sync(); });
  nameIn.addEventListener('blur', () => { S.touched.add('display_name'); sync(); });
  const cnt1 = el('div', 'mk-cnt'); R.nameCount = el('span', 'seccnt');
  cnt1.append(el('span', 'fnote', COPY.nameNote), R.nameCount);
  R.nameErrSlot = el('div');
  fName.append(nameIn, cnt1, R.nameErrSlot); R.nameFld = fName; R.nameIn = nameIn;

  const fColor = fld('Color de la marca');
  const sw = el('div', 'mk-swatches'); sw.setAttribute('role', 'radiogroup'); sw.setAttribute('aria-label', 'Color de la marca');
  R.swatches = [];
  for (const p of S.palette) {
    if (!p || typeof p.id !== 'string') continue;
    const b = button('mk-sw', null, () => { if (S.saving) return; S.st.accent = p.id; clearServerErr('accent'); sync(); }, { aria: String(p.label || p.id) });
    b.style.background = p.light; b.setAttribute('role', 'radio'); b.dataset.accent = p.id;
    sw.append(b); R.swatches.push(b);
  }
  R.colorNote = el('span', 'fnote');
  R.colorErrSlot = el('div');
  fColor.append(sw, R.colorNote, R.colorErrSlot); R.colorFld = fColor;

  const fLogo = fld('Logo');
  const row = el('div', 'mk-logorow'); const t = el('div');
  t.append(el('b', null, 'Sin logo todavía'), el('span', null, 'Tus clientes ven tu inicial sobre tu color.'));
  R.logoMono = mono(null, ''); R.logoMono.style.cssText += ';width:56px;height:56px';
  row.append(R.logoMono, t); fLogo.append(row);
  if (LOGO_ENABLED) { /* M2: the mockup's «Subí tu logo» uploader, PNG o JPG, cuadrado, mín 256×256, through the photo pipeline */ }
  ident.append(fName, fColor, fLogo);

  // Para recoger
  const rec = section('Para recoger');
  const fNote = fld('Nota para quien recoge', 'mk-note');
  const ta = el('textarea'); ta.id = 'mk-note'; ta.maxLength = BF.NOTE_MAX; ta.rows = 3; ta.placeholder = COPY.notePh; ta.value = S.st.pickup_note;
  ta.addEventListener('input', () => {
    // one line on every customer surface: a typed or pasted line break becomes a space (the server refuses control characters)
    if (/[\r\n]/.test(ta.value)) { const at = ta.selectionStart; ta.value = ta.value.replace(/\r\n|[\r\n]/g, ' '); try { ta.setSelectionRange(at, at); } catch (_) { /* jsdom */ } }
    S.st.pickup_note = ta.value; clearServerErr('pickup_note'); sync();
  });
  const cnt2 = el('div', 'mk-cnt'); R.noteCount = el('span', 'seccnt');
  cnt2.append(el('span', 'fnote', COPY.noteNote), R.noteCount);
  R.noteErrSlot = el('div');
  fNote.append(ta, cnt2, R.noteErrSlot); R.noteFld = fNote; R.noteIn = ta;
  rec.append(fNote);

  // save row
  const acts = el('div', 'actrow1b');
  R.save = button('btn accent', 'Guardar cambios', () => save());
  R.discard = button('btn ghost', 'Descartar', () => discard());
  R.actNote = el('span', 'fnote');
  acts.append(R.save, R.discard, R.actNote);
  left.append(ident, rec, acts);

  // preview (the customer page's own light tokens: it stays light in the dark portal)
  const pv = section('Así te ven tus clientes'); pv.querySelector('h3').append(el('span', 'hint', 'Vista previa'));
  const card = el('div', 'mk-prev');
  R.band = el('div', 'mk-prevband');
  const ph = el('div', 'mk-prevhead'); const pt = el('div');
  R.prevName = el('div', 'mk-prevname');
  pt.append(R.prevName, el('div', 'mk-prevsub', 'Pedí en línea · Sucursal Centro · Abierto hasta las 10:00 p. m.'));
  R.prevMono = mono(null, '');
  ph.append(R.prevMono, pt);
  R.prevBtn = el('div', 'mk-prevbtn', 'Empezar pedido');
  const tr = el('div', 'mk-prevtrack'); R.prevDot = el('i');
  tr.append(R.prevDot, document.createTextNode('Pedido #148 · En camino'), el('span', null, 'Seguimiento'));
  card.append(R.band, ph, R.prevBtn, tr);
  pv.append(card, el('span', 'fnote', COPY.preview));
  right.append(pv);
  grid.append(left, right);
  out.push(grid);

  // Datos de Sherpa (read-only, quieter)
  const ds = section('Datos de Sherpa', 'Solo lectura'); ds.classList.add('mk-quiet'); ds.id = 'mk-datos';
  const lk = icon('lock'); lk.classList.add('mk-h3lock'); ds.querySelector('h3').prepend(lk);
  ds.append(el('p', 'help', 'Estos datos los administra Sherpa. Para cambiar cualquiera, escribinos.'));
  const rows = el('div', 'frow1b');
  const lockNote = (rest) => { const l = el('span', 'lock1b'); l.append(icon('lock'), document.createTextNode('Definidas por Sherpa.')); return [l, document.createTextNode(` ${rest}`)]; };
  const link = button('mk-link', 'Ver en Sucursales', () => goto('suc'));
  const P = S.platform || {};
  const wa = typeof P.whatsapp_number === 'string' && P.whatsapp_number ? P.whatsapp_number : null;
  const url = typeof P.menu_url === 'string' && P.menu_url ? P.menu_url.replace(/^https?:\/\//, '') : null;
  rows.append(
    roField('WhatsApp de la marca', wa || 'Definido por Sherpa', wa ? 'Desde este número tus clientes reciben la confirmación y el seguimiento. Para cambiarlo, escribinos.' : 'Para cambiarlo, escribinos.'),
    roField('Ubicación y zona de cada sucursal', link, lockNote('El pin y la zona de entrega de cada sucursal.')),
    roField('Tarifas de envío', 'Definidas por Sherpa', 'Se calculan por sucursal y zona.'),
    roField('Dirección web de tu menú', url || 'Definida por Sherpa', url ? 'Compartila en tus redes o en un código QR.' : null),
  );
  ds.append(rows);
  out.push(ds);
  return out;
}

function clearServerErr(field) { if (S.serverErr && S.serverErr.field === field) S.serverErr = null; }
function errFor(field) {
  if (S.serverErr && S.serverErr.field === field) return S.serverErr.reason || 'invalid';
  const r = field === 'display_name' ? BF.nameReason(S.st.display_name) : field === 'pickup_note' ? BF.noteReason(S.st.pickup_note) : BF.accentReason(S.st.accent, S.palette);
  if (!r) return null;
  // shown live for a forbidden character; otherwise once the field was left or a save was tried
  if (r === 'bad_chars' || S.showErr || S.touched.has(field)) return r;
  return null;
}
function paintErr(slot, fieldEl, input, id, field) {
  const r = errFor(field);
  slot.replaceChildren();
  fieldEl.classList.toggle('invalid', !!r);
  if (input) { input.setAttribute('aria-invalid', r ? 'true' : 'false'); if (r) input.setAttribute('aria-describedby', id); else input.removeAttribute('aria-describedby'); }
  if (r) { const e = el('div', 'ferr1b'); e.id = id; e.append(icon('err'), el('span', null, BF.errText(field, r))); slot.append(e); }
}

// everything that follows the fields: counters, swatch state, preview, monograms, errors, the save row
function sync() {
  const R = S.refs;
  if (!R || !S.st) return;
  const name = S.st.display_name;
  R.nameCount.textContent = `${name.length}/${BF.NAME_MAX}`;
  R.noteCount.textContent = `${S.st.pickup_note.length}/${BF.NOTE_MAX}`;
  const sw = swatchOf(S.st.accent);
  for (const b of R.swatches) {
    const on = b.dataset.accent === S.st.accent;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.replaceChildren(); if (on) b.append(icon('check'));
    b.disabled = S.saving;
  }
  R.colorNote.textContent = sw ? `${COPY.colorNote} Seleccionado: ${sw.label}.` : COPY.colorNote;
  const fill = sw ? sw.light : null;
  const shownName = name.trim() || S.base.display_name;
  for (const m of [R.logoMono, R.prevMono]) { m.style.background = fill || ''; m.textContent = BF.initial(shownName); m.style.color = sw && sw.on ? sw.on : ''; }
  R.prevName.textContent = shownName;
  for (const n of [R.band, R.prevBtn, R.prevDot]) n.style.background = fill || '';   // no colour chosen yet: the stylesheet's neutral
  R.prevBtn.style.color = sw && sw.on ? sw.on : '';
  paintErr(R.nameErrSlot, R.nameFld, R.nameIn, 'mk-name-err', 'display_name');
  paintErr(R.colorErrSlot, R.colorFld, null, 'mk-color-err', 'accent');
  paintErr(R.noteErrSlot, R.noteFld, R.noteIn, 'mk-note-err', 'pickup_note');
  R.nameIn.disabled = S.saving; R.noteIn.disabled = S.saving;
  const keys = dirtyKeys();
  R.save.disabled = S.saving || keys.length === 0;
  R.discard.classList.toggle('hidden', keys.length === 0);
  R.discard.disabled = S.saving;
  R.actNote.textContent = keys.length ? BF.changedLine(keys) : COPY.clean;
}

// ── the registration (module top level, before the nav is first drawn) ───────────────────────────────────────────────
registerView({
  id: 'marca',
  group: 'Negocio',
  label: 'Marca',
  icon: ICON_D,
  visible: (sel) => !!sel && sel.role === 'owner' && Array.isArray(sel.caps) && sel.caps.includes('brand.settings'),
  mount(host, sel) {
    S.sel = sel;
    S.body = el('div');
    host.replaceChildren(S.body);
    const key = keyOf();
    const keep = S.kept && S.kept.key === key ? S.kept.st : null;
    S.kept = null;
    S.status = 'idle'; S.base = null; S.st = null; S.saving = false; S.showErr = false; S.serverErr = null; S.conflict = false; S.saveFailed = false; S.touched = new Set();
    render();
    load({ keep });
  },
  unmount() {
    // unsaved edits survive a nav switch for this uid + brand; never an edit whose save was in flight (its write may have landed)
    S.kept = S.st && S.base && !S.saving && dirtyKeys().length ? { key: keyOf(), st: clone(S.st) } : null;
    S.gen += 1;
    clearToast();
    if (S.body) S.body.replaceChildren();
    S.body = null; S.refs = null; S.status = 'idle'; S.base = null; S.st = null; S.saving = false;
  },
  canLeave: () => !(S.st && S.base && dirtyKeys().length),
});

// test-only view of the module state (never read by the page)
export const _marcaState = S;
