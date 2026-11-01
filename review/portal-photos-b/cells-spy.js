// REVIEW ONLY (chrome-cells.mjs) — records the portal's Cloud Functions calls and the PUT aborts, after fixture.js installed its fakes.
(function () {
  window.__calls = []; window.__aborts = 0;
  const f = window.fetch;
  window.fetch = (url, opts) => { const u = String(url); if (u.includes('cloudfunctions.net/')) window.__calls.push({ fn: u.split('cloudfunctions.net/')[1].split('?')[0], body: opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null }); return f(url, opts); };
  const X = window.XMLHttpRequest;
  window.XMLHttpRequest = class extends X { abort() { window.__aborts += 1; return super.abort(); } };
})();
