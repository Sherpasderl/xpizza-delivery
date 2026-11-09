// REVIEW ONLY (review/portal-marca) — loaded before the portal's modules: answers the Cloud Functions calls from the scenario the
// shooter put in window.__SCN, in the servers' own shapes:
//   getMyBranches          scn.e1 (the photos-B shape, + brand.settings in the owner's caps)
//   getEditableCatalog     F-1 (catalog/portal-reads.js): platform_changes_pending = { fields } when scn.menu.pending;
//                          draft_unpublishable when scn.menu.unpublishable (today's red box, the N2 entry)
//   resetDraftToLive       scn.reset409 → 409 { error:'platform_changes_pending', detail, fields } (F-1 reset-draft.js)
//   getBrandProfile        3a's contract (marca.test.mjs CONTRACT FAKE): { ok, brand_id, version, fields | seed, palette, platform, projection }
//   updateBrandProfile     CAS on expected_version → 200 { ok, version, projected } | 409 version_conflict
(function () {
  const scn = window.__SCN || {};
  window.__shootUid = scn.uid || 'uShoot';
  const M = scn.menu || {};
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  const it = (key, cat, price, desc) => ({ key, price, display: { name: key, cat, price, ...(desc ? { desc } : {}) } });
  // the mockups' sample menu: Clásicas 3, Especiales 2, Bebidas 1
  const ITEMS = [it('Margarita', 'cl', 280, 'Tomate, mozzarella fresca y albahaca'), it('Pepperoni', 'cl', 310, 'Pepperoni y mozzarella'), it('Familiar', 'cl', 1280, 'La de compartir'),
    it('Cuatro quesos', 'es', 340, 'Mozzarella, gouda, parmesano y azul'), it('Suprema', 'es', 360, 'Carnes y vegetales'), it('Horchata', 'be', 45)];
  const cats = [{ id: 'cl', name: 'Clásicas' }, { id: 'es', name: 'Especiales' }, { id: 'be', name: 'Bebidas' }];
  const source = () => ({ restaurant_id: 'r_centro', schema_version: 1, items: JSON.parse(JSON.stringify(ITEMS)), extras: [],
    structure: { schema_version: 2, item_order: ITEMS.map((i) => i.key), categories: cats } });
  // the palette as 3a serves it (platform/brand-palette.json, verbatim from the approved mockup)
  const PALETTE = [['verde', 'Verde', '#1B6E3A'], ['ladrillo', 'Ladrillo', '#B8321F'], ['terracota', 'Terracota', '#B4531B'], ['azul', 'Azul', '#1F4FA3'],
    ['ciruela', 'Ciruela', '#6B3A86'], ['petroleo', 'Petróleo', '#0E6B6B'], ['cafe', 'Café', '#6B4A2B'], ['carbon', 'Carbón', '#2B2B2E']]
    .map(([id, label, hex]) => ({ id, label, light: hex, dark: hex, on: '#FFFFFF' }));
  const B = scn.brand || {};
  const sv = { version: B.version === undefined ? 1 : B.version,
    fields: B.fields === undefined ? { display_name: 'Pizzería Del Valle', accent: 'ladrillo', logo: null, pickup_note: '' } : B.fields,
    platform: B.platform || { whatsapp_number: '+504 9795-2893', menu_url: 'https://pedidos.sherpa.hn/del-valle' } };
  window.__brandPosts = [];
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes('cloudfunctions.net/')) return realFetch(url, opts);
    const fn = u.split('cloudfunctions.net/')[1].split('?')[0];
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    if (fn === 'getMyBranches') return json(200, scn.e1);
    if (fn === 'getEditableCatalog') {
      const out = { source: source(), sourceUpdateTime: '1700000000.000000001', activeVersionId: 'v142', usesPlatformFactura: false, renderedCategories: ['cl', 'es', 'be'],
        restaurantName: 'Pizzería Del Valle', publish_via_request: false, groupAuthoring: false, choiceBadges: [] };
      if (M.pending) out.platform_changes_pending = { fields: ['structure.badge_priority', 'item[Margarita].display.desc'] };
      if (M.unpublishable) out.draft_unpublishable = { code: 'structure_changed', detail: 'x' };
      return json(200, out);
    }
    if (fn === 'resetDraftToLive') {
      if (scn.reset409) return json(409, { error: 'platform_changes_pending', detail: 'Sherpa is updating this menu', fields: ['structure.badge_priority', 'item[Margarita].display.desc'] });
      return json(200, { ok: true });
    }
    if (fn === 'getBranchAvailability') return json(200, { branches: [] });
    if (fn === 'getBrandProfile') {
      return json(200, { ok: true, brand_id: 'marca_v', version: sv.version, fields: sv.fields ? { ...sv.fields } : null, ...(sv.fields ? {} : { seed: { display_name: 'Pizzería Del Valle' } }),
        palette: PALETTE, platform: sv.platform, projection: { branches: 3, in_sync: 3 } });
    }
    if (fn === 'updateBrandProfile') {
      window.__brandPosts.push(body);
      if (!body || body.brand_id !== 'marca_v') return json(403, { error: 'not_authorized' });
      if (body.expected_version !== sv.version) return json(409, { error: 'version_conflict', version: sv.version });
      sv.version = (sv.version || 0) + 1; sv.fields = { ...body.fields };
      return json(200, { ok: true, version: sv.version, projected: 3 });
    }
    return json(404, { error: 'not_found' });
  };
})();
