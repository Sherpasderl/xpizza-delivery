'use strict';
// TEST-OWNED preload (codex photos-config r2): an OFFLINE client/read SENTINEL for spawned owner CLIs. firebase-admin's client constructors
// (firestore / storage / database) are replaced by stubs that RECORD the attempt and THROW before any network — so a CLI that reaches a
// client is caught by the test's own named assertion, not later by the egress guard. initializeApp is allowed (it opens nothing).
// The attempts are written to $TB_SENTINEL_OUT at exit.
const fs = require('fs');
const hits = [];
// the namespace's properties are getter-only, so the cached module's EXPORTS are swapped for a Proxy (the CLI's require hits the cache)
const resolved = require.resolve('firebase-admin', { paths: [require('path').join(__dirname, '..')] });
const real = require(resolved);
const STUBBED = new Set(['firestore', 'storage', 'database']);
const proxy = new Proxy(real, { get(t, k, r) {
  if (STUBBED.has(k)) return () => { hits.push(k); throw Object.assign(new Error(`TB_SENTINEL: the CLI reached admin.${String(k)}()`), { code: 'tb_sentinel' }); };
  return Reflect.get(t, k, r);
} });
require.cache[resolved].exports = proxy;
process.on('exit', () => { if (process.env.TB_SENTINEL_OUT) fs.writeFileSync(process.env.TB_SENTINEL_OUT, JSON.stringify(hits)); });
