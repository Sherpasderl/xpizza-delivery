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

  // ── codex r2 P1-1a: the RESOLVED destination — a loopback NAME whose (custom) lookup maps to an external address ──
  {
    const k = G.refused.length;
    const r = await Promise.race([new Promise((resolve) => { const sk = require('net').connect({ host: 'localhost', port: 443, lookup: (h, o, cb) => cb(null, '192.0.2.1', 4) }); sk.on('error', (e) => resolve(e)); sk.on('connect', () => { sk.destroy(); resolve(null); }); }), new Promise((res) => setTimeout(() => res('TIMEOUT'), 4000))]);
    assert.ok(r && r !== 'TIMEOUT' && isRefusal(r) && G.refused.slice(k).some((x) => /localhost→192\.0\.2\.1/.test(x.target)), FAIL(`localhost with a custom lookup → 192.0.2.1 was not refused (${r && (r.code || r)})`));
    const k2 = G.refused.length;
    const r2 = await Promise.race([new Promise((resolve) => { const q = http.request({ host: 'localhost', port: 80, path: '/', lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: '192.0.2.1', family: 4 }]) : cb(null, '192.0.2.1', 4)) }); q.on('error', (e) => resolve(e)); q.on('response', () => resolve(null)); q.end(); }), new Promise((res) => setTimeout(() => res('TIMEOUT'), 4000))]);
    assert.ok(r2 && r2 !== 'TIMEOUT' && G.refused.slice(k2).length > 0, FAIL('http.request with a custom lookup mapping localhost → external was not refused'));
    // IPv6 normalization (codex r2 P2): every spelling of loopback is loopback; nothing else is
    const yes = ['::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '::ffff:7f00:1', '::ffff:127.0.0.1', '::FFFF:7F00:0001', '[::1]', '127.9.8.7'];
    const no = ['::ffff:c000:201', '::ffff:192.0.2.1', '::2', 'fe80::1', '2001:db8::1', '192.0.2.1', '128.0.0.1'];
    assert.ok(yes.every((a) => G.isLoopbackAddress(a)) && no.every((a) => !G.isLoopbackAddress(a)), FAIL(`IPv6 / IPv4 normalization: ${JSON.stringify({ yes: yes.filter((a) => !G.isLoopbackAddress(a)), no: no.filter((a) => G.isLoopbackAddress(a)) })}`));
    ok(`the RESOLVED destination is checked: localhost with a custom lookup → 192.0.2.1 is refused (net.connect and http.request); loopback is recognised on the normalized address (${yes.length} spellings incl. ::ffff:7f00:1), ${no.length} non-loopback forms are not`);
  }

  // ── codex r2 P1-1b: DESCENDANTS — the guard travels with every child, whatever env / execArgv the caller passes ──
  {
    const code = "const q=require('http').request('http://192.0.2.1/x');q.on('error',e=>{console.log(e.code)});q.end();setTimeout(()=>{},300)";
    const cp = require('child_process');
    const out = (r) => String(r && (r.stdout !== undefined ? r.stdout : r) || '').trim();
    const sync = (f) => { try { return f(); } catch (e) { return `ESCAPED (${e && (e.code || e.message)})`; } };   // an unguarded child hangs on the unroutable address → timeout
    const replaced = out(cp.spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 8000 }));
    const e2 = { ...process.env }; delete e2.NODE_OPTIONS;
    const deleted = sync(() => out(cp.execFileSync(process.execPath, ['-e', code], { env: e2, encoding: 'utf8', timeout: 8000 })));
    const plain = out(cp.spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 8000 }));
    const viaExec = sync(() => out(cp.execSync(`"${process.execPath}" -e "${code.replace(/"/g, '\\"')}"`, { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 8000 })));
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'r3-egress-fork-')); const kid = path.join(tmp, 'kid.js');
    fs.writeFileSync(kid, "const q=require('http').request('http://192.0.2.1/x');q.on('error',e=>{process.send(e.code,()=>process.exit(0))});q.end();");
    const forked = await new Promise((resolve) => { const f = cp.fork(kid, [], { execArgv: [], env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); const t = setTimeout(() => { f.kill(); resolve('TIMEOUT'); }, 6000); f.on('message', (m) => { clearTimeout(t); resolve(m); }); f.on('error', (e) => { clearTimeout(t); resolve(`error ${e.message}`); }); });
    fs.rmSync(tmp, { recursive: true, force: true });
    const { Worker } = require('worker_threads');
    const worker = await new Promise((resolve) => { const w = new Worker("const q=require('http').request('http://192.0.2.1/x');q.on('error',e=>{require('worker_threads').parentPort.postMessage(e.code)});q.end();", { eval: true, execArgv: [] }); const t = setTimeout(() => { w.terminate(); resolve('TIMEOUT'); }, 6000); w.on('message', (m) => { clearTimeout(t); w.terminate(); resolve(m); }); w.on('error', (e) => { clearTimeout(t); resolve(`error ${e.message}`); }); });
    // a Worker honours NODE_OPTIONS from ITS env: an explicit EMPTY env is the case only the guard's env layer can cover
    const workerEmptyEnv = await new Promise((resolve) => { const w = new Worker("const q=require('http').request('http://192.0.2.1/x');q.on('error',e=>{require('worker_threads').parentPort.postMessage(e.code)});q.end();", { eval: true, execArgv: [], env: {} }); const t = setTimeout(() => { w.terminate(); resolve('TIMEOUT'); }, 6000); w.on('message', (m) => { clearTimeout(t); w.terminate(); resolve(m); }); w.on('error', (e) => { clearTimeout(t); resolve(`error ${e.message}`); }); });
    const all = { replaced, deleted, plain, viaExec, forked, worker, workerEmptyEnv };
    assert.ok(Object.values(all).every((v) => v === 'ERR_R3_EGRESS_REFUSED'), FAIL(`a descendant escaped the guard: ${JSON.stringify(all)}`));
    ok(`descendants are guarded whatever the caller passes: spawnSync with a REPLACED env, execFileSync with NODE_OPTIONS DELETED, a plain spawnSync, execSync, fork with execArgv: [] + a replaced env, a Worker with execArgv: [], a Worker with execArgv: [] AND an EMPTY env — each refused`);
  }

  // ── codex r2 P1-1b/1d static: every child-launch API used by a test / tool file is one the guard wraps; any NEW unix
  // socket / pre-opened transport / custom createConnection use is flagged (none exists today — out of scope, residual)
  {
    const acorn = require('acorn');
    const ROOT = path.join(__dirname, '..');
    const files = []; (function w(d) { for (const nm of fs.readdirSync(d)) { if (['node_modules', 'sdk-10.13.2', '.git', '.firebase'].includes(nm)) continue; const p = path.join(d, nm); const st = fs.statSync(p); if (st.isDirectory()) w(p); else if (/\.(c?js|mjs)$/.test(nm)) files.push(p); } })(ROOT);
    const WRAPPED = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync', 'Worker']);
    const CP_API = new Set([...WRAPPED, 'execFileAsync', 'spawnAsync']);
    const bypass = []; const transport = []; let launches = 0;
    const SELF = new Set([__filename, path.join(ROOT, 'tools', 'egress-guard.js')]);
    for (const f of files) {
      if (SELF.has(f)) continue;
      const src = fs.readFileSync(f, 'utf8'); let ast;
      const o = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true };
      try { ast = acorn.parse(src, { ...o, sourceType: /\.mjs$/.test(f) ? 'module' : 'script' }); } catch (_) { try { ast = acorn.parse(src, { ...o, sourceType: 'module' }); } catch (__) { continue; } }
      const rel = path.relative(ROOT, f);
      (function rec(n) {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'CallExpression' || n.type === 'NewExpression') {
          const c = n.callee; const nm = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null);
          if (WRAPPED.has(nm)) launches += 1;
          if (nm === 'binding' || nm === 'internalBinding') { const a = n.arguments[0]; if (a && /spawn|process_wrap|tcp_wrap|pipe_wrap/.test(String(a.value))) bypass.push(`${rel}:${n.loc.start.line} ${nm}(${a.value})`); }
          if (nm === 'connect' || nm === 'createConnection') { const op = n.arguments[0]; if (op && op.type === 'ObjectExpression' && op.properties.some((p) => p.key && ['path', 'fd'].includes(p.key.name))) transport.push(`${rel}:${n.loc.start.line} ${nm}({ path/fd })`); }
        }
        if (n.type === 'Property' && n.key && ['socketPath', 'createConnection'].includes(n.key.name || n.key.value)) transport.push(`${rel}:${n.loc.start.line} ${n.key.name || n.key.value}:`);
        if (n.type === 'NewExpression' && n.callee && n.callee.type === 'MemberExpression' && n.callee.property.name === 'Socket' && n.arguments[0] && n.arguments[0].type === 'ObjectExpression' && n.arguments[0].properties.some((p) => p.key && p.key.name === 'fd')) transport.push(`${rel}:${n.loc.start.line} new Socket({ fd })`);
        for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(rec); else if (v && typeof v.type === 'string') rec(v); }
      })(ast);
      void CP_API;
    }
    const REVIEWED_TRANSPORT = [];   // residual, out of scope: unix sockets / pre-opened transports — none used by a test today
    assert.deepStrictEqual(bypass, [], FAIL(`a process / socket binding bypasses the wrapped APIs:\n  ${bypass.join('\n  ')}`));
    assert.deepStrictEqual(transport.filter((t) => !REVIEWED_TRANSPORT.includes(t)), [], FAIL(`a NEW unix-socket / pre-opened-transport / custom createConnection use (outside the egress boundary — review it):\n  ${transport.join('\n  ')}`));
    ok(`static: ${files.length} test / tool sources — ${launches} child-launch call sites, all through the wrapped APIs (no process / socket binding bypass); 0 unix-socket / pre-opened-transport uses (residual, out of scope — any new one is RED)`);
  }

  // ── codex r2 P1-1c: no REAL credential in a test process — emulator-run scrubs every secret key name ──
  {
    const SE = require('../tools/secret-env');
    const keys = SE.secretKeys();
    assert.ok(['ULTRAMSG_TOKEN', 'ULTRAMSG_INSTANCE_ID', 'PIXELPAY_SECRET', 'PIXELPAY_GW_ACCESS_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'VAPID_PRIVATE_KEY'].every((k) => keys.includes(k)), FAIL('the secret key set misses a reviewed key'));
    const { childEnv } = require('../tools/emulator-run');
    const fakeParent = { ...process.env, ULTRAMSG_TOKEN: 'r3-fake', PIXELPAY_SECRET: 'r3-fake', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/r3-fake.json' };
    const ce = childEnv(['database'], fakeParent);
    assert.deepStrictEqual(SE.present(ce), [], FAIL(`emulator-run's suite env still holds secret key(s): ${SE.present(ce).join(', ')}`));
    assert.deepStrictEqual(SE.present(process.env), [], FAIL(`this test process holds secret key(s): ${SE.present(process.env).join(', ')}`));
    const contract = fs.readdirSync(__dirname).filter((f) => /\.emulator\.test\.(c?js|mjs)$/.test(f));
    const missing = contract.filter((f) => !/require\('\.\/_no-secrets'\)/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
    assert.deepStrictEqual(missing, [], FAIL(`R3 runners that do not assert the absence of real credentials: ${missing.join(', ')}`));
    ok(`no real credential: ${keys.length} secret key names (reviewed ∪ .env NAMES) — emulator-run's suite env drops them (fake parent values removed), this process holds none, all ${contract.length} R3 emulator runners assert it before setting any fake`);
  }

  // wiring: emulator-run preloads the guard FIRST into every suite step; every R3 contract entry in npm test preloads it
  const er = fs.readFileSync(path.join(__dirname, '..', 'tools', 'emulator-run.js'), 'utf8');
  assert.ok(/const INNER = injectCounter\(rest\[0\], EGRESS, COUNTER, NULL_GUARD\);/.test(er) && /const EGRESS = path\.join\(ROOT, 'tools', 'egress-guard\.js'\);/.test(er), FAIL('emulator-run does not preload tools/egress-guard.js first'));
  const wr = fs.readFileSync(path.join(__dirname, '..', 'tools', 'emu-cmd-wrapper.js'), 'utf8');
  assert.ok(/spawn\(process\.execPath, argv\.slice\(1\), \{ stdio: 'inherit', env: stepEnv\(\) \}\)/.test(wr) && /env\.NODE_OPTIONS = `\$\{env\.NODE_OPTIONS \? env\.NODE_OPTIONS \+ ' ' : ''\}\$\{req\}`/.test(wr), FAIL('the suite-command wrapper does not hand the guard to step DESCENDANTS via NODE_OPTIONS'));
  // and it is effective: a grandchild spawned with the wrapper's step env is guarded
  { const env = { ...process.env, NODE_OPTIONS: `--require ${path.join(__dirname, '..', 'tools', 'egress-guard.js')}` };
    const r = require('child_process').spawnSync(process.execPath, ['-e', "const q=require('http').request('http://192.0.2.1/x');q.on('error',e=>{console.log(e.code)});q.end();setTimeout(()=>{},200)"], { env, encoding: 'utf8', timeout: 8000 });
    assert.strictEqual((r.stdout || '').trim(), 'ERR_R3_EGRESS_REFUSED', FAIL(`a guarded grandchild was not refused (${r.stdout} ${r.stderr})`)); }
  const { injectCounter } = require('../tools/emulator-run');
  const inj = injectCounter('node a.js && node --experimental-vm-modules b.mjs', '/x/tools/egress-guard.js', '/x/tools/count-marks.js');
  assert.ok((inj.match(/-r \/x\/tools\/egress-guard\.js -r \/x\/tools\/count-marks\.js/g) || []).length === 2, FAIL(`chained injection: ${inj}`));
  const steps = require('../package.json').scripts.test.split('&&').map((x) => x.trim()).filter((x) => /\scontract\//.test(x));
  const bare = steps.filter((x) => !/-r \.\/tools\/egress-guard\.js /.test(x));
  assert.deepStrictEqual(bare, [], FAIL(`R3 contract entries in npm test without the egress preload:\n  ${bare.join('\n  ')}`));
  ok(`wiring: emulator-run injects the guard ahead of the counter into EVERY chained node step, the wrapper hands it to every step's DESCENDANTS (a grandchild is refused); all ${steps.length} R3 contract entries in npm test preload it`);
  const al = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'egress-allowlist.json'), 'utf8')).entries;
  for (const a of al) assert.ok(a.suite && a.host && a.reason && a.owner, FAIL(`allowlist entry incomplete: ${JSON.stringify(a)}`));
  ok(`allowlist: ${al.length} reviewed entr${al.length === 1 ? 'y' : 'ies'} (each names suite, host, reason, owner)`);
  console.log(`\nr3-egress guard: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-egress guard FAILED:', e && e.stack || e); process.exit(1); });
