// DISH PHOTOS B (PLAN-dish-photos r2 §3) — the DOM half: the row thumbnail (P1/P7/P10b), the drawer's «Foto» field
// (P1/P2/P4/P5/P6/P7), the crop step (P3), the review thumbnails (P8) and the upload controller (E-P1 → signed PUT → E-P2).
// Exact to the owner-approved MOCKUP-portal-dish-photo.html. createElement + textContent only (a dish name is data); every
// position is set through the CSSOM (the CSP forbids style attributes). The rules live in photo-logic.js.
import * as P from './photo-logic.js';
import { photoUploadStart, photoProcess, putSigned } from './api.js';
import { closeIcon } from './ops-dom.js';

const NS = 'http://www.w3.org/2000/svg';
// [tag, attrs] shapes, so a circle or a rect draws as the mockup's icons do
const ICONS = {
  camera: [['path', { d: 'M4 8h3l2-3h6l2 3h3v11H4z' }], ['circle', { cx: '12', cy: '13', r: '3.5' }]],
  upload: [['path', { d: 'M12 16V4M8 8l4-4 4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3' }]],
  gallery: [['rect', { x: '3', y: '5', width: '18', height: '14', rx: '2' }], ['path', { d: 'M3 16l5-5 4 4 3-3 6 6' }], ['circle', { cx: '16', cy: '9', r: '1.5' }]],
  warn: [['path', { d: 'M12 3l9 16H3z' }], ['path', { d: 'M12 10v4' }], ['path', { d: 'M12 17.5v.01' }]],
  minus: [['path', { d: 'M5 12h14' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
};
export function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[name]) { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); }
  return svg;
}
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
// Every clickable is built as `const x = el('button', '<literal classes>')` with its own listener, so portal-wiring's cursor
// guard can resolve what it is (a class passed through a helper is invisible to it).
// an <img> whose failure is reported (preview renewal, §2.2 E-P3) and never left as a broken image
function img(cls, url, alt, onError) {
  const i = el('img', cls);
  i.alt = alt;
  i.decoding = 'async';
  if (onError) i.addEventListener('error', () => onError(url), { once: true });
  i.src = url;
  return i;
}

// ── the list row (P1 / P7) ────────────────────────────────────────────────────────────────────────────────────────────
// `view` from photoView(). With uploads off and no photo, today's empty placeholder exactly (render.js keeps that path).
export function rowThumb({ view, name, enabled, onOpen, onUpload, onImgError }) {
  if (view.kind === 'photo' && (view.url || view.neutral)) {
    // a photo — or a legacy image whose picture is unknown / failed to load: the neutral frame, still a photo (opens the drawer)
    const t = el('button', `thumb set${view.draft ? ' phchg' : ''}`); t.type = 'button';
    t.addEventListener('click', onOpen);
    t.title = P.COPY.rowEdit;
    t.setAttribute('aria-label', P.COPY.rowEditAria(name));
    if (view.url) t.append(img('gimg', view.url, '', onImgError));
    if (enabled) { const c = el('span', 'cam'); c.append(icon('camera')); t.append(c); }
    return t;
  }
  if (view.kind === 'removing') {
    const t = el('button', 'thumb set phchg phrmthumb'); t.type = 'button';
    t.addEventListener('click', onOpen);
    t.title = P.COPY.rowEdit;
    t.setAttribute('aria-label', P.COPY.rowEditAria(name));
    if (view.url) t.append(img('gimg', view.url, '', onImgError));
    const c = el('span', 'cam'); c.append(icon('camera')); t.append(c);
    return t;
  }
  // no photo (or a pid whose preview is unknown — never a broken image): the camera, which opens the drawer WITH the picker
  const t = el('button', 'thumb'); t.type = 'button';
  t.addEventListener('click', onUpload);
  t.title = P.COPY.rowUpload;
  t.setAttribute('aria-label', P.COPY.rowUploadAria(name));
  t.append(icon('camera'));
  return t;
}
// the discreet amber tag after the name (P7)
export function rowTag(view) {
  if (view.kind === 'photo' && (view.url || view.neutral) && view.draft) return el('span', 'tag phtag', P.COPY.draftTag);
  if (view.kind === 'removing') return el('span', 'tag phtag', P.COPY.removedTag);
  return null;
}
// P10b — the published card on a read-only row: a plain picture, no button, no camera, no cursor
export function readOnlyThumb(url) {
  const t = el('div', 'thumb set phro');
  t.setAttribute('aria-hidden', 'true');
  t.append(img('gimg', url, ''));
  return t;
}
// P8 — a 64×48 card thumbnail in the diff; the neutral frame alone when no URL is known
export function reviewThumb(url, was, onImgError) {
  const s = el('span', `phpth${was ? ' was' : ''}`);
  if (url) s.append(img('gimg', url, '', onImgError));
  return s;
}

