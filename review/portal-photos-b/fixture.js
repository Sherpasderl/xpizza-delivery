// REVIEW ONLY (review/portal-photos-b) — loaded before the portal's modules: answers the Cloud Functions calls and the signed
// Storage PUT from the scenario the shooter put in window.__SCN, in the shapes of PLAN-dish-photos §2.2 (+ amendments).
//   scn.e1        getMyBranches answer          scn.menu   {items, photos, previews, legacy, enabled, viaRequest, fiscal}
//   scn.avail     getBranchAvailability answer  scn.diff   the editCatalog diff (the source is echoed back as canonical)
//   scn.put       'ok' | 'hold' (62 %, never ends: P4) | 'fail'      scn.process  [status, body] for E-P2 (default: the pid)
(function () {
  const scn = window.__SCN || {};
  window.__shootUid = scn.uid || 'uShoot';
  const M = scn.menu || {};
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  const PHOTO = (f) => `/review/portal-photos-b/mockup/mockup-dish-photo/${f}`;
  window.__PHOTO = PHOTO;
  const cats = [{ id: 'cl', name: 'Clásicas' }, { id: 'es', name: 'Especiales' }, { id: 'be', name: 'Bebidas' }];
  const source = () => ({ restaurant_id: 'r_centro', schema_version: 1, items: JSON.parse(JSON.stringify(M.items || [])), extras: [],
    structure: { schema_version: 2, item_order: (M.items || []).map((i) => i.key), categories: cats } });
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes('cloudfunctions.net/')) return realFetch(url, opts);
    const fn = u.split('cloudfunctions.net/')[1].split('?')[0];
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    if (fn === 'getMyBranches') return json(200, scn.e1);
    if (fn === 'getEditableCatalog') {
      const out = { source: source(), sourceUpdateTime: 'T', activeVersionId: 'v142', usesPlatformFactura: !!M.fiscal, renderedCategories: ['cl', 'es', 'be'],
        restaurantName: 'Pizzería Del Valle' };
      if (M.photos && Object.keys(M.photos).length) out.photos = M.photos;
      if (M.previews && Object.keys(M.previews).length) out.photoPreviews = M.previews;
      if (M.legacy && Object.keys(M.legacy).length) out.legacyPreviews = M.legacy;
      if (M.enabled) out.photosEnabled = true;
      if (M.viaRequest) out.publish_via_request = true;
      return json(200, out);
    }
    if (fn === 'getBranchAvailability') return json(200, scn.avail || { branches: [] });
    if (fn === 'photoUploadStart') return json(200, { uploadId: 'up1', method: 'PUT', expiresAt: Date.now() + 600e3,
      url: 'https://storage.googleapis.com/xpizza-delivery.firebasestorage.app/uploads/r_centro/up1?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=shoot',
      headers: { 'Content-Type': body.contentType, 'x-goog-content-length-range': '1,10485760', 'x-goog-if-generation-match': '0' } });
    if (fn === 'photoProcess') {
      if (scn.process) return json(scn.process[0], scn.process[1]);
      return json(200, { pid: 'pidPep', preview: { card: PHOTO('09-pepperoni.jpg'), hero: PHOTO('09-pepperoni.jpg'), expiresAt: Date.now() + 3600e3 } });
    }
    if (fn === 'editCatalog') return json(200, { diff: scn.diff || { changed: [], added: [], removed: [], renamed: [], largeChangeSet: [] }, token: 'tok', updateTime: 'T2', source: body.source });
    if (fn === 'publishEdited') return json(200, { ok: true, versionId: 'v143' });
    if (fn === 'catalogRequestPublish') return json(200, { ok: true });
    return json(404, { error: 'not_found' });
  };
  // the signed PUT (XMLHttpRequest, for progress)
  window.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; }
    open() {}
    setRequestHeader() {}
    abort() { if (this.onabort) this.onabort(); }
    send(b) {
      const total = (b && b.size) || 1;
      if (scn.put === 'hold') { setTimeout(() => { if (this.upload.onprogress) this.upload.onprogress({ loaded: Math.round(total * 0.62), total }); }, 10); return; }
      if (scn.put === 'fail') { setTimeout(() => this.onerror && this.onerror(), 10); return; }
      setTimeout(() => { if (this.upload.onprogress) this.upload.onprogress({ loaded: total, total }); this.status = 200; if (this.onload) this.onload(); }, 10);
    }
  };
})();
