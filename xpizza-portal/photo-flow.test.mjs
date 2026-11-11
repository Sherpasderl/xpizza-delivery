// DISH PHOTOS B — the REAL portal (index.html + app.js + shell.js + photo.js + availability.js, auth stubbed) in jsdom, against
// the §2.2 CONTRACT FAKE (photo-contract-fake.mjs): every frame's behaviour P1–P10b, the dark (flag off) path, cancel / retry,
// the photos-only review + seal + receipt, a new product's photo (amendment 1), and the CSP's URL shapes.
// Run: node --test --test-force-exit xpizza-portal/photo-flow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DIR, loadModules, okJson, errJson } from './ventas-harness.mjs';
import { createPhotoFake, DEFAULT_BUCKET, PUBLIC_BUCKET } from './photo-contract-fake.mjs';
import * as L from './photo-logic.js';

const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const OWNER = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'catalog.add_product', 'catalog.fiscal_ack', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const MANAGER_RO = ['availability.set'];
const ITEMS = () => [
  { key: 'Margarita', price: 280, display: { name: 'Margarita', cat: 'cl', price: 280, desc: 'Tomate, mozzarella fresca y albahaca' } },
  { key: 'Pepperoni', price: 310, display: { name: 'Pepperoni', cat: 'cl', price: 310, desc: 'Pepperoni y mozzarella' } },
  { key: 'Hawaiana', price: 300, display: { name: 'Hawaiana', cat: 'cl', price: 300, desc: 'Jamón, piña y mozzarella' } },
];
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 2000) { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) assert.fail(`timed out: ${what}`); await settle(10); } }
const branch = (rid, caps, role) => ({ rid, brand_id: 'marca_s', role, state: 'member', caps, name: 'Centro', identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null });

let blobs = 0;
async function boot(fake, { caps = OWNER, role = 'owner' } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage', 'File']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.CSS = { escape: (x) => String(x).replace(/["\\]/g, '\\$&') };   // jsdom has no CSS.escape (the ventas harness stubs it too)
  globalThis.__branchesDirect = true;
  globalThis.XMLHttpRequest = fake.XHR;
  // the decode seam: a test file carries its EXIF-oriented size; anything else does not decode
  globalThis.createImageBitmap = async (f) => { if (!f || !f.__dims) throw new Error('undecodable'); return { width: f.__dims.W, height: f.__dims.H, close() {} }; };
  URL.createObjectURL = () => `blob:https://portal.test/${++blobs}`;
  URL.revokeObjectURL = () => {};
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const fn = u.pathname.split('/').pop();
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    calls.push({ fn, body, url: String(url) });
    if (fn === 'getMyBranches') return okJson({ brands: [{ brand_id: 'marca_s', name: 'Marca S' }], branches: [branch(fake.rid, caps, role)], membership_writes_enabled: false });
    const r = await fake.fetchHandler(fn, body || Object.fromEntries(u.searchParams));
    return r.status === 200 ? okJson(r.body) : errJson(r.status, r.body);
  };
  const mods = await loadModules();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: `uPh${blobs}${Date.now()}` } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(60);
  return { w, d: w.document, mods, calls };
}
const mkFile = (w, { name = 'pep.jpg', type = 'image/jpeg', size = 300000, W = 1600, H = 1200 } = {}) => {
  const f = new w.File([new Uint8Array(size)], name, { type });
  if (W) Object.defineProperty(f, '__dims', { value: { W, H } });
  Object.defineProperty(f, '__content', { value: `${name}:${size}:${W}x${H}` });
  return f;
};
// the system picker: the input photo.js attached for this pick receives the file
async function choose(d, w, file) {
  const inputs = [...d.querySelectorAll('input[type=file]')];
  const input = inputs[inputs.length - 1];
  assert.ok(input, 'a picker input is open');
  assert.equal(input.accept, 'image/jpeg,image/png,image/webp');
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new w.Event('change'));
  await settle(30);
  return input;
}
const rowOf = (d, name) => [...d.querySelectorAll('#detail .irow')].find((r) => r.querySelector('.nm') && r.querySelector('.nm').firstChild.textContent === name);
const drawer = (d) => d.getElementById('drawer');
const btnText = (root, t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
const n = (calls, fn) => calls.filter((c) => c.fn === fn).length;
async function openDrawerFor(d, name) { rowOf(d, name).querySelector('.rowchev').click(); await settle(); }
// P2 → P3 → «Listo» → P4 → P7, through the real UI
async function uploadVia(d, w, fake, name, file) {
  rowOf(d, name).querySelector('button.thumb').click();     // the camera: the drawer WITH the picker
  await settle();
  await choose(d, w, file);
  await until(() => drawer(d).querySelector('.phcrop'), 'the crop step');
  btnText(drawer(d), 'Listo').click();
}

test('DARK — uploads off and no photo data: today\'s placeholder, no «Foto» field, no photo call, a save body with no `photos`', async () => {
  // E-P3 sends legacyPreviews whatever the flag: the dark portal must still look exactly as today
  const fake = createPhotoFake({ items: ITEMS(), photosEnabled: false, legacy: { Pepperoni: true } });
  const { d, calls } = await boot(fake);
  const r = rowOf(d, 'Pepperoni');
  const th = r.querySelector('.thumb');
  assert.equal(th.tagName, 'DIV'); assert.equal(th.title, 'Editar producto'); assert.equal(th.children.length, 0, 'today\'s empty placeholder');
  await openDrawerFor(d, 'Pepperoni');
  assert.ok(![...drawer(d).querySelectorAll('label')].some((l) => l.textContent === 'Foto'), 'no «Foto» field');
  drawer(d).querySelector('input[aria-label="Precio"]').value = '320';
  drawer(d).querySelector('input[aria-label="Precio"]').dispatchEvent(new window.Event('input'));
  d.getElementById('review').click();
  await until(() => n(calls, 'editCatalog') === 1, 'the save');
  const body = calls.find((c) => c.fn === 'editCatalog').body;
  assert.ok(!('photos' in body.source), 'a photo-less save is byte-identical: no `photos` key at all');
  assert.equal(n(calls, 'photoUploadStart') + n(calls, 'photoProcess'), 0);
});

test('P1 → P2 → P3 → P4 → P7 — the camera opens the drawer with the picker; crop; the signed PUT carries exactly the signed headers; the row and the bar', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  const r = rowOf(d, 'Pepperoni');
  const cam = r.querySelector('button.thumb');
  assert.equal(cam.title, 'Subir foto'); assert.equal(cam.getAttribute('aria-label'), 'Subir foto de Pepperoni');
  cam.click();
  await settle();
  // P1: the field is first in the drawer, the zone is a real button
  const firstLabel = drawer(d).querySelector('.dwb .fld > label');
  assert.equal(firstLabel.textContent, 'Foto');
  assert.equal(drawer(d).querySelector('button.uploader.phdesk b').textContent, 'Subí una foto');
  // P3
  await choose(d, w, mkFile(w, { W: 1600, H: 1200 }));
  await until(() => drawer(d).querySelector('.phcrop'), 'the crop step');
  assert.equal(drawer(d).querySelector('.dwt').textContent, 'Ajustar foto');
  const tabs = [...drawer(d).querySelectorAll('[role=tab]')];
  assert.deepEqual(tabs.map((t) => t.textContent), ['Tarjeta (4:3)', 'Detalle (16:10)']);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(drawer(d).querySelector('.phcrop').getAttribute('aria-label'), 'Foto de Pepperoni, encuadre de tarjeta. Arrastrá para moverla.');
  assert.equal(drawer(d).querySelector('.phoname').textContent, 'Pepperoni');
  assert.equal(drawer(d).querySelector('.phoprice').textContent, 'L 310');
  // zoom the card to 150 % and switch to the hero, which keeps its own view
  const range = drawer(d).querySelector('input[type=range]');
  assert.equal(range.max, '200');
  range.value = '150'; range.dispatchEvent(new w.Event('input'));
  tabs[1].click(); await settle();
  assert.equal(drawer(d).querySelector('[role=tab][aria-selected=true]').textContent, 'Detalle (16:10)');
  assert.equal(drawer(d).querySelector('input[type=range]').value, '100', 'the hero keeps its own zoom');
  // «Listo» → E-P1 → PUT → E-P2
  btnText(drawer(d), 'Listo').click();
  await until(() => n(calls, 'photoProcess') === 1, 'E-P2');
  const start = calls.find((c) => c.fn === 'photoUploadStart').body;
  assert.deepEqual(Object.keys(start).sort(), ['bytes', 'contentType', 'op_id', 'rid']);
  assert.equal(start.rid, fake.rid); assert.equal(start.contentType, 'image/jpeg'); assert.equal(start.bytes, 300000);
  const [put] = fake.puts;
  assert.ok(put.url.startsWith(`https://storage.googleapis.com/${DEFAULT_BUCKET}/uploads/`), 'path-style upload URL');
  assert.deepEqual(put.headers, { 'Content-Type': 'image/jpeg', 'x-goog-content-length-range': '1,10485760', 'x-goog-if-generation-match': '0' }, 'EXACTLY the signed headers — nothing invented');
  const proc = calls.find((c) => c.fn === 'photoProcess').body;
  assert.deepEqual(proc.crops, { card: { x: 267, y: 200, w: 1066, h: 800 }, hero: { x: 0, y: 100, w: 1600, h: 1000 } }, 'the card zoomed 150 %, the hero untouched');
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'P7');
  // P7: the drawer, the row, the bar
  const acts = [...drawer(d).querySelectorAll('.phacts .uprm')].map((b) => b.textContent);
  assert.deepEqual(acts, ['Cambiar', 'Quitar']);
  assert.equal(drawer(d).querySelector('.uphoto img').alt, 'Foto de Pepperoni');
  const row = rowOf(d, 'Pepperoni');
  const th = row.querySelector('button.thumb');
  assert.ok(th.classList.contains('set') && th.classList.contains('phchg'), 'the draft mark');
  assert.match(th.querySelector('img').src, new RegExp(`/${DEFAULT_BUCKET}/drafts/`), 'the E-P2 draft preview');
  assert.equal(row.querySelector('.tag.phtag').textContent, 'Foto sin publicar');
  assert.equal(d.getElementById('rbtxt').textContent, '1 cambio sin publicar · 1 foto');
  // the next save sends the map, whole
  d.getElementById('review').click();
  await until(() => n(calls, 'editCatalog') === 1, 'the save');
  const pid = calls.find((c) => c.fn === 'photoProcess') && fake.uploads.values().next().value.result.pid;
  assert.deepEqual(calls.find((c) => c.fn === 'editCatalog').body.source.photos, { Pepperoni: { state: 'pid', pid } });
});

test('P6 — too large / not JPG-PNG-WEBP / too small: the inline error, the zone ready again, nothing uploaded', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  await openDrawerFor(d, 'Margarita');
  for (const [file, text] of [
    [mkFile(w, { size: L.MAX_BYTES + 1 }), 'Ese archivo pesa más de 10 MB. Elegí una foto más liviana.'],
    [mkFile(w, { name: 'x.heic', type: 'image/heic' }), 'Ese archivo no es JPG, PNG ni WEBP.'],
    [mkFile(w, { W: 499, H: 440 }), 'Esa foto es muy pequeña: necesita al menos 500×440 px.'],
    [mkFile(w, { W: null }), 'Ese archivo no es JPG, PNG ni WEBP.'],    // declared JPEG that does not decode
  ]) {
    btnText(drawer(d), '') || drawer(d).querySelector('button.uploader.phdesk').click();
    drawer(d).querySelector('button.uploader.phdesk').click();
    await choose(d, w, file);
    await until(() => drawer(d).querySelector('.ferr'), `error for ${file.name}`);
    const fld = drawer(d).querySelector('.fld.invalid');
    assert.ok(fld, '.fld.invalid');
    assert.equal(fld.querySelector('.ferr span').textContent, text);
    assert.equal(fld.querySelector('.ferr').getAttribute('role'), 'alert');
    assert.ok(fld.querySelector('button.uploader.phinv'), 'the zone, ready for another file');
  }
  assert.equal(n(calls, 'photoUploadStart'), 0, 'nothing reached the server');
  assert.equal(d.getElementById('rbtxt').textContent, 'Revisá si hay algo sin publicar', 'the draft did not change');
});