// ── the drawer's «Foto» field ─────────────────────────────────────────────────────────────────────────────────────────
function ferr(text) {
  const f = el('div', 'ferr phferr');
  f.setAttribute('role', 'alert');
  f.append(icon('warn'), el('span', null, text));
  return f;
}
// P1 / P2: the zone. The whole zone is a button (P1; on a desktop it opens the system picker). On a phone, choosing (P2) is
// the SAME zone expanded in place into two buttons — «Tomar foto» (the camera) and «Elegir de la galería» (the picker).
function zone({ invalid, expanded, onPick }) {
  if (!expanded) {
    const desk = el('button', `uploader phdesk${invalid ? ' phinv' : ''}`); desk.type = 'button';
    desk.addEventListener('click', () => onPick(null));   // null: the caller expands it on a phone, opens the picker elsewhere
    desk.append(icon('upload'), el('b', null, P.COPY.zone), el('span', null, P.COPY.limits));
    return [desk];
  }
  const ph = el('div', `uploader phph2${invalid ? ' phinv' : ''}`);
  const two = el('span', 'phph2b');
  const take = el('button', 'btn'); take.type = 'button';
  take.addEventListener('click', () => onPick(true));
  take.append(icon('camera'), document.createTextNode(P.COPY.take));
  const pick = el('button', 'btn'); pick.type = 'button';
  pick.addEventListener('click', () => onPick(false));
  pick.append(icon('gallery'), document.createTextNode(P.COPY.gallery));
  two.append(take, pick);
  ph.append(icon('upload'), el('b', null, P.COPY.zone), el('span', null, P.COPY.limits), two);
  return [ph];
}
// Returns the field, or null when there is nothing to show (uploads off and no photo: today's drawer, unchanged).
export function photoField({ name, view, job, enabled, expanded = false, held = false, onPick, onRemove, onUndo, onRetry, onCancel, onImgError }) {
  const shows = view.kind === 'photo' && !!(view.url || view.neutral);
  if (!enabled && !shows) return null;
  const f = el('div', 'fld');
  f.append(el('label', null, P.COPY.field));
  if (job && job.phase === 'busy') {
    // P4 — the cropped photo, dimmed, under a determinate bar; the rest of the drawer stays editable
    const u = el('div', 'uphoto phbusy');
    u.append(img('gimg', job.url, P.COPY.alt(name)));
    const ov = el('div', 'phov');
    const bar = el('div', 'phbar');
    const pct = Math.round((job.progress || 0) * 100);
    bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', P.COPY.uploadingAria);
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(pct));
    const fill = el('i'); fill.style.width = `${pct}%`; bar.append(fill);
    const stop = el('button', 'uprm', P.COPY.cancel); stop.type = 'button';
    stop.addEventListener('click', onCancel);
    ov.append(bar, el('span', null, P.COPY.uploading), stop);
    u.append(ov);
    f.append(u);
    return f;
  }
  if (job && job.phase === 'ready' && held) {
    // ruling A (Codex r1 #1) — uploaded, but HELD beside a pending section name: the cropped photo with the busy state's own
    // «Cancelar» (data-held: the rename lock leaves it on), so the merchant's way out is never «discard everything»
    const u = el('div', 'uphoto');
    u.append(img('gimg', job.url, P.COPY.alt(name)));
    const a = el('div', 'phacts');
    a.dataset.held = '1';
    const stop = el('button', 'uprm', P.COPY.cancel); stop.type = 'button';
    stop.addEventListener('click', onCancel);
    a.append(stop);
    u.append(a);
    f.append(u);
    return f;
  }
  const failed = (job && job.phase === 'failed') || (view.kind === 'photo' && view.missing && !job);
  const invalid = !!(job && job.phase === 'invalid');
  if (shows) {
    const u = el('div', 'uphoto');
    if (view.url) u.append(img('gimg', view.url, P.COPY.alt(name), onImgError));
    if (enabled) {
      const a = el('div', 'phacts');
      const change = el('button', 'uprm', P.COPY.change); change.type = 'button';
      change.addEventListener('click', () => onPick(false));
      const remove = el('button', 'uprm', P.COPY.remove); remove.type = 'button';
      remove.addEventListener('click', onRemove);
      a.append(change, remove);
      u.append(a);
    }
    f.append(u);
    if (failed) {
      const r = el('div', 'pherr');
      const again = el('button', 'btn sm', P.COPY.retry); again.type = 'button';
      again.addEventListener('click', onRetry);
      r.append(ferr(P.COPY.failed), again);
      f.append(r);
    }
    if (invalid) { f.classList.add('invalid'); f.append(ferr(P.COPY.invalid[job.code])); }
    return f;
  }
  if (invalid) f.classList.add('invalid');
  f.append(...zone({ invalid: invalid || failed, expanded, onPick }));
  if (failed) {
    f.append(ferr(P.COPY.failed));
    const r = el('div', 'pherr phright');
    const again = el('button', 'btn sm', P.COPY.retry); again.type = 'button';
    again.addEventListener('click', onRetry);
    r.append(again);
    f.append(r);
  }
  if (invalid) f.append(ferr(P.COPY.invalid[job.code]));
  if (view.kind === 'removing' && enabled) {
    const r = el('div', 'phrm');
    const undo = el('button', 'btn ptext sm', P.COPY.undo); undo.type = 'button';
    undo.addEventListener('click', onUndo);
    r.append(el('span', null, P.COPY.rmLine), undo);
    f.append(r);
  }
  return f;
}

