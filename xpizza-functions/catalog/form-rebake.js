'use strict';
// PLAN 4 (bake from published) r3 §4 / §5 — REBUILD a form when its brand publishes, and RECONCILE what is DEPLOYED.
//
// FAST PATH — onMirrorWrite(rid): the mirror write that follows a publish POSTs that rid's Netlify build hook. Best-effort
// (a successful publish does not guarantee a mirror write), one POST per cooldown per rid however many events arrive.
// RECOVERY — reconcile(): every 10 min, for every rid in the brand-agnostic registry that has an orders site, compare the
// PUBLISHED menu (in-process, the same buildPublicMenu the endpoint serves) with the bundle the DEPLOYED form actually carries
// (GET its origin, extractBundle) using the live check's own compareBundle. On a difference, and no hook in the last 15 min,
// POST the hook and record {at, attempts}. After 3 attempts without convergence for the SAME published menu: one
// form_rebake_stuck {rid, attempts} alarm, then silence until the published menu changes. One mechanism covers a missing
// mirror event, a failed hook, a hook accepted whose build failed or deployed elsewhere, and duplicate events.
// Off the publish and money paths: it reads public endpoints and the static site, and writes only form_rebake/{rid}.
//
// HOOKS ARE CREDENTIALS (§5): FORM_BUILD_HOOKS = JSON {rid: url} in the functions env. A url must be exactly
// https://api.netlify.com/build_hooks/<24 hex> (no port, credentials, query or fragment); anything else is refused with a
// form_rebake_bad_hook {rid} alarm, a rid with no hook raises form_rebake_missing_hook {rid} — each ONCE per configuration.
// A url is never logged, never alarmed, never stored: errors carry only the rid and a class (hook_rejected / hook_unreachable).
// Unset (rollout steps 1–3, before the owner creates the hooks) the whole mechanism is DORMANT: no reads, no requests, no alarms.
// The POST carries no body and no trigger_branch, so the hook's own configured branch (main) builds.
const crypto = require('crypto');
const { compareBundle } = require('./bundle-compare');   // the live check's own comparator, as a pure library
const { extractBundle } = require('./splice-form-bundle');
const { assetBaseFor } = require('./public-photos');
const { RID_RE } = require('../platform-manifest');

const PATH = 'form_rebake';
const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const HOOK_DEADLINE_MS = 10000;
const READ_DEADLINE_MS = 15000;
const HOOK_HOST = 'api.netlify.com';
const HOOK_PATH_RE = /^\/build_hooks\/[0-9a-f]{24}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sorted = (v) => (isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : Array.isArray(v) ? v.map(sorted) : v);
// The published MENU's identity for "the version changed": a hash of the menu as read (WITHOUT the identity overlay — see
// readPublished in index.js — so it is exactly what a bake would write, and this module names no identity field).
const menuVersion = (menu) => crypto.createHash('sha256').update(JSON.stringify(sorted(menu))).digest('hex').slice(0, 24);

function isHookUrl(url) {
  if (typeof url !== 'string') return false;
  let u; try { u = new URL(url); } catch (_) { return false; }
  return u.protocol === 'https:' && u.hostname === HOOK_HOST && u.port === '' && !u.username && !u.password
    && u.search === '' && u.hash === '' && HOOK_PATH_RE.test(u.pathname) && url === `https://${HOOK_HOST}${u.pathname}`;
}

// PURE. The env value → { configured, hooks: {rid: url}, bad: [rid | '*'], fingerprint }. Never echoes a url.
function parseHooks(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { configured: false, hooks: {}, bad: [], fingerprint: null };
  const fingerprint = crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 16);
  let v; try { v = JSON.parse(String(raw)); } catch (_) { return { configured: true, hooks: {}, bad: ['*'], fingerprint }; }
  if (!isObj(v)) return { configured: true, hooks: {}, bad: ['*'], fingerprint };
  const hooks = {}; const bad = [];
  for (const [rid, url] of Object.entries(v)) {
    if (RID_RE.test(rid) && isHookUrl(url)) hooks[rid] = url; else bad.push(RID_RE.test(rid) ? rid : '*');
  }
  return { configured: true, hooks, bad, fingerprint };
}

