'use strict';
/* 1D D4-c2b — ONE monitor run in a FRESH process (the deployed function's footprint): node test/_c2b-monitor-child.js '<json>'
   input {rids, slow?: {rid, ms}} → prints one JSON line {results, lines, reads, pacing, ms, summaryAt, peakRss}. Test-only. */
require('./_emulator-required')('database', 'firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const origLog = console.log; console.log = () => {}; console.warn = () => {};
require('../index.js');
const admin = require('firebase-admin');
const { createIdentityIntegrityMonitor } = require('../catalog/identity-integrity-monitor');
const input = JSON.parse(process.argv[2]);
const base = process.memoryUsage();   // after index.js + firebase-admin loaded: the function's own baseline
let peak = base.rss; let peakAt = null;
const sampler = setInterval(() => { const m = process.memoryUsage(); if (m.rss > peak) { peak = m.rss; peakAt = m; } }, 25);
// a db whose transactional reads for ONE restaurant are slowed (each get / getAll / query) — a slow merchant, below the monitor
function slowDb(base, rid, ms) {
  const pathOf = (x) => String((x && (x.path || (x._queryOptions && x._queryOptions.parentPath && x._queryOptions.parentPath.relativeName)
    || (x._query && x._query._queryOptions.parentPath.relativeName))) || '');
  const hit = (args) => args.some((a) => pathOf(a).startsWith(`restaurants/${rid}/`) || pathOf(a) === `restaurants/${rid}`);
  const wrapTx = (tx) => new Proxy(tx, { get(t, k) {
    const v = Reflect.get(t, k, t);
    if ((k === 'get' || k === 'getAll') && typeof v === 'function') return async (...a) => { if (hit(a)) await new Promise((r) => setTimeout(r, ms)); return v.apply(t, a); };
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  return new Proxy(base, { get(t, k) {
    const v = Reflect.get(t, k, t);
    if (k === 'runTransaction') return (fn, opts) => v.call(t, (tx) => fn(wrapTx(tx)), opts);
    return typeof v === 'function' ? v.bind(t) : v;
  } });
}
(async () => {
  const db = input.slow ? slowDb(admin.firestore(), input.slow.rid, input.slow.ms) : admin.firestore();
  const logged = []; const start = Date.now();
  const now = () => Date.now() + (input.nowOffsetMs || 0);   // the scheduled time of THIS run (runs are 15 min apart)
  const r = await createIdentityIntegrityMonitor({ db, rtdb: admin.database(), now, log: (k, d) => logged.push([Date.now(), k, d]) }).run({ listIds: async () => input.rids, quietMs: 0 });
  const first = logged.find(([, k]) => k === 'identity_integrity_state');
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const checks = logged.filter(([, k]) => k === 'identity_integrity_check').map(([, , d]) => d);
  origLog(JSON.stringify({ results: r.results, lines: r.lines, reads: r.reads, pacing: r.pacing, ms: Date.now() - start, summaryAt: first ? first[0] - start : null,
    heartbeat: logged.some(([, k]) => k === 'identity_integrity_heartbeat'), checks, peakRss: peak, baseRss: base.rss,
    atPeak: peakAt && { heapUsed: peakAt.heapUsed, heapTotal: peakAt.heapTotal, external: peakAt.external, arrayBuffers: peakAt.arrayBuffers } }));
  process.exit(0);
})().catch((e) => { clearInterval(sampler); origLog(JSON.stringify({ error: String(e && e.stack || e) })); process.exit(1); });
