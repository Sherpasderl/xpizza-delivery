// DISH PHOTOS B — the pure half (photo-logic.js) against PLAN-dish-photos r2 §2.2 (+ amendments 2026-10-27) and the
// owner-approved mockup's «Textos». Run: node --test xpizza-portal/photo-logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from './photo-logic.js';
import { rekeyTmpPhotos, REKEY_CASES } from './photo-contract-fake.mjs';

const MOCKUP = (() => { try { return readFileSync(new URL('../../xpizza-D4c-grill/MOCKUP-portal-dish-photo.html', import.meta.url), 'utf8'); } catch (_) { return null; } })();

test('the copy is the approved «Textos», character for character', () => {
  const C = L.COPY;
  const want = [
    C.rowUpload, C.zone, C.limits, C.field, C.take, C.gallery, C.cropTitle, C.frameLabel, C.frame.card, C.frame.hero, C.hint, C.zoom,
    C.preview, C.previewLede, C.previewCap.card, C.previewCap.hero, C.done, C.cancel, C.uploading, C.failed, C.retry,
    C.invalid.too_large, C.invalid.bad_type, C.invalid.too_small, C.remove, C.change, C.draftTag, C.removedTag, C.rmLine, C.undo,
    C.group, C.line.new, C.line.changed, C.line.removed, C.none, C.sealSub, C.sealBody,
  ];
  assert.equal(C.frame.card, 'Tarjeta (4:3)');                      // the \x28 spelling renders the approved text
  assert.equal(C.frame.hero, 'Detalle (16:10)');
  assert.equal(C.limits, 'JPG, PNG o WEBP · máx 10MB · mín 500×440');
  assert.equal(C.rowUploadAria('Pepperoni'), 'Subir foto de Pepperoni');
  assert.equal(C.alt('Pepperoni'), 'Foto de Pepperoni');
  assert.equal(C.cropAria('Pepperoni', 'card'), 'Foto de Pepperoni, encuadre de tarjeta. Arrastrá para moverla.');
  assert.equal(C.barSuffix(1), ' · 1 foto');
  assert.equal(C.barSuffix(3), ' · 3 fotos');
  assert.equal(C.sealAck(3), ' publicar las fotos de estos 3 productos.');
  assert.equal(C.sealAck(1), ' publicar la foto de este producto.');      // owner-approved singular (2026-10-27)
  assert.equal(C.receipt(['Pepperoni']), 'La foto de «Pepperoni» ya está en el menú publicado.');
  assert.equal(C.receipt(['Pepperoni', 'Margarita', 'Hawaiana']), 'Las fotos de Pepperoni, Margarita y Hawaiana ya están en el menú publicado.');
  if (MOCKUP) {
    // every string the mockup's «Textos» lists for these frames is the one the module carries
    const textos = MOCKUP.slice(MOCKUP.indexOf('id="copia"'), MOCKUP.indexOf('id="preguntas"')).replace(/&amp;/g, '&');
    for (const s of want) assert.ok(textos.includes(`«${s.trim()}»`) || textos.includes(s.trim()), `«${s}» is in the approved Textos`);
    assert.ok(textos.includes('«Autorizo publicar las fotos de estos 3 productos.»'));
    assert.ok(textos.includes('«La foto de «Pepperoni» ya está en el menú publicado.»'));
  }
});

test('P6 — the browser-side checks: type and size before reading; the oriented size after', () => {
  assert.equal(L.checkFile({ type: 'image/jpeg', size: 2e6 }), null);
  assert.equal(L.checkFile({ type: 'image/webp', size: L.MAX_BYTES }), null, 'exactly 10 MB passes (the signed range is 1..10485760)');
  assert.equal(L.checkFile({ type: 'image/png', size: L.MAX_BYTES + 1 }), 'too_large');
  for (const t of ['image/heic', 'image/gif', 'image/svg+xml', 'text/html', '']) assert.equal(L.checkFile({ type: t, size: 100 }), 'bad_type', t);
  assert.equal(L.checkFile({ type: 'image/jpeg', size: 0 }), 'bad_type');
  assert.equal(L.checkFile(null), 'bad_type');
  assert.equal(L.checkDims(500, 440), null);
  assert.equal(L.checkDims(499, 440), 'too_small');
  assert.equal(L.checkDims(500, 439), 'too_small');
  assert.equal(L.ACCEPT, 'image/jpeg,image/png,image/webp');
});