// ── P3 — the crop step (a step of the drawer, not a modal) ────────────────────────────────────────────────────────────
// One frame at a time; each keeps its own position. The rect E-P2 receives is derived from the view (photo-logic rectFor),
// and the SAME rect places the crop area and both previews, so what the owner sees is what the server cuts.
function place(imgEl, W, H, r) {
  const p = P.placement(W, H, r);
  imgEl.style.width = `${p.width}%`; imgEl.style.height = `${p.height}%`; imgEl.style.left = `${p.left}%`; imgEl.style.top = `${p.top}%`;
}
export function cropStep({ job, name, desc, priceText, onFrame, onView, onCancel, onDone, onClose }) {
  const { W, H } = job;
  const frame = P.FRAMES[job.frame];
  const head = el('div', 'dwh');
  const close = closeIcon(onClose);
  head.append(el('div', 'dwt', P.COPY.cropTitle), close);
  const body = el('div', 'dwb');

  const f1 = el('div', 'fld');
  f1.append(el('label', null, P.COPY.frameLabel));
  const seg = el('div', 'gtype phseg');
  seg.setAttribute('role', 'tablist'); seg.setAttribute('aria-label', P.COPY.frameLabel);
  for (const id of ['card', 'hero']) {
    const b = el('button', 'phsegb', P.COPY.frame[id]); b.type = 'button';
    if (job.frame === id) b.classList.add('on');
    b.addEventListener('click', () => { if (job.frame !== id) onFrame(id); });
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(job.frame === id));
    seg.append(b);
  }
  const crop = el('div', 'phcrop');
  crop.style.aspectRatio = job.frame === 'hero' ? '16/10' : '4/3';
  crop.setAttribute('role', 'img'); crop.setAttribute('aria-label', P.COPY.cropAria(name, job.frame));
  crop.tabIndex = 0;
  const cimg = img('', job.url, '');
  crop.append(cimg, el('i', 'phgrid'));
  const hint = el('div', 'phhint', P.COPY.hint);
  const zoom = el('div', 'phzoom');
  const range = el('input');
  range.type = 'range'; range.min = '100';
  range.max = String(Math.floor(P.maxZoom(W, H, frame) * 100));
  range.value = String(Math.round(Math.min(job.views[job.frame].z, P.maxZoom(W, H, frame)) * 100));
  range.setAttribute('aria-label', P.COPY.zoom);
  const zi = el('span', 'phzi'); zi.append(icon('plus'));
  zoom.append(el('span', 'phzl', P.COPY.zoom), icon('minus'), range, zi);
  f1.append(seg, crop, hint, zoom);

  const f2 = el('div', 'fld');
  f2.append(el('label', null, P.COPY.preview), el('div', 'phpvlbl', P.COPY.previewLede));
  const two = el('div', 'phpv2');
  const card = (id) => {
    const wrap = el('div');
    wrap.append(el('div', 'phpvcap', P.COPY.previewCap[id]));
    const oc = el('div', 'phocard');
    const ph = el('div', id === 'hero' ? 'phohero' : 'phophoto');
    const pimg = img('', job.url, '');
    ph.append(pimg, el('i', id === 'hero' ? 'phshh' : 'phshc'));   // the order page's shade over its photo
    const ob = el('div', 'phobody');
    ob.append(el('div', `phoname${id === 'hero' ? ' phoh' : ''}`, name));
    if (id === 'card' && desc) ob.append(el('div', 'phodesc', desc));
    if (priceText) ob.append(el('div', 'phoprice', priceText));
    oc.append(ph, ob);
    wrap.append(oc);
    return [wrap, pimg];
  };
  const [cw, cardImg] = card('card');
  const [hw, heroImg] = card('hero');
  two.append(cw, hw);
  f2.append(two);
  body.append(f1, f2);

  const paintRects = () => {
    place(cimg, W, H, P.rectFor(W, H, frame, job.views[job.frame]));
    place(cardImg, W, H, P.rectFor(W, H, P.FRAMES.card, job.views.card));
    place(heroImg, W, H, P.rectFor(W, H, P.FRAMES.hero, job.views.hero));
  };
  paintRects();
  const set = (v) => { onView(job.frame, v); paintRects(); };
  range.addEventListener('input', () => set(P.zoomView(W, H, frame, job.views[job.frame], Number(range.value) / 100)));
  // drag: screen pixels → image pixels through the rect's current scale
  let drag = null;
  crop.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, v: job.views[job.frame] };
    if (crop.setPointerCapture && e.pointerId !== undefined) { try { crop.setPointerCapture(e.pointerId); } catch (_) { /* jsdom */ } }
  });
  crop.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = P.rectFor(W, H, frame, drag.v);
    const k = r.w / (crop.clientWidth || r.w);
    set(P.moveView(W, H, frame, drag.v, (e.clientX - drag.x) * k, (e.clientY - drag.y) * k));
  });
  const end = () => { drag = null; };
  crop.addEventListener('pointerup', end); crop.addEventListener('pointercancel', end);
  // keyboard: the arrows move the PHOTO by 5 % of the frame, exactly as a drag in that direction would; + / − zoom by 10 %
  crop.addEventListener('keydown', (e) => {
    const v = job.views[job.frame];
    const r = P.rectFor(W, H, frame, v);
    const step = { ArrowLeft: [-r.w * 0.05, 0], ArrowRight: [r.w * 0.05, 0], ArrowUp: [0, -r.h * 0.05], ArrowDown: [0, r.h * 0.05] }[e.key];
    if (step) { e.preventDefault(); set(P.moveView(W, H, frame, v, step[0], step[1])); return; }
    if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      const nv = P.zoomView(W, H, frame, v, v.z + (e.key === '-' ? -0.1 : 0.1));
      set(nv); range.value = String(Math.round(nv.z * 100));
    }
  });

  const foot = el('div', 'dwf');
  const cancel = el('button', 'btn ghost', P.COPY.cancel); cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  const done = el('button', 'btn accent', P.COPY.done); done.type = 'button';
  done.addEventListener('click', onDone);
  foot.append(cancel, el('span', 'phsp'), done);
  return { head, body, foot };
}

