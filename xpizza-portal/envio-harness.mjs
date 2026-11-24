// «Envío» — the shared REAL-server harness (moved verbatim from envio-view.test.mjs; used by it and by envio-zones-view.test.mjs):
// 5f's REAL getDeliveryPricingCore / setDeliveryPricingCore over the functions suites' faithful in-memory RTDB, a transport layer that can
// fail after the commit, and the page over the shipped index.html with the REAL app.js, ventas.js, shell.js and envio.js.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DIR, installFetch, okJson, settle } from './ventas-harness.mjs';
import { MAP_ORIGIN, PORTAL_ORIGIN, childMessage } from './envio-map-protocol.js';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const { fakeRtdb } = require('../xpizza-functions/test/_fake-rtdb-sdk.js');
const CORE = require('../xpizza-functions/delivery/pricing-admin-core.js');
const RC = require('../xpizza-functions/restaurant-config');
const ZL = require('../xpizza-functions/delivery/zones-lock');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');

const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const branch = (rid, name) => ({ rid, brand_id: 'marca_e', role: 'owner', state: 'member', caps: OWNER_CAPS, name, identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null });
const E1 = (over = {}) => ({ brands: [{ brand_id: 'marca_e', name: 'Pizzería Del Valle' }], branches: [branch('r_cen', 'Centro')], membership_writes_enabled: false, ...over });
const POLICY = (version, bands) => ({ policy_version: version, bands, history: [], updated_at: 1, updated_by: 'uAdmin' });
const B3 = [{ max_km: 3, cents: 4000 }, { max_km: 6, cents: 5000 }];
// the platform's restaurants, as getDeliveryPricing's directory reads them (registry + identity + brand name)
const WORLD = {
  ids: ['r_xp', 'r_lm', 'r_far'],
  restaurants: {
    r_xp: { identity: { brand_id: 'b_xp', name: 'X. Pizza', location_name: 'Centro', hub_lat: 15.5075, hub_lng: -88.0398 } },
    r_lm: { identity: { brand_id: 'b_lm', name: 'La Musa', location_name: 'Centro', hub_lat: 15.5041, hub_lng: -88.0385 } },
    r_far: { identity: { brand_id: 'b_far', name: 'Sin Pin', location_name: 'Norte' } },
  },
  brands: { b_xp: { name: 'X. Pizza' }, b_lm: { name: 'La Musa' }, b_far: { name: 'Sin Pin' } },
};

// ── the server: 5f's REAL cores over the faithful fake RTDB, plus a transport layer ─────────────────────────────────────────
function server({ policy = POLICY(3, B3), admins = { uAdmin: true }, registry, world = WORLD } = {}) {
  const db = fakeRtdb({ platform_admins: admins, ...(policy ? { platform_config: { delivery_pricing: policy } } : {}), restaurants: world.restaurants, brands: world.brands }, { strict: true });
  const srv = {
    db, uid: null, at: 0, commits: 0, posts: [], gets: 0, now: Date.UTC(2026, 10, 11, 18, 0), forgetIdentities: () => forgetIdentities(),
    fault: { post: null, get: null },   // post: 'before503' | 'after503' | 'afterDrop' | 'afterMalformed' | 'drop' ; get: 'fail' | 'hold'
    hold: { get: null, post: null, getAfter: null },
    // a one-shot TRANSPORT rewrite of the next setDeliveryPricing body, BEFORE the real core (the screen validates first and never sends an
    // invalid zone list, so a cell reaches the real validator's 400s this way — the answer is the core's own); `answers` = the core's outs
    rewrite: null, answers: [],
  };
  // envío step 2: the zones lock's deps, exactly production's (delivery/pricing-admin-functions.js:19-27) — the REAL getIdentity (its warm
  // cache cleared per world) and the REAL strict grace read; `srv.now` is the clock the lock judges hours at (a Wednesday, noon local)
  RC._cache.clear();
  // a cell that changes a restaurant's identity (its hours) mid-session drops getIdentity's warm cache, as a new instance would
  const forgetIdentities = () => RC._cache.clear();
  const deps = () => ({ db, verifyIdToken: async (t) => { if (t !== 'TK-test' || !srv.uid) throw new Error('bad'); return { uid: srv.uid }; },
    timestamp: () => ++srv.at, readRegistry: registry || (async () => ({ ok: true, fresh: true, ids: world.ids })),
    getIdentity: RC.getIdentity, readGrace: ZL.readGraceMinutesStrict, now: () => srv.now });
  const req = (body) => ({ get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer TK-test' : null), body });
  const answer = (out) => (out.status === 200 ? okJson(out.body) : { ok: false, status: out.status, json: async () => out.body, text: async () => JSON.stringify(out.body), headers: { get: () => null } });
  const ver = () => { const v = db.ref(CORE.PATH); return v; };
  srv.version = async () => { const n = (await ver().once('value')).val(); return n ? n.policy_version : 0; };
  srv.node = async () => (await db.ref(CORE.PATH).once('value')).val();
  srv.handle = async (fn, body) => {
    if (fn === 'getDeliveryPricing') {
      srv.gets++;
      if (srv.hold.get) await srv.hold.get;
      if (srv.fault.get === 'fail') { srv.fault.get = null; throw new TypeError('Failed to fetch'); }
      const got = await CORE.getDeliveryPricingCore(deps(), req(undefined));
      // Codex r1 F4: the server has READ; the answer is delivered later (one-shot)
      if (srv.hold.getAfter) { const h = srv.hold.getAfter; srv.hold.getAfter = null; await h; }
      return answer(got);
    }
    if (fn === 'setDeliveryPricing') {
      srv.posts.push(body);
      if (srv.hold.post) await srv.hold.post;
      const f = srv.fault.post; srv.fault.post = null;
      if (f === 'drop') throw new TypeError('Failed to fetch');
      if (f === 'before503') return answer({ status: 503, body: { error: 'unavailable', retryable: true } });
      // Codex r1 F2: the real validator's 400 shape, nothing written (the screen never sends an invalid body, so a fault layer reaches it)
      if (f === 'refuse400') return answer({ status: 400, body: { error: 'bad_request', field: 'bands' } });
      const rw = srv.rewrite; srv.rewrite = null;
      const before = await srv.version();
      const out = await CORE.setDeliveryPricingCore(deps(), req(rw ? rw(JSON.parse(JSON.stringify(body))) : body));
      srv.answers.push(out);
      if ((await srv.version()) !== before) srv.commits++;
      if (f === 'after503') return answer({ status: 503, body: { error: 'unavailable', retryable: true } });
      if (f === 'afterDrop') throw new TypeError('Failed to fetch');
      if (f === 'afterMalformed') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); }, text: async () => '', headers: { get: () => null } };
      return answer(out);
    }
    return null;
  };
  return srv;
}

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__envio-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => { if (globalThis.__tokenHold) await globalThis.__tokenHold; const f = globalThis.__onToken; if (f) { globalThis.__onToken = null; queueMicrotask(f); } return globalThis.__tokenValue === undefined ? "TK-test" : globalThis.__tokenValue; };\n'
    + 'export const login = async () => {};\nexport const logout = async () => {};\nexport const watchAuth = () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__envio-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__envio-under-test.${n}.${tag}.mjs`;
  const files = [auth];
  const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell', 'envio']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__envio-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