test('crops — every rect the screen can produce is one E-P2 accepts (ints, inside, aspect ±0.5 %, the amended minimums)', () => {
  assert.deepEqual([L.FRAMES.hero.minW, L.FRAMES.hero.minH], [496, 310], 'hero minimum amended 2026-10-27 (512×320 could not fit 500 wide)');
  assert.ok(L.framesFit(500, 440), 'the smallest image the approved copy admits has both crops');
  let n = 0;
  for (const [W, H] of [[500, 440], [514, 440], [500, 1000], [4032, 3024], [3024, 4032], [1000, 625], [801, 601], [2000, 441], [640, 2000], [1280, 800]]) {
    for (const f of Object.values(L.FRAMES)) {
      const zmax = L.maxZoom(W, H, f);
      for (const z of [0, 0.5, 1, 1.001, 1.37, zmax - 1e-9, zmax, zmax + 0.2, 2, 9]) {
        for (const [cx, cy] of [[-50, -50], [0, 0], [W / 2, H / 2], [W, H], [W * 2, H * 2], [W * 0.13, H * 0.91]]) {
          const r = L.rectFor(W, H, f, { z, cx, cy });
          assert.ok(L.rectOk(W, H, f, r), `${W}×${H} ${f.id} z=${z} → ${JSON.stringify(r)}`);
          n += 1;
        }
      }
    }
  }
  assert.ok(n > 1000);
  // the pinned regression: at 514×440 the hero's zoom ceiling floored a pixel short (495×309)
  const r = L.rectFor(514, 440, L.FRAMES.hero, { z: L.maxZoom(514, 440, L.FRAMES.hero), cx: 0, cy: 0 });
  assert.ok(r.w >= 496 && r.h >= 310, JSON.stringify(r));
  // non-vacuity: rectOk refuses what E-P2 refuses
  assert.equal(L.rectOk(800, 600, L.FRAMES.card, { x: 0, y: 0, w: 399, h: 300 }), false, 'under the minimum');
  assert.equal(L.rectOk(800, 600, L.FRAMES.card, { x: 1, y: 0, w: 800, h: 600 }), false, 'out of bounds');
  assert.equal(L.rectOk(800, 600, L.FRAMES.card, { x: 0, y: 0, w: 800, h: 560 }), false, 'wrong aspect');
  assert.equal(L.rectOk(800, 600, L.FRAMES.card, { x: 0.5, y: 0, w: 400, h: 300 }), false, 'not an integer');
});

test('crops — a drag moves the frame, a zoom keeps its centre, both stay inside the photo', () => {
  const f = L.FRAMES.card;
  const v0 = L.initialView(1600, 1200);
  assert.deepEqual(L.rectFor(1600, 1200, f, v0), { x: 0, y: 0, w: 1600, h: 1200 }, 'zoom 1 = the whole 4:3 photo');
  const z = L.zoomView(1600, 1200, f, v0, 2);
  assert.deepEqual(L.rectFor(1600, 1200, f, z), { x: 400, y: 300, w: 800, h: 600 }, 'zoom 2 about the centre');
  const m = L.moveView(1600, 1200, f, z, 100, 0);            // dragging the photo right shows more of its left
  assert.equal(L.rectFor(1600, 1200, f, m).x, 300);
  const far = L.moveView(1600, 1200, f, z, 1e6, -1e6);
  assert.deepEqual(L.rectFor(1600, 1200, f, far), { x: 0, y: 600, w: 800, h: 600 }, 'clamped to the photo');
  // the placement shows exactly the rect: the photo's left edge sits at -x/w of the box
  assert.deepEqual(L.placement(1600, 1200, { x: 400, y: 300, w: 800, h: 600 }), { width: 200, height: 200, left: -50, top: -50 });
  const both = L.cropsFor(1600, 1200, { card: z, hero: v0 });
  assert.ok(L.rectOk(1600, 1200, L.FRAMES.card, both.card) && L.rectOk(1600, 1200, L.FRAMES.hero, both.hero));
  assert.deepEqual(both.hero, { x: 0, y: 100, w: 1600, h: 1000 }, 'each frame keeps its own position');
});