const withDeadline = (p, ms, what) => {
  let t; const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}_deadline`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
};
const log = (deps, line, detail) => { (deps.log || console.warn)(line, JSON.stringify(detail)); };

// ONE alarm per (configuration, kind) per rid: recorded at form_rebake/{rid}/hook_alarm so a bad config does not alarm every
// ten minutes, and a corrected (or newly broken) config alarms again.
async function alarmOnce(rid, kind, cfg, deps) {
  const mark = `${kind}:${cfg.fingerprint}`;
  let fresh = false;
  await deps.db.ref(`form_rebake/${rid}/hook_alarm`).transaction((cur) => { if (cur === mark) { fresh = false; return undefined; } fresh = true; return mark; });
  if (fresh) await deps.alarm(kind, { rid });
}

// The rid's hook, or null (dormant / bad / missing — the last two alarm once).
async function hookFor(rid, cfg, deps) {
  if (!cfg.configured) return null;
  if (cfg.bad.includes('*') || cfg.bad.includes(rid)) { await alarmOnce(rid, 'form_rebake_bad_hook', cfg, deps); return null; }
  if (!cfg.hooks[rid]) { await alarmOnce(rid, 'form_rebake_missing_hook', cfg, deps); return null; }
  return cfg.hooks[rid];
}

// POST the hook (no body, no trigger_branch). → 'ok' | 'hook_rejected' | 'hook_unreachable'. Never logs the url.
async function postHook(url, rid, deps) {
  let cls;
  try {
    const res = await withDeadline(deps.http.post(url), HOOK_DEADLINE_MS, 'hook');
    cls = res && res.status >= 200 && res.status < 300 ? 'ok' : 'hook_rejected';
  } catch (_) { cls = 'hook_unreachable'; }
  log(deps, 'form_rebake_hook', { rid, class: cls });
  return cls;
}

// ONE RETRY BUDGET (Codex r1 #4), FENCED BY THE ACTIVATION GENERATION (Codex r2 #1, r3 #1) — the trigger and the reconciler claim
// POSTs through THIS transaction, so they share the cooldown, the attempt count and `stuck` for ONE activation. Which activation is
// current is decided by the active pointer's GENERATION, which the pointer writer advances on EVERY activation — a rollback
// included (identity.seq is the VERSION's ordinal and goes BACKWARDS on a rollback, so it cannot fence). An OLDER observation (a
// reconciliation that read before a later activation) is STALE and touches nothing; the count resets only when a NEWER
// generation is first observed. obs = { version (content hash, for the record), generation }.
// → { decision: 'post' | 'cooldown' | 'stuck' | 'stuck_silent' | 'stale', attempts }
const genOf = (c) => (typeof c.generation === 'number' && Number.isFinite(c.generation) ? c.generation : -Infinity);
async function claimAttempt(rid, obs, deps) {
  const now = deps.now();
  let decision = null; let attempts = 0;
  await deps.db.ref(`form_rebake/${rid}`).transaction((cur) => {
    let c = isObj(cur) ? { ...cur } : {};
    if (obs.generation < genOf(c)) { decision = 'stale'; return undefined; }                 // an OLDER observation: no write at all
    if (obs.generation > genOf(c)) c = { ...c, version: obs.version, generation: obs.generation, attempts: 0, stuck: false };   // a NEWER activation re-arms
    if (c.stuck) { decision = 'stuck_silent'; return c; }
    if (typeof c.at === 'number' && now - c.at < COOLDOWN_MS) { decision = 'cooldown'; return c; }
    if ((c.attempts || 0) >= MAX_ATTEMPTS) { decision = 'stuck'; attempts = c.attempts; return { ...c, stuck: true }; }
    decision = 'post'; attempts = (c.attempts || 0) + 1;
    return { ...c, at: now, attempts };
  });
  if (decision === 'stuck') await deps.alarm('form_rebake_stuck', { rid, attempts });
  return { decision, attempts };
}

// THE COHERENT READ: the active pointer's { version, generation } and the published menu, accepted only when the menu IS that
// pointer's version (an activation landing between the two reads is retried; three disagreements = unreadable). Injected:
// getPointer(rid) → { version, generation }; readMenu(rid) → buildPublicMenu's result (overlay-free), incl. version_id.
// → { menu, generation }
async function readFencedPublished(rid, { getPointer, readMenu }, tries = 3) {
  for (let i = 0; i < tries; i += 1) {
    const p = await getPointer(rid);
    const m = await readMenu(rid);
    if (p && m && p.version && m.version_id === p.version && Number.isSafeInteger(p.generation)) return { menu: m.body, generation: p.generation };
  }
  throw new Error('published_unstable');
}
// readPublished(rid) → { menu, generation }: the overlay-free published menu and the activation generation it was read at.
const observe = (read) => ({ menu: read && read.menu, obs: { version: menuVersion(read && read.menu), generation: Number(read && read.generation) } });

// FAST PATH — the mirror-write trigger. It reads the published menu (the same in-process read the reconciler uses) only to
// learn its VERSION, then spends from the shared budget — an unchanged mirror event after `stuck` posts nothing.
async function onMirrorWrite(rid, deps) {
  const cfg = parseHooks(deps.env.FORM_BUILD_HOOKS);
  const url = await hookFor(rid, cfg, deps);
  if (!url) return { posted: false, reason: cfg.configured ? 'no_hook' : 'dormant' };
  let read;
  try { read = observe(await withDeadline(deps.readPublished(rid), READ_DEADLINE_MS, 'published')); } catch (e) {
    log(deps, 'form_rebake_published_unreadable', { rid }); return { posted: false, reason: 'published_unreadable' };   // the reconciler retries
  }
  const { decision, attempts } = await claimAttempt(rid, read.obs, deps);
  if (decision !== 'post') return { posted: false, reason: decision };
  const cls = await postHook(url, rid, deps);
  await deps.db.ref(`form_rebake/${rid}/last_class`).set(cls);
  return { posted: true, class: cls, attempts };
}

// RECOVERY — one rid. → { rid, decision, ... }
async function reconcileRid(rid, base, cfg, deps) {
  const url = await hookFor(rid, cfg, deps);
  if (!url) return { rid, decision: 'no_hook' };
  let published, deployed;
  let read;
  try { read = observe(await withDeadline(deps.readPublished(rid), READ_DEADLINE_MS, 'published')); published = read.menu; } catch (e) {
    log(deps, 'form_rebake_published_unreadable', { rid }); return { rid, decision: 'published_unreadable' };
  }
  try {
    const html = await withDeadline(deps.http.getText(`${base}?_reconcile=${deps.now()}`, { headers: { 'cache-control': 'no-cache' } }), READ_DEADLINE_MS, 'deployed');
    deployed = extractBundle(html);
  } catch (e) { log(deps, 'form_rebake_deployed_unreadable', { rid }); return { rid, decision: 'deployed_unreadable' }; }
  const { fail, warn } = compareBundle(deployed, published);
  const converged = !fail.length && !warn.length;
  if (converged) {
    // convergence resets the budget — fenced like a claim: an OLDER observation touches nothing; a no-op write is skipped
    await deps.db.ref(`form_rebake/${rid}`).transaction((cur) => {
      const c = isObj(cur) ? { ...cur } : {};
      if (read.obs.generation < genOf(c)) return undefined;
      if (!c.attempts && !c.stuck && read.obs.generation === genOf(c)) return undefined;
      return { ...c, version: read.obs.version, generation: read.obs.generation, attempts: 0, stuck: false };
    });
    return { rid, decision: 'converged' };
  }
  const { decision, attempts } = await claimAttempt(rid, read.obs, deps);
  if (decision === 'stuck') return { rid, decision, attempts };
  if (decision !== 'post') return { rid, decision };
  const cls = await postHook(url, rid, deps);
  await deps.db.ref(`form_rebake/${rid}/last_class`).set(cls);
  return { rid, decision, attempts, class: cls, differences: fail.length + warn.length };
}

// RECOVERY — every registered rid with an orders site. Dormant until FORM_BUILD_HOOKS is set.
async function reconcile(deps) {
  const cfg = parseHooks(deps.env.FORM_BUILD_HOOKS);
  if (!cfg.configured) return { dormant: true, results: [] };
  await deps.registry.ready();
  const results = [];
  for (const rid of [...deps.registry.known()].sort()) {
    const base = assetBaseFor(rid, deps.sites);
    if (!base) continue;
    try { results.push(await reconcileRid(rid, base, cfg, deps)); } catch (e) {
      log(deps, 'form_rebake_reconcile_failed', { rid }); results.push({ rid, decision: 'error' });
    }
  }
  return { dormant: false, results };
}

module.exports = { readFencedPublished, parseHooks, isHookUrl, onMirrorWrite, reconcile, reconcileRid, menuVersion, PATH, COOLDOWN_MS, MAX_ATTEMPTS, HOOK_DEADLINE_MS };
