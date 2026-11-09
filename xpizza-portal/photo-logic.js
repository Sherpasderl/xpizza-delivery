// DISH PHOTOS B (PLAN-dish-photos r2 §3, against the FROZEN §2.2 contract + its 2026-10-27 amendments) — the PURE half.
//
// Everything here is DOM-free so node asserts it directly: the approved copy (MOCKUP-portal-dish-photo.html «Textos»), the
// browser-side file checks (the server stays authoritative), the crop geometry in the EXIF-oriented pixel space E-P2 reads,
// the three photo states (legacy / pid / removed) as the screen shows them, the error → copy map, the retry plan, and the
// preview-renewal clock. photo.js (DOM) and app.js / render.js / review.js read only what is exported here.

// ── limits (§2.2 E-P1 / E-P2) ──────────────────────────────────────────────────────────────────────────────────────────
export const MAX_BYTES = 10485760;                                   // 10 MB, the signed content-length-range ceiling
export const TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const ACCEPT = TYPES.join(',');
export const MIN_W = 500;                                            // after EXIF orientation (E-P2 → too_small)
export const MIN_H = 440;
// The two crops of the same photo (Q2): the order page's card and detail shapes. `min` is §2.2's minimum crop, in source
// pixels. Hero 496×310 (advisor ruling 2026-10-27, §2.2 amended from 512×320, which no 500–511 px wide image could meet):
// the largest 16:10 inside the approved 500×440 minimum is 500×312, so every image the copy admits has both crops.
export const FRAMES = Object.freeze({
  card: Object.freeze({ id: 'card', aspect: 4 / 3, minW: 400, minH: 300 }),
  hero: Object.freeze({ id: 'hero', aspect: 16 / 10, minW: 496, minH: 310 }),
});
export const ZOOM_MAX = 2;                                            // the mockup's slider: 100–200 %
export const RENEW_EARLY_MS = 5 * 60 * 1000;                          // re-read previews 5 min before expiresAt (§2.2 E-P3)