test('three states — what a row / the drawer shows, from the draft map, the loaded map, the previews and the legacy keys', () => {
  const previews = { P1: { card: 'https://x/P1.webp' }, P2: { card: 'https://x/P2.webp', expiresAt: 9e12 } };
  const legacy = { Hawaiana: { card: 'https://x/leg.webp' }, Calzone: {} };
  const v = (key, photos, orig) => L.photoView(key, { photos, orig, previews, legacy });
  assert.deepEqual(v('Margarita', {}, {}), { kind: 'none' }, 'no entry, no legacy image → none');
  assert.equal(v('Hawaiana', {}, {}).url, 'https://x/leg.webp', 'a legacy image shows');
  assert.equal(v('Hawaiana', {}, {}).draft, false);
  const nourl = v('Calzone', {}, {});
  assert.equal(nourl.kind, 'photo'); assert.equal(nourl.neutral, true, 'a legacy key without a URL is still a photo: the neutral frame');
  const pub = v('Pep', { Pep: { state: 'pid', pid: 'P1' } }, { Pep: { state: 'pid', pid: 'P1' } });
  assert.equal(pub.url, 'https://x/P1.webp'); assert.equal(pub.draft, false, 'loaded + published (no expiry): no draft mark');
  assert.equal(v('Pep', { Pep: { state: 'pid', pid: 'P2' } }, { Pep: { state: 'pid', pid: 'P2' } }).draft, true, 'a DRAFT registry pid (expires) is «sin publicar» after a reload too');
  assert.equal(v('Pep', { Pep: { state: 'pid', pid: 'P1' } }, {}).draft, true, 'changed this session');
  const miss = v('Pep', { Pep: { state: 'pid', pid: 'PX' } }, {});
  assert.equal(miss.missing, true, 'a pid with no preview is MISSING (P5), never a broken image');
  assert.deepEqual(v('Hawaiana', { Hawaiana: { state: 'removed' } }, {}), { kind: 'removing', url: 'https://x/leg.webp' }, 'removing a legacy image');
  assert.deepEqual(v('Pep', { Pep: { state: 'removed' } }, { Pep: { state: 'pid', pid: 'P1' } }), { kind: 'removing', url: 'https://x/P1.webp' });
  assert.deepEqual(v('Pep', { Pep: { state: 'removed' } }, { Pep: { state: 'removed' } }), { kind: 'none' }, 'a stored removal reads as none');
  // «Quitar» / «Deshacer»
  assert.deepEqual(L.removedEntry('Hawaiana', { orig: {}, legacy }), { state: 'removed' }, 'legacy image → an explicit removal (no fallback)');
  assert.equal(L.removedEntry('Margarita', { orig: {}, legacy }), null, 'nothing to remove under it → back to absent');
  assert.deepEqual(L.removedEntry('Pep', { orig: { Pep: { state: 'pid', pid: 'P1' } }, legacy }), { state: 'removed' });
  assert.equal(L.undoEntry('Margarita', { orig: {} }), null, 'undo restores ABSENCE');
  assert.deepEqual(L.undoEntry('Pep', { orig: { Pep: { state: 'pid', pid: 'P1' } } }), { state: 'pid', pid: 'P1' });
  assert.deepEqual(L.pendingPhotoKeys({ A: { state: 'removed' }, B: { state: 'pid', pid: 'P' } }, { B: { state: 'pid', pid: 'P' }, C: { state: 'removed' } }), ['A', 'C']);
});