// ── the upload controller ────────────────────────────────────────────────────────────────────────────────────────────
// One job per product key: invalid (P6) → crop (P3) → busy (P4) → done | failed (P5). It never writes the draft itself:
// `deps.apply(key, pid, preview)` does (through the guarded editor), and returns false while the draft is owned — the result
// is then HELD (phase 'ready') and applied by flush() when editing is handed back, never dropped.
//   deps: { rid(), token, gen(), alive(gen), apply(key, pid, preview), changed(key), decode(file) → {W, H}, newOpId(), XHR? }
export function createUploader(deps) {
  const jobs = new Map();
  const cur = (key, job) => jobs.get(key) === job && !job.cancelled;
  const drop = (key) => {
    const j = jobs.get(key);
    if (!j) return;
    j.cancelled = true;
    if (j.abort) j.abort.abort();
    if (j.url && typeof URL !== 'undefined' && URL.revokeObjectURL) { try { URL.revokeObjectURL(j.url); } catch (_) { /* jsdom */ } }
    jobs.delete(key);
  };
  async function take(key, file) {
    drop(key);
    const code = P.checkFile(file);
    if (code) { jobs.set(key, { phase: 'invalid', code }); deps.changed(key); return; }
    const job = { phase: 'reading' };
    jobs.set(key, job);
    let dims = null;
    try { dims = await deps.decode(file); } catch (_) { dims = null; }
    const free = () => { if (dims && dims.url && typeof URL !== 'undefined' && URL.revokeObjectURL) { try { URL.revokeObjectURL(dims.url); } catch (_) { /* jsdom */ } } };
    if (!cur(key, job)) { free(); return; }
    if (!dims) { jobs.set(key, { phase: 'invalid', code: 'bad_type' }); deps.changed(key); return; }
    const small = P.checkDims(dims.W, dims.H) || (P.framesFit(dims.W, dims.H) ? null : 'too_small');
    if (small) { free(); jobs.set(key, { phase: 'invalid', code: small }); deps.changed(key); return; }
    jobs.set(key, { phase: 'crop', file, url: dims.url, W: dims.W, H: dims.H, frame: 'card',
      views: { card: P.initialView(dims.W, dims.H), hero: P.initialView(dims.W, dims.H) } });
    deps.changed(key);
  }
  async function run(key, job) {
    const gen = deps.gen();
    const rid = deps.rid();
    job.phase = 'busy';
    deps.changed(key);
    try {
      if (!job.uploaded) {
        job.uploadId = null;
        const start = await photoUploadStart({ rid, opId: deps.newOpId(), contentType: job.file.type, bytes: job.file.size, token: deps.token });
        if (!cur(key, job) || !deps.alive(gen)) return;
        job.uploadId = start && start.uploadId;
        job.abort = new AbortController();
        await putSigned(start, job.file, { onProgress: (p) => { if (cur(key, job)) { job.progress = p; deps.changed(key, 'progress'); } }, signal: job.abort.signal, XHR: deps.XHR });
        if (!cur(key, job) || !deps.alive(gen)) return;
        job.uploaded = true;
        job.progress = 1;
        job.failures = 0;                 // a NEW upload: its own E-P2 attempt budget (§2.2 attempts < 3)
      }
      job.processing = true;
      const out = await photoProcess({ rid, uploadId: job.uploadId, crops: job.crops, token: deps.token });
      if (!cur(key, job) || !deps.alive(gen)) return;
      if (!out || typeof out.pid !== 'string' || !out.pid) throw Object.assign(new Error('bad_response'), { code: 'unavailable' });
      job.result = { pid: out.pid, preview: out.preview || null };
      settle(key, job);
    } catch (e) {
      if (!cur(key, job) || !deps.alive(gen)) return;
      const code = e && typeof e.code === 'string' ? e.code : null;
      // only a response that CONSUMED one of the server's processing attempts counts toward its 3 (§2.2: a failed decode /
      // read / write → `unavailable`, attempts+1). `in_progress` (the claim was refused — another call holds the lease),
      // `rate_limited`, and a lost response (no answer: unknown) consumed nothing (codex r2 #2)
      if (job.processing && P.CONSUMES_ATTEMPT.includes(code)) job.failures = (job.failures || 0) + 1;
      job.processing = false;
      const c = P.errorCopy(code);
      job.code = code;
      job.phase = c.kind === 'invalid' ? 'invalid' : 'failed';
      if (job.phase === 'invalid') job.uploaded = false;
      deps.changed(key);
    }
  }
  function settle(key, job) {
    if (deps.apply(key, job.result.pid, job.result.preview)) { drop(key); deps.changed(key); return; }
    job.phase = 'ready';           // the draft is owned right now (a review / publish): held, applied by flush()
    deps.changed(key);
  }
  return {
    jobOf: (key) => jobs.get(key) || null,
    busy: () => [...jobs.values()].some((j) => j.phase === 'busy' || j.phase === 'reading' || j.phase === 'ready'),
    // an upload the merchant has open (reading → crop → upload → held): a pending photo for the rename hold (ruling A)
    active: () => [...jobs.values()].some((j) => j.phase === 'reading' || j.phase === 'crop' || j.phase === 'busy' || j.phase === 'ready'),
    take,
    // P3 «Listo»: freeze the two rects (the contract's), then upload
    upload(key) {
      const job = jobs.get(key);
      if (!job || job.phase !== 'crop') return;
      job.crops = P.cropsFor(job.W, job.H, job.views);
      job.uploaded = false;
      run(key, job);
    },
    setFrame(key, id) { const j = jobs.get(key); if (j && j.phase === 'crop' && P.FRAMES[id]) { j.frame = id; deps.changed(key); } },
    setView(key, id, v) { const j = jobs.get(key); if (j && j.phase === 'crop') j.views[id] = v; },
    // «Cancelar» in P3 (nothing uploaded) and in P4 (the PUT is aborted; a call already on the wire is ignored on arrival)
    cancel(key) { drop(key); deps.changed(key); },
    clear(key) { const j = jobs.get(key); if (j && (j.phase === 'invalid' || j.phase === 'failed')) { drop(key); } },
    // P5 «Reintentar»: the same file and crops — E-P2 again when the bytes are in Storage, else a new upload (new op_id)
    retry(key) {
      const job = jobs.get(key);
      if (!job || job.phase !== 'failed') return;
      if (P.retryPlan({ uploaded: job.uploaded, code: job.code, failures: job.failures || 0 }) === 'restart') job.uploaded = false;
      run(key, job);
    },
    flush() { for (const [key, job] of [...jobs]) if (job.phase === 'ready') settle(key, job); },
    abortAll() { for (const key of [...jobs.keys()]) drop(key); },
  };
}
// The oriented size of a picked file, and a blob: URL for the crop step. createImageBitmap with imageOrientation from-image
// is the size E-P2 reads (EXIF applied); an <img> (which also honours EXIF) is the fallback.
export async function decodeFile(file) {
  const url = URL.createObjectURL(file);
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const out = { W: bmp.width, H: bmp.height, url };
      if (bmp.close) bmp.close();
      return out;
    }
    const i = new Image();
    await new Promise((res, rej) => { i.onload = res; i.onerror = rej; i.src = url; });
    return { W: i.naturalWidth, H: i.naturalHeight, url };
  } catch (e) {
    try { URL.revokeObjectURL(url); } catch (_) { /* nothing to free */ }
    throw e;
  }
}
// The system picker. A fresh input per pick (accept the three types; `capture` only for «Tomar foto»), attached while open.
export function openPicker(onFile, { capture = false } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = P.ACCEPT;
  if (capture) input.setAttribute('capture', 'environment');
  input.className = 'hidden';
  input.addEventListener('change', () => { const f = input.files && input.files[0]; input.remove(); if (f) onFile(f); }, { once: true });
  input.addEventListener('cancel', () => input.remove(), { once: true });
  document.body.append(input);
  input.click();
  return input;
}