test('P4 «Cancelar» — the PUT is aborted, E-P2 never runs, the drawer and the draft are as before', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  const release = fake.holdPut();
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.phbar'), 'P4');
  const bar = drawer(d).querySelector('.phbar');
  assert.equal(bar.getAttribute('role'), 'progressbar'); assert.equal(bar.getAttribute('aria-label'), 'Subiendo foto');
  await until(() => bar.getAttribute('aria-valuenow') === '62', 'the progress, in place');
  assert.equal(drawer(d).querySelector('.phov span').textContent, 'Subiendo foto…');
  assert.ok(d.getElementById('review').disabled, 'the review waits for the photo in flight');
  btnText(drawer(d), 'Cancelar').click();
  release();
  await settle(60);
  assert.equal(n(calls, 'photoProcess'), 0);
  assert.equal(fake.puts[0].aborted, true, 'the PUT itself was aborted — the bytes stop, not only the result');
  assert.ok(drawer(d).querySelector('button.uploader.phdesk'), 'back to the zone');
  assert.equal(d.getElementById('rbtxt').textContent, 'Revisá si hay algo sin publicar');
  assert.equal(d.getElementById('review').disabled, false);
});

test('P5 «Reintentar» — a transient E-P2 failure re-calls E-P2 with the SAME upload and crops; a failed PUT starts again with a NEW op_id', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  fake.failNext('photoProcess', 503, { error: 'unavailable', retryable: true });
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.ferr'), 'P5');
  assert.equal(drawer(d).querySelector('.ferr span').textContent, 'No se pudo subir la foto.');
  assert.ok(drawer(d).querySelector('button.uploader.phinv'), 'no photo before: the zone with the error');
  btnText(drawer(d), 'Reintentar').click();
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'the retry landed');
  const procs = calls.filter((c) => c.fn === 'photoProcess').map((c) => c.body);
  assert.equal(procs.length, 2); assert.deepEqual(procs[0], procs[1], 'the same uploadId and crops');
  assert.equal(n(calls, 'photoUploadStart'), 1, 'no new upload');
  // a PUT that never answered: Reintentar = a new upload with a NEW op_id
  fake.failNext('PUT', 0);
  await uploadVia(d, w, fake, 'Margarita', mkFile(w, { name: 'mar.jpg' }));
  await until(() => drawer(d).querySelector('.ferr'), 'P5 after the PUT');
  btnText(drawer(d), 'Reintentar').click();
  await until(() => n(calls, 'photoProcess') === 3, 'E-P2 after the restart');
  const starts = calls.filter((c) => c.fn === 'photoUploadStart').map((c) => c.body.op_id);
  assert.equal(starts.length, 3); assert.notEqual(starts[1], starts[2], 'a NEW op_id');
  // the object is gone: upload_missing → start again
  fake.failNext('photoProcess', 409, { error: 'upload_missing' });
  await uploadVia(d, w, fake, 'Hawaiana', mkFile(w, { name: 'haw.jpg' }));
  await until(() => drawer(d).querySelector('.ferr'), 'upload_missing');
  btnText(drawer(d), 'Reintentar').click();
  await until(() => n(calls, 'photoUploadStart') === 5, 'restart after upload_missing');
});

test('P7 «Quitar» on a published photo = a removal draft with «Deshacer»; undo restores the state exactly', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.registry.set('pidPub', { state: 'published' });
  fake.active.photos = { Pepperoni: { state: 'pid', pid: 'pidPub' } };
  fake.draft.photos = { Pepperoni: { state: 'pid', pid: 'pidPub' } };
  const { d } = await boot(fake);
  let th = rowOf(d, 'Pepperoni').querySelector('button.thumb');
  assert.ok(th.classList.contains('set') && !th.classList.contains('phchg'), 'published: no draft mark');
  assert.equal(th.querySelector('img').src, `https://storage.googleapis.com/${PUBLIC_BUCKET}/photos/${fake.rid}/pidPub-card.webp`);
  assert.ok(th.querySelector('.cam svg'), 'the camera badge');
  await openDrawerFor(d, 'Pepperoni');
  btnText(drawer(d), 'Quitar').click(); await settle();
  assert.equal(drawer(d).querySelector('.phrm span').textContent, 'La foto actual se quita al publicar.');
  assert.ok(drawer(d).querySelector('button.uploader.phdesk'), 'the field is the empty zone again');
  const row = rowOf(d, 'Pepperoni');
  assert.ok(row.querySelector('button.thumb').classList.contains('phrmthumb'), 'the dimmed thumb');
  assert.equal(row.querySelector('.tag.phtag').textContent, 'Se quita la foto');
  assert.equal(d.getElementById('rbtxt').textContent, '1 cambio sin publicar · 1 foto');
  btnText(drawer(d), 'Deshacer').click(); await settle();
  assert.ok(drawer(d).querySelector('.uphoto img'));
  assert.equal(d.getElementById('rbtxt').textContent, 'Revisá si hay algo sin publicar');
  th = rowOf(d, 'Pepperoni').querySelector('button.thumb');
  assert.ok(!th.classList.contains('phchg'));
});

test('a LEGACY image (E-P3 legacyPreviews) is a photo: Cambiar / Quitar; a key with no URL is the neutral frame, still truthful', async () => {
  const fake = createPhotoFake({ items: ITEMS(), legacy: { Hawaiana: true, Margarita: 'nourl' } });
  const { d, calls } = await boot(fake);
  const haw = rowOf(d, 'Hawaiana').querySelector('button.thumb.set');
  assert.match(haw.querySelector('img').src, new RegExp(`/${PUBLIC_BUCKET}/photos/${fake.rid}/legacy/`), 'served from the PUBLIC bucket (amendment 2)');
  const mar = rowOf(d, 'Margarita').querySelector('button.thumb.set');
  assert.ok(mar && !mar.querySelector('img'), 'no URL: the neutral frame, not the camera, not a broken image');
  await openDrawerFor(d, 'Hawaiana');
  btnText(drawer(d), 'Quitar').click(); await settle();
  assert.equal(drawer(d).querySelector('.phrm span').textContent, 'La foto actual se quita al publicar.');
  d.getElementById('review').click();
  await until(() => n(calls, 'editCatalog') === 1, 'the save');
  assert.deepEqual(calls.find((c) => c.fn === 'editCatalog').body.source.photos, { Hawaiana: { state: 'removed' } }, 'legacy → an explicit removal');
  await until(() => d.querySelector('#mbody .mgroup'), 'the review');
  const line = [...d.querySelectorAll('#mbody .prow')].find((p) => p.querySelector('.pname').textContent === 'Hawaiana');
  assert.equal(line.querySelector('.psub').textContent, 'Foto quitada');
  assert.ok(line.querySelector('.phpth.was img'), '«antes»: the legacy thumbnail');
  assert.equal(line.querySelector('.now.phnone').textContent, 'Sin foto');
});

test('P8 + P9 — photos only on a FISCAL brand: the «Fotos» group, the photos seal (Publicar gated on Autorizo), the photo receipt', async () => {
  const fake = createPhotoFake({ items: ITEMS(), usesPlatformFactura: true });
  const { d, w, calls } = await boot(fake);
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'P7');
  d.getElementById('review').click();
  await until(() => d.querySelector('#mbody .seal'), 'the review');
  const g = d.querySelector('#mbody .mgroup');
  assert.equal(g.querySelector('.mglabel span').textContent, 'Fotos');
  assert.equal(g.querySelector('.mgn').textContent, '1');
  const line = g.querySelector('.prow');
  assert.equal(line.querySelector('.pname').textContent, 'Pepperoni');
  assert.equal(line.querySelector('.psub').textContent, 'Foto nueva');
  assert.equal(line.querySelector('.was.phnone').textContent, 'Sin foto');
  assert.ok(line.querySelector('.phpth img'), 'después: the card thumb');
  const seal = d.querySelector('#mbody .seal.phseal');
  assert.equal(seal.querySelector('.sealh span').textContent, 'Esta publicación requiere tu autorización como propietario');
  assert.equal(seal.querySelector('.sealbody p').textContent, 'Como propietario, autorizás esta publicación. No cambia ningún precio: solo las fotos de los productos.');
  assert.deepEqual([...seal.querySelectorAll('.seachg')].map((c) => `${c.querySelector('.sn').textContent}|${c.querySelector('.sv').textContent}`), ['Pepperoni|Foto nueva']);
  assert.equal(seal.querySelector('.at').textContent, 'Autorizo publicar la foto de este producto.');
  const pub = d.getElementById('pubbtn');
  assert.equal(pub.disabled, true, 'Publicar waits for Autorizo');
  const cb = seal.querySelector('input[type=checkbox]');
  cb.checked = true; cb.dispatchEvent(new w.Event('change'));
  assert.equal(pub.disabled, false);
  pub.click();
  await until(() => d.querySelector('#mbody .receipt'), 'P9');
  assert.equal(calls.find((c) => c.fn === 'publishEdited').body.fiscalAck, true);
  assert.equal(d.querySelector('#mbody .receipt p').textContent, 'La foto de «Pepperoni» ya está en el menú publicado.');
  // after: the published photo, no draft mark
  await until(() => n(calls, 'getEditableCatalog') >= 2, 'the post-publish reload');
  await settle(40);
  const th = rowOf(d, 'Pepperoni').querySelector('button.thumb');
  assert.ok(!th.classList.contains('phchg'));
  assert.match(th.querySelector('img').src, new RegExp(`/${PUBLIC_BUCKET}/photos/`));
});

test('amendment 1 — a NEW product\'s photo travels with its first save under its tmp ref, re-keyed by the server, «Foto nueva» in the review', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  btnText(d.getElementById('detail'), 'Agregar producto').click();
  await settle();
  assert.equal(drawer(d).querySelector('.dwt').firstChild.textContent, 'Nuevo producto');
  assert.ok(drawer(d).querySelector('button.uploader.phdesk'), 'P1 inset: the zone replaces «Foto: próximamente»');
  const name = drawer(d).querySelector('input[aria-label="Nombre"]');
  name.value = 'Calzone'; name.dispatchEvent(new w.Event('input'));
  const price = drawer(d).querySelector('input[aria-label="Precio"]');
  price.value = '350'; price.dispatchEvent(new w.Event('input'));
  drawer(d).querySelector('button.uploader.phdesk').click();
  await choose(d, w, mkFile(w, { name: 'cal.jpg' }));
  await until(() => drawer(d).querySelector('.phcrop'), 'crop');
  assert.equal(drawer(d).querySelector('.phoname').textContent, 'Calzone');
  btnText(drawer(d), 'Listo').click();
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'the new product\'s photo');
  d.getElementById('review').click();
  await until(() => n(calls, 'editCatalog') === 1, 'the save');
  const sent = calls.find((c) => c.fn === 'editCatalog').body.source;
  const ref = sent.items.find((i) => i.ref).ref;
  assert.ok(ref.startsWith('tmp:') && sent.photos[ref] && sent.photos[ref].state === 'pid', 'sent under the tmp ref');
  await until(() => d.querySelector('#mbody .prow'), 'the review');
  const line = [...d.querySelectorAll('#mbody .prow')].find((p) => p.querySelector('.psub') && p.querySelector('.psub').textContent === 'Foto nueva');
  assert.ok(line, '«Foto nueva»'); assert.equal(line.querySelector('.pname').textContent, 'Calzone');
  assert.deepEqual(Object.keys(fake.draft.photos), ['Calzone'], 'the server holds it under the allocated key');
});