test('errors map by `error` to the approved copy; Reintentar redoes E-P2 only when the bytes are stored and the failure was transient', () => {
  for (const c of ['too_large', 'bad_type', 'too_small']) assert.deepEqual(L.errorCopy(c), { kind: 'invalid', text: L.COPY.invalid[c] });
  for (const c of ['unavailable', 'upload_missing', 'in_progress', 'rate_limited', 'bad_crop', 'op_conflict', 'photos_disabled', 'not_authorized', null, 'something_new']) {
    assert.deepEqual(L.errorCopy(c), { kind: 'failed', text: 'No se pudo subir la foto.' }, String(c));
  }
  assert.equal(L.retryPlan({ uploaded: false, code: 'unavailable' }), 'restart', 'nothing stored: a new upload (new op_id)');
  assert.equal(L.retryPlan({ uploaded: true, code: 'unavailable' }), 'process');
  assert.equal(L.retryPlan({ uploaded: true, code: 'in_progress' }), 'process');
  assert.equal(L.retryPlan({ uploaded: true, code: null }), 'process', 'no answer (network): the same E-P2 again');
  assert.equal(L.retryPlan({ uploaded: true, code: 'upload_missing' }), 'restart', 'the object is gone: E-P1 again');
  assert.equal(L.retryPlan({ uploaded: true, code: 'bad_crop' }), 'restart', 'terminal: a new upload');
  // codex r1 #5 — §2.2 attempts < 3: the third failed E-P2 on one uploadId is terminal, whatever its code
  assert.equal(L.retryPlan({ uploaded: true, code: 'unavailable', failures: 2 }), 'process', 'two failures: one attempt left');
  assert.equal(L.retryPlan({ uploaded: true, code: 'unavailable', failures: 3 }), 'restart', 'three failures: a fresh upload');
  assert.equal(L.retryPlan({ uploaded: true, code: null, failures: 3 }), 'restart');
});

test('preview renewal — 5 minutes before the earliest expiry among the pids on screen; published pids never expire', () => {
  const now = 1_000_000;
  const pv = { A: { card: 'a', expiresAt: now + 60 * 60e3 }, B: { card: 'b', expiresAt: new Date(now + 20 * 60e3).toISOString() }, C: { card: 'c' } };
  assert.equal(L.renewIn(pv, ['A', 'B', 'C'], now), 15 * 60e3);
  assert.equal(L.renewIn(pv, ['C'], now), null, 'published only: nothing to renew');
  assert.equal(L.renewIn(pv, ['A'], now + 58 * 60e3), 0, 'already inside the window: now');
});

test('review lines — «Foto nueva / cambiada / quitada» from the server line + whether a legacy image existed', () => {
  const legacy = { Haw: { card: 'u' } };
  const line = (key, o, n) => ({ surface: 'item', key, field: 'photo', old: o, new: n });
  assert.equal(L.lineKind(line('Pep', { kind: 'legacy' }, { kind: 'pid', pid: 'P' }), legacy), 'new', 'no legacy image under it');
  assert.equal(L.lineKind(line('Haw', { kind: 'legacy' }, { kind: 'pid', pid: 'P' }), legacy), 'changed', 'replaces the legacy image');
  assert.equal(L.lineKind(line('Pep', { kind: 'pid', pid: 'A' }, { kind: 'pid', pid: 'B' }), legacy), 'changed');
  assert.equal(L.lineKind(line('Haw', { kind: 'legacy' }, { kind: 'removed' }), legacy), 'removed', 'legacy → removed is a real change');
  assert.equal(L.lineKind(line('Pep', { kind: 'removed' }, { kind: 'pid', pid: 'P' }), legacy), 'new');
  assert.equal(L.stateUrl({ kind: 'legacy' }, 'Haw', {}, legacy), 'u');
  assert.equal(L.stateUrl({ kind: 'removed' }, 'Haw', {}, legacy), null);
});

