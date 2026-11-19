'use strict';
// card-cleanup (3b): capture the EXACT wire request the REAL @pixelpay/sdk-core 2.5.2 + axios (the probes' install) sends for
// Tokenization.deleteCard — against a LOOPBACK server only (no network). Settings as probe-live-auth: setupEndpoint, setupCredentials,
// setupLanguage('es'), optional x-gw-access-token, no environment. Placeholder credentials (not secrets). Prints the captured JSON.
const http = require('http'); const path = require('path'); const { createRequire } = require('module');
const PROBE_DIR = path.join(process.env.HOME, 'Downloads/xpizza-delivery/payments-probe');
const req = createRequire(path.join(PROBE_DIR, 'package.json'));
const PixelPay = req('@pixelpay/sdk-core');
const versions = { sdk: req('@pixelpay/sdk-core/package.json').version, axios: req('axios/package.json').version };
const srv = http.createServer((rq, rs) => {
  let body = ''; rq.on('data', (c) => { body += c; }); rq.on('end', () => { srv.captured.push({ method: rq.method, url: rq.url, httpVersion: rq.httpVersion, rawHeaders: rq.rawHeaders, body }); rs.writeHead(400, { 'Content-Type': 'application/json' }); rs.end('{"success":false,"message":"El token no es valido"}'); });
});
srv.captured = [];
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  for (const gw of [null, 'GW-PLACEHOLDER-0001']) {
    const st = new PixelPay.Models.Settings();
    st.setupEndpoint(`http://127.0.0.1:${port}`); st.setupCredentials('KEY-PLACEHOLDER-0001', 'HASH-PLACEHOLDER-0001'); st.setupLanguage('es');
    if (gw) st.setupHeaders({ 'x-gw-access-token': gw });
    await new PixelPay.Services.Tokenization(st).deleteCard('T-EQ-00000000-0000-4000-8000-000000000000');
  }
  srv.close();
  console.log(JSON.stringify({ versions, node: process.version, captures: srv.captured.map((c) => ({ ...c, rawHeaders: c.rawHeaders.map((h, i) => (i % 2 === 1 && /^127\.0\.0\.1:\d+$/.test(h) ? '127.0.0.1:<port>' : h)) })) }, null, 1));
});
