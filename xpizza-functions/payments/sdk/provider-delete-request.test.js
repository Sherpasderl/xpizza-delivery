'use strict';
// card-cleanup (PLAN (3b), advisor-approved (ii)): the drain's provider token delete is the EXACT request the probes prove.
//   RQ-FIXTURE   the vendored @pixelpay/sdk-core 2.5.2 files (test/fixtures/pixelpay-sdk-2.5.2) are unmodified: each sha256 is pinned
//                here (equal to the probes' install, payments-probe/node_modules/@pixelpay/sdk-core@2.5.2 — checked at vendoring).
//   RQ-SDK       the VENDORED SDK's own Tokenization.deleteCard, driven with a capturing axios stub (no network), builds: baseURL, the
//                card path, params { lang: 'es', from, sdk_version } (no env), these headers — and the pinned wire capture's URL is
//                exactly axios's serialization of that path + params (sdk-delete-wire.json, recorded from the REAL SDK + axios 1.17.0).
//   RQ-WIRE      OUR adapter (pixelpay-adapter pspDeleteToken) sends, to a LOOPBACK server, the byte-identical request: method, path +
//                query, raw headers in order (the port masked), no body — with and without the gateway token.
// Run: node payments/sdk/provider-delete-request.test.js
const assert = require('assert');
const crypto = require('crypto'); const fs = require('fs'); const path = require('path'); const http = require('http'); const zlib = require('zlib');
const Module = require('module');
let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const FIX = path.join(__dirname, '..', '..', 'test', 'fixtures', 'pixelpay-sdk-2.5.2');
const WIRE = JSON.parse(fs.readFileSync(path.join(FIX, 'sdk-delete-wire.json'), 'utf8'));
const TOKEN = 'T-EQ-00000000-0000-4000-8000-000000000000';
const SHA256 = [
  ['LICENSE.md', 'e0810c4796c0003b06b2d994c26e50fdd76d2e10b625f3f0117f21effaef0663'],
  ['lib/assets/media.json', 'b06833533b2a1027ee526008403187d5aeae964fb804cba2f6b87eb090cb96ea'],
  ['lib/base/Helpers.js', 'c079a65eb30540ebea14810b0939dea1bc924655092d62fb463ef8226e0a5750'],
  ['lib/base/RequestBehaviour.js', '94c8695155221d9ae32fa475d19e277e307def589338198611d43af7ac5a4796'],
  ['lib/base/Response.js', 'fdb8b4f607c2d2ca8448c44553d11638fa88047c352617f6883382679cc44246'],
  ['lib/base/ServiceBehaviour.js', '23aaec943b2fe796d3a1f5e298b8b7d19848cb45c6a468c8e4d5df8b5c66a2ed'],
  ['lib/exceptions/FailedEncryptionException.js', 'a7292dfb65c0e4878ff58341cf233dc8c906d718c4948f4f3677a6d871933f04'],
  ['lib/exceptions/InvalidCredentialsException.js', '186d97c405000feca93833d2358eb9460e1d7d30976fe9fd99c9988e649ba74f'],
  ['lib/exceptions/InvalidTransactionTypeException.js', 'b86f4672f3740b3c6d97e9c60588437c35d60741fb66ebfd73df8ba8d631d8f0'],
  ['lib/libraries/CardinalManager.js', 'ac75d50aaf72378d804e6fc01ae7138d262e1207b142da2f70365c40fef1924b'],
  ['lib/libraries/PixelPayLoading.js', '3878ae5ab7e9ea502a7441803ac9a1ee0ba08ba9852a80295a8b858312b75149'],
  ['lib/libraries/PixelPayModal.js', '07019ca64e348b6b7e758eaf699f261e0add93806b72e7354f6489c61b55242b'],
  ['lib/models/Settings.js', '1140ebb41417aac07684e342244caaf907cadf2bfeedfdacad253ff74fa88568'],
  ['lib/requests/AuthTokenization.js', '7879a3dbbe12c7a5f04eeab7c15e4449e6e06f0fb286677d31a8510e8380192c'],
  ['lib/requests/AuthTransaction.js', '96089d22786f87e0ddf5eeb8a483110e85b54bdff581bc71129225aa59047383'],
  ['lib/requests/LookupContinueTransaction.js', 'b129962fccb8a7d50ee00f5a3aad114b8c4c489a160fe1401d17d0cc8dda92b8'],
  ['lib/requests/LookupTransaction.js', '3054dce8c50f4a71f37ed085fbe469dc323e2ed48294c2fb6cf8bb0d4bf986fa'],
  ['lib/requests/PaymentTransaction.js', '9aab351b95c16aa7731336cc104dc2e6231c6772a052c54458982b46f060cdec'],
  ['lib/requests/SaleTransaction.js', '86123a33fd380ab4fad7c1a382e68fc2b7980aec635924cd9ac7a051d9c4939c'],
  ['lib/resources/Environment.js', '58a1019e6e6d3da60905017db065d2964fc986405e050eb3b6252fa15781b939'],
  ['lib/responses/ErrorResponse.js', '411d708bf51c98cb14c511e237056fe5f9a95d803a41497a8d99008e4d0053b5'],
  ['lib/responses/FailureResponse.js', '4562dc62baaf772b363bec34c71eed2a67870d7140e45e61930186d203896990'],
  ['lib/responses/InputErrorResponse.js', '1ce03dbfd9353e43a06d06bf2c4b2739e40a99c70f281696cb5b178feba9fefc'],
  ['lib/responses/NetworkFailureResponse.js', '823731a31c2f0a744366eb25d07c4d46491e38fa80da6408de112d164636f8ec'],
  ['lib/responses/NoAccessResponse.js', '626b7594729b177402bf523f829cdd1ec5ec5585ee0b401850f1e2ca47eef509'],
  ['lib/responses/NotFoundResponse.js', '067a7e079c46b10f0176f446d8a6dc6e2c636348631af0bcf5cd58da577c647a'],
  ['lib/responses/PayloadResponse.js', '0d98503ad205ad0804354af8a11a12dfc6bbd8260dbccef9050b0230f41536c3'],
  ['lib/responses/PaymentDeclinedResponse.js', '90508085ea79d1e317dfe8d8770ec609bd46690b684181659abf101f34e2f07d'],
  ['lib/responses/PreconditionalResponse.js', 'df329d18633b445a6f27c15417d0816b68af4576a2068b4e62ded36deffbcafd'],
  ['lib/responses/SuccessResponse.js', 'df7bc66c8d468f35a94edcb53fc02ccf8f47cb354db1d4311f4bcf124bb1387a'],
  ['lib/responses/TimeoutResponse.js', '4f30bacd248121e05a428af1c4bab4531160419046beabf4a7e9212ca8957462'],
  ['lib/services/CardinalAuthentication.js', 'd4488dc8e74116cb5aa731c5ba3c9c749ab8710b28e0ca381cd621dd939cb44c'],
  ['lib/services/Tokenization.js', 'baa5582c80aad61b09c674b0c6a013547f212a17ef00465fb8857ea0adfddaac'],
  ['lib/version.js', 'cb865438fa0789dac3c7cd529e7cae050d760238a90dade32107f3e1a0f73e66'],
];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(FIX, f))).digest('hex');
const masked = (raw) => raw.map((h, i) => (i % 2 === 1 && /^127\.0\.0\.1:\d+$/.test(h) ? '127.0.0.1:<port>' : h));
// a loopback server that records exactly what arrives, then answers with `answer`
function loopback(answer) {
  return new Promise((resolve) => {
    const got = [];
    const srv = http.createServer((rq, rs) => { let body = ''; rq.on('data', (c) => { body += c; }); rq.on('end', () => { got.push({ method: rq.method, url: rq.url, httpVersion: rq.httpVersion, rawHeaders: masked(rq.rawHeaders), body }); answer(rs); }); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, got, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const json400 = (rs) => { rs.writeHead(400, { 'Content-Type': 'application/json' }); rs.end('{"success":false,"message":"El token no es valido"}'); };

(async () => {
  await cell('RQ-FIXTURE', (L) => {
    assert.strictEqual(SHA256.length, 34, `${L}: premise — the 33 deleteCard files + LICENSE.md are pinned`);
    for (const [f, h] of SHA256) assert.strictEqual(sha(f), h, `${L}: the vendored ${f} is the unmodified 2.5.2 file`);
    assert.ok(WIRE.versions && WIRE.versions.sdk === '2.5.2' && WIRE.versions.axios === '1.17.0' && WIRE.captures.length === 2, `${L}: the wire evidence names the SDK / axios versions the probes ran`);
  });
  await cell('RQ-SDK', async (L) => {
    const seen = [];
    const stubAxios = { create: (cfg) => ({ delete: async (url, opts) => { seen.push({ cfg, url, opts }); return { status: 400, data: { success: false, message: 'x' } }; } }) };
    const stubs = { axios: { default: stubAxios, ...stubAxios, __esModule: true }, tweetnacl: {}, 'tweetnacl-util': {}, 'crypto-js': {} };
    const orig = Module._load;
    Module._load = function (req, parent, isMain) { if (Object.prototype.hasOwnProperty.call(stubs, req) && parent && String(parent.filename).startsWith(FIX)) return stubs[req]; return orig.apply(this, arguments); };
    try {
      const Settings = require(path.join(FIX, 'lib/models/Settings.js')).default;
      const Tokenization = require(path.join(FIX, 'lib/services/Tokenization.js')).default;
      for (const gw of [null, 'GW-PLACEHOLDER-0001']) {
        const st = new Settings(); st.setupEndpoint('http://127.0.0.1:1'); st.setupCredentials('KEY-PLACEHOLDER-0001', 'HASH-PLACEHOLDER-0001'); st.setupLanguage('es');
        if (gw) st.setupHeaders({ 'x-gw-access-token': gw });
        await new Tokenization(st).deleteCard(TOKEN);
      }
    } finally { Module._load = orig; }
    assert.strictEqual(seen.length, 2, `${L}: premise — the vendored deleteCard ran twice`);
    for (const [i, s] of seen.entries()) {
      assert.strictEqual(s.url, `api/v2/tokenization/card/${TOKEN}`, `${L}: the card path, the token raw`);
      assert.deepStrictEqual(s.opts && s.opts.params, { lang: 'es', from: 'sdk-javascript', sdk_version: '2.5.2' }, `${L}: the params (no env)`);
      const q = Object.entries(s.opts.params).map(([k, v]) => `${k}=${v}`).join('&');
      assert.strictEqual(WIRE.captures[i].url, `/${s.url}?${q}`, `${L}: the pinned wire URL is exactly axios's serialization of that path + params`);
      const want = { Accept: 'application/json', 'Content-Type': 'application/json', 'x-auth-key': 'KEY-PLACEHOLDER-0001', 'x-auth-hash': 'HASH-PLACEHOLDER-0001', ...(i === 1 ? { 'x-gw-access-token': 'GW-PLACEHOLDER-0001' } : {}) };
      assert.deepStrictEqual(s.cfg.headers, want, `${L}: the SDK's headers (${i ? 'with' : 'without'} the gateway token)`);
    }
  });
  await cell('RQ-WIRE', async (L) => {
    const PA = require('./pixelpay-adapter');
    for (const [i, gw] of [[0, null], [1, 'GW-PLACEHOLDER-0001']]) {
      const { srv, got, base } = await loopback(json400);
      try {
        const impl = PA.makePixelPayImpl({ mode: 'production', endpoint: base, key_id: 'KEY-PLACEHOLDER-0001', auth_hash: 'HASH-PLACEHOLDER-0001', gw_token: gw, secret: 's', merchant_email: 'm@x.hn', app_url: 'https://x', namespace: 'prod' }, { log: { info() {}, warn() {}, error() {} } });
        const r = await impl.pspDeleteToken({ token: TOKEN });
        assert.deepStrictEqual(r, { status: 400, success: false }, `${L}: the status passes through (400, not a success)`);
      } finally { srv.close(); }
      assert.strictEqual(got.length, 1, `${L}: one request`);
      assert.deepStrictEqual(got[0], WIRE.captures[i], `${L}: OUR request is byte-identical to the SDK's (${gw ? 'with' : 'without'} the gateway token): method, path + query, raw headers in order, no body`);
    }
  });
  await cell('RQ-REPLY', async (L) => {
    const PA = require('./pixelpay-adapter');
    const { srv, base } = await loopback((rs) => { rs.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); rs.end(zlib.gzipSync('{"success":true}')); });
    try {
      const impl = PA.makePixelPayImpl({ mode: 'production', endpoint: base, key_id: 'k', auth_hash: 'h', gw_token: null, secret: 's', merchant_email: 'm@x.hn', app_url: 'https://x', namespace: 'prod' }, { log: { info() {} } });
      assert.deepStrictEqual(await impl.pspDeleteToken({ token: TOKEN }), { status: 200, success: true }, `${L}: a compressed 200 reply is decoded (we accept the encodings axios offers)`);
      assert.throws(() => PA.deleteTokenRequest({ mode: 'production', endpoint: base, key_id: 'k', auth_hash: 'h' }, '../../transaction/void'), /charset/, `${L}: a token outside the provider charset is never put in the path`);
      assert.ok(/&env=sandbox$/.test(PA.deleteTokenRequest({ mode: 'sandbox', endpoint: base, key_id: 'k', auth_hash: 'h' }, TOKEN).url), `${L}: sandbox mode adds env=sandbox, as setupSandbox does`);
    } finally { srv.close(); }
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nprovider-delete-request: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { process.stderr.write(`provider-delete-request: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
