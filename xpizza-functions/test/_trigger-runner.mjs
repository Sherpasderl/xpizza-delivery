// TRACKER FIXES (BUILD-tracker-fixes r1.1 §3.1) — test-only TRIGGER RUNNER for the REAL exported v2 database triggers of index.js.
//
// What it guarantees (and what it does not):
//   - PER-WRITE capture (codex build r1 P1-3): EVERY acknowledged write — Admin set/update/remove/push/transaction (patched
//     Reference) and client SDK writes (_web-sdk-loader hooks) — is serialized by a lock and bracketed by a PRE- and POST-image of
//     every watched trigger path instance; the events of THAT write are queued as soon as it is acknowledged. So A→B then B→C
//     inside ONE step yields two events, and a committed write followed by a throw keeps its event. A step only labels and
//     bounds writes; an image taken at the step's end must equal the image after its last captured write (anything else is an
//     UNCAPTURED write → the step fails). Overlapping steps THROW, and an Admin write outside any step THROWS at quiescence.
//     Writes issued concurrently by one handler are serialized by the lock (order preserved per call; timing is not modelled).
//   - Events = instances whose value changed (deep) — `written` triggers get {before, after}; `created` triggers only when
//     before is null. Parent multi-path updates and deletions are matched per instance (a deleted node → after null).
//   - Delivery: `.run(event)` on the REAL export, in a deterministic order (FIFO by step, then trigger name). A handler's own
//     writes are captured as a step, so the events they cause are queued too (to quiescence). A handler that THROWS is
//     re-delivered ONLY if its export metadata says retry:true (`__endpoint.eventTrigger.retry`), up to `maxRetries`.
//   - Long-sleeping handlers (e.g. monitorAssignmentTimeout's real 60 s sleep) can be marked `background`: started, not awaited
//     per step; `quiesce()` awaits them and any writes they make are attributed to their own step.
//   - It does NOT model production's concurrency between independent triggers (they run sequentially here; adversarial
//     interleavings are driven explicitly by later milestones' hold points), coalescing of very fast same-leaf writes, or latency.
import { isDeepStrictEqual } from 'node:util';

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const snap = (v) => ({ val: () => clone(v), exists: () => v !== null && v !== undefined });