test('flags OFF with a stored map — no uploader, the photo still shows, and every save sends the map back unchanged', async () => {
  const fake = createPhotoFake({ items: ITEMS(), photosEnabled: false });
  fake.registry.set('pidD', { state: 'draft' });
  fake.draft.photos = { Pepperoni: { state: 'pid', pid: 'pidD' } };
  const { d, calls } = await boot(fake);
  const th = rowOf(d, 'Pepperoni').querySelector('button.thumb.set');
  assert.ok(th && th.querySelector('img') && !th.querySelector('.cam'), 'shown, without the camera badge');
  assert.equal(rowOf(d, 'Margarita').querySelector('.thumb').tagName, 'DIV', 'a dish without one: today\'s placeholder');
  await openDrawerFor(d, 'Pepperoni');
  assert.ok(drawer(d).querySelector('.uphoto img') && !drawer(d).querySelector('.phacts'), 'no Cambiar / Quitar: no control without effect');
  const inp = drawer(d).querySelector('input[aria-label="Precio"]');
  inp.value = '330'; inp.dispatchEvent(new window.Event('input'));
  d.getElementById('review').click();
  await until(() => d.querySelector('#mbody .mgroup'), 'the review (no photo_change_disabled)');
  assert.deepEqual(calls.find((c) => c.fn === 'editCatalog').body.source.photos, { Pepperoni: { state: 'pid', pid: 'pidD' } });
});

test('P10b — a manager without the menu permission sees each branch\'s PUBLISHED card (E-P4 branches[i].photos), and no square without one', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.registry.set('pidPub', { state: 'published' });
  fake.active.photos = { Pepperoni: { state: 'pid', pid: 'pidPub' }, Margarita: { state: 'removed' } };
  const { d } = await boot(fake, { caps: MANAGER_RO, role: 'manager' });
  await until(() => rowOf(d, 'Pepperoni'), 'the read-only menu');
  const th = rowOf(d, 'Pepperoni').querySelector('.thumb');
  assert.ok(th.classList.contains('set') && th.classList.contains('phro') && th.tagName === 'DIV', 'a plain picture, no button');
  assert.equal(th.getAttribute('aria-hidden'), 'true');
  assert.equal(th.querySelector('img').src, `https://storage.googleapis.com/${PUBLIC_BUCKET}/photos/${fake.rid}/pidPub-card.webp`);
  assert.equal(rowOf(d, 'Margarita').querySelector('.thumb'), null, 'no photo: no square');
});

test('preview renewal — an image that fails to load triggers ONE re-read of getEditableCatalog; the draft on screen is kept', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.registry.set('pidPub', { state: 'published' });
  fake.active.photos = { Pepperoni: { state: 'pid', pid: 'pidPub' } };
  fake.draft.photos = { Pepperoni: { state: 'pid', pid: 'pidPub' } };
  const { d, w, calls } = await boot(fake);
  const reads = n(calls, 'getEditableCatalog');
  const inp = rowOf(d, 'Hawaiana').querySelector('.price input');
  inp.value = '305'; inp.dispatchEvent(new w.Event('input'));          // an unsaved edit that must survive the renewal
  rowOf(d, 'Pepperoni').querySelector('button.thumb img').dispatchEvent(new w.Event('error'));
  await until(() => n(calls, 'getEditableCatalog') === reads + 1, 'one renewal read');
  await settle(40);
  assert.equal(d.getElementById('rbtxt').textContent, '1 cambio sin publicar', 'the unsaved price edit is still there');
  rowOf(d, 'Pepperoni').querySelector('button.thumb img').dispatchEvent(new w.Event('error'));
  await settle(60);
  assert.equal(n(calls, 'getEditableCatalog'), reads + 1, 'a second failure does not re-read again');
  assert.ok(rowOf(d, 'Pepperoni').querySelector('button.thumb:not(.set)'), 'a pid it still cannot show: the camera, never a broken image');
});

test('CSP (P2-10) — the URLs the contract emits are exactly the path-scoped sources the portal admits; anything else is outside', () => {
  const toml = readFileSync(join(DIR, 'netlify.toml'), 'utf8');
  const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)[1];
  const dir = (name) => (csp.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name} `)) || '').split(/\s+/).slice(1);
  const img = dir('img-src'), connect = dir('connect-src');
  // the public bucket is ONE constant (⚠️ placeholder until A0): here, and in the fake
  assert.ok(img.includes(`https://storage.googleapis.com/${PUBLIC_BUCKET}/photos/`), 'img-src: the public photos/ prefix');
  assert.ok(img.includes(`https://storage.googleapis.com/${DEFAULT_BUCKET}/drafts/`), 'img-src: the drafts/ prefix');
  assert.ok(img.includes('blob:'), 'img-src: blob: (the crop step)');
  assert.ok(connect.includes(`https://storage.googleapis.com/${DEFAULT_BUCKET}/uploads/`), 'connect-src: the uploads/ prefix');
  assert.ok(!dir('connect-src').includes('blob:'), 'blob: in img-src only');
  for (const d of [img, connect]) assert.ok(!d.some((s) => s === 'https://storage.googleapis.com' || s === 'https:' || s === '*'), 'never the bare host or a wildcard');
  // CSP path matching: a source ending in "/" admits that path prefix only
  const admits = (list, url) => list.some((s) => s.endsWith('/') && url.startsWith(s));
  const fake = createPhotoFake({ items: ITEMS() });
  fake.caps.add('catalog.edit');
  const up = fake.fetchHandler('photoUploadStart', { rid: fake.rid, op_id: 'op:1', contentType: 'image/png', bytes: 10 });
  return up.then((r) => {
    assert.ok(admits(connect, r.body.url), `the signed PUT URL is admitted: ${r.body.url}`);
    assert.ok(!admits(img, r.body.url), 'an upload URL is not an image source');
    assert.ok(admits(img, `https://storage.googleapis.com/${PUBLIC_BUCKET}/photos/${fake.rid}/P-card.webp`));
    assert.ok(admits(img, `https://storage.googleapis.com/${DEFAULT_BUCKET}/drafts/${fake.rid}/P-card.webp?X-Goog-Signature=x`));
    for (const out of [`https://${DEFAULT_BUCKET}.storage.googleapis.com/uploads/r/u`, `https://storage.googleapis.com/${DEFAULT_BUCKET}/photos/x`,
      `https://storage.googleapis.com/other-bucket/uploads/r/u`, `https://storage.googleapis.com/${DEFAULT_BUCKET}/uploadsX/r`, 'https://xpizza-orders.netlify.app/images/a.jpg']) {
      assert.ok(!admits(connect, out) && !admits(img, out), `outside the policy: ${out}`);
    }
  });
});

test('P3 keyboard — the arrows move the PHOTO like a drag: ← twice on the card shows more of its right (the frame moves right)', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  rowOf(d, 'Pepperoni').querySelector('button.thumb').click(); await settle();
  await choose(d, w, mkFile(w, { W: 1600, H: 1200 }));
  await until(() => drawer(d).querySelector('.phcrop'), 'the crop step');
  const range = drawer(d).querySelector('input[type=range]');
  range.value = '150'; range.dispatchEvent(new w.Event('input'));
  const crop = drawer(d).querySelector('.phcrop');
  assert.equal(crop.tabIndex, 0, 'keyboard-operable');
  for (let i = 0; i < 2; i++) crop.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  crop.dispatchEvent(new w.KeyboardEvent('keydown', { key: '+', bubbles: true }));
  assert.equal(drawer(d).querySelector('input[type=range]').value, '160', '+ zooms by 10 %, and the slider follows');
  btnText(drawer(d), 'Listo').click();
  await until(() => n(calls, 'photoProcess') === 1, 'E-P2');
  const card = calls.find((c) => c.fn === 'photoProcess').body.crops.card;
  assert.equal(card.w, 1000, '160 % of the 1600 px base');
  assert.ok(card.x > 300, `two ← moved the frame right over the photo (x ${card.x}); centred at 160 % it would be 300`);
});

test('P1 cajón → P2 on a PHONE — the zone (and the row camera) expand in place into «Tomar foto» / «Elegir de la galería»; no picker until one is chosen', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w } = await boot(fake);
  window.matchMedia = (q) => ({ matches: /max-width:\s*560px/.test(q) });   // a 390 screen
  await openDrawerFor(d, 'Pepperoni');
  assert.ok(drawer(d).querySelector('button.uploader.phdesk') && !drawer(d).querySelector('.uploader.phph2'), 'P1 cajón: the plain zone');
  drawer(d).querySelector('button.uploader.phdesk').click(); await settle();
  assert.equal(d.querySelectorAll('input[type=file]').length, 0, 'no picker yet');
  const two = [...drawer(d).querySelectorAll('.phph2b .btn')].map((b) => b.textContent.trim());
  assert.deepEqual(two, ['Tomar foto', 'Elegir de la galería'], 'P2: the same zone, expanded');
  btnText(drawer(d), 'Tomar foto').click();
  const input = [...d.querySelectorAll('input[type=file]')].pop();
  assert.equal(input.getAttribute('capture'), 'environment', '«Tomar foto»: the camera');
  // the row camera on a phone opens the drawer straight on P2
  closeBtn(drawer(d)).click();
  rowOf(d, 'Margarita').querySelector('button.thumb').click(); await settle();
  assert.ok(drawer(d).querySelector('.uploader.phph2'), 'the row camera: the drawer with the choice open');
  delete window.matchMedia;
  void w;
});

// ── Codex build r1 (2026-10-27): the seven P2s, each pinned ─────────────────────────────────────────────────────────────

test('codex r1 #1 — removing an unsaved new product removes its photo entry too: the next save is valid (no orphan tmp key)', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  btnText(d.getElementById('detail'), 'Agregar producto').click(); await settle();
  drawer(d).querySelector('button.uploader.phdesk').click();
  await choose(d, w, mkFile(w, { name: 'nuevo.jpg' }));
  await until(() => drawer(d).querySelector('.phcrop'), 'crop');
  btnText(drawer(d), 'Listo').click();
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'the photo on the new product');
  [...drawer(d).querySelectorAll('.dwf button')].find((b) => b.textContent === 'Quitar').click();   // the PRODUCT's Quitar
  await settle();
  const price = rowOf(d, 'Pepperoni').querySelector('.price input');
  price.value = '320'; price.dispatchEvent(new w.Event('input'));   // something else to save
  d.getElementById('review').click();
  await until(() => d.querySelector('#mbody .mgroup'), 'the save succeeded (no validation error)');
  const body = calls.find((c) => c.fn === 'editCatalog').body;
  assert.ok(!('photos' in body.source), `no orphan photo entry: ${JSON.stringify(body.source.photos)}`);
});

