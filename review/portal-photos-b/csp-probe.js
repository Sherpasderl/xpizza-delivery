// REVIEW ONLY (chrome-cells.mjs) — served under netlify.toml's REAL Content-Security-Policy header: which loads does the browser
// block? Each probe runs ALONE in its own window and counts the violations raised during it (a cross-origin violation reports
// only the origin, so matching by URL is impossible). The violation is raised before any network, so no Storage access is
// needed. window.__csp = {"img|put URL": blocked}, set when every probe has run.
(async function () {
  const out = {};
  let hits = 0;
  document.addEventListener('securitypolicyviolation', () => { hits += 1; });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const probes = [
    ['img', 'https://storage.googleapis.com/xpizza-delivery-photos/photos/r/P-card.webp'],
    ['img', 'https://storage.googleapis.com/xpizza-delivery.firebasestorage.app/drafts/r/P-card.webp?X-Goog-Signature=x'],
    ['img', 'blob:'],
    ['put', 'https://storage.googleapis.com/xpizza-delivery.firebasestorage.app/uploads/r/u1?X-Goog-Signature=x'],
    ['img', 'https://storage.googleapis.com/xpizza-delivery.firebasestorage.app/uploads/r/u1'],
    ['img', 'https://storage.googleapis.com/other-bucket/photos/r/P.webp'],
    ['img', 'https://xpizza-delivery-photos.storage.googleapis.com/photos/r/P.webp'],
    ['img', 'https://xpizza-orders.netlify.app/images/a.jpg'],
    ['put', 'https://storage.googleapis.com/xpizza-delivery.firebasestorage.app/drafts/r/x'],
    ['put', 'https://storage.googleapis.com/other-bucket/uploads/r/u1'],
  ];
  for (const [kind, url] of probes) {
    const before = hits;
    let threw = false;
    if (kind === 'img') { const i = new Image(); i.src = url === 'blob:' ? URL.createObjectURL(new Blob(['x'], { type: 'image/png' })) : url; }
    else { try { const x = new XMLHttpRequest(); x.open('PUT', url); x.send('x'); } catch (_) { threw = true; } }
    await wait(250);
    out[`${kind} ${url}`] = threw || hits > before;
  }
  window.__csp = out;
})();