export function listDatabaseTriggers(app) {
  const out = [];
  for (const [name, fn] of Object.entries(app)) {
    const et = fn && fn.__endpoint && fn.__endpoint.eventTrigger;
    if (!et || !/database/.test(et.eventType || '')) continue;
    const pattern = et.eventFilterPathPatterns && et.eventFilterPathPatterns.ref;
    if (!pattern) continue;
    const kind = /\.created$/.test(et.eventType) ? 'created' : /\.written$/.test(et.eventType) ? 'written' : 'other';
    out.push({ name, fn, pattern: pattern.replace(/^\//, ''), kind, retry: et.retry === true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function makeTriggerRunner({ app, db, entities, background = [], maxRetries = 3, only = null, log = () => {} }) {
  const triggers = listDatabaseTriggers(app).filter((t) => !only || only.includes(t.name));
  const queue = [];
  const failures = [];
  const delivered = [];
  const pending = new Set();
  let inStep = false, stepWrites = 0, unattributed = [];

  // ── Admin write instrumentation (server writers): every Admin set/update/remove/push/transaction must happen inside a step
  const proto = Object.getPrototypeOf(db.ref());
  if (!proto.__trPatched) {
    for (const m of ['set', 'update', 'remove', 'transaction', 'setWithPriority']) {
      const orig = proto[m]; if (typeof orig !== 'function') continue;
      proto[m] = function (...a) {
        const R = proto.__trRunner;
        if (!R) return orig.apply(this, a);
        R.onAdminWrite(m, this.toString());
        return R.capture(`${m} ${this.toString().replace(/^https?:\/\/[^/]+\/?/, '').split('?')[0]}`, () => orig.apply(this, a));
      };
    }
    // push(value): the key is generated client-side; the WRITE is the child's set(value) — routed through the captured set above,
    // and the returned child reference stays thenable like the SDK's ThenableReference
    const origPush = proto.push;
    proto.push = function (...a) {
      const R = proto.__trRunner;
      if (!R || a.length === 0 || a[0] === undefined) return origPush.apply(this, a);
      const child = origPush.call(this);
      const p = child.set(a[0]);
      child.then = p.then.bind(p); child.catch = p.catch.bind(p);
      return child;
    };
    proto.__trPatched = true;
  }
  let lock = Promise.resolve();
  let curLabel = null, lastImage = null;
  const acquire = () => { let release; const gate = new Promise((r) => { release = r; }); const prev = lock; lock = prev.then(() => gate); return prev.then(() => release); };
  const record = (label, pre, post) => { const ev = eventsBetween(pre, post); queue.push(...ev.map((e) => ({ ...e, from: label }))); lastImage = post; return ev.length; };
  const self = {
    onAdminWrite(m, p) { if (inStep) stepWrites += 1; else unattributed.push(`${m} ${p}`); },
    onClientWrite() { if (!inStep) throw new Error('_trigger-runner: a client write outside step()'); stepWrites += 1; },
    // one acknowledged write, bracketed: its events are queued even if it (or later work) throws
    async capture(what, run) {
      const release = await acquire();
      const label = curLabel || `(outside step) ${what}`;
      try {
        const pre = await image();
        let res, err = null;
        try { res = await run(); } catch (e) { err = e; }
        record(label, pre, await image());
        if (err) throw err;
        return res;
      } finally { release(); }
    },
  };
  proto.__trRunner = self;

  // concrete path instances of every trigger pattern for the scenario's entities
  const params = { orderId: entities.orders || [], taskId: entities.tasks || [], uid: entities.drivers || [], rid: entities.rids || [] };
  async function instancesOf(t) {
    const names = [...t.pattern.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    let combos = [{}];
    for (const nm of names) {
      const next = [];
      for (const c of combos) {
        let vals = params[nm];
        if (!vals || !vals.length) {   // a wildcard not in the entity set (e.g. eventId): enumerate the parent's children
          const parent = t.pattern.split(`{${nm}}`)[0].replace(/\{(\w+)\}/g, (_m, k) => c[k]).replace(/\/$/, '');
          vals = Object.keys((await db.ref(parent).once('value')).val() || {});
        }
        for (const v of vals) next.push({ ...c, [nm]: v });
      }
      combos = next;
    }
    return combos.map((c) => ({ params: c, path: t.pattern.replace(/\{(\w+)\}/g, (_m, k) => c[k]) }));
  }
  // the runner's OWN reads (pre/post images) are marked so a measuring harness can exclude them (globalThis.__trImaging > 0)
  async function image() {
    globalThis.__trImaging = (globalThis.__trImaging || 0) + 1;
    try {
      const m = new Map();
      for (const t of triggers) for (const ins of await instancesOf(t)) {
        if (!m.has(ins.path)) m.set(ins.path, clone((await db.ref(ins.path).once('value')).val()));
      }
      return m;
    } finally { globalThis.__trImaging -= 1; }
  }
  function eventsBetween(pre, post) {
    const ev = [];
    for (const t of triggers) {
      const re = new RegExp('^' + t.pattern.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '$');
      const paths = new Set([...pre.keys(), ...post.keys()]);
      for (const p of [...paths].sort()) {
        const m = p.match(re); if (!m) continue;
        const before = pre.has(p) ? pre.get(p) : null, after = post.has(p) ? post.get(p) : null;
        if (isDeepStrictEqual(before, after)) continue;
        if (t.kind === 'created' && before !== null) continue;
        ev.push({ trigger: t, params: { ...m.groups }, before, after, path: p });
      }
    }
    return ev;
  }

  async function step(label, fn) {
    if (inStep) throw new Error(`_trigger-runner: nested/overlapping step (${label}) — writes must be serialized`);
    { const release = await acquire(); try { lastImage = await image(); } finally { release(); } }
    inStep = true; stepWrites = 0; const prevLabel = curLabel; curLabel = label;
    const before = queue.length;
    let res, err = null;
    try { res = await fn(); } catch (e) { err = e; } finally { inStep = false; curLabel = prevLabel; }
    // safety net: after the last captured write, nothing else may have changed a watched path
    { const release = await acquire(); try {
      const post = await image();
      const unexplained = eventsBetween(lastImage, post);
      if (unexplained.length) throw new Error(`_trigger-runner: UNCAPTURED write(s) in step ${label}: ${unexplained.map((e) => e.path).join(', ')}`);
    } finally { release(); } }
    log(`step ${label}: ${stepWrites} write(s), ${queue.length - before} event(s)`);
    if (err) throw err;
    return res;
  }

  async function runOne(e, attempt = 1) {
    const event = e.trigger.kind === 'created'
      ? { data: snap(e.after), params: e.params }
      : { data: { before: snap(e.before), after: snap(e.after) }, params: e.params };
    const label = `${e.trigger.name}(${e.path})${attempt > 1 ? `#${attempt}` : ''}`;
    if (background.includes(e.trigger.name)) {
      const p = (async () => {
        try { await e.trigger.fn.run(event); } catch (err) { failures.push({ label, error: String(err && err.message) }); }
      })();
      pending.add(p); p.finally(() => pending.delete(p));
      delivered.push(label + ' [background]');
      return;
    }
    try {
      await step(label, () => e.trigger.fn.run(event));
      delivered.push(label);
    } catch (err) {
      if (e.trigger.retry && attempt <= maxRetries) return runOne(e, attempt + 1);
      failures.push({ label, error: String(err && err.message), retried: e.trigger.retry });
    }
  }

  async function deliverAll({ filter = null, drop = null } = {}) {
    while (queue.length) {
      const e = queue.shift();
      if (drop && drop(e)) { delivered.push(`DROPPED ${e.trigger.name}(${e.path})`); continue; }
      if (filter && !filter(e)) continue;
      await runOne(e);
    }
  }
  // quiesce({ awaitBackground }) — deliver every queued event to quiescence. Background handlers (real sleeps) are awaited only
  // when asked (e.g. at the end of a journey): awaiting them at every capture would let a real-time timer (the 60 s accept
  // monitor) fire before the scenario's next step, changing the journey itself.
  async function quiesce({ awaitBackground = true } = {}) {
    await deliverAll();
    while (awaitBackground && pending.size) { await Promise.all([...pending]); await deliverAll(); }
    if (unattributed.length) throw new Error(`_trigger-runner: unattributed Admin write(s) outside any step: ${unattributed.join(', ')}`);
  }
  // hooks for _web-sdk-loader: client writes must happen inside a step (they are counted toward the step)
  // client SDK writes (via _web-sdk-loader): beforeWrite takes the lock + PRE-image; afterWrite (or onWriteError, for a write that
  // failed — e.g. denied by the rules) takes the POST-image, queues that write's events and RELEASES the lock
  let clientPending = null;
  const clientHooks = {
    beforeWrite: async (o) => {
      self.onClientWrite();
      const release = await acquire();
      try { clientPending = { release, pre: await image(), what: o ? `${o.kind} ${o.path}` : 'client write' }; } catch (e) { release(); throw e; }
    },
    afterWrite: async () => { const c = clientPending; clientPending = null; if (!c) return; try { record(curLabel || c.what, c.pre, await image()); } finally { c.release(); } },
    onWriteError: async () => { const c = clientPending; clientPending = null; if (!c) return; try { record(curLabel || c.what, c.pre, await image()); } finally { c.release(); } },
  };
  function close() { if (proto.__trRunner === self) proto.__trRunner = null; }
  return { step, deliverAll, quiesce, queue, failures, delivered, triggers, clientHooks, close };
}