test('codex r1 #2 — renewal is BOUNDED: an unsaved upload E-P3 does not know is read once, then never re-scheduled; no zero-delay loop', async () => {
  const fake = createPhotoFake({ items: ITEMS(), draftTtlMs: 60e3 });   // inside the 5-min renewal window from the start
  const { d, w, calls } = await boot(fake);
  const before = n(calls, 'getEditableCatalog');
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'P7');
  await until(() => n(calls, 'getEditableCatalog') === before + 1, 'the one renewal read (its preview expires inside the window)');
  await settle(400);
  assert.equal(n(calls, 'getEditableCatalog'), before + 1, 'the unsaved pid came back absent → stale → no further reads');
  // its picture then fails: ONE more read for that photo at most, and then the neutral frame — never a loop, never a broken image
  rowOf(d, 'Pepperoni').querySelector('button.thumb img').dispatchEvent(new w.Event('error'));
  await settle(200);
  const reads = n(calls, 'getEditableCatalog');
  const th = rowOf(d, 'Pepperoni').querySelector('button.thumb');
  if (th.querySelector('img')) th.querySelector('img').dispatchEvent(new w.Event('error'));
  await settle(300);
  assert.ok(n(calls, 'getEditableCatalog') <= reads, 'no read after the photo already had its retry');
  const th2 = rowOf(d, 'Pepperoni').querySelector('button.thumb');
  assert.ok(th2.classList.contains('set') && !th2.querySelector('img'), 'the neutral frame: still a photo, no broken image');
});

test('codex r1 #3 — "one retry" is per PHOTO: a renewed (different) signed URL that fails again does not trigger another read', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.registry.set('pidD', { state: 'draft' });
  fake.draft.photos = { Pepperoni: { state: 'pid', pid: 'pidD' } };
  const { d, w, calls } = await boot(fake);
  const reads = n(calls, 'getEditableCatalog');
  const url1 = rowOf(d, 'Pepperoni').querySelector('button.thumb img').src;
  rowOf(d, 'Pepperoni').querySelector('button.thumb img').dispatchEvent(new w.Event('error'));
  await until(() => n(calls, 'getEditableCatalog') === reads + 1, 'the one renewal');
  await settle(60);
  const img2 = rowOf(d, 'Pepperoni').querySelector('button.thumb img');
  assert.ok(img2 && img2.src !== url1, 'the renewal minted a NEW signed URL');
  img2.dispatchEvent(new w.Event('error'));
  await settle(300);
  assert.equal(n(calls, 'getEditableCatalog'), reads + 1, 'the same photo, another URL: no second read');
});

test('codex r1 #4 — a renewal updates the OPEN review\'s thumbnails in place: same nodes, the fiscal tick kept, the listener re-armed', async () => {
  const fake = createPhotoFake({ items: ITEMS(), usesPlatformFactura: true });
  fake.registry.set('pidD', { state: 'draft' });
  fake.draft.photos = { Pepperoni: { state: 'pid', pid: 'pidD' } };
  const { d, w, calls } = await boot(fake);
  d.getElementById('review').click();
  await until(() => d.querySelector('#mbody .seal.phseal'), 'P8');
  const seal = d.querySelector('#mbody .seal.phseal');
  const cb = seal.querySelector('input[type=checkbox]');
  cb.checked = true; cb.dispatchEvent(new w.Event('change'));
  assert.equal(d.getElementById('pubbtn').disabled, false);
  const img = d.querySelector('#mbody img[data-ph="pid:pidD"]');
  assert.ok(img, 'the review thumb carries its photo identity');
  const before = img.getAttribute('src');
  const reads = n(calls, 'getEditableCatalog');
  img.dispatchEvent(new w.Event('error'));
  await until(() => n(calls, 'getEditableCatalog') === reads + 1, 'the renewal read');
  await settle(60);
  assert.equal(d.querySelector('#mbody img[data-ph="pid:pidD"]'), img, 'the SAME node');
  assert.notEqual(img.getAttribute('src'), before, 'its picture replaced in place');
  assert.equal(d.querySelector('#mbody .seal.phseal'), seal, 'the review was not rebuilt');
  assert.equal(cb.checked, true, 'the fiscal acknowledgement kept');
  assert.equal(d.getElementById('pubbtn').disabled, false, '…and Publicar still enabled');
  img.dispatchEvent(new w.Event('error'));                          // the re-armed listener fires: no read (one per photo)
  await settle(200);
  assert.equal(n(calls, 'getEditableCatalog'), reads + 1);
  assert.equal(d.querySelector('#mbody img[data-ph="pid:pidD"]'), null, 'a second failure: the neutral frame, no broken image');
  assert.ok(d.querySelector('#mbody .phpth'), 'the frame stays');
});

test('codex r1 #5 — after the THIRD failed processing call (terminal per §2.2) «Reintentar» starts a FRESH upload, never E-P2 on that uploadId', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  fake.failNext('photoProcess', 503, { error: 'unavailable', retryable: true });
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  for (let k = 2; k <= 3; k++) {
    await until(() => drawer(d).querySelector('.ferr'), `failure ${k - 1}`);
    fake.failNext('photoProcess', 503, { error: 'unavailable', retryable: true });
    btnText(drawer(d), 'Reintentar').click();
    await until(() => n(calls, 'photoProcess') === k, `E-P2 attempt ${k}`);
  }
  await until(() => drawer(d).querySelector('.ferr'), 'failure 3');
  const procs = calls.filter((c) => c.fn === 'photoProcess').map((c) => c.body.uploadId);
  assert.equal(new Set(procs).size, 1, 'three tries on one upload');
  assert.equal(n(calls, 'photoUploadStart'), 1);
  btnText(drawer(d), 'Reintentar').click();
  await until(() => n(calls, 'photoUploadStart') === 2, 'a FRESH upload after the terminal third failure');
  await until(() => n(calls, 'photoProcess') === 4, 'E-P2 on the new upload');
  const last = calls.filter((c) => c.fn === 'photoProcess').pop().body.uploadId;
  assert.notEqual(last, procs[0], 'never the terminal uploadId again');
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'and it lands');
});

test('codex r1 #6 — the fake\'s pid is a real content hash: same bytes + same crops ⇒ same pid; different crops ⇒ different pid', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const w = new JSDOM('').window;
  const put = async (name, crops) => {
    const s = await fake.fetchHandler('photoUploadStart', { rid: fake.rid, op_id: `op:${name}:${JSON.stringify(crops)}`, contentType: 'image/jpeg', bytes: 300000 });
    const x = new fake.XHR(); x.open('PUT', s.body.url);
    for (const [k, v] of Object.entries(s.body.headers)) x.setRequestHeader(k, v);
    await new Promise((r) => { x.onload = r; x.send(mkFile(w, { name })); });
    return (await fake.fetchHandler('photoProcess', { rid: fake.rid, uploadId: s.body.uploadId, crops })).body.pid;
  };
  const A = { card: { x: 0, y: 0, w: 1600, h: 1200 }, hero: { x: 0, y: 100, w: 1600, h: 1000 } };
  const B = { card: { x: 267, y: 200, w: 1066, h: 800 }, hero: { x: 0, y: 100, w: 1600, h: 1000 } };
  const p1 = await put('same.jpg', A); const p2 = await put('same.jpg', A); const p3 = await put('same.jpg', B);
  assert.equal(p1, p2, 'a content id: identical input ⇒ identical pid');
  assert.notEqual(p1, p3, 'a different card crop ⇒ a different pid');
  assert.match(p1, /^pid_[0-9a-f]{32}$/);
});

test('codex r1 #7 — the fake\'s READS are tenant-scoped like §2.2: another restaurant / brand, or a missing capability, is refused', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  assert.equal((await fake.fetchHandler('getEditableCatalog', { restaurantId: fake.rid })).status, 200);
  assert.equal((await fake.fetchHandler('getEditableCatalog', { restaurantId: 'r_other' })).status, 403, 'another tenant');
  assert.equal((await fake.fetchHandler('getBranchAvailability', { restaurantId: fake.rid })).status, 200);
  assert.equal((await fake.fetchHandler('getBranchAvailability', { brandId: fake.brandId })).status, 200);
  assert.equal((await fake.fetchHandler('getBranchAvailability', { restaurantId: 'r_other' })).status, 403, 'another branch');
  assert.equal((await fake.fetchHandler('getBranchAvailability', { brandId: 'marca_other' })).status, 403, 'another brand');
  fake.caps.delete('availability.set');
  assert.equal((await fake.fetchHandler('getBranchAvailability', { restaurantId: fake.rid })).status, 403, 'E-P4 needs availability.set');
  fake.caps.delete('catalog.read_editor');
  assert.equal((await fake.fetchHandler('getEditableCatalog', { restaurantId: fake.rid })).status, 403, 'E-P3 needs catalog.read_editor');
});

// ── Codex build r2 (2026-10-27): the three narrow fixes ──────────────────────────────────────────────────────────────────

test('codex r2 #1 — a review thumbnail renewed BEFORE its first error keeps ONE identity-bound handler: its error buys exactly one read', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.registry.set('pidA', { state: 'draft' }); fake.registry.set('pidB', { state: 'draft' });
  fake.draft.photos = { Pepperoni: { state: 'pid', pid: 'pidA' }, Margarita: { state: 'pid', pid: 'pidB' } };
  const { d, w, calls } = await boot(fake);
  d.getElementById('review').click();
  await until(() => d.querySelector('#mbody img[data-ph="pid:pidA"]') && d.querySelector('#mbody img[data-ph="pid:pidB"]'), 'P8 with both thumbs');
  const a = d.querySelector('#mbody img[data-ph="pid:pidA"]');
  const srcA = a.getAttribute('src');
  const r0 = n(calls, 'getEditableCatalog');
  // B's failure renews EVERY review thumb — A is renewed before its own first error
  d.querySelector('#mbody img[data-ph="pid:pidB"]').dispatchEvent(new w.Event('error'));
  await until(() => n(calls, 'getEditableCatalog') === r0 + 1, 'the renewal B bought');
  await settle(60);
  assert.notEqual(a.getAttribute('src'), srcA, 'A renewed in place');
  a.dispatchEvent(new w.Event('error'));
  await settle(300);
  assert.equal(n(calls, 'getEditableCatalog'), r0 + 2, 'A\'s first error: EXACTLY one read (no stale listener on its old URL)');
  a.dispatchEvent(new w.Event('error'));
  await settle(200);
  assert.equal(n(calls, 'getEditableCatalog'), r0 + 2, 'A\'s second error: none');
});

test('codex r2 #2 — only answers that consumed a processing attempt count: 3× in_progress (and a lost answer) never force a fresh upload', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  fake.failNext('photoProcess', 409, { error: 'in_progress', retryable: true });
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  for (const [status, body] of [[409, { error: 'in_progress', retryable: true }], [409, { error: 'in_progress', retryable: true }], [0, null]]) {
    await until(() => drawer(d).querySelector('.ferr'), 'P5');
    fake.failNext('photoProcess', status, body);
    btnText(drawer(d), 'Reintentar').click();
    await until(() => !drawer(d).querySelector('.ferr') || n(calls, 'photoProcess') > 3, 'the retry went out');
    await settle(40);
  }
  await until(() => drawer(d).querySelector('.ferr'), 'P5 after the lost answer');
  btnText(drawer(d), 'Reintentar').click();
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'lands on the SAME upload');
  assert.equal(n(calls, 'photoUploadStart'), 1, 'never a fresh (quota-charged) upload: the server spent no attempt');
  assert.equal(new Set(calls.filter((c) => c.fn === 'photoProcess').map((c) => c.body.uploadId)).size, 1);
});