// ── approved copy (the mockup's «Textos»; voseo hondureño) ─────────────────────────────────────────────────────────────
const joinNames = (names) => (names.length <= 1 ? (names[0] || '') : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`);
export const COPY = Object.freeze({
  field: 'Foto',
  rowUpload: 'Subir foto',
  rowUploadAria: (name) => `Subir foto de ${name}`,
  rowEdit: 'Editar producto',
  rowEditAria: (name) => `Editar ${name}`,
  zone: 'Subí una foto',
  limits: 'JPG, PNG o WEBP · máx 10MB · mín 500×440',
  take: 'Tomar foto',
  gallery: 'Elegir de la galería',
  cropTitle: 'Ajustar foto',
  frameLabel: 'Encuadre',
  // `\x28` is "(" — the rendered text is exactly «Tarjeta (4:3)» / «Detalle (16:10)»; spelled so, a word before a parenthesis
  // inside a string does not read as a call to portal-wiring's ReferenceError guard (it strips comments, not strings)
  frame: Object.freeze({ card: 'Tarjeta \x284:3)', hero: 'Detalle \x2816:10)' }),
  hint: 'Arrastrá la foto para moverla. La misma foto sirve para los dos encuadres; cada uno guarda su posición.',
  zoom: 'Zoom',
  preview: 'Vista previa',
  previewLede: 'Así se ve en la página de pedidos',
  previewCap: Object.freeze({ card: 'Tarjeta · 4:3', hero: 'Detalle · 16:10' }),
  cropAria: (name, frame) => `Foto de ${name}, encuadre de ${frame === 'hero' ? 'detalle' : 'tarjeta'}. Arrastrá para moverla.`,
  done: 'Listo',
  cancel: 'Cancelar',
  close: 'Cerrar',
  uploading: 'Subiendo foto…',
  uploadingAria: 'Subiendo foto',
  failed: 'No se pudo subir la foto.',
  limited: 'Subiste muchas fotos seguidas. Probá de nuevo más tarde.',   // P5-L (owner-approved ratelimit mockup, option B)
  retry: 'Reintentar',
  invalid: Object.freeze({
    too_large: 'Ese archivo pesa más de 10 MB. Elegí una foto más liviana.',
    bad_type: 'Ese archivo no es JPG, PNG ni WEBP.',
    too_small: 'Esa foto es muy pequeña: necesita al menos 500×440 px.',
  }),
  change: 'Cambiar',
  remove: 'Quitar',
  draftTag: 'Foto sin publicar',
  removedTag: 'Se quita la foto',
  rmLine: 'La foto actual se quita al publicar.',
  undo: 'Deshacer',
  alt: (name) => `Foto de ${name}`,
  barSuffix: (n) => (n === 1 ? ' · 1 foto' : ` · ${n} fotos`),
  group: 'Fotos',
  line: Object.freeze({ new: 'Foto nueva', changed: 'Foto cambiada', removed: 'Foto quitada' }),
  none: 'Sin foto',
  sealSub: 'Esta publicación requiere tu autorización como propietario',
  sealBody: 'Como propietario, autorizás esta publicación. No cambia ningún precio: solo las fotos de los productos.',
  // the plural as drawn; the singular owner-approved 2026-10-27 — never "estos 1 productos"
  sealAck: (n) => (n === 1 ? ' publicar la foto de este producto.' : ` publicar las fotos de estos ${n} productos.`),
  receipt: (names) => (names.length === 1
    ? `La foto de «${names[0]}» ya está en el menú publicado.`
    : `Las fotos de ${joinNames(names)} ya están en el menú publicado.`),
});

// ── browser-side checks (P6) — the server re-checks everything (E-P2) ─────────────────────────────────────────────────
// The declared type and the size, before anything is read. Returns the P6 code or null.
export function checkFile(file) {
  if (!file || typeof file.size !== 'number') return 'bad_type';
  if (!TYPES.includes(file.type)) return 'bad_type';
  if (file.size > MAX_BYTES) return 'too_large';
  if (file.size < 1) return 'bad_type';
  return null;
}
// The ORIENTED size (createImageBitmap(…, {imageOrientation:'from-image'}) / an <img>'s natural size, which honour EXIF).
export function checkDims(w, h) {
  if (!(Number.isFinite(w) && Number.isFinite(h))) return 'bad_type';
  return w < MIN_W || h < MIN_H ? 'too_small' : null;
}
// Both crops must be possible at all, or E-P2 can only answer bad_crop: the image is too small for the contract's crops.
export const framesFit = (w, h) => Object.values(FRAMES).every((f) => { const b = baseSize(w, h, f.aspect); return b.w >= f.minW && b.h >= f.minH; });

// ── crop geometry (§2.2 E-P2: integers, oriented space, aspect ±0.5 %, the minimum crop) ─────────────────────────────
// A frame's view is {z, cx, cy}: zoom ≥ 1 over the largest rect of the frame's aspect that fits, centred at (cx, cy) in
// image pixels. The rect sent to E-P2 is derived from it — the view is the merchant's, the rect is the contract's.
export function baseSize(W, H, aspect) {
  return W / H > aspect ? { w: H * aspect, h: H } : { w: W, h: W / aspect };
}
export function maxZoom(W, H, frame) {
  const b = baseSize(W, H, frame.aspect);
  return Math.max(1, Math.min(ZOOM_MAX, b.w / frame.minW, b.h / frame.minH));
}
export const initialView = (W, H) => ({ z: 1, cx: W / 2, cy: H / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export function rectFor(W, H, frame, view) {
  const b = baseSize(W, H, frame.aspect);
  const z = clamp(Number.isFinite(view && view.z) ? view.z : 1, 1, maxZoom(W, H, frame));
  // floored to an integer, but never under the minimum (float division at the zoom ceiling lands a pixel short: 514×440 at
  // its max zoom gave 495×309); minW / aspect is exactly minH for both frames, so the height follows
  const w = clamp(Math.floor(b.w / z), Math.min(frame.minW, Math.floor(b.w)), Math.floor(b.w));
  const h = Math.min(H, Math.round(w / frame.aspect));
  const cx = Number.isFinite(view && view.cx) ? view.cx : W / 2;
  const cy = Number.isFinite(view && view.cy) ? view.cy : H / 2;
  return { x: clamp(Math.round(cx - w / 2), 0, W - w), y: clamp(Math.round(cy - h / 2), 0, H - h), w, h };
}
// The rect, checked against the contract exactly as E-P2 will (so a bad rect is a bug here, never a bad_crop there).
export function rectOk(W, H, frame, r) {
  const ints = [r.x, r.y, r.w, r.h].every(Number.isInteger);
  return ints && r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H && r.w >= frame.minW && r.h >= frame.minH
    && Math.abs((r.w / r.h) / frame.aspect - 1) <= 0.005;
}
// Re-centre a view after a drag (dx, dy in IMAGE pixels) or a zoom, clamped so the rect stays inside the photo.
export function moveView(W, H, frame, view, dx, dy) {
  const r = rectFor(W, H, frame, view);
  return { z: view.z, cx: clamp(r.x + r.w / 2 - dx, r.w / 2, W - r.w / 2), cy: clamp(r.y + r.h / 2 - dy, r.h / 2, H - r.h / 2) };
}
export function zoomView(W, H, frame, view, z) {
  const next = { ...view, z: clamp(z, 1, maxZoom(W, H, frame)) };
  return moveView(W, H, frame, next, 0, 0);
}
// Where the photo sits inside a box of the frame's aspect showing exactly `r` — percentages, so it holds at any width and is
// set through the CSSOM (the CSP forbids style attributes). The same numbers place the crop area and both previews.
export function placement(W, H, r) {
  return { width: (W / r.w) * 100, height: (H / r.h) * 100, left: (-r.x / r.w) * 100, top: (-r.y / r.h) * 100 };
}
export const cropsFor = (W, H, views) => ({ card: rectFor(W, H, FRAMES.card, views.card), hero: rectFor(W, H, FRAMES.hero, views.hero) });

// ── the three photo states (§2.1), as the screen shows them ───────────────────────────────────────────────────────────
// `photos` = the draft map, `orig` = the map as loaded, `previews` = E-P3 photoPreviews (+ E-P2 results), `legacy` = E-P3
// legacyPreviews (the image the public menu serves today when there is no entry). Absent entry = legacy.
// A KEY in legacyPreviews means the dish HAS a legacy image (amendment 2026-10-27), with or without a usable card URL: a key
// without one (or whose picture fails to load) is still a photo — the neutral frame + the camera, Cambiar / Quitar truthful.
// A pid without a preview is different (§2.2 E-P3: a pid the registry no longer serves): P5, a new upload.
const legacyHas = (legacy, key) => !!(legacy && Object.prototype.hasOwnProperty.call(legacy, key) && legacy[key] && typeof legacy[key] === 'object');
const entryOf = (map, key) => (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);
const sameEntry = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
const urlOfEntry = (e, key, previews, legacy) => {
  if (e && e.state === 'pid') { const p = previews && previews[e.pid]; return p && typeof p.card === 'string' ? p.card : null; }
  if (!e) { const l = legacy && legacy[key]; return l && typeof l.card === 'string' ? l.card : null; }
  return null;
};
const hasPhoto = (e, key, legacy) => (e ? e.state === 'pid' : legacyHas(legacy, key));
export function photoView(key, { photos, orig, previews, legacy } = {}) {
  const cur = entryOf(photos, key);
  const was = entryOf(orig, key);
  const changed = !sameEntry(cur, was);
  if (cur && cur.state === 'pid') {
    const p = previews && previews[cur.pid];
    const url = urlOfEntry(cur, key, previews, legacy);
    // "sin publicar": edited in this session, or the registry still holds it as a DRAFT (only draft previews expire, §2.2)
    return { kind: 'photo', url, missing: !url, neutral: false, draft: changed || !!(p && p.expiresAt != null), pid: cur.pid };
  }
  if (cur && cur.state === 'removed') {
    // a removal made here, over a photo the dish has → the dimmed thumb + «Se quita la foto»; a stored removal reads as none
    if (changed && hasPhoto(was, key, legacy)) return { kind: 'removing', url: urlOfEntry(was, key, previews, legacy) };
    return { kind: 'none' };
  }
  if (!legacyHas(legacy, key)) return { kind: 'none' };
  const url = urlOfEntry(null, key, previews, legacy);
  return { kind: 'photo', url, missing: false, neutral: !url, draft: false, legacy: true };
}
// «Quitar»: the result is NO photo. Absence already means none when the dish has no legacy image, so the entry goes;
// otherwise it is an explicit removal (§2.1 — removing a legacy image is a real change).
export function removedEntry(key, { orig, legacy } = {}) {
  const was = entryOf(orig, key);
  if (!was && !hasPhoto(null, key, legacy)) return null;
  return { state: 'removed' };
}
// «Deshacer» restores what was loaded — including ABSENCE.
export const undoEntry = (key, { orig } = {}) => entryOf(orig, key);
// Keys whose photo state differs from what was loaded: the bar's «· N fotos» and its share of the pending count.
export function pendingPhotoKeys(photos, orig) {
  const keys = new Set([...Object.keys(photos || {}), ...Object.keys(orig || {})]);
  return [...keys].filter((k) => !sameEntry(entryOf(photos, k), entryOf(orig, k))).sort();
}

// ── errors (§2.2 codes, mapped by `error`, never by status) ──────────────────────────────────────────────────────────
// P6 (the file itself) — a new file is needed; P5-L (the server's upload limit, `rate_limited`) — a neutral note, nothing to
// retry until the window passes; everything else is P5 «No se pudo subir la foto.» + Reintentar.
export const INVALID_CODES = Object.freeze(['too_large', 'bad_type', 'too_small']);
export const errorCopy = (code) => (INVALID_CODES.includes(code) ? { kind: 'invalid', text: COPY.invalid[code] }
  : code === 'rate_limited' ? { kind: 'limited', text: COPY.limited } : { kind: 'failed', text: COPY.failed });
// «Reintentar» (§2.2 Cancellation / retry): the SAME uploadId + crops through E-P2 when the bytes reached Storage and the
// failure was transient; otherwise start over at E-P1 with a NEW op_id (a new upload; quota-charged).
// §2.2 E-P2: `attempts < 3` — the THIRD processing failure makes that upload terminal (`unavailable` from then on), so after
// three failed E-P2 calls on one uploadId the only way forward is a fresh upload (codex r1 #5).
const PROCESS_AGAIN = Object.freeze(['unavailable', 'in_progress', 'rate_limited']);
export const MAX_PROCESS_ATTEMPTS = 3;
export const CONSUMES_ATTEMPT = Object.freeze(['unavailable']);   // the E-P2 answers that spent one of the 3 attempts
export function retryPlan({ uploaded, code, failures = 0 }) {
  if (!uploaded) return 'restart';
  if (failures >= MAX_PROCESS_ATTEMPTS) return 'restart';
  if (code === 'upload_missing') return 'restart';
  if (code == null || PROCESS_AGAIN.includes(code)) return 'process';   // null = no answer (network): the same call again
  return 'restart';
}

// ── preview renewal (§2.2 E-P3) ───────────────────────────────────────────────────────────────────────────────────────
// expiresAt arrives as epoch ms or an ISO string; anything else is "no expiry". Returns the ms to wait (≥ 0) before the
// re-read, or null when nothing on screen expires.
export const expiryMs = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null));
export function renewIn(previews, pids, now) {
  let at = null;
  for (const pid of pids) {
    const p = previews && previews[pid];
    const e = p ? expiryMs(p.expiresAt) : null;
    if (e !== null && (at === null || e < at)) at = e;
  }
  return at === null ? null : Math.max(0, at - RENEW_EARLY_MS - now);
}

// ── review (§2.4) ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A diff line {surface:'item', key, field:'photo', old, new} with <state> ∈ {kind:'legacy'} | {kind:'pid',pid} | {kind:'removed'}.
// A legacy state HAS a photo exactly when the server gave a legacy preview for that key.
export const isPhotoLine = (c) => !!(c && c.field === 'photo');
const stateHas = (s, key, legacy) => !!(s && (s.kind === 'pid' || (s.kind === 'legacy' && legacyHas(legacy, key))));
export function lineKind(c, legacy) {
  const before = stateHas(c.old, c.key, legacy);
  const after = stateHas(c.new, c.key, legacy);
  if (!after) return 'removed';
  return before ? 'changed' : 'new';
}
export function stateUrl(s, key, previews, legacy) {
  if (!s) return null;
  if (s.kind === 'pid') { const p = previews && previews[s.pid]; return p && typeof p.card === 'string' ? p.card : null; }
  if (s.kind === 'legacy') { const l = legacy && legacy[key]; return l && typeof l.card === 'string' ? l.card : null; }
  return null;
}
