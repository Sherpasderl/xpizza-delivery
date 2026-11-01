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
  btnText(drawer(d), 'Cerrar').click();
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