test('codex r2 #3 — a SAVED pid the server stopped serving shows P5 with its re-upload; an UNSAVED upload absent from E-P3 shows the frame', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.registry.set('pidS', { state: 'draft' });
  fake.draft.photos = { Pepperoni: { state: 'pid', pid: 'pidS' } };
  const { d, w, calls } = await boot(fake);
  fake.registry.set('pidS', { state: 'deleted' });                       // the server no longer serves it
  const r0 = n(calls, 'getEditableCatalog');
  rowOf(d, 'Pepperoni').querySelector('button.thumb img').dispatchEvent(new w.Event('error'));
  await until(() => n(calls, 'getEditableCatalog') === r0 + 1, 'the renewal');
  await settle(60);
  const th = rowOf(d, 'Pepperoni').querySelector('button.thumb');
  assert.equal(th.title, 'Subir foto', 'SAVED + gone: the camera (missing), not the neutral frame');
  await openDrawerFor(d, 'Pepperoni');
  assert.equal(drawer(d).querySelector('.ferr span').textContent, 'No se pudo subir la foto.', 'P5');
  btnText(drawer(d), 'Reintentar').click();
  assert.ok([...d.querySelectorAll('input[type=file]')].length >= 1, '…and its Reintentar is a re-upload (the picker)');
  // the unsaved twin (the frame) is codex r1 #2's test: an upload E-P3 does not know → stale → neutral frame
});

// ── Ruling A (advisor 2026-10-31, interim; T1's «a rename publishes alone»): a photo is a change like any other ─────────────
// A pending photo already turns «Cambiar nombre» off; these pin the other direction. While a section name waits, every photo
// control is off — the same disabled treatment as the prices — and nothing is picked, uploaded or written; an upload that is
// already open (crop → upload) is a pending photo too, so it turns the rename off until it lands or is cancelled.
async function renameSection(d, to) {
  d.querySelector('#detail .secren').click(); await settle();
  const input = d.querySelector('#detail .secin');
  input.value = to; input.dispatchEvent(new window.Event('input'));
  btnText(d.getElementById('detail'), 'Guardar').click(); await settle();
}
test('ruling A — while a section rename is pending, the photo controls are off and no photo is picked, uploaded or written', async () => {
  const fake = createPhotoFake({ items: ITEMS(), legacy: { Margarita: true } });
  const { d, calls, mods } = await boot(fake);
  await renameSection(d, 'Pizzas clásicas');
  assert.ok(d.querySelector('#detail > .secnote'), 'premise: the name change is pending (its notice is up)');
  // the row camera: the drawer opens (as a row does), the picker does not
  rowOf(d, 'Pepperoni').querySelector('button.thumb').click(); await settle();
  assert.equal(d.querySelectorAll('input[type=file]').length, 0, 'no picker while a name change waits');
  const zoneBtn = drawer(d).querySelector('button.uploader.phdesk');
  assert.ok(zoneBtn, 'premise: the drawer shows its «Foto» zone');
  assert.equal(zoneBtn.disabled, true, 'the zone is off, like the price field');
  zoneBtn.click(); await settle();
  assert.equal(d.querySelectorAll('input[type=file]').length, 0, 'a dispatched click on the zone opens nothing');
  closeBtn(drawer(d)).click(); await settle();
  // a dish WITH a photo: «Cambiar» / «Quitar» are off too
  await openDrawerFor(d, 'Margarita');
  const acts = [...drawer(d).querySelectorAll('.phacts button')];
  assert.ok(acts.length === 2 && acts.every((b) => b.disabled), 'Cambiar / Quitar are off');
  assert.equal(n(calls, 'photoUploadStart') + n(calls, 'photoProcess'), 0, 'no photo call');
  void mods;
});
test('ruling A — the state boundary: setPhoto is refused while a name change is pending (local or saved), like every price write', async () => {
  const E = await import('./editor.js');
  const src = { restaurant_id: 'r', schema_version: 1, extras: [], items: [{ key: 'A', price: 100, display: { name: 'A', cat: 'c', price: 100 } }],
    structure: { schema_version: 2, item_order: ['A'], categories: [{ id: 'c', name: 'Uno' }] } };
  const local = E.createDraft(JSON.parse(JSON.stringify(src)), { canEdit: () => true, held: () => null });
  E.setCategoryNames(local, [['c', 'Dos']]);
  assert.equal(E.pendingRenames(local).length, 1, 'premise: a local rename');
  E.setPhoto(local, 'A', { state: 'removed' });
  assert.deepEqual(E.pendingPhotos(local), [], 'refused beside a LOCAL rename');
  const saved = E.createDraft(JSON.parse(JSON.stringify(src)), { canEdit: () => true, held: () => 'names' });
  E.setPhoto(saved, 'A', { state: 'removed' });
  assert.deepEqual(E.pendingPhotos(saved), [], 'refused beside a SAVED rename');
  const free = E.createDraft(JSON.parse(JSON.stringify(src)), { canEdit: () => true, held: () => null });
  E.setPhoto(free, 'A', { state: 'removed' });
  assert.deepEqual(E.pendingPhotos(free), ['A'], 'non-vacuity: with no rename the same write lands');
});
test('ruling A — an upload already open (crop → upload) is a pending photo: «Cambiar nombre» is off until it lands or is cancelled', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w } = await boot(fake);
  assert.equal(d.querySelector('#detail .secren').disabled, false, 'premise: the rename is on with nothing pending');
  rowOf(d, 'Pepperoni').querySelector('button.thumb').click(); await settle();
  await choose(d, w, mkFile(w));
  await until(() => drawer(d).querySelector('.phcrop'), 'the crop step');
  assert.equal(d.querySelector('#detail .secren').disabled, true, 'the crop step is open: the rename is off');
  btnText(drawer(d), 'Cancelar').click(); await settle();
  assert.equal(d.querySelector('#detail .secren').disabled, false, 'cancelled: the rename is back');
});
// ── Codex ruleA r1 (2026-10-31) ────────────────────────────────────────────────────────────────────────────────────────
// #1 an upload HELD beside a section name ('ready': the guard refused to write it) keeps its way out — «Cancelar», the busy
// state's own control and copy — and cancelling it loses nothing else. The UI blocks each side while the other is pending, so
// the one seeded fact is the SERVER's (state.savedRenames — what getEditableCatalog / «Enviar al dueño» write) landing while
// the PUT is held: the rest is the real flow.
test('codex ruleA r1 #1 — a photo held beside a pending name shows «Cancelar» (enabled); cancel → the name is still pending, nothing else lost', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, mods } = await boot(fake);
  await openDrawerFor(d, 'Margarita');
  const price = drawer(d).querySelector('input[aria-label="Precio"]');
  price.value = '290'; price.dispatchEvent(new window.Event('input')); await settle();
  closeBtn(drawer(d)).click(); await settle();
  const release = fake.holdPut();
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.phbusy'), 'P4: the PUT is in flight');
  mods.app.state.savedRenames = [{ id: 'cl', from: 'Clásicas', to: 'Pizzas' }];   // the server's saved name, landing now
  release();
  await until(() => { const j = drawer(d).querySelector('.uphoto:not(.phbusy)'); return j && btnText(drawer(d), 'Cancelar'); }, 'the held photo');
  const cancel = btnText(drawer(d), 'Cancelar');
  assert.equal(cancel.disabled, false, 'its way out is NOT locked with the rest of the field');
  assert.deepEqual(mods.app.state.draft.state.photos, undefined, 'premise: held, not written');
  cancel.click(); await settle();
  assert.ok(!btnText(drawer(d), 'Cancelar') && drawer(d).querySelector('button.uploader.phdesk'), 'cancelled: the empty zone again');
  assert.equal(mods.app.state.savedRenames.length, 1, 'the name is still pending');
  const marg = mods.app.state.draft.state.items.find((i) => i.key === 'Margarita');
  assert.equal(marg.price, 290, 'the other edit is kept');
  assert.equal(d.getElementById('review').disabled, false, 'nothing is held any more: the review is reachable');
});
// #2 every drawer render path carries the lock — the preview-renewal and image-error redraws included
test('codex ruleA r1 #2 — with a name pending, the renewal and image-error redraws keep Cambiar / Quitar disabled', async () => {
  const fake = createPhotoFake({ items: ITEMS(), legacy: { Margarita: true } });
  const { d } = await boot(fake);
  await renameSection(d, 'Pizzas clásicas');
  await openDrawerFor(d, 'Margarita');
  const off = () => { const a = [...drawer(d).querySelectorAll('.phacts button')]; return a.length === 2 && a.every((b) => b.disabled); };
  assert.ok(off(), 'premise: locked on open');
  drawer(d).querySelector('.uphoto img').dispatchEvent(new window.Event('error')); // 1st error: ONE renewal read → its redraw
  await settle(60);
  assert.ok(drawer(d).querySelector('.uphoto'), 'premise: the drawer was redrawn with its photo field');
  assert.ok(off(), 'after the renewal redraw: still locked');
  const im = drawer(d).querySelector('.uphoto img');
  if (im) { im.dispatchEvent(new window.Event('error')); await settle(60); }               // 2nd error: the retried-path redraw
  assert.ok(off() || !drawer(d).querySelector('.phacts'), 'after the image-error redraw: still locked');
});
// 5f review (2026-10-31): the fake's rate limit answers EXACTLY as the server (photos/errors.js rate_limited: 429, retryable) —
// a stub laxer than production voids the test. 30 new starts pass; the 31st is refused; a retry of a known op is never charged.
test('5f review — the fake\'s rate limit is the server\'s: the 31st new start is 429 rate_limited (retryable); a known op is not charged', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const start = (op) => fake.fetchHandler('photoUploadStart', { rid: fake.rid, op_id: op, contentType: 'image/jpeg', bytes: 1000 });
  for (let i = 0; i < 30; i++) assert.equal((await start(`op:${i}`)).status, 200, `start ${i + 1} of 30`);
  const r = await start('op:30');
  assert.equal(r.status, 429, 'the server sends 429 (photos/errors.js), not 503');
  assert.equal(r.body.error, 'rate_limited');
  assert.equal(r.body.retryable, true);
  assert.equal((await start('op:0')).status, 200, 'an existing op is a retry, never rate-charged');
});

