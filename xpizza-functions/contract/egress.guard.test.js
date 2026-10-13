'use strict';
// R3 P1-a (codex r1 P1-1) — THE EGRESS GUARD's acceptance (npm test chain). tools/egress-guard.js, preloaded before any
// client, refuses every non-loopback connection at the PROCESS level. Each supported network path is driven at a
// non-loopback destination and must be refused AND recorded, while loopback keeps working; a redirect from a permitted
// loopback server to an external host is refused at the hop. Also checked: emulator-run preloads the guard FIRST into
// every suite step, and every R3 contract entry in the npm test chain preloads it.
// Run: node -r ./tools/egress-guard.js contract/egress.guard.test.js
const G = require('../tools/egress-guard');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const dns = require('dns');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-EGRESS ${m}`;
const EXT = 'api.ultramsg.com';
const refusedSince = (k) => G.refused.slice(k);
const isRefusal = (e) => !!e && (e.code === 'ERR_R3_EGRESS_REFUSED' || (e.cause && e.cause.code === 'ERR_R3_EGRESS_REFUSED') || /REFUSED \(tests reach loopback only\)/.test(String(e && (e.message + (e.cause ? e.cause.message : '')))));
const viaReq = (mod, url) => new Promise((resolve) => {
  let req; try { req = mod.request(url, { method: 'POST' }); } catch (e) { resolve(e); return; }
  req.on('error', (e) => resolve(e)); req.on('response', () => resolve(null)); req.end('x');
});

(async () => {
  assert.ok(process.env.R3_EGRESS_MODE !== 'record', FAIL('this acceptance runs in the default refuse mode'));
  assert.ok(global.__R3_EGRESS_GUARD === true, FAIL('the guard is not installed'));
  const srv = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: `http://${EXT}/r3-probe` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('loopback-ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    // loopback keeps working through every client
    assert.strictEqual(await (await fetch(`${base}/x`)).text(), 'loopback-ok', FAIL('loopback fetch broke'));
    assert.strictEqual(await viaReq(http, `${base}/x`), null, FAIL('loopback http.request broke'));
    ok('loopback works: fetch and http.request reach a 127.0.0.1 server');

    const cases = [
      ['fetch (undici)', async () => { try { await fetch(`https://${EXT}/r3-test-instance/messages/chat`, { method: 'POST', body: 'a=1' }); return null; } catch (e) { return e; } }],
      ['http.request', () => viaReq(http, `http://${EXT}/r3`)],
      // an IP LITERAL needs no DNS: only the connect-level refusal can stop it (192.0.2.1 = TEST-NET-1, never routed)
      ['http.request to an IP literal (no DNS)', () => viaReq(http, 'http://192.0.2.1/r3')],
      ['net.connect to an IP literal', () => new Promise((resolve) => { const sk = require('net').connect({ host: '192.0.2.1', port: 443 }); sk.on('error', (e) => resolve(e)); sk.on('connect', () => { sk.destroy(); resolve(null); }); })],
      ['https.request', () => viaReq(https, `https://${EXT}/r3`)],
      ['redirect loopback → external (fetch follows)', async () => { try { await fetch(`${base}/redirect`); return null; } catch (e) { return e; } }],
      ['node-fetch', async () => { const nf = require('node-fetch'); try { await nf(`https://${EXT}/r3`); return null; } catch (e) { return e; } }],
      ['dns.lookup', () => new Promise((r) => dns.lookup(EXT, (e) => r(e)))],
      ['dns.promises.lookup', async () => { try { await dns.promises.lookup(EXT); return null; } catch (e) { return e; } }],
      ['jsdom XMLHttpRequest (outside the page harness)', () => new Promise((resolve) => {
        const { JSDOM } = require('jsdom');
        const w = new JSDOM('<!doctype html><body></body>', { url: base + '/' }).window;
        const x = new w.XMLHttpRequest(); x.open('POST', `https://${EXT}/r3`); x.onerror = () => { w.close(); resolve('xhr-error'); }; x.onload = () => { w.close(); resolve(null); }; x.send('a=1');
      })],
    ];
    for (const [label, run] of cases) {
      const k = G.refused.length;
      // bounded: a path that is NOT refused would hang on the unroutable address — that is a failure, not a wait
      const r = await Promise.race([run(), new Promise((res) => setTimeout(() => res('TIMEOUT'), 4000))]);
      assert.ok(r !== 'TIMEOUT', FAIL(`${label}: not refused (the connection was attempted and hung)`));
      const recs = refusedSince(k);
      assert.ok(r !== null && recs.length > 0 && recs.every((x) => !/127\.0\.0\.1|localhost/.test(x.target)) && recs.some((x) => x.target.startsWith(EXT) || x.target.startsWith('192.0.2.1')), FAIL(`${label}: not refused (result ${r && (r.code || r.message || r)}; recorded ${JSON.stringify(recs)})`));
      if (r !== 'xhr-error') assert.ok(isRefusal(r) || /ERR_R3_EGRESS_REFUSED|REFUSED/.test(String(r && (r.stack || r))) || (r && r.cause && isRefusal(r.cause)), FAIL(`${label}: failed for another reason (${r && (r.code || r.message)})`));
    }
    ok(`every path to ${EXT} is REFUSED and recorded: ${cases.map((c) => c[0]).join('; ')}`);
  } finally { srv.close(); }

  // wiring: emulator-run preloads the guard FIRST into every suite step; every R3 contract entry in npm test preloads it
  const er = fs.readFileSync(path.join(__dirname, '..', 'tools', 'emulator-run.js'), 'utf8');
  assert.ok(/const INNER = injectCounter\(rest\[0\], EGRESS, COUNTER, NULL_GUARD\);/.test(er) && /const EGRESS = path\.join\(ROOT, 'tools', 'egress-guard\.js'\);/.test(er), FAIL('emulator-run does not preload tools/egress-guard.js first'));
  const { injectCounter } = require('../tools/emulator-run');
  const inj = injectCounter('node a.js && node --experimental-vm-modules b.mjs', '/x/tools/egress-guard.js', '/x/tools/count-marks.js');
  assert.ok((inj.match(/-r \/x\/tools\/egress-guard\.js -r \/x\/tools\/count-marks\.js/g) || []).length === 2, FAIL(`chained injection: ${inj}`));
  const steps = require('../package.json').scripts.test.split('&&').map((x) => x.trim()).filter((x) => /\scontract\//.test(x));
  const bare = steps.filter((x) => !/-r \.\/tools\/egress-guard\.js /.test(x));
  assert.deepStrictEqual(bare, [], FAIL(`R3 contract entries in npm test without the egress preload:\n  ${bare.join('\n  ')}`));
  ok(`wiring: emulator-run injects the guard ahead of the counter into EVERY chained node step; all ${steps.length} R3 contract entries in npm test preload it`);
  const al = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'egress-allowlist.json'), 'utf8')).entries;
  for (const a of al) assert.ok(a.suite && a.host && a.reason && a.owner, FAIL(`allowlist entry incomplete: ${JSON.stringify(a)}`));
  ok(`allowlist: ${al.length} reviewed entr${al.length === 1 ? 'y' : 'ies'} (each names suite, host, reason, owner)`);
  console.log(`\nr3-egress guard: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-egress guard FAILED:', e && e.stack || e); process.exit(1); });