let lastPage = null;   // each new page signs the previous one out: its view unmounts and its map timers stop (no cross-test leaks)
async function page({ e1 = E1({ platform_admin: true }), srv = server(), cache = null, uid = 'uAdmin', e1Cache = null } = {}) {
  if (lastPage) { try { lastPage.d.dispatchEvent(new lastPage.w.CustomEvent('portal:auth', { detail: { uid: null } })); } catch (_) { /* gone */ } lastPage = null; }
  const dom = new JSDOM(HTML, { url: `${PORTAL_ORIGIN}/`, pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  if (!w.crypto || !w.crypto.getRandomValues) Object.defineProperty(w, 'crypto', { value: globalThis.crypto, configurable: true });
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  if (cache) w.sessionStorage.setItem(`sherpa.portal.envio.${uid}`, JSON.stringify(cache));
  if (e1Cache) w.sessionStorage.setItem(`sherpa.portal.branches.${uid}`, JSON.stringify(e1Cache));
  globalThis.__branchesDirect = true;
  globalThis.__tokenHold = null;
  globalThis.__tokenValue = undefined;
  const st = { e1 };
  const calls = installFetch(async (fn) => {
    const last = calls[calls.length - 1];
    if (fn === 'getMyBranches') { if (st.holdE1) await st.holdE1; return okJson(st.e1); }
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    if (fn === 'getEditableCatalog') return okJson({ source: { restaurant_id: 'r_cen', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v1' });
    const r = await srv.handle(fn, last && last.body);
    if (r) return r;
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }), text: async () => '', headers: { get: () => null } };
  });
  const mods = await loadAll();
  mods.envio._envioTiming.deadlineMs = 5000;   // a timeout cell shortens it before opening
  const d = w.document;
  const reg = () => mods.shell._registered.find((r) => r.id === 'envio');
  const host = () => reg().main;
  const text = () => host().textContent.replace(/\s+/g, ' ');
  const btn = (label, root = host()) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const rows = () => [...host().querySelectorAll('.band')].map((b) => [b.querySelector('input[data-f="km"]').value, b.querySelector('input[data-f="fee"]').value]);
  const input = (i, f) => host().querySelectorAll('.band')[i].querySelector(`input[data-f="${f}"]`);
  const type = (i, f, v) => { const n = input(i, f); n.value = v; n.dispatchEvent(new w.Event('input')); };
  const bar = () => host().querySelector('.rbar');
  const n = (fn) => calls.filter((c) => c.fn === fn);
  const signIn = async (u = uid) => {
    srv.uid = u;
    d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid: u } }));
    d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
    await settle(40);
  };
  const open = async () => { reg().nav.click(); await settle(30); };
  const frame = () => host().querySelector('iframe');
  const fromMap = (data, { origin = MAP_ORIGIN, source } = {}) => {
    w.dispatchEvent(new w.MessageEvent('message', { data, origin, source: source === undefined ? frame().contentWindow : source }));
  };
  const mount = () => mods.envio._envioState.map && mods.envio._envioState.map.mount;
  lastPage = { dom, w, d, mods, st, srv, calls, reg, host, text, btn, rows, input, type, bar, n, signIn, open, frame, fromMap, mount };
  return lastPage;
}
const posted = (P) => {   // what the parent posted to the map frame
  const out = [];
  const f = P.frame();
  if (!f.__spy) { f.__spy = out; const real = f.contentWindow.postMessage.bind(f.contentWindow); f.contentWindow.postMessage = (m, o) => { out.push([m, o]); try { real(m, o); } catch (_) { /* jsdom origin */ } }; }
  return f.__spy;
};

// ── gating ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export { require, CORE, HTML, OWNER_CAPS, branch, E1, POLICY, B3, WORLD, server, loadAll, page, posted };