// OWNER BUG (2026-11-01, «make it look perfect»): every drawer's top-right close is the APPROVED icon box — `.dwx` is a 32×32
// icon box, drawn in every approved mockup (MOCKUP-portal-dish-photo, category-rename, ratelimit, the 09-07 editor mock) as the
// X svg with aria-label «Cerrar» and NO text. The word «Cerrar» in that box overflowed it. Behaviour is unchanged: it closes.
const strokes = (d) => d.split(/(?=M)/).map((s) => s.trim()).filter(Boolean).sort().join(' ');   // the X's two lines, in any order
function assertCloseIcon(root, where) {
  const x = root.querySelector('.dwh .dwx');
  assert.ok(x, `${where}: the head has its .dwx`);
  assert.equal(x.tagName, 'BUTTON'); assert.equal(x.type, 'button');
  assert.equal(x.getAttribute('aria-label'), 'Cerrar', `${where}: named «Cerrar» for assistive tech`);
  assert.equal(x.textContent, '', `${where}: no text in the icon box (it overflowed the 32×32 box)`);
  const svg = x.querySelector('svg');
  assert.ok(svg && svg.namespaceURI === 'http://www.w3.org/2000/svg', `${where}: a real SVG element`);
  assert.equal(svg.getAttribute('viewBox'), '0 0 24 24'); assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(strokes([...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('')), strokes('M18 6L6 18M6 6l12 12'), `${where}: the mockup's two strokes of the X`);
  return x;
}
const closeBtn = (root) => root.querySelector('.dwh .dwx[aria-label="Cerrar"]');
test('OWNER BUG — the item drawer, the «Nuevo producto» drawer and the crop step close with the approved X icon (no text), and still close', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, mods } = await boot(fake);
  await openDrawerFor(d, 'Pepperoni');
  assertCloseIcon(drawer(d), 'item drawer').click(); await settle();
  assert.ok(!drawer(d).classList.contains('show'), 'item drawer: closed'); assert.equal(mods.app.state.drawerKey ?? null, null);
  btnText(d.getElementById('detail'), 'Agregar producto').click(); await settle();
  assert.ok(drawer(d).classList.contains('show'), 'premise: the add drawer is open');
  assertCloseIcon(drawer(d), '«Nuevo producto» drawer').click(); await settle();
  assert.ok(!drawer(d).classList.contains('show'), '«Nuevo producto» drawer: closed');
  rowOf(d, 'Pepperoni').querySelector('button.thumb').click(); await settle();
  await choose(d, w, mkFile(w));
  await until(() => drawer(d).querySelector('.phcrop'), 'the crop step');
  assertCloseIcon(drawer(d), 'crop step').click(); await settle();
  assert.ok(!drawer(d).querySelector('.phcrop'), 'crop step: left — the file is discarded');
  assert.equal(n(fake.calls || [], 'photoUploadStart'), 0, 'crop step close uploads nothing');
});
test('OWNER BUG — photos DARK (flag off): the item drawer and the «Nuevo producto» drawer still close with the approved X icon', async () => {
  const fake = createPhotoFake({ items: ITEMS(), photosEnabled: false });
  const { d } = await boot(fake);
  await openDrawerFor(d, 'Pepperoni');
  assert.ok(!drawer(d).querySelector('button.uploader'), 'premise: photos are dark — no «Foto» field');
  assertCloseIcon(drawer(d), 'item drawer (dark)').click(); await settle();
  assert.ok(!drawer(d).classList.contains('show'), 'item drawer (dark): closed');
  btnText(d.getElementById('detail'), 'Agregar producto').click(); await settle();
  assertCloseIcon(drawer(d), '«Nuevo producto» drawer (dark)').click(); await settle();
  assert.ok(!drawer(d).classList.contains('show'), '«Nuevo producto» drawer (dark): closed');
});

// OWNER-APPROVED MOCKUP-portal-photos-held-state.html (2026-11-01): ruling A's held states, the two notice lines as proposed, and
// the drawer's locked controls DIMMED like the list's prices (they did not look locked: the zone kept its green «Subí una foto»).
const NOTE_RENAMES = 'Hay un cambio de nombre esperando publicarse. Publicalo o descartalo para seguir editando precios, fotos o agregando productos.';
const NOTE_OTHERS = 'Hay cambios sin publicar. Un cambio de nombre se publica solo: publicá o descartá esos cambios primero.';
const secnote = (d) => { const n = d.querySelector('#detail > .secnote span'); return n ? n.textContent : null; };
test('HELD H1 — a pending section name: the notice names photos too (owner-approved line); the drawer\'s photo controls are locked AND dimmed', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d } = await boot(fake);
  await renameSection(d, 'Pizzas de la casa');
  assert.equal(secnote(d), NOTE_RENAMES);
  await openDrawerFor(d, 'Pepperoni');
  const dw = drawer(d);
  assert.ok(dw.classList.contains('namehold'), 'the drawer carries the hold, for the dimming');
  assert.ok(dw.querySelector('button.uploader').disabled, 'premise: the zone is locked');
});
test('HELD H3 — a pending photo: «Cambiar nombre» is off and the notice is the owner-approved generic line (not «precio»)', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w } = await boot(fake);
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'a pending photo');
  closeBtn(drawer(d)).click(); await settle();
  assert.ok(d.querySelector('#detail .secren').disabled, 'premise: the rename is off');
  assert.equal(secnote(d), NOTE_OTHERS);
});
test('HELD — no pending name: the drawer has no hold class (nothing dimmed by it)', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d } = await boot(fake);
  await openDrawerFor(d, 'Pepperoni');
  assert.ok(!drawer(d).classList.contains('namehold'));
});
test('HELD dimming — styles.css dims every control the name hold locks, exactly like the list\'s prices (opacity .5, not-allowed)', () => {
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const listPrice = /\.price input:disabled\{([^}]*)\}/.exec(css);
  assert.ok(listPrice, 'premise: the list price rule');
  const rule = /\n\s*((?:#drawer\.namehold [^{]+?,\s*)*#drawer\.namehold [^{]+)\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'a #drawer.namehold rule');
  assert.equal(rule[2].replace(/\s/g, ''), listPrice[1].replace(/\s/g, ''), 'the SAME declarations as the list prices');
  const sels = rule[1].split(',').map((s) => s.trim());
  for (const s of ['input:disabled', 'textarea:disabled', 'select:disabled', 'button.uploader:disabled', '.phph2b button:disabled', '.phacts button:disabled', '.pherr button:disabled', '.phrm button:disabled']) {
    assert.ok(sels.includes(`#drawer.namehold ${s}`), `dims ${s}`);
  }
});

// Codex held r1: the hold must CLEAR on the same drawer element when the pending name goes (discard / publish), and the
// dimming must be the stylesheet's computed verdict — the locked controls dimmed, the held photo's «Cancelar» enabled and not.
const withCss = (d) => { const st = d.createElement('style'); st.textContent = readFileSync(join(DIR, 'styles.css'), 'utf8'); d.head.append(st); };
const look = (d, n) => { const cs = d.defaultView.getComputedStyle(n); return `${cs.opacity}|${cs.cursor}`; };
test('HELD r1 — Descartar clears the hold on the SAME drawer element (no sticky namehold)', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d } = await boot(fake);
  await renameSection(d, 'Pizzas de la casa');
  await openDrawerFor(d, 'Pepperoni');
  const dw = drawer(d);
  assert.ok(dw.classList.contains('namehold'), 'premise: held');
  d.getElementById('discard').click(); await settle();
  assert.equal(secnote(d), null, 'premise: the name change is gone');
  assert.ok(!dw.classList.contains('namehold'), 'the hold cleared with it');
});
test('HELD r1 — publishing the name clears the hold on the SAME drawer element', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, calls } = await boot(fake);
  await renameSection(d, 'Pizzas de la casa');
  await openDrawerFor(d, 'Pepperoni');
  const dw = drawer(d);
  assert.ok(dw.classList.contains('namehold'), 'premise: held');
  d.getElementById('review').click();
  await until(() => !d.getElementById('pubbtn').disabled, 'the review is ready');
  d.getElementById('pubbtn').click();
  await until(() => d.querySelector('#mbody .receipt'), 'published');
  await until(() => n(calls, 'getEditableCatalog') >= 2, 'the post-publish reload'); await settle(40);
  assert.ok(!dw.classList.contains('namehold'), 'the hold cleared once the name is published');
});
test('HELD r1 — computed: every locked control is dimmed exactly like the list prices (0.5 / not-allowed); the price list itself too', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d } = await boot(fake);
  withCss(d);
  await renameSection(d, 'Pizzas de la casa');
  const listPrice = d.querySelector('#detail .price input');
  assert.ok(listPrice.disabled, 'premise: the list prices are locked');
  assert.equal(look(d, listPrice), '0.5|not-allowed');
  await openDrawerFor(d, 'Pepperoni');
  const dw = drawer(d);
  for (const n of [dw.querySelector('button.uploader'), ...dw.querySelectorAll('input')]) {
    assert.ok(n.disabled, `premise: ${n.tagName}.${n.className} locked`);
    assert.equal(look(d, n), '0.5|not-allowed', `${n.tagName}.${n.className} dimmed`);
  }
});
test('HELD r1 — DEFENSIVE SYNTHETIC-STATE TEST (no production path demonstrated): the held photo\'s «Cancelar» stays ENABLED and UNDIMMED inside the dimmed drawer', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, mods } = await boot(fake);
  withCss(d);
  const release = fake.holdPut();
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.phbusy'), 'P4');
  // DEFENSIVE SYNTHETIC-STATE TEST (Codex held r4): no production path to this state is demonstrated here — a local rename blocks
  // the upload first, and the fake serves no pendingRenames (ruling B). The page state is seeded exactly as ruleA r1 #1 does, to
  // pin what the drawer shows IF a saved name ever meets a held upload.
  mods.app.state.savedRenames = [{ id: 'cl', from: 'Clásicas', to: 'Pizzas' }];
  release();
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy)') && btnText(drawer(d), 'Cancelar'), 'the held photo (not P4\'s own «Cancelar»)');
  const dw = drawer(d);
  assert.ok(dw.classList.contains('namehold'), 'premise: the drawer is held');
  const cancel = btnText(dw, 'Cancelar');
  assert.equal(cancel.disabled, false);
  assert.notEqual(d.defaultView.getComputedStyle(cancel).opacity, '0.5', 'undimmed: its way out looks available');
  assert.notEqual(d.defaultView.getComputedStyle(cancel).cursor, 'not-allowed');
});

// Codex held r3 / advisor ruling B — the fake does NOT model the rename rule: it is STRICTER than production (a category change
// only as a pure rename of an otherwise unchanged published catalog; anything else → 400 unmodeled_change) and serves no
// pendingRenames. Production's rule (rename_not_alone, structure_changed, the derived pendingRenames incl. from: null) is proven
// against the REAL editCatalog / getEditableCatalog in the emulator cells (the dry tree, where Part A is present).
const editBody = async (fake, mutate) => {
  const r = await fake.fetchHandler('getEditableCatalog', { restaurantId: fake.rid });
  const src = JSON.parse(JSON.stringify(r.body.source));
  mutate(src);
  return { restaurantId: fake.rid, baseSourceUpdateTime: r.body.sourceUpdateTime, source: src };
};
test('HELD r3 fake (ruling B) — stricter, never laxer: a rename beside ANY other change is refused; a pure rename passes; no pendingRenames', async () => {
  const rn = (src) => { src.structure.categories[0].name = 'Pizzas'; };
  const probes = [
    ['+ a price', (src) => { rn(src); src.items[0].price += 10; }],
    ['+ an extra', (src) => { rn(src); src.extras.push({ key: 'Queso extra', price: 25, display: { name: 'Queso extra', price: 25 } }); }],
    ['+ item_order changed', (src) => { rn(src); src.structure.item_order.reverse(); }],
    ['+ category metadata', (src) => { rn(src); src.structure.categories[0].color = 'red'; }],
    ['+ a photo', (src) => { rn(src); src.photos = { Pepperoni: { state: 'removed' } }; }],
    ['an id changed (no rename)', (src) => { src.structure.categories[0].id = 'xx'; }],
    ['a category added', (src) => { src.structure.categories.push({ id: 'nv', name: 'Nueva' }); }],
    // r4: the STRICTEST fake — only the allowlisted names, only the fake's own input shape
    ['a name outside the allowlist', (src) => { src.structure.categories[0].name = 'Otra sección'; }],
    ['whitespace around an allowed name', (src) => { src.structure.categories[0].name = ' Pizzas '; }],
    ['a numeric name', (src) => { src.structure.categories[0].name = 12; }],
    ['markup', (src) => { src.structure.categories[0].name = '<b>Pizzas</b>'; }],
    ['structure.categories missing', (src) => { delete src.structure.categories; }],
    ['a root field changed (schema_version)', (src) => { src.schema_version = 2; }],
    ['an unknown root field', (src) => { src.extra_root = true; }],
    ['an unknown structure field', (src) => { src.structure.badges = []; }],
  ];
  for (const [what, mutate] of probes) {
    const fake = createPhotoFake({ items: ITEMS() });
    // a fake that THROWS on an unsupported shape is a failure too — recorded as an answer, so it fails as an assertion
    const r = await fake.fetchHandler('editCatalog', await editBody(fake, mutate)).catch((e) => ({ status: 'threw', body: { error: String(e && e.message) } }));
    assert.equal(r.status, 400, what); assert.equal(r.body.error, 'unmodeled_change', what);
  }
  for (const name of ['Pizzas clásicas', 'Pizzas de la casa']) {   // the other allowlisted names the suites use
    const f2 = createPhotoFake({ items: ITEMS() });
    assert.equal((await f2.fetchHandler('editCatalog', await editBody(f2, (src) => { src.structure.categories[0].name = name; }))).status, 200, name);
  }
  const fake = createPhotoFake({ items: ITEMS() });
  const ok = await fake.fetchHandler('editCatalog', await editBody(fake, rn));
  assert.equal(ok.status, 200, 'a pure rename is accepted');
  assert.deepEqual(ok.body.diff.changed, [{ surface: 'category', key: 'cl', field: 'name', old: 'Clásicas', new: 'Pizzas' }]);
  const read = await fake.fetchHandler('getEditableCatalog', { restaurantId: fake.rid });
  assert.ok(!('pendingRenames' in read.body), 'never served by the fake (production derives it with assessDraft — emulator cells)');
});