test('amendment 1 — the ONE tmp re-keying rule (shared with A2: REKEY_CASES)', () => {
  assert.ok(REKEY_CASES.length >= 4);
  for (const c of REKEY_CASES) assert.deepEqual(rekeyTmpPhotos(c.photos, c.items, new Map(c.allocated)), c.want, c.name);
});

import { createDraft, setPhoto, draftPhotos, pendingPhotos, pendingCount, pendingChanges, discard } from './editor.js';
test('editor — setPhoto: the canEdit boundary, absent when empty, only the two states, only rows of the draft; counted, never a price', () => {
  const src = () => ({ items: [{ key: 'Pep', price: 310, display: { name: 'Pep', price: 310 } }, { ref: 'tmp:n', price: null, display: { name: '' } }], extras: [], structure: {} });
  let owned = false;
  const d = createDraft(src(), { canEdit: () => !owned });
  setPhoto(d, 'Pep', { state: 'pid', pid: 'P1' });
  assert.deepEqual(d.state.photos, { Pep: { state: 'pid', pid: 'P1' } });
  setPhoto(d, 'tmp:n', { state: 'pid', pid: 'P2' });
  assert.deepEqual(draftPhotos(d)['tmp:n'], { state: 'pid', pid: 'P2' }, 'an unsaved addition keys by its tmp ref (amendment 1)');
  assert.deepEqual(pendingPhotos(d), ['Pep', 'tmp:n']);
  assert.equal(pendingCount(d), 2, 'two photo changes = two pending (the bar)');
  assert.deepEqual(pendingChanges(d), [], 'no PRICE cell lights up for a photo');
  owned = true;
  setPhoto(d, 'Pep', null);
  assert.deepEqual(d.state.photos.Pep, { state: 'pid', pid: 'P1' }, '🔴 refused while the draft is owned (review / publish)');
  owned = false;
  for (const bad of [{ state: 'pid' }, { state: 'pid', pid: '' }, { state: 'pid', pid: 'X', card: 'u' }, { state: 'removed', x: 1 }, { state: 'legacy' }, 'removed', 7]) {
    setPhoto(d, 'Pep', bad);
    assert.deepEqual(d.state.photos.Pep, { state: 'pid', pid: 'P1' }, `refused: ${JSON.stringify(bad)}`);
  }
  setPhoto(d, 'Ghost', { state: 'removed' });
  assert.ok(!('Ghost' in d.state.photos), 'a key that is not a row of the draft is refused');
  setPhoto(d, 'Pep', null); setPhoto(d, 'tmp:n', null);
  assert.ok(!('photos' in d.state), 'an empty map goes back to ABSENT — the photo-less document is byte-identical to today');
  setPhoto(d, 'Pep', { state: 'removed' });
  discard(d);
  assert.ok(!('photos' in d.state), 'Descartar restores the loaded document');
});

test('P5-L (owner-approved ratelimit mockup, option B): `rate_limited` maps to the neutral limit note; every other non-file code stays P5', () => {
  assert.deepEqual(L.errorCopy('rate_limited'), { kind: 'limited', text: 'Subiste muchas fotos seguidas. Probá de nuevo más tarde.' });
  for (const c of ['unavailable', 'in_progress', 'upload_missing', 'bad_crop', 'photo_unavailable', null]) assert.deepEqual(L.errorCopy(c), { kind: 'failed', text: 'No se pudo subir la foto.' }, String(c));
  assert.equal(L.errorCopy('too_large').kind, 'invalid');
});
