'use strict';
/* R3 §2b — THE CONTROLLED SCHEDULER (no Functions emulator). Owns every RTDB write in the process and every trigger
 * invocation the suite runs. PLAN-R3 rev 4.1 §2b.1–§2b.7, §6a. Install BEFORE require('../index.js') (§6a order).
 *
 *  WRITE GATE (§2b.1). Every Admin-SDK Reference write — set / update / remove / push(value) / transaction /
 *    setWithPriority / setPriority — passes one serialized gate: read the BEFORE snapshot of every trigger instance the
 *    write can affect, commit, read the AFTER snapshot, append ONE transition record (a multipath update is one
 *    transition), enqueue the matching invocations. Writes are serialized, so before/after are exact. The staff pages'
 *    RTDB adapter is Admin underneath, so its writes pass here too.
 *  MATCHING (§2b.2). Pattern T (e.g. orders/{orderId}/status). Written path P deeper than T → the instance is P cut
 *    to T's depth; P at or above T → every concrete path under P matching T in before ∪ after. `written` fires when
 *    before ≠ after; `created` when before is absent and after present.
 *  EVENTS (§2b.3). written → { data: { before, after } (Admin DataSnapshots), params }; created → { data: snapshot, params }.
 *  RECORDS (§2b.4). Every match is recorded { export, kind, path, params, transition } — whether or not it is RUN.
 *    Which exports actually RUN is declared by the suite (`run`); the rest are recorded only (P1 runs them all).
 *  SLEEPS (§2b.5). Only the AST-identified application sleep call sites are virtual, confirmed PER CALL by stack frame
 *    (issued by sleep()'s body, called from an authorized line, inside an invocation). Everything else is real.
 *  QUIESCENCE (§2b.5). Every invocation completed or parked on an authorized virtual sleep; the gate idle; nothing
 *    queued. advance(ms) walks the virtual timeline in due order, draining between due times. It moves NO clock (§6a).
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { AsyncLocalStorage } = require('async_hooks');

const FN = path.join(__dirname, '..');
const INDEX = path.join(FN, 'index.js');
const ALS = new AsyncLocalStorage();

// ── §2b.5 authorized sleep sites (AST) ─────────────────────────────────────────────────────────────────────────────
function sleepSites(file = INDEX) {
  const ast = acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true, allowReturnOutsideFunction: true });
  let def = null; const calls = [];
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'sleep') def = n.loc.start.line;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'sleep') calls.push({ line: n.loc.start.line, arg: n.arguments[0] && (n.arguments[0].name || n.arguments[0].raw) });
    for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v); }
  })(ast);
  return { def, calls };
}
// the reviewed set (PLAN §2b.5): a change here is a review, and createScheduler refuses a source that disagrees
const REVIEWED_SLEEPS = ['ACCEPT_TIMEOUT_MS', 'GRACE_PERIOD_MS'];

const frameIndexLine = (f) => { const m = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(String(f).trim()); return m && m[1] === INDEX ? Number(m[2]) : null; };

// ── path helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
const segsOf = (p) => String(p).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
const isWild = (s) => /^\{[^}]+\}$/.test(s);
function bindPrefix(pSegs, tSegs) {   // P (len ≥ |T|) cut to |T| matched against T → params | null
  const params = {};
  for (let i = 0; i < tSegs.length; i += 1) {
    if (isWild(tSegs[i])) params[tSegs[i].slice(1, -1)] = pSegs[i];
    else if (tSegs[i] !== pSegs[i]) return null;
  }
  return params;
}
// every concrete path under `base` (segments) matching the remaining pattern, in a value tree
function expandUnder(baseSegs, tSegs, ...trees) {
  const out = new Map();
  const rest = tSegs.slice(baseSegs.length);
  for (const tree of trees) {
    (function rec(node, i, acc) {
      if (i === rest.length) { out.set(acc.join('/'), true); return; }
      if (!node || typeof node !== 'object') return;
      if (isWild(rest[i])) { for (const k of Object.keys(node)) rec(node[k], i + 1, [...acc, k]); }
      else if (Object.prototype.hasOwnProperty.call(node, rest[i])) rec(node[rest[i]], i + 1, [...acc, rest[i]]);
    })(tree, 0, baseSegs.slice());
  }
  return [...out.keys()];
}

function createScheduler({ admin, triggers, run = new Set(), log = () => {} }) {
  const db = admin.database();
  const sites = sleepSites();
  if (!sites.def) throw new Error('scheduler: function sleep() not found in index.js — §2b.5 premise');
  const found = sites.calls.map((c) => c.arg).sort();
  if (JSON.stringify(found) !== JSON.stringify(REVIEWED_SLEEPS)) throw new Error(`scheduler: index.js sleep() call sites ${JSON.stringify(sites.calls)} ≠ the reviewed set ${JSON.stringify(REVIEWED_SLEEPS)} — review before virtualizing (§2b.5)`);
  const AUTH = new Map(sites.calls.map((c) => [c.line, c.arg]));

  const state = {
    vnow: 0, vseq: 0, timers: [], invs: [], transitions: [], records: [], queued: 0, gateBusy: 0,
    virtualCreated: 0, inContextRealLong: [], detachedWrites: [], armed: true,
  };

  // ── timers ──
  const realSetTimeout = global.setTimeout; const realClearTimeout = global.clearTimeout;
  function authorizedSite(stack) {
    const frames = String(stack).split('\n').slice(2).map(frameIndexLine);
    if (frames[0] !== sites.def) return null;                          // issued BY sleep()'s body
    const caller = frames.slice(1).find((l) => l !== null && l !== sites.def);
    return AUTH.has(caller) ? caller : null;                           // called from a reviewed line
  }
  function setTimeoutGate(fn, ms, ...args) {
    const store = ALS.getStore();
    const inv = store && store.inv;
    if (inv && !inv.done) {
      const site = authorizedSite(new Error().stack);
      if (site) {
        const t = { id: ++state.vseq, due: state.vnow + Number(ms || 0), fn, args, site, inv, virtual: true, ref() { return t; }, unref() { return t; }, hasRef: () => true };
        state.timers.push(t); inv.parked = t; inv.virtualCreated += 1; state.virtualCreated += 1;
        log(`park ${inv.name} @${t.due} (site :${site})`);
        return t;
      }
      if (Number(ms) >= 5000) state.inContextRealLong.push({ inv: inv.name, ms: Number(ms), top: String(new Error().stack).split('\n').slice(2, 4).map((x) => x.trim()).join(' | ') });
    }
    return realSetTimeout.call(this, fn, ms, ...args);
  }
  function clearTimeoutGate(t) {
    if (t && t.virtual) { const i = state.timers.indexOf(t); if (i >= 0) state.timers.splice(i, 1); if (t.inv.parked === t) t.inv.parked = null; return undefined; }
    return realClearTimeout(t);
  }

  // ── invocations ──
  function invoke(name, event, { fn, origin = 'explicit', transition = null } = {}) {
    const inv = { name, origin, transition, done: false, parked: null, error: null, virtualCreated: 0, result: undefined };
    state.invs.push(inv);
    const body = fn || (() => { const f = require(INDEX)[name]; if (!f || typeof f.run !== 'function') throw new Error(`scheduler: export ${name} has no .run`); return f.run(event); });
    inv.promise = ALS.run({ inv }, () => Promise.resolve().then(body))
      .then((v) => { inv.result = v; inv.done = true; inv.parked = null; }, (e) => { inv.error = e; inv.done = true; inv.parked = null; log(`ERROR ${name}: ${e && e.message}`); });
    return inv;
  }
  const active = () => state.invs.filter((i) => !i.done && !i.parked);
  async function drain(label = 'drain', capMs = 20000) {
    const t0 = Date.now();
    let quiet = 0;
    for (;;) {
      const busy = active().length || state.gateBusy || state.queued;
      if (!busy) { quiet += 1; if (quiet >= 3) return; } else quiet = 0;
      if (Date.now() - t0 > capMs) throw new Error(`🔴 R3-SCHED drain(${label}): not quiescent after ${capMs} ms — active: ${active().map((i) => i.name).join(', ') || '-'}; gate busy ${state.gateBusy}; queued ${state.queued}`);
      await new Promise((r) => realSetTimeout(r, 10));
    }
  }
  async function advance(ms, label = 'advance') {
    const target = state.vnow + ms;
    await drain(`${label} (before)`);
    for (;;) {
      state.timers.sort((a, b) => a.due - b.due || a.id - b.id);
      const t = state.timers[0];
      if (!t || t.due > target) break;
      state.timers.shift(); state.vnow = t.due; t.inv.parked = null;
      log(`wake ${t.inv.name} @${t.due}`);
      t.fn(...t.args);
      await drain(`${label} @${state.vnow}`);
    }
    state.vnow = target;
  }

  // ── §2b.1 the write gate ──
  let chain = Promise.resolve();
  const serialize = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const refPath = (ref) => { const u = new URL(ref.toString()); return decodeURIComponent(u.pathname).replace(/^\/+/, ''); };
  async function readTree(p) { return (await db.ref(p || '/').get()).val(); }
  // the trigger instances a write at these paths can affect → [{ trig, path, params }]
  async function affected(paths) {
    const out = new Map();
    for (const p of paths) {
      const pSegs = segsOf(p);
      for (const trig of triggers) {
        const tSegs = trig.segs;
        if (pSegs.length >= tSegs.length) {
          const params = bindPrefix(pSegs, tSegs);
          if (params) out.set(`${trig.name}|${pSegs.slice(0, tSegs.length).join('/')}`, { trig, path: pSegs.slice(0, tSegs.length).join('/'), params });
        } else if (pSegs.every((s, i) => isWild(tSegs[i]) || tSegs[i] === s)) {
          // P is at/above T: expand concretely (before tree read here; after tree read post-commit)
          out.set(`${trig.name}|@${pSegs.join('/')}`, { trig, above: pSegs });
        }
      }
    }
    return [...out.values()];
  }
  async function gated(kind, ref, paths, commit) {
    const store = ALS.getStore();
    const inv = store && store.inv;
    if (store && store.fixture) return commit();                       // a declared fixture write: not a scenario transition
    if (!state.armed) return commit();
    if (inv && inv.done) state.detachedWrites.push({ inv: inv.name, kind, paths });
    state.gateBusy += 1;
    try {
      return await serialize(async () => {
        const aff = await affected(paths);
        // BEFORE
        const instances = new Map();
        for (const a of aff) {
          if (a.path) { instances.set(`${a.trig.name}|${a.path}`, { trig: a.trig, path: a.path, params: a.params }); continue; }
          const tree = await readTree(a.above.join('/'));
          for (const p of expandUnder(a.above, a.trig.segs, tree)) instances.set(`${a.trig.name}|${p}`, { trig: a.trig, path: p, params: bindPrefix(segsOf(p), a.trig.segs), aboveBase: a.above });
        }
        const before = new Map();
        for (const [k, x] of instances) before.set(k, await db.ref(x.path).get());
        const result = await commit();
        // AFTER (+ instances that only exist after a write at/above the pattern)
        for (const a of aff.filter((y) => !y.path)) {
          const tree = await readTree(a.above.join('/'));
          for (const p of expandUnder(a.above, a.trig.segs, tree)) {
            const k = `${a.trig.name}|${p}`;
            if (!instances.has(k)) { instances.set(k, { trig: a.trig, path: p, params: bindPrefix(segsOf(p), a.trig.segs) }); before.set(k, null); }
          }
        }
        const tid = state.transitions.length;
        const tr = { id: tid, kind, ref: refPath(ref), paths: paths.slice(), by: inv ? inv.name : (store && store.writer) || 'test', fires: [] };
        state.transitions.push(tr);
        for (const [k, x] of instances) {
          const b = before.get(k);
          const a = await db.ref(x.path).get();
          const bv = b ? b.val() : null; const av = a.val();
          const changed = JSON.stringify(bv) !== JSON.stringify(av);
          const fires = x.trig.kind === 'created' ? (bv === null && av !== null) : (x.trig.kind === 'written' ? changed : false);
          if (!fires) continue;
          const rec = { export: x.trig.name, kind: x.trig.kind, path: x.path, params: x.params, transition: tid, run: run.has(x.trig.name) };
          state.records.push(rec); tr.fires.push(rec);
          if (rec.run) {
            const event = x.trig.kind === 'created' ? { data: a, params: x.params } : { data: { before: b || (await snapshotNull(x.path)), after: a }, params: x.params };
            state.queued += 1;
            // queued, then started on the next tick OUTSIDE the writer's context (a trigger runs in its own invocation)
            ALS.exit(() => setImmediate(() => { state.queued -= 1; invoke(x.trig.name, event, { origin: 'fanout', transition: tid }); }));
          }
        }
        return result;
      });
    } finally { state.gateBusy -= 1; }
  }
  // a "before" for an instance that only came into existence through a write AT/ABOVE its pattern (so it could not be read
  // before the commit): it WAS absent. Its snapshot is read from a never-written mirror path ending in the SAME key, so
  // .val() === null, .exists() === false and .key is the instance's own key.
  async function snapshotNull(p) { return db.ref(`__r3_absent__/${p}`).get(); }

  function installGate() {
    const proto = Object.getPrototypeOf(db.ref('x'));
    const orig = {};
    for (const m of ['set', 'update', 'remove', 'transaction', 'setWithPriority', 'setPriority', 'push']) orig[m] = proto[m];
    proto.set = function (v, cb) { return gated('set', this, [refPath(this)], () => orig.set.call(this, v, cb)); };
    proto.setWithPriority = function (v, pr, cb) { return gated('set', this, [refPath(this)], () => orig.setWithPriority.call(this, v, pr, cb)); };
    proto.setPriority = function (pr, cb) { return gated('setPriority', this, [refPath(this)], () => orig.setPriority.call(this, pr, cb)); };
    proto.remove = function (cb) { return gated('remove', this, [refPath(this)], () => orig.remove.call(this, cb)); };
    proto.update = function (v, cb) {
      const base = refPath(this);
      const paths = v && typeof v === 'object' ? Object.keys(v).map((k) => [base, k].filter(Boolean).join('/')) : [base];
      return gated('update', this, paths, () => orig.update.call(this, v, cb));
    };
    proto.transaction = function (fn, cb, local) { return gated('transaction', this, [refPath(this)], () => orig.transaction.call(this, fn, cb, local)); };
    proto.push = function (v, cb) {
      if (v === undefined) return orig.push.call(this, v, cb);           // key only, no write
      const child = orig.push.call(this);                                 // the key, generated as the SDK does
      const done = proto.set.call(child, v).then(() => this.child(child.key));   // a FRESH non-thenable Reference
      if (cb) done.then(() => cb(null), (e) => cb(e));
      child.then = (a, b) => done.then(a, b); child.catch = (b) => done.catch(b);
      return child;
    };
    return () => Object.assign(proto, orig);
  }

  let uninstall = null;
  function install() {
    global.setTimeout = setTimeoutGate; global.clearTimeout = clearTimeoutGate;
    const ungate = installGate();
    uninstall = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; ungate(); };
    return api;
  }
  // a declared FIXTURE write block (drivers, config): not a scenario transition, no fan-out
  const fixture = (fn) => ALS.run({ fixture: true }, fn);
  // a WRITER call (an HTTP handler driven by the suite): its writes are attributed to `label`
  const writer = (label, fn, extra = {}) => { const store = { writer: label, ...extra }; return ALS.run(store, fn).then((r) => ({ r, store })); };

  // end-of-scenario hygiene: invocation errors and undeclared parked sleepers FAIL
  function assertClean(declaredParked = []) {
    const errs = state.invs.filter((i) => i.error).map((i) => `${i.name}: ${i.error && i.error.message}`);
    if (errs.length) throw new Error(`🔴 R3-SCHED invocation error(s):\n  ${errs.join('\n  ')}`);
    const parked = state.invs.filter((i) => i.parked).map((i) => `${i.name}@${i.parked.due}`);
    const extra = parked.filter((p) => !declaredParked.some((d) => p.startsWith(`${d}@`) || p === d));
    if (extra.length) throw new Error(`🔴 R3-SCHED undeclared parked sleeper(s): ${extra.join(', ')} (declared: ${JSON.stringify(declaredParked)})`);
  }

  const api = { install, uninstall: () => uninstall && uninstall(), invoke, drain, advance, fixture, writer, assertClean, state, sites, ALS,
    get vnow() { return state.vnow; }, setArmed(v) { state.armed = !!v; } };
  return api;
}

module.exports = { createScheduler, sleepSites, ALS, REVIEWED_SLEEPS, expandUnder, bindPrefix, segsOf };