// C (Codex held r3): EACH locked control, by name, in each state the hold meets — present, disabled, and the stylesheet's computed
// 0.5 / not-allowed (the list prices' declarations) — and «Cerrar» enabled and undimmed. The rename is made through the page's
// own path wherever the state allows one after it. A removal pending blocks a local rename, so that state is a DEFENSIVE
// SYNTHETIC-STATE TEST (Codex held r4): seeded like ruleA r1 #1, no production path demonstrated.
function assertLocked(d, n, what) {
  assert.ok(n, `${what}: present`);
  assert.equal(n.disabled, true, `${what}: disabled`);
  assert.equal(look(d, n), '0.5|not-allowed', `${what}: dimmed like the list prices`);
}
function assertOpen(d, n, what) {
  assert.ok(n && !n.disabled, `${what}: present and enabled`);
  assert.notEqual(d.defaultView.getComputedStyle(n).opacity, '0.5', `${what}: not dimmed`);
}
const byText = (root, t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
const price = (dw) => dw.querySelector('input[aria-label="Precio"]');
test('HELD r3 C — no photo: the zone and «Precio» locked + dimmed; «Cerrar» open', async () => {
  const fake = createPhotoFake({ items: ITEMS() }); const { d } = await boot(fake); withCss(d);
  await renameSection(d, 'Pizzas de la casa');
  await openDrawerFor(d, 'Pepperoni'); const dw = drawer(d);
  assert.ok(dw.classList.contains('namehold'), 'premise: held');
  assertLocked(d, dw.querySelector('button.uploader.phdesk'), 'the zone «Subí una foto»');
  assertLocked(d, price(dw), '«Precio»');
  assertOpen(d, closeBtn(dw), '«Cerrar»');
});
test('HELD r3 C — a published photo: «Cambiar» and «Quitar» locked + dimmed', async () => {
  const fake = createPhotoFake({ items: ITEMS(), legacy: { Margarita: true } }); const { d } = await boot(fake); withCss(d);
  await renameSection(d, 'Pizzas de la casa');
  await openDrawerFor(d, 'Margarita'); const dw = drawer(d);
  assertLocked(d, byText(dw, 'Cambiar'), '«Cambiar»');
  assertLocked(d, byText(dw, 'Quitar'), '«Quitar»');
  assertLocked(d, price(dw), '«Precio»');
  assertOpen(d, closeBtn(dw), '«Cerrar»');
});
test('HELD r3 C — a failed upload (P5), then a rename: «Reintentar» and the zone locked + dimmed', async () => {
  const fake = createPhotoFake({ items: ITEMS() }); const { d, w } = await boot(fake); withCss(d);
  fake.failNext('photoProcess', 503, { error: 'unavailable', retryable: true });
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.ferr'), 'P5');
  closeBtn(drawer(d)).click(); await settle();
  await renameSection(d, 'Pizzas de la casa');                   // a failed upload is not a pending photo: the page's own rename
  await openDrawerFor(d, 'Pepperoni'); const dw = drawer(d);
  assert.ok(dw.classList.contains('namehold'), 'premise: held');
  assertLocked(d, byText(dw, 'Reintentar'), '«Reintentar»');
  assertLocked(d, dw.querySelector('button.uploader'), 'the zone');
});
test('HELD r3 C — a phone: the expanded pair «Tomar foto» / «Elegir de la galería» locked + dimmed', async () => {
  window.matchMedia = (q) => ({ matches: /max-width:\s*560px/.test(q) });
  try {
    const fake = createPhotoFake({ items: ITEMS() }); const { d } = await boot(fake); withCss(d);
    window.matchMedia = (q) => ({ matches: /max-width:\s*560px/.test(q) });
    await openDrawerFor(d, 'Pepperoni'); drawer(d).querySelector('button.uploader').click(); await settle();
    assert.ok(byText(drawer(d), 'Tomar foto'), 'premise: expanded');
    closeBtn(drawer(d)).click(); await settle();
    await renameSection(d, 'Pizzas de la casa');
    await openDrawerFor(d, 'Pepperoni'); const dw = drawer(d);
    assertLocked(d, byText(dw, 'Tomar foto'), '«Tomar foto»');
    assertLocked(d, byText(dw, 'Elegir de la galería'), '«Elegir de la galería»');
  } finally { delete window.matchMedia; }
});
test('HELD r3 C — DEFENSIVE SYNTHETIC-STATE TEST (no production path demonstrated): a removal pending + a seeded saved name → «Deshacer» locked + dimmed', async () => {
  const fake = createPhotoFake({ items: ITEMS(), legacy: { Margarita: true } }); const { d, mods } = await boot(fake); withCss(d);
  await openDrawerFor(d, 'Margarita'); byText(drawer(d), 'Quitar').click(); await settle();
  mods.app.state.savedRenames = [{ id: 'cl', from: 'Clásicas', to: 'Pizzas' }];
  d.querySelector('#rail .railitem').click(); await settle();      // the paint every savedRenames path is followed by
  mods.app.openDrawer('Margarita'); await settle();
  const dw = drawer(d);
  assert.ok(dw.classList.contains('namehold'), 'premise: held');
  assertLocked(d, byText(dw, 'Deshacer'), '«Deshacer»');
  assertLocked(d, dw.querySelector('button.uploader'), 'the zone');
});

// OWNER-APPROVED MOCKUP-portal-dish-photo-ratelimit.html (P5-L, option B, 2026-11-01): the server's upload limit (30 new starts
// per person per hour, 200 per branch per day → 429 `rate_limited`, photos/errors.js) is NOT a failure of the merchant's: a
// NEUTRAL note (grey, a clock, role=status) «Subiste muchas fotos seguidas. Probá de nuevo más tarde.» and NO «Reintentar»
// (it would fail again until the window passes). Only this code; every other failure keeps P5. The fake answers exactly as the
// server does once its 30 starts are used (fake.starts, the same counter the 5f-review test pins).
const LIMITED = 'Subiste muchas fotos seguidas. Probá de nuevo más tarde.';
function assertLimitedNote(root) {
  const note = root.querySelector('.phwait');
  assert.ok(note, 'the neutral note');
  assert.equal(note.getAttribute('role'), 'status', 'a status, not an alert');
  assert.equal(note.querySelector('span').textContent, LIMITED);
  const svg = note.querySelector('svg');
  assert.ok(svg && svg.querySelector('circle') && svg.querySelector('path').getAttribute('d') === 'M12 7v5l3 2', 'the clock');
  assert.ok(!root.querySelector('.phferr'), 'not the red error line');
  assert.ok(!btnText(root, 'Reintentar'), 'no «Reintentar»: it would fail again until the limit passes');
}
test('P5-L — no photo before: the upload limit shows the neutral note under the zone (no red border), no «Reintentar»', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, calls } = await boot(fake);
  fake.starts = 30;                                   // the 30 new starts of this hour are used
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.phwait'), 'P5-L');
  assertLimitedNote(drawer(d));
  assert.ok(drawer(d).querySelector('button.uploader.phdesk'), 'the zone stays, ready for later');
  assert.ok(!drawer(d).querySelector('button.uploader.phinv'), 'without the red «invalid» border: nothing is wrong with the file');
  assert.ok(!drawer(d).querySelector('.fld.invalid'));
  assert.equal(n(calls, 'photoProcess'), 0, 'premise: refused at the start (E-P1)');
});
test('P5-L — a photo before: it stays, with the neutral note under it and no «Reintentar»; the draft is unchanged', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w, mods } = await boot(fake);
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.uphoto:not(.phbusy) .phacts'), 'a first photo');
  const before = JSON.stringify(mods.app.state.draft.state.photos);
  fake.starts = 30;
  btnText(drawer(d), 'Cambiar').click(); await settle();
  await choose(d, w, mkFile(w, { name: 'otra.jpg' }));
  await until(() => drawer(d).querySelector('.phcrop'), 'the crop step');
  btnText(drawer(d), 'Listo').click();
  await until(() => drawer(d).querySelector('.phwait'), 'P5-L over the photo');
  assertLimitedNote(drawer(d));
  assert.ok(drawer(d).querySelector('.uphoto .gimg'), 'the photo stays');
  assert.equal(JSON.stringify(mods.app.state.draft.state.photos), before, 'nothing changed in the draft');
});
test('P5-L is ONLY the limit: a transient failure is still P5 «No se pudo subir la foto.» + «Reintentar»', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w } = await boot(fake);
  fake.failNext('photoProcess', 503, { error: 'unavailable', retryable: true });
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.ferr'), 'P5');
  assert.ok(!drawer(d).querySelector('.phwait'));
  assert.ok(btnText(drawer(d), 'Reintentar'));
});

