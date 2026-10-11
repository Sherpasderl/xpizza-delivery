'use strict';
/* R1b — TEST SERVERS BIND 127.0.0.1 EXPLICITLY, never the wildcard.
 *
 * 🔴 ROOT CAUSE of order-exists' 409 → 200 (measured, not assumed). A suite's per-request server did `listen(0)` — the
 * dual-stack WILDCARD [::]:P — then fetched http://127.0.0.1:P. On macOS (libuv always sets SO_REUSEADDR) ANOTHER
 * process may bind the more specific 127.0.0.1:P at the same time, and the kernel then routes the suite's request to
 * THAT process: a 200 came back for a case whose handler never ran (no handler log line at all for that request). A
 * server bound to 127.0.0.1 explicitly owns the port exclusively — a second 127.0.0.1 bind gets EADDRINUSE.
 * Same class as the AirPlay *:5000 finding (a specific bind beside a wildcard one).
 *
 * 1. the premise, driven on this machine (two real processes); 2. every test-side ephemeral server names 127.0.0.1.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const REPO = path.join(__dirname, '..', '..');

const shadowProbe = (listenArgs) => new Promise((resolve, reject) => {
  const a = http.createServer((q, r) => r.end('A')).listen(...listenArgs, () => {
    const P = a.address().port;
    const b = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end('B')).listen(${P},'127.0.0.1',()=>console.log('B-LISTENING')).on('error',(e)=>{console.log('B-REFUSED '+e.code);process.exit(0)})`], { stdio: ['ignore', 'pipe', 'ignore'] });
    b.stdout.once('data', async (d) => {
      try {
        const msg = String(d).trim();
        const body = await (await fetch(`http://127.0.0.1:${P}/`)).text();
        b.kill(); a.close(); resolve({ msg, body });
      } catch (e) { b.kill(); a.close(); reject(e); }
    });
  });
});

(async () => {
  // 1. PREMISE — the wildcard server IS shadowed by another process; the explicit 127.0.0.1 server is NOT
  {
    const wild = await shadowProbe([0]);
    assert.deepStrictEqual([wild.msg, wild.body], ['B-LISTENING', 'B'], `premise — on this machine a listen(0) server is shadowed by another process's 127.0.0.1 bind (${JSON.stringify(wild)})`);
    const pinned = await shadowProbe([0, '127.0.0.1']);
    assert.ok(/^B-REFUSED/.test(pinned.msg) && pinned.body === 'A', `🔴 a 127.0.0.1-bound test server was shadowed: ${JSON.stringify(pinned)}`);
    ok('premise, on two real processes: a listen(0) WILDCARD test server is shadowed — another process binds 127.0.0.1 on its port and receives its fetch; a server bound to 127.0.0.1 is exclusive (the second bind is refused) and receives its own fetch');
  }
  // 2. every test-side ephemeral server binds 127.0.0.1 explicitly
  {
    const offenders = []; let checked = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', '.git', '.impeccable'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(c|m)?js$/.test(e.name)) continue;
        const rel = path.relative(REPO, p);
        if (!/(\.test\.|\.measure\.|test\/|\.proof\.)/.test(rel) && !/d4p1-capture/.test(rel)) continue;
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        lines.forEach((l, i) => { if (/\.listen\(\s*0\s*[,)]/.test(l)) { checked += 1; if (!/\.listen\(\s*0\s*,\s*['"]127\.0\.0\.1['"]/.test(l)) offenders.push(`${rel}:${i + 1}`); } });
      }
    };
    walk(REPO);
    assert.ok(checked >= 20, `premise — the test servers were found (${checked})`);
    assert.deepStrictEqual(offenders, [], `🔴 test servers listening on the WILDCARD (shadowable by another process's 127.0.0.1 bind):\n  ${offenders.join('\n  ')}`);
    ok(`all ${checked} test-side ephemeral servers (listen(0, …)) bind 127.0.0.1 explicitly — none can be shadowed`);
  }
  console.log(`\nloopback-listen guard: OK (${n})`);
})().catch((e) => { console.error('LOOPBACK-LISTEN GUARD FAILED:', e && e.stack || e); process.exit(1); });
