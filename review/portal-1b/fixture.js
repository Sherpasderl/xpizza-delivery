// REVIEW ONLY (review/portal-1b) — loaded before the portal's modules: answers the Cloud Functions calls from the scenario the
// shooter put in window.__SCN (getMyBranches answers in order, the last repeating; writes answer from scn.writes).
(function () {
  const scn = window.__SCN || { e1: [] };
  window.__shootUid = scn.uid || 'uShoot';
  let n = 0;
  const realFetch = window.fetch.bind(window);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes('cloudfunctions.net/')) return realFetch(url, opts);
    const fn = u.split('cloudfunctions.net/')[1].split('?')[0];
    if (fn === 'getMyBranches') { const r = scn.e1[Math.min(n, scn.e1.length - 1)]; n += 1; return json(200, r); }
    if (fn === 'getEditableCatalog') return json(200, { source: { restaurant_id: 'r', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'getBranchAvailability') return json(200, { branches: [] });
    if (scn.writes && scn.writes[fn]) { const [s, b] = scn.writes[fn]; return json(s, b); }
    return json(404, { error: 'not_found' });
  };
})();