// ── S4 «Editar producto» (PLAN-portal-item-edit r6 addendum S4): with the text-edit switch on, the drawer is a working copy — an
// upload started in it lands in the COPY (never the draft) until «Guardar»; «Cancelar» while it is in flight means it never lands.
test('S4 — an upload started in the edit drawer lands in the COPY: the draft takes it only with «Guardar», once', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.flags.textEdit = true;
  const { d, w, mods } = await boot(fake);
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.dwf') && !drawer(d).querySelector('.phcrop'), 'back in the edit drawer');
  await until(() => btnText(drawer(d), 'Guardar') && !btnText(drawer(d), 'Guardar').disabled, 'the upload landed in the copy');
  const photosOf = () => JSON.parse(JSON.stringify((mods.app.state.draft.state.photos) || {}));
  assert.deepEqual(photosOf(), {}, 'nothing in the draft yet');
  btnText(drawer(d), 'Guardar').click();
  await settle(20);
  assert.equal(photosOf().Pepperoni && photosOf().Pepperoni.state, 'pid', '«Guardar»: the photo, in the draft');
  assert.match(d.getElementById('rbtxt').textContent, /· 1 foto/);
});
test('S4 — «Guardar» waits for an upload in flight; «Cancelar» then means the late answer NEVER lands (draft untouched)', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.flags.textEdit = true;
  const { d, w, mods } = await boot(fake);
  const release = fake.holdPut();
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => btnText(drawer(d), 'Guardar'), 'the edit drawer while the upload runs');
  const g = btnText(drawer(d), 'Guardar');
  assert.equal(g.disabled, true);
  assert.equal(g.title, 'Esperá a que termine de subir la foto');
  // OWNER 11-10: in the EDIT drawer the upload's own button reads «Detener subida»; the footer keeps «Cancelar» (one each)
  assert.equal(drawer(d).querySelector('.uprm').textContent, 'Detener subida');
  assert.deepEqual([...drawer(d).querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Cancelar').map((b) => b.closest('.dwf') !== null), [true], 'one «Cancelar», the footer\'s');
  drawer(d).querySelector('.dwf .btn.ghost').click();   // the DRAWER's «Cancelar» (the photo field carries the upload's own, P4)
  await settle(10);
  release();
  await settle(120);
  assert.deepEqual(JSON.parse(JSON.stringify((mods.app.state.draft.state.photos) || {})), {}, 'the late answer never reached the draft');
  assert.ok(!drawer(d).classList.contains('show'));
});

test('S4 — OFF: today\'s drawer keeps the approved P4 «Cancelar» on an upload in flight (the owner\'s «Detener subida» is the edit drawer\'s only)', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  const { d, w } = await boot(fake);
  const release = fake.holdPut();
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => drawer(d).querySelector('.uprm'), 'the upload in flight');
  assert.equal(drawer(d).querySelector('.uprm').textContent, 'Cancelar');
  release(); await settle(60);
});
test('S4 (Codex S4P2 r1 P2-3) — «Detener subida» stops the upload AND frees «Guardar»: the other edits save, no photo lands', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.flags.textEdit = true;
  const { d, w, mods } = await boot(fake);
  const release = fake.holdPut();
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => btnText(drawer(d), 'Guardar'), 'the edit drawer while the upload runs');
  const nm = [...drawer(d).querySelectorAll('.dwb > .fld')].find((f) => f.querySelector('label') && f.querySelector('label').firstChild.textContent.trim() === 'Nombre').querySelector('input');
  nm.value = 'Pepperoni picante'; nm.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(btnText(drawer(d), 'Guardar').disabled, true, 'premise: held by the upload');
  drawer(d).querySelector('.uprm').click();   // «Detener subida»
  await settle(30);
  const g = btnText(drawer(d), 'Guardar');
  assert.equal(g.disabled, false, '«Guardar» is free again');
  g.click(); await settle(20);
  release(); await settle(80);
  const st = mods.app.state.draft.state;
  assert.equal(st.items.find((i) => i.key === 'Pepperoni').display.name, 'Pepperoni picante', 'the name saved');
  assert.deepEqual(JSON.parse(JSON.stringify(st.photos || {})), {}, 'no photo landed');
});

// UNSAVED EDITS (MOCKUP-portal-item-edit-unsaved.html, owner-approved 2026-11-11): the photo step's «Cerrar» is an exit that would
// drop the working copy — with unsaved edits it asks first (frame 2), exactly as the drawer's own «Cerrar».
test('U-PHOTO-CLOSE-DIRTY — the photo step\'s «Cerrar» with unsaved edits asks; «Seguir editando» keeps the step, the copy and the upload binding; «Descartar» drops both', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.flags.textEdit = true;
  const { d, w, mods } = await boot(fake);
  const pep = () => JSON.parse(JSON.stringify(mods.app.state.draft.state)).items.find((i) => i.key === 'Pepperoni');
  const photosOf = () => JSON.parse(JSON.stringify(mods.app.state.draft.state.photos || {}));
  await openDrawerFor(d, 'Pepperoni');
  // the existing ON premise: the edit drawer's own footer («Cancelar» · «Guardar»), not this change's new mark
  assert.ok(drawer(d).querySelector('.dwf') && btnText(drawer(d).querySelector('.dwf'), 'Cancelar') && btnText(drawer(d).querySelector('.dwf'), 'Guardar'), 'premise: the ON edit drawer (the working copy)');
  const price = drawer(d).querySelector('input[aria-label="Precio"]');
  price.value = '330'; price.dispatchEvent(new w.Event('input', { bubbles: true }));
  const release = fake.holdPut();
  drawer(d).querySelector('button.uploader.phdesk').click();
  await settle();
  await choose(d, w, mkFile(w));
  await until(() => drawer(d).querySelector('.phcrop'), 'the crop step');
  const crop = drawer(d).querySelector('.phcrop');
  drawer(d).querySelector('.dwh .dwx').click(); await settle();
  const cf = drawer(d).querySelector('.mk-cf');
  assert.ok(cf, 'U-PHOTO-CLOSE-DIRTY: the confirm is shown over the photo step');
  assert.equal(cf.querySelector('h3').textContent, '¿Descartar los cambios?', 'U-PHOTO-CLOSE-DIRTY: the title');
  btnText(cf, 'Seguir editando').click(); await settle();
  assert.equal(drawer(d).querySelector('.phcrop'), crop, 'U-KEEP-EDITING-BYTE-IDENTICAL (photo close): the SAME crop step');
  btnText(drawer(d), 'Listo').click();
  await until(() => drawer(d).querySelector('.dwf') && !drawer(d).querySelector('.phcrop'), 'back in the edit drawer, the upload in flight');
  assert.equal(drawer(d).querySelector('input[aria-label="Precio"]').value, '330', 'U-KEEP-EDITING-BYTE-IDENTICAL (photo close): the typed price survived the step');
  // the upload binding survives a kept confirm: «Cerrar» → «Seguir editando» while it runs, then it lands in the COPY
  const s0 = mods.app._openCopy(), up0 = s0 && s0.upload, json0 = JSON.stringify({ work: s0.work, base: s0.base, photoTouched: s0.photoTouched, upload: s0.upload });
  drawer(d).querySelector('.dwh .dwx').click(); await settle();
  btnText(drawer(d).querySelector('.mk-cf'), 'Seguir editando').click(); await settle();
  const s1 = mods.app._openCopy();
  assert.ok(s1 === s0 && s1.upload === up0 && up0 && up0.state === 'busy', 'U-KEEP-EDITING-BYTE-IDENTICAL (photo close): the SAME session and the SAME busy upload binding');
  assert.strictEqual(JSON.stringify({ work: s1.work, base: s1.base, photoTouched: s1.photoTouched, upload: s1.upload }), json0, 'U-KEEP-EDITING-BYTE-IDENTICAL (photo close): work, base, photo flag, upload byte-identical');
  release();
  await until(() => btnText(drawer(d), 'Guardar') && !btnText(drawer(d), 'Guardar').disabled, 'U-KEEP-EDITING-BYTE-IDENTICAL (photo close): the held upload landed in the kept copy');
  assert.deepEqual([pep().price, photosOf()], [310, {}], 'U-KEEP-EDITING-BYTE-IDENTICAL (photo close): the draft still untouched before «Guardar»');
  btnText(drawer(d), 'Guardar').click(); await settle(20);
  assert.deepEqual([pep().price, photosOf().Pepperoni && photosOf().Pepperoni.state], [330, 'pid'], 'U-KEEP-EDITING-BYTE-IDENTICAL (photo close): «Guardar» saves the kept price AND the kept upload');
});

test('U-PHOTO-CLOSE-DISCARD — «Descartar» on the photo step\'s confirm closes the drawer; the draft never takes the unsaved price', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.flags.textEdit = true;
  const { d, w, mods } = await boot(fake);
  const pep = () => JSON.parse(JSON.stringify(mods.app.state.draft.state)).items.find((i) => i.key === 'Pepperoni');
  const draft0 = JSON.stringify(mods.app.state.draft.state);
  await openDrawerFor(d, 'Pepperoni');
  assert.ok(drawer(d).querySelector('.dwf') && btnText(drawer(d).querySelector('.dwf'), 'Guardar'), 'premise: the ON edit drawer');
  const price = drawer(d).querySelector('input[aria-label="Precio"]');
  price.value = '330'; price.dispatchEvent(new w.Event('input', { bubbles: true }));
  drawer(d).querySelector('button.uploader.phdesk').click();
  await settle();
  await choose(d, w, mkFile(w));
  await until(() => drawer(d).querySelector('.phcrop'), 'the crop step');
  drawer(d).querySelector('.dwh .dwx').click(); await settle();
  assert.ok(drawer(d).querySelector('.mk-cf'), 'U-PHOTO-CLOSE-DISCARD: the confirm is shown over the photo step');
  btnText(drawer(d).querySelector('.mk-cf'), 'Descartar').click(); await settle();
  assert.equal(drawer(d).classList.contains('show'), false, 'U-PHOTO-CLOSE-DISCARD: «Descartar» closes the drawer');
  assert.deepStrictEqual([pep().price, pep().display.price], [310, 310], 'U-PHOTO-CLOSE-DISCARD: the draft never took the unsaved price');
  assert.strictEqual(JSON.stringify(mods.app.state.draft.state), draft0, 'U-PHOTO-CLOSE-DISCARD: the COMPLETE draft byte-for-byte as before the drawer opened');
});


test('U-CONFIRM-UPLOAD-REDRAW — an upload landing while the confirm is open = «Seguir editando»: the confirm is torn down cleanly, the copy and its photo stay, the page is live', async () => {
  const fake = createPhotoFake({ items: ITEMS() });
  fake.flags.textEdit = true;
  const { d, w, mods } = await boot(fake);
  const inert0 = [...d.querySelectorAll('[inert]')];
  const release = fake.holdPut();
  await uploadVia(d, w, fake, 'Pepperoni', mkFile(w));
  await until(() => btnText(drawer(d), 'Guardar') && drawer(d).querySelector('.dwf'), 'the edit drawer while the upload runs');
  const s0 = mods.app._openCopy();
  drawer(d).querySelector('.dwh .dwx').click(); await settle();
  assert.ok(drawer(d).querySelector('.mk-cf'), 'premise: the confirm is open over a dirty copy (an upload on its way)');
  release();
  await until(() => !drawer(d).querySelector('.mk-cf'), 'U-CONFIRM-UPLOAD-REDRAW: the redraw tears the confirm down');
  const tab = new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); d.body.dispatchEvent(tab);
  assert.deepStrictEqual([[...d.querySelectorAll('[inert]')], tab.defaultPrevented], [inert0, false], 'U-CONFIRM-UPLOAD-REDRAW: nothing left inert, Tab not trapped');
  assert.ok(mods.app._openCopy() === s0 && drawer(d).classList.contains('show'), 'U-CONFIRM-UPLOAD-REDRAW: the same copy stays open («Seguir editando»)');
  await until(() => btnText(drawer(d), 'Guardar') && !btnText(drawer(d), 'Guardar').disabled, 'U-CONFIRM-UPLOAD-REDRAW: the photo landed in the copy');
  btnText(drawer(d), 'Guardar').click(); await settle(20);
  assert.equal((JSON.parse(JSON.stringify(mods.app.state.draft.state.photos || {})).Pepperoni || {}).state, 'pid', 'U-CONFIRM-UPLOAD-REDRAW: «Guardar» saves it');
});
